#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L7u ROLLBACK handler. MUTATING in live mode, failure/abort path only. It acts ONLY on what the apply journal
# says this attempt created or changed, refuses unknown/mismatched state before touching anything, restores the exact prestate atomically
# (current pointer, core.env bytes + metadata, drop-in, tmpfiles, runtime directory, membership, group, the new release), restarts the OLD
# Core only as part of that bounded rollback and verifies it. It never performs CUT or RESTORE and never touches an ESP32.
VERB=ROLLBACK
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
P4_HERE="$(cd "$HERE/../.." && pwd)"
PY="${AEGIS_PYTHON_BIN:-python3}"

fail() { printf 'L7U_%s=FAIL reason=%s\n' "$VERB" "$1" >&2; exit 1; }

[ "${AEGIS_L7U_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_FLAG_REQUIRED
[ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
for v in AEGIS_L7U_WORK_DIR AEGIS_L7U_SOURCE_DIR AEGIS_L7U_OLD_RELEASE_ID AEGIS_L7U_NEW_RELEASE_ID AEGIS_L7U_EXPECTED_MAIN \
  AEGIS_L7U_OPERATOR_USER AEGIS_L7U_OPERATOR_UID AEGIS_L7U_ALERT_SOURCE_UID; do
  [ -n "${!v:-}" ] || fail "${v}_REQUIRED"
done
exec "$PY" "$P4_HERE/p4-l7u-upgrade.py" rollback --old-release-id "$AEGIS_L7U_OLD_RELEASE_ID" --new-release-id "$AEGIS_L7U_NEW_RELEASE_ID" \
  --expected-main "$AEGIS_L7U_EXPECTED_MAIN" --source-dir "$AEGIS_L7U_SOURCE_DIR" --work-dir "$AEGIS_L7U_WORK_DIR" \
  --operator-user "$AEGIS_L7U_OPERATOR_USER" --operator-uid "$AEGIS_L7U_OPERATOR_UID" \
  --alert-source-uid "$AEGIS_L7U_ALERT_SOURCE_UID"
