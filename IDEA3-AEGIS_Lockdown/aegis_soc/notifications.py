"""Presentation-only, session-local security notification model.

Scope boundary (read this before wiring anything new into it):

    This module never publishes MQTT, never touches the controller or
    supervisor, never mutates incident/containment/control state, and
    never fabricates attack classification. It only turns evidence the
    application ALREADY has -- an attacker IP already delivered by the
    existing detector callback, a broker disconnect the existing MQTT
    client already reported, an already-open incident row, an
    already-failed audit-chain check -- into a uniform, ackable list a
    Tkinter notification center/toast can render.

    Acknowledging a notification changes only this in-memory list. It
    never marks an incident CONTAINED/CLOSED, never clears armed/locked
    state, and never counts as CUT/RESTORE authorization.

Persistence: NotificationCenter is process-memory-only. It is never
written to disk or the database, and does not survive an application
restart -- callers must not claim otherwise.

Severity mapping is deliberately narrow: only the three levels below,
each backed by real evidence already available elsewhere in this
codebase (presentation.py's status metrics, database.py's incident rows,
db.verify_chain()). This module does not invent a fourth "attack type"
field -- if only an IP is known, only an IP is ever shown.
"""

from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field

SEVERITY_INFO = "INFO"
SEVERITY_WARNING = "WARNING"
SEVERITY_CRITICAL = "CRITICAL"
SEVERITIES = (SEVERITY_INFO, SEVERITY_WARNING, SEVERITY_CRITICAL)

CATEGORY_CONNECTIVITY = "connectivity"
CATEGORY_SECURITY_ALERT = "security_alert"
CATEGORY_INCIDENT = "incident"
CATEGORY_AUDIT = "audit"
CATEGORY_SYSTEM = "system"

NAV_LOCKDOWN = "lockdown"
NAV_INCIDENTS = "incidents"
NAV_AUDIT = "audit"


@dataclass
class Notification:
    """One notification. title_key/message_key are i18n.STRINGS keys,
    resolved by the caller at render time (never baked into a fixed
    language here) so a later language switch redisplays correctly.
    format_kwargs holds only non-secret, already-known values (an IP,
    an incident id) substituted into the message template -- never a
    credential, never a fabricated attack label."""

    id: int
    timestamp: float
    severity: str
    category: str
    title_key: str
    message_key: str
    format_kwargs: dict = field(default_factory=dict)
    source_ip: str | None = None
    incident_id: int | None = None
    navigation_target: str | None = None
    acknowledged: bool = False


class NotificationCenter:
    """In-memory, session-local notification list. See module docstring
    for the full scope boundary."""

    def __init__(self, max_items: int = 200):
        self._items: list[Notification] = []
        self._ids = itertools.count(1)
        self._max_items = max_items

    def add(
        self,
        *,
        severity: str,
        category: str,
        title_key: str,
        message_key: str,
        format_kwargs: dict | None = None,
        source_ip: str | None = None,
        incident_id: int | None = None,
        navigation_target: str | None = None,
        timestamp: float | None = None,
    ) -> Notification:
        if severity not in SEVERITIES:
            raise ValueError(f"unknown notification severity: {severity!r}")
        notification = Notification(
            id=next(self._ids),
            timestamp=timestamp if timestamp is not None else time.time(),
            severity=severity,
            category=category,
            title_key=title_key,
            message_key=message_key,
            format_kwargs=dict(format_kwargs or {}),
            source_ip=source_ip,
            incident_id=incident_id,
            navigation_target=navigation_target,
        )
        self._items.insert(0, notification)
        del self._items[self._max_items :]
        return notification

    def all(self) -> list[Notification]:
        return list(self._items)

    def unread(self) -> list[Notification]:
        return [n for n in self._items if not n.acknowledged]

    def unread_count(self) -> int:
        return len(self.unread())

    def critical_unread_count(self) -> int:
        return sum(1 for n in self.unread() if n.severity == SEVERITY_CRITICAL)

    def acknowledge(self, notification_id: int) -> bool:
        """Marks one notification read. Presentation-state only -- see
        module docstring; never touches incident/containment state."""
        for notification in self._items:
            if notification.id == notification_id:
                notification.acknowledged = True
                return True
        return False

    def acknowledge_all(self) -> None:
        for notification in self._items:
            notification.acknowledged = True

    def clear(self) -> None:
        self._items.clear()

    # ------------------------------------------------------------------
    # Convenience builders. Each maps one existing, already-verified
    # evidence source honestly -- no fabricated classification.
    # ------------------------------------------------------------------
    def notify_broker_disconnected(self) -> Notification:
        return self.add(
            severity=SEVERITY_WARNING,
            category=CATEGORY_CONNECTIVITY,
            title_key="notif.broker_disconnected_title",
            message_key="notif.broker_disconnected_message",
            navigation_target=NAV_LOCKDOWN,
        )

    def notify_esp32_offline(self) -> Notification:
        return self.add(
            severity=SEVERITY_WARNING,
            category=CATEGORY_CONNECTIVITY,
            title_key="notif.esp32_offline_title",
            message_key="notif.esp32_offline_message",
            navigation_target=NAV_LOCKDOWN,
        )

    def notify_attacker_detected(self, source_ip: str | None, incident_id: int | None = None) -> Notification:
        return self.add(
            severity=SEVERITY_CRITICAL,
            category=CATEGORY_SECURITY_ALERT,
            title_key="notif.security_alert_title",
            message_key="notif.security_alert_message" if source_ip else "notif.security_alert_message_unknown",
            format_kwargs={"source_ip": source_ip} if source_ip else {},
            source_ip=source_ip,
            incident_id=incident_id,
            navigation_target=NAV_INCIDENTS,
        )

    def notify_lockdown_engaged(self) -> Notification:
        return self.add(
            severity=SEVERITY_CRITICAL,
            category=CATEGORY_SYSTEM,
            title_key="notif.lockdown_engaged_title",
            message_key="notif.lockdown_engaged_message",
            navigation_target=NAV_LOCKDOWN,
        )

    def notify_normal_restored(self) -> Notification:
        return self.add(
            severity=SEVERITY_INFO,
            category=CATEGORY_SYSTEM,
            title_key="notif.normal_restored_title",
            message_key="notif.normal_restored_message",
            navigation_target=NAV_LOCKDOWN,
        )

    def notify_audit_integrity_invalid(self) -> Notification:
        return self.add(
            severity=SEVERITY_CRITICAL,
            category=CATEGORY_AUDIT,
            title_key="notif.audit_invalid_title",
            message_key="notif.audit_invalid_message",
            navigation_target=NAV_AUDIT,
        )
