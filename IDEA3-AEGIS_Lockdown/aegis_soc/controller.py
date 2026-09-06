"""Shared, authenticated command path for GUI, supervisor, and future adapters.

This module is deliberately small: it composes the existing security payload
builder and MQTT transport instead of reimplementing either one.  It is also the
single dry-run boundary for commands that could change physical relay state.
"""

from collections.abc import Callable
from dataclasses import dataclass

from . import config, security
from . import database as db

CUT_UPLINK = "CUT_UPLINK"
RESTORE_UPLINK = "RESTORE_UPLINK"
ALLOWED_COMMANDS = frozenset({CUT_UPLINK, RESTORE_UPLINK})


@dataclass(frozen=True)
class CommandResult:
    action: str
    ok: bool
    sent: bool
    dry_run: bool
    nonce: str | None
    detail: str


class AegisCommandController:
    """Route relay commands through HMAC signing, audit, and MQTT exactly once."""

    def __init__(
        self,
        mqtt_manager,
        *,
        dry_run: bool = False,
        audit_log: Callable[..., None] = db.log_event,
    ):
        self.mqtt = mqtt_manager
        self.dry_run = dry_run
        self._audit_log = audit_log

    def issue(
        self,
        action: str,
        description: str,
        *,
        critical: bool = False,
        origin: str = "unknown",
        authorize_restore: bool = False,
    ) -> CommandResult:
        """Issue an allow-listed command or safely simulate it.

        RESTORE requires an explicit authorization bit from a caller that has
        already completed its human recovery/authentication flow.  This makes an
        accidental restore during startup, restart, or shutdown fail closed.
        """
        if action not in ALLOWED_COMMANDS:
            raise ValueError(f"Unsupported AEGIS command: {action}")

        level = db.CRITICAL if critical else db.INFO
        safe_context = f"{action} - {description} (origin={origin})"

        if action == RESTORE_UPLINK and not authorize_restore:
            detail = "RESTORE_UPLINK rejected: explicit recovery authorization required"
            self._audit_log("COMMAND_REJECTED", f"{detail} (origin={origin})", db.WARN)
            return CommandResult(action, False, False, self.dry_run, None, detail)

        payload, nonce = security.create_secure_payload(action, "cmd")

        if self.dry_run:
            detail = f"WOULD_SEND {safe_context}"
            self._audit_log("DRY_RUN_COMMAND", detail, level)
            return CommandResult(action, True, False, True, nonce, detail)

        if not self.mqtt.publish(config.TOPIC_CMD, payload):
            detail = f"MQTT unavailable; not sent: {safe_context}"
            self._audit_log("COMMAND_REJECTED", detail, db.WARN)
            return CommandResult(action, False, False, False, nonce, detail)

        detail = f"SENT {safe_context}"
        self._audit_log("COMMAND_SENT", safe_context, level)
        return CommandResult(action, True, True, False, nonce, detail)

    def send_heartbeat(self) -> bool:
        """Send an authenticated heartbeat; dry-run never touches MQTT."""
        if self.dry_run:
            return True
        payload, _ = security.create_secure_payload("alive", "hb")
        return self.mqtt.publish(config.TOPIC_HEARTBEAT, payload)
