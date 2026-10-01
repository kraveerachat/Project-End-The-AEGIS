"""Core-mediated Recovery: the wire contract shared by the Core server and the observer UI.

Pure and dependency-free on purpose. The observer UI imports this module, so it must never import
``config`` (credential reads, demo defaults), ``database``, the MQTT adapter, the command controller,
or anything that can publish. There is deliberately no operation that carries an IP address, a path,
a command, or a secret: the Core derives every target from its own durable state.

RESTORE is not an operation here. The only production RESTORE authority is the Core-local D4 gate
(``aegisctl restore``); this channel can only *observe* it through ``RESTORE_STATUS``.
"""

from __future__ import annotations

import unicodedata
from typing import Any

PROTOCOL_VERSION = 1
MAX_MESSAGE_BYTES = 4096
DEFAULT_SOCKET_PATH = "/run/aegis-idea3-recovery/recovery.sock"

OP_STATUS = "STATUS"
OP_ISOLATE = "ISOLATE"
OP_PROBE = "PROBE"
OP_RESTORE_STATUS = "RESTORE_STATUS"
OP_CLOSE = "CLOSE"
OPS = frozenset({OP_STATUS, OP_ISOLATE, OP_PROBE, OP_RESTORE_STATUS, OP_CLOSE})

# Exactly the keys each operation may carry besides "v" and "op". Everything else is refused.
_PARAMS = {
    OP_STATUS: frozenset(),
    OP_ISOLATE: frozenset(),
    OP_PROBE: frozenset(),
    OP_RESTORE_STATUS: frozenset(),
    OP_CLOSE: frozenset({"summary"}),
}

SUMMARY_MIN_CHARS = 12
SUMMARY_MAX_CHARS = 500
_DANGEROUS_BIDI = frozenset({"RLO", "LRO", "RLE", "LRE", "PDF", "RLI", "LRI", "FSI", "PDI"})

R1 = "R1_INCIDENT_CONTEXT"
R2 = "R2_SAFE_ACCESS"
R3 = "R3_ATTACKER_ISOLATION"
R4 = "R4_RESTORE_AUTHORIZATION"
R5 = "R5_PHYSICAL_RESTORE"
R6 = "R6_NETWORK_RECOVERY"
R7 = "R7_SERVICE_RECOVERY"
R8 = "R8_INCIDENT_CLOSURE"
GATES = (R1, R2, R3, R4, R5, R6, R7, R8)

PENDING = "PENDING"
CHECKING = "CHECKING"
VERIFIED = "VERIFIED"
FAILED = "FAILED"
NOT_CONFIGURED = "NOT_CONFIGURED"
GATE_STATUSES = frozenset({PENDING, CHECKING, VERIFIED, FAILED, NOT_CONFIGURED})

#: Gates R8 needs VERIFIED before the Core will close the incident.
CLOSURE_REQUIRED = (R1, R2, R3, R4, R5, R6, R7)


class RequestError(ValueError):
    """A request the Core refuses before doing anything; ``code`` is a stable, secret-free reason."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def summary_problem(summary: Any) -> str | None:
    """Bounded, printable lessons-learned text only (the UI's one free-text field)."""
    if not isinstance(summary, str) or not summary.strip():
        return "SUMMARY_REQUIRED"
    text = summary.strip()
    if not (SUMMARY_MIN_CHARS <= len(text) <= SUMMARY_MAX_CHARS) or not text.isprintable():
        return "SUMMARY_INVALID"
    if any(
        unicodedata.category(char) in {"Cf", "Cs"} or unicodedata.bidirectional(char) in _DANGEROUS_BIDI
        for char in text
    ):
        return "SUMMARY_INVALID"
    try:
        text.encode("utf-8")
    except UnicodeError:
        return "SUMMARY_INVALID"
    return None


def validate_request(body: Any) -> tuple[str, dict[str, Any]]:
    """Strict allowlist. Returns (op, params) or raises RequestError."""
    if not isinstance(body, dict):
        raise RequestError("MALFORMED_REQUEST")
    if body.get("v") != PROTOCOL_VERSION:
        raise RequestError("MALFORMED_REQUEST")
    op = body.get("op")
    if not isinstance(op, str) or op not in OPS:
        raise RequestError("UNKNOWN_OPERATION")
    extra = set(body) - {"v", "op"}
    if not extra <= _PARAMS[op]:
        raise RequestError("MALFORMED_REQUEST")
    params = {key: body[key] for key in extra}
    if op == OP_CLOSE:
        problem = summary_problem(params.get("summary"))
        if problem:
            raise RequestError(problem)
        params["summary"] = params["summary"].strip()
    return op, params


def build_request(op: str, *, summary: str | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"v": PROTOCOL_VERSION, "op": op}
    if summary is not None:
        body["summary"] = summary
    validate_request(body)
    return body


def response(ok: bool, code: str, detail: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"v": PROTOCOL_VERSION, "ok": bool(ok), "code": code, "detail": detail, "data": data or {}}


def gate_record(gate: str, status: str, summary: str, *, detail: str = "", checked_at: float = 0.0) -> dict[str, Any]:
    if gate not in GATES or status not in GATE_STATUSES:
        raise ValueError("unknown gate or status")
    return {"gate": gate, "status": status, "summary": summary, "detail": detail, "checked_at": checked_at}
