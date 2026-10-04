#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1i (governed POST-L7 install of ONE repaired immutable release) apply handler.
#
# Stage order: L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> Recovery R1-R8 -> LVR -> L8 -> L9. F1i creates /opt/aegis-idea3/releases/<frozen release id> by calling the reviewed
# p4-l7-install-release.py exactly once (p4-f1i-install.py journals the exact prestate first and re-proves target/current/Core immediately before the call). It never creates
# /opt/aegis-idea3 or its releases directory (post-L7 Production already has both), never touches `current`, an old release, credentials, core.env, a unit, the Core, the detector,
# the broker, Recovery, IDEA1/IDEA2 or the ESP32. The post-L7 material and the Core unit are PRESERVED state, never required absent (that is the L6c defect F1i exists to avoid).
#
# Runs as root (the frozen runner invokes it through sudo). Needs AEGIS_F1I_LIVE_AUTHORIZED=YES, which exists nowhere but the frozen runner.
set -euo pipefail

fail() {
  printf 'F1I_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1I_WORK_DIR AEGIS_F1I_CURRENT_RELEASE_ID AEGIS_F1I_RELEASE_ID AEGIS_F1I_SOURCE_DIR AEGIS_F1I_SOURCE_SHA AEGIS_F1I_DETECTOR_SHA256 AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1I_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1I_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1i-install.py" apply --work-dir "$AEGIS_F1I_WORK_DIR" --expected-current-release-id "$AEGIS_F1I_CURRENT_RELEASE_ID" \
  --release-id "$AEGIS_F1I_RELEASE_ID" --source-dir "$AEGIS_F1I_SOURCE_DIR" --source-sha "$AEGIS_F1I_SOURCE_SHA" --detector-sha256 "$AEGIS_F1I_DETECTOR_SHA256"
