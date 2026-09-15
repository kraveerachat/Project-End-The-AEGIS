"""Core MQTT adapter: TLS, exact topics, and authentication before effect (design §6.2, §8).

Every test injects a fake paho client, so the adapter logic is exercised under
any installed paho-mqtt. Only the real default-client test needs the pinned
paho-mqtt 2.x API and says so when it is unavailable.
"""

from __future__ import annotations

from types import SimpleNamespace

import paho.mqtt.client as paho
import pytest

from aegis_soc import config
from aegis_soc import mqtt_client as mqtt_module
from aegis_soc import protocol_v1 as p1
from aegis_soc.mqtt_client import MQTTManager
from aegis_soc.protocol_inbound import ProtocolContext
from aegis_soc.protocol_store import ProtocolStore

DEVICE = "test-device-01"
# Public TEST-ONLY golden-vector keys; Core key loading refuses them.
KEYS = p1.ProtocolKeys(c2d=bytes(range(0x20)), d2c=bytes(range(0x20, 0x40)))
NOW = p1.TIME_FLOOR + 3_600
TOPICS = p1.topics(DEVICE)


class FakePahoClient:
    def __init__(self, publish_rc=0):
        self.calls = []
        self.subscriptions = []
        self.published = []
        self.publish_rc = publish_rc

    def subscribe(self, topics):
        self.subscriptions.append(topics)

    def publish(self, topic, payload, qos=0, retain=False):
        self.published.append((topic, payload, qos, retain))
        return SimpleNamespace(rc=self.publish_rc)

    def tls_set_context(self, context):
        self.calls.append(("tls_set_context", context))

    def tls_insecure_set(self, value):
        self.calls.append(("tls_insecure_set", value))

    def username_pw_set(self, username, password):
        self.calls.append(("username_pw_set", username))

    def connect_async(self, host, port, keepalive):
        self.calls.append(("connect_async", host, port, keepalive))

    def loop_start(self):
        self.calls.append(("loop_start",))

    def loop_stop(self):
        self.calls.append(("loop_stop",))

    def disconnect(self):
        self.calls.append(("disconnect",))


class Clock:
    def __init__(self, value=NOW):
        self.value = value

    def trusted_now(self):
        return self.value


@pytest.fixture(autouse=True)
def audit(monkeypatch):
    events = []
    monkeypatch.setattr(mqtt_module.db, "log_event", lambda *args, **kwargs: events.append(args))
    return events


@pytest.fixture(autouse=True)
def notifications(monkeypatch):
    sent = []
    monkeypatch.setattr("aegis_soc.comms.send_webhook_alert", lambda *args, **kwargs: sent.append((args, kwargs)))
    return sent


@pytest.fixture
def store(tmp_path):
    instance = ProtocolStore(tmp_path / "data" / "core-protocol.sqlite3", wall_clock=lambda: NOW)
    yield instance
    instance.close()


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def client():
    return FakePahoClient()


@pytest.fixture
def manager(store, clock, client):
    return MQTTManager(protocol=ProtocolContext(DEVICE, KEYS, store, clock), client_factory=lambda: client,
                       protocol_mode="v1")


@pytest.fixture
def broker(monkeypatch, tmp_path):
    ca = tmp_path / "mqtt-ca.pem"
    ca.write_text("TEST ONLY placeholder\n", encoding="ascii")
    monkeypatch.setattr(config, "BROKER_CONFIGURED", True, raising=False)
    monkeypatch.setattr(config, "BROKER_IP", "127.0.0.1")
    monkeypatch.setattr(config, "PORT", 8883)
    monkeypatch.setattr(config, "MQTT_TLS", True)
    monkeypatch.setattr(config, "MQTT_CA_FILE", str(ca))
    monkeypatch.setattr(config, "MQTT_USER", "idea3-core")
    monkeypatch.setattr(config, "MQTT_PASS", "test-only-password")
    contexts = []
    monkeypatch.setattr(mqtt_module, "build_mqtt_ssl_context", lambda path: contexts.append(path) or "TLS-CONTEXT")
    return contexts


def status(**overrides) -> bytes:
    fields = {
        "msg_id": p1.new_msg_id(), "device_time": NOW - 1, "time_trust": "SYNCED", "output_state": "NORMAL",
        "reason": "PERIODIC", "cmd_msg_id": "", "cmd_seq": 0, "device_seq_hwm": 0, "rssi_dbm": -60,
        "heap_free": 150000,
    }
    fields.update(overrides)
    return p1.encode(p1.STATUS, device_id=DEVICE, fields=fields, keys=KEYS)[1]


