"""Governed Recovery R2-R8 stage driver (normal path only). REPOSITORY IMPLEMENTATION; nothing here has run live.

The Core already owns Recovery (``recovery_core``/``recovery_protocol``). This module only DRIVES the existing, reviewed Core operations through the existing unprivileged client and VERIFIES the
outcome read-only. It adds NO new Core authority and:

* never accepts an IP, path, command or secret (the Core derives the ISOLATE target from its own bound incident; the only free text is the bounded CLOSE summary and the bounded owner RESTORE reason);
* never publishes RESTORE, never writes SQLite, never calls nft, never speaks MQTT, never uses break-glass and never reads or stores the D4 secret (RESTORE is the owner's interactive ``aegisctl restore``
  from the PINNED release; this module only records that command's EXIT CODE);
* owns NO attempt marker: the ONE canonical, root-owned, durable stage-global marker is created by the frozen runner library immediately before ISOLATE (``p4-recovery-run-lib.sh``);
* enforces the normal-path ladder on the OPERATOR side with ONE exclusive record per step: STATUS -> PROBE -> ISOLATE -> fresh PROBE -> (owner D4) -> RESTORE_STATUS -> PROBE -> CLOSE. A step refuses unless its
  predecessors are recorded, runs ONCE, and a stop outcome ends the whole ladder (never resent). These records are an OPERATOR TRACE: operator-writable, NON-AUTHORITATIVE, never read by the final verifier;
* the root-side commands (``baseline-db``, ``final-verify``, ``verify-result``, ``containment-delta``) work only inside a root-owned directory with trusted ancestors, open the Core databases read-only
  through a WAL-aware in-memory view, and accept a PASS only from the Core's OWN durable evidence: the single R3 request/result, the single RESTORE request/publication with the correlated command-store
  ACK/STATUS, ``RECOVERY_R8_CLOSE`` and ``INCIDENT_CLOSED``, in order, with an intact audit hash chain. The Core CLOSE success is the authority that R1-R7 (including the Core's own live R2/R6/R7 probes) were
  re-evaluated: operator-supplied R2/R6/R7 observations are never an acceptance authority.
"""

from __future__ import annotations

import argparse
import calendar
import hashlib
import ipaddress
import itertools
import json
import os
import re
import sqlite3
import stat
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import local_restore as lr
from . import r1_acceptance as r1
from . import recovery_client as rc
from . import recovery_evidence as rev
from . import recovery_protocol as rp
from .ip_containment import NFT_FAMILY, NFT_TABLE, ContainmentRejected, validate_block_target

