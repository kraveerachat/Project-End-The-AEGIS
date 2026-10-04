"""R1 Real Detector Acceptance: hermetic tests for the read-only observer/verifier (nothing live, nothing authorised).

Stores are hand-built SQLite files in tmp_path; services and journal are plain dicts. No socket, unit, device or Production path is
touched. A ``live`` baseline built here is a TEST CONSTRUCT: it proves the verifier's logic, never a Production claim.
"""

from __future__ import annotations

import copy
import json
import os
import sqlite3
import subprocess
import time
from pathlib import Path

import pytest

from aegis_soc import r1_acceptance as r1
from aegis_soc.alert_sink import AlertResult
from aegis_soc.production_detector import ProductionDetector

IP = "203.0.113.50"
UID = 987
PID = "4321"
T0 = 1_800_000_000.0


def stamp(epoch: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(epoch))


def unit(pid: str, restarts: str = "0") -> dict[str, str]:
    return {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "MainPID": pid, "NRestarts": restarts,
            "Result": "success", "UnitFileState": "enabled", "Restart": "no"}


def make_db(path, *, old=True):
    conn = sqlite3.connect(path)
    conn.executescript(
        """CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT, event_type TEXT,
           details TEXT, incident_id INTEGER, hash TEXT);
           CREATE TABLE incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, opened_at TEXT, closed_at TEXT, state TEXT,
           attacker_ip TEXT, summary TEXT);"""
    )
    if old:
        conn.execute("INSERT INTO incidents (opened_at, closed_at, state, attacker_ip) VALUES (?, ?, 'CLOSED', '198.51.100.9')",
                     (stamp(T0 - 9000), stamp(T0 - 8000)))
        conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) VALUES (?, 'WARN', 'INCIDENT_BOUND', "
                     "'attacker_ip=198.51.100.9 source=detector_alert action=CREATED', 1)", (stamp(T0 - 9000),))
    conn.commit()
    conn.close()


def add_incident(path, *, ip=IP, state="OPEN", at=T0 + 10, bound=True, accepted=True, a_pid=PID, a_uid=UID, a_ip=None, action="CREATED"):
    conn = sqlite3.connect(path)
    cur = conn.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES (?, ?, ?)", (stamp(at), state, ip))
    iid = cur.lastrowid
    if accepted:
        conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) VALUES (?, 'INFO', 'ALERT_ACCEPTED', ?, ?)",
                     (stamp(at), f"uid={a_uid} pid={a_pid} attacker_ip={a_ip or ip} action={action}", iid))
    if bound:
        conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) VALUES (?, 'WARN', 'INCIDENT_BOUND', ?, ?)",
                     (stamp(at), f"attacker_ip={ip} source=detector_alert action=CREATED", iid))
    conn.commit()
    conn.close()
    return iid


def journal_line(ip=IP, *, pid=PID, at=T0 + 9, result="SENT_BOUND", unit_name=r1.DETECTOR_UNIT, message=None):
    return {"message": message or f"[F1-DETECTOR] alert result={result} detail=- ip={ip}", "pid": pid, "unit": unit_name, "at": at}


@pytest.fixture
def world(tmp_path):
    db_path = str(tmp_path / "audit.db")
    make_db(db_path)
    services = {"core": unit("1111"), "detector": unit(PID)}
    baseline = r1.capture_baseline(audit_snapshot=db_path, release_id="rel-1", detector_sha256="a" * 64, detector_uid=UID, mode="live",
                                   now=T0, services=services)
    return type("World", (), {"db": db_path, "baseline": baseline, "services": services})


def final(world, *, journal=None, services=None, ended=T0 + 60):
    return r1.capture_final(now=ended, services=services or copy.deepcopy(world.services), journal=[journal_line()] if journal is None else journal)


def run(world, **kwargs):
    return r1.verify(world.baseline, final(world, **kwargs), world.db)


def ok_world(world):
    add_incident(world.db)
    return world


# --------------------------------------------------------------------------- PASS


