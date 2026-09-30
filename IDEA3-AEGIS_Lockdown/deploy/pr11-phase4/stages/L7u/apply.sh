#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L7u (post-L7 Recovery Core upgrade) APPLY handler. MUTATING in live mode, called once by the owner runner.
# Thin wrapper: every mutation (release install, dedicated group + operator membership, core.env append, systemd drop-in, tmpfiles rule and
# pre-provisioned runtime directory, daemon-reload, atomic current switch, ONE governed Core restart, Recovery-channel verification) lives in
# p4-l7u-upgrade.py so it is exercised by fixture tests. It refuses without root and the live flag, and it has no retry.
# Design: docs/superpowers/specs/2026-10-01-idea3-pr11-phase4-l7u-post-l7-recovery-core-upgrade.md.
VERB=APPLY
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
PY="${AEGIS_PYTHON_BIN:-python3}"

fail() { printf 'L7U_%s=FAIL reason=%s\n' "$VERB" "$1" >&2; exit 1; }

[ "${AEGIS_L7U_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
for v in AEGIS_L7U_WORK_DIR AEGIS_L7U_SOURCE_DIR AEGIS_L7U_OLD_RELEASE_ID AEGIS_L7U_NEW_RELEASE_ID AEGIS_L7U_EXPECTED_MAIN \
  AEGIS_L7U_OPERATOR_USER AEGIS_L7U_OPERATOR_UID; do
  [ -n "${!v:-}" ] || fail "${v}_REQUIRED"
done
exec "$PY" "$P4_HERE/p4-l7u-upgrade.py" apply --old-release-id "$AEGIS_L7U_OLD_RELEASE_ID" --new-release-id "$AEGIS_L7U_NEW_RELEASE_ID" \
  --expected-main "$AEGIS_L7U_EXPECTED_MAIN" --source-dir "$AEGIS_L7U_SOURCE_DIR" --work-dir "$AEGIS_L7U_WORK_DIR" \
  --operator-user "$AEGIS_L7U_OPERATOR_USER" --operator-uid "$AEGIS_L7U_OPERATOR_UID"
