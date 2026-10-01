"""PR252 security remediation (F1-F4, R5 ordering, import graph). Repository-only, hermetic.

Nothing here opens a broker, a device, the root containment socket or a network listener. F1 has no test that
reaches ``_on_attacker`` through production because no approved production alert source exists (see
``test_no_production_alert_source_reaches_the_incident_binding``).
"""

from __future__ import annotations

import inspect
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import replace
from pathlib import Path

import pytest
from test_core_recovery import (
    IP,
    OTHER_IP,
    SUMMARY,
    incident_count,
    make_env,
    op,
    raw_exchange,
)
from test_local_restore import SECRET, request

from aegis_soc import config, mqtt_client, recovery_client, recovery_core, supervisor
from aegis_soc import database as db
from aegis_soc import local_restore as lr
from aegis_soc import protocol_v1 as p1
from aegis_soc import recovery_protocol as rp

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def credential():
    return lr.RestoreCredential.parse(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N))


@pytest.fixture
def env(tmp_path, monkeypatch, credential):
    instance = make_env(tmp_path, monkeypatch, credential)
    yield instance
    instance.core.close()


@pytest.fixture
def served(env):
    directory = Path(tempfile.mkdtemp(prefix="aegis-rs-"))
    servers = []

    def start(allowed_uid=None, *, deadline=None, socket_gid=None):
        server = recovery_core.RecoveryServer(
            directory / "recovery.sock", env.service,
            allowed_uid=os.geteuid() if allowed_uid is None else allowed_uid, socket_gid=socket_gid,
        )
        if deadline is not None:
            server.request_deadline = deadline
        server.start()
        servers.append(server)
        return server

    env.directory = directory
    env.start = start
    yield env
    for server in servers:
        server.close()
    shutil.rmtree(directory, ignore_errors=True)


def within(seconds, target, *args):
    """Run ``target`` on a thread; return (finished_in_time, thread)."""
    thread = threading.Thread(target=target, args=args, daemon=True)
    thread.start()
    thread.join(seconds)
    return not thread.is_alive(), thread


# --------------------------------------------------------------------------- F1: no invented alert source


def test_no_production_alert_source_reaches_the_incident_binding():
    """F1 is BLOCKED_BY_MISSING_PRODUCTION_ALERT_SOURCE: Protocol v1 has no alert kind, production subscribes only
    to ACK/STATUS, and the only attacker source is the unsigned legacy-v0-lab topic. Nothing may be wired to it."""
    assert p1.KINDS == frozenset({p1.COMMAND, p1.HEARTBEAT, p1.ACK, p1.STATUS})
    v1 = mqtt_client.MQTTManager.__new__(mqtt_client.MQTTManager)
    v1.legacy = False
    v1.protocol = type("P", (), {"topics": p1.topics("aegis-esp32-01")})()
    assert {topic for topic, _ in v1._subscriptions()} == {v1.protocol.topics.ack, v1.protocol.topics.status}
    legacy = mqtt_client.MQTTManager.__new__(mqtt_client.MQTTManager)
    legacy.legacy = True
    assert config.TOPIC_ATTACKER_IP in {topic for topic, _ in legacy._subscriptions()}
    sources = [
        inspect.getsource(recovery_core.RecoveryServer),
        inspect.getsource(recovery_core.CoreRecoveryService.handle),
    ]
    assert not any("bind_incident" in text for text in sources), "no request/IPC path may bind an incident"


# --------------------------------------------------------------------------- F2: durable one-shot invariant


def _restore_rows(incident_id):
    return db.fetch_incident_events(incident_id, ("RESTORE_REQUESTED",), 10)


