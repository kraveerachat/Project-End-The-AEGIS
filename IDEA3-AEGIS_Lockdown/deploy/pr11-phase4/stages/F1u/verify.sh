#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1u verify handler (read-only; issues no switch, no restart, no service action and no write).
#
# Re-proves, after apply: `current` is exactly the NEW target; the NEW release passes the existing release guard (root-owned) with the frozen id, source SHA, clean tree, production_detector.py digest
# and the pinned Core runtime digest carrying ALERT_ACCEPTED, and its journaled tree digest is unchanged; the running Core is a NEW healthy process whose working directory IS the NEW release;
# the Recovery and alert sockets exist with the exact owner/group/mode and are held by that very Core process; the detector is the dependency-cycled D2 (a new MainPID/start/InvocationID, running from the NEW release, the
# same reviewed unit and production_detector.py bytes, disabled, Restart=no, exactly one process) and has not cycled again since apply. Nothing connects to a socket, so no alert exists.
set -euo pipefail

fail() {
  printf 'F1U_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1U_WORK_DIR AEGIS_F1U_OLD_RELEASE_ID AEGIS_F1U_NEW_RELEASE_ID AEGIS_F1U_NEW_SOURCE_SHA AEGIS_F1U_DETECTOR_SHA256 AEGIS_F1U_RECOVERY_CORE_SHA256 \
  AEGIS_F1U_DETECTOR_UNIT_SHA256 AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1U_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1U_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1u-upgrade.py" verify --work-dir "$AEGIS_F1U_WORK_DIR" --old-release-id "$AEGIS_F1U_OLD_RELEASE_ID" \
  --new-release-id "$AEGIS_F1U_NEW_RELEASE_ID" --source-sha "$AEGIS_F1U_NEW_SOURCE_SHA" --detector-sha256 "$AEGIS_F1U_DETECTOR_SHA256" \
  --recovery-core-sha256 "$AEGIS_F1U_RECOVERY_CORE_SHA256" --detector-unit-sha256 "$AEGIS_F1U_DETECTOR_UNIT_SHA256"
