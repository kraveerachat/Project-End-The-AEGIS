#!/usr/bin/env bash
# LVR rollback — nothing to roll back: LVR is a READ-ONLY acceptance stage that
# owns no Production change. This handler performs NO action (it touches no incident,
# audit row, marker, evidence, table, service or release).
set -euo pipefail
[ "$#" = 0 ] || { printf 'LVR_ROLLBACK=FAIL reason=NO_ARGUMENTS_ACCEPTED\n' >&2; exit 1; }
printf 'LVR_ROLLBACK=NOTHING_OWNED\nLVR_REVERSIBLE_PRODUCTION_MUTATION_OWNED=NO\nLVR_IS_RECOVERY_RETRY=NO\n'
