"""READ-ONLY Recovery R1-R8 evidence checker (repository foundation; nothing here is deployed or run against Production).

Inspects a stored snapshot and emits deterministic, machine-readable, secret-safe evidence for gates R1-R8 with an
explicit ``VERIFIED`` / ``BLOCKED`` / ``NOT_PROVEN`` verdict per gate:

* the Core audit database and the Protocol-v1 command store are opened ``mode=ro&immutable=1`` with ``PRAGMA query_only``
  (a missing file is never created, no sidecar file is ever created, nothing is ever written; a store with ANY non-empty WAL
  or rollback-journal sidecar is refused as NOT_PROVEN rather than read inconsistently);
* R2/R6/R7 probe results, the live containment read-back and the device status are NOT probed here: they are read from an
  optional, strictly allow-listed observation snapshot with its own timestamps and incident binding, and anything absent,
  stale, unbound or malformed is ``NOT_PROVEN``/``BLOCKED`` rather than assumed;
* gate truth is taken from the Core authorities, not re-invented: ``recovery_protocol`` (gate names / closure set), the
  Core's R3/R5 audit row grammar, ``ip_containment.validate_block_target`` (R1 address rules) and
  ``local_restore.restore_evidence_ladder`` (the reviewed RESTORE evidence ladder);
* it never publishes, never contacts a network, never calls the containment helper / nft, and never touches a device or
  serial port. Nothing in it can read the D4 credential: ``RESTORE_REQUESTED`` rows are read for ``id`` / ``timestamp``
  only, never their details, and every emitted field is drawn from a fixed vocabulary.

A VERIFIED result here is evidence about stored state only. It is not physical evidence and not a Production claim.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote

# Importing the Core modules constructs the rotating audit log handler, which would create a file. This checker must not
# write anything, so point it at the null device unless the configuration was already loaded by the embedding process.
if "aegis_soc.config" not in sys.modules:
    os.environ["AEGIS_LOG_PATH"] = os.devnull

from . import local_restore as lr  # noqa: E402
from . import recovery_protocol as rp  # noqa: E402
from .ip_containment import ContainmentRejected, validate_block_target  # noqa: E402
from .recovery_core import _PUBLISHED_RE, _R3_RE  # noqa: E402

SCHEMA = "aegis.idea3.recovery-evidence/1"
OBSERVATION_VERSION = 1
DEFAULT_MAX_AGE_SEC = 300.0
FUTURE_SKEW_SEC = 60.0
MAX_OBSERVATION_BYTES = 65536

VERIFIED = "VERIFIED"
BLOCKED = "BLOCKED"
NOT_PROVEN = "NOT_PROVEN"
VERDICTS = (VERIFIED, BLOCKED, NOT_PROVEN)

R7_CHECKS = ("core_db", "mqtt", "device", "uplink_normal", "dispatch", "web")

_BOUND_RE = re.compile(r"^attacker_ip=(\S+) source=(\S+)")
_MSG_ID_RE = re.compile(r"^[0-9a-f]{32}$")
# Defence in depth: refuse to emit anything that looks like a credential, whatever produced it.
_SECRET_RE = re.compile(r"scrypt\$|\$scrypt|PRIVATE KEY|BEGIN [A-Z ]*KEY|password\s*[=:]|secret\s*[=:]|token\s*[=:]", re.I)

_AUDIT_COLUMNS = {"id", "timestamp", "level", "event_type", "details", "incident_id"}
_INCIDENT_COLUMNS = {"id", "opened_at", "closed_at", "state", "attacker_ip", "summary"}
_PROTOCOL_COLUMNS = {"msg_id", "device_id", "seq", "action", "state", "published_at", "ack_result", "status_correlated"}


class EvidenceError(RuntimeError):
    """A refusal with a stable, secret-free code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class StoreProblem(Exception):
    """A store that cannot be used: ``MISSING`` (absent) or ``MALFORMED`` (present but unusable)."""

    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


# --------------------------------------------------------------------------- read-only stores


