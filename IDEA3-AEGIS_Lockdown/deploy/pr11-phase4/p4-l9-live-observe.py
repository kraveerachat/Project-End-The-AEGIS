#!/usr/bin/env python3
"""L9 LIVE backend: read-only observation of the RUNNING Core's own authenticated evidence.

Repository tooling for the live-capable L9 successor (OD-L9-01a, resolving the open question of
the L9 design in favour of the "Core-side observation of the running service" mechanism).

What it does: it takes a PRE boundary, watches the running Core for a bounded window, and proves
from canonical Core-owned sources that the real device kept talking to the real Core with
authenticated, fresh, non-replayed Protocol-v1 STATUS frames while L9 did nothing.

What it never does: it opens no socket and no serial port, publishes nothing, issues no COMMAND,
sends no heartbeat of its own, injects no probe frame, generates no key, starts/stops/restarts
no service, and writes only the stage-local evidence bundle. The only systemd verb it may run is
``show``. There are no override flags: every source path is fixed in this file, and the tests
exercise the pure functions with injected sources.

Evidence sources (all root-owned Core outputs, read through read-only handles):
* ``protocol_seen_d2c``: a row exists only after AUTH, SKEW and REPLAY all passed in the Core.
* ``audit_logs`` ``DEVICE_STATUS`` rows: ``"<output_state> (<reason>)"`` written per accepted STATUS.
* ``protocol_commands`` / ``protocol_sequence``: any COMMAND issued would change them.
* the Core's own ``status.json`` (through ``/proc/<pid>/root``) and ``systemctl show``.

Honest limits (recorded in every bundle, never hidden): negative probes are NOT injected live
(``negative_probe_coverage=REPOSITORY_FIXTURE_ONLY``), and the device-side heartbeat effect has no
outward signal by design, so it is evidenced only indirectly (``NO_DEADMAN_OVER_WINDOW``).
"""

from __future__ import annotations

import argparse
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
SCHEMA_VERSION = "l9-live-evidence-v1"

DEADMAN_SECONDS = 60          # protocol design: device dead-man window
STATUS_INTERVAL_SECONDS = 30  # firmware STATUS_INTERVAL_MS
MIN_WINDOW_SECONDS = 2 * DEADMAN_SECONDS      # two full dead-man windows without a DEADMAN status
MAX_WINDOW_SECONDS = 900
MIN_PERIODIC_ROWS = 3
MAX_STATUS_GAP_SECONDS = STATUS_INTERVAL_SECONDS + 15
POLL_SECONDS = 5.0

CANONICAL_DIR = Path("/var/lib/aegis-idea3-governance")
MARKER_NAME = "L9-GLOBAL-ATTEMPT-CONSUMED"
SEAM_ENABLED = "AEGIS_L9_TEST_ONLY_CANONICAL_DIR_ENABLED"
SEAM_DIR = "AEGIS_L9_TEST_ONLY_CANONICAL_DIR"

_AUDIT_STATUS = re.compile(r"([A-Z][A-Z_]{1,30}) \(([A-Z][A-Z_]{1,30})\)")
_DEVICE_ID = re.compile(r"[a-z0-9][a-z0-9-]{1,30}[a-z0-9]")
_HEX32 = re.compile(r"[0-9a-f]{32}")

