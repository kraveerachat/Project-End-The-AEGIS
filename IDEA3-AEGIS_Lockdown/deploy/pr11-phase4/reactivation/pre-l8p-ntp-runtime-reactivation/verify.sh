#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — PRE-L8p NTP RUNTIME REACTIVATION verify handler. READ-ONLY (it issues no systemctl action and writes only into its own work directory).
# Success claims nothing beyond: chronyd is running, timesyncd is not, exactly udp 10.77.30.1:123 is served (no wildcard), TrustedClock is SYNCED within the L5 bound,
# /etc/chrony.conf is byte-identical to the PRE snapshot (and to the approved L5 content) and both UnitFileStates are unchanged.
set -uo pipefail
export LC_ALL=C

fail() { printf 'NTPREACT_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../p4-ntp-reactivation-lib.sh
. "$P4_HERE/p4-ntp-reactivation-lib.sh"

WORK="${AEGIS_NTPREACT_WORK_DIR:-}"
[ "${AEGIS_NTPREACT_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
[ -n "$WORK" ] && [ -d "$WORK" ] && [ ! -L "$WORK" ] || fail WORK_DIR_MISSING
[ -f "$WORK/pre_snapshot" ] && [ -f "$WORK/pre_snapshot_complete" ] || fail PRE_SNAPSHOT_MISSING
pre() { sed -n "s/^$1=//p" "$WORK/pre_snapshot" | head -n 1; }

# runs the check in THIS shell (the clock gate sets NTPREACT_CLOCK_LINE); its one stable stderr reason line becomes the failure reason
GATE_ERR="$(mktemp)" || fail TEMPFILE_UNAVAILABLE
trap 'rm -f "$GATE_ERR"' EXIT
gate() { "$@" 2>"$GATE_ERR" >/dev/null && return 0; fail "$(head -n 1 "$GATE_ERR" | grep . || printf 'GATE_FAILED:%s' "$1")"; }

# services: runtime state
[ "$(ntpreact_unit_prop chronyd.service ActiveState)" = active ] && [ "$(ntpreact_unit_prop chronyd.service SubState)" = running ] || fail CHRONYD_NOT_ACTIVE_RUNNING
[ "$(ntpreact_unit_prop systemd-timesyncd.service ActiveState)" != active ] || fail CONCURRENT_TIME_DAEMONS_ACTIVE
# UnitFileState is protected: unchanged from PRE AND equal to the approved values
[ "$(ntpreact_unit_prop chronyd.service UnitFileState)" = "$(pre chronyd_unitfilestate)" ] && [ "$(pre chronyd_unitfilestate)" = disabled ] || fail CHRONYD_UNITFILESTATE_CHANGED
[ "$(ntpreact_unit_prop systemd-timesyncd.service UnitFileState)" = "$(pre timesyncd_unitfilestate)" ] && [ "$(pre timesyncd_unitfilestate)" = enabled ] || fail TIMESYNCD_UNITFILESTATE_CHANGED

# listeners
gate ntpreact_listener_exact_gate

# trusted clock (the existing L5 predicate) and its explicit bound
gate ntpreact_clock_gate
printf '%s\n' "$NTPREACT_CLOCK_LINE" > "$WORK/verify-clock.txt"

# configuration: byte-for-byte unchanged
post_sha="$(sha256sum "$NTPREACT_CHRONY_CONF" | awk '{ print $1 }')"
[ "$post_sha" = "$(pre chrony_conf_sha256)" ] || fail CHRONY_CONF_SHA256_CHANGED
[ "$post_sha" = "$NTPREACT_CHRONY_CONF_SHA256" ] || fail CHRONY_CONF_NOT_APPROVED_L5_CONTENT
[ "$(ntpreact_conf_meta)" = "$(pre chrony_conf_meta)" ] || fail CHRONY_CONF_METADATA_CHANGED

printf 'NTPREACT_VERIFY=PASS\n'
printf 'CHRONYD_ACTIVE=YES\n'
printf 'TIMESYNCD_INACTIVE=YES\n'
printf 'NTP_LISTENER=%s:123\n' "$NTPREACT_AP_ADDR"
printf 'WILDCARD_NTP_LISTENER=NO\n'
printf 'TRUSTEDCLOCK=SYNCED\n'
printf 'MAXERROR_WITHIN_L5_BOUND=YES\n'
printf 'CHRONYD_UNITFILESTATE=disabled\n'
printf 'TIMESYNCD_UNITFILESTATE=enabled\n'
printf 'CHRONY_CONF_SHA256_PRE_EQ_POST=YES\n'
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
