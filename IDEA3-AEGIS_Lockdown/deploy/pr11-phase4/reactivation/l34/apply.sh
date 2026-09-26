#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-REBOOT RUNTIME REACTIVATION apply handler (RUNTIME_ONLY).
# MUTATING in live mode. It restores the ALREADY ACCEPTED persistent L3/L4 configuration to its accepted ACTIVE runtime state:
#   1. exact-ID rfkill unblock of the resolved target only (if it is soft-blocked),
#   1b. GLOBAL NM Wi-Fi radio mutation is FORBIDDEN BY DEFAULT. Only under the explicit V2 authorization (AEGIS_L34_NM_RADIO_ENABLE=YES, set by the
#       runner after the exact V2 scope) and only if NM still reports the radio disabled after the unblock: a temporary runtime
#       `nmcli device set wlp0s20f3 autoconnect no` (PRE value restored later), then `nmcli radio wifi on` EXACTLY ONCE. Allowed only when
#       preflight proves wlp0s20f3 is the sole Wi-Fi device/wlan rfkill and no Wi-Fi connection is active. rollback.sh disables the radio only if
#       this run enabled it. Never used otherwise.
#   2. bounded NetworkManager target-device readiness, then `nmcli connection up aegis-idea3-ap ifname wlp0s20f3`,
#   3. `systemctl reset-failed` + `systemctl start` of aegis-idea3-dnsmasq.service ONLY (no enable/disable).
# It never rewrites the NetworkManager profile or any persistent NetworkManager configuration, the dnsmasq config/unit or the nft file, never
# touches nftables, forwarding, regulatory state, enp62s0, legacy mosquitto or Twingate, changes the global Wi-Fi radio only through the single
# V2-authorized enable described above, and claims NO L3/L4 live acceptance.
# Every runtime change is journaled BEFORE it is made so rollback.sh undoes exactly what this run changed.
set -uo pipefail
export LC_ALL=C

fail() { printf 'L34_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
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
SVC_TRIES="${AEGIS_L34_SVC_TRIES:-20}"
SVC_INTERVAL="${AEGIS_L34_SVC_INTERVAL:-0.5}"
EXAMPLE_UNIT="$(cd "$P4_HERE/../network" && pwd)/aegis-idea3-dnsmasq.service.example"

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
journal() { printf '%s\t%s\n' "$1" "$2" >> "$WORK/journal.tsv" || fail JOURNAL_WRITE_FAILED; }
listeners() { { ss -H -lnt | awk '{ print "tcp " $4 }'; ss -H -lnu | awk '{ print "udp " $4 }'; } | LC_ALL=C sort -u; }
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID -p NRestarts -p ExecMainStartTimestamp "$1"; }
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
  sysfs=/sys
else
  # Fixture mode drives the SAME code path, so every command must be a test stub: refuse to run against real host tools.
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in rfkill nmcli iw ip nft sysctl systemctl ss dnsmasq; do
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

# ── 2. read-only preflight: nothing below changes any state until PRODUCTION_MUTATION_PERFORMED=YES ─────────────────────
l34_profile_gate "$profile" || fail "$(l34_profile_gate "$profile" 2>&1 | head -n 1)"
l34_profile_effective_gate || fail "$(l34_profile_effective_gate 2>&1 | head -n 1)"
l34_dnsmasq_conf_gate "$conf" || fail "$(l34_dnsmasq_conf_gate "$conf" 2>&1 | head -n 1)"
l34_dnsmasq_unit_gate "$unit_file" "$EXAMPLE_UNIT" || fail L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY
[ -f "$nft_file" ] && [ ! -L "$nft_file" ] || fail L34_NFT_FILE_MISSING
dnsmasq --test --conf-file="$conf" >/dev/null 2>&1 || fail DNSMASQ_CONFIG_SYNTAX_FAIL
l34_persistent_snapshot "$WORK/persistent-pre.tsv" "$profile" "$conf" "$unit_file" "$nft_file" || fail L34_PERSISTENT_SNAPSHOT_FAILED

