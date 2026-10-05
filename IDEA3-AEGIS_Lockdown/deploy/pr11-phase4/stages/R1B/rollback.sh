#!/usr/bin/env bash
# R1B rollback — EVIDENCE-PRESERVING and BOUNDED. R1B owns no reversible Production change: its only durable effects are GENUINE evidence produced by an
# external event (ALERT_ACCEPTED, INCIDENT_BOUND, an OPEN incident, detector journal lines). Genuine evidence is never deleted, closed, edited or rewritten to
# restore PRE. This handler therefore performs NO action: it touches no incident, audit row, journal, R1I table, blocked_ipv4, service or release pointer.
set -uo pipefail
[ "$#" = 0 ] || { printf 'R1B_ROLLBACK=FAIL reason=NO_ARGUMENTS_ACCEPTED\n' >&2; exit 1; }
printf 'R1B_ROLLBACK=EVIDENCE_PRESERVED\n'
printf 'R1B_REVERSIBLE_PRODUCTION_MUTATION_OWNED=NO\n'
printf 'R1B_GENUINE_EVIDENCE_RETAINED=YES\n'
printf 'R1B_RERUN_ALLOWED=NO\n'

printf 'R1A_RESULT=FAIL_IMMUTABLE\nR1A_EVIDENCE_PRESERVED=YES\n'
