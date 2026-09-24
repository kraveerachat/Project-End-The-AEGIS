#!/usr/bin/env python3
"""PROTOTYPE (not wired): READ-ONLY L9 live observation of the running Core's stores.

The Core service itself performs the real Protocol v1 verification (TRANSPORT→SCHEMA→PAYLOAD→TIME→AUTH→SKEW→REPLAY).
An accepted device STATUS leaves exactly one durable row in `protocol_seen_d2c`; this tool only *reads* that store
(and the audit log) as the service account and proves, without any network/serial access and without writing:
  * at least N accepted STATUS rows for the configured device inside a freshness window,
  * zero command rows and zero allocated sequence (no COMMAND was ever issued),
  * zero COMMAND_SENT / COMMAND_QUEUED / DRY_RUN_COMMAND audit events (the event types the Core really writes;
    the action names CUT_UPLINK/RESTORE_UPLINK are never audit event types).
HEARTBEAT (Core → device) is NOT persisted, so it is reported as NOT_OBSERVABLE_FROM_STORE and never as PASS.
Output carries counts and stable codes only — never message ids, MACs, keys or device timestamps.
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

DEVICE_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$")


class L9Error(Exception):
    """Fail-closed condition in the L9 live observer."""


def _open_ro(path: Path) -> sqlite3.Connection:
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise L9Error(f"database must be an existing regular file: {path.name}")
    # A WAL-mode reader may create -shm/-wal sidecars. Running as root would leave root-owned sidecars next to the
    # Core's database and break the Core, so the observer must run as the file owner (the service account).
    if os.geteuid() == 0 or path.stat().st_uid != os.geteuid():
        raise L9Error("RUN_AS_SERVICE_USER: run as the account that owns the database (never root)")
    try:
        con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
        con.execute("PRAGMA query_only=ON")
        con.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except sqlite3.Error as exc:
        raise L9Error(f"database cannot be opened read-only: {path.name}") from exc
    return con


def observe(*, protocol_db: Path, audit_db: Path | None, device_id: str, now: float, window_sec: int, min_status: int) -> dict[str, object]:
    if not DEVICE_RE.fullmatch(device_id):
        raise L9Error("invalid device id")
    result: dict[str, object] = {"L9_HEARTBEAT_EVIDENCE": "NOT_OBSERVABLE_FROM_STORE"}
    con = _open_ro(protocol_db)
    try:
        try:
            status_rows = con.execute(
                "SELECT count(*), max(received_at) FROM protocol_seen_d2c WHERE device_id=? AND kind='STATUS' AND received_at BETWEEN ? AND ?",
                (device_id, now - window_sec, now + 2),
            ).fetchone()
            commands = con.execute("SELECT count(*) FROM protocol_commands").fetchone()[0]
            allocated = con.execute("SELECT coalesce(max(last_allocated_seq), 0) FROM protocol_sequence").fetchone()[0]
        except sqlite3.Error as exc:
            raise L9Error("protocol store schema is not readable") from exc
    finally:
        con.close()
    actuation = 0
    if audit_db is not None:
        acon = _open_ro(audit_db)
        try:
            actuation = acon.execute("SELECT count(*) FROM audit_logs WHERE event_type IN ('COMMAND_SENT', 'COMMAND_QUEUED', 'DRY_RUN_COMMAND')").fetchone()[0]
        except sqlite3.Error as exc:
            raise L9Error("audit log is not readable") from exc
        finally:
            acon.close()
    count, latest = int(status_rows[0]), status_rows[1]
    result.update({
        "L9_STATUS_ACCEPTED_IN_WINDOW": count,
        "L9_LATEST_STATUS_AGE_SEC": None if latest is None else round(now - float(latest), 1),
        "L9_COMMAND_ROWS": int(commands),
        "L9_SEQUENCE_ALLOCATED": int(allocated),
        "L9_ACTUATION_EVENTS": int(actuation),
    })
    reason = None
    if commands or allocated:
        reason = "COMMAND_ROWS_PRESENT"
    elif actuation:
        reason = "ACTUATION_AUDIT_EVENT"
    elif count < min_status:
        reason = "NO_STATUS_IN_WINDOW"
    result["L9_LIVE_OBSERVATION"] = "PASS" if reason is None else "FAIL"
    if reason:
        result["L9_FAILURE_REASON"] = reason
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only L9 live observer (prototype)")
    parser.add_argument("--protocol-db", type=Path, required=True)
    parser.add_argument("--audit-db", type=Path)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--window-sec", type=int, default=120)
    parser.add_argument("--min-status", type=int, default=1)
    args = parser.parse_args(argv)
    try:
        result = observe(protocol_db=args.protocol_db, audit_db=args.audit_db, device_id=args.device_id,
                         now=time.time(), window_sec=args.window_sec, min_status=args.min_status)
    except L9Error as exc:
        print(f"L9_LIVE_OBSERVATION=FAIL reason={exc}", file=sys.stderr)
        return 1
    for key, value in result.items():
        print(f"{key}={value}")
    print("PRODUCTION_MUTATION_PERFORMED=NO")
    return 0 if result["L9_LIVE_OBSERVATION"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