def test_the_database_enforces_one_restore_requested_row_per_incident(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    db.log_event_strict("RESTORE_REQUESTED", "first", db.CRITICAL, incident_id)
    with pytest.raises(sqlite3.IntegrityError):
        db.log_event_strict("RESTORE_REQUESTED", "second", db.CRITICAL, incident_id)
    assert len(_restore_rows(incident_id)) == 1


def test_a_restore_row_for_incident_a_does_not_consume_incident_b(env):
    a = env.service.bind_incident(IP)["incident_id"]
    db.log_event_strict("RESTORE_REQUESTED", "a", db.CRITICAL, a)
    assert db.restore_attempt_exists(a) is True
    op(env, rp.OP_CLOSE, summary=SUMMARY)  # refused (incomplete); a stays open, so close it directly for the test
    db.close_incident(a, "closed for test")
    b = env.service.bind_incident(OTHER_IP)["incident_id"]
    assert b != a and db.restore_attempt_exists(b) is False
    db.log_event_strict("RESTORE_REQUESTED", "b", db.CRITICAL, b)  # must not collide with a
    assert len(_restore_rows(b)) == 1


def test_historical_rows_without_an_incident_neither_collide_nor_consume(env):
    db.log_event_strict("RESTORE_REQUESTED", "legacy one", db.CRITICAL)
    db.log_event_strict("RESTORE_REQUESTED", "legacy two", db.CRITICAL)  # NULL incident_id is not one shared incident
    incident_id = env.service.bind_incident(IP)["incident_id"]
    assert db.restore_attempt_exists(incident_id) is False
    assert env.core.ask(request())["code"] == "PUBLISHED"


def test_init_db_adds_the_invariant_to_an_existing_database_and_keeps_history(tmp_path, monkeypatch):
    path = tmp_path / "old.sqlite3"
    monkeypatch.setattr(config, "DB_PATH", str(path))
    monkeypatch.setattr("aegis_soc.comms.send_ops_alert", lambda *a, **k: None)
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT DEFAULT 'INFO',"
                     " event_type TEXT, details TEXT, incident_id INTEGER, hash TEXT)")
        conn.execute("INSERT INTO audit_logs (event_type, details, incident_id) VALUES ('RESTORE_REQUESTED', 'old', 7)")
    db.init_db()
    db.init_db()  # idempotent
    with pytest.raises(sqlite3.IntegrityError):
        db.log_event_strict("RESTORE_REQUESTED", "dup", db.CRITICAL, 7)
    assert db.restore_attempt_exists(7) is True


def test_init_db_fails_closed_and_preserves_history_when_old_duplicates_exist(tmp_path, monkeypatch):
    """Historical duplicates mean the durable one-shot invariant cannot be proven.

    Startup must fail closed instead of silently falling back to a process/read-side
    guard, and the existing audit history must remain untouched.
    """
    path = tmp_path / "dup.sqlite3"
    monkeypatch.setattr(config, "DB_PATH", str(path))
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, level TEXT DEFAULT 'INFO',"
                     " event_type TEXT, details TEXT, incident_id INTEGER, hash TEXT)")
        for _ in range(2):
            conn.execute("INSERT INTO audit_logs (event_type, details, incident_id) VALUES ('RESTORE_REQUESTED', 'old', 7)")

    with pytest.raises(sqlite3.IntegrityError):
        db.init_db()

    with sqlite3.connect(path) as conn:
        rows = conn.execute(
            "SELECT event_type, details, incident_id FROM audit_logs ORDER BY id"
        ).fetchall()
        index = conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='index' AND name='ux_audit_restore_requested_incident'"
        ).fetchone()

    assert rows == [
        ("RESTORE_REQUESTED", "old", 7),
        ("RESTORE_REQUESTED", "old", 7),
    ]
    assert index is None


