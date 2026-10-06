"""R1 Real Detector Acceptance: hermetic tests for the read-only observer/verifier (nothing live, nothing authorised).

Stores are hand-built SQLite files in tmp_path; services and journal are plain dicts. No socket, unit, device or Production path is
touched. A ``live`` baseline built here is a TEST CONSTRUCT: it proves the verifier's logic, never a Production claim.
"""

from __future__ import annotations

import copy
import json
import os
import re
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


def add_incident(path, *, ip=IP, state="OPEN", at=T0 + 8, bound=True, accepted=True, a_pid=PID, a_uid=UID, a_ip=None, action="CREATED", accepted_at=None, bound_at=None):
    conn = sqlite3.connect(path)
    cur = conn.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES (?, ?, ?)", (stamp(at), state, ip))
    iid = cur.lastrowid
    if accepted:
        conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) VALUES (?, 'INFO', 'ALERT_ACCEPTED', ?, ?)",
                     (stamp(at if accepted_at is None else accepted_at), f"uid={a_uid} pid={a_pid} attacker_ip={a_ip or ip} action={action}", iid))
    if bound:
        conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) VALUES (?, 'WARN', 'INCIDENT_BOUND', ?, ?)",
                     (stamp(at if bound_at is None else bound_at), f"attacker_ip={ip} source=detector_alert action=CREATED", iid))
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
    baseline = r1.capture_baseline(audit_db=db_path, release_id="rel-1", detector_sha256="a" * 64, detector_uid=UID,
                                   now=T0, services=services)
    return type("World", (), {"db": db_path, "baseline": baseline, "services": services})


def ssh_event(at, *, ip=IP, unit_name="sshd.service", exe="/usr/bin/sshd", transport="syslog"):
    return {"kind": "ssh", "ip": ip, "dpt": "", "pid": "700", "unit": unit_name, "transport": transport, "exe": exe, "at": at}


def net_event(at, port="22", *, ip=IP, transport="kernel", unit_name=""):
    return {"kind": "net", "ip": ip, "dpt": port, "pid": "", "unit": unit_name, "transport": transport, "exe": "", "at": at}


def ssh_burst(**kwargs):
    return [ssh_event(T0 + 4 + i, **kwargs) for i in range(5)]


def final(world, *, journal=None, services=None, ended=T0 + 60, source=None):
    return r1.capture_final(
        now=ended, services=services or copy.deepcopy(world.services),
        journal={"detector": [journal_line()] if journal is None else journal, "source": ssh_burst() if source is None else source},
    )


def run(world, **kwargs):
    return r1.verify(world.baseline, final(world, **kwargs), world.db)


def ok_world(world):
    add_incident(world.db)
    return world


# --------------------------------------------------------------------------- PASS


def test_one_real_event_passes_with_a_narrow_result_and_never_promotes(world):
    result = run(ok_world(world))
    assert result["result"] == "PASS" and result["incident_id"] == 2 and result["attacker_ip"] == IP
    assert result["reconstructed_rules"] == ["ssh_bruteforce"]
    assert result["checks"]["R1_EVIDENCE_VERIFIED"] == "YES" and result["checks"]["REAL_DETECTOR_CHAIN_VERIFIED"] == "YES"
    assert set(result["checks"].values()) == {"YES"}
    assert result["claims"] == r1.CLAIMS
    lines = r1.claim_lines(result)
    for line in ("F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN", "R1_VERIFIED=NOT_CLAIMED", "RECOVERY_R1_R8_PROVEN=NO",
                 "RECOVERY_R2_R8_EXECUTED=NO", "LVR_PROVEN=NO", "L8_ACCEPTANCE=NO", "L9_PROVEN=NO"):
        assert line in lines
    assert "=PROVEN" not in lines and "=VERIFIED" not in lines.replace("R1_EVIDENCE_VERIFIED=YES", "")


@pytest.mark.parametrize("events", [
    [net_event(T0 + 8 + i * 0.01, str(1000 + i)) for i in range(20)],  # SYN-flood shape
    [net_event(T0 + 4 + i * 0.5, str(1000 + i)) for i in range(10)],  # port-scan shape
])
def test_kernel_source_rules_are_reconstructed(world, events):
    result = run(ok_world(world), source=events)
    assert result["result"] == "PASS" and result["reconstructed_rules"]


