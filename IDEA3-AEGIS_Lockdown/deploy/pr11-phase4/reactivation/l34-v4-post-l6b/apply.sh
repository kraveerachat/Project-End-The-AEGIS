#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-L6b/L6c RUNTIME REACTIVATION apply handler (RUNTIME_ONLY, V4).
# MUTATING in live mode. Distinct from V1/V2/V3 (deploy/pr11-phase4/reactivation/l34/), which model the PRE-L6b baselines
# (FRESH/RESIDUAL: NM radio disabled, target unavailable) and unconditionally reset-failed+start dnsmasq. V4 supports
# EXACTLY ONE different baseline: rfkill already unblocked, NM radio already enabled, target already disconnected (no
# active Wi-Fi connection), the already-accepted L6b broker AND dnsmasq already active/running. V4 performs EXACTLY ONE
# mutation:
#   1. temporarily disable wlp0s20f3 device autoconnect (PRE value restored later),
#   2. exactly one `nmcli connection up aegis-idea3-ap ifname wlp0s20f3`,
#   3. restore device autoconnect to its exact PRE value.
# It NEVER touches rfkill, the global NM Wi-Fi radio, aegis-idea3-dnsmasq.service or aegis-idea3-mosquitto.service (no
# start/stop/restart/reset-failed of either), never rewrites any persistent configuration, never touches nftables,
# forwarding, regulatory state, enp62s0, legacy mosquitto, Twingate or IDEA2, and claims NO L3/L4 live acceptance.
# Every runtime change is journaled BEFORE it is made so rollback.sh undoes exactly what this run changed.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_V4_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }

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
DNSMASQ_UNIT=aegis-idea3-dnsmasq.service
BROKER_UNIT=aegis-idea3-mosquitto.service

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

# ── 2. read-only preflight: nothing below changes any state until PRODUCTION_MUTATION_PERFORMED=YES ─────────────────────
l34_profile_gate "$profile" || fail "$(l34_profile_gate "$profile" 2>&1 | head -n 1)"
l34_profile_effective_gate || fail "$(l34_profile_effective_gate 2>&1 | head -n 1)"
l34_persistent_snapshot "$WORK/persistent-pre.tsv" "$profile" || fail L34_PERSISTENT_SNAPSHOT_FAILED

nft list table inet aegis_idea3 > "$WORK/nft-table-pre.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" || fail "$(l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" 2>&1 | head -n 1)"
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(l34_forwarding_gate "$AP_IF" 2>&1 | head -n 1)"

l34_ap_pre_gate "$AP_IF" || fail "$(l34_ap_pre_gate "$AP_IF" 2>&1 | head -n 1)"
l34_no_wifi_active_gate || fail "$(l34_no_wifi_active_gate 2>&1 | head -n 1)"
l34_v4_rfkill_ready_gate || fail "$(l34_v4_rfkill_ready_gate 2>&1 | head -n 1)"

radio_pre=$(nmcli radio wifi 2>/dev/null || true)
nm_snapshot=$(l34_nm_status_snapshot) || fail L34_NM_DEVICE_INVENTORY_UNREADABLE
target_state=$(awk -F: '$1 == "wlp0s20f3" { split($3, w, " "); print w[1] }' <<< "$nm_snapshot")
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

unit_props "$DNSMASQ_UNIT" | l34_v4_service_active_gate "$DNSMASQ_UNIT" \
  || fail "$(unit_props "$DNSMASQ_UNIT" | l34_v4_service_active_gate "$DNSMASQ_UNIT" 2>&1 | head -n 1)"
unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" \
  || fail "$(unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" 2>&1 | head -n 1)"
l34_v4_identity_snapshot "$DNSMASQ_UNIT" "$WORK/dnsmasq-identity-pre.txt" || fail L34_DNSMASQ_IDENTITY_UNREADABLE
l34_v4_identity_snapshot "$BROKER_UNIT" "$WORK/broker-identity-pre.txt" || fail L34_BROKER_IDENTITY_UNREADABLE
l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" 2>&1 | head -n 1)"
l34_v4_broker_listeners_gate "$L34_AP_ADDR" || fail "$(l34_v4_broker_listeners_gate "$L34_AP_ADDR" 2>&1 | head -n 1)"

for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-pre.txt"
ip route show default > "$WORK/default-route-pre.txt"

if [ "${AEGIS_L34_PREFLIGHT_ONLY:-NO}" = YES ]; then
  printf 'L34_V4_PREFLIGHT=PASS\n'
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
  exit 0
fi

# ── 3. FIRST runtime mutation (the runner takes its PRE capture before calling this handler) ─────────────────────────────
printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'
printf 'YES\n' > "$WORK/production-mutation"

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

# 3d. preservation proof: dnsmasq and the L6b broker were NEVER touched by this run
l34_v4_identity_unchanged "$DNSMASQ_UNIT" "$WORK/dnsmasq-identity-pre.txt" || fail L34_DNSMASQ_UNEXPECTEDLY_CHANGED
l34_v4_identity_unchanged "$BROKER_UNIT" "$WORK/broker-identity-pre.txt" || fail L34_BROKER_UNEXPECTEDLY_CHANGED
l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" 2>&1 | head -n 1)"
l34_v4_broker_listeners_gate "$L34_AP_ADDR" || fail "$(l34_v4_broker_listeners_gate "$L34_AP_ADDR" 2>&1 | head -n 1)"

printf 'L34_V4_APPLY=PASS\n'
printf 'REACTIVATION_TYPE=RUNTIME_ONLY\n'
printf 'PERSISTENT_FILES_REWRITTEN=NO\n'
printf 'DNSMASQ_MUTATED=NO\n'
printf 'L6B_BROKER_MUTATED=NO\n'
printf 'RFKILL_MUTATED=NO\n'
printf 'NM_RADIO_MUTATED=NO\n'
printf 'L3_LIVE_ACCEPTANCE_CLAIMED=NO\n'
printf 'L4_LIVE_ACCEPTANCE_CLAIMED=NO\n'