def ack(command, result="ACCEPTED", **overrides) -> bytes:
    fields = {
        "msg_id": p1.new_msg_id(), "device_time": NOW - 1, "ack_for_msg_id": command.msg_id,
        "ack_for_seq": command.seq, "result": result,
    }
    fields.update(overrides)
    return p1.encode(p1.ACK, device_id=DEVICE, fields=fields, keys=KEYS)[1]


def deliver(manager, topic, payload, retain=False):
    manager._on_message(None, None, SimpleNamespace(topic=topic, payload=payload, retain=retain))


def open_command(store, action="CUT_UPLINK"):
    reserved = store.reserve_command(DEVICE, action, NOW, NOW + 30)
    store.mark_published(reserved.msg_id)
    return reserved


def flip_mac(payload: bytes) -> bytes:
    return payload[:-3] + (b"0" if payload[-3:-2] != b"0" else b"1") + payload[-2:]


# ---- connection, TLS, identity ---------------------------------------------

def test_unconfigured_broker_never_opens_an_mqtt_connection(manager, client, monkeypatch):
    monkeypatch.setattr(config, "BROKER_CONFIGURED", False, raising=False)
    manager.start()
    assert client.calls == []


def test_v1_without_a_protocol_context_never_connects(broker, client):
    manager = MQTTManager(protocol=None, client_factory=lambda: client, protocol_mode="v1")
    manager.start()
    assert client.calls == []


def test_tls_without_a_ca_never_falls_back_to_plaintext(manager, client, broker, monkeypatch):
    def refuse(_path):
        raise ValueError("an MQTT CA file is required for TLS")

    monkeypatch.setattr(mqtt_module, "build_mqtt_ssl_context", refuse)
    manager.start()
    assert client.calls == []


def test_tls_start_uses_the_verified_context_and_a_distinct_core_identity(manager, client, broker):
    manager.start()
    assert broker == [config.MQTT_CA_FILE]
    assert ("tls_set_context", "TLS-CONTEXT") in client.calls
    assert ("username_pw_set", "idea3-core") in client.calls
    assert ("connect_async", "127.0.0.1", 8883, 60) in client.calls
    assert not any(call[0] == "tls_insecure_set" for call in client.calls)
    assert client.calls.index(("tls_set_context", "TLS-CONTEXT")) < client.calls.index(("connect_async", "127.0.0.1", 8883, 60))


def test_connect_subscribes_exactly_the_two_device_to_core_topics(manager, client):
    manager._on_connect(client, None, None, 0)
    assert manager.is_connected is True
    assert client.subscriptions == [[(TOPICS.ack, 0), (TOPICS.status, 0)]]
    flat = [topic for group in client.subscriptions for topic, _ in group]
    assert config.TOPIC_ATTACKER_IP not in flat
    assert not any("#" in topic or "+" in topic for topic in flat)


def test_rejected_broker_connection_is_not_reported_connected(manager, client):
    observed = []
    manager.connection_callback = observed.append
    manager._on_connect(client, None, None, 5)
    assert manager.is_connected is False
    assert observed == [False]
    assert client.subscriptions == []


@pytest.mark.parametrize("reason_codes", [[0x80, 0], [0, 0x80], [SimpleNamespace(is_failure=True, value=0x80)]])
def test_a_refused_subscription_is_never_treated_as_ready(manager, client, reason_codes):
    observed = []
    manager.connection_callback = observed.append
    manager._on_connect(client, None, None, 0)
    manager._on_subscribe(client, None, 1, reason_codes)
    assert manager.is_connected is False
    assert observed == [True, False]


def test_publish_is_qos0_non_retained_and_reports_failure_honestly(manager, client):
    assert manager.publish(TOPICS.command, b"x") is False
    manager.is_connected = True
    assert manager.publish(TOPICS.command, b"x") is True
    assert client.published == [(TOPICS.command, b"x", 0, False)]
    client.publish_rc = 4
    assert manager.publish(TOPICS.command, b"y") is False


def test_default_client_is_mqtt311_clean_session_with_the_fixed_core_identity():
    if not hasattr(paho, "CallbackAPIVersion"):
        pytest.skip("system paho-mqtt < 2.0; the repository pins paho-mqtt 2.1.0")
    client = mqtt_module._paho_client()
    assert client._client_id == b"idea3-core"
    assert client._protocol == paho.MQTTv311
    assert client._clean_session is True


# ---- authentication before any effect ------------------------------------