# --------------------------------------------------------------------------- FAIL CLOSED: source events (real vs fabricated journal text)


def test_no_source_events_means_a_fabricated_or_missing_trigger(world):
    assert reason(run(ok_world(world), source=[])) == "NO_TRUSTED_SOURCE_EVENT"


def test_below_threshold_is_not_a_rule_match(world):
    assert reason(run(ok_world(world), source=ssh_burst()[:4])) == "NO_TRUSTED_SOURCE_EVENT"


@pytest.mark.parametrize("bad", [
    {"unit_name": "user@1000.service"}, {"unit_name": ""}, {"exe": "/home/attacker/sshd"}, {"exe": "/usr/bin/logger"},
    {"transport": "stdout"}, {"transport": "kernel"},
])
def test_forged_ssh_text_from_another_source_is_refused(world, bad):
    forged = ssh_burst(**bad)
    assert reason(run(ok_world(world), source=forged)) == "UNTRUSTED_SOURCE_LINES_PRESENT"


@pytest.mark.parametrize("bad", [{"transport": "syslog"}, {"transport": "journal"}, {"unit_name": "evil.service"}])
def test_forged_kernel_text_from_a_unit_or_syslog_is_refused(world, bad):
    forged = [net_event(T0 + 8 + i * 0.01, str(i), **bad) for i in range(20)]
    assert reason(run(ok_world(world), source=forged)) == "UNTRUSTED_SOURCE_LINES_PRESENT"


def test_a_forged_line_mixed_into_a_real_burst_is_refused(world):
    mixed = [*ssh_burst(), ssh_event(T0 + 6, unit_name="user@1000.service", exe="/usr/bin/bash")]
    assert reason(run(ok_world(world), source=mixed)) == "UNTRUSTED_SOURCE_LINES_PRESENT"


def test_trusted_events_for_a_different_address_do_not_qualify(world):
    assert reason(run(ok_world(world), source=ssh_burst(ip="203.0.113.99"))) == "NO_TRUSTED_SOURCE_EVENT"


@pytest.mark.parametrize("delay", [0.1, 1.5, 30.0])
def test_final_trusted_threshold_event_after_the_alert_is_refused(world, delay):
    """Causality: the detector alert is at T0+9; a rule completed AFTER it can never explain it (no skew admits it)."""
    events = [*[ssh_event(T0 + 4 + i) for i in range(4)], ssh_event(T0 + 9 + delay)]
    assert reason(run(ok_world(world), source=events)) == "NO_TRUSTED_SOURCE_EVENT"


def test_trusted_events_long_before_the_alert_do_not_qualify(world):
    early = [ssh_event(T0 + 1 + i * 0.1) for i in range(5)]
    assert reason(run(ok_world(world), journal=[journal_line(at=T0 + 40)], source=early)) in (
        "SOURCE_EVENT_NOT_BEFORE_ALERT", "DETECTOR_EVENT_STALE")


def test_ssh_events_wider_than_the_exact_window_are_refused(world):
    # 5 trusted events spanning 30.5 s > TIME_WINDOW (30 s) but inside the old TIME_WINDOW + SKEW_SEC.
    span = r1.TIME_WINDOW + 0.5
    events = [ssh_event(T0 + 8.5 - span + i * span / 4) for i in range(5)]
    assert reason(run(ok_world(world), source=events)) == "NO_TRUSTED_SOURCE_EVENT"


def test_port_scan_wider_than_the_exact_window_is_refused(world):
    span = r1.SCAN_TIME_WINDOW + 0.5
    events = [net_event(T0 + 8.5 - span + i * span / 9, str(1000 + i)) for i in range(10)]
    assert reason(run(ok_world(world), source=events)) == "NO_TRUSTED_SOURCE_EVENT"


def test_syn_flood_wider_than_the_exact_window_is_refused(world):
    span = r1.SYN_FLOOD_WINDOW + 0.5
    events = [net_event(T0 + 8.5 - span + i * span / 19, "22") for i in range(20)]
    assert reason(run(ok_world(world), source=events)) == "NO_TRUSTED_SOURCE_EVENT"


