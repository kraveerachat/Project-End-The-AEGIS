"""PR11 Phase 4 L7 — reviewed core.env renderer/validator (deploy/pr11-phase4/p4-l7-core-env.py).

The previous L7 apply wrote a three-line core.env that lacked the broker address, device id, CA path and TLS server name the Core
needs. The renderer derives the file from the repository example and the two owner-frozen values (AP address, device id), and the
validator proves the installed file: exact allowlisted keys, production/live/no-containment values, TLS 8883 only, no secret.
"""

from __future__ import annotations

import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
TOOL = ROOT / "deploy" / "pr11-phase4" / "p4-l7-core-env.py"
EXAMPLE = ROOT / "deploy" / "aegis-idea3-core.env.example"
AP = "10.77.30.1"
DEVICE = "aegis-relay-01"
NAME = "mqtt.aegis.home.arpa"


def render(tmp_path: Path, *, ap: str = AP, device: str = DEVICE, name: str = NAME) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(TOOL), "render", "--example", str(EXAMPLE), "--ap-address", ap, "--device-id", device,
                           "--server-name", name, "--output", str(tmp_path / "core.env")], text=True, capture_output=True, check=False)


def check(path: Path, *, ap: str = AP, device: str = DEVICE, name: str = NAME) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(TOOL), "check", "--file", str(path), "--ap-address", ap, "--device-id", device,
                           "--server-name", name], text=True, capture_output=True, check=False)


def parse(path: Path) -> dict[str, str]:
    out = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            k, _, v = line.partition("=")
            out[k] = v
    return out


def test_tool_exists() -> None:
    assert TOOL.is_file()


def test_example_documents_the_tls_server_name() -> None:
    assert "AEGIS_MQTT_TLS_SERVER_NAME=" in EXAMPLE.read_text()


def test_render_fills_exactly_the_owner_frozen_values(tmp_path: Path) -> None:
    res = render(tmp_path)
    assert res.returncode == 0, res.stdout + res.stderr
    env = parse(tmp_path / "core.env")
    assert env["AEGIS_BROKER_IP"] == AP and env["AEGIS_P1_DEVICE_ID"] == DEVICE and env["AEGIS_MQTT_TLS_SERVER_NAME"] == NAME
    assert env["AEGIS_BROKER_PORT"] == "8883" and env["AEGIS_MQTT_TLS"] == "1" and env["AEGIS_MQTT_USER"] == "idea3-core"
    assert env["AEGIS_PROFILE"] == "production" and env["AEGIS_DRY_RUN"] == "0" and env["AEGIS_AUTO_CONTAIN"] == "0"
    assert env["AEGIS_START_DETECTOR"] == env["AEGIS_START_GUI"] == env["AEGIS_VOICE_ENABLE"] == "0"
    assert env["AEGIS_PROTOCOL_MODE"] == "v1" and env["AEGIS_CORE_DISPATCH_ENABLED"] == "0"
    assert env["AEGIS_MQTT_CA_FILE"] == "/etc/aegis-idea3/pki/mqtt-ca.crt"
    assert env["AEGIS_RESTORE_CREDENTIAL_FILE"] == "/etc/aegis-idea3/credentials/restore.credential"
    assert stat.S_IMODE((tmp_path / "core.env").stat().st_mode) == 0o600


def test_render_is_deterministic_and_passes_its_own_check(tmp_path: Path) -> None:
    assert render(tmp_path).returncode == 0
    first = (tmp_path / "core.env").read_bytes()
    (tmp_path / "core.env").unlink()
    assert render(tmp_path).returncode == 0
    assert (tmp_path / "core.env").read_bytes() == first
    res = check(tmp_path / "core.env")
    assert res.returncode == 0 and "L7_CORE_ENV=PASS" in res.stdout


def test_render_refuses_to_overwrite(tmp_path: Path) -> None:
    (tmp_path / "core.env").write_text("x\n")
    assert render(tmp_path).returncode != 0
    assert (tmp_path / "core.env").read_text() == "x\n"


@pytest.mark.parametrize("ap", ["0.0.0.0", "127.0.0.1", "224.0.0.1", "::1", "not-an-ip", "10.77.30.1/28", "", "999.1.1.1"])
def test_render_rejects_bad_ap_address(tmp_path: Path, ap: str) -> None:
    assert render(tmp_path, ap=ap).returncode != 0 and not (tmp_path / "core.env").exists()


