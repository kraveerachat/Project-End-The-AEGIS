#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1 rollback handler (failure/abort path ONLY; never retries).
#
# Acts only on the attempt's own journal: stop the detector only if this attempt issued the start, prove the installed unit is still the exact bytes
# and inode this attempt wrote, remove only that unit, daemon-reload, prove the unit is not-found. A pre-existing unit is never removed. The Core,
# core.env, users and groups are never touched. A changed or unidentifiable unit, or any unknown state, fails closed for an owner decision.
set -euo pipefail

fail() {
  printf 'F1_ROLLBACK=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1_WORK_DIR AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1-deploy.py" rollback --work-dir "$AEGIS_F1_WORK_DIR"
