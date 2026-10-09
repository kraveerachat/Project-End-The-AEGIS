#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — governed dnsmasq UNIT boot-order REPAIR apply handler (task-specific package; NOT an L-stage, NOT a V-retry).
# MUTATING in live mode. STAGE_NAME=dnsmasq-unit-boot-order-repair
# PR #305 fixed the canonical aegis-idea3-dnsmasq.service.example (bounded AP-readiness gate) in the repository. The live host still has the OLD pre-PR305 unit, which
# the corrected L34 authority refuses. This handler performs EXACTLY, in this order (every mutation is journaled BEFORE it is made so rollback.sh undoes only what
# this run owns):
#   1 backup of the installed old unit into the evidence directory   2 atomic install of the canonical template RENDERED with the fixed approved values
#   3 `systemctl daemon-reload`                                      4 FAILED baseline: `systemctl reset-failed` + `systemctl start` of aegis-idea3-dnsmasq.service
#                                                                      RUNNING baseline: `systemctl restart` of aegis-idea3-dnsmasq.service
#                                                                      SAFE_STOPPED baseline: `systemctl start` ONLY (no reset-failed: Result is already success; no restart)
#   5 bounded read-only wait for active/running, the exact listeners, and proof that nothing else moved.
# It supports EXACTLY three baselines (AP up and exactly approved + the exact old unit installed + dnsmasq either failed/start-limit-hit, active/running, or the exact
# SAFE_STOPPED state a governed rollback leaves: loaded/enabled/inactive/dead/success/MainPID 0 with no dnsmasq DNS/DHCP listener) and
# NEVER touches: the AP interface / NetworkManager / its profile (SSID, channel, IPv4), the DHCP pool or DNS mapping, nftables / forwarding, the broker, Twingate,
# Core, Recovery, the F1 detector, L8p, ESP32, serial ports, firmware, NVS or relay/CUT/RESTORE. It claims NO K12 reboot persistence, L3, L4 or L6b acceptance.
set -uo pipefail
export LC_ALL=C

fail() { printf 'DNSMASQ_REPAIR_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
# shellcheck source=../../p4-l34-v8-lib.sh
. "$P4_HERE/p4-l34-v8-lib.sh"
# shellcheck source=../../p4-dnsmasq-repair-lib.sh
. "$P4_HERE/p4-dnsmasq-repair-lib.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_DNSREPAIR_WORK_DIR:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
# Live timing is frozen. Only fixture (stubbed) runs may shorten the waits or inject a failure, so a live operator has no knob.
STABLE_INTERVAL=5
DNS_TRIES=20
DNS_INTERVAL=0.5
FAIL_AT=""
if [ -n "$ROOT" ]; then
  STABLE_INTERVAL="${AEGIS_DNSREPAIR_STABLE_INTERVAL:-5}"
  DNS_TRIES="${AEGIS_DNSREPAIR_TRIES:-20}"; DNS_INTERVAL="${AEGIS_DNSREPAIR_INTERVAL:-0.5}"
  FAIL_AT="${AEGIS_DNSREPAIR_FAIL_AT:-}"
fi
DNSMASQ_UNIT=$L34_UNIT
BROKER_UNIT=$L34_V7_BROKER_UNIT
CORE_UNIT=$L34_V7_CORE_UNIT
TEMPLATE="$(cd "$P4_HERE/../network" && pwd)/aegis-idea3-dnsmasq.service.example"

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
journal() { printf '%s\t%s\n' "$1" "$2" >> "$WORK/journal.tsv" || fail JOURNAL_WRITE_FAILED; }
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }
identity() { printf '%s/%s' "$(systemctl show -p MainPID --value "$1")" "$(systemctl show -p NRestarts --value "$1")"; }
reason_of() { "$@" 2>&1 >/dev/null | head -n 1; }
inject() { [ "$FAIL_AT" != "$1" ] || fail "FIXTURE_INJECTED_FAILURE:$1"; }   # fixture-only failure injection (FAIL_AT is empty in live mode)

