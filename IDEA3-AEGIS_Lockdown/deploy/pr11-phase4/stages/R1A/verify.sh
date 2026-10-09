#!/usr/bin/env bash
# R1A verify: READ-ONLY inspection of the stored verifier result. It adds two BINDINGS on top of the existing fail-closed r1_acceptance verifier (which remains the evidence authority and carries its own causality predicate, described below):
#   1. SOURCE IP: the accepted incident's attacker_ip must EQUAL the pinned expected external source IP (an unrelated genuine IP cannot satisfy R1A);
#   2. MARKER-BOUNDED WINDOW, with the evidence's real granularity stated explicitly:
#      - the completing trusted source event(s) and the detector's own alert carry sub-second journald times and must lie EXACTLY inside [window_start, window_end] (window_start = the instant AFTER the
#        canonical marker exists; window_end = the instant the bounded wait completed);
#      - the Core audit rows (the new incident, INCIDENT_BOUND and ALERT_ACCEPTED) carry WHOLE-SECOND times (the real time rounded DOWN), so no exact sub-second predicate can be proved for them and none is
#        claimed. DIVISION OF RESPONSIBILITY:
#        * r1_acceptance (the evidence authority) enforces the causal ordering for ALL THREE rows: the incident opened_at, INCIDENT_BOUND and ALERT_ACCEPTED stored seconds must not be later than the detector's
#          own alert line time (AUDIT_ROW_AFTER_DETECTOR_ALERT, no tolerance), because the Core writes its rows before it replies and the detector logs its alert line only after the reply. It also requires exactly ONE
#          detector alert line, ONE ALERT_ACCEPTED row and ONE new incident for the same address and the detector's PID.
#        * this script only sees the result's evidence_times (incident_opened_at, alert_accepted_at, detector_alert_at, source_completed_at). As defense in depth it re-checks that the incident and ALERT_ACCEPTED
#          seconds are not later than the detector alert, and that floor(window_start) <= stored <= window_end for those two rows (the floor reflects the 1 s granularity; the ceiling is exact because a stored
#          second never exceeds the real time of the in-window alert that follows the row). There is NO post-deadline grace.
#        * INCIDENT_BOUND's timestamp is NOT in evidence_times, so this script does NOT independently window-check INCIDENT_BOUND; its ordering rests on r1_acceptance.
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
# defense in depth (the r1_acceptance verifier already refuses it): a stored audit second can never be later than the detector's own alert line
if opened > alert or accepted > alert:
    bad("AUDIT_ROW_AFTER_DETECTOR_ALERT")
# audit rows carry whole-second times (granularity: 1 s): lower bound at the marker's second, upper bound exactly the deadline (no delivery grace)
if opened < math.floor(w0) or accepted < math.floor(w0):
    bad("AUDIT_ROW_BEFORE_THE_MARKER")
if opened > w1 or accepted > w1:
    bad("AUDIT_ROW_AFTER_THE_OBSERVATION_DEADLINE")
PYEOF
) || fail "${reason:-RESULT_NOT_PASS_OR_CLAIMS_ALTERED}"
printf 'R1A_VERIFY=PASS\nR1A_SOURCE_IP_BOUND=YES\nR1A_MARKER_BOUNDED_WINDOW=YES\nR1_EVIDENCE_VERIFIED=YES\nREAL_DETECTOR_CHAIN_VERIFIED=YES\n'
printf 'F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN\nR1_VERIFIED=NOT_CLAIMED\nRECOVERY_R1_R8_PROVEN=NO\nR1A_PROMOTION=NOT_AUTOMATIC\n'
