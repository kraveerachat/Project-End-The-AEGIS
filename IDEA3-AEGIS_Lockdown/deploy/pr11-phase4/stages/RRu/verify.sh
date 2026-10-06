#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage RRu verify handler (read-only; issues no switch, no restart, no service action and no write).
#
# Re-proves, after apply: `current` is exactly the NEW target; the NEW release passes the existing release guard (root-owned) with the frozen id, source SHA, clean tree, production_detector.py digest, the pinned Core
# runtime digest and the pinned aegis_soc/cli.py digest as a MANIFESTED entry; it is exactly OLD plus cli.py (machine equivalence), its journaled tree digest is unchanged, the OLD release is untouched; the Core and the
# detector are the SAME processes as at preflight; the Recovery and alert sockets are still held by that Core; core.env/credential metadata is identical. Nothing connects to a socket, so no alert exists.
set -euo pipefail

fail() {
  printf 'RRU_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

for var in AEGIS_RRU_WORK_DIR AEGIS_RRU_OLD_RELEASE_ID AEGIS_RRU_NEW_RELEASE_ID AEGIS_RRU_NEW_SOURCE_SHA AEGIS_RRU_DETECTOR_SHA256 AEGIS_RRU_RECOVERY_CORE_SHA256 \
  AEGIS_RRU_DETECTOR_UNIT_SHA256 AEGIS_RRU_RESTORE_CLI_SHA256 AEGIS_PYTHON_BIN; do
  [ -n "${!var:-}" ] || fail "$var required"
done
[ "${AEGIS_RRU_LIVE_AUTHORIZED:-}" = YES ] || fail "AEGIS_RRU_LIVE_AUTHORIZED=YES required"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$AEGIS_PYTHON_BIN" "$HERE/../../p4-rru-upgrade.py" verify --work-dir "$AEGIS_RRU_WORK_DIR" --old-release-id "$AEGIS_RRU_OLD_RELEASE_ID" \
  --new-release-id "$AEGIS_RRU_NEW_RELEASE_ID" --source-sha "$AEGIS_RRU_NEW_SOURCE_SHA" --detector-sha256 "$AEGIS_RRU_DETECTOR_SHA256" \
  --recovery-core-sha256 "$AEGIS_RRU_RECOVERY_CORE_SHA256" --detector-unit-sha256 "$AEGIS_RRU_DETECTOR_UNIT_SHA256" --restore-cli-sha256 "$AEGIS_RRU_RESTORE_CLI_SHA256"
