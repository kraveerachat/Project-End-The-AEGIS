"""The shared physical-command boundary: Protocol v1, R7, R8, R13 (design §5, §7, §9)."""

from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path

import pytest

from aegis_soc import config
from aegis_soc import protocol_v1 as p1
from aegis_soc.controller import DEFAULT_RESTORE_ORIGINS, AegisCommandController
from aegis_soc.protocol_inbound import ProtocolContext
from aegis_soc.protocol_store import ProtocolStore

FIXTURE = json.loads((Path(__file__).resolve().parent / "fixtures" / "protocol-v1-vectors.json").read_text("ascii"))
DEVICE = FIXTURE["deviceId"]
KEYS = p1.ProtocolKeys(
    c2d=bytes.fromhex(FIXTURE["testOnlyKeys"]["c2d"]),
    d2c=bytes.fromhex(FIXTURE["testOnlyKeys"]["d2c"]),
)
NOW = p1.TIME_FLOOR + 3_600


class FakeMQTT:
    def __init__(self, publish_result=True, on_publish=None):
        self.publish_result = publish_result
        self.on_publish = on_publish
        self.published = []

    def publish(self, topic, payload):
        self.published.append((topic, payload))
        if self.on_publish:
            self.on_publish(topic, payload)
        return self.publish_result


class Clock:
    def __init__(self, value=NOW):
        self.value = value

    def trusted_now(self):
        return self.value


def _audit_collector():
    events = []
    return events, lambda *args: events.append(args)


@pytest.fixture
def store(tmp_path):
    instance = ProtocolStore(tmp_path / "data" / "core-protocol.sqlite3", wall_clock=lambda: NOW)
    yield instance
    instance.close()


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def context(store, clock):
    return ProtocolContext(DEVICE, KEYS, store, clock)


def _v1(mqtt, context, audit=lambda *args: None, **kwargs):
    return AegisCommandController(mqtt, audit_log=audit, protocol=context, protocol_mode="v1", **kwargs)


def _parse(topic, payload, kind):
    message = p1.parse(payload, topic=topic, device_id=DEVICE, accept_kinds=frozenset({kind}))
    assert p1.verify(message, KEYS) is True
    return message


def test_live_command_publishes_a_signed_v1_command(context, store):
    mqtt = FakeMQTT()
    events, audit = _audit_collector()

    result = _v1(mqtt, context, audit).issue("CUT_UPLINK", "test containment", origin="test")

    assert (result.ok, result.sent, result.dry_run, result.seq) == (True, True, False, 1)
    topic, payload = mqtt.published[0]
    assert topic == p1.topics(DEVICE).command
    message = _parse(topic, payload, p1.COMMAND)
    assert message.fields["action"] == "CUT_UPLINK"
    assert message.fields["msg_id"] == result.nonce
    assert (message.int("seq"), message.int("issued_at"), message.int("expires_at")) == (1, NOW, NOW + 30)
    assert store.command(result.nonce)["state"] == "PUBLISHED"
    assert events[-1][0] == "COMMAND_SENT"


