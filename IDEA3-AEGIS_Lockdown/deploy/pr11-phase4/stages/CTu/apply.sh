#!/usr/bin/env bash
# CTu mutation is private to the frozen owner-runner. This public/bundle path
# is permanently non-mutating and refuses both direct execution and sourcing.
set -Eeuo pipefail
printf 'CTU_APPLY=FAIL reason=DIRECT_HANDLER_INVOCATION_REFUSED\n' >&2
exit 1
