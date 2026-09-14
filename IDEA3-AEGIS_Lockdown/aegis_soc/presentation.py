"""
AEGIS IDEA 3 — Overview presentation-state mapping (Slice 1 UX/UI refresh).

Every function here is a pure mapping from evidence the GUI already tracks
(booleans/strings/numbers) to a display value plus a semantic status key.
Nothing in this module imports tkinter, touches MQTT, or reads the database
directly -- it only shapes values callers already have.

Absent or stale evidence always maps to "unknown", never to a fabricated
healthy/failed value. This module has no "FAILED" or "MONITOR_ONLY" producer
because the standalone Tkinter GUI (aegis_soc/gui.py) has no real signal for
either today; adding them here would be inventing state the application
cannot back with evidence.
"""
import re
from dataclasses import dataclass

# Semantic status keys. Defined here (not in theme.py) so this module has no
# tkinter dependency and can be imported/tested without a display or a
# tkinter installation at all; theme.py imports these constants from here to
# map them to actual colors.
STATUS_HEALTHY  = "healthy"
STATUS_WARNING  = "warning"
STATUS_CRITICAL = "critical"
STATUS_UNKNOWN  = "unknown"
STATUS_NEUTRAL  = "neutral"

_ORIGIN_PATTERN = re.compile(r"\(origin=([a-zA-Z0-9_-]+)\)")


@dataclass(frozen=True)
class Metric:
    label: str
    value: str
    status: str
    helper: str = ""


@dataclass(frozen=True)
class ActivityRow:
    time: str
    severity: str
    event: str
    source: str


def broker_metric(connected):
    """connected: True/False/None. None means no connection callback has
    fired yet -- that is genuinely unknown, not disconnected."""
    if connected is True:
        return Metric("MQTT Broker", "CONNECTED", STATUS_HEALTHY)
    if connected is False:
        return Metric("MQTT Broker", "DISCONNECTED", STATUS_CRITICAL)
    return Metric("MQTT Broker", "UNKNOWN", STATUS_UNKNOWN, "No broker evidence yet")


def esp32_metric(seconds_since_seen, offline_threshold_sec, rssi=None, heap=None):
    """seconds_since_seen: None when the device has never been observed."""
    if seconds_since_seen is None:
        return Metric("ESP32", "UNKNOWN", STATUS_UNKNOWN, "No device evidence yet")

    helper = f"last seen {seconds_since_seen:.0f}s ago"
    if rssi is not None:
        helper += f" · RSSI {rssi} dBm"
    if heap is not None:
        helper += f" · heap {heap} B"

    if seconds_since_seen <= offline_threshold_sec:
        return Metric("ESP32", "ONLINE", STATUS_HEALTHY, helper)
    return Metric("ESP32", "OFFLINE", STATUS_CRITICAL, helper)


def uplink_metric(state):
    """state: 'NORMAL' | 'LOCKDOWN' | anything else (including None), which
    is treated as unknown rather than guessed."""
    if state == "NORMAL":
        return Metric("Uplink", "NORMAL", STATUS_HEALTHY)
    if state == "LOCKDOWN":
        return Metric("Uplink", "LOCKDOWN", STATUS_CRITICAL)
    return Metric("Uplink", "UNKNOWN", STATUS_UNKNOWN, "No status evidence yet")


def system_health_metric(broker_connected, seconds_since_seen, offline_threshold_sec):
    """Derived only from this console's own connectivity evidence (broker
    link + device freshness). Never reports FAILED: there is no crash or
    failure signal available to this GUI, so FAILED stays reserved for a
    later slice with real evidence rather than being fabricated here."""
    if broker_connected is None or seconds_since_seen is None:
        return Metric("System Health", "UNKNOWN", STATUS_UNKNOWN, "Insufficient evidence")
    if broker_connected and seconds_since_seen <= offline_threshold_sec:
        return Metric("System Health", "HEALTHY", STATUS_HEALTHY)
    return Metric("System Health", "DEGRADED", STATUS_WARNING)


def mode_metric(armed):
    """This GUI only ever has ARMED/DISARMED evidence (no MONITOR_ONLY --
    that concept belongs to the separate headless supervisor runtime)."""
    if armed:
        return Metric("System Mode", "ARMED", STATUS_HEALTHY)
    return Metric("System Mode", "DISARMED", STATUS_WARNING)


def deadman_metric(remaining_seconds):
    if remaining_seconds <= 10:
        status = STATUS_CRITICAL
    elif remaining_seconds <= 30:
        status = STATUS_WARNING
    else:
        status = STATUS_HEALTHY
    return Metric("Dead Man", f"{remaining_seconds:.0f}s", status)


def incidents_metric(open_incident):
    """open_incident: the dict returned by database.get_open_incident(), or
    None/falsy when nothing is open."""
    if not open_incident:
        return Metric("Open Incidents", "0", STATUS_HEALTHY)
    detail_bits = [f"#{open_incident.get('id')}"]
    if open_incident.get("state"):
        detail_bits.append(open_incident["state"])
    if open_incident.get("attacker_ip"):
        detail_bits.append(f"IP {open_incident['attacker_ip']}")
    return Metric("Open Incidents", "1", STATUS_WARNING, " · ".join(detail_bits))


def today_metric(count):
    return Metric("Today", str(count), STATUS_NEUTRAL)


def extract_source(details):
    """Best-effort SOURCE for the Recent Activity table: parses the existing
    '(origin=...)' marker already written by AegisCommandController.issue().
    Falls back to a neutral 'SYSTEM' label rather than guessing a specific
    origin when none was recorded."""
    if not details:
        return "SYSTEM"
    match = _ORIGIN_PATTERN.search(details)
    if match:
        return match.group(1).upper()
    return "SYSTEM"


def _format_time(timestamp):
    """audit_logs.timestamp is stored as 'YYYY-MM-DD HH:MM:SS'; the compact
    activity table only needs the time portion."""
    if timestamp and " " in timestamp:
        return timestamp.split(" ", 1)[1]
    return timestamp or "--:--:--"


def build_activity_rows(log_rows, limit=8):
    """log_rows: iterable of (id, timestamp, level, event_type, details,
    incident_id) tuples ordered newest-first, e.g. database.fetch_all_logs().
    """
    rows = []
    for row in list(log_rows)[:limit]:
        _row_id, timestamp, level, event_type, details, _incident_id = row
        rows.append(ActivityRow(
            time=_format_time(timestamp),
            severity=level or "INFO",
            event=event_type or "EVENT",
            source=extract_source(details),
        ))
    return rows
