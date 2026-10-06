#!/usr/bin/env bash
# Read-only final claim boundary. A result is valid only when the Core-backed
# verifier proved R1-R8 and the unique close records; operator step files alone
# cannot earn PASS.
set -Eeuo pipefail
fail() { printf 'RECOVERY_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
WORK=${AEGIS_RCVSTAGE_WORK_DIR:-}
RESULT="$WORK/recovery-result.json"
[ -f "$RESULT" ] && [ ! -L "$RESULT" ] || fail RESULT_MISSING
"${AEGIS_PYTHON_BIN:-python3}" -B - "$RESULT" <<'PY' || fail RESULT_NOT_VERIFIED
import json, sys
d=json.load(open(sys.argv[1], encoding="utf-8"))
claims=d.get("claims", {})
gates=d.get("gates", {})
checks=d.get("checks", {})
required={"R1_INCIDENT_CONTEXT","R2_SAFE_ACCESS","R3_ATTACKER_ISOLATION","R4_RESTORE_AUTHORIZATION","R5_PHYSICAL_RESTORE","R6_NETWORK_RECOVERY","R7_SERVICE_RECOVERY","R8_INCIDENT_CLOSURE"}
if d.get("schema") != "aegis.idea3.recovery-result/1" or d.get("result") != "PASS" or set(gates) != required or any(v != "VERIFIED" for v in gates.values()):
    raise SystemExit(1)
if claims != {"F1_REAL_DETECTOR_ACCEPTANCE":"NOT_PROVEN","R1_VERIFIED":"NOT_CLAIMED","LVR_PROVEN":"NO","L8_ACCEPTANCE":"NO","L9_PROVEN":"NO","R1B_RESULT":"FAIL_IMMUTABLE","R1B_RESULT_REWRITTEN":"NO","R1BV_RESULT":"PASS","R1BV_RESULT_REWRITTEN":"NO"}:
    raise SystemExit(1)
if checks.get("RECOVERY_R8_CORE_CLOSE_RECORDS") != "PASS" or checks.get("RECOVERY_AUDIT_INTEGRITY") != "PASS":
    raise SystemExit(1)
PY
printf 'RECOVERY_VERIFY=PASS\nRECOVERY_R2_R8_EXECUTED=YES\nRECOVERY_LIVE=CLOSED_PASS\nR1B_RESULT=FAIL_IMMUTABLE\nR1BV_RESULT=PASS\nLVR_PROVEN=NO\nL8_ACCEPTANCE=NO\nL9_PROVEN=NO\n'