EVIDENCE_FIELDS = (
    "schema_version", "run_id", "evidence_class", "device_id",
    "pre_protocol_seen_rowid", "until_protocol_seen_rowid", "pre_audit_id", "until_audit_id",
    "observation_window_seconds", "core_pid", "core_pid_unchanged", "core_restart_count_unchanged",
    "detector_invocation_unchanged", "status_rows_observed", "periodic_rows_observed", "boot_rows_observed",
    "deadman_rows_observed", "other_reason_rows_observed", "max_status_gap_seconds", "output_state_observed",
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
    def audit_rows(self, after_id: int, until_id: int | None) -> list[tuple[int, str, str]]: ...


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

    def audit_rows(self, after_id: int, until_id: int | None) -> list[tuple[int, str, str]]:
        sql = "SELECT id, event_type, details FROM audit_logs WHERE id > ?"
        params: tuple = (after_id,)
        if until_id is not None:
            sql += " AND id <= ?"
            params += (until_id,)
        return [(int(i), str(e), str(d)) for i, e, d in _query(AUDIT_DB, sql + " ORDER BY id", params)]


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


def boundary_from_snapshot(snap: dict[str, Any]) -> dict[str, str]:
    m, st = snap["metrics"], snap["status"]
    out = {
        "L9_PRE_TIME": repr(float(snap["time"])), "L9_PRE_CORE_PID": str(snap["pid"]),
        "L9_PRE_CORE_NRESTARTS": snap["core"]["NRestarts"], "L9_PRE_CORE_INVOCATION": snap["core"]["InvocationID"],
        "L9_PRE_DETECTOR_PID": snap["detector"]["MainPID"], "L9_PRE_DETECTOR_INVOCATION": snap["detector"]["InvocationID"],
        "L9_PRE_DETECTOR_NRESTARTS": snap["detector"]["NRestarts"], "L9_PRE_STATUS_UPDATED_AT": repr(float(st.get("updated_at", 0))),
        "L9_PRE_STATUS_UPLINK": str(st.get("uplink", "")), "L9_PRE_PROTOCOL_SEEN_ID": str(m["protocol_seen_rowid"]),
        "L9_PRE_AUDIT_ID": str(m["audit_id"]), "L9_PRE_COMMAND_ROWS": str(m["command_rows"]),
        "L9_PRE_LAST_ALLOCATED_SEQ": str(m["last_allocated_seq"]), "L9_PRE_OPEN_INCIDENTS": str(m["open_incidents"]),
        "L9_PRE_OPEN_EPISODES": str(m["open_episodes"]),
    }
    return out


def parse_marker(text: str, device_id: str) -> dict[str, str]:
    """The consumed-attempt marker the owner runner wrote BEFORE this observation, with its PRE boundary."""
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
    missing = [k for k in BOUNDARY_KEYS if k not in values]
    if missing:
        raise ObserveError(f"MARKER_BOUNDARY_INCOMPLETE:{missing[0]}")
    return values


def _initial_user_namespace() -> bool:
    try:
        return Path("/proc/self/uid_map").read_text().split()[:3] == ["0", "0", "4294967295"]
    except OSError:
        return True  # unknown: treat as the real namespace (the seam stays refused)


def check_marker_file(path: Path) -> None:
    """The attempt marker must be THE canonical, root-owned, regular, non-symlink, non-group/world-writable one-shot marker."""
    enabled, seam = os.environ.get(SEAM_ENABLED), os.environ.get(SEAM_DIR)
    owner_uid = 0
    directory = CANONICAL_DIR
    if enabled is not None or seam is not None:
        if enabled != "YES" or not seam:
            raise ObserveError("TEST_SEAM_INCOMPLETE")
        if _initial_user_namespace():
            raise ObserveError("TEST_SEAM_REFUSED_IN_THE_REAL_ROOT_NAMESPACE")
        directory, owner_uid = Path(seam), os.geteuid()
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


# ---------------------------------------------------------------------------- evaluation (pure)


def _status_triplet(details: str) -> tuple[str, str] | None:
    match = _AUDIT_STATUS.fullmatch(details)
    return (match.group(1), match.group(2)) if match else None


def evaluate(boundary: dict[str, str], post: dict[str, Any], rows: list[tuple[int, float]], audit: list[tuple[int, str, str]],
             window: float, until: dict[str, int]) -> dict[str, Any]:
    """Return the evidence payload for these observations. ``failure_boundary`` is the FIRST violated invariant."""
    pre_uplink = boundary["L9_PRE_STATUS_UPLINK"]
    statuses = [(i, _status_triplet(d)) for i, e, d in audit if e == "DEVICE_STATUS"]
    unparsed = [i for i, t in statuses if t is None]
    parsed = [t for _, t in statuses if t is not None]
    reasons = [r for _, r in parsed]
    states = sorted({s for s, _ in parsed})
    times = [t for _, t in rows]
    gaps = [b - a for a, b in zip(times, times[1:])]
    m, st = post["metrics"], post["status"]
    cmd_audit = sum(1 for _, e, _ in audit if e == "COMMAND_SENT")
    anomalies = sum(1 for _, e, _ in audit if e in {"P1_STATUS_UNCORRELATED", "P1_SEQUENCE_RESYNC"})
    fields: dict[str, Any] = {
        "observation_window_seconds": int(window), "core_pid": int(post["pid"]),
        "core_pid_unchanged": str(post["pid"]) == boundary["L9_PRE_CORE_PID"],
        "core_restart_count_unchanged": post["core"]["NRestarts"] == boundary["L9_PRE_CORE_NRESTARTS"],
        "detector_invocation_unchanged": post["detector"]["InvocationID"] == boundary["L9_PRE_DETECTOR_INVOCATION"]
        and post["detector"]["MainPID"] == boundary["L9_PRE_DETECTOR_PID"],
        "status_rows_observed": len(rows), "periodic_rows_observed": reasons.count("PERIODIC"),
        "boot_rows_observed": reasons.count("BOOT") + reasons.count("BOOT_GRACE"), "deadman_rows_observed": reasons.count("DEADMAN"),
        "other_reason_rows_observed": sum(1 for r in reasons if r not in {"PERIODIC", "BOOT", "BOOT_GRACE", "DEADMAN"}),
        "max_status_gap_seconds": int(max(gaps)) if gaps else 0,
        "output_state_observed": states[0] if len(states) == 1 else ("NONE" if not states else "MIXED"),
        "output_state_changed": len(states) > 1 or (bool(states) and states[0] != pre_uplink),
        "core_time_trust": str(st.get("time_trust")), "core_broker": str(st.get("broker")), "core_device": str(st.get("device")),
        "core_uplink": str(st.get("uplink")),
        "incident_state_unchanged": str(m["open_incidents"]) == boundary["L9_PRE_OPEN_INCIDENTS"],
        "episode_state_unchanged": str(m["open_episodes"]) == boundary["L9_PRE_OPEN_EPISODES"],
        "commands_emitted": int(m["command_rows"]) - int(boundary["L9_PRE_COMMAND_ROWS"]),
        "cut_emitted": 0, "restore_emitted": 0, "command_sent_audit_rows": cmd_audit,
        "relay_actuation": "NONE",
        "pre_protocol_seen_rowid": int(boundary["L9_PRE_PROTOCOL_SEEN_ID"]), "until_protocol_seen_rowid": until["protocol"],
        "pre_audit_id": int(boundary["L9_PRE_AUDIT_ID"]), "until_audit_id": until["audit"],
    }
    seq_moved = int(m["last_allocated_seq"]) != int(boundary["L9_PRE_LAST_ALLOCATED_SEQ"])
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
        ("AUDIT_STATUS_UNPARSEABLE", not unparsed),
        ("DEADMAN_OBSERVED", fields["deadman_rows_observed"] == 0),
        ("DEVICE_REBOOTED_DURING_OBSERVATION", fields["boot_rows_observed"] == 0),
        ("UNEXPECTED_STATUS_REASON", fields["other_reason_rows_observed"] == 0),
        ("PERIODIC_ROWS_INSUFFICIENT", fields["periodic_rows_observed"] >= MIN_PERIODIC_ROWS),
        ("AUTHENTICATED_ROWS_MISSING", len(rows) >= fields["periodic_rows_observed"] and len(rows) >= MIN_PERIODIC_ROWS),
        ("STATUS_GAP_TOO_LARGE", all(g <= MAX_STATUS_GAP_SECONDS for g in gaps)),
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
        "output_state_changed": False, "incident_state_unchanged": True, "episode_state_unchanged": True, "commands_emitted": 0,
        "cut_emitted": 0, "restore_emitted": 0, "command_sent_audit_rows": 0, "relay_actuation": "NONE", "core_time_trust": "SYNCED",
        "core_broker": "CONNECTED", "core_device": "ONLINE", "heartbeat_acceptance_basis": "NO_DEADMAN_OVER_WINDOW",
        "negative_probes_injected_live": "NO", "negative_probe_coverage": "REPOSITORY_FIXTURE_ONLY",
    }
    for key, want in expected.items():
        if data.get(key) != want or type(data.get(key)) is not type(want):
            raise ObserveError(f"EVIDENCE_FIELD_INVALID:{key}")
    ints = ("observation_window_seconds", "status_rows_observed", "periodic_rows_observed", "max_status_gap_seconds", "core_pid",
            "pre_protocol_seen_rowid", "until_protocol_seen_rowid", "pre_audit_id", "until_audit_id")
    if any(type(data.get(k)) is not int or data[k] < 0 for k in ints):
        raise ObserveError("EVIDENCE_NUMBER_INVALID")
    if data["observation_window_seconds"] < MIN_WINDOW_SECONDS:
        raise ObserveError("EVIDENCE_WINDOW_TOO_SHORT")
    if data["periodic_rows_observed"] < MIN_PERIODIC_ROWS or data["status_rows_observed"] < data["periodic_rows_observed"]:
        raise ObserveError("EVIDENCE_PERIODIC_ROWS_INSUFFICIENT")
    if data["max_status_gap_seconds"] > MAX_STATUS_GAP_SECONDS:
        raise ObserveError("EVIDENCE_STATUS_GAP_TOO_LARGE")
    if data["until_protocol_seen_rowid"] < data["pre_protocol_seen_rowid"] + data["status_rows_observed"] or data["until_audit_id"] <= data["pre_audit_id"]:
        raise ObserveError("EVIDENCE_BOUNDARY_INCONSISTENT")
    if data["output_state_observed"] in {"NONE", "MIXED"} or data["output_state_observed"] != data["core_uplink"]:
        raise ObserveError("EVIDENCE_OUTPUT_STATE_INCONSISTENT")
    if not _DEVICE_ID.fullmatch(str(data.get("device_id", ""))) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", str(data.get("run_id", ""))):
        raise ObserveError("EVIDENCE_IDENTIFIER_INVALID")


