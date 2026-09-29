#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 STALE-BROKER / AP-DOWN RUNTIME REACTIVATION apply handler (RUNTIME_ONLY, V6).
# MUTATING in live mode. V6_STAGE_NAME=l34-v6-stale-broker-ap-down  V6_BASELINE_ID=STALE_BROKER_AP_DOWN
# Distinct from V1–V3 (NM radio disabled), V4 (dnsmasq AND broker healthy, AP up) and V5 (dnsmasq failed, broker crash-looping).
# V6 supports EXACTLY ONE baseline: V4's wifi/rfkill/radio/wpa topology (radio enabled, target disconnected, rfkill unblocked),
# aegis-idea3-dnsmasq.service loaded/enabled/inactive/dead/success/MainPID=0 (clean, NOT failed), the AP address and every AP
# DNS/DHCP listener ABSENT, and aegis-idea3-mosquitto.service active/running/success/enabled with a tuple that is stable across
# three samples and holds exactly the stale 8883 pair (127.0.0.1:8883 and 10.77.30.1:8883).
#
# V6 performs EXACTLY, in this order:
#   1 journal autoconnect disable   2 device autoconnect no    3 bounded NM ready        4 journal NM_UP
#   5 one `nmcli connection up aegis-idea3-ap ifname wlp0s20f3`  6 AP/default-route/radio proof
#   7 journal autoconnect restore   8 restore PRE autoconnect   9 prove the AP address   10 journal DNSMASQ_START
#   11 one `systemctl start aegis-idea3-dnsmasq.service`         12 bounded dnsmasq active + listener polls
#   13 bounded exact broker-pair poll  14 ONE handshake-only TLS probe (p4-l7-broker-probe.py) to 10.77.30.1:8883
#   15 broker tuple == PRE          16 persistent/nft/forwarding/preservation gates
# (verify.sh = 17, the 6x5s soak = 18, POST capture/compare/identity = 19–21 belong to verify.sh and the owner runner.)
# NO command is EVER issued against the broker (no start/stop/restart/reload/reset-failed/kill/try-restart/enable/disable/mask); the
# broker is only READ before and after. There is NO reset-failed on this path: dnsmasq is cleanly inactive, so a plain start suffices.
# Never rewrites the NM profile, dnsmasq config/unit or broker config; never touches rfkill, the global NM radio, nftables, forwarding,
# regulatory state, enp62s0, legacy mosquitto (incl. :1883), Twingate, IDEA1/IDEA2; sends no MQTT bytes; no ESP32; no L7/L8; claims NO
# L3/L4/L6b live acceptance. Every runtime change is journaled BEFORE it is made so rollback.sh undoes exactly what this run changed.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_V6_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
REPO_ROOT="$(cd "$P4_HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
# shellcheck source=../../p4-l3-nm.sh
. "$P4_HERE/p4-l3-nm.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L34_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
NM_TRIES="${AEGIS_L34_NM_TRIES:-20}"
NM_INTERVAL="${AEGIS_L34_NM_INTERVAL:-0.5}"
# Live timing is frozen. Only fixture (stubbed) runs may shorten the waits, so a live operator has no soak/stability/probe knob.
STABLE_INTERVAL=5
PROBE_TIMEOUT=20
DNS_TRIES=20
DNS_INTERVAL=0.5
BROKER_TRIES=15
BROKER_INTERVAL=1
if [ -n "$ROOT" ]; then
  STABLE_INTERVAL="${AEGIS_L34_V6_STABLE_INTERVAL:-5}"
  PROBE_TIMEOUT="${AEGIS_L34_V6_PROBE_TIMEOUT:-20}"
  DNS_TRIES="${AEGIS_L34_V6_TRIES:-20}"; DNS_INTERVAL="${AEGIS_L34_V6_INTERVAL:-0.5}"
  BROKER_TRIES="${AEGIS_L34_V6_TRIES:-15}"; BROKER_INTERVAL="${AEGIS_L34_V6_INTERVAL:-1}"
  L34_V6_PROBE_CMD="${AEGIS_L34_V6_PROBE_CMD:-}"
else
  L34_V6_PROBE_CMD=""
fi
PY="${AEGIS_L34_V6_PYTHON:-python3}"
DNSMASQ_UNIT=$L34_UNIT
BROKER_UNIT=$L34_V6_BROKER_UNIT
EXAMPLE_UNIT="$(cd "$P4_HERE/../network" && pwd)/aegis-idea3-dnsmasq.service.example"

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
journal() { printf '%s\t%s\n' "$1" "$2" >> "$WORK/journal.tsv" || fail JOURNAL_WRITE_FAILED; }
identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }
reason_of() { "$@" 2>&1 >/dev/null | head -n 1; }

