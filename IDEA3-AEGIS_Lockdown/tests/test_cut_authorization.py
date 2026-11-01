"""Central, one-shot physical CUT authorization over disposable SQLite and fake transports."""

from __future__ import annotations

import dataclasses
import sqlite3
import threading

import pytest

from aegis_soc import protocol_v1 as p1
from aegis_soc.controller import CUT_UPLINK, AegisCommandController
from aegis_soc.cut_authorization import (
    CutAuthorizationError,
    CutAuthorizationStore,
)
from aegis_soc.protocol_inbound import ProtocolContext
from aegis_soc.protocol_store import ProtocolStore


DEVICE = "test-device-01"
REQUEST = "req-20261029-0001"
INCIDENT = "incident-42"
OPERATOR = "uid:1000"
NOW = p1.TIME_FLOOR + 3_600
KEYS = p1.ProtocolKeys(c2d=bytes(range(0x20)), d2c=bytes(range(0x20, 0x40)))


class Clock:
    def trusted_now(self):
        return NOW


class FakeMQTT:
    def __init__(self, result=True, error=None):
        self.result = result
        self.error = error
        self.published = []
        self.lock = threading.Lock()

    def publish(self, topic, payload):
        with self.lock:
            self.published.append((topic, payload))
        if self.error is not None:
            raise self.error
        return self.result


@pytest.fixture
def authorization(tmp_path):
    path = tmp_path / "core.sqlite3"
    store = CutAuthorizationStore(path, wall_clock=lambda: NOW)
    issuer = store.trusted_issuer()
    yield path, store, issuer
    store.close()


@pytest.fixture
def v1(tmp_path, authorization):
    _, authorizations, issuer = authorization
    protocol_store = ProtocolStore(tmp_path / "protocol.sqlite3", wall_clock=lambda: NOW)
    context = ProtocolContext(DEVICE, KEYS, protocol_store, Clock())
    mqtt = FakeMQTT()
    controller = AegisCommandController(
        mqtt,
        protocol=context,
        protocol_mode="v1",
        audit_log=lambda *_args: None,
        cut_authorizations=authorizations,
    )
    yield controller, mqtt, protocol_store, issuer
    protocol_store.close()


def grant(issuer, *, request_id=REQUEST, incident_id=INCIDENT, target=DEVICE, expires_at=NOW + 30):
    return issuer.issue(
        request_id=request_id,
        incident_id=incident_id,
        target_device=target,
        action=CUT_UPLINK,
        operator_identity=OPERATOR,
        expires_at=expires_at,
        reason="verified operator containment",
    )


def issue(controller, approval, *, request_id=REQUEST, incident_id=INCIDENT):
    return controller.issue(
        CUT_UPLINK,
        "verified containment",
        critical=True,
        origin="forged-origin-is-not-authority",
        cut_authorization=approval,
        cut_request_id=request_id,
        cut_incident_id=incident_id,
    )


def test_cut_without_authorization_and_forged_origin_never_publish(v1):
    controller, mqtt, _, _ = v1
    result = controller.issue(CUT_UPLINK, "unauthorized", origin="core-local-cut")
    assert (result.sent, result.reason_code) == (False, "CUT_AUTHORIZATION_REQUIRED")
    assert mqtt.published == []


def test_valid_authorization_publishes_one_signed_protocol_v1_command_then_replay_is_refused(v1):
    controller, mqtt, _, issuer = v1
    approval = grant(issuer)

    first = issue(controller, approval)

    assert first.sent is True
    assert len(mqtt.published) == 1
    topic, payload = mqtt.published[0]
    command = p1.parse(payload, topic=topic, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
    assert p1.verify(command, KEYS) is True
    assert command.fields["action"] == CUT_UPLINK
    replay = issue(controller, approval)
    assert (replay.sent, replay.reason_code) == (False, "CUT_AUTHORIZATION_USED")
    assert len(mqtt.published) == 1


@pytest.mark.parametrize(
    "changes,reason",
    [
        ({"request_id": "wrong-request"}, "CUT_AUTHORIZATION_BINDING_MISMATCH"),
        ({"incident_id": "wrong-incident"}, "CUT_AUTHORIZATION_BINDING_MISMATCH"),
        ({"target_device": "other-device-02"}, "CUT_AUTHORIZATION_BINDING_MISMATCH"),
        ({"action": "RESTORE_UPLINK"}, "CUT_AUTHORIZATION_BINDING_MISMATCH"),
    ],
)
def test_wrong_request_incident_target_or_action_cannot_consume(authorization, changes, reason):
    _, store, issuer = authorization
    approval = grant(issuer)
    bindings = {
        "request_id": REQUEST,
        "incident_id": INCIDENT,
        "target_device": DEVICE,
        "action": CUT_UPLINK,
    }
    bindings.update(changes)
    with pytest.raises(CutAuthorizationError, match=reason):
        store.consume(approval, **bindings)
    assert store.get(approval.approval_id)["state"] == "AUTHORIZED"


def test_forged_grant_mac_is_refused_without_consumption(authorization):
    _, store, issuer = authorization
    approval = grant(issuer)
    forged = dataclasses.replace(approval, authenticator="0" * 64)
    with pytest.raises(CutAuthorizationError, match="CUT_AUTHORIZATION_FORGED"):
        store.consume(
            forged,
            request_id=REQUEST,
            incident_id=INCIDENT,
            target_device=DEVICE,
            action=CUT_UPLINK,
        )
    assert store.get(approval.approval_id)["state"] == "AUTHORIZED"


def test_expired_authorization_is_terminal_and_cannot_be_replayed(authorization):
    _, store, issuer = authorization
    approval = grant(issuer, expires_at=NOW - 1)
    with pytest.raises(CutAuthorizationError, match="CUT_AUTHORIZATION_EXPIRED"):
        store.consume(
            approval,
            request_id=REQUEST,
            incident_id=INCIDENT,
            target_device=DEVICE,
            action=CUT_UPLINK,
        )
    assert store.get(approval.approval_id)["state"] == "EXPIRED"


def test_concurrent_consumption_allows_exactly_one_publish(v1):
    controller, mqtt, _, issuer = v1
    approval = grant(issuer)
    barrier = threading.Barrier(3)
    results = []

    def run():
        barrier.wait()
        results.append(issue(controller, approval))

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=3)

    assert sum(result.sent for result in results) == 1
    assert sorted(result.reason_code for result in results if not result.sent) == ["CUT_AUTHORIZATION_USED"]
    assert len(mqtt.published) == 1


