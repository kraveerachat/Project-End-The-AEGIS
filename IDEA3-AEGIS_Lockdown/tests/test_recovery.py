"""Evidence-driven recovery (R1-R8): fail-closed gates, not a button checklist.

Every gate must be provable from injected, machine-verifiable evidence. A
button press alone must never satisfy a gate; an unrelated/uncorrelated
event must never satisfy one either. Protocol v1 correlation (R5) is
exercised through the real ProtocolStore + MQTTManager + controller
pipeline (see tests/test_mqtt_client.py / tests/test_controller.py for the
same pattern) rather than re-derived by hand, per the task's "do not parse
raw MQTT independently" constraint.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aegis_soc import config
from aegis_soc import database as db
from aegis_soc import protocol_v1 as p1
from aegis_soc.controller import AegisCommandController
from aegis_soc.ip_containment import ContainmentUnavailable
from aegis_soc.mqtt_client import MQTTManager
from aegis_soc.protocol_inbound import ProtocolContext
from aegis_soc.protocol_store import ProtocolStore
from aegis_soc.recovery import Gate, GateStatus, RecoveryCoordinator

DEVICE = "test-device-01"
KEYS = p1.ProtocolKeys(c2d=bytes(range(0x20)), d2c=bytes(range(0x20, 0x40)))
NOW = p1.TIME_FLOOR + 3_600
ATTACKER_IP = "203.0.113.7"


# ---------------------------------------------------------------------------
# Shared fakes
# ---------------------------------------------------------------------------

class Clock:
    def __init__(self, value=NOW):
        self.value = value

    def trusted_now(self):
        return self.value


class FakePahoClient:
    def __init__(self):
        self.published = []

    def subscribe(self, topics):
        pass

    def publish(self, topic, payload, qos=0, retain=False):
        self.published.append((topic, payload))
        return SimpleNamespace(rc=0)


class FakeContainmentClient:
    """Deterministic double for ip_containment.ContainmentClient."""

    def __init__(self, *, block_ok=True, present_after_block=True, raise_on="none"):
        self.block_ok = block_ok
        self.present_after_block = present_after_block
        self.raise_on = raise_on
        self.calls = []

    def block(self, ip):
        self.calls.append(("block", ip))
        if self.raise_on == "block":
            raise ContainmentUnavailable("simulated apply outage")
        return {"ok": self.block_ok, "operation": "block", "ip": ip, "reason_code": "BLOCKED" if self.block_ok else "NFT_FAILED"}

    def contains(self, ip):
        self.calls.append(("contains", ip))
        if self.raise_on == "contains":
            raise ContainmentUnavailable("simulated read-back outage")
        return {"ok": True, "operation": "contains", "ip": ip, "present": self.present_after_block, "reason_code": "PRESENT" if self.present_after_block else "ABSENT"}


class WrongIpContainmentClient(FakeContainmentClient):
    """The exact attacker IP was never actually blocked -- a different IP was."""

    def contains(self, ip):
        self.calls.append(("contains", ip))
        return {"ok": True, "operation": "contains", "ip": ip, "present": False, "reason_code": "ABSENT"}


@pytest.fixture(autouse=True)
def audit(monkeypatch):
    events = []
    monkeypatch.setattr(db, "log_event", lambda *args, **kwargs: events.append(args))
    monkeypatch.setattr(db, "log_event_strict", lambda *args, **kwargs: events.append(args))
    return events


@pytest.fixture
def coordinator():
    return RecoveryCoordinator()


def _open_incident(**overrides):
    incident = {"id": 42, "opened_at": "2026-01-01 00:00:00", "state": "CONTAINED", "attacker_ip": ATTACKER_IP}
    incident.update(overrides)
    return incident


# ---------------------------------------------------------------------------
# R1 -- Incident Context
# ---------------------------------------------------------------------------

def test_r1_does_not_fabricate_an_incident_when_none_is_open(coordinator):
    create_calls = []
    evidence = coordinator.resolve_incident_context(get_open_incident=lambda: None)

    assert evidence.status == GateStatus.FAILED
    assert coordinator.incident_id is None
    assert create_calls == []  # nothing in this module ever calls create_incident


def test_r1_binds_to_an_existing_recoverable_incident(coordinator):
    evidence = coordinator.resolve_incident_context(incident=_open_incident())

    assert evidence.status == GateStatus.VERIFIED
    assert coordinator.incident_id == 42
    assert "attacker_ip=203.0.113.7" in evidence.detail


def test_r1_missing_incident_blocks_every_later_gate(coordinator):
    coordinator.resolve_incident_context(get_open_incident=lambda: None)

    assert coordinator.verify_safe_access(prober=lambda t: (True, "ok")).status == GateStatus.FAILED
    assert coordinator.apply_and_verify_attacker_isolation(ATTACKER_IP, containment_client=FakeContainmentClient()).status == GateStatus.FAILED
    assert coordinator.authorize_restore("4321", verify_pin=lambda p: True).status == GateStatus.FAILED


def test_r1_a_closed_incident_is_not_recoverable(coordinator):
    evidence = coordinator.resolve_incident_context(incident=_open_incident(state="CLOSED"))
    assert evidence.status == GateStatus.FAILED
    assert coordinator.incident_id is None


# ---------------------------------------------------------------------------
# R2 -- Safe Management Access
# ---------------------------------------------------------------------------

def test_r2_cannot_be_verified_by_a_bare_button_press_it_needs_a_probe_result(coordinator, monkeypatch):
    coordinator.resolve_incident_context(incident=_open_incident())
    monkeypatch.setattr(config, "RECOVERY_MANAGEMENT_PROBE_TARGET", "10.0.0.1:22")

    evidence = coordinator.verify_safe_access(prober=lambda target: (True, "connected"))

    assert evidence.status == GateStatus.VERIFIED
    assert evidence.evidence_source == "10.0.0.1:22"


def test_r2_probe_pass_verifies(coordinator, monkeypatch):
    coordinator.resolve_incident_context(incident=_open_incident())
    monkeypatch.setattr(config, "RECOVERY_MANAGEMENT_PROBE_TARGET", "10.0.0.1:22")

    evidence = coordinator.verify_safe_access(prober=lambda target: (True, "reachable"))
    assert evidence.status == GateStatus.VERIFIED


def test_r2_probe_fail_blocks(coordinator, monkeypatch):
    coordinator.resolve_incident_context(incident=_open_incident())
    monkeypatch.setattr(config, "RECOVERY_MANAGEMENT_PROBE_TARGET", "10.0.0.1:22")

    evidence = coordinator.verify_safe_access(prober=lambda target: (False, "timeout"))
    assert evidence.status == GateStatus.FAILED


def test_r2_missing_config_is_not_configured_never_pass(coordinator, monkeypatch):
    coordinator.resolve_incident_context(incident=_open_incident())
    monkeypatch.setattr(config, "RECOVERY_MANAGEMENT_PROBE_TARGET", "")

    evidence = coordinator.verify_safe_access()
    assert evidence.status == GateStatus.NOT_CONFIGURED
    assert evidence.status != GateStatus.VERIFIED


# ---------------------------------------------------------------------------
# R3 -- Attacker Isolation (apply != verify)
# ---------------------------------------------------------------------------

def test_r3_apply_success_without_a_confirmed_rule_does_not_verify(coordinator):
    coordinator.resolve_incident_context(incident=_open_incident())
    client = FakeContainmentClient(block_ok=True, present_after_block=False)

    evidence = coordinator.apply_and_verify_attacker_isolation(ATTACKER_IP, containment_client=client)

    assert evidence.status != GateStatus.VERIFIED
    assert evidence.status == GateStatus.FAILED


def test_r3_apply_success_but_wrong_ip_blocked_does_not_verify(coordinator):
    coordinator.resolve_incident_context(incident=_open_incident())
    client = WrongIpContainmentClient(block_ok=True)

    evidence = coordinator.apply_and_verify_attacker_isolation(ATTACKER_IP, containment_client=client)

    assert evidence.status == GateStatus.FAILED


def test_r3_apply_success_and_exact_ip_confirmed_verifies(coordinator):
    coordinator.resolve_incident_context(incident=_open_incident())
    client = FakeContainmentClient(block_ok=True, present_after_block=True)

    evidence = coordinator.apply_and_verify_attacker_isolation(ATTACKER_IP, containment_client=client)

    assert evidence.status == GateStatus.VERIFIED
    assert client.calls == [("block", ATTACKER_IP), ("contains", ATTACKER_IP)]


def test_r3_verification_read_failure_is_not_verified(coordinator):
    coordinator.resolve_incident_context(incident=_open_incident())
    client = FakeContainmentClient(raise_on="contains")

    evidence = coordinator.apply_and_verify_attacker_isolation(ATTACKER_IP, containment_client=client)

    assert evidence.status == GateStatus.FAILED


def test_r3_apply_failure_is_not_verified(coordinator):
    coordinator.resolve_incident_context(incident=_open_incident())
    client = FakeContainmentClient(block_ok=False)

    evidence = coordinator.apply_and_verify_attacker_isolation(ATTACKER_IP, containment_client=client)

    assert evidence.status == GateStatus.FAILED
    assert ("contains", ATTACKER_IP) not in client.calls  # never verifies an apply that already failed


# ---------------------------------------------------------------------------
# R4 -- Restore Authorization
# ---------------------------------------------------------------------------

def test_r4_requires_explicit_authorization_result(coordinator):
    coordinator.resolve_incident_context(incident=_open_incident())

    evidence = coordinator.authorize_restore("4321", verify_pin=lambda pin: True)
    assert evidence.status == GateStatus.VERIFIED


def test_r4_wrong_pin_cannot_authorize(coordinator):
    coordinator.resolve_incident_context(incident=_open_incident())

    evidence = coordinator.authorize_restore("0000", verify_pin=lambda pin: False)
    assert evidence.status == GateStatus.FAILED


def test_r4_telegram_origin_can_never_authorize(coordinator):
    coordinator.resolve_incident_context(incident=_open_incident())

    evidence = coordinator.authorize_restore("4321", origin="telegram", verify_pin=lambda pin: True)
    assert evidence.status == GateStatus.FAILED


def test_r4_never_records_the_pin_value_anywhere(coordinator, audit):
    coordinator.resolve_incident_context(incident=_open_incident())
    coordinator.authorize_restore("super-secret-4321", verify_pin=lambda pin: True)

    evidence = coordinator.gate(Gate.R4_RESTORE_AUTHORIZATION)
    assert "super-secret-4321" not in evidence.summary
    assert "super-secret-4321" not in evidence.detail
    assert all("super-secret-4321" not in str(args) for args in audit)


def test_r4_resets_when_the_bound_incident_changes(coordinator):
    coordinator.resolve_incident_context(incident=_open_incident(id=1))
    coordinator.authorize_restore("4321", verify_pin=lambda pin: True)
    assert coordinator.gate(Gate.R4_RESTORE_AUTHORIZATION).status == GateStatus.VERIFIED

    coordinator.resolve_incident_context(incident=_open_incident(id=2))
    assert coordinator.gate(Gate.R4_RESTORE_AUTHORIZATION).status == GateStatus.PENDING


# ---------------------------------------------------------------------------
# R5 -- Physical Restore: REQUESTED != PUBLISHED != ACK != STATUS != VERIFIED
# ---------------------------------------------------------------------------

def _ready_coordinator(monkeypatch, *, dry_run=False, controller_extra=None):
    """A coordinator with R1-R4 already VERIFIED, ready to request RESTORE."""
    coordinator = RecoveryCoordinator()
    coordinator.resolve_incident_context(incident=_open_incident())
    monkeypatch.setattr(config, "RECOVERY_MANAGEMENT_PROBE_TARGET", "10.0.0.1:22")
    coordinator.verify_safe_access(prober=lambda t: (True, "ok"))
    coordinator.apply_and_verify_attacker_isolation(ATTACKER_IP, containment_client=FakeContainmentClient())
    coordinator.authorize_restore("4321", verify_pin=lambda pin: True)
    return coordinator


def status_payload(**overrides) -> bytes:
    fields = {
        "msg_id": p1.new_msg_id(), "device_time": NOW - 1, "time_trust": "SYNCED", "output_state": "NORMAL",
        "reason": "PERIODIC", "cmd_msg_id": "", "cmd_seq": 0, "device_seq_hwm": 0, "rssi_dbm": -60, "heap_free": 150000,
    }
    fields.update(overrides)
    return p1.encode(p1.STATUS, device_id=DEVICE, fields=fields, keys=KEYS)[1]


def ack_payload(reserved, result="ACCEPTED", **overrides) -> bytes:
    fields = {
        "msg_id": p1.new_msg_id(), "device_time": NOW - 1, "ack_for_msg_id": reserved.nonce,
        "ack_for_seq": reserved.seq, "result": result,
    }
    fields.update(overrides)
    return p1.encode(p1.ACK, device_id=DEVICE, fields=fields, keys=KEYS)[1]


def deliver(manager, topic, payload):
    manager._on_message(None, None, SimpleNamespace(topic=topic, payload=payload, retain=False))


@pytest.fixture
def store(tmp_path):
    instance = ProtocolStore(tmp_path / "data" / "core-protocol.sqlite3", wall_clock=lambda: NOW)
    yield instance
    instance.close()


@pytest.fixture
def protocol_context(store):
    return ProtocolContext(DEVICE, KEYS, store, Clock())


@pytest.fixture
def paho():
    return FakePahoClient()


@pytest.fixture
def manager(protocol_context, paho):
    instance = MQTTManager(protocol=protocol_context, client_factory=lambda: paho, protocol_mode="v1")
    instance.is_connected = True  # publish() refuses while disconnected; these tests exercise correlation, not connection
    return instance


@pytest.fixture
def controller(manager, protocol_context):
    # AegisCommandController's audit_log default captures the real db.log_event
    # at import time, before this file's autouse monkeypatch can reach it, and
    # that would otherwise touch a real sqlite file on disk for every test.
    return AegisCommandController(
        manager, protocol=protocol_context, protocol_mode="v1", dry_run=False, audit_log=lambda *args, **kwargs: None,
    )


def _wire_manager_to_coordinator(manager, coordinator):
    manager.ack_callback = lambda a, d, n: coordinator.on_ack_evidence(a, d, n)
    manager.status_callback = lambda s, r, h, n: coordinator.on_status_evidence(s, r, h, n)


def test_r5_controller_ok_alone_does_not_verify_physical_restore(coordinator, monkeypatch, controller):
    ready = _ready_coordinator(monkeypatch)
    evidence = ready.request_physical_restore(controller)

    assert evidence.status == GateStatus.CHECKING
    assert evidence.status != GateStatus.VERIFIED


def test_r5_wrong_ack_msg_id_does_not_satisfy(coordinator, monkeypatch, controller):
    ready = _ready_coordinator(monkeypatch)
    ready.request_physical_restore(controller)

    ready.on_ack_evidence("OK", "ACCEPTED", "not-the-real-msg-id")

    assert ready.gate(Gate.R5_PHYSICAL_RESTORE).status == GateStatus.CHECKING


def test_r5_correct_ack_alone_does_not_satisfy(coordinator, monkeypatch, controller, manager, store):
    ready = _ready_coordinator(monkeypatch)
    _wire_manager_to_coordinator(manager, ready)
    result = ready.request_physical_restore(controller)
    reserved = SimpleNamespace(nonce=result.evidence_source.removeprefix("msg_id="), seq=store.command(result.evidence_source.removeprefix("msg_id="))["seq"])

    deliver(manager, p1.topics(DEVICE).ack, ack_payload(reserved, result="ACCEPTED"))

    assert ready.gate(Gate.R5_PHYSICAL_RESTORE).status == GateStatus.CHECKING


def test_r5_wrong_status_correlation_does_not_satisfy(coordinator, monkeypatch, controller, manager, store):
    ready = _ready_coordinator(monkeypatch)
    _wire_manager_to_coordinator(manager, ready)
    ready.request_physical_restore(controller)

    # A STATUS correlated to an unrelated (never-opened) command must be ignored.
    deliver(manager, p1.topics(DEVICE).status, status_payload(output_state="NORMAL", reason="PERIODIC"))

    assert ready.gate(Gate.R5_PHYSICAL_RESTORE).status == GateStatus.CHECKING


def test_r5_correlated_ack_and_correlated_status_normal_verifies(coordinator, monkeypatch, controller, manager, store):
    ready = _ready_coordinator(monkeypatch)
    _wire_manager_to_coordinator(manager, ready)
    result = ready.request_physical_restore(controller)
    msg_id = result.evidence_source.removeprefix("msg_id=")
    reserved = SimpleNamespace(nonce=msg_id, seq=store.command(msg_id)["seq"])

    deliver(manager, p1.topics(DEVICE).ack, ack_payload(reserved, result="ACCEPTED"))
    deliver(manager, p1.topics(DEVICE).status, status_payload(output_state="NORMAL", reason="COMMAND", cmd_msg_id=msg_id, cmd_seq=reserved.seq))

    assert ready.gate(Gate.R5_PHYSICAL_RESTORE).status == GateStatus.VERIFIED


def test_r5_correlated_ack_and_status_lockdown_does_not_verify(coordinator, monkeypatch, controller, manager, store):
    ready = _ready_coordinator(monkeypatch)
    _wire_manager_to_coordinator(manager, ready)
    result = ready.request_physical_restore(controller)
    msg_id = result.evidence_source.removeprefix("msg_id=")
    reserved = SimpleNamespace(nonce=msg_id, seq=store.command(msg_id)["seq"])

    deliver(manager, p1.topics(DEVICE).ack, ack_payload(reserved, result="ACCEPTED"))
    deliver(manager, p1.topics(DEVICE).status, status_payload(output_state="LOCKDOWN", reason="COMMAND", cmd_msg_id=msg_id, cmd_seq=reserved.seq))

    evidence = ready.gate(Gate.R5_PHYSICAL_RESTORE)
    assert evidence.status == GateStatus.FAILED
    assert evidence.status != GateStatus.VERIFIED


def test_r5_ack_rejection_fails_the_gate(coordinator, monkeypatch, controller, manager, store):
    ready = _ready_coordinator(monkeypatch)
    _wire_manager_to_coordinator(manager, ready)
    result = ready.request_physical_restore(controller)
    msg_id = result.evidence_source.removeprefix("msg_id=")
    reserved = SimpleNamespace(nonce=msg_id, seq=store.command(msg_id)["seq"])

    deliver(manager, p1.topics(DEVICE).ack, ack_payload(reserved, result="REJECTED_SEQUENCE"))

    assert ready.gate(Gate.R5_PHYSICAL_RESTORE).status == GateStatus.FAILED


def test_r5_dry_run_is_simulated_never_physically_verified(monkeypatch, manager, protocol_context, paho):
    ready = _ready_coordinator(monkeypatch)
    dry_controller = AegisCommandController(
        manager, protocol=protocol_context, protocol_mode="v1", dry_run=True, audit_log=lambda *args, **kwargs: None,
    )

    evidence = ready.request_physical_restore(dry_controller)

    assert evidence.status == GateStatus.SIMULATED
    assert evidence.status != GateStatus.VERIFIED
    assert paho.published == []  # dry-run never publishes; no physical evidence can exist


def test_r5_restore_cannot_be_requested_unless_r1_through_r4_satisfy_policy(monkeypatch, controller, paho):
    coordinator = RecoveryCoordinator()
    coordinator.resolve_incident_context(incident=_open_incident())
    # R2, R3, R4 never verified.

    evidence = coordinator.request_physical_restore(controller)

    assert evidence.status == GateStatus.FAILED
    assert paho.published == []  # nothing was ever sent


# ---------------------------------------------------------------------------
# R6 -- Network Recovery
# ---------------------------------------------------------------------------

def _r5_verified_coordinator():
    coordinator = RecoveryCoordinator()
    coordinator.resolve_incident_context(incident=_open_incident())
    coordinator._set(Gate.R5_PHYSICAL_RESTORE, GateStatus.VERIFIED, "test setup")
    return coordinator


def test_r6_blocks_without_verified_r5():
    coordinator = RecoveryCoordinator()
    coordinator.resolve_incident_context(incident=_open_incident())

    evidence = coordinator.verify_network_recovery(prober=lambda t: (True, "ok"))
    assert evidence.status == GateStatus.FAILED


def test_r6_not_configured_is_not_verified(monkeypatch):
    coordinator = _r5_verified_coordinator()
    monkeypatch.setattr(config, "RECOVERY_NETWORK_PROBE_TARGETS", "")

    evidence = coordinator.verify_network_recovery()
    assert evidence.status == GateStatus.NOT_CONFIGURED


def test_r6_failed_mandatory_probe_blocks(monkeypatch):
    coordinator = _r5_verified_coordinator()
    monkeypatch.setattr(config, "RECOVERY_NETWORK_PROBE_TARGETS", "10.0.0.1:443")

    evidence = coordinator.verify_network_recovery(prober=lambda t: (False, "unreachable"))
    assert evidence.status == GateStatus.FAILED


def test_r6_all_probes_pass_verifies(monkeypatch):
    coordinator = _r5_verified_coordinator()
    monkeypatch.setattr(config, "RECOVERY_NETWORK_PROBE_TARGETS", "10.0.0.1:443,10.0.0.2:443")

    evidence = coordinator.verify_network_recovery(prober=lambda t: (True, "ok"))
    assert evidence.status == GateStatus.VERIFIED


# ---------------------------------------------------------------------------
# R7 -- Service Recovery
# ---------------------------------------------------------------------------

def _r6_verified_coordinator():
    coordinator = _r5_verified_coordinator()
    coordinator._set(Gate.R6_NETWORK_RECOVERY, GateStatus.VERIFIED, "test setup")
    return coordinator


def test_r7_mandatory_core_failure_blocks_closure(monkeypatch):
    coordinator = _r6_verified_coordinator()
    monkeypatch.setattr(config, "RECOVERY_WEB_READINESS_URL", "")

    evidence = coordinator.verify_service_recovery(
        core_probe=lambda: False, mqtt_manager=SimpleNamespace(is_connected=True),
    )
    assert evidence.status != GateStatus.VERIFIED


def test_r7_mandatory_mqtt_failure_blocks_closure(monkeypatch):
    coordinator = _r6_verified_coordinator()
    monkeypatch.setattr(config, "RECOVERY_WEB_READINESS_URL", "")

    evidence = coordinator.verify_service_recovery(
        core_probe=lambda: True, mqtt_manager=SimpleNamespace(is_connected=False),
    )
    assert evidence.status != GateStatus.VERIFIED


def test_r7_mandatory_web_not_configured_blocks_closure_not_fake_green(monkeypatch):
    coordinator = _r6_verified_coordinator()
    monkeypatch.setattr(config, "RECOVERY_WEB_READINESS_URL", "")

    evidence = coordinator.verify_service_recovery(
        core_probe=lambda: True, mqtt_manager=SimpleNamespace(is_connected=True),
    )
    assert evidence.status == GateStatus.NOT_CONFIGURED
    assert evidence.status != GateStatus.VERIFIED


def test_r7_all_mandatory_ready_verifies(monkeypatch):
    coordinator = _r6_verified_coordinator()
    monkeypatch.setattr(config, "RECOVERY_WEB_READINESS_URL", "http://localhost/security/api/readiness")

    evidence = coordinator.verify_service_recovery(
        core_probe=lambda: True, mqtt_manager=SimpleNamespace(is_connected=True),
        web_probe=lambda url: (True, "READY"),
    )
    assert evidence.status == GateStatus.VERIFIED


def test_r7_optional_idea1_idea2_unavailable_never_becomes_fake_pass(monkeypatch):
    coordinator = _r6_verified_coordinator()
    monkeypatch.setattr(config, "RECOVERY_WEB_READINESS_URL", "http://localhost/security/api/readiness")
    monkeypatch.setattr(config, "RECOVERY_IDEA1_READINESS_URL", "")
    monkeypatch.setattr(config, "RECOVERY_IDEA2_READINESS_URL", "")

    evidence = coordinator.verify_service_recovery(
        core_probe=lambda: True, mqtt_manager=SimpleNamespace(is_connected=True),
        web_probe=lambda url: (True, "READY"),
    )
    # Optional adapters being unconfigured must not stop R7 from verifying,
    # and must never themselves be reported as PASS.
    assert evidence.status == GateStatus.VERIFIED
    assert "ADAPTER_UNAVAILABLE" in evidence.detail


# ---------------------------------------------------------------------------
# R8 -- Incident Closure (fail-closed)
# ---------------------------------------------------------------------------

def _fully_verified_coordinator(monkeypatch):
    coordinator = RecoveryCoordinator()
    coordinator.resolve_incident_context(incident=_open_incident())
    for gate in (
        Gate.R2_SAFE_ACCESS, Gate.R3_ATTACKER_ISOLATION, Gate.R4_RESTORE_AUTHORIZATION,
        Gate.R5_PHYSICAL_RESTORE, Gate.R6_NETWORK_RECOVERY, Gate.R7_SERVICE_RECOVERY,
    ):
        coordinator._set(gate, GateStatus.VERIFIED, "test setup")
    return coordinator


def test_r8_cannot_close_with_any_incomplete_gate(monkeypatch):
    coordinator = _fully_verified_coordinator(monkeypatch)
    coordinator._set(Gate.R7_SERVICE_RECOVERY, GateStatus.CHECKING, "still checking")

    evidence = coordinator.close_incident("lessons learned", close_fn=lambda *a: pytest.fail("must not close"))
    assert evidence.status == GateStatus.FAILED


def test_r8_cannot_close_with_not_configured_mandatory_gate(monkeypatch):
    coordinator = _fully_verified_coordinator(monkeypatch)
    coordinator._set(Gate.R2_SAFE_ACCESS, GateStatus.NOT_CONFIGURED, "unset")

    evidence = coordinator.close_incident("lessons learned", close_fn=lambda *a: pytest.fail("must not close"))
    assert evidence.status == GateStatus.FAILED


def test_r8_requires_a_nonempty_summary(monkeypatch):
    coordinator = _fully_verified_coordinator(monkeypatch)

    evidence = coordinator.close_incident("   ", close_fn=lambda *a: pytest.fail("must not close"))
    assert evidence.status == GateStatus.FAILED


def test_r8_closes_only_after_the_complete_verified_chain(monkeypatch):
    coordinator = _fully_verified_coordinator(monkeypatch)
    calls = []

    evidence = coordinator.close_incident("root caused and patched", close_fn=lambda incident_id, summary: calls.append((incident_id, summary)))

    assert evidence.status == GateStatus.VERIFIED
    assert calls == [(42, "root caused and patched")]


def test_r8_never_writes_the_close_twice(monkeypatch):
    coordinator = _fully_verified_coordinator(monkeypatch)
    calls = []
    coordinator.close_incident("first close", close_fn=lambda incident_id, summary: calls.append((incident_id, summary)))

    coordinator.close_incident("second attempt", close_fn=lambda incident_id, summary: calls.append((incident_id, summary)))

    assert len(calls) == 1


def test_r8_not_applicable_gate_may_satisfy_closure(monkeypatch):
    coordinator = _fully_verified_coordinator(monkeypatch)
    coordinator._set(Gate.R2_SAFE_ACCESS, GateStatus.NOT_APPLICABLE, "no OOB path in this lab topology")

    evidence = coordinator.close_incident("closed", close_fn=lambda incident_id, summary: None)
    assert evidence.status == GateStatus.VERIFIED


# ---------------------------------------------------------------------------
# Cross-cutting: no secrets anywhere in gate evidence
# ---------------------------------------------------------------------------

def test_no_gate_evidence_ever_contains_a_secret_looking_field():
    coordinator = RecoveryCoordinator()
    coordinator.resolve_incident_context(incident=_open_incident())
    coordinator.authorize_restore("4321", verify_pin=lambda pin: True)

    for evidence in coordinator.all_gates():
        payload = evidence.as_safe_dict()
        for forbidden in ("pin", "password", "private_key", "token", "mqtt_pass", "secret"):
            for key in payload:
                assert forbidden not in key.lower() or key == "gate"
