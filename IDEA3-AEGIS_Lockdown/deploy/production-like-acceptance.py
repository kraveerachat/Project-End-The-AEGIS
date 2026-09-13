#!/usr/bin/env python3
"""Run the PR9 Core+Web candidate against disposable local state only."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ACCEPTANCE_STEPS = (
    "health",
    "readiness",
    "login",
    "snapshot",
    "service-status",
    "audit-write",
    "audit-read",
    "stop",
    "restart",
    "audit-reopen",
    "logout",
    "clean-stop",
    "process-residue",
    "owner-only-permissions",
    "residue-check",
)

# With no broker, feed, or device configured, these are the only honest values.
HONEST_ABSENT_STATES = {
    "idea1": "NOT_CONFIGURED",
    "idea2": "NOT_CONFIGURED",
    "mqtt": "NOT_CONFIGURED",
    "esp32": "UNKNOWN",
    "physicalEvidence": "UNKNOWN",
}
PROC_ROOT = Path("/proc")


class AcceptanceFailure(RuntimeError):
    """A safe local acceptance assertion failed."""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Verify IDEA3 Core+Web locally without Production or hardware")
    parser.add_argument("--data-root", required=True, type=Path)
    return parser


def validate_data_root(path: Path, *, source_root: Path) -> Path:
    if not path.is_absolute():
        raise ValueError("--data-root must be an absolute disposable path")
    root = path.resolve()
    source = source_root.resolve()
    if root == source or root.is_relative_to(source):
        raise ValueError("--data-root must be outside the source tree")
    if root.exists() and any(root.iterdir()):
        raise ValueError("--data-root must be empty for a fresh acceptance run")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root


def build_environment(
    *,
    source_root: Path,
    data_root: Path,
    node_executable: Path,
    web_port: int,
    control_port: int,
    session_secret: str,
    password_hash: str,
) -> dict[str, str]:
    return {
        "NODE_ENV": "production",
        "AEGIS_PROFILE": "lab",
        "AEGIS_DRY_RUN": "1",
        "AEGIS_AUTO_CONTAIN": "0",
        "AEGIS_START_DETECTOR": "0",
        "AEGIS_START_GUI": "0",
        "AEGIS_VOICE_ENABLE": "0",
        "AEGIS_BROKER_IP": "",
        "AEGIS_BROKER_PORT": "",
        "AEGIS_MQTT_USER": "",
        "AEGIS_MQTT_PASS": "",
        "AEGIS_HMAC_SECRET": "",
        "AEGIS_ADMIN_PIN": "",
        "AEGIS_IDEA1_STATUS_URL": "",
        "AEGIS_IDEA2_STATUS_URL": "",
        "AEGIS_IDEA1_INTEGRATION_TOKEN": "",
        "AEGIS_IDEA2_INTEGRATION_TOKEN": "",
        "AEGIS_APPLICATION_ROOT": str(source_root),
        "AEGIS_DATA_DIR": str(data_root),
        "AEGIS_CONFIG_FILE": str(data_root / "config" / ".env"),
        "AEGIS_NODE_EXECUTABLE": str(node_executable),
        "AEGIS_WEB_ENTRYPOINT": str(source_root / "web" / "server" / "index.js"),
        "AEGIS_WEB_STATIC_DIR": str(source_root / "web" / "dist"),
        "AEGIS_BIND_HOST": "127.0.0.1",
        "AEGIS_WEB_BASE_PATH": "/security",
        "PORT": str(web_port),
        "AEGIS_CONTROL_PORT": str(control_port),
        "SESSION_SECRET": session_secret,
        "AEGIS_IDEA3_ADMIN_USER": "acceptance-admin",
        "AEGIS_IDEA3_ADMIN_PASSWORD_HASH": password_hash,
        "AEGIS_ALLOW_DEV_LOGIN": "false",
        "AEGIS_DEMO_ALLOWED": "false",
        "AEGIS_SESSION_IDLE_MS": "1800000",
        "AEGIS_MAX_EVIDENCE_AGE_MS": "120000",
        "AEGIS_ADAPTER_TIMEOUT_MS": "2500",
        "AEGIS_IDEA3_AUDIT_DB_PATH": str(data_root / "data" / "security-center-audit.sqlite3"),
        "AEGIS_DB_PATH": str(data_root / "data" / "core-audit.sqlite3"),
        "AEGIS_LOG_PATH": str(data_root / "logs" / "aegis_soc.log"),
        "AEGIS_RUNTIME_DIR": str(data_root / "runtime"),
        "AEGIS_RUNTIME_LOG_DIR": str(data_root / "logs"),
    }


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _hash_password(node: Path, source_root: Path, password: str) -> str:
    completed = subprocess.run(
        [str(node), str(source_root / "web" / "server" / "passwordHash.js")],
        input=f"{password}\n",
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    digest = completed.stdout.strip()
    if completed.returncode != 0 or not digest.startswith("$2"):
        raise AcceptanceFailure("password-hash helper failed")
    return digest


def _write_configuration(environment: dict[str, str]) -> None:
    path = Path(environment["AEGIS_CONFIG_FILE"])
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    lines = [
        "# Generated disposable PR9 acceptance configuration.",
        *(f"{name}={value}" for name, value in sorted(environment.items())),
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o600)


def _http_json(
    url: str,
    *,
    method: str = "GET",
    payload: dict | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, object, dict]:
    body = None if payload is None else json.dumps(payload).encode()
    request_headers = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url,
        method=method,
        data=body,
        headers=request_headers,
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            raw = response.read()
            document = json.loads(raw) if raw else {}
            return response.status, response.headers, document
    except urllib.error.HTTPError as error:
        raw = error.read()
        document = json.loads(raw) if raw else {}
        return error.code, error.headers, document


def _wait_for_json(url: str, *, expected_status: int, timeout: float = 20) -> dict:
    deadline = time.monotonic() + timeout
    last_status = 0
    while time.monotonic() < deadline:
        try:
            status, _headers, document = _http_json(url)
            last_status = status
            if status == expected_status:
                return document
        except (OSError, ValueError, urllib.error.URLError):
            pass
        time.sleep(0.1)
    raise AcceptanceFailure(f"endpoint did not reach HTTP {expected_status}; last={last_status}")


def _require(condition: bool, label: str) -> None:
    if not condition:
        raise AcceptanceFailure(label)


def _start_service(source_root: Path, environment: dict[str, str]) -> subprocess.Popen:
    child_environment = dict(os.environ)
    child_environment.update(environment)
    return subprocess.Popen(
        [sys.executable, "-m", "aegis_soc.production_runtime", "start"],
        cwd=source_root,
        env=child_environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        umask=0o077,
    )


def _stop_service(
    process: subprocess.Popen | None,
    *,
    source_root: Path,
    environment: dict[str, str],
) -> None:
    if process is None or process.poll() is not None:
        return
    child_environment = dict(os.environ)
    child_environment.update(environment)
    subprocess.run(
        [sys.executable, "-m", "aegis_soc.production_runtime", "stop"],
        cwd=source_root,
        env=child_environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=20,
        check=False,
    )
    try:
        process.wait(timeout=20)
        return
    except subprocess.TimeoutExpired:
        pass
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def _login(base_url: str, password: str) -> tuple[str, str]:
    origin = base_url.split("/security", 1)[0]
    status, headers, document = _http_json(
        f"{base_url}/api/auth/login",
        method="POST",
        payload={"username": "acceptance-admin", "password": password},
        headers={"Origin": origin},
    )
    _require(status == 200, "Admin login failed")
    cookie = (headers.get("Set-Cookie") or "").split(";", 1)[0]
    csrf = document.get("csrfToken")
    _require(cookie.startswith("aegis.idea3.sid="), "secure session cookie missing")
    _require(isinstance(csrf, str) and len(csrf) == 64, "CSRF token missing")
    return cookie, csrf


def _authenticated_headers(base_url: str, cookie: str, csrf: str | None = None):
    headers = {
        "Cookie": cookie,
        "Origin": base_url.split("/security", 1)[0],
    }
    if csrf is not None:
        headers["X-CSRF-Token"] = csrf
    return headers


def _exercise_generation(base_url: str, password: str, *, first: bool) -> None:
    if first:
        health = _wait_for_json(f"{base_url}/api/health", expected_status=200)
        _require(health == {"status": "ok"}, "liveness contract failed")

    readiness = _wait_for_json(f"{base_url}/api/readiness", expected_status=200)
    _require(
        readiness == {"status": "READY", "audit": "READY", "schemaVersion": 3},
        "schema-v3 readiness contract failed",
    )
    cookie, csrf = _login(base_url, password)
    headers = _authenticated_headers(base_url, cookie)

    status, _response_headers, snapshot = _http_json(f"{base_url}/api/security/snapshot", headers=headers)
    _require(status == 200 and snapshot.get("mode") == "LIVE", "snapshot failed")
    integration = snapshot.get("integration", {})
    _require(
        integration.get("idea1", {}).get("status") == "NOT_CONFIGURED",
        "IDEA1 absence was overstated",
    )
    _require(
        integration.get("idea2", {}).get("status") == "NOT_CONFIGURED",
        "IDEA2 absence was overstated",
    )

    if first:
        status, _response_headers, document = _http_json(
            f"{base_url}/api/security/settings",
            method="PATCH",
            payload={"auditRetentionDays": 365},
            headers=_authenticated_headers(base_url, cookie, csrf),
        )
        _require(status == 200 and document.get("audit"), "durable audit write failed")

    status, _response_headers, document = _http_json(f"{base_url}/api/security/audit?limit=50", headers=headers)
    audit = document.get("audit", [])
    _require(status == 200 and isinstance(audit, list), "audit read failed")
    if not first:
        _require(
            any(entry.get("action") == "UPDATE_POLICY" for entry in audit),
            "audit did not survive restart",
        )

    status, _response_headers, _document = _http_json(
        f"{base_url}/api/auth/logout",
        method="POST",
        headers=_authenticated_headers(base_url, cookie, csrf),
    )
    _require(status == 204, "logout failed")


def _assert_no_secret_leak(data_root: Path, values: tuple[str, ...]) -> None:
    for directory_name in ("logs", "runtime"):
        directory = data_root / directory_name
        if not directory.exists():
            continue
        for path in directory.rglob("*"):
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
            _require(not any(value in text for value in values), "secret reached logs/status")


def _proc_stat(pid: int, proc_root: Path) -> tuple[int, str] | None:
    """Return (parent pid, start time) for one live process, or None."""
    try:
        text = (proc_root / str(pid) / "stat").read_text(encoding="utf-8")
    except OSError:
        return None
    # The command name may contain spaces or parentheses; fields follow its last ")".
    fields = text.rsplit(")", 1)[1].split()
    return int(fields[1]), fields[19]


def _process_tree(root_pid: int, *, proc_root: Path = PROC_ROOT) -> dict[int, str]:
    """Map a process and all its descendants to their start times.

    Parent links are followed instead of the process group because the Core
    supervisor starts optional components in new sessions.
    """
    stats: dict[int, tuple[int, str]] = {}
    for entry in proc_root.iterdir():
        if entry.name.isdigit():
            stat = _proc_stat(int(entry.name), proc_root)
            if stat is not None:
                stats[int(entry.name)] = stat
    tree = {root_pid: stats[root_pid][1]} if root_pid in stats else {}
    frontier = [root_pid]
    while frontier:
        parent = frontier.pop()
        for pid, (ppid, starttime) in stats.items():
            if ppid == parent and pid not in tree:
                tree[pid] = starttime
                frontier.append(pid)
    return tree


def _surviving(processes: dict[int, str], *, proc_root: Path = PROC_ROOT) -> list[int]:
    """Return recorded processes still present with the same start time."""
    survivors = []
    for pid, starttime in sorted(processes.items()):
        stat = _proc_stat(pid, proc_root)
        if stat is not None and stat[1] == starttime:
            survivors.append(pid)
    return survivors


def _owner_only_violations(root: Path) -> list[str]:
    """List paths under the data root that grant any group or world access."""
    violations = []
    for path in sorted([root, *root.rglob("*")]):
        try:
            mode = path.lstat().st_mode
        except FileNotFoundError:
            continue
        if mode & 0o077:
            violations.append("." if path == root else path.relative_to(root).as_posix())
    return violations


def _read_service_status(data_root: Path) -> dict | None:
    try:
        document = json.loads((data_root / "runtime" / "service-status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return document if isinstance(document, dict) else None


def _wait_for_service_status(data_root: Path, *, timeout: float = 10) -> dict:
    deadline = time.monotonic() + timeout
    document = None
    while time.monotonic() < deadline:
        document = _read_service_status(data_root)
        if document and document.get("processHealth") == "HEALTHY" and document.get("serviceReadiness") == "READY":
            return document
        time.sleep(0.1)
    last = None if document is None else document.get("status")
    raise AcceptanceFailure(f"service status did not reach HEALTHY/READY; last={last}")


def _require_honest_states(document: dict) -> dict[str, str]:
    """Require the measured absent/unknown states; return exactly what was observed."""
    measured = {}
    for name, expected in HONEST_ABSENT_STATES.items():
        value = document.get(name)
        _require(value == expected, f"{name} must be {expected} without that dependency; observed {value}")
        measured[name] = value
    return measured


def run_acceptance(data_root: Path) -> dict[str, object]:
    source_root = Path(__file__).resolve().parent.parent
    root = validate_data_root(data_root, source_root=source_root)
    node_name = shutil.which("node")
    if node_name is None:
        raise AcceptanceFailure("Node.js is unavailable")
    node = Path(node_name).resolve()
    _require((source_root / "web" / "dist" / "index.html").is_file(), "Web build missing")

    web_port = _free_port()
    control_port = _free_port()
    while control_port == web_port:
        control_port = _free_port()
    password = f"Aa1!{secrets.token_urlsafe(24)}"
    session_secret = f"Aa1!{secrets.token_urlsafe(48)}"
    password_hash = _hash_password(node, source_root, password)
    environment = build_environment(
        source_root=source_root,
        data_root=root,
        node_executable=node,
        web_port=web_port,
        control_port=control_port,
        session_secret=session_secret,
        password_hash=password_hash,
    )
    _write_configuration(environment)
    base_url = f"http://localhost:{web_port}/security"
    process = None
    generations = 0
    service_states: dict[str, str] = {}
    processes_observed = 0
    try:
        for first in (True, False):
            process = _start_service(source_root, environment)
            _exercise_generation(base_url, password, first=first)
            running = _wait_for_service_status(root)
            _require(running.get("audit") == "READY", "service status audit is not READY")
            service_states = _require_honest_states(running)
            owned = _process_tree(process.pid)
            _require(len(owned) >= 3, "Core and Web were not observed under the service owner")
            processes_observed = len(owned)
            generations += 1
            _stop_service(process, source_root=source_root, environment=environment)
            _require(process.poll() == 0, "service did not stop cleanly")
            process = None
            _require(not _surviving(owned), "a service, Core, or Web process survived clean stop")
    finally:
        _stop_service(process, source_root=source_root, environment=environment)

    final = _read_service_status(root) or {}
    _require(
        final.get("status") == "STOPPED" and final.get("components") == {"core": "STOPPED", "web": "STOPPED"},
        "final service status is not a clean stop",
    )
    runtime_dir = root / "runtime"
    _require(not (runtime_dir / "control.token").exists(), "control token residue")
    _require(not list(root.rglob("*.tmp")), "temporary file residue")
    status, _headers, _document = 0, None, None
    try:
        status, _headers, _document = _http_json(f"{base_url}/api/health")
    except (OSError, urllib.error.URLError):
        pass
    _require(status == 0, "Web listener survived clean stop")
    violations = _owner_only_violations(root)
    _require(not violations, f"group/world-accessible paths: {', '.join(violations)}")
    _assert_no_secret_leak(root, (password, session_secret, password_hash))
    return {
        "result": "PRODUCTION_LIKE_VERIFIED",
        "generations": generations,
        "web": "READY",
        "audit": "PERSISTED_ACROSS_RESTART",
        **service_states,
        "processesObservedPerGeneration": processes_observed,
        "survivingProcesses": 0,
        "controlToken": "ABSENT",
        "ownerOnlyPermissions": True,
        "finalStatus": final["status"],
        "productionMutation": False,
    }


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        result = run_acceptance(arguments.data_root)
    except (AcceptanceFailure, OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"result": "FAIL", "error": str(error)}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
