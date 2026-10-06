#!/usr/bin/env bash
# R1D verify: READ-ONLY inspection of the stored observer result. The observer (`aegis_soc.historical_disposition final`, run from the immutable snapshot) is the evidence authority; this script only
# re-checks the stored document and states the claim boundary. It never promotes a project claim and never claims R1B PASS.
set -uo pipefail
fail() { printf 'R1D_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
WORK="${AEGIS_R1D_WORK_DIR:-}"; PY="${AEGIS_PYTHON_BIN:-python3}"
[ -n "$WORK" ] && [ -f "$WORK/r1d-result.json" ] && [ -f "$WORK/R1D-FINAL-RAN" ] || fail RESULT_MISSING
reason=$(env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C "$PY" -B -s - "$WORK/r1d-result.json" "${AEGIS_R1D_BINDING_SHA256:-}" <<'PYEOF'
import json, re, sys

path, binding = sys.argv[1:3]


def bad(code):
    print(code)
    sys.exit(1)


try:
    d = json.load(open(path, encoding="utf-8"))
except (OSError, ValueError):
    bad("RESULT_UNREADABLE")
need = {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"}
checks = d.get("checks", {})
if not (d.get("schema") == "aegis.idea3.r1d-result/1" and d.get("result") == "PASS" and d.get("reason") == "OK"
        and re.fullmatch(r"[0-9a-f]{64}", binding or "") and d.get("binding_sha256") == binding
        and all(d.get("claims", {}).get(k) == v for k, v in need.items()) and set(d.get("claims", {})) == set(need)
        and checks.get("PREEXISTING_OPEN_INCIDENT_COUNT") == 0 and checks.get("R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED") == "YES"
        and checks.get("R1B_ATTEMPT_CONSUMED") == "NO" and checks.get("DISPOSITION_AUDIT_ROW") == "ONE" and checks.get("ATTEMPT_ROW") == "ONE" and checks.get("ONE_SHOT_INDEX") == "EXPECTED_DEFINITION" and checks.get("HASH_CHAIN") == "VALID"
        and checks.get("RECOVERY_R8_FABRICATED") == "NO"):
    bad("RESULT_NOT_PASS_OR_CLAIMS_ALTERED")
PYEOF
) || fail "${reason:-RESULT_NOT_PASS_OR_CLAIMS_ALTERED}"
printf 'R1D_VERIFY=PASS\nPREEXISTING_OPEN_INCIDENT_COUNT=0\nR1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED=YES\nR1B_ATTEMPT_CONSUMED=NO\n'
printf 'R1D_HISTORICAL_DISPOSITION_NOT_RECOVERY_R8=YES\nF1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN\nR1_VERIFIED=NOT_CLAIMED\nRECOVERY_R1_R8_PROVEN=NO\nR1D_PROMOTION=NONE\n'