def _open_ro(path: Any, required: dict[str, set[str]]) -> sqlite3.Connection:
    if not isinstance(path, (str, os.PathLike)) or not str(path):
        raise StoreProblem("MISSING")
    target = Path(path)
    if not target.is_file():
        raise StoreProblem("MISSING")
    # ``immutable=1`` makes SQLite skip locking and never create -wal/-shm/-journal sidecars (a plain mode=ro open of a
    # WAL store would), which also lets it read from a read-only directory. That is only sound when nothing is pending:
    # an immutable open IGNORES a hot rollback journal and an un-checkpointed WAL, and would read uncommitted or
    # inconsistent pages as evidence. Any NON-EMPTY sidecar is therefore refused BEFORE SQLite is opened; analyse a
    # quiesced store or a consistently copied snapshot. Zero-byte sidecars hold nothing and are allowed.
    for suffix, kind in (("-wal", "WAL_PENDING"), ("-journal", "JOURNAL_PENDING")):
        sidecar = Path(f"{target}{suffix}")
        try:
            if sidecar.exists() and sidecar.stat().st_size > 0:
                raise StoreProblem(kind)
        except OSError:
            raise StoreProblem("MALFORMED") from None
    conn = None
    try:
        conn = sqlite3.connect(f"file:{quote(str(target.resolve()))}?mode=ro&immutable=1", uri=True)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only = ON")
        for table, columns in required.items():
            found = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
            if not columns <= found:
                raise StoreProblem("MALFORMED")
        return conn
    except StoreProblem:
        conn.close()
        raise
    except sqlite3.Error:
        if conn is not None:
            conn.close()
        raise StoreProblem("MALFORMED") from None