def test_one_real_event_passes_and_claims_exactly_r1(world):
    result = run(ok_world(world))
    assert result["result"] == "PASS" and result["incident_id"] == 2 and result["attacker_ip"] == IP
    assert set(result["checks"].values()) == {"YES"} and len(result["checks"]) == 7
    claims = result["claims"]
    assert claims["F1_REAL_DETECTOR_ACCEPTANCE"] == "PROVEN" and claims["R1_VERIFIED"] == "VERIFIED"
    for name in ("RECOVERY_R1_R8_PROVEN", "RECOVERY_R2_R8_EXECUTED", "LVR_PROVEN", "L8_ACCEPTANCE", "L9_PROVEN"):
        assert claims[name] == "NO"
    assert "RECOVERY_R1_R8_PROVEN=NO" in r1.claim_lines(result)


def test_simulate_mode_never_claims(world):
    world.baseline["mode"] = "simulate"
    result = run(ok_world(world))
    assert result["result"] == "SIMULATED_PASS" and result["claims"]["F1_REAL_DETECTOR_ACCEPTANCE"] == "NOT_PROVEN"
    assert result["claims"]["R1_VERIFIED"] == "NOT_CLAIMED"


# --------------------------------------------------------------------------- FAIL CLOSED: incident evidence


def reason(result):
    assert result["result"] == "FAIL" and result["claims"]["F1_REAL_DETECTOR_ACCEPTANCE"] == "NOT_PROVEN"
    assert result["claims"]["R1_VERIFIED"] == "NOT_CLAIMED"
    return result["reason"]


def test_no_incident(world):
    assert reason(run(world)) == "NO_NEW_INCIDENT"


def test_multiple_candidate_incidents(world):
    add_incident(world.db)
    add_incident(world.db, ip="203.0.113.51")
    assert reason(run(world)) == "AMBIGUOUS_INCIDENTS"


def test_preexisting_open_incident_is_refused_at_baseline(tmp_path):
    path = str(tmp_path / "a.db")
    make_db(path)
    conn = sqlite3.connect(path)
    conn.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES (?, 'OPEN', ?)", (stamp(T0 - 5), IP))
    conn.commit()
    conn.close()
    with pytest.raises(r1.AcceptanceError) as error:
        r1.capture_baseline(audit_snapshot=path, release_id="r", detector_sha256="b" * 64, detector_uid=UID, mode="live", now=T0,
                            services={"core": unit("1"), "detector": unit(PID)})
    assert error.value.code == "PREEXISTING_OPEN_INCIDENT"


def test_preexisting_incident_reused_is_not_new(world):
    conn = sqlite3.connect(world.db)
    conn.execute("UPDATE incidents SET state='OPEN', attacker_ip=? WHERE id=1", (IP,))
    conn.commit()
    conn.close()
    assert reason(run(world)) == "PREEXISTING_INCIDENT_OPEN"


def test_incident_outside_window(world):
    add_incident(world.db, at=T0 + 600)
    assert reason(run(world)) == "INCIDENT_OUTSIDE_WINDOW"


def test_stale_incident_before_window(world):
    add_incident(world.db, at=T0 - 100)
    assert reason(run(world)) == "INCIDENT_OUTSIDE_WINDOW"


@pytest.mark.parametrize("ip", ["127.0.0.1", "0.0.0.0", "999.1.1.1", "not-an-ip", "203.0.113.050", ""])
def test_invalid_attacker_ip(world, ip):
    add_incident(world.db, ip=ip)
    assert reason(run(world)) == "ATTACKER_IP_INVALID"


def test_missing_incident_bound(world):
    add_incident(world.db, bound=False)
    assert reason(run(world)) == "INCIDENT_BOUND_MISSING_OR_AMBIGUOUS"


def test_incident_bound_for_other_ip_or_action(world):
    iid = add_incident(world.db)
    conn = sqlite3.connect(world.db)
    conn.execute("UPDATE audit_logs SET details='attacker_ip=203.0.113.99 source=detector_alert action=CREATED' WHERE event_type='INCIDENT_BOUND' AND incident_id=?", (iid,))
    conn.commit()
    conn.close()
    assert reason(run(world)) == "INCIDENT_BOUND_MISMATCH"


