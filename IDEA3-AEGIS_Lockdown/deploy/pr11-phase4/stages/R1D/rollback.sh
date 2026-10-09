#!/usr/bin/env bash
# R1D rollback — EVIDENCE-PRESERVING and BOUNDED. The historical-incident disposition is a one-shot, irreversible Core transition: this handler performs NO action. It never reopens, deletes or edits an incident,
# audit row, marker, R1A/R1B evidence, R1I table, blocked_ipv4, service or release pointer, and it never retries the disposition.
set -uo pipefail
[ "$#" = 0 ] || { printf 'R1D_ROLLBACK=FAIL reason=NO_ARGUMENTS_ACCEPTED\n' >&2; exit 1; }
printf 'R1D_ROLLBACK=EVIDENCE_PRESERVED\n'
printf 'R1D_REVERSIBLE_PRODUCTION_MUTATION_OWNED=NO\n'
printf 'R1D_DISPOSITION_RETAINED_IF_COMMITTED=YES\n'
printf 'R1D_RERUN_ALLOWED=NO\n'
