"""Composite Linux/server owner for the IDEA3 Core and Web processes."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .paths import RuntimePaths, application_root, load_dotenv
from .windows_launcher import LauncherRuntime, doctor_command, stop_command


def _absolute_path(name: str, value: str | None, *, required: bool = True) -> Path | None:
    raw = (value or "").strip()
    if not raw:
        if required:
            raise ValueError(f"{name} must be set to an absolute path")
        return None
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{name} must be an absolute path")
    return path.resolve()


def _port(name: str, value: str | None, fallback: int) -> int:
    raw = str(fallback) if value is None else value.strip()
    if not raw.isascii() or not raw.isdecimal():
        raise ValueError(f"{name} must be an integer from 1 to 65535")
    parsed = int(raw)
    if not 1 <= parsed <= 65535:
        raise ValueError(f"{name} must be an integer from 1 to 65535")
    return parsed


def _boolean(name: str, value: str | None, fallback: bool) -> bool:
    if value is None:
        return fallback
    if value == "1":
        return True
    if value == "0":
        return False
    raise ValueError(f"{name} must be 0 or 1")


@dataclass(frozen=True)
class ProductionSettings:
    """Validated immutable payload and external data settings for a server."""

    application_root: Path
    paths: RuntimePaths
    node_executable: Path
    web_entrypoint: Path
    static_dir: Path
    profile: str
    dry_run: bool
    web_port: int
    control_port: int
    bind_host: str
    mqtt_configured: bool = False
    idea1_configured: bool = False
    idea2_configured: bool = False

    @classmethod
    def from_environment(
        cls,
        env: Mapping[str, str] | None = None,
    ) -> ProductionSettings:
        values = os.environ if env is None else env
        app_root = _absolute_path(
            "AEGIS_APPLICATION_ROOT",
            values.get("AEGIS_APPLICATION_ROOT") or str(application_root()),
        )
        data_root = _absolute_path("AEGIS_DATA_DIR", values.get("AEGIS_DATA_DIR"))
        assert app_root is not None and data_root is not None

        config_file = _absolute_path(
            "AEGIS_CONFIG_FILE",
            values.get("AEGIS_CONFIG_FILE") or str(data_root / "config" / ".env"),
        )
        detected_node = shutil.which("node")
        node_executable = _absolute_path(
            "AEGIS_NODE_EXECUTABLE",
            values.get("AEGIS_NODE_EXECUTABLE") or detected_node,
        )
        web_entrypoint = _absolute_path(
            "AEGIS_WEB_ENTRYPOINT",
            values.get("AEGIS_WEB_ENTRYPOINT")
            or str(app_root / "web" / "server" / "index.js"),
        )
        static_dir = _absolute_path(
            "AEGIS_WEB_STATIC_DIR",
            values.get("AEGIS_WEB_STATIC_DIR") or str(app_root / "web" / "dist"),
        )
        assert config_file is not None
        assert node_executable is not None
        assert web_entrypoint is not None
        assert static_dir is not None

        paths = RuntimePaths(
            root=data_root,
            config_file=config_file,
            core_db=data_root / "data" / "core-audit.sqlite3",
            web_db=data_root / "data" / "security-center-audit.sqlite3",
            runtime_dir=data_root / "runtime",
            log_dir=data_root / "logs",
        )
        configured_values = dict(values)
        load_dotenv(config_file, configured_values)
        return cls(
            application_root=app_root,
            paths=paths,
            node_executable=node_executable,
            web_entrypoint=web_entrypoint,
            static_dir=static_dir,
            profile=values.get("AEGIS_PROFILE", "production"),
            dry_run=_boolean("AEGIS_DRY_RUN", values.get("AEGIS_DRY_RUN"), False),
            web_port=_port("PORT", values.get("PORT"), 8003),
            control_port=_port(
                "AEGIS_CONTROL_PORT", values.get("AEGIS_CONTROL_PORT"), 8103
            ),
            bind_host=values.get("AEGIS_BIND_HOST", "127.0.0.1"),
            mqtt_configured=bool(configured_values.get("AEGIS_BROKER_IP", "").strip()),
            idea1_configured=bool(
                configured_values.get("AEGIS_IDEA1_STATUS_URL", "").strip()
            ),
            idea2_configured=bool(
                configured_values.get("AEGIS_IDEA2_STATUS_URL", "").strip()
            ),
        )

    def validate(self) -> None:
        try:
            loopback = ipaddress.ip_address(self.bind_host).is_loopback
        except ValueError:
            loopback = False
        if not loopback:
            raise ValueError("production services require a loopback bind address")
        if self.web_port == self.control_port:
            raise ValueError("Web and control ports must be distinct")
        if self.profile not in {"development", "lab", "production"}:
            raise ValueError("unsupported production runtime profile")
        if self.paths.root == self.application_root or self.paths.root.is_relative_to(
            self.application_root
        ):
            raise ValueError("AEGIS_DATA_DIR must be outside the application root")
        if not self.paths.config_file.is_file():
            raise ValueError("production configuration file is unavailable")
        if not self.node_executable.is_file():
            raise ValueError("Node executable is unavailable")
        if not self.web_entrypoint.is_file():
            raise ValueError("Web entrypoint is unavailable")
        if not (self.static_dir / "index.html").is_file():
            raise ValueError("Web static assets are unavailable")

    def child_environment(
        self,
        base_environment: Mapping[str, str],
        *,
        core_status_url: str,
    ) -> dict[str, str]:
        environment = dict(base_environment)
        environment.pop("AEGIS_CONTROL_TOKEN", None)
        environment.update(
            {
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
            }
        )
        return environment

    def core_command(self) -> list[str]:
        return [
            sys.executable,
            "-m",
            "aegis_soc.supervisor",
            "--profile",
            self.profile,
            "--dry-run" if self.dry_run else "--live",
            "--headless",
            "--no-detector",
            "--no-voice",
        ]

    def web_command(self) -> list[str]:
        return [str(self.node_executable), str(self.web_entrypoint)]


def _read_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=2) as response:
        if response.status != 200:
            raise OSError(f"readiness returned HTTP {response.status}")
        document = json.loads(response.read())
    if not isinstance(document, dict):
        raise TypeError("readiness response must be an object")
    return document


class ProductionRuntime(LauncherRuntime):
    """Own Core plus Web and report readiness without overstating physical truth."""

    def __init__(
        self,
        settings: ProductionSettings,
        *,
        readiness_probe=_read_json,
        core_status_reader=None,
        **launcher_dependencies,
    ) -> None:
        super().__init__(settings, **launcher_dependencies)
        self.readiness_probe = readiness_probe
        self.core_status_reader = core_status_reader

    def _core_status(self) -> dict:
        if self.core_status_reader is not None:
            return self.core_status_reader()
        return super()._core_status()

    def snapshot(self) -> dict:
        process_snapshot = super().snapshot()
        components = process_snapshot["components"]
        process_health = (
            "HEALTHY"
            if components == {"core": "RUNNING", "web": "RUNNING"}
            else "DEGRADED"
        )
        readiness = {"status": "DEGRADED", "audit": "DEGRADED"}
        try:
            candidate = self.readiness_probe(
                f"http://localhost:{self.settings.web_port}/security/api/readiness"
            )
            if (
                candidate.get("status") == "READY"
                and candidate.get("audit") == "READY"
                and candidate.get("schemaVersion") == 2
            ):
                readiness = candidate
        except (OSError, TypeError, ValueError, urllib.error.URLError):
            pass

        core_status = self._core_status()
        core_components = core_status.get("components", {})
        broker = core_components.get("broker")
        mqtt = "NOT_CONFIGURED"
        if self.settings.mqtt_configured:
            mqtt = "CONNECTED" if broker == "CONNECTED" else "UNAVAILABLE"
        device = core_components.get("device")
        esp32 = device if device in {"ONLINE", "OFFLINE"} else "UNKNOWN"
        service_readiness = (
            "READY"
            if process_health == "HEALTHY" and readiness["status"] == "READY"
            else "DEGRADED"
        )
        return {
            "schemaVersion": 1,
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "status": service_readiness,
            "profile": self.settings.profile,
            "dryRun": self.settings.dry_run,
            "components": components,
            "processHealth": process_health,
            "serviceReadiness": service_readiness,
            "audit": readiness["audit"],
            "mqtt": mqtt,
            "idea1": "UNAVAILABLE"
            if self.settings.idea1_configured
            else "NOT_CONFIGURED",
            "idea2": "UNAVAILABLE"
            if self.settings.idea2_configured
            else "NOT_CONFIGURED",
            "esp32": esp32,
            "physicalEvidence": "UNKNOWN",
        }

    def _write_status(self, status: str | None = None) -> None:
        document = self.snapshot()
        if status is not None:
            document["status"] = status
            document["serviceReadiness"] = status
            if status in {"STOPPED", "FAILED"}:
                document["processHealth"] = status
        self._atomic_write(
            self.settings.paths.runtime_dir / "service-status.json",
            json.dumps(document, indent=2, sort_keys=True) + "\n",
        )


def _read_service_status(settings: ProductionSettings) -> dict | None:
    try:
        document = json.loads(
            (settings.paths.runtime_dir / "service-status.json").read_text(
                encoding="utf-8"
            )
        )
    except (OSError, ValueError):
        return None
    return document if isinstance(document, dict) else None


def production_status_command(
    settings: ProductionSettings,
    *,
    output=sys.stdout,
) -> int:
    """Print only safe service state dimensions."""
    document = _read_service_status(settings)
    if document is None:
        output.write("status: NOT_RUNNING\n")
        return 1

    status = document.get("status", "UNKNOWN")
    output.write(f"status: {status}\n")
    for name in (
        "processHealth",
        "serviceReadiness",
        "audit",
        "mqtt",
        "idea1",
        "idea2",
        "esp32",
        "physicalEvidence",
    ):
        value = document.get(name)
        if isinstance(value, str):
            output.write(f"{name}: {value}\n")
    return 0 if status == "READY" else 1


def production_stop_command(
    settings: ProductionSettings,
    *,
    output=sys.stdout,
    post: Callable[[str, dict[str, str]], int],
) -> int:
    """Stop idempotently through the token-protected loopback boundary."""
    if not (settings.paths.runtime_dir / "control.token").exists():
        output.write("stop: NOT_RUNNING\n")
        return 0
    return stop_command(settings, output=output, post=post)


def restart_command(
    settings: ProductionSettings,
    *,
    runtime_factory=ProductionRuntime,
    post: Callable[[str, dict[str, str]], int],
    output=sys.stdout,
    monotonic=time.monotonic,
    sleep=time.sleep,
    timeout: float = 15,
) -> int:
    """Stop, observe the old control boundary leave, then start once."""
    if production_stop_command(settings, output=output, post=post) != 0:
        return 1

    token_path = settings.paths.runtime_dir / "control.token"
    deadline = monotonic() + timeout
    while token_path.exists() and monotonic() < deadline:
        sleep(0.1)
    if token_path.exists():
        output.write("restart: STOP_TIMEOUT\n")
        return 1
    return runtime_factory(settings).run()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aegis-idea3-service",
        description="Own the IDEA3 Core and Web production processes",
    )
    parser.add_argument(
        "command",
        choices=["start", "stop", "restart", "status", "doctor"],
    )
    return parser


def _post(url: str, headers: dict[str, str]) -> int:
    request = urllib.request.Request(url, method="POST", data=b"", headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, OSError):
        return 0


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        settings = ProductionSettings.from_environment()
        settings.validate()
    except ValueError as error:
        print(f"production-runtime: INVALID_SETTINGS ({error})")
        return 2

    if arguments.command == "start":
        return ProductionRuntime(settings).run()
    if arguments.command == "stop":
        return production_stop_command(settings, post=_post)
    if arguments.command == "restart":
        return restart_command(settings, post=_post)
    if arguments.command == "status":
        return production_status_command(settings)
    if arguments.command == "doctor":
        return doctor_command(settings)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
