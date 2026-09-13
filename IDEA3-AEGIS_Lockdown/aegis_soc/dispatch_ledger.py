"""Durable Core dispatch ledger for the PR10 S2 Server -> Core boundary (spec §5.1).

The ledger is a separate SQLite file, so the hash-chained Core audit database
stays untouched. Every state change is committed before its side effect runs.
The firmware nonce stays Core-local, and only CUT_UPLINK can ever enter the
ledger. Each Core-reported stage appends one reconciliation-outbox row whose
format matches the evidence the server accepts.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

CUT_UPLINK = "CUT_UPLINK"
DISPATCHABLE_ACTIONS = frozenset({CUT_UPLINK})
UNRESOLVED_STATES = ("CLAIM_REQUESTED", "CLAIMED", "PUBLISHED", "ACK_RECEIVED")
IN_FLIGHT_STATES = ("PUBLISHED", "ACK_RECEIVED")
DEVICE_STATES = ("NORMAL", "LOCKDOWN")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS core_dispatch_actions (
  action_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action = 'CUT_UPLINK'),
  expires_at REAL NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'CLAIM_REQUESTED', 'CLAIMED', 'PUBLISHED', 'ACK_RECEIVED', 'STATUS_CORRELATED',
    'DRY_RUN_ONLY', 'FAILED', 'EXPIRED_AT_CORE', 'CLAIM_REJECTED', 'OUTCOME_UNKNOWN')),
  nonce TEXT,
  claim_requested_at REAL NOT NULL,
  published_at REAL,
  ack_at REAL,
  updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS core_reconciliation_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL REFERENCES core_dispatch_actions(action_id),
  sequence INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN (
    'PUBLISHED', 'DRY_RUN', 'ACK', 'STATUS', 'OUTCOME_UNKNOWN', 'EXPIRED_AT_CORE', 'FAILED')),
  observed_at TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  delivered_at REAL,
  disposition TEXT CHECK (disposition IN ('DELIVERED', 'REJECTED_BY_SERVER')),
  UNIQUE (action_id, sequence)
);
"""


def evidence_timestamp(epoch_seconds: float) -> str:
    """Render a Core wall-clock time in the canonical form the server accepts."""
    moment = datetime.fromtimestamp(epoch_seconds, tz=timezone.utc)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


def _placeholders(values: tuple[str, ...]) -> str:
    return ", ".join("?" for _ in values)


