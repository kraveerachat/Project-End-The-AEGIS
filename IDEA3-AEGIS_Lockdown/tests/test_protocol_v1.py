"""Protocol v1 codec: grammar, signing, key handling (design §4)."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from aegis_soc import protocol_v1 as p1

FIXTURE = json.loads((Path(__file__).resolve().parent / "fixtures" / "protocol-v1-vectors.json").read_text("ascii"))
DEVICE = FIXTURE["deviceId"]
KEYS = p1.ProtocolKeys(
    c2d=bytes.fromhex(FIXTURE["testOnlyKeys"]["c2d"]),
    d2c=bytes.fromhex(FIXTURE["testOnlyKeys"]["d2c"]),
)
RECEIVER_KINDS = {"core": frozenset({p1.ACK, p1.STATUS}), "device": frozenset({p1.COMMAND, p1.HEARTBEAT})}
GENERIC_STAGES = {"TRANSPORT", "SCHEMA", "PAYLOAD"}


def _wire(entry: dict) -> bytes:
    return bytes.fromhex(entry["wireHex"]) if entry.get("wireHex") else entry["wire"].encode("ascii")


def test_fixed_constants_and_enums_fail_closed():
    assert p1.PROTOCOL_VERSION == 1
    assert p1.MAX_PAYLOAD_BYTES == 512
    assert p1.TIME_FLOOR == FIXTURE["timeFloor"] == 1_789_430_400
    assert p1.ACTIONS == frozenset({"CUT_UPLINK", "RESTORE_UPLINK"})
    assert p1.ACK_RESULTS == frozenset({"ACCEPTED", "REJECTED_EXPIRED", "REJECTED_SEQUENCE", "REJECTED_PERSIST"})
    assert p1.TIME_TRUST_STATES == frozenset({"SYNCED", "HOLDOVER", "UNTRUSTED"})
    assert p1.OUTPUT_STATES == frozenset({"NORMAL", "LOCKDOWN"})
    assert p1.STATUS_REASONS == frozenset(
        {"BOOT", "PERIODIC", "COMMAND", "DEADMAN", "BOOT_GRACE", "SEQUENCE_REJECTED"}
    )
    for enum in (p1.ACTIONS, p1.ACK_RESULTS, p1.TIME_TRUST_STATES, p1.OUTPUT_STATES, p1.STATUS_REASONS):
        assert isinstance(enum, frozenset)
    assert p1.DOMAIN_BY_KIND == {
        "COMMAND": "CORE_TO_DEVICE", "HEARTBEAT": "CORE_TO_DEVICE", "ACK": "DEVICE_TO_CORE", "STATUS": "DEVICE_TO_CORE",
    }


def test_topics_are_exact_per_device_and_reject_invalid_device_ids():
    topics = p1.topics(DEVICE)
    assert topics.command == "aegis/idea3/v1/test-device-01/command"
    assert topics.heartbeat == "aegis/idea3/v1/test-device-01/heartbeat"
    assert topics.ack == "aegis/idea3/v1/test-device-01/ack"
    assert topics.status == "aegis/idea3/v1/test-device-01/status"
    for invalid in ("", "Test", "a", "-abc", "abc-", "a" * 33, "dev+1", "dev/1", "#"):
        with pytest.raises(ValueError):
            p1.topics(invalid)


@pytest.mark.parametrize("vector", FIXTURE["valid"], ids=lambda vector: vector["id"])
def test_valid_vectors_parse_verify_and_encode_byte_exactly(vector):
    raw = vector["wire"].encode("ascii")
    message = p1.parse(raw, topic=vector["topic"], device_id=DEVICE, accept_kinds=p1.KINDS)
    assert message.kind == vector["kind"]
    assert list(message.elements) == vector["elements"]
    assert message.mac == vector["mac"]
    assert p1.signing_input(p1.DOMAIN_BY_KIND[message.kind], vector["topic"], message.elements).hex() == (
        vector["signingInputHex"]
    )
    assert p1.verify(message, KEYS) is True
    topic, encoded = p1.encode(message.kind, device_id=DEVICE, fields=message.fields, keys=KEYS)
    assert topic == vector["topic"]
    assert encoded == raw


@pytest.mark.parametrize("scenario", FIXTURE["scenarios"], ids=lambda scenario: scenario["id"])
def test_generic_parse_and_verify_agree_with_every_scenario(scenario):
    raw = _wire(scenario)
    kinds = RECEIVER_KINDS[scenario["receiver"]]
    stage, code = scenario["expectStage"], scenario["expectCode"]
    if stage in GENERIC_STAGES and code != "RETAINED":
        with pytest.raises(p1.ProtocolRejected) as rejected:
            p1.parse(raw, topic=scenario["topic"], device_id=DEVICE, accept_kinds=kinds)
        assert (rejected.value.stage, rejected.value.code) == (stage, code)
        return
    message = p1.parse(raw, topic=scenario["topic"], device_id=DEVICE, accept_kinds=kinds)
    if scenario["macValid"] is not None:
        assert p1.verify(message, KEYS) is scenario["macValid"]
    else:
        # Receiver-level TRANSPORT (retained) rejections carry an otherwise valid wire.
        assert (stage, code) == ("TRANSPORT", "RETAINED")
        assert p1.verify(message, KEYS) is True


def test_verify_compares_raw_digests_with_compare_digest(monkeypatch):
    calls = []
    original = p1.hmac.compare_digest

    def spy(left, right):
        calls.append((len(left), len(right)))
        return original(left, right)

    monkeypatch.setattr(p1.hmac, "compare_digest", spy)
    vector = FIXTURE["valid"][0]
    message = p1.parse(vector["wire"].encode(), topic=vector["topic"], device_id=DEVICE, accept_kinds=p1.KINDS)
    assert p1.verify(message, KEYS) is True
    assert calls == [(32, 32)]


def test_verify_uses_the_key_fixed_by_the_message_kind():
    status = next(vector for vector in FIXTURE["valid"] if vector["kind"] == "STATUS")
    message = p1.parse(status["wire"].encode(), topic=status["topic"], device_id=DEVICE, accept_kinds=p1.KINDS)
    assert p1.verify(message, KEYS) is True
    swapped = p1.ProtocolKeys(c2d=KEYS.d2c, d2c=KEYS.c2d)
    assert p1.verify(message, swapped) is False


def test_skew_window_edges():
    now = FIXTURE["timeFloor"] + 1_000
    assert p1.check_skew(now, now) is None
    assert p1.check_skew(now + 2, now) is None
    assert p1.check_skew(now + 3, now) == "FUTURE"
    assert p1.check_skew(now - 30, now) is None
    assert p1.check_skew(now - 31, now) == "STALE"


def test_new_msg_id_is_128_bit_lowercase_hex_and_never_zero():
    value = p1.new_msg_id()
    assert len(value) == 32 and value == value.lower() and int(value, 16) >= 0
    draws = iter([bytes(16), bytes(range(1, 17))])
    assert p1.new_msg_id(rng=lambda _size: next(draws)) == bytes(range(1, 17)).hex()
    with pytest.raises(RuntimeError):
        p1.new_msg_id(rng=lambda _size: bytes(16))


@pytest.mark.parametrize(
    ("kind", "fields"),
    [
        ("COMMAND", {"msg_id": "a" * 32, "seq": 0, "issued_at": 1789434000, "expires_at": 1789434030, "action": "CUT_UPLINK"}),
        ("COMMAND", {"msg_id": "a" * 32, "seq": 1, "issued_at": 1789434000, "expires_at": 1789434030, "action": "REBOOT"}),
        ("COMMAND", {"msg_id": "a" * 32, "seq": 1, "issued_at": 1789434000, "expires_at": 1789434031, "action": "CUT_UPLINK"}),
        ("COMMAND", {"msg_id": "a" * 32, "seq": 1, "issued_at": 1789434000, "action": "CUT_UPLINK"}),
        ("HEARTBEAT", {"msg_id": "a" * 32, "issued_at": 1789434000, "extra": "x"}),
        ("HEARTBEAT", {"msg_id": "0" * 32, "issued_at": 1789434000}),
        ("STATUS", {"msg_id": "b" * 32, "device_time": 1789434000, "time_trust": "SYNCED", "output_state": "NORMAL",
                    "reason": "PERIODIC", "cmd_msg_id": "", "cmd_seq": 0, "device_seq_hwm": 0, "rssi_dbm": 5,
                    "heap_free": 1}),
        ("ACK", {"msg_id": "c" * 32, "device_time": 1789434000, "ack_for_msg_id": "d" * 32, "ack_for_seq": 1,
                 "result": "OK"}),
    ],
)
def test_encode_refuses_values_outside_the_grammar(kind, fields):
    with pytest.raises(ValueError):
        p1.encode(kind, device_id=DEVICE, fields=fields, keys=KEYS)


def test_encode_accepts_integers_and_emits_canonical_text():
    topic, raw = p1.encode(
        "HEARTBEAT", device_id=DEVICE, fields={"msg_id": "e" * 32, "issued_at": 1789434000}, keys=KEYS,
    )
    assert topic.endswith("/heartbeat")
    assert raw.startswith(b'[1,"HEARTBEAT","test-device-01","' + b"e" * 32 + b'","1789434000","')


def _write_keys(tmp_path, c2d: bytes, d2c: bytes, *, c2d_text=None, d2c_text=None):
    c2d_path = tmp_path / "c2d.key"
    d2c_path = tmp_path / "d2c.key"
    c2d_path.write_text(c2d_text if c2d_text is not None else c2d.hex() + "\n", encoding="ascii")
    d2c_path.write_text(d2c_text if d2c_text is not None else d2c.hex() + "\n", encoding="ascii")
    return c2d_path, d2c_path


def test_load_protocol_keys_accepts_two_distinct_random_keys(tmp_path):
    c2d = hashlib.sha256(b"unit c2d").digest()
    d2c = hashlib.sha256(b"unit d2c").digest()
    keys = p1.load_protocol_keys(*_write_keys(tmp_path, c2d, d2c))
    assert (keys.c2d, keys.d2c) == (c2d, d2c)
    assert c2d.hex() not in repr(keys) and d2c.hex() not in repr(keys)


@pytest.mark.parametrize(
    "case",
    ["missing", "short", "non_hex", "uppercase", "whitespace", "all_zero", "equal", "test_c2d", "test_d2c", "swapped_test",
     "demo"],
)
def test_load_protocol_keys_refuses_unsafe_material_without_echoing_it(tmp_path, case):
    good_c2d = hashlib.sha256(b"unit c2d").digest()
    good_d2c = hashlib.sha256(b"unit d2c").digest()
    demo = hashlib.sha256(b"AEGIS-DEMO-SHARED-SECRET-change-me").digest()
    variants = {
        "short": {"c2d_text": good_c2d.hex()[:62]},
        "non_hex": {"c2d_text": "z" * 64},
        "uppercase": {"c2d_text": good_c2d.hex().upper()},
        "whitespace": {"c2d_text": " " + good_c2d.hex()},
        "all_zero": {"c2d": bytes(32)},
        "equal": {"d2c": good_c2d},
        "test_c2d": {"c2d": KEYS.c2d},
        "test_d2c": {"d2c": KEYS.d2c},
        "swapped_test": {"c2d": KEYS.d2c},
        "demo": {"c2d": demo},
    }
    options = {"c2d": good_c2d, "d2c": good_d2c}
    options.update(variants.get(case, {}))
    c2d_path, d2c_path = _write_keys(tmp_path, options.pop("c2d"), options.pop("d2c"), **options)
    if case == "missing":
        c2d_path.unlink()
    with pytest.raises(p1.ProtocolKeyError) as refused:
        p1.load_protocol_keys(c2d_path, d2c_path)
    message = str(refused.value)
    for secret in (good_c2d.hex(), good_d2c.hex(), KEYS.c2d.hex(), KEYS.d2c.hex(), demo.hex()):
        assert secret not in message