def test_incident_not_open(world):
    add_incident(world.db, state="CLOSED")
    assert reason(run(world)) == "INCIDENT_NOT_OPEN"


# --------------------------------------------------------------------------- FAIL CLOSED: provenance / injection


def test_missing_core_alert_acceptance_proof(world):
    add_incident(world.db, accepted=False)
    assert reason(run(world)) == "ALERT_ACCEPTED_MISSING_OR_AMBIGUOUS"


def test_malformed_provenance_row(world):
    iid = add_incident(world.db)
    conn = sqlite3.connect(world.db)
    conn.execute("UPDATE audit_logs SET details='uid=x pid=1' WHERE event_type='ALERT_ACCEPTED' AND incident_id=?", (iid,))
    conn.commit()
    conn.close()
    assert reason(run(world)) == "ALERT_ACCEPTED_MISSING_OR_AMBIGUOUS"


def test_direct_socket_injection_other_pid_is_rejected(world):
    add_incident(world.db, a_pid="9999")  # kernel-attested peer pid is not the detector
    assert reason(run(world)) == "ALERT_SOURCE_PID_NOT_DETECTOR"


def test_wrong_source_uid(world):
    add_incident(world.db, a_uid=0)
    assert reason(run(world)) == "ALERT_SOURCE_UID_MISMATCH"


def test_accepted_ip_differs_from_incident(world):
    add_incident(world.db, a_ip="203.0.113.77")
    assert reason(run(world)) == "ALERT_ACCEPTED_MISMATCH"


def test_existing_action_is_not_a_created_incident(world):
    add_incident(world.db, action="EXISTING")
    assert reason(run(world)) == "ALERT_ACCEPTED_MISMATCH"


def test_no_detector_journal_line(world):
    assert reason(run(ok_world(world), journal=[])) == "DETECTOR_ALERT_LINE_MISSING_OR_AMBIGUOUS"


def test_journal_line_from_other_pid(world):
    assert reason(run(ok_world(world), journal=[journal_line(pid="777")])) == "JOURNAL_PID_NOT_DETECTOR"


def test_journal_line_from_other_unit_is_ignored(world):
    assert reason(run(ok_world(world), journal=[journal_line(unit_name="other.service")])) == "DETECTOR_ALERT_LINE_MISSING_OR_AMBIGUOUS"


def test_stale_detector_event(world):
    assert reason(run(ok_world(world), journal=[journal_line(at=T0 - 500)])) == "DETECTOR_ALERT_LINE_MISSING_OR_AMBIGUOUS"


def test_detector_event_after_core_acceptance_is_not_causal(world):
    assert reason(run(ok_world(world), journal=[journal_line(at=T0 + 40)])) == "DETECTOR_EVENT_STALE"


def test_detector_ip_mismatch(world):
    assert reason(run(ok_world(world), journal=[journal_line(ip="203.0.113.99")])) == "DETECTOR_IP_MISMATCH"


def test_duplicate_detector_lines_are_ambiguous(world):
    assert reason(run(ok_world(world), journal=[journal_line(), journal_line(at=T0 + 9.5)])) == "DETECTOR_ALERT_LINE_MISSING_OR_AMBIGUOUS"


def test_non_bound_detector_result(world):
    assert reason(run(ok_world(world), journal=[journal_line(result="SENT_EXISTING")])) == "DETECTOR_RESULT_NOT_BOUND"


@pytest.mark.parametrize("marker", ["synthetic", "FIXTURE", "simulated", "replayed", "injected", "test"])
def test_synthetic_marker_in_detector_journal(world, marker):
    extra = journal_line(message=f"[F1-DETECTOR] note {marker}", at=T0 + 8)
    assert reason(run(ok_world(world), journal=[extra, journal_line()])) == "SYNTHETIC_MARKER"


# --------------------------------------------------------------------------- FAIL CLOSED: service continuity


