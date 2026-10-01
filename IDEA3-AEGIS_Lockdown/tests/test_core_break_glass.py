"""OD-R5-BG-01: break-glass is an emergency OPERATIONAL recovery path, never Recovery R4/R5/R8 and never the normal path.

Hermetic, like test_core_restore_policy: a real supervisor, Protocol v1 store, MQTT adapter, D4 gate and audit database;
only paho, the containment helper and the probes are fakes. Authenticated STATUS frames are delivered through the real
inbound verifier, so the durable lockdown-episode model and the process-local freshness proof run unmodified.
"""

from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path

import pytest
from test_core_recovery import IP, gates, make_env, op
from test_local_restore import CONFIRM, DEVICE, REASON, SECRET, Core

from aegis_soc import config
from aegis_soc import database as db
from aegis_soc import local_restore as lr
from aegis_soc import protocol_v1 as p1
from aegis_soc import recovery_protocol as rp
from aegis_soc.controller import RESTORE_UPLINK

BG = lr.BREAK_GLASS_CONFIRMATION


@pytest.fixture(scope="module")
def credential():
    return lr.RestoreCredential.parse(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N))


def bg_gate(env, supervisor=None, credential_=None):
    supervisor = supervisor or env.core.supervisor
    return lr.LocalRestoreGate(
        supervisor, credential_ or env.credential, allowed_uid=os.geteuid(), audit=db.log_event,
        audit_strict=db.log_event_strict, monotonic=lambda: env.core.now[0],
        incident_lookup=db.get_open_incident, attempt_lookup=db.restore_attempt_exists,
        precondition_lookup=env.service.restore_precondition_unmet,
        break_glass_lookup=env.service.break_glass_unmet, episode_lookup=supervisor.fresh_lockdown_episode,
    )


@pytest.fixture
def env(tmp_path, monkeypatch, credential):
    instance = make_env(tmp_path, monkeypatch, credential)
    instance.credential = credential
    instance.bg = bg_gate(instance)
    yield instance
    instance.core.close()


def bg_request(**changes):
    body = lr.restore_request(SECRET, CONFIRM, REASON, break_glass_confirmation=BG)
    for key, value in changes.items():
        if value is None:
            body.pop(key, None)
        else:
            body[key] = value
    return body


def ask(env, **changes):
    return env.bg.handle(bg_request(**changes), env.peer)


def lockdown(env, core=None):
    (core or env.core).deliver(p1.STATUS, output_state="LOCKDOWN")


def normal(env, core=None):
    (core or env.core).deliver(p1.STATUS, output_state="NORMAL")


def claims():
    conn = sqlite3.connect(config.DB_PATH)
    try:
        return conn.execute("SELECT episode_id, claim_case, incident_id, dispatched_at FROM restore_break_glass_claims").fetchall()
    finally:
        conn.close()


def audit_rows(*events):
    return [row for row in db.fetch_all_logs() if row[3] in events]


def refused(env, code, **changes):
    response = ask(env, **changes)
    assert (response["ok"], response["code"]) == (False, code), response
    nothing(env)
    return response


def nothing(env):
    assert claims() == []
    assert not audit_rows("RESTORE_BREAK_GLASS_CLAIM", "RESTORE_BREAK_GLASS_PUBLISHED", "RESTORE_REQUESTED", "RESTORE_PUBLISHED")
    assert env.core.client.published == []
    assert env.core.store.last_allocated_seq(DEVICE) == 0, "no command reservation"
    assert [call for call in env.containment.calls if call[0] == "block"] == [], "no containment mutation"