def test_concurrent_writers_on_separate_connections_create_exactly_one_attempt(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    outcomes, barrier = [], threading.Barrier(8)

    def attempt(index):
        barrier.wait()
        try:
            db.log_event_strict("RESTORE_REQUESTED", f"racer {index}", db.CRITICAL, incident_id)
            outcomes.append("ok")
        except sqlite3.IntegrityError:
            outcomes.append("refused")

    threads = [threading.Thread(target=attempt, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert sorted(outcomes) == ["ok"] + ["refused"] * 7
    assert len(_restore_rows(incident_id)) == 1


def test_a_second_process_lookup_race_collides_at_the_database_and_never_publishes_a_second_restore(env):
    """The gate's SELECT can be stale (second process / TOCTOU). The INSERT collision must refuse and not publish."""
    incident_id = env.service.bind_incident(IP)["incident_id"]
    env.core.gate.attempt_lookup = lambda _incident: False  # stale: pretends nothing was spent
    db.log_event_strict("RESTORE_REQUESTED", "the other process won", db.CRITICAL, incident_id)
    response = env.core.ask(request())
    assert (response["ok"], response["code"]) == (False, "RESTORE_ATTEMPT_CONSUMED")
    assert env.core.commands() == [] and env.core.client.published == []
    assert len(_restore_rows(incident_id)) == 1


def test_a_failing_audit_write_keeps_the_incident_bound_restore_fail_closed(env):
    env.service.bind_incident(IP)

    def broken(*_args, **_kwargs):
        raise sqlite3.OperationalError("database is locked")

    env.core.gate.audit_strict = broken
    response = env.core.ask(request())
    assert (response["ok"], response["code"]) == (False, "AUDIT_UNAVAILABLE")
    assert env.core.commands() == [] and env.core.client.published == []


def test_restart_still_sees_the_spent_one_shot_at_the_database_level(env, tmp_path, monkeypatch, credential):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    assert env.core.ask(request())["code"] == "PUBLISHED"
    path = config.DB_PATH
    env.core.close()
    (tmp_path / "again").mkdir()
    again = make_env(tmp_path / "again", monkeypatch, credential, db_path=path)
    try:
        with pytest.raises(sqlite3.IntegrityError):
            db.log_event_strict("RESTORE_REQUESTED", "second life", db.CRITICAL, incident_id)
    finally:
        again.core.close()


# --------------------------------------------------------------------------- F2 audit: incident binding characterization


def test_the_first_bind_wins_and_a_later_different_ip_is_ignored_and_audited(env):
    first = env.service.bind_incident(IP)
    second = env.service.bind_incident(OTHER_IP)
    assert (first["action"], second["action"]) == ("CREATED", "IGNORED_DIFFERENT_IP")
    assert db.get_open_incident()["attacker_ip"] == IP


def test_a_protected_management_address_can_be_bound_and_then_fails_isolation_closed(env):
    """CHARACTERIZATION of a known dead end (owner decision pending; incident authority deliberately NOT changed):
    a bound address the root helper refuses leaves R3 FAILED, and a different later IP cannot rebind."""
    env.containment.block_ok = False  # the helper answers PROTECTED_ADDRESS for gateway/management addresses
    env.service.bind_incident("192.0.2.10")
    response = op(env, rp.OP_ISOLATE)
    assert response["ok"] is False and response["code"] == "R3_FAILED"
    assert env.service.bind_incident(OTHER_IP)["action"] == "IGNORED_DIFFERENT_IP"
    assert incident_count() == 1


def test_an_audit_failure_after_incident_creation_keeps_one_incident_and_is_reported(env, monkeypatch):
    monkeypatch.setattr(db, "log_event_strict", lambda *a, **k: (_ for _ in ()).throw(sqlite3.OperationalError("locked")))
    first = env.service.bind_incident(IP)
    assert first["action"] == "CREATED" and first["audited"] is False
    assert env.service.bind_incident(IP)["action"] == "EXISTING"
    assert incident_count() == 1


# --------------------------------------------------------------------------- F3: containment never waits on the operator lock


def _arm_alert_path(env):
    sup = env.core.supervisor
    sup.settings = replace(sup.settings, auto_contain=True)
    sup.status.armed = "ARMED"
    sup.recovery = env.service
    sup.containment = env.containment
    return sup


def test_a_slow_operator_probe_does_not_delay_alert_containment(env):
    sup = _arm_alert_path(env)
    env.service.bind_incident(IP)
    release, entered = threading.Event(), threading.Event()

    def slow_tcp(target):
        entered.set()
        release.wait(20)
        return True, f"tcp {target}"

    env.service._tcp_probe = slow_tcp
    operator = threading.Thread(target=op, args=(env, rp.OP_PROBE), daemon=True)
    operator.start()
    try:
        assert entered.wait(5), "the operator PROBE never reached its network probe"
        finished, _ = within(2.0, sup._on_attacker, OTHER_IP)
        assert finished, "the alert path waited behind a slow operator PROBE"
        assert ("block", OTHER_IP) in env.containment.calls
    finally:
        release.set()
        operator.join(10)


def test_duplicate_alerts_are_idempotent_under_concurrency(env):
    barrier, results = threading.Barrier(8), []

    def alert():
        barrier.wait()
        results.append(env.service.bind_incident(IP)["action"])

    threads = [threading.Thread(target=alert) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert sorted(results) == ["CREATED"] + ["EXISTING"] * 7
    assert incident_count() == 1
    assert len(db.fetch_incident_events(db.get_open_incident()["id"], ("INCIDENT_BOUND",))) == 1


def test_racing_different_attacker_addresses_never_overwrite_the_open_incident(env):
    barrier, results = threading.Barrier(2), {}

    def alert(ip):
        barrier.wait()
        results[ip] = env.service.bind_incident(ip)["action"]

    threads = [threading.Thread(target=alert, args=(ip,)) for ip in (IP, OTHER_IP)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(10)
    assert sorted(results.values()) == ["CREATED", "IGNORED_DIFFERENT_IP"]
    winner = next(ip for ip, action in results.items() if action == "CREATED")
    assert incident_count() == 1 and db.get_open_incident()["attacker_ip"] == winner


def test_close_and_bind_racing_never_corrupt_incident_state(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    env.service._run_r7 = lambda r6: env.service._record(rp.R7, rp.VERIFIED, "ok")
    stop, seen = threading.Event(), []

    def hammer_alerts():
        while not stop.is_set():
            seen.append(env.service.bind_incident(OTHER_IP)["action"])

    thread = threading.Thread(target=hammer_alerts, daemon=True)
    thread.start()
    try:
        for _ in range(25):
            op(env, rp.OP_CLOSE, summary=SUMMARY)  # refused (gates incomplete); must never touch the binding
            op(env, rp.OP_PROBE)
    finally:
        stop.set()
        thread.join(10)
    assert set(seen) <= {"IGNORED_DIFFERENT_IP"}
    assert db.get_open_incident()["id"] == incident_id and db.get_open_incident()["attacker_ip"] == IP
    assert incident_count() == 1


def test_bind_incident_still_never_contains_cuts_or_publishes(env):
    _arm_alert_path(env)
    env.service.bind_incident(IP)
    assert env.containment.calls == [] and env.core.client.published == []
    assert "containment" not in inspect.getsource(recovery_core.CoreRecoveryService.bind_incident).replace("_bind_lock", "")


# --------------------------------------------------------------------------- F4: AF_UNIX peer-auth / slow client


def _exchange(path, chunks=(), *, pause=0.0, wait=5.0):
    """Connect, send ``chunks`` (with ``pause`` between), then read one reply line. Returns (reply|None, elapsed)."""
    started = time.monotonic()
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(wait)
        connection.connect(str(path))
        try:
            for chunk in chunks:
                try:
                    connection.sendall(chunk)
                except OSError:  # the server answered and closed while we were still trickling
                    break
                time.sleep(pause)
            line = connection.makefile("rb").readline()
        except (TimeoutError, OSError):
            return None, time.monotonic() - started
    return (json.loads(line) if line else None), time.monotonic() - started


def test_an_unauthorized_peer_is_refused_before_any_request_byte_is_read(served):
    server = served.start(allowed_uid=os.geteuid() + 1, deadline=5.0)
    reply, elapsed = _exchange(server.path, wait=1.5)  # sends ZERO bytes
    assert reply is not None and (reply["ok"], reply["code"]) == (False, "PEER_REFUSED")
    assert elapsed < 1.0
    assert served.containment.calls == []


def test_peer_credentials_are_read_before_the_first_recv(served, monkeypatch):
    order = []
    real_peer = recovery_core._peer_from

    def spy_peer(connection):
        order.append("peer")
        return real_peer(connection)

    class Spy:
        def __init__(self, connection):
            self._c = connection

        def recv(self, *args):
            order.append("recv")
            return self._c.recv(*args)

        def __getattr__(self, name):
            return getattr(self._c, name)

    monkeypatch.setattr(recovery_core, "_peer_from", spy_peer)
    server = served.start()
    real_read = server._read_and_handle
    server._read_and_handle = lambda connection: real_read(Spy(connection))
    reply = recovery_client.request(rp.OP_STATUS, path=str(server.path), expected_uid=os.geteuid())
    assert reply["ok"] is True and order[0] == "peer" and "recv" in order


def test_a_trickling_request_reaches_the_total_deadline(served):
    server = served.start(deadline=0.6)
    reply, elapsed = _exchange(server.path, [b"{"] * 40, pause=0.15, wait=6.0)
    assert reply is not None and (reply["ok"], reply["code"]) == (False, "MALFORMED_REQUEST")
    assert elapsed < 2.0, "the deadline was reset on every recv instead of bounding the whole request"


def test_a_silent_slow_client_does_not_block_the_next_authorized_client(served):
    server = served.start(deadline=0.5)
    silent = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    silent.connect(str(server.path))
    try:
        started = time.monotonic()
        reply = recovery_client.request(rp.OP_STATUS, path=str(server.path), expected_uid=os.geteuid())
        assert reply["ok"] is True and time.monotonic() - started < 3.0
    finally:
        silent.close()


def test_the_deadline_is_monotonic_and_the_hard_limit_is_unchanged():
    source = inspect.getsource(recovery_core.RecoveryServer._read_and_handle)
    assert "monotonic" in source and "time.time" not in source
    assert rp.MAX_MESSAGE_BYTES == 4096


def test_an_oversized_request_is_still_refused_and_not_processed(served):
    server = served.start()
    reply = raw_exchange(server.path, b"x" * (rp.MAX_MESSAGE_BYTES + 512))
    assert (reply["ok"], reply["code"]) == (False, "MALFORMED_REQUEST")
    assert served.containment.calls == []


def test_a_pipelined_burst_gets_exactly_one_response(served):
    server = served.start()
    status = json.dumps({"v": 1, "op": "STATUS"}).encode() + b"\n"
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(str(server.path))
        connection.sendall(status * 5)
        stream = connection.makefile("rb")
        first = json.loads(stream.readline())
        assert first["ok"] is True and first["code"] == "STATUS"
        assert stream.readline() == b""  # the server closed after one reply; the rest was never executed


def test_timeout_logs_carry_no_request_content(served):
    server = served.start(deadline=0.4)
    secret_marker = b'{"v":1,"op":"CLOSE","summary":"TOPSECRET-MARKER'
    _exchange(server.path, [secret_marker], wait=3.0)
    assert not any("TOPSECRET-MARKER" in str(row) for row in db.fetch_all_logs())


def test_the_socket_is_0660_with_the_configured_group(served):
    server = served.start(socket_gid=os.getegid())
    metadata = Path(server.path).stat()
    assert (metadata.st_mode & 0o777) == 0o660 and metadata.st_gid == os.getegid()


def test_a_group_writable_or_symlinked_runtime_directory_is_refused(served, tmp_path):
    loose = Path(tempfile.mkdtemp(prefix="aegis-loose-"))
    try:
        loose.chmod(0o770)
        with pytest.raises(recovery_core.RecoveryChannelError):
            recovery_core.RecoveryServer(loose / "r.sock", served.service, allowed_uid=os.geteuid()).start()
        real = Path(tempfile.mkdtemp(prefix="aegis-real-"))
        link = loose.parent / f"aegis-link-{os.getpid()}"
        link.symlink_to(real)
        try:
            with pytest.raises(recovery_core.RecoveryChannelError):
                recovery_core.RecoveryServer(link / "r.sock", served.service, allowed_uid=os.geteuid()).start()
        finally:
            link.unlink()
            shutil.rmtree(real, ignore_errors=True)
    finally:
        shutil.rmtree(loose, ignore_errors=True)


def test_a_stale_socket_is_taken_over_but_a_live_one_is_not(served):
    stale = served.directory / "recovery.sock"
    leftover = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    leftover.bind(str(stale))
    leftover.close()  # the file remains, nothing listens
    server = served.start()
    assert recovery_client.request(rp.OP_STATUS, path=str(server.path), expected_uid=os.geteuid())["ok"]
    with pytest.raises(recovery_core.RecoveryChannelError):
        recovery_core.RecoveryServer(server.path, served.service, allowed_uid=os.geteuid()).start()


# --------------------------------------------------------------------------- R5 ordering (inert until owner decision)


class Preconditions:
    def __init__(self, unmet=None, boom=False):
        self.unmet, self.boom, self.calls, self.guard_depth_at_call = unmet, boom, [], []

    def __call__(self, incident):
        self.calls.append(incident["id"] if incident else None)
        if self.boom:
            raise RuntimeError("probe exploded")
        return self.unmet


def _with_preconditions(env, lookup):
    env.core.gate.precondition_lookup = lookup
    entered = []
    real_guard = env.core.supervisor.command_guard

    def spy_guard():
        entered.append(True)
        return real_guard()

    env.core.supervisor.command_guard = spy_guard
    return entered


def test_unmet_preconditions_refuse_without_consuming_the_one_shot(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    lookup = Preconditions(unmet="R3 is not VERIFIED")
    _with_preconditions(env, lookup)
    refused = env.core.ask(request())
    assert (refused["ok"], refused["code"]) == (False, "RECOVERY_PRECONDITION_UNMET")
    assert db.restore_attempt_exists(incident_id) is False and env.core.client.published == []
    lookup.unmet = None
    assert env.core.ask(request())["code"] == "PUBLISHED"  # the one-shot was intact


def test_preconditions_run_after_credential_and_confirmation_and_before_the_command_guard(env):
    env.service.bind_incident(IP)
    lookup = Preconditions()
    entered = _with_preconditions(env, lookup)
    assert env.core.ask(request(secret="wrong-secret-value-1"))["code"] == "AUTH_FAILED"
    assert env.core.ask(request(confirmation="nope"))["code"] == "CONFIRMATION_MISMATCH"
    assert lookup.calls == [], "the network probe must not run for an unauthenticated or unconfirmed request"
    original_lookup_call = lookup.__call__
    seen = []

    def ordered(incident):
        seen.append(("precondition", bool(entered)))
        return original_lookup_call(incident)

    env.core.gate.precondition_lookup = ordered
    env.core.ask(request())
    assert seen == [("precondition", False)], "the fresh R2 probe must precede the command guard"


def test_a_failing_precondition_lookup_fails_closed_without_consuming(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    _with_preconditions(env, Preconditions(boom=True))
    refused = env.core.ask(request())
    assert refused["code"] == "RECOVERY_PRECONDITION_UNMET"
    assert db.restore_attempt_exists(incident_id) is False and env.core.client.published == []


def test_the_service_precondition_helper_requires_r1_r3_and_a_fresh_r2(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    unmet = env.service.restore_precondition_unmet
    assert "R3" in unmet(db.get_open_incident())  # R3 has not run yet
    assert op(env, rp.OP_ISOLATE)["code"] == "R3_VERIFIED"
    env.tcp_ok = True
    before = len(env.tcp_targets)
    assert unmet(db.get_open_incident()) is None
    assert env.tcp_targets[before:] == ["192.0.2.10:22"], "exactly one fresh single-target R2 probe"
    env.tcp_ok = False
    assert "R2" in unmet(db.get_open_incident())
    assert unmet(None) and incident_id


def test_r8_can_prove_the_r3_result_row_precedes_restore_requested(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    check = env.service.r3_precedes_restore
    assert check(incident_id) is False  # neither row exists
    op(env, rp.OP_ISOLATE)
    assert check(incident_id) is False  # R3 exists but RESTORE_REQUESTED does not yet
    db.log_event_strict("RESTORE_REQUESTED", "after r3", db.CRITICAL, incident_id)
    assert check(incident_id) is True


def test_r8_detects_restore_requested_recorded_before_the_r3_result(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    db.log_event_strict("RESTORE_REQUESTED", "too early", db.CRITICAL, incident_id)
    op(env, rp.OP_ISOLATE)
    assert env.service.r3_precedes_restore(incident_id) is False


@pytest.mark.xfail(
    strict=True,
    reason="BLOCKED_ON_OWNER_DECISION: production wiring of precondition_lookup / R8 ordering needs an approved "
    "break-glass so the owner cannot be locked out; the confirmation string and authority are NOT invented here",
)
def test_production_supervisor_enforces_r3_before_restore(env):
    assert lr.LocalRestoreGate.__init__  # keep the reference honest
    source = inspect.getsource(supervisor.AegisSupervisor.start_local_restore)
    assert "precondition_lookup" in source


# --------------------------------------------------------------------------- recovery_ui import graph


def test_recovery_ui_imports_no_mqtt_controller_telegram_credentials_or_database():
    code = (
        "import json, sys\n"
        "import aegis_soc.recovery_ui\n"
        "print(json.dumps(sorted(sys.modules)))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=60, check=True,
        env={**os.environ, "PYTHONPATH": str(ROOT)},
    )
    loaded = set(json.loads(result.stdout))
    forbidden_prefixes = (
        "paho", "aegis_soc.mqtt_client", "aegis_soc.controller", "aegis_soc.telegram_control", "aegis_soc.comms",
        "aegis_soc.config", "aegis_soc.database", "aegis_soc.local_restore", "aegis_soc.supervisor",
        "aegis_soc.recovery_core", "aegis_soc.security", "aegis_soc.auth", "aegis_soc.protocol_store",
        "aegis_soc.protocol_v1", "aegis_soc.systemd_credentials", "aegis_soc.dispatch", "aegis_soc.ip_containment",
        "sqlite3", "ssl", "urllib.request", "tkinter", "requests",
    )
    offenders = sorted(name for name in loaded if name.startswith(forbidden_prefixes))
    assert offenders == []
    assert {"aegis_soc.recovery_client", "aegis_soc.recovery_protocol"} <= loaded
