#!/usr/bin/env bash
set -uo pipefail

fail() { printf 'R1I_APPLY=FAIL reason=%s\n' "$1" >&2; exit 1; }
ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_R1I_WORK_DIR:-}"
SOURCE="${AEGIS_R1I_SOURCE:-$(dirname "$0")/r1i.nft.example}"
TABLE="inet aegis_idea3_r1i"
[ -n "$WORK" ] && [ -d "$WORK" ] || fail WORK_DIR_REQUIRED
[ -f "$SOURCE" ] && [ ! -L "$SOURCE" ] || fail SOURCE_INVALID
python3 "$(dirname "$0")/r1i_input_instrumentation.py" validate "$SOURCE" >/dev/null || fail SOURCE_INVALID
[ ! -e "$WORK/OWNERSHIP" ] || fail ONE_SHOT_ALREADY_CONSUMED

if [ -z "$ROOT" ]; then
  [ "${AEGIS_R1I_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
  command -v nft >/dev/null 2>&1 || fail NFT_UNAVAILABLE
  nft list tables >/dev/null 2>&1 || fail NFT_STATE_UNREADABLE
  nft list tables | grep -Fqx "table $TABLE" && fail FOREIGN_TABLE_ALREADY_EXISTS
else
  [ ! -e "$ROOT/etc/aegis-idea3-r1i.nft" ] || fail FOREIGN_FILE_ALREADY_EXISTS
fi

# The ownership record is written before the first nft/file mutation. It is
# intentionally separate from the stage registry and is never auto-retried.
( set -o noclobber; {
  printf 'stage_id=R1I\n'
  printf 'table=%s\n' "$TABLE"
  printf 'pre_state=ABSENT\n'
  printf 'source_sha256=%s\n' "$(sha256sum "$SOURCE" | awk '{print $1}')"
 } > "$WORK/OWNERSHIP" ) 2>/dev/null || fail OWNERSHIP_JOURNAL_FAILED

if [ -n "$ROOT" ]; then
  install -D -m 0644 "$SOURCE" "$ROOT/etc/aegis-idea3-r1i.nft" || fail FIXTURE_APPLY_FAILED
  cp "$ROOT/etc/aegis-idea3-r1i.nft" "$WORK/POST_STATE" || fail POST_STATE_CAPTURE_FAILED
else
  nft -f "$SOURCE" || fail NFT_APPLY_FAILED
  nft --stateless list table inet aegis_idea3_r1i > "$WORK/POST_STATE" || fail POST_STATE_CAPTURE_FAILED
fi
printf 'R1I_APPLY=PASS\nR1I_TABLE=%s\nVERDICT_CHANGE=NO\nCONTAINMENT_OWNERSHIP_TOUCHED=NO\n'
printf 'PRODUCTION_MUTATION_PERFORMED=%s\n' "${ROOT:+FIXTURE_ONLY}${ROOT:-YES}"
