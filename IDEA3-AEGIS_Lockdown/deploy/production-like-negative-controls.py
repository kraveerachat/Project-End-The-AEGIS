#!/usr/bin/env python3
"""Run the PR9 fail-closed negative controls against disposable local state only.

Every case gets a fresh data root beneath --data-root, the lab/headless/dry-run
Core, generated test-only credentials, and loopback-only dependencies. No
Production host, real broker, device, relay, or real IDEA1/IDEA2 feed is
contacted, and no command is published.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import secrets
import shutil
import socket
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parent.parent
_ACCEPTANCE_SPEC = importlib.util.spec_from_file_location(
    "production_like_acceptance",
    Path(__file__).resolve().parent / "production-like-acceptance.py",
)
assert _ACCEPTANCE_SPEC is not None and _ACCEPTANCE_SPEC.loader is not None
ACCEPTANCE = importlib.util.module_from_spec(_ACCEPTANCE_SPEC)
_ACCEPTANCE_SPEC.loader.exec_module(ACCEPTANCE)

_RUNTIME_MARKERS = (
    "aegis_soc.production_runtime",
    "aegis_soc.supervisor",
    str(SOURCE_ROOT / "web" / "server" / "index.js"),
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run IDEA3 fail-closed negative controls locally without Production or hardware"
    )
    parser.add_argument("--data-root", required=True, type=Path)
    return parser


@dataclass(frozen=True)
class Context:
    node: Path
    password: str
    session_secret: str
    password_hash: str
    feed_token: str
    feed_url: str
    closed_port: int

    @property
    def secret_values(self) -> tuple[str, ...]:
        return (self.password, self.session_secret, self.password_hash, self.feed_token)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _feed_handler(token: str):
    class FeedHandler(BaseHTTPRequestHandler):
        """Loopback feed that serves one fixed document per route to a bearer token."""

        def log_message(self, *_args):
            return

        def do_GET(self):
            if self.headers.get("Authorization") != f"Bearer {token}":
                self._send(401, b"{}")
                return
            now = datetime.now(timezone.utc)
            documents = {
                "/fresh": {"schema_version": 1, "generated_at": _iso(now), "events": []},
                "/stale": {"schema_version": 1, "generated_at": _iso(now - timedelta(hours=1)), "events": []},
                "/wrong-schema": {"schema_version": 2, "generated_at": _iso(now), "events": []},
            }
            route = self.path.split("?", 1)[0]
            if route == "/malformed":
                self._send(200, b"{not-json")
            elif route in documents:
                self._send(200, json.dumps(documents[route]).encode())
            else:
                self._send(404, b"{}")

        def _send(self, status: int, body: bytes) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return FeedHandler


def _clean(observation: dict) -> bool:
    return (
        not observation["controlTokenResidue"]
        and not observation["survivingProcesses"]
        and not observation["webListenerAfter"]
        and not observation["secretLeak"]
    )


def fails_closed(observation: dict) -> bool:
    """The service started, a child refused the configuration, and the owner failed cleanly."""
    final = observation["finalServiceStatus"] or {}
    return (
        observation["exitedDuringStart"]
        and observation["exit"] not in (0, None)
        and final.get("status") == "FAILED"
        and final.get("physicalEvidence") == "UNKNOWN"
        and _clean(observation)
    )


def rejected_before_start(observation: dict) -> bool:
    """The service owner rejected its settings before creating any runtime state."""
    return observation["exit"] == 2 and observation["finalServiceStatus"] is None and _clean(observation)


def degrades(source: str, code: str) -> Callable[[dict], bool]:
    """A bad feed stays UNKNOWN, raises an explicit error, and produces no incident."""

    def check(observation: dict) -> bool:
        running = observation.get("runningServiceStatus") or {}
        final = observation.get("finalServiceStatus") or {}
        return (
            not observation["exitedDuringStart"]
            and observation.get(source, {}).get("status") not in (None, "HEALTHY")
            and code in observation.get("operationalErrors", [])
            and observation.get("incidents") == 0
            and running.get(source) == "UNKNOWN"
            and running.get("physicalEvidence") == "UNKNOWN"
            and observation["exit"] == 0
            and final.get("status") == "STOPPED"
            and _clean(observation)
        )

    return check


def healthy_control(observation: dict) -> bool:
    """Positive control: the harness can observe HEALTHY when a feed really is fresh."""
    running = observation.get("runningServiceStatus") or {}
    return (
        observation.get("idea1", {}).get("status") == "HEALTHY"
        and running.get("idea1") == "UNKNOWN"
        and observation["exit"] == 0
        and _clean(observation)
    )


def mqtt_unavailable(observation: dict) -> bool:
    running = observation.get("runningServiceStatus") or {}
    return (
        not observation["exitedDuringStart"]
        and running.get("mqtt") == "UNAVAILABLE"
        and running.get("physicalEvidence") == "UNKNOWN"
        and observation["exit"] == 0
        and _clean(observation)
    )


@dataclass(frozen=True)
class Case:
    name: str
    category: str
    overrides: Callable[[Context], dict[str, str]]
    predicate: Callable[[dict], bool]
    probe: bool = False
    prepare: Callable[[Path], None] | None = None


def _feed(source: str, route: str) -> Callable[[Context], dict[str, str]]:
    def overrides(context: Context) -> dict[str, str]:
        return {
            f"AEGIS_{source}_STATUS_URL": f"{context.feed_url}{route}",
            f"AEGIS_{source}_INTEGRATION_TOKEN": context.feed_token,
        }

    return overrides


def _closed_feed(source: str) -> Callable[[Context], dict[str, str]]:
    def overrides(context: Context) -> dict[str, str]:
        return {
            f"AEGIS_{source}_STATUS_URL": f"http://127.0.0.1:{context.closed_port}/feed",
            f"AEGIS_{source}_INTEGRATION_TOKEN": context.feed_token,
        }

    return overrides


def _unusable_audit_database(root: Path) -> None:
    (root / "data" / "security-center-audit.sqlite3").mkdir(parents=True)


# liveProvider.js deliberately reports a malformed body as ADAPTER_RESPONSE_REJECTED.
CASES = (
    Case("positive-idea1-fresh-feed", "control", _feed("IDEA1", "/fresh"), healthy_control, probe=True),
    Case("missing-session-secret", "invalid-config", lambda _context: {"SESSION_SECRET": ""}, fails_closed),
    Case("malformed-production-port", "invalid-config", lambda _context: {"PORT": "80x3"}, rejected_before_start),
    Case(
        "live-core-without-actuation-config",
        "invalid-config",
        lambda _context: {"AEGIS_PROFILE": "production", "AEGIS_DRY_RUN": "0"},
        fails_closed,
    ),
    Case(
        "audit-db-path-unusable",
        "audit-failure",
        lambda _context: {},
        fails_closed,
        prepare=_unusable_audit_database,
    ),
    Case(
        "mqtt-unavailable-dry-run",
        "mqtt",
        lambda context: {"AEGIS_BROKER_IP": "127.0.0.1", "AEGIS_BROKER_PORT": str(context.closed_port)},
        mqtt_unavailable,
    ),
    Case("idea1-unavailable", "idea1", _closed_feed("IDEA1"), degrades("idea1", "ADAPTER_UNAVAILABLE"), probe=True),
    Case("idea2-unavailable", "idea2", _closed_feed("IDEA2"), degrades("idea2", "ADAPTER_UNAVAILABLE"), probe=True),
    Case(
        "idea1-stale-evidence",
        "stale-evidence",
        _feed("IDEA1", "/stale"),
        degrades("idea1", "ADAPTER_EVIDENCE_STALE"),
        probe=True,
    ),
    Case(
        "idea2-stale-evidence",
        "stale-evidence",
        _feed("IDEA2", "/stale"),
        degrades("idea2", "ADAPTER_EVIDENCE_STALE"),
        probe=True,
    ),
    Case(
        "idea1-malformed-evidence",
        "malformed-evidence",
        _feed("IDEA1", "/malformed"),
        degrades("idea1", "ADAPTER_RESPONSE_REJECTED"),
        probe=True,
    ),
    Case(
        "idea2-malformed-evidence",
        "malformed-evidence",
        _feed("IDEA2", "/malformed"),
        degrades("idea2", "ADAPTER_RESPONSE_REJECTED"),
        probe=True,
    ),
    Case(
        "idea2-schema-rejected",
        "malformed-evidence",
        _feed("IDEA2", "/wrong-schema"),
        degrades("idea2", "ADAPTER_RESPONSE_REJECTED"),
        probe=True,
    ),
)


def _listening(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def _stray_runtime_processes(proc_root: Path = ACCEPTANCE.PROC_ROOT) -> list[int]:
    """Find any python/node service, Core, or Web process still running from this source tree."""
    strays = []
    for entry in proc_root.iterdir():
        if not entry.name.isdigit() or int(entry.name) == os.getpid():
            continue
        try:
            arguments = [part.decode(errors="replace") for part in (entry / "cmdline").read_bytes().split(b"\0") if part]
            cwd = Path(os.readlink(entry / "cwd"))
            executable = Path(os.readlink(entry / "exe")).name
        except OSError:
            continue
        if (
            cwd == SOURCE_ROOT
            and executable.startswith(("python", "node"))
            and any(marker in arguments for marker in _RUNTIME_MARKERS)
        ):
            strays.append(int(entry.name))
    return sorted(strays)


def _service_status(root: Path) -> dict | None:
    document = ACCEPTANCE._read_service_status(root)
    if document is None:
        return None
    keys = ("status", "processHealth", "serviceReadiness", "components", "audit",
            "mqtt", "idea1", "idea2", "esp32", "physicalEvidence")
    return {key: document.get(key) for key in keys}


def _core_broker(root: Path) -> str | None:
    try:
        return json.loads((root / "runtime" / "status.json").read_text(encoding="utf-8")).get("broker")
    except (OSError, ValueError, AttributeError):
        return None


def _snapshot_probe(base_url: str, password: str) -> dict:
    cookie, csrf = ACCEPTANCE._login(base_url, password)
    status, _headers, snapshot = ACCEPTANCE._http_json(
        f"{base_url}/api/security/snapshot",
        headers=ACCEPTANCE._authenticated_headers(base_url, cookie),
    )
    integration = snapshot.get("integration", {})
    result = {
        "snapshotHttp": status,
        "idea1": {key: integration.get("idea1", {}).get(key) for key in ("status", "freshness")},
        "idea2": {key: integration.get("idea2", {}).get(key) for key in ("status", "freshness")},
        "operationalErrors": sorted({
            error.get("code") for error in snapshot.get("operationalErrors", []) if isinstance(error, dict)
        }),
        "incidents": len(snapshot.get("incidents", [])),
    }
    ACCEPTANCE._http_json(
        f"{base_url}/api/auth/logout",
        method="POST",
        headers=ACCEPTANCE._authenticated_headers(base_url, cookie, csrf),
    )
    return result


def run_case(case: Case, context: Context, data_root: Path) -> dict:
    root = ACCEPTANCE.validate_data_root(data_root / f"nc {case.name}", source_root=SOURCE_ROOT)
    web_port = ACCEPTANCE._free_port()
    control_port = ACCEPTANCE._free_port()
    while control_port == web_port:
        control_port = ACCEPTANCE._free_port()
    environment = ACCEPTANCE.build_environment(
        source_root=SOURCE_ROOT,
        data_root=root,
        node_executable=context.node,
        web_port=web_port,
        control_port=control_port,
        session_secret=context.session_secret,
        password_hash=context.password_hash,
    )
    environment.update(case.overrides(context))
    ACCEPTANCE._write_configuration(environment)
    if case.prepare is not None:
        case.prepare(root)

    base_url = f"http://localhost:{web_port}/security"
    observation: dict = {"case": case.name, "category": case.category}
    owned: dict[int, str] = {}
    started = time.monotonic()
    process = ACCEPTANCE._start_service(SOURCE_ROOT, environment)
    try:
        readiness = None
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline and process.poll() is None:
            owned.update(ACCEPTANCE._process_tree(process.pid))
            try:
                status, _headers, document = ACCEPTANCE._http_json(f"{base_url}/api/readiness")
                readiness = {"http": status, "body": document}
                if status in (200, 503):
                    break
            except (OSError, ValueError):
                pass
            time.sleep(0.2)
        if process.poll() is None:
            time.sleep(1.2)  # allow at least one running service-status write
            owned.update(ACCEPTANCE._process_tree(process.pid))
        observation["exitedDuringStart"] = process.poll() is not None
        observation["readiness"] = readiness
        if process.poll() is None:
            observation["runningServiceStatus"] = _service_status(root)
            observation["coreBroker"] = _core_broker(root)
            if case.probe:
                observation.update(_snapshot_probe(base_url, context.password))
    finally:
        ACCEPTANCE._stop_service(process, source_root=SOURCE_ROOT, environment=environment)
    observation["exit"] = process.returncode
    observation["seconds"] = round(time.monotonic() - started, 1)
    observation["finalServiceStatus"] = _service_status(root)
    observation["controlTokenResidue"] = (root / "runtime" / "control.token").exists()
    observation["processesObserved"] = len(owned)
    observation["survivingProcesses"] = sorted(set(ACCEPTANCE._surviving(owned)) | set(_stray_runtime_processes()))
    observation["webListenerAfter"] = _listening(web_port)
    try:
        ACCEPTANCE._assert_no_secret_leak(root, context.secret_values)
        observation["secretLeak"] = False
    except ACCEPTANCE.AcceptanceFailure:
        observation["secretLeak"] = True
    return observation


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        base = ACCEPTANCE.validate_data_root(arguments.data_root, source_root=SOURCE_ROOT)
        node_name = shutil.which("node")
        ACCEPTANCE._require(node_name is not None, "Node.js is unavailable")
        node = Path(node_name).resolve()
        ACCEPTANCE._require((SOURCE_ROOT / "web" / "dist" / "index.html").is_file(), "Web build missing")
        password = f"Aa1!{secrets.token_urlsafe(24)}"
        session_secret = f"Aa1!{secrets.token_urlsafe(48)}"
        feed_token = secrets.token_urlsafe(32)
        password_hash = ACCEPTANCE._hash_password(node, SOURCE_ROOT, password)
        feed = ThreadingHTTPServer(("127.0.0.1", 0), _feed_handler(feed_token))
    except (ACCEPTANCE.AcceptanceFailure, OSError, ValueError, subprocess.SubprocessError) as error:
        print(json.dumps({"result": "FAIL", "error": str(error)}, sort_keys=True))
        return 1

    threading.Thread(target=feed.serve_forever, name="negative-control-feed", daemon=True).start()
    context = Context(
        node=node,
        password=password,
        session_secret=session_secret,
        password_hash=password_hash,
        feed_token=feed_token,
        feed_url=f"http://127.0.0.1:{feed.server_address[1]}",
        closed_port=ACCEPTANCE._free_port(),
    )
    failures = 0
    try:
        for case in CASES:
            try:
                observation = run_case(case, context, base)
                observation["result"] = "PASS" if case.predicate(observation) else "FAIL"
            except (ACCEPTANCE.AcceptanceFailure, OSError, ValueError, subprocess.SubprocessError) as error:
                observation = {"case": case.name, "category": case.category, "result": "FAIL", "error": str(error)}
            failures += observation["result"] != "PASS"
            print(json.dumps(observation, sort_keys=True), flush=True)
    finally:
        feed.shutdown()
        feed.server_close()
    print(json.dumps({"result": "FAIL" if failures else "PASS", "cases": len(CASES), "failed": failures}, sort_keys=True))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
