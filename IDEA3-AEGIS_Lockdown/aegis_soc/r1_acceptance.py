"""Real Detector Acceptance / R1: read-only observer (baseline + final capture) and fail-closed verifier. Repository foundation only.

Nothing here is deployed, run against Production, or authorised. It OBSERVES an external event and never creates one: it opens no
socket, never writes to ``alert.sock``, never starts/stops/restarts a unit, never writes to the Core store (the audit database is
read through a ``mode=ro`` connection and ``sqlite3`` online backup into a caller-chosen snapshot file), and runs only the fixed
read-only ``systemctl show`` / ``journalctl`` argvs below. It holds no secret and reads no ``core.env``.

Provenance model (no new secret, no new trust boundary):

* the production detector prints ``[F1-DETECTOR] alert result=SENT_BOUND ... ip=<IPv4> rule=<rule>`` to ITS OWN journal; journald stamps
  that line with the trusted ``_SYSTEMD_UNIT`` / ``_PID`` fields;
* the Core ingress durably records ``ALERT_ACCEPTED uid=<peer uid> pid=<peer pid> attacker_ip=<IPv4> action=CREATED`` where uid/pid come
  from the kernel (SO_PEERCRED), next to the existing ``INCIDENT_BOUND ... source=detector_alert action=CREATED`` row;
* an acceptance needs all of them to agree on one address and on the detector's baseline MainPID. A direct write to ``alert.sock`` by any
  other process has a different peer pid and no journal line, so it cannot satisfy this. RESIDUAL (documented, not hidden): code running
  INSIDE the detector process (same pid) is indistinguishable from the detector; that is the existing trust boundary.

A PASS here is evidence for the governed live attempt only. It never claims Recovery R2-R8, LVR, L8 or L9.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import recovery_evidence as ev
from .ip_containment import ContainmentRejected, validate_block_target
from .production_detector import RULES

SCHEMA_BASELINE = "aegis.idea3.r1-baseline/1"
SCHEMA_FINAL = "aegis.idea3.r1-final/1"
SCHEMA_RESULT = "aegis.idea3.r1-acceptance/1"

CORE_UNIT = "aegis-idea3-core.service"
DETECTOR_UNIT = "aegis-idea3-detector.service"
SHOW_PROPERTIES = ("LoadState", "ActiveState", "SubState", "MainPID", "NRestarts", "Result", "UnitFileState", "Restart")
# Fixed read-only argv builders; nothing is derived from event content.
SYSTEMCTL_SHOW = ("systemctl", "show", "--no-pager")
SKEW_SEC = 2.0
MAX_JOURNAL_LINES = 10000

_SERVICE_KEYS = set(SHOW_PROPERTIES)
_ALERT_LINE = re.compile(r"^\[F1-DETECTOR\] alert result=(\S+) detail=(\S+) ip=(\S+) rule=(\S+)$")
_ACCEPTED = re.compile(r"^uid=(\d+) pid=(\d+) attacker_ip=(\S+) action=(\S+)$")
_BOUND = re.compile(r"^attacker_ip=(\S+) source=(\S+) action=(\S+)$")
_SYNTHETIC = re.compile(r"synthetic|fixture|simulat|replay|inject|\btest\b", re.IGNORECASE)
_SECRET = re.compile(
    r"scrypt\$|\$scrypt|PRIVATE KEY|BEGIN [A-Z ]*KEY|password\s*[=:]|secret\s*[=:]|token\s*[=:]|MQTT_PASS|core\.env", re.IGNORECASE
)
_TS = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")

#: Claim lines printed for EVERY outcome; only the first two flip, and only on a fully verified live observation.
NEGATIVE_CLAIMS = (
    "RECOVERY_R1_R8_PROVEN=NO", "RECOVERY_R2_R8_EXECUTED=NO", "LVR_PROVEN=NO", "L8_ACCEPTANCE=NO", "L9_PROVEN=NO",
)


class AcceptanceError(RuntimeError):
    """A refusal with a stable, secret-free code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


# --------------------------------------------------------------------------- read-only capture


