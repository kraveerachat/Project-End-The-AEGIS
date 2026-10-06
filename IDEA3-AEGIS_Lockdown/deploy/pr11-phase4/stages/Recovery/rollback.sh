#!/usr/bin/env bash
# Recovery rollback is EVIDENCE-PRESERVING and performs NO action. It never reopens an incident, sends CUT/RESTORE, removes containment, restarts a service, removes R1I, or rewrites, deletes or reconstructs the
# consumed attempt marker or any evidence. Any post-marker failure requires human reconciliation, never an automatic rerun.
set -uo pipefail
[ "$#" = 0 ] || { printf 'RECOVERY_ROLLBACK=FAIL reason=NO_ARGUMENTS_ACCEPTED\n' >&2; exit 1; }
printf 'RECOVERY_ROLLBACK=HUMAN_RECONCILIATION_REQUIRED\nRECOVERY_AUTOMATIC_ROLLBACK=NO\nRECOVERY_ATTEMPT_RETRY=NEVER\nRECOVERY_RERUN_ALLOWED=NO\nRECOVERY_IS_R1B_RETRY=NO\nR1I_MUST_REMAIN_INSTALLED=YES\n'
