"""R1D: Core-mediated, atomic, evidence-preserving disposition of the preserved historical R1A incident.

This is NOT Recovery R8 and NOT a generic close. It exists only so that the governed R1B stage (which needs a NEW incident with ``CREATED``
semantics) can run after the immutable failed R1A attempt left incident #1 OPEN. Properties:

* a dedicated local AF_UNIX channel, peer uid 0 only (``SO_PEERCRED``), no network listener, no operation on the normal Recovery protocol;
* INERT by default (exact flag, production profile, configured detector authority) and permanently dead after one successful disposition;
* the Core derives the target incident itself from durable provenance; the caller supplies only a binding digest (confirmation, never a selector);
* ONE all-or-nothing database transaction (see ``database.dispose_historical_incident_atomic``).
"""

from __future__ import annotations

import hashlib
import hmac
import argparse
import json
import math
import os
import re
import socket
import sqlite3
import stat
import struct
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import database as db
from . import local_restore as lr
from .ip_containment import ContainmentRejected, parse_ipv4

BINDING_VERSION = "R1D_BINDING_V1"
EVENT_TYPE = db.HISTORICAL_DISPOSITION_EVENT  # INCIDENT_DISPOSED_HISTORICAL — never RECOVERY_R8_CLOSE / INCIDENT_CLOSED
OP_DISPOSE = "DISPOSE_HISTORICAL"
CHANNEL_NAME = "historical-disposition.sock"
REQUIRED_PEER_UID = 0
MAX_MESSAGE_BYTES = 512
REQUEST_DEADLINE_SEC = 5.0
DISPOSITION_SUMMARY = "HISTORICAL_DISPOSITION R1A_FAIL_IMMUTABLE (not a Recovery closure)"

_SHA256 = re.compile(r"[0-9a-f]{64}")
_BOUND = re.compile(r"attacker_ip=(\d{1,3}(?:\.\d{1,3}){3}) source=detector_alert action=(\w+)")
_ACCEPTED = re.compile(r"uid=(\d+) pid=(\d+) attacker_ip=(\d{1,3}(?:\.\d{1,3}){3}) action=(\w+)")
_INCIDENT_COLUMNS = ("id", "opened_at", "closed_at", "state", "attacker_ip", "summary")
_AUDIT_COLUMNS = ("id", "timestamp", "level", "event_type", "details", "incident_id", "hash")
# durable Recovery R3/R4/R5/R8 evidence that must NOT exist for the incident (a past read-only R2/R6/R7 probe leaves no durable row and is NOT claimed absent)
_RECOVERY_EVIDENCE = ("RECOVERY_R3_REQUESTED", "RECOVERY_R3_RESULT", "RESTORE_REQUESTED", "RESTORE_BREAK_GLASS_CLAIM", "RECOVERY_R8_CLOSE", "INCIDENT_CLOSED", "RECOVERY_STEP")
_NULL_INCIDENT_RESTORE = ("RESTORE_REQUESTED", "RESTORE_BREAK_GLASS_CLAIM")