def service_snapshot(unit: str, run=subprocess.run) -> dict[str, str]:
    """Non-secret unit state via ``systemctl show`` (read-only). Anything unexpected is a refusal, never a guess."""
    if unit not in (CORE_UNIT, DETECTOR_UNIT):
        raise AcceptanceError("UNIT_NOT_ALLOWED")
    argv = [*SYSTEMCTL_SHOW, *(f"--property={name}" for name in SHOW_PROPERTIES), unit]
    try:
        done = run(argv, capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.SubprocessError):
        raise AcceptanceError("SYSTEMCTL_UNAVAILABLE") from None
    if done.returncode != 0:
        raise AcceptanceError("SYSTEMCTL_FAILED")
    values: dict[str, str] = {}
    for line in done.stdout.splitlines():
        key, sep, value = line.partition("=")
        if sep and key in _SERVICE_KEYS:
            values[key] = value
    if set(values) != _SERVICE_KEYS or not values["MainPID"].isdigit() or not values["NRestarts"].isdigit():
        raise AcceptanceError("SYSTEMCTL_MALFORMED")
    return values


def consistent_snapshot(source_db: str, destination: str) -> None:
    """Copy the (possibly WAL-mode, live) audit store with the SQLite online backup API from a ``mode=ro`` source. Never writes the
    source; refuses to overwrite an existing destination. The copy is then self-contained for the immutable verifier open."""
    dest = Path(destination)
    if dest.exists():
        raise AcceptanceError("SNAPSHOT_EXISTS")
    src = None
    out = None
    try:
        src = sqlite3.connect(f"file:{quote(str(Path(source_db).resolve()))}?mode=ro", uri=True)
        out = sqlite3.connect(str(dest))
        src.backup(out)
        out.execute("PRAGMA journal_mode = DELETE")
        out.commit()
    except sqlite3.Error:
        raise AcceptanceError("SNAPSHOT_FAILED") from None
    finally:
        for handle in (out, src):
            if handle is not None:
                handle.close()


def _audit_marks(audit_db: str) -> dict[str, Any]:
    conn = None
    try:
        conn = ev._open_ro(audit_db, {"audit_logs": {"id"}, "incidents": {"id", "state"}})
        audit_max = conn.execute("SELECT COALESCE(MAX(id), 0) FROM audit_logs").fetchone()[0]
        incident_max = conn.execute("SELECT COALESCE(MAX(id), 0) FROM incidents").fetchone()[0]
        open_count = conn.execute("SELECT COUNT(*) FROM incidents WHERE state != 'CLOSED'").fetchone()[0]
    except ev.StoreProblem as problem:
        raise AcceptanceError(f"STORE_{problem.kind}") from None
    except sqlite3.Error:
        raise AcceptanceError("STORE_MALFORMED") from None
    finally:
        if conn is not None:
            conn.close()
    return {"audit_max_id": int(audit_max), "incident_max_id": int(incident_max), "open_incidents": int(open_count)}


def capture_baseline(
    *, audit_snapshot: str, release_id: str, detector_sha256: str, detector_uid: int, mode: str, now: float,
    services: dict[str, dict[str, str]],
) -> dict[str, Any]:
    """The PRE record. ``mode`` is ``live`` (a governed owner-run window) or ``simulate`` (can never claim)."""
    if mode not in ("live", "simulate"):
        raise AcceptanceError("MODE_INVALID")
    if not re.fullmatch(r"[0-9a-f]{64}", detector_sha256) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", release_id):
        raise AcceptanceError("IDENTITY_MALFORMED")
    if type(detector_uid) is not int or detector_uid <= 0:
        raise AcceptanceError("DETECTOR_UID_INVALID")
    marks = _audit_marks(audit_snapshot)
    if marks["open_incidents"] != 0:
        raise AcceptanceError("PREEXISTING_OPEN_INCIDENT")  # a new alert would be EXISTING, not a created incident
    for unit, key in ((CORE_UNIT, "core"), (DETECTOR_UNIT, "detector")):
        _require_running(services.get(key), "BASELINE_" + key.upper())
    return {
        "schema": SCHEMA_BASELINE, "mode": mode, "started_at": float(now), "release_id": release_id,
        "detector_sha256": detector_sha256, "detector_uid": detector_uid, **marks,
        "core": {k: services["core"][k] for k in SHOW_PROPERTIES},
        "detector": {k: services["detector"][k] for k in SHOW_PROPERTIES},
    }


def _require_running(snap: Any, label: str) -> None:
    if (
        not isinstance(snap, dict) or set(snap) < _SERVICE_KEYS or snap.get("LoadState") != "loaded"
        or snap.get("ActiveState") != "active" or snap.get("SubState") != "running" or snap.get("Result") != "success"
        or not str(snap.get("MainPID", "")).isdigit() or int(snap["MainPID"]) <= 0
    ):
        raise AcceptanceError(f"{label}_NOT_RUNNING")


