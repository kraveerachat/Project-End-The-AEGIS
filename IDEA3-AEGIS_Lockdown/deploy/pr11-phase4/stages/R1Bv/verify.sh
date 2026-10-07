#!/usr/bin/env bash
# R1Bv verify: READ-ONLY re-check of the stored observer result. The observer (`aegis_soc.r1bv_validation final`, run from the immutable snapshot) is the evidence authority; this script re-checks the stored document
# and states the claim boundary. It promotes nothing, never claims R1B PASS and never rewrites R1B (R1B_RESULT=FAIL_IMMUTABLE).
set -uo pipefail
fail() { printf 'R1BV_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
WORK="${AEGIS_R1BV_WORK_DIR:-}"; PY="${AEGIS_PYTHON_BIN:-python3}"
[ -n "$WORK" ] && [ -f "$WORK/r1bv-result.json" ] && [ -f "$WORK/R1BV-FINAL-RAN" ] || fail RESULT_MISSING
reason=$(env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C "$PY" -B -s - "$WORK/r1bv-result.json" "${AEGIS_R1BV_EXPECTED_SOURCE_IP:-}" <<'PYEOF'
import json, sys

path, source = sys.argv[1:3]


def bad(code):
    print(code)
    sys.exit(1)


try:
    d = json.load(open(path, encoding="utf-8"))
except (OSError, ValueError):
    bad("RESULT_UNREADABLE")
claims = {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO", "RECOVERY_R2_R8_EXECUTED": "NO",
          "R1B_RESULT": "FAIL_IMMUTABLE", "R1B_RESULT_REWRITTEN": "NO", "R1BV_IS_R1B_RETRY": "NO"}
checks = {"R1BV_CANONICAL_MARKER_TIME_AUTHORITY": "PASS", "R1BV_TIMING_CORROBORATION": "PASS", "R1BV_HISTORICAL_BOUND": "PASS", "R1BV_EXPECTED_SOURCE_BOUND": "PASS", "R1BV_REAL_DETECTOR_CHAIN": "PASS",
          "R1BV_NEW_INCIDENT_CREATED_SEMANTICS": "PASS", "R1BV_AUDIT_PROVENANCE": "PASS", "R1BV_AUDIT_INTEGRITY": "PASS", "R1BV_WINDOW_RECORD_ABSENT": "YES"}
b = d.get("bound", {})
if not (d.get("schema") == "aegis.idea3.r1bv-result/1" and d.get("result") == "PASS" and d.get("reason") == "OK" and source and d.get("expected_source_ip") == source
        and d.get("attacker_ip") == source and d.get("claims") == claims and d.get("checks") == checks and b.get("observe_seconds") == 600
        and isinstance(b.get("lower"), float) and isinstance(b.get("deadline"), float) and abs(b["deadline"] - b["lower"] - 600.0) < 1e-6):
    bad("RESULT_NOT_PASS_OR_CLAIMS_ALTERED")
PYEOF
) || fail "${reason:-RESULT_NOT_PASS_OR_CLAIMS_ALTERED}"
printf 'R1BV_VERIFY=PASS\nR1BV_IS_R1B_RETRY=NO\nR1BV_READ_ONLY_VALIDATION_ONLY=YES\nR1BV_NEW_EXTERNAL_EVENT_GENERATED=NO\nR1BV_EXISTING_R1B_EVIDENCE_ONLY=YES\nR1BV_INCIDENT_MUTATED=NO\nR1BV_R1B_MARKER_MUTATED=NO\n'
printf 'R1BV_WINDOW_RECORD_CREATED=NO\nR1BV_WINDOW_RECORD_RECONSTRUCTED=NO\nR1BV_CANONICAL_MARKER_TIME_AUTHORITY=PASS\nR1BV_HISTORICAL_BOUND=PASS\nR1BV_EXPECTED_SOURCE_BOUND=PASS\n'
printf 'R1BV_REAL_DETECTOR_CHAIN=PASS\nR1BV_NEW_INCIDENT_CREATED_SEMANTICS=PASS\nR1BV_AUDIT_PROVENANCE=PASS\nR1BV_AUDIT_INTEGRITY=PASS\n'
printf 'R1B_RESULT=FAIL_IMMUTABLE\nR1B_RESULT_REWRITTEN=NO\nF1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN\nR1_VERIFIED=NOT_CLAIMED\nRECOVERY_R1_R8_PROVEN=NO\nRECOVERY_R2_R8_EXECUTED=NO\n'
