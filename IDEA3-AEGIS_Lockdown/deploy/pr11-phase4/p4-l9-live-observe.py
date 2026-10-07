#!/usr/bin/env python3
"""L9 LIVE backend: read-only observation of the RUNNING Core's own authenticated evidence.

Repository tooling for the live-capable L9 successor (OD-L9-01a: "Core-side observation").

What it does: it takes a PRE boundary, watches the running Core for a bounded window, and proves from
canonical Core-owned sources that the real device kept talking to the real Core with authenticated, fresh,
non-replayed Protocol-v1 STATUS frames, continuously over the WHOLE window, while L9 did nothing.

What it never does: it opens no socket and no serial port, publishes nothing, issues no COMMAND, sends no
heartbeat of its own, injects no probe frame, generates no key, starts/stops/restarts no service, and writes
only (a) the stage-local evidence bundle and (b) one exclusive "marker used" claim next to the canonical
attempt marker. The only systemd verb it may run is ``show``. There are no override flags: every source path
is fixed in this file and the tests drive the pure functions with injected sources.

SQLite: every handle is opened ``mode=ro`` with ``PRAGMA query_only=ON`` and only SELECT statements exist in
this file, so no INSERT/UPDATE/DELETE/DDL is ever issued and the logical database content cannot change.
``immutable=1`` is deliberately NOT used: it would hide uncheckpointed WAL data. SQLite may still maintain its
own read-side WAL/SHM coordination state; this tool therefore claims LOGICAL read-only behaviour, not
byte-for-byte filesystem immutability.

Acceptance rules (the first violated one is the ``failure_boundary``):
* ONLY canonical ``protocol_seen_d2c`` rows (kind STATUS, the observed device) count as authenticated
  evidence: a row exists only after TRANSPORT, SCHEMA, AUTH, SKEW and REPLAY all passed in the Core.
* The audit ``DEVICE_STATUS`` rows are used ONLY to classify those protocol rows (reason / output state). Each
  audit row must correlate, in order and in time, with its protocol row. An audit-only row (for example a
  legacy unsigned STATUS) is a failure, never evidence; unrelated audit growth is ignored.
* Continuity over the WHOLE window: the first row near the window start, every internal gap bounded, the last
  row near the window end, and every row's ``received_at`` inside the window.
* The consumed-attempt marker is bound to this exact invocation (run id, main, runner SHA, work and evidence
  paths, device), must be fresh, and can be used exactly once.

Honest limits (recorded in every bundle): negative probes are NOT injected live
(``negative_probe_coverage=REPOSITORY_FIXTURE_ONLY``), and the device-side heartbeat effect has no outward
signal by design, so it is evidenced only indirectly (``NO_DEADMAN_OVER_WINDOW``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import stat
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

AUDIT_DB = Path("/var/lib/aegis-idea3/data/core-audit.sqlite3")
PROTOCOL_DB = Path("/var/lib/aegis-idea3/data/core-protocol.sqlite3")
SYSTEMCTL = "/usr/bin/systemctl"
CORE_UNIT = "aegis-idea3-core.service"
DETECTOR_UNIT = "aegis-idea3-detector.service"

EVIDENCE_NAME = "l9-live-evidence.json"
EVIDENCE_CLASS = "LIVE_CORE_OBSERVATION"
SCHEMA_VERSION = "l9-live-evidence-v2"

DEADMAN_SECONDS = 60          # protocol design: device dead-man window
STATUS_INTERVAL_SECONDS = 30  # firmware STATUS_INTERVAL_MS
MIN_WINDOW_SECONDS = 2 * DEADMAN_SECONDS      # two full dead-man windows without a DEADMAN status
MAX_WINDOW_SECONDS = 900
MIN_PERIODIC_ROWS = 3
MAX_STATUS_GAP_SECONDS = STATUS_INTERVAL_SECONDS + 15   # also bounds the silence at both window edges
EDGE_SKEW_SECONDS = 2.0       # clock jitter allowed for a row stamped just outside the window
AUDIT_DELAY_SECONDS = 5.0     # the audit row follows its protocol row within this many seconds
AUDIT_GRACE_SECONDS = 6.0     # a protocol row younger than this at the end may not have its audit row yet
POLL_SECONDS = 5.0
# Marker lifecycle: the stage must start within this long after the runner consumed the attempt, the PRE boundary
# is taken inside the same moment, and the observation may overrun its budget by at most two status periods.
MAX_START_DELAY_SECONDS = 120.0
MAX_BOUNDARY_SKEW_SECONDS = 30.0
MAX_OVERRUN_SECONDS = 2 * STATUS_INTERVAL_SECONDS

CANONICAL_DIR = Path("/var/lib/aegis-idea3-governance")
MARKER_NAME = "L9-GLOBAL-ATTEMPT-CONSUMED"
USED_NAME = "L9-OBSERVATION-USED"
SEAM_ENABLED = "AEGIS_L9_TEST_ONLY_CANONICAL_DIR_ENABLED"
SEAM_DIR = "AEGIS_L9_TEST_ONLY_CANONICAL_DIR"

_AUDIT_STATUS = re.compile(r"([A-Z][A-Z_]{1,30}) \(([A-Z][A-Z_]{1,30})\)")
_DEVICE_ID = re.compile(r"[a-z0-9][a-z0-9-]{1,30}[a-z0-9]")
_RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_HEX40 = re.compile(r"[0-9a-f]{40}")
_HEX64 = re.compile(r"[0-9a-f]{64}")

EVIDENCE_FIELDS = (
    "schema_version", "run_id", "evidence_class", "device_id", "expected_main", "runner_sha256",
    "marker_consumed_epoch", "window_start_epoch", "window_end_epoch",
    "pre_protocol_seen_rowid", "until_protocol_seen_rowid", "pre_audit_id", "until_audit_id",
    "observation_window_seconds", "core_pid", "core_pid_unchanged", "core_restart_count_unchanged",
    "detector_invocation_unchanged", "status_rows_observed", "periodic_rows_observed", "boot_rows_observed",
    "deadman_rows_observed", "other_reason_rows_observed", "rows_outside_window", "audit_only_status_rows",
    "first_status_offset_seconds", "last_status_to_end_seconds", "max_status_gap_seconds", "output_state_observed",
    "output_state_changed", "core_time_trust", "core_broker", "core_device", "core_uplink",
    "incident_state_unchanged", "episode_state_unchanged", "commands_emitted", "cut_emitted", "restore_emitted",
    "command_sent_audit_rows", "relay_actuation", "heartbeat_acceptance_basis", "negative_probes_injected_live",
    "negative_probe_coverage", "result", "failure_boundary",
)


class ObserveError(RuntimeError):
    """An observation or verification refused; ``str(exc)`` is one stable reason code."""


# ---------------------------------------------------------------------------- sources


class Sources(Protocol):
    def systemd(self, unit: str) -> dict[str, str]: ...
    def status(self, core_pid: int) -> dict[str, Any]: ...
    def metrics(self, device_id: str) -> dict[str, int]: ...
    def status_rows(self, device_id: str, after_rowid: int, until_rowid: int | None) -> list[tuple[int, float]]: ...
    def audit_rows(self, after_id: int, until_id: int | None) -> list[tuple[int, str, str, float | None]]: ...


def _connect(path: Path) -> sqlite3.Connection:
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.execute("PRAGMA query_only = ON")
        return conn
    except sqlite3.Error as exc:
        raise ObserveError(f"DB_UNREADABLE:{type(exc).__name__}") from None


def _query(path: Path, sql: str, params: tuple = ()) -> list[tuple]:
    conn = _connect(path)
    try:
        return conn.execute(sql, params).fetchall()
    except sqlite3.Error as exc:
        raise ObserveError(f"DB_QUERY_FAILED:{type(exc).__name__}") from None
    finally:
        conn.close()


def _audit_epoch(text: Any) -> float | None:
    """The Core stamps audit rows with local ``%Y-%m-%d %H:%M:%S`` time; a stamp that does not parse correlates with nothing."""
    try:
        return time.mktime(time.strptime(str(text), "%Y-%m-%d %H:%M:%S"))
    except (ValueError, OverflowError):
        return None


class RealSources:
    """The only sources the CLI uses. Read-only sqlite handles, ``systemctl show`` and the Core's status file."""

    def systemd(self, unit: str) -> dict[str, str]:
        props = ("ActiveState", "SubState", "MainPID", "NRestarts", "InvocationID", "Result")
        argv = [SYSTEMCTL, "show", *[a for p in props for a in ("-p", p)], unit]
        done = subprocess.run(argv, capture_output=True, text=True, check=False)  # noqa: S603 - fixed absolute argv, verb `show` only
        if done.returncode != 0:
            raise ObserveError("SYSTEMD_UNREADABLE")
        out = dict(line.split("=", 1) for line in done.stdout.splitlines() if "=" in line)
        if set(props) - set(out):
            raise ObserveError("SYSTEMD_UNREADABLE")
        return out

    def status(self, core_pid: int) -> dict[str, Any]:
        try:
            data = json.loads(Path(f"/proc/{core_pid}/root/run/aegis-idea3/status.json").read_text())
        except (OSError, ValueError):
            raise ObserveError("CORE_STATUS_UNREADABLE") from None
        if not isinstance(data, dict):
            raise ObserveError("CORE_STATUS_UNREADABLE")
        return data

    def metrics(self, device_id: str) -> dict[str, int]:
        seen = _query(PROTOCOL_DB, "SELECT COALESCE(MAX(rowid), 0) FROM protocol_seen_d2c WHERE device_id = ? AND kind = 'STATUS'", (device_id,))
        commands = _query(PROTOCOL_DB, "SELECT COUNT(*) FROM protocol_commands")
        seq = _query(PROTOCOL_DB, "SELECT COALESCE(MAX(last_allocated_seq), 0) FROM protocol_sequence WHERE device_id = ?", (device_id,))
        audit = _query(AUDIT_DB, "SELECT COALESCE(MAX(id), 0) FROM audit_logs")
        incidents = _query(AUDIT_DB, "SELECT COUNT(*) FROM incidents WHERE state = 'OPEN'")
        episodes = _query(AUDIT_DB, "SELECT COUNT(*) FROM lockdown_episodes WHERE device_id = ? AND closed_at IS NULL", (device_id,))
        return {"protocol_seen_rowid": int(seen[0][0]), "command_rows": int(commands[0][0]), "last_allocated_seq": int(seq[0][0]),
                "audit_id": int(audit[0][0]), "open_incidents": int(incidents[0][0]), "open_episodes": int(episodes[0][0])}

    def status_rows(self, device_id: str, after_rowid: int, until_rowid: int | None) -> list[tuple[int, float]]:
        sql = "SELECT rowid, received_at FROM protocol_seen_d2c WHERE device_id = ? AND kind = 'STATUS' AND rowid > ?"
        params: tuple = (device_id, after_rowid)
        if until_rowid is not None:
            sql += " AND rowid <= ?"
            params += (until_rowid,)
        return [(int(r), float(t)) for r, t in _query(PROTOCOL_DB, sql + " ORDER BY rowid", params)]

    def audit_rows(self, after_id: int, until_id: int | None) -> list[tuple[int, str, str, float | None]]:
        sql = "SELECT id, event_type, details, timestamp FROM audit_logs WHERE id > ?"
        params: tuple = (after_id,)
        if until_id is not None:
            sql += " AND id <= ?"
            params += (until_id,)
        return [(int(i), str(e), str(d), _audit_epoch(t)) for i, e, d, t in _query(AUDIT_DB, sql + " ORDER BY id", params)]


