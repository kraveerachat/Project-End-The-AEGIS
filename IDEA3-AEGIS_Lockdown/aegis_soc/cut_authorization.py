"""Core-owned, durable, one-shot authorization for physical ``CUT_UPLINK``.

The SQLite row is durable evidence, not a bearer capability. A usable grant
also has a process-local MAC, so copied database identifiers and grants from a
previous Core process fail closed. Consumption and its audit event commit in
one ``BEGIN IMMEDIATE`` transaction. Once consumed, no outcome rearms it.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Callable


_logger = logging.getLogger("aegis_soc")

CUT_UPLINK = "CUT_UPLINK"
_TERMINAL_OUTCOMES = frozenset({"PUBLISHED", "NOT_PUBLISHED", "OUTCOME_UNKNOWN"})


class CutAuthorizationError(RuntimeError):
    """A stable fail-closed reason code; details never contain credentials."""


@dataclass(frozen=True)
class CutAuthorizationGrant:
    approval_id: str
    request_id: str
    incident_id: str | None
    target_device: str
    action: str
    operator_identity: str
    expires_at: float
    authenticator: str


class TrustedCutAuthorizationIssuer:
    """Capability handed only to the authenticated Core-local CUT gate."""

    def __init__(self, store: CutAuthorizationStore) -> None:
        self.__store = store

    def issue(
        self,
        *,
        request_id: str,
        incident_id: str | None,
        target_device: str,
        action: str,
        operator_identity: str,
        expires_at: float,
        reason: str,
    ) -> CutAuthorizationGrant:
        return self.__store._issue(
            request_id=request_id,
            incident_id=incident_id,
            target_device=target_device,
            action=action,
            operator_identity=operator_identity,
            expires_at=expires_at,
            reason=reason,
        )


class CutAuthorizationStore:
    """SQLite approval lifecycle plus a process-local grant authenticator."""

    def __init__(
        self,
        path: str | Path,
        *,
        wall_clock: Callable[[], float] = time.time,
        runtime_key: bytes | None = None,
    ) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._clock = wall_clock
        self.__runtime_key = runtime_key or secrets.token_bytes(32)
        if len(self.__runtime_key) < 32:
            raise ValueError("CUT authorization runtime key is too short")
        self.__issuer_claimed = False
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 5000")
        return connection

    def _initialize(self) -> None:
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS cut_authorizations (
                    approval_id TEXT PRIMARY KEY,
                    request_id TEXT NOT NULL,
                    incident_id TEXT,
                    target_device TEXT NOT NULL,
                    action TEXT NOT NULL CHECK (action = 'CUT_UPLINK'),
                    operator_identity TEXT NOT NULL,
                    reason TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    expires_at REAL NOT NULL,
                    state TEXT NOT NULL CHECK (
                        state IN ('AUTHORIZED','CONSUMED','EXPIRED','INVALIDATED_RESTART')
                    ),
                    consumed_at REAL,
                    outcome TEXT NOT NULL DEFAULT 'PENDING',
                    msg_id TEXT
                )
                """
            )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS cut_authorization_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    approval_id TEXT NOT NULL REFERENCES cut_authorizations (approval_id),
                    occurred_at REAL NOT NULL,
                    event_type TEXT NOT NULL,
                    detail TEXT NOT NULL
                )
                """
            )
            connection.execute(
                "CREATE TRIGGER IF NOT EXISTS cut_authorization_events_no_update "
                "BEFORE UPDATE ON cut_authorization_events BEGIN SELECT RAISE(ABORT, 'authorization audit is immutable'); END"
            )
            connection.execute(
                "CREATE TRIGGER IF NOT EXISTS cut_authorization_events_no_delete "
                "BEFORE DELETE ON cut_authorization_events BEGIN SELECT RAISE(ABORT, 'authorization audit is immutable'); END"
            )
            now = float(self._clock())
            open_rows = connection.execute(
                "SELECT approval_id FROM cut_authorizations WHERE state = 'AUTHORIZED'"
            ).fetchall()
            for row in open_rows:
                connection.execute(
                    "UPDATE cut_authorizations SET state = 'INVALIDATED_RESTART', outcome = 'NOT_PUBLISHED' "
                    "WHERE approval_id = ? AND state = 'AUTHORIZED'",
                    (row["approval_id"],),
                )
                connection.execute(
                    "INSERT INTO cut_authorization_events (approval_id, occurred_at, event_type, detail) "
                    "VALUES (?, ?, 'INVALIDATED_RESTART', 'unused process-bound grant invalidated')",
                    (row["approval_id"], now),
                )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def close(self) -> None:
        """Connections are operation-scoped; retained for uniform lifecycle use."""

    def trusted_issuer(self) -> TrustedCutAuthorizationIssuer:
        """Claim the sole issuer capability once for this Core process."""
        if self.__issuer_claimed:
            raise RuntimeError("trusted CUT authorization issuer already claimed")
        self.__issuer_claimed = True
        return TrustedCutAuthorizationIssuer(self)

    @staticmethod
    def _bounded(name: str, value: str | None, *, optional: bool = False) -> str | None:
        if value is None and optional:
            return None
        if not isinstance(value, str) or not 1 <= len(value) <= 160 or not value.isascii() or not value.isprintable():
            raise ValueError(f"invalid {name}")
        return value

    def _grant_mac(
        self,
        approval_id: str,
        request_id: str,
        incident_id: str | None,
        target_device: str,
        action: str,
        operator_identity: str,
        expires_at: float,
    ) -> str:
        fields = (
            approval_id,
            request_id,
            incident_id or "",
            target_device,
            action,
            operator_identity,
            format(float(expires_at), ".17g"),
        )
        return hmac.new(self.__runtime_key, "\x00".join(fields).encode("ascii"), hashlib.sha256).hexdigest()

    def _issue(
        self,
        *,
        request_id: str,
        incident_id: str | None,
        target_device: str,
        action: str,
        operator_identity: str,
        expires_at: float,
        reason: str,
    ) -> CutAuthorizationGrant:
        request_id = self._bounded("request_id", request_id)  # type: ignore[assignment]
        incident_id = self._bounded("incident_id", incident_id, optional=True)
        target_device = self._bounded("target_device", target_device)  # type: ignore[assignment]
        operator_identity = self._bounded("operator_identity", operator_identity)  # type: ignore[assignment]
        reason = self._bounded("reason", reason)  # type: ignore[assignment]
        if action != CUT_UPLINK:
            raise ValueError("trusted issuer may authorize only CUT_UPLINK")
        expires_at = float(expires_at)
        approval_id = secrets.token_hex(16)
        created_at = float(self._clock())
        grant = CutAuthorizationGrant(
            approval_id=approval_id,
            request_id=request_id,
            incident_id=incident_id,
            target_device=target_device,
            action=action,
            operator_identity=operator_identity,
            expires_at=expires_at,
            authenticator=self._grant_mac(
                approval_id, request_id, incident_id, target_device, action, operator_identity, expires_at
            ),
        )
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "INSERT INTO cut_authorizations "
                "(approval_id, request_id, incident_id, target_device, action, operator_identity, reason, "
                "created_at, expires_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'AUTHORIZED')",
                (
                    approval_id,
                    request_id,
                    incident_id,
                    target_device,
                    action,
                    operator_identity,
                    reason,
                    created_at,
                    expires_at,
                ),
            )
            connection.execute(
                "INSERT INTO cut_authorization_events (approval_id, occurred_at, event_type, detail) "
                "VALUES (?, ?, 'AUTHORIZED', ?)",
                (approval_id, created_at, f"request_id={request_id} target={target_device} operator={operator_identity}"),
            )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()
        return grant

    def _authentic(self, grant: CutAuthorizationGrant) -> bool:
        if not isinstance(grant, CutAuthorizationGrant):
            return False
        expected = self._grant_mac(
            grant.approval_id,
            grant.request_id,
            grant.incident_id,
            grant.target_device,
            grant.action,
            grant.operator_identity,
            grant.expires_at,
        )
        return hmac.compare_digest(expected, grant.authenticator)

    def consume(
        self,
        grant: CutAuthorizationGrant,
        *,
        request_id: str,
        incident_id: str | None,
        target_device: str,
        action: str,
    ) -> str:
        if not self._authentic(grant):
            raise CutAuthorizationError("CUT_AUTHORIZATION_FORGED")
        supplied = (request_id, incident_id, target_device, action)
        bound = (grant.request_id, grant.incident_id, grant.target_device, grant.action)
        if supplied != bound:
            raise CutAuthorizationError("CUT_AUTHORIZATION_BINDING_MISMATCH")
        now = float(self._clock())
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT request_id, incident_id, target_device, action, operator_identity, expires_at, state "
                "FROM cut_authorizations WHERE approval_id = ?",
                (grant.approval_id,),
            ).fetchone()
            if row is None:
                raise CutAuthorizationError("CUT_AUTHORIZATION_FORGED")
            database_binding = (row["request_id"], row["incident_id"], row["target_device"], row["action"])
            if database_binding != bound or row["operator_identity"] != grant.operator_identity:
                raise CutAuthorizationError("CUT_AUTHORIZATION_FORGED")
            if row["state"] != "AUTHORIZED":
                raise CutAuthorizationError("CUT_AUTHORIZATION_USED")
            if now >= float(row["expires_at"]):
                connection.execute(
                    "UPDATE cut_authorizations SET state = 'EXPIRED', outcome = 'NOT_PUBLISHED' "
                    "WHERE approval_id = ? AND state = 'AUTHORIZED'",
                    (grant.approval_id,),
                )
                connection.execute(
                    "INSERT INTO cut_authorization_events (approval_id, occurred_at, event_type, detail) "
                    "VALUES (?, ?, 'EXPIRED', 'approval expired before consume')",
                    (grant.approval_id, now),
                )
                connection.commit()
                raise CutAuthorizationError("CUT_AUTHORIZATION_EXPIRED")
            changed = connection.execute(
                "UPDATE cut_authorizations SET state = 'CONSUMED', consumed_at = ? "
                "WHERE approval_id = ? AND state = 'AUTHORIZED'",
                (now, grant.approval_id),
            )
            if changed.rowcount != 1:
                raise CutAuthorizationError("CUT_AUTHORIZATION_USED")
            connection.execute(
                "INSERT INTO cut_authorization_events (approval_id, occurred_at, event_type, detail) "
                "VALUES (?, ?, 'CONSUMED', ?)",
                (grant.approval_id, now, f"request_id={request_id} target={target_device} action={action}"),
            )
            connection.commit()
            return grant.approval_id
        except CutAuthorizationError:
            if connection.in_transaction:
                connection.rollback()
            raise
        except Exception as error:
            connection.rollback()
            _logger.error("CUT authorization consume failed: %s: %s", type(error).__name__, error)
            raise CutAuthorizationError("CUT_AUTHORIZATION_STORE_UNAVAILABLE") from None
        finally:
            connection.close()

    def record_outcome(self, approval_id: str, outcome: str, msg_id: str | None = None) -> None:
        if outcome not in _TERMINAL_OUTCOMES:
            raise ValueError("invalid CUT authorization outcome")
        now = float(self._clock())
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            changed = connection.execute(
                "UPDATE cut_authorizations SET outcome = ?, msg_id = ? "
                "WHERE approval_id = ? AND state = 'CONSUMED' AND outcome = 'PENDING'",
                (outcome, msg_id, approval_id),
            )
            if changed.rowcount == 1:
                connection.execute(
                    "INSERT INTO cut_authorization_events (approval_id, occurred_at, event_type, detail) "
                    "VALUES (?, ?, ?, ?)",
                    (approval_id, now, outcome, f"msg_id={msg_id or 'NONE'}"),
                )
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def get(self, approval_id: str) -> dict | None:
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT * FROM cut_authorizations WHERE approval_id = ?", (approval_id,)
            ).fetchone()
            return dict(row) if row else None
        finally:
            connection.close()

    def events(self, approval_id: str) -> list[dict]:
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT occurred_at, event_type, detail FROM cut_authorization_events "
                "WHERE approval_id = ? ORDER BY id",
                (approval_id,),
            ).fetchall()
            return [dict(row) for row in rows]
        finally:
            connection.close()

    def for_request(self, request_id: str) -> list[dict]:
        connection = self._connect()
        try:
            rows = connection.execute(
                "SELECT * FROM cut_authorizations WHERE request_id = ? ORDER BY created_at, approval_id",
                (request_id,),
            ).fetchall()
            return [dict(row) for row in rows]
        finally:
            connection.close()
