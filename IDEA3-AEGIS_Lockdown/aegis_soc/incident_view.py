"""Read-only view model of the Core-attested Recovery STATUS answer for the purple Desktop (stdlib only).

The ONLY thing this module can ask the Core is ``STATUS``: the operation is a module constant and ``fetch`` never takes an
operation argument, so it cannot issue ISOLATE, PROBE, RESTORE_STATUS, CLOSE, CUT or RESTORE. It trusts nothing it receives:
every field is validated against a small allowlist, text is sanitized, and anything unexpected degrades to UNKNOWN or
NOT_AVAILABLE. The transport (identity and peer checks, bounds, fail-closed errors) is the existing ``recovery_client``; it is
injected by the launcher, so this module imports nothing from ``aegis_soc``.

Authority is stated, never inflated: every row is "Core-attested Recovery STATUS" evidence reported with the Core's own timestamp.
Recovery STATUS says nothing about the relay, the ESP32, the broker, the uplink or the Core runtime, so those are shown as
UNKNOWN. Nothing here is physical evidence.
"""

from __future__ import annotations

import ipaddress
import math
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

OP_STATUS = "STATUS"  # the single operation this module can ever request
PROTOCOL_VERSION = 1
AUTHORITY = "Core-attested Recovery STATUS (read-only)"
NOT_PHYSICAL = "Not physical evidence: this does not show the relay, cable, ESP32, broker or uplink."
STALE_AFTER_SEC = 900.0  # a VERIFIED gate check older than this is shown as STALE
FUTURE_TOLERANCE_SEC = 60.0
MAX_TEXT = 200

VERIFIED, PENDING, CHECKING, FAILED = "VERIFIED", "PENDING", "CHECKING", "FAILED"
UNKNOWN, STALE, NOT_AVAILABLE = "UNKNOWN", "STALE", "NOT_AVAILABLE"
_CORE_GATE_STATES = frozenset({VERIFIED, PENDING, CHECKING, FAILED, "NOT_CONFIGURED"})

GATES = (
    ("R1_INCIDENT_CONTEXT", "R1 Incident context"),
    ("R2_SAFE_ACCESS", "R2 Safe management access"),
    ("R3_ATTACKER_ISOLATION", "R3 Attacker isolation (software block)"),
    ("R4_RESTORE_AUTHORIZATION", "R4 RESTORE authorization (D4, owner terminal only)"),
    ("R5_PHYSICAL_RESTORE", "R5 RESTORE dispatched"),
    ("R6_NETWORK_RECOVERY", "R6 Network recovery"),
    ("R7_SERVICE_RECOVERY", "R7 Service recovery"),
    ("R8_INCIDENT_CLOSURE", "R8 Incident closure"),
)
_KNOWN_GATES = {name for name, _ in GATES}
_INCIDENT_STATES = frozenset({"OPEN", "CLOSED"})
_DANGEROUS_BIDI = frozenset({"RLO", "LRO", "RLE", "LRE", "PDF", "RLI", "LRI", "FSI", "PDI"})

# Fields the Recovery STATUS answer does not and cannot provide. Shown explicitly so their absence is never read as health.
NOT_PROVIDED = ("Core runtime", "Broker connection", "ESP32 presence", "Uplink / relay state")


def safe_text(value: Any, *, limit: int = MAX_TEXT) -> str:
    """A Core-supplied string made safe for display: printable, no control/bidi characters, bounded."""
    if not isinstance(value, str):
        return UNKNOWN
    cleaned = "".join(
        ch for ch in value
        if ch.isprintable() and unicodedata.category(ch) not in {"Cf", "Cs", "Co"}
        and unicodedata.bidirectional(ch) not in _DANGEROUS_BIDI
    ).strip()
    if not cleaned:
        return UNKNOWN
    return cleaned if len(cleaned) <= limit else cleaned[: limit - 1] + "…"


def _clock_text(epoch: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(epoch)) + " (local)"


@dataclass(frozen=True)
class GateView:
    gate: str
    label: str
    state: str  # VERIFIED PENDING CHECKING FAILED UNKNOWN STALE NOT_AVAILABLE
    summary: str
    detail: str
    authority: str
    checked_at_text: str
    age_seconds: float | None


@dataclass(frozen=True)
class IncidentView:
    incident_id: str
    state: str
    opened_at: str  # exactly as the Core reported it; no time zone is asserted
    source_ip: str


