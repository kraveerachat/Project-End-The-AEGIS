"""Building the Core Protocol v1 context from configuration (fail closed)."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from aegis_soc import config
from aegis_soc import protocol_runtime as runtime
from aegis_soc.paths import application_root

DEVICE = "test-device-01"


@pytest.fixture
def configured(tmp_path, monkeypatch):
    c2d = tmp_path / "c2d.key"
    d2c = tmp_path / "d2c.key"
    c2d.write_text(hashlib.sha256(b"runtime c2d").hexdigest() + "\n", encoding="ascii")
    d2c.write_text(hashlib.sha256(b"runtime d2c").hexdigest() + "\n", encoding="ascii")
    monkeypatch.setattr(config, "PROTOCOL_MODE", "v1")
    monkeypatch.setattr(config, "P1_DEVICE_ID", DEVICE)
    monkeypatch.setattr(config, "P1_C2D_KEY_FILE", str(c2d))
    monkeypatch.setattr(config, "P1_D2C_KEY_FILE", str(d2c))
    monkeypatch.setattr(config, "CORE_PROTOCOL_DB_PATH", str(tmp_path / "data" / "core-protocol.sqlite3"))
    return tmp_path


def test_a_complete_v1_configuration_builds_a_context(configured):
    context = runtime.build_protocol_context_from_environment()
    try:
        assert context is not None
        assert context.device_id == DEVICE
        assert context.store.path == configured / "data" / "core-protocol.sqlite3"
        assert context.keys.c2d == hashlib.sha256(b"runtime c2d").digest()
        assert context.topics.status == "aegis/idea3/v1/test-device-01/status"
    finally:
        context.store.close()


def test_legacy_lab_mode_builds_no_v1_context(configured, monkeypatch):
    monkeypatch.setattr(config, "PROTOCOL_MODE", "legacy-v0-lab")
    assert runtime.build_protocol_context_from_environment() is None


@pytest.mark.parametrize("missing", ["P1_DEVICE_ID", "P1_C2D_KEY_FILE", "P1_D2C_KEY_FILE"])
def test_incomplete_configuration_builds_no_context(configured, monkeypatch, missing):
    monkeypatch.setattr(config, missing, "")
    assert runtime.build_protocol_context_from_environment() is None


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("P1_DEVICE_ID", "Bad_Device"),
        ("CORE_PROTOCOL_DB_PATH", "relative/core-protocol.sqlite3"),
    ],
)
def test_invalid_configuration_builds_no_context(configured, monkeypatch, name, value):
    monkeypatch.setattr(config, name, value)
    assert runtime.build_protocol_context_from_environment() is None


def test_unsafe_keys_build_no_context(configured, monkeypatch):
    shared = configured / "c2d.key"
    monkeypatch.setattr(config, "P1_D2C_KEY_FILE", str(shared))
    assert runtime.build_protocol_context_from_environment() is None


def test_default_protocol_db_follows_the_durable_data_root(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "CORE_PROTOCOL_DB_PATH", "")
    monkeypatch.setenv("AEGIS_DATA_DIR", str(tmp_path / "state"))
    assert runtime.protocol_db_path() == tmp_path / "state" / "data" / "core-protocol.sqlite3"
    monkeypatch.delenv("AEGIS_DATA_DIR")
    assert runtime.protocol_db_path(platform="linux") == application_root() / ".aegis-runtime" / "data" / (
        "core-protocol.sqlite3"
    )


@pytest.mark.parametrize("root", ["/run/aegis-idea3", "/run"])
def test_protocol_db_under_run_is_refused(monkeypatch, root):
    monkeypatch.setattr(config, "CORE_PROTOCOL_DB_PATH", f"{root}/core-protocol.sqlite3")
    with pytest.raises(ValueError):
        runtime.protocol_db_path()
    assert runtime.protocol_db_problem(Path(f"{root}/core-protocol.sqlite3"), runtime_dir=Path("/run/aegis-idea3"))
