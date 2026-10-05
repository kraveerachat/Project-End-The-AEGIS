"""R1D Core authority: the atomic, evidence-preserving disposition of the preserved historical R1A incident.

Hermetic: a temporary SQLite audit database written through the real `database` module (real hash chain), an
in-process service, and (for the channel tests) a temporary AF_UNIX socket. Nothing touches a real database, device,
broker, Recovery channel or network."""

from __future__ import annotations

import hashlib
import json
import os
import socket
import sqlite3
import threading
from pathlib import Path

import pytest

from aegis_soc import config
from aegis_soc import database as db
from aegis_soc import historical_disposition as hd
from aegis_soc import local_restore as lr

ROOT = Path(__file__).resolve().parent.parent
IP = "203.0.113.9"
UID = 987
PID = 4321
ROOT_PEER = lr.Peer(uid=0, pid=1234)


@pytest.fixture
def world(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "audit.sqlite3"))
    monkeypatch.setattr(config, "ALERT_SOURCE_UID", UID)
    monkeypatch.setattr("aegis_soc.comms.send_ops_alert", lambda *a, **k: None)
    db.init_db()
    return tmp_path


def seed(*, ip=IP, uid=UID, pid=PID, accepted_ip=None, bound=1, accepted=1, action="CREATED", state=None):
    incident_id = db.create_incident(ip)
    for _ in range(bound):
        db.log_event_strict("INCIDENT_BOUND", f"attacker_ip={ip} source=detector_alert action={action}", db.WARN, incident_id)
    for _ in range(accepted):
        db.log_event_strict("ALERT_ACCEPTED", f"uid={uid} pid={pid} attacker_ip={accepted_ip or ip} action={action}", db.INFO, incident_id)
    if state:
        conn = sqlite3.connect(config.DB_PATH)
        conn.execute("UPDATE incidents SET state=? WHERE id=?", (state, incident_id))
        conn.commit()
        conn.close()
    return incident_id


def service(**kw):
    kw.setdefault("profile", "production")
    kw.setdefault("detector_uid", UID)
    return hd.HistoricalDispositionService(**kw)


def binding() -> str:
    return hd.read_binding(config.DB_PATH, UID)["binding_sha256"]


def request(digest, **extra):
    return {"v": 1, "op": hd.OP_DISPOSE, "binding_sha256": digest, **extra}


def open_count() -> int:
    conn = sqlite3.connect(config.DB_PATH)
    try:
        return conn.execute("SELECT COUNT(*) FROM incidents WHERE state != 'CLOSED'").fetchone()[0]
    finally:
        conn.close()


def audit_rows(event_type):
    conn = sqlite3.connect(config.DB_PATH)
    try:
        return conn.execute("SELECT id, details, incident_id FROM audit_logs WHERE event_type=?", (event_type,)).fetchall()
    finally:
        conn.close()


def refused(response, code):
    assert response["ok"] is False and response["code"] == code, response


# ------------------------------------------------------------------------------------------------ binding
def test_the_binding_is_a_versioned_canonical_digest_the_core_reconstructs(world):
    incident_id = seed()
    info = hd.read_binding(config.DB_PATH, UID)
    assert info["incident_id"] == incident_id and len(info["binding_sha256"]) == 64
    again = hd.read_binding(config.DB_PATH, UID)
    assert again["binding_sha256"] == info["binding_sha256"]  # deterministic
    parsed = json.loads(info["canonical_bytes"])
    assert parsed["v"] == "R1D_BINDING_V1" and set(parsed) == {"v", "incident", "incident_bound", "alert_accepted"}
    assert set(parsed["incident"]) == {"id", "opened_at", "closed_at", "state", "attacker_ip", "summary"}
    for row in ("incident_bound", "alert_accepted"):
        assert set(parsed[row]) == {"id", "timestamp", "level", "event_type", "details", "incident_id", "hash"}
    assert hashlib.sha256(info["canonical_bytes"]).hexdigest() == info["binding_sha256"]