nft list table inet aegis_idea3 > "$WORK/nft-table-pre.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" || fail "$(l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" 2>&1 | head -n 1)"
[ "$(nft list tables 2>/dev/null | grep -c .)" -ge 1 ] || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
[ "$(nft list tables 2>/dev/null | grep -c 'table inet aegis_idea3$')" = 1 ] || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(l34_forwarding_gate "$AP_IF" 2>&1 | head -n 1)"

l34_ap_pre_gate "$AP_IF" || fail "$(l34_ap_pre_gate "$AP_IF" 2>&1 | head -n 1)"
l3_reg_gate "$AP_IF" "$L34_CHANNEL" || fail "$L3_REG_REASON"
l34_no_wifi_active_gate || fail "$(l34_no_wifi_active_gate 2>&1 | head -n 1)"
radio_pre=$(nmcli radio wifi 2>/dev/null || true)
radio_authorized=0
dev_ac_prior=""
if [ "$radio_pre" = disabled ] && [ "${AEGIS_L34_NM_RADIO_ENABLE:-NO}" = YES ]; then
  # NEW OWNER DECISION BOUNDARY: a global NetworkManager radio change is only acceptable when the machine topology makes its scope the target.
  l34_wifi_topology_gate "$AP_IF" "$sysfs" || fail "$(l34_wifi_topology_gate "$AP_IF" "$sysfs" 2>&1 | head -n 1)"
  dev_ac_prior=$(l34_device_autoconnect "$AP_IF") || fail L34_DEVICE_AUTOCONNECT_UNREADABLE
  radio_authorized=1
fi
l3_rfkill_resolve_id "$AP_IF" "$sysfs" "$L34_EXPECTED_RFKILL_ID" || fail "$L3_RFKILL_REASON"
rfkill_id=$L3_RFKILL_ID
l3_rfkill_state "$rfkill_id" || fail "$L3_RFKILL_REASON"
[ "$L3_RFKILL_HARD" != blocked ] || fail RFKILL_HARD_BLOCKED
printf 'id=%s soft=%s hard=%s\n' "$rfkill_id" "$L3_RFKILL_SOFT" "$L3_RFKILL_HARD" > "$WORK/rfkill-target-pre.txt"
l34_rfkill_snapshot "$WORK/rfkill-all-pre.txt" || fail L34_RFKILL_LIST_UNREADABLE

unit_props "$L34_UNIT" > "$WORK/dnsmasq-pre.txt" || fail L34_DNSMASQ_SHOW_FAILED
l34_service_pre_gate < "$WORK/dnsmasq-pre.txt" || fail "$(l34_service_pre_gate < "$WORK/dnsmasq-pre.txt" 2>&1 | head -n 1)"
listeners > "$WORK/listeners-pre.txt"
ip route show default > "$WORK/default-route-pre.txt"
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-pre.txt"
awk '$2 ~ /:1883$/ { print $2 }' "$WORK/listeners-pre.txt" > "$WORK/legacy-1883-pre.txt"
nmcli radio wifi > "$WORK/nm-radio-pre.txt" 2>/dev/null || true

if [ "${AEGIS_L34_PREFLIGHT_ONLY:-NO}" = YES ]; then
  printf 'L34_PREFLIGHT=PASS\n'
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
  exit 0
fi

# ── 3. FIRST runtime mutation (the runner takes its PRE capture before calling this handler) ─────────────────────────────
printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'
printf 'YES\n' > "$WORK/production-mutation"

# 3a. exact-ID rfkill unblock of the resolved target only; never `rfkill unblock all` (the radio enable, if authorized, is step 3a' below)
if [ "$L3_RFKILL_SOFT" = blocked ]; then
  journal RFKILL_UNBLOCK "$rfkill_id"
  l3_rfkill_prepare "$AP_IF" "$WORK" "$L34_EXPECTED_RFKILL_ID" "$sysfs" || fail "$L3_RFKILL_REASON"
