"""Evidence-driven incident recovery (R1-R8).

Replaces the old five-step checklist, which let a button press stand in for
machine-verifiable evidence. This module is the security boundary: it is a
Tkinter-independent state machine that a UI can observe and drive, but that
independently refuses to advance past an unverified gate no matter what the
UI does. Disabled buttons are a convenience, not the boundary.

The eight gates:

    R1 INCIDENT_CONTEXT       -- bind to an existing incident, never fabricate one
    R2 SAFE_ACCESS            -- machine-verified management/OOB reachability
    R3 ATTACKER_ISOLATION     -- apply a deny rule, then independently read it back
    R4 RESTORE_AUTHORIZATION  -- explicit human authorization for this incident
    R5 PHYSICAL_RESTORE       -- correlated ACK *and* correlated STATUS=NORMAL
    R6 NETWORK_RECOVERY       -- bounded, read-only network reachability probes
    R7 SERVICE_RECOVERY       -- genuine service readiness, optional adapters excluded
    R8 INCIDENT_CLOSURE       -- fail-closed: every mandatory gate must be VERIFIED

Core invariant this module enforces end to end:

    REQUESTED != PUBLISHED != ACK_CORRELATED != STATUS_CORRELATED
    != PHYSICAL_RESTORE_VERIFIED != NETWORK_RECOVERED != SERVICE_READY
    != INCIDENT_CLOSED

Never store or log PIN, password, private keys, tokens, or MQTT credentials:
gate evidence carries only identifiers, statuses, and non-secret detail text.
"""

from __future__ import annotations

import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from enum import Enum

from . import config
from . import database as db
from .ip_containment import ContainmentClient, ContainmentRejected, ContainmentUnavailable, parse_ipv4


class GateStatus(str, Enum):
    PENDING = "PENDING"
    CHECKING = "CHECKING"
    VERIFIED = "VERIFIED"
    FAILED = "FAILED"
    NOT_CONFIGURED = "NOT_CONFIGURED"
    NOT_APPLICABLE = "NOT_APPLICABLE"
    SIMULATED = "SIMULATED"


#: Statuses that count as satisfying a gate's dependency for progression or closure.
_SATISFIED = frozenset({GateStatus.VERIFIED, GateStatus.NOT_APPLICABLE})


class Gate(str, Enum):
    R1_INCIDENT_CONTEXT = "R1_INCIDENT_CONTEXT"
    R2_SAFE_ACCESS = "R2_SAFE_ACCESS"
    R3_ATTACKER_ISOLATION = "R3_ATTACKER_ISOLATION"
    R4_RESTORE_AUTHORIZATION = "R4_RESTORE_AUTHORIZATION"
    R5_PHYSICAL_RESTORE = "R5_PHYSICAL_RESTORE"
    R6_NETWORK_RECOVERY = "R6_NETWORK_RECOVERY"
    R7_SERVICE_RECOVERY = "R7_SERVICE_RECOVERY"
    R8_INCIDENT_CLOSURE = "R8_INCIDENT_CLOSURE"


#: Gates R8 requires to be VERIFIED or NOT_APPLICABLE before it will close.
CLOSURE_REQUIRED_GATES = (
    Gate.R1_INCIDENT_CONTEXT,
    Gate.R2_SAFE_ACCESS,
    Gate.R3_ATTACKER_ISOLATION,
    Gate.R4_RESTORE_AUTHORIZATION,
    Gate.R5_PHYSICAL_RESTORE,
    Gate.R6_NETWORK_RECOVERY,
    Gate.R7_SERVICE_RECOVERY,
)

#: Gates R5 (RESTORE) requires to already be VERIFIED before it may be requested.
RESTORE_REQUIRED_GATES = (
    Gate.R1_INCIDENT_CONTEXT,
    Gate.R2_SAFE_ACCESS,
    Gate.R3_ATTACKER_ISOLATION,
    Gate.R4_RESTORE_AUTHORIZATION,
)


class RestorePhase(str, Enum):
    NOT_REQUESTED = "NOT_REQUESTED"
    SIMULATED = "SIMULATED"
    PUBLISHED = "PUBLISHED"
    ACK_REJECTED = "ACK_REJECTED"
    LOCKDOWN_AFTER_RESTORE = "LOCKDOWN_AFTER_RESTORE"
    VERIFIED = "VERIFIED"


