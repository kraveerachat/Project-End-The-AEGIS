"""Fail-closed, read-only projection of the running IDEA3 Core status file.

This module deliberately has no MQTT, controller, supervisor, Telegram, GPIO,
serial, subprocess, or background-worker dependency. It reads one JSON file and
returns only the small allowlisted vocabulary needed by the Desktop observer.
"""

from __future__ import annotations

import json
import math
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

STATUS_PATH = Path("/run/aegis-idea3/status.json")
DEFAULT_MAX_AGE_SECONDS = 120.0
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


def _read_status_text(path: Path) -> str:
    """Read status directly, with one exact-file passwordless sudo fallback."""

    try:
        return path.read_text(encoding="utf-8")
    except PermissionError:
        if path != STATUS_PATH:
            raise
        result = subprocess.run(
            ["sudo", "-n", "cat", str(STATUS_PATH)],
            capture_output=True,
            text=True,
            check=False,
            timeout=2.0,
        )
        if result.returncode != 0:
            detail = (result.stderr or "not authorized").strip()
            raise PermissionError(f"permission denied for fixed Core status file: {detail}")
        return result.stdout


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


def read_observer_status(
    path: Path = STATUS_PATH,
    *,
    now: float | None = None,
    max_age_seconds: float = DEFAULT_MAX_AGE_SECONDS,
) -> ObserverEvidence:
    """Read the fixed Core status shape without importing the Core runtime."""

    try:
        document = json.loads(_read_status_text(Path(path)))
    except FileNotFoundError:
        return _unknown("MISSING", "Core status file is unavailable")
    except PermissionError as error:
        return _unknown("UNAVAILABLE", str(error))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return _unknown("INVALID", "Core status file is unreadable or invalid")
    if not isinstance(document, dict):
        return _unknown("INVALID", "Core status document is not an object")

    problem = _validate(document)
    if problem:
        freshness = "CONTRADICTORY" if "contradiction" in problem else "INVALID"
        return _unknown(freshness, problem)

    current = time.time() if now is None else now
    age = current - float(document["updated_at"])
    if age < 0:
        return _unknown("INVALID", "Core status timestamp is in the future")
    if age > max_age_seconds:
        return _unknown("STALE", f"Core status is {age:.1f}s old")

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