@pytest.mark.parametrize(
    "payload_factory",
    [
        lambda: flip_mac(status()),
        lambda: status()[:-66] + b'"' + b"0" * 64 + b'"]',
        lambda: b'{"state":"NORMAL","reason":"heartbeat","rssi":-47,"heap":199000}',
        lambda: b'{"reason":"heartbeat"}',
        lambda: b"",
    ],
    ids=["bad-mac", "unsigned", "legacy-v0", "malformed-no-state", "empty"],
)
def test_unauthenticated_or_malformed_status_has_no_effect(manager, audit, notifications, payload_factory):
    statuses = []
    manager.status_callback = lambda *args: statuses.append(args)
    deliver(manager, TOPICS.status, payload_factory())
    assert manager.device_online() is False
    assert statuses == [] and notifications == [] and audit == []


def test_retained_evidence_has_no_effect(manager):
    statuses = []
    manager.status_callback = lambda *args: statuses.append(args)
    deliver(manager, TOPICS.status, status(), retain=True)
    assert manager.device_online() is False and statuses == []


def test_untrusted_core_time_rejects_valid_evidence(manager, clock):
    clock.value = None
    deliver(manager, TOPICS.status, status())
    assert manager.device_online() is False


def test_stale_future_wrong_device_and_replayed_status_have_no_effect(manager):
    statuses = []
    manager.status_callback = lambda *args: statuses.append(args)
    deliver(manager, TOPICS.status, status(device_time=NOW - 31))
    deliver(manager, TOPICS.status, status(device_time=NOW + 3))
    other = p1.encode(p1.STATUS, device_id="test-device-02", fields={
        "msg_id": p1.new_msg_id(), "device_time": NOW, "time_trust": "SYNCED", "output_state": "NORMAL",
        "reason": "PERIODIC", "cmd_msg_id": "", "cmd_seq": 0, "device_seq_hwm": 0, "rssi_dbm": -1, "heap_free": 1,
    }, keys=KEYS)
    deliver(manager, other[0], other[1])
    assert manager.device_online() is False and statuses == []
    replayed = status()
    deliver(manager, TOPICS.status, replayed)
    deliver(manager, TOPICS.status, replayed)
    assert len(statuses) == 1


def test_legacy_topics_are_ignored_in_v1_mode(manager):
    deliver(manager, config.TOPIC_STATUS, b'{"state":"LOCKDOWN","reason":"x","rssi":-1,"heap":1}')
    deliver(manager, config.TOPIC_ATTACKER_IP, b"203.0.113.9")
    assert manager.device_online() is False
    assert manager.last_attacker_ip is None


# ---- accepted evidence -----------------------------------------------------

def test_authenticated_periodic_status_marks_liveness_but_never_confirms_a_command(manager, store):
    command = open_command(store)
    statuses = []
    manager.status_callback = lambda *args: statuses.append(args)
    deliver(manager, TOPICS.status, status(output_state="LOCKDOWN", rssi_dbm=-48, heap_free=200000))
    assert manager.device_online() is True
    assert statuses == [("LOCKDOWN", -48, 200000, "")]
    assert store.command(command.msg_id)["status_correlated"] == 0


def test_command_status_confirms_only_the_open_command_once(manager, store, audit):
    command = open_command(store)
    statuses = []
    manager.status_callback = lambda *args: statuses.append(args)
    deliver(manager, TOPICS.status, status(output_state="LOCKDOWN", reason="COMMAND", cmd_msg_id=command.msg_id,
                                           cmd_seq=command.seq, device_seq_hwm=command.seq))
    deliver(manager, TOPICS.status, status(output_state="LOCKDOWN", reason="COMMAND", cmd_msg_id=command.msg_id,
                                           cmd_seq=command.seq, device_seq_hwm=command.seq))
    deliver(manager, TOPICS.status, status(output_state="LOCKDOWN", reason="COMMAND", cmd_msg_id="d" * 32,
                                           cmd_seq=9, device_seq_hwm=9))
    assert [item[3] for item in statuses] == [command.msg_id, "", ""]
    assert [event[0] for event in audit].count("P1_STATUS_UNCORRELATED") == 2


def test_ack_drives_pending_state_only_when_it_consumes_the_open_command(manager, store, audit):
    command = open_command(store)
    acks = []
    manager.ack_callback = lambda *args: acks.append(args)
    deliver(manager, TOPICS.ack, ack(command, ack_for_seq=command.seq + 1))
    assert acks == [] and manager.device_online() is True
    deliver(manager, TOPICS.ack, ack(command))
    deliver(manager, TOPICS.ack, ack(command))
    assert acks == [("OK", "ACCEPTED", command.msg_id)]
    assert "P1_ACK_UNCORRELATED" in [event[0] for event in audit]


