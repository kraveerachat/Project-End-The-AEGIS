"""MQTT connection and device-liveness regression tests."""

from types import SimpleNamespace

from aegis_soc import config
from aegis_soc.mqtt_client import MQTTManager


class FakeClient:
    def __init__(self):
        self.subscriptions = []

    def subscribe(self, topics):
        self.subscriptions.append(topics)


def test_attacker_topic_does_not_mark_esp32_online(monkeypatch):
    manager = MQTTManager()
    monkeypatch.setattr("aegis_soc.mqtt_client.db.log_event", lambda *args, **kwargs: None)
    manager.attacker_callback = lambda ip: None
    message = SimpleNamespace(topic=config.TOPIC_ATTACKER_IP, payload=b"203.0.113.9")

    manager._on_message(None, None, message)

    assert manager.last_attacker_ip == "203.0.113.9"
    assert manager.last_device_msg_ts is None
    assert manager.device_online() is False


def test_rejected_broker_connection_is_not_reported_connected(monkeypatch):
    manager = MQTTManager()
    client = FakeClient()
    observed = []
    manager.connection_callback = observed.append
    monkeypatch.setattr("aegis_soc.mqtt_client.db.log_event", lambda *args, **kwargs: None)

    manager._on_connect(client, None, None, reason_code=5)

    assert manager.is_connected is False
    assert observed == [False]
    assert client.subscriptions == []


def test_ack_callback_includes_command_nonce(monkeypatch):
    """MQTT ACK callback preserves the command nonce for Core correlation."""
    from types import SimpleNamespace

    from aegis_soc import config
    from aegis_soc import mqtt_client as mqtt_module

    monkeypatch.setattr(
        mqtt_module.db,
        "log_event",
        lambda *args, **kwargs: None,
    )

    manager = mqtt_module.MQTTManager()
    received = []

    manager.ack_callback = lambda *args: received.append(args)

    message = SimpleNamespace(
        topic=config.TOPIC_ACK,
        payload=b'{"ack":"OK","detail":"uplink cut","nonce":"abc123"}',
    )

    manager._on_message(None, None, message)

    assert received == [
        ("OK", "uplink cut", "abc123"),
    ]


def test_status_callback_includes_command_nonce(monkeypatch):
    """MQTT STATUS callback preserves command correlation for Core."""
    monkeypatch.setattr(
        "aegis_soc.mqtt_client.db.log_event",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "aegis_soc.comms.send_webhook_alert",
        lambda *args, **kwargs: None,
    )

    manager = MQTTManager()
    received = []
    manager.status_callback = lambda *args: received.append(args)

    message = SimpleNamespace(
        topic=config.TOPIC_STATUS,
        payload=(
            b'{"state":"LOCKDOWN","reason":"verified",'
            b'"rssi":-48,"heap":200000,'
            b'"command_nonce":"abc123"}'
        ),
    )

    manager._on_message(None, None, message)

    assert received == [
        ("LOCKDOWN", -48, 200000, "abc123"),
    ]


def test_status_callback_uses_empty_command_nonce_when_missing(monkeypatch):
    """Non-command STATUS forwards an empty correlation identifier."""
    monkeypatch.setattr(
        "aegis_soc.mqtt_client.db.log_event",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "aegis_soc.comms.send_webhook_alert",
        lambda *args, **kwargs: None,
    )

    manager = MQTTManager()
    received = []
    manager.status_callback = lambda *args: received.append(args)

    message = SimpleNamespace(
        topic=config.TOPIC_STATUS,
        payload=(
            b'{"state":"NORMAL","reason":"heartbeat",'
            b'"rssi":-47,"heap":199000}'
        ),
    )

    manager._on_message(None, None, message)

    assert received == [
        ("NORMAL", -47, 199000, ""),
    ]
