"""T9 integration of systemd credentials with the Core configuration."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

PROBE = r"""
import json
from aegis_soc import config

print(json.dumps({
    "c2d": config.P1_C2D_KEY_FILE,
    "d2c": config.P1_D2C_KEY_FILE,
    "mqtt_pass": config.MQTT_PASS,
    "admin_credential_ok": config.verify_pin("9876"),
    "admin_environment_ok": config.verify_pin("1111"),
}))
"""


def _base_environment(tmp_path: Path) -> dict[str, str]:
    env = os.environ.copy()

    for name in (
        "CREDENTIALS_DIRECTORY",
        "AEGIS_P1_C2D_KEY_FILE",
        "AEGIS_P1_D2C_KEY_FILE",
        "AEGIS_MQTT_PASS",
        "AEGIS_ADMIN_PIN",
    ):
        env.pop(name, None)

    # Prevent a developer-local dotenv from influencing this integration test.
    env["AEGIS_CONFIG_FILE"] = str(tmp_path / "does-not-exist.env")
    return env


def _write_credential(root: Path, name: str, value: str) -> Path:
    path = root / name
    path.write_text(value + "\n", encoding="utf-8")
    path.chmod(0o400)
    return path


def _run_probe(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", PROBE],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_t9_systemd_credentials_override_secret_environment_values(tmp_path):
    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    c2d = _write_credential(root, "k_c2d", "1" * 64)
    d2c = _write_credential(root, "k_d2c", "2" * 64)
    _write_credential(root, "mqtt-core.pass", "credential-password")
    _write_credential(root, "admin.pin", "9876")

    env = _base_environment(tmp_path)
    env.update(
        {
            "CREDENTIALS_DIRECTORY": str(root),
            "AEGIS_P1_C2D_KEY_FILE": "/unsafe/environment/c2d",
            "AEGIS_P1_D2C_KEY_FILE": "/unsafe/environment/d2c",
            "AEGIS_MQTT_PASS": "environment-password",
            "AEGIS_ADMIN_PIN": "1111",
        }
    )

    completed = _run_probe(env)

    assert completed.returncode == 0, completed.stderr
    values = json.loads(completed.stdout)

    assert values["c2d"] == str(c2d)
    assert values["d2c"] == str(d2c)
    assert values["mqtt_pass"] == "credential-password"
    assert values["admin_credential_ok"] is True
    assert values["admin_environment_ok"] is False


def test_t9_missing_required_systemd_credential_fails_closed(tmp_path):
    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    _write_credential(root, "k_c2d", "1" * 64)
    _write_credential(root, "k_d2c", "2" * 64)
    _write_credential(root, "mqtt-core.pass", "credential-password")
    # admin.pin deliberately absent.

    env = _base_environment(tmp_path)
    env["CREDENTIALS_DIRECTORY"] = str(root)

    completed = _run_probe(env)

    assert completed.returncode != 0
    assert "admin.pin" in completed.stderr
    assert "credential-password" not in completed.stderr


def test_t9_non_systemd_runtime_keeps_environment_compatibility(tmp_path):
    env = _base_environment(tmp_path)
    env.update(
        {
            "AEGIS_P1_C2D_KEY_FILE": "/lab/c2d",
            "AEGIS_P1_D2C_KEY_FILE": "/lab/d2c",
            "AEGIS_MQTT_PASS": "lab-password",
            "AEGIS_ADMIN_PIN": "1111",
        }
    )

    completed = _run_probe(env)

    assert completed.returncode == 0, completed.stderr
    values = json.loads(completed.stdout)

    assert values["c2d"] == "/lab/c2d"
    assert values["d2c"] == "/lab/d2c"
    assert values["mqtt_pass"] == "lab-password"
    assert values["admin_environment_ok"] is True


def test_t9_unsafe_protocol_key_credential_fails_closed(tmp_path):
    root = tmp_path / "credentials"
    root.mkdir(mode=0o700)

    c2d = _write_credential(root, "k_c2d", "1" * 64)
    c2d.chmod(0o644)

    _write_credential(root, "k_d2c", "2" * 64)
    _write_credential(root, "mqtt-core.pass", "credential-password")
    _write_credential(root, "admin.pin", "9876")

    env = _base_environment(tmp_path)
    env["CREDENTIALS_DIRECTORY"] = str(root)

    completed = _run_probe(env)

    assert completed.returncode != 0
    assert "k_c2d" in completed.stderr
    assert "credential-password" not in completed.stderr


PREFLIGHT_PROBE = r"""
import json
from pathlib import Path