# ── 1. environment / authorization ──────────────────────────────────────────────────────────────────────────────────
[ -n "$WORK" ] || fail AEGIS_L34_WORK_DIR_REQUIRED
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
case "$WORK" in /etc/*) fail WORK_DIR_INSIDE_ETC ;; esac
[ ! -L "$WORK" ] || fail WORK_DIR_IS_SYMLINK
[ ! -e "$WORK" ] || fail WORK_DIR_ALREADY_EXISTS
if [ -z "$ROOT" ]; then
  [ "${AEGIS_L34_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
  case "$PY" in /*) [ -x "$PY" ] || fail V6_PROBE_PYTHON_INVALID ;; *) fail V6_PROBE_PYTHON_INVALID ;; esac
else
  # Fixture mode drives the SAME code path, so every command must be a test stub: refuse to run against real host tools.
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
fi
umask 077
mkdir -p "$WORK" || fail WORK_DIR_CREATE_FAILED
chmod 700 "$WORK"
: > "$WORK/journal.tsv"
chmod 600 "$WORK/journal.tsv"

profile=$(host_path "$L34_PROFILE")
conf=$(host_path "$L34_DNSMASQ_CONF")
unit_file=$(host_path "$L34_DNSMASQ_UNIT")
broker_conf=$(host_path "$L34_V6_BROKER_CONF")

# ── 2. read-only preflight: nothing below changes any state until PRODUCTION_MUTATION_PERFORMED=YES ─────────────────────
l34_profile_gate "$profile" || fail "$(reason_of l34_profile_gate "$profile")"
l34_profile_effective_gate || fail "$(reason_of l34_profile_effective_gate)"
l34_dnsmasq_conf_gate "$conf" || fail "$(reason_of l34_dnsmasq_conf_gate "$conf")"
l34_dnsmasq_unit_gate "$unit_file" "$EXAMPLE_UNIT" || fail L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY
dnsmasq --test --conf-file="$conf" >/dev/null 2>&1 || fail DNSMASQ_CONFIG_SYNTAX_FAIL
[ -f "$broker_conf" ] && [ ! -L "$broker_conf" ] || fail L34_V6_BROKER_CONF_MISSING
l34_persistent_snapshot "$WORK/persistent-pre.tsv" "$profile" "$conf" "$unit_file" "$broker_conf" || fail L34_PERSISTENT_SNAPSHOT_FAILED

nft list table inet aegis_idea3 > "$WORK/nft-table-pre.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" || fail "$(l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" 2>&1 | head -n 1)"
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"

l34_wifi_topology_gate "$AP_IF" "$(host_path /sys)" || fail "$(reason_of l34_wifi_topology_gate "$AP_IF" "$(host_path /sys)")"
l34_ap_pre_gate "$AP_IF" || fail "$(reason_of l34_ap_pre_gate "$AP_IF")"
l34_v6_ap_address_absent_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v6_ap_address_absent_gate "$AP_IF" "$L34_AP_ADDR")"
l34_no_wifi_active_gate || fail "$(reason_of l34_no_wifi_active_gate)"
l34_v4_rfkill_ready_gate || fail "$(reason_of l34_v4_rfkill_ready_gate)"

radio_pre=$(nmcli radio wifi 2>/dev/null || true)
nm_snapshot=$(l34_nm_status_snapshot) || fail L34_NM_DEVICE_INVENTORY_UNREADABLE
target_state=$(awk -F: -v ifc="$AP_IF" '$1 == ifc { split($3, w, " "); print w[1] }' <<< "$nm_snapshot")
p2p_inventory=$(l34_p2p_inventory <<< "$nm_snapshot")
wifi_devices=$(l34_wifi_devices <<< "$nm_snapshot")
wpa_props=$(l34_v6_unit_props wpa_supplicant.service)
l34_v4_baseline_gate "$radio_pre" "$target_state" "$wifi_devices" "$p2p_inventory" <<< "$wpa_props" \
  || fail "$(l34_v4_baseline_gate "$radio_pre" "$target_state" "$wifi_devices" "$p2p_inventory" <<< "$wpa_props" 2>&1 | head -n 1)"
printf '%s\n' "$radio_pre" > "$WORK/radio-pre.txt"

dev_ac_pre=$(l34_device_autoconnect "$AP_IF") || fail L34_DEVICE_AUTOCONNECT_UNREADABLE
ap_profile_ac=$(l34_v4_ap_profile_autoconnect) || fail L34_AP_PROFILE_AUTOCONNECT_UNREADABLE
l34_v4_autoconnect_pre_gate "$dev_ac_pre" "$ap_profile_ac" || fail "$(reason_of l34_v4_autoconnect_pre_gate "$dev_ac_pre" "$ap_profile_ac")"

l34_v6_unit_props "$DNSMASQ_UNIT" > "$WORK/dnsmasq-pre.txt" || fail L34_DNSMASQ_SHOW_FAILED
l34_v6_dnsmasq_pre_gate < "$WORK/dnsmasq-pre.txt" || fail "$(l34_v6_dnsmasq_pre_gate < "$WORK/dnsmasq-pre.txt" 2>&1 | head -n 1)"
l34_v6_no_ap_dns_dhcp_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v6_no_ap_dns_dhcp_gate "$AP_IF" "$L34_AP_ADDR")"

l34_v6_unit_props "$BROKER_UNIT" > "$WORK/broker-pre.txt" || fail L34_V6_BROKER_SHOW_FAILED
l34_v4_service_active_gate "$BROKER_UNIT" < "$WORK/broker-pre.txt" || fail "$(l34_v4_service_active_gate "$BROKER_UNIT" < "$WORK/broker-pre.txt" 2>&1 | head -n 1)"
stable_why=$(l34_v6_broker_stable_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_V6_STABLE_SAMPLES" "$STABLE_INTERVAL" 2>&1 >/dev/null) \
  || fail "$(head -n 1 <<< "$stable_why")"
l34_v4_broker_listeners_gate "$L34_AP_ADDR" || fail "$(reason_of l34_v4_broker_listeners_gate "$L34_AP_ADDR")"
l34_v6_legacy_1883_snapshot "$WORK/legacy-1883-pre.txt" || fail "$(reason_of l34_v6_legacy_1883_snapshot "$WORK/legacy-1883-pre.txt")"

for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-pre.txt"
ip route show default > "$WORK/default-route-pre.txt"

if [ "${AEGIS_L34_PREFLIGHT_ONLY:-NO}" = YES ]; then
  printf 'L34_V6_PREFLIGHT=PASS\n'
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
  exit 0
fi

# ── 3. FIRST runtime mutation (the runner takes its PRE capture and consumes the attempt before calling this handler) ────
# The marker is written and confirmed BEFORE any mutating command: the runner decides whether rollback.sh must run by testing
# for it, so a silently-failed write would leave a mutated host with no rollback attempted. Fail closed if it cannot be written.
printf 'YES\n' > "$WORK/production-mutation" || fail PRODUCTION_MUTATION_MARKER_WRITE_FAILED
printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'

# 1–2. temporarily disable device autoconnect (PRE value restored below) so no remembered Wi-Fi profile races the one activation
journal NM_DEVICE_AUTOCONNECT_DISABLE "$dev_ac_pre"
nmcli device set "$AP_IF" autoconnect no || fail NM_DEVICE_AUTOCONNECT_SET_FAILED

# 3–5. bounded NetworkManager target-device readiness (state based; not an activation retry), then ONE bound activation
l3_nm_wait_ready "$AP_IF" "$NM_TRIES" "$NM_INTERVAL" || fail "$L3_NM_REASON"
journal NM_UP "$L34_CONN"
l3_nm_activate "$AP_IF" "$L34_CONN" || fail "$L3_NM_REASON"

# 6. AP / default-route / radio proof
ap_ok=1
for ((i = 1; i <= NM_TRIES; i++)); do
  if l34_ap_active_gate "$AP_IF" 2>/dev/null; then ap_ok=0; break; fi
  [ "$i" -lt "$NM_TRIES" ] && sleep "$NM_INTERVAL"
done
[ "$ap_ok" = 0 ] || fail "$(reason_of l34_ap_active_gate "$AP_IF")"
[ "$(ip route show default)" = "$(cat "$WORK/default-route-pre.txt")" ] || fail L34_DEFAULT_ROUTE_CHANGED
[ "$(nmcli radio wifi 2>/dev/null)" = "$radio_pre" ] || fail L34_RADIO_STATE_CHANGED

# 7–8. restore device autoconnect to exactly its PRE value
journal NM_DEVICE_AUTOCONNECT_RESTORED "$dev_ac_pre"
nmcli device set "$AP_IF" autoconnect "$dev_ac_pre" || fail NM_DEVICE_AUTOCONNECT_RESTORE_FAILED

# 9. the AP address exists (exact address, no default route through the AP)
l34_ap_active_gate "$AP_IF" || fail "$(reason_of l34_ap_active_gate "$AP_IF")"

# 10–12. the existing accepted dnsmasq service ONLY: journal, ONE plain start (no reset-failed, no enable/disable), bounded polls
journal DNSMASQ_START "$DNSMASQ_UNIT"
systemctl start "$DNSMASQ_UNIT" || fail DNSMASQ_SERVICE_START_FAILED
dns_ok=1
for ((i = 1; i <= DNS_TRIES; i++)); do
  if l34_v6_unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>/dev/null; then dns_ok=0; break; fi
  [ "$i" -lt "$DNS_TRIES" ] && sleep "$DNS_INTERVAL"
done
[ "$dns_ok" = 0 ] || fail "$(l34_v6_unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
lst_ok=1
for ((i = 1; i <= DNS_TRIES; i++)); do
  if l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" 2>/dev/null; then lst_ok=0; break; fi
  [ "$i" -lt "$DNS_TRIES" ] && sleep "$DNS_INTERVAL"
done
[ "$lst_ok" = 0 ] || fail "$(reason_of l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR")"

# 13. bounded, read-only, exact broker-pair poll (the pair is already present; this only confirms it is still exactly that pair)
pair_ok=1
for ((i = 1; i <= BROKER_TRIES; i++)); do
  if l34_v4_broker_listeners_gate "$L34_AP_ADDR" 2>/dev/null; then pair_ok=0; break; fi
  [ "$i" -lt "$BROKER_TRIES" ] && sleep "$BROKER_INTERVAL"
done
if [ "$pair_ok" != 0 ]; then
  ss -H -ltn "sport = :8883" > "$WORK/broker-listeners-observed.txt" 2>&1 || true  # evidence of what the gate last saw
  fail "$(reason_of l34_v4_broker_listeners_gate "$L34_AP_ADDR")"
fi

# 14. ONE handshake-only TLS probe to the AP address, through the unchanged p4-l7-broker-probe.py (never 127.0.0.1, no MQTT bytes)
# The probe is captured ONCE: its failure reason is read from that single run, never by probing again.
probe_err=$(l34_v6_tls_probe "$PY" "$P4_HERE" "$REPO_ROOT" "$PROBE_TIMEOUT" 2>&1 >"$WORK/tls-probe.txt") || fail "$(head -n 1 <<< "$probe_err")"

# 15. the broker tuple is EXACTLY the PRE tuple: this run never restarted, replaced or re-invoked the broker
l34_v6_broker_tuple_equal "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" || fail "$(reason_of l34_v6_broker_tuple_equal "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt")"

# 16. persistent / nft / forwarding / preservation gates: nothing but the approved runtime footprint moved
l34_persistent_verify "$WORK/persistent-pre.tsv" || fail "$(reason_of l34_persistent_verify "$WORK/persistent-pre.tsv")"
nft list table inet aegis_idea3 > "$WORK/nft-table-apply.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-apply.txt" || fail L2_NFT_TABLE_CHANGED
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"
l34_v6_legacy_1883_unchanged "$WORK/legacy-1883-pre.txt" || fail "$(reason_of l34_v6_legacy_1883_unchanged "$WORK/legacy-1883-pre.txt")"
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-apply.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-apply.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED

printf 'L34_V6_APPLY=PASS\n'
printf 'REACTIVATION_TYPE=RUNTIME_ONLY\n'
printf 'PERSISTENT_FILES_REWRITTEN=NO\n'
printf 'DNSMASQ_MUTATED=YES (one plain start only)\n'
printf 'BROKER_CONTROL_COMMAND_ISSUED=NO\n'
printf 'BROKER_TUPLE_EQUALS_PRE=YES\n'
printf 'TLS_PROBE=PASS via p4-l7-broker-probe.py\n'
printf 'RFKILL_MUTATED=NO\n'
printf 'NM_RADIO_MUTATED=NO\n'
printf 'L3_LIVE_ACCEPTANCE_CLAIMED=NO\n'
printf 'L4_LIVE_ACCEPTANCE_CLAIMED=NO\n'
printf 'L6B_LIVE_ACCEPTANCE_CLAIMED=NO\n'
