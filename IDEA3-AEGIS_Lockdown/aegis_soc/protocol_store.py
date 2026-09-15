"""Durable Protocol v1 Core store (PR11 Phase 4, design §4.7 and §7).

A separate SQLite file beside the dispatch ledger. It owns the per-device
command sequence, one row for every reserved command, and the durable replay
rows for authenticated device evidence. Every write commits with
``synchronous=FULL`` before the caller takes its next irrevocable step (R13).
Evidence rows are closed on restart, never deleted.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from .protocol_v1 import ACK_RESULTS, ACTIONS, KINDS, new_msg_id, valid_device_id

SEQUENCE_CEILING = 2**63 - 1  # SQLite INTEGER is signed 64-bit; the wire allows uint64
SEEN_RETENTION_SEC = 600
OPEN_STATES = ("PUBLISHED", "ACK_CONSUMED")
_UNRESOLVED_STATES = ("RESERVED", "PUBLISHED", "ACK_CONSUMED")
_PRAGMAS = frozenset({"journal_mode", "synchronous"})

_SCHEMA = """
CREATE TABLE IF NOT EXISTS protocol_sequence (
  device_id TEXT PRIMARY KEY,
  last_allocated_seq INTEGER NOT NULL CHECK (last_allocated_seq >= 0)
);
CREATE TABLE IF NOT EXISTS protocol_commands (
  msg_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  action TEXT NOT NULL CHECK (action IN ('CUT_UPLINK', 'RESTORE_UPLINK')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('RESERVED', 'PUBLISHED', 'NOT_PUBLISHED', 'ACK_CONSUMED', 'CLOSED')),
  reserved_at REAL NOT NULL,
  published_at REAL,
  ack_result TEXT,
  ack_msg_id TEXT,
  status_correlated INTEGER NOT NULL DEFAULT 0,
  closed_reason TEXT,
  UNIQUE (device_id, seq)
);
CREATE TABLE IF NOT EXISTS protocol_seen_d2c (
  device_id TEXT NOT NULL,
  msg_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  received_at REAL NOT NULL,
  PRIMARY KEY (device_id, msg_id)
);
"""


class ProtocolStoreError(RuntimeError):
    """The store cannot safely allocate; the caller must not publish."""


@dataclass(frozen=True)
class ReservedCommand:
    device_id: str
    seq: int
    msg_id: str
    action: str
    issued_at: int
    expires_at: int


def _placeholders(values: tuple[str, ...]) -> str:
    return ", ".join("?" for _ in values)


class ProtocolStore:
    def __init__(
        self,
        path: Path | str,
        *,
        wall_clock: Callable[[], float] = time.time,
        msg_id_factory: Callable[[], str] = new_msg_id,
    ) -> None:
        self.path = Path(path)
        if not self.path.is_absolute():
            raise ValueError("the protocol store path must be absolute")
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._clock = wall_clock
        self._msg_id = msg_id_factory
        # MQTT callbacks, the supervisor loop, and dispatch ticks share this store.
        self._lock = threading.RLock()
        self._db = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.execute("PRAGMA synchronous = FULL")
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

    def pragma(self, name: str):
        if name not in _PRAGMAS:
            raise ValueError("unsupported pragma")
        with self._lock:
            return self._db.execute(f"PRAGMA {name}").fetchone()[0]

    def last_allocated_seq(self, device_id: str) -> int:
        with self._lock:
            row = self._db.execute(
                "SELECT last_allocated_seq FROM protocol_sequence WHERE device_id = ?", (device_id,)
            ).fetchone()
        return int(row[0]) if row else 0

    def command(self, msg_id: str) -> dict | None:
        with self._lock:
            row = self._db.execute("SELECT * FROM protocol_commands WHERE msg_id = ?", (msg_id,)).fetchone()
        return dict(row) if row else None

    def reserve_command(self, device_id: str, action: str, issued_at: int, expires_at: int) -> ReservedCommand:
        """Allocate and commit the next sequence number before any publish (design §7 step 2)."""
        if not valid_device_id(device_id):
            raise ValueError("invalid device id")
        if action not in ACTIONS:
            raise ValueError("unsupported action")
        msg_id = self._msg_id()
        with self._transaction() as db:
            row = db.execute(
                "SELECT last_allocated_seq FROM protocol_sequence WHERE device_id = ?", (device_id,)
            ).fetchone()
            last = int(row[0]) if row else 0
            if last >= SEQUENCE_CEILING:
                raise ProtocolStoreError("the command sequence is exhausted; the device must be rekeyed")
            seq = last + 1
            db.execute(
                "INSERT INTO protocol_sequence (device_id, last_allocated_seq) VALUES (?, ?) "
                "ON CONFLICT(device_id) DO UPDATE SET last_allocated_seq = excluded.last_allocated_seq",
                (device_id, seq),
            )
            db.execute(
                "INSERT INTO protocol_commands "
                "(msg_id, device_id, seq, action, issued_at, expires_at, state, reserved_at) "
                "VALUES (?, ?, ?, ?, ?, ?, 'RESERVED', ?)",
                (msg_id, device_id, seq, action, int(issued_at), int(expires_at), self._clock()),
            )
        return ReservedCommand(device_id, seq, msg_id, action, int(issued_at), int(expires_at))

    def _update(self, sql: str, parameters: tuple) -> bool:
        with self._transaction() as db:
            return db.execute(sql, parameters).rowcount == 1

    def mark_published(self, msg_id: str) -> bool:
        return self._update(
            "UPDATE protocol_commands SET state = 'PUBLISHED', published_at = ? WHERE msg_id = ? AND state = 'RESERVED'",
            (self._clock(), msg_id),
        )

    def mark_not_published(self, msg_id: str) -> bool:
        """Nothing was sent; the sequence stays burned and is never reused."""
        return self._update(
            "UPDATE protocol_commands SET state = 'NOT_PUBLISHED' WHERE msg_id = ? AND state = 'RESERVED'", (msg_id,),
        )

    def consume_ack(self, device_id: str, ack_for_msg_id: str, ack_for_seq: int, result: str, ack_msg_id: str) -> bool:
        """An authenticated ACK consumes its open published command exactly once."""
        if result not in ACK_RESULTS:
            raise ValueError("unsupported ACK result")
        return self._update(
            "UPDATE protocol_commands SET state = 'ACK_CONSUMED', ack_result = ?, ack_msg_id = ? "
            "WHERE msg_id = ? AND device_id = ? AND seq = ? AND state = 'PUBLISHED'",
            (result, ack_msg_id, ack_for_msg_id, device_id, int(ack_for_seq)),
        )

    def correlate_status(self, device_id: str, cmd_msg_id: str, cmd_seq: int) -> bool:
        """A COMMAND-reason STATUS confirms an open command once, before or after its ACK."""
        return self._update(
            f"UPDATE protocol_commands SET status_correlated = 1 WHERE msg_id = ? AND device_id = ? AND seq = ? "
            f"AND state IN ({_placeholders(OPEN_STATES)}) AND status_correlated = 0",
            (cmd_msg_id, device_id, int(cmd_seq), *OPEN_STATES),
        )

    def resync_forward(self, device_id: str, *, device_hwm: int, cmd_msg_id: str, cmd_seq: int) -> bool:
        """OD-6: move the allocator forward only, and only for the open correlated command."""
        with self._transaction() as db:
            open_command = db.execute(
                f"SELECT 1 FROM protocol_commands WHERE msg_id = ? AND device_id = ? AND seq = ? "
                f"AND state IN ({_placeholders(OPEN_STATES)})",
                (cmd_msg_id, device_id, int(cmd_seq), *OPEN_STATES),
            ).fetchone()
            if open_command is None:
                return False
            row = db.execute(
                "SELECT last_allocated_seq FROM protocol_sequence WHERE device_id = ?", (device_id,)
            ).fetchone()
            current = int(row[0]) if row else 0
            target = min(int(device_hwm), SEQUENCE_CEILING)
            if target <= current:
                return False
            db.execute(
                "UPDATE protocol_sequence SET last_allocated_seq = ? WHERE device_id = ?", (target, device_id),
            )
            return True

    def record_seen(self, device_id: str, msg_id: str, kind: str) -> bool:
        """Durable replay acceptance: True exactly once per (device, msg_id)."""
        if kind not in KINDS:
            raise ValueError("unsupported kind")
        return self._update(
            "INSERT OR IGNORE INTO protocol_seen_d2c (device_id, msg_id, kind, received_at) VALUES (?, ?, ?, ?)",
            (device_id, msg_id, kind, self._clock()),
        )

    def prune_seen(self, older_than_sec: float = SEEN_RETENTION_SEC) -> int:
        with self._transaction() as db:
            return db.execute(
                "DELETE FROM protocol_seen_d2c WHERE received_at < ?", (self._clock() - older_than_sec,),
            ).rowcount

    def close_open_commands_after_restart(self) -> list[str]:
        """Every unresolved command becomes CLOSED; later evidence for it is ignored."""
        with self._transaction() as db:
            msg_ids = [
                row["msg_id"]
                for row in db.execute(
                    f"SELECT msg_id FROM protocol_commands WHERE state IN ({_placeholders(_UNRESOLVED_STATES)}) "
                    "ORDER BY device_id, seq",
                    _UNRESOLVED_STATES,
                ).fetchall()
            ]
            db.execute(
                f"UPDATE protocol_commands SET state = 'CLOSED', closed_reason = 'CORE_RESTART' "
                f"WHERE state IN ({_placeholders(_UNRESOLVED_STATES)})",
                _UNRESOLVED_STATES,
            )
            return msg_ids
