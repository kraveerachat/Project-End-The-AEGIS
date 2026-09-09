"""Windows standalone launcher boundaries and process orchestration."""

from __future__ import annotations

import hmac
import ipaddress
import json
import os
import re
import secrets
import subprocess
import sys
import tempfile
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from .paths import RuntimePaths, load_dotenv
from .platform_lock import AlreadyRunningError, ExclusiveFileLock


@dataclass(frozen=True)
class LauncherSettings:
    """Validated immutable payload and external runtime settings."""

    application_root: Path
    paths: RuntimePaths
    profile: str
    dry_run: bool
    web_port: int
    control_port: int
    bind_host: str
    open_browser: bool

    @property
    def node_executable(self) -> Path:
        return self.application_root / "node" / "node.exe"

    @property
    def web_entrypoint(self) -> Path:
        return self.application_root / "server" / "index.js"

    @property
    def static_dir(self) -> Path:
        return self.application_root / "web"

    def validate(self) -> None:
        try:
            loopback = ipaddress.ip_address(self.bind_host).is_loopback
        except ValueError:
            loopback = False
        if not loopback:
            raise ValueError("launcher services require a loopback bind address")
        if not 1 <= self.web_port <= 65535 or not 0 <= self.control_port <= 65535:
            raise ValueError("launcher ports must be inside 1-65535; test control port may be zero")
        if self.web_port == self.control_port:
            raise ValueError("Web and control ports must be distinct")
        if self.profile not in {"development", "lab", "production"}:
            raise ValueError("unsupported launcher profile")
        if not self.node_executable.is_file():
            raise ValueError("bundled Node runtime is unavailable")
        if not self.web_entrypoint.is_file():
            raise ValueError("bundled Web entrypoint is unavailable")
        if not (self.static_dir / "index.html").is_file():
            raise ValueError("bundled Web static assets are unavailable")

    def child_environment(
        self,
        base_environment: Mapping[str, str],
        *,
        core_status_url: str,
    ) -> dict[str, str]:
        environment = dict(base_environment)
        environment.pop("AEGIS_CONTROL_TOKEN", None)
        environment.update({
            "NODE_ENV": "production",
            "PORT": str(self.web_port),
            "AEGIS_DATA_DIR": str(self.paths.root),
            "AEGIS_CONFIG_FILE": str(self.paths.config_file),
            "AEGIS_DB_PATH": str(self.paths.core_db),
            "AEGIS_LOG_PATH": str(self.paths.log_dir / "aegis_soc.log"),
            "AEGIS_IDEA3_AUDIT_DB_PATH": str(self.paths.web_db),
            "AEGIS_RUNTIME_DIR": str(self.paths.runtime_dir),
            "AEGIS_RUNTIME_LOG_DIR": str(self.paths.log_dir),
            "AEGIS_WEB_BASE_PATH": "/security",
            "AEGIS_WEB_STATIC_DIR": str(self.static_dir),
            "AEGIS_BIND_HOST": self.bind_host,
            "AEGIS_IDEA3_RUNTIME_STATUS_URL": core_status_url,
        })
        return environment

    def core_command(self, *, frozen: bool | None = None) -> list[str]:
        frozen_runtime = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
        command = [sys.executable, "core"] if frozen_runtime else [
            sys.executable,
            "-m",
            "aegis_soc.supervisor",
        ]
        command.extend([
            "--profile",
            self.profile,
            "--dry-run" if self.dry_run else "--live",
            "--headless",
            "--no-detector",
            "--no-voice",
        ])
        return command

    def web_command(self) -> list[str]:
        return [str(self.node_executable), str(self.web_entrypoint)]


