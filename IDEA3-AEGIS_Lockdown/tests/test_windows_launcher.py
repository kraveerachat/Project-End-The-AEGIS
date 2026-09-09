"""Windows standalone launcher boundary and lifecycle tests."""

from __future__ import annotations

import argparse
import getpass
import io
import json
import os
import re
import shutil
import subprocess
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
    start_command,
    status_command,
    stop_command,
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


def _bundle_for_subprocess(tmp_path):
    """A payload shaped like the built one-folder bundle."""
    bundle = tmp_path / "bundle"
    (bundle / "node").mkdir(parents=True)
    (bundle / "server").mkdir()
    (bundle / "web").mkdir()
    (bundle / "windows").mkdir()
    (bundle / "node" / "node.exe").write_bytes(b"node")
    (bundle / "server" / "index.js").write_text("// server\n", encoding="utf-8")
    (bundle / "web" / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
    shutil.copy(LAUNCHER_MAIN, bundle / "windows" / "launcher_main.py")
    shutil.copytree(Path(__file__).resolve().parent.parent / "aegis_soc", bundle / "aegis_soc")
    return bundle


def test_settings_use_a_runtime_paths_api_that_actually_exists(tmp_path, monkeypatch):
    """`_settings` is the first line of every command; a wrong API breaks them all."""

    launcher_main = _load_launcher_main()
    bundle = _bundle_for_subprocess(tmp_path)
    monkeypatch.setenv("AEGIS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(bundle / "AEGIS-IDEA3.exe"))

    settings = launcher_main._settings(
        argparse.Namespace(profile="lab", dry_run=True, web_port=8003)
    )

    assert settings.paths.config_file == tmp_path / "data" / "config" / ".env"
    assert settings.application_root == bundle


def test_frozen_application_root_is_the_bundle_directory_not_the_pyinstaller_internal(
    tmp_path, monkeypatch
):
    """PyInstaller 6 puts sys._MEIPASS in _internal; the payload is beside the exe.

    build.ps1 stages node/, server/ and web/ next to AEGIS-IDEA3.exe, so anchoring
    on _MEIPASS makes every bundled component unreachable.
    """

    launcher_main = _load_launcher_main()
    bundle = _bundle_for_subprocess(tmp_path)
    internal = bundle / "_internal"
    internal.mkdir()
    monkeypatch.setenv("AEGIS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(bundle / "AEGIS-IDEA3.exe"))
    monkeypatch.setattr(sys, "_MEIPASS", str(internal), raising=False)

    settings = launcher_main._settings(
        argparse.Namespace(profile="lab", dry_run=True, web_port=8003)
    )

    assert settings.application_root == bundle
    assert settings.application_root != internal
    assert settings.node_executable == bundle / "node" / "node.exe"
    assert settings.web_entrypoint.is_file()
    assert (settings.static_dir / "index.html").is_file()


@pytest.mark.parametrize(
    ("command", "expected_code", "expected_text"),
    [("doctor", 1, "config: MISSING"), ("status", 1, "status: NOT_RUNNING")],
)
def test_frozen_entry_point_runs_commands_instead_of_crashing(
    tmp_path, command, expected_code, expected_text
):
    """Run the entry point as its own process, the way the bundle does."""

    bundle = _bundle_for_subprocess(tmp_path)
    environment = dict(os.environ)
    environment["AEGIS_DATA_DIR"] = str(tmp_path / "data")

    completed = subprocess.run(
        [sys.executable, str(bundle / "windows" / "launcher_main.py"), "--profile", "lab", command],
        capture_output=True,
        text=True,
        env=environment,
        timeout=60,
        check=False,
    )

    assert "Traceback" not in completed.stderr, completed.stderr
    assert completed.returncode == expected_code
    assert expected_text in completed.stdout


def test_stop_reaches_a_real_control_server_over_loopback(tmp_path, monkeypatch):
    """Exercise the actual HTTP wiring the launcher uses, not a stub."""

    launcher_main = _load_launcher_main()
    stopped = []
    server = ControlServer(
        host="127.0.0.1",
        port=0,
        token="live-control-token",
        core_status=lambda: {"status": "UNKNOWN"},
        launcher_status=lambda: {"status": "RUNNING"},
        request_stop=lambda: stopped.append(True),
    )
    server.start()
    try:
        settings = replace(
            _settings(tmp_path),
            control_port=int(server.base_url.rsplit(":", 1)[1]),
        )
        settings.paths.runtime_dir.mkdir(parents=True, exist_ok=True)
        (settings.paths.runtime_dir / "control.token").write_text(
            "live-control-token\n", encoding="utf-8"
        )
        monkeypatch.setattr(launcher_main, "_settings", lambda _arguments: settings)

        assert launcher_main.main(["stop"]) == 0
    finally:
        server.close()

    assert stopped == [True]


def test_stop_is_refused_when_the_control_token_is_wrong(tmp_path, monkeypatch):
    launcher_main = _load_launcher_main()
    stopped = []
    server = ControlServer(
        host="127.0.0.1",
        port=0,
        token="real-token",
        core_status=lambda: {"status": "UNKNOWN"},
        launcher_status=lambda: {"status": "RUNNING"},
        request_stop=lambda: stopped.append(True),
    )
    server.start()
    try:
        settings = replace(
            _settings(tmp_path),
            control_port=int(server.base_url.rsplit(":", 1)[1]),
        )
        settings.paths.runtime_dir.mkdir(parents=True, exist_ok=True)
        (settings.paths.runtime_dir / "control.token").write_text("stolen-token\n", encoding="utf-8")
        monkeypatch.setattr(launcher_main, "_settings", lambda _arguments: settings)

        assert launcher_main.main(["stop"]) == 1
    finally:
        server.close()

    assert stopped == []


def test_smoke_script_records_evidence_even_when_the_run_aborts():
    script = SMOKE_FILE.read_text(encoding="utf-8")

    abort = script.index("Add-Result 'smoke-run-completed' $false")
    evidence = script.index("smoke-result.json")
    assert abort < evidence, "an aborted run must still reach the evidence stage"
    assert "Add-Result 'smoke-run-completed' $true" in script
    assert "$message.Replace($password, '<redacted>')" in script
    assert "exit $(if ($failed -eq 0) { 0 } else { 1 })" in script


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


# --------------------------------------------------------------- launcher CLI

LAUNCHER_MAIN = WINDOWS / "launcher_main.py"


def _load_launcher_main():
    """Import the frozen entry point from its source path, as PyInstaller does."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("aegis_launcher_main", LAUNCHER_MAIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class _PipedStdin(io.StringIO):
    """Redirected stdin: exactly what `$StdIn | & AEGIS-IDEA3.exe configure` gives."""

    def isatty(self):
        return False


class _ConsoleStdin(io.StringIO):
    """An interactive console, where hidden entry must still be used."""

    def isatty(self):
        return True


def _configure_arguments(**changes):
    defaults = {"username": "admin", "force": False}
    defaults.update(changes)
    return argparse.Namespace(**defaults)


def test_configure_reads_piped_credentials_and_never_calls_the_console_getpass(tmp_path, monkeypatch):
    """Windows `getpass` reads the console, not a redirected pipe.

    CPython's ``win_getpass`` calls ``msvcrt.getwch()``, which reads CONIN$ and
    never sees piped stdin, so the documented stdin-only automation contract
    cannot be served by ``getpass`` on a frozen Windows console executable.
    """

    launcher_main = _load_launcher_main()
    settings = _settings(tmp_path)
    hashed = []

    def _hasher_factory(_settings):
        def hash_password(password):
            hashed.append(password)
            return "$2b$12$" + "x" * 53

        return hash_password

    def _forbidden(*_args, **_kwargs):
        raise AssertionError("getpass must not be used when stdin is redirected")

    monkeypatch.setattr(launcher_main, "_node_password_hasher", _hasher_factory)
    monkeypatch.setattr(getpass, "getpass", _forbidden)
    monkeypatch.setattr(sys, "stdin", _PipedStdin("piped-secret\npiped-secret\n"))

    code = launcher_main._configure(settings, _configure_arguments())

    assert code == 0
    assert settings.paths.config_file.is_file()
    assert hashed == ["piped-secret"]
    assert "piped-secret" not in settings.paths.config_file.read_text(encoding="utf-8")


def test_configure_rejects_mismatched_piped_credentials_without_writing_config(tmp_path, monkeypatch):
    launcher_main = _load_launcher_main()
    settings = _settings(tmp_path)

    monkeypatch.setattr(launcher_main, "_node_password_hasher", lambda _s: (lambda _p: "$2b$12$" + "x" * 53))
    monkeypatch.setattr(sys, "stdin", _PipedStdin("first-secret\nsecond-secret\n"))

    code = launcher_main._configure(settings, _configure_arguments())

    assert code == 2
    assert not settings.paths.config_file.exists()


def test_configure_fails_loudly_when_the_pipe_supplies_no_credentials(tmp_path, monkeypatch):
    launcher_main = _load_launcher_main()
    settings = _settings(tmp_path)

    monkeypatch.setattr(launcher_main, "_node_password_hasher", lambda _s: (lambda _p: "$2b$12$" + "x" * 53))
    monkeypatch.setattr(sys, "stdin", _PipedStdin(""))

    code = launcher_main._configure(settings, _configure_arguments())

    assert code != 0
    assert not settings.paths.config_file.exists()


def test_configure_still_hides_entry_on_an_interactive_console(tmp_path, monkeypatch):
    launcher_main = _load_launcher_main()
    settings = _settings(tmp_path)
    prompts = []

    def _fake_getpass(prompt=""):
        prompts.append(prompt)
        return "console-secret"

    monkeypatch.setattr(launcher_main, "_node_password_hasher", lambda _s: (lambda _p: "$2b$12$" + "x" * 53))
    monkeypatch.setattr(getpass, "getpass", _fake_getpass)
    monkeypatch.setattr(sys, "stdin", _ConsoleStdin(""))

    code = launcher_main._configure(settings, _configure_arguments())

    assert code == 0
    assert len(prompts) == 2


def test_configure_never_echoes_the_password_it_read(tmp_path, monkeypatch, capsys):
    launcher_main = _load_launcher_main()
    settings = _settings(tmp_path)

    monkeypatch.setattr(launcher_main, "_node_password_hasher", lambda _s: (lambda _p: "$2b$12$" + "x" * 53))
    monkeypatch.setattr(sys, "stdin", _PipedStdin("never-print-me\nnever-print-me\n"))

    launcher_main._configure(settings, _configure_arguments())
    captured = capsys.readouterr()

    assert "never-print-me" not in captured.out
    assert "never-print-me" not in captured.err


def test_launcher_cli_exposes_every_documented_operator_command():
    """The parser and windows/README.md must describe the same launcher."""

    launcher_main = _load_launcher_main()
    parser = launcher_main.build_parser()
    documented = set(
        re.findall(r"^AEGIS-IDEA3\.exe (\w[\w-]*)", (WINDOWS / "README.md").read_text(encoding="utf-8"), re.MULTILINE)
    )
    subparsers = next(
        action for action in parser._actions if isinstance(action, argparse._SubParsersAction)
    )

    assert documented, "README must document the operator commands"
    assert documented <= set(subparsers.choices), (
        f"documented but not implemented: {sorted(documented - set(subparsers.choices))}"
    )
    for command in ("configure", "doctor", "start", "status", "open", "logs", "stop"):
        assert command in subparsers.choices


@pytest.mark.parametrize("command", ["start", "stop"])
def test_lifecycle_commands_parse_and_dispatch(tmp_path, monkeypatch, command):
    launcher_main = _load_launcher_main()
    settings = _settings(tmp_path)
    dispatched = []

    monkeypatch.setattr(launcher_main, "_settings", lambda _arguments: settings)
    monkeypatch.setattr(
        launcher_main,
        "start_command",
        lambda given, **_kwargs: dispatched.append(("start", given)) or 0,
    )
    monkeypatch.setattr(
        launcher_main,
        "stop_command",
        lambda given, **_kwargs: dispatched.append(("stop", given)) or 0,
    )

    assert launcher_main.main([command]) == 0
    assert dispatched == [(command, settings)]


def test_start_command_runs_the_launcher_runtime_with_its_children(tmp_path):
    settings = _settings(tmp_path)
    started = []

    class _Runtime:
        def __init__(self, given):
            started.append(given)

        def run(self):
            return 7

    assert start_command(settings, runtime_factory=_Runtime) == 7
    assert started == [settings]


def test_stop_command_uses_the_authenticated_loopback_control_boundary(tmp_path):
    settings = _settings(tmp_path)
    settings.paths.runtime_dir.mkdir(parents=True, exist_ok=True)
    (settings.paths.runtime_dir / "control.token").write_text("control-token-value\n", encoding="utf-8")
    calls = []
    output = io.StringIO()

    def _post(url, headers):
        calls.append((url, headers))
        return 202

    assert stop_command(settings, output=output, post=_post) == 0
    url, headers = calls[0]
    assert url == f"http://{settings.bind_host}:{settings.control_port}/v1/stop"
    assert headers["X-AEGIS-Control-Token"] == "control-token-value"
    assert "control-token-value" not in output.getvalue()


def test_stop_command_reports_not_running_without_a_control_token(tmp_path):
    settings = _settings(tmp_path)
    output = io.StringIO()

    def _post(_url, _headers):
        raise AssertionError("stop must not contact anything without a token")

    assert stop_command(settings, output=output, post=_post) == 1
    assert "NOT_RUNNING" in output.getvalue()


def test_stop_command_returns_nonzero_when_the_boundary_refuses(tmp_path):
    settings = _settings(tmp_path)
    settings.paths.runtime_dir.mkdir(parents=True, exist_ok=True)
    (settings.paths.runtime_dir / "control.token").write_text("stale-token\n", encoding="utf-8")
    output = io.StringIO()

    assert stop_command(settings, output=output, post=lambda _u, _h: 403) == 1
    assert "stale-token" not in output.getvalue()


def test_stop_command_never_terminates_arbitrary_processes():
    import ast
    import inspect

    function = ast.parse(inspect.getsource(stop_command)).body[0]
    if ast.get_docstring(function):
        function.body = function.body[1:]
    code = ast.unparse(function)

    for forbidden in ("kill", "taskkill", "terminate", "Popen", "psutil", "signal"):
        assert forbidden not in code




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


SPEC_FILE = WINDOWS / "aegis-idea3.spec"
MODULE_ROOT = WINDOWS.parent


class _StubAnalysis:
    """Records the source arguments the spec hands to PyInstaller."""

    def __init__(self, scripts, **options):
        self.requested_scripts = list(scripts)
        self.requested_options = options
        self.pure = ()
        self.zipped_data = ()
        self.scripts = ()
        self.binaries = ()
        self.zipfiles = ()
        self.datas = ()


def _execute_spec_from(working_directory):
    """Execute the spec the way PyInstaller 6 does, from an arbitrary directory.

    PyInstaller injects SPEC/SPECPATH into the spec namespace and never changes
    the process working directory, so the caller's directory must not influence
    which sources are packaged.
    """

    recorded = {}

    def _record(name):
        def factory(*args, **options):
            recorded.setdefault(name, []).append((args, options))
            return object()

        return factory

    def _analysis(scripts, **options):
        analysis = _StubAnalysis(scripts, **options)
        recorded["analysis"] = analysis
        return analysis

    namespace = {
        "Analysis": _analysis,
        "PYZ": _record("PYZ"),
        "EXE": _record("EXE"),
        "COLLECT": _record("COLLECT"),
        "SPEC": str(SPEC_FILE),
        "SPECPATH": str(SPEC_FILE.parent),
        "DISTPATH": str(Path(working_directory) / "dist"),
        "workpath": str(Path(working_directory) / "build"),
        "os": os,
    }

    previous = Path.cwd()
    os.chdir(working_directory)
    try:
        exec(  # noqa: S102 - the spec is repository source, executed exactly as PyInstaller does
            compile(SPEC_FILE.read_text(encoding="utf-8"), str(SPEC_FILE), "exec"),
            namespace,
        )
    finally:
        os.chdir(previous)
    return recorded


@pytest.mark.parametrize(
    "caller",
    ["module_root", "repository_root", "unrelated_directory"],
)
def test_spec_resolves_bundle_sources_independently_of_the_caller_directory(tmp_path, caller):
    working_directory = {
        "module_root": MODULE_ROOT,
        "repository_root": MODULE_ROOT.parent,
        "unrelated_directory": tmp_path,
    }[caller]

    recorded = _execute_spec_from(working_directory)

    analysis = recorded["analysis"]
    launcher = WINDOWS / "launcher_main.py"
    assert launcher.is_file()
    assert [Path(script) for script in analysis.requested_scripts] == [launcher]
    search_path = [Path(entry) for entry in analysis.requested_options["pathex"]]
    assert MODULE_ROOT in search_path
    assert (MODULE_ROOT / "aegis_soc" / "__init__.py").is_file()
    assert recorded["COLLECT"], "the one-folder bundle must still be collected"


def test_spec_never_anchors_sources_on_the_process_working_directory():
    spec = SPEC_FILE.read_text(encoding="utf-8")

    assert "os.getcwd()" not in spec
    assert "SPECPATH" in spec


def test_build_script_runs_source_verification_from_the_module_root():
    script = (WINDOWS / "build.ps1").read_text(encoding="utf-8")

    assert "Push-Location $ProjectRoot" in script


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


SMOKE_FILE = WINDOWS / "smoke.ps1"


def _bundle_independent_passes(bundle_path, tool_source):
    """Model of the smoke check `$onPath.Source -notlike "$BundlePath*"`."""

    return not tool_source.startswith(bundle_path)


def _survivor_detected(bundle_path, process_path):
    """Model of the smoke check `$_.Path.StartsWith($BundlePath)`."""

    return process_path.startswith(bundle_path)


def test_a_relative_bundle_path_would_make_the_process_origin_checks_vacuous(tmp_path):
    """The defect this contract exists to prevent, stated as executable evidence."""

    bundle = tmp_path / "AEGIS-IDEA3"
    (bundle / "node").mkdir(parents=True)
    tool_inside_bundle = str(bundle / "node" / "node.exe")
    child_inside_bundle = str(bundle / "AEGIS-IDEA3.exe")
    relative_bundle = os.path.join(".", "AEGIS-IDEA3")

    # An absolute process path never matches a relative prefix, so a bundle-sourced
    # toolchain and a surviving bundle child both report PASS without being proven.
    assert _bundle_independent_passes(relative_bundle, tool_inside_bundle)
    assert not _survivor_detected(relative_bundle, child_inside_bundle)

    # The canonical absolute path the acceptance boundary must produce instead.
    resolved_bundle = str(bundle.resolve())
    assert not _bundle_independent_passes(resolved_bundle, tool_inside_bundle)
    assert _survivor_detected(resolved_bundle, child_inside_bundle)


def test_smoke_script_canonicalises_the_bundle_path_before_every_use():
    script = SMOKE_FILE.read_text(encoding="utf-8")

    resolution = script.index("Resolve-Path -LiteralPath $BundlePath")
    for use in (
        "Join-Path $BundlePath 'AEGIS-IDEA3.exe'",
        "Join-Path $BundlePath 'node' 'node.exe'",
        '-notlike "$BundlePath*"',
        ".StartsWith($BundlePath)",
        "Join-Path $BundlePath '*.sqlite3'",
    ):
        assert use in script, use
        assert script.index(use) > resolution, f"{use} compares an unresolved -BundlePath"


def test_smoke_script_fails_loudly_on_an_unresolvable_bundle_path():
    script = SMOKE_FILE.read_text(encoding="utf-8")

    guard = script.index("Test-Path -LiteralPath $BundlePath")
    assert "SMOKE FAILED: -BundlePath not found" in script
    assert guard < script.index("Resolve-Path -LiteralPath $BundlePath")


def test_smoke_script_keeps_every_precondition_gate():
    script = SMOKE_FILE.read_text(encoding="utf-8")

    assert script.index("Windows acceptance must run on Windows") < script.index(
        "Resolve-Path -LiteralPath $BundlePath"
    )
    assert "SMOKE FAILED: launcher not found at" in script
    assert "-DataPath must not already exist" in script


def test_smoke_script_uses_bundle_binaries_and_never_prints_credentials():
    script = (WINDOWS / "smoke.ps1").read_text(encoding="utf-8")

    assert "-BundlePath" in script and "-DataPath" in script
    assert "AEGIS_DATA_DIR" in script
    assert "smoke-result.json" in script
    for stage in ("configure", "status", "login", "logout", "stop"):
        assert stage in script.lower()
    assert "Write-Host $password" not in script
    assert "ConvertTo-Json" in script


def test_launcher_reports_an_incomplete_bundle_without_a_frozen_traceback(tmp_path, monkeypatch, capsys):
    """A frozen executable must never answer an operator with a stack trace."""

    launcher_main = _load_launcher_main()
    incomplete = tmp_path / "bundle"
    incomplete.mkdir()
    monkeypatch.setenv("AEGIS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(launcher_main.sys, "_MEIPASS", str(incomplete), raising=False)

    code = launcher_main.main(["doctor"])
    captured = capsys.readouterr()

    assert code == 2
    assert "INVALID_SETTINGS" in captured.out
    assert "Traceback" not in captured.out + captured.err


def test_smoke_integration_token_gate_is_multiline_anchored():
    """PowerShell `-match` is single-line: an unanchored `$` makes the gate dead."""

    script = SMOKE_FILE.read_text(encoding="utf-8")

    assert "(?m)^AEGIS_IDEA{0}_INTEGRATION_TOKEN=" in script
    assert "AEGIS_IDEA1_INTEGRATION_TOKEN=\\s*$" not in script


def test_frozen_core_child_forwards_its_argv_to_the_supervisor(monkeypatch):
    """The bundle re-invokes itself as Core; the launcher parser must not eat its flags."""

    from aegis_soc import supervisor

    launcher_main = _load_launcher_main()
    forwarded = []
    monkeypatch.setattr(supervisor, "main", lambda argv=None: forwarded.append(argv) or 0)

    code = launcher_main.main(
        ["core", "--profile", "lab", "--dry-run", "--headless", "--no-detector", "--no-voice"]
    )

    assert code == 0
    assert forwarded == [
        ["--profile", "lab", "--dry-run", "--headless", "--no-detector", "--no-voice"]
    ]


def test_core_child_command_and_entry_point_agree(tmp_path, monkeypatch):
    """`core_command(frozen=True)` and the entry point must describe one contract."""

    from aegis_soc import supervisor

    launcher_main = _load_launcher_main()
    settings = _settings(tmp_path)
    command = settings.core_command(frozen=True)
    forwarded = []
    monkeypatch.setattr(supervisor, "main", lambda argv=None: forwarded.append(argv) or 0)

    assert command[1] == "core"
    assert launcher_main.main(command[1:]) == 0
    assert forwarded == [command[2:]]


def test_spec_packages_the_core_supervisor_and_its_transport():
    spec = SPEC_FILE.read_text(encoding="utf-8")

    assert "'aegis_soc.supervisor'" in spec
    assert "'paho'" not in spec, "the Core child imports paho at module import time"
    assert "'tkinter'" in spec and "'pytest'" in spec


def test_build_script_discards_a_stale_artifact_before_verification():
    """A build that fails verification must not leave a previous bundle behind.

    Smoke acceptance takes a bundle path, so a stale artifact surviving a failed
    build can be smoke-tested and reported against the wrong commit.
    """

    script = (WINDOWS / "build.ps1").read_text(encoding="utf-8")

    discard = script.index("Remove-Item -Recurse -Force $OutDir")
    assert discard < script.index("python -m pytest")
    assert discard < script.index("npm test")
    assert script.count("Remove-Item -Recurse -Force $OutDir") == 1


STAGE_SERVER_SCRIPT = WINDOWS / "stage-server-payload.ps1"


def _web_source_tree(root):
    """Minimal stand-in for IDEA3-AEGIS_Lockdown/web with the paths that matter."""

    web = root / "web"
    server = web / "server"
    (server / "routes").mkdir(parents=True)
    (server / "index.js").write_text("// entrypoint\n", encoding="utf-8")
    (server / "passwordHash.js").write_text("// bcrypt helper\n", encoding="utf-8")
    (server / "routes" / "session.js").write_text("// routes\n", encoding="utf-8")
    (web / "package.json").write_text('{"name":"aegis-idea3-web"}\n', encoding="utf-8")
    (web / "package-lock.json").write_text('{"lockfileVersion":3}\n', encoding="utf-8")
    return web


def _stage_server_payload(web_dir, server_stage):
    return subprocess.run(
        [
            "pwsh",
            "-NoProfile",
            "-NonInteractive",
            "-File",
            str(STAGE_SERVER_SCRIPT),
            "-WebDir",
            str(web_dir),
            "-ServerStage",
            str(server_stage),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


requires_powershell = pytest.mark.skipif(
    shutil.which("pwsh") is None,
    reason="PowerShell 7 is required to execute the bundle staging contract",
)


@requires_powershell
@pytest.mark.parametrize("destination", ["missing", "already_exists"])
def test_server_payload_is_staged_directly_under_server(tmp_path, destination):
    """The launcher opens <bundle>/server/index.js, so the payload must not nest.

    ``Copy-Item -Recurse`` of a directory onto a destination that already exists
    places the source *inside* it, which produced <bundle>/server/server/... on
    real Windows while package.json stayed one level up. Both destination states
    must now yield the same flat layout.
    """

    web = _web_source_tree(tmp_path)
    server_stage = tmp_path / "bundle" / "server"
    server_stage.parent.mkdir(parents=True)
    if destination == "already_exists":
        (server_stage / "stale").mkdir(parents=True)

    completed = _stage_server_payload(web, server_stage)

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert (server_stage / "index.js").is_file()
    assert (server_stage / "passwordHash.js").is_file()
    assert not (server_stage / "server" / "index.js").exists()
    assert not (server_stage / "server" / "passwordHash.js").exists()
    assert not (server_stage / "server").exists()
    assert not (server_stage / "stale").exists()
    assert (server_stage / "routes" / "session.js").is_file()
    assert (server_stage / "package.json").is_file()
    assert (server_stage / "package-lock.json").is_file()


@requires_powershell
def test_server_payload_staging_fails_when_the_entrypoints_are_missing(tmp_path):
    web = _web_source_tree(tmp_path)
    (web / "server" / "passwordHash.js").unlink()
    server_stage = tmp_path / "bundle" / "server"

    completed = _stage_server_payload(web, server_stage)

    assert completed.returncode != 0
    assert "passwordHash.js" in completed.stdout + completed.stderr


def test_build_script_delegates_server_staging_to_the_verified_helper():
    script = (WINDOWS / "build.ps1").read_text(encoding="utf-8")

    assert STAGE_SERVER_SCRIPT.is_file()
    assert "stage-server-payload.ps1') -WebDir $WebDir -ServerStage $serverStage" in script
    # The directory-onto-existing-directory copy is what nested the payload.
    assert "Copy-Item -Recurse -Force (Join-Path $WebDir $item) $serverStage" not in script
    assert "@('server', 'package.json', 'package-lock.json')" not in script
    # npm ci must still install production dependencies into <bundle>/server.
    assert script.index("-ServerStage $serverStage") < script.index("npm ci --omit=dev")


def test_server_staging_helper_pins_the_launcher_payload_contract():
    helper = STAGE_SERVER_SCRIPT.read_text(encoding="utf-8")

    for copy in re.findall(r"(?m)^\s*Copy-Item.*$", helper):
        assert "-LiteralPath" in copy and "-Destination" in copy, copy
    for required in ("index.js", "passwordHash.js", "package.json", "package-lock.json"):
        assert f"'{required}'" in helper
    assert "$nested = Join-Path $ServerStage 'server'" in helper
