#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — dnsmasq unit boot-order REBOOT VERIFICATION handler. STRICTLY READ-ONLY, and SEPARATE from the repair run.
# Two modes (AEGIS_DNSREPAIR_REBOOT_MODE):
#   record  BEFORE the owner-approved orderly reboot: proves the repair run's terminal verdict was PASS, the host is in the repaired good state, the AP profile
#           autoconnects and dnsmasq is enabled; writes reboot-pre.txt (boot id, approval reference, persistent snapshot) into a NEW evidence directory.
#   verify  AFTER the reboot: proves a reboot happened (boot id changed), then — after a bounded read-only convergence wait — that the AP came back with the exact
#           approved mode/SSID/channel/IPv4, dnsmasq is active/running with the canonical unit loaded, did not exhaust its StartLimit and logged no unknown-interface /
#           bind failure this boot, Core and the broker are healthy, forwarding is still zero, L2 is intact and no persistent file drifted across the reboot.
# This script NEVER reboots, shuts down, starts, stops, restarts, reloads, resets or modifies anything: the reboot itself is a separate owner action. It records
#   K12_PERSISTENCE_OBSERVED   — what this run saw (YES only when every check passed AND the owner attested no manual intervention after the boot), and separately
#   K12_FORMALLY_PROVEN=NO     — always: the repository holds no canonical K12 acceptance contract that lets a script conclude formal proof; that is an owner/Kla decision.
set -uo pipefail
export LC_ALL=C