class DispatchLedger:
    """Forward-only Core record of claimed dispatch actions and their evidence."""

    def __init__(self, path: Path, *, wall_clock: Callable[[], float] = time.time):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._clock = wall_clock
        # Worker ticks and MQTT callbacks run on different threads; the lock serializes them.
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.executescript(_SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._db.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            self._db.execute("BEGIN IMMEDIATE")
            try:
                yield self._db
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
            else:
                self._db.execute("COMMIT")

    def _append_outbox(self, db: sqlite3.Connection, action_id: str, stage: str, detail: dict, now: float) -> None:
        sequence = db.execute(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM core_reconciliation_outbox WHERE action_id = ?",
            (action_id,),
        ).fetchone()[0]
        db.execute(
            "INSERT INTO core_reconciliation_outbox (action_id, sequence, stage, observed_at, detail_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (action_id, sequence, stage, evidence_timestamp(now), json.dumps(detail, sort_keys=True, separators=(",", ":"))),
        )

    def _has_evidence(self, db: sqlite3.Connection, action_id: str, stage: str, detail: dict) -> bool:
        return db.execute(
            "SELECT 1 FROM core_reconciliation_outbox WHERE action_id = ? AND stage = ? AND detail_json = ?",
            (action_id, stage, json.dumps(detail, sort_keys=True, separators=(",", ":"))),
        ).fetchone() is not None

    def _transition(
        self,
        db: sqlite3.Connection,
        action_id: str,
        target: str,
        allowed: tuple[str, ...],
        *,
        now: float,
        stage: str | None = None,
        detail: dict | None = None,
        **columns: object,
    ) -> bool:
        assignments = "".join(f", {column} = ?" for column in columns)
        cursor = db.execute(
            f"UPDATE core_dispatch_actions SET state = ?, updated_at = ?{assignments} "
            f"WHERE action_id = ? AND state IN ({_placeholders(allowed)})",
            (target, now, *columns.values(), action_id, *allowed),
        )
        if cursor.rowcount != 1:
            return False
        if stage is not None:
            self._append_outbox(db, action_id, stage, detail or {}, now)
        return True

    def get(self, action_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM core_dispatch_actions WHERE action_id = ?", (action_id,)).fetchone()
        return dict(row) if row else None

    def begin_claim(self, action_id: str, action: str, expires_at: float) -> bool:
        """Durably record the intent to claim before any claim is sent; False on replay."""
        if action not in DISPATCHABLE_ACTIONS:
            raise ValueError("Only CUT_UPLINK can be dispatched")
        with self._transaction() as db:
            if db.execute("SELECT 1 FROM core_dispatch_actions WHERE action_id = ?", (action_id,)).fetchone():
                return False
            now = self._clock()
            db.execute(
                "INSERT INTO core_dispatch_actions "
                "(action_id, action, expires_at, state, claim_requested_at, updated_at) "
                "VALUES (?, ?, ?, 'CLAIM_REQUESTED', ?, ?)",
                (action_id, action, float(expires_at), now, now),
            )
            return True

    def mark_claimed(self, action_id: str) -> bool:
        with self._transaction() as db:
            return self._transition(db, action_id, "CLAIMED", ("CLAIM_REQUESTED",), now=self._clock())

    def mark_claim_rejected(self, action_id: str) -> bool:
        """The server refused the claim; nothing was published and nothing is reported."""
        with self._transaction() as db:
            return self._transition(db, action_id, "CLAIM_REJECTED", ("CLAIM_REQUESTED",), now=self._clock())

    def mark_published(self, action_id: str, nonce: str) -> bool:
        with self._transaction() as db:
            now = self._clock()
            return self._transition(
                db, action_id, "PUBLISHED", ("CLAIMED",), now=now, stage="PUBLISHED", nonce=nonce, published_at=now,
            )

    def mark_dry_run(self, action_id: str, nonce: str | None) -> bool:
        with self._transaction() as db:
            return self._transition(
                db, action_id, "DRY_RUN_ONLY", ("CLAIMED",), now=self._clock(), stage="DRY_RUN", nonce=nonce,
            )

    def mark_failed(self, action_id: str, reason_code: str) -> bool:
        with self._transaction() as db:
            return self._transition(
                db, action_id, "FAILED", ("CLAIMED",), now=self._clock(),
                stage="FAILED", detail={"reasonCode": reason_code},
            )

    def mark_expired_at_core(self, action_id: str) -> bool:
        with self._transaction() as db:
            return self._transition(
                db, action_id, "EXPIRED_AT_CORE", ("CLAIMED",), now=self._clock(), stage="EXPIRED_AT_CORE",
            )

    def mark_outcome_unknown(self, action_id: str, reason_code: str) -> bool:
        """Any unresolved action may become OUTCOME_UNKNOWN for human review; never retried."""
        with self._transaction() as db:
            return self._transition(
                db, action_id, "OUTCOME_UNKNOWN", UNRESOLVED_STATES, now=self._clock(),
                stage="OUTCOME_UNKNOWN", detail={"reasonCode": reason_code},
            )

    def record_ack(self, nonce: str, ack: str) -> str | None:
        """Correlate an ACK by nonce with a published action; a mismatch returns None."""
        if not nonce:
            return None
        with self._transaction() as db:
            row = db.execute(
                "SELECT action_id FROM core_dispatch_actions WHERE nonce = ? AND state = 'PUBLISHED'", (nonce,),
            ).fetchone()
            if row is None:
                return None
            action_id = row["action_id"]
            now = self._clock()
            if ack != "OK":
                self._transition(
                    db, action_id, "OUTCOME_UNKNOWN", ("PUBLISHED",), now=now,
                    stage="OUTCOME_UNKNOWN", detail={"reasonCode": "ACK_NOT_OK"},
                )
                return action_id
            self._transition(
                db, action_id, "ACK_RECEIVED", ("PUBLISHED",), now=now, stage="ACK", detail={"ackCode": "OK"}, ack_at=now,
            )
            # A LOCKDOWN STATUS may arrive before the ACK; it is correlated once the ACK is in.
            if self._has_evidence(db, action_id, "STATUS", {"deviceState": "LOCKDOWN"}):
                self._transition(db, action_id, "STATUS_CORRELATED", ("ACK_RECEIVED",), now=now)
            return action_id

    def record_status(self, nonce: str, device_state: str) -> str | None:
        """Record a nonce-correlated device STATUS once; LOCKDOWN after an ACK correlates it."""
        if not nonce or device_state not in DEVICE_STATES:
            return None
        with self._transaction() as db:
            row = db.execute(
                f"SELECT action_id, state FROM core_dispatch_actions "
                f"WHERE nonce = ? AND state IN ({_placeholders(IN_FLIGHT_STATES)})",
                (nonce, *IN_FLIGHT_STATES),
            ).fetchone()
            if row is None:
                return None
            action_id = row["action_id"]
            detail = {"deviceState": device_state}
            if self._has_evidence(db, action_id, "STATUS", detail):
                return action_id
            now = self._clock()
            if device_state == "LOCKDOWN" and row["state"] == "ACK_RECEIVED":
                self._transition(db, action_id, "STATUS_CORRELATED", ("ACK_RECEIVED",), now=now, stage="STATUS", detail=detail)
            else:
                self._append_outbox(db, action_id, "STATUS", detail, now)
            return action_id

    def mark_stale_outcomes(self, *, ack_timeout_sec: float, status_timeout_sec: float) -> list[str]:
        """Published without an ACK, or acknowledged without a correlated STATUS, in time."""
        stale: list[str] = []
        with self._transaction() as db:
            now = self._clock()
            checks = (
                ("PUBLISHED", "published_at", ack_timeout_sec, "ACK_TIMEOUT"),
                ("ACK_RECEIVED", "ack_at", status_timeout_sec, "STATUS_TIMEOUT"),
            )
            for state, column, timeout, reason in checks:
                rows = db.execute(
                    f"SELECT action_id FROM core_dispatch_actions WHERE state = ? AND {column} + ? <= ? "
                    "ORDER BY claim_requested_at, action_id",
                    (state, timeout, now),
                ).fetchall()
                for row in rows:
                    if self._transition(
                        db, row["action_id"], "OUTCOME_UNKNOWN", (state,), now=now,
                        stage="OUTCOME_UNKNOWN", detail={"reasonCode": reason},
                    ):
                        stale.append(row["action_id"])
        return stale

    def recover_after_restart(self) -> list[str]:
        """Every unresolved action becomes OUTCOME_UNKNOWN; nothing is ever republished."""
        with self._transaction() as db:
            now = self._clock()
            action_ids = [
                row["action_id"]
                for row in db.execute(
                    f"SELECT action_id FROM core_dispatch_actions WHERE state IN ({_placeholders(UNRESOLVED_STATES)}) "
                    "ORDER BY claim_requested_at, action_id",
                    UNRESOLVED_STATES,
                ).fetchall()
            ]
            for action_id in action_ids:
                self._transition(
                    db, action_id, "OUTCOME_UNKNOWN", UNRESOLVED_STATES, now=now,
                    stage="OUTCOME_UNKNOWN", detail={"reasonCode": "CORE_RESTART"},
                )
            return action_ids

    def in_flight(self) -> bool:
        with self._lock:
            return self._db.execute(
                f"SELECT 1 FROM core_dispatch_actions WHERE state IN ({_placeholders(IN_FLIGHT_STATES)}) LIMIT 1",
                IN_FLIGHT_STATES,
            ).fetchone() is not None

    def pending_outbox(self, limit: int = 100) -> list[dict]:
        """Undelivered evidence in the order it was recorded."""
        with self._lock:
            rows = self._db.execute(
                "SELECT id, action_id, sequence, stage, observed_at, detail_json FROM core_reconciliation_outbox "
                "WHERE disposition IS NULL ORDER BY id LIMIT ?",
                (limit,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "action_id": row["action_id"],
                "sequence": row["sequence"],
                "stage": row["stage"],
                "observed_at": row["observed_at"],
                "detail": json.loads(row["detail_json"]),
            }
            for row in rows
        ]

    def _dispose(self, outbox_id: int, disposition: str) -> bool:
        with self._transaction() as db:
            return db.execute(
                "UPDATE core_reconciliation_outbox SET disposition = ?, delivered_at = ? "
                "WHERE id = ? AND disposition IS NULL",
                (disposition, self._clock(), outbox_id),
            ).rowcount == 1

    def mark_outbox_delivered(self, outbox_id: int) -> bool:
        return self._dispose(outbox_id, "DELIVERED")

    def mark_outbox_rejected(self, outbox_id: int) -> bool:
        """The server definitively refused this evidence (4xx); it is kept, never resent."""
        return self._dispose(outbox_id, "REJECTED_BY_SERVER")

    def outbox_dispositions(self, action_id: str) -> list[tuple[int, str | None]]:
        with self._lock:
            return [
                (row["sequence"], row["disposition"])
                for row in self._db.execute(
                    "SELECT sequence, disposition FROM core_reconciliation_outbox WHERE action_id = ? ORDER BY sequence",
                    (action_id,),
                ).fetchall()
            ]
