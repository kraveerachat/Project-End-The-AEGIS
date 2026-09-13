"""Writable-path and dotenv bootstrap contracts for standalone runtimes."""

import json
import os
import subprocess
import sys

import pytest

from aegis_soc.paths import (
    RuntimePaths,
    application_root,
    configuration_path,
    data_root,
    load_dotenv,
)
from aegis_soc.runtime import RuntimeSettings


def test_source_application_root_is_the_idea3_directory():
    root = application_root(frozen=False)

    assert root.name == "IDEA3-AEGIS_Lockdown"
    assert (root / "aegis_soc").is_dir()


def test_windows_data_root_uses_local_appdata(tmp_path):
    root = data_root(env={"LOCALAPPDATA": str(tmp_path)}, platform="win32")

    assert root == (tmp_path / "AEGIS" / "IDEA3").resolve()


def test_explicit_absolute_data_root_wins_on_every_platform(tmp_path):
    root = data_root(
        env={"AEGIS_DATA_DIR": str(tmp_path / "operator-data")},
        platform="linux",
    )

    assert root == (tmp_path / "operator-data").resolve()


def test_relative_data_root_is_rejected():
    with pytest.raises(ValueError, match="AEGIS_DATA_DIR must be an absolute path"):
        data_root(env={"AEGIS_DATA_DIR": "relative/runtime"}, platform="win32")


def test_windows_data_root_requires_local_appdata_when_not_overridden():
    with pytest.raises(ValueError, match="LOCALAPPDATA is required"):
        data_root(env={}, platform="win32")


def test_explicit_configuration_path_must_be_absolute():
    with pytest.raises(ValueError, match="AEGIS_CONFIG_FILE must be an absolute path"):
        configuration_path(
            env={"AEGIS_CONFIG_FILE": "config/.env"},
            platform="win32",
        )


def test_source_configuration_defaults_to_project_dotenv():
    assert configuration_path(env={}, platform="linux") == application_root() / ".env"


def test_external_data_root_moves_configuration_outside_the_payload(tmp_path):
    assert configuration_path(
        env={"AEGIS_DATA_DIR": str(tmp_path)},
        platform="linux",
    ) == tmp_path.resolve() / "config" / ".env"


def test_runtime_paths_keep_all_mutable_files_under_external_root(tmp_path):
    paths = RuntimePaths.from_environment(
        env={"AEGIS_DATA_DIR": str(tmp_path)},
        platform="win32",
    )

    assert paths == RuntimePaths(
        root=tmp_path.resolve(),
        config_file=tmp_path.resolve() / "config" / ".env",
        core_db=tmp_path.resolve() / "data" / "core-audit.sqlite3",
        web_db=tmp_path.resolve() / "data" / "security-center-audit.sqlite3",
        runtime_dir=tmp_path.resolve() / "runtime",
        log_dir=tmp_path.resolve() / "logs",
    )


def test_runtime_paths_keep_the_core_dispatch_ledger_beside_but_apart_from_the_core_audit(tmp_path):
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(tmp_path)}, platform="linux")

    assert paths.dispatch_db == tmp_path.resolve() / "data" / "core-dispatch.sqlite3"
    assert paths.dispatch_db != paths.core_db


