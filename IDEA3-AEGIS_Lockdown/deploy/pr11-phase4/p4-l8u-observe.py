#!/usr/bin/env python3
"""L8u passive observer: READ-ONLY logical acceptance of the already-provisioned production ESP32 from Core-owned runtime and durable Protocol-v1 evidence.

What it NEVER does: open a serial port, run esptool, reset, flash, provision, publish MQTT, send CUT/RESTORE, write SQLite, write any file, or touch the network. SQLite is opened ``mode=ro``;
the only file it reads besides the databases is the Core runtime status document (through ``/proc/<core pid>/root``) and the pinned historical L8p evidence bundle.

Claim boundary (``L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY``): authenticated Protocol-v1 STATUS observed from the pinned device after the one-attempt marker, the Core runtime reports the pinned state with
time trust SYNCED and the broker CONNECTED, nothing actuated during the window, and the historical L8p evidence bundle matches the pinned device/firmware identity. It does NOT prove the electrical
relay, physical isolation, firmware provenance beyond the historical L8p evidence, or a second independent observation channel.

Modes: ``--capture-boundary`` (rowid/id high-water marks, printed as ``KEY=value`` lines the owner runner stores in the marker), ``--preflight`` (read-only readiness before the attempt is consumed),
``--verify`` (bounded polling until the evidence holds or the deadline passes).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import stat
import sys
import time
from pathlib import Path

AUDIT_DB = Path("/var/lib/aegis-idea3/data/core-audit.sqlite3")
PROTOCOL_DB = Path("/var/lib/aegis-idea3/data/core-protocol.sqlite3")
MARKER = Path("/var/lib/aegis-idea3-governance/L8U-GLOBAL-ATTEMPT-CONSUMED")

EVIDENCE_FIELDS = (
    "schema_version", "run_id", "device_mac", "chip_identity", "flash_size", "firmware_sha256", "nvs_schema_version",
    "nvs_readback_match", "firmware_readback_match", "flash_result", "boot_verification_result", "failure_boundary",
)
STATES = ("LOCKDOWN", "NORMAL")
# Anything the Core records when it ACTUATES (queue/ack a command, run a Recovery step, change mode, close an incident). None may appear during the observation window.
ACTUATION_EVENT_LIKE = ("COMMAND_%", "ACK_RECEIVED", "RECOVERY_%", "MODE_CHANGE", "INCIDENT_CLOSED")


class ObserveError(RuntimeError):
    pass


def _fail(reason: str) -> None:
    raise ObserveError(reason)


def _connect(path: Path) -> sqlite3.Connection:
    try:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as exc:
        _fail(f"DB_UNREADABLE:{type(exc).__name__}")
    raise AssertionError  # pragma: no cover


def _scalar(path: Path, sql: str, args: tuple = ()) -> int:
    con = _connect(path)
    try:
        return int(con.execute(sql, args).fetchone()[0])
    except sqlite3.Error as exc:
        _fail(f"DB_QUERY_FAILED:{type(exc).__name__}")
    finally:
        con.close()
    raise AssertionError  # pragma: no cover


def capture_boundary(audit_db: Path, protocol_db: Path, device_id: str) -> dict[str, int]:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", device_id or ""):
        _fail("DEVICE_ID_INVALID")
    return {
        "L8U_PRE_PROTOCOL_SEEN_ID": _scalar(protocol_db, "SELECT COALESCE(MAX(rowid), 0) FROM protocol_seen_d2c WHERE device_id = ? AND kind = 'STATUS'", (device_id,)),
        "L8U_PRE_AUDIT_ID": _scalar(audit_db, "SELECT COALESCE(MAX(id), 0) FROM audit_logs"),
        "L8U_PRE_COMMAND_ROWID": _scalar(protocol_db, "SELECT COALESCE(MAX(rowid), 0) FROM protocol_commands"),
    }


def read_marker(marker: Path, device_id: str) -> tuple[int, int, int, float]:
    try:
        st = marker.lstat()
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            _fail("L8U_MARKER_NOT_A_REGULAR_FILE")
        values = dict(line.split("=", 1) for line in marker.read_text().splitlines() if "=" in line)
    except (OSError, UnicodeError) as exc:
        _fail(f"L8U_MARKER_UNREADABLE:{type(exc).__name__}")
    if values.get("L8U_ATTEMPT_CONSUMED") != "YES" or values.get("L8U_RERUN_ALLOWED") != "NO" or values.get("L8U_DEVICE_ID") != device_id:
        _fail("L8U_MARKER_NOT_THIS_ATTEMPT")
    try:
        return (int(values["L8U_PRE_PROTOCOL_SEEN_ID"]), int(values["L8U_PRE_AUDIT_ID"]), int(values["L8U_PRE_COMMAND_ROWID"]), float(values["L8U_CONSUMED_AT_EPOCH"]))
    except (KeyError, ValueError):
        _fail("L8U_MARKER_BOUNDARY_INVALID")
    raise AssertionError  # pragma: no cover


def check_l8p_evidence(path: Path, sha256: str, device_mac: str, firmware_sha256: str) -> None:
    """The HISTORICAL L8p provisioning bundle: pinned bytes, exact twelve fields, every PASS the closed L8p required. Read-only predecessor proof; nothing here can rerun anything."""
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        _fail("L8P_EVIDENCE_PIN_INVALID")
    try:
        st = path.lstat()
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode) or st.st_mode & 0o077:
            _fail("L8P_EVIDENCE_NOT_A_PRIVATE_REGULAR_FILE")
        data = path.read_bytes()
    except OSError as exc:
        _fail(f"L8P_EVIDENCE_UNREADABLE:{type(exc).__name__}")
    if hashlib.sha256(data).hexdigest() != sha256:
        _fail("L8P_EVIDENCE_SHA256_MISMATCH")
    try:
        doc = json.loads(data)
    except ValueError:
        _fail("L8P_EVIDENCE_NOT_JSON")
    if not isinstance(doc, dict) or set(doc) != set(EVIDENCE_FIELDS):
        _fail("L8P_EVIDENCE_FIELD_SET_INVALID")
    if doc["schema_version"] != 1:
        _fail("L8P_EVIDENCE_SCHEMA_INVALID")
    if str(doc["device_mac"]).lower() != device_mac.lower():
        _fail("L8P_EVIDENCE_DEVICE_MAC_MISMATCH")
    if doc["firmware_sha256"] != firmware_sha256:
        _fail("L8P_EVIDENCE_FIRMWARE_MISMATCH")
    for key, want in (("nvs_readback_match", "PASS"), ("firmware_readback_match", "PASS"), ("flash_result", "PASS"), ("boot_verification_result", "PASS"), ("failure_boundary", "NONE")):
        if doc[key] != want:
            _fail(f"L8P_EVIDENCE_{key.upper()}_NOT_{want}")


def read_status(core_pid: int, status_path: Path | None = None) -> dict:
    path = status_path or Path(f"/proc/{core_pid}/root/run/aegis-idea3/status.json")
    try:
        status = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        _fail(f"STATUS_UNREADABLE:{type(exc).__name__}")
    if not isinstance(status, dict) or status.get("pid") != core_pid:
        _fail("STATUS_PID_MISMATCH")
    return status


def preflight(core_pid: int, expected_state: str, status_path: Path | None = None) -> None:
    """Readiness BEFORE the one attempt is consumed: the Core runtime already reports the pinned state with time trust SYNCED and the broker CONNECTED. Never starts/repairs anything."""
    if expected_state not in STATES:
        _fail("EXPECTED_STATE_INVALID")
    status = read_status(core_pid, status_path)
    for key, value in (("time_trust", "SYNCED"), ("broker", "CONNECTED"), ("device", "ONLINE"), ("state", expected_state), ("uplink", expected_state)):
        if status.get(key) != value:
            _fail(f"PREFLIGHT_STATUS_{key.upper()}_NOT_EXPECTED")


def verify_once(*, core_pid: int, device_id: str, expected_state: str, marker: Path, audit_db: Path, protocol_db: Path, status_path: Path | None = None) -> None:
    pre_seen, pre_audit, pre_cmd, consumed_at = read_marker(marker, device_id)
    status = read_status(core_pid, status_path)
    try:
        updated_at = float(status["updated_at"])
    except (KeyError, TypeError, ValueError):
        _fail("STATUS_TIMESTAMP_INVALID")
    if updated_at <= consumed_at:
        _fail("STATUS_NOT_REFRESHED_AFTER_THE_ATTEMPT")
    for key, value in (("time_trust", "SYNCED"), ("broker", "CONNECTED"), ("device", "ONLINE"), ("state", expected_state), ("uplink", expected_state)):
        if status.get(key) != value:
            _fail(f"STATUS_{key.upper()}_NOT_EXPECTED")

    con = _connect(protocol_db)
    try:
        seen = con.execute(
            "SELECT rowid, msg_id, received_at FROM protocol_seen_d2c WHERE rowid > ? AND device_id = ? AND kind = 'STATUS' AND received_at > ? ORDER BY rowid DESC LIMIT 1",
            (pre_seen, device_id, consumed_at),
        ).fetchone()
        actuated = con.execute("SELECT COUNT(*) FROM protocol_commands WHERE rowid > ?", (pre_cmd,)).fetchone()[0]
    except sqlite3.Error as exc:
        _fail(f"PROTOCOL_EVIDENCE_UNREADABLE:{type(exc).__name__}")
    finally:
        con.close()
    if not seen or not isinstance(seen[1], str) or not seen[1]:
        _fail("AUTHENTICATED_STATUS_NOT_OBSERVED_AFTER_THE_ATTEMPT")
    if actuated:
        _fail("COMMAND_ISSUED_DURING_OBSERVATION")

    con = _connect(audit_db)
    try:
        status_rows = con.execute(
            "SELECT COUNT(*) FROM audit_logs WHERE id > ? AND event_type = 'DEVICE_STATUS' AND details LIKE ?", (pre_audit, f"{expected_state} (%"),
        ).fetchone()[0]
        clause = " OR ".join("event_type LIKE ?" for _ in ACTUATION_EVENT_LIKE)
        actuation_events = con.execute(f"SELECT COUNT(*) FROM audit_logs WHERE id > ? AND ({clause})", (pre_audit, *ACTUATION_EVENT_LIKE)).fetchone()[0]
    except sqlite3.Error as exc:
        _fail(f"AUDIT_EVIDENCE_UNREADABLE:{type(exc).__name__}")
    finally:
        con.close()
    if not status_rows:
        _fail("DEVICE_STATUS_AUDIT_NOT_OBSERVED_AFTER_THE_ATTEMPT")
    if actuation_events:
        _fail("ACTUATION_EVENT_DURING_OBSERVATION")


def verify(deadline_seconds: int, interval: float = 2.0, **kwargs) -> None:
    deadline = time.monotonic() + deadline_seconds
    last = "NOT_STARTED"
    while True:
        try:
            verify_once(**kwargs)
            return
        except ObserveError as exc:
            last = str(exc)
        if time.monotonic() >= deadline:
            _fail(f"OBSERVATION_DEADLINE:{last}")
        time.sleep(interval)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="L8u passive observer (read-only)")
    mode = parser.add_mutually_exclusive_group(required=True)
    for name in ("capture-boundary", "preflight", "verify", "check-l8p-evidence"):
        mode.add_argument(f"--{name}", action="store_true")
    parser.add_argument("--device-id")
    parser.add_argument("--core-pid", type=int)
    parser.add_argument("--expected-state")
    parser.add_argument("--observe-seconds", type=int)
    parser.add_argument("--device-mac")
    parser.add_argument("--firmware-sha256")
    parser.add_argument("--l8p-evidence-file", type=Path)
    parser.add_argument("--l8p-evidence-sha256")
    args = parser.parse_args(argv)
    try:
        if args.capture_boundary:
            for key, value in capture_boundary(AUDIT_DB, PROTOCOL_DB, args.device_id or "").items():
                print(f"{key}={value}")
            return 0
        if args.check_l8p_evidence:
            check_l8p_evidence(args.l8p_evidence_file, args.l8p_evidence_sha256 or "", args.device_mac or "", args.firmware_sha256 or "")
            print("L8U_L8P_EVIDENCE=PASS historical_provisioning_evidence_only=YES")
            return 0
        if not args.core_pid or args.core_pid <= 0 or args.expected_state not in STATES:
            _fail("INVALID_ARGUMENTS")
        if args.preflight:
            preflight(args.core_pid, args.expected_state)
            print("L8U_PREFLIGHT=PASS")
            return 0
        if not args.device_id or not args.observe_seconds or not 10 <= args.observe_seconds <= 3600:
            _fail("INVALID_ARGUMENTS")
        verify(args.observe_seconds, core_pid=args.core_pid, device_id=args.device_id, expected_state=args.expected_state, marker=MARKER, audit_db=AUDIT_DB, protocol_db=PROTOCOL_DB)
        print(f"L8U_RUNTIME_VERIFY=PASS L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY authenticated_status=OBSERVED state={args.expected_state} actuation=NONE")
        return 0
    except ObserveError as exc:
        print(f"L8U_OBSERVE=FAIL reason={exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