def test_a_rejected_ack_is_forwarded_as_not_ok(manager, store):
    command = open_command(store)
    acks = []
    manager.ack_callback = lambda *args: acks.append(args)
    deliver(manager, TOPICS.ack, ack(command, result="REJECTED_SEQUENCE"))
    assert acks == [("REJECTED_SEQUENCE", "REJECTED_SEQUENCE", command.msg_id)]


def test_sequence_rejection_resyncs_forward_only_for_the_open_command(manager, store):
    command = open_command(store)
    deliver(manager, TOPICS.status, status(reason="PERIODIC", device_seq_hwm=40))
    assert store.last_allocated_seq(DEVICE) == command.seq
    deliver(manager, TOPICS.status, status(reason="SEQUENCE_REJECTED", cmd_msg_id="e" * 32, cmd_seq=1,
                                           device_seq_hwm=40))
    assert store.last_allocated_seq(DEVICE) == command.seq
    statuses = []
    manager.status_callback = lambda *args: statuses.append(args)
    deliver(manager, TOPICS.status, status(reason="SEQUENCE_REJECTED", cmd_msg_id=command.msg_id,
                                           cmd_seq=command.seq, device_seq_hwm=40))
    assert store.last_allocated_seq(DEVICE) == 40
    assert statuses[0][3] == ""


def test_uplink_state_transitions_send_one_outbound_notification_each(manager, notifications):
    for state in ("LOCKDOWN", "LOCKDOWN", "NORMAL", "NORMAL"):
        deliver(manager, TOPICS.status, status(output_state=state, reason="DEADMAN" if state == "LOCKDOWN" else "PERIODIC",
                                               rssi_dbm=-48, heap_free=200000))
    assert [call[0][0] for call in notifications] == ["LOCKDOWN", "NORMAL"]
    assert all(call[1] == {"attacker_ip": None} for call in notifications)


def test_notification_failure_does_not_change_status_or_correlation(manager, store, monkeypatch):
    monkeypatch.setattr("aegis_soc.comms.send_webhook_alert", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("x")))
    command = open_command(store)
    statuses = []
    manager.status_callback = lambda *args: statuses.append(args)
    deliver(manager, TOPICS.status, status(output_state="LOCKDOWN", reason="COMMAND", cmd_msg_id=command.msg_id,
                                           cmd_seq=command.seq, device_seq_hwm=command.seq))
    assert statuses == [("LOCKDOWN", -60, 150000, command.msg_id)]


# ---- legacy lab isolation -------------------------------------------------

@pytest.fixture
def legacy(client):
    return MQTTManager(protocol=None, client_factory=lambda: client, protocol_mode="legacy-v0-lab")


def test_legacy_lab_mode_keeps_its_topics_and_callbacks(legacy, client):
    legacy._on_connect(client, None, None, 0)
    flat = [topic for group in client.subscriptions for topic, _ in group]
    assert flat == [config.TOPIC_ACK, config.TOPIC_STATUS, config.TOPIC_ATTACKER_IP]
    statuses = []
    legacy.status_callback = lambda *args: statuses.append(args)
    deliver(legacy, config.TOPIC_STATUS, b'{"state":"LOCKDOWN","reason":"verified","rssi":-48,"heap":200000,'
                                         b'"command_nonce":"abc123"}')
    assert statuses == [("LOCKDOWN", -48, 200000, "abc123")]


def test_legacy_lab_mode_never_turns_a_malformed_status_into_normal(legacy):
    statuses = []
    legacy.status_callback = lambda *args: statuses.append(args)
    deliver(legacy, config.TOPIC_STATUS, b'{"reason":"heartbeat","rssi":-47,"heap":199000}')
    deliver(legacy, config.TOPIC_STATUS, b'{"state":"RESTORED","rssi":-47,"heap":199000}')
    deliver(legacy, config.TOPIC_STATUS, b"[1,2,3]")
    assert statuses == []
    assert legacy.device_online() is False


def test_legacy_attacker_topic_does_not_mark_esp32_online(legacy):
    legacy.attacker_callback = lambda ip: None
    deliver(legacy, config.TOPIC_ATTACKER_IP, b"203.0.113.9")
    assert legacy.last_attacker_ip == "203.0.113.9"
    assert legacy.device_online() is False