def test_dotenv_adds_values_without_overriding_process_environment(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text(
        "# operator configuration\n"
        "SESSION_SECRET=file-value\n"
        "PORT='8003'\n"
        "AEGIS_IDEA1_INTEGRATION_TOKEN=\n",
        encoding="utf-8",
    )
    env = {"SESSION_SECRET": "operator-value"}

    load_dotenv(dotenv, env)

    assert env == {
        "SESSION_SECRET": "operator-value",
        "PORT": "8003",
        "AEGIS_IDEA1_INTEGRATION_TOKEN": "",
    }


def test_missing_dotenv_is_a_noop(tmp_path):
    env = {"EXISTING": "value"}

    load_dotenv(tmp_path / "missing.env", env)

    assert env == {"EXISTING": "value"}


def test_dotenv_rejects_invalid_variable_names(tmp_path):
    dotenv = tmp_path / ".env"
    dotenv.write_text("VALID_NAME=ok\nINVALID-NAME=blocked\n", encoding="utf-8")
    env = {}

    with pytest.raises(ValueError, match="invalid environment variable name"):
        load_dotenv(dotenv, env)

    assert env == {}


def _run_config_import(tmp_path, environment):
    env = os.environ.copy()
    for name in (
        "AEGIS_BROKER_PORT",
        "AEGIS_CONFIG_FILE",
        "AEGIS_DATA_DIR",
        "AEGIS_DB_PATH",
        "AEGIS_LOG_PATH",
    ):
        env.pop(name, None)
    env.update(environment)
    env["PYTHONPATH"] = str(application_root())
    return subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import json; from aegis_soc import config; "
                "print(json.dumps({'db': config.DB_PATH, 'log': config.LOG_PATH, "
                "'port': config.PORT, 'brokerConfigured': config.BROKER_CONFIGURED, "
                "'warnings': config.validate_config()}))"
            ),
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        encoding=env.get("PYTHONIOENCODING", "utf-8").split(":", 1)[0],
        check=False,
    )


def test_config_uses_external_data_root_for_mutable_defaults(tmp_path):
    result = _run_config_import(tmp_path, {"AEGIS_DATA_DIR": str(tmp_path / "state")})

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["db"] == str((tmp_path / "state" / "data" / "core-audit.sqlite3").resolve())
    assert payload["log"] == str((tmp_path / "state" / "logs" / "aegis_soc.log").resolve())


def test_config_loads_an_explicit_absolute_dotenv(tmp_path):
    dotenv = tmp_path / "operator.env"
    dotenv.write_text("AEGIS_BROKER_PORT=2883\n", encoding="utf-8")

    result = _run_config_import(tmp_path, {"AEGIS_CONFIG_FILE": str(dotenv)})

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["port"] == 2883


def test_config_import_accepts_standalone_blank_optional_broker_values(tmp_path):
    dotenv = tmp_path / "standalone.env"
    dotenv.write_text(
        "AEGIS_BROKER_IP=\nAEGIS_BROKER_PORT=\nAEGIS_MQTT_USER=\nAEGIS_MQTT_PASS=\n",
        encoding="utf-8",
    )

    result = _run_config_import(tmp_path, {"AEGIS_CONFIG_FILE": str(dotenv)})

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["port"] == 1883
    assert payload["brokerConfigured"] is False
    assert any("broker is not configured" in warning.lower() for warning in payload["warnings"])


def test_malformed_broker_port_fallback_is_windows_console_safe(tmp_path):
    dotenv = tmp_path / "malformed.env"
    dotenv.write_text("AEGIS_BROKER_IP=\nAEGIS_BROKER_PORT=not-a-port\n", encoding="utf-8")

    result = _run_config_import(
        tmp_path,
        {
            "AEGIS_CONFIG_FILE": str(dotenv),
            "PYTHONIOENCODING": "cp1252",
        },
    )

    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["port"] == 1883
    assert payload["brokerConfigured"] is False
    assert "AEGIS_BROKER_PORT is not an integer; using default port 1883" in payload["warnings"]
    assert "UnicodeEncodeError" not in result.stderr
    assert result.stdout.isascii()


def test_config_rejects_a_relative_dotenv_path(tmp_path):
    result = _run_config_import(tmp_path, {"AEGIS_CONFIG_FILE": "operator.env"})

    assert result.returncode != 0
    assert "AEGIS_CONFIG_FILE must be an absolute path" in result.stderr


def test_runtime_settings_derive_runtime_and_log_dirs_from_external_root(monkeypatch, tmp_path):
    monkeypatch.setenv("AEGIS_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("AEGIS_RUNTIME_DIR", raising=False)
    monkeypatch.delenv("AEGIS_RUNTIME_LOG_DIR", raising=False)

    settings = RuntimeSettings.from_profile("development")

    assert settings.runtime_dir == tmp_path.resolve() / "runtime"
    assert settings.log_dir == tmp_path.resolve() / "logs"