# ---------------------------------------------------------------------------- snapshot and boundary


def snapshot(sources: Sources, device_id: str, now: float) -> dict[str, Any]:
    if not _DEVICE_ID.fullmatch(device_id or ""):
        raise ObserveError("DEVICE_ID_INVALID")
    core = sources.systemd(CORE_UNIT)
    try:
        pid = int(core["MainPID"])
    except ValueError:
        raise ObserveError("CORE_PID_INVALID") from None
    if pid <= 0:
        raise ObserveError("CORE_PID_INVALID")
    return {"time": float(now), "core": core, "detector": sources.systemd(DETECTOR_UNIT), "status": sources.status(pid),
            "pid": pid, "metrics": sources.metrics(device_id)}


BOUNDARY_KEYS = (
    "L9_PRE_TIME", "L9_PRE_CORE_PID", "L9_PRE_CORE_NRESTARTS", "L9_PRE_CORE_INVOCATION", "L9_PRE_DETECTOR_PID",
    "L9_PRE_DETECTOR_INVOCATION", "L9_PRE_DETECTOR_NRESTARTS", "L9_PRE_STATUS_UPDATED_AT", "L9_PRE_STATUS_UPLINK",
    "L9_PRE_PROTOCOL_SEEN_ID", "L9_PRE_AUDIT_ID", "L9_PRE_COMMAND_ROWS", "L9_PRE_LAST_ALLOCATED_SEQ",
    "L9_PRE_OPEN_INCIDENTS", "L9_PRE_OPEN_EPISODES",
)
IDENTITY_KEYS = ("L9_DEVICE_ID", "L9_RUN_ID", "L9_EXPECTED_MAIN", "L9_RUNNER_SHA256", "L9_WORK_DIR", "L9_EVIDENCE_DIR", "L9_CONSUMED_AT_EPOCH")