# ---------------------------------------------------------------------------- observe / verify


def observe(sources: Sources, marker_text: str, device_id: str, run_id: str, window_seconds: int,
            clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep) -> dict[str, Any]:
    if not MIN_WINDOW_SECONDS <= window_seconds <= MAX_WINDOW_SECONDS:
        raise ObserveError("WINDOW_OUT_OF_BOUNDS")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", run_id or ""):
        raise ObserveError("RUN_ID_INVALID")
    boundary = parse_marker(marker_text, device_id)
    start = float(boundary["L9_PRE_TIME"])
    if clock() < start:
        raise ObserveError("CLOCK_BEFORE_BOUNDARY")
    deadline = start + window_seconds
    hard_stop = deadline + 2 * STATUS_INTERVAL_SECONDS
    while True:
        now = clock()
        if now >= deadline:
            post = snapshot(sources, device_id, now)
            until = {"protocol": post["metrics"]["protocol_seen_rowid"], "audit": post["metrics"]["audit_id"]}
            rows = sources.status_rows(device_id, int(boundary["L9_PRE_PROTOCOL_SEEN_ID"]), until["protocol"])
            audit = sources.audit_rows(int(boundary["L9_PRE_AUDIT_ID"]), until["audit"])
            fields = evaluate(boundary, post, rows, audit, now - start, until)
            if fields["result"] == "PASS" or now >= hard_stop:
                break
            # An insufficient-row result can still heal until the hard stop; every other failure is final immediately.
            if fields["failure_boundary"] not in {"PERIODIC_ROWS_INSUFFICIENT", "AUTHENTICATED_ROWS_MISSING"}:
                break
        sleep(POLL_SECONDS)
    return {"schema_version": SCHEMA_VERSION, "run_id": run_id, "evidence_class": EVIDENCE_CLASS, "device_id": device_id, **fields}


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


