"""Core-local manual CUT channel: the Desktop operator's only route to a real CUT, always through the supervisor.

Hermetic: a real supervisor, Protocol v1 store, MQTT adapter and CUT gate over temporary storage; only paho is a fake.
Nothing here touches a broker, a device, GPIO, or a relay.
"""

from __future__ import annotations

import inspect
import os
import stat
import threading
from pathlib import Path

import pytest
from test_local_restore import Core, p1

from aegis_soc import config, local_cut
from aegis_soc import database as db
from aegis_soc import local_restore as lr
from aegis_soc import supervisor as supervisor_module
from aegis_soc.controller import CUT_UPLINK, RESTORE_UPLINK

REASON = "attacker confirmed on the LAN; isolate now"
MY_UID = os.geteuid()


@pytest.fixture
def core(tmp_path):
    instance = Core(tmp_path, credential=None)
    instance.supervisor.status.uplink = "NORMAL"
    instance.cut_gate = local_cut.LocalCutGate(
        instance.supervisor, allowed_uid=MY_UID, audit=instance.audit.log, audit_strict=instance.audit.append,
    )
    yield instance
    instance.supervisor.stop_local_cut()
    instance.close()


def cut(core, **changes):
    body = local_cut.cut_request(REASON)
    body.update(changes)
    return core.cut_gate.handle(body, core.peer)


def cuts(core):
    return [command for command in core.commands() if command.fields["action"] == CUT_UPLINK]


def enable(monkeypatch, core, *, uid=MY_UID, gid=None, name="cut.sock"):
    monkeypatch.setattr(config, "LOCAL_CUT_ENABLED", "YES")
    monkeypatch.setattr(config, "LOCAL_CUT_OPERATOR_UID", uid)
    monkeypatch.setattr(config, "LOCAL_CUT_SOCKET_GID", gid)
    monkeypatch.setattr(config, "LOCAL_CUT_SOCKET", str(core.runtime_dir / name))
    # The supervisor wires the real audit writers; keep the global audit database out of the hermetic tests.
    monkeypatch.setattr(db, "log_event", core.audit.log)
    monkeypatch.setattr(db, "log_event_strict", core.audit.append)
    return core.runtime_dir / name


# ---- authorization, validation, no actuation on refusal -------------------------------------------------------------------
@pytest.mark.parametrize(
    "changes,code",
    [
        ({"confirmation": "cut uplink"}, "CONFIRMATION_REQUIRED"),
        ({"confirmation": ""}, "CONFIRMATION_REQUIRED"),
        ({"origin": "telegram"}, "ORIGIN_REFUSED"),
        ({"origin": "gui"}, "ORIGIN_REFUSED"),
        ({"origin": "aegisctl-local"}, "ORIGIN_REFUSED"),
        ({"reason": ""}, "REASON_REQUIRED"),
        ({"reason": "short"}, "REASON_INVALID"),
        ({"reason": "x" * 500}, "REASON_INVALID"),
        ({"reason": "bidi ‮ override attack"}, "REASON_INVALID"),
        ({"reason": "surrogate \ud800 attack text"}, "REASON_INVALID"),
        ({"op": RESTORE_UPLINK}, "MALFORMED_REQUEST"),
        ({"v": 2}, "MALFORMED_REQUEST"),
        ({"extra": 1}, "MALFORMED_REQUEST"),
    ],
)
def test_an_invalid_request_is_refused_and_nothing_is_published(core, changes, code):
    response = cut(core, **changes)
    assert response["ok"] is False
    assert response["code"] == code
    assert response["evidence"]["published"] == "NOT_PUBLISHED"
    assert core.commands() == []
    assert core.audit.strict == []


@pytest.mark.parametrize("body", [None, [], "CUT_UPLINK", 7, {}, {"op": CUT_UPLINK}])
def test_a_non_object_or_partial_body_is_refused(core, body):
    assert core.cut_gate.handle(body, core.peer)["code"] == "MALFORMED_REQUEST"
    assert core.commands() == []


@pytest.mark.parametrize("uid", [MY_UID + 1, 0, -1])
def test_a_peer_that_is_not_the_configured_operator_is_refused(core, uid):
    response = core.cut_gate.handle(local_cut.cut_request(REASON), lr.Peer(uid=uid, pid=1))
    assert response["code"] == "PEER_REFUSED"
    assert core.commands() == [] and core.audit.strict == []