def test_the_binding_changes_with_any_bound_field(world):
    seed()
    base = binding()
    conn = sqlite3.connect(config.DB_PATH)
    conn.execute("UPDATE incidents SET opened_at='2000-01-01 00:00:00' WHERE id=1")
    conn.commit()
    conn.close()
    assert binding() != base


# ------------------------------------------------------------------------------------------------ positive
def test_the_exact_historical_incident_is_disposed_atomically_and_semantically_distinct_from_r8(world):
    incident_id = seed()
    chain_before = db.verify_chain()
    response = service().dispose(request(binding()), ROOT_PEER)
    assert response == {"ok": True, "code": "DISPOSED", "incident_id": incident_id, "message": response["message"]}
    assert open_count() == 0 and db.get_open_incident() is None
    rows = audit_rows(hd.EVENT_TYPE)
    assert len(rows) == 1 and rows[0][2] == incident_id
    detail = rows[0][1]
    for part in (f"incident={incident_id}", "class=R1A_HISTORICAL_FAIL", "source=R1A_FAIL_IMMUTABLE", "successor=R1B", "recovery_r8=NO", "claims_promoted=NO", "peer_uid=0", "peer_pid=1234"):
        assert part in detail, part
    assert IP not in detail  # the address is bound through the digest only
    assert chain_before[0] and db.verify_chain()[0]
    assert not audit_rows("RECOVERY_R8_CLOSE") and not audit_rows("INCIDENT_CLOSED")  # neither event is fabricated
    conn = sqlite3.connect(config.DB_PATH)
    state, closed_at, summary = conn.execute("SELECT state, closed_at, summary FROM incidents WHERE id=?", (incident_id,)).fetchone()
    conn.close()
    assert state == "CLOSED" and closed_at and "HISTORICAL_DISPOSITION" in summary


def test_after_the_disposition_the_r1b_baseline_sees_zero_open_incidents_and_a_later_alert_is_created(world):
    from aegis_soc import r1_acceptance as r1

    seed()
    service().dispose(request(binding()), ROOT_PEER)
    assert r1._audit_marks(config.DB_PATH)["open_incidents"] == 0  # PREEXISTING_OPEN_INCIDENT can no longer fire
    later = db.create_incident("198.51.100.77")
    assert later != 1 and db.get_open_incident()["id"] == later  # the next real alert creates a NEW incident (CREATED semantics live in bind_incident; see test_core_recovery)


def test_the_disposed_incident_is_not_recovery_r8_evidence(world):
    from aegis_soc import recovery_evidence as ev
    from aegis_soc import recovery_protocol as rp

    incident_id = seed()
    service().dispose(request(binding()), ROOT_PEER)

    class Audit:
        def events(self, iid, types, limit):
            return []

        def restore_requests(self, iid):
            return []

    gate = ev._r8(Audit(), {"id": incident_id, "state": "CLOSED", "closed_at": "x"})
    assert gate["gate"] == rp.R8 and gate["verdict"] == ev.BLOCKED and gate["reason"] == "NO_CORE_CLOSE_RECORD"


# ------------------------------------------------------------------------------------------------ atomicity
def test_an_audit_insert_failure_rolls_back_the_whole_disposition(world, monkeypatch):
    seed()
    digest = binding()

    def boom(*a, **k):
        raise sqlite3.OperationalError("injected audit failure")

    monkeypatch.setattr(db, "_compute_hash", boom)
    response = service().dispose(request(digest), ROOT_PEER)
    assert response["ok"] is False
    assert open_count() == 1 and not audit_rows(hd.EVENT_TYPE)  # neither half persisted


