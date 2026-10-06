"""R1Dv: READ-ONLY validation of the ALREADY COMMITTED R1D historical-incident disposition.

R1Dv is a successor validation stage, NOT a retry or replay of R1D. This module only ever opens SQLite with ``mode=ro``; it contains no socket, no caller of the R1D channel, no write and no marker handling beyond
a read-only ``lstat`` of the governed R1D marker. It derives every fact from durable state (the audit rows, the incident row, the persistent one-shot index, the hash chain) and compares it with the
owner-authorized ORIGINAL R1D binding; it never trusts a failure receipt.

Limitation, stated honestly: after ``OPEN -> CLOSED`` the incident row no longer equals the row the R1D binding was computed over, so the binding cannot be recomputed from the CURRENT incident row. The durable audit
row written by the Core in the same transaction carries ``binding=<digest>`` and is required to equal the owner-authorized value; as additional (informational) evidence the digest is recomputed over the preserved
immutable provenance rows plus the original incident fields reconstructed as a hypothesis (the match, when it occurs, is cryptographic proof; a mismatch is not itself a failure).
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import sqlite3
import stat
import sys
from pathlib import Path
from typing import Any

from . import historical_disposition as hd

BASELINE_SCHEMA = "aegis.idea3.r1dv-baseline/1"
RESULT_SCHEMA = "aegis.idea3.r1dv-result/1"
CLAIMS = {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN": "NO"}
_SHA256 = re.compile(r"[0-9a-f]{64}")
_PEER = re.compile(r"peer_uid=(\d+) peer_pid=(\d+)")
_INCIDENT = re.compile(r"incident=(\d+) class=R1A_HISTORICAL_FAIL source=R1A_FAIL_IMMUTABLE successor=R1B recovery_r8=NO claims_promoted=NO binding=([0-9a-f]{64}) ")
# events that may NOT appear between the R1Dv PRE and POST observations (the read-only stage must see an unchanged historical state)
_FORBIDDEN_BETWEEN = (hd.ATTEMPT_EVENT, hd.EVENT_TYPE, "RECOVERY_R8_CLOSE", "INCIDENT_CLOSED", "RESTORE_REQUESTED", "RECOVERY_R3_REQUESTED", "RECOVERY_R3_RESULT", "RESTORE_BREAK_GLASS_CLAIM")


class ValidationError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def _one(conn: sqlite3.Connection, sql: str, args: tuple = ()) -> list[tuple]:
    return conn.execute(sql, args).fetchall()


def _marker_check(path: str | None) -> str:
    if not path:
        raise ValidationError("R1D_MARKER_PATH_REQUIRED")
    try:
        info = os.lstat(path)
    except OSError:
        raise ValidationError("R1D_MARKER_MISSING") from None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise ValidationError("R1D_MARKER_NOT_A_REGULAR_FILE")
    return "PRESENT"


def observe(audit_db: str, original_binding: str, marker_path: str | None) -> dict[str, Any]:
    """Validate the committed R1D state. Raises ``ValidationError`` with a stable, secret-free code on ANY deviation. Read-only."""
    if _SHA256.fullmatch(original_binding or "") is None:
        raise ValidationError("ORIGINAL_BINDING_PIN_INVALID")
    marker = _marker_check(marker_path)
    try:
        conn = hd._open_ro(audit_db)
    except hd.ObserverError as exc:
        raise ValidationError(exc.args[0]) from None
    try:
        attempts = _one(conn, "SELECT id, details FROM audit_logs WHERE event_type = ? ORDER BY id", (hd.ATTEMPT_EVENT,))
        dispositions = _one(conn, "SELECT id, details, incident_id FROM audit_logs WHERE event_type = ? ORDER BY id", (hd.EVENT_TYPE,))
        if len(attempts) != 1:
            raise ValidationError("ATTEMPT_ROW_COUNT_NOT_ONE")
        if len(dispositions) != 1:
            raise ValidationError("DISPOSITION_ROW_COUNT_NOT_ONE")
        (attempt_id, attempt_details), (disp_id, disp_details, disp_incident) = attempts[0], dispositions[0]
        if attempt_id >= disp_id:
            raise ValidationError("ATTEMPT_ROW_NOT_BEFORE_THE_DISPOSITION")
        a_peer, d_peer = _PEER.search(attempt_details or ""), _PEER.search(disp_details or "")
        if a_peer is None or d_peer is None or a_peer.groups() != d_peer.groups() or a_peer.group(1) != "0":
            raise ValidationError("ATTEMPT_AND_DISPOSITION_NOT_BY_THE_SAME_ROOT_PEER")
        detail = _INCIDENT.search(disp_details or "")
        if detail is None or disp_incident is None or int(detail.group(1)) != disp_incident:
            raise ValidationError("DISPOSITION_DETAILS_MALFORMED_OR_INCIDENT_MISMATCH")
        if not hmac.compare_digest(detail.group(2), original_binding):
            raise ValidationError("DISPOSITION_BINDING_NOT_THE_ORIGINAL_R1D_BINDING")
        iid = int(disp_incident)
        rows = _one(conn, "SELECT id, opened_at, closed_at, state, attacker_ip, summary FROM incidents WHERE id = ?", (iid,))
        if len(rows) != 1:
            raise ValidationError("HISTORICAL_INCIDENT_NOT_EXACTLY_ONE")
        incident = dict(zip(("id", "opened_at", "closed_at", "state", "attacker_ip", "summary"), rows[0], strict=True))
        if incident["state"] != "CLOSED" or not incident["closed_at"]:
            raise ValidationError("HISTORICAL_INCIDENT_NOT_CLOSED")
        if incident["summary"] != hd.DISPOSITION_SUMMARY:
            raise ValidationError("HISTORICAL_SUMMARY_NOT_THE_DISPOSITION_SUMMARY")
        open_count = int(_one(conn, "SELECT COUNT(*) FROM incidents WHERE state != 'CLOSED'")[0][0])
        if open_count != 0:
            raise ValidationError("OPEN_INCIDENTS_PRESENT")
        r8 = int(_one(conn, "SELECT COUNT(*) FROM audit_logs WHERE incident_id = ? AND event_type = 'RECOVERY_R8_CLOSE'", (iid,))[0][0])
        closed_events = int(_one(conn, "SELECT COUNT(*) FROM audit_logs WHERE incident_id = ? AND event_type = 'INCIDENT_CLOSED'", (iid,))[0][0])
        if r8 != 0 or closed_events != 0:
            raise ValidationError("RECOVERY_R8_OR_INCIDENT_CLOSED_ROW_PRESENT")
        audit_sql = "SELECT id, timestamp, level, event_type, details, incident_id, hash FROM audit_logs WHERE incident_id = ? AND event_type = ? ORDER BY id"
        bound_rows, accepted_rows = _one(conn, audit_sql, (iid, "INCIDENT_BOUND")), _one(conn, audit_sql, (iid, "ALERT_ACCEPTED"))
        if len(bound_rows) != 1 or len(accepted_rows) != 1:
            raise ValidationError("PROVENANCE_ROWS_NOT_EXACTLY_ONE_EACH")
        bound, accepted = dict(zip(hd._AUDIT_COLUMNS, bound_rows[0], strict=True)), dict(zip(hd._AUDIT_COLUMNS, accepted_rows[0], strict=True))
        b_match, a_match = hd._BOUND.fullmatch(bound["details"] or ""), hd._ACCEPTED.fullmatch(accepted["details"] or "")
        if (b_match is None or a_match is None or b_match.group(2) != "CREATED" or a_match.group(4) != "CREATED"
                or b_match.group(1) != incident["attacker_ip"] or a_match.group(3) != incident["attacker_ip"]):
            raise ValidationError("PROVENANCE_CONTRADICTORY")
        index_rows = _one(conn, "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name LIKE 'ux_audit_historical%'")
        if [name for name, _ in index_rows] != [hd.INDEX_NAME] or " ".join((index_rows[0][1] or "").split()) != hd.INDEX_DEFINITION:
            raise ValidationError("ONE_SHOT_INDEX_MISSING_OR_UNEXPECTED_DEFINITION")
        if not hd._chain_valid(conn):
            raise ValidationError("AUDIT_CHAIN_BROKEN")
        hypothesis = dict(incident, closed_at=None, state="OPEN", summary=None)
        recompute = "NOT_RECOMPUTABLE_FROM_CURRENT_STATE"
        try:
            if hmac.compare_digest(hd.binding_sha256(hypothesis, bound, accepted), original_binding):
                recompute = "MATCH"
        except KeyError:
            pass
        state = {
            "audit_max_id": int(_one(conn, "SELECT COALESCE(MAX(id), 0) FROM audit_logs")[0][0]), "incident_max_id": int(_one(conn, "SELECT COALESCE(MAX(id), 0) FROM incidents")[0][0]),
            "incident": incident, "attempt_id": attempt_id, "disposition_id": disp_id, "index_names": hd._index_names(conn),
        }
    finally:
        conn.close()
    checks = {
        "R1D_MARKER": marker, "R1DV_R1D_ATTEMPT_AUDIT_COUNT": 1, "R1DV_R1D_DISPOSITION_AUDIT_COUNT": 1, "R1DV_RECOVERY_R8_CLOSE_COUNT": 0, "R1DV_HISTORICAL_INCIDENT_STATE": "CLOSED",
        "PREEXISTING_OPEN_INCIDENT_COUNT": 0, "R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED": "YES", "R1DV_ONE_SHOT_INDEX": "PASS", "R1DV_AUDIT_INTEGRITY": "PASS",
        "R1DV_ORIGINAL_BINDING_IN_DISPOSITION_ROW": "MATCH", "R1DV_BINDING_RECOMPUTE": recompute, "R1DV_HISTORICAL_INCIDENT_ID": iid,
    }
    return {"state": state, "checks": checks}


def compare_states(before: dict[str, Any], after: dict[str, Any], audit_db: str) -> None:
    """PRE -> POST: the historical state must be identical and nothing forbidden may have been appended; read-only."""
    if before["incident"] != after["incident"] or before["attempt_id"] != after["attempt_id"] or before["disposition_id"] != after["disposition_id"] or before["index_names"] != after["index_names"]:
        raise ValidationError("HISTORICAL_STATE_CHANGED_BETWEEN_PRE_AND_POST")
    if before["incident_max_id"] != after["incident_max_id"]:
        raise ValidationError("INCIDENT_SET_CHANGED_BETWEEN_PRE_AND_POST")
    if after["audit_max_id"] < before["audit_max_id"]:
        raise ValidationError("AUDIT_LOG_SHRANK")
    conn = hd._open_ro(audit_db)
    try:
        marks = ",".join("?" for _ in _FORBIDDEN_BETWEEN)
        if conn.execute(f"SELECT 1 FROM audit_logs WHERE id > ? AND event_type IN ({marks}) LIMIT 1", (before["audit_max_id"], *_FORBIDDEN_BETWEEN)).fetchone() is not None:
            raise ValidationError("FORBIDDEN_AUDIT_EVENT_APPENDED_BETWEEN_PRE_AND_POST")
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="aegis_soc.historical_validation", description="R1Dv read-only observer")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("baseline", "final"):
        item = sub.add_parser(name)
        item.add_argument("--audit-db", required=True)
        item.add_argument("--original-binding-sha256", required=True)
        item.add_argument("--marker", required=True)
        item.add_argument("--out", required=True)
        if name == "final":
            item.add_argument("--baseline", required=True)
    args = parser.parse_args(argv)
    try:
        observed = observe(args.audit_db, args.original_binding_sha256, args.marker)
        if args.command == "baseline":
            document = {"schema": BASELINE_SCHEMA, "original_binding_sha256": args.original_binding_sha256, **observed}
        else:
            baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8"))
            if baseline.get("schema") != BASELINE_SCHEMA or baseline.get("original_binding_sha256") != args.original_binding_sha256:
                raise ValidationError("BASELINE_INVALID")
            compare_states(baseline["state"], observed["state"], args.audit_db)
            document = {"schema": RESULT_SCHEMA, "result": "PASS", "reason": "OK", "original_binding_sha256": args.original_binding_sha256, "claims": dict(CLAIMS), **observed}
        hd._write_exclusive(args.out, document)
        print(f"R1DV_OBSERVER={'BASELINE' if args.command == 'baseline' else 'PASS'}")
    except (ValidationError, OSError, ValueError, sqlite3.Error) as error:
        code = getattr(error, "code", None) or str(error) or type(error).__name__
        print(f"R1DV_OBSERVER=FAIL reason={code}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
