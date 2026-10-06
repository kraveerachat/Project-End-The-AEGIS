"""Governed Recovery R2-R8 stage driver (normal path only). REPOSITORY IMPLEMENTATION; nothing here has run live.

The Core already owns Recovery (``recovery_core``/``recovery_protocol``). This module only DRIVES the existing, reviewed Core operations through the existing unprivileged client and VERIFIES the
outcome read-only. It adds NO new Core authority and:

* never accepts an IP, path, command or secret (the Core derives the ISOLATE target from its own bound incident; the only free text is the bounded CLOSE summary and the bounded owner RESTORE reason);
* never publishes RESTORE, never writes SQLite, never calls nft, never speaks MQTT, never uses break-glass and never reads or stores the D4 secret (RESTORE is the owner's interactive ``aegisctl restore``;
  this module only records that command's EXIT CODE);
* enforces the normal-path ladder with ONE exclusive record per step in a steps directory: STATUS -> PROBE -> ISOLATE -> fresh PROBE -> (owner D4) -> RESTORE_STATUS -> PROBE -> CLOSE. A step refuses unless its
  predecessors are recorded and verified, runs ONCE, and an unknown outcome stops the whole ladder (never resent);
* the root-side commands (``baseline-db``, ``final-verify``) open the Core databases read-only through a WAL-aware in-memory view and reuse ``recovery_evidence`` and the existing audit hash-chain check.

Residual (documented): the operator-side step records are written by the operator account, so they can never CREATE a pass by themselves: the final verifier requires the Core's own durable rows (R3 result,
the single RESTORE_REQUESTED, RESTORE_PUBLISHED, correlated ACK/STATUS in the command store, RECOVERY_R8_CLOSE, INCIDENT_CLOSED) and the Core CLOSE success, which itself re-evaluated R1-R7 live.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sqlite3
import stat
import sys
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from . import local_restore as lr
from . import r1_acceptance as r1
from . import recovery_client as rc
from . import recovery_evidence as rev
from . import recovery_protocol as rp
from .ip_containment import ContainmentRejected, validate_block_target

STEP_SCHEMA = "aegis.idea3.recovery-step/1"
BASELINE_SCHEMA = "aegis.idea3.recovery-baseline/1"
RESULT_SCHEMA = "aegis.idea3.recovery-result/1"
CLAIMS = {
    "F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "LVR_PROVEN": "NO", "L8_ACCEPTANCE": "NO", "L9_PROVEN": "NO",
    "R1B_RESULT": "FAIL_IMMUTABLE", "R1B_RESULT_REWRITTEN": "NO", "R1BV_RESULT": "PASS", "R1BV_RESULT_REWRITTEN": "NO",
}
#: ordered ladder: name -> (file, predecessors that must exist AND be verified)
LADDER = {
    "STATUS": ("01-status.json", ()),
    "PROBE_PRE": ("02-probe-pre.json", ("STATUS",)),
    "ISOLATE": ("03-isolate.json", ("STATUS", "PROBE_PRE")),
    "PROBE_POST_ISOLATE": ("04-probe-post-isolate.json", ("ISOLATE",)),
    "D4": ("05-d4.json", ("PROBE_POST_ISOLATE",)),
    "RESTORE_STATUS": ("06-restore-status.json", ("D4",)),
    "PROBE_FINAL": ("07-probe-final.json", ("RESTORE_STATUS",)),
    "CLOSE": ("08-close.json", ("PROBE_FINAL",)),
}
#: D4 exit codes of ``aegisctl restore``: 0 NORMAL observed; 3 published but evidence pending (read-only poll allowed, never resend); 1 channel unavailable / 2 refused / 4 OUTCOME_UNKNOWN => STOP.
D4_CONTINUE = {0, 3}
FORBIDDEN_NEW_EVENTS = ("RESTORE_BREAK_GLASS_CLAIM", "RESTORE_BREAK_GLASS_PUBLISHED", "ALERT_ACCEPTED", "INCIDENT_BOUND", "INCIDENT_DISPOSED_HISTORICAL", "R1D_DISPOSITION_ATTEMPT_RECORDED")
MAX_WAIT_SEC = 300
OBSERVATION_MAX_AGE_SEC = 3600.0  # the owner-interactive D4 step can take minutes; the Core CLOSE re-evaluated R1-R7 live in any case
ATTEMPT_SCHEMA = "aegis.idea3.recovery-attempt/1"


class StageError(Exception):
    """A refusal with a stable, secret-free code."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


Request = Callable[..., dict[str, Any]]


def default_request(op: str, summary: str | None = None) -> dict[str, Any]:
    """The existing unprivileged client, with a FIXED socket path and the Core account resolved without any environment override."""
    return rc.request(op, summary=summary, path=rp.DEFAULT_SOCKET_PATH, expected_uid=rc.core_uid({}), timeout=20.0)


