"""Real Detector Acceptance / R1: read-only observer (baseline + final capture) and fail-closed verifier. Repository foundation only.

Nothing here is deployed, run against Production, or authorised. It OBSERVES an external event and never creates one: it opens no
socket, never writes to ``alert.sock``, never starts/stops/restarts a unit, never writes to the Core store (the audit database is
read through a ``mode=ro`` connection and copied by the SQLite online backup into an IN-MEMORY database; no raw audit copy is ever written to
disk, and only sanitized derived evidence is emitted), and runs only the fixed
read-only ``systemctl show`` / ``journalctl`` argvs below. It holds no secret and reads no ``core.env``.

Provenance model (no new secret, no detector change, no new trust boundary):

* DELIVERY (default creation mode): the Core ingress durably records ``ALERT_ACCEPTED ... action=CREATED`` next to
  ``INCIDENT_BOUND ... action=CREATED``. Successor mode is explicit and separate: one preserved OPEN incident is snapshotted,
  must remain unchanged, the Core must record exactly one new ``ALERT_ACCEPTED ... action=EXISTING``, no new incident or
  current-window INCIDENT_BOUND may appear, and the detector must report ``SENT_EXISTING``. The peer pid must be
  the detector's baseline MainPID and equal the journald ``_PID`` of the detector's own ``alert result=SENT_BOUND`` line. A direct write
  to ``alert.sock`` by any other process fails this.
* SOURCE EVENT: the deployed detector matches message TEXT from ``journalctl -f -o cat``, so a forged journal line could make the real
  detector send a real alert. The verifier therefore reconstructs the detector's own rule (thresholds and regexes are imported from
  ``production_detector``, which is unchanged) from journal entries whose journald-TRUSTED metadata (``_SYSTEMD_UNIT`` + ``_EXE`` +
  ``_TRANSPORT`` for sshd; ``_TRANSPORT=kernel`` for ``AEGIS_NEWCONN``) shows a real source, and it fails closed if ANY rule-matching
  line for the same address came from another source. Underscore fields are stamped by journald from kernel credentials, so an
  unprivileged local writer cannot set them. RESIDUAL (documented, not hidden): root, or code inside the detector or sshd, can still
  forge; that is outside this verifier's threat model.

This module only VERIFIES EVIDENCE. It can never promote a claim: every result carries ``F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`` and
``R1_VERIFIED=NOT_CLAIMED``. Promotion needs a separately reviewed, owner-registered stage (exact-main pin, fresh Authorization/K3,
one-attempt marker, owner runner) that does not exist in this repository. It never claims Recovery R2-R8, LVR, L8 or L9.
"""

from __future__ import annotations

import argparse
import json
import os
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
from .production_detector import (
    _DPT_RE,
    _SRC_RE,
    _SSH_RE,
    FAIL_THRESHOLD,
    LINE_MAX_CHARS,
    SCAN_PORT_THRESHOLD,
    SCAN_TIME_WINDOW,
    SYN_FLOOD_THRESHOLD,
    SYN_FLOOD_WINDOW,
    TIME_WINDOW,
)

SCHEMA_BASELINE = "aegis.idea3.r1-baseline/1"
SCHEMA_FINAL = "aegis.idea3.r1-final/1"
SCHEMA_RESULT = "aegis.idea3.r1-acceptance/1"

CORE_UNIT = "aegis-idea3-core.service"
DETECTOR_UNIT = "aegis-idea3-detector.service"
SHOW_PROPERTIES = ("LoadState", "ActiveState", "SubState", "MainPID", "NRestarts", "Result", "UnitFileState", "Restart")
# Fixed read-only argv builders; nothing is derived from event content.
SYSTEMCTL_SHOW = ("systemctl", "show", "--no-pager")
SKEW_SEC = 2.0
MAX_JOURNAL_LINES = 200000
MAX_SOURCE_EVENTS = 20000
SOURCE_TO_ALERT_MAX_SEC = 10.0  # the completing source event must immediately precede the detector's alert line
JOURNAL_FIELDS = "MESSAGE,_PID,_SYSTEMD_UNIT,_TRANSPORT,_EXE,_UID"
SSH_UNITS = frozenset({"ssh.service", "sshd.service"})
SSH_EXE_DIRS = frozenset({"/usr/bin", "/usr/sbin", "/usr/lib/ssh", "/usr/lib/openssh"})
SSH_EXE_NAMES = frozenset({"sshd", "sshd-session", "sshd-auth"})
SSH_TRANSPORTS = frozenset({"syslog", "journal"})
RULE_SSH, RULE_SCAN, RULE_SYN = "ssh_bruteforce", "port_scan", "syn_flood"