def case_b_failed_r3(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    env.containment.block_ok = False
    assert op(env, rp.OP_ISOLATE)["code"] == "R3_FAILED"
    env.containment.calls.clear()
    return incident_id


# --------------------------------------------------------------------------- episode model


def test_authenticated_lockdown_opens_one_episode_and_repeats_do_not_multiply_it(env):
    lockdown(env)
    lockdown(env)
    lockdown(env)
    episodes = db.fetch_lockdown_episodes(DEVICE)
    assert len(episodes) == 1 and episodes[0]["closed_at"] is None


def test_authenticated_normal_closes_the_episode_and_a_new_lockdown_opens_a_new_one(env):
    lockdown(env)
    normal(env)
    assert db.get_open_lockdown_episode(DEVICE) is None
    lockdown(env)
    episodes = db.fetch_lockdown_episodes(DEVICE)
    assert [e["closed_at"] is None for e in episodes] == [False, True], "history preserved, one open episode"
    assert episodes[0]["id"] != episodes[1]["id"]


def test_unauthenticated_or_invalid_status_never_creates_an_episode(env):
    topic = p1.topics(DEVICE).for_kind(p1.STATUS)
    env.core.mqtt._on_message(None, None, type("M", (), {"topic": topic, "payload": b'{"state":"LOCKDOWN"}', "retain": False})())
    forged_keys = p1.ProtocolKeys(c2d=bytes(range(0x40, 0x60)), d2c=bytes(range(0x60, 0x80)))
    fields = {
        "msg_id": p1.new_msg_id(), "device_time": p1.TIME_FLOOR + 3_599, "time_trust": "SYNCED", "output_state": "LOCKDOWN",
        "reason": "PERIODIC", "cmd_msg_id": "", "cmd_seq": 0, "device_seq_hwm": 0, "rssi_dbm": -55, "heap_free": 1,
    }
    _topic, raw = p1.encode(p1.STATUS, device_id=DEVICE, fields=fields, keys=forged_keys)
    env.core.mqtt._on_message(None, None, type("M", (), {"topic": topic, "payload": raw, "retain": False})())
    assert db.fetch_lockdown_episodes() == []
    assert env.core.supervisor.fresh_lockdown_episode() is None


def test_the_legacy_status_path_cannot_open_an_episode(env):
    env.core.mqtt.legacy = True
    env.core.supervisor._on_status("LOCKDOWN", -50, 1000, "")  # the unauthenticated callback only
    assert db.fetch_lockdown_episodes() == []
    assert env.core.supervisor.fresh_lockdown_episode() is None


def test_schema_init_is_idempotent_and_unsafe_history_fails_closed(env):
    db.init_db()
    db.init_db()
    conn = sqlite3.connect(config.DB_PATH)
    try:
        conn.execute("DROP INDEX ux_lockdown_episode_open")
        conn.execute("INSERT INTO lockdown_episodes (device_id, opened_at, open_msg_id) VALUES ('d', 't', 'a')")
        conn.execute("INSERT INTO lockdown_episodes (device_id, opened_at, open_msg_id) VALUES ('d', 't', 'b')")
        conn.commit()
    finally:
        conn.close()
    with pytest.raises(sqlite3.IntegrityError):
        db.init_db()
    assert len(db.fetch_lockdown_episodes("d")) == 2, "nothing was silently rewritten"


def test_history_cannot_be_deleted(env):
    lockdown(env)
    conn = sqlite3.connect(config.DB_PATH)
    try:
        with pytest.raises(sqlite3.DatabaseError):
            conn.execute("DELETE FROM lockdown_episodes")
    finally:
        conn.close()


def test_the_database_allows_one_claim_per_episode_and_concurrent_writers_produce_one_winner(env):
    lockdown(env)
    episode = db.get_open_lockdown_episode(DEVICE)["id"]
    wins, losses = [], []
    barrier = threading.Barrier(8)

    def writer():
        barrier.wait()
        try:
            wins.append(db.claim_break_glass(episode, "NO_INCIDENT", None, REASON, "uid=1"))
        except sqlite3.IntegrityError:
            losses.append(1)

    threads = [threading.Thread(target=writer) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(15)
    assert len(wins) == 1 and len(losses) == 7
    assert len(claims()) == 1 and len(audit_rows("RESTORE_BREAK_GLASS_CLAIM")) == 1
    with pytest.raises(sqlite3.IntegrityError):
        db.claim_break_glass(episode, "R3_FAILED", None, REASON, "uid=1")


def test_a_claim_needs_an_open_episode(env):
    lockdown(env)
    episode = db.get_open_lockdown_episode(DEVICE)["id"]
    normal(env)
    with pytest.raises(sqlite3.IntegrityError):
        db.claim_break_glass(episode, "NO_INCIDENT", None, REASON, "uid=1")


# --------------------------------------------------------------------------- restart / freshness


def test_an_open_durable_episode_alone_never_authorizes_break_glass_after_a_restart(env, tmp_path, monkeypatch, credential):
    lockdown(env)
    open_episode = db.get_open_lockdown_episode(DEVICE)["id"]
    assert env.core.supervisor.fresh_lockdown_episode() == open_episode
    restarted = Core(tmp_path / "restart", credential=credential, profile="production", store_path=tmp_path / "restart.sqlite3")
    try:
        assert db.get_open_lockdown_episode(DEVICE)["id"] == open_episode, "the durable episode survives the restart"
        assert restarted.supervisor.fresh_lockdown_episode() is None, "the process-local proof does not"
        gate = bg_gate(env, restarted.supervisor)
        response = gate.handle(bg_request(), env.peer)
        assert (response["ok"], response["code"]) == (False, "BREAK_GLASS_LOCKDOWN_UNPROVEN")
        assert restarted.client.published == [] and claims() == []
        lockdown(env, restarted)  # a fresh authenticated LOCKDOWN in the new process
        assert restarted.supervisor.fresh_lockdown_episode() == open_episode, "same episode identity, now live"
        assert gate.handle(bg_request(), env.peer)["code"] == "PUBLISHED"
    finally:
        restarted.close()


def test_a_status_normal_clears_the_freshness_proof(env):
    lockdown(env)
    normal(env)
    assert env.core.supervisor.fresh_lockdown_episode() is None


def test_a_failed_durable_episode_write_leaves_no_freshness_proof(env, monkeypatch):
    def broken(*_args):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(db, "record_authenticated_status", broken)
    lockdown(env)
    assert env.core.supervisor.fresh_lockdown_episode() is None


# --------------------------------------------------------------------------- request authority


def test_case_a_no_incident_with_everything_valid_publishes_a_break_glass_restore(env):
    lockdown(env)
    response = ask(env)
    assert response["ok"] is True and response["code"] == "PUBLISHED"
    assert response["break_glass"] == lr.BREAK_GLASS_RESULT == "OPERATIONAL_RECOVERY_ONLY"
    assert len(env.core.restores()) == 1
    rows = claims()
    assert len(rows) == 1 and rows[0][1] == "NO_INCIDENT" and rows[0][2] is None and rows[0][3] is not None
    assert len(audit_rows("RESTORE_BREAK_GLASS_CLAIM")) == 1 and len(audit_rows("RESTORE_BREAK_GLASS_PUBLISHED")) == 1
    # visibly not a normal RESTORE: no NULL-incident RESTORE_REQUESTED, no R5 publication row
    assert not audit_rows("RESTORE_REQUESTED", "RESTORE_PUBLISHED")
    assert env.containment.calls == [] and db.fetch_incidents(10) == []
    assert SECRET not in repr(db.fetch_all_logs())


@pytest.mark.parametrize(
    ("changes", "code"),
    [
        ({"secret": "wrong secret value here"}, "AUTH_FAILED"),
        ({"secret": None}, "AUTH_REQUIRED"),
        ({"confirmation": None}, "CONFIRMATION_REQUIRED"),
        ({"confirmation": "restore uplink"}, "CONFIRMATION_MISMATCH"),
        ({"break_glass_confirmation": None}, "BREAK_GLASS_CONFIRMATION_REQUIRED"),
        ({"break_glass_confirmation": CONFIRM}, "BREAK_GLASS_CONFIRMATION_MISMATCH"),
        ({"break_glass_confirmation": BG.lower()}, "BREAK_GLASS_CONFIRMATION_MISMATCH"),
        ({"break_glass_confirmation": BG + " "}, "BREAK_GLASS_CONFIRMATION_MISMATCH"),
        ({"reason": None}, "REASON_REQUIRED"),
        ({"reason": "short"}, "REASON_INVALID"),
        ({"break_glass": False}, "BREAK_GLASS_FLAG_REQUIRED"),
        ({"break_glass": None}, "BREAK_GLASS_FLAG_REQUIRED"),
        ({"break_glass": "true"}, "MALFORMED_REQUEST"),
        ({"break_glass": 1}, "MALFORMED_REQUEST"),
        ({"extra": 1}, "MALFORMED_REQUEST"),
        ({"origin": "web"}, "ORIGIN_REFUSED"),
    ],
)
def test_every_request_authority_failure_is_refused_before_any_side_effect(env, changes, code):
    lockdown(env)
    refused(env, code, **changes)


def test_a_non_core_peer_cannot_reach_break_glass(env):
    lockdown(env)
    response = env.bg.handle(bg_request(), lr.Peer(uid=os.geteuid() + 1, pid=1))
    assert response["code"] == "PEER_REFUSED"
    nothing(env)


def test_the_recovery_interface_has_no_break_glass_or_restore_operation():
    assert not any("BREAK" in name or "RESTORE_UPLINK" in name for name in rp.OPS)
    for module in ("recovery_core.py", "recovery_client.py", "recovery_ui.py"):
        source = (Path(__file__).resolve().parent.parent / "aegis_soc" / module).read_text()
        assert "BREAK_GLASS_CONFIRMATION" not in source and "break_glass_confirmation" not in source


def test_a_gate_without_break_glass_wiring_refuses_it(env):
    lockdown(env)
    gate = lr.LocalRestoreGate(
        env.core.supervisor, env.credential, allowed_uid=os.geteuid(), audit=db.log_event, audit_strict=db.log_event_strict,
        monotonic=lambda: env.core.now[0], incident_lookup=db.get_open_incident, attempt_lookup=db.restore_attempt_exists,
        precondition_lookup=env.service.restore_precondition_unmet,
    )
    assert gate.handle(bg_request(), env.peer)["code"] == "BREAK_GLASS_UNAVAILABLE"
    nothing(env)


def test_the_normal_request_wire_format_is_unchanged():
    assert set(lr.restore_request(SECRET, CONFIRM, REASON)) == {"v", "op", "origin", "secret", "confirmation", "reason"}


# --------------------------------------------------------------------------- eligibility


def test_no_authenticated_lockdown_means_no_break_glass(env):
    refused(env, "BREAK_GLASS_LOCKDOWN_UNPROVEN")


def test_case_b_without_an_r3_attempt_is_refused(env):
    env.service.bind_incident(IP)
    lockdown(env)
    refused(env, "BREAK_GLASS_INELIGIBLE")


def test_case_b_with_an_r3_request_but_no_result_is_pending_and_refused(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    db.log_event_strict("RECOVERY_R3_REQUESTED", f"ip={IP}", db.WARN, incident_id)
    lockdown(env)
    refused(env, "BREAK_GLASS_INELIGIBLE")


def test_case_b_with_a_latest_failed_r3_publishes_without_touching_the_incident_or_r3(env):
    incident_id = case_b_failed_r3(env)
    lockdown(env)
    before = db.fetch_incident_events(incident_id, ("RECOVERY_R3_RESULT",), 10)
    response = ask(env)
    assert response["code"] == "PUBLISHED" and response["break_glass"] == "OPERATIONAL_RECOVERY_ONLY"
    assert claims()[0][1:3] == ("R3_FAILED", incident_id)
    assert db.fetch_incident_events(incident_id, ("RECOVERY_R3_RESULT",), 10) == before
    assert db.restore_attempt_exists(incident_id) is False, "no normal RESTORE_REQUESTED for the incident"
    assert env.containment.calls == [], "break-glass never mutates containment"


def test_case_b_with_a_verified_r3_and_live_read_back_is_refused_because_the_normal_path_is_available(env):
    env.service.bind_incident(IP)
    assert op(env, rp.OP_ISOLATE)["code"] == "R3_VERIFIED"
    env.containment.calls.clear()
    lockdown(env)
    refused(env, "BREAK_GLASS_NOT_REQUIRED")
    # and the normal path really is available
    assert env.core.gate is not env.bg
    assert env.core.ask(lr.restore_request(SECRET, CONFIRM, REASON))["code"] == "PUBLISHED"


def test_a_verified_r3_that_lost_its_read_back_is_not_a_failed_r3_and_stays_refused(env):
    env.service.bind_incident(IP)
    assert op(env, rp.OP_ISOLATE)["code"] == "R3_VERIFIED"
    env.containment.present = False
    env.containment.calls.clear()
    lockdown(env)
    refused(env, "BREAK_GLASS_INELIGIBLE")


def test_an_r3_failure_for_a_different_address_is_not_a_failed_r3_for_this_incident(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    db.log_event_strict("RECOVERY_R3_RESULT", "result=FAILED ip=198.51.100.77 reason=X", db.WARN, incident_id)
    lockdown(env)
    refused(env, "BREAK_GLASS_INELIGIBLE")


def test_more_than_one_open_incident_is_refused(env):
    case_b_failed_r3(env)
    db.create_incident("198.51.100.5")
    conn = sqlite3.connect(config.DB_PATH)
    conn.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES ('t', 'OPEN', '198.51.100.6')")
    conn.commit()
    conn.close()
    lockdown(env)
    refused(env, "BREAK_GLASS_INELIGIBLE")


@pytest.mark.parametrize("scenario", ["failed", "not_configured", "no_target_cached"])
def test_a_fresh_verified_r2_is_always_required(env, monkeypatch, scenario):
    lockdown(env)
    if scenario == "failed":
        env.tcp_ok = False
    elif scenario == "not_configured":
        monkeypatch.setattr(config, "RECOVERY_MANAGEMENT_PROBE_TARGET", "")
    else:  # a previously cached VERIFIED R2 must not stand in for the fresh probe
        assert op(env, rp.OP_PROBE)["ok"] is not None
        env.tcp_ok = False
    refused(env, "BREAK_GLASS_PRECONDITION_UNMET")


def test_every_break_glass_operation_runs_its_own_fresh_r2_probe(env):
    lockdown(env)
    env.tcp_targets.clear()
    assert ask(env)["code"] == "PUBLISHED"
    assert env.tcp_targets == ["192.0.2.10:22"]


# --------------------------------------------------------------------------- one claim per episode / ordering


def test_the_claim_is_spent_before_publication_and_a_second_request_for_the_episode_is_refused(env):
    lockdown(env)
    assert ask(env)["code"] == "PUBLISHED"
    env.core.supervisor.pending_command = None
    env.core.supervisor.awaiting_physical_confirmation = None
    env.core.client.published.clear()
    response = ask(env)
    assert (response["ok"], response["code"]) == (False, "BREAK_GLASS_EPISODE_SPENT")
    assert env.core.client.published == [] and len(claims()) == 1


def test_publication_outcome_unknown_leaves_the_episode_spent_and_no_retry(env):
    lockdown(env)
    env.core.client.publish_rc = 1  # the broker refused the frame: not published, outcome not a success
    first = ask(env)
    assert first["ok"] is False
    assert len(claims()) == 1, "the claim is durable before publication"
    env.core.client.publish_rc = 0
    env.core.supervisor.pending_command = None
    env.core.supervisor.awaiting_physical_confirmation = None
    env.core.client.published.clear()
    assert ask(env)["code"] == "BREAK_GLASS_EPISODE_SPENT"
    assert env.core.client.published == []


def test_a_new_authenticated_lockdown_episode_is_eligible_again(env):
    lockdown(env)
    assert ask(env)["code"] == "PUBLISHED"
    normal(env)
    env.core.supervisor.pending_command = None
    env.core.supervisor.awaiting_physical_confirmation = None
    lockdown(env)
    assert ask(env)["code"] == "PUBLISHED"
    assert [row[0] for row in claims()] == sorted({row[0] for row in claims()}) and len(claims()) == 2


def test_a_durable_claim_write_failure_publishes_nothing(env, monkeypatch):
    lockdown(env)

    def broken(*_args):
        raise sqlite3.OperationalError("disk full")

    env.bg.claim_recorder = broken
    response = ask(env)
    assert (response["ok"], response["code"]) == (False, "AUDIT_UNAVAILABLE")
    nothing(env)


def test_the_notification_failure_does_not_unspend_the_claim(env, monkeypatch):
    lockdown(env)

    def broken(*_args, **_kwargs):
        raise RuntimeError("ops channel down")

    monkeypatch.setattr("aegis_soc.comms.send_ops_alert", broken)
    assert ask(env)["code"] == "PUBLISHED"
    assert len(claims()) == 1


def test_concurrent_requests_make_exactly_one_claim_and_at_most_one_publication(env, credential):
    lockdown(env)
    gates_ = [env.bg, bg_gate(env), bg_gate(env)]
    for gate in gates_:
        gate.claim_lookup = lambda _episode: None  # stale spent reads, as separate processes would have
    outcomes = []
    barrier = threading.Barrier(len(gates_))

    def attempt(gate):
        barrier.wait()
        outcomes.append(gate.handle(bg_request(), env.peer)["code"])

    threads = [threading.Thread(target=attempt, args=(gate,)) for gate in gates_]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(30)
    assert len(outcomes) == 3 and outcomes.count("PUBLISHED") == 1
    assert len(claims()) == 1 and len(env.core.restores()) == 1


def test_the_claim_is_durable_across_a_restart_and_response_loss(env, tmp_path, credential):
    lockdown(env)
    assert ask(env)["code"] == "PUBLISHED"
    restarted = Core(tmp_path / "restart2", credential=credential, profile="production", store_path=tmp_path / "restart2.sqlite3")
    try:
        lockdown(env, restarted)
        response = bg_gate(env, restarted.supervisor).handle(bg_request(), env.peer)
        assert response["code"] == "BREAK_GLASS_EPISODE_SPENT" and restarted.client.published == []
    finally:
        restarted.close()


# --------------------------------------------------------------------------- basis chokepoint


@pytest.mark.parametrize("basis", ["BREAK_GLASS", "BREAK_GLASS_BASIS", None, "", lr.BreakGlassBasis(1, 1), lr.BreakGlassBasis(0, 0)])
def test_the_chokepoint_refuses_a_forged_or_fabricated_break_glass_basis(env, basis):
    lockdown(env)  # a fresh episode exists, but no claim does
    result = env.core.supervisor.issue_command(RESTORE_UPLINK, "direct", origin=lr.CONTROLLER_ORIGIN, authorize_restore=True, restore_basis=basis)
    assert result.sent is False and result.reason_code == "RESTORE_POLICY_REQUIRED"
    assert env.core.client.published == []


def test_a_real_claim_basis_is_single_use_and_a_stale_episode_basis_is_refused(env):
    lockdown(env)
    episode = db.get_open_lockdown_episode(DEVICE)["id"]
    claim_id = db.claim_break_glass(episode, "NO_INCIDENT", None, REASON, "uid=1")
    basis = lr.BreakGlassBasis(claim_id, episode)
    sup = env.core.supervisor
    assert sup.issue_command(RESTORE_UPLINK, "x", origin=lr.CONTROLLER_ORIGIN, authorize_restore=True, restore_basis=basis).sent
    sup.pending_command = None
    reuse = sup.issue_command(RESTORE_UPLINK, "x", origin=lr.CONTROLLER_ORIGIN, authorize_restore=True, restore_basis=basis)
    assert reuse.sent is False and reuse.reason_code == "RESTORE_POLICY_REQUIRED"


def test_the_normal_path_still_requires_the_normal_basis_only(env):
    lockdown(env)
    assert env.core.supervisor.issue_command(RESTORE_UPLINK, "x", origin=lr.CONTROLLER_ORIGIN, authorize_restore=True).reason_code == "RESTORE_POLICY_REQUIRED"
    assert env.core.supervisor.issue_command(
        RESTORE_UPLINK, "x", origin=lr.CONTROLLER_ORIGIN, authorize_restore=True, restore_basis=lr.RESTORE_BASIS_R3_VERIFIED,
    ).sent is True


def test_the_production_supervisor_wires_break_glass_into_its_own_gate(env):
    env.core.supervisor.start_local_restore()
    gate = env.core.supervisor.local_restore.gate
    assert gate.break_glass_lookup == env.core.supervisor.recovery.break_glass_unmet
    assert gate.episode_lookup == env.core.supervisor.fresh_lockdown_episode


# --------------------------------------------------------------------------- R4 / R5 / R8 ignore break-glass


def test_break_glass_never_becomes_r4_or_r5_even_with_a_correlated_ack_and_normal(env):
    incident_id = case_b_failed_r3(env)
    lockdown(env)
    published = ask(env)
    assert published["code"] == "PUBLISHED"
    msg_id, seq = published["msg_id"], published["seq"]
    env.core.deliver(p1.ACK, ack_for_msg_id=msg_id, ack_for_seq=seq, result="ACCEPTED")
    env.core.deliver(p1.STATUS, output_state="NORMAL", reason="COMMAND", cmd_msg_id=msg_id, cmd_seq=seq, device_seq_hwm=seq)
    status = op(env, rp.OP_RESTORE_STATUS)
    states = gates(status)
    assert states[rp.R4]["status"] == rp.PENDING and states[rp.R5]["status"] == rp.PENDING
    assert status["data"]["break_glass_restore"] == "OPERATIONAL_RECOVERY_ONLY"
    assert db.restore_attempt_exists(incident_id) is False
    assert not db.fetch_incident_events(incident_id, ("RESTORE_PUBLISHED", "RESTORE_REQUESTED"))
    closed = op(env, rp.OP_CLOSE, summary="attempt to close after a break-glass restore")
    assert closed["ok"] is False and db.get_open_incident() is not None


def test_the_normal_status_report_says_none_without_a_claim(env):
    lockdown(env)
    assert op(env, rp.OP_RESTORE_STATUS)["data"]["break_glass_restore"] == "NONE"


def test_the_gate_never_issues_cut_or_blocks_and_never_uses_legacy_attacker_state(env):
    case_b_failed_r3(env)
    lockdown(env)
    assert ask(env)["code"] == "PUBLISHED"
    actions = [command.fields["action"] for command in env.core.commands()]
    assert actions == [RESTORE_UPLINK]
    assert env.containment.calls == []
