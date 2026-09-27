#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 runtime reactivation rollback handler (failure / abort path only).
# MUTATING in live mode. It undoes ONLY what apply.sh journaled, in reverse dependency order, and is idempotent:
#   DNSMASQ_START    -> `systemctl stop aegis-idea3-dnsmasq.service` (exact unit; never dnsmasq.service)
#   NM_UP            -> `nmcli connection down aegis-idea3-ap`, only while that profile is the active connection of wlp0s20f3
#   NM_WIFI_RADIO_ENABLE (V2) -> disable the device autoconnect, `nmcli radio wifi off`, then restore the PRE autoconnect value; only when this
#                    run enabled the radio and it is currently enabled (never otherwise)
#   RFKILL_UNBLOCK   -> restore the exact recorded rfkill id to blocked (p4-l3-rfkill.sh), only if it was soft-blocked before
# It never recreates the stale start-limit-hit artifact (DNSMASQ_RESET_FAILED is not "undone": the unit returns to a safe
# non-running state), never deletes/rewrites the profile, dnsmasq config/unit, nft file or any persistent NetworkManager configuration, and
# never touches nftables, forwarding, regulatory state, enp62s0, legacy mosquitto or Twingate. The global Wi-Fi radio is FORBIDDEN BY DEFAULT: it
# is turned off here only when the journal proves THIS run enabled it under the V2 authorization and it is currently enabled; the temporary
# device autoconnect value is restored to its PRE value.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
# shellcheck source=../../p4-l3-rfkill.sh
. "$P4_HERE/p4-l3-rfkill.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L34_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
DOWN_TRIES="${AEGIS_L34_NM_TRIES:-20}"
DOWN_INTERVAL="${AEGIS_L34_NM_INTERVAL:-0.5}"

listeners() { { ss -H -lnt | awk '{ print "tcp " $4 }'; ss -H -lnu | awk '{ print "udp " $4 }'; } | LC_ALL=C sort -u; }
identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
JOURNAL="$WORK/journal.tsv"
[ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || fail JOURNAL_MISSING
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
for f in persistent-pre.tsv nft-table-pre.txt identities-pre.txt; do [ -f "$WORK/$f" ] || fail "PRE_BASELINE_MISSING:$f"; done
if [ -z "$ROOT" ]; then
  [ "${AEGIS_L34_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
  sysfs=/sys
else
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
  sysfs="${ROOT%/}/sys"
fi
host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }

# ── journal: only fixed, known entries are acted on ─────────────────────────────────────────────────────────────────────
j_start=0 j_nm=0 j_rfkill=0 j_reset=0 j_rfkill_id="" j_radio=0 j_acdis=0 j_acprior=""
while IFS=$'\t' read -r kind value || [ -n "$kind" ]; do
  [ -n "$kind" ] || continue
  case "$kind" in
    DNSMASQ_START) [ "$value" = "$L34_UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_start=1 ;;
    DNSMASQ_RESET_FAILED) [ "$value" = "$L34_UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_reset=1 ;;
    NM_UP) [ "$value" = "$L34_CONN" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_nm=1 ;;
    NM_WIFI_RADIO_ENABLE) [ "$value" = disabled ] || fail JOURNAL_ENTRY_NOT_OWNED; j_radio=1 ;;
    NM_DEVICE_AUTOCONNECT_DISABLE) [[ "$value" =~ ^(yes|no)$ ]] || fail JOURNAL_ENTRY_NOT_OWNED; j_acdis=1; j_acprior=$value ;;
    NM_DEVICE_AUTOCONNECT_RESTORED) [[ "$value" =~ ^(yes|no)$ ]] || fail JOURNAL_ENTRY_NOT_OWNED ;;
    RFKILL_UNBLOCK) [[ "$value" =~ ^[0-9]+$ ]] || fail JOURNAL_ENTRY_NOT_OWNED; j_rfkill=1; j_rfkill_id=$value ;;
    *) fail JOURNAL_ENTRY_UNKNOWN ;;
  esac
done < "$JOURNAL"

# 1. dnsmasq: stop exactly the dedicated unit if this run started (or attempted to start) it. No disable, no reset-failed.
if [ "$j_start" = 1 ]; then
  if systemctl is-active --quiet "$L34_UNIT"; then
    systemctl stop "$L34_UNIT" || fail DNSMASQ_SERVICE_STOP_FAILED
  fi
fi

# 2. AP connection: down only the approved profile, only when it is the active connection of exactly the target interface.
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