@pytest.mark.parametrize("key,field,value,code", [
    ("detector", "MainPID", "5555", "DETECTOR_PID_CHANGED"),
    ("detector", "NRestarts", "1", "DETECTOR_NRESTARTS_CHANGED"),
    ("core", "MainPID", "2222", "CORE_PID_CHANGED"),
    ("core", "NRestarts", "1", "CORE_NRESTARTS_CHANGED"),
    ("core", "UnitFileState", "disabled", "CORE_STATE_CHANGED"),
    ("detector", "Restart", "always", "DETECTOR_STATE_CHANGED"),
])
def test_service_continuity(world, key, field, value, code):
    services = copy.deepcopy(world.services)
    services[key][field] = value
    assert reason(run(ok_world(world), services=services)) == code


def test_service_not_running_at_end(world):
    services = copy.deepcopy(world.services)
    services["detector"]["ActiveState"] = "failed"
    assert reason(run(ok_world(world), services=services)).startswith("FINAL_DETECTOR")


# --------------------------------------------------------------------------- FAIL CLOSED: store / malformed inputs


def test_inconsistent_wal_state_is_refused(world):
    add_incident(world.db)
    with open(world.db + "-wal", "wb") as handle:
        handle.write(b"x" * 64)
    assert reason(run(world)) == "STORE_WAL_PENDING"


def test_missing_store(world, tmp_path):
    assert r1.verify(world.baseline, final(world), str(tmp_path / "nope.db"))["reason"] == "STORE_MISSING"


def test_malformed_baseline_and_final(world):
    assert r1.verify({}, final(world), world.db)["reason"] == "BASELINE_MALFORMED"
    assert r1.verify(world.baseline, {"schema": r1.SCHEMA_FINAL}, world.db)["reason"] == "FINAL_MALFORMED"
    bad = copy.deepcopy(world.baseline)
    del bad["detector"]["NRestarts"]
    assert r1.verify(bad, final(world), world.db)["result"] == "FAIL"


def test_window_reversed(world):
    assert reason(run(ok_world(world), ended=T0 - 5)) == "WINDOW_INVALID"


def test_secret_shaped_output_refused():
    with pytest.raises(r1.AcceptanceError):
        r1.render({"x": "password=hunter2"})
    with pytest.raises(r1.AcceptanceError):
        r1.render({"x": "read core.env"})


def test_snapshot_never_overwrites_and_refuses_bad_input(tmp_path):
    src, dst = str(tmp_path / "s.db"), str(tmp_path / "d.db")
    make_db(src)
    r1.consistent_snapshot(src, dst)
    assert r1._audit_marks(dst)["incident_max_id"] == 1
    with pytest.raises(r1.AcceptanceError):
        r1.consistent_snapshot(src, dst)
    with pytest.raises(r1.AcceptanceError):
        r1.consistent_snapshot(str(tmp_path / "missing.db"), str(tmp_path / "x.db"))


def test_snapshot_of_wal_store_is_consistent_and_source_unchanged(tmp_path):
    src = str(tmp_path / "w.db")
    make_db(src)
    live = sqlite3.connect(src)
    live.execute("PRAGMA journal_mode=WAL")
    live.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES (?, 'OPEN', ?)", (stamp(T0), IP))
    live.commit()
    dst = str(tmp_path / "copy.db")
    r1.consistent_snapshot(src, dst)
    live.close()
    assert r1._audit_marks(dst)["incident_max_id"] == 2 and not os.path.exists(dst + "-wal")


# --------------------------------------------------------------------------- journal / systemctl parsing, governance


def test_journal_parse_and_malformed():
    line = json.dumps({"MESSAGE": "m", "_PID": "5", "_SYSTEMD_UNIT": r1.DETECTOR_UNIT, "__REALTIME_TIMESTAMP": "1800000000000000"})
    assert r1.parse_journal([line, ""])[0]["at"] == 1_800_000_000.0
    with pytest.raises(r1.AcceptanceError):
        r1.parse_journal(["{not json"])
    with pytest.raises(r1.AcceptanceError):
        r1.parse_journal([json.dumps({"MESSAGE": "m"})])