class Refused(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class DispositionChannelError(RuntimeError):
    pass


def enabled(profile: str, *, enabled_flag: str) -> bool:
    """The channel is inert unless production AND the flag is EXACTLY ``YES`` (no whitespace, no case folding)."""
    return profile == "production" and enabled_flag == "YES"


def _row(columns: tuple[str, ...], values) -> dict[str, Any]:
    return dict(zip(columns, values, strict=True))


def canonical_binding_bytes(incident: dict[str, Any], bound: dict[str, Any], accepted: dict[str, Any]) -> bytes:
    """``R1D_BINDING_V1``: versioned canonical JSON (sorted keys, compact, ASCII) of exactly the incident row and the two provenance rows."""
    document = {
        "v": BINDING_VERSION,
        "incident": {key: incident[key] for key in _INCIDENT_COLUMNS},
        "incident_bound": {key: bound[key] for key in _AUDIT_COLUMNS},
        "alert_accepted": {key: accepted[key] for key in _AUDIT_COLUMNS},
    }
    return json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def binding_sha256(incident: dict[str, Any], bound: dict[str, Any], accepted: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_binding_bytes(incident, bound, accepted)).hexdigest()


def _evaluate(conn: sqlite3.Connection, detector_uid: int | None) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    """The complete eligibility predicate against ONE connection/transaction. Raises ``Refused`` with a stable, secret-free code."""
    if detector_uid is None:
        raise Refused("DETECTOR_UID_UNCONFIGURED")
    if conn.execute("SELECT 1 FROM audit_logs WHERE event_type = ? LIMIT 1", (EVENT_TYPE,)).fetchone() is not None:
        raise Refused("ALREADY_DISPOSED")
    open_rows = conn.execute(
        "SELECT id, opened_at, closed_at, state, attacker_ip, summary FROM incidents WHERE state != 'CLOSED' ORDER BY id"
    ).fetchall()
    if not open_rows:
        raise Refused("NO_OPEN_INCIDENT")
    if len(open_rows) > 1:
        raise Refused("AMBIGUOUS_OPEN_INCIDENTS")
    incident = _row(_INCIDENT_COLUMNS, open_rows[0])
    if incident["state"] != "OPEN":
        raise Refused("INCIDENT_NOT_OPEN_STATE")
    try:
        address = parse_ipv4(incident["attacker_ip"])
    except ContainmentRejected:
        raise Refused("ATTACKER_IP_INVALID") from None
    if address.is_unspecified or address.is_loopback or address.is_multicast or address.is_link_local:
        raise Refused("ATTACKER_IP_INVALID")
    ip = str(address)
    audit_sql = "SELECT id, timestamp, level, event_type, details, incident_id, hash FROM audit_logs WHERE incident_id = ? AND event_type = ? ORDER BY id"
    bound_rows = conn.execute(audit_sql, (incident["id"], "INCIDENT_BOUND")).fetchall()
    accepted_rows = conn.execute(audit_sql, (incident["id"], "ALERT_ACCEPTED")).fetchall()
    if len(bound_rows) != 1 or len(accepted_rows) != 1:
        raise Refused("PROVENANCE_MISSING_OR_AMBIGUOUS")
    bound, accepted = _row(_AUDIT_COLUMNS, bound_rows[0]), _row(_AUDIT_COLUMNS, accepted_rows[0])
    bound_match = _BOUND.fullmatch(bound["details"] or "")
    accepted_match = _ACCEPTED.fullmatch(accepted["details"] or "")
    if bound_match is None or accepted_match is None or bound_match.group(2) != "CREATED" or accepted_match.group(4) != "CREATED":
        raise Refused("PROVENANCE_MISSING_OR_AMBIGUOUS")
    if bound_match.group(1) != ip or accepted_match.group(3) != ip:
        raise Refused("ALERT_IP_MISMATCH")
    if int(accepted_match.group(1)) != int(detector_uid) or int(accepted_match.group(2)) <= 0:
        raise Refused("ALERT_UID_MISMATCH")
    marks = ",".join("?" for _ in _RECOVERY_EVIDENCE)
    if conn.execute(f"SELECT 1 FROM audit_logs WHERE incident_id = ? AND event_type IN ({marks}) LIMIT 1", (incident["id"], *_RECOVERY_EVIDENCE)).fetchone() is not None:
        raise Refused("RECOVERY_EVIDENCE_PRESENT")
    null_marks = ",".join("?" for _ in _NULL_INCIDENT_RESTORE)
    if conn.execute(
        f"SELECT 1 FROM audit_logs WHERE incident_id IS NULL AND id > ? AND event_type IN ({null_marks}) LIMIT 1", (accepted["id"], *_NULL_INCIDENT_RESTORE)
    ).fetchone() is not None:
        raise Refused("RECOVERY_EVIDENCE_PRESENT")
    return incident, bound, accepted


def read_binding(audit_db: str, detector_uid: int | None) -> dict[str, Any]:
    """Owner/runner READ-ONLY computation of the binding (SQLite opened ``mode=ro``): the value pinned in the Authorization. Mutates nothing."""
    path = Path(audit_db)
    if not path.is_absolute() or ".." in path.parts:
        raise Refused("AUDIT_DB_PATH_INVALID")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        incident, bound, accepted = _evaluate(conn, detector_uid)
    finally:
        conn.close()
    data = canonical_binding_bytes(incident, bound, accepted)
    return {"incident_id": incident["id"], "binding_sha256": hashlib.sha256(data).hexdigest(), "canonical_bytes": data}


def disposition_exists() -> bool:
    """True when the one-shot disposition row exists (fail closed to True when the database cannot be read)."""
    try:
        conn = db._connect()
        try:
            return conn.execute("SELECT 1 FROM audit_logs WHERE event_type = ? LIMIT 1", (EVENT_TYPE,)).fetchone() is not None
        finally:
            conn.close()
    except Exception:
        return True


def _response(ok: bool, code: str, message: str = "", **extra: Any) -> dict[str, Any]:
    return {"ok": ok, "code": code, "message": message, **extra}


class HistoricalDispositionService:
    def __init__(self, *, profile: str, detector_uid: int | None, required_peer_uid: int = REQUIRED_PEER_UID) -> None:
        self.profile = profile
        self.detector_uid = detector_uid
        self.required_peer_uid = required_peer_uid

    @staticmethod
    def _valid_request(body: Any) -> str | None:
        if not isinstance(body, dict) or set(body) != {"v", "op", "binding_sha256"}:
            return None
        if body["v"] != 1 or type(body["v"]) is not int or body["op"] != OP_DISPOSE:
            return None
        digest = body["binding_sha256"]
        if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
            return None
        return digest

    def dispose(self, body: Any, peer: lr.Peer) -> dict[str, Any]:
        if peer.uid != self.required_peer_uid:
            return _response(False, "PEER_REFUSED", "request is not from the required local peer")
        if self.profile != "production":
            return _response(False, "NOT_PRODUCTION", "the historical disposition exists only in production")
        digest = self._valid_request(body)
        if digest is None:
            return _response(False, "REQUEST_INVALID", "the request is not exactly the disposition request")

        def plan(conn: sqlite3.Connection) -> dict[str, Any]:
            incident, bound, accepted = _evaluate(conn, self.detector_uid)
            expected = binding_sha256(incident, bound, accepted)  # the Core reconstructs the bytes itself; the caller's digest is confirmation only
            if not hmac.compare_digest(expected, digest):
                raise Refused("BINDING_MISMATCH")
            details = (
                f"incident={incident['id']} class=R1A_HISTORICAL_FAIL source=R1A_FAIL_IMMUTABLE successor=R1B recovery_r8=NO claims_promoted=NO "
                f"binding={expected} peer_uid={peer.uid} peer_pid={peer.pid}"
            )
            return {"incident_id": incident["id"], "details": details}

        try:
            incident_id = db.dispose_historical_incident_atomic(plan, summary=DISPOSITION_SUMMARY)
        except Refused as refusal:
            return _response(False, refusal.code, "the historical disposition is not eligible")
        except Exception:
            return _response(False, "DISPOSITION_FAILED", "the transaction failed and was rolled back")
        return _response(True, "DISPOSED", f"incident #{incident_id} historically disposed (not Recovery R8)", incident_id=incident_id)


def _peer_from(connection: socket.socket) -> lr.Peer:
    raw = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, _gid = struct.unpack("3i", raw)
    return lr.Peer(uid=uid, pid=pid)


class HistoricalDispositionServer:
    """Core-owned AF_UNIX server (0600): peer-credential checked BEFORE any byte is read, bounded, one request per connection; closes for good after a success."""

    def __init__(self, path: Path | str, service: HistoricalDispositionService, *, allowed_uid: int = REQUIRED_PEER_UID) -> None:
        self.path = Path(path)
        self.service = service
        self.allowed_uid = int(allowed_uid)
        self._listener: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._done = threading.Event()

    def finished(self) -> bool:
        return self._done.is_set()

    def _prepare_path(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        parent = self.path.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or stat.S_IMODE(parent.st_mode) & 0o022:
            raise DispositionChannelError("the runtime directory must be Core-owned and not group/world writable")
        try:
            metadata = self.path.lstat()
        except FileNotFoundError:
            return
        if not stat.S_ISSOCK(metadata.st_mode):
            raise DispositionChannelError("refusing to replace a non-socket path")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.settimeout(0.1)
            probe.connect(str(self.path))
        except OSError:
            self.path.unlink()
        else:
            raise DispositionChannelError("a disposition server is already listening")
        finally:
            probe.close()

    def start(self) -> None:
        if self._listener is not None:
            return
        if disposition_exists():  # permanently dead after a recorded disposition (also after a Core restart)
            raise DispositionChannelError("a historical disposition already exists; the channel stays closed")
        self._prepare_path()
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            listener.bind(str(self.path))
            os.chmod(self.path, 0o600)  # Core-private: never group- or world-reachable
            listener.listen(1)
            listener.settimeout(0.2)
        except BaseException:
            listener.close()
            raise
        self._listener = listener
        self._stop.clear()
        self._thread = threading.Thread(target=self._serve, name="aegis-core-r1d", daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        assert self._listener is not None
        while not self._stop.is_set():
            try:
                connection, _ = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                break
            with connection:
                connection.settimeout(REQUEST_DEADLINE_SEC)
                try:
                    response = self._read_and_handle(connection)
                except Exception:
                    response = _response(False, "OUTCOME_UNKNOWN", "the result was lost; do not assume success")
                try:
                    connection.sendall(json.dumps(response, ensure_ascii=True).encode("ascii") + b"\n")
                except OSError:
                    pass
            if response.get("ok") is True:
                break
        self._finish()

    def _finish(self) -> None:
        listener, self._listener = self._listener, None
        if listener is not None:
            listener.close()
        try:
            if stat.S_ISSOCK(self.path.lstat().st_mode):
                self.path.unlink()
        except FileNotFoundError:
            pass
        self._done.set()

    def _read_and_handle(self, connection: socket.socket) -> dict[str, Any]:
        try:
            peer = _peer_from(connection)
        except OSError:
            return _response(False, "PEER_REFUSED", "peer credentials unavailable")
        if peer.uid != self.allowed_uid:
            return _response(False, "PEER_REFUSED", "request is not from the required local peer")  # before reading a single request byte
        deadline = time.monotonic() + REQUEST_DEADLINE_SEC
        data = bytearray()
        try:
            while len(data) <= MAX_MESSAGE_BYTES:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError
                connection.settimeout(remaining)
                chunk = connection.recv(min(256, MAX_MESSAGE_BYTES + 1 - len(data)))
                if not chunk:
                    break
                data.extend(chunk)
                if b"\n" in chunk:
                    break
            if len(data) > MAX_MESSAGE_BYTES:
                raise ValueError
            body = json.loads(bytes(data).split(b"\n", 1)[0].decode("utf-8"))
        except (OSError, UnicodeError, ValueError):
            return _response(False, "REQUEST_INVALID", "the request is not exactly the disposition request")
        return self.service.dispose(body, peer)

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None
        self._finish()


# --------------------------------------------------------------------------- read-only observer CLI (run by the frozen runner from the IMMUTABLE verifier snapshot)
BASELINE_SCHEMA = "aegis.idea3.r1d-baseline/1"
RESULT_SCHEMA = "aegis.idea3.r1d-result/1"
CLAIMS = {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"}


class ObserverError(Exception):
    pass


def _open_ro(audit_db: str) -> sqlite3.Connection:
    path = Path(audit_db)
    if not path.is_absolute() or ".." in path.parts:
        raise ObserverError("AUDIT_DB_PATH_INVALID")
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def _chain_valid(conn: sqlite3.Connection) -> bool:
    previous = "GENESIS"
    for _id, timestamp, level, event_type, details, stored in conn.execute(
        "SELECT id, timestamp, level, event_type, details, hash FROM audit_logs ORDER BY id"
    ):
        if db._compute_hash(timestamp, level, event_type, details, previous) != stored:
            return False
        previous = stored
    return True


def _marks(conn: sqlite3.Connection) -> dict[str, int]:
    return {
        "audit_max_id": int(conn.execute("SELECT COALESCE(MAX(id), 0) FROM audit_logs").fetchone()[0]),
        "incident_max_id": int(conn.execute("SELECT COALESCE(MAX(id), 0) FROM incidents").fetchone()[0]),
        "open_incidents": int(conn.execute("SELECT COUNT(*) FROM incidents WHERE state != 'CLOSED'").fetchone()[0]),
    }


def _write_exclusive(path: str, document: dict[str, Any]) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(document, handle, sort_keys=True, indent=1)
        handle.write("\n")


def capture_baseline(audit_db: str, detector_uid: int, binding: str) -> dict[str, Any]:
    """Read-only PRE record: the preserved historical incident is the single eligible one AND its binding equals the owner-authorized value."""
    if _SHA256.fullmatch(binding or "") is None:
        raise ObserverError("BINDING_PIN_INVALID")
    conn = _open_ro(audit_db)
    try:
        try:
            incident, bound, accepted = _evaluate(conn, detector_uid)
        except Refused as refusal:
            raise ObserverError(refusal.code) from None
        if not hmac.compare_digest(binding_sha256(incident, bound, accepted), binding):
            raise ObserverError("BINDING_NOT_THE_PINNED_VALUE")
        if not _chain_valid(conn):
            raise ObserverError("AUDIT_CHAIN_BROKEN")
        marks = _marks(conn)
    finally:
        conn.close()
    if marks["open_incidents"] != 1:
        raise ObserverError("OPEN_INCIDENT_COUNT_NOT_ONE")
    return {"schema": BASELINE_SCHEMA, "incident_id": incident["id"], "binding_sha256": binding, "incident": incident, **marks}


def window_check(audit_db: str, detector_uid: int, window_record: str) -> dict[str, Any]:
    """The incident's own durable times are compatible with the preserved R1A window (whole-second audit granularity: floor(start) <= t <= end)."""
    values: dict[str, float] = {}
    for line in Path(window_record).read_text(encoding="utf-8").splitlines():
        key, _, value = line.partition("=")
        if key in ("window_start", "window_end"):
            try:
                values[key] = float(value)
            except ValueError:
                raise ObserverError("R1A_WINDOW_RECORD_MALFORMED") from None
    start, end = values.get("window_start"), values.get("window_end")
    if start is None or end is None or not (math.isfinite(start) and math.isfinite(end)) or start <= 0 or end <= start:
        raise ObserverError("R1A_WINDOW_RECORD_MALFORMED")
    conn = _open_ro(audit_db)
    try:
        try:
            incident, bound, accepted = _evaluate(conn, detector_uid)
        except Refused as refusal:
            raise ObserverError(refusal.code) from None
    finally:
        conn.close()
    for label, stamp in (("INCIDENT_OPENED", incident["opened_at"]), ("INCIDENT_BOUND", bound["timestamp"]), ("ALERT_ACCEPTED", accepted["timestamp"])):
        try:
            moment = time.mktime(time.strptime(stamp, "%Y-%m-%d %H:%M:%S"))
        except (TypeError, ValueError):
            raise ObserverError(f"{label}_TIME_MALFORMED") from None
        if not (math.floor(start) <= moment <= end):
            raise ObserverError(f"{label}_OUTSIDE_THE_R1A_WINDOW")
    return {"R1A_WINDOW_COMPATIBLE": "YES"}


def verify_final(audit_db: str, baseline: dict[str, Any], binding: str) -> dict[str, Any]:
    """Read-only POST proof: ONLY the expected state changed (one OPEN->CLOSED row, one disposition audit row, the chain advance)."""
    if baseline.get("schema") != BASELINE_SCHEMA or baseline.get("binding_sha256") != binding:
        raise ObserverError("BASELINE_INVALID")
    iid, before = baseline["incident_id"], baseline["incident"]
    conn = _open_ro(audit_db)
    try:
        marks = _marks(conn)
        if marks["open_incidents"] != 0:
            raise ObserverError("HISTORICAL_INCIDENT_STILL_OPEN")
        rows = conn.execute("SELECT id, details, incident_id FROM audit_logs WHERE event_type = ?", (EVENT_TYPE,)).fetchall()
        if len(rows) != 1 or rows[0][2] != iid or f"binding={binding}" not in rows[0][1] or "recovery_r8=NO claims_promoted=NO" not in rows[0][1]:
            raise ObserverError("DISPOSITION_AUDIT_ROW_MISSING_OR_AMBIGUOUS")
        if conn.execute(
            "SELECT 1 FROM audit_logs WHERE id > ? AND event_type IN ('RECOVERY_R8_CLOSE','INCIDENT_CLOSED','RESTORE_REQUESTED','RECOVERY_R3_REQUESTED','RECOVERY_R3_RESULT') LIMIT 1",
            (baseline["audit_max_id"],),
        ).fetchone() is not None:
            raise ObserverError("RECOVERY_EVENT_FABRICATED_OR_PRESENT")
        if marks["audit_max_id"] != baseline["audit_max_id"] + 1 or rows[0][0] != marks["audit_max_id"]:
            raise ObserverError("AUDIT_ADVANCE_NOT_EXACTLY_ONE_ROW")
        if marks["incident_max_id"] != baseline["incident_max_id"]:
            raise ObserverError("INCIDENT_SET_CHANGED")
        row = conn.execute("SELECT id, opened_at, closed_at, state, attacker_ip, summary FROM incidents WHERE id = ?", (iid,)).fetchone()
        if row is None or row[3] != "CLOSED" or not row[2] or row[5] != DISPOSITION_SUMMARY or row[1] != before["opened_at"] or row[4] != before["attacker_ip"]:
            raise ObserverError("INCIDENT_NOT_EXACTLY_THE_EXPECTED_TRANSITION")
        if not _chain_valid(conn):
            raise ObserverError("AUDIT_CHAIN_BROKEN")
    finally:
        conn.close()
    return {
        "schema": RESULT_SCHEMA, "result": "PASS", "reason": "OK", "incident_id": iid, "binding_sha256": binding, "claims": dict(CLAIMS),
        "checks": {
            "PREEXISTING_OPEN_INCIDENT_COUNT": 0, "R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED": "YES", "R1B_ATTEMPT_CONSUMED": "NO",
            "DISPOSITION_AUDIT_ROW": "ONE", "HASH_CHAIN": "VALID", "RECOVERY_R8_FABRICATED": "NO",
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aegis_soc.historical_disposition", description="R1D read-only observer")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("binding", "baseline", "window-check", "final"):
        item = sub.add_parser(name)
        item.add_argument("--audit-db", required=True)
        if name != "final":
            item.add_argument("--detector-uid", type=int, required=True)
        if name in ("baseline", "final"):
            item.add_argument("--binding-sha256", required=True)
            item.add_argument("--out", required=True)
        if name == "final":
            item.add_argument("--baseline", required=True)
        if name == "window-check":
            item.add_argument("--window-record", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "binding":
            info = read_binding(args.audit_db, args.detector_uid)
            print(f"R1D_BINDING_SHA256={info['binding_sha256']} R1D_INCIDENT_ID={info['incident_id']}")
        elif args.command == "baseline":
            _write_exclusive(args.out, capture_baseline(args.audit_db, args.detector_uid, args.binding_sha256))
            print("R1D_BASELINE=CAPTURED")
        elif args.command == "window-check":
            window_check(args.audit_db, args.detector_uid, args.window_record)
            print("R1A_WINDOW_COMPATIBLE=YES")
        else:
            baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
            _write_exclusive(args.out, verify_final(args.audit_db, baseline, args.binding_sha256))
            print("R1D_FINAL=PASS")
    except (ObserverError, Refused, OSError, ValueError, sqlite3.Error) as error:
        code = getattr(error, "code", None) or str(error) or type(error).__name__
        print(f"R1D_OBSERVER=FAIL reason={code}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
