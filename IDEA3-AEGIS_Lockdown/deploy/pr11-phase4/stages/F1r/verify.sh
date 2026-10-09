#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1r verify handler (read-only; issues no switch, no service action and no write).
#
# Re-proves, after apply: `current` is exactly the NEW target; the NEW release passes the existing release guard at --expect-owner root with the frozen
# release id, source SHA, clean tree and production_detector.py digest; the OLD release is still intact; the Core is the SAME running process (MainPID,
# NRestarts and, if readable, cwd unchanged); the detector unit/process is still absent. It never claims the running Core moved to the new release.
set -euo pipefail

fail() {
  printf 'F1R_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1R_WORK_DIR AEGIS_F1R_OLD_RELEASE_ID AEGIS_F1R_NEW_RELEASE_ID AEGIS_F1R_NEW_SOURCE_SHA AEGIS_F1R_NEW_DETECTOR_SHA256 AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1R_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1R_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1r-switch.py" verify --work-dir "$AEGIS_F1R_WORK_DIR" --old-release-id "$AEGIS_F1R_OLD_RELEASE_ID" \
  --new-release-id "$AEGIS_F1R_NEW_RELEASE_ID" --new-source-sha "$AEGIS_F1R_NEW_SOURCE_SHA" --new-detector-sha256 "$AEGIS_F1R_NEW_DETECTOR_SHA256"
