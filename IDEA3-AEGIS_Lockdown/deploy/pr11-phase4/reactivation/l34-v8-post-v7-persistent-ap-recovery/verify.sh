#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-V7 PERSISTENT AP RECOVERY verification handler (V8). Read-only.
# Proves the AP, dnsmasq and the L6b broker runtime are active with their exact expected listeners, that the radio/rfkill/autoconnect/wpa/p2p side effects
# are exactly the ones this run owns, that the AP profile carries the ONE authorized persistent change (connection.autoconnect no -> yes, journaled exactly
# once) and is semantically identical in every other non-secret record (key order and the daemon uuid ignored), and that nothing else moved: dnsmasq/broker/unit/nft files unchanged, L2 nft unchanged,
# forwarding zero, no NAT, no unrelated Wi-Fi active, legacy mosquitto/Twingate/IDEA2 and Core identities unchanged. Never prints the PSK.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_V8_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
# shellcheck source=../../p4-l34-v8-lib.sh
. "$P4_HERE/p4-l34-v8-lib.sh"
# shellcheck source=../../p4-l3-rfkill.sh
. "$P4_HERE/p4-l3-rfkill.sh"
# shellcheck source=../../p4-l3-regulatory.sh
. "$P4_HERE/p4-l3-regulatory.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L34_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
STABLE_INTERVAL=5
[ -z "$ROOT" ] || STABLE_INTERVAL="${AEGIS_L34_V8_STABLE_INTERVAL:-5}"
DNSMASQ_UNIT=$L34_UNIT
BROKER_UNIT=$L34_V7_BROKER_UNIT
CORE_UNIT=$L34_V7_CORE_UNIT
EXAMPLE_UNIT="$(cd "$P4_HERE/../network" && pwd)/aegis-idea3-dnsmasq.service.example"

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }
reason_of() { "$@" 2>&1 >/dev/null | head -n 1; }

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
for f in persistent-pre.tsv nft-table-pre.txt rfkill-all-pre.txt rfkill-target-pre.txt default-route-pre.txt identities-pre.txt radio-pre.txt \
         broker-identity-pre.txt core-tuple-pre.txt baseline.txt nm-devices-pre.txt journal.tsv rfkill_id; do
  [ -f "$WORK/$f" ] || fail "PRE_BASELINE_MISSING:$f"
done
if [ -n "$ROOT" ]; then
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
fi

# persistent accepted artifacts: byte/metadata identical to the pre-mutation snapshot, and still the accepted content
l34_v8_persistent_verify "$WORK/persistent-pre.tsv" yes || fail "$(reason_of l34_v8_persistent_verify "$WORK/persistent-pre.tsv" yes)"
l34_profile_gate "$(host_path "$L34_PROFILE")" || fail "$(reason_of l34_profile_gate "$(host_path "$L34_PROFILE")")"
l34_dnsmasq_conf_gate "$(host_path "$L34_DNSMASQ_CONF")" || fail L34_DNSMASQ_CONF_CHANGED
l34_dnsmasq_unit_gate "$(host_path "$L34_DNSMASQ_UNIT")" "$EXAMPLE_UNIT" || fail L34_DNSMASQ_UNIT_CHANGED
l34_v7_broker_conf_gate "$(host_path "$L34_V7_BROKER_CONF")" || fail "$(reason_of l34_v7_broker_conf_gate "$(host_path "$L34_V7_BROKER_CONF")")"

# AP runtime
l34_ap_active_gate "$AP_IF" || fail "$(reason_of l34_ap_active_gate "$AP_IF")"
l3_reg_verify_active "$AP_IF" "$L34_CHANNEL" || fail "$L3_REG_REASON"
[ "$(ip route show default)" = "$(cat "$WORK/default-route-pre.txt")" ] || fail L34_DEFAULT_ROUTE_CHANGED
[ "$(nmcli -g GENERAL.CONNECTION device show "$AP_IF" 2>/dev/null)" = "$L34_CONN" ] || fail L34_ACTIVE_CONNECTION_NOT_APPROVED_PROFILE

# rfkill: exactly the target was unblocked, nothing else changed
l34_rfkill_only_target_changed "$WORK/rfkill-all-pre.txt" "$(cat "$WORK/rfkill_id")" || fail L34_RFKILL_NON_TARGET_CHANGED
l3_rfkill_state "$(cat "$WORK/rfkill_id")" || fail "$L3_RFKILL_REASON"
[ "$L3_RFKILL_SOFT" = unblocked ] && [ "$L3_RFKILL_HARD" != blocked ] || fail L34_TARGET_RFKILL_NOT_UNBLOCKED

# radio: disabled before, enabled now (by this run's single enable, or already enabled by the exact unblock)
[ "$(cat "$WORK/radio-pre.txt")" = disabled ] || fail L34_V8_RADIO_PRE_NOT_DISABLED
[ "$(nmcli radio wifi 2>/dev/null)" = enabled ] || fail L34_NM_RADIO_NOT_ENABLED

# the only active Wi-Fi connection is the approved profile on the target
wifi_active=$(nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | grep -c '^802-11-wireless' || true)
[ "$wifi_active" = 1 ] || fail L34_UNRELATED_WIFI_ACTIVE
nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | grep -qx "802-11-wireless:$AP_IF" || fail L34_UNRELATED_WIFI_ACTIVE