def test_systemctl_snapshot_is_read_only_fixed_argv_and_allow_listed():
    seen = []

    def fake(argv, **kwargs):
        seen.append(argv)
        body = "".join(f"{k}={v}\n" for k, v in unit("42").items())
        return subprocess.CompletedProcess(argv, 0, stdout=body, stderr="")

    assert r1.service_snapshot(r1.CORE_UNIT, run=fake)["MainPID"] == "42"
    assert seen[0][:3] == ["systemctl", "show", "--no-pager"] and not {"start", "stop", "restart", "kill"} & set(seen[0])
    with pytest.raises(r1.AcceptanceError):
        r1.service_snapshot("ssh.service", run=fake)
    with pytest.raises(r1.AcceptanceError):
        r1.service_snapshot(r1.CORE_UNIT, run=lambda a, **k: subprocess.CompletedProcess(a, 0, stdout="MainPID=1\n", stderr=""))


def test_module_cannot_mutate_production():
    source = Path(r1.__file__).read_text(encoding="utf-8")
    for forbidden in ("AF_UNIX", "import socket", "sendall", "systemctl restart", "systemctl start", "systemctl stop", "nft ", "paho", "serial", "sudo", "INSERT INTO", "UPDATE "):
        assert forbidden not in source, forbidden
    assert "RECOVERY_R1_R8_PROVEN=NO" in source and "R2_R8_EXECUTED=NO" in source
    for claim in ("RECOVERY_R1_R8_PROVEN", "RECOVERY_R2_R8_EXECUTED", "LVR_PROVEN", "L8_ACCEPTANCE", "L9_PROVEN"):
        assert r1._claims(True)[claim] == "NO"


def test_baseline_requires_running_services_and_valid_identity(tmp_path):
    path = str(tmp_path / "a.db")
    make_db(path)
    stopped = {"core": unit("1"), "detector": {**unit(PID), "ActiveState": "inactive"}}
    with pytest.raises(r1.AcceptanceError) as error:
        r1.capture_baseline(audit_snapshot=path, release_id="r", detector_sha256="c" * 64, detector_uid=UID, mode="live", now=T0, services=stopped)
    assert error.value.code == "BASELINE_DETECTOR_NOT_RUNNING"
    good = {"core": unit("1"), "detector": unit(PID)}
    for kwargs in ({"detector_sha256": "zz"}, {"detector_uid": 0}, {"mode": "prod"}, {"release_id": "bad id!"}):
        args = {"audit_snapshot": path, "release_id": "r", "detector_sha256": "c" * 64, "detector_uid": UID, "mode": "live", "now": T0, "services": good, **kwargs}
        with pytest.raises(r1.AcceptanceError):
            r1.capture_baseline(**args)


def test_baseline_document_holds_no_secret_material(world):
    text = r1.render(world.baseline)
    assert "core.env" not in text and "password" not in text.lower()


def test_committed_package_has_no_live_owner_runner():
    """No new stage is registered and no runner can authorise a live attempt until the owner decides the stage (see receipt)."""
    root = os.path.join(os.path.dirname(__file__), "..", "deploy", "pr11-phase4")
    lib = Path(root, "p4-lib.sh").read_text(encoding="utf-8")
    assert 'readonly P4_STAGES="L0 L1 L2 L3 L4 L5 L6a L6b L6c L7 L7u L8p F1i F1r F1 L8 L9"' in lib
    assert not [n for n in os.listdir(os.path.join(root, "owner-run")) if "r1" in n.lower()]


# --------------------------------------------------------------------------- producer-side provenance (detector log)


def test_real_detector_alert_line_matches_the_verifier_grammar(capsys):
    detector = ProductionDetector(lambda ip: AlertResult(True, "SENT_BOUND"), clock=lambda: 0.0)
    for _ in range(5):
        detector.process(f"Failed password for root from {IP} port 22 ssh2")
    out = capsys.readouterr().out
    assert f"[F1-DETECTOR] alert result=SENT_BOUND detail=- ip={IP}" in out
    assert r1._ALERT_LINE.match(out.strip().splitlines()[-1])