def test_the_operator_uid_is_not_assumed_to_be_the_core_uid(core):
    other = local_cut.LocalCutGate(core.supervisor, allowed_uid=MY_UID + 1000, audit=core.audit.log,
                                   audit_strict=core.audit.append)
    assert other.handle(local_cut.cut_request(REASON), core.peer)["code"] == "PEER_REFUSED"
    allowed = other.handle(local_cut.cut_request(REASON), lr.Peer(uid=MY_UID + 1000, pid=9))
    assert allowed["code"] == "CUT_PUBLISHED"


# ---- durable audit --------------------------------------------------------------------------------------------------------
def test_a_valid_request_is_durably_audited_before_it_is_published(core):
    response = cut(core)
    assert response["ok"] is True and response["code"] == "CUT_PUBLISHED"
    [(event, details, _level, published_before)] = core.audit.strict
    assert event == "CUT_REQUESTED" and REASON in details
    assert published_before == 0  # the durable row committed before any frame was published
    [command] = cuts(core)
    assert command.fields["msg_id"] == response["msg_id"]


def test_an_unavailable_audit_store_refuses_explicitly_and_publishes_nothing(core):
    core.audit.fail_strict = True
    response = cut(core)
    assert response["ok"] is False
    assert response["code"] == "AUDIT_UNAVAILABLE"
    assert response["evidence"]["published"] == "NOT_PUBLISHED"
    assert core.commands() == []
    assert core.supervisor.pending_command is None
    core.audit.fail_strict = False
    assert cut(core)["code"] == "CUT_PUBLISHED"  # a later request is not poisoned


def test_a_refusal_never_depends_on_the_audit_store(core):
    def broken(*_a, **_k):
        raise OSError("audit disk full")

    core.cut_gate.audit = broken
    assert cut(core, confirmation="no")["code"] == "CONFIRMATION_REQUIRED"


# ---- supervisor-owned lifecycle -------------------------------------------------------------------------------------------
def test_a_valid_request_goes_through_the_supervisor_command_boundary(core):
    response = cut(core)
    assert response["evidence"] == {
        "requested": "ACCEPTED", "published": "PUBLISHED", "ack": "PENDING", "executed": "NOT_PROVEN",
        "relay_confirmation": "NOT_AVAILABLE", "physical_evidence": "NOT_PROVEN",
    }
    assert core.supervisor.pending_command["action"] == CUT_UPLINK
    assert core.supervisor.pending_command["nonce"] == response["msg_id"]


def test_a_second_cut_while_one_awaits_its_ack_is_not_published(core):
    assert cut(core)["ok"] is True
    again = cut(core)
    assert again["ok"] is False and again["code"] == "COMMAND_PENDING"
    assert len(cuts(core)) == 1


