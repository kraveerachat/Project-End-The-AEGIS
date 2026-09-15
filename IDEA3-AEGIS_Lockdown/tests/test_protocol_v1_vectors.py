"""Protocol v1 golden vectors: self-consistency against the spec-literal reference.

These tests never import ``aegis_soc``; the codec, inbound verifier, and
firmware parity tests consume the same fixture.
"""

from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path

import protocol_v1_reference as ref
import protocol_v1_vectors_generate as generator

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "protocol-v1-vectors.json"


def _fixture() -> dict:
    return json.loads(FIXTURE.read_text(encoding="ascii"))


def _wire(entry: dict) -> bytes:
    return bytes.fromhex(entry["wireHex"]) if entry.get("wireHex") else entry["wire"].encode("ascii")


def test_committed_fixture_equals_generator_output():
    assert FIXTURE.read_text(encoding="ascii") == generator.render(generator.build_fixture())


def test_test_only_keys_are_the_documented_public_values():
    keys = _fixture()["testOnlyKeys"]
    assert bytes.fromhex(keys["c2d"]) == bytes(range(0x20))
    assert bytes.fromhex(keys["d2c"]) == bytes(range(0x20, 0x40))
    assert keys["c2d"] != keys["d2c"]
    assert "TEST ONLY" in _fixture()["notice"]


def test_hmac_primitive_matches_rfc_4231():
    for case in _fixture()["hmacPrimitive"]:
        digest = hmac.new(bytes.fromhex(case["keyHex"]), bytes.fromhex(case["dataHex"]), hashlib.sha256).hexdigest()
        assert digest == case["mac"], case["source"]


def test_valid_vectors_match_the_reference_signing_input_mac_and_wire():
    fixture = _fixture()
    keys = {kind: bytes.fromhex(fixture["testOnlyKeys"]["c2d" if ref.DOMAIN[kind] == ref.C2D else "d2c"])
            for kind in ref.DOMAIN}
    assert {vector["kind"] for vector in fixture["valid"]} == {"COMMAND", "HEARTBEAT", "ACK", "STATUS"}
    for vector in fixture["valid"]:
        kind = vector["kind"]
        expected_input = ref.signing_input(ref.DOMAIN[kind], vector["topic"], vector["elements"])
        assert vector["signingInputHex"] == expected_input.hex(), vector["id"]
        assert vector["mac"] == ref.mac(keys[kind], ref.DOMAIN[kind], vector["topic"], vector["elements"]), vector["id"]
        assert vector["wire"] == ref.wire(vector["elements"][0], [*vector["elements"][1:], vector["mac"]]).decode()
        assert len(vector["wire"]) <= 512
        # The first length prefix is the protocol label, never a raw concatenation.
        assert expected_input.startswith(len(ref.LABEL).to_bytes(4, "big") + ref.LABEL)


def test_length_prefix_distinguishes_concatenation_equivalent_splits():
    pair = _fixture()["lengthPrefixPair"]
    assert "".join(pair["a"]) == "".join(pair["b"])
    assert pair["signingInputHexA"] != pair["signingInputHexB"]
    key = bytes(range(0x20, 0x40))
    domain = pair["domain"].encode()
    assert ref.mac(key, domain, pair["topic"], pair["a"]) != ref.mac(key, domain, pair["topic"], pair["b"])


def test_domains_and_keys_are_separated_per_direction():
    fixture = _fixture()
    status = next(vector for vector in fixture["valid"] if vector["id"] == "V-ST-PERIODIC")
    c2d = bytes.fromhex(fixture["testOnlyKeys"]["c2d"])
    d2c = bytes.fromhex(fixture["testOnlyKeys"]["d2c"])
    macs = {
        ref.mac(d2c, ref.D2C, status["topic"], status["elements"]),
        ref.mac(c2d, ref.D2C, status["topic"], status["elements"]),
        ref.mac(d2c, ref.C2D, status["topic"], status["elements"]),
    }
    assert len(macs) == 3


def test_scenarios_cover_every_stage_both_receivers_and_the_binding_order():
    scenarios = _fixture()["scenarios"]
    ids = [scenario["id"] for scenario in scenarios]
    assert len(ids) == len(set(ids))
    stages = {(scenario["receiver"], scenario["expectStage"]) for scenario in scenarios}
    for receiver in ("core", "device"):
        for stage in ("ACCEPTED", "TRANSPORT", "SCHEMA", "PAYLOAD", "TIME", "AUTH", "SKEW", "REPLAY"):
            assert (receiver, stage) in stages, (receiver, stage)
    assert ("device", "PERSIST") in stages
    for required in (
        "C-TIME-BEFORE-AUTH", "C-AUTH-BEFORE-SKEW", "C-AUTH-BEFORE-REPLAY", "C-SKEW-BEFORE-REPLAY",
        "D-TIME-BEFORE-AUTH", "D-AUTH-BEFORE-SKEW", "D-SKEW-BEFORE-REPLAY",
    ):
        assert required in ids


def test_scenario_mac_validity_claims_hold_for_parseable_wires():
    fixture = _fixture()
    keys = {"c2d": bytes.fromhex(fixture["testOnlyKeys"]["c2d"]), "d2c": bytes.fromhex(fixture["testOnlyKeys"]["d2c"])}
    checked = 0
    for scenario in fixture["scenarios"]:
        if scenario["macValid"] is None:
            assert scenario["expectStage"] in {"TRANSPORT", "SCHEMA"}, scenario["id"]
            continue
        raw = _wire(scenario)
        try:
            elements = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(elements, list) or len(elements) < 3 or not all(isinstance(e, str) for e in elements[1:]):
            continue
        kind = scenario["topic"].rsplit("/", 1)[1].upper()
        kind = {"COMMAND": "COMMAND", "HEARTBEAT": "HEARTBEAT", "ACK": "ACK", "STATUS": "STATUS"}[kind]
        key = keys["c2d" if ref.DOMAIN[kind] == ref.C2D else "d2c"]
        texts = [str(elements[0]), *elements[1:-1]]
        valid = ref.mac(key, ref.DOMAIN[kind], scenario["topic"], texts) == elements[-1]
        assert valid is scenario["macValid"], scenario["id"]
        checked += 1
    assert checked > 60
