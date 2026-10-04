#!/usr/bin/env bash
set -uo pipefail
fail() { printf 'R1I_ROLLBACK=FAIL reason=%s\n' "$1" >&2; exit 1; }
ROOT="${AEGIS_P4_FS_ROOT:-}"; WORK="${AEGIS_R1I_WORK_DIR:-}"
[ -n "$WORK" ] && [ -f "$WORK/OWNERSHIP" ] && [ -f "$WORK/POST_STATE" ] || fail OWNERSHIP_RECORD_MISSING
grep -Fqx 'stage_id=R1I' "$WORK/OWNERSHIP" || fail OWNERSHIP_STAGE_MISMATCH
if [ -n "$ROOT" ]; then CURRENT="$ROOT/etc/aegis-idea3-r1i.nft"; [ -f "$CURRENT" ] || fail TABLE_MISSING
else
  [ "${AEGIS_R1I_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
  CURRENT="$WORK/CURRENT_STATE"; nft --stateless list table inet aegis_idea3_r1i > "$CURRENT" || fail TABLE_MISSING
fi
cmp -s "$CURRENT" "$WORK/POST_STATE" || fail FOREIGN_STATE_DRIFT
if [ -n "$ROOT" ]; then rm -f -- "$CURRENT" || fail FIXTURE_ROLLBACK_FAILED
else nft delete table inet aegis_idea3_r1i || fail NFT_DELETE_FAILED
fi
printf 'R1I_ROLLBACK=PASS\nREMOVED_ONLY=inet/aegis_idea3_r1i\nCONTAINMENT_OWNERSHIP_TOUCHED=NO\n'