def _ask(request: Request, op: str, summary: str | None = None) -> dict[str, Any]:
    try:
        reply = request(op, summary) if summary is not None else request(op)
    except rc.RecoveryUnavailable:
        raise StageError("CORE_RECOVERY_UNAVAILABLE") from None
    except rc.RecoveryOutcomeUnknown:
        raise StageError("OUTCOME_UNKNOWN") from None
    if not isinstance(reply, dict) or not isinstance(reply.get("data", {}), dict) or "ok" not in reply:
        raise StageError("CORE_REPLY_MALFORMED")
    return reply


def _gates(reply: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out = {}
    for item in reply.get("data", {}).get("gates", []) or []:
        if isinstance(item, dict) and item.get("gate") in rp.GATES:
            out[item["gate"]] = item
    return out


def _incident(reply: dict[str, Any]) -> dict[str, Any]:
    incident = reply.get("data", {}).get("incident")
    if not isinstance(incident, dict) or type(incident.get("id")) is not int or not isinstance(incident.get("attacker_ip"), str):
        raise StageError("NO_BOUND_INCIDENT")
    try:
        if str(validate_block_target(incident["attacker_ip"], ())) != incident["attacker_ip"]:
            raise StageError("BOUND_IP_INVALID")
    except ContainmentRejected:
        raise StageError("BOUND_IP_INVALID") from None
    return {"id": incident["id"], "attacker_ip": incident["attacker_ip"]}


def _require(gates: dict[str, dict[str, Any]], names: tuple[str, ...]) -> dict[str, str]:
    seen = {}
    for name in names:
        status = gates.get(name, {}).get("status")
        if status != rp.VERIFIED:
            raise StageError(f"GATE_NOT_VERIFIED:{name}:{status}")
        seen[name] = status
    return seen


# ----------------------------------------------------------------------------------------------- step records (exclusive, one per step, ordered)


def _path(steps_dir: str, name: str) -> Path:
    return Path(steps_dir) / LADDER[name][0]


def _load(steps_dir: str, name: str) -> dict[str, Any]:
    try:
        doc = json.loads(_path(steps_dir, name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise StageError(f"PREDECESSOR_MISSING:{name}") from None
    if doc.get("schema") != STEP_SCHEMA or doc.get("step") != name or doc.get("verified") is not True:
        raise StageError(f"PREDECESSOR_NOT_VERIFIED:{name}")
    return doc


def _predecessors(steps_dir: str, name: str) -> dict[str, dict[str, Any]]:
    if not Path(steps_dir).is_dir() or Path(steps_dir).is_symlink():
        raise StageError("STEPS_DIR_INVALID")
    if _path(steps_dir, name).exists():
        raise StageError(f"STEP_ALREADY_RECORDED:{name}")  # every step runs ONCE; nothing is retried or overwritten
    docs = {pre: _load(steps_dir, pre) for pre in LADDER[name][1]}
    if "D4" in docs and docs["D4"].get("exit_code") not in D4_CONTINUE:
        raise StageError("D4_STOP_OUTCOME_NOT_RETRIED")
    return docs


def _same_incident(expected: dict[str, Any], docs: dict[str, dict[str, Any]], incident: dict[str, Any]) -> None:
    if expected != incident:
        raise StageError("INCIDENT_CHANGED")
    for doc in docs.values():
        if doc.get("incident") != incident:
            raise StageError("INCIDENT_CHANGED")


def _write(steps_dir: str, name: str, doc: dict[str, Any]) -> None:
    doc = {"schema": STEP_SCHEMA, "step": name, "at": time.time(), **doc}
    text = json.dumps(doc, sort_keys=True, indent=2, ensure_ascii=True) + "\n"
    if re.search(r"secret|password|credential|token", text.replace("restore_credential", ""), re.IGNORECASE):
        raise StageError("SECRET_SHAPED_OUTPUT_REFUSED")
    fd = os.open(_path(steps_dir, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


# ----------------------------------------------------------------------------------------------- the ladder (operator account; unprivileged Core client only)


def socket_trusted(path: str = rp.DEFAULT_SOCKET_PATH, *, core_uid: int | None = None) -> str:
    """The Recovery socket exists, is a socket owned by the Core account, and its directory is Core- or root-owned and not group/world writable."""
    uid = rc.core_uid({}) if core_uid is None else core_uid
    try:
        info, parent = os.lstat(path), os.lstat(os.path.dirname(path))
    except OSError:
        raise StageError("RECOVERY_SOCKET_MISSING") from None
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != uid or info.st_mode & 0o002:
        raise StageError("RECOVERY_SOCKET_NOT_THE_CORE_SURFACE")
    if not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode) or parent.st_uid not in (0, uid) or parent.st_mode & 0o022:
        raise StageError("RECOVERY_SOCKET_DIRECTORY_NOT_TRUSTED")
    return "TRUSTED"


def step_status(request: Request, steps_dir: str) -> dict[str, Any]:
    _predecessors(steps_dir, "STATUS")
    reply = _ask(request, rp.OP_STATUS)
    if reply.get("ok") is not True or reply.get("code") != "STATUS":
        raise StageError("STATUS_REFUSED:" + str(reply.get("code")))
    incident, gates = _incident(reply), _gates(reply)
    seen = _require(gates, (rp.R1,))
    for gate in (rp.R3, rp.R4, rp.R5, rp.R8):  # no Recovery progress may pre-exist for the bound incident
        if gates.get(gate, {}).get("status") == rp.VERIFIED:
            raise StageError(f"RECOVERY_ALREADY_PROGRESSED:{gate}")
    _write(steps_dir, "STATUS", {"verified": True, "incident": incident, "gates": seen})
    return {"incident": incident}


def _probe(request: Request, steps_dir: str, name: str, require: tuple[str, ...]) -> dict[str, Any]:
    docs = _predecessors(steps_dir, name)
    reply = _ask(request, rp.OP_PROBE)
    if reply.get("ok") is not True or reply.get("code") != "PROBED":
        raise StageError("PROBE_REFUSED:" + str(reply.get("code")))
    incident, gates = _incident(reply), _gates(reply)
    _same_incident(_first_incident(steps_dir), docs, incident)
    seen = _require(gates, require)
    _write(steps_dir, name, {"verified": True, "incident": incident, "gates": seen, "details": {g: gates[g].get("detail", "")[:400] for g in require},
                              "summaries": {g: gates[g].get("summary", "")[:200] for g in require}})
    return {"gates": seen}


def _first_incident(steps_dir: str) -> dict[str, Any]:
    return _load(steps_dir, "STATUS")["incident"]


def step_probe_pre(request: Request, steps_dir: str) -> dict[str, Any]:
    return _probe(request, steps_dir, "PROBE_PRE", (rp.R2,))


def step_probe_post_isolate(request: Request, steps_dir: str) -> dict[str, Any]:
    return _probe(request, steps_dir, "PROBE_POST_ISOLATE", (rp.R2,))  # a FRESH R2 before the owner D4 step


def step_probe_final(request: Request, steps_dir: str) -> dict[str, Any]:
    docs = _predecessors(steps_dir, "PROBE_FINAL")
    restore = docs["RESTORE_STATUS"]
    if restore.get("gates", {}).get(rp.R5) != rp.VERIFIED:
        raise StageError("R6_R7_REQUIRE_VERIFIED_R5")  # R6/R7 are probed only AFTER a verified R5
    return _probe(request, steps_dir, "PROBE_FINAL", (rp.R2, rp.R6, rp.R7))


def step_isolate(request: Request, steps_dir: str) -> dict[str, Any]:
    docs = _predecessors(steps_dir, "ISOLATE")
    reply = _ask(request, rp.OP_ISOLATE)  # NO parameter: the Core derives the target from the bound incident
    if reply.get("ok") is not True or reply.get("code") != "R3_VERIFIED":
        raise StageError("ISOLATE_NOT_VERIFIED:" + str(reply.get("code")))
    incident, gates = _incident(reply), _gates(reply)
    _same_incident(docs["STATUS"]["incident"], docs, incident)
    seen = _require(gates, (rp.R3,))
    _write(steps_dir, "ISOLATE", {"verified": True, "incident": incident, "gates": seen, "containment_readback": "VERIFIED_BY_CORE"})
    return {"gates": seen}


def record_d4(steps_dir: str, exit_code: int) -> dict[str, Any]:
    """Record ONLY the exit code of the owner's interactive ``aegisctl restore``. No output, no secret, no retry."""
    docs = _predecessors(steps_dir, "D4")
    if type(exit_code) is not int or not 0 <= exit_code <= 255:
        raise StageError("D4_EXIT_CODE_INVALID")
    meaning = {0: "NORMAL_OBSERVED", 3: "PUBLISHED_EVIDENCE_PENDING", 1: "CHANNEL_UNAVAILABLE_NOTHING_SENT", 2: "REFUSED", 4: "OUTCOME_UNKNOWN_DO_NOT_RESEND"}.get(exit_code, "UNEXPECTED_STOP")
    cont = exit_code in D4_CONTINUE
    _write(steps_dir, "D4", {"verified": cont, "incident": docs["PROBE_POST_ISOLATE"]["incident"], "exit_code": exit_code, "meaning": meaning, "retry": "NEVER"})
    if not cont:
        raise StageError("D4_STOP:" + meaning)
    return {"exit_code": exit_code, "meaning": meaning}


def step_restore_status(request: Request, steps_dir: str, *, wait_seconds: float = 0.0, sleep: Callable[[float], None] = time.sleep, monotonic: Callable[[], float] = time.monotonic) -> dict[str, Any]:
    if not 0 <= wait_seconds <= MAX_WAIT_SEC:
        raise StageError("WAIT_OUT_OF_RANGE")
    docs = _predecessors(steps_dir, "RESTORE_STATUS")
    deadline = monotonic() + wait_seconds
    while True:  # READ-ONLY polling of the Core evidence; RESTORE is never resent
        reply = _ask(request, rp.OP_RESTORE_STATUS)
        if reply.get("ok") is not True or reply.get("code") != "RESTORE_STATUS":
            raise StageError("RESTORE_STATUS_REFUSED:" + str(reply.get("code")))
        gates, data = _gates(reply), reply.get("data", {})
        ladder = data.get("restore") if isinstance(data.get("restore"), dict) else {}
        if data.get("break_glass_restore") not in ("NONE",):
            raise StageError("BREAK_GLASS_REPORTED_OR_UNKNOWN")  # break-glass can never earn R4/R5/R8 credit
        if ladder.get("ack") == "OUTCOME_UNKNOWN":
            raise StageError("OUTCOME_UNKNOWN")
        if str(ladder.get("ack", "")).startswith("REJECTED") or ladder.get("executed") == "DEVICE_REPORTED_LOCKDOWN":
            raise StageError("RESTORE_NOT_ACCEPTED_OR_LOCKDOWN")
        if all(gates.get(g, {}).get("status") == rp.VERIFIED for g in (rp.R4, rp.R5)):
            if ladder.get("ack") != "ACCEPTED" or ladder.get("executed") != "DEVICE_REPORTED_NORMAL":
                raise StageError("R5_WITHOUT_CORRELATED_ACK_AND_STATUS_NORMAL")
            seen = _require(gates, (rp.R4, rp.R5))
            _write(steps_dir, "RESTORE_STATUS", {"verified": True, "incident": docs["D4"]["incident"], "gates": seen, "ladder": {k: str(ladder.get(k)) for k in ("requested", "published", "ack", "executed")}})
            return {"gates": seen}
        if monotonic() >= deadline:
            raise StageError("R4_R5_NOT_VERIFIED_BEFORE_DEADLINE")
        sleep(min(2.0, max(0.0, deadline - monotonic())))


def step_close(request: Request, steps_dir: str, summary: str) -> dict[str, Any]:
    docs = _predecessors(steps_dir, "CLOSE")
    problem = rp.summary_problem(summary)
    if problem:
        raise StageError(problem)
    probe = docs["PROBE_FINAL"]
    if any(probe.get("gates", {}).get(g) != rp.VERIFIED for g in (rp.R2, rp.R6, rp.R7)):
        raise StageError("R8_REQUIRES_R1_TO_R7_VERIFIED")
    reply = _ask(request, rp.OP_CLOSE, summary.strip())
    if reply.get("ok") is not True or reply.get("code") != "CLOSED":
        raise StageError("CLOSE_REFUSED:" + str(reply.get("code")))
    _write(steps_dir, "CLOSE", {"verified": True, "incident": probe["incident"], "code": "CLOSED"})
    return {"code": "CLOSED"}


def check_reason(reason: str) -> str:
    problem = lr.reason_problem(reason)
    if problem:
        raise StageError(problem)
    return "REASON_OK"


def consume_attempt(marker: str) -> dict[str, Any]:
    """Consume exactly one Recovery attempt immediately before the first mutation.

    The marker is deliberately the only stage-owned write before ``ISOLATE``.  It is
    exclusive and never removed or overwritten, so a failed post-marker attempt is
    preserved and cannot be blindly retried.
    """
    path = Path(marker)
    if not marker or not path.is_absolute() or path.is_symlink() or not path.parent.is_dir() or path.parent.is_symlink():
        raise StageError("RECOVERY_ATTEMPT_MARKER_PATH_INVALID")
    if path.exists():
        raise StageError("RECOVERY_ATTEMPT_ALREADY_CONSUMED")
    doc = {"schema": ATTEMPT_SCHEMA, "consumed": True, "at": time.time(), "retry": "NEVER"}
    raw = (json.dumps(doc, sort_keys=True, separators=(",", ":")) + "\n").encode()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise StageError("RECOVERY_ATTEMPT_ALREADY_CONSUMED") from None
    with os.fdopen(fd, "wb") as handle:
        handle.write(raw)
    return doc


def recovery_run_attempt(
    request: Request,
    steps_dir: str,
    marker: str,
    *,
    restore_exit_code: Callable[[], int],
    restore_wait_seconds: float = 0.0,
    restore_sleep: Callable[[float], None] = time.sleep,
    restore_monotonic: Callable[[], float] = time.monotonic,
    close_summary: str,
) -> dict[str, Any]:
    """Run the single ordered Recovery R2-R8 attempt.

    ``restore_exit_code`` is the owner-interactive normal ``aegisctl restore``
    authority.  The callback returns only its exit code; it receives no secret and
    this driver never retries it.  Core operations are the only source of mutable
    Recovery evidence.
    """
    if not callable(restore_exit_code):
        raise StageError("D4_INTERACTIVE_AUTHORITY_REQUIRED")
    first = step_status(request, steps_dir)
    step_probe_pre(request, steps_dir)
    # This is intentionally adjacent to the first mutating Core operation.
    consumed = consume_attempt(marker)
    try:
        step_isolate(request, steps_dir)
        step_probe_post_isolate(request, steps_dir)
        code = restore_exit_code()
        record_d4(steps_dir, code)
        step_restore_status(request, steps_dir, wait_seconds=restore_wait_seconds, sleep=restore_sleep, monotonic=restore_monotonic)
        step_probe_final(request, steps_dir)
        step_close(request, steps_dir, close_summary)
    except StageError:
        raise
    return {"attempt": consumed, "incident": first["incident"], "result": "CLOSED"}


# ----------------------------------------------------------------------------------------------- root side: read-only database observers


def memory_view(path: Any, required: dict[str, set[str]]) -> sqlite3.Connection:
    """A WAL-aware, consistent, read-only in-memory view (the live Core database has a non-empty WAL, which ``recovery_evidence._open_ro`` correctly refuses on a file). Nothing is written to disk."""
    if not isinstance(path, (str, os.PathLike)) or not Path(path).is_file():
        raise rev.StoreProblem("MISSING")
    src = view = None
    try:
        src = sqlite3.connect(f"file:{quote(str(Path(path).resolve()))}?mode=ro", uri=True)
        view = sqlite3.connect(":memory:")
        src.backup(view)
        view.row_factory = sqlite3.Row
        view.execute("PRAGMA query_only = ON")
        for table, columns in required.items():
            if not columns <= {row["name"] for row in view.execute(f"PRAGMA table_info({table})")}:
                raise rev.StoreProblem("MALFORMED")
        return view
    except rev.StoreProblem:
        if view is not None:
            view.close()
        raise
    except sqlite3.Error:
        if view is not None:
            view.close()
        raise rev.StoreProblem("MALFORMED") from None
    finally:
        if src is not None:
            src.close()


def _scalar(view: sqlite3.Connection, sql: str, args: tuple = ()) -> Any:
    return view.execute(sql, args).fetchone()[0]


def baseline_db(*, audit_db: str, r1b_baseline: str, expected_source_ip: str, detector_uid: int, owner_uid: int = 0) -> dict[str, Any]:
    """PRE-MARKER read-only proof that the Core's single open incident is the genuine R1B-created one and that no Recovery progress exists. Raises ``StageError`` on ANY deviation."""
    from . import r1bv_validation as v

    try:
        expected = str(validate_block_target(expected_source_ip, ()))
    except (ContainmentRejected, ValueError, TypeError):
        raise StageError("EXPECTED_SOURCE_NOT_AN_EXTERNALLY_CAPABLE_IPV4") from None
    if expected != expected_source_ip:
        raise StageError("EXPECTED_SOURCE_NOT_AN_EXTERNALLY_CAPABLE_IPV4")
    try:
        parent = os.lstat(os.path.dirname(r1b_baseline))
        info = os.lstat(r1b_baseline)
        data = Path(r1b_baseline).read_text(encoding="utf-8") if stat.S_ISREG(info.st_mode) else ""
        preserved = json.loads(data)
    except (OSError, ValueError):
        raise StageError("PRESERVED_R1B_BASELINE_MISSING_OR_MALFORMED") from None
    if info.st_uid != owner_uid or parent.st_uid != owner_uid or info.st_mode & 0o022 or parent.st_mode & 0o022 or preserved.get("schema") != r1.SCHEMA_BASELINE:
        raise StageError("PRESERVED_R1B_BASELINE_NOT_TRUSTED")
    base_audit, base_incident = preserved.get("audit_max_id"), preserved.get("incident_max_id")
    if type(base_audit) is not int or type(base_incident) is not int:
        raise StageError("PRESERVED_R1B_BASELINE_MALFORMED")
    view = memory_view(audit_db, {"audit_logs": rev._AUDIT_COLUMNS, "incidents": rev._INCIDENT_COLUMNS})
    try:
        open_rows = view.execute("SELECT id, attacker_ip, state FROM incidents WHERE state != 'CLOSED'").fetchall()
        if len(open_rows) != 1:
            raise StageError("NOT_EXACTLY_ONE_OPEN_INCIDENT")
        incident = dict(open_rows[0])
        if incident["attacker_ip"] != expected:
            raise StageError("OPEN_INCIDENT_IS_NOT_FROM_THE_PINNED_SOURCE")
        if incident["id"] <= base_incident or _scalar(view, "SELECT COUNT(*) FROM incidents WHERE id > ?", (base_incident,)) != 1:
            raise StageError("OPEN_INCIDENT_IS_NOT_THE_SINGLE_R1B_CREATED_INCIDENT")
        bound = view.execute("SELECT id, details FROM audit_logs WHERE incident_id = ? AND event_type = 'INCIDENT_BOUND'", (incident["id"],)).fetchall()
        accepted = view.execute("SELECT id, details FROM audit_logs WHERE incident_id = ? AND event_type = 'ALERT_ACCEPTED'", (incident["id"],)).fetchall()
        if len(bound) != 1 or len(accepted) != 1 or min(bound[0]["id"], accepted[0]["id"]) <= base_audit:
            raise StageError("INCIDENT_PROVENANCE_ROWS_MISSING_AMBIGUOUS_OR_BEFORE_THE_R1B_BASELINE")
        if f"attacker_ip={expected} source=detector_alert action=CREATED" not in bound[0]["details"] or f"uid={detector_uid} " not in accepted[0]["details"] or f"attacker_ip={expected} action=CREATED" not in accepted[0]["details"]:
            raise StageError("INCIDENT_PROVENANCE_ROWS_MISMATCH")
        placeholders = ",".join("?" for _ in ("RECOVERY_R3_REQUESTED", "RECOVERY_R3_RESULT", "RESTORE_REQUESTED", "RESTORE_PUBLISHED", "RECOVERY_R8_CLOSE", "INCIDENT_CLOSED"))
        if _scalar(view, f"SELECT COUNT(*) FROM audit_logs WHERE incident_id = ? AND event_type IN ({placeholders})",
                   (incident["id"], "RECOVERY_R3_REQUESTED", "RECOVERY_R3_RESULT", "RESTORE_REQUESTED", "RESTORE_PUBLISHED", "RECOVERY_R8_CLOSE", "INCIDENT_CLOSED")) != 0:
            raise StageError("RECOVERY_HISTORY_ALREADY_EXISTS_FOR_THIS_INCIDENT")
        marks = {"audit_max_id": int(_scalar(view, "SELECT COALESCE(MAX(id), 0) FROM audit_logs")), "incident_max_id": int(_scalar(view, "SELECT COALESCE(MAX(id), 0) FROM incidents"))}
    finally:
        view.close()
    v.audit_chain_intact(audit_db)  # the explicit hash-chain integrity predicate (provenance is not integrity)
    return {"schema": BASELINE_SCHEMA, "incident_id": incident["id"], "attacker_ip": incident["attacker_ip"], **marks, "checks": {
        "RECOVERY_SINGLE_OPEN_INCIDENT": "PASS", "RECOVERY_INCIDENT_IS_THE_R1B_CREATED_ONE": "PASS", "RECOVERY_NO_PRIOR_RECOVERY_HISTORY": "PASS", "RECOVERY_AUDIT_INTEGRITY_PRE": "PASS"}}


def _observations(steps_dir: str, incident_id: int, now: float) -> dict[str, Any]:
    final, isolate = _load(steps_dir, "PROBE_FINAL"), _load(steps_dir, "ISOLATE")
    r7 = {}
    for item in final["details"].get(rp.R7, "").split():
        name, _, state = item.partition("=")
        if name in rev.R7_CHECKS:
            r7[name] = True if state == "OK" else (None if state == "NOT_CONFIGURED" else False)
    count = re.search(r"(\d+) network probe", final["summaries"].get(rp.R6, ""))
    return {"v": rev.OBSERVATION_VERSION, "incident_id": incident_id,
            "r2": {"observed_at": final["at"], "configured": True, "ok": final["gates"][rp.R2] == rp.VERIFIED},
            "containment": {"observed_at": isolate["at"], "present": isolate.get("containment_readback") == "VERIFIED_BY_CORE"},
            "r6": {"observed_at": final["at"], "configured": True, "results": [final["gates"][rp.R6] == rp.VERIFIED] * (int(count.group(1)) if count else 1)},
            "r7": {"observed_at": final["at"], "checks": {k: r7.get(k) for k in rev.R7_CHECKS if k in r7}}}


def final_verify(*, audit_db: str, protocol_db: str, steps_dir: str, baseline: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    """Root-side, read-only FINAL proof. Requires the Core's own durable evidence; the step records only SUPPLEMENT the non-durable R2/R6/R7 gates and can never create a pass alone."""
    from . import r1bv_validation as v

    now = time.time() if now is None else now
    close = _load(steps_dir, "CLOSE")
    incident_id = baseline["incident_id"]
    if close["incident"]["id"] != incident_id or _load(steps_dir, "STATUS")["incident"]["id"] != incident_id:
        raise StageError("INCIDENT_CHANGED")
    view = memory_view(audit_db, {"audit_logs": rev._AUDIT_COLUMNS, "incidents": rev._INCIDENT_COLUMNS})
    try:
        row = view.execute("SELECT state, closed_at FROM incidents WHERE id = ?", (incident_id,)).fetchone()
        if row is None or row["state"] != "CLOSED":
            raise StageError("INCIDENT_NOT_CLOSED")
        if _scalar(view, "SELECT COUNT(*) FROM incidents WHERE state != 'CLOSED'") != 0:
            raise StageError("OPEN_INCIDENTS_REMAIN")
        if _scalar(view, "SELECT COUNT(*) FROM incidents WHERE id > ?", (baseline["incident_max_id"],)) != 0:
            raise StageError("A_NEW_INCIDENT_APPEARED_DURING_RECOVERY")
        ids: dict[str, int] = {}
        for event in ("RECOVERY_R3_REQUESTED", "RECOVERY_R3_RESULT", "RESTORE_REQUESTED", "RESTORE_PUBLISHED", "RECOVERY_R8_CLOSE", "INCIDENT_CLOSED"):
            rows = view.execute("SELECT id FROM audit_logs WHERE incident_id = ? AND event_type = ? ORDER BY id", (incident_id, event)).fetchall()
            if len(rows) != 1:
                raise StageError(f"EXPECTED_EXACTLY_ONE_{event}")
            ids[event] = rows[0]["id"]
        order = ["RECOVERY_R3_REQUESTED", "RECOVERY_R3_RESULT", "RESTORE_REQUESTED", "RESTORE_PUBLISHED", "RECOVERY_R8_CLOSE", "INCIDENT_CLOSED"]
        if any(ids[a] >= ids[b] for a, b in zip(order, order[1:])) or ids[order[0]] <= baseline["audit_max_id"]:
            raise StageError("RECOVERY_AUDIT_ORDER_VIOLATED")
        marks = ",".join("?" for _ in FORBIDDEN_NEW_EVENTS)
        if _scalar(view, f"SELECT COUNT(*) FROM audit_logs WHERE id > ? AND event_type IN ({marks})", (baseline["audit_max_id"], *FORBIDDEN_NEW_EVENTS)) != 0:
            raise StageError("FORBIDDEN_EVENT_APPENDED_DURING_RECOVERY")
        if _scalar(view, "SELECT COUNT(*) FROM audit_logs WHERE id > ? AND event_type LIKE 'RESTORE_BREAK_GLASS%'", (baseline["audit_max_id"],)) != 0:
            raise StageError("BREAK_GLASS_ACTIVITY_DURING_RECOVERY")
    finally:
        view.close()
    v.audit_chain_intact(audit_db)
    observations = _observations(steps_dir, incident_id, now)
    obs_path = Path(steps_dir) / "observations.json"
    fd = os.open(obs_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(observations, handle, sort_keys=True)
    original = rev._open_ro
    rev._open_ro = memory_view  # the producer-bound, WAL-aware read-only view for the SAME checker (no copy on disk)
    try:
        document = rev.evaluate(audit_db, protocol_db=protocol_db, observations=obs_path, incident_id=incident_id, now=now, max_age_sec=OBSERVATION_MAX_AGE_SEC)
    finally:
        rev._open_ro = original
    gates = {g["gate"]: g for g in document["gates"]}
    if document["overall"] != rev.VERIFIED or any(gates[name]["verdict"] != rev.VERIFIED for name in rp.GATES):
        raise StageError("RECOVERY_EVIDENCE_NOT_VERIFIED:" + ",".join(f"{n}={gates[n]['verdict']}:{gates[n]['reason']}" for n in rp.GATES if gates[n]["verdict"] != rev.VERIFIED))
    if gates[rp.R8]["reason"] != "CLOSED_BY_CORE_WITH_EVIDENCE" or gates[rp.R5]["reason"] != "ACK_ACCEPTED_STATUS_NORMAL":
        raise StageError("RECOVERY_R5_OR_R8_REASON_NOT_THE_NORMAL_PATH")
    return {"schema": RESULT_SCHEMA, "result": "PASS", "reason": "OK", "incident_id": incident_id, "claims": dict(CLAIMS),
            "gates": {name: gates[name]["verdict"] for name in rp.GATES}, "checks": {"RECOVERY_AUDIT_INTEGRITY": "PASS", "RECOVERY_R8_CORE_CLOSE_RECORDS": "PASS", "RECOVERY_NORMAL_PATH_ONLY": "PASS", "RECOVERY_NO_NEW_INCIDENT_OR_ATTACKER_EVENT": "PASS"}}


# ----------------------------------------------------------------------------------------------- CLI


def _emit(path: str, doc: dict[str, Any]) -> None:
    text = json.dumps(doc, sort_keys=True, indent=2, ensure_ascii=True) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)


def main(argv: list[str] | None = None, *, request: Request = default_request) -> int:
    parser = argparse.ArgumentParser(prog="aegis_soc.recovery_stage", description="Governed Recovery R2-R8 stage driver (normal path only)")
    sub = parser.add_subparsers(dest="command", required=True)
    marker_cmd = sub.add_parser("consume-attempt")
    marker_cmd.add_argument("--marker", required=True)
    for name in ("status", "probe-pre", "isolate", "probe-post-isolate", "probe-final", "restore-status", "close", "record-d4"):
        item = sub.add_parser(name)
        item.add_argument("--steps-dir", required=True)
        if name == "restore-status":
            item.add_argument("--wait-seconds", type=float, default=0.0)
        if name == "close":
            item.add_argument("--summary", required=True)
        if name == "record-d4":
            item.add_argument("--exit-code", type=int, required=True)
    sub.add_parser("socket-check")
    reason = sub.add_parser("check-reason")
    reason.add_argument("reason")
    base = sub.add_parser("baseline-db")
    for flag in ("--audit-db", "--r1b-baseline", "--expected-source-ip", "--out"):
        base.add_argument(flag, required=True)
    base.add_argument("--detector-uid", type=int, required=True)
    fin = sub.add_parser("final-verify")
    for flag in ("--audit-db", "--protocol-db", "--steps-dir", "--baseline", "--out"):
        fin.add_argument(flag, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "socket-check":
            print(f"RECOVERY_SOCKET={socket_trusted()}")
        elif args.command == "check-reason":
            print(f"RECOVERY_{check_reason(args.reason)}")
        elif args.command == "baseline-db":
            doc = baseline_db(audit_db=args.audit_db, r1b_baseline=args.r1b_baseline, expected_source_ip=args.expected_source_ip, detector_uid=args.detector_uid)
            _emit(args.out, doc)
            print("RECOVERY_BASELINE_DB=PASS")
        elif args.command == "final-verify":
            baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
            if baseline.get("schema") != BASELINE_SCHEMA:
                raise StageError("BASELINE_INVALID")
            doc = final_verify(audit_db=args.audit_db, protocol_db=args.protocol_db, steps_dir=args.steps_dir, baseline=baseline)
            _emit(args.out, doc)
            print("RECOVERY_FINAL_VERIFY=PASS")
        elif args.command == "consume-attempt":
            consume_attempt(args.marker)
            print("RECOVERY_ATTEMPT_CONSUMED=YES")
        else:
            step = {"status": lambda: step_status(request, args.steps_dir), "probe-pre": lambda: step_probe_pre(request, args.steps_dir), "isolate": lambda: step_isolate(request, args.steps_dir),
                    "probe-post-isolate": lambda: step_probe_post_isolate(request, args.steps_dir), "probe-final": lambda: step_probe_final(request, args.steps_dir),
                    "restore-status": lambda: step_restore_status(request, args.steps_dir, wait_seconds=getattr(args, "wait_seconds", 0.0)),
                    "close": lambda: step_close(request, args.steps_dir, getattr(args, "summary", "")), "record-d4": lambda: record_d4(args.steps_dir, getattr(args, "exit_code", -1))}[args.command]
            out = step()
            print(f"RECOVERY_STEP={args.command.upper().replace('-', '_')} RESULT=VERIFIED " + " ".join(f"{k}={v}" for k, v in sorted(out.items()) if k != "incident"))
    except (StageError, rev.StoreProblem, r1_error()) as error:
        code = getattr(error, "code", None) or getattr(error, "kind", None) or type(error).__name__
        print(f"RECOVERY_STEP_REFUSED reason={code}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        print(f"RECOVERY_STEP_REFUSED reason={type(error).__name__}", file=sys.stderr)
        return 1
    return 0


def r1_error():
    return r1.AcceptanceError


if __name__ == "__main__":
    raise SystemExit(main())
