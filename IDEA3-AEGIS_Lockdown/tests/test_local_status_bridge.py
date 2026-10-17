"""The loopback Core status bridge is read-only, loopback-only and fail-closed."""

from __future__ import annotations

import ast
import http.client
import json
import shutil
import threading
import time
from pathlib import Path

import pytest

from tools import local_stack
from tools import local_status_bridge as bridge

LOCKDOWN_ROOT = Path(__file__).resolve().parents[1]


def _core_status(**changes):
    value = {
        "state": "RUNNING", "profile": "development", "dry_run": True, "auto_contain": False, "broker": "CONNECTED",
        "device": "ONLINE", "uplink": "NORMAL", "armed": "MONITOR_ONLY", "dispatch": "DISABLED", "time_trust": "SYNCED",
        "updated_at": time.time(), "components": {"detector": "RUNNING"},
    }
    value.update(changes)
    return value


@pytest.fixture
def served(tmp_path):
    status_file = tmp_path / "status.json"
    server = bridge.build_server(status_file)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield status_file, server.server_address[1]
    server.shutdown()
    server.server_close()


def _request(port, method="GET", path="/status"):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request(method, path)
    response = conn.getresponse()
    body = response.read()
    conn.close()
    return response.status, body


def test_valid_status_is_served_as_the_core_projection(served):
    status_file, port = served
    status_file.write_text(json.dumps(_core_status()))
    status, body = _request(port)
    document = json.loads(body)
    assert status == 200
    assert document["schemaVersion"] == 1
    assert document["status"] == "UNKNOWN", "a dry-run Core is never reported HEALTHY"
    assert document["components"]["broker"] == "CONNECTED"
    assert set(document) >= {"schemaVersion", "generatedAt", "status", "components", "modes", "issues"}


def test_missing_malformed_and_oversized_status_become_the_absent_projection(served):
    status_file, port = served
    for write in (None, lambda: status_file.write_text("{not json"), lambda: status_file.write_text(" " * (bridge.MAX_STATUS_BYTES + 1))):
        if write:
            write()
        status, body = _request(port)
        document = json.loads(body)
        assert status == 200
        assert document["status"] == "UNKNOWN" and document["evidenceSource"] == "RUNTIME_STATUS_ABSENT"
        assert document["generatedAt"] is None


def test_secrets_and_free_text_never_cross_the_bridge(served):
    status_file, port = served
    status_file.write_text(json.dumps(_core_status(detail="token=SECRET", pid=4242, extra_secret="hunter2")))
    _, body = _request(port)
    assert b"SECRET" not in body and b"hunter2" not in body and b"4242" not in body


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
def test_only_get_status_is_served(served, method):
    _, port = served
    assert _request(port, method)[0] == 405


@pytest.mark.parametrize("path", ["/", "/status/x", "/status?x=1", "/../etc/passwd", "/health"])
def test_no_other_route_exists(served, path):
    _, port = served
    assert _request(port, "GET", path)[0] == 404


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.117", "localhost", "example.com", ""])
def test_non_loopback_hosts_are_refused(tmp_path, host):
    with pytest.raises(ValueError):
        bridge.build_server(tmp_path / "status.json", host=host)


def test_relative_status_path_is_refused():
    with pytest.raises(ValueError):
        bridge.build_server(Path("status.json"))


def test_bridge_module_has_no_process_network_client_or_write_capability():
    tree = ast.parse(Path(bridge.__file__).read_text(encoding="utf-8"))
    imported = {alias.name.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names}
    imported |= {node.module.split(".")[0] for node in ast.walk(tree) if isinstance(node, ast.ImportFrom) and node.module}
    assert not imported & {"subprocess", "os", "socket", "paho", "serial", "urllib", "requests", "shutil"}
    source = Path(bridge.__file__).read_text(encoding="utf-8")
    assert "sudo" not in source.replace("no sudo fallback", "") and "write_text" not in source and "open(" not in source


@pytest.mark.skipif(shutil.which("node") is None or not (LOCKDOWN_ROOT / "web" / "dist" / "index.html").is_file(),
                    reason="node or web/dist unavailable")
def test_stack_start_status_stop_cycle_and_web_shows_unknown_without_core_status(tmp_path):
    state = tmp_path / "state"
    missing = tmp_path / "absent-status.json"
    port = local_stack._free_port()
    base = ["--state-dir", str(state)]
    assert local_stack.main([*base, "start", "--status-file", str(missing), "--web-port", str(port)]) == 0
    try:
        assert local_stack.main([*base, "status"]) == 0
        assert local_stack.main([*base, "start", "--status-file", str(missing), "--web-port", str(port)]) == 1
        assert oct((state / "web-dev-password").stat().st_mode & 0o777) == "0o600"
        assert local_stack._http_status(f"http://127.0.0.1:{port}/security/api/security/snapshot") == 401
    finally:
        assert local_stack.main([*base, "stop"]) == 0
    assert local_stack.main([*base, "status"]) == 3
    assert local_stack._http_status(f"http://127.0.0.1:{port}/security/") is None
