#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-L6b/L6c DEGRADED runtime reactivation rollback handler (V5, failure/abort
# path only). MUTATING in live mode. It undoes ONLY what apply.sh journaled, in reverse dependency order, and is
# idempotent:
#   DNSMASQ_START                  -> `systemctl stop aegis-idea3-dnsmasq.service` (exact unit only)
#   NM_UP                          -> `nmcli connection down aegis-idea3-ap`, only while that profile is the active
#                                      connection of wlp0s20f3
#   NM_DEVICE_AUTOCONNECT_DISABLE  -> device autoconnect is forced off BEFORE the connection-down above (so nothing
#                                      can race in while the AP is coming down), then restored to its exact PRE value
#                                      once the AP is confirmed down
# It never recreates the stale DNSMASQ start-limit-hit artifact (DNSMASQ_RESET_FAILED is not "undone": the unit
# returns to a safe non-running state), never rewrites the profile, dnsmasq config/unit, broker config or the nft
# file, and NEVER touches rfkill, the global NM Wi-Fi radio, or aegis-idea3-mosquitto.service (no
# start/stop/restart/reset-failed of it — apply.sh never journaled a mutation against it, because it never issued
# one; the broker's post-rollback state is whatever its own systemd auto-restart left it in, and this rollback makes
# no claim about it either way). If, after the connection-down, a DIFFERENT (unrelated) Wi-Fi profile is found active
# on wlp0s20f3, this rollback FAILS CLOSED and ESCALATES rather than touching that unrelated profile.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_V5_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L34_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
DOWN_TRIES="${AEGIS_L34_NM_TRIES:-20}"
DOWN_INTERVAL="${AEGIS_L34_NM_INTERVAL:-0.5}"
DNSMASQ_UNIT=aegis-idea3-dnsmasq.service
BROKER_UNIT=aegis-idea3-mosquitto.service

identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
JOURNAL="$WORK/journal.tsv"
[ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || fail JOURNAL_MISSING
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
for f in persistent-pre.tsv nft-table-pre.txt identities-pre.txt broker-identity-pre.txt; do [ -f "$WORK/$f" ] || fail "PRE_BASELINE_MISSING:$f"; done
if [ -z "$ROOT" ]; then
  [ "${AEGIS_L34_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
else
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
fi

# ── journal: only fixed, known entries are acted on — exactly this run's owned mutations, nothing else ────────────────
j_start=0 j_reset=0 j_nm=0 j_acdis=0 j_acprior=""
while IFS=$'\t' read -r kind value || [ -n "$kind" ]; do
  [ -n "$kind" ] || continue
  case "$kind" in
    DNSMASQ_START) [ "$value" = "$DNSMASQ_UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_start=1 ;;
    DNSMASQ_RESET_FAILED) [ "$value" = "$DNSMASQ_UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_reset=1 ;;
    NM_UP) [ "$value" = "$L34_CONN" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_nm=1 ;;
    NM_DEVICE_AUTOCONNECT_DISABLE) [[ "$value" =~ ^(yes|no)$ ]] || fail JOURNAL_ENTRY_NOT_OWNED; j_acdis=1; j_acprior=$value ;;
    NM_DEVICE_AUTOCONNECT_RESTORED) [[ "$value" =~ ^(yes|no)$ ]] || fail JOURNAL_ENTRY_NOT_OWNED ;;
    *) fail JOURNAL_ENTRY_UNKNOWN ;;
  esac
done < "$JOURNAL"

# 1. dnsmasq: stop exactly the dedicated unit if this run started (or attempted to start) it. No disable, no
# reset-failed (never recreates the stale start-limit-hit artifact).
if [ "$j_start" = 1 ]; then
  if systemctl is-active --quiet "$DNSMASQ_UNIT"; then
    systemctl stop "$DNSMASQ_UNIT" || fail DNSMASQ_SERVICE_STOP_FAILED
  fi
fi

