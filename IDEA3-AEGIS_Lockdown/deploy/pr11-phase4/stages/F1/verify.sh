#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1 verify handler (read-only; issues no start, stop, reload or write).
#
# Re-proves, after apply: the installed unit is byte-identical to the pin with root:root 0644 and is the inode this attempt wrote; LoadState=loaded,
# ActiveState=active, SubState=running, MainPID>0, Result=success, NRestarts=0, Restart=no, not enabled; the dedicated alert socket is still exactly
# contracted; the Core PID and restart count and core.env bytes are unchanged. Prints F1_VERIFY=PASS only. It never claims real detector acceptance.
set -euo pipefail

fail() {
  printf 'F1_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1_WORK_DIR AEGIS_F1_ALERT_SOURCE_UID AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1-deploy.py" verify --work-dir "$AEGIS_F1_WORK_DIR" --uid "$AEGIS_F1_ALERT_SOURCE_UID"
