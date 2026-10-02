#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-V7 PERSISTENT AP RECOVERY rollback handler (V8, failure/abort path only).
# MUTATING in live mode. It undoes ONLY what apply.sh journaled, idempotently, in this order:
#   NM_PROFILE_AUTOCONNECT_ENABLE  -> FIRST: `nmcli connection modify aegis-idea3-ap connection.autoconnect no` (restores the PRE persistent value), only
#                                     when the journal owns the change AND the profile is not already `no`; nothing may autoconnect while the AP comes down
#   DNSMASQ_START                  -> `systemctl stop aegis-idea3-dnsmasq.service` (exact unit only)
#   NM_UP                          -> `nmcli connection down aegis-idea3-ap`, only while that profile is the active connection of wlp0s20f3
#   NM_WIFI_RADIO_ENABLE           -> `nmcli radio wifi off`, only when THIS run enabled the radio and it is currently enabled
#   NM_DEVICE_AUTOCONNECT_DISABLE  -> device autoconnect forced off while the AP comes down / the radio goes off, then restored to its exact PRE value
#   RFKILL_UNBLOCK                 -> re-block exactly the recorded rfkill id (p4-l3-rfkill.sh), only if it was soft-blocked before this run
# The rollback boundary is SAFE-EQUIVALENT (V3 model), not byte-exact: the p2p pseudo-device (exactly unavailable), wpa_supplicant left running and the
# target phy regulatory state (TH or 00; this workflow never runs `iw reg set`) are the only tolerated residuals, and nothing is stopped, deleted or reset
# to make them go away. It never recreates the stale start-limit-hit artifact and NEVER issues any command against aegis-idea3-mosquitto.service or
# aegis-idea3-core.service: tearing the AP down leaves the broker crash-looping again exactly as its own restart policy decides. After rollback every
# canonical non-secret profile record (key order and the daemon-assigned uuid ignored; autoconnect=false included) and every other persistent file is proven identical to PRE (the profile: semantically identical). Ownership that cannot be proven from the
# journal fails closed and escalates; a DIFFERENT Wi-Fi profile found active is never touched. It never edits /var/lib/systemd/rfkill or any NM state file.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_V8_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
# shellcheck source=../../p4-l34-v8-lib.sh
. "$P4_HERE/p4-l34-v8-lib.sh"
# shellcheck source=../../p4-l3-rfkill.sh
. "$P4_HERE/p4-l3-rfkill.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L34_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
DOWN_TRIES="${AEGIS_L34_NM_TRIES:-20}"
DOWN_INTERVAL="${AEGIS_L34_NM_INTERVAL:-0.5}"
DNSMASQ_UNIT=$L34_UNIT

identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
JOURNAL="$WORK/journal.tsv"
[ -f "$JOURNAL" ] && [ ! -L "$JOURNAL" ] || fail JOURNAL_MISSING
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
for f in persistent-pre.tsv nft-table-pre.txt identities-pre.txt baseline.txt nm-devices-pre.txt phy-country-pre.txt; do [ -f "$WORK/$f" ] || fail "PRE_BASELINE_MISSING:$f"; done
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
j_start=0 j_reset=0 j_nm=0 j_radio=0 j_acdis=0 j_acprior="" j_rfkill=0 j_rfkill_id="" j_prof=0
while IFS=$'\t' read -r kind value || [ -n "$kind" ]; do
  [ -n "$kind" ] || continue
  case "$kind" in
    DNSMASQ_START) [ "$value" = "$DNSMASQ_UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_start=1 ;;
    DNSMASQ_RESET_FAILED) [ "$value" = "$DNSMASQ_UNIT" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_reset=1 ;;
    NM_PROFILE_AUTOCONNECT_ENABLE) [ "$value" = no ] || fail JOURNAL_ENTRY_NOT_OWNED; j_prof=1 ;;
    NM_UP) [ "$value" = "$L34_CONN" ] || fail JOURNAL_ENTRY_NOT_OWNED; j_nm=1 ;;
    NM_WIFI_RADIO_ENABLE) [ "$value" = disabled ] || fail JOURNAL_ENTRY_NOT_OWNED; j_radio=1 ;;
    NM_DEVICE_AUTOCONNECT_DISABLE) [[ "$value" =~ ^(yes|no)$ ]] || fail JOURNAL_ENTRY_NOT_OWNED; j_acdis=1; j_acprior=$value ;;
    NM_DEVICE_AUTOCONNECT_RESTORED) [[ "$value" =~ ^(yes|no)$ ]] || fail JOURNAL_ENTRY_NOT_OWNED ;;
    RFKILL_UNBLOCK) [[ "$value" =~ ^[0-9]+$ ]] || fail JOURNAL_ENTRY_NOT_OWNED; j_rfkill=1; j_rfkill_id=$value ;;
    *) fail JOURNAL_ENTRY_UNKNOWN ;;
  esac