STEP_SCHEMA = "aegis.idea3.recovery-step/1"
BASELINE_SCHEMA = "aegis.idea3.recovery-baseline/1"
RESULT_SCHEMA = "aegis.idea3.recovery-result/1"
CLAIMS = {
    "F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "LVR_PROVEN": "NO", "L8_ACCEPTANCE": "NO", "L9_PROVEN": "NO",
    "R1B_RESULT": "FAIL_IMMUTABLE", "R1B_RESULT_REWRITTEN": "NO", "R1BV_RESULT": "PASS", "R1BV_RESULT_REWRITTEN": "NO", "RECOVERY_PROMOTION": "NOT_AUTOMATIC",
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
#: D4 = the owner's interactive normal-path ``aegisctl restore`` exit code (cli.py ``command_restore``). It is only an OPERATOR-SIDE HINT, never evidence:
#:   0 accepted (and, only when ``--wait`` was used, a correlated NORMAL was read back); 3 the CLI did NOT confirm NORMAL (still pending, a REJECTED ack, a non-NORMAL status or the wait deadline) - this may
#:   proceed ONLY into READ-ONLY reconciliation (RESTORE_STATUS), NEVER a resend; 1 channel unavailable (nothing sent); 2 refused or rejected; 4 OUTCOME_UNKNOWN. Everything except 0 and 3 is TERMINAL.
D4_CONTINUE = {0, 3}
D4_MEANING = {
    0: "D4_ACCEPTED", 3: "D4_NOT_CONFIRMED_NORMAL_RECONCILE_READ_ONLY", 1: "D4_CHANNEL_UNAVAILABLE_NOTHING_SENT", 2: "D4_REFUSED_OR_REJECTED", 4: "D4_OUTCOME_UNKNOWN_DO_NOT_RESEND",
}
FORBIDDEN_NEW_EVENTS = ("RESTORE_BREAK_GLASS_CLAIM", "RESTORE_BREAK_GLASS_PUBLISHED", "ALERT_ACCEPTED", "INCIDENT_BOUND", "INCIDENT_DISPOSED_HISTORICAL", "R1D_DISPOSITION_ATTEMPT_RECORDED")
MAX_WAIT_SEC = 300
#: Gates whose acceptance is the Core's own durable evidence (independently re-verified here) versus the gates the Core re-evaluated LIVE inside its CLOSE (attested by the Core CLOSE record only).
DURABLE_GATES = (rp.R1, rp.R3, rp.R4, rp.R8)
#: R5: the durable stores prove the PUBLISHED RESTORE, the ACCEPTED ack and a correlated device STATUS. That the correlated status was NORMAL exists only in the Core's in-memory physical confirmation
#: (``restore_evidence_ladder``), which the Core CLOSE re-read live: so the NORMAL state is attested by the Core CLOSE record, never by operator input.
R5_DURABLE = "ACK_ACCEPTED_STATUS_CORRELATED"
CORE_CLOSE_ATTESTED_GATES = (rp.R2, rp.R6, rp.R7)
CORE_CLOSE_ATTESTATION = "ATTESTED_BY_CORE_CLOSE"
BASELINE_FILE, RESULT_FILE, FINAL_RAN_FILE, RESULT_SHA_FILE = "recovery-baseline.json", "recovery-result.json", "RECOVERY-FINAL-RAN", "RECOVERY-RESULT-SHA256"
MARKER_CONSUMED_RE = re.compile(r"^consumed_at=(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$", re.MULTILINE)
MARKER_WORK_RE = re.compile(r"^work=(/[A-Za-z0-9._/-]+)$", re.MULTILINE)
MAX_FILE_BYTES = 1 << 20


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
    doc = {"schema": STEP_SCHEMA, "step": name, "at": time.time(), "authority": "OPERATOR_TRACE_NON_AUTHORITATIVE", **doc}
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
    """Record ONLY the exit code of the owner's interactive ``aegisctl restore``. No output, no secret, no retry, no resend.

    The code is an operator-side hint, never evidence: R4/R5 are accepted only from the Core's own correlated evidence (RESTORE_STATUS and the final verifier). Only 0 and 3 may continue, and only into
    READ-ONLY reconciliation; 1, 2, 4 and anything unexpected are terminal."""
    docs = _predecessors(steps_dir, "D4")
    if type(exit_code) is not int or not 0 <= exit_code <= 255:
        raise StageError("D4_EXIT_CODE_INVALID")
    meaning = D4_MEANING.get(exit_code, "D4_UNEXPECTED_STOP")
    cont = exit_code in D4_CONTINUE
    _write(steps_dir, "D4", {"verified": cont, "incident": docs["PROBE_POST_ISOLATE"]["incident"], "exit_code": exit_code, "meaning": meaning, "retry": "NEVER", "resend": "NEVER"})
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


_REASON_FORBIDDEN = frozenset("`$\\")


def check_reason(reason: str) -> str:
    """The existing production RESTORE-reason validator (``local_restore.reason_problem``) plus a stage-level refusal of shell-active characters. The reason is passed ONLY as one quoted argv element
    (``--reason=<value>``); it is never evaluated, expanded, sourced or written into a script."""
    problem = lr.reason_problem(reason)
    if problem:
        raise StageError(problem)
    if _REASON_FORBIDDEN & set(reason):
        raise StageError("REASON_INVALID")
    return "REASON_OK"


# ----------------------------------------------------------------------------------------------- root side: trusted directories and files


def _trusted_chain(path: str, *, owner_uid: int, trust_root: str, kind: str) -> Path:
    """``path`` is a canonical absolute path whose every component up to ``trust_root`` is a real (non-symlink) directory owned by ``owner_uid`` and not group/world writable. Production: uid 0 and ``/``."""
    target = Path(path)
    if not isinstance(path, str) or not path or not target.is_absolute() or os.path.normpath(path) != path or os.path.realpath(path) != path:
        raise StageError(f"{kind}_NOT_CANONICAL")
    current = target
    while True:
        try:
            info = os.lstat(current)
        except OSError:
            raise StageError(f"{kind}_MISSING") from None
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise StageError(f"{kind}_NOT_A_REAL_DIRECTORY")
        if info.st_uid != owner_uid or info.st_mode & 0o022:
            raise StageError(f"{kind}_NOT_TRUSTED_OWNER_OR_WRITABLE")
        if str(current) == trust_root:
            return target
        if current.parent == current:
            raise StageError(f"{kind}_TRUST_ROOT_NOT_AN_ANCESTOR")
        current = current.parent


def require_root_work(work: str, *, owner_uid: int = 0, trust_root: str = "/") -> Path:
    """The root-side work directory: trusted chain AND private (no group/other access at all)."""
    path = _trusted_chain(work, owner_uid=owner_uid, trust_root=trust_root, kind="WORK_DIR")
    if os.lstat(path).st_mode & 0o077:
        raise StageError("WORK_DIR_NOT_PRIVATE")
    return path


def _read_trusted_file(path: Path, *, owner_uid: int) -> bytes:
    """Read ONE regular, non-symlink file owned by ``owner_uid`` and not group/world writable (checked on the opened descriptor)."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise StageError("TRUSTED_FILE_UNREADABLE") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid or info.st_mode & 0o022 or info.st_nlink != 1 or info.st_size > MAX_FILE_BYTES:
            raise StageError("TRUSTED_FILE_NOT_TRUSTED")
        return os.read(fd, MAX_FILE_BYTES + 1)
    finally:
        os.close(fd)


def _create_exclusive(path: Path, text: str, mode: int = 0o400) -> None:
    """Exclusive creation (``O_EXCL``, never following a symlink); an existing file is never replaced and a failure leaves it as evidence."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    except FileExistsError:
        raise StageError(f"ALREADY_EXISTS:{path.name}") from None
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read_attempt_marker(marker: str, work: str, *, owner_uid: int = 0, trust_root: str = "/") -> dict[str, Any]:
    """The ONE canonical stage-global attempt marker: it must exist, sit under a trusted root-owned chain, be a root-owned regular file, and name THIS work directory. Returns its digest and consumed time."""
    path = Path(marker)
    _trusted_chain(str(path.parent), owner_uid=owner_uid, trust_root=trust_root, kind="MARKER_DIR")
    data = _read_trusted_file(path, owner_uid=owner_uid)
    text = data.decode("utf-8", "replace")
    stamp, bound = MARKER_CONSUMED_RE.search(text), MARKER_WORK_RE.search(text)
    if not stamp or not bound or "RECOVERY_ATTEMPT_CONSUMED=YES" not in text:
        raise StageError("ATTEMPT_MARKER_MALFORMED")
    if bound.group(1) != work:
        raise StageError("ATTEMPT_MARKER_NOT_FOR_THIS_WORK_DIR")
    return {"sha256": _sha256(data), "consumed_epoch": float(calendar.timegm(time.strptime(stamp.group(1), "%Y-%m-%dT%H:%M:%SZ")))}


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


def _audit_chain(audit_db: str) -> None:
    from . import r1bv_validation as v

    try:
        v.audit_chain_intact(audit_db)
    except v.ValidationError:
        raise StageError("AUDIT_CHAIN_BROKEN") from None


_RECOVERY_EVENTS = ("RECOVERY_R3_REQUESTED", "RECOVERY_R3_RESULT", "RESTORE_REQUESTED", "RESTORE_PUBLISHED", "RECOVERY_R8_CLOSE", "INCIDENT_CLOSED")


def baseline_db(*, audit_db: str, r1b_baseline: str, expected_source_ip: str, detector_uid: int, work: str, owner_uid: int = 0, trust_root: str = "/") -> dict[str, Any]:
    """PRE-MARKER read-only proof that the Core's single open incident is the genuine R1B-created one and that no Recovery progress exists. Writes the baseline ONLY into the root work directory, exclusively.
    Raises ``StageError`` on ANY deviation."""
    work_path = require_root_work(work, owner_uid=owner_uid, trust_root=trust_root)
    try:
        expected = str(validate_block_target(expected_source_ip, ()))
    except (ContainmentRejected, ValueError, TypeError):
        raise StageError("EXPECTED_SOURCE_NOT_AN_EXTERNALLY_CAPABLE_IPV4") from None
    if expected != expected_source_ip:
        raise StageError("EXPECTED_SOURCE_NOT_AN_EXTERNALLY_CAPABLE_IPV4")
    try:
        parent = os.lstat(os.path.dirname(r1b_baseline))
        preserved = json.loads(_read_trusted_file(Path(r1b_baseline), owner_uid=owner_uid).decode("utf-8"))
    except (OSError, ValueError, StageError):
        raise StageError("PRESERVED_R1B_BASELINE_MISSING_OR_MALFORMED") from None
    if parent.st_uid != owner_uid or parent.st_mode & 0o022 or preserved.get("schema") != r1.SCHEMA_BASELINE:
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
        marks_sql = ",".join("?" for _ in _RECOVERY_EVENTS)
        if _scalar(view, f"SELECT COUNT(*) FROM audit_logs WHERE incident_id = ? AND event_type IN ({marks_sql})", (incident["id"], *_RECOVERY_EVENTS)) != 0:
            raise StageError("RECOVERY_HISTORY_ALREADY_EXISTS_FOR_THIS_INCIDENT")
        marks = {"audit_max_id": int(_scalar(view, "SELECT COALESCE(MAX(id), 0) FROM audit_logs")), "incident_max_id": int(_scalar(view, "SELECT COALESCE(MAX(id), 0) FROM incidents"))}
    finally:
        view.close()
    _audit_chain(audit_db)  # the explicit hash-chain integrity predicate (provenance is not integrity)
    document = {"schema": BASELINE_SCHEMA, "incident_id": incident["id"], "attacker_ip": incident["attacker_ip"], **marks, "checks": {
        "RECOVERY_SINGLE_OPEN_INCIDENT": "PASS", "RECOVERY_INCIDENT_IS_THE_R1B_CREATED_ONE": "PASS", "RECOVERY_NO_PRIOR_RECOVERY_HISTORY": "PASS", "RECOVERY_AUDIT_INTEGRITY_PRE": "PASS"}}
    _create_exclusive(work_path / BASELINE_FILE, json.dumps(document, sort_keys=True, indent=2, ensure_ascii=True) + "\n")
    return document


def _load_baseline(work_path: Path, owner_uid: int) -> tuple[dict[str, Any], str]:
    raw = _read_trusted_file(work_path / BASELINE_FILE, owner_uid=owner_uid)
    try:
        baseline = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise StageError("BASELINE_INVALID") from None
    if not isinstance(baseline, dict) or baseline.get("schema") != BASELINE_SCHEMA or type(baseline.get("incident_id")) is not int:
        raise StageError("BASELINE_INVALID")
    for key in ("audit_max_id", "incident_max_id"):
        if type(baseline.get(key)) is not int:
            raise StageError("BASELINE_INVALID")
    return baseline, _sha256(raw)


def _parse_ts(text: Any) -> float:
    try:
        return float(time.mktime(time.strptime(str(text), "%Y-%m-%d %H:%M:%S")))
    except ValueError:
        raise StageError("AUDIT_TIMESTAMP_MALFORMED") from None


def final_verify(*, audit_db: str, protocol_db: str, work: str, attempt_marker: str, now: float | None = None, owner_uid: int = 0, trust_root: str = "/") -> dict[str, Any]:
    """Root-side, read-only FINAL proof, run ONCE (an exclusive ``RECOVERY-FINAL-RAN`` marker is created first and never removed).

    PASS requires the Core's OWN durable evidence only (see the module docstring). Operator step records are never read. The result and its SHA-256 sidecar are created exclusively in the root work directory."""
    work_path = require_root_work(work, owner_uid=owner_uid, trust_root=trust_root)
    baseline, baseline_sha = _load_baseline(work_path, owner_uid)
    marker = read_attempt_marker(attempt_marker, work, owner_uid=owner_uid, trust_root=trust_root)
    incident_id = baseline["incident_id"]
    _create_exclusive(work_path / FINAL_RAN_FILE, f"attempt_marker_sha256={marker['sha256']}\nbaseline_sha256={baseline_sha}\nincident_id={incident_id}\nwork={work}\n")
    view = memory_view(audit_db, {"audit_logs": rev._AUDIT_COLUMNS, "incidents": rev._INCIDENT_COLUMNS})
    try:
        row = view.execute("SELECT state, closed_at FROM incidents WHERE id = ?", (incident_id,)).fetchone()
        if row is None or row["state"] != "CLOSED" or not row["closed_at"]:
            raise StageError("INCIDENT_NOT_CLOSED")
        if _scalar(view, "SELECT COUNT(*) FROM incidents WHERE state != 'CLOSED'") != 0:
            raise StageError("OPEN_INCIDENTS_REMAIN")
        if _scalar(view, "SELECT COUNT(*) FROM incidents WHERE id > ?", (baseline["incident_max_id"],)) != 0:
            raise StageError("A_NEW_INCIDENT_APPEARED_DURING_RECOVERY")
        ids: dict[str, int] = {}
        stamps: dict[str, float] = {}
        for event in _RECOVERY_EVENTS:
            rows = view.execute("SELECT id, timestamp FROM audit_logs WHERE incident_id = ? AND event_type = ? ORDER BY id", (incident_id, event)).fetchall()
            if len(rows) != 1:
                raise StageError(f"EXPECTED_EXACTLY_ONE_{event}")
            ids[event], stamps[event] = rows[0]["id"], _parse_ts(rows[0]["timestamp"])
        if any(ids[a] >= ids[b] for a, b in itertools.pairwise(_RECOVERY_EVENTS)) or ids[_RECOVERY_EVENTS[0]] <= baseline["audit_max_id"]:
            raise StageError("RECOVERY_AUDIT_ORDER_VIOLATED")
        if stamps["RECOVERY_R3_REQUESTED"] < marker["consumed_epoch"]:  # whole-second audit stamp: the marker (written BEFORE ISOLATE) can never be later than the Core's first Recovery row
            raise StageError("ISOLATE_PRECEDES_THE_ATTEMPT_MARKER")
        marks = ",".join("?" for _ in FORBIDDEN_NEW_EVENTS)
        if _scalar(view, f"SELECT COUNT(*) FROM audit_logs WHERE id > ? AND event_type IN ({marks})", (baseline["audit_max_id"], *FORBIDDEN_NEW_EVENTS)) != 0:
            raise StageError("FORBIDDEN_EVENT_APPENDED_DURING_RECOVERY")
        if _scalar(view, "SELECT COUNT(*) FROM audit_logs WHERE id > ? AND event_type LIKE 'RESTORE_BREAK_GLASS%'", (baseline["audit_max_id"],)) != 0:
            raise StageError("BREAK_GLASS_ACTIVITY_DURING_RECOVERY")
    finally:
        view.close()
    _audit_chain(audit_db)
    document = rev.evaluate(audit_db, protocol_db=protocol_db, observations=None, incident_id=incident_id, now=time.time() if now is None else now, opener=memory_view)
    gates = {g["gate"]: g for g in document["gates"]}
    unverified = [name for name in (rp.R1, rp.R3, rp.R4) if gates[name]["verdict"] != rev.VERIFIED]
    if unverified:
        raise StageError("RECOVERY_EVIDENCE_NOT_VERIFIED:" + ",".join(f"{n}={gates[n]['verdict']}:{gates[n]['reason']}" for n in unverified))
    ladder = gates[rp.R5]["evidence"]
    if (ladder.get("published") != "PUBLISHED" or ladder.get("ack") != "ACCEPTED" or ladder.get("executed") not in ("DEVICE_STATUS_CORRELATED", "DEVICE_REPORTED_NORMAL")
            or gates[rp.R5]["verdict"] == rev.BLOCKED):
        raise StageError(f"RECOVERY_R5_NOT_THE_CORRELATED_NORMAL_PATH:{gates[rp.R5]['verdict']}:{gates[rp.R5]['reason']}")
    if not str(gates[rp.R3]["reason"]).startswith("ISOLATION_VERIFIED_LIVE_"):
        raise StageError("RECOVERY_R3_REASON_NOT_THE_VERIFIED_ISOLATION")
    result = {"schema": RESULT_SCHEMA, "result": "PASS", "reason": "OK", "incident_id": incident_id, "attempt_marker_sha256": marker["sha256"], "baseline_sha256": baseline_sha, "claims": dict(CLAIMS),
              "gates": {**{name: "VERIFIED" for name in DURABLE_GATES}, rp.R5: R5_DURABLE, **{name: CORE_CLOSE_ATTESTATION for name in CORE_CLOSE_ATTESTED_GATES}},
              "checks": {"RECOVERY_AUDIT_INTEGRITY": "PASS", "RECOVERY_R8_CORE_CLOSE_RECORDS": "PASS", "RECOVERY_NORMAL_PATH_ONLY": "PASS", "RECOVERY_NO_NEW_INCIDENT_OR_ATTACKER_EVENT": "PASS",
                         "RECOVERY_R2_R6_R7_BY_CORE_CLOSE": "ATTESTED_NOT_INDEPENDENT", "RECOVERY_R5_PHYSICAL_NORMAL_BY_CORE_CLOSE": "ATTESTED_NOT_INDEPENDENT"}}
    text = json.dumps(result, sort_keys=True, indent=2, ensure_ascii=True) + "\n"
    _create_exclusive(work_path / RESULT_FILE, text)
    _create_exclusive(work_path / RESULT_SHA_FILE, f"{_sha256(text.encode())}  {RESULT_FILE}\n")
    return result


def verify_result(*, audit_db: str, work: str, attempt_marker: str, owner_uid: int = 0, trust_root: str = "/") -> dict[str, Any]:
    """Read-only re-proof used by ``verify.sh``: a hand-written JSON file cannot satisfy it. It needs the canonical marker, the root-created ``RECOVERY-FINAL-RAN`` for THIS marker and baseline, the root-owned
    result matching its SHA-256 sidecar, the exact claim constants, the same incident, and (again) an intact audit chain with the incident closed by the Core."""
    work_path = require_root_work(work, owner_uid=owner_uid, trust_root=trust_root)
    baseline, baseline_sha = _load_baseline(work_path, owner_uid)
    marker = read_attempt_marker(attempt_marker, work, owner_uid=owner_uid, trust_root=trust_root)
    ran = _read_trusted_file(work_path / FINAL_RAN_FILE, owner_uid=owner_uid).decode("utf-8", "replace")
    expected_ran = f"attempt_marker_sha256={marker['sha256']}\nbaseline_sha256={baseline_sha}\nincident_id={baseline['incident_id']}\nwork={work}\n"
    if ran != expected_ran:
        raise StageError("FINAL_RAN_MARKER_NOT_FOR_THIS_ATTEMPT")
    raw = _read_trusted_file(work_path / RESULT_FILE, owner_uid=owner_uid)
    sidecar = _read_trusted_file(work_path / RESULT_SHA_FILE, owner_uid=owner_uid).decode("utf-8", "replace")
    if sidecar != f"{_sha256(raw)}  {RESULT_FILE}\n":
        raise StageError("RESULT_DIGEST_MISMATCH")
    try:
        doc = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise StageError("RESULT_MALFORMED") from None
    required = {**{name: "VERIFIED" for name in DURABLE_GATES}, rp.R5: R5_DURABLE, **{name: CORE_CLOSE_ATTESTATION for name in CORE_CLOSE_ATTESTED_GATES}}
    if (not isinstance(doc, dict) or doc.get("schema") != RESULT_SCHEMA or doc.get("result") != "PASS" or doc.get("reason") != "OK" or doc.get("incident_id") != baseline["incident_id"]
            or doc.get("attempt_marker_sha256") != marker["sha256"] or doc.get("baseline_sha256") != baseline_sha or doc.get("claims") != CLAIMS or doc.get("gates") != required):
        raise StageError("RESULT_NOT_THE_VERIFIED_ONE_FOR_THIS_ATTEMPT")
    checks = doc.get("checks", {})
    if checks.get("RECOVERY_R8_CORE_CLOSE_RECORDS") != "PASS" or checks.get("RECOVERY_AUDIT_INTEGRITY") != "PASS":
        raise StageError("RESULT_CHECKS_NOT_PASS")
    view = memory_view(audit_db, {"audit_logs": rev._AUDIT_COLUMNS, "incidents": rev._INCIDENT_COLUMNS})
    try:
        row = view.execute("SELECT state FROM incidents WHERE id = ?", (baseline["incident_id"],)).fetchone()
        closes = _scalar(view, "SELECT COUNT(*) FROM audit_logs WHERE incident_id = ? AND event_type IN ('RECOVERY_R8_CLOSE', 'INCIDENT_CLOSED')", (baseline["incident_id"],))
    finally:
        view.close()
    if row is None or row["state"] != "CLOSED" or closes != 2:
        raise StageError("INCIDENT_NOT_CLOSED_BY_THE_CORE")
    _audit_chain(audit_db)
    return {"incident_id": baseline["incident_id"], "attempt_marker_sha256": marker["sha256"]}


# ----------------------------------------------------------------------------------------------- root side: exact containment (nft) semantic delta


_NFT_COUNTER = re.compile(r"counter packets [0-9]+ bytes [0-9]+")
_NFT_HANDLE = re.compile(r" # handle [0-9]+")
_BLOCKED_SET = re.compile(r"^(?P<ind>[ \t]*)set[ \t]+blocked_ipv4[ \t]*\{[ \t]*\n(?P<body>.*?)\n(?P=ind)\}[ \t]*$", re.MULTILINE | re.DOTALL)
_ELEMENTS = re.compile(r"[ \t]*elements[ \t]*=[ \t]*\{(?P<items>[^}]*)\}[ \t]*\n?")
TABLE_KEY = f"fw.nft.table.{NFT_FAMILY}.{NFT_TABLE}.sha256"
RULESET_KEY = "fw.nft.ruleset.sha256"


def _nft_normalize(text: str) -> str:
    """The capture's own normalisation (``p4-l0-capture.sh::nft_normalize``): counters and handles are volatile, everything else is state."""
    return "\n".join(_NFT_HANDLE.sub("", _NFT_COUNTER.sub("counter", line), count=1) for line in text.splitlines())


def _capture_sha(normalized: str) -> str:
    return _sha256((normalized.rstrip("\n") + "\n").encode())


def _split_blocked_set(normalized: str) -> tuple[str, set[str]]:
    """(the table text with the ``blocked_ipv4`` elements clause removed, the set of IPv4 elements). Exactly one such set must exist."""
    matches = list(_BLOCKED_SET.finditer(normalized))
    if len(matches) != 1:
        raise StageError("BLOCKED_SET_NOT_EXACTLY_ONE")
    match = matches[0]
    found = _ELEMENTS.search(match.group("body"))
    elements: set[str] = set()
    if found:
        for item in found.group("items").replace("\n", " ").split(","):
            token = item.strip().split()[0] if item.strip() else ""
            if not token:
                continue
            try:
                elements.add(str(ipaddress.IPv4Address(token)))
            except ValueError:
                raise StageError("BLOCKED_SET_ELEMENT_NOT_IPV4") from None
    body = _ELEMENTS.sub("", match.group("body"), count=1).rstrip()  # an empty set prints no elements clause
    return normalized[: match.start("body")] + body + normalized[match.end("body"):], elements


def _firewall_records(bundle: str, owner_uid: int) -> dict[str, str]:
    raw = _read_trusted_file(Path(bundle) / "firewall.tsv", owner_uid=owner_uid).decode("utf-8", "replace")
    out = {}
    for line in raw.splitlines():
        key, _, value = line.partition("\t")
        if key:
            out[key] = value
    return out


def _fw_keys(record: dict[str, str]) -> set[str]:
    return {key for key in record if key.startswith("fw.nft.")}


def nft_dump_matches_capture(*, bundle: str, nft: str, owner_uid: int = 0) -> str:
    """The semantic nft dump taken for the delta proof is EXACTLY the state the generic capture hashed (so the later allowance can never mask a change that happened between the capture and the dump)."""
    record = _firewall_records(bundle, owner_uid)
    if record.get(TABLE_KEY) in (None, "UNAVAILABLE"):
        raise StageError("NFT_CAPTURE_UNAVAILABLE")
    text = _read_trusted_file(Path(nft), owner_uid=owner_uid).decode("utf-8", "replace")
    _split_blocked_set(_nft_normalize(text))  # exactly one blocked_ipv4 set with IPv4-only elements
    if _capture_sha(_nft_normalize(text)) != record[TABLE_KEY]:
        raise StageError("NFT_DUMP_NOT_THE_CAPTURED_STATE")
    return "MATCH"


def containment_delta(*, pre_bundle: str, post_bundle: str, pre_nft: str, post_nft: str, attacker_ip: str, owner_uid: int = 0) -> list[str]:
    """Prove the ONLY relevant firewall change between the PRE and POST captures is the Core-derived bound attacker ADDED to ``inet aegis_idea3 blocked_ipv4``; return the captured keys that change as a
    consequence (the only keys the generic comparator may then approve). Anything else - another table, rule, set, element, a removed element, a different address - is a refusal."""
    try:
        ip = str(ipaddress.IPv4Address(attacker_ip))
    except ValueError:
        raise StageError("ATTACKER_IP_INVALID") from None
    pre_rec, post_rec = _firewall_records(pre_bundle, owner_uid), _firewall_records(post_bundle, owner_uid)
    if _fw_keys(pre_rec) != _fw_keys(post_rec) or pre_rec.get("fw.nft.tables") != post_rec.get("fw.nft.tables") or "UNAVAILABLE" in {pre_rec.get(TABLE_KEY), post_rec.get(TABLE_KEY), pre_rec.get(RULESET_KEY), post_rec.get(RULESET_KEY)}:
        raise StageError("NFT_CAPTURE_SET_CHANGED_OR_UNAVAILABLE")
    for key in sorted(_fw_keys(pre_rec) - {TABLE_KEY, RULESET_KEY}):
        if pre_rec[key] != post_rec[key]:
            raise StageError(f"UNRELATED_FIREWALL_DRIFT:{key}")
    texts = []
    for label, path, record in (("PRE", pre_nft, pre_rec), ("POST", post_nft, post_rec)):
        text = _read_trusted_file(Path(path), owner_uid=owner_uid).decode("utf-8", "replace")
        normalized = _nft_normalize(text)
        if _capture_sha(normalized) != record.get(TABLE_KEY):
            raise StageError(f"NFT_DUMP_NOT_THE_CAPTURED_STATE:{label}")  # the semantic dump must be exactly the state the generic capture hashed
        texts.append(_split_blocked_set(normalized))
    (pre_rest, pre_elems), (post_rest, post_elems) = texts
    if pre_rest != post_rest:
        raise StageError("NFT_TABLE_CHANGED_BEYOND_THE_BLOCKED_SET_ELEMENTS")
    if ip in pre_elems or post_elems != pre_elems | {ip}:
        raise StageError("BLOCKED_SET_DELTA_IS_NOT_EXACTLY_THE_BOUND_ATTACKER")
    return [key for key in (TABLE_KEY, RULESET_KEY) if pre_rec[key] != post_rec[key]]


# ----------------------------------------------------------------------------------------------- root side: pre-marker readiness (Core configuration + timezone)


READINESS_KEYS = ("AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET", "AEGIS_RECOVERY_NETWORK_PROBE_TARGETS", "AEGIS_RECOVERY_WEB_READINESS_URL")
_TZ_SAMPLE_OFFSETS_SEC = (0, 86400 * 91, 86400 * 182, 86400 * 273, -86400 * 91, -86400 * 182)


def _probe_target_ok(target: str) -> bool:
    """The same shape ``recovery_core._tcp_probe`` accepts (``host:port``, numeric port), plus a real port range and no whitespace/control character."""
    host, _, port = target.rpartition(":")
    return bool(host) and port.isdigit() and 1 <= int(port) <= 65535 and target.isprintable() and not any(ch.isspace() for ch in target)


def config_readiness(environ: dict[str, str]) -> dict[str, str]:
    """The RUNNING Core's mandatory later Recovery settings are present and usable (the exact settings ``_run_r2``/``_run_r6``/``_run_r7`` read). Only configured/not-configured is ever reported: no value is returned."""
    management = environ.get("AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET", "").strip()
    network = [item.strip() for item in environ.get("AEGIS_RECOVERY_NETWORK_PROBE_TARGETS", "").split(",") if item.strip()]
    web = environ.get("AEGIS_RECOVERY_WEB_READINESS_URL", "").strip()
    if not management or not _probe_target_ok(management):
        raise StageError("CONFIG_NOT_READY:MANAGEMENT_PROBE_TARGET")
    if not network or not all(_probe_target_ok(item) for item in network):
        raise StageError("CONFIG_NOT_READY:NETWORK_PROBE_TARGETS")  # R6 would be NOT_CONFIGURED/FAILED and the Core would refuse CLOSE after RESTORE
    if not web.lower().startswith("https://") or len(web) <= len("https://") or not web.isprintable() or any(ch.isspace() for ch in web):
        raise StageError("CONFIG_NOT_READY:WEB_READINESS_URL")  # R7's web check is mandatory and https-only
    return {"MANAGEMENT": "CONFIGURED", "NETWORK_TARGETS": str(len(network)), "WEB": "CONFIGURED"}


def read_core_environ(pid: Any, proc_root: str = "/proc") -> dict[str, str]:
    """The listed settings (and ``TZ``) from the running Core's process environment (root-only ``/proc/<pid>/environ``); nothing else is kept, so no secret is ever held or returned."""
    if type(pid) is not int or pid <= 0:
        raise StageError("CORE_PID_INVALID")
    try:
        raw = Path(f"{proc_root}/{pid}/environ").read_bytes()
    except OSError:
        raise StageError("CORE_ENVIRON_UNREADABLE") from None
    wanted = {*READINESS_KEYS, "TZ"}
    out: dict[str, str] = {}
    for item in raw.split(b"\0"):
        key, sep, value = item.decode("utf-8", "replace").partition("=")
        if sep and key in wanted:
            out[key] = value
    return out


def _utc_offsets(tz: str | None, now: float) -> list[int]:
    saved = os.environ.get("TZ")
    try:
        if tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = tz
        time.tzset()
        return [time.localtime(now + delta).tm_gmtoff for delta in _TZ_SAMPLE_OFFSETS_SEC]
    finally:
        if saved is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = saved
        time.tzset()


def timezone_equal(core_tz: str | None, now: float | None = None) -> str:
    """Audit stamps are written by the Core with local-time ``strftime`` and read here with local-time ``mktime``: the Core's effective timezone must equal this verifier's (compared at several instants a year apart)."""
    instant = time.time() if now is None else now
    if _utc_offsets(core_tz, instant) != _utc_offsets(os.environ.get("TZ"), instant):
        raise StageError("TIMEZONE_MISMATCH")
    return "EQUAL"


def readiness(core_pid: Any, proc_root: str = "/proc") -> dict[str, str]:
    environ = read_core_environ(core_pid, proc_root)
    result = config_readiness(environ)
    result["TIMEZONE"] = timezone_equal(environ.get("TZ"))
    return result


# ----------------------------------------------------------------------------------------------- CLI


def _emit_text(path: str, text: str) -> None:
    _create_exclusive(Path(path), text)


def main(argv: list[str] | None = None, *, request: Request = default_request) -> int:
    parser = argparse.ArgumentParser(prog="aegis_soc.recovery_stage", description="Governed Recovery R2-R8 stage driver (normal path only)")
    sub = parser.add_subparsers(dest="command", required=True)
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
    reason.add_argument("--reason", required=True)
    base = sub.add_parser("baseline-db")
    for flag in ("--audit-db", "--r1b-baseline", "--expected-source-ip", "--work-dir"):
        base.add_argument(flag, required=True)
    base.add_argument("--detector-uid", type=int, required=True)
    fin = sub.add_parser("final-verify")
    for flag in ("--audit-db", "--protocol-db", "--work-dir", "--attempt-marker"):
        fin.add_argument(flag, required=True)
    ver = sub.add_parser("verify-result")
    for flag in ("--audit-db", "--work-dir", "--attempt-marker"):
        ver.add_argument(flag, required=True)
    ready = sub.add_parser("readiness")
    ready.add_argument("--core-pid", type=int, required=True)
    dump = sub.add_parser("nft-dump-check")
    for flag in ("--bundle", "--nft"):
        dump.add_argument(flag, required=True)
    delta = sub.add_parser("containment-delta")
    for flag in ("--pre-bundle", "--post-bundle", "--pre-nft", "--post-nft", "--work-dir"):
        delta.add_argument(flag, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "socket-check":
            print(f"RECOVERY_SOCKET={socket_trusted()}")
        elif args.command == "check-reason":
            print(f"RECOVERY_{check_reason(args.reason)}")
        elif args.command == "baseline-db":
            baseline_db(audit_db=args.audit_db, r1b_baseline=args.r1b_baseline, expected_source_ip=args.expected_source_ip, detector_uid=args.detector_uid, work=args.work_dir)
            print("RECOVERY_BASELINE_DB=PASS")
        elif args.command == "final-verify":
            final_verify(audit_db=args.audit_db, protocol_db=args.protocol_db, work=args.work_dir, attempt_marker=args.attempt_marker)
            print("RECOVERY_FINAL_VERIFY=PASS")
        elif args.command == "verify-result":
            verify_result(audit_db=args.audit_db, work=args.work_dir, attempt_marker=args.attempt_marker)
            print("RECOVERY_RESULT_BOUND_TO_ATTEMPT=PASS")
        elif args.command == "readiness":
            out = readiness(args.core_pid)
            print("RECOVERY_READINESS=PASS " + " ".join(f"{k}={v}" for k, v in sorted(out.items())))
        elif args.command == "nft-dump-check":
            print(f"RECOVERY_NFT_DUMP={nft_dump_matches_capture(bundle=args.bundle, nft=args.nft)}")
        elif args.command == "containment-delta":
            work_path = require_root_work(args.work_dir)
            work_baseline, _ = _load_baseline(work_path, 0)
            keys = containment_delta(pre_bundle=args.pre_bundle, post_bundle=args.post_bundle, pre_nft=args.pre_nft, post_nft=args.post_nft, attacker_ip=work_baseline["attacker_ip"])
            _emit_text(str(work_path / "allow-keys.generated"), "# Generated AFTER the exact blocked_ipv4 delta (the Core-derived bound attacker only) was proven. Nothing else is approved.\n" + "\n".join(keys) + "\n")
            print(f"RECOVERY_CONTAINMENT_DELTA=PASS ALLOWED_KEYS={len(keys)}")
        else:
            step = {"status": lambda: step_status(request, args.steps_dir), "probe-pre": lambda: step_probe_pre(request, args.steps_dir), "isolate": lambda: step_isolate(request, args.steps_dir),
                    "probe-post-isolate": lambda: step_probe_post_isolate(request, args.steps_dir), "probe-final": lambda: step_probe_final(request, args.steps_dir),
                    "restore-status": lambda: step_restore_status(request, args.steps_dir, wait_seconds=getattr(args, "wait_seconds", 0.0)),
                    "close": lambda: step_close(request, args.steps_dir, getattr(args, "summary", "")), "record-d4": lambda: record_d4(args.steps_dir, getattr(args, "exit_code", -1))}[args.command]
            out = step()
            print(f"RECOVERY_STEP={args.command.upper().replace('-', '_')} RESULT=VERIFIED " + " ".join(f"{k}={v}" for k, v in sorted(out.items()) if k != "incident"))
    except (StageError, rev.StoreProblem, r1.AcceptanceError) as error:
        code = getattr(error, "code", None) or getattr(error, "kind", None) or type(error).__name__
        print(f"RECOVERY_STEP_REFUSED reason={code}", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error) as error:
        print(f"RECOVERY_STEP_REFUSED reason={type(error).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