_SERVICE_KEYS = set(SHOW_PROPERTIES)
_ALERT_LINE = re.compile(r"^\[F1-DETECTOR\] alert result=(\S+) detail=(\S+) ip=(\S+)$")
_ACCEPTED = re.compile(r"^uid=(\d+) pid=(\d+) attacker_ip=(\S+) action=(\S+)$")
_BOUND = re.compile(r"^attacker_ip=(\S+) source=(\S+) action=(\S+)$")
_SECRET = re.compile(
    r"scrypt\$|\$scrypt|PRIVATE KEY|BEGIN [A-Z ]*KEY|password\s*[=:]|secret\s*[=:]|token\s*[=:]|MQTT_PASS|core\.env", re.IGNORECASE
)
_TS = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")

#: Printed for EVERY outcome. This module has no path to a positive acceptance claim (see the module docstring).
CLAIMS = {
    "F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO",
    "RECOVERY_R2_R8_EXECUTED": "NO", "LVR_PROVEN": "NO", "L8_ACCEPTANCE": "NO", "L9_PROVEN": "NO",
}


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


_REQUIRED = {"audit_logs": ev._AUDIT_COLUMNS, "incidents": ev._INCIDENT_COLUMNS}


def open_audit_view(source_db: Any) -> sqlite3.Connection:
    """One internally consistent, WAL-aware, point-in-time view of the Core audit store, held ONLY IN MEMORY.

    The source is opened ``mode=ro`` (never written) and copied with the SQLite online backup API into ``:memory:``. No raw copy of the
    Production audit history is ever created on disk: callers derive sanitized evidence from the view and close it. Any problem
    (missing file, not a database, missing columns, backup failure) refuses; nothing is guessed."""
    if not isinstance(source_db, (str, os.PathLike)) or not str(source_db) or not Path(source_db).is_file():
        raise AcceptanceError("STORE_MISSING")
    src = None
    view = None
    try:
        src = sqlite3.connect(f"file:{quote(str(Path(source_db).resolve()))}?mode=ro", uri=True)
        view = sqlite3.connect(":memory:")
        src.backup(view)
        view.row_factory = sqlite3.Row
        view.execute("PRAGMA query_only = ON")
        for table, columns in _REQUIRED.items():
            if not columns <= {row["name"] for row in view.execute(f"PRAGMA table_info({table})")}:
                raise AcceptanceError("STORE_MALFORMED")
        return view
    except AcceptanceError:
        if view is not None:
            view.close()
        raise
    except sqlite3.Error:
        if view is not None:
            view.close()
        raise AcceptanceError("STORE_UNREADABLE") from None
    finally:
        if src is not None:
            src.close()