done < "$JOURNAL"

# 0. persistent policy first: restore connection.autoconnect=no, only if this run's journal owns the change (written BEFORE the modify, so a modify that
# failed without effect leaves the profile already `no` and nothing is modified). No other profile property is ever written.
if [ "$j_prof" = 1 ] && [ "$(l34_v4_ap_profile_autoconnect)" != no ]; then
  nmcli connection modify "$L34_CONN" connection.autoconnect no || fail NM_PROFILE_AUTOCONNECT_RESTORE_FAILED
fi

# 1. dnsmasq: stop exactly the dedicated unit if this run started (or attempted to start) it. No disable, no reset-failed.
if [ "$j_start" = 1 ]; then
  if systemctl is-active --quiet "$DNSMASQ_UNIT"; then
    systemctl stop "$DNSMASQ_UNIT" || fail DNSMASQ_SERVICE_STOP_FAILED
  fi
fi

# 2. nothing may autoconnect while the AP comes down or the radio goes off: device autoconnect is forced off first, only if this run owns that change
if [ "$j_acdis" = 1 ] && { [ "$j_nm" = 1 ] || [ "$j_radio" = 1 ]; } && [ "$(nmcli -g GENERAL.AUTOCONNECT device show "$AP_IF" 2>/dev/null)" != no ]; then
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

# 3b. escalation: a DIFFERENT Wi-Fi profile active after the AP is down is never fixed here (no radio-off, no rfkill) — fail closed loudly BEFORE touching the radio.
unrelated=$(nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | awk -F: '$1 == "802-11-wireless" { print $2 }')
if [ -n "$unrelated" ]; then
  fail "UNRELATED_WIFI_ACTIVATED_DURING_ROLLBACK=YES:ESCALATE_TO_OWNER (never manipulated by this rollback)"
fi

# 4. NM radio: only when this run journaled the enable and the radio is currently enabled (never otherwise)
if [ "$j_radio" = 1 ] && [ "$(nmcli radio wifi 2>/dev/null)" = enabled ]; then
  nmcli radio wifi off || fail NM_WIFI_RADIO_DISABLE_FAILED
fi

# 5. restore device autoconnect to its exact PRE value, only once the AP is down and the radio is back off
if [ "$j_acdis" = 1 ] && [ "$(nmcli -g GENERAL.AUTOCONNECT device show "$AP_IF" 2>/dev/null)" != "$j_acprior" ]; then
  nmcli device set "$AP_IF" autoconnect "$j_acprior" || fail NM_DEVICE_AUTOCONNECT_RESTORE_FAILED
fi

# 6. rfkill: re-block exactly the recorded id, only if it was soft-blocked before this run (p4-l3-rfkill.sh)
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
! iw dev "$AP_IF" info 2>/dev/null | grep -q 'type AP' || fail AP_STILL_ACTIVE
[ -z "$(ip -4 -o addr show dev "$AP_IF" 2>/dev/null)" ] || fail AP_IF_STILL_HAS_IPV4_ADDRESS
! systemctl is-active --quiet "$DNSMASQ_UNIT" || fail DNSMASQ_STILL_RUNNING
[ "$(systemctl show -p UnitFileState --value "$DNSMASQ_UNIT")" = enabled ] || fail DNSMASQ_UNIT_FILE_STATE_CHANGED
if [ "$j_rfkill" = 1 ] && [ -f "$WORK/rfkill-target-pre.txt" ] && grep -q 'soft=blocked' "$WORK/rfkill-target-pre.txt"; then
  l3_rfkill_state "$(cat "$WORK/rfkill_id")" || fail "$L3_RFKILL_REASON"
  [ "$L3_RFKILL_SOFT" = blocked ] || fail RFKILL_PRE_STATE_NOT_RESTORED
fi
[ ! -f "$WORK/rfkill-all-pre.txt" ] || [ "$j_rfkill" = 0 ] || l34_rfkill_only_target_changed "$WORK/rfkill-all-pre.txt" "$(cat "$WORK/rfkill_id" 2>/dev/null || echo -1)" || fail L34_RFKILL_NON_TARGET_CHANGED
l34_v8_persistent_verify "$WORK/persistent-pre.tsv" no || fail "$(l34_v8_persistent_verify "$WORK/persistent-pre.tsv" no 2>&1 | head -n 1)"
[ "$(l34_v4_ap_profile_autoconnect)" = no ] || fail L34_V8_ROLLBACK_AP_PROFILE_AUTOCONNECT_NOT_RESTORED
nft list table inet aegis_idea3 > "$WORK/nft-table-rollback.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-rollback.txt" || fail L2_NFT_TABLE_CHANGED
l34_forwarding_gate "$AP_IF" || fail "$(l34_forwarding_gate "$AP_IF" 2>&1 | head -n 1)"
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-rollback.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-rollback.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED
if [ -f "$WORK/core-tuple-pre.txt" ]; then
  l34_v7_core_unchanged "$L34_V7_CORE_UNIT" "$WORK/core-tuple-pre.txt" || fail "$(l34_v7_core_unchanged "$L34_V7_CORE_UNIT" "$WORK/core-tuple-pre.txt" 2>&1 | head -n 1)"