def test_an_incident_update_failure_rolls_back_the_audit_row(world):
    seed()
    digest = binding()
    conn = sqlite3.connect(config.DB_PATH)
    conn.execute("CREATE TRIGGER block_update BEFORE UPDATE ON incidents BEGIN SELECT RAISE(ABORT, 'injected update failure'); END")
    conn.commit()
    conn.close()
    response = service().dispose(request(digest), ROOT_PEER)
    assert response["ok"] is False
    assert open_count() == 1 and not audit_rows(hd.EVENT_TYPE)  # the audit row did not survive the failed transition


def test_the_disposition_is_one_transaction_not_log_then_close():
    source = (ROOT / "aegis_soc/database.py").read_text()
    body = source[source.index("def dispose_historical_incident_atomic"):]
    body = body[:body.index("\ndef ", 10)]
    assert 'BEGIN IMMEDIATE' in body and "_AUDIT_WRITE_LOCK" in body and "rowcount" in body and "rollback" in body
    assert "log_event_strict" not in body and "close_incident(" not in body and "_append_event(" not in body
    # notification only after the commit
    assert body.index("conn.commit()") < body.index("_emit_event")


def test_the_database_one_shot_unique_index_blocks_a_second_disposition_row(world):
    seed()
    service().dispose(request(binding()), ROOT_PEER)
    conn = sqlite3.connect(config.DB_PATH)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id, hash) VALUES ('t','INFO',?,'x',NULL,'h')", (hd.EVENT_TYPE,))
    conn.close()


# ------------------------------------------------------------------------------------------------ refusals
def test_a_duplicate_disposition_is_refused(world):
    seed()
    digest = binding()
    assert service().dispose(request(digest), ROOT_PEER)["ok"] is True
    seed(ip="198.51.100.50")  # a NEW open incident appears later (e.g. R1B)
    refused(service().dispose(request(digest), ROOT_PEER), "ALREADY_DISPOSED")
    assert open_count() == 1 and len(audit_rows(hd.EVENT_TYPE)) == 1  # the later real incident is NOT hidden


def test_no_open_incident_is_refused(world):
    refused(service().dispose(request("0" * 64), ROOT_PEER), "NO_OPEN_INCIDENT")


def test_more_than_one_open_incident_is_refused(world):
    seed()
    conn = sqlite3.connect(config.DB_PATH)
    conn.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES ('2026-01-01 00:00:00','OPEN','198.51.100.2')")
    conn.commit()
    conn.close()
    refused(service().dispose(request("0" * 64), ROOT_PEER), "AMBIGUOUS_OPEN_INCIDENTS")
    assert open_count() == 2


def test_an_incident_that_is_not_exactly_open_is_refused(world):
    seed(state="CONTAINED")
    refused(service().dispose(request("0" * 64), ROOT_PEER), "INCIDENT_NOT_OPEN_STATE")


@pytest.mark.parametrize("kwargs,code", [
    ({"bound": 0}, "PROVENANCE_MISSING_OR_AMBIGUOUS"),
    ({"accepted": 0}, "PROVENANCE_MISSING_OR_AMBIGUOUS"),
    ({"bound": 2}, "PROVENANCE_MISSING_OR_AMBIGUOUS"),
    ({"accepted": 2}, "PROVENANCE_MISSING_OR_AMBIGUOUS"),
    ({"accepted_ip": "198.51.100.4"}, "ALERT_IP_MISMATCH"),
    ({"uid": 555}, "ALERT_UID_MISMATCH"),
    ({"action": "EXISTING"}, "PROVENANCE_MISSING_OR_AMBIGUOUS"),
])
def test_wrong_provenance_is_refused_and_nothing_changes(world, kwargs, code):
    seed(**kwargs)
    refused(service().dispose(request("0" * 64), ROOT_PEER), code)
    assert open_count() == 1 and not audit_rows(hd.EVENT_TYPE)