@dataclass(frozen=True)
class GateEvidence:
    """Safe, loggable evidence for one gate. Never carries a secret."""

    gate: Gate
    status: GateStatus
    checked_at: float
    summary: str
    detail: str = ""
    evidence_source: str = ""

    def as_safe_dict(self) -> dict:
        return {
            "gate": self.gate.value,
            "status": self.status.value,
            "checked_at": self.checked_at,
            "summary": self.summary,
            "detail": self.detail,
            "evidence_source": self.evidence_source,
        }


def _pending(gate: Gate) -> GateEvidence:
    return GateEvidence(gate=gate, status=GateStatus.PENDING, checked_at=0.0, summary="Not yet checked")


def _tcp_probe(target: str, timeout: float = 2.0) -> tuple[bool, str]:
    """Bounded, read-only, no-mutation reachability probe for host:port."""
    host, _, port_text = target.rpartition(":")
    if not host or not port_text.isdigit():
        return False, f"invalid probe target: {target!r}"
    try:
        with socket.create_connection((host, int(port_text)), timeout=timeout):
            return True, f"tcp connect to {target} ok"
    except OSError as error:
        return False, f"tcp connect to {target} failed: {type(error).__name__}: {error}"


def _http_readiness_probe(url: str, timeout: float = 2.0) -> tuple[bool, str]:
    """Bounded, read-only GET against an existing readiness/health endpoint."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            body = response.read(2048)
        return True, body.decode("utf-8", errors="replace")[:200]
    except (urllib.error.URLError, OSError, ValueError) as error:
        return False, f"{type(error).__name__}: {error}"


class RecoveryCoordinator:
    """Enforces R1-R8 progression independently of whatever the UI shows.

    One coordinator is bound to at most one incident at a time. It never
    talks to Tkinter; a UI observes ``gate()``/``all_gates()`` and drives
    progression by calling the ``*_`` verification methods, and forwards
    already-verified MQTT ACK/STATUS evidence via ``on_ack_evidence`` /
    ``on_status_evidence``.
    """

    def __init__(self) -> None:
        self.incident_id: int | None = None
        self._incident_attacker_ip: str | None = None
        self._gates: dict[Gate, GateEvidence] = {}
        self._restore_phase = RestorePhase.NOT_REQUESTED
        # One-shot: set before RESTORE is handed to the controller, cleared only when nothing could have been sent.
        self._restore_attempted = False
        self._restore_msg_id: str | None = None
        self._restore_seq: int | None = None
        self._restore_ack_ok: bool | None = None
        self._restore_status_value: str | None = None

    # ---- introspection ----------------------------------------------------

    def gate(self, gate: Gate) -> GateEvidence:
        return self._gates.get(gate, _pending(gate))

    def all_gates(self) -> list[GateEvidence]:
        return [self.gate(g) for g in Gate]

    @property
    def restore_already_requested(self) -> bool:
        """True once a RESTORE attempt is spent; it is never issued a second time for this incident."""
        return self._restore_attempted

    def ready_to_close(self) -> bool:
        return all(self.gate(g).status in _SATISFIED for g in CLOSURE_REQUIRED_GATES)

    def _set(self, gate: Gate, status: GateStatus, summary: str, *, detail: str = "", evidence_source: str = "") -> GateEvidence:
        evidence = GateEvidence(
            gate=gate, status=status, checked_at=time.time(), summary=summary, detail=detail, evidence_source=evidence_source,
        )
        self._gates[gate] = evidence
        return evidence

    def _blocked_by(self, *dependencies: Gate) -> Gate | None:
        for dependency in dependencies:
            if self.gate(dependency).status not in _SATISFIED:
                return dependency
        return None

    # ---- R1: incident context ----------------------------------------------

    def resolve_incident_context(self, *, incident: dict | None = None, get_open_incident=None) -> GateEvidence:
        """Bind to an existing recoverable incident. Never creates a new one."""
        lookup = get_open_incident or db.get_open_incident
        resolved = incident if incident is not None else lookup()
        if not resolved or resolved.get("state") == "CLOSED":
            if self.incident_id is not None:
                self._reset_for_new_incident()
            self.incident_id = None
            self._incident_attacker_ip = None
            return self._set(Gate.R1_INCIDENT_CONTEXT, GateStatus.FAILED, "No recoverable incident is currently open")
        new_incident_id = resolved["id"]
        if self.incident_id is not None and self.incident_id != new_incident_id:
            self._reset_for_new_incident()
        self.incident_id = new_incident_id
        self._incident_attacker_ip = resolved.get("attacker_ip") or None
        detail_parts = [f"state={resolved['state']}"]
        if resolved.get("attacker_ip"):
            detail_parts.append(f"attacker_ip={resolved['attacker_ip']}")
        if resolved.get("opened_at"):
            detail_parts.append(f"opened_at={resolved['opened_at']}")
        return self._set(
            Gate.R1_INCIDENT_CONTEXT, GateStatus.VERIFIED, f"Bound to incident #{self.incident_id}",
            detail="; ".join(detail_parts), evidence_source="database.get_open_incident",
        )

    def _reset_for_new_incident(self) -> None:
        """Authorization and progress from a prior incident never carry over."""
        for gate in (
            Gate.R2_SAFE_ACCESS, Gate.R3_ATTACKER_ISOLATION, Gate.R4_RESTORE_AUTHORIZATION,
            Gate.R5_PHYSICAL_RESTORE, Gate.R6_NETWORK_RECOVERY, Gate.R7_SERVICE_RECOVERY,
            Gate.R8_INCIDENT_CLOSURE,
        ):
            self._gates.pop(gate, None)
        self._restore_phase = RestorePhase.NOT_REQUESTED
        self._restore_attempted = False
        self._restore_msg_id = None
        self._restore_seq = None
        self._restore_ack_ok = None
        self._restore_status_value = None

    def abandon_restore_authorization(self) -> None:
        """Explicitly drop a stale/abandoned authorization (session close, timeout)."""
        self._gates.pop(Gate.R4_RESTORE_AUTHORIZATION, None)

    # ---- R2: safe management access ----------------------------------------

    def verify_safe_access(self, *, prober=None) -> GateEvidence:
        blocked = self._blocked_by(Gate.R1_INCIDENT_CONTEXT)
        if blocked:
            return self._set(Gate.R2_SAFE_ACCESS, GateStatus.FAILED, f"{blocked.value} is not verified")
        target = config.RECOVERY_MANAGEMENT_PROBE_TARGET
        if not target:
            return self._set(
                Gate.R2_SAFE_ACCESS, GateStatus.NOT_CONFIGURED,
                "No management probe target is configured (AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET)",
            )
        probe = prober or _tcp_probe
        ok, detail = probe(target)
        status = GateStatus.VERIFIED if ok else GateStatus.FAILED
        summary = "Management access probe reachable" if ok else "Management access probe unreachable"
        return self._set(Gate.R2_SAFE_ACCESS, status, summary, detail=detail, evidence_source=target)

    # ---- R3: attacker isolation ---------------------------------------------

    def apply_and_verify_attacker_isolation(self, ip: str, *, containment_client=None) -> GateEvidence:
        blocked = self._blocked_by(Gate.R1_INCIDENT_CONTEXT)
        if blocked:
            return self._set(Gate.R3_ATTACKER_ISOLATION, GateStatus.FAILED, f"{blocked.value} is not verified")
        try:
            address = str(parse_ipv4(ip))
        except ContainmentRejected as error:
            return self._set(Gate.R3_ATTACKER_ISOLATION, GateStatus.FAILED, f"Attacker IP rejected: {error.reason_code}")

        # The target must be the attacker bound by R1; free text never reaches containment.
        try:
            bound = str(parse_ipv4(self._incident_attacker_ip))
        except ContainmentRejected:
            return self._set(
                Gate.R3_ATTACKER_ISOLATION, GateStatus.FAILED, "The bound incident has no valid attacker_ip to isolate",
            )
        if address != bound:
            return self._set(
                Gate.R3_ATTACKER_ISOLATION, GateStatus.FAILED,
                "R3 target does not match the attacker_ip bound by the active incident; nothing was applied",
            )

        client = containment_client or ContainmentClient()
        try:
            apply_response = client.block(address)
        except ContainmentUnavailable as error:
            return self._set(Gate.R3_ATTACKER_ISOLATION, GateStatus.FAILED, "Containment apply unavailable", detail=str(error))
        if not apply_response.get("ok"):
            return self._set(
                Gate.R3_ATTACKER_ISOLATION, GateStatus.FAILED, "Containment apply rejected",
                detail=str(apply_response.get("reason_code")),
            )

        try:
            verify_response = client.contains(address)
        except ContainmentUnavailable as error:
            return self._set(Gate.R3_ATTACKER_ISOLATION, GateStatus.FAILED, "Containment verify unavailable", detail=str(error))
        if verify_response.get("ok") and verify_response.get("present") is True:
            return self._set(
                Gate.R3_ATTACKER_ISOLATION, GateStatus.VERIFIED, f"{address} confirmed blocked (read-back verified)",
                evidence_source="ip_containment.ContainmentClient",
            )
        return self._set(
            Gate.R3_ATTACKER_ISOLATION, GateStatus.FAILED,
            "Containment read-back did not confirm the exact attacker IP is blocked",
            detail=str(verify_response),
        )

    # ---- R4: restore authorization -------------------------------------------

    def authorize_restore(self, pin: str, *, origin: str = "recovery-wizard", verify_pin=None) -> GateEvidence:
        blocked = self._blocked_by(Gate.R1_INCIDENT_CONTEXT)
        if blocked:
            return self._set(Gate.R4_RESTORE_AUTHORIZATION, GateStatus.FAILED, f"{blocked.value} is not verified")
        if origin == "telegram":
            return self._set(Gate.R4_RESTORE_AUTHORIZATION, GateStatus.FAILED, "Telegram can never authorize RESTORE")
        verifier = verify_pin or config.verify_pin
        if not verifier(pin):
            return self._set(Gate.R4_RESTORE_AUTHORIZATION, GateStatus.FAILED, "Authorization denied: PIN did not verify")
        return self._set(
            Gate.R4_RESTORE_AUTHORIZATION, GateStatus.VERIFIED, f"Restore authorized for incident #{self.incident_id}",
            evidence_source=origin,
        )

    # ---- R5: physical restore -------------------------------------------------

    def request_physical_restore(self, controller, *, origin: str = "recovery-wizard") -> GateEvidence:
        if self._restore_attempted:
            # A spent attempt (published, dry-run, or unknown outcome) is never repeated; report it unchanged.
            return self.gate(Gate.R5_PHYSICAL_RESTORE)
        blocked = self._blocked_by(*RESTORE_REQUIRED_GATES)
        if blocked:
            return self._set(Gate.R5_PHYSICAL_RESTORE, GateStatus.FAILED, f"RESTORE blocked: {blocked.value} is not verified")

        # Spent before the call: if issue() raises, the outcome is unknown and must not be retried.
        self._restore_attempted = True
        result = controller.issue(
            "RESTORE_UPLINK", f"Evidence-driven recovery for incident #{self.incident_id}",
            origin=origin, authorize_restore=True,
        )
        if result.dry_run:
            self._restore_phase = RestorePhase.SIMULATED
            self._restore_msg_id = None
            return self._set(
                Gate.R5_PHYSICAL_RESTORE, GateStatus.SIMULATED,
                "RESTORE_UPLINK simulated (dry-run); no physical evidence exists", detail=result.detail,
            )
        if not result.sent:
            self._restore_attempted = False  # refused or unsendable: nothing left the Core, so no attempt was spent
            self._restore_phase = RestorePhase.NOT_REQUESTED
            return self._set(
                Gate.R5_PHYSICAL_RESTORE, GateStatus.FAILED, f"RESTORE_UPLINK was not sent: {result.detail}",
                detail=result.reason_code or "",
            )
        self._restore_phase = RestorePhase.PUBLISHED
        self._restore_msg_id = result.nonce
        self._restore_seq = result.seq
        self._restore_ack_ok = None
        self._restore_status_value = None
        return self._set(
            Gate.R5_PHYSICAL_RESTORE, GateStatus.CHECKING,
            "RESTORE_UPLINK published; waiting for correlated ACK and correlated STATUS=NORMAL",
            evidence_source=f"msg_id={result.nonce}",
        )

    def on_ack_evidence(self, ack: str, result: str, ack_for_msg_id: str | None) -> None:
        """Forwarded from MQTTManager.ack_callback -- already store-correlated."""
        if self._restore_phase != RestorePhase.PUBLISHED:
            return
        if not ack_for_msg_id or ack_for_msg_id != self._restore_msg_id:
            return
        self._restore_ack_ok = ack == "OK"
        if not self._restore_ack_ok:
            self._restore_phase = RestorePhase.ACK_REJECTED
        self._recompute_restore(ack_result=result)

    def on_status_evidence(self, state: str, rssi: int, heap: int, command_nonce: str | None) -> None:
        """Forwarded from MQTTManager.status_callback -- already store-correlated."""
        if self._restore_phase not in (RestorePhase.PUBLISHED, RestorePhase.LOCKDOWN_AFTER_RESTORE):
            return
        if not command_nonce or command_nonce != self._restore_msg_id:
            return
        self._restore_status_value = state
        if state == "LOCKDOWN":
            self._restore_phase = RestorePhase.LOCKDOWN_AFTER_RESTORE
        self._recompute_restore()

    def _recompute_restore(self, *, ack_result: str = "") -> None:
        if self._restore_ack_ok is False:
            self._set(
                Gate.R5_PHYSICAL_RESTORE, GateStatus.FAILED, "RESTORE_UPLINK ACK was rejected by the device",
                detail=ack_result, evidence_source=f"msg_id={self._restore_msg_id}",
            )
            return
        if self._restore_status_value == "LOCKDOWN":
            self._set(
                Gate.R5_PHYSICAL_RESTORE, GateStatus.FAILED,
                "Correlated STATUS=LOCKDOWN after RESTORE_UPLINK; physical restore did not happen",
                evidence_source=f"msg_id={self._restore_msg_id}",
            )
            return
        if self._restore_ack_ok is True and self._restore_status_value == "NORMAL":
            self._restore_phase = RestorePhase.VERIFIED
            self._set(
                Gate.R5_PHYSICAL_RESTORE, GateStatus.VERIFIED,
                "Correlated ACK accepted and correlated STATUS=NORMAL received",
                evidence_source=f"msg_id={self._restore_msg_id}",
            )
            return
        waiting_for = []
        if self._restore_ack_ok is not True:
            waiting_for.append("ACK")
        if self._restore_status_value != "NORMAL":
            waiting_for.append("STATUS=NORMAL")
        self._set(
            Gate.R5_PHYSICAL_RESTORE, GateStatus.CHECKING, f"Waiting for correlated {' and '.join(waiting_for)}",
            evidence_source=f"msg_id={self._restore_msg_id}",
        )

    # ---- R6: network recovery -------------------------------------------------

    def verify_network_recovery(self, *, prober=None) -> GateEvidence:
        blocked = self._blocked_by(Gate.R5_PHYSICAL_RESTORE)
        if blocked:
            return self._set(Gate.R6_NETWORK_RECOVERY, GateStatus.FAILED, f"{blocked.value} is not verified")
        targets = [t.strip() for t in config.RECOVERY_NETWORK_PROBE_TARGETS.split(",") if t.strip()]
        if not targets:
            return self._set(
                Gate.R6_NETWORK_RECOVERY, GateStatus.NOT_CONFIGURED,
                "No mandatory network probe targets are configured (AEGIS_RECOVERY_NETWORK_PROBE_TARGETS)",
            )
        probe = prober or _tcp_probe
        results = {target: probe(target) for target in targets}
        failed = [target for target, (ok, _detail) in results.items() if not ok]
        detail = "; ".join(f"{target}={detail}" for target, (_ok, detail) in results.items())
        if failed:
            return self._set(
                Gate.R6_NETWORK_RECOVERY, GateStatus.FAILED, f"Network probe(s) failed: {', '.join(failed)}", detail=detail,
            )
        return self._set(
            Gate.R6_NETWORK_RECOVERY, GateStatus.VERIFIED, f"{len(targets)} network probe(s) passed",
            detail=detail, evidence_source=",".join(targets),
        )

    # ---- R7: service recovery ---------------------------------------------------

    def verify_service_recovery(self, *, core_probe=None, mqtt_manager=None, web_probe=None, idea1_probe=None, idea2_probe=None) -> GateEvidence:
        blocked = self._blocked_by(Gate.R6_NETWORK_RECOVERY)
        if blocked:
            return self._set(Gate.R7_SERVICE_RECOVERY, GateStatus.FAILED, f"{blocked.value} is not verified")

        mandatory: dict[str, tuple[bool | None, str]] = {}
        core_check = core_probe or db.ping
        try:
            mandatory["core"] = (bool(core_check()), "database self-check")
        except Exception as error:  # a failing probe is evidence, not a crash
            mandatory["core"] = (False, f"core probe raised {type(error).__name__}: {error}")

        mqtt_ok = bool(getattr(mqtt_manager, "is_connected", False)) if mqtt_manager is not None else False
        mandatory["mqtt"] = (mqtt_ok, "MQTTManager.is_connected" if mqtt_manager is not None else "no MQTT manager provided")

        web_url = config.RECOVERY_WEB_READINESS_URL
        if not web_url:
            mandatory["web"] = (None, "NOT_CONFIGURED (AEGIS_RECOVERY_WEB_READINESS_URL)")
        else:
            ok, detail = (web_probe or _http_readiness_probe)(web_url)
            mandatory["web"] = (ok, detail)

        optional: dict[str, tuple[bool | None, str]] = {}
        for name, url, probe_fn in (
            ("idea1", config.RECOVERY_IDEA1_READINESS_URL, idea1_probe),
            ("idea2", config.RECOVERY_IDEA2_READINESS_URL, idea2_probe),
        ):
            if not url:
                optional[name] = (None, "ADAPTER_UNAVAILABLE")
            else:
                ok, detail = (probe_fn or _http_readiness_probe)(url)
                optional[name] = (ok, detail)

        detail = str({**mandatory, **optional})
        incomplete = [name for name, (ok, _detail) in mandatory.items() if ok is not True]
        if incomplete:
            status = GateStatus.NOT_CONFIGURED if all(mandatory[name][0] is None for name in incomplete) else GateStatus.FAILED
            return self._set(
                Gate.R7_SERVICE_RECOVERY, status, f"Mandatory service(s) not ready: {', '.join(incomplete)}", detail=detail,
            )
        return self._set(Gate.R7_SERVICE_RECOVERY, GateStatus.VERIFIED, "All mandatory services report ready", detail=detail)

    # ---- R8: incident closure -------------------------------------------------

    def close_incident(self, summary: str, *, close_fn=None) -> GateEvidence:
        if self.gate(Gate.R8_INCIDENT_CLOSURE).status == GateStatus.VERIFIED:
            return self.gate(Gate.R8_INCIDENT_CLOSURE)  # already closed; never write twice
        incomplete = [g for g in CLOSURE_REQUIRED_GATES if self.gate(g).status not in _SATISFIED]
        if incomplete:
            return self._set(
                Gate.R8_INCIDENT_CLOSURE, GateStatus.FAILED,
                f"Cannot close: incomplete gate(s) {', '.join(g.value for g in incomplete)}",
            )
        if not summary or not summary.strip():
            return self._set(Gate.R8_INCIDENT_CLOSURE, GateStatus.FAILED, "Lessons-learned summary is required to close")
        if self.incident_id is None:
            return self._set(Gate.R8_INCIDENT_CLOSURE, GateStatus.FAILED, "No incident is bound to this recovery session")

        closer = close_fn or db.close_incident
        closer(self.incident_id, summary)
        db.log_event_strict("INCIDENT_CLOSED", summary, db.INFO, self.incident_id)
        return self._set(
            Gate.R8_INCIDENT_CLOSURE, GateStatus.VERIFIED, f"Incident #{self.incident_id} closed with full evidence chain",
            evidence_source="database.close_incident",
        )