# 2b. NM radio (V2): only when this run journaled the enable and the radio is currently enabled. Nothing may autoconnect between the AP going
# down and the radio going off, so the device autoconnect is forced off first; the PRE autoconnect value is restored once the radio is off.
if [ "$j_radio" = 1 ] && [ "$(nmcli radio wifi 2>/dev/null)" = enabled ]; then
  nmcli device set "$AP_IF" autoconnect no || fail NM_DEVICE_AUTOCONNECT_SET_FAILED
  nmcli radio wifi off || fail NM_WIFI_RADIO_DISABLE_FAILED
fi
if [ "$j_acdis" = 1 ] && [ "$(nmcli -g GENERAL.AUTOCONNECT device show "$AP_IF" 2>/dev/null)" != "$j_acprior" ]; then
  nmcli device set "$AP_IF" autoconnect "$j_acprior" || fail NM_DEVICE_AUTOCONNECT_RESTORE_FAILED
fi

# 3. rfkill: re-block exactly the recorded id, only if it was soft-blocked before this run (p4-l3-rfkill.sh)
if [ "$j_rfkill" = 1 ]; then
  [ "$(cat "$WORK/rfkill_id" 2>/dev/null)" = "$j_rfkill_id" ] || fail RFKILL_ID_JOURNAL_MISMATCH
  l3_rfkill_restore "$WORK" || fail "$L3_RFKILL_REASON"
fi

# ── proofs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$j_radio" = 1 ]; then
  [ "$(nmcli radio wifi 2>/dev/null)" = disabled ] || fail NM_WIFI_RADIO_NOT_RESTORED
fi
if [ "$j_acdis" = 1 ]; then
  [ "$(nmcli -g GENERAL.AUTOCONNECT device show "$AP_IF" 2>/dev/null)" = "$j_acprior" ] || fail NM_DEVICE_AUTOCONNECT_NOT_RESTORED
fi
! nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | grep -q '^802-11-wireless' || fail L34_WIFI_CONNECTION_STILL_ACTIVE
! iw dev "$AP_IF" info 2>/dev/null | grep -q 'type AP' || fail AP_STILL_ACTIVE
[ -z "$(ip -4 -o addr show dev "$AP_IF" 2>/dev/null)" ] || fail AP_IF_STILL_HAS_IPV4_ADDRESS
! systemctl is-active --quiet "$L34_UNIT" || fail DNSMASQ_STILL_RUNNING
[ "$(systemctl show -p UnitFileState --value "$L34_UNIT")" = enabled ] || fail DNSMASQ_UNIT_FILE_STATE_CHANGED
if [ -f "$WORK/rfkill-target-pre.txt" ] && grep -q 'soft=blocked' "$WORK/rfkill-target-pre.txt"; then
  l3_rfkill_state "$(cat "$WORK/rfkill_id")" || fail "$L3_RFKILL_REASON"
  [ "$L3_RFKILL_SOFT" = blocked ] || fail RFKILL_PRE_STATE_NOT_RESTORED
fi
[ ! -f "$WORK/rfkill-all-pre.txt" ] || l34_rfkill_only_target_changed "$WORK/rfkill-all-pre.txt" "$(cat "$WORK/rfkill_id" 2>/dev/null || echo -1)" || fail L34_RFKILL_NON_TARGET_CHANGED
l34_persistent_verify "$WORK/persistent-pre.tsv" || fail "$(l34_persistent_verify "$WORK/persistent-pre.tsv" 2>&1 | head -n 1)"
nft list table inet aegis_idea3 > "$WORK/nft-table-rollback.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-rollback.txt" || fail L2_NFT_TABLE_CHANGED
l34_forwarding_gate "$AP_IF" || fail "$(l34_forwarding_gate "$AP_IF" 2>&1 | head -n 1)"
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-rollback.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-rollback.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED

