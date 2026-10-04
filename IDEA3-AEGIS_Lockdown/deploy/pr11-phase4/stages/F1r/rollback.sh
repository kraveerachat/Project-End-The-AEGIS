#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1r rollback handler (failure/abort path ONLY; never retries).
#
# Acts only on the attempt's own journal: if no switch happened it owns nothing; if the switch happened it first proves `current` still points exactly
# where this attempt left it (anything else fails closed BEFORE any mutation), atomically restores the exact OLD target, then proves the Core PID/restart
# count are unchanged and the detector is absent. It never deletes or alters either release, never restarts the Core, never starts/stops the detector and
# never touches L6c artifacts, IDEA1/IDEA2, Recovery or the ESP32.
set -euo pipefail

fail() {
  printf 'F1R_ROLLBACK=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1R_WORK_DIR AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1R_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1R_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1r-switch.py" rollback --work-dir "$AEGIS_F1R_WORK_DIR"
