#!/usr/bin/env python3
"""Read-only LVR runtime acceptance; all observed values come from live files/services."""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote


class LvrFailure(RuntimeError):
    pass


def fail(code: str) -> None:
    raise LvrFailure(code)


def readonly_db(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        fail("AUDIT_DB_MISSING")
    try:
        conn = sqlite3.connect(f"file:{quote(str(path.resolve()))}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        required = {
            "audit_logs": {"id", "event_type", "incident_id"},
            "incidents": {"id", "state"},
        }
        for table, fields in required.items():
            present = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            if not fields <= present:
                fail(f"AUDIT_DB_SCHEMA_{table}")
        return conn
    except LvrFailure:
        raise
    except sqlite3.Error:
        fail("AUDIT_DB_UNREADABLE")


def service_from_systemd(unit: str, fixture: Path | None) -> dict[str, str]:
    if fixture is not None:
        path = fixture / (unit.replace(".service", "") + ".show")
        if not path.is_file():
            fail(f"SYSTEMD_FIXTURE_MISSING:{unit}")
        return dict(line.split("=", 1) for line in path.read_text().splitlines() if "=" in line)
    try:
        out = subprocess.run(
            ["/usr/bin/systemctl", "show", "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "Result", "-p", "MainPID", "-p", "NRestarts", unit],
            check=False, capture_output=True, text=True, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"},
        )
    except OSError:
        fail("SYSTEMD_UNAVAILABLE")
    if out.returncode:
        fail(f"SYSTEMD_SHOW_FAILED:{unit}")
    return dict(line.split("=", 1) for line in out.stdout.splitlines() if "=" in line)


def verify(args: argparse.Namespace) -> None:
    status_path = Path(args.status)
    try:
        status = json.loads(status_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        fail("STATUS_UNREADABLE")
    if not isinstance(status, dict):
        fail("STATUS_NOT_OBJECT")
    expected = {"broker": "CONNECTED", "device": "ONLINE", "uplink": "NORMAL", "time_trust": "SYNCED"}
    for key, value in expected.items():
        if status.get(key) != value:
            fail(f"STATUS_{key.upper()}_NOT_{value}")
    if status.get("armed") not in ("ARMED", "DISARMED", "MONITOR_ONLY"):
        fail("STATUS_ARMED_INVALID")
    if args.device_id and status.get("device_id") and status.get("device_id") != args.device_id:
        fail("STATUS_DEVICE_ID_MISMATCH")
    pid = status.get("pid")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1:
        fail("STATUS_PID_INVALID")
    updated = status.get("updated_at")
    if isinstance(updated, bool) or not isinstance(updated, (int, float)) or not math.isfinite(float(updated)):
        fail("STATUS_TIMESTAMP_INVALID")
    now = float(args.now) if args.now is not None else time.time()
    if now - float(updated) > args.max_age or float(updated) - now > 60:
        fail("STATUS_STALE")

    core = service_from_systemd("aegis-idea3-core.service", args.systemd_fixture)
    detector = service_from_systemd("aegis-idea3-detector.service", args.systemd_fixture)
    for label, service in (("CORE", core), ("DETECTOR", detector)):
        for key, value in (("LoadState", "loaded"), ("ActiveState", "active"), ("SubState", "running"), ("Result", "success"), ("NRestarts", "0")):
            if service.get(key) != value:
                fail(f"{label}_{key.upper()}_INVALID")
    if str(core.get("MainPID")) != str(pid):
        fail("STATUS_PID_NOT_CURRENT_CORE")
    detector_pid = detector.get("MainPID")
    if not detector_pid or not detector_pid.isdigit() or int(detector_pid) <= 1:
        fail("DETECTOR_PID_INVALID")

    marker = Path(args.recovery_marker)
    try:
        lines = marker.read_text(encoding="utf-8").splitlines()
    except OSError:
        fail("RECOVERY_MARKER_UNREADABLE")
    if marker.is_symlink() or "RECOVERY_ATTEMPT_CONSUMED=YES" not in lines or "RECOVERY_RERUN_ALLOWED=NO" not in lines:
        fail("RECOVERY_MARKER_NOT_CONSUMED_NO_RERUN")

    conn = readonly_db(Path(args.audit_db))
    try:
        open_count = conn.execute("SELECT COUNT(*) FROM incidents WHERE state != 'CLOSED'").fetchone()[0]
        if open_count:
            fail("OPEN_INCIDENT_REMAINS")
        latest_incident = conn.execute("SELECT MAX(id) FROM incidents").fetchone()[0]
        if latest_incident is None:
            fail("RECOVERY_CLOSE_EVIDENCE_MISSING")
        rows = conn.execute("SELECT id, incident_id FROM audit_logs WHERE event_type='RECOVERY_R8_CLOSE' ORDER BY id").fetchall()
        closes = conn.execute("SELECT id, incident_id FROM audit_logs WHERE event_type='INCIDENT_CLOSED' ORDER BY id").fetchall()
        if not rows or not closes:
            fail("RECOVERY_CLOSE_EVIDENCE_MISSING")
        if rows[-1][1] is None or closes[-1][1] != rows[-1][1]:
            fail("RECOVERY_CLOSE_EVENT_NOT_CORRELATED")
        if rows[-1][1] != latest_incident:
            fail("RECOVERY_CLOSE_NOT_LATEST_INCIDENT")
    finally:
        conn.close()
    print("LVR_RUNTIME_PROOF=PASS")
    print("LVR_STATUS_SOURCE=CORE_STATUS_JSON")
    print("LVR_SYSTEMD_SOURCE=SYSTEMD_SHOW")
    print("LVR_RECOVERY_SOURCE=CORE_AUDIT_DB_AND_CANONICAL_MARKER")
    print("LVR_CLAIM_BOUNDARY=LVR_ONLY")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", required=True)
    parser.add_argument("--audit-db", required=True)
    parser.add_argument("--recovery-marker", required=True)
    parser.add_argument("--max-age", type=float, default=300.0)
    parser.add_argument("--systemd-fixture", type=Path)
    parser.add_argument("--now", type=float)
    parser.add_argument("--device-id")
    args = parser.parse_args()
    try:
        verify(args)
    except LvrFailure as exc:
        print(f"LVR_RUNTIME_PROOF=FAIL reason={exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
