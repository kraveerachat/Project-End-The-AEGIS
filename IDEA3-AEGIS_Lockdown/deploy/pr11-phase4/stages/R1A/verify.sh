#!/usr/bin/env bash
# R1A verify: READ-ONLY inspection of the stored verifier result. It never promotes a project claim; promotion needs a separately reviewed LIVE closeout.
set -uo pipefail
fail() { printf 'R1A_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
WORK="${AEGIS_R1A_WORK_DIR:-}"; PY="${AEGIS_PYTHON_BIN:-python3}"
[ -n "$WORK" ] && [ -f "$WORK/r1-result.json" ] && [ -f "$WORK/R1A-FINAL-RAN" ] || fail RESULT_MISSING
"$PY" - "$WORK/r1-result.json" <<'PYEOF' || fail RESULT_NOT_PASS_OR_CLAIMS_ALTERED
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
need = {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"}
ok = d.get("schema") == "aegis.idea3.r1-acceptance/1" and d.get("result") == "PASS" and d.get("reason") == "OK" \
    and all(d.get("claims", {}).get(k) == v for k, v in need.items()) \
    and d.get("checks", {}).get("REAL_DETECTOR_CHAIN_VERIFIED") == "YES" and d.get("checks", {}).get("R1_EVIDENCE_VERIFIED") == "YES"
sys.exit(0 if ok else 1)
PYEOF
printf 'R1A_VERIFY=PASS\nR1_EVIDENCE_VERIFIED=YES\nREAL_DETECTOR_CHAIN_VERIFIED=YES\n'
printf 'F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN\nR1_VERIFIED=NOT_CLAIMED\nRECOVERY_R1_R8_PROVEN=NO\nR1A_PROMOTION=NOT_AUTOMATIC\n'
