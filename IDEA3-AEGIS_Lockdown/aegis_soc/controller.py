"""Shared, authenticated command path for GUI, supervisor, and future adapters.

Protocol v1 (PR11 Phase 4) is the default. Every COMMAND and HEARTBEAT is a
signed fixed-array message, and a command's per-device sequence is committed
before the publish, which is the point of no return (R13). Commands and
heartbeats need trusted Core time (R7). RESTORE needs both an explicit
authorization bit and an allowlisted local origin; Telegram can never restore
(R8, D4). The legacy v0 path exists only behind an explicit non-production lab
mode. This module is also the single dry-run boundary for relay commands.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

from . import config, security
from . import database as db
from . import protocol_v1 as p1

CUT_UPLINK = "CUT_UPLINK"
RESTORE_UPLINK = "RESTORE_UPLINK"
ALLOWED_COMMANDS = frozenset({CUT_UPLINK, RESTORE_UPLINK})
DEFAULT_RESTORE_ORIGINS = frozenset({"gui", "recovery-wizard"})
FORBIDDEN_RESTORE_ORIGINS = frozenset({"telegram"})


@dataclass(frozen=True)
class CommandResult:
    action: str
    ok: bool
    sent: bool
    dry_run: bool
    # The correlation identifier: the 128-bit Protocol v1 msg_id (legacy: v0 nonce).
    nonce: str | None
    detail: str
    seq: int | None = None
    reason_code: str | None = None


class AegisCommandController:
    """Route relay commands through signing, audit, and MQTT exactly once."""

    def __init__(
        self,
        mqtt_manager,
        *,
        dry_run: bool = False,
        audit_log: Callable[..., None] = db.log_event,
        protocol=None,
        protocol_mode: str | None = None,
        restore_origins: frozenset[str] = DEFAULT_RESTORE_ORIGINS,
    ):
        origins = frozenset(restore_origins)
        if origins & FORBIDDEN_RESTORE_ORIGINS:
            raise ValueError("Telegram can never hold RESTORE authority")
        self.mqtt = mqtt_manager
        self.dry_run = dry_run
        self._audit_log = audit_log
        self.protocol = protocol
        mode = config.PROTOCOL_MODE if protocol_mode is None else protocol_mode
        # Anything other than the explicit lab opt-in is strict Protocol v1.
        self.legacy = mode == config.PROTOCOL_MODE_LEGACY_LAB
        self.restore_origins = origins
        self._last_heartbeat_issued_at: int | None = None
        self._heartbeat_withheld = False

    def _reject(self, action: str, detail: str, reason_code: str, audit_detail: str | None = None) -> CommandResult:
        self._audit_log("COMMAND_REJECTED", audit_detail or detail, db.WARN)
        return CommandResult(action, False, False, self.dry_run, None, detail, reason_code=reason_code)

    def issue(
        self,
        action: str,
        description: str,
        *,
        critical: bool = False,
        origin: str = "unknown",
        authorize_restore: bool = False,
        not_after: float | None = None,
    ) -> CommandResult:
        """Issue an allow-listed command or safely simulate it.

        RESTORE requires an explicit authorization bit from a caller that has
        already completed its human recovery/authentication flow *and* an
        origin on this controller's allowlist. Startup, restart, reconnect,
        shutdown, Telegram, and dispatch paths therefore fail closed.
        """
        if action not in ALLOWED_COMMANDS:
            raise ValueError(f"Unsupported AEGIS command: {action}")

        level = db.CRITICAL if critical else db.INFO
        safe_context = f"{action} - {description} (origin={origin})"

        if action == RESTORE_UPLINK:
            if not authorize_restore:
                detail = "RESTORE_UPLINK rejected: explicit recovery authorization required"
                return self._reject(action, detail, "RESTORE_NOT_AUTHORIZED", f"{detail} (origin={origin})")
            if origin in FORBIDDEN_RESTORE_ORIGINS or origin not in self.restore_origins:
                detail = "RESTORE_UPLINK rejected: this origin has no restore authority"
                return self._reject(action, detail, "RESTORE_ORIGIN_REFUSED", f"{detail} (origin={origin})")

        if self.dry_run:
            detail = f"WOULD_SEND {safe_context}"
            self._audit_log("DRY_RUN_COMMAND", detail, level)
            return CommandResult(action, True, False, True, None, detail)

        if self.legacy:
            return self._issue_legacy(action, safe_context, level)
        return self._issue_v1(action, safe_context, level, not_after)

    def _issue_legacy(self, action: str, safe_context: str, level: str) -> CommandResult:
        payload, nonce = security.create_secure_payload(action, "cmd")
        if not self.mqtt.publish(config.TOPIC_CMD, payload):
            return self._reject(action, f"MQTT unavailable; not sent: {safe_context}", "MQTT_UNAVAILABLE")
        self._audit_log("COMMAND_SENT", safe_context, level)
        return CommandResult(action, True, True, False, nonce, f"SENT {safe_context}")

    def _mark_not_published(self, msg_id: str) -> None:
        try:
            self.protocol.store.mark_not_published(msg_id)
        except Exception:
            self._audit_log("PROTOCOL_STORE_WRITE_FAILED", "unpublished command could not be marked", db.WARN)

    def _issue_v1(self, action: str, safe_context: str, level: str, not_after: float | None) -> CommandResult:
        context = self.protocol
        if context is None:
            return self._reject(action, f"Protocol v1 is not configured; not sent: {safe_context}", "PROTOCOL_NOT_CONFIGURED")
        issued_at = context.clock.trusted_now()
        if issued_at is None:
            return self._reject(action, f"Core time is not trusted; not sent: {safe_context}", "CORE_TIME_UNTRUSTED")
        expires_at = issued_at + p1.COMMAND_TTL_MAX_SEC
        if not_after is not None:
            expires_at = min(expires_at, math.floor(not_after))
        if expires_at <= issued_at:
            return self._reject(action, f"Command expired at the Core; not sent: {safe_context}", "EXPIRED_AT_CORE")

        try:
            reserved = context.store.reserve_command(context.device_id, action, issued_at, expires_at)
        except Exception:
            return self._reject(action, f"Protocol store unavailable; not sent: {safe_context}", "PROTOCOL_STORE_UNAVAILABLE")
        try:
            topic, payload = p1.encode(
                p1.COMMAND,
                device_id=context.device_id,
                fields={
                    "msg_id": reserved.msg_id,
                    "seq": reserved.seq,
                    "issued_at": issued_at,
                    "expires_at": expires_at,
                    "action": action,
                },
                keys=context.keys,
            )
        except (TypeError, ValueError):
            self._mark_not_published(reserved.msg_id)
            return self._reject(action, f"Command could not be encoded; not sent: {safe_context}", "PROTOCOL_ENCODE_FAILED")

        if not self.mqtt.publish(topic, payload):
            self._mark_not_published(reserved.msg_id)
            return self._reject(action, f"MQTT unavailable; not sent: {safe_context}", "MQTT_UNAVAILABLE")

        # The publish was the point of no return (R13): the command is never
        # reported as unsent, and an unrecordable publish resolves to
        # OUTCOME_UNKNOWN because its evidence can no longer correlate.
        try:
            context.store.mark_published(reserved.msg_id)
        except Exception:
            self._audit_log(
                "PROTOCOL_STORE_WRITE_AFTER_PUBLISH_FAILED", f"{safe_context} seq={reserved.seq}", db.CRITICAL,
            )
        self._audit_log("COMMAND_SENT", f"{safe_context} seq={reserved.seq}", level)
        return CommandResult(action, True, True, False, reserved.msg_id, f"SENT {safe_context}", seq=reserved.seq)

    def send_heartbeat(self) -> bool:
        """Send an authenticated heartbeat; dry-run never touches MQTT (R7 gates v1)."""
        if self.dry_run:
            return True
        if self.legacy:
            payload, _ = security.create_secure_payload("alive", "hb")
            return self.mqtt.publish(config.TOPIC_HEARTBEAT, payload)
        context = self.protocol
        if context is None:
            return False
        now = context.clock.trusted_now()
        if now is None:
            if not self._heartbeat_withheld:
                self._heartbeat_withheld = True
                self._audit_log("HEARTBEAT_WITHHELD", "Core time is not trusted; no heartbeat is published (R7)", db.WARN)
            return False
        self._heartbeat_withheld = False
        if self._last_heartbeat_issued_at is not None and now <= self._last_heartbeat_issued_at:
            return False
        topic, payload = p1.encode(
            p1.HEARTBEAT,
            device_id=context.device_id,
            fields={"msg_id": p1.new_msg_id(), "issued_at": now},
            keys=context.keys,
        )
        if not self.mqtt.publish(topic, payload):
            return False
        self._last_heartbeat_issued_at = now
        return True
