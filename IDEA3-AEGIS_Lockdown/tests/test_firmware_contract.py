from pathlib import Path

FIRMWARE_SOURCE = (
    Path(__file__).resolve().parents[1]
    / "firmware"
    / "src"
    / "main.cpp"
)


def test_firmware_ack_payload_contains_nonce():
    """ESP32 ACK payload must echo the command nonce for correlation."""
    source = FIRMWARE_SOURCE.read_text(encoding="utf-8")

    assert 'doc["nonce"] = nonce;' in source


def test_firmware_command_acks_echo_parsed_nonce():
    """Command ACK paths must return the nonce parsed from that command."""
    source = FIRMWARE_SOURCE.read_text(encoding="utf-8")

    expected_calls = (
        'sendAck("STALE","timestamp out of window", nonce);',
        'sendAck("REPLAY","nonce reused", nonce);',
        'sendAck("BAD_HMAC","sig mismatch", nonce);',
        'sendAck("OK","uplink cut", nonce);',
        'sendAck("OK","uplink restored", nonce);',
        'sendAck("UNKNOWN_CMD", cmd, nonce);',
    )

    for call in expected_calls:
        assert call in source


def test_firmware_command_status_can_include_command_nonce():
    source = FIRMWARE_SOURCE.read_text(encoding="utf-8")

    assert 'doc["command_nonce"] = commandNonce;' in source
    assert 'setLockdown(true, "verified", nonce)' in source
    assert 'setLockdown(false, "verified", nonce)' in source


def test_firmware_non_command_status_does_not_forward_command_nonce():
    source = FIRMWARE_SOURCE.read_text(encoding="utf-8")

    assert 'publishStatus("ONLINE", "Boot completed");' in source
    assert 'setLockdown(true, "SECURE BOOT - ไม่พบ Heartbeat ภายใน 90 วิ!");' in source
    assert 'setLockdown(true, "DEAD MAN\'S SWITCH - ขาดสัญญาณ Heartbeat 60 วิ!");' in source
    assert 'publishStatus(isLockedDown ? "LOCKDOWN" : "NORMAL", "heartbeat");' in source


def test_firmware_boots_relay_in_fail_secure_state():
    """Application startup must engage the active-low relay before output enable."""
    source = FIRMWARE_SOURCE.read_text(encoding="utf-8")
    setup = source.split("void setup()", 1)[1].split("void loop()", 1)[0]
    preload_trigger = "digitalWrite(RELAY_IN, RELAY_TRIGGER);"
    enable_output = "pinMode(RELAY_IN, OUTPUT);"

    assert "bool isLockedDown = true;" in source
    assert preload_trigger in setup
    assert "digitalWrite(RELAY_IN, RELAY_RELEASE);" not in setup
    assert setup.index(preload_trigger) < setup.index(enable_output)