def read_detector_journal(since_epoch: float, run=subprocess.run) -> list[dict[str, str]]:
    """The detector unit's own journal (fixed argv, read-only), reduced to the trusted fields."""
    argv = ["journalctl", "-u", DETECTOR_UNIT, "-o", "json", "--no-pager", "--output-fields=MESSAGE,_PID,_SYSTEMD_UNIT",
            f"--since=@{int(since_epoch) - 1}"]
    try:
        done = run(argv, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.SubprocessError):
        raise AcceptanceError("JOURNAL_UNAVAILABLE") from None
    if done.returncode != 0:
        raise AcceptanceError("JOURNAL_FAILED")
    return parse_journal(done.stdout.splitlines())


def parse_journal(lines: list[str]) -> list[dict[str, str]]:
    if len(lines) > MAX_JOURNAL_LINES:
        raise AcceptanceError("JOURNAL_TOO_LARGE")
    events = []
    for line in lines:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            event = {
                "message": row["MESSAGE"], "pid": str(row["_PID"]), "unit": row["_SYSTEMD_UNIT"],
                "at": float(row["__REALTIME_TIMESTAMP"]) / 1_000_000.0,
            }
        except (ValueError, KeyError, TypeError):
            raise AcceptanceError("JOURNAL_MALFORMED") from None
        if not all(isinstance(event[k], str) for k in ("message", "pid", "unit")):
            raise AcceptanceError("JOURNAL_MALFORMED")
        events.append(event)
    return events


def capture_final(*, now: float, services: dict[str, dict[str, str]], journal: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "schema": SCHEMA_FINAL, "ended_at": float(now), "core": services["core"], "detector": services["detector"],
        "journal": journal,
    }


# --------------------------------------------------------------------------- verifier


def _epoch(text: Any) -> float:
    if not isinstance(text, str) or not _TS.match(text):
        raise AcceptanceError("TIMESTAMP_MALFORMED")
    return time.mktime(time.strptime(text, "%Y-%m-%d %H:%M:%S"))


def _fail(code: str) -> dict[str, Any]:
    return {"schema": SCHEMA_RESULT, "result": "FAIL", "reason": code, "claims": _claims(False)}


def _claims(proven: bool) -> dict[str, str]:
    claims = {"F1_REAL_DETECTOR_ACCEPTANCE": "PROVEN" if proven else "NOT_PROVEN", "R1_VERIFIED": "VERIFIED" if proven else "NOT_CLAIMED"}
    claims.update(line.split("=", 1) for line in NEGATIVE_CLAIMS)
    return claims


def _check_services(baseline: dict[str, Any], final: dict[str, Any]) -> None:
    for key in ("core", "detector"):
        before, after = baseline.get(key), final.get(key)
        if not isinstance(before, dict) or not isinstance(after, dict) or set(after) < _SERVICE_KEYS:
            raise AcceptanceError("SERVICE_RECORD_MALFORMED")
        _require_running(after, "FINAL_" + key.upper())
        if after["MainPID"] != before["MainPID"]:
            raise AcceptanceError(f"{key.upper()}_PID_CHANGED")
        if after["NRestarts"] != before["NRestarts"]:
            raise AcceptanceError(f"{key.upper()}_NRESTARTS_CHANGED")
        for field in ("LoadState", "ActiveState", "SubState", "Result", "UnitFileState", "Restart"):
            if after[field] != before[field]:
                raise AcceptanceError(f"{key.upper()}_STATE_CHANGED")


def verify(baseline: Any, final: Any, audit_snapshot: str) -> dict[str, Any]:
    """Fail-closed verification of ONE new incident against the baseline. Returns a result document; never raises for evidence faults."""
    try:
        return _verify(baseline, final, audit_snapshot)
    except AcceptanceError as error:
        return _fail(error.code)
    except ev.StoreProblem as problem:
        return _fail(f"STORE_{problem.kind}")
    except (KeyError, TypeError, ValueError, sqlite3.Error):
        return _fail("EVIDENCE_MALFORMED")


