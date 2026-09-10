"""Composite Linux/server owner for the IDEA3 Core and Web processes."""

from __future__ import annotations

import ipaddress
import os
import shutil
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from .paths import RuntimePaths, application_root


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
