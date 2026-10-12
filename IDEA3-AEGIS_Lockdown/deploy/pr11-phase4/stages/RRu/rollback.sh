#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage RRu rollback handler (failure/abort path ONLY; journal-driven and bounded).
#
# Undoes ONLY what the RRu attempt journalled: `current` back to the OLD target and removal of ONLY the release this attempt installed (ownership = a journaled tree digest, re-proved). It restarts nothing and
# never addresses the Core or the detector, so both are proved EXACTLY as at preflight. A foreign pointer/release/process refuses and is left exactly as found. Never a retry.
set -euo pipefail

fail() {
  printf 'RRU_ROLLBACK=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_RRU_WORK_DIR AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_RRU_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_RRU_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-rru-upgrade.py" rollback --work-dir "$AEGIS_RRU_WORK_DIR"