def _audit_baseline_state(audit_db: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """One internally consistent read-only snapshot of audit maxima + non-closed incidents."""
    view = open_audit_view(audit_db)
    try:
        audit_max = view.execute("SELECT COALESCE(MAX(id), 0) FROM audit_logs").fetchone()[0]
        incident_max = view.execute("SELECT COALESCE(MAX(id), 0) FROM incidents").fetchone()[0]
        rows = view.execute(
            "SELECT id, opened_at, closed_at, state, attacker_ip FROM incidents "
            "WHERE state != 'CLOSED' ORDER BY id"
        ).fetchall()
        preserved = [dict(row) for row in rows]
        marks = {
            "audit_max_id": int(audit_max),
            "incident_max_id": int(incident_max),
            "open_incidents": len(preserved),
        }
        return marks, preserved
    except sqlite3.Error:
        raise AcceptanceError("STORE_MALFORMED") from None
    finally:
        view.close()


def _audit_marks(audit_db: Any) -> dict[str, Any]:
    return _audit_baseline_state(audit_db)[0]


def _preserved_open_incidents(audit_db: Any) -> list[dict[str, Any]]:
    """Sanitized snapshot of pre-existing non-closed incidents for a successor stage."""
    return _audit_baseline_state(audit_db)[1]


def capture_baseline(
    *, audit_db: str, release_id: str, detector_sha256: str, detector_uid: int, now: float,
    services: dict[str, dict[str, str]], allowed_open_incidents: int = 0,
) -> dict[str, Any]:
    """The PRE record. It carries no mode or claim: it is only the boundary the verifier compares against."""
    if not re.fullmatch(r"[0-9a-f]{64}", detector_sha256) or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", release_id):
        raise AcceptanceError("IDENTITY_MALFORMED")
    if type(detector_uid) is not int or detector_uid <= 0:
        raise AcceptanceError("DETECTOR_UID_INVALID")
    if type(allowed_open_incidents) is not int or allowed_open_incidents not in (0, 1):
        raise AcceptanceError("ALLOWED_OPEN_INCIDENTS_INVALID")
    marks, current_open = _audit_baseline_state(audit_db)
    preserved: list[dict[str, Any]] = []
    if marks["open_incidents"] != allowed_open_incidents:
        raise AcceptanceError("PREEXISTING_OPEN_INCIDENT")
    if allowed_open_incidents:
        preserved = current_open
        if len(preserved) != 1 or preserved[0].get("state") != "OPEN":
            raise AcceptanceError("PREEXISTING_OPEN_INCIDENT")
    for unit, key in ((CORE_UNIT, "core"), (DETECTOR_UNIT, "detector")):
        _require_running(services.get(key), "BASELINE_" + key.upper())
    document = {
        "schema": SCHEMA_BASELINE, "started_at": float(now), "release_id": release_id,
        "detector_sha256": detector_sha256, "detector_uid": detector_uid, **marks,
        "core": {k: services["core"][k] for k in SHOW_PROPERTIES},
        "detector": {k: services["detector"][k] for k in SHOW_PROPERTIES},
    }
    if preserved:
        document["preserved_open_incidents"] = preserved
    return document


def _require_running(snap: Any, label: str) -> None:
    if (
        not isinstance(snap, dict) or set(snap) < _SERVICE_KEYS or snap.get("LoadState") != "loaded"
        or snap.get("ActiveState") != "active" or snap.get("SubState") != "running" or snap.get("Result") != "success"
        or not str(snap.get("MainPID", "")).isdigit() or int(snap["MainPID"]) <= 0
    ):
        raise AcceptanceError(f"{label}_NOT_RUNNING")


def read_journal(since_epoch: float, run=subprocess.run) -> dict[str, list[dict[str, Any]]]:
    """One fixed read-only ``journalctl`` argv over the whole journal, immediately reduced (raw messages are never persisted)."""
    argv = ["journalctl", "-o", "json", "--no-pager", f"--output-fields={JOURNAL_FIELDS}", f"--since=@{int(since_epoch) - 1}"]
    try:
        done = run(argv, capture_output=True, text=True, timeout=120, check=False)
    except (OSError, subprocess.SubprocessError):
        raise AcceptanceError("JOURNAL_UNAVAILABLE") from None
    if done.returncode != 0:
        raise AcceptanceError("JOURNAL_FAILED")
    return reduce_journal(done.stdout.splitlines())


def reduce_journal(lines: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Keep ONLY (a) the detector unit's own lines and (b) the rule-relevant facts (address, port, trusted metadata) of lines the
    detector rules would match. Every other journal line (any other unit's text) is dropped unread, so no unrelated or secret-bearing
    message can reach the evidence."""
    if len(lines) > MAX_JOURNAL_LINES:
        raise AcceptanceError("JOURNAL_TOO_LARGE")
    detector: list[dict[str, Any]] = []
    source: list[dict[str, Any]] = []
    for line in lines:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
            at = float(row["__REALTIME_TIMESTAMP"]) / 1_000_000.0
        except (ValueError, KeyError, TypeError):
            raise AcceptanceError("JOURNAL_MALFORMED") from None
        message = row.get("MESSAGE")
        if not isinstance(message, str):
            continue
        meta = {key: "" if row.get(field) is None else str(row.get(field)) for key, field in
                (("pid", "_PID"), ("unit", "_SYSTEMD_UNIT"), ("transport", "_TRANSPORT"), ("exe", "_EXE"))}
        if meta["unit"] == DETECTOR_UNIT:
            detector.append({"message": message[:LINE_MAX_CHARS], **meta, "at": at})
            continue
        text = message[:LINE_MAX_CHARS]
        ssh = _SSH_RE.search(text)
        if ssh:
            source.append({"kind": "ssh", "ip": ssh.group(1), "dpt": "", **meta, "at": at})
        if "AEGIS_NEWCONN" in text:
            src, dpt = _SRC_RE.search(text), _DPT_RE.search(text)
            if src:
                source.append({"kind": "net", "ip": src.group(1), "dpt": dpt.group(1) if dpt else "", **meta, "at": at})
        if len(source) > MAX_SOURCE_EVENTS:
            raise AcceptanceError("SOURCE_EVENTS_TOO_MANY")
    return {"detector": detector, "source": source}


def capture_final(*, now: float, services: dict[str, dict[str, str]], journal: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    return {
        "schema": SCHEMA_FINAL, "ended_at": float(now), "core": services["core"], "detector": services["detector"],
        "journal": journal["detector"], "source_events": journal["source"],
    }


def source_is_trusted(event: dict[str, Any]) -> bool:
    """Journald-trusted metadata only (underscore fields are stamped from kernel credentials, never from the message)."""
    if event["kind"] == "ssh":
        directory, _, name = str(event["exe"]).rpartition("/")
        return (event["unit"] in SSH_UNITS and event["transport"] in SSH_TRANSPORTS and directory in SSH_EXE_DIRS
                and name in SSH_EXE_NAMES)
    return event["kind"] == "net" and event["transport"] == "kernel" and not event["unit"]


def reconstruct_rules(events: list[dict[str, Any]], ip: str, alert_at: float) -> dict[str, float]:
    """``{rule: first completion time}`` for every detector rule the TRUSTED events for ``ip`` satisfy using the detector's EXACT
    thresholds and windows. Only events at or before the detector's own alert line count (no skew widens a window or admits a
    source event that follows the alert), so a rule completed after the alert can never explain it."""
    mine = sorted((e for e in events if e["ip"] == ip and source_is_trusted(e) and e["at"] <= alert_at), key=lambda e: e["at"])
    found: dict[str, float] = {}
    ssh = [e["at"] for e in mine if e["kind"] == "ssh"]
    for i, at in enumerate(ssh):
        if sum(1 for t in ssh[: i + 1] if at - t <= TIME_WINDOW) >= FAIL_THRESHOLD:
            found[RULE_SSH] = at
            break
    net = [e for e in mine if e["kind"] == "net"]
    for i, event in enumerate(net):
        scan = [e for e in net[: i + 1] if event["at"] - e["at"] <= SCAN_TIME_WINDOW]
        if len({e["dpt"] for e in scan if e["dpt"]}) >= SCAN_PORT_THRESHOLD:
            found.setdefault(RULE_SCAN, event["at"])
        syn = [e for e in net[: i + 1] if event["at"] - e["at"] <= SYN_FLOOD_WINDOW]
        if len(syn) >= SYN_FLOOD_THRESHOLD and not ip.startswith("127."):
            found.setdefault(RULE_SYN, event["at"])
    return found


# --------------------------------------------------------------------------- verifier


def _epoch(text: Any) -> float:
    if not isinstance(text, str) or not _TS.match(text):
        raise AcceptanceError("TIMESTAMP_MALFORMED")
    return time.mktime(time.strptime(text, "%Y-%m-%d %H:%M:%S"))


def _fail(code: str) -> dict[str, Any]:
    return {"schema": SCHEMA_RESULT, "result": "FAIL", "reason": code, "claims": dict(CLAIMS)}


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


def verify(baseline: Any, final: Any, audit_db: str) -> dict[str, Any]:
    """Fail-closed verification of ONE new incident against the baseline. Returns a result document; never raises for evidence faults."""
    try:
        return _verify(baseline, final, audit_db)
    except AcceptanceError as error:
        return _fail(error.code)
    except (KeyError, TypeError, ValueError, sqlite3.Error):
        return _fail("EVIDENCE_MALFORMED")


def _verify(baseline: Any, final: Any, audit_db: str) -> dict[str, Any]:
    if not isinstance(baseline, dict) or baseline.get("schema") != SCHEMA_BASELINE:
        raise AcceptanceError("BASELINE_MALFORMED")
    if not isinstance(final, dict) or final.get("schema") != SCHEMA_FINAL or not isinstance(final.get("journal"), list):
        raise AcceptanceError("FINAL_MALFORMED")
    started, ended = baseline["started_at"], final["ended_at"]
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (started, ended)) or ended < started:
        raise AcceptanceError("WINDOW_INVALID")
    _check_services(baseline, final)
    pid, uid = baseline["detector"]["MainPID"], baseline["detector_uid"]

    view = open_audit_view(audit_db)
    try:
        incidents = view.execute("SELECT id, opened_at, closed_at, state, attacker_ip FROM incidents ORDER BY id").fetchall()
        audit = view.execute(
            "SELECT id, timestamp, event_type, details, incident_id FROM audit_logs WHERE id > ? ORDER BY id", (baseline["audit_max_id"],)
        ).fetchall()
        return _verify_view(baseline, final, view, incidents, audit, started, ended, pid, uid)
    finally:
        view.close()


def _verify_view(baseline, final, view, incidents, audit, started, ended, pid, uid) -> dict[str, Any]:
    preserved = baseline.get("preserved_open_incidents")
    successor_existing = preserved is not None

    if not successor_existing:
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
        expected_action = "CREATED"
        expected_detector_result = "SENT_BOUND"
    else:
        # R1B successor mode: R1A's real incident is immutable evidence. The Core's single-open-incident contract
        # MUST return EXISTING for the same attacker; creating/closing/rebinding an incident would rewrite history.
        if not isinstance(preserved, list) or len(preserved) != 1 or not isinstance(preserved[0], dict):
            raise AcceptanceError("PRESERVED_INCIDENT_BASELINE_MALFORMED")
        before = preserved[0]
        if set(before) != {"id", "opened_at", "closed_at", "state", "attacker_ip"} or before.get("state") != "OPEN":
            raise AcceptanceError("PRESERVED_INCIDENT_BASELINE_MALFORMED")
        current = [
            dict(row) for row in incidents
            if row["id"] <= baseline["incident_max_id"] and row["state"] != "CLOSED"
        ]
        if current != [before]:
            raise AcceptanceError("PRESERVED_INCIDENT_CHANGED")
        fresh = [row for row in incidents if row["id"] > baseline["incident_max_id"]]
        if fresh:
            raise AcceptanceError("FRESH_INCIDENT_CREATED_UNEXPECTED")
        incident = dict(current[0])
        opened = _epoch(incident["opened_at"])  # historical R1A time; not required to fall in the R1B window
        expected_action = "EXISTING"
        expected_detector_result = "SENT_EXISTING"

    try:
        ip = str(validate_block_target(incident["attacker_ip"], ()))
    except ContainmentRejected:
        raise AcceptanceError("ATTACKER_IP_INVALID") from None
    if ip != incident["attacker_ip"]:
        raise AcceptanceError("ATTACKER_IP_INVALID")

    # Only audit rows NEWER than the baseline participate in the current delivery proof.
    mine = [row for row in audit if row["incident_id"] == incident["id"]]
    bound = [_BOUND.match(r["details"]) for r in mine if r["event_type"] == "INCIDENT_BOUND"]
    if successor_existing:
        if bound:
            raise AcceptanceError("CURRENT_INCIDENT_BOUND_UNEXPECTED")
    else:
        if len(bound) != 1 or bound[0] is None:
            raise AcceptanceError("INCIDENT_BOUND_MISSING_OR_AMBIGUOUS")
        if bound[0].groups() != (ip, "detector_alert", "CREATED"):
            raise AcceptanceError("INCIDENT_BOUND_MISMATCH")

    accepted = [_ACCEPTED.match(r["details"]) for r in mine if r["event_type"] == "ALERT_ACCEPTED"]
    if len(accepted) != 1 or accepted[0] is None:
        raise AcceptanceError("ALERT_ACCEPTED_MISSING_OR_AMBIGUOUS")
    a_uid, a_pid, a_ip, a_action = accepted[0].groups()
    if a_ip != ip or a_action != expected_action:
        raise AcceptanceError("ALERT_ACCEPTED_MISMATCH")
    if int(a_uid) != uid:
        raise AcceptanceError("ALERT_SOURCE_UID_MISMATCH")
    if a_pid != pid:
        raise AcceptanceError("ALERT_SOURCE_PID_NOT_DETECTOR")
    if any(r["event_type"] in ("ALERT_ACCEPTED", "INCIDENT_BOUND") and r["incident_id"] != incident["id"] for r in audit):
        raise AcceptanceError("UNRELATED_ALERT_ROWS")

    # Historical R1 binding must still be valid in successor mode; in creation mode this proves the just-created binding.
    gate, _ = ev._r1(ev._AuditStore(view), incident["id"])
    if gate["verdict"] != ev.VERIFIED or gate["evidence"].get("detector_alert") != ev.VERIFIED:
        raise AcceptanceError("R1_GATE_NOT_VERIFIED")

    matches = []
    for journal_event in final["journal"]:
        if not isinstance(journal_event, dict) or not all(k in journal_event for k in ("message", "pid", "unit", "at")):
            raise AcceptanceError("JOURNAL_MALFORMED")
        if journal_event["unit"] != DETECTOR_UNIT or not (started - SKEW_SEC <= journal_event["at"] <= ended + SKEW_SEC):
            continue
        line = _ALERT_LINE.match(journal_event["message"])
        if line:
            if journal_event["pid"] != pid:
                raise AcceptanceError("JOURNAL_PID_NOT_DETECTOR")
            matches.append((journal_event, line.groups()))
    if len(matches) != 1:
        raise AcceptanceError("DETECTOR_ALERT_LINE_MISSING_OR_AMBIGUOUS")
    journal_event, (result, _detail, j_ip) = matches[0]
    if result != expected_detector_result:
        raise AcceptanceError("DETECTOR_RESULT_NOT_EXISTING" if successor_existing else "DETECTOR_RESULT_NOT_BOUND")
    if j_ip != ip:
        raise AcceptanceError("DETECTOR_IP_MISMATCH")

    accepted_at = _epoch(next(r["timestamp"] for r in mine if r["event_type"] == "ALERT_ACCEPTED"))
    if not (started - SKEW_SEC <= accepted_at <= ended + SKEW_SEC):
        raise AcceptanceError("ALERT_ACCEPTED_OUTSIDE_WINDOW")
    if journal_event["at"] > accepted_at + SKEW_SEC or journal_event["at"] < started - SKEW_SEC:
        raise AcceptanceError("DETECTOR_EVENT_STALE")

    if successor_existing:
        if accepted_at > journal_event["at"]:
            raise AcceptanceError("AUDIT_ROW_AFTER_DETECTOR_ALERT")
    else:
        bound_at = _epoch(next(r["timestamp"] for r in mine if r["event_type"] == "INCIDENT_BOUND"))
        if max(accepted_at, bound_at, opened) > journal_event["at"]:
            raise AcceptanceError("AUDIT_ROW_AFTER_DETECTOR_ALERT")

    # Prove the trigger was a genuine trusted source event, using the deployed detector's exact thresholds/windows.
    source = final.get("source_events")
    needed = ("kind", "ip", "dpt", "pid", "unit", "transport", "exe", "at")
    if not isinstance(source, list) or len(source) > MAX_SOURCE_EVENTS or not all(
        isinstance(e, dict) and all(k in e for k in needed) and e["kind"] in ("ssh", "net")
        and isinstance(e["at"], (int, float)) and not isinstance(e["at"], bool) for e in source
    ):
        raise AcceptanceError("SOURCE_EVENTS_MALFORMED")
    horizon = started - SOURCE_TO_ALERT_MAX_SEC - TIME_WINDOW
    window = [e for e in source if e["ip"] == ip and horizon <= e["at"] <= ended + SKEW_SEC]
    if any(not source_is_trusted(e) for e in window):
        raise AcceptanceError("UNTRUSTED_SOURCE_LINES_PRESENT")
    rules = reconstruct_rules(window, ip, journal_event["at"])
    if not rules:
        raise AcceptanceError("NO_TRUSTED_SOURCE_EVENT")
    qualifying = sorted(
        done for done in rules.values()
        if 0 <= journal_event["at"] - done <= SOURCE_TO_ALERT_MAX_SEC and done >= started - SKEW_SEC
    )
    if not qualifying:
        raise AcceptanceError("SOURCE_EVENT_NOT_BEFORE_ALERT")

    checks = {
        "R1_EVIDENCE_VERIFIED": "YES",
        "REAL_DETECTOR_CHAIN_VERIFIED": "YES",
        "TRUSTED_SOURCE_EVENT_RECONSTRUCTED": "YES",
        "ALERT_DELIVERED_TO_CORE": "YES",
        "ALERT_SOURCE_UID_VALIDATED": "YES",
        "ALERT_SOURCE_PID_IS_DETECTOR": "YES",
        "INCIDENT_ATTACKER_IPV4_VALID": "YES",
    }
    if successor_existing:
        checks.update({
            "PRESERVED_OPEN_INCIDENT_UNCHANGED": "YES",
            "EXISTING_INCIDENT_REACCEPTED": "YES",
            "HISTORICAL_INCIDENT_BOUND_VERIFIED": "YES",
        })
    else:
        checks.update({
            "OPEN_INCIDENT_CREATED": "YES",
            "INCIDENT_BOUND_AUDIT_PRESENT": "YES",
        })

    return {
        "schema": SCHEMA_RESULT,
        "result": "PASS",
        "reason": "OK",
        "acceptance_mode": "PRESERVED_EXISTING" if successor_existing else "CREATED",
        "incident_id": incident["id"],
        "attacker_ip": ip,
        "reconstructed_rules": sorted(rules),
        "release_id": baseline["release_id"],
        "evidence_times": {
            "incident_opened_at": opened,
            "alert_accepted_at": accepted_at,
            "detector_alert_at": journal_event["at"],
            "source_completed_at": qualifying,
        },
        "checks": checks,
        "claims": dict(CLAIMS),
    }


def render(document: dict[str, Any]) -> str:
    text = json.dumps(document, sort_keys=True, indent=2, ensure_ascii=True)
    if _SECRET.search(text):
        raise AcceptanceError("SECRET_SHAPED_OUTPUT_REFUSED")
    return text + "\n"


def claim_lines(document: dict[str, Any]) -> str:
    checks = document.get("checks", {})
    return "".join(f"{k}={v}\n" for k, v in (*checks.items(), *document["claims"].items()))


# --------------------------------------------------------------------------- CLI (read-only subcommands only)


def _write_new(path: str, text: str) -> None:
    """Sanitized evidence only, never overwriting an existing file."""
    with open(path, "x", encoding="utf-8") as handle:
        handle.write(text)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="r1_acceptance", description="Read-only R1 real-detector acceptance observer/verifier.")
    sub = parser.add_subparsers(dest="command", required=True)
    base = sub.add_parser("baseline")
    base.add_argument("--audit-db", required=True)
    base.add_argument("--release-id", required=True)
    base.add_argument("--detector-sha256", required=True)
    base.add_argument("--detector-uid", type=int, required=True)
    base.add_argument("--allow-baseline-open-incidents", type=int, choices=(0, 1), default=0)
    base.add_argument("--out", required=True)
    fin = sub.add_parser("final")
    fin.add_argument("--baseline", required=True)
    fin.add_argument("--audit-db", required=True)
    fin.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "baseline":
            services = {"core": service_snapshot(CORE_UNIT), "detector": service_snapshot(DETECTOR_UNIT)}
            document = capture_baseline(
                audit_db=args.audit_db, release_id=args.release_id, detector_sha256=args.detector_sha256,
                detector_uid=args.detector_uid, now=time.time(), services=services,
                allowed_open_incidents=args.allow_baseline_open_incidents,
            )
            _write_new(args.out, render(document))
            return 0
        baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
        services = {"core": service_snapshot(CORE_UNIT), "detector": service_snapshot(DETECTOR_UNIT)}
        final = capture_final(now=time.time(), services=services, journal=read_journal(baseline["started_at"]))
        result = verify(baseline, final, args.audit_db)
        _write_new(args.out, render(result))
        sys.stdout.write(claim_lines(result))
        return 0 if result["result"] == "PASS" else 2
    except (AcceptanceError, OSError, ValueError, KeyError) as error:
        sys.stderr.write(f"r1_acceptance: refused: {getattr(error, 'code', type(error).__name__)}\n")
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
