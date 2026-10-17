"""Fail-closed, read-only projection of the running IDEA3 Core status file.

This module deliberately has no MQTT, controller, supervisor, Telegram, GPIO,
serial, subprocess, or background-worker dependency. It reads one JSON file and
returns only the small allowlisted vocabulary needed by the Desktop observer.
"""

from __future__ import annotations

import json
import math
import os
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

STATUS_PATH = Path("/run/aegis-idea3/status.json")
DEFAULT_MAX_AGE_SECONDS = 120.0
MAX_STATUS_BYTES = 64 * 1024
UNKNOWN = "UNKNOWN"

_REQUIRED_FIELDS = frozenset(
    {
        "state",
        "profile",
        "dry_run",
        "auto_contain",
        "broker",
        "device",
        "uplink",
        "armed",
        "dispatch",
        "time_trust",
        "updated_at",
        "components",
    }
)
_CORE_STATES = frozenset(
    {"INIT", "PREFLIGHT", "WAIT_BROKER", "WAIT_DEVICE", "RUNNING", "DEGRADED", "LOCKDOWN", "FAILED", "SHUTDOWN"}
)
_PROFILES = frozenset({"development", "lab", "production"})
_BROKER_STATES = frozenset({"CONNECTED", "DISCONNECTED", UNKNOWN})
_DEVICE_STATES = frozenset({"ONLINE", "OFFLINE", UNKNOWN})
_UPLINK_STATES = frozenset({"NORMAL", "LOCKDOWN", UNKNOWN})
_ARMED_STATES = frozenset({"ARMED", "DISARMED", "MONITOR_ONLY"})
_DISPATCH_STATES = frozenset({"DISABLED", "ACTIVE", "PAUSED_CREDENTIAL", "UNAVAILABLE", UNKNOWN})
_TIME_STATES = frozenset({"SYNCED", "HOLDOVER", "UNTRUSTED", UNKNOWN})
_COMPONENT_STATES = frozenset({"RUNNING", "RESTARTING", "FAILED", "STOPPED"})

# This is intentionally an operator statement, not data claimed by the Core.
PHYSICAL_OBSERVATION = "Pin 2 open; Pins 1 and 3–8 connected"


@dataclass(frozen=True)
class ObserverEvidence:
    valid: bool
    freshness: str
    reason: str
    runtime_state: str = UNKNOWN
    profile: str = UNKNOWN
    dry_run: str = UNKNOWN
    auto_contain: str = UNKNOWN
    broker: str = UNKNOWN
    device: str = UNKNOWN
    uplink: str = UNKNOWN
    armed: str = UNKNOWN
    dispatch: str = UNKNOWN
    trusted_time: str = UNKNOWN
    evidence_timestamp: str = UNKNOWN
    physical_observation: str = PHYSICAL_OBSERVATION
    physical_source: str = "OPERATOR_OBSERVED_ONLY"
    physical_verification: str = "NOT_VERIFIED"
    allowlisted: frozenset[str] = frozenset()


def _unknown(freshness: str, reason: str) -> ObserverEvidence:
    return ObserverEvidence(valid=False, freshness=freshness, reason=reason)


class _UnsafeStatusFile(OSError):
    """The configured path is not a plain, bounded, regular status file."""


