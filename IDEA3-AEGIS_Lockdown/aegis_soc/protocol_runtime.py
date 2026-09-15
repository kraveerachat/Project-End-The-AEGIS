"""Build the Core's Protocol v1 context from configuration (PR11 Phase 4).

Fail closed: legacy lab mode, incomplete or invalid configuration, unsafe keys,
or a protocol store under ``/run`` all yield no context. Without a context the
Core publishes no COMMAND or HEARTBEAT, and its MQTT client refuses to connect.
Runtime preflight reports the precise reason separately.
"""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

from . import config
from . import protocol_v1 as p1
from .paths import RuntimePaths, application_root
from .protocol_inbound import ProtocolContext
from .protocol_store import ProtocolStore
from .trusted_time import TrustedClock

_RUN_ROOT = Path("/run")


def protocol_db_problem(path: Path, *, runtime_dir: Path | None = None) -> str | None:
    """Durable replay/sequence state never lives under /run or the runtime directory."""
    if not path.is_absolute():
        return "the protocol store path must be absolute"
    resolved = path.resolve()
    if path.is_relative_to(_RUN_ROOT) or resolved.is_relative_to(_RUN_ROOT):
        return "the protocol store must be durable data, never under /run"
    if runtime_dir is not None and resolved.is_relative_to(Path(runtime_dir).resolve()):
        return "the protocol store must be durable data, never under the runtime directory"
    return None


def protocol_db_path(*, platform: str | None = None) -> Path:
    if config.CORE_PROTOCOL_DB_PATH:
        path = Path(config.CORE_PROTOCOL_DB_PATH).expanduser()
    elif os.getenv("AEGIS_DATA_DIR", "").strip() or (platform or sys.platform) == "win32":
        path = RuntimePaths.from_environment(platform=platform).protocol_db
    else:
        path = application_root() / ".aegis-runtime" / "data" / "core-protocol.sqlite3"
    problem = protocol_db_problem(path)
    if problem is not None:
        raise ValueError(problem)
    return path


def build_protocol_context_from_environment(*, clock=None) -> ProtocolContext | None:
    if config.PROTOCOL_MODE == config.PROTOCOL_MODE_LEGACY_LAB:
        return None
    device_id = config.P1_DEVICE_ID
    if not (device_id and config.P1_C2D_KEY_FILE and config.P1_D2C_KEY_FILE):
        return None
    if not p1.valid_device_id(device_id):
        return None
    try:
        keys = p1.load_protocol_keys(config.P1_C2D_KEY_FILE, config.P1_D2C_KEY_FILE)
        store = ProtocolStore(protocol_db_path())
    except (ValueError, OSError, sqlite3.Error):
        return None
    return ProtocolContext(device_id, keys, store, clock if clock is not None else TrustedClock())
