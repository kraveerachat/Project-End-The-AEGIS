#!/usr/bin/env bash
set -uo pipefail
fail() { printf 'R1I_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
HERE="$(dirname "$0")"; TOOL="$HERE/r1i_input_instrumentation.py"
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
python3 "$TOOL" validate-state "$CURRENT" >/dev/null || fail RULESET_NOT_STAGE_OWNED
# validate-state accepts only the exact owned shape, so the VERIFIED_ lines below were observed
# in the examined state. EXPECTED_/DESIGN_ lines are design intent, not examined here.
printf 'R1I_VERIFY=PASS\n'
printf 'VERIFIED_STATE_EXACT_OWNED_SHAPE=YES\nVERIFIED_HOOKS=input\nVERIFIED_PRIORITY=-10\nVERIFIED_IPV4_ONLY=YES\n'
printf 'VERIFIED_RATE_LIMIT=50/second burst 60 packets\nVERIFIED_NO_VERDICT_STATEMENT=YES\n'
printf 'EXPECTED_TRANSPORT=kernel\nEXPECTED_SYSTEMD_UNIT=EMPTY_OR_ABSENT\n'
printf 'DESIGN_RATE_HEADROOM=100_TOKENS_PER_2_SEC_500_PER_10_SEC\n'