def boundary_from_snapshot(snap: dict[str, Any]) -> dict[str, str]:
    m, st = snap["metrics"], snap["status"]
    return {
        "L9_PRE_TIME": repr(float(snap["time"])), "L9_PRE_CORE_PID": str(snap["pid"]),
        "L9_PRE_CORE_NRESTARTS": snap["core"]["NRestarts"], "L9_PRE_CORE_INVOCATION": snap["core"]["InvocationID"],
        "L9_PRE_DETECTOR_PID": snap["detector"]["MainPID"], "L9_PRE_DETECTOR_INVOCATION": snap["detector"]["InvocationID"],
        "L9_PRE_DETECTOR_NRESTARTS": snap["detector"]["NRestarts"], "L9_PRE_STATUS_UPDATED_AT": repr(float(st.get("updated_at", 0))),
        "L9_PRE_STATUS_UPLINK": str(st.get("uplink", "")), "L9_PRE_PROTOCOL_SEEN_ID": str(m["protocol_seen_rowid"]),
        "L9_PRE_AUDIT_ID": str(m["audit_id"]), "L9_PRE_COMMAND_ROWS": str(m["command_rows"]),
        "L9_PRE_LAST_ALLOCATED_SEQ": str(m["last_allocated_seq"]), "L9_PRE_OPEN_INCIDENTS": str(m["open_incidents"]),
        "L9_PRE_OPEN_EPISODES": str(m["open_episodes"]),
    }


