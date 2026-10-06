"""R1Dv read-only observer: validates the ALREADY COMMITTED R1D disposition from durable state. Hermetic: a temporary SQLite database written through the real `database` and `historical_disposition` code
(the same path R1D took), never a real database, socket, device or host path."""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from aegis_soc import config  # noqa: E402
from aegis_soc import database as db  # noqa: E402
from aegis_soc import historical_disposition as hd  # noqa: E402
from aegis_soc import historical_validation as hv  # noqa: E402
from aegis_soc import local_restore as lr  # noqa: E402

UID, IP = 987, "203.0.113.9"
ROOT_PEER = lr.Peer(uid=0, pid=1234)


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "audit.sqlite3"))
    monkeypatch.setattr(config, "ALERT_SOURCE_UID", UID)
    monkeypatch.setattr("aegis_soc.comms.send_ops_alert", lambda *a, **k: None)
    db.init_db()
    marker = tmp_path / "R1D-GLOBAL-ATTEMPT-CONSUMED"
    marker.write_text("consumed_at=x\n")
    return {"db": config.DB_PATH, "marker": str(marker), "tmp": tmp_path}


def committed(world) -> str:
    """Drive the REAL R1D path (seed an open incident, record the attempt, dispose) and return the original binding."""
    incident = db.create_incident(IP)
    db.log_event_strict("INCIDENT_BOUND", f"attacker_ip={IP} source=detector_alert action=CREATED", db.WARN, incident)
    db.log_event_strict("ALERT_ACCEPTED", f"uid={UID} pid=4321 attacker_ip={IP} action=CREATED", db.INFO, incident)
    binding = hd.read_binding(world["db"], UID)["binding_sha256"]
    hd.record_attempt(ROOT_PEER)
    service = hd.HistoricalDispositionService(profile="production", detector_uid=UID)
    assert service.dispose({"v": 1, "op": hd.OP_DISPOSE, "binding_sha256": binding}, ROOT_PEER)["ok"] is True
    return binding


def sql(world, statement: str, *args) -> None:
    conn = sqlite3.connect(world["db"])
    conn.execute(statement, args)
    conn.commit()
    conn.close()


def run(world, binding, **kw):
    return hv.observe(world["db"], binding, kw.get("marker", world["marker"]))


def refused(world, binding, code, **kw):
    with pytest.raises(hv.ValidationError) as error:
        run(world, binding, **kw)
    assert error.value.code == code


# ---------------------------------------------------------------- PASS
def test_the_committed_r1d_state_validates_and_the_observer_is_read_only(world):
    binding = committed(world)
    before = Path(world["db"]).read_bytes()
    out = run(world, binding)
    assert Path(world["db"]).read_bytes() == before  # no write of any kind
    c = out["checks"]
    assert c["R1DV_R1D_ATTEMPT_AUDIT_COUNT"] == 1 and c["R1DV_R1D_DISPOSITION_AUDIT_COUNT"] == 1 and c["R1DV_RECOVERY_R8_CLOSE_COUNT"] == 0
    assert c["R1DV_HISTORICAL_INCIDENT_STATE"] == "CLOSED" and c["PREEXISTING_OPEN_INCIDENT_COUNT"] == 0 and c["R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED"] == "YES"
    assert c["R1DV_ONE_SHOT_INDEX"] == "PASS" and c["R1DV_AUDIT_INTEGRITY"] == "PASS" and c["R1DV_ORIGINAL_BINDING_IN_DISPOSITION_ROW"] == "MATCH"
    assert c["R1DV_BINDING_RECOMPUTE"] == "MATCH"  # the preserved provenance rows plus the reconstructed original incident fields reproduce the owner-authorized digest


def test_the_cli_writes_a_baseline_then_a_final_result_without_mutating(world, capsys):
    binding = committed(world)
    base, res = str(world["tmp"] / "b.json"), str(world["tmp"] / "r.json")
    before = Path(world["db"]).read_bytes()
    assert hv.main(["baseline", "--audit-db", world["db"], "--original-binding-sha256", binding, "--marker", world["marker"], "--out", base]) == 0
    assert hv.main(["final", "--audit-db", world["db"], "--original-binding-sha256", binding, "--marker", world["marker"], "--baseline", base, "--out", res]) == 0
    result = json.loads(Path(res).read_text())
    assert result["result"] == "PASS" and result["claims"] == hv.CLAIMS and Path(world["db"]).read_bytes() == before


