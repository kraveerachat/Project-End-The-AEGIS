#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-V7 PERSISTENT AP RECOVERY apply handler (V8, OD-L34-V8-01).
# MUTATING in live mode. V8_STAGE_NAME=l34-v8-post-v7-persistent-ap-recovery  V8_BASELINE_ID=POST_V7_RADIO_DISABLED_AP_DOWN_BROKER_CHURN
# V7 was RUNTIME_ONLY (K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN); two reboots later the host is back in the radio-disabled / AP-down / broker-churn state.
# V8 is a NEW, one-shot governed stage (its own handlers, runner and marker; V7 state, authorization, runner and marker are never reused). It supports
# EXACTLY ONE baseline: target wlan rfkill soft-blocked (not hard-blocked), NM Wi-Fi radio disabled, wlp0s20f3 unavailable, no active Wi-Fi connection,
# the approved aegis-idea3-ap profile intact with connection.autoconnect=no, no AP address, aegis-idea3-dnsmasq.service failed/start-limit-hit, and the
# L6b broker crash-looping through its OWN systemd auto-restart ONLY because 10.77.30.1 is absent (the strict V7 current-boot, current-invocation journal
# contract, reused unchanged), no :8883 listener, a management alternate default route, Core healthy.
# It performs EXACTLY, in this order (every mutation is journaled BEFORE it is made so rollback.sh undoes only what this run owns):
#   1 exact-ID rfkill unblock   2 device autoconnect off   3 ONE `nmcli radio wifi on`   4 BOUNDED wait for wlp0s20f3 == disconnected
#   5 ONE PERSISTENT `nmcli connection modify aegis-idea3-ap connection.autoconnect yes` (the ONLY persistent change V8 may make)
#   6 ONE `nmcli connection up aegis-idea3-ap ifname wlp0s20f3`   7 restore device autoconnect to its exact PRE value
#   8 exact AP / interface / address / default-route invariants   9 `systemctl reset-failed` + 10 ONE `systemctl start` of aegis-idea3-dnsmasq.service ONLY
#   11 READ-ONLY bounded wait for the broker's own auto-restart   12 exact 8883 pair   13 ONE handshake-only TLS probe   14 broker tuple stable
#   15 Core tuple unchanged   16 every persistent artifact unchanged except the one authorized autoconnect field.
# It NEVER issues any command against the broker or Core, never edits /var/lib/systemd/rfkill or any NetworkManager state file, never edits broker,
# dnsmasq or unit configuration, never touches nftables, NAT, forwarding, regulatory state, enp62s0, legacy mosquitto, Twingate, IDEA1/IDEA2, ESP32,
# Recovery R1–R8, L7u or L8, and claims NO K12, L3, L4 or L6b acceptance.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_V8_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
REPO_ROOT="$(cd "$P4_HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
# shellcheck source=../../p4-l34-v8-lib.sh
. "$P4_HERE/p4-l34-v8-lib.sh"
# shellcheck source=../../p4-l3-rfkill.sh
. "$P4_HERE/p4-l3-rfkill.sh"
# shellcheck source=../../p4-l3-nm.sh
. "$P4_HERE/p4-l3-nm.sh"
# shellcheck source=../../p4-l3-regulatory.sh
. "$P4_HERE/p4-l3-regulatory.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L34_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
NM_TRIES="${AEGIS_L34_NM_TRIES:-20}"
NM_INTERVAL="${AEGIS_L34_NM_INTERVAL:-0.5}"
# Live timing is frozen. Only fixture (stubbed) runs may shorten the waits, so a live operator has no stability/probe knob.
STABLE_INTERVAL=5
PROBE_TIMEOUT=20
DNS_TRIES=20
DNS_INTERVAL=0.5
BROKER_TRIES=30
BROKER_INTERVAL=2
LISTEN_TRIES=15
LISTEN_INTERVAL=1
if [ -n "$ROOT" ]; then
  STABLE_INTERVAL="${AEGIS_L34_V8_STABLE_INTERVAL:-5}"
  PROBE_TIMEOUT="${AEGIS_L34_V8_PROBE_TIMEOUT:-20}"
  DNS_TRIES="${AEGIS_L34_V8_TRIES:-20}"; DNS_INTERVAL="${AEGIS_L34_V8_INTERVAL:-0.5}"
  BROKER_TRIES="${AEGIS_L34_V8_TRIES:-30}"; BROKER_INTERVAL="${AEGIS_L34_V8_INTERVAL:-2}"
  LISTEN_TRIES="${AEGIS_L34_V8_TRIES:-15}"; LISTEN_INTERVAL="${AEGIS_L34_V8_INTERVAL:-1}"
  L34_V6_PROBE_CMD="${AEGIS_L34_V8_PROBE_CMD:-}"
