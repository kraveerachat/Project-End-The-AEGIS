"""Linux/server production runtime contracts."""

from __future__ import annotations

import json
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from aegis_soc.production_runtime import (
    ProductionRuntime,
    ProductionSettings,
    build_parser,
    production_status_command,
    production_stop_command,
    restart_command,
)
from aegis_soc.supervisor import ChildProcessSupervisor, settings_from_args
from aegis_soc.supervisor import build_parser as build_core_parser


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


def test_production_core_is_headless_and_has_no_telegram_command_surface(tmp_path):
    settings = ProductionSettings.from_environment(_environment(tmp_path))
    command = settings.core_command()
    core_args = build_core_parser().parse_args(command[3:])
    core_settings = settings_from_args(core_args)
    children = ChildProcessSupervisor(core_settings, lambda *args, **kwargs: None)

    children.configure()

    assert core_settings.start_gui is False
    assert "gui" not in children.components
    assert children.components == {}


class _Process:
    def __init__(self, returncode=None):
        self.returncode = returncode

    def poll(self):
        return self.returncode


def _core_status(*, broker="UNKNOWN", device="UNKNOWN"):
    return {
        "schemaVersion": 1,
        "generatedAt": "2026-09-10T00:00:00.000Z",
        "status": "UNKNOWN",
        "components": {"broker": broker, "device": device, "uplink": "UNKNOWN"},
        "modes": {
            "profile": "lab",
            "dryRun": True,
            "autoContain": False,
            "armed": "MONITOR_ONLY",
        },
        "issues": [],
        "evidenceSource": "RUNTIME_STATUS_FILE",
    }


def test_service_snapshot_separates_process_health_audit_readiness_and_physical_truth(
    tmp_path,
):
    settings = ProductionSettings.from_environment(_environment(tmp_path))
    runtime = ProductionRuntime(
        settings,
        readiness_probe=lambda _url: {
            "status": "READY",
            "audit": "READY",
            "schemaVersion": 2,
        },
        core_status_reader=lambda: _core_status(),
    )
    runtime.children = {"core": _Process(), "web": _Process()}

    snapshot = runtime.snapshot()

    assert snapshot["status"] == "READY"
    assert snapshot["processHealth"] == "HEALTHY"
    assert snapshot["serviceReadiness"] == "READY"
    assert snapshot["audit"] == "READY"
    assert snapshot["mqtt"] == "NOT_CONFIGURED"
    assert snapshot["idea1"] == "NOT_CONFIGURED"
    assert snapshot["idea2"] == "NOT_CONFIGURED"
    assert snapshot["esp32"] == "UNKNOWN"
    assert snapshot["physicalEvidence"] == "UNKNOWN"


def test_service_snapshot_degrades_when_web_or_audit_is_unavailable(tmp_path):
    settings = ProductionSettings.from_environment(_environment(tmp_path))
    runtime = ProductionRuntime(
        settings,
        readiness_probe=lambda _url: {"status": "DEGRADED", "audit": "DEGRADED"},
        core_status_reader=lambda: _core_status(broker="DISCONNECTED"),
    )
    runtime.children = {"core": _Process(), "web": _Process(returncode=1)}

    snapshot = runtime.snapshot()

    assert snapshot["status"] == "DEGRADED"
    assert snapshot["processHealth"] == "DEGRADED"
    assert snapshot["serviceReadiness"] == "DEGRADED"
    assert snapshot["audit"] == "DEGRADED"
    assert snapshot["mqtt"] == "NOT_CONFIGURED"
    assert snapshot["physicalEvidence"] == "UNKNOWN"


@pytest.mark.parametrize(
    ("configured", "broker", "expected"),
    [
        (False, "UNKNOWN", "NOT_CONFIGURED"),
        (True, "UNKNOWN", "UNKNOWN"),
        (True, "DISCONNECTED", "UNAVAILABLE"),
        (True, "CONNECTED", "CONNECTED"),
    ],
)
def test_service_snapshot_preserves_core_mqtt_evidence_truth(
    tmp_path, configured, broker, expected
):
    settings = replace(
        ProductionSettings.from_environment(_environment(tmp_path)),
        mqtt_configured=configured,
    )
    runtime = ProductionRuntime(
        settings,
        readiness_probe=lambda _url: {
            "status": "READY",
            "audit": "READY",
            "schemaVersion": 2,
        },
        core_status_reader=lambda: _core_status(broker=broker),
    )
    runtime.children = {"core": _Process(), "web": _Process()}

    snapshot = runtime.snapshot()

    assert snapshot["mqtt"] == expected
    assert snapshot["esp32"] == "UNKNOWN"
    assert snapshot["physicalEvidence"] == "UNKNOWN"


