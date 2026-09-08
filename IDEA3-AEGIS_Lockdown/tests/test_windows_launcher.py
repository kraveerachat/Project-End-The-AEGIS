"""Windows standalone launcher boundary and lifecycle tests."""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from dataclasses import replace

import pytest

from aegis_soc.paths import RuntimePaths
from aegis_soc.windows_launcher import ControlServer, LauncherRuntime, LauncherSettings


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