def test_consume_and_audit_are_atomic_and_fail_closed(v1, authorization):
    path, store, issuer = authorization
    controller, mqtt, _, _ = v1
    approval = grant(issuer)
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            "CREATE TRIGGER fail_cut_consume_audit BEFORE INSERT ON cut_authorization_events "
            "WHEN NEW.event_type = 'CONSUMED' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END"
        )
        connection.commit()
    finally:
        connection.close()

    result = issue(controller, approval)

    assert (result.sent, result.reason_code) == (False, "CUT_AUTHORIZATION_STORE_UNAVAILABLE")
    assert store.get(approval.approval_id)["state"] == "AUTHORIZED"
    assert mqtt.published == []


@pytest.mark.parametrize(
    "publish_result,publish_error,outcome,reason",
    [
        (False, None, "NOT_PUBLISHED", "MQTT_UNAVAILABLE"),
        (True, RuntimeError("uncertain transport"), "OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN"),
    ],
)
def test_publish_failure_or_uncertainty_burns_authorization(
    tmp_path, authorization, publish_result, publish_error, outcome, reason,
):
    _, store, issuer = authorization
    protocol_store = ProtocolStore(tmp_path / "protocol-failure.sqlite3", wall_clock=lambda: NOW)
    context = ProtocolContext(DEVICE, KEYS, protocol_store, Clock())
    mqtt = FakeMQTT(publish_result, publish_error)
    controller = AegisCommandController(
        mqtt,
        protocol=context,
        protocol_mode="v1",
        audit_log=lambda *_args: None,
        cut_authorizations=store,
    )
    approval = grant(issuer)
    try:
        result = issue(controller, approval)
        assert (result.sent, result.reason_code) == (False, reason)
        assert store.get(approval.approval_id)["state"] == "CONSUMED"
        assert store.get(approval.approval_id)["outcome"] == outcome
        assert issue(controller, approval).reason_code == "CUT_AUTHORIZATION_USED"
        assert len(mqtt.published) == 1
    finally:
        protocol_store.close()


def test_restart_invalidates_an_unconsumed_process_bound_grant(tmp_path):
    path = tmp_path / "restart.sqlite3"
    first = CutAuthorizationStore(path, wall_clock=lambda: NOW)
    approval = grant(first.trusted_issuer())
    first.close()

    restarted = CutAuthorizationStore(path, wall_clock=lambda: NOW + 1)
    try:
        with pytest.raises(CutAuthorizationError, match="CUT_AUTHORIZATION_FORGED"):
            restarted.consume(
                approval,
                request_id=REQUEST,
                incident_id=INCIDENT,
                target_device=DEVICE,
                action=CUT_UPLINK,
            )
        assert restarted.get(approval.approval_id)["state"] == "INVALIDATED_RESTART"
    finally:
        restarted.close()


def test_legacy_lab_path_has_the_same_central_authorization_boundary(authorization):
    _, store, issuer = authorization
    mqtt = FakeMQTT()
    controller = AegisCommandController(
        mqtt,
        protocol_mode="legacy-v0-lab",
        audit_log=lambda *_args: None,
        cut_authorizations=store,
        cut_target_device=DEVICE,
    )
    assert controller.issue(CUT_UPLINK, "direct legacy", origin="test").reason_code == "CUT_AUTHORIZATION_REQUIRED"
    approval = grant(issuer)
    result = issue(controller, approval)
    assert result.sent is True and len(mqtt.published) == 1
    assert issue(controller, approval).reason_code == "CUT_AUTHORIZATION_USED"


def test_dry_run_cut_never_requires_or_consumes_physical_authorization(authorization):
    _, store, issuer = authorization
    mqtt = FakeMQTT()
    controller = AegisCommandController(
        mqtt,
        dry_run=True,
        protocol_mode="v1",
        audit_log=lambda *_args: None,
        cut_authorizations=store,
        cut_target_device=DEVICE,
    )
    approval = grant(issuer)
    result = controller.issue(CUT_UPLINK, "simulation", origin="anything")
    assert (result.ok, result.sent, result.dry_run) == (True, False, True)
    assert store.get(approval.approval_id)["state"] == "AUTHORIZED"
    assert mqtt.published == []