else
  L34_V6_PROBE_CMD=""
fi
PY="${AEGIS_L34_V8_PYTHON:-python3}"
DNSMASQ_UNIT=$L34_UNIT
BROKER_UNIT=$L34_V7_BROKER_UNIT
CORE_UNIT=$L34_V7_CORE_UNIT
EXAMPLE_UNIT="$(cd "$P4_HERE/../network" && pwd)/aegis-idea3-dnsmasq.service.example"

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
journal() { printf '%s\t%s\n' "$1" "$2" >> "$WORK/journal.tsv" || fail JOURNAL_WRITE_FAILED; }
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }
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
  case "$PY" in /*) [ -x "$PY" ] || fail V8_PROBE_PYTHON_INVALID ;; *) fail V8_PROBE_PYTHON_INVALID ;; esac
  sysfs=/sys
else
  # Fixture mode drives the SAME code path, so every command must be a test stub: refuse to run against real host tools.
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq journalctl; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
  sysfs="${ROOT%/}/sys"
fi
umask 077
mkdir -p "$WORK" || fail WORK_DIR_CREATE_FAILED
chmod 700 "$WORK"
: > "$WORK/journal.tsv"
chmod 600 "$WORK/journal.tsv"

profile=$(host_path "$L34_PROFILE")
conf=$(host_path "$L34_DNSMASQ_CONF")
unit_file=$(host_path "$L34_DNSMASQ_UNIT")
nft_file=$(host_path "$L34_NFT_FILE")
broker_conf=$(host_path "$L34_V7_BROKER_CONF")

# ── 2. read-only preflight: nothing below changes any state until PRODUCTION_MUTATION_PERFORMED=YES ─────────────────────
l34_profile_gate "$profile" || fail "$(reason_of l34_profile_gate "$profile")"
l34_profile_effective_gate || fail "$(reason_of l34_profile_effective_gate)"
l34_dnsmasq_conf_gate "$conf" || fail "$(reason_of l34_dnsmasq_conf_gate "$conf")"
l34_dnsmasq_unit_gate "$unit_file" "$EXAMPLE_UNIT" || fail L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY
[ -f "$nft_file" ] && [ ! -L "$nft_file" ] || fail L34_NFT_FILE_MISSING
dnsmasq --test --conf-file="$conf" >/dev/null 2>&1 || fail DNSMASQ_CONFIG_SYNTAX_FAIL
l34_v7_broker_conf_gate "$broker_conf" || fail "$(reason_of l34_v7_broker_conf_gate "$broker_conf")"
l34_v8_persistent_snapshot "$WORK/persistent-pre.tsv" "$profile" "$conf" "$unit_file" "$nft_file" "$broker_conf" || fail L34_PERSISTENT_SNAPSHOT_FAILED

nft list table inet aegis_idea3 > "$WORK/nft-table-pre.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" || fail "$(l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" 2>&1 | head -n 1)"
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"

l34_wifi_topology_gate "$AP_IF" "$sysfs" || fail "$(reason_of l34_wifi_topology_gate "$AP_IF" "$sysfs")"
l34_ap_pre_gate "$AP_IF" || fail "$(reason_of l34_ap_pre_gate "$AP_IF")"
l3_reg_gate "$AP_IF" "$L34_CHANNEL" || fail "$L3_REG_REASON"
l34_no_wifi_active_gate || fail "$(reason_of l34_no_wifi_active_gate)"
# dnsmasq: the exact failed/start-limit-hit state (V3 gate, reused verbatim)
unit_props "$DNSMASQ_UNIT" > "$WORK/dnsmasq-pre.txt" || fail L34_DNSMASQ_SHOW_FAILED
l34_service_pre_gate < "$WORK/dnsmasq-pre.txt" || fail "$(l34_service_pre_gate < "$WORK/dnsmasq-pre.txt" 2>&1 | head -n 1)"
l34_v6_ap_address_absent_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v6_ap_address_absent_gate "$AP_IF" "$L34_AP_ADDR")"
l34_v6_no_ap_dns_dhcp_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v6_no_ap_dns_dhcp_gate "$AP_IF" "$L34_AP_ADDR")"

# exact rfkill target: soft-blocked, never hard-blocked (this handler is the ONLY V-handler that unblocks it, and only that exact id)
l3_rfkill_resolve_id "$AP_IF" "$sysfs" "$L34_EXPECTED_RFKILL_ID" || fail "$L3_RFKILL_REASON"
rfkill_id=$L3_RFKILL_ID
l3_rfkill_state "$rfkill_id" || fail "$L3_RFKILL_REASON"
[ "$L3_RFKILL_HARD" != blocked ] || fail RFKILL_HARD_BLOCKED
[ "$L3_RFKILL_SOFT" = blocked ] || fail L34_V8_RFKILL_NOT_SOFT_BLOCKED
printf 'id=%s soft=%s hard=%s\n' "$rfkill_id" "$L3_RFKILL_SOFT" "$L3_RFKILL_HARD" > "$WORK/rfkill-target-pre.txt"
l34_rfkill_snapshot "$WORK/rfkill-all-pre.txt" || fail L34_RFKILL_LIST_UNREADABLE

# radio/device/wpa baseline: the proven FRESH or RESIDUAL radio-disabled baseline (reused verbatim from V3), nothing else
radio_pre=$(nmcli radio wifi 2>/dev/null || true)
nm_snapshot=$(l34_nm_status_snapshot) || fail L34_NM_DEVICE_INVENTORY_UNREADABLE
target_state=$(awk -F: '$1 == "wlp0s20f3" { split($3, w, " "); print w[1] }' <<< "$nm_snapshot")
p2p_inventory=$(l34_p2p_inventory <<< "$nm_snapshot")
wifi_devices=$(l34_wifi_devices <<< "$nm_snapshot")
wpa_props=$(systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID -p NRestarts wpa_supplicant.service)
baseline=$(l34_baseline_classify "$L3_REG_COUNTRY" "$radio_pre" "$target_state" "$p2p_inventory" "$wifi_devices" <<< "$wpa_props") \
  || fail "$(l34_baseline_classify "$L3_REG_COUNTRY" "$radio_pre" "$target_state" "$p2p_inventory" "$wifi_devices" <<< "$wpa_props" 2>&1 | head -n 1)"
printf '%s\n' "$baseline" > "$WORK/baseline.txt"
printf '%s\n' "$L3_REG_COUNTRY" > "$WORK/phy-country-pre.txt"
l34_nm_devices_listing > "$WORK/nm-devices-pre.txt"
printf '%s\n' "$radio_pre" > "$WORK/radio-pre.txt"
printf 'L34_BASELINE=%s\n' "$baseline"

dev_ac_pre=$(l34_device_autoconnect "$AP_IF") || fail L34_DEVICE_AUTOCONNECT_UNREADABLE
ap_profile_ac=$(l34_v4_ap_profile_autoconnect) || fail L34_AP_PROFILE_AUTOCONNECT_UNREADABLE
ap_profile_file_ac=$(l34_v8_profile_file_autoconnect "$profile") || fail "$(reason_of l34_v8_profile_file_autoconnect "$profile")"
l34_v8_pre_autoconnect_gate "$dev_ac_pre" "$ap_profile_ac" "$ap_profile_file_ac" || fail "$(reason_of l34_v8_pre_autoconnect_gate "$dev_ac_pre" "$ap_profile_ac" "$ap_profile_file_ac")"

# broker: the strict churn contract, and no 8883 listener of any kind
l34_v7_broker_show "$BROKER_UNIT" > "$WORK/broker-pre.txt" || fail L34_V8_BROKER_SHOW_FAILED
l34_v7_broker_journal_capture "$BROKER_UNIT" "$WORK/broker-pre.txt" "$WORK/broker-journal-pre.txt" || fail "$(reason_of l34_v7_broker_journal_capture "$BROKER_UNIT" "$WORK/broker-pre.txt" "$WORK/broker-journal-pre.txt")"
l34_v7_broker_churn_gate "$WORK/broker-journal-pre.txt" < "$WORK/broker-pre.txt" \
  || fail "$(l34_v7_broker_churn_gate "$WORK/broker-journal-pre.txt" < "$WORK/broker-pre.txt" 2>&1 | head -n 1)"
l34_v7_no_8883_listener_gate || fail "$(reason_of l34_v7_no_8883_listener_gate)"
l34_v4_identity_snapshot "$BROKER_UNIT" "$WORK/broker-identity-pre.txt" || fail L34_V8_BROKER_IDENTITY_UNREADABLE

# Core: healthy and unchanged
unit_props "$CORE_UNIT" | l34_v7_core_gate || fail "$(unit_props "$CORE_UNIT" | l34_v7_core_gate 2>&1 | head -n 1)"
l34_v6_broker_tuple "$CORE_UNIT" > "$WORK/core-tuple-pre.txt" || fail L34_V8_CORE_TUPLE_UNREADABLE

for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-pre.txt"
ip route show default > "$WORK/default-route-pre.txt"

if [ "${AEGIS_L34_PREFLIGHT_ONLY:-NO}" = YES ]; then
  printf 'L34_V8_PREFLIGHT=PASS\n'
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
  exit 0
fi

# ── 3. FIRST runtime mutation (the runner takes its PRE capture before calling this handler) ─────────────────────────────
# The marker is written and confirmed BEFORE any mutating command: rollback_flow() decides whether rollback.sh must run by testing for it.
printf 'YES\n' > "$WORK/production-mutation" || fail PRODUCTION_MUTATION_MARKER_WRITE_FAILED
printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'

# 3a. exact-ID rfkill unblock of the resolved target only; never `rfkill unblock all`
journal RFKILL_UNBLOCK "$rfkill_id"
l3_rfkill_prepare "$AP_IF" "$WORK" "$L34_EXPECTED_RFKILL_ID" "$sysfs" || fail "$L3_RFKILL_REASON"
l34_rfkill_only_target_changed "$WORK/rfkill-all-pre.txt" "$rfkill_id" || fail L34_RFKILL_NON_TARGET_CHANGED

# 3b. device autoconnect off FIRST, so no remembered Wi-Fi profile can grab the device once the radio is on; PRE value restored below
journal NM_DEVICE_AUTOCONNECT_DISABLE "$dev_ac_pre"
nmcli device set "$AP_IF" autoconnect no || fail NM_DEVICE_AUTOCONNECT_SET_FAILED

# 3c. the NM radio is enabled EXACTLY ONCE, and only if it is still disabled after the exact unblock
radio_now=$(nmcli radio wifi 2>/dev/null || true)
if [ "$radio_now" = disabled ]; then
  journal NM_WIFI_RADIO_ENABLE disabled
  nmcli radio wifi on || fail NM_WIFI_RADIO_ENABLE_FAILED
fi

# 3d. LOAD-BEARING (live race 2026-10-01): activation must NOT be attempted until NetworkManager has moved wlp0s20f3 unavailable -> disconnected.
# State based, bounded, not an activation retry; then exactly ONE activation bound to the interface.
l3_nm_wait_ready "$AP_IF" "$NM_TRIES" "$NM_INTERVAL" || fail "$L3_NM_REASON"
# 3d2. THE ONE PERSISTENT CHANGE (OD-L34-V8-01): connection.autoconnect no -> yes on the approved profile, exactly once, journaled BEFORE it is made so a
# failure from here on rolls it back. The device autoconnect is still off and the radio is on, so nothing can grab the device between this and the
# activation below. Nothing but NetworkManager's own `connection modify` writes the keyfile; no rfkill state file or NetworkManager state file is touched.
journal NM_PROFILE_AUTOCONNECT_ENABLE no
nmcli connection modify "$L34_CONN" connection.autoconnect "$L34_V8_PROFILE_AUTOCONNECT_TARGET" || fail NM_PROFILE_AUTOCONNECT_MODIFY_FAILED
l34_v8_profile_autoconnect_enabled_gate "$profile" || fail "$(reason_of l34_v8_profile_autoconnect_enabled_gate "$profile")"
l34_v8_persistent_verify "$WORK/persistent-pre.tsv" yes || fail "$(reason_of l34_v8_persistent_verify "$WORK/persistent-pre.tsv" yes)"
l34_profile_gate "$profile" || fail "$(reason_of l34_profile_gate "$profile")"
l34_profile_effective_gate || fail "$(reason_of l34_profile_effective_gate)"
journal NM_UP "$L34_CONN"
l3_nm_activate "$AP_IF" "$L34_CONN" || fail "$L3_NM_REASON"
ap_ok=1
for ((i = 1; i <= NM_TRIES; i++)); do
  if l34_ap_active_gate "$AP_IF" 2>/dev/null; then ap_ok=0; break; fi
  [ "$i" -lt "$NM_TRIES" ] && sleep "$NM_INTERVAL"
done
[ "$ap_ok" = 0 ] || fail "$(reason_of l34_ap_active_gate "$AP_IF")"
l3_reg_verify_active "$AP_IF" "$L34_CHANNEL" || fail "$L3_REG_REASON"
[ "$(ip route show default)" = "$(cat "$WORK/default-route-pre.txt")" ] || fail L34_DEFAULT_ROUTE_CHANGED
l34_no_wifi_active_gate 2>/dev/null && fail L34_AP_CONNECTION_NOT_ACTIVE
nmcli -t -f TYPE,DEVICE connection show --active 2>/dev/null | grep -qx "802-11-wireless:$AP_IF" || fail L34_AP_CONNECTION_NOT_ACTIVE
[ "$(nmcli -g GENERAL.CONNECTION device show "$AP_IF" 2>/dev/null)" = "$L34_CONN" ] || fail L34_ACTIVE_CONNECTION_NOT_APPROVED_PROFILE

# 3e. restore device autoconnect to exactly its PRE value (the AP is active through its explicit activation)
nmcli device set "$AP_IF" autoconnect "$dev_ac_pre" || fail NM_DEVICE_AUTOCONNECT_RESTORE_FAILED
journal NM_DEVICE_AUTOCONNECT_RESTORED "$dev_ac_pre"

# 3f. the existing accepted dnsmasq service ONLY: reset the stale failed bookkeeping, then start it. No enable/disable.
journal DNSMASQ_RESET_FAILED "$DNSMASQ_UNIT"
systemctl reset-failed "$DNSMASQ_UNIT" || fail DNSMASQ_RESET_FAILED_FAILED
journal DNSMASQ_START "$DNSMASQ_UNIT"
systemctl start "$DNSMASQ_UNIT" || fail DNSMASQ_SERVICE_START_FAILED
dns_ok=1
for ((i = 1; i <= DNS_TRIES; i++)); do
  if unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>/dev/null; then dns_ok=0; break; fi
  [ "$i" -lt "$DNS_TRIES" ] && sleep "$DNS_INTERVAL"
done
[ "$dns_ok" = 0 ] || fail "$(unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR")"

# 3g. the L6b broker: NO start/stop/restart/reset-failed/kill command is ever issued. Bounded, read-only wait for it to recover on its own,
# through its own already-configured Restart=on-failure, now that its bind address exists.
broker_ok=1
for ((i = 1; i <= BROKER_TRIES; i++)); do
  if unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" 2>/dev/null; then broker_ok=0; break; fi
  [ "$i" -lt "$BROKER_TRIES" ] && sleep "$BROKER_INTERVAL"
done
[ "$broker_ok" = 0 ] || fail "L34_V8_BROKER_DID_NOT_RECOVER:$(unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" 2>&1 | head -n 1)"
# A Type=simple unit is active/running the instant systemd execs it, before mosquitto has bound its sockets: poll the exact-set gate (bounded, read-only).
listen_ok=1
for ((i = 1; i <= LISTEN_TRIES; i++)); do
  if l34_v4_broker_listeners_gate "$L34_AP_ADDR" 2>/dev/null; then listen_ok=0; break; fi
  [ "$i" -lt "$LISTEN_TRIES" ] && sleep "$LISTEN_INTERVAL"
done
if [ "$listen_ok" != 0 ]; then
  ss -H -ltn "sport = :8883" > "$WORK/broker-listeners-observed.txt" 2>&1 || true  # evidence of what the gate last saw
  fail "$(reason_of l34_v4_broker_listeners_gate "$L34_AP_ADDR")"
fi
l34_v5_broker_autorestart_evidence "$BROKER_UNIT" "$WORK/broker-identity-pre.txt" || fail "$(reason_of l34_v5_broker_autorestart_evidence "$BROKER_UNIT" "$WORK/broker-identity-pre.txt")"

# 3h. ONE handshake-only TLS probe to the AP address through the unchanged p4-l7-broker-probe.py (never 127.0.0.1, no MQTT bytes)
probe_err=$(l34_v6_tls_probe "$PY" "$P4_HERE" "$REPO_ROOT" "$PROBE_TIMEOUT" 2>&1 >"$WORK/tls-probe.txt") || fail "$(head -n 1 <<< "$probe_err")"

# 3i. the broker's own restart counter must have STABILIZED: identical well-formed tuples over a bounded sample (read-only)
l34_v7_broker_stable_gate "$BROKER_UNIT" "$WORK/broker-tuple-stable.txt" "$L34_V7_STABLE_SAMPLES" "$STABLE_INTERVAL" \
  || fail "$(reason_of l34_v7_broker_stable_gate "$BROKER_UNIT" "$WORK/broker-tuple-stable.txt" "$L34_V7_STABLE_SAMPLES" "$STABLE_INTERVAL")"
l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-stable.txt" "$L34_AP_ADDR" || fail "$(reason_of l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-stable.txt" "$L34_AP_ADDR")"

# 3j. Core is exactly the PRE tuple; every persistent/L2/forwarding/identity invariant still holds
l34_v7_core_unchanged "$CORE_UNIT" "$WORK/core-tuple-pre.txt" || fail "$(reason_of l34_v7_core_unchanged "$CORE_UNIT" "$WORK/core-tuple-pre.txt")"
l34_v8_persistent_verify "$WORK/persistent-pre.tsv" yes || fail "$(reason_of l34_v8_persistent_verify "$WORK/persistent-pre.tsv" yes)"
l34_profile_gate "$profile" || fail "$(reason_of l34_profile_gate "$profile")"
[ "$(l34_v4_ap_profile_autoconnect)" = yes ] || fail L34_V8_AP_PROFILE_AUTOCONNECT_NOT_ENABLED
nft list table inet aegis_idea3 > "$WORK/nft-table-apply.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-apply.txt" || fail L2_NFT_TABLE_CHANGED
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-apply.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-apply.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED

printf 'L34_V8_APPLY=PASS\n'
printf 'REACTIVATION_TYPE=RUNTIME_RECOVERY_WITH_ONE_PERSISTENT_AUTOCONNECT_CHANGE\n'
printf 'PERSISTENT_CHANGE_SCOPE=NM_PROFILE_aegis-idea3-ap_connection.autoconnect_no_to_yes_ONLY\n'
printf 'PERSISTENT_FILES_REWRITTEN=ONLY_THE_AP_PROFILE_AUTOCONNECT_FIELD\n'
printf 'DIRECT_RFKILL_STATE_FILE_EDIT=NO\n'
printf 'RFKILL_MUTATED=YES (exact id %s only, unblock)\n' "$rfkill_id"
printf 'NM_RADIO_MUTATED=%s\n' "$([ "$radio_now" = disabled ] && echo 'YES (enabled exactly once)' || echo NO)"
printf 'DNSMASQ_MUTATED=YES (reset-failed+start, exact V3 pattern)\n'
printf 'L6B_BROKER_MUTATED=NO\n'
printf 'L6B_BROKER_RECOVERED_VIA=SYSTEMD_AUTO_RESTART\n'
printf 'BROKER_CONTROL_COMMAND_ISSUED=NO\n'
printf 'BROKER_TUPLE_STABLE=YES\n'
printf 'TLS_PROBE=PASS via p4-l7-broker-probe.py\n'
printf 'CORE_CONTROL_COMMAND_ISSUED=NO\n'
printf 'CORE_UNCHANGED=YES\n'
printf 'K12_AUTOMATIC_REBOOT_PERSISTENCE_CLAIMED=NO\n'
printf 'L3_LIVE_ACCEPTANCE_CLAIMED=NO\n'
printf 'L4_LIVE_ACCEPTANCE_CLAIMED=NO\n'
printf 'L6B_LIVE_ACCEPTANCE_CLAIMED=NO\n'
printf 'RECOVERY_R1_R8_PROVEN=NO\n'
printf 'L7U_EXECUTED=NO\n'
printf 'L8_AUTHORIZED=NO\n'