# 2. ensure autoconnect is off BEFORE the connection comes down, so nothing can race in during the down transition.
if [ "$j_acdis" = 1 ] && [ "$(nmcli -g GENERAL.AUTOCONNECT device show "$AP_IF" 2>/dev/null)" != no ]; then
  nmcli device set "$AP_IF" autoconnect no || fail NM_DEVICE_AUTOCONNECT_SET_FAILED
fi

# 3. AP connection: down only the approved profile, only when it is the active connection of exactly the target interface.
if [ "$j_nm" = 1 ]; then
  active=$(nmcli -g GENERAL.CONNECTION device show "$AP_IF" 2>/dev/null || true)
  if [ "$active" = "$L34_CONN" ]; then
    nmcli connection down "$L34_CONN" || fail NMCLI_DOWN_FAILED
  fi
  gone=1
  for ((i = 1; i <= DOWN_TRIES; i++)); do
    if [ -z "$(ip -4 -o addr show dev "$AP_IF" 2>/dev/null)" ]; then gone=0; break; fi
    [ "$i" -lt "$DOWN_TRIES" ] && sleep "$DOWN_INTERVAL"
  done
  [ "$gone" = 0 ] || fail AP_IF_STILL_HAS_IPV4_ADDRESS
fi

# 4. restore device autoconnect to its exact PRE value, only once the AP is confirmed down
if [ "$j_acdis" = 1 ]; then
  nmcli device set "$AP_IF" autoconnect "$j_acprior" || fail NM_DEVICE_AUTOCONNECT_RESTORE_FAILED
fi

# ── escalation: if a DIFFERENT Wi-Fi profile is now active on the target, this is never fixed here — fail closed loudly.
unrelated=$(nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | awk -F: '$1 == "802-11-wireless" { print $2 }')
if [ -n "$unrelated" ]; then
  fail "UNRELATED_WIFI_ACTIVATED_DURING_ROLLBACK=YES:ESCALATE_TO_OWNER (never manipulated by this rollback)"
fi

# ── proofs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$j_acdis" = 1 ]; then
  [ "$(nmcli -g GENERAL.AUTOCONNECT device show "$AP_IF" 2>/dev/null)" = "$j_acprior" ] || fail NM_DEVICE_AUTOCONNECT_NOT_RESTORED
fi
! nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | grep -q '^802-11-wireless' || fail L34_WIFI_CONNECTION_STILL_ACTIVE
! iw dev "$AP_IF" info 2>/dev/null | grep -q 'type AP' || fail AP_STILL_ACTIVE
[ -z "$(ip -4 -o addr show dev "$AP_IF" 2>/dev/null)" ] || fail AP_IF_STILL_HAS_IPV4_ADDRESS
! systemctl is-active --quiet "$DNSMASQ_UNIT" || fail DNSMASQ_STILL_RUNNING
l34_persistent_verify "$WORK/persistent-pre.tsv" || fail "$(l34_persistent_verify "$WORK/persistent-pre.tsv" 2>&1 | head -n 1)"
nft list table inet aegis_idea3 > "$WORK/nft-table-rollback.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-rollback.txt" || fail L2_NFT_TABLE_CHANGED
l34_forwarding_gate "$AP_IF" || fail "$(l34_forwarding_gate "$AP_IF" 2>&1 | head -n 1)"
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-rollback.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-rollback.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED

printf 'L34_V5_ROLLBACK=PASS\n'
printf 'AP_ACTIVE=NO\n'
printf 'DNSMASQ_RUNNING=NO\n'
printf 'L6B_BROKER_TOUCHED=NO (never commanded by apply.sh; final state is whatever systemd auto-restart left it in)\n'
printf 'RFKILL_TOUCHED=NO\n'
printf 'NM_RADIO_TOUCHED=NO\n'
printf 'PERSISTENT_FILES_UNCHANGED=YES\n'
printf 'STALE_START_LIMIT_HIT_RECREATED=NO\n'
printf 'DEVICE_AUTOCONNECT_RESTORED=%s\n' "$([ "$j_acdis" = 1 ] && echo YES || echo NOT_CHANGED)"
