#!/usr/bin/env bash
# R1A verify: READ-ONLY inspection of the stored verifier result. It adds two BINDINGS on top of the existing fail-closed r1_acceptance verifier (whose acceptance predicates are untouched):
#   1. SOURCE IP: the accepted incident's attacker_ip must EQUAL the pinned expected external source IP (an unrelated genuine IP cannot satisfy R1A);
#   2. MARKER-BOUNDED WINDOW: the completing trusted source event, the detector's alert, ALERT_ACCEPTED and the new incident must ALL fall inside [window_start, window_end], where window_start is the
#      instant the R1A-ATTEMPT-CONSUMED marker was created and window_end is the instant the bounded wait completed. An event before the marker or after the deadline fails.
# It never promotes a project claim; promotion needs a separately reviewed LIVE closeout.
set -uo pipefail
fail() { printf 'R1A_VERIFY=FAIL reason=%s\n' "$1" >&2; exit 1; }
WORK="${AEGIS_R1A_WORK_DIR:-}"; PY="${AEGIS_PYTHON_BIN:-python3}"
[ -n "$WORK" ] && [ -f "$WORK/r1-result.json" ] && [ -f "$WORK/R1A-FINAL-RAN" ] || fail RESULT_MISSING
reason=$(env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C "$PY" -B -s - "$WORK/r1-result.json" "${AEGIS_R1A_EXPECTED_SOURCE_IP:-}" "${AEGIS_R1A_WINDOW_START:-}" "${AEGIS_R1A_WINDOW_END:-}" <<'PYEOF'
import ipaddress, json, math, sys

path, expected, start, end = sys.argv[1:5]


def bad(code):
    print(code)
    sys.exit(1)


try:
    d = json.load(open(path, encoding="utf-8"))
except (OSError, ValueError):
    bad("RESULT_UNREADABLE")
need = {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"}
if not (d.get("schema") == "aegis.idea3.r1-acceptance/1" and d.get("result") == "PASS" and d.get("reason") == "OK"
        and all(d.get("claims", {}).get(k) == v for k, v in need.items())
        and d.get("checks", {}).get("REAL_DETECTOR_CHAIN_VERIFIED") == "YES" and d.get("checks", {}).get("R1_EVIDENCE_VERIFIED") == "YES"):
    bad("RESULT_NOT_PASS_OR_CLAIMS_ALTERED")

# 1. source IP binding: the pin must be a real external-capable IPv4 address and the accepted incident must be exactly that address
try:
    pinned = ipaddress.IPv4Address(expected)
except ValueError:
    bad("EXPECTED_SOURCE_IP_INVALID")
if pinned.is_unspecified or pinned.is_loopback or pinned.is_link_local or pinned.is_multicast or pinned.is_reserved or str(pinned) == "255.255.255.255":
    bad("EXPECTED_SOURCE_IP_NOT_EXTERNAL")
if d.get("attacker_ip") != str(pinned):
    bad("ATTACKER_IP_NOT_THE_EXPECTED_SOURCE")


# 2. marker-bounded window
def num(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        bad("TIME_MALFORMED")
    return float(value)


try:
    w0, w1 = float(start), float(end)
except ValueError:
    bad("WINDOW_MISSING")
if not (math.isfinite(w0) and math.isfinite(w1)) or w0 <= 0 or w1 <= w0 or w1 - w0 > 1_000_000:
    bad("WINDOW_INVALID")
t = d.get("evidence_times")
if not isinstance(t, dict) or not isinstance(t.get("source_completed_at"), list) or not t["source_completed_at"]:
    bad("EVIDENCE_TIMES_MISSING")
sources = [num(v) for v in t["source_completed_at"]]
alert, opened, accepted = num(t.get("detector_alert_at")), num(t.get("incident_opened_at")), num(t.get("alert_accepted_at"))
# the trusted completing source event(s) and the detector's alert carry sub-second journal times: they must lie EXACTLY inside [start, end]
if any(v < w0 for v in sources) or alert < w0:
    bad("EVENT_BEFORE_THE_MARKER")
if any(v > w1 for v in sources) or alert > w1:
    bad("EVENT_AFTER_THE_OBSERVATION_DEADLINE")
# audit rows carry whole-second times: floor at the marker's second, and allow the Core's delivery latency (the verifier's own 2 s skew) after the deadline
if opened < math.floor(w0) or accepted < math.floor(w0):
    bad("AUDIT_ROW_BEFORE_THE_MARKER")
if opened > w1 + 2.0 or accepted > w1 + 2.0:
    bad("AUDIT_ROW_AFTER_THE_OBSERVATION_DEADLINE")
PYEOF
) || fail "${reason:-RESULT_NOT_PASS_OR_CLAIMS_ALTERED}"
printf 'R1A_VERIFY=PASS\nR1A_SOURCE_IP_BOUND=YES\nR1A_MARKER_BOUNDED_WINDOW=YES\nR1_EVIDENCE_VERIFIED=YES\nREAL_DETECTOR_CHAIN_VERIFIED=YES\n'
printf 'F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN\nR1_VERIFIED=NOT_CLAIMED\nRECOVERY_R1_R8_PROVEN=NO\nR1A_PROMOTION=NOT_AUTOMATIC\n'
