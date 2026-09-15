"""Firmware integration contract around the host-proven Protocol v1 library."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "firmware/src/main.cpp"
SECRETS = ROOT / "firmware/src/secrets.h.example"
PLATFORMIO = ROOT / "firmware/platformio.ini"


def _source():
    return SOURCE.read_text(encoding="utf-8")


def _function(name):
    source = _source()
    match = re.search(rf"(?:void|bool|TimeTrust|String)\s+{name}\([^;]*\)\s*{{", source)
    if match is None:
        raise ValueError(f"firmware function {name} is missing")
    opening = source.index("{", match.start())
    depth = 1
    cursor = opening + 1
    while depth:
        depth += (source[cursor] == "{") - (source[cursor] == "}")
        cursor += 1
    return source[opening:cursor]


def test_firmware_uses_ca_verified_tls_only_mqtt():
    source = _source()
    assert "WiFiClientSecure" in source
    assert "setCACert(" in source
    assert "setInsecure(" not in source
    assert "WiFiClient wifiClient" not in source
    assert "1883" not in source


def test_firmware_checks_the_768_byte_mqtt_buffer_before_connecting():
    setup = _function("setup")
    assert "mqtt.setBufferSize(768)" in setup
    assert "mqttBufferReady" in setup
    connect = _function("connectMQTT")
    assert connect.index("if (!mqttBufferReady)") < connect.index("mqtt.connect(")


def test_firmware_uses_only_core_local_ntp_with_bounded_holdover():
    source = _source()
    sync = _function("syncTimeNTP")
    assert "sntp_set_sync_interval(60000)" in sync
    assert sync.index("sntp_set_sync_interval(60000)") < sync.index("configTime(")
    assert "ntpServer.c_str()" in sync
    assert "pool.ntp.org" not in source and "time.nist.gov" not in source
    assert "TIME_HOLDOVER_MAX_MS = 300000" in source
    assert "sntp_set_time_sync_notification_cb" in sync


def test_firmware_requires_trusted_time_before_mqtt_connect():
    connect = _function("connectMQTT")
    assert connect.index("timeTrust() == TimeTrust::UNTRUSTED") < connect.index("mqtt.connect(")


def test_firmware_has_fixed_identity_topics_qos0_and_nonretained_publish():
    source = _source()
    connect = _function("connectMQTT")
    assert "random(" not in connect
    assert "deviceId.c_str()" in connect
    assert "mqtt.subscribe(topicCommand.c_str(), 0)" in connect
    assert "mqtt.subscribe(topicHeartbeat.c_str(), 0)" in connect
    assert "topicAck" not in connect and "topicStatus" not in connect
    publish = _function("publishSigned")
    assert "mqtt.publish(" in publish
    assert ", false)" in publish


def test_command_validation_authenticates_before_skew_replay_persist_and_gpio():
    handler = _function("handleCommand")
    assert handler.index("aegis::p1::verify") < handler.index("checkAuthenticatedSkew")
    assert handler.index("checkAuthenticatedSkew") < handler.index("acceptedSequence")
    assert handler.index("acceptedSequence") < handler.index("putULong64")
    assert handler.index("putULong64") < handler.index("setLockdown(")


def test_persistence_failure_and_sequence_replay_never_actuate():
    handler = _function("handleCommand")
    persist_branch = handler.split("if (!preferences.putULong64", 1)[1].split("}", 1)[0]
    assert "REJECTED_PERSIST" in persist_branch
    assert "setLockdown(" not in persist_branch
    replay_branch = handler.split("if (!acceptedSequence", 1)[1].split("}", 1)[0]
    assert "REJECTED_SEQUENCE" in replay_branch
    assert "setLockdown(" not in replay_branch


def test_preparse_time_and_auth_failures_are_silent():
    handler = _function("onMqttMessage")
    before_dispatch = handler.split("handleCommand", 1)[0]
    assert "sendAck(" not in before_dispatch
    assert "publishStatus(" not in before_dispatch


def test_ack_and_status_are_signed_with_the_device_to_core_key():
    assert "DEVICE_TO_CORE" in _function("sendAck")
    assert "keyD2C" in _function("sendAck")
    assert "DEVICE_TO_CORE" in _function("publishStatus")
    assert "keyD2C" in _function("publishStatus")


def test_heartbeat_deadman_boot_and_reconnect_never_restore():
    for name in ("handleHeartbeat", "checkDeadman", "setup", "connectMQTT"):
        assert "RELAY_RELEASE" not in _function(name)
        assert "setLockdown(false" not in _function(name)


def test_firmware_boots_relay_in_fail_secure_state():
    source = _source()
    setup = _function("setup")
    preload = "digitalWrite(RELAY_IN, RELAY_TRIGGER);"
    enable = "pinMode(RELAY_IN, OUTPUT);"
    assert "bool isLockedDown = true;" in source
    assert preload in setup and enable in setup
    assert setup.index(preload) < setup.index(enable)
    assert "digitalWrite(RELAY_IN, RELAY_RELEASE);" not in setup


def test_provisioning_schema_and_keys_are_loaded_from_nvs():
    provisioning = _function("loadProvisioning")
    assert 'preferences.getUInt("schema", 0) == 1' in provisioning
    assert 'preferences.getBytes("k_c2d", keyC2D, 32)' in provisioning
    assert 'preferences.getBytes("k_d2c", keyD2C, 32)' in provisioning
    assert 'preferences.getULong64("seq_hi", 0)' in provisioning


def test_secrets_example_contains_only_public_ca_and_ntp_placeholders():
    text = SECRETS.read_text(encoding="utf-8")
    assert "SECRET_MQTT_CA_CERT" in text and "SECRET_NTP_SERVER" in text
    assert "SECRET_HMAC_KEY" not in text
    assert "BEGIN PRIVATE KEY" not in text
    assert not any(len(word) == 64 and all(char in "0123456789abcdef" for char in word) for word in text.split())


def test_platformio_pins_firmware_dependencies_without_upload_changes():
    text = PLATFORMIO.read_text(encoding="utf-8")
    assert "platform = espressif32@7.0.1" in text
    assert "knolleary/PubSubClient@2.8" in text
    assert "bblanchon/ArduinoJson@7.0.4" in text
    assert "upload_protocol" not in text