def parse_marker(text: str, device_id: str) -> dict[str, str]:
    """The consumed-attempt marker the owner runner wrote BEFORE this observation: identity, binding and PRE boundary."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            if key in values:
                raise ObserveError("MARKER_DUPLICATE_KEY")
            values[key] = value
    if values.get("L9_ATTEMPT_CONSUMED") != "YES" or values.get("L9_RERUN_ALLOWED") != "NO":
        raise ObserveError("MARKER_NOT_CONSUMED")
    if values.get("L9_DEVICE_ID") != device_id:
        raise ObserveError("MARKER_DEVICE_MISMATCH")
    missing = [k for k in (*IDENTITY_KEYS, *BOUNDARY_KEYS) if k not in values]
    if missing:
        raise ObserveError(f"MARKER_FIELD_MISSING:{missing[0]}")
    if not _RUN_ID.fullmatch(values["L9_RUN_ID"]) or not _HEX40.fullmatch(values["L9_EXPECTED_MAIN"]) or not _HEX64.fullmatch(values["L9_RUNNER_SHA256"]):
        raise ObserveError("MARKER_IDENTITY_INVALID")
    try:
        float(values["L9_CONSUMED_AT_EPOCH"])
        float(values["L9_PRE_TIME"])
    except ValueError:
        raise ObserveError("MARKER_TIME_INVALID") from None
    return values


def bind_marker(marker: dict[str, str], *, run_id: str, expected_main: str, runner_sha256: str, work_dir: str, evidence_dir: str, now: float) -> None:
    """The marker must equal this exact invocation and be fresh. No caller value can override a marker identity."""
    expected = {"L9_RUN_ID": run_id, "L9_EXPECTED_MAIN": expected_main, "L9_RUNNER_SHA256": runner_sha256,
                "L9_WORK_DIR": os.path.abspath(work_dir), "L9_EVIDENCE_DIR": os.path.abspath(evidence_dir)}
    for key, want in expected.items():
        if marker[key] != want:
            raise ObserveError(f"MARKER_BINDING_MISMATCH:{key}")
    consumed, pre = float(marker["L9_CONSUMED_AT_EPOCH"]), float(marker["L9_PRE_TIME"])
    if abs(consumed - pre) > MAX_BOUNDARY_SKEW_SECONDS:
        raise ObserveError("MARKER_BOUNDARY_NOT_AT_CONSUMPTION")
    age = now - consumed
    if age < -MAX_BOUNDARY_SKEW_SECONDS:
        raise ObserveError("MARKER_FROM_THE_FUTURE")
    if age > MAX_START_DELAY_SECONDS:
        raise ObserveError("MARKER_STALE")


def _initial_user_namespace() -> bool:
    try:
        return Path("/proc/self/uid_map").read_text().split()[:3] == ["0", "0", "4294967295"]
    except OSError:
        return True  # unknown: treat as the real namespace (the seam stays refused)


def _canonical_dir() -> tuple[Path, int]:
    enabled, seam = os.environ.get(SEAM_ENABLED), os.environ.get(SEAM_DIR)
    if enabled is None and seam is None:
        return CANONICAL_DIR, 0
    if enabled != "YES" or not seam:
        raise ObserveError("TEST_SEAM_INCOMPLETE")
    if _initial_user_namespace():
        raise ObserveError("TEST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE")
    return Path(seam), os.geteuid()


def check_marker_file(path: Path) -> None:
    """The attempt marker must be THE canonical, root-owned, regular, non-symlink, non-group/world-writable one-shot marker."""
    directory, owner_uid = _canonical_dir()
    if Path(os.path.abspath(path)) != directory / MARKER_NAME:
        raise ObserveError("MARKER_NOT_THE_CANONICAL_PATH")
    try:
        st = path.lstat()
    except OSError:
        raise ObserveError("MARKER_MISSING") from None
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise ObserveError("MARKER_NOT_A_REGULAR_FILE")
    if st.st_uid != owner_uid or st.st_mode & 0o022:
        raise ObserveError("MARKER_NOT_ROOT_OWNED_PRIVATE")


def claim_marker_use(used_path: Path, run_id: str, evidence_dir: str, work_dir: str, now: float) -> None:
    """Durable single-use binding: the first observation creates this exclusive file; any other apply/run finds it and refuses."""
    body = f"L9_RUN_ID={run_id}\nL9_EVIDENCE_DIR={os.path.abspath(evidence_dir)}\nL9_WORK_DIR={os.path.abspath(work_dir)}\nL9_OBSERVATION_STARTED_EPOCH={now!r}\n".encode()
    try:
        fd = os.open(used_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise ObserveError("MARKER_ALREADY_OBSERVED") from None
    except OSError as exc:
        raise ObserveError(f"MARKER_USE_NOT_RECORDABLE:{type(exc).__name__}") from None
    with os.fdopen(fd, "wb") as handle:
        handle.write(body)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        dfd = os.open(used_path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        raise ObserveError("MARKER_USE_NOT_DURABLE") from None


def read_used_claim(used_path: Path) -> dict[str, str]:
    try:
        if used_path.is_symlink() or not used_path.is_file():
            raise ObserveError("MARKER_USE_CLAIM_MISSING")
        return dict(line.split("=", 1) for line in used_path.read_text().splitlines() if "=" in line)
    except OSError:
        raise ObserveError("MARKER_USE_CLAIM_MISSING") from None


# ---------------------------------------------------------------------------- evaluation (pure)


def _status_triplet(details: str) -> tuple[str, str] | None:
    match = _AUDIT_STATUS.fullmatch(details)
    return (match.group(1), match.group(2)) if match else None


def analyze(rows: list[tuple[int, float]], audit: list[tuple[int, str, str, float | None]], start: float, end: float) -> dict[str, Any]:
    """Authenticated-protocol evidence only. ``rows`` are canonical protocol STATUS rows; ``audit`` only classifies them."""
    stale = [t for _, t in rows if t < start - EDGE_SKEW_SECONDS]
    future = [t for _, t in rows if t > end + EDGE_SKEW_SECONDS]
    times = [t for _, t in rows]
    status_audit = [(i, _status_triplet(d), ts) for i, e, d, ts in audit if e == "DEVICE_STATUS"]
    unparsed = sum(1 for _, trip, _ in status_audit if trip is None)
    problems: list[str] = []
    paired = 0
    confirmed = [t for t in times if t <= end - AUDIT_GRACE_SECONDS]
    if len(status_audit) > len(rows):
        problems.append("AUDIT_ONLY_STATUS_PRESENT")
    elif len(status_audit) < len(confirmed):
        problems.append("PROTOCOL_ROW_WITHOUT_AUDIT")
    else:
        for k, (_, trip, ts) in enumerate(status_audit):
            if ts is None or not (times[k] - 1.0 <= ts <= times[k] + AUDIT_DELAY_SECONDS):
                problems.append("AUDIT_PROTOCOL_UNCORRELATED")
                break
            paired += 1
    reasons = [trip[1] for _, trip, _ in status_audit[:paired] if trip is not None]
    states = sorted({trip[0] for _, trip, _ in status_audit[:paired] if trip is not None})
    inside = sorted(t for t in times if start - EDGE_SKEW_SECONDS <= t <= end + EDGE_SKEW_SECONDS)
    internal = [b - a for a, b in zip(inside, inside[1:])]
    return {
        "stale": len(stale), "future": len(future), "problems": problems, "unparsed": unparsed, "paired": paired,
        "periodic": reasons.count("PERIODIC"), "boot": reasons.count("BOOT") + reasons.count("BOOT_GRACE"), "deadman": reasons.count("DEADMAN"),
        "other": sum(1 for r in reasons if r not in {"PERIODIC", "BOOT", "BOOT_GRACE", "DEADMAN"}),
        "states": states, "first_offset": (inside[0] - start) if inside else None, "last_to_end": (end - inside[-1]) if inside else None,
        "max_internal_gap": max(internal) if internal else 0.0, "audit_only": max(0, len(status_audit) - len(rows)),
        "outside": len(stale) + len(future), "rows": len(rows),
    }


def evaluate(boundary: dict[str, str], post: dict[str, Any], rows: list[tuple[int, float]], audit: list[tuple[int, str, str, float | None]],
             start: float, end: float, until: dict[str, int]) -> dict[str, Any]:
    """Return the evidence payload for these observations. ``failure_boundary`` is the FIRST violated invariant."""
    pre_uplink = boundary["L9_PRE_STATUS_UPLINK"]
    a = analyze(rows, audit, start, end)
    window = end - start
    m, st = post["metrics"], post["status"]
    cmd_audit = sum(1 for _, e, _, _ in audit if e == "COMMAND_SENT")
    anomalies = sum(1 for _, e, _, _ in audit if e in {"P1_STATUS_UNCORRELATED", "P1_SEQUENCE_RESYNC"})
    states = a["states"]
    offsets = [x for x in (a["first_offset"], a["last_to_end"]) if x is not None]
    fields: dict[str, Any] = {
        "observation_window_seconds": int(window), "window_start_epoch": start, "window_end_epoch": end,
        "core_pid": int(post["pid"]), "core_pid_unchanged": str(post["pid"]) == boundary["L9_PRE_CORE_PID"],
        "core_restart_count_unchanged": post["core"]["NRestarts"] == boundary["L9_PRE_CORE_NRESTARTS"],
        "detector_invocation_unchanged": post["detector"]["InvocationID"] == boundary["L9_PRE_DETECTOR_INVOCATION"]
        and post["detector"]["MainPID"] == boundary["L9_PRE_DETECTOR_PID"],
        "status_rows_observed": a["rows"], "periodic_rows_observed": a["periodic"], "boot_rows_observed": a["boot"],
        "deadman_rows_observed": a["deadman"], "other_reason_rows_observed": a["other"], "rows_outside_window": a["outside"],
        "audit_only_status_rows": a["audit_only"],
        "first_status_offset_seconds": int(a["first_offset"]) if a["first_offset"] is not None else 10**6,
        "last_status_to_end_seconds": int(a["last_to_end"]) if a["last_to_end"] is not None else 10**6,
        "max_status_gap_seconds": int(max([a["max_internal_gap"], *offsets])) if offsets else 10**6,
        "output_state_observed": states[0] if len(states) == 1 else ("NONE" if not states else "MIXED"),
        "output_state_changed": len(states) > 1 or (bool(states) and states[0] != pre_uplink),
        "core_time_trust": str(st.get("time_trust")), "core_broker": str(st.get("broker")), "core_device": str(st.get("device")),
        "core_uplink": str(st.get("uplink")),
        "incident_state_unchanged": str(m["open_incidents"]) == boundary["L9_PRE_OPEN_INCIDENTS"],
        "episode_state_unchanged": str(m["open_episodes"]) == boundary["L9_PRE_OPEN_EPISODES"],
        "commands_emitted": int(m["command_rows"]) - int(boundary["L9_PRE_COMMAND_ROWS"]),
        "cut_emitted": 0, "restore_emitted": 0, "command_sent_audit_rows": cmd_audit, "relay_actuation": "NONE",
        "pre_protocol_seen_rowid": int(boundary["L9_PRE_PROTOCOL_SEEN_ID"]), "until_protocol_seen_rowid": until["protocol"],
        "pre_audit_id": int(boundary["L9_PRE_AUDIT_ID"]), "until_audit_id": until["audit"],
    }
    seq_moved = int(m["last_allocated_seq"]) != int(boundary["L9_PRE_LAST_ALLOCATED_SEQ"])
    problem = a["problems"][0] if a["problems"] else None
    checks = (
        ("CORE_NOT_ACTIVE_RUNNING", post["core"]["ActiveState"] == "active" and post["core"]["SubState"] == "running" and post["core"]["Result"] == "success"),
        ("CORE_PID_CHANGED", fields["core_pid_unchanged"]),
        ("CORE_RESTARTED", fields["core_restart_count_unchanged"] and post["core"]["InvocationID"] == boundary["L9_PRE_CORE_INVOCATION"]),
        ("DETECTOR_NOT_ACTIVE_RUNNING", post["detector"]["ActiveState"] == "active" and post["detector"]["SubState"] == "running"),
        ("DETECTOR_CHANGED", fields["detector_invocation_unchanged"] and post["detector"]["NRestarts"] == boundary["L9_PRE_DETECTOR_NRESTARTS"]),
        ("CORE_STATUS_PID_MISMATCH", st.get("pid") == post["pid"]),
        ("CORE_STATUS_NOT_REFRESHED", isinstance(st.get("updated_at"), (int, float)) and float(st["updated_at"]) > float(boundary["L9_PRE_STATUS_UPDATED_AT"])),
        ("TIME_TRUST_NOT_SYNCED", fields["core_time_trust"] == "SYNCED"),
        ("BROKER_NOT_CONNECTED", fields["core_broker"] == "CONNECTED"),
        ("DEVICE_NOT_ONLINE", fields["core_device"] == "ONLINE"),
        ("UPLINK_CHANGED", fields["core_uplink"] == pre_uplink and pre_uplink in {"NORMAL", "LOCKDOWN"}),
        ("WINDOW_TOO_SHORT", window >= MIN_WINDOW_SECONDS),
        ("AUDIT_STATUS_UNPARSEABLE", a["unparsed"] == 0),
        ("AUTH_ROWS_OUTSIDE_WINDOW", a["outside"] == 0),
        ("AUDIT_ONLY_STATUS_PRESENT", problem != "AUDIT_ONLY_STATUS_PRESENT"),
        ("PROTOCOL_ROW_WITHOUT_AUDIT", problem != "PROTOCOL_ROW_WITHOUT_AUDIT"),
        ("AUDIT_PROTOCOL_UNCORRELATED", problem != "AUDIT_PROTOCOL_UNCORRELATED"),
        ("DEADMAN_OBSERVED", a["deadman"] == 0),
        ("DEVICE_REBOOTED_DURING_OBSERVATION", a["boot"] == 0),
        ("UNEXPECTED_STATUS_REASON", a["other"] == 0),
        ("PERIODIC_ROWS_INSUFFICIENT", a["periodic"] >= MIN_PERIODIC_ROWS and a["rows"] >= MIN_PERIODIC_ROWS),
        ("FIRST_STATUS_TOO_LATE", a["first_offset"] is not None and a["first_offset"] <= MAX_STATUS_GAP_SECONDS),
        ("STATUS_GAP_TOO_LARGE", a["max_internal_gap"] <= MAX_STATUS_GAP_SECONDS),
        ("LAST_STATUS_TOO_EARLY", a["last_to_end"] is not None and a["last_to_end"] <= MAX_STATUS_GAP_SECONDS),
        ("OUTPUT_STATE_CHANGED", not fields["output_state_changed"]),
        ("COMMAND_ISSUED", fields["commands_emitted"] == 0 and cmd_audit == 0 and not seq_moved),
        ("STATUS_CORRELATION_ANOMALY", anomalies == 0),
        ("INCIDENT_STATE_CHANGED", fields["incident_state_unchanged"] and fields["episode_state_unchanged"]),
    )
    failure = next((name for name, ok in checks if not ok), "NONE")
    fields.update({
        "heartbeat_acceptance_basis": "NO_DEADMAN_OVER_WINDOW", "negative_probes_injected_live": "NO",
        "negative_probe_coverage": "REPOSITORY_FIXTURE_ONLY", "result": "PASS" if failure == "NONE" else "FAIL",
        "failure_boundary": failure,
    })
    return fields


def check_bundle_invariants(data: dict[str, Any]) -> None:
    """Recompute the pass criteria from the bundle's own numbers: the ``result`` word alone is never trusted."""
    if data["result"] != "PASS" or data["failure_boundary"] != "NONE":
        raise ObserveError("EVIDENCE_RESULT_NOT_PASS")
    expected = {
        "evidence_class": EVIDENCE_CLASS, "schema_version": SCHEMA_VERSION, "core_pid_unchanged": True, "core_restart_count_unchanged": True,
        "detector_invocation_unchanged": True, "deadman_rows_observed": 0, "boot_rows_observed": 0, "other_reason_rows_observed": 0,
        "rows_outside_window": 0, "audit_only_status_rows": 0, "output_state_changed": False, "incident_state_unchanged": True,
        "episode_state_unchanged": True, "commands_emitted": 0, "cut_emitted": 0, "restore_emitted": 0, "command_sent_audit_rows": 0,
        "relay_actuation": "NONE", "core_time_trust": "SYNCED", "core_broker": "CONNECTED", "core_device": "ONLINE",
        "heartbeat_acceptance_basis": "NO_DEADMAN_OVER_WINDOW", "negative_probes_injected_live": "NO",
        "negative_probe_coverage": "REPOSITORY_FIXTURE_ONLY",
    }
    for key, want in expected.items():
        if data.get(key) != want or type(data.get(key)) is not type(want):
            raise ObserveError(f"EVIDENCE_FIELD_INVALID:{key}")
    ints = ("observation_window_seconds", "status_rows_observed", "periodic_rows_observed", "first_status_offset_seconds",
            "last_status_to_end_seconds", "max_status_gap_seconds", "core_pid", "pre_protocol_seen_rowid", "until_protocol_seen_rowid",
            "pre_audit_id", "until_audit_id")
    if any(type(data.get(k)) is not int or data[k] < 0 for k in ints):
        raise ObserveError("EVIDENCE_NUMBER_INVALID")
    floats = ("marker_consumed_epoch", "window_start_epoch", "window_end_epoch")
    if any(not isinstance(data.get(k), (int, float)) or isinstance(data.get(k), bool) for k in floats):
        raise ObserveError("EVIDENCE_NUMBER_INVALID")
    if data["observation_window_seconds"] < MIN_WINDOW_SECONDS or data["window_end_epoch"] - data["window_start_epoch"] < MIN_WINDOW_SECONDS:
        raise ObserveError("EVIDENCE_WINDOW_TOO_SHORT")
    if abs((data["window_end_epoch"] - data["window_start_epoch"]) - data["observation_window_seconds"]) > 1.0:
        raise ObserveError("EVIDENCE_WINDOW_INCONSISTENT")
    if data["periodic_rows_observed"] < MIN_PERIODIC_ROWS or data["status_rows_observed"] < data["periodic_rows_observed"]:
        raise ObserveError("EVIDENCE_PERIODIC_ROWS_INSUFFICIENT")
    for key in ("first_status_offset_seconds", "last_status_to_end_seconds", "max_status_gap_seconds"):
        if data[key] > MAX_STATUS_GAP_SECONDS:
            raise ObserveError("EVIDENCE_STATUS_GAP_TOO_LARGE")
    if data["until_protocol_seen_rowid"] < data["pre_protocol_seen_rowid"] + data["status_rows_observed"] or data["until_audit_id"] <= data["pre_audit_id"]:
        raise ObserveError("EVIDENCE_BOUNDARY_INCONSISTENT")
    if data["output_state_observed"] in {"NONE", "MIXED"} or data["output_state_observed"] != data["core_uplink"]:
        raise ObserveError("EVIDENCE_OUTPUT_STATE_INCONSISTENT")
    if not _DEVICE_ID.fullmatch(str(data.get("device_id", ""))) or not _RUN_ID.fullmatch(str(data.get("run_id", ""))):
        raise ObserveError("EVIDENCE_IDENTIFIER_INVALID")
    if not _HEX40.fullmatch(str(data.get("expected_main", ""))) or not _HEX64.fullmatch(str(data.get("runner_sha256", ""))):
        raise ObserveError("EVIDENCE_IDENTIFIER_INVALID")
    if abs(data["marker_consumed_epoch"] - data["window_start_epoch"]) > MAX_BOUNDARY_SKEW_SECONDS:
        raise ObserveError("EVIDENCE_MARKER_TIME_INCONSISTENT")


