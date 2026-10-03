#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — PRE-L8p NTP RUNTIME REACTIVATION apply handler (task package: pre-l8p-ntp-runtime-reactivation). NOT an L5 rerun.
# MUTATING only in live mode (AEGIS_NTPREACT_LIVE_AUTHORIZED=YES, root). The WHOLE mutation is exactly two systemctl commands, in this order:
#     systemctl stop systemd-timesyncd.service
#     systemctl start chronyd.service
# It never enables or disables a unit, never writes /etc/chrony.conf (it must already be the approved L5 content), never touches the network, the AP, dnsmasq, the
# broker or Core, and never restarts anything. UnitFileState is asserted before and proven unchanged by verify.sh.
# AEGIS_NTPREACT_PREFLIGHT_ONLY=YES runs every read-only PRE gate, records the PRE snapshot, and exits without any mutation.
set -uo pipefail
export LC_ALL=C

fail() { printf 'NTPREACT_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-ntp-reactivation-lib.sh
. "$P4_HERE/p4-ntp-reactivation-lib.sh"

WORK="${AEGIS_NTPREACT_WORK_DIR:-}"
PREFLIGHT_ONLY="${AEGIS_NTPREACT_PREFLIGHT_ONLY:-NO}"

[ "${AEGIS_NTPREACT_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -n "$WORK" ] || fail AEGIS_NTPREACT_WORK_DIR_REQUIRED
[ "${AEGIS_AP_INTERFACE:-$NTPREACT_AP_IF}" = "$NTPREACT_AP_IF" ] || fail TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3
[[ "$PREFLIGHT_ONLY" =~ ^(YES|NO)$ ]] || fail PREFLIGHT_FLAG_INVALID

# 1. Read-only PRE gates (every one fails closed with a stable reason; nothing has been changed yet).
# runs the check in THIS shell (the clock gate sets NTPREACT_CLOCK_LINE); its one stable stderr reason line becomes the failure reason
GATE_ERR="$(mktemp)" || fail TEMPFILE_UNAVAILABLE
trap 'rm -f "$GATE_ERR"' EXIT
gate() { "$@" 2>"$GATE_ERR" >/dev/null && return 0; fail "$(head -n 1 "$GATE_ERR" | grep . || printf 'GATE_FAILED:%s' "$1")"; }
gate ntpreact_pre_units_gate
gate ntpreact_ap_gate
gate ntpreact_conf_gate
gate ntpreact_alt_config_gate
gate ntpreact_no_ntp_listener_gate
gate ntpreact_clock_gate

umask 077
mkdir -p "$WORK" && chmod 700 "$WORK" || fail WORK_DIR_UNUSABLE
[ ! -e "$WORK/pre_snapshot_complete" ] || fail WORK_DIR_ALREADY_USED
{
  printf 'chrony_conf_sha256=%s\n' "$(sha256sum "$NTPREACT_CHRONY_CONF" | awk '{ print $1 }')"
  printf 'chrony_conf_meta=%s\n' "$(ntpreact_conf_meta)"
  printf 'chronyd_unitfilestate=%s\n' "$(ntpreact_unit_prop chronyd.service UnitFileState)"
  printf 'timesyncd_unitfilestate=%s\n' "$(ntpreact_unit_prop systemd-timesyncd.service UnitFileState)"
  printf 'timesyncd_pre_active=%s\n' "$(ntpreact_unit_prop systemd-timesyncd.service ActiveState)"
  printf 'chronyd_pre_active=%s\n' "$(ntpreact_unit_prop chronyd.service ActiveState)"
  printf 'pre_clock=%s\n' "$NTPREACT_CLOCK_LINE"
} > "$WORK/pre_snapshot" || fail PRE_SNAPSHOT_WRITE_FAILED
printf 'PRE\n' > "$WORK/pre_snapshot_complete"

if [ "$PREFLIGHT_ONLY" = YES ]; then
  printf 'NTPREACT_PREFLIGHT=PASS\n'
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
  exit 0
fi

# 2. FIRST ACTUAL MUTATION is the next command: record it durably and on stdout first, so a later failure can never erase the fact and the runner rolls back.
printf 'YES\n' > "$WORK/production-mutation"
printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'

printf 'stop systemd-timesyncd.service\n' >> "$WORK/service_events"
systemctl stop systemd-timesyncd.service || fail TIMESYNCD_STOP_FAILED
printf 'start chronyd.service\n' >> "$WORK/service_events"
systemctl start chronyd.service || fail CHRONYD_START_FAILED

# 3. Readiness: the shared L5 predicate (chronyd Leap status Normal AND kernel synced AND maxerror <= bound AND TrustedClock SYNCED). Bounded, read-only, never adjusts anything.
ready_out="$(python3 "$P4_HERE/p4-l5-clock.py" wait --timeout "${AEGIS_NTPREACT_READINESS_TIMEOUT_SEC:-60}" --interval 1 --work "$WORK" 2>&1)" \
  || fail "TRUSTEDCLOCK_READINESS_TIMEOUT:$(printf '%s\n' "$ready_out" | sed -n 's/.*reason=\([A-Z_]*\).*/\1/p' | tail -1)"
printf '%s\n' "$ready_out"

printf 'NTPREACT_APPLY=PASS\n'