else
  printf '0\n' > "$WORK/rfkill_pre_state"
  printf '%s\n' "$rfkill_id" > "$WORK/rfkill_id"
fi
l34_rfkill_only_target_changed "$WORK/rfkill-all-pre.txt" "$rfkill_id" || fail L34_RFKILL_NON_TARGET_CHANGED

# 3a'. owner-authorized global radio enable (V2). Order matters: the runtime device autoconnect is disabled FIRST so that, once the radio is
# on, no autoconnect Wi-Fi profile can activate on the target before the one bound activation below.
radio_enabled_by_run=NO
radio_now=$(nmcli radio wifi 2>/dev/null || true)   # after the exact unblock: `enabled` means NM's software flag was already on (old, no-global path)
if [ "${AEGIS_L34_NM_RADIO_ENABLE:-NO}" = YES ] && [ "$radio_authorized" = 1 ] && [ "$radio_now" = disabled ]; then
  journal NM_DEVICE_AUTOCONNECT_DISABLE "$dev_ac_prior"
  nmcli device set "$AP_IF" autoconnect no || fail NM_DEVICE_AUTOCONNECT_SET_FAILED
  journal NM_WIFI_RADIO_ENABLE disabled
  nmcli radio wifi on || fail NM_WIFI_RADIO_ENABLE_FAILED
  radio_enabled_by_run=YES
fi

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
l3_reg_verify_active "$AP_IF" "$L34_CHANNEL" || fail "$L3_REG_REASON"
[ "$(ip route show default)" = "$(cat "$WORK/default-route-pre.txt")" ] || fail L34_DEFAULT_ROUTE_CHANGED
l34_no_wifi_active_gate 2>/dev/null && fail L34_AP_CONNECTION_NOT_ACTIVE
if [ "$radio_authorized" = 1 ]; then
  # the AP is active through its explicit activation; put the device autoconnect back to exactly its PRE value
  nmcli device set "$AP_IF" autoconnect "$dev_ac_prior" || fail NM_DEVICE_AUTOCONNECT_RESTORE_FAILED
  journal NM_DEVICE_AUTOCONNECT_RESTORED "$dev_ac_prior"
fi

# 3c. the existing accepted dnsmasq service ONLY: reset the stale post-reboot failed bookkeeping, then start it. No enable/disable.
journal DNSMASQ_RESET_FAILED "$L34_UNIT"
systemctl reset-failed "$L34_UNIT" || fail DNSMASQ_RESET_FAILED_FAILED
journal DNSMASQ_START "$L34_UNIT"
systemctl start "$L34_UNIT" || fail DNSMASQ_SERVICE_START_FAILED
svc_ok=1
for ((i = 1; i <= SVC_TRIES; i++)); do
  if unit_props "$L34_UNIT" | l34_service_active_gate 2>/dev/null; then svc_ok=0; break; fi
  [ "$i" -lt "$SVC_TRIES" ] && sleep "$SVC_INTERVAL"
done
[ "$svc_ok" = 0 ] || fail "$(unit_props "$L34_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"

printf 'L34_APPLY=PASS\n'
printf 'REACTIVATION_TYPE=RUNTIME_ONLY\n'
printf 'PERSISTENT_FILES_REWRITTEN=NO\n'
printf 'NM_WIFI_RADIO_ENABLED_BY_RUN=%s\n' "$radio_enabled_by_run"
printf 'GLOBAL_RADIO_CHANGE=%s\n' "$radio_enabled_by_run"
printf 'L3_LIVE_ACCEPTANCE_CLAIMED=NO\n'
printf 'L4_LIVE_ACCEPTANCE_CLAIMED=NO\n'
printf 'K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN\n'
