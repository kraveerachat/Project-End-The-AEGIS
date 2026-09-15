"""Host-compiled C++ Protocol v1 parity against the independent fixture."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from shutil import which

import pytest

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / "firmware/lib/aegis_protocol"
DRIVER = ROOT / "firmware/test/native/protocol_parity_main.cpp"
CRYPTO = ROOT / "firmware/test/native/crypto_openssl.cpp"
FIXTURE = ROOT / "tests/fixtures/protocol-v1-vectors.json"


def _fixture():
    return json.loads(FIXTURE.read_text(encoding="ascii"))


@pytest.fixture(scope="module")
def parity_binary(tmp_path_factory):
    if which("g++") is None or not Path("/usr/include/openssl/hmac.h").is_file():
        pytest.skip("g++ and OpenSSL headers are required for C++ parity")
    output = tmp_path_factory.mktemp("p4-cpp") / "protocol-parity"
    subprocess.run(
        ["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-O1", "-I", str(LIB),
         str(LIB / "aegis_protocol.cpp"), str(CRYPTO), str(DRIVER), "-lcrypto", "-o", str(output)],
        check=True, capture_output=True, text=True,
    )
    return output


def _run(binary, *args):
    environment = {**os.environ, "ASAN_OPTIONS": "detect_leaks=0"}
    result = subprocess.run([str(binary), *args], check=True, capture_output=True, text=True, env=environment)
    return result.stdout.rstrip("\n")


def test_cpp_signing_input_and_hmac_equal_every_valid_vector(parity_binary):
    fixture = _fixture()
    for vector in fixture["valid"]:
        direction = "CORE_TO_DEVICE" if vector["kind"] in {"COMMAND", "HEARTBEAT"} else "DEVICE_TO_CORE"
        key = fixture["testOnlyKeys"]["c2d" if direction == "CORE_TO_DEVICE" else "d2c"]
        elements = ",".join(element.encode("ascii").hex() for element in vector["elements"])
        actual = _run(parity_binary, "sign", key, direction, vector["topic"], elements)
        assert actual == f'{vector["signingInputHex"]}\t{vector["mac"]}', vector["id"]


def test_cpp_parser_matches_python_transport_schema_and_payload_stages(parity_binary):
    fixture = _fixture()
    for vector in fixture["valid"]:
        receiver = "device" if vector["kind"] in {"COMMAND", "HEARTBEAT"} else "core"
        assert _run(parity_binary, "parse", vector["wire"].encode().hex(), vector["topic"],
                    fixture["deviceId"], receiver, "0") == "ACCEPTED\tOK", vector["id"]

    early = {"TRANSPORT", "SCHEMA", "PAYLOAD"}
    for scenario in fixture["scenarios"]:
        expected = (scenario["expectStage"], scenario["expectCode"])
        if expected[0] not in early:
            expected = ("ACCEPTED", "OK")
        wire_hex = scenario.get("wireHex") or scenario["wire"].encode().hex()
        retained = "1" if scenario.get("retain") else "0"
        actual = _run(parity_binary, "parse", wire_hex, scenario["topic"], fixture["deviceId"],
                      scenario["receiver"], retained)
        assert actual == "\t".join(expected), scenario["id"]


def test_cpp_mac_verification_uses_the_constant_time_comparator():
    source = (LIB / "aegis_protocol.cpp").read_text(encoding="utf-8")
    verify = source.split("bool verify(", 1)[1].split("\n}", 1)[0]
    assert "ctEqual32" in verify
    assert "memcmp" not in verify and "strcmp" not in verify


def test_cpp_parser_survives_seeded_mutations_under_sanitizers(tmp_path):
    if which("g++") is None or not Path("/usr/include/openssl/hmac.h").is_file():
        pytest.skip("g++ and OpenSSL headers are required for sanitizer parity")
    output = tmp_path / "protocol-parity-sanitized"
    subprocess.run(
        ["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror", "-O1", "-g",
         "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-I", str(LIB),
         str(LIB / "aegis_protocol.cpp"), str(CRYPTO), str(DRIVER), "-lcrypto", "-o", str(output)],
        check=True, capture_output=True, text=True,
    )
    vector = _fixture()["valid"][0]
    assert _run(output, "fuzz", vector["wire"].encode().hex(), vector["topic"], _fixture()["deviceId"], "10000") == "OK"
