#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1i verify handler (read-only; issues no install, no removal, no service action and no write).
#
# POST-L7 PRESERVATION verify (deliberately NOT the pre-L7 L6c predicates): the new release exists as a real directory, passes the existing release guard root-owned with the
# frozen release id, source SHA, clean tree and production_detector.py digest and is unchanged since install (tree-state digest); `current` is byte-for-byte the same pointer; the
# Core is the SAME running process (MainPID and NRestarts exactly as snapshotted; its unit is expected to be loaded); credentials and core.env still exist with unchanged metadata
# (values are never read or printed); the detector unit and any standalone detector process are absent.
set -euo pipefail

fail() {
  printf 'F1I_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1I_WORK_DIR AEGIS_F1I_CURRENT_RELEASE_ID AEGIS_F1I_RELEASE_ID AEGIS_F1I_SOURCE_SHA AEGIS_F1I_DETECTOR_SHA256 AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1I_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1I_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1i-install.py" verify --work-dir "$AEGIS_F1I_WORK_DIR" --expected-current-release-id "$AEGIS_F1I_CURRENT_RELEASE_ID" \
  --release-id "$AEGIS_F1I_RELEASE_ID" --source-sha "$AEGIS_F1I_SOURCE_SHA" --detector-sha256 "$AEGIS_F1I_DETECTOR_SHA256"
