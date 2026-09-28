#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-L6b/L6c DEGRADED runtime reactivation verification handler (V5). Read-only.
# Proves the AP and dnsmasq runtime are active AND that the L6b broker recovered to active/running with its exact
# expected listeners, AND that nothing else moved: persistent profile/dnsmasq/broker config unchanged, L2 nft/PF-01
# unchanged, forwarding zero, no NAT, no unrelated Wi-Fi active, device autoconnect restored to its exact PRE value,
# legacy mosquitto/Twingate/IDEA2 identities unchanged. Never prints the PSK or broker credentials.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_V5_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L34_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
DNSMASQ_UNIT=aegis-idea3-dnsmasq.service
BROKER_UNIT=aegis-idea3-mosquitto.service

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }

[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
for f in persistent-pre.tsv nft-table-pre.txt default-route-pre.txt identities-pre.txt radio-pre.txt \
         broker-identity-pre.txt journal.tsv; do
  [ -f "$WORK/$f" ] || fail "PRE_BASELINE_MISSING:$f"
done
if [ -n "$ROOT" ]; then
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
fi

# persistent accepted artifacts: byte/metadata identical to the pre-mutation snapshot (profile, dnsmasq conf/unit,
# broker conf — V5 never rewrites any of them, even though it starts dnsmasq and waits on the broker)
l34_persistent_verify "$WORK/persistent-pre.tsv" || fail "$(l34_persistent_verify "$WORK/persistent-pre.tsv" 2>&1 | head -n 1)"
l34_profile_gate "$(host_path "$L34_PROFILE")" || fail "$(l34_profile_gate "$(host_path "$L34_PROFILE")" 2>&1 | head -n 1)"

# AP runtime
l34_ap_active_gate "$AP_IF" || fail "$(l34_ap_active_gate "$AP_IF" 2>&1 | head -n 1)"
[ "$(ip route show default)" = "$(cat "$WORK/default-route-pre.txt")" ] || fail L34_DEFAULT_ROUTE_CHANGED
[ "$(nmcli -g GENERAL.CONNECTION device show "$AP_IF" 2>/dev/null)" = "$L34_CONN" ] || fail L34_ACTIVE_CONNECTION_NOT_APPROVED_PROFILE
[ "$(nmcli radio wifi 2>/dev/null)" = "$(cat "$WORK/radio-pre.txt")" ] || fail L34_RADIO_STATE_CHANGED
l34_v4_rfkill_ready_gate || fail "$(l34_v4_rfkill_ready_gate 2>&1 | head -n 1)"

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
l34_forwarding_gate "$AP_IF" || fail "$(l34_forwarding_gate "$AP_IF" 2>&1 | head -n 1)"

# legacy mosquitto / Twingate / IDEA2 identities unchanged
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-post.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-post.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED

# dnsmasq: now active/running with its exact expected listeners (reactivated by this run's own reset-failed+start)
unit_props "$DNSMASQ_UNIT" | l34_service_active_gate \
  || fail "$(unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" 2>&1 | head -n 1)"

# the L6b broker: now active/running with its exact expected listeners, recovered ONLY via its own systemd
# auto-restart (this handler never issued start/stop/restart/reset-failed against it)
unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" \
  || fail "$(unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" 2>&1 | head -n 1)"
l34_v4_broker_listeners_gate "$L34_AP_ADDR" || fail "$(l34_v4_broker_listeners_gate "$L34_AP_ADDR" 2>&1 | head -n 1)"

printf 'L34_V5_VERIFY=PASS\n'
printf 'AP_RUNTIME=ACTIVE SSID=%s CHANNEL=%s ADDRESS=%s/%s\n' "$L34_SSID" "$L34_CHANNEL" "$L34_AP_ADDR" "$L34_AP_PREFIX"
printf 'DNSMASQ=ACTIVE_RUNNING (reactivated this run)\n'
printf 'L6B_BROKER=ACTIVE_RUNNING (recovered via systemd auto-restart, never commanded)\n'
printf 'PERSISTENT_FILES_UNCHANGED=YES\n'
printf 'UNRELATED_WIFI_ACTIVE=NO\n'
printf 'L2_UNCHANGED=YES\n'
printf 'FORWARDING=ZERO\n'
printf 'LEGACY_MOSQUITTO_TWINGATE_IDEA2=UNCHANGED\n'
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
