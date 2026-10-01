"""Core-mediated Recovery: the Core is the sole production authority, the desktop only observes.

Hermetic: a real supervisor, Protocol v1 store, MQTT adapter and D4 gate (reusing the D4 test harness) over a
temporary audit database; only paho, the containment helper and the network probes are fakes. Nothing here opens a
broker, a device, the root containment socket, or a network listener.
"""

from __future__ import annotations

import inspect
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest
from test_local_restore import CONFIRM, REASON, SECRET, Core, request

from aegis_soc import config, recovery_client, recovery_core, recovery_ui
from aegis_soc import database as db
from aegis_soc import local_restore as lr
from aegis_soc import protocol_v1 as p1
from aegis_soc import recovery_protocol as rp
from aegis_soc.controller import RESTORE_UPLINK
from aegis_soc.dispatch_worker import PAUSED_CREDENTIAL
from aegis_soc.ip_containment import ContainmentUnavailable
from aegis_soc.runtime import RuntimeSettings
from aegis_soc.supervisor import AegisSupervisor

ROOT = Path(__file__).resolve().parent.parent
IP = "203.0.113.9"
OTHER_IP = "198.51.100.77"
SUMMARY = "attacker isolated, uplink restored by the owner, services verified"


class FakeContainment:
    """Stands in for the root helper. Records every call so tests can prove what the Core asked for."""

    def __init__(self, *, block_ok=True, present=True, unavailable=False):
        self.calls = []
        self.block_ok = block_ok
        self.present = present
        self.unavailable = unavailable

    def block(self, ip):
        self.calls.append(("block", ip))
        if self.unavailable:
            raise ContainmentUnavailable("down")
        if not self.block_ok:
            return {"ok": False, "reason_code": "PROTECTED_ADDRESS"}
        return {"ok": True, "operation": "block", "ip": ip, "changed": True}

    def contains(self, ip):
        self.calls.append(("contains", ip))
        return {"ok": True, "operation": "contains", "ip": ip, "present": self.present}


class Env:
    pass


@pytest.fixture(scope="module")
def credential():
    return lr.RestoreCredential.parse(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N))


def make_env(tmp_path, monkeypatch, credential, *, profile="production", containment=None, db_path=None):
    monkeypatch.setattr(config, "DB_PATH", str(db_path or tmp_path / "audit.sqlite3"))
    monkeypatch.setattr("aegis_soc.comms.send_ops_alert", lambda *a, **k: None)
    monkeypatch.setattr(config, "RECOVERY_MANAGEMENT_PROBE_TARGET", "192.0.2.10:22")
    monkeypatch.setattr(config, "RECOVERY_NETWORK_PROBE_TARGETS", "192.0.2.1:53,192.0.2.10:22")
    monkeypatch.setattr(config, "RECOVERY_WEB_READINESS_URL", "https://web.invalid/security/")
    db.init_db()
    env = Env()
    env.core = Core(tmp_path, credential=credential, profile=profile)
    env.core.mqtt.device_online = lambda: True
    env.containment = containment or FakeContainment()
    env.tcp_targets = []
    env.tcp_ok = True
    env.web_ok = True

    def tcp(target):
        env.tcp_targets.append(target)
        return env.tcp_ok, f"tcp {target}"

    env.service = recovery_core.CoreRecoveryService(
        env.core.supervisor, tcp_probe=tcp, web_probe=lambda url: (env.web_ok, "web"), containment=env.containment,
    )
    env.core.gate = lr.LocalRestoreGate(
        env.core.supervisor,
        credential,
        allowed_uid=os.geteuid(),
        audit=db.log_event,
        audit_strict=db.log_event_strict,
        monotonic=lambda: env.core.now[0],
        incident_lookup=db.get_open_incident,
        attempt_lookup=db.restore_attempt_exists,
    )
    env.peer = lr.Peer(uid=os.geteuid(), pid=4242)
    return env


@pytest.fixture
def env(tmp_path, monkeypatch, credential):
    instance = make_env(tmp_path, monkeypatch, credential)
    yield instance
    instance.core.close()


def op(env, name, **params):
    return env.service.handle({"v": 1, "op": name, **params}, env.peer, allowed_uid=os.geteuid())


