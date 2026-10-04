#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage F1i rollback handler (failure/abort path ONLY; never retries).
#
# Owns ONLY the release this attempt created. If the installer never completed it owns nothing. Otherwise it first proves `current` is still the exact pre-attempt target, that the
# target is a real directory that still passes the release guard root-owned with the exact id, source SHA and detector digest and whose tree digest is unchanged (a drifted or foreign
# release is left for the owner), and only then removes that exact directory. It never removes /opt/aegis-idea3, the releases directory, an old release, `current`, credentials,
# core.env, a unit or Recovery state, and never restarts the Core or touches the detector. It then proves target absent, current unchanged, Core PID/NRestarts unchanged, detector
# absent and the L7 material unchanged. Unknown state fails closed.
set -euo pipefail

fail() {
  printf 'F1I_ROLLBACK=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_F1I_WORK_DIR AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_F1I_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_F1I_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-f1i-install.py" rollback --work-dir "$AEGIS_F1I_WORK_DIR"
