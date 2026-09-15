"""Production preflight for Protocol v1, TLS-only MQTT, and broker identity (design §8)."""

from __future__ import annotations

import hashlib
import ssl
import subprocess
from dataclasses import replace
from shutil import which

import pytest

from aegis_soc import config
from aegis_soc.mqtt_client import build_mqtt_ssl_context
from aegis_soc.runtime import RuntimeSettings

C2D = hashlib.sha256(b"preflight c2d").hexdigest()
D2C = hashlib.sha256(b"preflight d2c").hexdigest()


@pytest.fixture
def production(tmp_path, monkeypatch):
    c2d = tmp_path / "keys" / "c2d.key"
    d2c = tmp_path / "keys" / "d2c.key"
    c2d.parent.mkdir()
    c2d.write_text(C2D + "\n", encoding="ascii")
    d2c.write_text(D2C + "\n", encoding="ascii")
    ca = tmp_path / "mqtt-ca.pem"
    ca.write_text("TEST ONLY placeholder\n", encoding="ascii")
    values = {
        "PROTOCOL_MODE": "v1",
        "P1_DEVICE_ID": "test-device-01",
        "P1_C2D_KEY_FILE": str(c2d),
        "P1_D2C_KEY_FILE": str(d2c),
        "CORE_PROTOCOL_DB_PATH": str(tmp_path / "data" / "core-protocol.sqlite3"),
        "MQTT_TLS": True,
        "MQTT_CA_FILE": str(ca),
        "PORT": 8883,
        "BROKER_IP": "127.0.0.1",
        "MQTT_USER": "idea3-core",
        "MQTT_PASS": "test-only-password",
        "ADMIN_PIN_CONFIGURED": True,
        "ADMIN_PIN_HASH": hashlib.sha256(b"9876").hexdigest(),
    }
    for name, value in values.items():
        monkeypatch.setattr(config, name, value)
    monkeypatch.setattr(config, "BROKER_CONFIGURED", True, raising=False)
    base = RuntimeSettings.from_profile("development", dry_run=True, start_detector=False, start_gui=False)
    return replace(base, profile="production", dry_run=False, runtime_dir=tmp_path / "runtime", log_dir=tmp_path / "logs")


def _errors(settings):
    errors, _warnings = settings.preflight(platform="linux")
    return errors


def test_a_complete_production_protocol_configuration_passes(production):
    assert _errors(production) == []


@pytest.mark.parametrize(
    ("name", "value", "expected"),
    [
        ("PROTOCOL_MODE", "legacy-v0-lab", "refuses the legacy v0 protocol"),
        ("PROTOCOL_MODE", "v2", "AEGIS_PROTOCOL_MODE must be"),
        ("MQTT_TLS", False, "requires TLS"),
        ("PORT", 1883, "port 1883"),
        ("MQTT_CA_FILE", "", "MQTT CA file"),
        ("MQTT_CA_FILE", "/nonexistent/aegis-test/ca.pem", "MQTT CA file"),
        ("MQTT_USER", "", "anonymous"),
        ("MQTT_PASS", "", "anonymous"),
        ("MQTT_USER", "idea3-dev-test-device-01", "ESP32 broker identity"),
        ("P1_DEVICE_ID", "", "AEGIS_P1_DEVICE_ID"),
        ("P1_DEVICE_ID", "Bad_Device", "AEGIS_P1_DEVICE_ID"),
        ("P1_C2D_KEY_FILE", "", "key file"),
        ("CORE_PROTOCOL_DB_PATH", "/run/aegis-idea3/core-protocol.sqlite3", "never under /run"),
        ("CORE_PROTOCOL_DB_PATH", "relative/core-protocol.sqlite3", "must be absolute"),
    ],
)
def test_production_refuses_each_unsafe_protocol_setting(production, monkeypatch, name, value, expected):
    monkeypatch.setattr(config, name, value)
    errors = _errors(production)
    assert any(expected in error for error in errors), errors
    assert all(C2D not in error and D2C not in error for error in errors)


def test_production_refuses_a_shared_key(production, monkeypatch):
    monkeypatch.setattr(config, "P1_D2C_KEY_FILE", config.P1_C2D_KEY_FILE)
    assert any("independent" in error for error in _errors(production))


def test_production_refuses_a_public_test_vector_key(production, monkeypatch, tmp_path):
    public = tmp_path / "public.key"
    public.write_text(bytes(range(0x20)).hex() + "\n", encoding="ascii")
    monkeypatch.setattr(config, "P1_C2D_KEY_FILE", str(public))
    errors = _errors(production)
    assert any("public test or demo" in error for error in errors)
    assert all(bytes(range(0x20)).hex() not in error for error in errors)


def test_the_protocol_store_may_not_live_in_the_runtime_directory(production, monkeypatch):
    monkeypatch.setattr(config, "CORE_PROTOCOL_DB_PATH", str(production.runtime_dir / "core-protocol.sqlite3"))
    assert any("runtime directory" in error for error in _errors(production))


def test_the_legacy_hmac_secret_is_not_a_production_requirement(production, monkeypatch):
    monkeypatch.setattr(config, "SECRET_KEY", config.DEMO_SECRET)
    assert _errors(production) == []


def test_lab_live_v1_without_tls_is_an_explicit_warning(production, monkeypatch):
    lab = replace(production, profile="lab")
    monkeypatch.setattr(config, "MQTT_TLS", False)
    monkeypatch.setattr(config, "PORT", 1883)
    errors, warnings = lab.preflight(platform="linux")
    assert errors == []
    assert any("TLS is disabled" in warning for warning in warnings)


def test_lab_legacy_mode_is_allowed_only_with_an_explicit_warning(production, monkeypatch):
    lab = replace(production, profile="lab")
    monkeypatch.setattr(config, "PROTOCOL_MODE", "legacy-v0-lab")
    errors, warnings = lab.preflight(platform="linux")
    assert errors == []
    assert any("legacy v0" in warning for warning in warnings)


def test_live_v1_needs_protocol_configuration_in_every_profile(production, monkeypatch):
    lab = replace(production, profile="development")
    monkeypatch.setattr(config, "P1_DEVICE_ID", "")
    errors, _ = lab.preflight(platform="linux")
    assert any("AEGIS_P1_DEVICE_ID" in error for error in errors)


# ---- the TLS context (OD-5: throwaway test-only certificate) ---------------

@pytest.fixture
def test_only_ca(tmp_path):
    if which("openssl") is None:
        pytest.skip("openssl is unavailable; a throwaway TEST-ONLY CA cannot be generated")
    cert = tmp_path / "test-only-ca.pem"
    key = tmp_path / "test-only-ca.key"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
         "-keyout", str(key), "-out", str(cert), "-days", "1", "-subj", "/CN=aegis-idea3-test-only-ca"],
        check=True, capture_output=True,
    )
    return cert


def test_mqtt_tls_context_verifies_certificate_and_hostname(test_only_ca):
    context = build_mqtt_ssl_context(str(test_only_ca))
    assert context.verify_mode == ssl.CERT_REQUIRED
    assert context.check_hostname is True
    assert context.minimum_version >= ssl.TLSVersion.TLSv1_2


@pytest.mark.parametrize("path", ["", "/nonexistent/aegis-test/ca.pem"])
def test_mqtt_tls_context_refuses_a_missing_ca(path):
    with pytest.raises((ValueError, OSError)):
        build_mqtt_ssl_context(path)
