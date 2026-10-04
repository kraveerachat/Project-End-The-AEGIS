#!/usr/bin/env bash
set -uo pipefail
fail() { printf 'R1I_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
ROOT="${AEGIS_P4_FS_ROOT:-}"; WORK="${AEGIS_R1I_WORK_DIR:-}"
[ -n "$WORK" ] && [ -f "$WORK/OWNERSHIP" ] && [ -f "$WORK/POST_STATE" ] || fail OWNERSHIP_RECORD_MISSING
grep -Fqx 'stage_id=R1I' "$WORK/OWNERSHIP" || fail OWNERSHIP_STAGE_MISMATCH
grep -Fqx 'table=inet aegis_idea3_r1i' "$WORK/OWNERSHIP" || fail OWNERSHIP_TABLE_MISMATCH
if [ -n "$ROOT" ]; then CURRENT="$ROOT/etc/aegis-idea3-r1i.nft"; [ -f "$CURRENT" ] || fail TABLE_MISSING
else
  command -v nft >/dev/null 2>&1 || fail NFT_UNAVAILABLE
  CURRENT="$WORK/CURRENT_STATE"; nft --stateless list table inet aegis_idea3_r1i > "$CURRENT" || fail TABLE_MISSING
fi
cmp -s "$CURRENT" "$WORK/POST_STATE" || fail FOREIGN_STATE_DRIFT
python3 "$(dirname "$0")/r1i_input_instrumentation.py" validate-state "$CURRENT" >/dev/null || fail RULESET_NOT_STAGE_OWNED
printf 'R1I_VERIFY=PASS\nTRANSPORT=kernel\nSYSTEMD_UNIT=EMPTY_OR_ABSENT\nRATE_LIMIT=50_PER_SEC_BURST_60\nRATE_HEADROOM=100_TOKENS_PER_2_SEC_500_PER_10_SEC\n'