def _verify(baseline: Any, final: Any, audit_snapshot: str) -> dict[str, Any]:
    if not isinstance(baseline, dict) or baseline.get("schema") != SCHEMA_BASELINE or baseline.get("mode") not in ("live", "simulate"):
        raise AcceptanceError("BASELINE_MALFORMED")
    if not isinstance(final, dict) or final.get("schema") != SCHEMA_FINAL or not isinstance(final.get("journal"), list):
        raise AcceptanceError("FINAL_MALFORMED")
    started, ended = baseline["started_at"], final["ended_at"]
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (started, ended)) or ended < started:
        raise AcceptanceError("WINDOW_INVALID")
    _check_services(baseline, final)
    pid, uid = baseline["detector"]["MainPID"], baseline["detector_uid"]

    conn = ev._open_ro(audit_snapshot, {"audit_logs": ev._AUDIT_COLUMNS, "incidents": ev._INCIDENT_COLUMNS})
    try:
        incidents = conn.execute("SELECT id, opened_at, closed_at, state, attacker_ip FROM incidents ORDER BY id").fetchall()
        audit = conn.execute(
            "SELECT id, timestamp, event_type, details, incident_id FROM audit_logs WHERE id > ? ORDER BY id", (baseline["audit_max_id"],)
        ).fetchall()
    finally:
        conn.close()
    if any(row["id"] <= baseline["incident_max_id"] and row["state"] != "CLOSED" for row in incidents):
        raise AcceptanceError("PREEXISTING_INCIDENT_OPEN")
    fresh = [row for row in incidents if row["id"] > baseline["incident_max_id"]]
    if not fresh:
        raise AcceptanceError("NO_NEW_INCIDENT")
    if len(fresh) > 1:
        raise AcceptanceError("AMBIGUOUS_INCIDENTS")
    incident = dict(fresh[0])
    if incident["state"] != "OPEN":
        raise AcceptanceError("INCIDENT_NOT_OPEN")
    opened = _epoch(incident["opened_at"])
    if not (started - SKEW_SEC <= opened <= ended + SKEW_SEC):
        raise AcceptanceError("INCIDENT_OUTSIDE_WINDOW")
    try:
        ip = str(validate_block_target(incident["attacker_ip"], ()))
    except ContainmentRejected:
        raise AcceptanceError("ATTACKER_IP_INVALID") from None
    if ip != incident["attacker_ip"]:
        raise AcceptanceError("ATTACKER_IP_INVALID")

    mine = [row for row in audit if row["incident_id"] == incident["id"]]
    bound = [_BOUND.match(r["details"]) for r in mine if r["event_type"] == "INCIDENT_BOUND"]
    if len(bound) != 1 or bound[0] is None:
        raise AcceptanceError("INCIDENT_BOUND_MISSING_OR_AMBIGUOUS")
    if bound[0].groups() != (ip, "detector_alert", "CREATED"):
        raise AcceptanceError("INCIDENT_BOUND_MISMATCH")
    accepted = [_ACCEPTED.match(r["details"]) for r in mine if r["event_type"] == "ALERT_ACCEPTED"]
    if len(accepted) != 1 or accepted[0] is None:
        raise AcceptanceError("ALERT_ACCEPTED_MISSING_OR_AMBIGUOUS")
    a_uid, a_pid, a_ip, a_action = accepted[0].groups()
    if a_ip != ip or a_action != "CREATED":
        raise AcceptanceError("ALERT_ACCEPTED_MISMATCH")
    if int(a_uid) != uid:
        raise AcceptanceError("ALERT_SOURCE_UID_MISMATCH")
    if a_pid != pid:
        raise AcceptanceError("ALERT_SOURCE_PID_NOT_DETECTOR")  # direct injection by another process lands here
    # Any other alert row in the window means the evidence is not a single clean detector event.
    if any(r["event_type"] in ("ALERT_ACCEPTED", "INCIDENT_BOUND") and r["incident_id"] != incident["id"] for r in audit):
        raise AcceptanceError("UNRELATED_ALERT_ROWS")

    store = ev._AuditStore(ev._open_ro(audit_snapshot, {"audit_logs": ev._AUDIT_COLUMNS, "incidents": ev._INCIDENT_COLUMNS}))
    try:
        gate, _ = ev._r1(store, incident["id"])
    finally:
        store.close()
    if gate["verdict"] != ev.VERIFIED or gate["evidence"].get("detector_alert") != ev.VERIFIED:
        raise AcceptanceError("R1_GATE_NOT_VERIFIED")

    matches = []
    for event in final["journal"]:
        if not isinstance(event, dict) or not all(k in event for k in ("message", "pid", "unit", "at")):
            raise AcceptanceError("JOURNAL_MALFORMED")
        if event["unit"] != DETECTOR_UNIT:
            continue
        if not (started - SKEW_SEC <= event["at"] <= ended + SKEW_SEC):
            continue
        if _SYNTHETIC.search(event["message"]):
            raise AcceptanceError("SYNTHETIC_MARKER")
        line = _ALERT_LINE.match(event["message"])
        if line:
            if event["pid"] != pid:
                raise AcceptanceError("JOURNAL_PID_NOT_DETECTOR")
            matches.append((event, line.groups()))
    if len(matches) != 1:
        raise AcceptanceError("DETECTOR_ALERT_LINE_MISSING_OR_AMBIGUOUS")
    event, (result, _detail, j_ip, rule) = matches[0]
    if result != "SENT_BOUND":
        raise AcceptanceError("DETECTOR_RESULT_NOT_BOUND")
    if j_ip != ip:
        raise AcceptanceError("DETECTOR_IP_MISMATCH")
    if rule not in RULES:
        raise AcceptanceError("DETECTOR_RULE_UNKNOWN")
    accepted_at = _epoch(next(r["timestamp"] for r in mine if r["event_type"] == "ALERT_ACCEPTED"))
    if event["at"] > accepted_at + SKEW_SEC or event["at"] < started - SKEW_SEC:
        raise AcceptanceError("DETECTOR_EVENT_STALE")

    live = baseline["mode"] == "live"
    document = {
        "schema": SCHEMA_RESULT, "result": "PASS" if live else "SIMULATED_PASS", "reason": "OK" if live else "SIMULATE_MODE_NEVER_CLAIMS",
        "mode": baseline["mode"], "incident_id": incident["id"], "attacker_ip": ip, "rule": rule, "release_id": baseline["release_id"],
        "checks": {
            "REAL_EVENT_OBSERVED": "YES", "DETECTOR_RULE_MATCHED": "YES", "ALERT_DELIVERED_TO_CORE": "YES",
            "ALERT_SOURCE_UID_VALIDATED": "YES", "OPEN_INCIDENT_CREATED": "YES", "INCIDENT_ATTACKER_IPV4_VALID": "YES",
            "INCIDENT_BOUND_AUDIT_PRESENT": "YES",
        },
        "claims": _claims(live),
    }
    return document


