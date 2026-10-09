#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage R1Du (governed post-F1 Core upgrade) apply handler.
#
# Stage order: L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> R1Du -> [R1A, not registered] -> Recovery R2-R8 -> LVR -> L8 -> L9.
# R1Du owns ONLY: install ONE new immutable release (the reviewed installer, once), atomically switch /opt/aegis-idea3/current from the exact frozen OLD target to the exact frozen NEW
# target, restart aegis-idea3-core.service EXACTLY ONCE (the normal governed `systemctl restart`; NO job-mode override), and verify the
# restarted Core runs from the NEW release and the detector lifecycle. The detector (Requires= the Core) is stopped and started again BY systemd inside that one transaction: D1 -> D2, an
# owner-approved R1Du consequence (R1DU_DETECTOR_LIFECYCLE_AMENDMENT=OPTION_A). R1Du never issues a detector command itself, and never edits core.env, credentials, units, drop-ins, tmpfiles, groups, firewall, network, broker, IDEA1/IDEA2,
# runs Recovery, injects an alert, or touches the ESP32. It proves deployment only; F1_REAL_DETECTOR_ACCEPTANCE stays NOT_PROVEN.
#
# Runs as root (the frozen runner invokes it through sudo). Needs AEGIS_R1DU_LIVE_AUTHORIZED=YES, which exists nowhere but the frozen runner.
set -euo pipefail

fail() {
  printf 'R1DU_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_R1DU_WORK_DIR AEGIS_R1DU_OLD_RELEASE_ID AEGIS_R1DU_NEW_RELEASE_ID AEGIS_R1DU_SOURCE_DIR AEGIS_R1DU_NEW_SOURCE_SHA AEGIS_R1DU_DETECTOR_SHA256 \
  AEGIS_R1DU_RECOVERY_CORE_SHA256 AEGIS_R1DU_DETECTOR_UNIT_SHA256 AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_R1DU_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_R1DU_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-r1du-upgrade.py" apply --work-dir "$AEGIS_R1DU_WORK_DIR" --old-release-id "$AEGIS_R1DU_OLD_RELEASE_ID" \
  --new-release-id "$AEGIS_R1DU_NEW_RELEASE_ID" --source-dir "$AEGIS_R1DU_SOURCE_DIR" --source-sha "$AEGIS_R1DU_NEW_SOURCE_SHA" --detector-sha256 "$AEGIS_R1DU_DETECTOR_SHA256" \
  --recovery-core-sha256 "$AEGIS_R1DU_RECOVERY_CORE_SHA256" --detector-unit-sha256 "$AEGIS_R1DU_DETECTOR_UNIT_SHA256"