def test_exact_window_boundaries_still_pass(world):
    span = r1.TIME_WINDOW
    events = [ssh_event(T0 + 8.5 - span + i * span / 4) for i in range(5)]
    assert run(ok_world(world), source=events)["result"] == "PASS"


def test_malformed_source_events(world):
    assert reason(run(ok_world(world), source=[{"kind": "ssh"}])) == "SOURCE_EVENTS_MALFORMED"
    final_doc = final(world)
    final_doc["source_events"] = "x"
    assert r1.verify(world.baseline, final_doc, world.db)["reason"] == "SOURCE_EVENTS_MALFORMED"


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
        r1.capture_baseline(audit_db=path, release_id="r", detector_sha256="b" * 64, detector_uid=UID, now=T0,
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


# --- causal order: the Core writes its rows BEFORE it replies; the detector logs SENT_BOUND AFTER the reply ------------------------------------


@pytest.mark.parametrize("kwargs", [
    {"at": T0 + 10},  # incident, INCIDENT_BOUND and ALERT_ACCEPTED all stored AFTER the detector's alert line (T0 + 9)
    {"at": T0 + 8, "accepted_at": T0 + 10},  # only ALERT_ACCEPTED later than the alert line
    {"at": T0 + 8, "bound_at": T0 + 10},  # only INCIDENT_BOUND later than the alert line
    {"at": T0 + 10, "accepted_at": T0 + 8, "bound_at": T0 + 8},  # only the incident's own opened_at later
])
def test_an_audit_row_stored_after_the_detector_alert_line_is_not_this_chain(world, kwargs):
    add_incident(world.db, **kwargs)
    result = run(world)
    assert result["result"] == "FAIL" and result["reason"] == "AUDIT_ROW_AFTER_DETECTOR_ALERT"
    assert result["claims"] == r1.CLAIMS


@pytest.mark.parametrize("alert_at", [T0 + 9.6, T0 + 9.0])
def test_whole_second_audit_rows_at_or_before_the_alert_time_still_pass(world, alert_at):
    # a row whose real time is 1800000009.2 is stored as the whole second 1800000009: stored <= alert (the detector line follows the reply), including the exact-second boundary
    add_incident(world.db, at=T0 + 9)
    assert r1.verify(world.baseline, final(world, journal=[journal_line(at=alert_at)]), world.db)["result"] == "PASS"


def test_no_post_deadline_grace_exists_in_the_causal_predicate():
    text = open(r1.__file__, encoding="utf-8").read()
    start = text.index("AUDIT_ROW_AFTER_DETECTOR_ALERT")
    assert "SKEW_SEC" not in text[start - 160:start + 60]  # the new ordering predicate carries no tolerance


def test_detector_event_after_core_acceptance_is_not_causal(world):
    assert reason(run(ok_world(world), journal=[journal_line(at=T0 + 40)])) == "DETECTOR_EVENT_STALE"


def test_detector_ip_mismatch(world):
    assert reason(run(ok_world(world), journal=[journal_line(ip="203.0.113.99")])) == "DETECTOR_IP_MISMATCH"


def test_duplicate_detector_lines_are_ambiguous(world):
    assert reason(run(ok_world(world), journal=[journal_line(), journal_line(at=T0 + 9.5)])) == "DETECTOR_ALERT_LINE_MISSING_OR_AMBIGUOUS"


def test_non_bound_detector_result(world):
    assert reason(run(ok_world(world), journal=[journal_line(result="SENT_EXISTING")])) == "DETECTOR_RESULT_NOT_BOUND"


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


def test_non_database_source_is_refused(world, tmp_path):
    garbage = tmp_path / "garbage.db"
    garbage.write_bytes(b"not a database" * 100)
    assert r1.verify(world.baseline, final(world), str(garbage))["reason"] == "STORE_UNREADABLE"


def test_store_missing_required_columns_is_refused(world, tmp_path):
    odd = tmp_path / "odd.db"
    conn = sqlite3.connect(odd)
    conn.execute("CREATE TABLE audit_logs (id INTEGER)")
    conn.commit()
    conn.close()
    assert r1.verify(world.baseline, final(world), str(odd))["reason"] in ("STORE_MALFORMED", "STORE_UNREADABLE")


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


SECRET_ROW = "scrypt$16384$deadbeefcafe password=hunter2 RESTORE_REQUESTED credential"


def files_under(root):
    return sorted(str(p.relative_to(root)) for p in Path(root).rglob("*") if p.is_file())


def digest(path):
    import hashlib

    return hashlib.sha256(Path(path).read_bytes()).hexdigest() if Path(path).exists() else None


def test_audit_view_is_in_memory_wal_consistent_and_leaves_no_copy(tmp_path):
    src = tmp_path / "w.db"
    make_db(str(src))
    live = sqlite3.connect(src)
    live.execute("PRAGMA journal_mode=WAL")
    live.execute("PRAGMA wal_autocheckpoint=0")
    live.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES (?, 'OPEN', ?)", (stamp(T0), IP))
    live.commit()  # committed only in the -wal file
    assert os.path.getsize(f"{src}-wal") > 0
    before = (digest(src), digest(f"{src}-wal"), files_under(tmp_path))
    view = r1.open_audit_view(src)
    try:
        assert view.execute("SELECT MAX(id) FROM incidents").fetchone()[0] == 2  # the WAL-only row is visible
        assert view.execute("PRAGMA database_list").fetchone()["file"] == ""  # purely in memory
        with pytest.raises(sqlite3.Error):
            view.execute("INSERT INTO incidents (opened_at, state) VALUES ('x', 'OPEN')")
    finally:
        view.close()
    assert r1._audit_marks(src)["incident_max_id"] == 2
    after = (digest(src), digest(f"{src}-wal"), files_under(tmp_path))
    live.close()
    assert before == after  # source bytes and the directory listing are unchanged: nothing was written, no copy remains


def test_unrelated_secret_shaped_audit_row_never_reaches_output_or_disk(world, tmp_path):
    conn = sqlite3.connect(world.db)
    conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id) VALUES (?, 'INFO', 'RESTORE_REQUESTED', ?, 1)",
                 (stamp(T0 + 1), SECRET_ROW))
    conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details) VALUES (?, 'INFO', 'OTHER', ?)", (stamp(T0 + 2), SECRET_ROW))
    conn.commit()
    conn.close()
    add_incident(world.db)
    first = r1.verify(world.baseline, final(world), world.db)
    second = r1.verify(world.baseline, final(world), world.db)
    assert first["result"] == "PASS" and r1.render(first) == r1.render(second)  # deterministic
    out = r1.render(first) + r1.claim_lines(first)
    assert "hunter2" not in out and "scrypt" not in out and "RESTORE_REQUESTED" not in out
    others = [str(p) for p in Path(tmp_path).rglob("*") if p.is_file() and str(p) != world.db]
    assert not [p for p in others if b"hunter2" in Path(p).read_bytes()]


