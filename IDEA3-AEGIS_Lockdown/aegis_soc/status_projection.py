"""Allowlisted status projection for the status sidecar (stdlib only, no Core imports).

``aegis_soc.runtime.safe_status_projection`` is the contract owner and is deliberately NOT changed: it stays inside the
governed Core release, whose file set is pinned by the release guard and the upgrade engines. The status publisher and pusher
ship in a separate sidecar package that must not carry MQTT, controller or restore code, so they use this mirror of the same
allowlist. ``tests/test_status_projection_mirror.py`` pins the two to identical output; any divergence fails the build.
Only allowlisted vocabulary crosses; ``detail``, ``pid``, paths and every unknown key are dropped rather than sanitized.
"""

from __future__ import annotations

import time

SAFE_STATUS_SCHEMA_VERSION = 1

_CANONICAL_STATUS_BY_STATE = {
    "RUNNING": "HEALTHY",
    "DEGRADED": "DEGRADED",
    "LOCKDOWN": "DEGRADED",
    "FAILED": "FAILED",
    "SHUTDOWN": "FAILED",
    "INIT": "UNKNOWN",
    "PREFLIGHT": "UNKNOWN",
    "WAIT_BROKER": "UNKNOWN",
    "WAIT_DEVICE": "UNKNOWN",
}

_ALLOWED_COMPONENTS = ("detector", "gui", "preflight")
_ALLOWED_COMPONENT_STATES = frozenset({"RUNNING", "RESTARTING", "FAILED", "STOPPED"})
_ALLOWED_BROKER_STATES = frozenset({"CONNECTED", "DISCONNECTED", "UNKNOWN"})
_ALLOWED_DEVICE_STATES = frozenset({"ONLINE", "OFFLINE", "UNKNOWN"})
_ALLOWED_UPLINK_STATES = frozenset({"NORMAL", "LOCKDOWN", "UNKNOWN"})
_ALLOWED_ARMED_STATES = frozenset({"ARMED", "DISARMED", "MONITOR_ONLY"})
_ALLOWED_PROFILES = frozenset({"development", "lab", "production"})
_ALLOWED_DISPATCH_STATES = frozenset(
    {"DISABLED", "ACTIVE", "PAUSED_CREDENTIAL", "UNAVAILABLE"}
)


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
        "dispatch": "UNKNOWN",
        "components": {},
        "modes": {"profile": "UNKNOWN", "dryRun": True, "autoContain": False, "armed": "UNKNOWN"},
        "issues": [],
        "evidenceSource": "RUNTIME_STATUS_ABSENT",
    }


def project_status_document(document: dict | None) -> dict:
    """Project runtime status into the versioned contract IDEA3 Web may consume.

    Only allowlisted state vocabulary crosses this boundary. Free-text ``detail``,
    ``pid``, paths, addresses, and every configuration or secret value are dropped
    rather than sanitized, so an unrecognized field can never leak by default.
    """
    if not isinstance(document, dict):
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
    dispatch = _allowlisted(document.get("dispatch"), _ALLOWED_DISPATCH_STATES)
    if status_value == "HEALTHY":
        if bool(document.get("dry_run", True)):
            status_value = "UNKNOWN"
        elif dispatch in {"PAUSED_CREDENTIAL", "UNAVAILABLE"}:
            status_value = "DEGRADED"
        elif dispatch == "UNKNOWN":
            status_value = "UNKNOWN"
        elif (
            components["broker"] == "DISCONNECTED"
            or components["device"] == "OFFLINE"
            or any(components.get(name) == "FAILED" for name in _ALLOWED_COMPONENTS)
        ):
            status_value = "DEGRADED"
        elif any(components[name] == "UNKNOWN" for name in ("broker", "device", "uplink")):
            status_value = "UNKNOWN"

    issues = set()
    if components["broker"] != "CONNECTED":
        issues.add("MQTT_DISCONNECTED")
    if components["device"] != "ONLINE":
        issues.add("ESP32_UNAVAILABLE")
    if any(components.get(name) == "FAILED" for name in _ALLOWED_COMPONENTS):
        issues.add("COMPONENT_FAILURE")
    if status_value == "FAILED":
        issues.add("CORE_PROCESS_FAILURE")
    if dispatch in {"PAUSED_CREDENTIAL", "UNAVAILABLE"}:
        issues.add("DISPATCH_PAUSED")

    profile = document.get("profile")
    return {
        "schemaVersion": SAFE_STATUS_SCHEMA_VERSION,
        "generatedAt": generated_at,
        "status": status_value,
        "dispatch": dispatch,
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