# ---------------------------------------------------------------------------- observe / verify


def observe(sources: Sources, marker_text: str, device_id: str, run_id: str, window_seconds: int, *, expected_main: str, runner_sha256: str,
            work_dir: str, evidence_dir: str, claim: Callable[[str, float], None],
            clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep) -> dict[str, Any]:
    if not MIN_WINDOW_SECONDS <= window_seconds <= MAX_WINDOW_SECONDS:
        raise ObserveError("WINDOW_OUT_OF_BOUNDS")
    if not _RUN_ID.fullmatch(run_id or ""):
        raise ObserveError("RUN_ID_INVALID")
    marker = parse_marker(marker_text, device_id)
    now = clock()
    bind_marker(marker, run_id=run_id, expected_main=expected_main, runner_sha256=runner_sha256, work_dir=work_dir, evidence_dir=evidence_dir, now=now)
    start = float(marker["L9_PRE_TIME"])
    claim(run_id, now)  # durable single use, BEFORE any observation
    deadline = start + window_seconds
    hard_stop = deadline + MAX_OVERRUN_SECONDS
    while True:
        now = clock()
        if now >= deadline:
            post = snapshot(sources, device_id, now)
            until = {"protocol": post["metrics"]["protocol_seen_rowid"], "audit": post["metrics"]["audit_id"]}
            rows = sources.status_rows(device_id, int(marker["L9_PRE_PROTOCOL_SEEN_ID"]), until["protocol"])
            audit = sources.audit_rows(int(marker["L9_PRE_AUDIT_ID"]), until["audit"])
            fields = evaluate(marker, post, rows, audit, start, now, until)
            if fields["result"] == "PASS" or now >= hard_stop:
                break
            # A silence-type result can still heal until the bounded hard stop; every other failure is final immediately.
            if fields["failure_boundary"] not in {"PERIODIC_ROWS_INSUFFICIENT", "LAST_STATUS_TOO_EARLY"}:
                break
        sleep(POLL_SECONDS)
    return {"schema_version": SCHEMA_VERSION, "run_id": run_id, "evidence_class": EVIDENCE_CLASS, "device_id": device_id,
            "expected_main": expected_main, "runner_sha256": runner_sha256, "marker_consumed_epoch": float(marker["L9_CONSUMED_AT_EPOCH"]), **fields}