def render(document: dict[str, Any]) -> str:
    text = json.dumps(document, sort_keys=True, indent=2, ensure_ascii=True)
    if _SECRET.search(text):
        raise AcceptanceError("SECRET_SHAPED_OUTPUT_REFUSED")
    return text + "\n"


def claim_lines(document: dict[str, Any]) -> str:
    return "".join(f"{k}={v}\n" for k, v in document["claims"].items())


# --------------------------------------------------------------------------- CLI (read-only subcommands only)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="r1_acceptance", description="Read-only R1 real-detector acceptance observer/verifier.")
    sub = parser.add_subparsers(dest="command", required=True)
    base = sub.add_parser("baseline")
    base.add_argument("--audit-db", required=True)
    base.add_argument("--snapshot", required=True, help="destination for the consistent audit copy (must not exist)")
    base.add_argument("--release-id", required=True)
    base.add_argument("--detector-sha256", required=True)
    base.add_argument("--detector-uid", type=int, required=True)
    base.add_argument("--mode", choices=("live", "simulate"), default="simulate")
    base.add_argument("--out", required=True)
    fin = sub.add_parser("final")
    fin.add_argument("--baseline", required=True)
    fin.add_argument("--audit-db", required=True)
    fin.add_argument("--snapshot", required=True)
    fin.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "baseline":
            consistent_snapshot(args.audit_db, args.snapshot)
            services = {"core": service_snapshot(CORE_UNIT), "detector": service_snapshot(DETECTOR_UNIT)}
            document = capture_baseline(
                audit_snapshot=args.snapshot, release_id=args.release_id, detector_sha256=args.detector_sha256,
                detector_uid=args.detector_uid, mode=args.mode, now=time.time(), services=services,
            )
            Path(args.out).write_text(render(document), encoding="utf-8")
            return 0
        baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
        consistent_snapshot(args.audit_db, args.snapshot)
        services = {"core": service_snapshot(CORE_UNIT), "detector": service_snapshot(DETECTOR_UNIT)}
        final = capture_final(now=time.time(), services=services, journal=read_detector_journal(baseline["started_at"]))
        result = verify(baseline, final, args.snapshot)
        Path(args.out).write_text(render(result), encoding="utf-8")
        sys.stdout.write(claim_lines(result))
        return 0 if result["result"] == "PASS" else 2
    except (AcceptanceError, OSError, ValueError, KeyError) as error:
        sys.stderr.write(f"r1_acceptance: refused: {getattr(error, 'code', type(error).__name__)}\n")
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