# V3: the rollback boundary is SAFE-EQUIVALENT, not byte-exact, once NetworkManager has initialized Wi-Fi. Prove every safety invariant here; the
# only tolerated residuals are the p2p pseudo-device (exactly unavailable), wpa_supplicant left running (unit facts intact) and the target phy
# regulatory state (TH or 00: this workflow never runs `iw reg set`). Nothing is stopped, deleted or reset to make the residuals go away.
exact_prestate=UNKNOWN
if [ "${AEGIS_L34_PRESERVATION:-}" = V3 ]; then
  [ -f "$WORK/baseline.txt" ] || fail "PRE_BASELINE_MISSING:v3"
  [ "$(nmcli radio wifi 2>/dev/null)" = disabled ] || fail L34_V3_ROLLBACK_NM_RADIO_NOT_DISABLED
  iw dev "$AP_IF" info 2>/dev/null | grep -q 'type managed' || fail L34_V3_ROLLBACK_TARGET_NOT_MANAGED
  [ -z "$(ip route show default dev "$AP_IF" 2>/dev/null)" ] || fail L34_V3_ROLLBACK_AP_DEFAULT_ROUTE
  l3_rfkill_state "$(cat "$WORK/rfkill_id")" || fail "$L3_RFKILL_REASON"
  if grep -q 'soft=blocked' "$WORK/rfkill-target-pre.txt"; then [ "$L3_RFKILL_SOFT" = blocked ] || fail L34_V3_ROLLBACK_RFKILL_NOT_BLOCKED; fi
  v3_baseline=$(cat "$WORK/baseline.txt")
  p2p_inv=$(l34_nm_status_snapshot | l34_p2p_inventory)
  l34_p2p_rollback_safe "$v3_baseline" "$p2p_inv" || fail L34_V3_ROLLBACK_P2P_DEVICE_STATE
  new_devs=$(comm -13 "$WORK/nm-devices-pre.txt" <(l34_nm_devices_listing) | grep -vx 'p2p-dev-wlp0s20f3:wifi-p2p' || true)
  [ -z "$new_devs" ] || fail L34_V3_ROLLBACK_UNEXPECTED_NM_DEVICE
  wpa=$(systemctl show -p LoadState -p UnitFileState -p Result -p NRestarts -p ActiveState -p SubState -p MainPID wpa_supplicant.service)
  for kv in LoadState=loaded UnitFileState=disabled Result=success NRestarts=0; do
    grep -qx "$kv" <<< "$wpa" || fail "L34_V3_ROLLBACK_WPA_UNIT_${kv%%=*}"
  done
  # the wpa_supplicant STATE must itself be a proven safe one before the boundary may be reported (never stopped/restarted here)
  l34_wpa_safe_state "$v3_baseline" <<< "$wpa" || fail L34_V3_ROLLBACK_WPA_STATE
  country_now=$(iw reg get 2>/dev/null | awk -v p="phy#$(iw dev "$AP_IF" info 2>/dev/null | awk '$1 == "wiphy" { print $2; exit }')" '$1 ~ /^phy#/ { on = ($1 == p); next } $1 == "global" { on = 0 } on && $1 == "country" { sub(":", "", $2); print $2; exit }')
  { [ "$country_now" = TH ] || [ "$country_now" = 00 ]; } || fail L34_V3_ROLLBACK_REGULATORY_STATE
  # exactness is reported separately from the safety boundary: byte-for-byte only when p2p, wpa_supplicant and the country all equal PRE
  pre_wpa_active=NO; [ "$(cat "$WORK/baseline.txt")" = RESIDUAL ] && pre_wpa_active=YES
  now_wpa_active=NO; grep -qx 'ActiveState=active' <<< "$wpa" && now_wpa_active=YES
  pre_p2p=NO; [ "$(cat "$WORK/baseline.txt")" = RESIDUAL ] && pre_p2p=YES
  now_p2p=NO; [ -n "$p2p_inv" ] && now_p2p=YES
  if [ "$pre_wpa_active" = "$now_wpa_active" ] && [ "$pre_p2p" = "$now_p2p" ] && [ "$country_now" = "$(cat "$WORK/phy-country-pre.txt")" ]; then exact_prestate=YES; else exact_prestate=NO; fi
fi

printf 'L34_ROLLBACK=PASS\n'
if [ "${AEGIS_L34_PRESERVATION:-}" = V3 ]; then
  printf 'SAFE_NETWORK_BOUNDARY_RESTORED=YES\n'
  printf 'EXACT_PRESTATE_RESTORED=%s\n' "$exact_prestate"
  printf 'L34_ROLLBACK_MODEL=SAFE_EQUIVALENT\n'
fi
printf 'AP_ACTIVE=NO\n'
printf 'DNSMASQ_RUNNING=NO\n'
printf 'PERSISTENT_FILES_UNCHANGED=YES\n'
printf 'RFKILL_PRE_STATE_RESTORED=YES\n'
printf 'NM_WIFI_RADIO_RESTORED=%s\n' "$([ "$j_radio" = 1 ] && echo YES || echo NOT_CHANGED)"
printf 'STALE_START_LIMIT_HIT_RECREATED=NO\n'