# ---------------------------------------------------------------- FAIL fixtures
def test_a_missing_or_wrong_marker_fails(world):
    binding = committed(world)
    refused(world, binding, "R1D_MARKER_MISSING", marker=str(world["tmp"] / "absent"))
    link = world["tmp"] / "link"
    link.symlink_to(world["marker"])
    refused(world, binding, "R1D_MARKER_NOT_A_REGULAR_FILE", marker=str(link))
    refused(world, binding, "R1D_MARKER_PATH_REQUIRED", marker=None)


@pytest.mark.parametrize("statement,code", [
    ("DELETE FROM audit_logs WHERE event_type = 'R1D_DISPOSITION_ATTEMPT_RECORDED'", "ATTEMPT_ROW_COUNT_NOT_ONE"),
    ("DELETE FROM audit_logs WHERE event_type = 'INCIDENT_DISPOSED_HISTORICAL'", "DISPOSITION_ROW_COUNT_NOT_ONE"),
])
def test_attempt_or_disposition_row_count_zero_fails(world, statement, code):
    binding = committed(world)
    sql(world, statement)
    refused(world, binding, code)


def test_a_second_attempt_row_fails(world):
    binding = committed(world)
    sql(world, "INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id, hash) VALUES ('t','INFO','R1D_DISPOSITION_ATTEMPT_RECORDED','peer_uid=0 peer_pid=1234','NULL','h')")
    refused(world, binding, "ATTEMPT_ROW_COUNT_NOT_ONE")


def test_a_second_disposition_row_fails(world):
    binding = committed(world)
    sql(world, "DROP INDEX ux_audit_historical_disposition")
    sql(world, "INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id, hash) VALUES ('t','INFO','INCIDENT_DISPOSED_HISTORICAL','x',1,'h')")
    refused(world, binding, "DISPOSITION_ROW_COUNT_NOT_ONE")


def test_the_incident_not_closed_fails(world):
    binding = committed(world)
    sql(world, "UPDATE incidents SET state='OPEN', closed_at=NULL WHERE id=1")
    refused(world, binding, "HISTORICAL_INCIDENT_NOT_CLOSED")


def test_a_second_open_incident_fails(world):
    binding = committed(world)
    sql(world, "INSERT INTO incidents (opened_at, state, attacker_ip) VALUES ('2026-01-01 00:00:00','OPEN','198.51.100.2')")
    refused(world, binding, "OPEN_INCIDENTS_PRESENT")


@pytest.mark.parametrize("event", ["RECOVERY_R8_CLOSE", "INCIDENT_CLOSED"])
def test_a_recovery_closure_row_for_the_incident_fails(world, event):
    binding = committed(world)
    db.log_event_strict(event, "x", db.INFO, 1)
    refused(world, binding, "RECOVERY_R8_OR_INCIDENT_CLOSED_ROW_PRESENT")


def test_a_wrong_or_missing_index_fails(world):
    binding = committed(world)
    sql(world, "DROP INDEX ux_audit_historical_disposition")
    refused(world, binding, "ONE_SHOT_INDEX_MISSING_OR_UNEXPECTED_DEFINITION")


def test_a_wrong_index_definition_fails(world):
    binding = committed(world)
    sql(world, "DROP INDEX ux_audit_historical_disposition")
    sql(world, "CREATE INDEX ux_audit_historical_disposition ON audit_logs (timestamp)")
    refused(world, binding, "ONE_SHOT_INDEX_MISSING_OR_UNEXPECTED_DEFINITION")


def test_an_extra_historical_index_fails(world):
    binding = committed(world)
    sql(world, "CREATE INDEX ux_audit_historical_extra ON audit_logs (timestamp)")
    refused(world, binding, "ONE_SHOT_INDEX_MISSING_OR_UNEXPECTED_DEFINITION")


def test_a_broken_audit_chain_fails(world):
    binding = committed(world)
    sql(world, "UPDATE audit_logs SET details = details || 'x' WHERE event_type = 'INCIDENT_BOUND'")
    refused(world, binding, "PROVENANCE_CONTRADICTORY")  # a tampered row is caught by the provenance check or the chain, whichever sees it first
    sql(world, "UPDATE audit_logs SET details = substr(details, 1, length(details) - 1) WHERE event_type = 'INCIDENT_BOUND'")
    sql(world, "UPDATE audit_logs SET hash = 'tampered' WHERE event_type = 'ALERT_ACCEPTED'")
    refused(world, binding, "AUDIT_CHAIN_BROKEN")