def test_sequence_is_committed_before_the_publish(context, store):
    observed = []

    def on_publish(topic, payload):
        message = p1.parse(payload, topic=topic, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
        observed.append((store.command(message.fields["msg_id"])["state"], store.last_allocated_seq(DEVICE)))

    _v1(FakeMQTT(on_publish=on_publish), context).issue("CUT_UPLINK", "ordering", origin="test")

    assert observed == [("RESERVED", 1)]


def test_not_after_caps_device_expiry_and_an_expired_command_is_never_reserved(context, store):
    mqtt = FakeMQTT()
    controller = _v1(mqtt, context)
    capped = controller.issue("CUT_UPLINK", "dispatch", origin="test", not_after=NOW + 10.9)
    assert _parse(*mqtt.published[0], p1.COMMAND).int("expires_at") == NOW + 10
    assert capped.sent is True

    expired = controller.issue("CUT_UPLINK", "dispatch", origin="test", not_after=NOW)
    assert (expired.sent, expired.reason_code) == (False, "EXPIRED_AT_CORE")
    assert store.last_allocated_seq(DEVICE) == 1
    assert len(mqtt.published) == 1


def test_untrusted_core_time_publishes_no_command_and_reserves_nothing(context, store, clock):
    clock.value = None
    mqtt = FakeMQTT()
    events, audit = _audit_collector()

    result = _v1(mqtt, context, audit).issue("CUT_UPLINK", "containment", origin="test", critical=True)

    assert (result.ok, result.sent, result.reason_code) == (False, False, "CORE_TIME_UNTRUSTED")
    assert mqtt.published == []
    assert store.last_allocated_seq(DEVICE) == 0
    assert events[0][0] == "COMMAND_REJECTED"


def test_mqtt_failure_burns_the_sequence_without_false_success(context, store):
    controller = _v1(FakeMQTT(publish_result=False), context)

    failed = controller.issue("CUT_UPLINK", "offline", origin="test")

    assert (failed.ok, failed.sent, failed.reason_code) == (False, False, "MQTT_UNAVAILABLE")
    burned = store.command(p1.parse(
        controller.mqtt.published[0][1], topic=p1.topics(DEVICE).command, device_id=DEVICE,
        accept_kinds=frozenset({p1.COMMAND}),
    ).fields["msg_id"])
    assert burned["state"] == "NOT_PUBLISHED"
    controller.mqtt.publish_result = True
    assert controller.issue("CUT_UPLINK", "retry by operator", origin="test").seq == 2


def test_store_failure_before_publish_sends_nothing(context):
    class BrokenStore:
        def reserve_command(self, *_args):
            raise OSError("disk full")

    mqtt = FakeMQTT()
    broken = ProtocolContext(DEVICE, KEYS, BrokenStore(), context.clock)
    result = _v1(mqtt, broken).issue("CUT_UPLINK", "containment", origin="test")
    assert (result.sent, result.reason_code) == (False, "PROTOCOL_STORE_UNAVAILABLE")
    assert mqtt.published == []


def test_store_failure_after_the_point_of_no_return_still_reports_sent(context, store, monkeypatch):
    monkeypatch.setattr(store, "mark_published", lambda _msg_id: (_ for _ in ()).throw(OSError("disk full")))
    events, audit = _audit_collector()

    result = _v1(FakeMQTT(), context, audit).issue("CUT_UPLINK", "containment", origin="test")

    assert result.sent is True
    assert store.command(result.nonce)["state"] == "RESERVED"
    assert ("PROTOCOL_STORE_WRITE_AFTER_PUBLISH_FAILED", config_level()) in {(event[0], event[2]) for event in events}


def config_level():
    from aegis_soc import database
    return database.CRITICAL


def test_missing_protocol_context_fails_closed():
    mqtt = FakeMQTT()
    result = AegisCommandController(mqtt, audit_log=lambda *args: None, protocol_mode="v1").issue(
        "CUT_UPLINK", "containment", origin="test",
    )
    assert (result.sent, result.reason_code) == (False, "PROTOCOL_NOT_CONFIGURED")
    assert mqtt.published == []


def test_an_unknown_protocol_mode_is_treated_as_strict_v1():
    mqtt = FakeMQTT()
    controller = AegisCommandController(mqtt, audit_log=lambda *args: None, protocol_mode="v2")
    assert controller.issue("CUT_UPLINK", "containment", origin="test").reason_code == "PROTOCOL_NOT_CONFIGURED"
    assert controller.send_heartbeat() is False
    assert mqtt.published == []


def test_dry_run_never_reserves_or_publishes(context, store):
    mqtt = FakeMQTT()
    events, audit = _audit_collector()
    result = _v1(mqtt, context, audit, dry_run=True).issue("CUT_UPLINK", "test containment", critical=True, origin="test")
    assert (result.ok, result.sent, result.dry_run, result.nonce) == (True, False, True, None)
    assert mqtt.published == []
    assert store.last_allocated_seq(DEVICE) == 0
    assert events[0][0] == "DRY_RUN_COMMAND"
    assert "WOULD_SEND CUT_UPLINK" in events[0][1]


def test_heartbeat_is_signed_v1_and_strictly_increasing(context, clock):
    mqtt = FakeMQTT()
    controller = _v1(mqtt, context)
    assert controller.send_heartbeat() is True
    topic, payload = mqtt.published[0]
    assert topic == p1.topics(DEVICE).heartbeat
    assert _parse(topic, payload, p1.HEARTBEAT).int("issued_at") == NOW
    assert controller.send_heartbeat() is False
    clock.value = NOW + 15
    assert controller.send_heartbeat() is True
    assert len(mqtt.published) == 2


def test_no_heartbeat_while_core_time_is_untrusted(context, clock):
    clock.value = None
    mqtt = FakeMQTT()
    events, audit = _audit_collector()
    controller = _v1(mqtt, context, audit)
    assert [controller.send_heartbeat() for _ in range(3)] == [False, False, False]
    assert mqtt.published == []
    assert [event[0] for event in events] == ["HEARTBEAT_WITHHELD"]
    clock.value = NOW
    assert controller.send_heartbeat() is True
    clock.value = None
    assert controller.send_heartbeat() is False
    assert [event[0] for event in events] == ["HEARTBEAT_WITHHELD", "HEARTBEAT_WITHHELD"]


def test_dry_run_heartbeat_never_publishes(context):
    mqtt = FakeMQTT()
    assert _v1(mqtt, context, dry_run=True).send_heartbeat() is True
    assert mqtt.published == []


def test_restore_fails_closed_without_explicit_recovery_authorization(context, store):
    mqtt = FakeMQTT()
    events, audit = _audit_collector()
    result = _v1(mqtt, context, audit).issue("RESTORE_UPLINK", "automatic startup restore", origin="gui")
    assert (result.ok, result.sent) == (False, False)
    assert "explicit recovery authorization required" in result.detail
    assert mqtt.published == [] and store.last_allocated_seq(DEVICE) == 0
    assert events[0][0] == "COMMAND_REJECTED"


@pytest.mark.parametrize("origin", ["telegram", "startup", "reconnect", "time-recovery", "web", "server-dispatch"])
def test_restore_is_refused_for_every_origin_outside_the_allowlist(context, store, origin):
    mqtt = FakeMQTT()
    result = _v1(mqtt, context).issue("RESTORE_UPLINK", "restore", origin=origin, authorize_restore=True)
    assert (result.sent, result.reason_code) == (False, "RESTORE_ORIGIN_REFUSED")
    assert mqtt.published == [] and store.last_allocated_seq(DEVICE) == 0


def test_an_allowlisted_authorized_restore_is_signed_and_published(context):
    mqtt = FakeMQTT()
    result = _v1(mqtt, context).issue("RESTORE_UPLINK", "human recovery", origin="gui", authorize_restore=True)
    assert result.sent is True
    assert _parse(*mqtt.published[0], p1.COMMAND).fields["action"] == "RESTORE_UPLINK"


def test_an_empty_allowlist_has_no_restore_authority(context):
    mqtt = FakeMQTT()
    controller = _v1(mqtt, context, restore_origins=frozenset())
    result = controller.issue("RESTORE_UPLINK", "recovery", origin="gui", authorize_restore=True)
    assert (result.sent, result.reason_code) == (False, "RESTORE_ORIGIN_REFUSED")


def test_telegram_can_never_be_given_restore_authority():
    assert frozenset({"gui", "recovery-wizard"}) == DEFAULT_RESTORE_ORIGINS
    with pytest.raises(ValueError):
        AegisCommandController(FakeMQTT(), restore_origins=frozenset({"gui", "telegram"}))


def _legacy_signature_valid(payload):
    data = json.loads(payload)
    action = data.get("cmd") or data.get("hb")
    signing = f"{action}|{data['nonce']}|{data['ts']}".encode()
    return hmac.compare_digest(hmac.new(config.SECRET_KEY, signing, hashlib.sha256).hexdigest(), data["sig"])


def test_legacy_lab_mode_is_isolated_and_explicit():
    mqtt = FakeMQTT()
    controller = AegisCommandController(mqtt, audit_log=lambda *args: None, protocol_mode="legacy-v0-lab")
    result = controller.issue("CUT_UPLINK", "lab", origin="test")
    assert result.sent is True
    topic, payload = mqtt.published[0]
    assert topic == config.TOPIC_CMD
    assert _legacy_signature_valid(payload)
    assert controller.send_heartbeat() is True
    assert mqtt.published[1][0] == config.TOPIC_HEARTBEAT
