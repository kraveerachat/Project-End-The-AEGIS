"""Linux/server production runtime contracts."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from aegis_soc.production_runtime import ProductionSettings


def _environment(tmp_path: Path) -> dict[str, str]:
    application_root = tmp_path / "immutable payload"
    node = tmp_path / "tool chain" / "node"
    web_entrypoint = application_root / "web" / "server" / "index.js"
    static_dir = application_root / "web" / "dist"
    data_root = tmp_path / "external writable data"
    config_file = data_root / "config" / ".env"

    node.parent.mkdir(parents=True, exist_ok=True)
    node.write_text("node\n", encoding="utf-8")
    web_entrypoint.parent.mkdir(parents=True, exist_ok=True)
    web_entrypoint.write_text("// server\n", encoding="utf-8")
    static_dir.mkdir(parents=True, exist_ok=True)
    (static_dir / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
    config_file.parent.mkdir(parents=True, exist_ok=True)
    config_file.write_text("NODE_ENV=production\n", encoding="utf-8")

    return {
        "AEGIS_APPLICATION_ROOT": str(application_root),
        "AEGIS_DATA_DIR": str(data_root),
        "AEGIS_CONFIG_FILE": str(config_file),
        "AEGIS_NODE_EXECUTABLE": str(node),
        "AEGIS_WEB_ENTRYPOINT": str(web_entrypoint),
        "AEGIS_WEB_STATIC_DIR": str(static_dir),
        "AEGIS_PROFILE": "lab",
        "AEGIS_DRY_RUN": "1",
        "PORT": "18003",
        "AEGIS_CONTROL_PORT": "18103",
        "AEGIS_BIND_HOST": "127.0.0.1",
    }


def test_settings_require_an_explicit_absolute_external_data_root(tmp_path):
    environment = _environment(tmp_path)
    environment.pop("AEGIS_DATA_DIR")
    with pytest.raises(ValueError, match="AEGIS_DATA_DIR"):
        ProductionSettings.from_environment(environment)

    environment["AEGIS_DATA_DIR"] = "relative/data"
    with pytest.raises(ValueError, match="AEGIS_DATA_DIR"):
        ProductionSettings.from_environment(environment)


def test_settings_reject_a_data_root_inside_the_immutable_payload(tmp_path):
    environment = _environment(tmp_path)
    environment["AEGIS_DATA_DIR"] = str(
        Path(environment["AEGIS_APPLICATION_ROOT"]) / "runtime"
    )

    with pytest.raises(ValueError, match="outside the application root"):
        ProductionSettings.from_environment(environment).validate()


@pytest.mark.parametrize(
    ("removed_path", "message"),
    [
        ("AEGIS_CONFIG_FILE", "configuration file"),
        ("AEGIS_WEB_ENTRYPOINT", "Web entrypoint"),
        ("AEGIS_WEB_STATIC_DIR", "Web static assets"),
    ],
)
def test_settings_reject_missing_config_or_payload(tmp_path, removed_path, message):
    environment = _environment(tmp_path)
    target = Path(environment[removed_path])
    if target.is_dir():
        (target / "index.html").unlink()
    else:
        target.unlink()

    with pytest.raises(ValueError, match=message):
        ProductionSettings.from_environment(environment).validate()


def test_settings_require_loopback_and_distinct_ports(tmp_path):
    environment = _environment(tmp_path)
    environment["AEGIS_BIND_HOST"] = "0.0.0.0"
    with pytest.raises(ValueError, match="loopback"):
        ProductionSettings.from_environment(environment).validate()

    environment = _environment(tmp_path)
    environment["AEGIS_CONTROL_PORT"] = environment["PORT"]
    with pytest.raises(ValueError, match="distinct"):
        ProductionSettings.from_environment(environment).validate()


def test_settings_support_spaces_and_explicit_server_payload_paths(tmp_path):
    environment = _environment(tmp_path)
    settings = ProductionSettings.from_environment(environment)

    settings.validate()
    child_environment = settings.child_environment(
        {"PATH": "operator-path", "AEGIS_CONTROL_TOKEN": "do-not-copy"},
        core_status_url="http://127.0.0.1:18103/v1/core-status",
    )

    assert settings.application_root == Path(environment["AEGIS_APPLICATION_ROOT"])
    assert settings.node_executable == Path(environment["AEGIS_NODE_EXECUTABLE"])
    assert settings.web_entrypoint == Path(environment["AEGIS_WEB_ENTRYPOINT"])
    assert settings.static_dir == Path(environment["AEGIS_WEB_STATIC_DIR"])
    assert settings.paths.config_file == Path(environment["AEGIS_CONFIG_FILE"])
    assert settings.paths.root.name == "external writable data"
    assert settings.core_command()[:3] == [sys.executable, "-m", "aegis_soc.supervisor"]
    assert settings.web_command() == [
        environment["AEGIS_NODE_EXECUTABLE"],
        environment["AEGIS_WEB_ENTRYPOINT"],
    ]
    assert child_environment["AEGIS_DATA_DIR"] == environment["AEGIS_DATA_DIR"]
    assert child_environment["AEGIS_IDEA3_AUDIT_DB_PATH"] == str(settings.paths.web_db)
    assert child_environment["AEGIS_WEB_STATIC_DIR"] == environment["AEGIS_WEB_STATIC_DIR"]
    assert child_environment["AEGIS_IDEA3_RUNTIME_STATUS_URL"].endswith("/v1/core-status")
    assert "AEGIS_CONTROL_TOKEN" not in child_environment