def test_service_snapshot_reports_configured_but_unprobed_feeds_as_unknown(tmp_path):
    environment = _environment(tmp_path)
    Path(environment["AEGIS_CONFIG_FILE"]).write_text(
        "NODE_ENV=production\n"
        "AEGIS_IDEA1_STATUS_URL=http://127.0.0.1:9/idea1-feed\n"
        "AEGIS_IDEA2_STATUS_URL=http://127.0.0.1:9/idea2-feed\n",
        encoding="utf-8",
    )
    settings = ProductionSettings.from_environment(environment)
    probed = []

    def readiness_probe(url):
        probed.append(url)
        return {"status": "READY", "audit": "READY", "schemaVersion": 2}

    runtime = ProductionRuntime(
        settings,
        readiness_probe=readiness_probe,
        core_status_reader=lambda: _core_status(),
    )
    runtime.children = {"core": _Process(), "web": _Process()}

    snapshot = runtime.snapshot()

    # This status source never contacts the feeds, so it cannot claim they are
    # unavailable; only the Web snapshot evaluates feed evidence.
    assert snapshot["idea1"] == "UNKNOWN"
    assert snapshot["idea2"] == "UNKNOWN"
    assert probed == ["http://localhost:18003/security/api/readiness"]


@pytest.mark.parametrize(
    ("terminal_status", "components"),
    [
        ("STOPPED", {"core": "STOPPED", "web": "STOPPED"}),
        ("FAILED", {"core": "FAILED", "web": "FAILED"}),
    ],
)
def test_terminal_service_status_does_not_probe_the_stopped_web_or_claim_audit_state(
    tmp_path, terminal_status, components
):
    settings = ProductionSettings.from_environment(_environment(tmp_path))
    runtime = ProductionRuntime(
        settings,
        readiness_probe=lambda _url: pytest.fail("a stopped Web must not be probed"),
        core_status_reader=lambda: _core_status(),
    )
    runtime.children = {"core": _Process(returncode=0), "web": _Process(returncode=0)}

    runtime._write_status(terminal_status)

    document = json.loads(
        (settings.paths.runtime_dir / "service-status.json").read_text(encoding="utf-8")
    )
    assert document["status"] == terminal_status
    assert document["processHealth"] == terminal_status
    assert document["serviceReadiness"] == terminal_status
    assert document["components"] == components
    assert document["audit"] == "UNKNOWN"
    assert document["physicalEvidence"] == "UNKNOWN"


class _Output:
    def __init__(self):
        self.value = ""

    def write(self, value):
        self.value += value
        return len(value)


def test_production_status_reads_service_status_and_returns_nonzero_when_degraded(
    tmp_path,
):
    settings = ProductionSettings.from_environment(_environment(tmp_path))
    settings.paths.runtime_dir.mkdir(parents=True)
    status_path = settings.paths.runtime_dir / "service-status.json"
    status_path.write_text(
        '{"status":"READY","audit":"READY","mqtt":"NOT_CONFIGURED"}\n',
        encoding="utf-8",
    )
    output = _Output()

    assert production_status_command(settings, output=output) == 0
    assert "status: READY" in output.value
    assert "audit: READY" in output.value
    assert "mqtt: NOT_CONFIGURED" in output.value

    status_path.write_text('{"status":"DEGRADED"}\n', encoding="utf-8")
    assert production_status_command(settings, output=_Output()) == 1


def test_production_stop_is_idempotent_when_no_instance_exists(tmp_path):
    settings = ProductionSettings.from_environment(_environment(tmp_path))
    output = _Output()

    code = production_stop_command(
        settings,
        output=output,
        post=lambda _url, _headers: pytest.fail("stop must not contact a missing instance"),
    )

    assert code == 0
    assert output.value == "stop: NOT_RUNNING\n"


def test_restart_stops_waits_for_the_old_boundary_and_starts_once(tmp_path):
    settings = ProductionSettings.from_environment(_environment(tmp_path))
    settings.paths.runtime_dir.mkdir(parents=True)
    token_path = settings.paths.runtime_dir / "control.token"
    token_path.write_text("old-control-token\n", encoding="utf-8")
    events = []

    def post(_url, headers):
        assert headers == {"X-AEGIS-Control-Token": "old-control-token"}
        events.append("stop")
        token_path.unlink()
        return 202

    class Runtime:
        def __init__(self, received_settings):
            assert received_settings is settings

        def run(self):
            events.append("start")
            return 0

    code = restart_command(
        settings,
        post=post,
        runtime_factory=Runtime,
        sleep=lambda _seconds: pytest.fail("removed token must not require a wait"),
        output=_Output(),
    )

    assert code == 0
    assert events == ["stop", "start"]


def test_cli_exposes_the_composite_service_lifecycle_commands():
    parser = build_parser()

    for command in ("start", "stop", "restart", "status", "doctor"):
        assert parser.parse_args([command]).command == command