def test_a_wrong_summary_fails(world):
    binding = committed(world)
    sql(world, "UPDATE incidents SET summary='RECOVERY CLOSURE' WHERE id=1")
    refused(world, binding, "HISTORICAL_SUMMARY_NOT_THE_DISPOSITION_SUMMARY")


def test_a_binding_that_is_not_the_original_r1d_binding_fails(world):
    committed(world)
    refused(world, "e" * 64, "DISPOSITION_BINDING_NOT_THE_ORIGINAL_R1D_BINDING")
    refused(world, "zz", "ORIGINAL_BINDING_PIN_INVALID")


def test_contradictory_provenance_fails(world):
    binding = committed(world)
    db.log_event_strict("ALERT_ACCEPTED", f"uid={UID} pid=1 attacker_ip={IP} action=CREATED", db.INFO, 1)  # a second ALERT_ACCEPTED for the incident
    refused(world, binding, "PROVENANCE_ROWS_NOT_EXACTLY_ONE_EACH")


def test_an_attempt_by_a_non_root_peer_or_a_different_peer_fails(world):
    binding = committed(world)
    sql(world, "UPDATE audit_logs SET details = replace(details, 'peer_uid=0', 'peer_uid=1000') WHERE event_type = 'R1D_DISPOSITION_ATTEMPT_RECORDED'")
    refused(world, binding, "ATTEMPT_AND_DISPOSITION_NOT_BY_THE_SAME_ROOT_PEER")


# ---------------------------------------------------------------- PRE -> POST
def pair(world):
    binding = committed(world)
    return binding, run(world, binding)["state"]


def test_an_unchanged_state_compares_equal_even_if_unrelated_audit_rows_are_appended(world):
    binding, before = pair(world)
    db.log_event_strict("SOME_UNRELATED_EVENT", "x", db.INFO, None)
    hv.compare_states(before, run(world, binding)["state"], world["db"])


@pytest.mark.parametrize("mutate,code", [
    (lambda w: sql(w, "INSERT INTO incidents (opened_at, state, attacker_ip) VALUES ('2026-02-02 00:00:00','CLOSED','198.51.100.3')"), "INCIDENT_SET_CHANGED_BETWEEN_PRE_AND_POST"),
    (lambda w: sql(w, "UPDATE incidents SET closed_at='2030-01-01 00:00:00' WHERE id=1"), "HISTORICAL_STATE_CHANGED_BETWEEN_PRE_AND_POST"),
    (lambda w: db.log_event_strict("RESTORE_REQUESTED", "x", db.INFO, None), "FORBIDDEN_AUDIT_EVENT_APPENDED_BETWEEN_PRE_AND_POST"),
    (lambda w: db.log_event_strict("RECOVERY_R8_CLOSE", "x", db.INFO, 99), "FORBIDDEN_AUDIT_EVENT_APPENDED_BETWEEN_PRE_AND_POST"),
])
def test_an_unauthorized_mutation_between_pre_and_post_fails(world, mutate, code):
    binding, before = pair(world)
    mutate(world)
    try:
        after = run(world, binding)["state"]
    except hv.ValidationError as error:
        # a mutation that also breaks the committed-state validation is refused earlier: still a fail-closed outcome
        assert error.code in {"OPEN_INCIDENTS_PRESENT", "RECOVERY_R8_OR_INCIDENT_CLOSED_ROW_PRESENT", "HISTORICAL_INCIDENT_NOT_CLOSED"} or error.code == code
        return
    with pytest.raises(hv.ValidationError) as error:
        hv.compare_states(before, after, world["db"])
    assert error.value.code == code


# ---------------------------------------------------------------- safety by construction
def test_the_observer_module_is_read_only_and_has_no_socket_or_caller_path():
    import ast

    tree = ast.parse((ROOT / "aegis_soc/historical_validation.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef)) and ast.get_docstring(node, clean=False):
            node.body = node.body[1:] or [ast.Pass()]
    code = ast.unparse(tree)
    for forbidden in ("import socket", "AF_UNIX", ".connect(", "r1d_dispose_call", "DISPOSE_HISTORICAL", "historical-disposition.sock", "sqlite3.connect(", "INSERT", "UPDATE ", "DELETE ", "DROP ", "CREATE ", "dispose_historical_incident_atomic", "record_attempt", "log_event"):
        assert forbidden not in code, forbidden
    assert "mode=ro" in (ROOT / "aegis_soc/historical_disposition.py").read_text()  # the only database opener it uses (hd._open_ro)