@pytest.mark.parametrize("event", ["RECOVERY_R3_REQUESTED", "RECOVERY_R3_RESULT", "RESTORE_REQUESTED", "RESTORE_BREAK_GLASS_CLAIM", "RECOVERY_R8_CLOSE", "INCIDENT_CLOSED", "RECOVERY_STEP"])
def test_durable_recovery_evidence_for_the_incident_blocks_the_disposition(world, event):
    incident_id = seed()
    db.log_event_strict(event, "x", db.INFO, incident_id)
    refused(service().dispose(request("0" * 64), ROOT_PEER), "RECOVERY_EVIDENCE_PRESENT")
    assert open_count() == 1


@pytest.mark.parametrize("event", ["RESTORE_REQUESTED", "RESTORE_BREAK_GLASS_CLAIM"])
def test_a_null_incident_restore_row_after_the_alert_blocks_the_disposition(world, event):
    seed()
    db.log_event_strict(event, "x", db.INFO, None)
    refused(service().dispose(request("0" * 64), ROOT_PEER), "RECOVERY_EVIDENCE_PRESENT")


def test_a_binding_mismatch_is_refused(world):
    seed()
    refused(service().dispose(request("f" * 64), ROOT_PEER), "BINDING_MISMATCH")
    assert open_count() == 1 and not audit_rows(hd.EVENT_TYPE)


def test_the_caller_can_never_supply_an_incident_id_or_an_address(world):
    seed()
    digest = binding()
    for extra in ({"incident_id": 1}, {"attacker_ip": IP}, {"ip": IP}, {"state": "CLOSED"}, {"summary": "x"}):
        refused(service().dispose(request(digest, **extra), ROOT_PEER), "REQUEST_INVALID")
    for bad in (None, [], "x", {"v": 1}, {"v": 2, "op": hd.OP_DISPOSE, "binding_sha256": digest}, {"v": 1, "op": "CLOSE", "binding_sha256": digest},
                {"v": 1, "op": hd.OP_DISPOSE, "binding_sha256": digest.upper()}, {"v": 1, "op": hd.OP_DISPOSE, "binding_sha256": digest + "\n"},
                {"v": 1, "op": hd.OP_DISPOSE, "binding_sha256": 7}):
        refused(service().dispose(bad, ROOT_PEER), "REQUEST_INVALID")
    assert open_count() == 1


def test_only_a_root_peer_is_accepted(world):
    seed()
    for uid in (1000, os.geteuid() if os.geteuid() else 1, 987):
        refused(service().dispose(request(binding()), lr.Peer(uid=uid, pid=1)), "PEER_REFUSED")
    assert open_count() == 1


def test_a_non_production_profile_refuses(world):
    seed()
    refused(service(profile="development").dispose(request(binding()), ROOT_PEER), "NOT_PRODUCTION")


def test_an_unconfigured_detector_authority_refuses(world, monkeypatch):
    seed()
    digest = binding()
    refused(service(detector_uid=None).dispose(request(digest), ROOT_PEER), "DETECTOR_UID_UNCONFIGURED")
    assert open_count() == 1


# ------------------------------------------------------------------------------------------------ normal Recovery unchanged
PINS = {
    "recovery_core.py": "c92d2c3c2d4a5d0c5decb890e7b13e5eac3ff8e6b97c38ef7ac8d541c3657435",
    "recovery_protocol.py": "1854124f815057b5efe9d7bee84ee95163b3d4a207224997bfe7a4596de19d60",
    "recovery_evidence.py": "7426b5ebc9878711059b5a028ca98998f2dedb93234ddedb7c49a9ce45e451ec",
    "r1_acceptance.py": "2ef349d4e7a4594b1b2a02d7222b00393fd4d80b7998b6d3b569e761fa057577",
}


@pytest.mark.parametrize("name", sorted(PINS))
def test_normal_recovery_and_the_r1b_acceptance_semantics_are_byte_unchanged(name):
    assert hashlib.sha256((ROOT / "aegis_soc" / name).read_bytes()).hexdigest() == PINS[name], f"{name} changed: R1D must not touch normal Recovery R8 or the R1B NEW/CREATED acceptance"


