#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L1 verify handler.
# Read-only post-stage verification. Changes nothing on host or fixture.
set -euo pipefail

fail() {
  printf 'L1_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

require_env() {
  local name=$1
  local value=${!name:-}
  [ -n "$value" ] || fail "$name required"
}

require_env AEGIS_L1_WORK_DIR
require_env AEGIS_P4_FS_ROOT

WORK_DIR="$AEGIS_L1_WORK_DIR"
FS_ROOT="$AEGIS_P4_FS_ROOT"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"

# 1. Delegate package presence and inactive service verification to helper (OD-L1-06, OD-L1-07)
if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" verify \
  --work-dir "$WORK_DIR" \
  --fs-root "$FS_ROOT"; then
  fail "package verification failed"
fi

# 2. Host preservation contract: allow-listeners carries zero active entries (OD-L1-07)
active_listeners=$(grep -cvE '^[[:space:]]*(#|$)' "$HERE/allow-listeners.txt" || true)
[ "$active_listeners" = "0" ] || fail "allow-listeners.txt must have zero active entries (found $active_listeners)"

printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'L1_VERIFY=PASS\n'
exit 0
