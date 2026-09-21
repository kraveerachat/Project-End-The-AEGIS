"""AEGIS IDEA3 PR11 Phase 4 — L8 ESP32 provisioning / flash handler test suite.

Authoritative design:
  IDEA3-AEGIS_Lockdown/docs/superpowers/specs/
  2026-09-21-idea3-pr11-phase4-l8-operational-design.md
Decisions:
  OD-L8-01 through OD-L8-09 (2026-09-21).

Every test in this module runs against the FIXTURE device backend. No test
opens a serial device, invokes esptool against hardware, flashes, erases, or
burns an eFuse. `test_l8_tests_never_reference_real_serial_devices` enforces
that property over this file itself.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
STAGES = DEPLOY / "stages"
L8_STAGE = STAGES / "L8"
P4_LIB = DEPLOY / "p4-lib.sh"
L8_DEVICE = DEPLOY / "p4-l8-device.py"
NVS_PROVISION = DEPLOY / "p4-nvs-provision.py"
FIRMWARE = ROOT / "firmware"

REQUIRED_HANDLER_FILES = (
    "apply.sh",
    "verify.sh",
    "rollback.sh",
    "allow-keys.txt",
    "allow-listeners.txt",
)

# Fixture-only material. None of these values is, or may become, Production.
FIXTURE_MAC = "24:0a:c4:11:22:33"
FIXTURE_CHIP = "ESP32-D0WD-V3"
FIXTURE_FLASH_SIZE = "4MB"
FIXTURE_SERIAL_PORT = "/dev/ttyUSB0"
FIXTURE_C2D = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
FIXTURE_D2C = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
FIXTURE_WIFI_PSK = "fixture-wifi-psk-value-9f2a"
FIXTURE_MQTT_PASS = "fixture-mqtt-device-password-71bd"
FIXTURE_WIFI_SSID = "AEGIS-FIXTURE-AP"
FIXTURE_NTP = "203.0.113.9"

# A deliberately NON-default offset: deriving this proves the offset came from
# the reviewed partition table and not from a hardcoded 0x9000 (OD-L8-03).
FIXTURE_NVS_OFFSET = 0xB000

EVIDENCE_ALLOWED_FIELDS = {
    "schema_version",
    "run_id",
    "device_mac",
    "chip_identity",
    "flash_size",
    "firmware_sha256",
    "nvs_schema_version",
    "nvs_readback_match",
    "flash_result",
    "boot_verification_result",
    "failure_boundary",
}

FORBIDDEN_EVIDENCE_VALUES = (
    FIXTURE_C2D,
    FIXTURE_D2C,
    FIXTURE_WIFI_PSK,
    FIXTURE_MQTT_PASS,
)

PARTITION_TABLE = """\
# Name,   Type, SubType, Offset,   Size,     Flags
nvs,      data, nvs,     0xb000,   0x5000,
otadata,  data, ota,     0x10000,  0x2000,
app0,     app,  ota_0,   0x20000,  0x180000,
app1,     app,  ota_1,   0x1a0000, 0x180000,
spiffs,   data, spiffs,  0x320000, 0xd0000,
"""

CA_PEM = (
    "-----BEGIN CERTIFICATE-----\n"
    "MIIBfixtureCertificateBodyForRepositoryTestsOnlyNotATrustAnchor\n"
    "-----END CERTIFICATE-----\n"
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def load_device_module():
    """Import p4-l8-device.py as a module."""
    spec = importlib.util.spec_from_file_location("p4_l8_device", str(L8_DEVICE))
    assert spec is not None and spec.loader is not None, f"cannot load {L8_DEVICE}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_private(path: Path, text: str, mode: int = 0o600) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(mode)
    return path


def make_input_dir(base: Path) -> Path:
    """Build a complete, valid owner-supplied L8 input directory."""
    d = base / "inputs"
    d.mkdir(parents=True, exist_ok=True)
    write_private(
        d / "device.identity",
        f"expected_mac={FIXTURE_MAC}\nserial_port={FIXTURE_SERIAL_PORT}\n",
    )
    write_private(
        d / "d4.attestation",
        "AEGIS_P4_D4_ATTESTATION_V1\n"
        "d4_live=YES\n"
        "reference=https://example.invalid/aegis/d4-live-record\n",
    )
    write_private(d / "k_c2d", FIXTURE_C2D + "\n")
    write_private(d / "k_d2c", FIXTURE_D2C + "\n")
    write_private(d / "wifi.psk", FIXTURE_WIFI_PSK + "\n")
    write_private(d / "mqtt.pass", FIXTURE_MQTT_PASS + "\n")
    return d


def make_support_files(base: Path) -> dict[str, Path]:
    """Build the non-secret support artifacts an L8 run consumes."""
    support = base / "support"
    support.mkdir(parents=True, exist_ok=True)

    table = support / "partitions.csv"
    table.write_text(PARTITION_TABLE, encoding="utf-8")

    fixture_device = support / "fixture-device.json"
    fixture_device.write_text(
        json.dumps(
            {
                "mac": FIXTURE_MAC,
                "chip_identity": FIXTURE_CHIP,
                "flash_size": FIXTURE_FLASH_SIZE,
            }
        ),
        encoding="utf-8",
    )

    secrets_header = support / "secrets.h"
    secrets_header.write_text(
        '#pragma once\n\n#define SECRET_MQTT_CA_CERT \\\n"'
        + CA_PEM.replace("\n", '\\n"\\\n"')
        + '"\n\n#define SECRET_NTP_SERVER "203.0.113.9"\n',
        encoding="utf-8",
    )

    firmware_image = support / "firmware.bin"
    firmware_image.write_bytes(b"\xe9" + b"AEGIS-FIXTURE-FIRMWARE-IMAGE" * 16)

    nvs_gen = support / "fixture-nvs-gen.sh"
    nvs_gen.write_text(
        "#!/usr/bin/env bash\n"
        "# Fixture stand-in for the owner-supplied NVS partition generator.\n"
        "set -euo pipefail\n"
        'csv="$1"\n'
        'out="$2"\n'
        'size="$3"\n'
        'python3 -c "\n'
        "import hashlib, sys\n"
        "csv, out, size = sys.argv[1], sys.argv[2], int(sys.argv[3], 0)\n"
        "body = hashlib.sha256(open(csv,'rb').read()).digest()\n"
        "open(out,'wb').write((body * ((size // len(body)) + 1))[:size])\n"
        '" "$csv" "$out" "$size"\n',
        encoding="utf-8",
    )
    nvs_gen.chmod(0o700)

    return {
        "partition_table": table,
        "fixture_device": fixture_device,
        "secrets_header": secrets_header,
        "firmware_image": firmware_image,
        "nvs_gen": nvs_gen,
    }


def l8_env(base: Path, **overrides: str) -> dict[str, str]:
    """Assemble a complete fixture-backend environment for the L8 handler."""
    inputs = make_input_dir(base)
    support = make_support_files(base)
    work = base / "work"
    evidence = base / "evidence"

    env = os.environ.copy()
    for stale in list(env):
        if stale.startswith("AEGIS_L8_"):
            env.pop(stale)

    env.update(
        {
            "AEGIS_L8_INPUT_DIR": str(inputs),
            "AEGIS_L8_WORK_DIR": str(work),
            "AEGIS_L8_EVIDENCE_DIR": str(evidence),
            "AEGIS_L8_BACKEND": "fixture",
            "AEGIS_L8_FIXTURE_DEVICE": str(support["fixture_device"]),
            "AEGIS_L8_PARTITION_TABLE": str(support["partition_table"]),
            "AEGIS_L8_SECRETS_HEADER": str(support["secrets_header"]),
            "AEGIS_L8_FIRMWARE_IMAGE": str(support["firmware_image"]),
            "AEGIS_L8_FIRMWARE_BUILD_CMD": "pio run -e esp32dev",
            "AEGIS_L8_NVS_PARTITION_GEN": str(support["nvs_gen"]),
            "AEGIS_L8_WIFI_SSID": FIXTURE_WIFI_SSID,
            "AEGIS_L8_NTP": FIXTURE_NTP,
            "AEGIS_L8_RUN_ID": "l8-fixture-run-0001",
        }
    )
    env.update(overrides)
    return env


def run_apply(env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(L8_STAGE / "apply.sh")],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def run_stage(script: str, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(L8_STAGE / script)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def combined(res: subprocess.CompletedProcess) -> str:
    return (res.stdout or "") + (res.stderr or "")


# ===========================================================================
# 1. Registration and shell contract
# ===========================================================================

def test_l8_all_required_files_exist() -> None:
    """All five stage files must exist under deploy/pr11-phase4/stages/L8/."""
    assert L8_STAGE.is_dir(), f"stage directory missing: {L8_STAGE}"
    for filename in REQUIRED_HANDLER_FILES:
        path = L8_STAGE / filename
        assert path.is_file(), f"required L8 stage file missing: {filename}"


def test_l8_handler_registration_status() -> None:
    """p4-lib.sh must report p4_stage_handler_status L8 as REGISTERED."""
    res = subprocess.run(
        ["bash", "-c", f". '{P4_LIB}' && p4_stage_handler_status L8"],
        text=True,
        capture_output=True,
        check=False,
    )
    assert res.returncode == 0, res.stderr
    assert res.stdout.strip() == "REGISTERED"


def test_l8_shell_scripts_pass_bash_n() -> None:
    """Every L8 shell script must pass bash -n."""
    for name in ("apply.sh", "verify.sh", "rollback.sh"):
        path = L8_STAGE / name
        assert path.is_file(), f"script missing: {name}"
        res = subprocess.run(
            ["bash", "-n", str(path)], text=True, capture_output=True, check=False
        )
        assert res.returncode == 0, f"bash -n failed on {name}:\n{res.stderr}"


def test_l8_device_tool_exists_and_compiles() -> None:
    """p4-l8-device.py must exist and be syntactically valid Python."""
    assert L8_DEVICE.is_file(), f"missing device tool: {L8_DEVICE}"
    res = subprocess.run(
        [sys.executable, "-m", "py_compile", str(L8_DEVICE)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert res.returncode == 0, res.stderr


def test_l8_allow_keys_has_zero_active_entries() -> None:
    """L8 changes the device, not the Core host: host drift allow-list is empty."""
    lines = (L8_STAGE / "allow-keys.txt").read_text(encoding="utf-8").splitlines()
    active = [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]
    assert active == [], f"expected zero allowed host drift keys, found: {active}"


def test_l8_allow_listeners_has_zero_active_entries() -> None:
    """L8 opens no listening socket on the Core host."""
    lines = (L8_STAGE / "allow-listeners.txt").read_text(encoding="utf-8").splitlines()
    active = [l.strip() for l in lines if l.strip() and not l.strip().startswith("#")]
    assert active == [], f"expected zero allowed listeners, found: {active}"


# ===========================================================================
# 2. Live gate and hardware-backend refusal (OD-L8-05, OD-L8-06)
# ===========================================================================

def test_l8_apply_requires_core_environment_variables(tmp_path: Path) -> None:
    """apply.sh fails closed when the mandatory directories are unset."""
    env = os.environ.copy()
    for stale in list(env):
        if stale.startswith("AEGIS_L8_"):
            env.pop(stale)
    res = run_apply(env)
    assert res.returncode != 0
    assert "AEGIS_L8_INPUT_DIR" in combined(res)


def test_l8_hardware_backend_is_refused_in_repository_scope(tmp_path: Path) -> None:
    """Selecting the hardware backend fails closed: no Production write tool exists."""
    env = l8_env(tmp_path, AEGIS_L8_BACKEND="hardware")
    res = run_apply(env)
    assert res.returncode != 0
    text = combined(res).upper()
    assert "HARDWARE" in text and (
        "NOT_IMPLEMENTED" in text or "NOT_AUTHORIZED" in text
    ), combined(res)


def test_l8_live_authorization_defaults_to_denied(tmp_path: Path) -> None:
    """The live gate is closed unless explicitly authorized AND hardware-backed."""
    env = l8_env(tmp_path, AEGIS_L8_BACKEND="hardware", AEGIS_L8_LIVE_AUTHORIZED="YES")
    res = run_apply(env)
    assert res.returncode != 0, "live path must stay closed in repository scope"


def test_l8_unknown_backend_is_refused(tmp_path: Path) -> None:
    """An unrecognised backend name fails closed rather than defaulting."""
    env = l8_env(tmp_path, AEGIS_L8_BACKEND="whatever")
    res = run_apply(env)
    assert res.returncode != 0
    assert "backend" in combined(res).lower()


def test_l8_fixture_backend_never_touches_a_real_serial_device(tmp_path: Path) -> None:
    """Under the fixture backend no real /dev/tty* path is ever opened."""
    env = l8_env(tmp_path)
    res = run_apply(env)
    assert res.returncode == 0, combined(res)

    # Everything the run produced must live under the stage directories.
    work = Path(env["AEGIS_L8_WORK_DIR"])
    evidence = Path(env["AEGIS_L8_EVIDENCE_DIR"])
    assert work.is_dir()
    assert evidence.is_dir()
    for produced in list(work.rglob("*")) + list(evidence.rglob("*")):
        assert not str(produced).startswith("/dev/"), produced


def test_l8_fixture_device_descriptor_must_not_be_a_device_node(tmp_path: Path) -> None:
    """A /dev/* path supplied as the fixture descriptor is refused."""
    env = l8_env(tmp_path, AEGIS_L8_FIXTURE_DEVICE="/dev/ttyUSB0")
    res = run_apply(env)
    assert res.returncode != 0
    assert "/dev/" in combined(res) or "device" in combined(res).lower()


def test_l8_handler_contains_no_destructive_esptool_verb() -> None:
    """No L8 source may contain erase_flash, write_mem, espefuse, or an upload target."""
    forbidden = ("erase_flash", "erase-flash", "write_mem", "espefuse", "--target upload")
    sources = [L8_DEVICE] + [L8_STAGE / n for n in ("apply.sh", "verify.sh", "rollback.sh")]
    for src in sources:
        body = src.read_text(encoding="utf-8")
        for verb in forbidden:
            # The verb may only appear inside a denylist, never as an invocation.
            for line in body.splitlines():
                if verb in line:
                    lowered = line.strip().lower()
                    assert lowered.startswith("#") or "forbidden" in lowered or "denylist" in lowered, (
                        f"{src.name}: destructive verb {verb!r} used outside a denylist: {line.strip()}"
                    )


def test_l8_tests_never_reference_real_serial_devices() -> None:
    """This suite must never pass a real serial path to a device-opening call."""
    body = Path(__file__).read_text(encoding="utf-8")
    assert "serial.Serial" not in body
    assert "esptool" not in body.replace("esptool against hardware", "")


# ===========================================================================
# 3. OV-12 identity binding (OD-L8-01)
# ===========================================================================

def test_l8_identity_binding_is_required(tmp_path: Path) -> None:
    """A missing device.identity fails closed."""
    env = l8_env(tmp_path)
    (Path(env["AEGIS_L8_INPUT_DIR"]) / "device.identity").unlink()
    res = run_apply(env)
    assert res.returncode != 0
    assert "device.identity" in combined(res)


@pytest.mark.parametrize(
    "binding",
    [
        "expected_mac=24:0A:C4:11:22:33\nserial_port=/dev/ttyUSB0\n",  # uppercase MAC
        "expected_mac=24-0a-c4-11-22-33\nserial_port=/dev/ttyUSB0\n",  # wrong separator
        "expected_mac=24:0a:c4:11:22\nserial_port=/dev/ttyUSB0\n",  # too short
        "expected_mac=24:0a:c4:11:22:33\n",  # serial_port missing
        "expected_mac=24:0a:c4:11:22:33\nserial_port=/tmp/not-a-tty\n",  # not a serial path
        "expected_mac=24:0a:c4:11:22:33\nserial_port=/dev/ttyUSB0\nextra=1\n",  # unknown key
    ],
)
def test_l8_rejects_malformed_identity_binding(tmp_path: Path, binding: str) -> None:
    """Every malformed OV-12 binding is refused."""
    env = l8_env(tmp_path)
    write_private(Path(env["AEGIS_L8_INPUT_DIR"]) / "device.identity", binding)
    res = run_apply(env)
    assert res.returncode != 0, f"binding should have been refused:\n{binding}"


def test_l8_rejects_world_readable_identity_binding(tmp_path: Path) -> None:
    """The OV-12 binding must be owner-only."""
    env = l8_env(tmp_path)
    (Path(env["AEGIS_L8_INPUT_DIR"]) / "device.identity").chmod(0o644)
    res = run_apply(env)
    assert res.returncode != 0
    text = combined(res).lower()
    assert "mode" in text or "permission" in text


def test_l8_mac_mismatch_fails_before_any_write(tmp_path: Path) -> None:
    """A MAC mismatch aborts before the NVS artifact or any device write exists."""
    env = l8_env(tmp_path)
    write_private(
        Path(env["AEGIS_L8_INPUT_DIR"]) / "device.identity",
        f"expected_mac=aa:bb:cc:dd:ee:ff\nserial_port={FIXTURE_SERIAL_PORT}\n",
    )
    res = run_apply(env)
    assert res.returncode != 0
    assert "mac" in combined(res).lower()

    work = Path(env["AEGIS_L8_WORK_DIR"])
    assert not (work / "nvs.bin").exists(), "NVS artifact created despite MAC mismatch"
    assert not (work / "first-write.marker").exists(), "write marker set despite MAC mismatch"
    assert not any(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json")), (
        "evidence bundle written despite MAC mismatch"
    )


# ===========================================================================
# 4. D4-only recovery prerequisite (OD-L8-08)
# ===========================================================================

def test_l8_requires_d4_attestation(tmp_path: Path) -> None:
    """Without the D4 attestation the write path is refused."""
    env = l8_env(tmp_path)
    (Path(env["AEGIS_L8_INPUT_DIR"]) / "d4.attestation").unlink()
    res = run_apply(env)
    assert res.returncode != 0
    assert "d4" in combined(res).lower()


def test_l8_rejects_d4_attestation_that_is_not_live(tmp_path: Path) -> None:
    """d4_live must be YES; anything else fails closed."""
    env = l8_env(tmp_path)
    write_private(
        Path(env["AEGIS_L8_INPUT_DIR"]) / "d4.attestation",
        "AEGIS_P4_D4_ATTESTATION_V1\n"
        "d4_live=NO\n"
        "reference=https://example.invalid/aegis/d4-record\n",
    )
    res = run_apply(env)
    assert res.returncode != 0
    assert "d4" in combined(res).lower()


def test_l8_handler_declares_no_interim_recovery_procedure() -> None:
    """OD-14: interim recovery is NOT approved, so no handler may implement one."""
    for src in (L8_DEVICE, L8_STAGE / "apply.sh", L8_STAGE / "rollback.sh"):
        body = src.read_text(encoding="utf-8").lower()
        assert "interim_recovery" not in body.replace("interim_recovery_procedure=not_approved", "")


# ===========================================================================
# 5. NVS schema, offset derivation, and key parity (OD-L8-02, OD-L8-03)
# ===========================================================================

def test_l8_nvs_offset_is_derived_from_the_reviewed_partition_table(tmp_path: Path) -> None:
    """The offset comes from the supplied table, not from a default."""
    mod = load_device_module()
    table = tmp_path / "partitions.csv"
    table.write_text(PARTITION_TABLE, encoding="utf-8")
    assert mod.derive_nvs_offset(table) == FIXTURE_NVS_OFFSET


def test_l8_nvs_offset_derivation_fails_closed_without_a_table(tmp_path: Path) -> None:
    """A missing partition table has no fallback offset."""
    mod = load_device_module()
    with pytest.raises(Exception):
        mod.derive_nvs_offset(tmp_path / "absent.csv")


def test_l8_nvs_offset_derivation_fails_closed_without_an_nvs_entry(tmp_path: Path) -> None:
    """A table with no nvs partition has no fallback offset."""
    mod = load_device_module()
    table = tmp_path / "partitions.csv"
    table.write_text(
        "# Name, Type, SubType, Offset, Size, Flags\n"
        "app0, app, ota_0, 0x20000, 0x180000,\n",
        encoding="utf-8",
    )
    with pytest.raises(Exception):
        mod.derive_nvs_offset(table)


def test_l8_apply_fails_closed_without_a_partition_table(tmp_path: Path) -> None:
    """apply.sh refuses to run when no reviewed partition table is supplied."""
    env = l8_env(tmp_path)
    env.pop("AEGIS_L8_PARTITION_TABLE")
    res = run_apply(env)
    assert res.returncode != 0
    assert "partition" in combined(res).lower()


def test_l8_sources_contain_no_unproven_hardcoded_production_offset() -> None:
    """0x9000 must never appear as a hardcoded Production NVS offset (OD-L8-03)."""
    sources = [L8_DEVICE] + [L8_STAGE / n for n in ("apply.sh", "verify.sh", "rollback.sh")]
    for src in sources:
        for line in src.read_text(encoding="utf-8").splitlines():
            if re.search(r"0x9000", line, re.IGNORECASE):
                lowered = line.strip().lower()
                assert lowered.startswith("#"), (
                    f"{src.name}: hardcoded Production NVS offset 0x9000: {line.strip()}"
                )


def test_l8_nvs_schema_matches_the_approved_field_set() -> None:
    """The provisioning schema is namespace aegis-p1, schema 1, eleven fields."""
    spec = importlib.util.spec_from_file_location("p4_nvs_provision", str(NVS_PROVISION))
    nvs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(nvs)
    assert nvs.NVS_NAMESPACE == "aegis-p1"
    assert nvs.NVS_SCHEMA_VERSION == 1
    assert nvs.NVS_KEYS == (
        "schema",
        "device_id",
        "wifi_ssid",
        "wifi_psk",
        "broker",
        "mqtt_user",
        "mqtt_pass",
        "ntp",
        "k_c2d",
        "k_d2c",
        "seq_hi",
    )


def test_l8_nvs_schema_carries_no_static_address_field() -> None:
    """DHCP address model: no address field may enter the schema (OD-L8-02)."""
    spec = importlib.util.spec_from_file_location("p4_nvs_provision", str(NVS_PROVISION))
    nvs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(nvs)
    forbidden = {"ip", "gw", "gateway", "mask", "netmask", "dns", "static_ip", "subnet"}
    assert forbidden.isdisjoint(set(nvs.NVS_KEYS))


def test_l8_firmware_performs_no_static_address_configuration() -> None:
    """The firmware must contain no WiFi.config call under the DHCP model."""
    source = (FIRMWARE / "src" / "main.cpp").read_text(encoding="utf-8")
    assert "WiFi.config" not in source


def test_l8_protocol_key_parity_between_core_and_nvs(tmp_path: Path) -> None:
    """The Core key loader and the NVS validator agree byte-for-byte."""
    c2d_file = write_private(tmp_path / "k_c2d", FIXTURE_C2D + "\n")
    d2c_file = write_private(tmp_path / "k_d2c", FIXTURE_D2C + "\n")

    sys.path.insert(0, str(ROOT))
    try:
        from aegis_soc.protocol_v1 import load_protocol_keys

        spec = importlib.util.spec_from_file_location("p4_nvs_provision", str(NVS_PROVISION))
        nvs = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(nvs)

        keys = load_protocol_keys(c2d_file, d2c_file)
        nvs_c2d, nvs_d2c = nvs.validate_protocol_keys(FIXTURE_C2D, FIXTURE_D2C)
        assert keys.c2d == nvs_c2d
        assert keys.d2c == nvs_d2c
    finally:
        if str(ROOT) in sys.path:
            sys.path.remove(str(ROOT))


def test_l8_rejects_known_demo_and_test_protocol_keys(tmp_path: Path) -> None:
    """A publicly known demo/test key is refused before provisioning."""
    env = l8_env(tmp_path)
    write_private(
        Path(env["AEGIS_L8_INPUT_DIR"]) / "k_c2d",
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f\n",
    )
    res = run_apply(env)
    assert res.returncode != 0
    assert "key" in combined(res).lower()


def test_l8_repository_contains_no_production_key_generator() -> None:
    """Production keys are generated owner-controlled offline (OD-L8-03)."""
    for src in (L8_DEVICE, L8_STAGE / "apply.sh"):
        body = src.read_text(encoding="utf-8")
        assert "PRODUCTION_KEY_GENERATOR" not in body
        assert "secrets.token_hex" not in body
        assert "os.urandom" not in body


def test_l8_nvs_generator_is_required_and_not_vendored(tmp_path: Path) -> None:
    """The NVS partition generator is owner-supplied; absence fails closed."""
    env = l8_env(tmp_path)
    env.pop("AEGIS_L8_NVS_PARTITION_GEN")
    res = run_apply(env)
    assert res.returncode != 0
    assert "nvs" in combined(res).lower()


def test_l8_rendered_nvs_csv_is_private_and_not_overwritten(tmp_path: Path) -> None:
    """The rendered CSV is mode 0600 and a second run refuses to overwrite it."""
    env = l8_env(tmp_path)
    first = run_apply(env)
    assert first.returncode == 0, combined(first)

    csv_path = Path(env["AEGIS_L8_WORK_DIR"]) / "nvs.csv"
    assert csv_path.is_file(), "rendered NVS CSV missing"
    assert stat.S_IMODE(csv_path.stat().st_mode) == 0o600

    second = run_apply(env)
    assert second.returncode != 0, "second apply overwrote existing stage artifacts"


# ===========================================================================
# 6. Firmware build identity and MQTT CA (OD-L8-04)
# ===========================================================================

def test_l8_rejects_a_build_command_carrying_an_upload_or_erase_verb(tmp_path: Path) -> None:
    """A build command that is not compile-only is refused."""
    for bad in ("pio run -e esp32dev --target upload", "esptool.py erase_flash", "pio run -t upload"):
        env = l8_env(tmp_path / re.sub(r"\W+", "_", bad), AEGIS_L8_FIRMWARE_BUILD_CMD=bad)
        res = run_apply(env)
        assert res.returncode != 0, f"build command should have been refused: {bad}"
        assert "build" in combined(res).lower() or "upload" in combined(res).lower()


def test_l8_records_the_firmware_sha256(tmp_path: Path) -> None:
    """The evidence bundle carries the SHA-256 of the exact firmware image."""
    env = l8_env(tmp_path)
    res = run_apply(env)
    assert res.returncode == 0, combined(res)

    expected = hashlib.sha256(Path(env["AEGIS_L8_FIRMWARE_IMAGE"]).read_bytes()).hexdigest()
    bundle = json.loads(next(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json")).read_text())
    assert bundle["firmware_sha256"] == expected


def test_l8_rejects_a_placeholder_mqtt_ca(tmp_path: Path) -> None:
    """A firmware trust anchor still holding the placeholder is refused."""
    env = l8_env(tmp_path)
    Path(env["AEGIS_L8_SECRETS_HEADER"]).write_text(
        '#define SECRET_MQTT_CA_CERT "-----BEGIN CERTIFICATE-----\\n"'
        ' "REPLACE_WITH_DEDICATED_AEGIS_MQTT_CA_CERTIFICATE\\n"'
        ' "-----END CERTIFICATE-----\\n"\n',
        encoding="utf-8",
    )
    res = run_apply(env)
    assert res.returncode != 0
    assert "ca" in combined(res).lower() or "placeholder" in combined(res).lower()


def test_l8_rejects_a_missing_or_non_certificate_trust_anchor(tmp_path: Path) -> None:
    """A trust anchor that is not a PEM certificate is refused."""
    env = l8_env(tmp_path)
    Path(env["AEGIS_L8_SECRETS_HEADER"]).write_text("#pragma once\n", encoding="utf-8")
    res = run_apply(env)
    assert res.returncode != 0


def test_l8_does_not_promote_documentation_fixture_network_values(tmp_path: Path) -> None:
    """The 192.0.2.x documentation range must never be provisioned (§8)."""
    env = l8_env(tmp_path, AEGIS_L8_NTP="192.0.2.1")
    res = run_apply(env)
    assert res.returncode != 0
    assert "192.0.2" in combined(res) or "ntp" in combined(res).lower()


def test_l8_mqtt_transport_contract_is_tls_8883_only() -> None:
    """The firmware provisioned by L8 speaks TLS 8883 and has no 1883 fallback."""
    source = (FIRMWARE / "src" / "main.cpp").read_text(encoding="utf-8")
    assert "constexpr int MQTT_PORT = 8883;" in source
    assert "1883" not in source


def test_l8_handler_has_no_plaintext_mqtt_fallback() -> None:
    """No L8 source may introduce a plaintext MQTT 1883 path."""
    sources = [L8_DEVICE] + [L8_STAGE / n for n in ("apply.sh", "verify.sh", "rollback.sh")]
    for src in sources:
        for line in src.read_text(encoding="utf-8").splitlines():
            if "1883" in line:
                lowered = line.strip().lower()
                assert lowered.startswith("#") or "forbidden" in lowered, (
                    f"{src.name}: plaintext MQTT 1883 reference: {line.strip()}"
                )


# ===========================================================================
# 7. Fail-secure relay contract (OD-L8-06)
# ===========================================================================

def test_l8_firmware_boot_relay_contract_is_fail_secure() -> None:
    """GPIO27, TRIGGER=LOW, RELEASE=HIGH, and the relay is driven at boot."""
    source = (FIRMWARE / "src" / "main.cpp").read_text(encoding="utf-8")
    assert "constexpr int RELAY_IN = 27;" in source
    assert "constexpr int RELAY_TRIGGER = LOW;" in source
    assert "constexpr int RELAY_RELEASE = HIGH;" in source
    assert "digitalWrite(RELAY_IN, RELAY_TRIGGER);" in source


def test_l8_firmware_deadman_and_boot_grace_are_unchanged() -> None:
    """Deadman is 60 s and boot grace is 90 s."""
    source = (FIRMWARE / "src" / "main.cpp").read_text(encoding="utf-8")
    assert "DEADMAN_TIMEOUT_MS = 60000" in source
    assert "BOOT_GRACE_MS = 90000" in source


def test_l8_handler_never_issues_cut_or_restore() -> None:
    """No L8 source may actuate the relay or send CUT/RESTORE."""
    sources = [L8_DEVICE] + [L8_STAGE / n for n in ("apply.sh", "verify.sh", "rollback.sh")]
    for src in sources:
        for line in src.read_text(encoding="utf-8").splitlines():
            if re.search(r"\b(CUT_UPLINK|RESTORE_UPLINK)\b", line):
                lowered = line.strip().lower()
                assert lowered.startswith("#") or "forbidden" in lowered or "never" in lowered, (
                    f"{src.name}: actuation reference: {line.strip()}"
                )


# ===========================================================================
# 8. Readback and zero-drift (OD-L8-07)
# ===========================================================================

def test_l8_readback_comparison_reports_only_a_boolean(tmp_path: Path) -> None:
    """The NVS readback compares privately and yields PASS/FAIL only."""
    mod = load_device_module()
    assert mod.compare_nvs_readback(b"aegis-fixture-image", b"aegis-fixture-image") is True
    assert mod.compare_nvs_readback(b"aegis-fixture-image", b"aegis-fixture-imagX") is False


def test_l8_successful_run_records_readback_pass(tmp_path: Path) -> None:
    """A clean fixture run records nvs_readback_match=PASS."""
    env = l8_env(tmp_path)
    res = run_apply(env)
    assert res.returncode == 0, combined(res)
    bundle = json.loads(next(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json")).read_text())
    assert bundle["nvs_readback_match"] == "PASS"
    assert bundle["flash_result"] == "PASS"


def test_l8_apply_reports_host_zero_drift(tmp_path: Path) -> None:
    """apply.sh asserts HOST_PRE_TO_RB_ZERO_DRIFT=YES (OD-L8-07)."""
    env = l8_env(tmp_path)
    res = run_apply(env)
    assert res.returncode == 0, combined(res)
    assert "HOST_PRE_TO_RB_ZERO_DRIFT=YES" in res.stdout


def test_l8_apply_writes_nothing_outside_its_stage_directories(tmp_path: Path) -> None:
    """The fixture run must not create host paths such as /etc or /opt entries."""
    env = l8_env(tmp_path)
    res = run_apply(env)
    assert res.returncode == 0, combined(res)

    allowed_roots = {Path(env["AEGIS_L8_WORK_DIR"]), Path(env["AEGIS_L8_EVIDENCE_DIR"])}
    created = [p for p in tmp_path.rglob("*") if p.is_file()]
    for path in created:
        if any(str(path).startswith(str(root)) for root in allowed_roots):
            continue
        # Everything else must be an input or support file the test itself made.
        assert path.parent.name in {"inputs", "support"}, f"unexpected artifact: {path}"


# ===========================================================================
# 9. Hardware evidence model (OD-L8-09)
# ===========================================================================

def test_l8_evidence_bundle_uses_the_exact_allowlist(tmp_path: Path) -> None:
    """The bundle carries exactly the eleven approved fields, no more and no less."""
    env = l8_env(tmp_path)
    res = run_apply(env)
    assert res.returncode == 0, combined(res)
    bundle_path = next(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json"))
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    assert set(bundle) == EVIDENCE_ALLOWED_FIELDS


def test_l8_evidence_bundle_is_private(tmp_path: Path) -> None:
    """The bundle is mode 0600."""
    env = l8_env(tmp_path)
    res = run_apply(env)
    assert res.returncode == 0, combined(res)
    bundle_path = next(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json"))
    assert stat.S_IMODE(bundle_path.stat().st_mode) == 0o600


def test_l8_evidence_bundle_rejects_an_extra_field(tmp_path: Path) -> None:
    """write_evidence refuses any field outside the allowlist."""
    mod = load_device_module()
    fields = {name: "x" for name in EVIDENCE_ALLOWED_FIELDS}
    fields["wifi_psk"] = FIXTURE_WIFI_PSK
    with pytest.raises(Exception):
        mod.write_evidence(tmp_path / "evidence.json", fields)
    assert not (tmp_path / "evidence.json").exists()


def test_l8_evidence_bundle_rejects_a_missing_field(tmp_path: Path) -> None:
    """write_evidence refuses an incomplete bundle."""
    mod = load_device_module()
    fields = {name: "x" for name in EVIDENCE_ALLOWED_FIELDS}
    fields.pop("failure_boundary")
    with pytest.raises(Exception):
        mod.write_evidence(tmp_path / "evidence.json", fields)


def test_l8_evidence_bundle_is_write_once(tmp_path: Path) -> None:
    """A second write to the same evidence path fails closed (WRITE_ONCE_NO_OVERWRITE)."""
    mod = load_device_module()
    fields = {name: "x" for name in EVIDENCE_ALLOWED_FIELDS}
    target = tmp_path / "evidence.json"
    mod.write_evidence(target, fields)
    original = target.read_text(encoding="utf-8")
    with pytest.raises(Exception):
        mod.write_evidence(target, fields)
    assert target.read_text(encoding="utf-8") == original


def test_l8_evidence_bundle_contains_no_secret(tmp_path: Path) -> None:
    """No provisioned secret value may appear anywhere in the evidence bundle."""
    env = l8_env(tmp_path)
    res = run_apply(env)
    assert res.returncode == 0, combined(res)
    body = next(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json")).read_text(encoding="utf-8")
    for secret in FORBIDDEN_EVIDENCE_VALUES:
        assert secret not in body, "secret leaked into the hardware evidence bundle"
    assert "wifi_psk" not in body
    assert "mqtt_pass" not in body


def test_l8_apply_output_never_prints_a_secret(tmp_path: Path) -> None:
    """Handler stdout/stderr must never echo a provisioned secret."""
    env = l8_env(tmp_path)
    res = run_apply(env)
    text = combined(res)
    for secret in FORBIDDEN_EVIDENCE_VALUES:
        assert secret not in text


# ===========================================================================
# 10. Verify handler
# ===========================================================================

def test_l8_verify_passes_after_a_clean_apply(tmp_path: Path) -> None:
    """verify.sh reports PASS for a complete, consistent fixture run."""
    env = l8_env(tmp_path)
    assert run_apply(env).returncode == 0
    res = run_stage("verify.sh", env)
    assert res.returncode == 0, combined(res)
    assert "L8_VERIFY=PASS" in res.stdout


def test_l8_verify_fails_closed_without_evidence(tmp_path: Path) -> None:
    """verify.sh fails when the evidence bundle is absent."""
    env = l8_env(tmp_path)
    assert run_apply(env).returncode == 0
    for bundle in Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json"):
        bundle.unlink()
    res = run_stage("verify.sh", env)
    assert res.returncode != 0
    assert "L8_VERIFY=FAIL" in combined(res)


def test_l8_verify_fails_closed_on_readback_failure(tmp_path: Path) -> None:
    """verify.sh fails when the recorded readback did not match."""
    env = l8_env(tmp_path)
    assert run_apply(env).returncode == 0
    bundle_path = next(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json"))
    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    bundle["nvs_readback_match"] = "FAIL"
    bundle_path.chmod(0o600)
    bundle_path.write_text(json.dumps(bundle), encoding="utf-8")
    res = run_stage("verify.sh", env)
    assert res.returncode != 0
    assert "L8_VERIFY=FAIL" in combined(res)


# ===========================================================================
# 11. Rollback semantics (OD-L8-08)
# ===========================================================================

def test_l8_rollback_before_first_write_clears_stage_artifacts(tmp_path: Path) -> None:
    """Pre-write rollback removes only stage-local artifacts and reports zero drift."""
    env = l8_env(tmp_path)
    work = Path(env["AEGIS_L8_WORK_DIR"])
    work.mkdir(parents=True, exist_ok=True)
    (work / "nvs.csv").write_text("fixture\n", encoding="utf-8")

    res = run_stage("rollback.sh", env)
    assert res.returncode == 0, combined(res)
    assert "HARDWARE_PRE_TO_RB_ZERO_DRIFT=YES" in res.stdout
    assert not (work / "nvs.csv").exists()


def test_l8_rollback_after_first_write_holds_fail_secure(tmp_path: Path) -> None:
    """Post-write rollback performs no device action and holds fail-secure."""
    env = l8_env(tmp_path)
    assert run_apply(env).returncode == 0

    res = run_stage("rollback.sh", env)
    assert res.returncode == 0, combined(res)
    assert "FAIL_SECURE_HOLD_AND_EVIDENCE" in res.stdout
    assert "HARDWARE_PRE_TO_RB_ZERO_DRIFT=NOT_APPLICABLE" in res.stdout


def test_l8_rollback_after_first_write_preserves_evidence(tmp_path: Path) -> None:
    """Evidence survives a post-write rollback."""
    env = l8_env(tmp_path)
    assert run_apply(env).returncode == 0
    bundles = list(Path(env["AEGIS_L8_EVIDENCE_DIR"]).glob("*.json"))
    assert bundles

    assert run_stage("rollback.sh", env).returncode == 0
    assert all(b.exists() for b in bundles), "rollback destroyed hardware evidence"


def test_l8_rollback_is_idempotent(tmp_path: Path) -> None:
    """Running rollback.sh repeatedly exits cleanly."""
    env = l8_env(tmp_path)
    assert run_apply(env).returncode == 0
    for _ in range(3):
        assert run_stage("rollback.sh", env).returncode == 0


def test_l8_rollback_performs_no_reflash_and_no_automatic_restore() -> None:
    """Forbidden rollback behaviours are absent from the handler."""
    body = (L8_STAGE / "rollback.sh").read_text(encoding="utf-8")
    lowered = body.lower()
    for forbidden in ("reflash", "previous firmware", "legacy v0", "auto restore", "auto-restore"):
        for line in lowered.splitlines():
            if forbidden in line:
                assert line.strip().startswith("#"), f"forbidden rollback behaviour: {line.strip()}"


# ===========================================================================
# 12. Cross-area preservation
# ===========================================================================

def test_l8_handler_does_not_reference_idea1_or_idea2() -> None:
    """L8 must not touch IDEA1 or IDEA2 state."""
    sources = [L8_DEVICE] + [L8_STAGE / n for n in REQUIRED_HANDLER_FILES]
    for src in sources:
        body = src.read_text(encoding="utf-8")
        assert "IDEA1-AEGIS_Drive_LC" not in body
        assert "IDEA2-AEGIS_Monitor" not in body
        assert "IDEA2-AEGIS_CCTV-Operator" not in body


def test_l8_stage_gate_still_requires_recovery_authorization() -> None:
    """p4-lib.sh keeps recovery_authorization as the extra L8 authorization field."""
    res = subprocess.run(
        ["bash", "-c", f". '{P4_LIB}' && p4_stage_auth_extra L8 && p4_stage_gaps L8"],
        text=True,
        capture_output=True,
        check=False,
    )
    assert res.returncode == 0, res.stderr
    assert "recovery_authorization" in res.stdout
    assert "G-04,G-11,G-16" in res.stdout