def gates(response):
    return {gate["gate"]: gate for gate in response["data"]["gates"]}


def incident_count():
    return len(db.fetch_incidents(1000))


def run_restore_to_normal(env, *, ack=True, normal=True):
    published = env.core.ask(request())
    assert published["code"] == "PUBLISHED"
    msg_id, seq = published["msg_id"], published["seq"]
    if ack:
        env.core.deliver(p1.ACK, ack_for_msg_id=msg_id, ack_for_seq=seq, result="ACCEPTED")
    if normal:
        env.core.deliver(p1.STATUS, output_state="NORMAL", reason="COMMAND", cmd_msg_id=msg_id, cmd_seq=seq,
                         device_seq_hwm=seq)
    return msg_id, seq


# --------------------------------------------------------------------------- R1: Core-owned incident binding


def test_a_validated_alert_creates_exactly_one_open_incident_and_is_idempotent(env):
    first = env.service.bind_incident(IP)
    assert first["action"] == "CREATED" and first["audited"] is True
    again = env.service.bind_incident(IP)
    assert again == {"action": "EXISTING", "incident_id": first["incident_id"]}
    assert incident_count() == 1
    rows = db.fetch_incident_events(first["incident_id"], ("INCIDENT_BOUND",))
    assert len(rows) == 1 and f"attacker_ip={IP}" in rows[0]["details"]