def write_evidence(path: Path, data: dict[str, Any]) -> None:
    if set(data) != set(EVIDENCE_FIELDS):
        raise ObserveError("EVIDENCE_FIELD_SET_INVALID")
    payload = (json.dumps({k: data[k] for k in EVIDENCE_FIELDS}, indent=2, sort_keys=True) + "\n").encode()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except OSError as exc:
        raise ObserveError(f"EVIDENCE_NOT_WRITABLE:{type(exc).__name__}") from None
    with os.fdopen(fd, "wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())


def evidence_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_evidence(path: Path, sources: Sources | None = None, *, binding: dict[str, Any] | None = None) -> dict[str, Any]:
    """Structure, privacy, recomputed invariants, (with sources) reconciliation against the Core's own durable rows,
    and (with ``binding``) the exact marker/invocation identity and the durable single-use claim."""
    if not path.is_file() or path.is_symlink():
        raise ObserveError("EVIDENCE_MISSING_OR_SYMLINK")
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ObserveError("EVIDENCE_MODE_NOT_0600")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise ObserveError("EVIDENCE_NOT_JSON") from None
    if not isinstance(data, dict) or set(data) != set(EVIDENCE_FIELDS):
        raise ObserveError("EVIDENCE_FIELD_SET_INVALID")
    check_bundle_invariants(data)
    if binding is not None:
        marker = binding["marker"]
        for key, field in (("L9_RUN_ID", "run_id"), ("L9_EXPECTED_MAIN", "expected_main"), ("L9_RUNNER_SHA256", "runner_sha256"), ("L9_DEVICE_ID", "device_id")):
            if marker[key] != data[field] or binding[field] != data[field]:
                raise ObserveError(f"EVIDENCE_MARKER_MISMATCH:{field}")
        if abs(float(marker["L9_CONSUMED_AT_EPOCH"]) - data["marker_consumed_epoch"]) > 1e-6 or abs(float(marker["L9_PRE_TIME"]) - data["window_start_epoch"]) > 1e-6:
            raise ObserveError("EVIDENCE_MARKER_MISMATCH:time")
        if marker["L9_EVIDENCE_DIR"] != os.path.abspath(str(path.parent)) or os.path.abspath(binding["evidence_dir"]) != marker["L9_EVIDENCE_DIR"]:
            raise ObserveError("EVIDENCE_MARKER_MISMATCH:evidence_dir")
        claim = binding["claim"]
        if claim.get("L9_RUN_ID") != data["run_id"] or claim.get("L9_EVIDENCE_DIR") != marker["L9_EVIDENCE_DIR"] or claim.get("L9_WORK_DIR") != marker["L9_WORK_DIR"]:
            raise ObserveError("EVIDENCE_USE_CLAIM_MISMATCH")
    if sources is not None:
        rows = sources.status_rows(data["device_id"], data["pre_protocol_seen_rowid"], data["until_protocol_seen_rowid"])
        audit = sources.audit_rows(data["pre_audit_id"], data["until_audit_id"])
        a = analyze(rows, audit, data["window_start_epoch"], data["window_end_epoch"])
        if len(rows) != data["status_rows_observed"]:
            raise ObserveError("RECONCILIATION_STATUS_ROWS_MISMATCH")
        if a["outside"] or a["problems"] or a["unparsed"] or a["periodic"] != data["periodic_rows_observed"] or a["boot"] or a["deadman"] or a["other"]:
            raise ObserveError("RECONCILIATION_AUDIT_STATUS_MISMATCH")
        if a["first_offset"] is None or a["first_offset"] > MAX_STATUS_GAP_SECONDS or a["last_to_end"] > MAX_STATUS_GAP_SECONDS or a["max_internal_gap"] > MAX_STATUS_GAP_SECONDS:
            raise ObserveError("RECONCILIATION_CONTINUITY")
        if any(e == "COMMAND_SENT" for _, e, _, _ in audit):
            raise ObserveError("RECONCILIATION_COMMAND_SENT_PRESENT")
    return data


# ---------------------------------------------------------------------------- CLI


def _identity_args(parser: argparse.ArgumentParser) -> None:
    for name in ("--marker", "--evidence-dir", "--work-dir", "--device-id", "--run-id", "--expected-main", "--runner-sha256"):
        parser.add_argument(name, required=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AEGIS L9 live observation (read-only)")
    sub = parser.add_subparsers(dest="command", required=True)
    cap = sub.add_parser("capture-boundary")
    cap.add_argument("--device-id", required=True)
    obs = sub.add_parser("observe")
    _identity_args(obs)
    obs.add_argument("--window-seconds", type=int, default=MIN_WINDOW_SECONDS)
    ver = sub.add_parser("verify")
    _identity_args(ver)
    args = parser.parse_args(argv)
    sources = RealSources()
    try:
        if args.command == "capture-boundary":
            for key, value in boundary_from_snapshot(snapshot(sources, args.device_id, time.time())).items():
                print(f"{key}={value}")
            return 0
        marker_path = Path(args.marker)
        check_marker_file(marker_path)
        evidence_dir = Path(args.evidence_dir)
        if not evidence_dir.is_dir() or evidence_dir.is_symlink():
            raise ObserveError("EVIDENCE_DIR_INVALID")
        used_path = marker_path.parent / USED_NAME
        if args.command == "observe":
            data = observe(sources, marker_path.read_text(encoding="utf-8"), args.device_id, args.run_id, args.window_seconds,
                           expected_main=args.expected_main, runner_sha256=args.runner_sha256, work_dir=args.work_dir, evidence_dir=args.evidence_dir,
                           claim=lambda run, now: claim_marker_use(used_path, run, args.evidence_dir, args.work_dir, now))
            write_evidence(evidence_dir / EVIDENCE_NAME, data)
            if data["result"] != "PASS":
                raise ObserveError(data["failure_boundary"])
            print("L9_LIVE_OBSERVE=PASS")
            return 0
        marker = parse_marker(marker_path.read_text(encoding="utf-8"), args.device_id)
        binding = {"marker": marker, "claim": read_used_claim(used_path), "evidence_dir": args.evidence_dir, "run_id": args.run_id,
                   "expected_main": args.expected_main, "runner_sha256": args.runner_sha256, "device_id": args.device_id}
        if marker["L9_WORK_DIR"] != os.path.abspath(args.work_dir):
            raise ObserveError("MARKER_BINDING_MISMATCH:L9_WORK_DIR")
        verify_evidence(evidence_dir / EVIDENCE_NAME, sources, binding=binding)
        print("L9_LIVE_VERIFY=PASS")
        return 0
    except ObserveError as exc:
        print(f"L9_LIVE_{args.command.upper().replace('-', '_')}=FAIL reason={exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
