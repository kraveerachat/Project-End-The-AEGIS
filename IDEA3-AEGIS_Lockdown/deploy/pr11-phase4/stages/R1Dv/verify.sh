#!/usr/bin/env bash
# R1Dv verify: READ-ONLY re-check of the stored observer result. The observer (`aegis_soc.historical_validation final`, run from the immutable snapshot) is the evidence authority; this script re-checks the stored document
# and states the claim boundary. It promotes nothing, claims no R1D PASS and never claims R1B PASS.
set -uo pipefail
fail() { printf 'R1DV_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
WORK="${AEGIS_R1DV_WORK_DIR:-}"; PY="${AEGIS_PYTHON_BIN:-python3}"
[ -n "$WORK" ] && [ -f "$WORK/r1dv-result.json" ] && [ -f "$WORK/R1DV-FINAL-RAN" ] || fail RESULT_MISSING
reason=$(env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C "$PY" -B -s - "$WORK/r1dv-result.json" "${AEGIS_R1DV_BINDING_SHA256:-}" <<'PYEOF'
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
c = d.get("checks", {})
expect = {"R1D_MARKER": "PRESENT", "R1DV_R1D_ATTEMPT_AUDIT_COUNT": 1, "R1DV_R1D_DISPOSITION_AUDIT_COUNT": 1, "R1DV_RECOVERY_R8_CLOSE_COUNT": 0, "R1DV_HISTORICAL_INCIDENT_STATE": "CLOSED",
          "PREEXISTING_OPEN_INCIDENT_COUNT": 0, "R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED": "YES", "R1DV_ONE_SHOT_INDEX": "PASS", "R1DV_AUDIT_INTEGRITY": "PASS",
          "R1DV_ORIGINAL_BINDING_IN_DISPOSITION_ROW": "MATCH"}
if not (d.get("schema") == "aegis.idea3.r1dv-result/1" and d.get("result") == "PASS" and d.get("reason") == "OK" and re.fullmatch(r"[0-9a-f]{64}", binding or "")
        and d.get("original_binding_sha256") == binding and d.get("claims") == need and all(c.get(k) == v and type(c.get(k)) is type(v) for k, v in expect.items())):
    bad("RESULT_NOT_PASS_OR_CLAIMS_ALTERED")
PYEOF
) || fail "${reason:-RESULT_NOT_PASS_OR_CLAIMS_ALTERED}"
printf 'R1DV_VERIFY=PASS\nR1DV_IS_R1D_RETRY=NO\nR1DV_READ_ONLY_VALIDATION_ONLY=YES\nR1DV_R1D_SOCKET_CONNECTED=NO\nR1DV_INCIDENT_MUTATED=NO\nR1DV_DISPOSITION_CREATED=NO\n'
printf 'R1DV_R1D_ATTEMPT_AUDIT_COUNT=1\nR1DV_R1D_DISPOSITION_AUDIT_COUNT=1\nR1DV_RECOVERY_R8_CLOSE_COUNT=0\nR1DV_HISTORICAL_INCIDENT_STATE=CLOSED\nPREEXISTING_OPEN_INCIDENT_COUNT=0\n'
printf 'R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED=YES\nR1DV_ONE_SHOT_INDEX=PASS\nR1DV_AUDIT_INTEGRITY=PASS\nR1B_ATTEMPT_CONSUMED=NO\n'
printf 'F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN\nR1_VERIFIED=NOT_CLAIMED\nRECOVERY_R1_R8_PROVEN=NO\nRECOVERY_R2_R8_EXECUTED=NO\nR1D_RESULT_REWRITTEN=NO\n'
