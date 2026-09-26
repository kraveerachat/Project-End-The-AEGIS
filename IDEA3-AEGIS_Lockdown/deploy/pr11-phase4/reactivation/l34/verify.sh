#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 runtime reactivation verification handler. Read-only.
# Proves the accepted runtime state is active AND that nothing else moved: persistent files unchanged, L2 nft/PF-01 unchanged, forwarding
# zero, no NAT, rfkill outside the target unchanged, legacy mosquitto/Twingate/engine/tunnel identities unchanged, dnsmasq listener delta
# exactly the approved scope. Never prints the PSK.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
# shellcheck source=../../p4-l3-rfkill.sh
. "$P4_HERE/p4-l3-rfkill.sh"
# shellcheck source=../../p4-l3-regulatory.sh
. "$P4_HERE/p4-l3-regulatory.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L34_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
EXAMPLE_UNIT="$(cd "$P4_HERE/../network" && pwd)/aegis-idea3-dnsmasq.service.example"

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
listeners() { { ss -H -lnt | awk '{ print "tcp " $4 }'; ss -H -lnu | awk '{ print "udp " $4 }'; } | LC_ALL=C sort -u; }
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID -p NRestarts -p ExecMainStartTimestamp "$1"; }
identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
for f in persistent-pre.tsv nft-table-pre.txt rfkill-all-pre.txt rfkill-target-pre.txt listeners-pre.txt default-route-pre.txt identities-pre.txt; do
  [ -f "$WORK/$f" ] || fail "PRE_BASELINE_MISSING:$f"
done
if [ -n "$ROOT" ]; then
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
fi

# persistent accepted artifacts: byte/metadata identical to the pre-mutation snapshot, and still the accepted content
l34_persistent_verify "$WORK/persistent-pre.tsv" || fail "$(l34_persistent_verify "$WORK/persistent-pre.tsv" 2>&1 | head -n 1)"
l34_profile_gate "$(host_path "$L34_PROFILE")" || fail "$(l34_profile_gate "$(host_path "$L34_PROFILE")" 2>&1 | head -n 1)"
l34_dnsmasq_conf_gate "$(host_path "$L34_DNSMASQ_CONF")" || fail L34_DNSMASQ_CONF_CHANGED
l34_dnsmasq_unit_gate "$(host_path "$L34_DNSMASQ_UNIT")" "$EXAMPLE_UNIT" || fail L34_DNSMASQ_UNIT_CHANGED

# AP runtime
l34_ap_active_gate "$AP_IF" || fail "$(l34_ap_active_gate "$AP_IF" 2>&1 | head -n 1)"
l3_reg_verify_active "$AP_IF" "$L34_CHANNEL" || fail "$L3_REG_REASON"
[ "$(ip route show default)" = "$(cat "$WORK/default-route-pre.txt")" ] || fail L34_DEFAULT_ROUTE_CHANGED
[ "$(nmcli -g GENERAL.CONNECTION device show "$AP_IF" 2>/dev/null)" = "$L34_CONN" ] || fail L34_ACTIVE_CONNECTION_NOT_APPROVED_PROFILE
l34_rfkill_only_target_changed "$WORK/rfkill-all-pre.txt" "$(cat "$WORK/rfkill_id" 2>/dev/null)" || fail L34_RFKILL_NON_TARGET_CHANGED
l3_rfkill_state "$(cat "$WORK/rfkill_id")" || fail "$L3_RFKILL_REASON"
[ "$L3_RFKILL_SOFT" = unblocked ] && [ "$L3_RFKILL_HARD" != blocked ] || fail L34_TARGET_RFKILL_NOT_UNBLOCKED

# no unrelated Wi-Fi device/profile is active: the only active Wi-Fi connection is the approved profile on the target
wifi_active=$(nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | grep -c '^802-11-wireless' || true)
[ "$wifi_active" = 1 ] || fail L34_UNRELATED_WIFI_ACTIVE
nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | grep -qx "802-11-wireless:$AP_IF" || fail L34_UNRELATED_WIFI_ACTIVE

# V2 global-radio decision: if this run enabled the NM radio it must be enabled now, and the runtime device autoconnect back at its PRE value
radio_state=PRE_ENABLED
if grep -q '^NM_WIFI_RADIO_ENABLE	' "$WORK/journal.tsv"; then
  radio_state=ENABLED_BY_RUN
  [ "$(nmcli radio wifi 2>/dev/null)" = enabled ] || fail L34_NM_RADIO_NOT_ENABLED
  prior=$(awk -F'\t' '$1 == "NM_DEVICE_AUTOCONNECT_DISABLE" { print $2 }' "$WORK/journal.tsv")
  [[ "$prior" =~ ^(yes|no)$ ]] || fail L34_DEVICE_AUTOCONNECT_PRIOR_MISSING
  [ "$(nmcli -g GENERAL.AUTOCONNECT device show "$AP_IF" 2>/dev/null)" = "$prior" ] || fail L34_DEVICE_AUTOCONNECT_NOT_RESTORED