@dataclass(frozen=True)
class Snapshot:
    available: bool
    reason: str
    incident: IncidentView | None  # None with available=True means the Core reports NO open incident
    gates: tuple[GateView, ...]
    fetched_text: str
    authority: str = AUTHORITY
    not_physical: str = NOT_PHYSICAL


def unavailable(reason: str, *, now: float | None = None) -> Snapshot:
    """Fail closed: no historical value survives a failed read."""
    gates = tuple(GateView(name, label, NOT_AVAILABLE, "", "", AUTHORITY, "NOT_AVAILABLE", None) for name, label in GATES)
    return Snapshot(False, safe_text(reason), None, gates, _clock_text(time.time() if now is None else now))


def _gate_view(record: Any, name: str, label: str, now: float) -> GateView:
    if not isinstance(record, dict):
        return GateView(name, label, UNKNOWN, "", "", AUTHORITY, "UNKNOWN", None)
    status = record.get("status")
    state = status if isinstance(status, str) and status in _CORE_GATE_STATES else UNKNOWN
    if state == "NOT_CONFIGURED":
        state = NOT_AVAILABLE
    checked = record.get("checked_at")
    checked_text, age = "UNKNOWN", None
    if isinstance(checked, (int, float)) and not isinstance(checked, bool) and math.isfinite(checked) and checked > 0:
        age = now - float(checked)
        if age < -FUTURE_TOLERANCE_SEC:
            state, checked_text, age = UNKNOWN, "UNKNOWN (timestamp is in the future)", None
        else:
            checked_text = _clock_text(float(checked))
            if state == VERIFIED and age > STALE_AFTER_SEC:
                state = STALE  # an old VERIFIED is not evidence about now
    elif state == VERIFIED:
        state = UNKNOWN  # a VERIFIED claim with no usable timestamp cannot be dated, so it is not trusted
    return GateView(name, label, state, safe_text(record.get("summary")), safe_text(record.get("detail")),
                    AUTHORITY, checked_text, age)


def parse_status(payload: Any, *, now: float | None = None) -> Snapshot:
    """Validate one Recovery STATUS answer. A structurally wrong answer is NOT_AVAILABLE, never a partial guess."""
    now = time.time() if now is None else now
    if not isinstance(payload, dict) or payload.get("v") != PROTOCOL_VERSION or payload.get("ok") is not True \
            or payload.get("code") != OP_STATUS or not isinstance(payload.get("data"), dict):
        return unavailable("the Core answer was not a valid STATUS response", now=now)
    data = payload["data"]
    raw_gates = data.get("gates")
    if not isinstance(raw_gates, list):
        return unavailable("the Core STATUS answer carried no gate list", now=now)
    by_name = {}
    for record in raw_gates:
        if isinstance(record, dict) and record.get("gate") in _KNOWN_GATES and record["gate"] not in by_name:
            by_name[record["gate"]] = record
    gates = tuple(_gate_view(by_name.get(name), name, label, now) for name, label in GATES)

    raw = data.get("incident")
    incident = None
    if raw is not None:
        if not isinstance(raw, dict):
            return unavailable("the Core STATUS answer carried a malformed incident", now=now)
        ident = raw.get("id")
        address = raw.get("attacker_ip")
        try:
            source_ip = str(ipaddress.ip_address(address)) if isinstance(address, str) else UNKNOWN
        except ValueError:
            source_ip = UNKNOWN
        state = raw.get("state")
        incident = IncidentView(
            incident_id=str(ident) if isinstance(ident, int) and not isinstance(ident, bool) and ident > 0 else UNKNOWN,
            state=state if isinstance(state, str) and state in _INCIDENT_STATES else UNKNOWN,
            opened_at=safe_text(raw.get("opened_at"), limit=40),
            source_ip=source_ip,
        )
    return Snapshot(True, "Core answered STATUS", incident, gates, _clock_text(now))


def fetch(
    request: Callable[..., dict[str, Any]], errors: tuple[type[BaseException], ...], *, now: float | None = None,
) -> Snapshot:
    """One read-only STATUS request through the injected, already identity-checked transport."""
    when = time.time() if now is None else now
    try:
        payload = request(OP_STATUS)
    except errors as error:
        return unavailable(f"Core Recovery channel unavailable: {error}", now=when)
    except Exception as error:  # noqa: BLE001 - the Desktop must fail closed on anything unexpected
        return unavailable(f"unexpected {type(error).__name__} reading Core STATUS", now=when)
    return parse_status(payload, now=when)
