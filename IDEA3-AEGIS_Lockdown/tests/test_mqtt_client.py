"""MQTT connection and device-liveness regression tests."""

from types import SimpleNamespace

from aegis_soc import config
from aegis_soc.mqtt_client import MQTTManager


def test_unconfigured_broker_never_opens_an_mqtt_connection(monkeypatch):
    manager = MQTTManager()
    calls = []
    monkeypatch.setattr("aegis_soc.mqtt_client.config.BROKER_CONFIGURED", False, raising=False)
    monkeypatch.setattr(manager.client, "connect_async", lambda *args: calls.append(args))
    monkeypatch.setattr(manager.client, "loop_start", lambda: calls.append("loop"))

    manager.start()

    assert calls == []


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


def test_uplink_state_transitions_send_one_outbound_notification_each(monkeypatch):
    monkeypatch.setattr(
        "aegis_soc.mqtt_client.db.log_event",
        lambda *args, **kwargs: None,
    )
    notifications = []
    monkeypatch.setattr(
        "aegis_soc.comms.send_webhook_alert",
        lambda *args, **kwargs: notifications.append((args, kwargs)),
    )
    manager = MQTTManager()

    lockdown = SimpleNamespace(
        topic=config.TOPIC_STATUS,
        payload=b'{"state":"LOCKDOWN","reason":"cut","rssi":-48,"heap":200000}',
    )
    normal = SimpleNamespace(
        topic=config.TOPIC_STATUS,
        payload=b'{"state":"NORMAL","reason":"restored","rssi":-47,"heap":199000}',
    )

    manager._on_message(None, None, lockdown)
    manager._on_message(None, None, lockdown)
    manager._on_message(None, None, normal)
    manager._on_message(None, None, normal)

    assert notifications == [
        (("LOCKDOWN", "cut", -48, 200000), {"attacker_ip": None}),
        (("NORMAL", "restored", -47, 199000), {"attacker_ip": None}),
    ]


def test_telegram_failure_does_not_change_status_ack_or_physical_correlation(monkeypatch):
    monkeypatch.setattr(
        "aegis_soc.mqtt_client.db.log_event",
        lambda *args, **kwargs: None,
    )
    monkeypatch.setattr(
        "aegis_soc.comms.send_webhook_alert",
        lambda *args, **kwargs: (_ for _ in ()).throw(OSError("offline")),
    )
    manager = MQTTManager()
    statuses = []
    acknowledgements = []
    manager.status_callback = lambda *args: statuses.append(args)
    manager.ack_callback = lambda *args: acknowledgements.append(args)

    message = SimpleNamespace(
        topic=config.TOPIC_STATUS,
        payload=(
            b'{"state":"LOCKDOWN","reason":"verified","rssi":-48,'
            b'"heap":200000,"command_nonce":"physical-123"}'
        ),
    )

    manager._on_message(None, None, message)

    assert statuses == [("LOCKDOWN", -48, 200000, "physical-123")]
    assert acknowledgements == []