fi

# V3 envelope: the ONLY side effects of NetworkManager Wi-Fi initialization accepted on top of the reactivation are the exact p2p pseudo-device
# and the wpa_supplicant lifecycle, both value-constrained; any other new NetworkManager device or a changed wpa_supplicant unit fails.
if [ "${AEGIS_L34_PRESERVATION:-}" = V3 ]; then
  [ -f "$WORK/baseline.txt" ] && [ -f "$WORK/nm-devices-pre.txt" ] || fail "PRE_BASELINE_MISSING:v3"
  new_devs=$(comm -13 "$WORK/nm-devices-pre.txt" <(l34_nm_devices_listing) | grep -vx 'p2p-dev-wlp0s20f3:wifi-p2p' || true)
  [ -z "$new_devs" ] || fail L34_V3_UNEXPECTED_NM_DEVICE
  [ "$(l34_p2p_device_state)" = disconnected ] || fail L34_V3_P2P_DEVICE_STATE
  wpa=$(systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID -p NRestarts wpa_supplicant.service)
  for kv in LoadState=loaded ActiveState=active SubState=running UnitFileState=disabled Result=success NRestarts=0; do
    grep -qx "$kv" <<< "$wpa" || fail "L34_V3_WPA_SUPPLICANT_${kv%%=*}"
  done
  grep -Eq '^MainPID=[1-9][0-9]*$' <<< "$wpa" || fail L34_V3_WPA_SUPPLICANT_MainPID
  v3_baseline=$(cat "$WORK/baseline.txt")
fi

# dnsmasq: active/running, persistent identity unchanged, no enable/disable side effect, exact listener scope
unit_props "$L34_UNIT" | l34_service_active_gate || fail "$(unit_props "$L34_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
listeners > "$WORK/listeners-post.txt"
comm -13 <(awk '$2 ~ /:(53|67)$/' "$WORK/listeners-pre.txt") <(awk '$2 ~ /:(53|67)$/' "$WORK/listeners-post.txt") | l34_listener_scope_gate \
  || fail L34_LISTENER_SCOPE_NOT_EXACT
[ "$(awk '$2 ~ /:1883$/ { print $2 }' "$WORK/listeners-post.txt")" = "$(cat "$WORK/legacy-1883-pre.txt")" ] || fail LEGACY_1883_CHANGED
! awk '$2 ~ /:(53|67)$/ && ($2 ~ /^0\.0\.0\.0:/ || $2 ~ /^127\./ || $2 ~ /^\[::\]/ || $2 ~ /enp62s0/) { bad = 1 } END { exit !bad }' \
  <(comm -13 "$WORK/listeners-pre.txt" "$WORK/listeners-post.txt") || fail L34_DNSMASQ_LISTENER_OUT_OF_SCOPE

# L2 and forwarding unchanged
nft list table inet aegis_idea3 > "$WORK/nft-table-post.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-post.txt" || fail L2_NFT_TABLE_CHANGED
l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-post.txt" || fail "$(l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-post.txt" 2>&1 | head -n 1)"
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(l34_forwarding_gate "$AP_IF" 2>&1 | head -n 1)"

# legacy mosquitto / Twingate / IDEA2 identities unchanged
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-post.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-post.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED

printf 'L34_VERIFY=PASS\n'
printf 'AP_RUNTIME=ACTIVE SSID=%s CHANNEL=%s ADDRESS=%s/%s\n' "$L34_SSID" "$L34_CHANNEL" "$L34_AP_ADDR" "$L34_AP_PREFIX"
printf 'DNSMASQ=ACTIVE_RUNNING\n'
printf 'PERSISTENT_FILES_UNCHANGED=YES\n'
if [ "${AEGIS_L34_PRESERVATION:-}" = V3 ]; then printf 'L34_V3_SIDE_EFFECTS=WITHIN_ENVELOPE\nL34_BASELINE=%s\n' "$v3_baseline"; fi
printf 'NM_WIFI_RADIO=%s\n' "$radio_state"
printf 'UNRELATED_WIFI_ACTIVE=NO\n'
printf 'L2_UNCHANGED=YES\n'
printf 'FORWARDING=ZERO\n'
printf 'LEGACY_MOSQUITTO_TWINGATE_IDEA2=UNCHANGED\n'
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
