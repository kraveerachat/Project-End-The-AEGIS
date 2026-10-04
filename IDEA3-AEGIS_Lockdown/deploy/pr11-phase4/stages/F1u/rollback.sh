#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1u rollback handler (failure/abort path ONLY; never retries).
#
# Acts only on the attempt's own journal and fails closed on foreign state BEFORE changing anything: restores `current` NEW -> OLD, restarts the Core at most ONCE (the same restricted
# plain argv) onto the OLD release only if the Core was or may have been restarted, then removes ONLY the release this attempt installed after re-proving its
# journaled tree digest. Before the Core restart the detector D1 is untouched; after it, the detector cycles again as the systemd dependency consequence (D1 -> D2 -> D3) and is accepted only with
# the lifecycle proof. It never issues a detector command, never deletes a foreign or pre-existing release, never touches core.env, credentials, Recovery state, incidents or the
# audit DB, and never runs Recovery. The rolled-back Core runs the OLD current release (not necessarily the pre-F1u process image).
set -euo pipefail

fail() {
  printf 'F1U_ROLLBACK=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1U_WORK_DIR AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1U_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1U_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1u-upgrade.py" rollback --work-dir "$AEGIS_F1U_WORK_DIR"