class ControlServer:
    """Loopback-only safe status and authenticated stop boundary."""

    def __init__(
        self,
        *,
        host: str,
        port: int,
        token: str,
        core_status: Callable[[], dict],
        launcher_status: Callable[[], dict],
        request_stop: Callable[[], None],
    ) -> None:
        if not token:
            raise ValueError("control token is required")
        self.host = host
        self.port = port
        self.token = token
        self.core_status = core_status
        self.launcher_status = launcher_status
        self.request_stop = request_stop
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        if self._server is None:
            raise RuntimeError("control server is not running")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def _handler(self):
        boundary = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format, *_args):
                return

            def _respond(self, status, payload):
                body = json.dumps(payload, sort_keys=True).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _loopback(self):
                try:
                    return ipaddress.ip_address(self.client_address[0]).is_loopback
                except ValueError:
                    return False

            def do_GET(self):
                if not self._loopback():
                    self._respond(403, {"error": {"code": "CONTROL_DENIED"}})
                    return
                route = urlsplit(self.path).path
                if route == "/v1/core-status":
                    self._respond(200, boundary.core_status())
                elif route == "/v1/launcher-status":
                    self._respond(200, boundary.launcher_status())
                else:
                    self._respond(404, {"error": {"code": "NOT_FOUND"}})

            def do_POST(self):
                if not self._loopback():
                    self._respond(403, {"error": {"code": "CONTROL_DENIED"}})
                    return
                if urlsplit(self.path).path != "/v1/stop":
                    self._respond(404, {"error": {"code": "NOT_FOUND"}})
                    return
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    content_length = 1
                if content_length != 0:
                    self._respond(413, {"error": {"code": "BODY_NOT_ALLOWED"}})
                    return
                supplied = self.headers.get("X-AEGIS-Control-Token", "")
                if not hmac.compare_digest(supplied, boundary.token):
                    self._respond(403, {"error": {"code": "CONTROL_DENIED"}})
                    return
                boundary.request_stop()
                self._respond(202, {"accepted": True})

        return Handler

    def start(self) -> None:
        if self._server is not None:
            raise RuntimeError("control server is already running")
        self._server = ThreadingHTTPServer((self.host, self.port), self._handler())
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="aegis-control-server",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        server = self._server
        thread = self._thread
        if server is None:
            return
        self._server = None
        self._thread = None
        server.shutdown()
        server.server_close()
        if thread is not None:
            thread.join(timeout=2)


class LauncherRuntime:
    """Own the known Core and Web child processes without physical actions."""

    def __init__(
        self,
        settings: LauncherSettings,
        *,
        popen_factory=subprocess.Popen,
        control_server_factory=ControlServer,
        token_factory=lambda: secrets.token_urlsafe(48),
    ) -> None:
        self.settings = settings
        self.popen_factory = popen_factory
        self.control_server_factory = control_server_factory
        self.token_factory = token_factory
        self.children: dict[str, subprocess.Popen] = {}
        self.stop_event = threading.Event()
        self._output_handle = None

    def snapshot(self) -> dict:
        components = {
            name: "RUNNING" if process.poll() is None else "FAILED"
            for name, process in sorted(self.children.items())
        }
        status = "RUNNING" if components and all(
            state == "RUNNING" for state in components.values()
        ) else "DEGRADED"
        return {
            "schemaVersion": 1,
            "status": status,
            "profile": self.settings.profile,
            "dryRun": self.settings.dry_run,
            "components": components,
        }

    def shutdown_children(self, *, timeout: float) -> None:
        for name in ("web", "core"):
            process = self.children.get(name)
            if process is None or process.poll() is not None:
                continue
            process.terminate()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=timeout)

    def request_stop(self) -> None:
        self.stop_event.set()

    def _core_status(self) -> dict:
        from .runtime import read_status, safe_status_projection

        return safe_status_projection(read_status(self.settings.paths.runtime_dir / "status.json"))

    @staticmethod
    def _atomic_write(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f"{path.name}-",
            suffix=".tmp",
            dir=path.parent,
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)

    def _write_status(self, status: str | None = None) -> None:
        document = self.snapshot()
        if status is not None:
            document["status"] = status
            if status == "STOPPED":
                document["components"] = {"core": "STOPPED", "web": "STOPPED"}
        self._atomic_write(
            self.settings.paths.runtime_dir / "launcher-status.json",
            json.dumps(document, indent=2, sort_keys=True) + "\n",
        )

    def _start_children(self, control_url: str) -> None:
        environment = dict(os.environ)
        load_dotenv(self.settings.paths.config_file, environment)
        environment = self.settings.child_environment(
            environment,
            core_status_url=f"{control_url}/v1/core-status",
        )
        self.settings.paths.log_dir.mkdir(parents=True, exist_ok=True)
        self._output_handle = (self.settings.paths.log_dir / "aegis-components.log").open(
            "a",
            encoding="utf-8",
        )
        process_options = {
            "cwd": self.settings.application_root,
            "env": environment,
            "stdin": subprocess.DEVNULL,
            "stdout": self._output_handle,
            "stderr": subprocess.STDOUT,
        }
        self.children["core"] = self.popen_factory(
            self.settings.core_command(),
            **process_options,
        )
        self.children["web"] = self.popen_factory(
            self.settings.web_command(),
            **process_options,
        )

    def run(self) -> int:
        control_server = None
        token_path = self.settings.paths.runtime_dir / "control.token"
        lock = ExclusiveFileLock(
            self.settings.paths.runtime_dir / "launcher.lock",
            f"pid={os.getpid()}",
        )
        result = 0
        try:
            self.settings.validate()
            for directory in (
                self.settings.paths.root,
                self.settings.paths.runtime_dir,
                self.settings.paths.log_dir,
                self.settings.paths.core_db.parent,
                self.settings.paths.web_db.parent,
            ):
                directory.mkdir(parents=True, exist_ok=True)
            lock.acquire()
            token = self.token_factory()
            self._atomic_write(token_path, f"{token}\n")
            try:
                token_path.chmod(0o600)
            except OSError:
                pass
            control_server = self.control_server_factory(
                host=self.settings.bind_host,
                port=self.settings.control_port,
                token=token,
                core_status=self._core_status,
                launcher_status=self.snapshot,
                request_stop=self.request_stop,
            )
            control_server.start()
            self._start_children(control_server.base_url)
            self._write_status()
            while not self.stop_event.wait(0.5):
                self._write_status()
        except AlreadyRunningError:
            result = 2
        except Exception:
            result = 1
        finally:
            self.shutdown_children(timeout=15)
            if self._output_handle is not None:
                self._output_handle.close()
                self._output_handle = None
            if control_server is not None:
                control_server.close()
            try:
                token_path.unlink()
            except FileNotFoundError:
                pass
            lock.release()
            try:
                self._write_status("STOPPED")
            except OSError:
                result = 1
        return result


