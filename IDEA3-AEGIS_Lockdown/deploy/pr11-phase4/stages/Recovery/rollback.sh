#!/usr/bin/env bash
# Recovery rollback is evidence-preserving. It never reopens an incident, sends
# CUT/RESTORE, removes containment, or rewrites the consumed attempt. Any
# post-marker failure requires human reconciliation, not an automatic rerun.
set -uo pipefail
[ "$#" = 0 ] || { printf 'RECOVERY_ROLLBACK=FAIL reason=NO_ARGUMENTS_ACCEPTED\n' >&2; exit 1; }
printf 'RECOVERY_ROLLBACK=HUMAN_RECONCILIATION_REQUIRED\nRECOVERY_AUTOMATIC_ROLLBACK=NO\nRECOVERY_ATTEMPT_RETRY=NEVER\nRECOVERY_IS_R1B_RETRY=NO\n'