def test_the_recovery_protocol_has_no_disposition_operation():
    from aegis_soc import recovery_protocol as rp

    assert hd.OP_DISPOSE not in rp.OPS and "DISPOSE" not in " ".join(rp.OPS)


# ------------------------------------------------------------------------------------------------ channel
def sock_path(tmp_path) -> Path:
    short = Path(os.environ.get("TMPDIR", "/tmp")) / f"r1d-{os.getpid()}-{abs(hash(str(tmp_path))) % 100000}"
    short.mkdir(mode=0o755, exist_ok=True)
    return short / hd.CHANNEL_NAME


def send(path: Path, body: bytes) -> dict:
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5)
        s.connect(str(path))
        s.sendall(body + b"\n")
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(4096)
            if not chunk:
                break
            data += chunk
    return json.loads(data.decode())


def make_server(world, *, allowed_uid):
    seed()
    path = sock_path(world)
    server = hd.HistoricalDispositionServer(path, service(), allowed_uid=allowed_uid)
    return server, path


def test_a_wrong_peer_is_refused_on_the_socket_before_any_byte_is_read(world):
    server, path = make_server(world, allowed_uid=os.geteuid() + 1)
    server.start()
    try:
        response = send(path, json.dumps(request(binding())).encode())
        refused(response, "PEER_REFUSED")
        assert open_count() == 1
    finally:
        server.close()


def test_the_socket_is_core_private_and_closes_itself_after_a_successful_disposition(world):
    digest = None
    server, path = make_server(world, allowed_uid=os.geteuid())
    digest = binding()
    # production requires a root peer (default); the hermetic socket test needs the local euid to be the accepted peer
    server.service = service(required_peer_uid=os.geteuid())
    server.start()
    assert (path.stat().st_mode & 0o777) == 0o600
    response = send(path, json.dumps(request(digest)).encode())
    assert response["ok"] is True and response["code"] == "DISPOSED"
    for _ in range(50):
        if not path.exists():
            break
        threading.Event().wait(0.1)
    assert not path.exists()  # the listener is dead and the socket is unlinked
    assert server.finished() is True
    server.close()


def test_the_server_refuses_to_start_when_a_disposition_already_exists(world):
    seed()
    service().dispose(request(binding()), ROOT_PEER)
    server = hd.HistoricalDispositionServer(sock_path(world), service(), allowed_uid=0)
    with pytest.raises(hd.DispositionChannelError):
        server.start()
    assert not sock_path(world).exists()


def test_oversized_and_malformed_requests_are_refused(world):
    server, path = make_server(world, allowed_uid=os.geteuid())
    server.service = service(required_peer_uid=os.geteuid())
    server.start()
    try:
        refused(send(path, b"not json"), "REQUEST_INVALID")
        refused(send(path, b"x" * 5000), "REQUEST_INVALID")
        assert open_count() == 1
    finally:
        server.close()


# ------------------------------------------------------------------------------------------------ inert by default / supervisor wiring
def test_the_channel_is_disabled_by_default_and_production_only(monkeypatch):
    monkeypatch.delenv("AEGIS_R1D_DISPOSITION_ENABLED", raising=False)
    assert hd.enabled("production", enabled_flag="") is False
    assert hd.enabled("production", enabled_flag="yes") is False
    assert hd.enabled("production", enabled_flag="YES ") is False
    assert hd.enabled("development", enabled_flag="YES") is False
    assert hd.enabled("production", enabled_flag="YES") is True


def test_supervisor_wiring_is_inert_by_default_and_uses_a_root_only_dedicated_channel():
    text = (ROOT / "aegis_soc/supervisor.py").read_text()
    start = text[text.index("def start_historical_disposition"):text.index("def stop_historical_disposition")]
    assert "allowed_uid=0" in start and "hd.enabled(" in start and "config.ALERT_SOURCE_UID" in start and "disposition_exists" in start
    assert "socket_gid" not in start  # never group-reachable
    assert "self.start_historical_disposition()" in text
    assert "recovery_server" not in start  # not the ordinary Recovery channel
    assert "AF_INET" not in (ROOT / "aegis_soc/historical_disposition.py").read_text()  # no network listener