class _AuditStore:
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    def close(self) -> None:
        self._conn.close()

    def incidents(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, opened_at, closed_at, state, attacker_ip FROM incidents ORDER BY id"
        ).fetchall()
        return [dict(row) for row in rows]

    def events(self, incident_id: int, event_types: tuple[str, ...], limit: int) -> list[dict[str, Any]]:
        marks = ",".join("?" * len(event_types))
        rows = self._conn.execute(
            f"SELECT id, timestamp, event_type, details FROM audit_logs WHERE incident_id = ? "
            f"AND event_type IN ({marks}) ORDER BY id DESC LIMIT ?",
            (incident_id, *event_types, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def restore_requests(self, incident_id: int) -> list[dict[str, Any]]:
        # id/timestamp only: the details column of a D4 row is never selected.
        rows = self._conn.execute(
            "SELECT id, timestamp FROM audit_logs WHERE event_type = 'RESTORE_REQUESTED' AND incident_id = ? ORDER BY id",
            (incident_id,),
        ).fetchall()
        return [dict(row) for row in rows]


class _ProtocolStore:
    def __init__(self, conn: sqlite3.Connection):
        self._conn = conn

    def close(self) -> None:
        self._conn.close()

    def command(self, msg_id: str) -> dict[str, Any] | None:
        row = self._conn.execute("SELECT * FROM protocol_commands WHERE msg_id = ?", (msg_id,)).fetchone()
        return dict(row) if row else None


class _LadderShim:
    """The two attributes ``restore_evidence_ladder`` reads from a supervisor, backed by the read-only store."""

    def __init__(self, store: _ProtocolStore, physical: dict[str, Any] | None):
        self.protocol = type("Context", (), {"store": store})()
        self.awaiting_physical_confirmation = physical


# --------------------------------------------------------------------------- observation snapshot


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


def _exact(section: Any, keys: set[str]) -> dict[str, Any]:
    if not isinstance(section, dict) or set(section) != keys or not _is_number(section.get("observed_at")):
        raise StoreProblem("MALFORMED")
    return section


def load_observations(path: Any) -> dict[str, Any]:
    """Strict allow-list parse. Unknown keys, wrong types or an oversized file are MALFORMED; nothing is passed through."""
    target = Path(path)
    if not target.is_file():
        raise StoreProblem("MISSING")
    try:
        if target.stat().st_size > MAX_OBSERVATION_BYTES:
            raise StoreProblem("MALFORMED")
        body = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        raise StoreProblem("MALFORMED") from None
    allowed = {"v", "incident_id", "r2", "containment", "r6", "r7", "device"}
    if not isinstance(body, dict) or not set(body) <= allowed or body.get("v") != OBSERVATION_VERSION:
        raise StoreProblem("MALFORMED")
    incident_id = body.get("incident_id")
    if type(incident_id) is not int:
        raise StoreProblem("MALFORMED")
    if "r2" in body:
        section = _exact(body["r2"], {"observed_at", "configured", "ok"})
        if type(section["configured"]) is not bool or type(section["ok"]) is not bool:
            raise StoreProblem("MALFORMED")
    if "containment" in body:
        section = _exact(body["containment"], {"observed_at", "present"})
        if type(section["present"]) is not bool:
            raise StoreProblem("MALFORMED")
    if "r6" in body:
        section = _exact(body["r6"], {"observed_at", "configured", "results"})
        results = section["results"]
        if type(section["configured"]) is not bool or not isinstance(results, list) or len(results) > 32:
            raise StoreProblem("MALFORMED")
        if any(type(item) is not bool for item in results):
            raise StoreProblem("MALFORMED")
    if "r7" in body:
        section = _exact(body["r7"], {"observed_at", "checks"})
        checks = section["checks"]
        if not isinstance(checks, dict) or not set(checks) <= set(R7_CHECKS):
            raise StoreProblem("MALFORMED")
        if any(value is not None and type(value) is not bool for value in checks.values()):
            raise StoreProblem("MALFORMED")
    if "device" in body:
        section = _exact(body["device"], {"observed_at", "state", "correlated_msg_id"})
        msg_id = section["correlated_msg_id"]
        if section["state"] not in {"NORMAL", "LOCKDOWN"}:
            raise StoreProblem("MALFORMED")
        if msg_id is not None and not (isinstance(msg_id, str) and _MSG_ID_RE.match(msg_id)):
            raise StoreProblem("MALFORMED")
    return body


# --------------------------------------------------------------------------- gate helpers


def _gate(gate: str, verdict: str, reason: str, summary: str, evidence: dict[str, Any] | None = None) -> dict[str, Any]:
    assert gate in rp.GATES and verdict in VERDICTS
    return {"gate": gate, "verdict": verdict, "reason": reason, "summary": summary, "evidence": evidence or {}}


def _prereq(gate: str, needs: tuple[str, ...], gates: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    missing = [name for name in needs if gates[name]["verdict"] != VERIFIED]
    if not missing:
        return None
    return _gate(
        gate, BLOCKED, "PREREQUISITE_NOT_VERIFIED", "A prerequisite gate is not VERIFIED", {"unverified": missing},
    )


class _Context:
    def __init__(self, now: float, max_age: float, observations: dict[str, Any] | None, obs_problem: str | None):
        self.now = now
        self.max_age = max_age
        self.observations = observations
        self.obs_problem = obs_problem

    def section(self, name: str, incident_id: int) -> tuple[dict[str, Any] | None, tuple[str, str] | None]:
        """The named observation or ``(verdict, reason)`` explaining why it cannot be used."""
        if self.obs_problem == "MALFORMED":
            return None, (BLOCKED, "OBSERVATIONS_MALFORMED")
        if self.obs_problem == "MISSING":
            return None, (NOT_PROVEN, "OBSERVATIONS_MISSING")
        if self.observations is None:
            return None, (NOT_PROVEN, "NO_OBSERVATIONS")
        section = self.observations.get(name)
        if section is None:
            return None, (NOT_PROVEN, "OBSERVATION_SECTION_MISSING")
        if self.observations["incident_id"] != incident_id:
            return None, (NOT_PROVEN, "OBSERVATION_INCIDENT_MISMATCH")
        age = self.now - float(section["observed_at"])
        if age < -FUTURE_SKEW_SEC:
            return None, (NOT_PROVEN, "OBSERVATION_FROM_THE_FUTURE")
        if age > self.max_age:
            return None, (NOT_PROVEN, "OBSERVATION_STALE")
        return section, None


# --------------------------------------------------------------------------- R1


def _select_incident(
    incidents: list[dict[str, Any]], incident_id: int | None,
) -> tuple[dict[str, Any] | None, str | None, str | None]:
    """``(incident, verdict, reason)``; incident None means R1 cannot be VERIFIED for the reported reason."""
    open_rows = [row for row in incidents if row["state"] != "CLOSED"]
    if incident_id is not None:
        subject = next((row for row in incidents if row["id"] == incident_id), None)
        if subject is None:
            return None, NOT_PROVEN, "INCIDENT_NOT_FOUND"
        others_open = [row for row in open_rows if row["id"] != incident_id]
        if others_open:
            return subject, BLOCKED, "CONFLICTING_OPEN_INCIDENTS"
        return subject, None, None
    if not open_rows:
        return None, NOT_PROVEN, "NO_OPEN_INCIDENT"
    if len(open_rows) > 1:
        return None, BLOCKED, "CONFLICTING_OPEN_INCIDENTS"
    return open_rows[0], None, None


def _r1(audit: _AuditStore, incident_id: int | None) -> tuple[dict[str, Any], dict[str, Any] | None]:
    incidents = audit.incidents()
    incident, verdict, reason = _select_incident(incidents, incident_id)
    if verdict is not None:
        count = sum(1 for row in incidents if row["state"] != "CLOSED")
        summary = "No single, unambiguous incident is bound"
        return _gate(rp.R1, verdict, reason, summary, {"open_incidents": count}), None
    assert incident is not None
    ip = incident["attacker_ip"]
    base = {"incident_id": incident["id"], "state": incident["state"]}
    if ip is None or ip == "":
        return _gate(rp.R1, NOT_PROVEN, "ATTACKER_IP_MISSING", "The incident has no attacker_ip", base), incident
    try:
        address = str(validate_block_target(ip, ()))
    except ContainmentRejected as error:
        evidence = {**base, "ip_rejection": error.reason_code}
        return _gate(rp.R1, BLOCKED, "ATTACKER_IP_INVALID", "The bound attacker_ip is not a valid attacker address", evidence), incident
    if address != ip:
        return _gate(rp.R1, BLOCKED, "ATTACKER_IP_INVALID", "The bound attacker_ip is not canonical", base), incident
    rows = audit.events(incident["id"], ("INCIDENT_BOUND",), 50)
    parsed = [_BOUND_RE.match(row["details"]) for row in rows]
    detector = [m for m in parsed if m and m.group(2) == "detector_alert"]
    if any(m.group(1) != ip for m in detector):
        evidence = {**base, "attacker_ip": ip, "detector_alert": BLOCKED}
        return _gate(rp.R1, BLOCKED, "DETECTOR_ALERT_IP_CONFLICT", "A detector-alert row names a different address", evidence), incident
    relation = VERIFIED if detector else NOT_PROVEN
    evidence = {**base, "attacker_ip": ip, "detector_alert": relation}
    summary = f"Bound to incident #{incident['id']}"
    return _gate(rp.R1, VERIFIED, f"DETECTOR_ALERT_{relation}", summary, evidence), incident


# --------------------------------------------------------------------------- R2 .. R8


def _r2(ctx: _Context, incident: dict[str, Any]) -> dict[str, Any]:
    section, problem = ctx.section("r2", incident["id"])
    if problem:
        return _gate(rp.R2, problem[0], problem[1], "No usable management-access probe evidence")
    if not section["configured"]:
        return _gate(rp.R2, NOT_PROVEN, "PROBE_NOT_CONFIGURED", "No management probe target was configured")
    if not section["ok"]:
        return _gate(rp.R2, BLOCKED, "MANAGEMENT_PROBE_FAILED", "The management access probe failed")
    return _gate(rp.R2, VERIFIED, "MANAGEMENT_PROBE_PASSED", "Fresh management access probe passed")


def _r3(audit: _AuditStore, ctx: _Context, incident: dict[str, Any]) -> dict[str, Any]:
    rows = audit.events(incident["id"], ("RECOVERY_R3_RESULT",), 1)
    if not rows:
        return _gate(rp.R3, NOT_PROVEN, "ISOLATION_NOT_REQUESTED", "Isolation has not been recorded for this incident")
    match = _R3_RE.match(rows[0]["details"])
    if not match:
        return _gate(rp.R3, BLOCKED, "ISOLATION_RECORD_UNREADABLE", "The latest isolation record is unreadable")
    result, ip = match.groups()
    if ip != incident["attacker_ip"]:
        return _gate(rp.R3, BLOCKED, "ISOLATION_IP_MISMATCH", "The isolation record does not match the bound attacker_ip")
    if result != "VERIFIED":
        return _gate(rp.R3, BLOCKED, "ISOLATION_NOT_VERIFIED", "The latest isolation attempt was not verified")
    live = NOT_PROVEN
    section, problem = ctx.section("containment", incident["id"])
    if section is not None:
        live = VERIFIED if section["present"] else BLOCKED
    evidence = {"attacker_ip": ip, "record_id": rows[0]["id"], "live_readback": live}
    if live == BLOCKED and incident["state"] != "CLOSED":
        return _gate(rp.R3, BLOCKED, "NO_LONGER_CONTAINED", "The attacker IP is no longer in the containment set", evidence)
    return _gate(rp.R3, VERIFIED, f"ISOLATION_VERIFIED_LIVE_{live}", "Isolation recorded as verified (block plus read-back)", evidence)


def _r3_precedes(audit: _AuditStore, incident_id: int, restore_row_id: int) -> bool:
    for row in audit.events(incident_id, ("RECOVERY_R3_RESULT",), 200):
        match = _R3_RE.match(row["details"])
        if match and match.group(1) == "VERIFIED" and row["id"] < restore_row_id:
            return True
    return False


def _r4(audit: _AuditStore, incident: dict[str, Any]) -> dict[str, Any]:
    requests = audit.restore_requests(incident["id"])
    if not requests:
        return _gate(rp.R4, NOT_PROVEN, "AWAITING_D4_RESTORE_REQUEST", "No durable RESTORE_REQUESTED row exists")
    if len(requests) > 1:
        return _gate(rp.R4, BLOCKED, "CONFLICTING_RESTORE_REQUESTS", "More than one RESTORE_REQUESTED row is bound")
    row = requests[0]
    if not _r3_precedes(audit, incident["id"], row["id"]):
        evidence = {"restore_requested_row": row["id"]}
        return _gate(rp.R4, BLOCKED, "R3_DID_NOT_PRECEDE_RESTORE", "No VERIFIED isolation row precedes the RESTORE request", evidence)
    evidence = {"restore_requested_row": row["id"], "restore_requested_at": row["timestamp"], "credential": "NEVER_READ"}
    return _gate(rp.R4, VERIFIED, "D4_RESTORE_REQUEST_RECORDED", "Durable RESTORE_REQUESTED bound to the incident", evidence)


def _r5(
    audit: _AuditStore, protocol: _ProtocolStore | None, protocol_problem: str | None, ctx: _Context, incident: dict[str, Any],
) -> dict[str, Any]:
    rows = audit.events(incident["id"], ("RESTORE_PUBLISHED",), 1)
    match = _PUBLISHED_RE.match(rows[0]["details"]) if rows else None
    if not match:
        return _gate(rp.R5, BLOCKED, "NO_PUBLICATION_EVIDENCE", "The spent attempt has no linked publication evidence")
    msg_id = match.group(1)
    if protocol is None:
        verdict = BLOCKED if protocol_problem == "MALFORMED" else NOT_PROVEN
        return _gate(rp.R5, verdict, f"PROTOCOL_STORE_{protocol_problem or 'MISSING'}", "The protocol store cannot be read", {"msg_id": msg_id})
    row = protocol.command(msg_id)
    if row is None:
        return _gate(rp.R5, BLOCKED, "LINKED_COMMAND_NOT_IN_STORE", "The linked RESTORE command is not in the protocol store", {"msg_id": msg_id})
    section, problem = ctx.section("device", incident["id"])
    physical = None
    if section is not None and section["correlated_msg_id"] == msg_id:
        physical = {"nonce": msg_id, "observed_state": section["state"]}
    try:
        found = lr.restore_evidence_ladder(_LadderShim(protocol, physical), msg_id)
    except (KeyError, TypeError, sqlite3.Error):
        return _gate(rp.R5, BLOCKED, "PROTOCOL_STORE_MALFORMED", "The command record is unreadable", {"msg_id": msg_id})
    if found is None:
        return _gate(rp.R5, BLOCKED, "LINKED_COMMAND_NOT_RESTORE", "The linked command is not a RESTORE", {"msg_id": msg_id})
    ladder = found[1]
    ack, executed, published = ladder["ack"], ladder["executed"], ladder["published"]
    evidence = {
        "msg_id": msg_id, "published": published, "ack": ack, "executed": executed,
        "device_evidence": "OBSERVED" if physical else (problem[1] if problem else "NOT_CORRELATED"),
        "physical_evidence": ladder["physical_evidence"],
    }
    if published == "NOT_PUBLISHED":
        return _gate(rp.R5, BLOCKED, "RESTORE_NOT_PUBLISHED", "The RESTORE was never published", evidence)
    if str(ack).startswith("REJECTED"):
        return _gate(rp.R5, BLOCKED, "DEVICE_REJECTED_RESTORE", "The device rejected RESTORE", evidence)
    if executed == "DEVICE_REPORTED_LOCKDOWN":
        return _gate(rp.R5, BLOCKED, "DEVICE_REPORTED_LOCKDOWN", "The device reported LOCKDOWN after RESTORE", evidence)
    if ack == "ACCEPTED" and executed == "DEVICE_REPORTED_NORMAL":
        return _gate(rp.R5, VERIFIED, "ACK_ACCEPTED_STATUS_NORMAL", "Correlated ACK and fresh correlated STATUS=NORMAL", evidence)
    if ack == "OUTCOME_UNKNOWN":
        return _gate(rp.R5, BLOCKED, "OUTCOME_UNKNOWN", "The RESTORE outcome is unknown", evidence)
    return _gate(rp.R5, NOT_PROVEN, "AWAITING_ACK_AND_FRESH_STATUS_NORMAL", "ACK and fresh correlated STATUS=NORMAL are not both proven", evidence)


def _r6(ctx: _Context, incident: dict[str, Any]) -> dict[str, Any]:
    section, problem = ctx.section("r6", incident["id"])
    if problem:
        return _gate(rp.R6, problem[0], problem[1], "No usable network probe evidence")
    results = section["results"]
    if not section["configured"] or not results:
        return _gate(rp.R6, NOT_PROVEN, "PROBES_NOT_CONFIGURED", "No network probe targets were configured")
    failed = sum(1 for ok in results if not ok)
    evidence = {"probes": len(results), "failed": failed}
    if failed:
        return _gate(rp.R6, BLOCKED, "NETWORK_PROBE_FAILED", "A network probe failed", evidence)
    return _gate(rp.R6, VERIFIED, "NETWORK_PROBES_PASSED", "Every network probe passed", evidence)


def _r7(ctx: _Context, incident: dict[str, Any]) -> dict[str, Any]:
    section, problem = ctx.section("r7", incident["id"])
    if problem:
        return _gate(rp.R7, problem[0], problem[1], "No usable service readiness evidence")
    checks = {name: section["checks"].get(name) for name in R7_CHECKS}
    state = {name: "OK" if value else ("NOT_CONFIGURED" if value is None else "FAIL") for name, value in checks.items()}
    evidence = {"checks": state}
    if any(value is False for value in checks.values()):
        return _gate(rp.R7, BLOCKED, "SERVICE_NOT_READY", "A mandatory service is not ready", evidence)
    if any(value is None for value in checks.values()):
        return _gate(rp.R7, NOT_PROVEN, "READINESS_NOT_CONFIGURED", "A mandatory readiness check has no evidence", evidence)
    return _gate(rp.R7, VERIFIED, "SERVICES_READY", "Every mandatory service reported ready", evidence)


def _r8(audit: _AuditStore, incident: dict[str, Any]) -> dict[str, Any]:
    if incident["state"] != "CLOSED":
        return _gate(rp.R8, NOT_PROVEN, "INCIDENT_NOT_CLOSED", "R1-R7 are verified but the Core has not closed the incident")
    closes = audit.events(incident["id"], ("RECOVERY_R8_CLOSE",), 1)
    if not closes:
        return _gate(rp.R8, BLOCKED, "NO_CORE_CLOSE_RECORD", "The incident is CLOSED without a Core closure audit row")
    requests = audit.restore_requests(incident["id"])
    if not requests or closes[0]["id"] < requests[0]["id"]:
        return _gate(rp.R8, BLOCKED, "CLOSE_PRECEDES_RESTORE", "The closure row does not follow the RESTORE request")
    evidence = {"close_record_id": closes[0]["id"], "closed_at": incident["closed_at"]}
    return _gate(rp.R8, VERIFIED, "CLOSED_BY_CORE_WITH_EVIDENCE", "R1-R7 verified and the Core closed the incident", evidence)


# --------------------------------------------------------------------------- orchestration


def _store_gates(verdict: str, reason: str) -> dict[str, dict[str, Any]]:
    gates: dict[str, dict[str, Any]] = {}
    for name in rp.GATES:
        if name == rp.R1:
            gates[name] = _gate(name, verdict, reason, "The audit store cannot be read")
        else:
            gates[name] = _prereq(name, (rp.R1,), gates)  # type: ignore[assignment]
    return gates


def evaluate(
    audit_db: Any,
    *,
    protocol_db: Any = None,
    observations: Any = None,
    incident_id: int | None = None,
    now: float,
    max_age_sec: float = DEFAULT_MAX_AGE_SEC,
) -> dict[str, Any]:
    """Pure read-only evaluation. ``now`` is explicit so identical inputs always give byte-identical output."""
    if incident_id is not None and type(incident_id) is not int:
        raise EvidenceError("BAD_INCIDENT_ID")
    if not _is_number(now) or not _is_number(max_age_sec) or max_age_sec <= 0:
        raise EvidenceError("BAD_TIME_ARGUMENT")

    obs: dict[str, Any] | None = None
    obs_problem: str | None = None
    if observations is not None:
        try:
            obs = load_observations(observations)
        except StoreProblem as problem:
            obs_problem = problem.kind
    ctx = _Context(float(now), float(max_age_sec), obs, obs_problem)

    gates: dict[str, dict[str, Any]]
    incident: dict[str, Any] | None = None
    try:
        audit = _AuditStore(_open_ro(audit_db, {"audit_logs": _AUDIT_COLUMNS, "incidents": _INCIDENT_COLUMNS}))
    except StoreProblem as problem:
        verdict = BLOCKED if problem.kind == "MALFORMED" else NOT_PROVEN
        gates = _store_gates(verdict, f"AUDIT_STORE_{problem.kind}")
        return _document(gates, None, now, max_age_sec)

    protocol: _ProtocolStore | None = None
    protocol_problem: str | None = None
    try:
        if protocol_db is None:
            protocol_problem = "MISSING"
        else:
            protocol = _ProtocolStore(_open_ro(protocol_db, {"protocol_commands": _PROTOCOL_COLUMNS}))
    except StoreProblem as problem:
        protocol_problem = problem.kind

    try:
        gates = {}
        gates[rp.R1], incident = _r1(audit, incident_id)
        subject = incident if gates[rp.R1]["verdict"] == VERIFIED else None

        def run(name: str, needs: tuple[str, ...], produce) -> None:
            blocked = _prereq(name, needs, gates)
            gates[name] = blocked if blocked else produce()

        run(rp.R2, (rp.R1,), lambda: _r2(ctx, subject))
        run(rp.R3, (rp.R1,), lambda: _r3(audit, ctx, subject))
        run(rp.R4, (rp.R1,), lambda: _r4(audit, subject))
        run(rp.R5, (rp.R4,), lambda: _r5(audit, protocol, protocol_problem, ctx, subject))
        run(rp.R6, (rp.R5,), lambda: _r6(ctx, subject))
        run(rp.R7, (rp.R6,), lambda: _r7(ctx, subject))
        run(rp.R8, rp.CLOSURE_REQUIRED, lambda: _r8(audit, subject))
    except sqlite3.Error:
        gates = _store_gates(BLOCKED, "AUDIT_STORE_MALFORMED")
        incident = None
    finally:
        audit.close()
        if protocol is not None:
            protocol.close()
    return _document(gates, incident, now, max_age_sec)


def _document(gates: dict[str, dict[str, Any]], incident: dict[str, Any] | None, now: Any, max_age: Any) -> dict[str, Any]:
    ordered = [gates[name] for name in rp.GATES]
    verdicts = {gate["verdict"] for gate in ordered}
    overall = VERIFIED if verdicts == {VERIFIED} else (BLOCKED if BLOCKED in verdicts else NOT_PROVEN)
    document = {
        "schema": SCHEMA,
        "read_only": True,
        "evaluated_at": float(now),
        "max_age_sec": float(max_age),
        "incident": (
            {key: incident[key] for key in ("id", "state", "attacker_ip")} if incident and gates[rp.R1]["verdict"] == VERIFIED else None
        ),
        "overall": overall,
        "gates": ordered,
        "claims": {"physical_evidence": "NOT_PROVEN", "production": "NOT_PROVEN", "scope": "STORED_STATE_ONLY"},
    }
    return document


def render(document: dict[str, Any]) -> str:
    """Deterministic JSON; refuses to emit anything credential-shaped."""
    text = json.dumps(document, sort_keys=True, indent=2, ensure_ascii=True)
    if _SECRET_RE.search(text):
        raise EvidenceError("SECRET_SHAPED_OUTPUT_REFUSED")
    return text + "\n"


# --------------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None, *, clock=None) -> int:
    import time

    parser = argparse.ArgumentParser(prog="recovery_evidence", description="Read-only Recovery R1-R8 evidence checker.")
    parser.add_argument("--audit-db", required=True, help="Core audit SQLite database (opened read-only)")
    parser.add_argument("--protocol-db", help="Protocol-v1 command store (opened read-only)")
    parser.add_argument("--observations", help="strict JSON snapshot of R2/R6/R7/containment/device observations")
    parser.add_argument("--incident-id", type=int, help="inspect this incident (needed to inspect a closed one)")
    parser.add_argument("--now", type=float, help="evaluation epoch seconds (default: current time)")
    parser.add_argument("--max-age-sec", type=float, default=DEFAULT_MAX_AGE_SEC)
    args = parser.parse_args(argv)
    now = args.now if args.now is not None else (clock or time.time)()
    try:
        document = evaluate(
            args.audit_db, protocol_db=args.protocol_db, observations=args.observations,
            incident_id=args.incident_id, now=now, max_age_sec=args.max_age_sec,
        )
        sys.stdout.write(render(document))
    except EvidenceError as error:
        sys.stderr.write(f"recovery_evidence: refused: {error.code}\n")
        return 4
    return {VERIFIED: 0, BLOCKED: 2, NOT_PROVEN: 3}[document["overall"]]


__all__ = ["BLOCKED", "NOT_PROVEN", "SCHEMA", "VERIFIED", "EvidenceError", "evaluate", "load_observations", "main", "render"]


if __name__ == "__main__":
    raise SystemExit(main())
