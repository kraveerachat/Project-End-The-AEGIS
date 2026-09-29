#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-L6b/L6c DEGRADED RUNTIME REACTIVATION apply handler (RUNTIME_ONLY, V5).
# MUTATING in live mode. Distinct from V1/V2/V3 (reactivation/l34/, NM radio disabled) AND from V4
# (reactivation/l34-v4-post-l6b/, dnsmasq AND the L6b broker already active/running). V5 supports EXACTLY ONE
# baseline: the same wifi/rfkill/radio/wpa topology as V4 (radio already enabled, target already
# disconnected, rfkill already unblocked — reuses l34_v4_baseline_gate / l34_v4_rfkill_ready_gate verbatim),
# but aegis-idea3-dnsmasq.service is in the exact V3 post-reboot failed/start-limit-hit precondition
# (reuses l34_service_pre_gate verbatim) and aegis-idea3-mosquitto.service (the L6b broker) is crash-looping
# (systemd auto-restarting it) because its AP-facing listener cannot bind while the AP address is absent.
#
# V5 performs EXACTLY:
#   1. temporarily disable wlp0s20f3 device autoconnect (PRE value restored later),
#   2. exactly one `nmcli connection up aegis-idea3-ap ifname wlp0s20f3`, restore autoconnect,
#   3. `systemctl reset-failed` + `systemctl start` of aegis-idea3-dnsmasq.service ONLY (the exact V3
#      pattern; no enable/disable), once the AP address exists,
#   4. a BOUNDED, read-only wait for aegis-idea3-mosquitto.service to reach active/running on its own,
#      through its own already-configured systemd auto-restart. NO start/stop/restart/reset-failed command
#      is ever issued against it.
# It never rewrites the NetworkManager profile, the dnsmasq config/unit, or the broker config; never touches
# rfkill, the global NM Wi-Fi radio, nftables, forwarding, regulatory state, enp62s0, legacy mosquitto,
# Twingate, IDEA1/IDEA2; never sends an MQTT command; never touches ESP32; never starts L7/L8; claims NO
# L3/L4/L6b live acceptance. Every runtime change is journaled BEFORE it is made so rollback.sh undoes
# exactly what this run changed.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_V5_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
# shellcheck source=../../p4-l3-nm.sh
. "$P4_HERE/p4-l3-nm.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_L34_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
NM_TRIES="${AEGIS_L34_NM_TRIES:-20}"
NM_INTERVAL="${AEGIS_L34_NM_INTERVAL:-0.5}"
BROKER_TRIES="${AEGIS_L34_V5_BROKER_TRIES:-30}"
BROKER_INTERVAL="${AEGIS_L34_V5_BROKER_INTERVAL:-2}"
LISTEN_TRIES="${AEGIS_L34_V5_LISTEN_TRIES:-15}"
LISTEN_INTERVAL="${AEGIS_L34_V5_LISTEN_INTERVAL:-1}"
DNSMASQ_UNIT=aegis-idea3-dnsmasq.service
BROKER_UNIT=aegis-idea3-mosquitto.service
EXAMPLE_UNIT="$(cd "$P4_HERE/../network" && pwd)/aegis-idea3-dnsmasq.service.example"

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
journal() { printf '%s\t%s\n' "$1" "$2" >> "$WORK/journal.tsv" || fail JOURNAL_WRITE_FAILED; }
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }
identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }

