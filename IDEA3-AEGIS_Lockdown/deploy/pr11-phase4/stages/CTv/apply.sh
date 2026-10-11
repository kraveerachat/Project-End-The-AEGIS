#!/usr/bin/env bash
# CTv mutation is private to the frozen owner runner.
set -Eeuo pipefail
printf 'CTV_APPLY=FAIL reason=DIRECT_HANDLER_INVOCATION_REFUSED\n' >&2
exit 1
