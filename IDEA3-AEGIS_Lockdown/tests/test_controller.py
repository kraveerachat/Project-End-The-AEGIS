"""Tests for the shared physical-command safety boundary."""

import hashlib
import hmac
import json

from aegis_soc import config
from aegis_soc.controller import AegisCommandController


class FakeMQTT:
    def __init__(self, publish_result=True):
        self.publish_result = publish_result
        self.published = []

    def publish(self, topic, payload):
        self.published.append((topic, payload))
        return self.publish_result


def _audit_collector():
    events = []

    def collect(*args):
        events.append(args)

    return events, collect


def _valid_signature(payload):
    data = json.loads(payload)
    action = data.get("cmd") or data.get("hb")
    signing = f"{action}|{data['nonce']}|{data['ts']}".encode()
    expected = hmac.new(config.SECRET_KEY, signing, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, data["sig"])


def test_dry_run_command_never_publishes():
    mqtt = FakeMQTT()
    events, audit = _audit_collector()
    controller = AegisCommandController(mqtt, dry_run=True, audit_log=audit)

    result = controller.issue("CUT_UPLINK", "test containment", critical=True, origin="test")

    assert result.ok is True
    assert result.sent is False
    assert result.dry_run is True
    assert mqtt.published == []
    assert events[0][0] == "DRY_RUN_COMMAND"
    assert "WOULD_SEND CUT_UPLINK" in events[0][1]


def test_live_command_uses_existing_signed_mqtt_path():
    mqtt = FakeMQTT()
    events, audit = _audit_collector()
    controller = AegisCommandController(mqtt, audit_log=audit)

    result = controller.issue("CUT_UPLINK", "test containment", origin="test")

    assert result.ok is True
    assert result.sent is True
    assert len(mqtt.published) == 1
    topic, payload = mqtt.published[0]
    assert topic == config.TOPIC_CMD
    assert json.loads(payload)["cmd"] == "CUT_UPLINK"
    assert _valid_signature(payload) is True
    assert events[0][0] == "COMMAND_SENT"


def test_restore_fails_closed_without_explicit_recovery_authorization():
    mqtt = FakeMQTT()
    events, audit = _audit_collector()
    controller = AegisCommandController(mqtt, audit_log=audit)

    result = controller.issue("RESTORE_UPLINK", "automatic startup restore", origin="startup")

    assert result.ok is False
    assert result.sent is False
    assert mqtt.published == []
    assert events[0][0] == "COMMAND_REJECTED"
    assert "explicit recovery authorization required" in result.detail


def test_authorized_restore_is_signed_and_published():
    mqtt = FakeMQTT()
    controller = AegisCommandController(mqtt, audit_log=lambda *args: None)

    result = controller.issue(
        "RESTORE_UPLINK",
        "human recovery",
        origin="test",
        authorize_restore=True,
    )

    assert result.sent is True
    assert json.loads(mqtt.published[0][1])["cmd"] == "RESTORE_UPLINK"
    assert _valid_signature(mqtt.published[0][1]) is True


def test_mqtt_failure_is_reported_without_false_success():
    mqtt = FakeMQTT(publish_result=False)
    events, audit = _audit_collector()
    controller = AegisCommandController(mqtt, audit_log=audit)

    result = controller.issue("CUT_UPLINK", "offline test", origin="test")

    assert result.ok is False
    assert result.sent is False
    assert events[0][0] == "COMMAND_REJECTED"


def test_heartbeat_is_signed_but_dry_run_never_publishes():
    live_mqtt = FakeMQTT()
    live = AegisCommandController(live_mqtt, audit_log=lambda *args: None)
    assert live.send_heartbeat() is True
    topic, payload = live_mqtt.published[0]
    assert topic == config.TOPIC_HEARTBEAT
    assert json.loads(payload)["hb"] == "alive"
    assert _valid_signature(payload) is True

    dry_mqtt = FakeMQTT()
    dry = AegisCommandController(dry_mqtt, dry_run=True, audit_log=lambda *args: None)
    assert dry.send_heartbeat() is True
    assert dry_mqtt.published == []