def test_the_normal_core_never_starts_the_channel_without_the_exact_flag(tmp_path, monkeypatch):
    from test_core_recovery import credential, make_env  # noqa: F401  (hermetic Core harness)
    from aegis_soc import config as cfg

    monkeypatch.setattr(cfg, "R1D_DISPOSITION_ENABLED", "")
    monkeypatch.setattr(cfg, "ALERT_SOURCE_UID", UID)
    env = make_env(tmp_path, monkeypatch, lr.RestoreCredential.parse(lr.hash_secret("s" * 24, n=lr.SCRYPT_MIN_N)))
    try:
        env.core.supervisor.start_historical_disposition()
        assert env.core.supervisor.historical_server is None
    finally:
        env.core.close()


def _core(tmp_path, monkeypatch):
    from test_core_recovery import make_env  # noqa: F401

    return make_env(tmp_path, monkeypatch, lr.RestoreCredential.parse(lr.hash_secret("s" * 24, n=lr.SCRYPT_MIN_N)))


def test_the_enabled_core_listens_privately_refuses_a_non_root_peer_and_stays_dead_after_a_disposition(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "R1D_DISPOSITION_ENABLED", "YES")
    monkeypatch.setattr(config, "ALERT_SOURCE_UID", UID)
    env = _core(tmp_path, monkeypatch)
    try:
        supervisor = env.core.supervisor
        supervisor.start_historical_disposition()
        server = supervisor.historical_server
        assert server is not None and server.allowed_uid == 0
        path = server.path
        assert (path.stat().st_mode & 0o777) == 0o600
        if os.geteuid() != 0:
            refused(send(path, json.dumps(request("0" * 64)).encode()), "PEER_REFUSED")
        supervisor.stop_historical_disposition()
        assert supervisor.historical_server is None and not path.exists()
        # a recorded disposition keeps the channel dead across a (simulated) restart
        seed()
        assert service().dispose(request(binding()), ROOT_PEER)["ok"] is True
        supervisor.start_historical_disposition()
        assert supervisor.historical_server is None
    finally:
        env.core.close()


def test_the_enabled_flag_without_a_detector_authority_does_not_start_the_channel(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "R1D_DISPOSITION_ENABLED", "YES")
    monkeypatch.setattr(config, "ALERT_SOURCE_UID", None)
    env = _core(tmp_path, monkeypatch)
    try:
        env.core.supervisor.start_historical_disposition()
        assert env.core.supervisor.historical_server is None
    finally:
        env.core.close()


# ------------------------------------------------------------------------------------------------ read-only observer (baseline / window / final)
def baseline_file(world, name="baseline.json"):
    path = str(world / name)
    assert hd.main(["baseline", "--audit-db", config.DB_PATH, "--detector-uid", str(UID), "--binding-sha256", binding(), "--out", path]) == 0
    return path


def test_the_observer_baseline_requires_the_pinned_binding_and_is_read_only(world, capsys):
    seed()
    before = Path(config.DB_PATH).read_bytes()
    assert hd.main(["baseline", "--audit-db", config.DB_PATH, "--detector-uid", str(UID), "--binding-sha256", "e" * 64, "--out", str(world / "b.json")]) == 1
    assert "BINDING_NOT_THE_PINNED_VALUE" in capsys.readouterr().err and not (world / "b.json").exists()
    path = baseline_file(world)
    baseline = json.loads(Path(path).read_text())
    assert baseline["schema"] == hd.BASELINE_SCHEMA and baseline["open_incidents"] == 1
    assert Path(config.DB_PATH).read_bytes() == before  # no write