def _read_status_text(path: Path) -> str:
    """Read the configured status file directly: no subprocess, no privilege change.

    The file is opened without following a final symlink and without blocking, must be a
    regular file, and is read with a hard size bound.
    """

    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0)
    descriptor = os.open(path, flags)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise _UnsafeStatusFile("Core status path is not a regular file")
        data = os.read(descriptor, MAX_STATUS_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(data) > MAX_STATUS_BYTES:
        raise _UnsafeStatusFile("Core status file exceeds the size bound")
    return data.decode("utf-8")


def _is_bool(value: Any) -> bool:
    return isinstance(value, bool)


def _validate(document: dict[str, Any]) -> str | None:
    missing = _REQUIRED_FIELDS - document.keys()
    if missing:
        return "missing fields: " + ", ".join(sorted(missing))
    if not isinstance(document["state"], str) or document["state"] not in _CORE_STATES:
        return "invalid Core runtime state"
    if not isinstance(document["profile"], str) or document["profile"] not in _PROFILES:
        return "invalid profile"
    if not _is_bool(document["dry_run"]) or not _is_bool(document["auto_contain"]):
        return "invalid boolean mode"
    if document["profile"] == "production" and document["dry_run"] is not False:
        return "production dry-run contradiction"
    if document["broker"] not in _BROKER_STATES or document["device"] not in _DEVICE_STATES:
        return "invalid broker/device state"
    if document["uplink"] not in _UPLINK_STATES or document["armed"] not in _ARMED_STATES:
        return "invalid uplink/armed state"
    if document["dispatch"] not in _DISPATCH_STATES or document["time_trust"] not in _TIME_STATES:
        return "invalid dispatch/time state"
    timestamp = document["updated_at"]
    if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)) or not math.isfinite(timestamp) or timestamp <= 0:
        return "invalid evidence timestamp"
    components = document["components"]
    if not isinstance(components, dict) or any(
        not isinstance(key, str) or not isinstance(value, str) or value not in _COMPONENT_STATES
        for key, value in components.items()
    ):
        return "invalid component state"
    if document["state"] == "LOCKDOWN" and document["uplink"] == "NORMAL":
        return "Core lockdown/uplink contradiction"
    return None


def load_status_document(
    path: Path,
    *,
    now: float | None = None,
    max_age_seconds: float = DEFAULT_MAX_AGE_SECONDS,
) -> tuple[dict[str, Any] | None, ObserverEvidence | None]:
    """Return ``(document, None)`` for fresh, valid, consistent evidence, else ``(None, UNKNOWN evidence)``.

    This is the single fail-closed gate shared by the Desktop reader and the status projection publisher.
    """

    try:
        document = json.loads(_read_status_text(Path(path)))
    except FileNotFoundError:
        return None, _unknown("MISSING", "Core status file is unavailable")
    except PermissionError:
        return None, _unknown("UNAVAILABLE", "permission denied for the Core status file; no privileged read is attempted")
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None, _unknown("INVALID", "Core status file is unreadable or invalid")
    if not isinstance(document, dict):
        return None, _unknown("INVALID", "Core status document is not an object")

    problem = _validate(document)
    if problem:
        freshness = "CONTRADICTORY" if "contradiction" in problem else "INVALID"
        return None, _unknown(freshness, problem)

    current = time.time() if now is None else now
    age = current - float(document["updated_at"])
    if age < 0:
        return None, _unknown("INVALID", "Core status timestamp is in the future")
    if age > max_age_seconds:
        return None, _unknown("STALE", f"Core status is {age:.1f}s old")
    return document, None


def read_observer_status(
    path: Path = STATUS_PATH,
    *,
    now: float | None = None,
    max_age_seconds: float = DEFAULT_MAX_AGE_SECONDS,
) -> ObserverEvidence:
    """Read the fixed Core status shape without importing the Core runtime."""

    document, unknown = load_status_document(path, now=now, max_age_seconds=max_age_seconds)
    if document is None:
        return unknown

    allowlisted = frozenset(_REQUIRED_FIELDS)
    return ObserverEvidence(
        valid=True,
        freshness="FRESH",
        reason="Core status evidence is fresh and internally consistent",
        runtime_state=document["state"],
        profile=document["profile"],
        dry_run="TRUE" if document["dry_run"] else "FALSE",
        auto_contain="TRUE" if document["auto_contain"] else "FALSE",
        broker=document["broker"],
        device=document["device"],
        uplink=document["uplink"],
        armed=document["armed"],
        dispatch=document["dispatch"],
        trusted_time=document["time_trust"],
        evidence_timestamp=str(document["updated_at"]),
        allowlisted=allowlisted,
    )
