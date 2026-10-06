#!/usr/bin/env python3
"""Read-only CTu proof from the Core process and its owned audit database."""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


class RuntimeProofError(RuntimeError):
    pass


def _fail(reason: str) -> None:
    raise RuntimeProofError(reason)


def verify_files(status_path: Path, audit_db: Path, core_pid: int, pre_updated_at: float, device_id: str) -> None:
    try:
        status = json.loads(status_path.read_text())
    except (OSError, ValueError) as exc:
        _fail(f"STATUS_UNREADABLE:{type(exc).__name__}")
    if not isinstance(status, dict):
        _fail("STATUS_NOT_OBJECT")
    if status.get("pid") != core_pid:
        _fail("STATUS_PID_MISMATCH")
    try:
        updated_at = float(status["updated_at"])
    except (KeyError, TypeError, ValueError):
        _fail("STATUS_TIMESTAMP_INVALID")
    if updated_at <= pre_updated_at:
        _fail("STATUS_NOT_REFRESHED_BY_CURRENT_CORE")
    expected = {"state": "LOCKDOWN", "time_trust": "SYNCED", "broker": "CONNECTED", "device": "ONLINE", "uplink": "LOCKDOWN"}
    for key, value in expected.items():
        if status.get(key) != value:
            _fail(f"STATUS_{key.upper()}_NOT_EXPECTED")
    try:
        connection = sqlite3.connect(f"file:{audit_db}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        _fail(f"AUDIT_DB_UNREADABLE:{type(exc).__name__}")
    try:
        row = connection.execute(
            "SELECT open_msg_id FROM lockdown_episodes WHERE device_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1",
            (device_id,),
        ).fetchone()
    except sqlite3.Error as exc:
        _fail(f"AUTHENTICATED_STATUS_AUDIT_UNREADABLE:{type(exc).__name__}")
    finally:
        connection.close()
    if not row or not isinstance(row[0], str) or not row[0]:
        _fail("AUTHENTICATED_STATUS_NOT_PROVEN")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core-pid", type=int, required=True)
    parser.add_argument("--pre-updated-at", type=float, required=True)
    parser.add_argument("--device-id", required=True)
    args = parser.parse_args()
    if args.core_pid <= 0 or not args.device_id:
        print("CTU_RUNTIME_VERIFY=FAIL reason=INVALID_BASELINE")
        return 1
    try:
        verify_files(Path(f"/proc/{args.core_pid}/root/run/aegis-idea3/status.json"), Path("/var/lib/aegis-idea3/data/core-audit.sqlite3"), args.core_pid, args.pre_updated_at, args.device_id)
    except RuntimeProofError as exc:
        print(f"CTU_RUNTIME_VERIFY=FAIL reason={exc}")
        return 1
    print("CTU_RUNTIME_VERIFY=PASS authenticated_status=PROVEN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