# ── 1. environment / authorization ──────────────────────────────────────────────────────────────────────────────────
[ -n "$WORK" ] || fail AEGIS_L34_WORK_DIR_REQUIRED
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
case "$WORK" in /etc/*) fail WORK_DIR_INSIDE_ETC ;; esac
[ ! -L "$WORK" ] || fail WORK_DIR_IS_SYMLINK
[ ! -e "$WORK" ] || fail WORK_DIR_ALREADY_EXISTS
if [ -z "$ROOT" ]; then
  [ "${AEGIS_L34_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
else
  # Fixture mode drives the SAME code path, so every command must be a test stub: refuse to run against real host tools.
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq journalctl; do
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
broker_conf=$(host_path "$L34_V5_BROKER_CONF")

# ── 2. read-only preflight: nothing below changes any state until PRODUCTION_MUTATION_PERFORMED=YES ─────────────────────
l34_profile_gate "$profile" || fail "$(l34_profile_gate "$profile" 2>&1 | head -n 1)"
l34_profile_effective_gate || fail "$(l34_profile_effective_gate 2>&1 | head -n 1)"
l34_dnsmasq_conf_gate "$conf" || fail "$(l34_dnsmasq_conf_gate "$conf" 2>&1 | head -n 1)"
l34_dnsmasq_unit_gate "$unit_file" "$EXAMPLE_UNIT" || fail L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY
dnsmasq --test --conf-file="$conf" >/dev/null 2>&1 || fail DNSMASQ_CONFIG_SYNTAX_FAIL
[ -f "$broker_conf" ] && [ ! -L "$broker_conf" ] || fail L34_V5_BROKER_CONF_MISSING
l34_persistent_snapshot "$WORK/persistent-pre.tsv" "$profile" "$conf" "$unit_file" "$broker_conf" || fail L34_PERSISTENT_SNAPSHOT_FAILED

nft list table inet aegis_idea3 > "$WORK/nft-table-pre.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" || fail "$(l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" 2>&1 | head -n 1)"
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(l34_forwarding_gate "$AP_IF" 2>&1 | head -n 1)"

l34_ap_pre_gate "$AP_IF" || fail "$(l34_ap_pre_gate "$AP_IF" 2>&1 | head -n 1)"
l34_no_wifi_active_gate || fail "$(l34_no_wifi_active_gate 2>&1 | head -n 1)"
l34_v4_rfkill_ready_gate || fail "$(l34_v4_rfkill_ready_gate 2>&1 | head -n 1)"

radio_pre=$(nmcli radio wifi 2>/dev/null || true)
nm_snapshot=$(l34_nm_status_snapshot) || fail L34_NM_DEVICE_INVENTORY_UNREADABLE
target_state=$(awk -F: -v ifc="$AP_IF" '$1 == ifc { split($3, w, " "); print w[1] }' <<< "$nm_snapshot")
p2p_inventory=$(l34_p2p_inventory <<< "$nm_snapshot")
wifi_devices=$(l34_wifi_devices <<< "$nm_snapshot")
wpa_props=$(systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID wpa_supplicant.service)
l34_v4_baseline_gate "$radio_pre" "$target_state" "$wifi_devices" "$p2p_inventory" <<< "$wpa_props" \
  || fail "$(l34_v4_baseline_gate "$radio_pre" "$target_state" "$wifi_devices" "$p2p_inventory" <<< "$wpa_props" 2>&1 | head -n 1)"
printf '%s\n' "$radio_pre" > "$WORK/radio-pre.txt"

dev_ac_pre=$(l34_device_autoconnect "$AP_IF") || fail L34_DEVICE_AUTOCONNECT_UNREADABLE
ap_profile_ac=$(l34_v4_ap_profile_autoconnect) || fail L34_AP_PROFILE_AUTOCONNECT_UNREADABLE
l34_v4_autoconnect_pre_gate "$dev_ac_pre" "$ap_profile_ac" \
  || fail "$(l34_v4_autoconnect_pre_gate "$dev_ac_pre" "$ap_profile_ac" 2>&1 | head -n 1)"

unit_props "$DNSMASQ_UNIT" > "$WORK/dnsmasq-pre.txt" || fail L34_DNSMASQ_SHOW_FAILED
l34_service_pre_gate < "$WORK/dnsmasq-pre.txt" || fail "$(l34_service_pre_gate < "$WORK/dnsmasq-pre.txt" 2>&1 | head -n 1)"
unit_props "$BROKER_UNIT" > "$WORK/broker-pre.txt" || fail L34_V5_BROKER_SHOW_FAILED
journalctl -u "$BROKER_UNIT" -n 30 --no-pager > "$WORK/broker-journal-pre.txt" 2>&1 || fail L34_V5_BROKER_JOURNAL_UNREADABLE
l34_v5_broker_crashloop_gate "$WORK/broker-journal-pre.txt" < "$WORK/broker-pre.txt" \
  || fail "$(l34_v5_broker_crashloop_gate "$WORK/broker-journal-pre.txt" < "$WORK/broker-pre.txt" 2>&1 | head -n 1)"
l34_v4_identity_snapshot "$BROKER_UNIT" "$WORK/broker-identity-pre.txt" || fail L34_V5_BROKER_IDENTITY_UNREADABLE

for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-pre.txt"
ip route show default > "$WORK/default-route-pre.txt"

if [ "${AEGIS_L34_PREFLIGHT_ONLY:-NO}" = YES ]; then
  printf 'L34_V5_PREFLIGHT=PASS\n'
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
  exit 0
fi

# ── 3. FIRST runtime mutation (the runner takes its PRE capture before calling this handler) ─────────────────────────────
# The marker must be written and confirmed BEFORE any mutating command: rollback_flow() decides whether rollback.sh
# needs to run by testing for this file's existence, so a silently-failed write here would leave a mutated host with
# no rollback attempted and no operator warning. Fail closed, before touching nmcli/systemctl, if it cannot be written.
printf 'YES\n' > "$WORK/production-mutation" || fail PRODUCTION_MUTATION_MARKER_WRITE_FAILED
printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'

# 3a. temporarily disable device autoconnect (PRE value restored below), so no remembered autoconnect Wi-Fi profile can
# race the one deliberate activation below.
journal NM_DEVICE_AUTOCONNECT_DISABLE "$dev_ac_pre"
nmcli device set "$AP_IF" autoconnect no || fail NM_DEVICE_AUTOCONNECT_SET_FAILED

# 3b. bounded NetworkManager target-device readiness (state based; not an activation retry), then ONE bound activation
l3_nm_wait_ready "$AP_IF" "$NM_TRIES" "$NM_INTERVAL" || fail "$L3_NM_REASON"
journal NM_UP "$L34_CONN"
l3_nm_activate "$AP_IF" "$L34_CONN" || fail "$L3_NM_REASON"
ap_ok=1
for ((i = 1; i <= NM_TRIES; i++)); do
  if l34_ap_active_gate "$AP_IF" 2>/dev/null; then ap_ok=0; break; fi
  [ "$i" -lt "$NM_TRIES" ] && sleep "$NM_INTERVAL"
done
[ "$ap_ok" = 0 ] || fail "$(l34_ap_active_gate "$AP_IF" 2>&1 | head -n 1)"
[ "$(ip route show default)" = "$(cat "$WORK/default-route-pre.txt")" ] || fail L34_DEFAULT_ROUTE_CHANGED
[ "$(nmcli radio wifi 2>/dev/null)" = "$radio_pre" ] || fail L34_RADIO_STATE_CHANGED

# 3c. restore device autoconnect to exactly its PRE value
nmcli device set "$AP_IF" autoconnect "$dev_ac_pre" || fail NM_DEVICE_AUTOCONNECT_RESTORE_FAILED
journal NM_DEVICE_AUTOCONNECT_RESTORED "$dev_ac_pre"

# 3d. the existing accepted dnsmasq service ONLY, exact V3 pattern: reset the stale post-reboot failed bookkeeping,
# then start it (its listeners bind to the AP address that now exists). No enable/disable.
journal DNSMASQ_RESET_FAILED "$DNSMASQ_UNIT"
systemctl reset-failed "$DNSMASQ_UNIT" || fail DNSMASQ_RESET_FAILED_FAILED
journal DNSMASQ_START "$DNSMASQ_UNIT"
systemctl start "$DNSMASQ_UNIT" || fail DNSMASQ_SERVICE_START_FAILED
dns_ok=1
for ((i = 1; i <= NM_TRIES; i++)); do
  if unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>/dev/null; then dns_ok=0; break; fi
  [ "$i" -lt "$NM_TRIES" ] && sleep "$NM_INTERVAL"
done
[ "$dns_ok" = 0 ] || fail "$(unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" 2>&1 | head -n 1)"

# 3e. the L6b broker: NO start/stop/restart/reset-failed command is issued. Bounded, read-only wait for it to recover
# on its own, through its own already-configured systemd auto-restart, now that its bind address exists.
broker_ok=1
for ((i = 1; i <= BROKER_TRIES; i++)); do
  if unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" 2>/dev/null; then broker_ok=0; break; fi
  [ "$i" -lt "$BROKER_TRIES" ] && sleep "$BROKER_INTERVAL"
done
[ "$broker_ok" = 0 ] || fail "L34_V5_BROKER_DID_NOT_RECOVER:$(unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" 2>&1 | head -n 1)"
# A Type=simple unit is "active/running" the instant systemd execs it, before mosquitto has bound its sockets, so the
# exact-set listener gate must be polled (bounded, read-only) rather than sampled once. The gate itself is unchanged:
# only the exact approved pair passes, and a wrong/extra listener still fails after the bound.
listen_ok=1
for ((i = 1; i <= LISTEN_TRIES; i++)); do
  if l34_v4_broker_listeners_gate "$L34_AP_ADDR" 2>/dev/null; then listen_ok=0; break; fi
  [ "$i" -lt "$LISTEN_TRIES" ] && sleep "$LISTEN_INTERVAL"
done
if [ "$listen_ok" != 0 ]; then
  ss -H -ltn "sport = :8883" > "$WORK/broker-listeners-observed.txt" 2>&1 || true  # evidence of what the gate last saw
  fail "$(l34_v4_broker_listeners_gate "$L34_AP_ADDR" 2>&1 | head -n 1)"
fi
l34_v5_broker_autorestart_evidence "$BROKER_UNIT" "$WORK/broker-identity-pre.txt" \
  || fail "$(l34_v5_broker_autorestart_evidence "$BROKER_UNIT" "$WORK/broker-identity-pre.txt" 2>&1 | head -n 1)"

# 3f. preservation proof: the broker config itself, and every other accepted persistent artifact, were never rewritten
l34_persistent_verify "$WORK/persistent-pre.tsv" || fail "$(l34_persistent_verify "$WORK/persistent-pre.tsv" 2>&1 | head -n 1)"

printf 'L34_V5_APPLY=PASS\n'
printf 'REACTIVATION_TYPE=RUNTIME_ONLY\n'
printf 'PERSISTENT_FILES_REWRITTEN=NO\n'
printf 'DNSMASQ_MUTATED=YES (reset-failed+start, exact V3 pattern)\n'
printf 'L6B_BROKER_MUTATED=NO\n'
printf 'L6B_BROKER_RECOVERED_VIA=SYSTEMD_AUTO_RESTART\n'
printf 'RFKILL_MUTATED=NO\n'
printf 'NM_RADIO_MUTATED=NO\n'
printf 'L3_LIVE_ACCEPTANCE_CLAIMED=NO\n'
printf 'L4_LIVE_ACCEPTANCE_CLAIMED=NO\n'
printf 'L6B_LIVE_ACCEPTANCE_CLAIMED=NO\n'
