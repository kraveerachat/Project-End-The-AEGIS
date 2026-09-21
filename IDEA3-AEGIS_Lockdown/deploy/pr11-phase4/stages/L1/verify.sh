#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L1 verify handler.
# Read-only post-stage verification. Changes nothing on host or fixture.
# AEGIS_P4_FS_ROOT is a TEST-ONLY fixture prefix (p4-lib.sh) and is required
# only for the fixture backend; live-mode verification reads real host
# package/service state instead and never touches FS_ROOT.
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

BACKEND="${AEGIS_L1_BACKEND:-fixture}"
PYTHON_BIN="${AEGIS_PYTHON_BIN:-python3}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
WORK_DIR="${AEGIS_L1_WORK_DIR:-}"
FS_ROOT=""

if [ "$BACKEND" = "fixture" ]; then
  require_env AEGIS_L1_WORK_DIR
  require_env AEGIS_P4_FS_ROOT
  WORK_DIR="$AEGIS_L1_WORK_DIR"
  FS_ROOT="$AEGIS_P4_FS_ROOT"
elif [ "$BACKEND" = "live" ] && [ -n "${AEGIS_P4_FS_ROOT:-}" ]; then
  fail "LIVE_MODE_FS_ROOT_REFUSED (AEGIS_P4_FS_ROOT is TEST-ONLY and must be unset in live mode)"
fi

# 1. Delegate package presence and inactive service verification to helper (OD-L1-06, OD-L1-07)
if [ "$BACKEND" = "fixture" ]; then
  if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" verify \
    --backend "$BACKEND" \
    --work-dir "$WORK_DIR" \
    --fs-root "$FS_ROOT"; then
    fail "package verification failed"
  fi
else
  if ! "$PYTHON_BIN" "$P4_HERE/p4-l1-packages.py" verify \
    --backend "$BACKEND"; then
    fail "package verification failed"
  fi
fi

# 2. Host preservation contract: allow-listeners carries zero active entries (OD-L1-07)
active_listeners=$(grep -cvE '^[[:space:]]*(#|$)' "$HERE/allow-listeners.txt" || true)
[ "$active_listeners" = "0" ] || fail "allow-listeners.txt must have zero active entries (found $active_listeners)"

printf 'HOST_PRE_TO_RB_ZERO_DRIFT=YES\n'
printf 'L1_VERIFY=PASS\n'
exit 0