def test_the_observer_final_passes_only_for_the_exact_transition(world):
    seed()
    digest = binding()
    base = baseline_file(world)
    assert service().dispose(request(digest), ROOT_PEER)["ok"] is True
    out = str(world / "result.json")
    assert hd.main(["final", "--audit-db", config.DB_PATH, "--baseline", base, "--binding-sha256", digest, "--out", out]) == 0
    result = json.loads(Path(out).read_text())
    assert result["result"] == "PASS" and result["claims"] == hd.CLAIMS
    assert result["checks"]["PREEXISTING_OPEN_INCIDENT_COUNT"] == 0 and result["checks"]["R1B_PRECONDITION_HISTORICAL_INCIDENT_CLEARED"] == "YES"
    assert result["checks"]["R1B_ATTEMPT_CONSUMED"] == "NO"


@pytest.mark.parametrize("tamper,reason", [
    ("still_open", "HISTORICAL_INCIDENT_STILL_OPEN"),
    ("fabricated_r8", "RECOVERY_EVENT_FABRICATED_OR_PRESENT"),
    ("extra_incident", "INCIDENT_SET_CHANGED"),
    ("wrong_summary", "INCIDENT_NOT_EXACTLY_THE_EXPECTED_TRANSITION"),
    ("extra_audit", "AUDIT_ADVANCE_NOT_EXACTLY_ONE_ROW"),
])
def test_the_observer_final_fails_closed_on_any_other_change(world, capsys, tamper, reason):
    seed()
    digest = binding()
    base = baseline_file(world)
    if tamper == "still_open":
        pass
    else:
        assert service().dispose(request(digest), ROOT_PEER)["ok"] is True
        if tamper == "fabricated_r8":
            db.log_event_strict("RECOVERY_R8_CLOSE", "x", db.INFO, 1)
        elif tamper == "extra_incident":
            conn = sqlite3.connect(config.DB_PATH)
            conn.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES ('2026-01-01 00:00:00','CLOSED','198.51.100.9')")
            conn.commit()
            conn.close()
        elif tamper == "wrong_summary":
            conn = sqlite3.connect(config.DB_PATH)
            conn.execute("UPDATE incidents SET summary='x' WHERE id=1")
            conn.commit()
            conn.close()
        elif tamper == "extra_audit":
            db.log_event_strict("NOTE", "x", db.INFO, None)
    rc = hd.main(["final", "--audit-db", config.DB_PATH, "--baseline", base, "--binding-sha256", digest, "--out", str(world / "r.json")])
    assert rc == 1 and reason in capsys.readouterr().err and not (world / "r.json").exists()


def test_the_window_check_binds_the_incident_times_to_the_preserved_r1a_window(world, capsys):
    import time as _time

    seed()
    now = _time.time()
    good = world / "window-good"
    good.write_text(f"window_start={now - 30}\nwindow_end={now + 30}\nobserve_seconds=60\n")
    assert hd.main(["window-check", "--audit-db", config.DB_PATH, "--detector-uid", str(UID), "--window-record", str(good)]) == 0
    late = world / "window-late"
    late.write_text(f"window_start={now + 100}\nwindow_end={now + 200}\n")
    assert hd.main(["window-check", "--audit-db", config.DB_PATH, "--detector-uid", str(UID), "--window-record", str(late)]) == 1
    assert "OUTSIDE_THE_R1A_WINDOW" in capsys.readouterr().err
    bad = world / "window-bad"
    bad.write_text("window_start=x\n")
    assert hd.main(["window-check", "--audit-db", config.DB_PATH, "--detector-uid", str(UID), "--window-record", str(bad)]) == 1


def test_the_observer_cli_has_no_mutating_subcommand_and_opens_sqlite_read_only():
    text = (ROOT / "aegis_soc/historical_disposition.py").read_text()
    cli = text[text.index("# --------------------------------------------------------------------------- read-only observer CLI"):]
    assert "mode=ro" in cli and "dispose_historical_incident_atomic" not in cli and "db.close_incident" not in cli
    assert "UPDATE" not in cli.split("def main")[0].replace("INCIDENT_NOT_EXACTLY", "")