# device autoconnect restored to its exact PRE value; the persisted profile's own autoconnect carries the ONE authorized change, journaled exactly once
prior=$(awk -F'\t' '$1 == "NM_DEVICE_AUTOCONNECT_DISABLE" { print $2 }' "$WORK/journal.tsv")
[[ "$prior" =~ ^(yes|no)$ ]] || fail L34_DEVICE_AUTOCONNECT_PRIOR_MISSING
[ "$(nmcli -g GENERAL.AUTOCONNECT device show "$AP_IF" 2>/dev/null)" = "$prior" ] || fail L34_DEVICE_AUTOCONNECT_NOT_RESTORED
[ "$(l34_v8_journal_count "$WORK/journal.tsv" NM_PROFILE_AUTOCONNECT_ENABLE)" = 1 ] || fail L34_V8_PROFILE_AUTOCONNECT_JOURNAL_NOT_EXACTLY_ONE
l34_v8_profile_autoconnect_enabled_gate "$(host_path "$L34_PROFILE")" || fail "$(reason_of l34_v8_profile_autoconnect_enabled_gate "$(host_path "$L34_PROFILE")")"

# V3 envelope: the only side effects of NetworkManager Wi-Fi initialization are the exact p2p pseudo-device and the wpa_supplicant lifecycle
new_devs=$(comm -13 "$WORK/nm-devices-pre.txt" <(l34_nm_devices_listing) | grep -vx 'p2p-dev-wlp0s20f3:wifi-p2p' || true)
[ -z "$new_devs" ] || fail L34_V3_UNEXPECTED_NM_DEVICE
[ "$(l34_nm_status_snapshot | l34_p2p_inventory)" = "$L34_P2P_POST_ROW" ] || fail L34_V3_P2P_DEVICE_STATE
wpa=$(systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID -p NRestarts wpa_supplicant.service)
for kv in LoadState=loaded ActiveState=active SubState=running UnitFileState=disabled Result=success NRestarts=0; do
  grep -qx "$kv" <<< "$wpa" || fail "L34_V3_WPA_SUPPLICANT_${kv%%=*}"
done
grep -Eq '^MainPID=[1-9][0-9]*$' <<< "$wpa" || fail L34_V3_WPA_SUPPLICANT_MainPID

# dnsmasq: active/running with its exact listeners
unit_props "$DNSMASQ_UNIT" | l34_service_active_gate || fail "$(unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR")"

# the L6b broker: active/running, exact 8883 pair, restart counter above PRE (its own automatic restart), and STABLE over a bounded sample.
# This handler never issued a start/stop/restart/reset-failed against it (structurally enforced by a static regression test).
unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" || fail "$(unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" 2>&1 | head -n 1)"
l34_v4_broker_listeners_gate "$L34_AP_ADDR" || fail "$(reason_of l34_v4_broker_listeners_gate "$L34_AP_ADDR")"
l34_v5_broker_autorestart_evidence "$BROKER_UNIT" "$WORK/broker-identity-pre.txt" || fail "$(reason_of l34_v5_broker_autorestart_evidence "$BROKER_UNIT" "$WORK/broker-identity-pre.txt")"
l34_v7_broker_stable_gate "$BROKER_UNIT" "$WORK/broker-tuple-verify.txt" "$L34_V7_STABLE_SAMPLES" "$STABLE_INTERVAL" \
  || fail "$(reason_of l34_v7_broker_stable_gate "$BROKER_UNIT" "$WORK/broker-tuple-verify.txt" "$L34_V7_STABLE_SAMPLES" "$STABLE_INTERVAL")"

# Core exactly unchanged
l34_v7_core_unchanged "$CORE_UNIT" "$WORK/core-tuple-pre.txt" || fail "$(reason_of l34_v7_core_unchanged "$CORE_UNIT" "$WORK/core-tuple-pre.txt")"

# L2 and forwarding unchanged
nft list table inet aegis_idea3 > "$WORK/nft-table-post.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-post.txt" || fail L2_NFT_TABLE_CHANGED
l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-post.txt" || fail "$(l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-post.txt" 2>&1 | head -n 1)"
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"

# legacy mosquitto / Twingate / IDEA2 identities unchanged
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-post.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-post.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED

printf 'L34_V8_VERIFY=PASS\n'
printf 'L34_BASELINE=%s\n' "$(cat "$WORK/baseline.txt")"
printf 'AP_RUNTIME=ACTIVE SSID=%s CHANNEL=%s ADDRESS=%s/%s\n' "$L34_SSID" "$L34_CHANNEL" "$L34_AP_ADDR" "$L34_AP_PREFIX"
printf 'RFKILL_TARGET=UNBLOCKED NM_WIFI_RADIO=ENABLED\n'
printf 'AP_PROFILE_AUTOCONNECT=YES (the one authorized persistent change; every other non-secret profile record semantically unchanged; key order and daemon uuid ignored)\n'
printf 'DNSMASQ=ACTIVE_RUNNING (reactivated this run)\n'
printf 'L6B_BROKER=ACTIVE_RUNNING (recovered through its own systemd auto-restart; no broker service-control command issued; tuple stable)\n'
printf 'CORE_UNCHANGED=YES\n'
printf 'OTHER_PERSISTENT_FILES_UNCHANGED=YES\n'
printf 'UNRELATED_WIFI_ACTIVE=NO\n'
printf 'L2_UNCHANGED=YES\n'
printf 'FORWARDING=ZERO\n'
printf 'LEGACY_MOSQUITTO_TWINGATE_IDEA2=UNCHANGED\n'
printf 'K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN\n'
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
