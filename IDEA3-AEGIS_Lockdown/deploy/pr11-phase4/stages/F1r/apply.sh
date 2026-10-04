#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1r (governed current-release activation, NO Core restart) apply handler.
#
# Stage order: L7 -> L7u -> L8p -> F1i (repaired-release install) -> F1r -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9.
# F1r owns ONLY the atomic switch of /opt/aegis-idea3/current from the exact frozen OLD release to the exact frozen, ALREADY-INSTALLED NEW release
# (p4-f1r-switch.py: journal OLD, re-read current, temp symlink + atomic rename, exact verification). It installs no release, restarts/reloads/starts/stops
# nothing (the running Core keeps its PID, restart count and cwd), never touches core.env, the detector, Recovery, IDEA1/IDEA2 or the ESP32.
#
# Runs as root (the frozen runner invokes it through sudo). Needs AEGIS_F1R_LIVE_AUTHORIZED=YES, which exists nowhere but the frozen runner.
set -euo pipefail

fail() {
  printf 'F1R_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1R_WORK_DIR AEGIS_F1R_OLD_RELEASE_ID AEGIS_F1R_NEW_RELEASE_ID AEGIS_F1R_NEW_SOURCE_SHA AEGIS_F1R_NEW_DETECTOR_SHA256 AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1R_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1R_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1r-switch.py" apply --work-dir "$AEGIS_F1R_WORK_DIR" --old-release-id "$AEGIS_F1R_OLD_RELEASE_ID" \
  --new-release-id "$AEGIS_F1R_NEW_RELEASE_ID" --new-source-sha "$AEGIS_F1R_NEW_SOURCE_SHA" --new-detector-sha256 "$AEGIS_F1R_NEW_DETECTOR_SHA256"