fail() {
  printf 'REBOOT_VERIFICATION_RESULT=FAIL reason=%s\n' "$1" >&2
  printf 'REBOOT_VERIFICATION_RESULT=FAIL\nK12_PERSISTENCE_OBSERVED=NO\nK12_FORMALLY_PROVEN=NO\nK12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN\n'
  exit 1
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-l34-reactivation-lib.sh
. "$P4_HERE/p4-l34-reactivation-lib.sh"
# shellcheck source=../../p4-l34-v8-lib.sh
. "$P4_HERE/p4-l34-v8-lib.sh"
# shellcheck source=../../p4-dnsmasq-repair-lib.sh
. "$P4_HERE/p4-dnsmasq-repair-lib.sh"

ROOT="${AEGIS_P4_FS_ROOT:-}"
MODE="${AEGIS_DNSREPAIR_REBOOT_MODE:-}"
RDIR="${AEGIS_DNSREPAIR_REBOOT_DIR:-}"
REPAIR_EVID="${AEGIS_DNSREPAIR_REPAIR_EVIDENCE:-}"
AP_IF="${AEGIS_AP_INTERFACE:-$L34_AP_IF}"
TRIES=90; INTERVAL=2
[ -z "$ROOT" ] || { TRIES="${AEGIS_DNSREPAIR_TRIES:-90}"; INTERVAL="${AEGIS_DNSREPAIR_INTERVAL:-2}"; }
DNSMASQ_UNIT=$L34_UNIT
BROKER_UNIT=$L34_V7_BROKER_UNIT
CORE_UNIT=$L34_V7_CORE_UNIT
TEMPLATE="$(cd "$P4_HERE/../network" && pwd)/aegis-idea3-dnsmasq.service.example"

host_path() { if [ -n "$ROOT" ]; then printf '%s%s\n' "${ROOT%/}" "$1"; else printf '%s\n' "$1"; fi; }
unit_props() { systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID "$1"; }
reason_of() { "$@" 2>&1 >/dev/null | head -n 1; }
boot_id() { cat "$(host_path /proc/sys/kernel/random/boot_id)" 2>/dev/null; }

[ "$MODE" = record ] || [ "$MODE" = verify ] || fail MODE_MUST_BE_record_OR_verify
[ -n "$RDIR" ] || fail AEGIS_DNSREPAIR_REBOOT_DIR_REQUIRED
[ "$AP_IF" = "$L34_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
[ ! -L "$RDIR" ] || fail REBOOT_DIR_IS_SYMLINK
if [ -z "$ROOT" ]; then
  : # a read-only observer: it runs as the owner's normal user or root; it needs no authorization flag because it changes nothing
else
  [ -n "${AEGIS_L34_STUB_DIR:-}" ] || fail FIXTURE_REQUIRES_STUB_DIR
  for c in nmcli iw ip nft sysctl systemctl ss dnsmasq journalctl systemd-analyze; do
    [[ "$(command -v "$c" 2>/dev/null)" == "$AEGIS_L34_STUB_DIR"/* ]] || fail "FIXTURE_COMMAND_NOT_STUBBED:$c"
  done
fi
profile=$(host_path "$L34_PROFILE"); conf=$(host_path "$L34_DNSMASQ_CONF"); unit_file=$(host_path "$L34_DNSMASQ_UNIT")
nft_file=$(host_path "$L34_NFT_FILE"); broker_conf=$(host_path "$L34_V7_BROKER_CONF")

# the AP side of the repaired state (used both to wait for convergence and to judge it)
ap_ready() { dnsrepair_ap_unchanged_gate "$AP_IF" >/dev/null 2>&1; }
services_ready() {
  unit_props "$DNSMASQ_UNIT" | l34_service_active_gate >/dev/null 2>&1 \
    && unit_props "$CORE_UNIT" | l34_v7_core_gate >/dev/null 2>&1 \
    && unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" >/dev/null 2>&1
}

# every check of the repaired good state; each prints one PASS line and exits through fail() on the first problem
state_checks() {
  local nrest journal bad
  # the canonical unit is installed AND loaded
  dnsrepair_canonical_unit_gate "$unit_file" "$TEMPLATE" || fail "$(reason_of dnsrepair_canonical_unit_gate "$unit_file" "$TEMPLATE")"
  dnsrepair_need_reload_gate || fail "$(reason_of dnsrepair_need_reload_gate)"
  echo "DNSMASQ_UNIT_AUTHORITY=PASS"
  # the AP: exactly the approved one, served by the approved profile, with the profile autoconnecting
  dnsrepair_ap_unchanged_gate "$AP_IF" || fail "$(reason_of dnsrepair_ap_unchanged_gate "$AP_IF")"
  echo "AP_MODE=PASS"; echo "AP_SSID=PASS"; echo "AP_CHANNEL=PASS"; echo "AP_IPV4_PREFIX=PASS"
  l34_v8_profile_autoconnect_enabled_gate "$profile" || fail "$(reason_of l34_v8_profile_autoconnect_enabled_gate "$profile")"
  echo "AP_PROFILE_AUTOCONNECT=PASS"
  # dnsmasq: active/running, enabled, no start-limit hit, exact listeners, and a clean boot journal
  unit_props "$DNSMASQ_UNIT" | l34_service_active_gate || fail "$(unit_props "$DNSMASQ_UNIT" | l34_service_active_gate 2>&1 | head -n 1)"
  ! unit_props "$DNSMASQ_UNIT" | grep -qx 'Result=start-limit-hit' || fail DNSREPAIR_DNSMASQ_START_LIMIT_HIT
  l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR" || fail "$(reason_of l34_v4_dnsmasq_listeners_gate "$AP_IF" "$L34_AP_ADDR")"
  echo "DNSMASQ_ACTIVE=YES"; echo "DNSMASQ_RUNNING=YES"; echo "DNSMASQ_START_LIMIT_HIT=NO"
  journal=$(journalctl -u "$DNSMASQ_UNIT" -b --no-pager 2>/dev/null) || fail DNSREPAIR_DNSMASQ_JOURNAL_UNREADABLE
  bad=$(grep -Eci 'unknown interface|cannot assign requested address|start request repeated too quickly|start-limit|failed with result' <<< "$journal" || true)
  [ "$bad" = 0 ] || fail "DNSREPAIR_DNSMASQ_BOOT_FAILURE_SIGNATURES:$bad"
  echo "DNSMASQ_UNKNOWN_INTERFACE_FAILURES=0"
  nrest=$(systemctl show -p NRestarts --value "$DNSMASQ_UNIT" 2>/dev/null) || fail DNSREPAIR_DNSMASQ_NRESTARTS_UNREADABLE
  [[ "$nrest" =~ ^[0-9]+$ ]] && [ "$nrest" -lt 5 ] || fail "DNSREPAIR_DNSMASQ_RESTART_COUNT_NOT_BOUNDED:$nrest"
  echo "DNSMASQ_NRESTARTS=$nrest"
  if [ "$nrest" = 0 ]; then echo "DNSMASQ_WAITED_FOR_AP=OBSERVED"; else echo "DNSMASQ_WAITED_FOR_AP=OBSERVED_WITH_BOUNDED_RETRIES"; fi
  # Core and the broker are healthy; Twingate is up; forwarding policy and L2 intact
  unit_props "$CORE_UNIT" | l34_v7_core_gate || fail "$(unit_props "$CORE_UNIT" | l34_v7_core_gate 2>&1 | head -n 1)"
  echo "CORE_HEALTH=PASS"
  unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" || fail "$(unit_props "$BROKER_UNIT" | l34_v4_service_active_gate "$BROKER_UNIT" 2>&1 | head -n 1)"
  l34_v4_broker_listeners_gate "$L34_AP_ADDR" || fail "$(reason_of l34_v4_broker_listeners_gate "$L34_AP_ADDR")"
  echo "BROKER_HEALTH=PASS"
  [ "$(systemctl show -p ActiveState --value twingate.service)" = active ] || fail DNSREPAIR_TWINGATE_NOT_ACTIVE
  l34_forwarding_gate "$AP_IF" || fail "$(reason_of l34_forwarding_gate "$AP_IF")"
  echo "FORWARDING_POLICY=PASS"
  nft list table inet aegis_idea3 2>/dev/null | l34_l2_text_gate "$AP_IF" || fail "L2_RUNTIME_NOT_READY=YES"
  nft list ruleset 2>/dev/null | l34_no_nat_gate || fail "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"
  echo "L2_FIREWALL=PASS"
  # the accepted persistent configuration is intact
  l34_profile_gate "$profile" || fail "$(reason_of l34_profile_gate "$profile")"
  l34_dnsmasq_conf_gate "$conf" || fail L34_DNSMASQ_CONF_CHANGED
  l34_v7_broker_conf_gate "$broker_conf" || fail "$(reason_of l34_v7_broker_conf_gate "$broker_conf")"
  [ -f "$nft_file" ] && [ ! -L "$nft_file" ] || fail L34_NFT_FILE_MISSING
}

case "$MODE" in
record)
  [ ! -e "$RDIR" ] || fail REBOOT_DIR_ALREADY_EXISTS
  [ -n "$REPAIR_EVID" ] && [ -f "$REPAIR_EVID/terminal-verdict.txt" ] || fail REPAIR_EVIDENCE_TERMINAL_VERDICT_MISSING
  grep -qx 'DNSMASQ_REPAIR_RESULT=PASS' "$REPAIR_EVID/terminal-verdict.txt" || fail REPAIR_EVIDENCE_NOT_PASS
  [[ "${AEGIS_DNSREPAIR_APPROVAL_REF:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._:/#?=\&%+-]{2,199}$ ]] || fail REBOOT_APPROVAL_REFERENCE_MISSING_OR_MALFORMED
  [[ "${AEGIS_DNSREPAIR_APPROVAL_REF^^}" =~ (REPLACE|TODO|TBD|CHANGEME|FIXME|XXX) ]] && fail REBOOT_APPROVAL_REFERENCE_IS_A_PLACEHOLDER
  bid=$(boot_id) && [ -n "$bid" ] || fail BOOT_ID_UNREADABLE
  # the repaired good state is proven BEFORE anything is written, so a bad host leaves no record behind
  out=$(state_checks) || { printf '%s\n' "$out"; exit 1; }
  umask 077
  mkdir -p "$RDIR" || fail REBOOT_DIR_CREATE_FAILED
  chmod 700 "$RDIR"
  printf '%s\n' "$out" > "$RDIR/pre-reboot-state.txt"
  dnsrepair_persistent_snapshot "$RDIR/persistent-pre-reboot.tsv" "$profile" "$conf" "$nft_file" "$broker_conf" "$unit_file" || fail L34_PERSISTENT_SNAPSHOT_FAILED
  { echo "BOOT_ID=$bid"; echo "RECORDED_AT=$(date -u +%FT%TZ)"; echo "APPROVAL_REF=$AEGIS_DNSREPAIR_APPROVAL_REF"; echo "REPAIR_EVIDENCE=$REPAIR_EVID"; } > "$RDIR/reboot-pre.txt"
  printf '%s\n' "$out"
  echo "REBOOT_VERIFICATION_RECORDED=YES"
  echo "REBOOT_VERIFICATION_EXECUTED=NO"
  echo "NEXT=the owner performs ONE orderly reboot (this script never reboots), does NOT intervene on the AP/dnsmasq after boot, then runs the verify mode"
  echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"
  echo "PRODUCTION_MUTATION_PERFORMED=NO"
  ;;
verify)
  [ -d "$RDIR" ] && [ -f "$RDIR/reboot-pre.txt" ] || fail REBOOT_PRE_RECORD_MISSING
  [ ! -e "$RDIR/reboot-post.txt" ] || fail REBOOT_VERIFICATION_ALREADY_RECORDED
  pre_boot=$(sed -n 's/^BOOT_ID=//p' "$RDIR/reboot-pre.txt")
  [ -n "$pre_boot" ] || fail REBOOT_PRE_RECORD_MALFORMED
  now_boot=$(boot_id) && [ -n "$now_boot" ] || fail BOOT_ID_UNREADABLE
  [ "$now_boot" != "$pre_boot" ] || fail REBOOT_NOT_OBSERVED_SAME_BOOT_ID
  echo "REBOOT_OBSERVED=YES"
  # bounded, READ-ONLY convergence wait: the services need a little time after boot; this only watches, it commands nothing
  converged=1
  for ((i = 1; i <= TRIES; i++)); do
    if ap_ready && services_ready; then converged=0; break; fi
    [ "$i" -lt "$TRIES" ] && sleep "$INTERVAL"
  done
  echo "CONVERGENCE_WAIT_POLLS=$i"
  out=$(state_checks) || { printf '%s\n' "$out"; exit 1; }
  printf '%s\n' "$out"
  dnsrepair_persistent_verify "$RDIR/persistent-pre-reboot.tsv" || fail "$(reason_of dnsrepair_persistent_verify "$RDIR/persistent-pre-reboot.tsv")"
  echo "PERSISTENT_FILES_UNCHANGED_ACROSS_REBOOT=PASS"
  echo "UNEXPECTED_DRIFT=NONE_OBSERVED_IN_CHECKED_SCOPE"
  echo "REBOOT_VERIFICATION_EXECUTED=YES"
  echo "REBOOT_VERIFICATION_RESULT=PASS"
  if [ "${AEGIS_DNSREPAIR_NO_MANUAL_INTERVENTION:-NO}" = YES ] && [ "$converged" = 0 ]; then
    echo "K12_PERSISTENCE_OBSERVED=YES"
  else
    echo "K12_PERSISTENCE_OBSERVED=NO (every check passed, but the owner did not attest NO manual AP/dnsmasq intervention after boot, or the host had not converged within the wait)"
  fi
  echo "K12_FORMALLY_PROVEN=NO"
  echo "K12_FORMAL_PROOF_NOTE=no canonical K12 acceptance contract in the repository lets a script conclude formal proof; recording it is an owner/integration decision"
  echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"
  echo "PRODUCTION_MUTATION_PERFORMED=NO"
  echo "ESP32_TOUCHED=NO"
  { echo "VERIFIED_AT=$(date -u +%FT%TZ)"; echo "BOOT_ID=$now_boot"; } > "$RDIR/reboot-post.txt"
  ;;
esac