# ── 1. environment / authorization ──────────────────────────────────────────────────────────────────────────────────
[ -n "$WORK" ] || fail AEGIS_DNSREPAIR_WORK_DIR_REQUIRED
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
case "$WORK" in /etc/*) fail WORK_DIR_INSIDE_ETC ;; esac
[ ! -L "$WORK" ] || fail WORK_DIR_IS_SYMLINK
[ ! -e "$WORK" ] || fail WORK_DIR_ALREADY_EXISTS
if [ -z "$ROOT" ]; then
  [ "${AEGIS_DNSREPAIR_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
else
  # Fixture mode drives the SAME code path, so every command must be a test stub: refuse to run against real host tools.
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in nmcli iw ip nft sysctl systemctl ss dnsmasq journalctl systemd-analyze; do
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
nft_file=$(host_path "$L34_NFT_FILE")
broker_conf=$(host_path "$L34_V7_BROKER_CONF")

# ── 2. read-only preflight: nothing below changes any state until PRODUCTION_MUTATION_PERFORMED=YES ─────────────────────
# 2a. the accepted persistent AP/DHCP/DNS/firewall/broker configuration (read only; this package never writes any of it)
l34_profile_gate "$profile" || fail "$(reason_of l34_profile_gate "$profile")"
l34_profile_effective_gate || fail "$(reason_of l34_profile_effective_gate)"
l34_dnsmasq_conf_gate "$conf" || fail "$(reason_of l34_dnsmasq_conf_gate "$conf")"
dnsmasq --test --conf-file="$conf" >/dev/null 2>&1 || fail DNSMASQ_CONFIG_SYNTAX_FAIL
[ -f "$nft_file" ] && [ ! -L "$nft_file" ] || fail L34_NFT_FILE_MISSING
l34_v7_broker_conf_gate "$broker_conf" || fail "$(reason_of l34_v7_broker_conf_gate "$broker_conf")"

# 2b. the AP is EXACTLY the approved one (interface, AP mode, SSID, channel, IPv4/prefix, no default route) and served by the approved profile
dnsrepair_ap_unchanged_gate "$AP_IF" || fail "$(reason_of dnsrepair_ap_unchanged_gate "$AP_IF")"

# 2c. the installed unit is the OLD refused authority; the canonical template renders (no placeholder) into a unit the corrected L34 authority accepts and
# `systemd-analyze verify` parses; no unit `daemon-reload` re-reads has a pending unreviewed on-disk change
dnsrepair_installed_unit_gate "$unit_file" "$TEMPLATE" || fail "$(reason_of dnsrepair_installed_unit_gate "$unit_file" "$TEMPLATE")"
RENDERED="$WORK/aegis-idea3-dnsmasq.service"
dnsrepair_render_gate "$TEMPLATE" "$RENDERED" || fail "$(reason_of dnsrepair_render_gate "$TEMPLATE" "$RENDERED")"
dnsrepair_analyze_gate "$RENDERED" || fail "$(reason_of dnsrepair_analyze_gate "$RENDERED")"
dnsrepair_need_reload_gate || fail "$(reason_of dnsrepair_need_reload_gate)"
OLD_SHA=$(dnsrepair_sha256 "$unit_file"); NEW_SHA=$(dnsrepair_sha256 "$RENDERED")

# 2d. the dnsmasq baseline: exactly FAILED (start-limit-hit, no listener) or RUNNING (exact three listeners); anything else is refused
unit_props "$DNSMASQ_UNIT" > "$WORK/dnsmasq-pre.txt" || fail L34_DNSMASQ_SHOW_FAILED
baseline=$(dnsrepair_baseline_classify < "$WORK/dnsmasq-pre.txt") || fail "$(dnsrepair_baseline_classify < "$WORK/dnsmasq-pre.txt" 2>&1 >/dev/null | head -n 1)"
if [ "$baseline" = FAILED ] || [ "$baseline" = SAFE_STOPPED ]; then
  l34_v6_no_ap_dns_dhcp_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v6_no_ap_dns_dhcp_gate "$AP_IF" "$L34_AP_ADDR")"
else
  l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR")"
fi
printf '%s\n' "$baseline" > "$WORK/baseline.txt"

# 2e. Core healthy, broker active with its exact 8883 pair and a STABLE tuple (recorded; later proven unchanged), Twingate/IDEA2/legacy identities recorded
unit_props "$CORE_UNIT" | l34_v7_core_gate || fail "$(unit_props "$CORE_UNIT" | l34_v7_core_gate 2>&1 | head -n 1)"
l34_v6_broker_tuple "$CORE_UNIT" > "$WORK/core-tuple-pre.txt" || fail DNSREPAIR_CORE_TUPLE_UNREADABLE
unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" || fail "$(unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" 2>&1 | head -n 1)"
l34_v7_broker_stable_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_V7_STABLE_SAMPLES" "$STABLE_INTERVAL" \
  || fail "$(reason_of l34_v7_broker_stable_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_V7_STABLE_SAMPLES" "$STABLE_INTERVAL")"
l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_AP_ADDR" || fail "$(reason_of l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_AP_ADDR")"
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-pre.txt"

# 2f. L2 / forwarding policy (never mutated) and the persistent snapshot
nft list table inet aegis_idea3 > "$WORK/nft-table-pre.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" || fail "$(l34_l2_text_gate "$AP_IF" < "$WORK/nft-table-pre.txt" 2>&1 | head -n 1)"
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"
dnsrepair_persistent_snapshot "$WORK/persistent-pre.tsv" "$profile" "$conf" "$nft_file" "$broker_conf" || fail L34_PERSISTENT_SNAPSHOT_FAILED
ip route show default > "$WORK/default-route-pre.txt"

printf 'DNSMASQ_REPAIR_BASELINE=%s\n' "$baseline"
if [ "${AEGIS_DNSREPAIR_PREFLIGHT_ONLY:-NO}" = YES ]; then
  printf 'DNSMASQ_REPAIR_PREFLIGHT=PASS\n'
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
  exit 0
fi

# ── 3. FIRST mutation (the runner takes its PRE capture before calling this handler) ──────────────────────────────────────
# The marker is written and confirmed BEFORE any mutating command: the runner decides whether rollback.sh must run by testing for it.
printf 'YES\n' > "$WORK/production-mutation" || fail PRODUCTION_MUTATION_MARKER_WRITE_FAILED
printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'

# 3a. backup of the exact old unit (digest-checked) BEFORE it is replaced; the journal owns the replacement from here on
install -m 0600 -- "$unit_file" "$WORK/unit.old" || fail UNIT_BACKUP_FAILED
[ "$(dnsrepair_sha256 "$WORK/unit.old")" = "$OLD_SHA" ] || fail UNIT_BACKUP_DIGEST_MISMATCH
journal UNIT_BACKUP "$OLD_SHA"
inject after_backup

# 3b. atomic install of the rendered canonical unit (journaled first, so a failure inside the rename is still rolled back)
journal UNIT_INSTALL "$NEW_SHA"
dnsrepair_install_unit "$RENDERED" "$unit_file" || fail "$(reason_of dnsrepair_install_unit "$RENDERED" "$unit_file")"
[ "$(dnsrepair_sha256 "$unit_file")" = "$NEW_SHA" ] || fail UNIT_INSTALL_DIGEST_MISMATCH
dnsrepair_canonical_unit_gate "$unit_file" "$TEMPLATE" || fail "$(reason_of dnsrepair_canonical_unit_gate "$unit_file" "$TEMPLATE")"
inject after_install

# 3c. systemd re-reads the unit definitions
journal DAEMON_RELOAD "$DNSMASQ_UNIT"
systemctl daemon-reload || fail DAEMON_RELOAD_FAILED
dnsrepair_need_reload_gate || fail "$(reason_of dnsrepair_need_reload_gate)"
inject after_reload

# 3d. the existing accepted dnsmasq service ONLY. No enable/disable. FAILED: clear the stale start-limit bookkeeping, then start. RUNNING: one restart.
# SAFE_STOPPED: start only (Result is already success, so there is nothing to reset, and a restart would be a second action on a stopped service).
if [ "$baseline" = FAILED ]; then
  journal DNSMASQ_RESET_FAILED "$DNSMASQ_UNIT"
  systemctl reset-failed "$DNSMASQ_UNIT" || fail DNSMASQ_RESET_FAILED_FAILED
  journal DNSMASQ_START "$DNSMASQ_UNIT"
  systemctl start "$DNSMASQ_UNIT" || fail DNSMASQ_SERVICE_START_FAILED
elif [ "$baseline" = SAFE_STOPPED ]; then
  journal DNSMASQ_START "$DNSMASQ_UNIT"
  systemctl start "$DNSMASQ_UNIT" || fail DNSMASQ_SERVICE_START_FAILED
else
  journal DNSMASQ_RESTART "$DNSMASQ_UNIT"
  systemctl restart "$DNSMASQ_UNIT" || fail DNSMASQ_SERVICE_RESTART_FAILED
fi
dns_ok=1
for ((i = 1; i <= DNS_TRIES; i++)); do
  if unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>/dev/null; then dns_ok=0; break; fi
  [ "$i" -lt "$DNS_TRIES" ] && sleep "$DNS_INTERVAL"
done
[ "$dns_ok" = 0 ] || fail "$(unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR")"

# 3e. nothing else moved: AP exactly as before, Core/broker/Twingate/IDEA2/legacy tuples, persistent files, L2, forwarding, default route
dnsrepair_ap_unchanged_gate "$AP_IF" || fail "$(reason_of dnsrepair_ap_unchanged_gate "$AP_IF")"
l34_v7_core_unchanged "$CORE_UNIT" "$WORK/core-tuple-pre.txt" || fail "$(reason_of l34_v7_core_unchanged "$CORE_UNIT" "$WORK/core-tuple-pre.txt")"
l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_AP_ADDR" || fail "$(reason_of l34_v6_broker_preserved_gate "$BROKER_UNIT" "$WORK/broker-tuple-pre.txt" "$L34_AP_ADDR")"
dnsrepair_persistent_verify "$WORK/persistent-pre.tsv" || fail "$(reason_of dnsrepair_persistent_verify "$WORK/persistent-pre.tsv")"
nft list table inet aegis_idea3 > "$WORK/nft-table-apply.txt" 2>/dev/null || fail "L2_RUNTIME_NOT_READY=YES:TABLE_MISSING"
cmp -s "$WORK/nft-table-pre.txt" "$WORK/nft-table-apply.txt" || fail L2_NFT_TABLE_CHANGED
nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"
[ "$(ip route show default)" = "$(cat "$WORK/default-route-pre.txt")" ] || fail DNSREPAIR_DEFAULT_ROUTE_CHANGED
for u in mosquitto.service twingate.service aegis-detection-engine.service aegis-detection-tunnel.service; do
  printf '%s %s\n' "$u" "$(identity "$u")"
done > "$WORK/identities-apply.txt"
cmp -s "$WORK/identities-pre.txt" "$WORK/identities-apply.txt" || fail LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED

printf 'DNSMASQ_REPAIR_APPLY=PASS\n'
printf 'DNSMASQ_REPAIR_BASELINE=%s\n' "$baseline"
printf 'REPAIR_SCOPE=ONE_UNIT_FILE_AND_ONE_SERVICE (aegis-idea3-dnsmasq.service)\n'
printf 'AP_CHANGED=NO\n'
printf 'NETWORKMANAGER_CHANGED=NO\n'
printf 'NFTABLES_OR_FORWARDING_CHANGED=NO\n'
printf 'BROKER_CONTROL_COMMAND_ISSUED=NO\n'
printf 'CORE_CONTROL_COMMAND_ISSUED=NO\n'
printf 'TWINGATE_MUTATED=NO\n'
printf 'ESP32_TOUCHED=NO\n'
printf 'K12_AUTOMATIC_REBOOT_PERSISTENCE_CLAIMED=NO\n'