def test_baseline_derives_only_safe_marks(world):
    assert set(world.baseline) == {"schema", "started_at", "release_id", "detector_sha256", "detector_uid", "audit_max_id",
                                   "incident_max_id", "open_incidents", "core", "detector"}


# --------------------------------------------------------------------------- journal / systemctl parsing, governance


def jrow(message, **fields):
    row = {"MESSAGE": message, "_PID": "5", "__REALTIME_TIMESTAMP": "1800000000000000", **fields}
    return json.dumps(row)


def test_journal_reduction_keeps_only_detector_lines_and_rule_facts():
    secret_line = jrow("db password=hunter2 for admin", _SYSTEMD_UNIT="app.service")
    ssh = jrow(f"Failed password for root from {IP} port 22 ssh2", _SYSTEMD_UNIT="sshd.service", _TRANSPORT="syslog", _EXE="/usr/bin/sshd")
    kern = jrow(f"AEGIS_NEWCONN IN=eth0 SRC={IP} DST=10.0.0.1 PROTO=TCP DPT=443", _TRANSPORT="kernel")
    own = jrow("[F1-DETECTOR] started", _SYSTEMD_UNIT=r1.DETECTOR_UNIT)
    out = r1.reduce_journal([secret_line, ssh, kern, own, ""])
    assert [e["kind"] for e in out["source"]] == ["ssh", "net"] and out["source"][1]["dpt"] == "443"
    assert len(out["detector"]) == 1
    assert "hunter2" not in json.dumps(out) and "password" not in json.dumps(out["source"]).lower()
    assert all(r1.source_is_trusted(e) for e in out["source"])


