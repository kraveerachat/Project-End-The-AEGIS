#!/usr/bin/env python3
"""Read-only CTu proof from Core-owned runtime and durable Protocol-v1 evidence."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
import re
from pathlib import Path


class RuntimeProofError(RuntimeError):
    pass


def _fail(reason: str) -> None:
    raise RuntimeProofError(reason)


def _connect(path: Path) -> sqlite3.Connection:
    try:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.Error as exc:
        _fail(f"AUDIT_DB_UNREADABLE:{type(exc).__name__}")


def capture_boundary(audit_db: Path, protocol_db: Path, device_id: str) -> tuple[int, int, int, int, int]:
    if not device_id:
        _fail("DEVICE_ID_INVALID")
    protocol = _connect(protocol_db)
    try:
        row = protocol.execute(
            "SELECT COALESCE(MAX(rowid), 0) FROM protocol_seen_d2c "
            "WHERE device_id = ? AND kind = 'STATUS'",
            (device_id,),
        ).fetchone()
    except sqlite3.Error as exc:
        _fail(f"PROTOCOL_DB_UNREADABLE:{type(exc).__name__}")
    finally:
        protocol.close()
    audit = _connect(audit_db)
    try:
        audit_row = audit.execute("SELECT COALESCE(MAX(id), 0) FROM audit_logs").fetchone()
        episode_row = audit.execute(
            "SELECT COALESCE(MAX(id), 0) FROM lockdown_episodes WHERE device_id = ?",
            (device_id,),
        ).fetchone()
        open_episode = audit.execute(
            "SELECT COUNT(*), COALESCE(MAX(id), 0) FROM lockdown_episodes "
            "WHERE device_id = ? AND closed_at IS NULL",
            (device_id,),
        ).fetchone()
    except sqlite3.Error as exc:
        _fail(f"AUDIT_LOG_UNREADABLE:{type(exc).__name__}")
    finally:
        audit.close()
    return int(row[0]), int(audit_row[0]), int(episode_row[0]), int(open_episode[0]), int(open_episode[1])


def _read_boundary(marker_path: Path, device_id: str) -> tuple[int, int, int, int, int, float]:
    try:
        values = {}
        for line in marker_path.read_text().splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
    except (OSError, UnicodeError) as exc:
        _fail(f"CTU_MARKER_UNREADABLE:{type(exc).__name__}")
    if values.get("CTU_ATTEMPT_CONSUMED") != "YES" or values.get("CTU_RERUN_ALLOWED") != "NO":
        _fail("CTU_MARKER_NOT_CONSUMED")
    if values.get("CTU_DEVICE_ID") != device_id:
        _fail("CTU_MARKER_DEVICE_MISMATCH")
    try:
        consumed_at = float(values["CTU_CONSUMED_AT_EPOCH"])
    except (KeyError, TypeError, ValueError):
        _fail("CTU_MARKER_CONSUMED_TIME_INVALID")
    try:
        protocol_id = int(values["CTU_PRE_PROTOCOL_SEEN_ID"])
        audit_id = int(values["CTU_PRE_AUDIT_ID"])
        episode_id = int(values["CTU_PRE_EPISODE_ID"])
        open_count = int(values["CTU_PRE_OPEN_EPISODE_COUNT"])
        open_id = int(values["CTU_PRE_OPEN_EPISODE_ID"])
    except (KeyError, TypeError, ValueError):
        _fail("CTU_MARKER_BOUNDARY_INVALID")
    if protocol_id < 0 or audit_id < 0 or episode_id < 0:
        _fail("CTU_MARKER_BOUNDARY_INVALID")
    if open_count not in (0, 1) or open_id < 0 or (open_count == 0 and open_id != 0):
        _fail("CTU_MARKER_OPEN_EPISODE_BOUNDARY_INVALID")
    return protocol_id, audit_id, episode_id, open_count, open_id, consumed_at


def _process_start_epoch(core_pid: int) -> float:
    try:
        btime = float(next(line.split()[1] for line in Path("/proc/stat").read_text().splitlines() if line.startswith("btime ")))
        stat = Path(f"/proc/{core_pid}/stat").read_text()
        start_ticks = int(stat.rsplit(")", 1)[1].split()[19])
        return btime + start_ticks / os.sysconf(os.sysconf_names["SC_CLK_TCK"])
    except (OSError, StopIteration, IndexError, ValueError, KeyError):
        _fail("CORE_PROCESS_START_UNREADABLE")


def _systemd_timestamp_epoch(value: str) -> float:
    value = value.strip()
    for fmt in ("%a %Y-%m-%d %H:%M:%S %Z", "%a %Y-%m-%d %H:%M:%S %z", "%Y-%m-%d %H:%M:%S %Z"):
        try:
            parsed = dt.datetime.strptime(value, fmt)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=dt.timezone.utc)
            return parsed.timestamp()
        except ValueError:
            continue
    _fail("CORE_SYSTEMD_START_TIMESTAMP_INVALID")


def verify_detector(
    pre: dict[str, str],
    post: dict[str, str],
    core_post_monotonic: int,
    post_apply: dict[str, str] | None = None,
) -> None:
    """Prove the single clean detector invocation expected after Core restart."""
    if pre.get("nrestarts") != "0" or post.get("nrestarts") != "0":
        _fail("DETECTOR_UNEXPECTED_RESTART_COUNT")
    for key, value in (("load", "loaded"), ("active", "active"), ("sub", "running"), ("unit_file", "disabled"), ("restart", "no")):
        if post.get(key) != value:
            _fail(f"DETECTOR_{key.upper()}_INVALID")
    if post.get("process_count") not in (None, "1", 1):
        _fail("DETECTOR_PROCESS_COUNT_INVALID")
    if not re.fullmatch(r"[1-9][0-9]*", post.get("pid", "")) or post.get("pid") == pre.get("pid"):
        _fail("DETECTOR_PID_TRANSITION_INVALID")
    if not pre.get("pid", "").isdigit() or not pre.get("start") or post.get("start") == pre.get("start"):
        _fail("DETECTOR_START_TRANSITION_INVALID")
    if not re.fullmatch(r"[0-9a-f]{32}", pre.get("invocation", "")) or not re.fullmatch(r"[0-9a-f]{32}", post.get("invocation", "")):
        _fail("DETECTOR_INVOCATION_INVALID")
    if post["invocation"] == pre["invocation"]:
        _fail("DETECTOR_INVOCATION_UNCHANGED")
    try:
        pre_mono = int(pre["monotonic"])
        post_mono = int(post["monotonic"])
    except (KeyError, TypeError, ValueError):
        _fail("DETECTOR_MONOTONIC_START_UNAVAILABLE")
    if post_mono <= pre_mono or post_mono <= core_post_monotonic or post_mono > core_post_monotonic + 30_000_000:
        _fail("DETECTOR_START_AFTER_CORE")
    if post_apply is not None:
        for key in ("pid", "start", "invocation", "monotonic", "nrestarts", "active", "sub", "result"):
            if key in post_apply and post.get(key) != post_apply.get(key):
                _fail(f"DETECTOR_CHANGED_AFTER_APPLY:{key.upper()}")
        if post_apply.get("pid") == pre.get("pid") or post_apply.get("invocation") == pre.get("invocation"):
            _fail("DETECTOR_APPLY_IDENTITY_NOT_NEW")


def verify_files(
    status_path: Path,
    audit_db: Path,
    protocol_db: Path,
    marker_path: Path,
    core_pid: int,
    pre_updated_at: float,
    device_id: str,
    process_start_epoch: float | None = None,
    post_core_start_timestamp: str | None = None,
) -> None:
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
    if process_start_epoch is not None:
        post_start_epoch = process_start_epoch
    elif post_core_start_timestamp is not None:
        post_start_epoch = _systemd_timestamp_epoch(post_core_start_timestamp)
    else:
        _fail("CORE_PRECISE_START_BOUNDARY_REQUIRED")
    if updated_at <= post_start_epoch:
        _fail("STATUS_NOT_POST_RESTART")
    expected = {"state": "LOCKDOWN", "time_trust": "SYNCED", "broker": "CONNECTED", "device": "ONLINE", "uplink": "LOCKDOWN"}
    for key, value in expected.items():
        if status.get(key) != value:
            _fail(f"STATUS_{key.upper()}_NOT_EXPECTED")

    pre_protocol_id, pre_audit_id, pre_episode_id, pre_open_count, pre_open_id, consumed_at = _read_boundary(marker_path, device_id)
    protocol = _connect(protocol_db)
    try:
        seen = protocol.execute(
            "SELECT rowid, msg_id, received_at FROM protocol_seen_d2c "
            "WHERE rowid > ? AND device_id = ? AND kind = 'STATUS' "
            "AND received_at > ? ORDER BY rowid DESC LIMIT 1",
            (pre_protocol_id, device_id, max(pre_updated_at, consumed_at, post_start_epoch)),
        ).fetchone()
    except sqlite3.Error as exc:
        _fail(f"PROTOCOL_STATUS_EVIDENCE_UNREADABLE:{type(exc).__name__}")
    finally:
        protocol.close()
    if not seen or not isinstance(seen[1], str) or not seen[1]:
        _fail("AUTHENTICATED_STATUS_NOT_POST_RESTART")
    protocol_msg_id = seen[1]

    audit = _connect(audit_db)
    try:
        if pre_open_count == 0:
            # When no episode existed at PRE, the same accepted STATUS must
            # open the new episode.  An audit row is never an identity source.
            episode = audit.execute(
                "SELECT id, open_msg_id FROM lockdown_episodes "
                "WHERE id > ? AND device_id = ? AND open_msg_id = ? AND closed_at IS NULL "
                "ORDER BY id DESC LIMIT 1",
                (pre_episode_id, device_id, protocol_msg_id),
            ).fetchone()
            if not episode:
                _fail("AUTHENTICATED_STATUS_NOT_CORRELATED")
        else:
            # A legitimate already-open episode may remain open across the
            # restart.  It is not itself post-restart proof: the new Core must
            # still have accepted a fresh STATUS for the configured device and
            # report the current LOCKDOWN state above.  Require exactly the
            # one PRE-bound open episode and reject any newly ambiguous state.
            open_rows = audit.execute(
                "SELECT id, open_msg_id FROM lockdown_episodes "
                "WHERE device_id = ? AND closed_at IS NULL ORDER BY id",
                (device_id,),
            ).fetchall()
            if len(open_rows) != 1 or int(open_rows[0][0]) != pre_open_id:
                _fail("PRE_OPEN_LOCKDOWN_EPISODE_CHANGED")
            episode = open_rows[0]
    except sqlite3.Error as exc:
        _fail(f"LOCKDOWN_EPISODE_UNREADABLE:{type(exc).__name__}")
    finally:
        audit.close()
    if not episode or not isinstance(episode[1], str) or not episode[1]:
        _fail("LOCKDOWN_EPISODE_IDENTITY_INVALID")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--capture-boundary", action="store_true")
    parser.add_argument("--verify-detector", action="store_true")
    parser.add_argument("--core-pid", type=int)
    parser.add_argument("--pre-updated-at", type=float)
    parser.add_argument("--device-id", required=True)
    parser.add_argument("--core-post-monotonic", type=int)
    parser.add_argument("--post-core-start-timestamp")
    for prefix in ("pre", "post"):
        parser.add_argument(f"--{prefix}-detector-pid")
        parser.add_argument(f"--{prefix}-detector-start")
        parser.add_argument(f"--{prefix}-detector-invocation")
        parser.add_argument(f"--{prefix}-detector-nrestarts")
        parser.add_argument(f"--{prefix}-detector-monotonic")
    parser.add_argument("--post-detector-load")
    parser.add_argument("--post-detector-active")
    parser.add_argument("--post-detector-sub")
    parser.add_argument("--post-detector-unit-file")
    parser.add_argument("--post-detector-restart")
    args = parser.parse_args()
    if args.verify_detector:
        try:
            if args.core_post_monotonic is None:
                _fail("CORE_POST_MONOTONIC_INVALID")
            verify_detector(
                {"pid": args.pre_detector_pid, "start": args.pre_detector_start, "invocation": args.pre_detector_invocation, "nrestarts": args.pre_detector_nrestarts, "monotonic": args.pre_detector_monotonic},
                {"pid": args.post_detector_pid, "start": args.post_detector_start, "invocation": args.post_detector_invocation, "nrestarts": args.post_detector_nrestarts, "monotonic": args.post_detector_monotonic, "load": args.post_detector_load, "active": args.post_detector_active, "sub": args.post_detector_sub, "unit_file": args.post_detector_unit_file, "restart": args.post_detector_restart},
                args.core_post_monotonic,
            )
        except RuntimeProofError as exc:
            print(f"CTU_DETECTOR_VERIFY=FAIL reason={exc}")
            return 1
        print("CTU_DETECTOR_VERIFY=PASS implicit_requires_consequence=PROVEN")
        return 0
    audit_db = Path("/var/lib/aegis-idea3/data/core-audit.sqlite3")
    protocol_db = Path("/var/lib/aegis-idea3/data/core-protocol.sqlite3")
    if args.capture_boundary:
        try:
            protocol_id, audit_id, episode_id, open_count, open_id = capture_boundary(audit_db, protocol_db, args.device_id)
        except RuntimeProofError as exc:
            print(f"CTU_BOUNDARY=FAIL reason={exc}")
            return 1
        print(f"CTU_PRE_PROTOCOL_SEEN_ID={protocol_id}")
        print(f"CTU_PRE_AUDIT_ID={audit_id}")
        print(f"CTU_PRE_EPISODE_ID={episode_id}")
        print(f"CTU_PRE_OPEN_EPISODE_COUNT={open_count}")
        print(f"CTU_PRE_OPEN_EPISODE_ID={open_id}")
        return 0
    if args.core_pid is None or args.pre_updated_at is None or args.core_pid <= 0:
        print("CTU_RUNTIME_VERIFY=FAIL reason=INVALID_BASELINE")
        return 1
    try:
        # The process start tick is the precise kernel boundary.  The
        # second-precision systemd wall timestamp remains a compatibility
        # fallback only for direct test callers that provide it explicitly.
        precise_start = _process_start_epoch(args.core_pid)
        verify_files(
            Path(f"/proc/{args.core_pid}/root/run/aegis-idea3/status.json"),
            audit_db,
            protocol_db,
            Path("/var/lib/aegis-idea3-governance/CTU-GLOBAL-ATTEMPT-CONSUMED"),
            args.core_pid,
            args.pre_updated_at,
            args.device_id,
            process_start_epoch=precise_start,
        )
    except RuntimeProofError as exc:
        print(f"CTU_RUNTIME_VERIFY=FAIL reason={exc}")
        return 1
    print("CTU_RUNTIME_VERIFY=PASS authenticated_status=POST_RESTART_PROVEN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
