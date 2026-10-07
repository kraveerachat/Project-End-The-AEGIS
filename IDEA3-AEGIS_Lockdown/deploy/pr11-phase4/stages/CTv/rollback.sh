#!/usr/bin/env bash
set -Eeuo pipefail
printf 'CTV_ROLLBACK=FAIL reason=DIRECT_HANDLER_INVOCATION_REFUSED\n' >&2
exit 1