_UNSAFE_VALUE = re.compile(r"[\r\n\x00]")
_ADMIN_USERNAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def _atomic_write_file(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically, leaving no temporary residue."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f"{path.name}-",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def write_configuration(
    settings: LauncherSettings,
    *,
    username: str,
    password: str,
    password_hasher: Callable[[str], str],
    secret_factory: Callable[[], str] = lambda: secrets.token_urlsafe(48),
    force: bool = False,
) -> Path:
    """Provision the external ``.env`` for a standalone install.

    The operator password is only ever handed to ``password_hasher``; neither it
    nor the generated session secret is returned, logged, or placed in a command
    argument. Optional integration and MQTT values are written blank so an
    unconfigured install fails closed instead of inheriting a bundled credential.
    """
    config_path = settings.paths.config_file
    if config_path.exists() and not force:
        raise FileExistsError(f"configuration already exists: {config_path}")
    if not _ADMIN_USERNAME.match(username or ""):
        raise ValueError("admin username must be 1-64 characters of A-Z a-z 0-9 . _ -")
    if not password:
        raise ValueError("an admin password is required")

    password_hash = password_hasher(password)
    session_secret = secret_factory()
    for label, value in (("password hash", password_hash), ("session secret", session_secret)):
        if not value or _UNSAFE_VALUE.search(value):
            raise ValueError(f"generated {label} is not a single safe line")

    lines = [
        "# AEGIS IDEA3 standalone runtime configuration.",
        "# Generated by the launcher; never commit this file or copy it between installs.",
        "NODE_ENV=production",
        f"PORT={settings.web_port}",
        f"AEGIS_PROFILE={settings.profile}",
        f"AEGIS_DRY_RUN={'1' if settings.dry_run else '0'}",
        "",
        f"SESSION_SECRET={session_secret}",
        f"AEGIS_IDEA3_ADMIN_USER={username}",
        f"AEGIS_IDEA3_ADMIN_PASSWORD_HASH={password_hash}",
        "AEGIS_ALLOW_DEV_LOGIN=false",
        "AEGIS_DEMO_ALLOWED=false",
        "",
        f"AEGIS_IDEA3_AUDIT_DB_PATH={settings.paths.web_db}",
        f"AEGIS_DB_PATH={settings.paths.core_db}",
        f"AEGIS_LOG_PATH={settings.paths.log_dir / 'aegis_soc.log'}",
        f"AEGIS_WEB_STATIC_DIR={settings.static_dir}",
        "AEGIS_WEB_BASE_PATH=/security",
        f"AEGIS_BIND_HOST={settings.bind_host}",
        "",
        "# Optional upstream integration; blank means NOT_CONFIGURED and fail-closed.",
        "AEGIS_IDEA1_STATUS_URL=",
        "AEGIS_IDEA2_STATUS_URL=",
        "AEGIS_IDEA3_RUNTIME_STATUS_URL=",
        "AEGIS_IDEA1_INTEGRATION_TOKEN=",
        "AEGIS_IDEA2_INTEGRATION_TOKEN=",
        "",
        "# Optional broker credentials; blank means no MQTT actuation path is configured.",
        "AEGIS_BROKER_IP=",
        "AEGIS_BROKER_PORT=",
        "AEGIS_MQTT_USER=",
        "AEGIS_MQTT_PASS=",
        "AEGIS_HMAC_SECRET=",
    ]
    _atomic_write_file(config_path, "\n".join(lines) + "\n")
    return config_path


_HEALTHY_STATUS = "RUNNING"
_LOG_TAIL_LIMIT = 2000


def _security_url(settings: LauncherSettings) -> str:
    return f"http://localhost:{settings.web_port}/security"


