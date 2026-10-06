#!/usr/bin/env bash
# R1Dv rollback — nothing to roll back: R1Dv is a READ-ONLY validation stage that owns no Production change. This handler performs NO action (it touches no incident, audit row, marker, evidence, table, service or release).
set -uo pipefail
[ "$#" = 0 ] || { printf 'R1DV_ROLLBACK=FAIL reason=NO_ARGUMENTS_ACCEPTED\n' >&2; exit 1; }
printf 'R1DV_ROLLBACK=NOTHING_OWNED\nR1DV_REVERSIBLE_PRODUCTION_MUTATION_OWNED=NO\nR1DV_IS_R1D_RETRY=NO\n'
