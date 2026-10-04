#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1 (governed F1 production detector unit install + ONE start) apply handler.
#
# Stage order: L7 -> L7u -> L8p -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9. F1 installs the exact pinned detector unit, daemon-reloads, starts the
# detector exactly once (through the reviewed p4-f1-alert-source.py ordered gate) and verifies the detector runtime. It never restarts the Core, edits
# core.env, users or groups, enables the unit, injects an alert, fabricates R1, runs Recovery, sends CUT/RESTORE, or touches the ESP32 or a serial port.
# It proves only F1_PRODUCTION_DEPLOYED=YES and F1_DETECTOR_STARTED=YES; F1_REAL_DETECTOR_ACCEPTANCE stays NOT_PROVEN.
#
# Runs as root (the frozen runner invokes it through sudo). Needs AEGIS_F1_LIVE_AUTHORIZED=YES, which exists nowhere but the frozen runner.
set -euo pipefail

fail() {
  printf 'F1_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1_WORK_DIR AEGIS_F1_ALERT_SOURCE_UID AEGIS_F1_UNIT_SHA256 AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1-deploy.py" apply \
  --work-dir "$AEGIS_F1_WORK_DIR" --uid "$AEGIS_F1_ALERT_SOURCE_UID" --unit-sha256 "$AEGIS_F1_UNIT_SHA256"
