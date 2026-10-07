#!/usr/bin/env bash
# CTu rollback is private to the frozen owner-runner. This public/bundle path
# is permanently non-mutating and refuses direct invocation.
set -Eeuo pipefail
printf 'CTU_ROLLBACK=FAIL reason=DIRECT_HANDLER_INVOCATION_REFUSED\n' >&2
exit 1
