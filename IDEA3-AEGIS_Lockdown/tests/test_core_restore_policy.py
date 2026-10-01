"""R5 NORMAL path: a production RESTORE is publishable only for the one open incident whose R3 isolation is verified.

Hermetic (see test_core_recovery): a real supervisor, Protocol v1 store, MQTT adapter and D4 gate over a temporary audit
database; only paho, the containment helper and the probes are fakes. Break-glass is deliberately NOT implemented:
``BREAK_GLASS=OWNER_DECISION_REQUIRED``. No incident, no R3, a stale or foreign R3, a mismatched address, an absent
containment entry, a failed R2 probe, a lookup or audit failure, or a spent attempt each refuse, and a refusal never
consumes the durable one-shot.
"""

from __future__ import annotations

import inspect
import os
import sqlite3
import threading

import pytest
from test_core_recovery import IP, OTHER_IP, make_env, op
from test_local_restore import DEVICE, SECRET, request

from aegis_soc import config, recovery_core
from aegis_soc import database as db
from aegis_soc import local_restore as lr
from aegis_soc import recovery_protocol as rp
from aegis_soc import supervisor as supervisor_module
from aegis_soc.controller import RESTORE_UPLINK
from aegis_soc.ip_containment import ContainmentUnavailable


@pytest.fixture(scope="module")
def credential():
    return lr.RestoreCredential.parse(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N))


@pytest.fixture
def env(tmp_path, monkeypatch, credential):
    instance = make_env(tmp_path, monkeypatch, credential)
    yield instance
    instance.core.close()


def isolated(env):
    """R1 bound and R3 verified for the open incident. Returns the incident id."""
    incident_id = env.service.bind_incident(IP)["incident_id"]
    assert op(env, rp.OP_ISOLATE)["code"] == "R3_VERIFIED"
    return incident_id


def refused(env, *, code="RECOVERY_PRECONDITION_UNMET"):
    response = env.core.ask(request())
    assert (response["ok"], response["code"]) == (False, code), response
    assert env.core.client.published == [], "a refused RESTORE must publish nothing"
    assert not [row for row in db.fetch_all_logs() if row[3] in {"RESTORE_REQUESTED", "RESTORE_PUBLISHED"}], "a refusal must not consume the one-shot"
    assert env.core.store.last_allocated_seq(DEVICE) == 0, "a refused RESTORE must not reserve a command-store sequence"
    assert [call for call in env.containment.calls if call[0] == "block"] in ([], [("block", IP)]), "no containment mutation from the gate"
    return response


def published(env):
    response = env.core.ask(request())
    assert response["code"] == "PUBLISHED", response
    return response


# --------------------------------------------------------------------------- normal path


def test_a_restore_with_a_verified_r3_for_the_open_incident_is_published_and_binds_the_attempt(env):
    incident_id = isolated(env)
    published(env)
    assert db.restore_attempt_exists(incident_id) is True


def test_a_restore_without_an_open_incident_is_refused_in_production(env):
    refused(env)  # the former silent "no incident" fallback is gone; break-glass is an owner decision


def test_a_restore_without_r3_is_refused(env):
    env.service.bind_incident(IP)
    refused(env)


