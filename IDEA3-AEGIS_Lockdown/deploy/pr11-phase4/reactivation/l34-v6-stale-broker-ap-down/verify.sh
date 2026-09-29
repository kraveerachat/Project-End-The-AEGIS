#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 STALE-BROKER / AP-DOWN runtime reactivation verification handler (V6). Read-only.
# Proves the AP and dnsmasq runtime are active, that the broker is UNTOUCHED (active/running/success/enabled, tuple == PRE, exact 8883
# pair), that nothing else moved (persistent profile/dnsmasq/broker config, L2 nft/PF-01, forwarding, no NAT, no unrelated Wi-Fi,
# device autoconnect restored, legacy mosquitto/Twingate/IDEA2 identities, legacy :1883 byte-identical), and then runs the frozen
# 6 x 5 s soak (each sample re-checks the AP gate, no AP default route, dnsmasq + listeners, the broker pair and the broker tuple).
# Never prints the PSK or broker credentials. Sends no MQTT bytes.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_V6_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L34_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
DNSMASQ_UNIT=$L34_UNIT
BROKER_UNIT=$L34_V6_BROKER_UNIT
# Live soak is frozen at 6 samples x 5 s. Only fixture (stubbed) runs may shorten the interval.
SOAK_SAMPLES=$L34_V6_SOAK_SAMPLES
SOAK_INTERVAL=5
if [ -n "$ROOT" ]; then SOAK_INTERVAL="${AEGIS_L34_V6_SOAK_INTERVAL:-5}"; fi

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }
reason_of() { "$@" 2>&1 >/dev/null | head -n 1; }

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
for f in persistent-pre.tsv nft-table-pre.txt default-route-pre.txt identities-pre.txt radio-pre.txt broker-tuple-pre.txt legacy-1883-pre.txt journal.tsv; do
  [ -f "$WORK/$f" ] || fail "PRE_BASELINE_MISSING:$f"
done
if [ -n "$ROOT" ]; then
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
fi

# persistent accepted artifacts: byte/metadata identical to the pre-mutation snapshot
l34_persistent_verify "$WORK/persistent-pre.tsv" || fail "$(reason_of l34_persistent_verify "$WORK/persistent-pre.tsv")"
l34_profile_gate "$(host_path "$L34_PROFILE")" || fail "$(reason_of l34_profile_gate "$(host_path "$L34_PROFILE")")"

# AP runtime
l34_ap_active_gate "$AP_IF" || fail "$(reason_of l34_ap_active_gate "$AP_IF")"
[ "$(ip route show default)" = "$(cat "$WORK/default-route-pre.txt")" ] || fail L34_DEFAULT_ROUTE_CHANGED
[ "$(nmcli -g GENERAL.CONNECTION device show "$AP_IF" 2>/dev/null)" = "$L34_CONN" ] || fail L34_ACTIVE_CONNECTION_NOT_APPROVED_PROFILE
[ "$(nmcli radio wifi 2>/dev/null)" = "$(cat "$WORK/radio-pre.txt")" ] || fail L34_RADIO_STATE_CHANGED
l34_v4_rfkill_ready_gate || fail "$(reason_of l34_v4_rfkill_ready_gate)"

# no unrelated Wi-Fi device/profile is active: the only active Wi-Fi connection is the approved profile on the target
wifi_active=$(nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | grep -c '^802-11-wireless' || true)
[ "$wifi_active" = 1 ] || fail L34_UNRELATED_WIFI_ACTIVE
nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | grep -qx "802-11-wireless:$AP_IF" || fail L34_UNRELATED_WIFI_ACTIVE

# device autoconnect restored to its exact PRE value; the persisted profile's own autoconnect was never written
prior=$(awk -F'\t' '$1 == "NM_DEVICE_AUTOCONNECT_DISABLE" { print $2 }' "$WORK/journal.tsv")
[[ "$prior" =~ ^(yes|no)$ ]] || fail L34_DEVICE_AUTOCONNECT_PRIOR_MISSING
[ "$(nmcli -g GENERAL.AUTOCONNECT device show "$AP_IF" 2>/dev/null)" = "$prior" ] || fail L34_DEVICE_AUTOCONNECT_NOT_RESTORED
[ "$(l34_v4_ap_profile_autoconnect)" = no ] || fail L34_AP_PROFILE_AUTOCONNECT_CHANGED

# L2 and forwarding unchanged
nft list table inet aegis_idea3 > "$WORK/nft-table-post.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-post.txt" || fail L2_NFT_TABLE_CHANGED
l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-post.txt" || fail "$(l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-post.txt" 2>&1 | head -n 1)"
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"

# legacy mosquitto / Twingate / IDEA2 identities unchanged, legacy plaintext :1883 byte-identical, no new :1883
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-post.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-post.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED
l34_v6_legacy_1883_unchanged "$WORK/legacy-1883-pre.txt" || fail "$(reason_of l34_v6_legacy_1883_unchanged "$WORK/legacy-1883-pre.txt")"

# dnsmasq: active/running with its exact expected listeners (started by this run's one plain start)
l34_v6_unit_props "$DNSMASQ_UNIT" | l34_service_active_gate || fail "$(l34_v6_unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR")"

# the broker: never commanded by this handler set (structurally true — enforced by a static regression test). Preservation is PROVEN, not
# assumed: active/running/success/enabled, MainPID/NRestarts/InvocationID all equal to PRE, and exactly the approved 8883 pair.
l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_AP_ADDR" \
  || fail "$(reason_of l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_AP_ADDR")"

printf 'L34_V6_VERIFY=PASS\n'
printf 'AP_RUNTIME=ACTIVE SSID=%s CHANNEL=%s ADDRESS=%s/%s\n' "$L34_SSID" "$L34_CHANNEL" "$L34_AP_ADDR" "$L34_AP_PREFIX"
printf 'DNSMASQ=ACTIVE_RUNNING (started this run)\n'
printf 'L6B_BROKER=ACTIVE_RUNNING TUPLE_EQUALS_PRE=YES STALE_PAIR_PRESERVED=YES BROKER_CONTROL_COMMAND_ISSUED=NO\n'
printf 'PERSISTENT_FILES_UNCHANGED=YES\n'
printf 'UNRELATED_WIFI_ACTIVE=NO\n'
printf 'L2_UNCHANGED=YES\n'
printf 'FORWARDING=ZERO\n'
printf 'LEGACY_MOSQUITTO_1883_TWINGATE_IDEA2=UNCHANGED\n'

# soak: 6 samples, 5 s apart, every sample re-proving AP, route, dnsmasq + listeners, broker pair and broker tuple
l34_v6_soak "$AP_IF" "$WORK/default-route-pre.txt" "$WORK/broker-tuple-pre.txt" "$SOAK_SAMPLES" "$SOAK_INTERVAL" > "$WORK/soak.txt" 2> "$WORK/soak.err" \
  || { cat "$WORK/soak.txt"; fail "$(head -n 1 "$WORK/soak.err")"; }
cat "$WORK/soak.txt"
printf 'L34_V6_SOAK=PASS SAMPLES=%s INTERVAL_S=%s\n' "$SOAK_SAMPLES" "$SOAK_INTERVAL"
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