def verify_evidence(path: Path, sources: Sources | None = None) -> dict[str, Any]:
    """Structure, privacy, recomputed invariants and (with sources) reconciliation against the Core's own durable rows."""
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
    if sources is not None:
        rows = sources.status_rows(data["device_id"], data["pre_protocol_seen_rowid"], data["until_protocol_seen_rowid"])
        audit = sources.audit_rows(data["pre_audit_id"], data["until_audit_id"])
        parsed = [_status_triplet(d) for _, e, d in audit if e == "DEVICE_STATUS"]
        if len(rows) != data["status_rows_observed"]:
            raise ObserveError("RECONCILIATION_STATUS_ROWS_MISMATCH")
        if sum(1 for t in parsed if t and t[1] == "PERIODIC") != data["periodic_rows_observed"] or any(t is None or t[1] != "PERIODIC" for t in parsed):
            raise ObserveError("RECONCILIATION_AUDIT_STATUS_MISMATCH")
        if any(e == "COMMAND_SENT" for _, e, _ in audit):
            raise ObserveError("RECONCILIATION_COMMAND_SENT_PRESENT")
    return data


# ---------------------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AEGIS L9 live observation (read-only)")
    sub = parser.add_subparsers(dest="command", required=True)
    cap = sub.add_parser("capture-boundary")
    cap.add_argument("--device-id", required=True)
    obs = sub.add_parser("observe")
    obs.add_argument("--marker", required=True)
    obs.add_argument("--evidence-dir", required=True)
    obs.add_argument("--device-id", required=True)
    obs.add_argument("--run-id", required=True)
    obs.add_argument("--window-seconds", type=int, default=MIN_WINDOW_SECONDS)
    ver = sub.add_parser("verify")
    ver.add_argument("--evidence-dir", required=True)
    args = parser.parse_args(argv)
    sources = RealSources()
    try:
        if args.command == "capture-boundary":
            for key, value in boundary_from_snapshot(snapshot(sources, args.device_id, time.time())).items():
                print(f"{key}={value}")
            return 0
        if args.command == "observe":
            marker = Path(args.marker)
            check_marker_file(marker)
            evidence_dir = Path(args.evidence_dir)
            if not evidence_dir.is_dir() or evidence_dir.is_symlink():
                raise ObserveError("EVIDENCE_DIR_INVALID")
            data = observe(sources, marker.read_text(encoding="utf-8"), args.device_id, args.run_id, args.window_seconds)
            write_evidence(evidence_dir / EVIDENCE_NAME, data)
            if data["result"] != "PASS":
                raise ObserveError(data["failure_boundary"])
            print("L9_LIVE_OBSERVE=PASS")
            return 0
        verify_evidence(Path(args.evidence_dir) / EVIDENCE_NAME, sources)
        print("L9_LIVE_VERIFY=PASS")
        return 0
    except ObserveError as exc:
        print(f"L9_LIVE={args.command.upper()}=FAIL reason={exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