def test_concurrent_requests_publish_exactly_one_command(core):
    results = []

    def fire():
        results.append(cut(core)["code"])

    threads = [threading.Thread(target=fire) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results.count("CUT_PUBLISHED") == 1
    assert results.count("COMMAND_PENDING") == 7
    assert len(cuts(core)) == 1


def test_an_untrusted_core_clock_publishes_nothing(core):
    core.clock.current = "UNSYNCED"
    response = cut(core)
    assert response["ok"] is False and response["code"] == "CORE_TIME_UNTRUSTED"
    assert core.commands() == []


def test_a_disconnected_broker_reports_not_published(core):
    core.mqtt.is_connected = False
    response = cut(core)
    assert response["ok"] is False
    assert response["evidence"]["published"] == "NOT_PUBLISHED"
    assert core.commands() == []


def test_a_closing_channel_refuses(core):
    core.cut_gate.disable()
    assert cut(core)["code"] == "CHANNEL_CLOSING"
    assert core.commands() == []


def test_evidence_reports_protocol_state_truthfully_and_never_physical(core):
    published = cut(core)
    reply = core.cut_gate.handle(local_cut.evidence_request(published["msg_id"]), core.peer)
    assert reply["ok"] is True and reply["code"] == "EVIDENCE"
    assert reply["evidence"]["published"] == "PUBLISHED"
    assert reply["evidence"]["ack"] == "PENDING"
    assert reply["evidence"]["executed"] == "NOT_OBSERVED"
    assert reply["evidence"]["physical_evidence"] == "NOT_PROVEN"


@pytest.mark.parametrize("msg_id", ["", "zz" * 16, "0" * 31, "0" * 32, 7, None])
def test_evidence_for_an_unknown_or_malformed_identifier_is_refused(core, msg_id):
    reply = core.cut_gate.handle(local_cut.evidence_request(msg_id), core.peer)
    assert reply["ok"] is False and reply["code"] in {"MALFORMED_REQUEST", "UNKNOWN_COMMAND"}


def test_evidence_is_refused_for_a_peer_that_is_not_the_operator(core):
    published = cut(core)
    reply = core.cut_gate.handle(local_cut.evidence_request(published["msg_id"]), lr.Peer(uid=MY_UID + 1, pid=1))
    assert reply["code"] == "PEER_REFUSED"


# ---- socket security ------------------------------------------------------------------------------------------------------
def test_the_channel_is_inert_unless_everything_is_explicitly_configured(core, monkeypatch):
    path = enable(monkeypatch, core)
    for flag in ("", "yes", "1", "true", " YES", "YES "):
        monkeypatch.setattr(config, "LOCAL_CUT_ENABLED", flag)
        core.supervisor.start_local_cut()
        assert core.supervisor.local_cut is None and not path.exists()
    monkeypatch.setattr(config, "LOCAL_CUT_ENABLED", "YES")
    for name, value in (("LOCAL_CUT_OPERATOR_UID", None), ("LOCAL_CUT_OPERATOR_UID", 0), ("LOCAL_CUT_SOCKET", "")):
        original = getattr(config, name)
        monkeypatch.setattr(config, name, value)
        core.supervisor.start_local_cut()
        assert core.supervisor.local_cut is None and not path.exists()
        monkeypatch.setattr(config, name, original)


def test_the_default_configuration_is_disabled():
    assert config.LOCAL_CUT_ENABLED == ""
    assert local_cut.controller_from_environment({}) is None
    assert local_cut.controller_from_environment({"AEGIS_LOCAL_CUT_ENABLED": "YES"}) is None
    assert local_cut.controller_from_environment(
        {"AEGIS_LOCAL_CUT_ENABLED": "YES", "AEGIS_LOCAL_CUT_SOCKET": "relative.sock"}) is None
    assert local_cut.controller_from_environment({"AEGIS_LOCAL_CUT_SOCKET": "/run/x/cut.sock"}) is None
    assert local_cut.controller_from_environment(
        {"AEGIS_LOCAL_CUT_ENABLED": "YES", "AEGIS_LOCAL_CUT_SOCKET": "/run/x/cut.sock"}) is not None


def test_the_socket_is_private_by_default_and_group_only_when_a_gid_is_configured(core, monkeypatch):
    path = enable(monkeypatch, core)
    core.supervisor.start_local_cut()
    assert stat.S_IMODE(path.lstat().st_mode) == 0o600
    core.supervisor.stop_local_cut()
    assert not path.exists()
    path = enable(monkeypatch, core, gid=os.getegid())
    core.supervisor.start_local_cut()
    mode = stat.S_IMODE(path.lstat().st_mode)
    assert mode == 0o660 and not mode & 0o007
    assert local_cut.socket_is_group_reachable_only(path)


def test_a_missing_socket_directory_is_never_created(core, monkeypatch):
    monkeypatch.setattr(config, "LOCAL_CUT_ENABLED", "YES")
    monkeypatch.setattr(config, "LOCAL_CUT_OPERATOR_UID", MY_UID)
    monkeypatch.setattr(config, "LOCAL_CUT_SOCKET", str(core.runtime_dir / "absent-dir" / "cut.sock"))
    core.supervisor.start_local_cut()
    assert core.supervisor.local_cut is None
    assert not (core.runtime_dir / "absent-dir").exists()


def test_a_group_or_world_writable_directory_is_refused(core, monkeypatch):
    path = enable(monkeypatch, core)
    os.chmod(core.runtime_dir, 0o770)
    core.supervisor.start_local_cut()
    assert core.supervisor.local_cut is None and not path.exists()


def test_a_relative_socket_path_is_refused():
    gate = object()
    with pytest.raises(lr.LocalRestoreError):
        local_cut.LocalCutServer("relative/cut.sock", gate)


def test_a_non_socket_at_the_path_is_never_replaced(core, monkeypatch):
    path = enable(monkeypatch, core)
    path.write_text("not a socket")
    core.supervisor.start_local_cut()
    assert core.supervisor.local_cut is None
    assert path.read_text() == "not a socket"


def test_the_desktop_controller_reaches_a_real_cut_over_the_core_socket(core, monkeypatch):
    path = enable(monkeypatch, core)
    core.supervisor.start_local_cut()
    controller = local_cut.LocalCutController(path, core_uid=MY_UID)
    result = controller.issue(CUT_UPLINK, REASON, critical=True, origin="gui")
    assert result.ok and result.sent and result.nonce
    assert [c.fields["msg_id"] for c in cuts(core)] == [result.nonce]
    again = controller.issue(CUT_UPLINK, REASON)
    assert not again.ok and again.reason_code == "COMMAND_PENDING" and len(cuts(core)) == 1
    assert controller.evidence(result.nonce)["evidence"]["ack"] == "PENDING"
    core.supervisor.stop_local_cut()
    assert not path.exists()


def test_a_server_that_is_not_the_core_account_is_refused_by_the_client(core, monkeypatch):
    path = enable(monkeypatch, core)
    core.supervisor.start_local_cut()
    impostor = local_cut.LocalCutController(path, core_uid=MY_UID + 1)
    result = impostor.issue(CUT_UPLINK, REASON)
    assert not result.ok and not result.sent and result.reason_code == "CHANNEL_UNAVAILABLE"
    assert core.commands() == []


def test_a_socket_peer_that_is_not_the_operator_is_refused_over_a_real_socket(core, monkeypatch):
    path = enable(monkeypatch, core, uid=MY_UID + 1)
    core.supervisor.start_local_cut()
    result = local_cut.LocalCutController(path, core_uid=MY_UID).issue(CUT_UPLINK, REASON)
    assert not result.ok and result.reason_code == "PEER_REFUSED"
    assert core.commands() == []


# ---- the Desktop controller is never a RESTORE or heartbeat authority ------------------------------------------------------
def test_the_desktop_controller_can_never_restore_or_heartbeat(core):
    sent = []
    controller = local_cut.LocalCutController(
        core.runtime_dir / "none.sock", core_uid=MY_UID, send=lambda *a, **k: sent.append(a),
    )
    result = controller.issue(RESTORE_UPLINK, "restore", authorize_restore=True)
    assert result.reason_code == "RESTORE_NOT_AVAILABLE" and not result.sent and not result.ok
    assert controller.send_heartbeat() is False
    assert sent == []
    with pytest.raises(ValueError):
        controller.issue("REBOOT", "x")


def test_the_cut_channel_cannot_carry_restore(core):
    for body in (
        {**local_cut.cut_request(REASON), "op": RESTORE_UPLINK},
        {"v": 1, "op": RESTORE_UPLINK, "origin": lr.LOCAL_REQUEST_ORIGIN, "secret": "x", "confirmation": lr.CONFIRMATION,
         "reason": REASON},
    ):
        assert core.cut_gate.handle(body, core.peer)["ok"] is False
    assert core.commands() == []


def test_an_unreachable_core_is_reported_not_assumed(core):
    controller = local_cut.LocalCutController(core.runtime_dir / "absent.sock", core_uid=MY_UID)
    result = controller.issue(CUT_UPLINK, REASON)
    assert not result.ok and not result.sent and result.reason_code == "CHANNEL_UNAVAILABLE"


def test_a_lost_reply_is_outcome_unknown_and_never_retried(core):
    calls = []

    def lost(*_args, **_kwargs):
        calls.append(1)
        raise lr.OutcomeUnknown("the local result was lost; do not retry automatically")

    controller = local_cut.LocalCutController(core.runtime_dir / "x.sock", core_uid=MY_UID, send=lost)
    result = controller.issue(CUT_UPLINK, REASON)
    assert result.reason_code == "OUTCOME_UNKNOWN" and not result.sent and not result.ok
    assert calls == [1]


# ---- architecture guards --------------------------------------------------------------------------------------------------
def test_the_cut_module_has_no_direct_mqtt_or_relay_path():
    source = inspect.getsource(local_cut)
    for forbidden in ("publish(", "MQTTManager", "paho", "gpio", "GPIO"):
        assert forbidden not in source, forbidden
    assert "issue_command" in source
    assert "RESTORE_UPLINK" in source and "authorize_restore=True" not in source


def test_the_supervisor_wires_the_gate_with_the_strict_audit_writer():
    # Read the file, not inspect.getsource: other suites replace classes, which makes getsource order-dependent.
    text = Path(supervisor_module.__file__).read_text(encoding="utf-8")
    source = text.split("def start_local_cut", 1)[1].split("def stop_local_cut", 1)[0]
    assert "audit_strict=db.log_event_strict" in source
    assert "allowed_uid=operator_uid" in source and "geteuid" not in source


def test_the_existing_restore_evidence_ladder_is_unchanged_for_restore(core):
    assert lr.restore_evidence_ladder(core.supervisor, "0" * 32) is None
    published = cut(core)
    # A CUT identifier is not RESTORE evidence, and a RESTORE identifier is not CUT evidence.
    assert lr.restore_evidence_ladder(core.supervisor, published["msg_id"]) is None
    assert lr.restore_evidence_ladder(core.supervisor, published["msg_id"], action=CUT_UPLINK) is not None
    assert p1 is not None