@pytest.mark.parametrize("device", ["", "has space", "a/b", "x" * 65, "Aegis!", "../x"])
def test_render_rejects_bad_device_id(tmp_path: Path, device: str) -> None:
    assert render(tmp_path, device=device).returncode != 0


@pytest.mark.parametrize("name", ["", "10.77.30.1", "has space", "a..b", "x" * 254])
def test_render_rejects_bad_server_name(tmp_path: Path, name: str) -> None:
    assert render(tmp_path, name=name).returncode != 0


def mutate(tmp_path: Path, key: str, value: str | None) -> Path:
    assert render(tmp_path).returncode == 0
    p = tmp_path / "core.env"
    lines = [l for l in p.read_text().splitlines() if not l.startswith(key + "=")]
    if value is not None:
        lines.append(f"{key}={value}")
    p.write_text("\n".join(lines) + "\n")
    return p


@pytest.mark.parametrize("key,value,code", [
    ("AEGIS_MQTT_PASS", "s3cret", "FORBIDDEN_KEY"), ("AEGIS_ADMIN_PIN", "849201", "FORBIDDEN_KEY"),
    ("AEGIS_P1_C2D_KEY_FILE", "/x", "FORBIDDEN_KEY"), ("AEGIS_P1_D2C_KEY_FILE", "/x", "FORBIDDEN_KEY"),
    ("AEGIS_TG_TOKEN", "123:abc", "SECRET_VALUE_PRESENT"), ("AEGIS_UNKNOWN", "1", "UNKNOWN_KEY"),
    ("AEGIS_AUTO_CONTAIN", "1", "VALUE_INVALID"), ("AEGIS_DRY_RUN", "1", "VALUE_INVALID"), ("AEGIS_PROFILE", "lab", "VALUE_INVALID"),
    ("AEGIS_MQTT_TLS", "0", "VALUE_INVALID"), ("AEGIS_BROKER_PORT", "1883", "VALUE_INVALID"), ("AEGIS_BROKER_IP", "10.77.30.2", "VALUE_INVALID"),
    ("AEGIS_BROKER_IP", "0.0.0.0", "VALUE_INVALID"), ("AEGIS_MQTT_USER", "idea3-dev-aegis-relay-01", "VALUE_INVALID"),
    ("AEGIS_START_DETECTOR", "1", "VALUE_INVALID"), ("AEGIS_PROTOCOL_MODE", "legacy-v0-lab", "VALUE_INVALID"),
    ("AEGIS_MQTT_TLS_SERVER_NAME", "10.77.30.1", "VALUE_INVALID"), ("AEGIS_MQTT_CA_FILE", "/etc/mosquitto/ca.crt", "VALUE_INVALID"),
    ("AEGIS_CORE_DISPATCH_ENABLED", "1", "VALUE_INVALID"), ("AEGIS_P1_DEVICE_ID", "other", "VALUE_INVALID"),
])
def test_check_rejects_violations(tmp_path: Path, key: str, value: str, code: str) -> None:
    res = check(mutate(tmp_path, key, value))
    assert res.returncode == 1 and f"L7_CORE_ENV=FAIL reason={code}" in res.stdout
    assert value not in res.stdout + res.stderr or value in ("1", "0", "lab", "1883", "other")  # secret values are never echoed


@pytest.mark.parametrize("key", ["AEGIS_BROKER_IP", "AEGIS_MQTT_TLS_SERVER_NAME", "AEGIS_PROFILE", "AEGIS_MQTT_CA_FILE", "AEGIS_P1_DEVICE_ID"])
def test_check_rejects_missing_required_key(tmp_path: Path, key: str) -> None:
    res = check(mutate(tmp_path, key, None))
    assert res.returncode == 1 and "L7_CORE_ENV=FAIL reason=REQUIRED_KEY_MISSING" in res.stdout


def test_check_rejects_duplicate_keys_and_malformed_lines(tmp_path: Path) -> None:
    assert render(tmp_path).returncode == 0
    p = tmp_path / "core.env"
    good = p.read_text()
    p.write_text(good + "AEGIS_PROFILE=production\n")
    assert "DUPLICATE_KEY" in check(p).stdout
    p.write_text(good + "no equals sign\n")
    assert "LINE_MALFORMED" in check(p).stdout


def test_tool_is_read_only_except_for_render_output() -> None:
    text = TOOL.read_text()
    for banned in ("subprocess", "os.system", "shutil", "os.remove", ".unlink(", "chown("):
        assert banned not in text, banned