def test_a_refusal_never_consumes_the_one_shot_and_the_attempt_stays_available(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    refused(env)
    assert db.restore_attempt_exists(incident_id) is False
    assert op(env, rp.OP_ISOLATE)["code"] == "R3_VERIFIED"
    published(env)


def test_an_r3_from_an_earlier_incident_is_stale_and_refused(env):
    first = isolated(env)
    db.close_incident(first, "closed for the stale-R3 test")
    second = env.service.bind_incident(IP)["incident_id"]
    assert second != first
    refused(env)  # R3 VERIFIED rows exist, but they belong to the first incident
    assert db.restore_attempt_exists(second) is False


def test_an_r3_row_for_a_different_address_is_refused(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    db.log_event_strict("RECOVERY_R3_RESULT", f"result=VERIFIED ip={OTHER_IP} reason=READ_BACK_CONFIRMED", db.CRITICAL, incident_id)
    refused(env)


def test_the_latest_r3_result_decides_so_a_later_failure_refuses(env):
    incident_id = isolated(env)
    db.log_event_strict("RECOVERY_R3_RESULT", f"result=FAILED ip={IP} reason=HELPER_UNAVAILABLE", db.WARN, incident_id)
    refused(env)


def test_r3_verified_but_absent_from_the_containment_set_is_refused(env):
    isolated(env)
    env.containment.present = False
    refused(env)


def test_an_unavailable_containment_read_back_is_refused(env, monkeypatch):
    isolated(env)

    def down(_ip):
        raise ContainmentUnavailable("helper down")

    monkeypatch.setattr(env.containment, "contains", down)
    refused(env)


def test_a_failed_fresh_r2_probe_is_refused(env):
    isolated(env)
    env.tcp_ok = False
    refused(env)


def test_an_unconfigured_r2_target_is_refused(env, monkeypatch):
    isolated(env)
    monkeypatch.setattr(config, "RECOVERY_MANAGEMENT_PROBE_TARGET", "")
    refused(env)


def test_more_than_one_open_incident_is_refused(env):
    isolated(env)
    connection = db._connect()
    connection.execute("INSERT INTO incidents (opened_at, state, attacker_ip) VALUES ('2026-10-02 00:00:00', 'OPEN', ?)", (OTHER_IP,))
    connection.commit()
    connection.close()
    assert db.count_open_incidents() == 2
    refused(env)


def test_an_incident_without_a_valid_attacker_ip_is_refused(env):
    db.create_incident(None)
    refused(env)


def test_a_lookup_failure_fails_closed(env):
    isolated(env)

    def boom():
        raise sqlite3.OperationalError("locked")

    env.core.gate.incident_lookup = boom
    response = env.core.ask(request())
    assert response["ok"] is False and response["code"] in {"AUDIT_UNAVAILABLE", "RECOVERY_PRECONDITION_UNMET"}
    assert env.core.client.published == [] and not [r for r in db.fetch_all_logs() if r[3] == "RESTORE_REQUESTED"]


def test_a_durable_audit_failure_fails_closed_without_publishing(env):
    isolated(env)

    def broken(*_args, **_kwargs):
        raise RuntimeError("audit down")

    env.core.gate.audit_strict = broken
    assert env.core.ask(request())["code"] == "AUDIT_UNAVAILABLE"
    assert env.core.client.published == []


def test_a_spent_attempt_refuses_a_second_restore(env):
    incident_id = isolated(env)
    db.log_event_strict("RESTORE_REQUESTED", "earlier attempt", db.CRITICAL, incident_id)
    refused_response = env.core.ask(request())
    assert (refused_response["ok"], refused_response["code"]) == (False, "RESTORE_ATTEMPT_CONSUMED")
    assert env.core.client.published == []


def test_a_spent_attempt_is_refused_before_any_network_probe(env):
    incident_id = isolated(env)
    db.log_event_strict("RESTORE_REQUESTED", "earlier attempt", db.CRITICAL, incident_id)
    before = len(env.tcp_targets)
    assert env.core.ask(request())["code"] == "RESTORE_ATTEMPT_CONSUMED"
    assert len(env.tcp_targets) == before


# --------------------------------------------------------------------------- one snapshot, no TOCTOU


def test_the_gate_evaluates_and_binds_one_incident_snapshot(env):
    isolated(env)
    snapshots = []
    real_lookup = env.core.gate.precondition_lookup

    def spy(incident):
        snapshots.append(incident)
        return real_lookup(incident)

    env.core.gate.precondition_lookup = spy
    published(env)
    assert len(snapshots) == 1 and snapshots[0] == db.get_open_incident()


def test_an_incident_that_changes_between_evaluation_and_the_guard_is_refused(env):
    first = isolated(env)
    real = db.get_open_incident
    calls = []

    def flip():
        calls.append(1)
        if len(calls) == 1:
            return real()
        return {"id": first + 1, "opened_at": "2026-10-02 00:00:00", "state": "OPEN", "attacker_ip": OTHER_IP}

    env.core.gate.incident_lookup = flip
    response = env.core.ask(request())
    assert (response["ok"], response["code"]) == (False, "INCIDENT_CHANGED")
    assert env.core.client.published == [] and db.restore_attempt_exists(first) is False


def test_the_evaluated_snapshot_is_the_one_the_audit_row_binds(env):
    incident_id = isolated(env)
    published(env)
    rows = db.fetch_incident_events(incident_id, ("RESTORE_REQUESTED",))
    assert len(rows) == 1 and f"incident_id={incident_id}" in rows[0]["details"]


# --------------------------------------------------------------------------- the production chokepoint


def test_a_direct_production_restore_without_a_policy_basis_is_refused(env):
    isolated(env)
    result = env.core.supervisor.issue_command(RESTORE_UPLINK, "direct", origin=lr.CONTROLLER_ORIGIN, authorize_restore=True)
    assert result.sent is False and result.reason_code == "RESTORE_POLICY_REQUIRED"
    assert env.core.client.published == []


@pytest.mark.parametrize("basis", ["", "BREAK_GLASS", "break_glass", "r3_verified", "R3", "OWNER", "R3_VERIFIED "])
def test_an_unapproved_or_forged_basis_is_refused_and_break_glass_is_not_a_basis(env, basis):
    isolated(env)
    result = env.core.supervisor.issue_command(
        RESTORE_UPLINK, "direct", origin=lr.CONTROLLER_ORIGIN, authorize_restore=True, restore_basis=basis,
    )
    assert result.sent is False and result.reason_code == "RESTORE_POLICY_REQUIRED"
    assert lr.PRODUCTION_RESTORE_BASES == frozenset({"R3_VERIFIED"})


def test_the_explicit_basis_lets_the_chokepoint_through(env):
    isolated(env)
    result = env.core.supervisor.issue_command(
        RESTORE_UPLINK, "direct", origin=lr.CONTROLLER_ORIGIN, authorize_restore=True, restore_basis=lr.RESTORE_BASIS_R3_VERIFIED,
    )
    assert result.sent is True


def test_cut_uplink_is_not_subject_to_the_restore_policy(env):
    result = env.core.supervisor.issue_command("CUT_UPLINK", "fail-secure cut", origin="controller", critical=True)
    assert result.reason_code != "RESTORE_POLICY_REQUIRED"


def test_the_chokepoint_applies_only_to_the_production_profile(tmp_path, monkeypatch, credential):
    lab = make_env(tmp_path, monkeypatch, credential, profile="development")
    try:
        result = lab.core.supervisor.issue_command(RESTORE_UPLINK, "lab", origin=lr.CONTROLLER_ORIGIN, authorize_restore=True)
        assert result.reason_code != "RESTORE_POLICY_REQUIRED"
    finally:
        lab.core.close()


def test_the_chokepoint_runs_before_any_command_state_changes():
    source = inspect.getsource(supervisor_module.AegisSupervisor.issue_command)
    assert source.index("RESTORE_POLICY_REQUIRED") < source.index("self._command_lock")


# --------------------------------------------------------------------------- production wiring (replaces the strict xfail)


def test_the_production_supervisor_wires_the_recovery_policy_into_the_d4_gate(env):
    env.core.supervisor.start_local_restore()
    gate = env.core.supervisor.local_restore.gate
    assert gate.precondition_lookup == env.core.supervisor.recovery.restore_precondition_unmet
    assert gate.incident_lookup is db.get_open_incident and gate.attempt_lookup is db.restore_attempt_exists


def test_the_supervisor_built_gate_refuses_a_restore_with_no_incident_then_allows_the_verified_one(env):
    env.core.supervisor.recovery = env.service  # the supervisor's own service, with the fake helper and probes injected
    env.core.supervisor.start_local_restore()
    gate = env.core.supervisor.local_restore.gate
    peer = lr.Peer(uid=os.geteuid(), pid=4242)
    refusal = gate.handle(request(), peer)
    assert (refusal["ok"], refusal["code"]) == (False, "RECOVERY_PRECONDITION_UNMET")
    assert env.core.client.published == []
    isolated(env)
    assert gate.handle(request(), peer)["code"] == "PUBLISHED"


def test_a_miswired_production_gate_refuses_before_any_audit_row_is_written(env):
    isolated(env)
    env.core.gate.precondition_lookup = None
    response = env.core.ask(request())
    assert (response["ok"], response["code"]) == (False, "RECOVERY_PRECONDITION_UNMET")
    assert env.core.client.published == [] and not [r for r in db.fetch_all_logs() if r[3] == "RESTORE_REQUESTED"]


def test_break_glass_is_not_implemented_and_stays_an_owner_decision():
    assert lr.BREAK_GLASS == "OWNER_DECISION_REQUIRED"
    assert "BREAK_GLASS" not in lr.PRODUCTION_RESTORE_BASES


def test_the_precondition_helper_requires_r1_exactly_one_open_incident_live_r3_and_a_fresh_r2(env):
    env.service.bind_incident(IP)
    unmet = env.service.restore_precondition_unmet
    assert "R3" in unmet(db.get_open_incident())
    assert op(env, rp.OP_ISOLATE)["code"] == "R3_VERIFIED"
    assert unmet(db.get_open_incident()) is None
    assert unmet(None) and "R1" in unmet(None)
    env.containment.present = False
    assert "R3" in unmet(db.get_open_incident())
    env.containment.present = True
    env.tcp_ok = False
    assert "R2" in unmet(db.get_open_incident())


# --------------------------------------------------------------------------- normal path: exact incident binding, no NULL, durable one-shot


def test_restore_requested_is_bound_to_the_exact_incident_and_is_never_null(env):
    incident_id = isolated(env)
    published(env)
    rows = [row for row in db.fetch_all_logs() if row[3] == "RESTORE_REQUESTED"]
    assert len(rows) == 1 and rows[0][5] == incident_id and rows[0][5] is not None
    assert f"incident_id={incident_id}" in rows[0][4]
    assert not [row for row in rows if row[5] is None]


def test_a_policy_that_wrongly_passes_still_cannot_produce_a_null_incident_restore(env):
    env.core.gate.precondition_lookup = lambda _incident: None  # a broken policy that approves everything
    response = env.core.ask(request())
    assert (response["ok"], response["code"]) == (False, "RECOVERY_PRECONDITION_UNMET")
    assert "Core-bound incident" in response["detail"]
    assert env.core.client.published == [] and env.core.store.last_allocated_seq(DEVICE) == 0
    assert not [row for row in db.fetch_all_logs() if row[3] == "RESTORE_REQUESTED"]


@pytest.mark.parametrize("scenario", ["no_incident", "no_r3", "r3_failed", "wrong_ip", "r2_failed", "r2_unset", "no_containment"])
def test_every_normal_path_failure_happens_before_any_durable_row_command_or_publish(env, monkeypatch, scenario):
    if scenario != "no_incident":
        incident_id = env.service.bind_incident(IP)["incident_id"]
    if scenario in {"r3_failed", "wrong_ip", "r2_failed", "r2_unset", "no_containment"}:
        assert op(env, rp.OP_ISOLATE)["code"] == "R3_VERIFIED"
    if scenario == "r3_failed":
        db.log_event_strict("RECOVERY_R3_RESULT", f"result=FAILED ip={IP} reason=HELPER_UNAVAILABLE", db.WARN, incident_id)
    if scenario == "wrong_ip":
        db.log_event_strict("RECOVERY_R3_RESULT", f"result=VERIFIED ip={OTHER_IP} reason=READ_BACK_CONFIRMED", db.CRITICAL, incident_id)
    if scenario == "r2_failed":
        env.tcp_ok = False
    if scenario == "r2_unset":
        monkeypatch.setattr(config, "RECOVERY_MANAGEMENT_PROBE_TARGET", "")
    if scenario == "no_containment":
        env.containment.present = False
    refused(env)
    assert env.core.commands() == []


def test_the_database_one_shot_stays_authoritative_for_two_gates_racing_on_one_incident(env, credential):
    incident_id = isolated(env)
    second = lr.LocalRestoreGate(
        env.core.supervisor, credential, allowed_uid=os.geteuid(), audit=db.log_event, audit_strict=db.log_event_strict,
        monotonic=lambda: env.core.now[0], incident_lookup=db.get_open_incident,
        attempt_lookup=lambda _incident: False,  # a stale spent-attempt read, as a second process would have
        precondition_lookup=env.service.restore_precondition_unmet,
    )
    env.core.gate.attempt_lookup = lambda _incident: False
    outcomes = []
    gate_lock = threading.Barrier(2)

    def attempt(gate):
        gate_lock.wait()
        outcomes.append(gate.handle(request(), env.peer)["code"])

    threads = [threading.Thread(target=attempt, args=(gate,)) for gate in (env.core.gate, second)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(15)
    assert sorted(outcomes).count("PUBLISHED") == 1 and len(outcomes) == 2
    assert len([row for row in db.fetch_all_logs() if row[3] == "RESTORE_REQUESTED" and row[5] == incident_id]) == 1
    assert len(env.core.restores()) == 1


def test_the_spent_attempt_survives_a_core_restart_under_the_production_policy(env, tmp_path, monkeypatch, credential):
    incident_id = isolated(env)
    published(env)
    path = config.DB_PATH
    env.core.close()
    (tmp_path / "again").mkdir()
    again = make_env(tmp_path / "again", monkeypatch, credential, db_path=path)
    try:
        assert db.restore_attempt_exists(incident_id) is True
        response = again.core.ask(request())
        assert (response["ok"], response["code"]) == (False, "RESTORE_ATTEMPT_CONSUMED")
        assert again.core.commands() == [] and again.core.client.published == []
    finally:
        again.core.close()


def test_the_restore_gate_has_no_cut_containment_mutation_or_legacy_attacker_side_effect(env, monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("the RESTORE gate reached the legacy attacker path")

    monkeypatch.setattr(env.core.supervisor, "_on_attacker", forbidden)
    isolated(env)
    published(env)
    assert [call for call in env.containment.calls if call[0] == "block"] == [("block", IP)], "only the earlier R3 isolation blocked"
    assert {command.fields["action"] for command in env.core.commands()} == {RESTORE_UPLINK}
    assert not [row for row in db.fetch_all_logs() if row[3] in {"CUT_REQUESTED", "COMMAND_REJECTED"}]


def test_f1_alert_ingress_still_binds_the_incident_the_restore_policy_then_requires(env):
    ingress = recovery_core.AlertIngress(env.core.supervisor.on_production_alert)
    reply = ingress.handle({"v": 1, "attacker_ip": IP}, lr.Peer(uid=os.geteuid(), pid=7), allowed_uid=os.geteuid())
    assert (reply["ok"], reply["code"]) == (True, "BOUND")
    refused(env)  # R1 is satisfied now, but R3 has not run
    assert op(env, rp.OP_ISOLATE)["code"] == "R3_VERIFIED"
    published(env)