fi

# V3 safe-equivalent boundary: prove every safety invariant; the only tolerated residuals are the p2p pseudo-device (exactly unavailable), wpa_supplicant
# left running (unit facts intact) and the target phy regulatory state (TH or 00). Nothing is stopped, deleted or reset to make them go away.
v3_baseline=$(cat "$WORK/baseline.txt")
[ "$(nmcli radio wifi 2>/dev/null)" = disabled ] || fail L34_V8_ROLLBACK_NM_RADIO_NOT_DISABLED
iw dev "$AP_IF" info 2>/dev/null | grep -q 'type managed' || fail L34_V8_ROLLBACK_TARGET_NOT_MANAGED
[ -z "$(ip route show default dev "$AP_IF" 2>/dev/null)" ] || fail L34_V8_ROLLBACK_AP_DEFAULT_ROUTE
l3_rfkill_state "$(cat "$WORK/rfkill_id" 2>/dev/null || echo "$L34_EXPECTED_RFKILL_ID")" || fail "$L3_RFKILL_REASON"
[ "$L3_RFKILL_SOFT" = blocked ] || fail L34_V8_ROLLBACK_RFKILL_NOT_BLOCKED
p2p_inv=$(l34_nm_status_snapshot | l34_p2p_inventory)
l34_p2p_rollback_safe "$v3_baseline" "$p2p_inv" || fail L34_V3_ROLLBACK_P2P_DEVICE_STATE
new_devs=$(comm -13 "$WORK/nm-devices-pre.txt" <(l34_nm_devices_listing) | grep -vx 'p2p-dev-wlp0s20f3:wifi-p2p' || true)
[ -z "$new_devs" ] || fail L34_V3_ROLLBACK_UNEXPECTED_NM_DEVICE
wpa=$(systemctl show -p LoadState -p UnitFileState -p Result -p NRestarts -p ActiveState -p SubState -p MainPID wpa_supplicant.service)
for kv in LoadState=loaded UnitFileState=disabled Result=success NRestarts=0; do
  grep -qx "$kv" <<< "$wpa" || fail "L34_V3_ROLLBACK_WPA_UNIT_${kv%%=*}"
done
l34_wpa_safe_state "$v3_baseline" <<< "$wpa" || fail L34_V3_ROLLBACK_WPA_STATE
country_now=$(iw reg get 2>/dev/null | awk -v p="phy#$(iw dev "$AP_IF" info 2>/dev/null | awk '$1 == "wiphy" { print $2; exit }')" '$1 ~ /^phy#/ { on = ($1 == p); next } $1 == "global" { on = 0 } on && $1 == "country" { sub(":", "", $2); print $2; exit }')
{ [ "$country_now" = TH ] || [ "$country_now" = 00 ]; } || fail L34_V3_ROLLBACK_REGULATORY_STATE

printf 'L34_V8_ROLLBACK=PASS\n'
printf 'SAFE_NETWORK_BOUNDARY_RESTORED=YES\n'
printf 'L34_ROLLBACK_MODEL=SAFE_EQUIVALENT\n'
printf 'AP_ACTIVE=NO\n'
printf 'DNSMASQ_RUNNING=NO\n'
printf 'AP_PROFILE_AUTOCONNECT_RESTORED=%s\n' "$([ "$j_prof" = 1 ] && echo 'YES (no)' || echo NOT_CHANGED)"
printf 'L6B_BROKER_TOUCHED=NO (never commanded; tearing the AP down leaves it crash-looping again or holding a stale 8883 pair, exactly as its own restart policy decides)\n'
printf 'CORE_TOUCHED=NO\n'
printf 'PERSISTENT_FILES_UNCHANGED=YES (profile semantically identical to PRE, key order and daemon uuid ignored, autoconnect=false restored)\n'
printf 'RFKILL_PRE_STATE_RESTORED=%s\n' "$([ "$j_rfkill" = 1 ] && echo YES || echo NOT_CHANGED)"
printf 'NM_WIFI_RADIO_RESTORED=%s\n' "$([ "$j_radio" = 1 ] && echo YES || echo NOT_CHANGED)"
printf 'DEVICE_AUTOCONNECT_RESTORED=%s\n' "$([ "$j_acdis" = 1 ] && echo YES || echo NOT_CHANGED)"
printf 'STALE_START_LIMIT_HIT_RECREATED=NO\n'