def test_a_different_alert_never_rebinds_the_open_incident_target(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    assert env.service.bind_incident(OTHER_IP)["action"] == "IGNORED_DIFFERENT_IP"
    assert incident_count() == 1
    assert db.get_open_incident()["attacker_ip"] == IP
    assert db.fetch_incident_events(incident_id, ("INCIDENT_ALERT_IGNORED",))


def test_an_open_incident_without_an_ip_gets_the_validated_alert_ip(env):
    incident_id = db.create_incident(None)
    assert env.service.bind_incident(IP)["action"] == "IP_SET"
    bound = db.get_open_incident()
    assert bound["id"] == incident_id and bound["attacker_ip"] == IP


@pytest.mark.parametrize("value", ["", "not-an-ip", "::1", "127.0.0.1", "0.0.0.0", "224.0.0.1", "169.254.1.1", None, 42])
def test_invalid_or_non_attacker_addresses_never_create_an_incident(env, value):
    assert env.service.bind_incident(value)["action"] == "REFUSED"
    assert incident_count() == 0


def test_binding_records_without_containing_cutting_or_publishing(env):
    env.service.bind_incident(IP)
    assert env.containment.calls == []
    assert env.core.client.published == []


def test_the_bound_alert_path_runs_only_in_a_production_core(tmp_path, monkeypatch, credential):
    dev = make_env(tmp_path, monkeypatch, credential, profile="development")
    try:
        assert dev.service.bind_incident(IP)["action"] == "SKIPPED"
        assert incident_count() == 0
    finally:
        dev.core.close()


def test_the_supervisor_alert_path_binds_an_incident_without_auto_containment(env):
    env.core.supervisor.recovery = env.service
    env.core.supervisor._on_attacker(IP)
    assert db.get_open_incident()["attacker_ip"] == IP
    assert env.containment.calls == [] and env.core.client.published == []


def test_opening_or_querying_recovery_never_creates_an_incident(env):
    for name in (rp.OP_STATUS, rp.OP_PROBE, rp.OP_RESTORE_STATUS, rp.OP_ISOLATE):
        op(env, name)
    op(env, rp.OP_CLOSE, summary=SUMMARY)
    assert incident_count() == 0
    status = op(env, rp.OP_STATUS)
    assert status["data"]["incident"] is None and gates(status)[rp.R1]["status"] == rp.FAILED


def test_the_recovery_ui_and_client_contain_no_incident_creation_path():
    for module in (recovery_ui, recovery_client, rp):
        source = inspect.getsource(module)
        assert "create_incident" not in source and "import database" not in source and "from . import database" not in source


# --------------------------------------------------------------------------- R3: incident-bound isolation


def test_isolation_has_no_caller_supplied_ip_anywhere():
    assert list(inspect.signature(recovery_core.CoreRecoveryService.isolate).parameters) == ["self"]
    with pytest.raises(rp.RequestError):
        rp.validate_request({"v": 1, "op": "ISOLATE", "ip": OTHER_IP})
    for extra in ("ip", "target", "attacker_ip", "cmd", "path"):
        with pytest.raises(rp.RequestError) as caught:
            rp.validate_request({"v": 1, "op": "STATUS", extra: "x"})
        assert caught.value.code == "MALFORMED_REQUEST"


def test_isolation_targets_exactly_the_bound_attacker_and_requires_an_independent_read_back(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    response = op(env, rp.OP_ISOLATE)
    assert response["ok"] is True and response["code"] == "R3_VERIFIED"
    assert env.containment.calls == [("block", IP), ("contains", IP)]
    assert gates(op(env, rp.OP_STATUS))[rp.R3]["status"] == rp.VERIFIED
    requested = db.fetch_incident_events(incident_id, ("RECOVERY_R3_REQUESTED",))
    result = db.fetch_incident_events(incident_id, ("RECOVERY_R3_RESULT",))
    assert requested and result and result[0]["details"].startswith(f"result=VERIFIED ip={IP} ")


def test_a_read_back_that_does_not_confirm_the_block_is_not_verified(tmp_path, monkeypatch, credential):
    instance = make_env(tmp_path, monkeypatch, credential, containment=FakeContainment(present=False))
    try:
        instance.service.bind_incident(IP)
        response = op(instance, rp.OP_ISOLATE)
        assert response["ok"] is False and response["code"] == "R3_FAILED"
        assert instance.containment.calls == [("block", IP), ("contains", IP)]
        assert gates(op(instance, rp.OP_STATUS))[rp.R3]["status"] == rp.FAILED
    finally:
        instance.core.close()


def test_an_unconfirmed_block_never_reaches_the_read_back(tmp_path, monkeypatch, credential):
    instance = make_env(tmp_path, monkeypatch, credential, containment=FakeContainment(block_ok=False))
    try:
        instance.service.bind_incident(IP)
        assert op(instance, rp.OP_ISOLATE)["ok"] is False
        assert instance.containment.calls == [("block", IP)]
    finally:
        instance.core.close()


def test_an_unavailable_helper_fails_isolation_closed(tmp_path, monkeypatch, credential):
    instance = make_env(tmp_path, monkeypatch, credential, containment=FakeContainment(unavailable=True))
    try:
        instance.service.bind_incident(IP)
        response = op(instance, rp.OP_ISOLATE)
        assert (response["ok"], response["code"]) == (False, "R3_FAILED")
        assert gates(op(instance, rp.OP_STATUS))[rp.R3]["status"] == rp.FAILED
    finally:
        instance.core.close()


def test_isolation_without_a_bound_incident_touches_nothing(env):
    assert op(env, rp.OP_ISOLATE)["code"] == "NO_INCIDENT"
    assert env.containment.calls == []


# --------------------------------------------------------------------------- desktop authority boundary


def test_the_observer_cannot_reach_the_containment_helper_or_any_publisher():
    code = (
        "import sys; import aegis_soc.recovery_ui, aegis_soc.recovery_client, aegis_soc.recovery_protocol;"
        "forbidden=('aegis_soc.config','aegis_soc.database','aegis_soc.mqtt_client','aegis_soc.controller','aegis_soc.gui',"
        "'aegis_soc.telegram_control','aegis_soc.ip_containment','aegis_soc.protocol_store','aegis_soc.protocol_runtime',"
        "'aegis_soc.protocol_inbound','aegis_soc.local_restore','aegis_soc.comms','aegis_soc.wizard','aegis_soc.recovery_core');"
        "print(sorted(m for m in sys.modules if m in forbidden or m.split('.')[0]=='paho'))"
    )
    result = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "[]"


def test_the_observer_has_no_demo_defaults_or_credentials():
    for module in (recovery_ui, recovery_client, rp):
        source = inspect.getsource(module)
        for needle in ("1234", "DEMO", "192.168.2.174", "AEGIS_ADMIN_PIN", "AEGIS_HMAC_SECRET", "AEGIS_MQTT", "aegis_audit.db"):
            assert needle not in source


def test_the_core_recovery_module_never_publishes_or_issues_commands():
    source = inspect.getsource(recovery_core)
    for needle in (".issue(", ".publish(", "AF_INET", "authorize_restore", "verify_pin", "controller"):
        assert needle not in source


def test_a_production_recovery_run_publishes_nothing_to_mqtt(env):
    env.service.bind_incident(IP)
    for name in (rp.OP_STATUS, rp.OP_PROBE, rp.OP_ISOLATE, rp.OP_RESTORE_STATUS):
        op(env, name)
    op(env, rp.OP_CLOSE, summary=SUMMARY)
    assert env.core.client.published == []


def test_d4_remains_the_only_production_restore_authority(env):
    assert "RESTORE_UPLINK" not in rp.OPS and not any("RESTORE" in name and name != "RESTORE_STATUS" for name in rp.OPS)
    with pytest.raises(rp.RequestError) as caught:
        rp.validate_request({"v": 1, "op": "RESTORE_UPLINK"})
    assert caught.value.code == "UNKNOWN_OPERATION"
    settings = RuntimeSettings.from_profile("production", dry_run=False, start_detector=False, start_gui=False)
    with pytest.raises(ValueError):
        AegisSupervisor(settings, restore_origins=frozenset({"gui"}), dispatch_worker=None)
    controller = env.core.supervisor.controller
    for origin in ("gui", "recovery-wizard", "web", "telegram", "recovery"):
        result = controller.issue(RESTORE_UPLINK, "attempt", origin=origin, authorize_restore=True)
        assert result.sent is False and result.reason_code == "RESTORE_ORIGIN_REFUSED"
    assert env.core.client.published == []


def test_the_supervisor_wires_the_incident_bound_one_shot_into_the_d4_gate(env):
    env.core.supervisor.start_local_restore()
    gate = env.core.supervisor.local_restore.gate
    assert gate.incident_lookup is db.get_open_incident and gate.attempt_lookup is db.restore_attempt_exists


def test_server_admin_is_not_the_production_recovery_entrypoint():
    admin = (ROOT / "server_admin.py").read_text(encoding="utf-8")
    assert "aegis_soc.gui" in admin and "recovery_ui" not in admin
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "python -m aegis_soc.recovery_ui" in readme and "`server_admin.py` is not the production Recovery entrypoint" in readme


# --------------------------------------------------------------------------- R4 / R5: durable one-shot on D4


def test_d4_binds_the_attempt_to_the_incident_with_durable_rows(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    msg_id, _seq = run_restore_to_normal(env, ack=False, normal=False)
    requested = db.fetch_incident_events(incident_id, ("RESTORE_REQUESTED",))
    published = db.fetch_incident_events(incident_id, ("RESTORE_PUBLISHED",))
    assert len(requested) == 1 and len(published) == 1 and published[0]["details"].startswith(f"msg_id={msg_id} ")
    assert db.restore_attempt_exists(incident_id) is True
    assert SECRET not in json.dumps([requested, published])


def test_any_durable_restore_row_for_the_incident_blocks_a_second_attempt(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    db.log_event_strict("RESTORE_REQUESTED", "earlier attempt", db.CRITICAL, incident_id)
    response = env.core.ask(request())
    assert (response["ok"], response["code"]) == (False, "RESTORE_ATTEMPT_CONSUMED")
    assert env.core.commands() == [] and env.core.client.published == []


def test_a_restore_without_an_open_incident_keeps_the_original_d4_behavior(env):
    assert env.core.ask(request())["code"] == "PUBLISHED"
    assert not any(row for row in db.fetch_all_logs() if row[5] is not None and row[3] == "RESTORE_REQUESTED")


def test_the_spent_attempt_survives_a_ui_close_and_a_core_restart(env, tmp_path, monkeypatch, credential):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    assert env.core.ask(request())["code"] == "PUBLISHED"
    audit_path = config.DB_PATH
    env.core.close()
    (tmp_path / "restart").mkdir()
    restarted = make_env(tmp_path / "restart", monkeypatch, credential, db_path=audit_path)
    try:
        assert db.get_open_incident()["id"] == incident_id
        response = restarted.core.ask(request())
        assert (response["ok"], response["code"]) == (False, "RESTORE_ATTEMPT_CONSUMED")
        assert restarted.core.commands() == []
        assert gates(op(restarted, rp.OP_RESTORE_STATUS))[rp.R4]["status"] == rp.VERIFIED
        # A fresh coordinator (UI reopen) has no memory of its own: the durable row is the only source.
        assert recovery_core.CoreRecoveryService(restarted.core.supervisor).restore_status()["ok"] is True
    finally:
        restarted.core.close()


def test_a_definitively_unsent_attempt_still_consumes_the_one_shot(env):
    env.service.bind_incident(IP)
    env.core.client.publish_rc = 1
    first = env.core.ask(request())
    assert first["ok"] is False and first["evidence"]["published"] == "NOT_PUBLISHED"
    env.core.client.publish_rc = 0
    second = env.core.ask(request())
    assert (second["ok"], second["code"]) == (False, "RESTORE_ATTEMPT_CONSUMED")
    assert env.core.client.published == [] or len(env.core.restores()) <= 1


# --------------------------------------------------------------------------- R5 evidence semantics


def test_r5_is_verified_only_for_a_correlated_accepted_ack_and_a_correlated_normal_status(env):
    env.service.bind_incident(IP)
    assert gates(op(env, rp.OP_RESTORE_STATUS))[rp.R5]["status"] == rp.PENDING
    msg_id, seq = run_restore_to_normal(env, ack=False, normal=False)
    assert gates(op(env, rp.OP_RESTORE_STATUS))[rp.R5]["status"] == rp.CHECKING
    env.core.deliver(p1.ACK, ack_for_msg_id=msg_id, ack_for_seq=seq, result="ACCEPTED")
    response = op(env, rp.OP_RESTORE_STATUS)
    assert gates(response)[rp.R5]["status"] == rp.CHECKING  # ACK without STATUS=NORMAL
    assert response["data"]["restore"]["executed"] == "NOT_OBSERVED"
    env.core.deliver(p1.STATUS, output_state="NORMAL", reason="COMMAND", cmd_msg_id=msg_id, cmd_seq=seq,
                     device_seq_hwm=seq)
    final = op(env, rp.OP_RESTORE_STATUS)
    assert gates(final)[rp.R5]["status"] == rp.VERIFIED
    assert final["data"]["restore"]["physical_evidence"] == "NOT_PROVEN"


def test_status_normal_for_the_wrong_command_is_not_verification(env):
    env.service.bind_incident(IP)
    _msg_id, seq = run_restore_to_normal(env, ack=True, normal=False)
    env.core.deliver(p1.STATUS, output_state="NORMAL", reason="COMMAND", cmd_msg_id=p1.new_msg_id(), cmd_seq=seq + 5,
                     device_seq_hwm=seq)
    response = op(env, rp.OP_RESTORE_STATUS)
    assert gates(response)[rp.R5]["status"] == rp.CHECKING
    assert response["data"]["restore"]["executed"] == "NOT_OBSERVED"


def test_a_rejected_ack_or_a_lockdown_report_fails_r5(env):
    env.service.bind_incident(IP)
    msg_id, seq = run_restore_to_normal(env, ack=False, normal=False)
    env.core.deliver(p1.ACK, ack_for_msg_id=msg_id, ack_for_seq=seq, result="REJECTED_EXPIRED")
    assert gates(op(env, rp.OP_RESTORE_STATUS))[rp.R5]["status"] == rp.FAILED


def test_a_core_restart_that_loses_the_physical_correlation_is_not_verified(env):
    env.service.bind_incident(IP)
    run_restore_to_normal(env)
    assert gates(op(env, rp.OP_RESTORE_STATUS))[rp.R5]["status"] == rp.VERIFIED
    env.core.supervisor.awaiting_physical_confirmation = None  # what a restarted supervisor remembers
    response = op(env, rp.OP_RESTORE_STATUS)
    assert gates(response)[rp.R5]["status"] == rp.FAILED
    assert response["data"]["restore"]["executed"] == "DEVICE_STATUS_CORRELATED"


def test_a_spent_attempt_without_linked_publication_evidence_fails_closed(env):
    incident_id = env.service.bind_incident(IP)["incident_id"]
    db.log_event_strict("RESTORE_REQUESTED", "audited then lost", db.CRITICAL, incident_id)
    assert gates(op(env, rp.OP_RESTORE_STATUS))[rp.R5]["status"] == rp.FAILED


# --------------------------------------------------------------------------- R2 / R6 / R7: Core-run probes


def full_chain(env):
    env.service.bind_incident(IP)
    assert op(env, rp.OP_ISOLATE)["ok"] is True
    run_restore_to_normal(env)


def test_probes_run_in_the_core_and_report_the_running_core_state(env):
    full_chain(env)
    response = op(env, rp.OP_PROBE)
    by_gate = gates(response)
    assert [by_gate[g]["status"] for g in (rp.R2, rp.R6, rp.R7)] == [rp.VERIFIED] * 3
    assert env.tcp_targets == ["192.0.2.10:22", "192.0.2.1:53", "192.0.2.10:22"]
    assert "mqtt=OK" in by_gate[rp.R7]["detail"] and "uplink_normal=OK" in by_gate[rp.R7]["detail"]


@pytest.mark.parametrize(
    "breaker",
    [
        lambda e: setattr(e.core.mqtt, "is_connected", False),
        lambda e: setattr(e.core.mqtt, "device_online", lambda: False),
        lambda e: setattr(e.core.supervisor.status, "dispatch", PAUSED_CREDENTIAL),
        lambda e: setattr(e, "web_ok", False),
        lambda e: setattr(e.core.supervisor.status, "uplink", "LOCKDOWN"),
    ],
)
def test_r7_reflects_the_real_core_broker_device_dispatch_and_web_state(env, breaker):
    full_chain(env)
    breaker(env)
    assert gates(op(env, rp.OP_PROBE))[rp.R7]["status"] == rp.FAILED


def test_r7_fails_when_the_core_database_check_fails(env, monkeypatch):
    full_chain(env)
    monkeypatch.setattr(db, "ping", lambda: False)
    assert gates(op(env, rp.OP_PROBE))[rp.R7]["status"] == rp.FAILED


def test_unset_probe_targets_are_not_configured_never_a_pass(env, monkeypatch):
    full_chain(env)
    monkeypatch.setattr(config, "RECOVERY_MANAGEMENT_PROBE_TARGET", "")
    monkeypatch.setattr(config, "RECOVERY_NETWORK_PROBE_TARGETS", "")
    by_gate = gates(op(env, rp.OP_PROBE))
    assert by_gate[rp.R2]["status"] == by_gate[rp.R6]["status"] == rp.NOT_CONFIGURED
    assert by_gate[rp.R7]["status"] == rp.PENDING


def test_r6_and_r7_wait_for_their_dependencies(env):
    env.service.bind_incident(IP)
    by_gate = gates(op(env, rp.OP_PROBE))
    assert by_gate[rp.R2]["status"] == rp.VERIFIED
    assert by_gate[rp.R6]["status"] == by_gate[rp.R7]["status"] == rp.PENDING


# --------------------------------------------------------------------------- R8: Core closure


def test_closure_is_refused_while_any_mandatory_gate_is_incomplete(env):
    env.service.bind_incident(IP)
    response = op(env, rp.OP_CLOSE, summary=SUMMARY)
    assert (response["ok"], response["code"]) == (False, "CLOSURE_REFUSED")
    assert rp.R3 in response["detail"] and rp.R5 in response["detail"]
    assert db.get_open_incident() is not None


def test_the_core_closes_only_after_re_checking_every_gate(env):
    env.service.bind_incident(IP)
    incident_id = db.get_open_incident()["id"]
    assert op(env, rp.OP_ISOLATE)["ok"] is True
    run_restore_to_normal(env)
    env.tcp_targets.clear()
    response = op(env, rp.OP_CLOSE, summary=SUMMARY)
    assert (response["ok"], response["code"]) == (True, "CLOSED")
    assert env.tcp_targets  # the Core re-ran the probes at closure; it did not trust a cached result
    assert db.get_open_incident() is None
    closed = next(row for row in db.fetch_incidents(10) if row["id"] == incident_id)
    assert closed["state"] == "CLOSED" and closed["summary"] == SUMMARY
    assert db.fetch_incident_events(incident_id, ("RECOVERY_R8_CLOSE",))
    assert db.fetch_incident_events(incident_id, ("INCIDENT_CLOSED",))


def test_closure_re_checks_isolation_against_the_live_containment_set(env):
    full_chain(env)
    env.containment.present = False
    response = op(env, rp.OP_CLOSE, summary=SUMMARY)
    assert response["code"] == "CLOSURE_REFUSED" and rp.R3 in response["detail"]
    assert db.get_open_incident() is not None


def test_the_ui_can_submit_only_bounded_text_and_cannot_fabricate_a_pass(env):
    env.service.bind_incident(IP)
    for forged in (
        {"summary": SUMMARY, "gates": [{"gate": rp.R5, "status": rp.VERIFIED}]},
        {"summary": SUMMARY, "force": True},
        {"summary": SUMMARY, "status": "VERIFIED"},
    ):
        assert op(env, rp.OP_CLOSE, **forged)["code"] == "MALFORMED_REQUEST"
    for bad in ("", "short", "x" * (rp.SUMMARY_MAX_CHARS + 1), "line\nbreak injected here", chr(0x202E) + SUMMARY, None, 7):
        assert op(env, rp.OP_CLOSE, summary=bad)["code"] in {"SUMMARY_REQUIRED", "SUMMARY_INVALID"}
    assert db.get_open_incident() is not None


def test_responses_carry_no_secret_and_no_pin(env):
    full_chain(env)
    blob = json.dumps([op(env, name) for name in (rp.OP_STATUS, rp.OP_PROBE, rp.OP_RESTORE_STATUS)])
    for needle in (SECRET, CONFIRM, REASON, "PIN", "password", "scrypt"):
        assert needle not in blob


def test_recovery_refuses_outside_a_production_core(tmp_path, monkeypatch, credential):
    dev = make_env(tmp_path, monkeypatch, credential, profile="development")
    try:
        assert op(dev, rp.OP_STATUS)["code"] == "NOT_PRODUCTION"
    finally:
        dev.core.close()


# --------------------------------------------------------------------------- the AF_UNIX interface


@pytest.fixture
def served(env):
    directory = Path(tempfile.mkdtemp(prefix="aegis-rc-"))
    servers = []

    def start(allowed_uid=None):
        server = recovery_core.RecoveryServer(
            directory / "recovery.sock", env.service, allowed_uid=os.geteuid() if allowed_uid is None else allowed_uid,
        )
        server.start()
        servers.append(server)
        return server

    env.directory = directory
    env.start = start
    yield env
    for server in servers:
        server.close()
    shutil.rmtree(directory, ignore_errors=True)


def raw_exchange(path, payload):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(5)
        connection.connect(str(path))
        connection.sendall(payload)
        return json.loads(connection.makefile("rb").readline())


def test_the_server_is_af_unix_only_and_answers_an_authorized_peer(served):
    server = served.start()
    assert server._listener.family == socket.AF_UNIX and server.family == socket.AF_UNIX
    assert (Path(server.path).stat().st_mode & 0o777) == 0o600
    reply = recovery_client.request(rp.OP_STATUS, path=str(server.path), expected_uid=os.geteuid())
    assert (reply["ok"], reply["code"]) == (True, "STATUS")


def test_an_unauthorized_peer_uid_is_rejected_without_a_state_change(served):
    server = served.start(allowed_uid=os.geteuid() + 1)
    reply = recovery_client.request(rp.OP_ISOLATE, path=str(server.path), expected_uid=os.geteuid())
    assert (reply["ok"], reply["code"]) == (False, "PEER_REFUSED")
    assert served.containment.calls == []


def test_the_client_refuses_a_server_that_is_not_the_core_account(served):
    server = served.start()
    with pytest.raises(recovery_client.RecoveryUnavailable):
        recovery_client.request(rp.OP_STATUS, path=str(server.path), expected_uid=os.geteuid() + 1)


def test_an_unreachable_socket_fails_closed(tmp_path):
    with pytest.raises(recovery_client.RecoveryUnavailable):
        recovery_client.request(rp.OP_STATUS, path=str(tmp_path / "missing.sock"), expected_uid=os.geteuid())


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        (b"x" * rp.MAX_MESSAGE_BYTES + b"\n", "MALFORMED_REQUEST"),  # oversize
        (b"{not json}\n", "MALFORMED_REQUEST"),
        (b"[]\n", "MALFORMED_REQUEST"),
        (json.dumps({"v": 2, "op": "STATUS"}).encode() + b"\n", "MALFORMED_REQUEST"),
        (json.dumps({"v": 1, "op": "RESTORE_UPLINK"}).encode() + b"\n", "UNKNOWN_OPERATION"),
        (json.dumps({"v": 1, "op": "status"}).encode() + b"\n", "UNKNOWN_OPERATION"),
        (json.dumps({"v": 1, "op": "ISOLATE", "ip": OTHER_IP}).encode() + b"\n", "MALFORMED_REQUEST"),
        (json.dumps({"v": 1, "op": "STATUS", "shell": "id"}).encode() + b"\n", "MALFORMED_REQUEST"),
    ],
)
def test_oversize_malformed_or_unknown_requests_are_refused(served, payload, code):
    server = served.start()
    reply = raw_exchange(server.path, payload)
    assert (reply["ok"], reply["code"]) == (False, code)
    assert served.containment.calls == [] and served.core.client.published == []


def test_the_socket_is_removed_on_close_and_never_replaces_a_non_socket(served, tmp_path):
    server = served.start()
    path = Path(server.path)
    server.close()
    assert not path.exists()
    regular = served.directory / "file.sock"
    regular.write_text("not a socket")
    with pytest.raises(recovery_core.RecoveryChannelError):
        recovery_core.RecoveryServer(regular, served.service, allowed_uid=os.geteuid()).start()


def test_the_supervisor_starts_the_channel_only_for_a_configured_production_core(env, monkeypatch):
    supervisor = env.core.supervisor
    supervisor.recovery = env.service
    monkeypatch.setattr(config, "RECOVERY_OPERATOR_UID", None)
    supervisor.start_recovery()
    assert supervisor.recovery_server is None
    directory = Path(tempfile.mkdtemp(prefix="aegis-rc-"))
    try:
        monkeypatch.setattr(config, "RECOVERY_OPERATOR_UID", os.geteuid())
        monkeypatch.setattr(config, "RECOVERY_SOCKET", str(directory / "recovery.sock"))
        supervisor.start_recovery()
        assert supervisor.recovery_server is not None
        assert recovery_client.request(rp.OP_STATUS, path=str(directory / "recovery.sock"), expected_uid=os.geteuid())["ok"]
        supervisor.stop_recovery()
        assert supervisor.recovery_server is None
    finally:
        supervisor.stop_recovery()
        shutil.rmtree(directory, ignore_errors=True)


# --------------------------------------------------------------------------- the observer UI


def test_the_ui_fails_closed_when_the_channel_is_unavailable(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv(recovery_client.SOCKET_ENV, str(tmp_path / "missing.sock"))
    monkeypatch.setenv(recovery_client.CORE_USER_ENV, "root")
    assert recovery_ui.main(["--once"]) == 3
    assert "fail closed" in capsys.readouterr().out
    assert list(tmp_path.iterdir()) == []  # no repo-local database or file fallback


def test_the_ui_renders_only_core_supplied_safe_evidence(served):
    served.service.bind_incident(IP)
    server = served.start()
    lines = []
    code = recovery_ui.run_once(
        request=lambda op_name, summary=None: recovery_client.request(
            op_name, summary=summary, path=str(server.path), expected_uid=os.geteuid()),
        out=lines.append,
    )
    assert code == 0
    text = "\n".join(lines)
    assert f"attacker_ip={IP}" in text and rp.R3 in text and SECRET not in text


def test_the_ui_offers_no_restore_action():
    source = inspect.getsource(recovery_ui)
    assert "OP_RESTORE_STATUS" in source and "RESTORE_UPLINK" not in source and "authorize" not in source.lower()
    assert "aegisctl restore" in recovery_ui.RESTORE_NOTE


def test_the_module_entrypoint_runs_without_the_legacy_gui():
    result = subprocess.run(
        [sys.executable, "-m", "aegis_soc.recovery_ui", "--help"], cwd=ROOT, capture_output=True, text=True, timeout=30, check=False,
    )
    assert result.returncode == 0 and "Core-mediated Recovery" in result.stdout
