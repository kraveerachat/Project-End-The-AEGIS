"""Application and writable-data path discovery for source and frozen runtimes."""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass
from pathlib import Path

_ENVIRONMENT_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def application_root(*, frozen: bool | None = None) -> Path:
    """Return the immutable payload root without depending on the current directory."""
    is_frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if is_frozen:
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


def data_root(
    *,
    env: Mapping[str, str] | None = None,
    platform: str | None = None,
) -> Path:
    """Resolve the external writable root and reject ambiguous relative overrides."""
    values = os.environ if env is None else env
    platform_name = sys.platform if platform is None else platform
    override = values.get("AEGIS_DATA_DIR", "").strip()
    if override:
        root = Path(override).expanduser()
        if not root.is_absolute():
            raise ValueError("AEGIS_DATA_DIR must be an absolute path")
        return root.resolve()

    if platform_name == "win32":
        local_app_data = values.get("LOCALAPPDATA", "").strip()
        if not local_app_data:
            raise ValueError("LOCALAPPDATA is required when AEGIS_DATA_DIR is not set")
        return (Path(local_app_data) / "AEGIS" / "IDEA3").resolve()

    return (application_root() / ".aegis-runtime").resolve()


def configuration_path(
    *,
    env: Mapping[str, str] | None = None,
    platform: str | None = None,
) -> Path:
    """Resolve the configuration file without current-directory dependence."""
    values = os.environ if env is None else env
    platform_name = sys.platform if platform is None else platform
    override = values.get("AEGIS_CONFIG_FILE", "").strip()
    if override:
        path = Path(override).expanduser()
        if not path.is_absolute():
            raise ValueError("AEGIS_CONFIG_FILE must be an absolute path")
        return path.resolve()
    if values.get("AEGIS_DATA_DIR", "").strip() or platform_name == "win32":
        return data_root(env=values, platform=platform_name) / "config" / ".env"
    return application_root() / ".env"


@dataclass(frozen=True)
class RuntimePaths:
    """Every mutable path used by the standalone launcher."""

    root: Path
    config_file: Path
    core_db: Path
    web_db: Path
    runtime_dir: Path
    log_dir: Path

    @classmethod
    def from_environment(
        cls,
        *,
        env: Mapping[str, str] | None = None,
        platform: str | None = None,
    ) -> RuntimePaths:
        root = data_root(env=env, platform=platform)
        return cls(
            root=root,
            config_file=root / "config" / ".env",
            core_db=root / "data" / "core-audit.sqlite3",
            web_db=root / "data" / "security-center-audit.sqlite3",
            runtime_dir=root / "runtime",
            log_dir=root / "logs",
        )


def load_dotenv(
    path: Path,
    environ: MutableMapping[str, str] | None = None,
) -> None:
    """Load a simple dotenv file without overriding operator-supplied values."""
    target = os.environ if environ is None else environ
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return

    parsed: dict[str, str] = {}
    for line_number, raw_line in enumerate(lines, start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError(f"invalid dotenv line {line_number}")
        key, value = line.split("=", 1)
        key = key.strip()
        if not _ENVIRONMENT_NAME.fullmatch(key):
            raise ValueError(f"invalid environment variable name on line {line_number}")
        parsed[key] = value.strip().strip('"').strip("'")

    for key, value in parsed.items():
        target.setdefault(key, value)
