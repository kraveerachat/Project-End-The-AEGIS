"""Runtime profiles, safe preflight checks, and persisted supervisor status."""

from __future__ import annotations

import ipaddress
import json
import os
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from enum import StrEnum
from pathlib import Path

from . import config


class RuntimeState(StrEnum):
    INIT = "INIT"
    PREFLIGHT = "PREFLIGHT"
    WAIT_BROKER = "WAIT_BROKER"
    WAIT_DEVICE = "WAIT_DEVICE"
    RUNNING = "RUNNING"
    DEGRADED = "DEGRADED"
    LOCKDOWN = "LOCKDOWN"
    FAILED = "FAILED"
    SHUTDOWN = "SHUTDOWN"


@dataclass(frozen=True)
class RuntimeSettings:
    profile: str
    dry_run: bool
    auto_contain: bool
    start_detector: bool
    start_gui: bool
    voice_enabled: bool
    health_interval: float
    broker_wait_sec: float
    device_wait_sec: float
    max_restarts: int
    restart_window_sec: float
    runtime_dir: Path
    log_dir: Path

    @classmethod
    def from_profile(
        cls,
        profile: str,
        *,
        dry_run: bool | None = None,
        auto_contain: bool | None = None,
        start_detector: bool | None = None,
        start_gui: bool | None = None,
        voice_enabled: bool | None = None,
    ) -> RuntimeSettings:
        if profile not in {"development", "lab", "production"}:
            raise ValueError(f"unsupported profile: {profile}")

        root = Path(__file__).resolve().parent.parent
        defaults = {
            "development": (True, False, False),
            "lab": (True, True, True),
            "production": (False, True, False),
        }
        default_dry, default_detector, default_gui = defaults[profile]

        return cls(
            profile=profile,
            dry_run=config._env_bool("AEGIS_DRY_RUN", default_dry) if dry_run is None else dry_run,
            auto_contain=(config.AUTO_CONTAIN if auto_contain is None else auto_contain),
            start_detector=(
                config._env_bool("AEGIS_START_DETECTOR", default_detector)
                if start_detector is None else start_detector
            ),
            start_gui=(
                config._env_bool("AEGIS_START_GUI", default_gui)
                if start_gui is None else start_gui
            ),
            voice_enabled=(
                config._env_bool("AEGIS_VOICE_ENABLE", False)
                if voice_enabled is None else voice_enabled
            ),
            health_interval=float(os.getenv("AEGIS_HEALTH_INTERVAL", "5")),
            broker_wait_sec=float(os.getenv("AEGIS_BROKER_WAIT_SEC", "30")),
            device_wait_sec=float(os.getenv("AEGIS_DEVICE_WAIT_SEC", str(config.DEVICE_OFFLINE_SEC))),
            max_restarts=int(os.getenv("AEGIS_MAX_RESTARTS", "5")),
            restart_window_sec=float(os.getenv("AEGIS_RESTART_WINDOW_SEC", "300")),
            runtime_dir=Path(os.getenv("AEGIS_RUNTIME_DIR", root / ".aegis-runtime")).resolve(),
            log_dir=Path(os.getenv("AEGIS_RUNTIME_LOG_DIR", root / "logs")).resolve(),
        )

    @property
    def status_path(self) -> Path:
        return self.runtime_dir / "status.json"

    @property
    def pid_path(self) -> Path:
        return self.runtime_dir / "supervisor.pid"

    @property
    def lock_path(self) -> Path:
        return self.runtime_dir / "supervisor.lock"

    def preflight(self) -> tuple[list[str], list[str]]:
        errors: list[str] = []
        warnings: list[str] = []

        minimum_python = (3, 10)
        if sys.version_info[:2] < minimum_python:
            errors.append("Python 3.10 or newer is required")
        if self.health_interval <= 0:
            errors.append("AEGIS_HEALTH_INTERVAL must be greater than zero")
        if self.broker_wait_sec < 0 or self.device_wait_sec < 0:
            errors.append("broker/device wait values cannot be negative")
        if self.max_restarts < 0 or self.restart_window_sec <= 0:
            errors.append("restart limits must be non-negative with a positive window")
        if not (1 <= config.PORT <= 65535):
            errors.append("MQTT broker port is outside 1-65535")
        try:
            ipaddress.ip_address(config.BROKER_IP)
        except ValueError:
            if config.BROKER_IP != "localhost":
                errors.append("MQTT broker address must be an IP address or localhost")
        if self.voice_enabled:
            errors.append("voice was requested but no voice runtime entry point exists")
        if self.start_gui and not os.getenv("DISPLAY"):
            errors.append("GUI was requested but DISPLAY is not set")
        if self.start_detector and not (Path(__file__).resolve().parent.parent / "detector.py").is_file():
            errors.append("detector.py is unavailable")

        if self.profile == "production":
            if not config.SECRET_KEY or config.SECRET_KEY == config.DEMO_SECRET:
                errors.append("production requires a non-demo HMAC secret")
            if not config.ADMIN_PIN_CONFIGURED or config.verify_pin(config.DEFAULT_ADMIN_PIN):
                errors.append("production requires a non-default Admin PIN")
            if config.BROKER_IP == "192.168.2.174":
                warnings.append("broker still uses the historical standalone default address")

        if self.dry_run:
            warnings.append("dry-run active: relay commands and heartbeats will not be published")
        if not self.auto_contain:
            warnings.append("auto-containment disabled: detector events are monitor-only")

        for path in (self.runtime_dir, self.log_dir, Path(config.DB_PATH).resolve().parent,
                     Path(config.LOG_PATH).resolve().parent):
            try:
                path.mkdir(parents=True, exist_ok=True)
                if not os.access(path, os.W_OK):
                    errors.append(f"path is not writable: {path}")
            except OSError as exc:
                errors.append(f"cannot prepare writable path {path}: {exc}")

        return errors, warnings


