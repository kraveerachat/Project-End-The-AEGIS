#!/usr/bin/env bash
# LVR read-only acceptance stage: apply is a contract NO-OP.
# LVR owns NO Production mutation (no service restart, no table modification,
# no incident or audit mutation, no hardware touch).
set -euo pipefail
[ "$#" = 0 ] || { printf 'LVR_APPLY=FAIL reason=NO_ARGUMENTS_ACCEPTED\n' >&2; exit 1; }
printf 'LVR_APPLY=COMPLETE\nLVR_PRODUCTION_MUTATION=NO\nLVR_STAGE=LVR\n'
