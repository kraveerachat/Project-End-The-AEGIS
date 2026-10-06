#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage RRu (governed Recovery-PREPARATION release deployment) apply handler.
#
# Stage order: ... -> R1Bv (PASS) -> RRu -> Recovery R2-R8 -> LVR -> L8 -> L9.
# RRu owns ONLY: install ONE new immutable release that also carries aegis_soc/cli.py (the reviewed installer, once) and atomically switch /opt/aegis-idea3/current from the exact frozen OLD target to the
# exact frozen NEW target. It restarts NOTHING (no Core restart, no detector command, no daemon-reload), edits no core.env/credential/unit/firewall/network/broker state, touches no incident, database, R1I,
# R1B/R1Bv evidence or Recovery marker, runs no ISOLATE/RESTORE/CLOSE and never touches the ESP32. It proves RECOVERY_RUNTIME_RELEASE_READY only.
#
# Runs as root (the frozen runner invokes it through sudo). Needs AEGIS_RRU_LIVE_AUTHORIZED=YES, which exists nowhere but the frozen runner.
set -euo pipefail

fail() {
  printf 'RRU_APPLY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_RRU_WORK_DIR AEGIS_RRU_OLD_RELEASE_ID AEGIS_RRU_NEW_RELEASE_ID AEGIS_RRU_SOURCE_DIR AEGIS_RRU_NEW_SOURCE_SHA AEGIS_RRU_DETECTOR_SHA256 \
  AEGIS_RRU_RECOVERY_CORE_SHA256 AEGIS_RRU_DETECTOR_UNIT_SHA256 AEGIS_RRU_RESTORE_CLI_SHA256 AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_RRU_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_RRU_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-rru-upgrade.py" apply --work-dir "$AEGIS_RRU_WORK_DIR" --old-release-id "$AEGIS_RRU_OLD_RELEASE_ID" \
  --new-release-id "$AEGIS_RRU_NEW_RELEASE_ID" --source-dir "$AEGIS_RRU_SOURCE_DIR" --source-sha "$AEGIS_RRU_NEW_SOURCE_SHA" --detector-sha256 "$AEGIS_RRU_DETECTOR_SHA256" \
  --recovery-core-sha256 "$AEGIS_RRU_RECOVERY_CORE_SHA256" --detector-unit-sha256 "$AEGIS_RRU_DETECTOR_UNIT_SHA256" --restore-cli-sha256 "$AEGIS_RRU_RESTORE_CLI_SHA256"