@dataclass
class RuntimeStatus:
    state: str = RuntimeState.INIT
    profile: str = "development"
    pid: int = field(default_factory=os.getpid)
    dry_run: bool = True
    auto_contain: bool = False
    broker: str = "UNKNOWN"
    device: str = "UNKNOWN"
    uplink: str = "UNKNOWN"
    armed: str = "MONITOR_ONLY"
    detail: str = "initializing"
    updated_at: float = field(default_factory=time.time)
    components: dict[str, str] = field(default_factory=dict)

    def write(self, path: Path) -> None:
        self.updated_at = time.time()
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(asdict(self), ensure_ascii=False, sort_keys=True, indent=2)
        fd, temporary_name = tempfile.mkstemp(prefix="status-", suffix=".tmp", dir=path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, path)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)


def read_status(path: Path) -> dict | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


SAFE_STATUS_SCHEMA_VERSION = 1

_CANONICAL_STATUS_BY_STATE = {
    RuntimeState.RUNNING: "HEALTHY",
    RuntimeState.DEGRADED: "DEGRADED",
    RuntimeState.LOCKDOWN: "DEGRADED",
    RuntimeState.FAILED: "FAILED",
    RuntimeState.SHUTDOWN: "FAILED",
    RuntimeState.INIT: "UNKNOWN",
    RuntimeState.PREFLIGHT: "UNKNOWN",
    RuntimeState.WAIT_BROKER: "UNKNOWN",
    RuntimeState.WAIT_DEVICE: "UNKNOWN",
}

_ALLOWED_COMPONENTS = ("detector", "gui", "preflight")
_ALLOWED_COMPONENT_STATES = frozenset({"RUNNING", "RESTARTING", "FAILED", "STOPPED"})
_ALLOWED_BROKER_STATES = frozenset({"CONNECTED", "DISCONNECTED", "UNKNOWN"})
_ALLOWED_DEVICE_STATES = frozenset({"ONLINE", "OFFLINE", "UNKNOWN"})
_ALLOWED_UPLINK_STATES = frozenset({"NORMAL", "LOCKDOWN", "UNKNOWN"})
_ALLOWED_ARMED_STATES = frozenset({"ARMED", "DISARMED", "MONITOR_ONLY"})
_ALLOWED_PROFILES = frozenset({"development", "lab", "production"})


def _allowlisted(value: object, allowed: frozenset[str]) -> str:
    return value if isinstance(value, str) and value in allowed else "UNKNOWN"


def _iso_utc(updated_at: object) -> str | None:
    if isinstance(updated_at, bool) or not isinstance(updated_at, (int, float)):
        return None
    try:
        moment = time.gmtime(float(updated_at))
    except (OSError, OverflowError, ValueError):
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", moment) + ".000Z"


def _absent_projection() -> dict:
    return {
        "schemaVersion": SAFE_STATUS_SCHEMA_VERSION,
        "generatedAt": None,
        "status": "UNKNOWN",
        "components": {},
        "modes": {"profile": "UNKNOWN", "dryRun": True, "autoContain": False, "armed": "UNKNOWN"},
        "issues": [],
        "evidenceSource": "RUNTIME_STATUS_ABSENT",
    }


def safe_status_projection(status: RuntimeStatus | dict | None) -> dict:
    """Project runtime status into the versioned contract IDEA3 Web may consume.

    Only allowlisted state vocabulary crosses this boundary. Free-text ``detail``,
    ``pid``, paths, addresses, and every configuration or secret value are dropped
    rather than sanitized, so an unrecognized field can never leak by default.
    """
    if isinstance(status, RuntimeStatus):
        document = asdict(status)
    elif isinstance(status, dict):
        document = status
    else:
        return _absent_projection()

    generated_at = _iso_utc(document.get("updated_at"))
    if generated_at is None:
        return _absent_projection()

    raw_components = document.get("components")
    components = {
        "broker": _allowlisted(document.get("broker"), _ALLOWED_BROKER_STATES),
        "device": _allowlisted(document.get("device"), _ALLOWED_DEVICE_STATES),
        "uplink": _allowlisted(document.get("uplink"), _ALLOWED_UPLINK_STATES),
    }
    if isinstance(raw_components, dict):
        for name in _ALLOWED_COMPONENTS:
            if name in raw_components:
                components[name] = _allowlisted(raw_components[name], _ALLOWED_COMPONENT_STATES)

    state = document.get("state")
    status_value = _CANONICAL_STATUS_BY_STATE.get(state, "UNKNOWN") if isinstance(state, str) else "UNKNOWN"

    issues = set()
    if components["broker"] != "CONNECTED":
        issues.add("MQTT_DISCONNECTED")
    if components["device"] != "ONLINE":
        issues.add("ESP32_UNAVAILABLE")
    if any(components.get(name) == "FAILED" for name in _ALLOWED_COMPONENTS):
        issues.add("COMPONENT_FAILURE")
    if status_value == "FAILED":
        issues.add("CORE_PROCESS_FAILURE")

    profile = document.get("profile")
    return {
        "schemaVersion": SAFE_STATUS_SCHEMA_VERSION,
        "generatedAt": generated_at,
        "status": status_value,
        "components": components,
        "modes": {
            "profile": profile if profile in _ALLOWED_PROFILES else "UNKNOWN",
            "dryRun": bool(document.get("dry_run", True)),
            "autoContain": bool(document.get("auto_contain", False)),
            "armed": _allowlisted(document.get("armed"), _ALLOWED_ARMED_STATES),
        },
        "issues": sorted(issues),
        "evidenceSource": "RUNTIME_STATUS_FILE",
    }