def test_journal_reduction_malformed_and_limits(monkeypatch):
    with pytest.raises(r1.AcceptanceError):
        r1.reduce_journal(["{not json"])
    with pytest.raises(r1.AcceptanceError):
        r1.reduce_journal([json.dumps({"MESSAGE": "m"})])
    monkeypatch.setattr(r1, "MAX_SOURCE_EVENTS", 2)
    line = jrow(f"AEGIS_NEWCONN SRC={IP} DPT=1", _TRANSPORT="kernel")
    with pytest.raises(r1.AcceptanceError):
        r1.reduce_journal([line] * 3)


def test_journal_read_is_one_fixed_read_only_argv():
    seen = []

    def fake(argv, **kwargs):
        seen.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    r1.read_journal(T0, run=fake)
    assert seen[0][0] == "journalctl" and len(seen) == 1
    assert not {"--rotate", "--vacuum-size", "--flush", "--sync", "--setup-keys"} & set(seen[0])


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
    for forbidden in ("AF_UNIX", "import socket", "sendall", "systemctl restart", "systemctl start", "systemctl stop", "nft ", "paho",
                      "serial", "sudo", "INSERT INTO", "UPDATE "):
        assert forbidden not in source, forbidden


def test_no_input_or_flag_can_promote_a_live_claim(world):
    """Blocker 2: there is no mode/flag/baseline field that turns a PASS into F1_REAL_DETECTOR_ACCEPTANCE=PROVEN."""
    source = Path(r1.__file__).read_text(encoding="utf-8")
    assert '"PROVEN"' not in source and "--mode" not in source and "live" not in re.findall(r"baseline.get\([^)]*\)", source)
    assert r1.CLAIMS["F1_REAL_DETECTOR_ACCEPTANCE"] == "NOT_PROVEN" and r1.CLAIMS["R1_VERIFIED"] == "NOT_CLAIMED"
    for claim in ("RECOVERY_R1_R8_PROVEN", "RECOVERY_R2_R8_EXECUTED", "LVR_PROVEN", "L8_ACCEPTANCE", "L9_PROVEN"):
        assert r1.CLAIMS[claim] == "NO"
    ok_world(world)
    for extra in ({"mode": "live"}, {"live": True}, {"claim": "PROVEN"}, {"authorized": True}):
        baseline = {**copy.deepcopy(world.baseline), **extra}
        result = r1.verify(baseline, final(world), world.db)
        assert result["claims"]["F1_REAL_DETECTOR_ACCEPTANCE"] == "NOT_PROVEN" and result["claims"]["R1_VERIFIED"] == "NOT_CLAIMED"
        assert "PROVEN" not in r1.claim_lines(result).replace("NOT_PROVEN", "").replace("_PROVEN=NO", "")


def test_cli_exposes_no_mode_or_snapshot_flag_and_cannot_self_promote(capsys):
    for flag in (["--mode", "live"], ["--snapshot", "/tmp/x"]):
        with pytest.raises(SystemExit):
            r1.main(["baseline", *flag, "--audit-db", "x", "--release-id", "r", "--detector-sha256", "a" * 64, "--detector-uid", "1",
                     "--out", "o"])
    capsys.readouterr()
    assert r1.main(["final", "--baseline", "/nonexistent", "--audit-db", "x", "--out", "o"]) == 4
    assert "PROVEN" not in capsys.readouterr().out.replace("NOT_PROVEN", "")