def _read_launcher_status(settings: LauncherSettings) -> dict | None:
    path = settings.paths.runtime_dir / "launcher-status.json"
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return document if isinstance(document, dict) else None


def status_command(settings: LauncherSettings, *, output=sys.stdout) -> int:
    """Report launcher status. Any non-RUNNING state returns a non-zero code."""
    document = _read_launcher_status(settings)
    if document is None:
        output.write("status: NOT_RUNNING\n")
        return 1

    status = document.get("status")
    status = status if isinstance(status, str) and status else "UNKNOWN"
    components = document.get("components")
    output.write(f"status: {status}\n")
    if isinstance(components, dict):
        for name, state in sorted(components.items()):
            output.write(f"  {name}: {state}\n")
    return 0 if status == _HEALTHY_STATUS else 1


def start_command(settings: LauncherSettings, *, runtime_factory=LauncherRuntime) -> int:
    """Run the launcher: Core then Web, owned by :class:`LauncherRuntime`.

    This blocks until the authenticated control boundary requests a stop, which
    is why the operator starts it as its own process.
    """
    return runtime_factory(settings).run()


def stop_command(
    settings: LauncherSettings,
    *,
    output=sys.stdout,
    post: Callable[[str, dict[str, str]], int],
) -> int:
    """Ask the running launcher to stop through its own control boundary.

    The stop travels over loopback with the runtime-issued control token; no
    process is signalled or killed from here, and the token is never printed.
    """
    try:
        token = (settings.paths.runtime_dir / "control.token").read_text(encoding="utf-8").strip()
    except OSError:
        output.write("stop: NOT_RUNNING\n")
        return 1
    if not token:
        output.write("stop: NO_CONTROL_TOKEN\n")
        return 1

    status = post(
        f"http://{settings.bind_host}:{settings.control_port}/v1/stop",
        {"X-AEGIS-Control-Token": token},
    )
    if status == 202:
        output.write("stop: ACCEPTED\n")
        return 0
    output.write(f"stop: REFUSED ({status})\n")
    return 1


def open_command(
    settings: LauncherSettings,
    *,
    output=sys.stdout,
    health_check: Callable[[str], bool],
    browser_open: Callable[[str], object] | None = None,
) -> int:
    """Open the Security Center only after Web health actually succeeds."""
    url = _security_url(settings)
    if not health_check(url):
        output.write("open: WEB_NOT_HEALTHY\n")
        return 1

    if browser_open is None:
        import webbrowser

        browser_open = webbrowser.open
    browser_open(url)
    output.write(f"open: {url}\n")
    return 0


def logs_command(settings: LauncherSettings, *, output=sys.stdout, lines: int = 200) -> int:
    """Tail the external Core log without reading outside the log directory."""
    log_path = settings.paths.log_dir / "aegis_soc.log"
    try:
        with log_path.open("r", encoding="utf-8", errors="replace") as handle:
            tail = list(handle)[-max(1, min(lines, _LOG_TAIL_LIMIT)):]
    except OSError:
        output.write(f"logs: NO_LOGS ({settings.paths.log_dir})\n")
        return 1

    for line in tail:
        output.write(line if line.endswith("\n") else f"{line}\n")
    return 0


def doctor_command(
    settings: LauncherSettings,
    *,
    output=sys.stdout,
    port_probe: Callable[[str, int], bool] | None = None,
) -> int:
    """Validate configuration, payload, writable paths, and ports.

    This performs no broker, device, or relay contact of any kind, and never
    echoes a configuration value: only presence and OK/MISSING codes are printed.
    """
    checks: list[tuple[str, bool, str]] = []

    checks.append(("config", settings.paths.config_file.is_file(), str(settings.paths.config_file)))

    payload_present = all((
        settings.web_entrypoint.is_file(),
        settings.node_executable.is_file(),
        settings.static_dir.is_dir(),
    ))
    checks.append(("payload", payload_present, str(settings.application_root)))

    writable = True
    for directory in (settings.paths.runtime_dir, settings.paths.log_dir):
        try:
            directory.mkdir(parents=True, exist_ok=True)
            writable = writable and os.access(directory, os.W_OK)
        except OSError:
            writable = False
    checks.append(("writable", writable, str(settings.paths.root)))

    if port_probe is not None:
        checks.append(("ports", port_probe(settings.bind_host, settings.web_port), f"{settings.bind_host}:{settings.web_port}"))

    checks.append(("platform", sys.platform.startswith(("win32", "linux", "darwin")), sys.platform))

    for name, ok, detail in checks:
        output.write(f"{name}: {'OK' if ok else 'MISSING'} ({detail})\n")
    return 0 if all(ok for _name, ok, _detail in checks) else 1