from aegis_soc.runtime import RuntimeSettings

runtime = Path(__import__("os").environ["AEGIS_RUNTIME_DIR"])
logs = Path(__import__("os").environ["AEGIS_RUNTIME_LOG_DIR"])

settings = RuntimeSettings.from_profile(
    "production",
    dry_run=False,
    start_detector=False,
    start_gui=False,
)

errors, warnings = settings.preflight(platform="linux")

print(json.dumps({
    "errors": errors,
    "warnings": warnings,
}))
"""


def _run_preflight_probe(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", PREFLIGHT_PROBE],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_t9_valid_systemd_credentials_satisfy_production_preflight(tmp_path):
    credentials = tmp_path / "credentials"
    credentials.mkdir(mode=0o700)

    _write_credential(credentials, "k_c2d", "1" * 64)
    _write_credential(credentials, "k_d2c", "2" * 64)
    _write_credential(credentials, "mqtt-core.pass", "credential-password")
    _write_credential(credentials, "admin.pin", "9876")

    ca = tmp_path / "mqtt-ca.pem"
    ca.write_text("TEST ONLY CA placeholder\n", encoding="ascii")

    env = _base_environment(tmp_path)
    env.update(
        {
            "CREDENTIALS_DIRECTORY": str(credentials),
            "AEGIS_BROKER_IP": "127.0.0.1",
            "AEGIS_BROKER_PORT": "8883",
            "AEGIS_MQTT_TLS": "1",
            "AEGIS_MQTT_CA_FILE": str(ca),
            "AEGIS_MQTT_USER": "idea3-core",
            "AEGIS_PROTOCOL_MODE": "v1",
            "AEGIS_P1_DEVICE_ID": "test-device-01",
            "AEGIS_CORE_PROTOCOL_DB_PATH": str(
                tmp_path / "data" / "core-protocol.sqlite3"
            ),
            "AEGIS_RUNTIME_DIR": str(tmp_path / "runtime"),
            "AEGIS_RUNTIME_LOG_DIR": str(tmp_path / "logs"),
            "AEGIS_DB_PATH": str(tmp_path / "data" / "core-audit.sqlite3"),
            "AEGIS_LOG_PATH": str(tmp_path / "logs" / "aegis.log"),
            "AEGIS_AUTO_CONTAIN": "0",
        }
    )

    completed = _run_preflight_probe(env)

    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)

    assert result["errors"] == []
    assert "credential-password" not in completed.stdout
    assert "9876" not in completed.stdout
    assert "1" * 64 not in completed.stdout
    assert "2" * 64 not in completed.stdout


def test_t9_default_admin_pin_from_systemd_is_rejected_by_production_preflight(tmp_path):
    credentials = tmp_path / "credentials"
    credentials.mkdir(mode=0o700)

    _write_credential(credentials, "k_c2d", "1" * 64)
    _write_credential(credentials, "k_d2c", "2" * 64)
    _write_credential(credentials, "mqtt-core.pass", "credential-password")
    _write_credential(credentials, "admin.pin", "1234")

    ca = tmp_path / "mqtt-ca.pem"
    ca.write_text("TEST ONLY CA placeholder\n", encoding="ascii")

    env = _base_environment(tmp_path)
    env.update(
        {
            "CREDENTIALS_DIRECTORY": str(credentials),
            "AEGIS_BROKER_IP": "127.0.0.1",
            "AEGIS_BROKER_PORT": "8883",
            "AEGIS_MQTT_TLS": "1",
            "AEGIS_MQTT_CA_FILE": str(ca),
            "AEGIS_MQTT_USER": "idea3-core",
            "AEGIS_PROTOCOL_MODE": "v1",
            "AEGIS_P1_DEVICE_ID": "test-device-01",
            "AEGIS_CORE_PROTOCOL_DB_PATH": str(
                tmp_path / "data" / "core-protocol.sqlite3"
            ),
            "AEGIS_RUNTIME_DIR": str(tmp_path / "runtime"),
            "AEGIS_RUNTIME_LOG_DIR": str(tmp_path / "logs"),
            "AEGIS_DB_PATH": str(tmp_path / "data" / "core-audit.sqlite3"),
            "AEGIS_LOG_PATH": str(tmp_path / "logs" / "aegis.log"),
        }
    )

    completed = _run_preflight_probe(env)

    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)

    assert any("non-default Admin PIN" in error for error in result["errors"])
    assert "1234" not in completed.stdout
    assert "credential-password" not in completed.stdout
