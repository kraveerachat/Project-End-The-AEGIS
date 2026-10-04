#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1u (governed post-F1 Core upgrade) apply handler.
#
# Stage order: L7 -> L7u -> L8p -> F1i -> F1r -> F1 -> F1u -> [R1A, not registered] -> Recovery R2-R8 -> LVR -> L8 -> L9.
# F1u owns ONLY: install ONE new immutable release (the reviewed installer, once), atomically switch /opt/aegis-idea3/current from the exact frozen OLD target to the exact frozen NEW
# target, restart aegis-idea3-core.service EXACTLY ONCE (the normal governed `systemctl restart`; NO job-mode override), and verify the
# restarted Core runs from the NEW release and the detector lifecycle. The detector (Requires= the Core) is stopped and started again BY systemd inside that one transaction: D1 -> D2, an
# owner-approved F1u consequence (F1U_DETECTOR_LIFECYCLE_AMENDMENT=OPTION_A). F1u never issues a detector command itself, and never edits core.env, credentials, units, drop-ins, tmpfiles, groups, firewall, network, broker, IDEA1/IDEA2,
# runs Recovery, injects an alert, or touches the ESP32. It proves deployment only; F1_REAL_DETECTOR_ACCEPTANCE stays NOT_PROVEN.
#
# Runs as root (the frozen runner invokes it through sudo). Needs AEGIS_F1U_LIVE_AUTHORIZED=YES, which exists nowhere but the frozen runner.
set -euo pipefail

fail() {
  printf 'F1U_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1U_WORK_DIR AEGIS_F1U_OLD_RELEASE_ID AEGIS_F1U_NEW_RELEASE_ID AEGIS_F1U_SOURCE_DIR AEGIS_F1U_NEW_SOURCE_SHA AEGIS_F1U_DETECTOR_SHA256 \
  AEGIS_F1U_RECOVERY_CORE_SHA256 AEGIS_F1U_DETECTOR_UNIT_SHA256 AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1U_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1U_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1u-upgrade.py" apply --work-dir "$AEGIS_F1U_WORK_DIR" --old-release-id "$AEGIS_F1U_OLD_RELEASE_ID" \
  --new-release-id "$AEGIS_F1U_NEW_RELEASE_ID" --source-dir "$AEGIS_F1U_SOURCE_DIR" --source-sha "$AEGIS_F1U_NEW_SOURCE_SHA" --detector-sha256 "$AEGIS_F1U_DETECTOR_SHA256" \
  --recovery-core-sha256 "$AEGIS_F1U_RECOVERY_CORE_SHA256" --detector-unit-sha256 "$AEGIS_F1U_DETECTOR_UNIT_SHA256"
