#!/usr/bin/env bash
# R1I apply: ONE attempt, never retried. Creates only `inet aegis_idea3_r1i` through one atomic
# nft batch whose first statement is `create table` (fails with "File exists" instead of merging).
set -uo pipefail

HERE="$(dirname "$0")"
ROOT="${AEGIS_P4_FS_ROOT:-}"
WORK="${AEGIS_R1I_WORK_DIR:-}"
SOURCE="${AEGIS_R1I_SOURCE:-$HERE/r1i.nft.example}"
TOOL="$HERE/r1i_input_instrumentation.py"
TABLE="inet aegis_idea3_r1i"
FIXTURE_TARGET="$ROOT/etc/aegis-idea3-r1i.nft"
JOURNALED=NO  # set only by the attempt that wrote OWNERSHIP, so a refused re-run never rewrites OUTCOME

fail() {
  printf 'R1I_APPLY=FAIL reason=%s%s\n' "$1" "${2:+ RESULT=$2}" >&2
  [ "$JOURNALED" = YES ] && printf 'reason=%s\nresult=%s\n' "$1" "${2:-NO_MUTATION_CLAIMED}" > "$WORK/OUTCOME" 2>/dev/null
  exit 1
}

# Bounded recovery after a successful create whose post-state could not be captured/validated.
# The one attempt stays consumed. The table is removed ONLY when its current state is proven to be
# exactly the owned shape; otherwise nothing is deleted and manual cleanup is required.
recover_or_manual() {
  local reason="$1" snap="$WORK/RECOVERY_STATE"
  if [ -n "$ROOT" ]; then
    if [ -f "$FIXTURE_TARGET" ] && cp "$FIXTURE_TARGET" "$snap" 2>/dev/null \
       && python3 "$TOOL" validate-state "$snap" >/dev/null 2>&1 && rm -f -- "$FIXTURE_TARGET"; then
      fail "$reason" ROLLED_BACK_EXACT_OWNED_STATE
    fi
  else
    if nft --stateless list table inet aegis_idea3_r1i > "$snap" 2>/dev/null \
       && python3 "$TOOL" validate-state "$snap" >/dev/null 2>&1 \
       && nft delete table inet aegis_idea3_r1i 2>/dev/null; then
      fail "$reason" ROLLED_BACK_EXACT_OWNED_STATE
    fi
  fi
  fail "$reason" MANUAL_CLEANUP_REQUIRED
}

[ -n "$WORK" ] && [ -d "$WORK" ] || fail WORK_DIR_REQUIRED
[ -f "$SOURCE" ] && [ ! -L "$SOURCE" ] || fail SOURCE_INVALID
python3 "$TOOL" validate "$SOURCE" >/dev/null || fail SOURCE_INVALID
[ ! -e "$WORK/OWNERSHIP" ] || fail ONE_SHOT_ALREADY_CONSUMED

if [ -z "$ROOT" ]; then
  [ "${AEGIS_R1I_LIVE_AUTHORIZED:-NO}" = YES ] || fail LIVE_AUTHORIZATION_REQUIRED
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
  command -v nft >/dev/null 2>&1 || fail NFT_UNAVAILABLE
  nft list tables >/dev/null 2>&1 || fail NFT_STATE_UNREADABLE
  # Advisory early refusal only; the atomic `create table` below is the authority (no TOCTOU).
  nft list tables | grep -Fqx "table $TABLE" && fail FOREIGN_TABLE_ALREADY_EXISTS
else
  [ ! -e "$FIXTURE_TARGET" ] || fail FOREIGN_FILE_ALREADY_EXISTS
fi

# The ownership record is written before the first nft/file mutation, never overwritten, never retried.
( set -o noclobber; {
  printf 'stage_id=R1I\n'
  printf 'table=%s\n' "$TABLE"
  printf 'pre_state=ABSENT_ASSERTED_BY_ATOMIC_CREATE\n'
  printf 'source_sha256=%s\n' "$(sha256sum "$SOURCE" | awk '{print $1}')"
 } > "$WORK/OWNERSHIP" ) 2>/dev/null || fail OWNERSHIP_JOURNAL_FAILED
JOURNALED=YES

if [ -n "$ROOT" ]; then
  mkdir -p "$ROOT/etc" || fail FIXTURE_APPLY_FAILED
  STAGE_STATE="$WORK/FIXTURE_RENDERED_STATE"
  python3 "$TOOL" render-state "$STAGE_STATE" || fail FIXTURE_APPLY_FAILED
  ( set -o noclobber; cat "$STAGE_STATE" > "$FIXTURE_TARGET" ) 2>/dev/null || fail FIXTURE_APPLY_FAILED
  CAPTURE() { cp "$FIXTURE_TARGET" "$WORK/POST_STATE.tmp"; }
else
  # One atomic transaction. A pre-existing table makes `create table` fail and nothing is merged.
  nft -f "$SOURCE" || fail NFT_ATOMIC_CREATE_REFUSED NO_TABLE_CREATED_BY_THIS_ATTEMPT
  CAPTURE() { nft --stateless list table inet aegis_idea3_r1i > "$WORK/POST_STATE.tmp"; }
fi

CAPTURE 2>/dev/null || recover_or_manual POST_STATE_CAPTURE_FAILED
python3 "$TOOL" validate-state "$WORK/POST_STATE.tmp" >/dev/null 2>&1 || recover_or_manual POST_STATE_VALIDATION_FAILED
mv -T -- "$WORK/POST_STATE.tmp" "$WORK/POST_STATE" 2>/dev/null || recover_or_manual POST_STATE_RECORD_FAILED

printf 'R1I_APPLY=PASS\n'
printf 'R1I_TABLE=%s\n' "$TABLE"
printf 'VERIFIED_STATE_EXACT_OWNED_SHAPE=YES\n'
printf 'VERIFIED_HOOKS=input\n'
printf 'DESIGN_VERDICT_CHANGE=NO\nDESIGN_CONTAINMENT_OWNERSHIP_TOUCHED=NO\n'
if [ -n "$ROOT" ]; then printf 'FIXTURE_ONLY=YES\nPRODUCTION_MUTATION_PERFORMED=NO\n'; else printf 'PRODUCTION_MUTATION_PERFORMED=YES\n'; fi
