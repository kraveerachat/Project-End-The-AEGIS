"""Windows standalone launcher boundary and lifecycle tests."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from dataclasses import replace
from pathlib import Path

import pytest

from aegis_soc.paths import RuntimePaths
from aegis_soc.windows_launcher import (
    ControlServer,
    LauncherRuntime,
    LauncherSettings,
    doctor_command,
    logs_command,
    open_command,
    status_command,
    write_configuration,
)


def _paths(tmp_path):
    root = tmp_path / "state"
    return RuntimePaths(
        root=root,
        config_file=root / "config" / ".env",
        core_db=root / "data" / "core-audit.sqlite3",
        web_db=root / "data" / "security-center-audit.sqlite3",
        runtime_dir=root / "runtime",
        log_dir=root / "logs",
    )


def _settings(tmp_path, **changes):
    payload = tmp_path / "payload"
    (payload / "node").mkdir(parents=True)
    (payload / "server").mkdir()
    (payload / "web").mkdir()
    (payload / "node" / "node.exe").write_bytes(b"node")
    (payload / "server" / "index.js").write_text("// server\n", encoding="utf-8")
    (payload / "web" / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
    base = LauncherSettings(
        application_root=payload,
        paths=_paths(tmp_path),
        profile="lab",
        dry_run=True,
        web_port=8003,
        control_port=0,
        bind_host="127.0.0.1",
        open_browser=False,
    )
    return replace(base, **changes)


def _json_request(url, *, method="GET", headers=None, data=None):
    request = urllib.request.Request(url, method=method, headers=headers or {}, data=data)
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            return response.status, dict(response.headers), json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), json.loads(error.read())


def test_launcher_settings_require_loopback_distinct_ports_and_payload(tmp_path):
    valid = _settings(tmp_path)

    valid.validate()

    with pytest.raises(ValueError, match="loopback"):
        replace(valid, bind_host="0.0.0.0").validate()
    with pytest.raises(ValueError, match="distinct"):
        replace(valid, control_port=8003).validate()
    (valid.node_executable).unlink()
    with pytest.raises(ValueError, match="bundled Node runtime"):
        valid.validate()


def test_child_environment_uses_external_paths_and_excludes_control_token(tmp_path):
    settings = _settings(tmp_path)

    environment = settings.child_environment(
        {"PATH": "operator-path", "AEGIS_CONTROL_TOKEN": "must-not-cross"},
        core_status_url="http://127.0.0.1:8004/v1/core-status",
    )

    assert environment["NODE_ENV"] == "production"
    assert environment["AEGIS_DATA_DIR"] == str(settings.paths.root)
    assert environment["AEGIS_CONFIG_FILE"] == str(settings.paths.config_file)
    assert environment["AEGIS_DB_PATH"] == str(settings.paths.core_db)
    assert environment["AEGIS_IDEA3_AUDIT_DB_PATH"] == str(settings.paths.web_db)
    assert environment["AEGIS_RUNTIME_DIR"] == str(settings.paths.runtime_dir)
    assert environment["AEGIS_RUNTIME_LOG_DIR"] == str(settings.paths.log_dir)
    assert environment["AEGIS_WEB_BASE_PATH"] == "/security"
    assert environment["AEGIS_WEB_STATIC_DIR"] == str(settings.static_dir)
    assert environment["AEGIS_IDEA3_RUNTIME_STATUS_URL"].endswith("/v1/core-status")
    assert "AEGIS_CONTROL_TOKEN" not in environment


def test_frozen_and_source_core_commands_are_unambiguous(tmp_path):
    settings = _settings(tmp_path)

    source = settings.core_command(frozen=False)
    frozen = settings.core_command(frozen=True)

    assert source[:3] == [sys.executable, "-m", "aegis_soc.supervisor"]
    assert frozen[:2] == [sys.executable, "core"]
    assert "--dry-run" in frozen
    assert "--headless" in frozen
    assert "--no-detector" in frozen
    assert settings.web_command() == [str(settings.node_executable), str(settings.web_entrypoint)]


def test_control_server_exposes_safe_status_and_requires_stop_token():
    stop_requests = []
    server = ControlServer(
        host="127.0.0.1",
        port=0,
        token="runtime-control-token",
        core_status=lambda: {
            "schemaVersion": 1,
            "status": "UNKNOWN",
            "components": {"device": "UNKNOWN"},
        },
        launcher_status=lambda: {
            "status": "DEGRADED",
            "components": {"core": "RUNNING", "web": "FAILED"},
        },
        request_stop=lambda: stop_requests.append("stop"),
    )
    server.start()
    try:
        status, headers, core = _json_request(f"{server.base_url}/v1/core-status")
        denied, _, denied_body = _json_request(
            f"{server.base_url}/v1/stop",
            method="POST",
            data=b"",
        )
        accepted, _, accepted_body = _json_request(
            f"{server.base_url}/v1/stop",
            method="POST",
            headers={"X-AEGIS-Control-Token": "runtime-control-token"},
            data=b"",
        )
    finally:
        server.close()

    assert status == 200
    assert headers["Cache-Control"] == "no-store"
    assert core["status"] == "UNKNOWN"
    assert "runtime-control-token" not in json.dumps(core)
    assert denied == 403
    assert denied_body == {"error": {"code": "CONTROL_DENIED"}}
    assert accepted == 202
    assert accepted_body == {"accepted": True}
    assert stop_requests == ["stop"]


def test_control_server_rejects_stop_request_bodies():
    server = ControlServer(
        host="127.0.0.1",
        port=0,
        token="runtime-control-token",
        core_status=dict,
        launcher_status=dict,
        request_stop=lambda: None,
    )
    server.start()
    try:
        status, _, body = _json_request(
            f"{server.base_url}/v1/stop",
            method="POST",
            headers={"X-AEGIS-Control-Token": "runtime-control-token"},
            data=b"unexpected",
        )
    finally:
        server.close()

    assert status == 413
    assert body == {"error": {"code": "BODY_NOT_ALLOWED"}}


class FakeProcess:
    def __init__(self, name, events, *, returncode=None):
        self.name = name
        self.events = events
        self.returncode = returncode

    def poll(self):
        return self.returncode

    def terminate(self):
        self.events.append(f"terminate:{self.name}")
        self.returncode = 0

    def wait(self, timeout):
        self.events.append(f"wait:{self.name}:{timeout}")
        return self.returncode

    def kill(self):
        self.events.append(f"kill:{self.name}")
        self.returncode = -9


def test_launcher_status_never_reports_healthy_with_a_failed_child(tmp_path):
    runtime = LauncherRuntime(_settings(tmp_path))
    runtime.children = {
        "core": FakeProcess("core", []),
        "web": FakeProcess("web", [], returncode=1),
    }

    assert runtime.snapshot() == {
        "schemaVersion": 1,
        "status": "DEGRADED",
        "profile": "lab",
        "dryRun": True,
        "components": {"core": "RUNNING", "web": "FAILED"},
    }


def test_launcher_stops_web_before_core_without_forced_kill(tmp_path):
    events = []
    runtime = LauncherRuntime(_settings(tmp_path))
    runtime.children = {
        "core": FakeProcess("core", events),
        "web": FakeProcess("web", events),
    }

    runtime.shutdown_children(timeout=15)

    assert events == [
        "terminate:web",
        "wait:web:15",
        "terminate:core",
        "wait:core:15",
    ]


def test_launcher_run_starts_children_and_cleans_control_state(tmp_path):
    events = []
    captured_environments = []
    settings = _settings(tmp_path)
    settings.paths.config_file.parent.mkdir(parents=True)
    settings.paths.config_file.write_text(
        "SESSION_SECRET=external-session-secret\n",
        encoding="utf-8",
    )

    def popen(command, **kwargs):
        name = "core" if len(captured_environments) == 0 else "web"
        events.append(f"start:{name}")
        captured_environments.append(kwargs["env"])
        return FakeProcess(name, events)

    class StopImmediatelyControlServer:
        def __init__(self, **kwargs):
            self.request_stop = kwargs["request_stop"]
            self.base_url = "http://127.0.0.1:49152"

        def start(self):
            events.append("control:start")
            self.request_stop()

        def close(self):
            events.append("control:close")

    runtime = LauncherRuntime(
        settings,
        popen_factory=popen,
        control_server_factory=StopImmediatelyControlServer,
        token_factory=lambda: "control-secret",
    )

    assert runtime.run() == 0
    assert events == [
        "control:start",
        "start:core",
        "start:web",
        "terminate:web",
        "wait:web:15",
        "terminate:core",
        "wait:core:15",
        "control:close",
    ]
    assert all(environment["SESSION_SECRET"] == "external-session-secret" for environment in captured_environments)
    assert all("control-secret" not in json.dumps(environment) for environment in captured_environments)
    assert not (settings.paths.runtime_dir / "control.token").exists()
    persisted = json.loads((settings.paths.runtime_dir / "launcher-status.json").read_text())
    assert persisted["status"] == "STOPPED"


def test_launcher_run_cleans_up_when_a_child_cannot_start(tmp_path):
    events = []
    settings = _settings(tmp_path)

    def popen(_command, **_kwargs):
        if "start:core" not in events:
            events.append("start:core")
            return FakeProcess("core", events)
        events.append("start:web")
        raise OSError("process creation denied")

    class FakeControlServer:
        def __init__(self, **_kwargs):
            self.base_url = "http://127.0.0.1:49152"

        def start(self):
            events.append("control:start")

        def close(self):
            events.append("control:close")

    runtime = LauncherRuntime(
        settings,
        popen_factory=popen,
        control_server_factory=FakeControlServer,
        token_factory=lambda: "control-secret",
    )

    assert runtime.run() == 1
    assert events == [
        "control:start",
        "start:core",
        "start:web",
        "terminate:core",
        "wait:core:15",
        "control:close",
    ]
    assert not (settings.paths.runtime_dir / "control.token").exists()


def test_configuration_is_external_atomic_and_contains_no_plaintext_password(tmp_path):
    settings = _settings(tmp_path)
    observed_passwords = []

    def password_hasher(password):
        observed_passwords.append(password)
        return '$2b$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy'

    path = write_configuration(
        settings,
        username="admin",
        password="operator-password",
        password_hasher=password_hasher,
        secret_factory=lambda: "generated-session-secret",
    )

    text = path.read_text(encoding="utf-8")
    assert path == settings.paths.config_file
    assert observed_passwords == ["operator-password"]
    assert "operator-password" not in text
    assert "SESSION_SECRET=generated-session-secret" in text
    assert "AEGIS_IDEA3_ADMIN_USER=admin" in text
    assert "AEGIS_IDEA3_ADMIN_PASSWORD_HASH=$2b$12$" in text
    assert "AEGIS_IDEA1_INTEGRATION_TOKEN=\n" in text
    assert "AEGIS_IDEA2_INTEGRATION_TOKEN=\n" in text
    assert list(path.parent.glob("*.tmp")) == []


def test_configuration_emits_the_keys_the_production_web_runtime_requires(tmp_path):
    settings = _settings(tmp_path)

    path = write_configuration(
        settings,
        username="admin",
        password="operator-password",
        password_hasher=lambda _p: "$2b$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy",
        secret_factory=lambda: "generated-session-secret",
    )
    values = dict(
        line.split("=", 1)
        for line in path.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
    )

    assert values["AEGIS_WEB_STATIC_DIR"] == str(settings.static_dir)
    assert values["AEGIS_WEB_BASE_PATH"] == "/security"
    assert values["AEGIS_BIND_HOST"] == settings.bind_host
    assert "AEGIS_IDEA3_STATIC_DIR" not in values


def test_configuration_refuses_invalid_username_or_implicit_overwrite(tmp_path):
    settings = _settings(tmp_path)
    settings.paths.config_file.parent.mkdir(parents=True)
    settings.paths.config_file.write_text("EXISTING=value\n", encoding="utf-8")
    hasher = lambda _password: '$2b$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy'

    with pytest.raises(FileExistsError):
        write_configuration(
            settings,
            username="admin",
            password="password",
            password_hasher=hasher,
            secret_factory=lambda: "session-secret",
        )
    with pytest.raises(ValueError, match="username"):
        write_configuration(
            settings,
            username="admin\nSESSION_SECRET=attacker",
            password="password",
            password_hasher=hasher,
            secret_factory=lambda: "session-secret",
            force=True,
        )
    assert settings.paths.config_file.read_text(encoding="utf-8") == "EXISTING=value\n"


class _Recorder:
    def __init__(self):
        self.lines = []

    def write(self, text):
        self.lines.append(text)
        return len(text)

    def text(self):
        return "".join(self.lines)


def _status_document(tmp_path, document):
    paths = _paths(tmp_path)
    paths.runtime_dir.mkdir(parents=True, exist_ok=True)
    (paths.runtime_dir / "launcher-status.json").write_text(
        json.dumps(document), encoding="utf-8"
    )
    return paths


def test_status_command_reports_running_and_returns_zero(tmp_path):
    settings = _settings(tmp_path)
    _status_document(tmp_path, {
        "schemaVersion": 1, "status": "RUNNING", "profile": "production",
        "dryRun": True, "components": {"core": "RUNNING", "web": "RUNNING"},
    })
    output = _Recorder()

    code = status_command(settings, output=output)

    assert code == 0
    assert "RUNNING" in output.text()


@pytest.mark.parametrize("status", ["STOPPED", "DEGRADED", "FAILED"])
def test_status_command_returns_nonzero_for_unhealthy_states(tmp_path, status):
    settings = _settings(tmp_path)
    _status_document(tmp_path, {
        "schemaVersion": 1, "status": status, "profile": "production",
        "dryRun": True, "components": {"core": status, "web": status},
    })
    output = _Recorder()

    code = status_command(settings, output=output)

    assert code != 0
    assert status in output.text()


def test_status_command_reports_not_running_when_no_status_document_exists(tmp_path):
    settings = _settings(tmp_path)
    output = _Recorder()

    code = status_command(settings, output=output)

    assert code != 0
    assert "NOT_RUNNING" in output.text()


def test_open_command_refuses_to_launch_a_browser_until_web_health_succeeds(tmp_path):
    settings = _settings(tmp_path)
    opened = []
    output = _Recorder()

    code = open_command(
        settings,
        output=output,
        health_check=lambda _url: False,
        browser_open=opened.append,
    )

    assert code != 0
    assert opened == []


def test_open_command_opens_the_loopback_url_after_web_health_succeeds(tmp_path):
    settings = _settings(tmp_path)
    opened = []
    output = _Recorder()

    code = open_command(
        settings,
        output=output,
        health_check=lambda _url: True,
        browser_open=opened.append,
    )

    assert code == 0
    assert opened == [f"http://{settings.bind_host}:{settings.web_port}/security"]


def test_logs_command_tails_the_external_log_without_leaving_the_log_directory(tmp_path):
    settings = _settings(tmp_path)
    settings.paths.log_dir.mkdir(parents=True, exist_ok=True)
    (settings.paths.log_dir / "aegis_soc.log").write_text(
        "".join(f"line-{index}\n" for index in range(10)), encoding="utf-8"
    )
    output = _Recorder()

    code = logs_command(settings, output=output, lines=3)

    assert code == 0
    assert output.text().splitlines()[-3:] == ["line-7", "line-8", "line-9"]


def test_logs_command_reports_missing_logs_instead_of_failing_hard(tmp_path):
    settings = _settings(tmp_path)
    output = _Recorder()

    code = logs_command(settings, output=output, lines=3)

    assert code != 0
    assert "NO_LOGS" in output.text()


def test_doctor_reports_missing_configuration_and_payload_without_contacting_hardware(tmp_path):
    settings = _settings(tmp_path)
    settings.web_entrypoint.unlink()
    output = _Recorder()

    code = doctor_command(settings, output=output)
    text = output.text()

    assert code != 0
    assert "config: MISSING" in text
    assert "payload: MISSING" in text
    for forbidden in ("mqtt", "broker", "relay", "esp32"):
        assert forbidden not in text.lower()


def test_doctor_passes_when_config_payload_and_writable_paths_are_present(tmp_path):
    settings = _settings(tmp_path)
    settings.paths.config_file.parent.mkdir(parents=True, exist_ok=True)
    settings.paths.config_file.write_text("NODE_ENV=production\n", encoding="utf-8")
    settings.web_entrypoint.parent.mkdir(parents=True, exist_ok=True)
    settings.web_entrypoint.write_text("// server\n", encoding="utf-8")
    settings.node_executable.parent.mkdir(parents=True, exist_ok=True)
    settings.node_executable.write_text("", encoding="utf-8")
    settings.static_dir.mkdir(parents=True, exist_ok=True)
    output = _Recorder()

    code = doctor_command(settings, output=output, port_probe=lambda _host, _port: True)
    text = output.text()

    assert code == 0
    assert "config: OK" in text
    assert "payload: OK" in text
    assert "writable: OK" in text


def test_doctor_never_prints_secret_values_from_the_configuration(tmp_path):
    settings = _settings(tmp_path)
    settings.paths.config_file.parent.mkdir(parents=True, exist_ok=True)
    settings.paths.config_file.write_text(
        "SESSION_SECRET=super-secret-value\n"
        "AEGIS_IDEA3_ADMIN_PASSWORD_HASH=$2b$12$abcdefghijklmnopqrstuv\n",
        encoding="utf-8",
    )
    output = _Recorder()

    doctor_command(settings, output=output, port_probe=lambda _host, _port: True)

    assert "super-secret-value" not in output.text()
    assert "$2b$12$" not in output.text()


WINDOWS = Path(__file__).resolve().parent.parent / "windows"


def test_toolchain_lock_pins_verified_node_archive():
    lock = json.loads((WINDOWS / "toolchain-lock.json").read_text(encoding="utf-8"))

    assert lock["node"]["version"] == "24.20.0"
    assert lock["node"]["sha256"] == (
        "6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba"
    )
    assert lock["node"]["architecture"] == "x64"
    assert lock["node"]["url"].startswith("https://nodejs.org/")
    assert lock["node"]["url"].endswith(lock["node"]["filename"])


def test_build_requirements_pin_exact_pyinstaller():
    requirements = (WINDOWS / "requirements-build.txt").read_text(encoding="utf-8")

    assert "pyinstaller==6.22.2" in requirements
    assert ">=" not in requirements


def test_spec_is_onedir_and_excludes_secret_runtime_inputs():
    spec = (WINDOWS / "aegis-idea3.spec").read_text(encoding="utf-8")

    assert "EXE(" in spec and "COLLECT(" in spec
    assert "name='AEGIS-IDEA3'" in spec
    assert ".env" not in spec
    assert "*.sqlite" not in spec


def test_build_script_verifies_node_hash_and_refuses_a_dirty_source_tree():
    script = (WINDOWS / "build.ps1").read_text(encoding="utf-8")

    assert "Get-FileHash" in script
    assert "status --porcelain" in script
    assert "SHA-256 mismatch" in script
    for stage in ("pytest", "npm", "pyinstaller", "Compress-Archive"):
        assert stage in script.lower() or stage in script


def test_build_script_scans_for_forbidden_artifacts_and_writes_a_manifest():
    script = (WINDOWS / "build.ps1").read_text(encoding="utf-8")

    assert "manifest.json" in script
    for forbidden in (".env", "*.sqlite", "node_modules"):
        assert forbidden in script


def test_generated_windows_artifacts_are_ignored_by_git():
    ignored = (Path(__file__).resolve().parent.parent / ".gitignore").read_text(encoding="utf-8")

    for pattern in ("windows/cache/", "windows/build/", "windows/dist/", "windows/out/"):
        assert pattern in ignored


class _FakeProcess:
    def __init__(self, name, events):
        self.name = name
        self.events = events
        self._alive = True

    def poll(self):
        return None if self._alive else 0

    def terminate(self):
        self.events.append(f"terminate:{self.name}")
        self._alive = False

    def wait(self, timeout=None):
        self.events.append(f"wait:{self.name}")
        return 0

    def kill(self):
        self.events.append(f"kill:{self.name}")
        self._alive = False


def test_shutdown_closes_web_before_core_and_waits_for_each(tmp_path):
    settings = _settings(tmp_path)
    runtime = LauncherRuntime(settings)
    events = []
    runtime.children = {
        "core": _FakeProcess("core", events),
        "web": _FakeProcess("web", events),
    }

    runtime.shutdown_children(timeout=5)

    assert events == ["terminate:web", "wait:web", "terminate:core", "wait:core"]


def test_shutdown_leaves_external_databases_untouched(tmp_path):
    settings = _settings(tmp_path)
    settings.paths.core_db.parent.mkdir(parents=True, exist_ok=True)
    settings.paths.core_db.write_bytes(b"core-audit")
    settings.paths.web_db.parent.mkdir(parents=True, exist_ok=True)
    settings.paths.web_db.write_bytes(b"web-audit")
    runtime = LauncherRuntime(settings)
    runtime.children = {"web": _FakeProcess("web", [])}

    runtime.shutdown_children(timeout=5)

    assert settings.paths.core_db.read_bytes() == b"core-audit"
    assert settings.paths.web_db.read_bytes() == b"web-audit"


def test_launcher_module_opens_no_controller_or_actuation_path():
    source = (Path(__file__).resolve().parent.parent / "aegis_soc" / "windows_launcher.py").read_text(
        encoding="utf-8"
    )

    for forbidden in ("mqtt_client", "MQTTManager", "issue_command", "CUT_UPLINK", "paho"):
        assert forbidden not in source


def test_smoke_script_uses_bundle_binaries_and_never_prints_credentials():
    script = (WINDOWS / "smoke.ps1").read_text(encoding="utf-8")

    assert "-BundlePath" in script and "-DataPath" in script
    assert "AEGIS_DATA_DIR" in script
    assert "smoke-result.json" in script
    for stage in ("configure", "status", "login", "logout", "stop"):
        assert stage in script.lower()
    assert "Write-Host $password" not in script
    assert "ConvertTo-Json" in script
