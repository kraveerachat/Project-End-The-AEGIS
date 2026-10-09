#!/usr/bin/env bash
# R1Bv rollback — nothing to roll back: R1Bv is a READ-ONLY validation stage that owns no Production change. This handler performs NO action (it touches no incident, audit row, marker, evidence, table, service or release).
set -uo pipefail
[ "$#" = 0 ] || { printf 'R1BV_ROLLBACK=FAIL reason=NO_ARGUMENTS_ACCEPTED\n' >&2; exit 1; }
printf 'R1BV_ROLLBACK=NOTHING_OWNED\nR1BV_REVERSIBLE_PRODUCTION_MUTATION_OWNED=NO\nR1BV_IS_R1B_RETRY=NO\n'