def test_cli_end_to_end_writes_only_sanitized_files(world, tmp_path, monkeypatch, capsys):
    out_dir = tmp_path / "evidence"
    out_dir.mkdir()
    monkeypatch.setattr(r1, "service_snapshot", lambda name, run=None: unit("1111" if name == r1.CORE_UNIT else PID))
    monkeypatch.setattr(r1.time, "time", lambda: T0)
    conn = sqlite3.connect(world.db)
    conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details) VALUES (?, 'INFO', 'OTHER', ?)", (stamp(T0 - 1), SECRET_ROW))
    conn.commit()
    conn.close()
    args = ["baseline", "--audit-db", world.db, "--release-id", "rel-1", "--detector-sha256", "a" * 64, "--detector-uid", str(UID)]
    assert r1.main([*args, "--out", str(out_dir / "baseline.json")]) == 0
    assert r1.main([*args, "--out", str(out_dir / "baseline.json")]) == 4  # never overwrites
    add_incident(world.db)
    monkeypatch.setattr(r1.time, "time", lambda: T0 + 60)
    monkeypatch.setattr(r1, "read_journal", lambda since: {"detector": [journal_line()], "source": ssh_burst()})
    assert r1.main(["final", "--baseline", str(out_dir / "baseline.json"), "--audit-db", world.db, "--out", str(out_dir / "result.json")]) == 0
    printed = capsys.readouterr().out
    assert "R1_EVIDENCE_VERIFIED=YES" in printed and "F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN" in printed
    assert files_under(out_dir) == ["baseline.json", "result.json"]
    assert not [p for p in out_dir.iterdir() if b"hunter2" in p.read_bytes() or b"scrypt" in p.read_bytes()]


def test_baseline_requires_running_services_and_valid_identity(tmp_path):
    path = str(tmp_path / "a.db")
    make_db(path)
    stopped = {"core": unit("1"), "detector": {**unit(PID), "ActiveState": "inactive"}}
    with pytest.raises(r1.AcceptanceError) as error:
        r1.capture_baseline(audit_db=path, release_id="r", detector_sha256="c" * 64, detector_uid=UID, now=T0, services=stopped)
    assert error.value.code == "BASELINE_DETECTOR_NOT_RUNNING"
    good = {"core": unit("1"), "detector": unit(PID)}
    for kwargs in ({"detector_sha256": "zz"}, {"detector_uid": 0}, {"release_id": "bad id!"}):
        args = {"audit_db": path, "release_id": "r", "detector_sha256": "c" * 64, "detector_uid": UID, "now": T0, "services": good, **kwargs}
        with pytest.raises(r1.AcceptanceError):
            r1.capture_baseline(**args)


def test_baseline_document_holds_no_secret_material(world):
    text = r1.render(world.baseline)
    assert "core.env" not in text and "password" not in text.lower()


def test_r1i_and_r1a_are_registered_in_order_and_neither_promotes_the_claim():
    """R1I, historical R1A and successor R1B are first-class stages; registration promotes nothing."""
    root = os.path.join(os.path.dirname(__file__), "..", "deploy", "pr11-phase4")
    lib = Path(root, "p4-lib.sh").read_text(encoding="utf-8")
    assert 'readonly P4_STAGES="L0 L1 L2 L3 L4 L5 L6a L6b L6c L7 L7u L8p F1i F1r F1 F1u R1I R1A R1Du R1D R1Dv R1B L8 L9"' in lib
    assert "REGISTERED" == subprocess.run(
        ["bash", "-c", f'. "{Path(root, "p4-lib.sh")}"; p4_stage_handler_status R1A'],
        text=True, capture_output=True, check=False,
    ).stdout.strip()
    assert r1.CLAIMS["F1_REAL_DETECTOR_ACCEPTANCE"] == "NOT_PROVEN" and r1.CLAIMS["R1_VERIFIED"] == "NOT_CLAIMED"  # registration promotes nothing
    assert "REGISTERED" == subprocess.run(
        ["bash", "-c", f'. "{Path(root, "p4-lib.sh")}"; p4_stage_handler_status R1I'],
        text=True, capture_output=True, check=False,
    ).stdout.strip()
    assert "PIN_MAIN_SHA" in Path(root, "owner-run/run-r1i-owner.sh").read_text(encoding="utf-8")


# --------------------------------------------------------------------------- producer-side provenance (detector log)


def test_real_detector_alert_line_matches_the_verifier_grammar(capsys):
    detector = ProductionDetector(lambda ip: AlertResult(True, "SENT_BOUND"), clock=lambda: 0.0)
    for _ in range(5):
        detector.process(f"Failed password for root from {IP} port 22 ssh2")
    out = capsys.readouterr().out
    assert f"[F1-DETECTOR] alert result=SENT_BOUND detail=- ip={IP}" in out
    assert r1._ALERT_LINE.match(out.strip().splitlines()[-1])
