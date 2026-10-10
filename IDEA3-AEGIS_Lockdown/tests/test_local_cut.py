"""Core-local manual CUT channel: the Desktop operator's only route to a real CUT, always through the supervisor.

Hermetic: a real supervisor, Protocol v1 store, MQTT adapter and CUT gate over temporary storage; only paho is a fake.
Nothing here touches a broker, a device, GPIO, or a relay. Distinct-uid/gid behavior lives in test_local_cut_identities.py.
"""

from __future__ import annotations

import ast
import json
import os
import socket
import stat
import threading
import time
from pathlib import Path

import pytest
from test_local_restore import Core, p1

from aegis_soc import config, local_cut
from aegis_soc import database as db
from aegis_soc import local_restore as lr
from aegis_soc import supervisor as supervisor_module
from aegis_soc.controller import CUT_UPLINK, RESTORE_UPLINK

REASON = "attacker confirmed on the LAN; isolate now"
SECRET = "a long per-cut operator secret 7731"
MY_UID = os.geteuid()


@pytest.fixture(scope="module")
def credential():
    return lr.RestoreCredential.parse(local_cut.hash_cut_secret(SECRET))


@pytest.fixture
def core(tmp_path, credential):
    instance = Core(tmp_path, credential=None)
    instance.supervisor.status.uplink = "NORMAL"
    instance.clock_now = [1000.0]
    instance.cut_gate = local_cut.LocalCutGate(
        instance.supervisor, allowed_uid=MY_UID, credential=credential, audit=instance.audit.log,
        audit_strict=instance.audit.append, monotonic=lambda: instance.clock_now[0],
    )
    yield instance
    instance.supervisor.stop_local_cut()
    instance.close()


def cut(core, **changes):
    body = local_cut.cut_request(REASON, SECRET)
    body.update(changes)
    return core.cut_gate.handle(body, core.peer)


def cut_without(core, key):
    body = local_cut.cut_request(REASON, SECRET)
    body.pop(key)
    return core.cut_gate.handle(body, core.peer)


def cuts(core):
    return [command for command in core.commands() if command.fields["action"] == CUT_UPLINK]


def pre_dispatch_rows(core):
    return [row for row in core.audit.strict if row[0] == "CUT_PRE_DISPATCH"]


def enable(monkeypatch, core, tmp_path, *, uid=MY_UID, gid=None, name="cut.sock", secret=SECRET):
    cred = tmp_path / "cut.cred"
    if not cred.exists():
        local_cut.write_cut_credential(cred, secret)
    monkeypatch.setattr(config, "LOCAL_CUT_ENABLED", "YES")
    monkeypatch.setattr(config, "LOCAL_CUT_OPERATOR_UID", uid)
    monkeypatch.setattr(config, "LOCAL_CUT_SOCKET_GID", gid)
    monkeypatch.setattr(config, "LOCAL_CUT_SOCKET", str(core.runtime_dir / name))
    monkeypatch.setattr(config, "LOCAL_CUT_CREDENTIAL_FILE", str(cred))
    monkeypatch.setattr(config, "RESTORE_CREDENTIAL_FILE", "")
    # The supervisor wires the real audit writers; keep the global audit database out of the hermetic tests.
    monkeypatch.setattr(db, "log_event", core.audit.log)
    monkeypatch.setattr(db, "log_event_strict", core.audit.append)
    return core.runtime_dir / name


def provider(secret=SECRET, calls=None):
    def ask():
        if calls is not None:
            calls.append(1)
        return secret
    return ask


# ---- validation: nothing is published on a refusal ----------------------------------------------------------------------
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
    response = core.cut_gate.handle(local_cut.cut_request(REASON, SECRET), lr.Peer(uid=uid, pid=1))
    assert response["code"] == "PEER_REFUSED"
    assert core.commands() == [] and core.audit.strict == []


# ---- I1: Core-verified per-CUT authentication ---------------------------------------------------------------------------
def test_the_correct_uid_without_a_credential_is_refused(core):
    response = cut_without(core, "secret")
    assert response["code"] == "MALFORMED_REQUEST"  # the contract requires the key
    for missing in ("", None, 7, ["x"], "s" * 300):
        refused = cut(core, secret=missing)
        assert refused["ok"] is False and refused["code"] == "AUTH_REQUIRED"
    assert core.commands() == [] and core.audit.strict == []


def test_a_wrong_credential_is_refused_and_publishes_nothing(core):
    response = cut(core, secret="not the operator secret at all")
    assert response["ok"] is False and response["code"] == "AUTH_FAILED"
    assert core.commands() == [] and core.audit.strict == []


def test_the_correct_credential_from_the_wrong_uid_is_refused(core):
    response = core.cut_gate.handle(local_cut.cut_request(REASON, SECRET), lr.Peer(uid=MY_UID + 1, pid=1))
    assert response["code"] == "PEER_REFUSED"
    assert core.commands() == []


def test_repeated_wrong_credentials_lock_out_even_the_correct_secret(core):
    for _ in range(lr.MAX_AUTH_FAILURES):
        assert cut(core, secret="wrong wrong wrong wrong")["code"] == "AUTH_FAILED"
    locked = cut(core)
    assert locked["code"] == "AUTH_LOCKED_OUT" and core.commands() == []
    core.clock_now[0] += lr.AUTH_LOCKOUT_SEC - 1
    assert cut(core)["code"] == "AUTH_LOCKED_OUT"
    core.clock_now[0] += 2
    assert cut(core)["code"] == "CUT_PUBLISHED"
    assert len(cuts(core)) == 1


def test_a_success_resets_the_failure_counter(core):
    for _ in range(lr.MAX_AUTH_FAILURES - 1):
        assert cut(core, secret="wrong wrong wrong wrong")["code"] == "AUTH_FAILED"
    assert cut(core)["code"] == "CUT_PUBLISHED"
    core.supervisor.pending_command = None
    for _ in range(lr.MAX_AUTH_FAILURES - 1):
        assert cut(core, secret="wrong wrong wrong wrong")["code"] == "AUTH_FAILED"
    assert cut(core, secret="wrong wrong wrong wrong")["code"] == "AUTH_FAILED"  # third failure only now


def test_a_d4_restore_credential_can_never_authenticate_a_cut(core):
    restore_style = lr.RestoreCredential.parse(lr.hash_secret(SECRET, n=lr.SCRYPT_MIN_N))
    gate = local_cut.LocalCutGate(core.supervisor, allowed_uid=MY_UID, credential=restore_style,
                                  audit=core.audit.log, audit_strict=core.audit.append)
    response = gate.handle(local_cut.cut_request(REASON, SECRET), core.peer)
    assert response["code"] == "AUTH_FAILED" and core.commands() == []


def test_the_credential_secret_is_never_logged_audited_or_returned(core, caplog):
    caplog.set_level("DEBUG")
    wrong = "this-is-a-wrong-secret-12345"
    responses = [cut(core, secret=wrong), cut(core), cut(core), cut(core, secret=wrong)]
    haystack = json.dumps(responses) + repr(core.audit.events) + repr(core.audit.strict) + caplog.text
    assert SECRET not in haystack and wrong not in haystack and local_cut.CREDENTIAL_DOMAIN not in haystack


def test_no_credential_is_cached_across_cuts(core):
    first = cut(core)
    assert first["code"] == "CUT_PUBLISHED"
    core.supervisor.pending_command = None
    # A new request must carry its own secret; nothing from the first request authorizes it.
    assert cut(core, secret="")["code"] == "AUTH_REQUIRED"
    assert len(cuts(core)) == 1


def test_the_controller_asks_the_human_for_every_cut_and_never_caches(core):
    asked = []
    sent = []

    def fake_send(path, body, *, expected_uid):
        sent.append(body)
        return {"ok": False, "code": "COMMAND_PENDING", "detail": "pending", "msg_id": None}

    controller = local_cut.LocalCutController(
        core.runtime_dir / "x.sock", core_uid=MY_UID, send=fake_send, secret_provider=provider(calls=asked),
    )
    controller.issue(CUT_UPLINK, REASON)
    controller.issue(CUT_UPLINK, REASON)
    assert len(asked) == 2 and [body["secret"] for body in sent] == [SECRET, SECRET]
    assert not hasattr(controller, "secret") and SECRET not in repr(vars(controller))


@pytest.mark.parametrize("answer", [None, "", 5])
def test_the_controller_refuses_locally_without_an_operator_secret(core, answer):
    sent = []
    controller = local_cut.LocalCutController(
        core.runtime_dir / "x.sock", core_uid=MY_UID, send=lambda *a, **k: sent.append(a), secret_provider=lambda: answer,
    )
    result = controller.issue(CUT_UPLINK, REASON)
    assert not result.ok and not result.sent and result.reason_code == "AUTH_REQUIRED" and sent == []
    no_provider = local_cut.LocalCutController(core.runtime_dir / "x.sock", core_uid=MY_UID, send=lambda *a, **k: sent.append(a))
    assert no_provider.issue(CUT_UPLINK, REASON).reason_code == "AUTH_REQUIRED" and sent == []


def test_credential_provisioning_enforces_a_minimum_and_domain(tmp_path):
    with pytest.raises(ValueError):
        local_cut.hash_cut_secret("short")
    with pytest.raises(ValueError):
        local_cut.write_cut_credential(tmp_path / "c", "short")
    path = tmp_path / "ok.cred"
    local_cut.write_cut_credential(path, SECRET)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    loaded = lr.RestoreCredential.load(path)
    assert loaded.verify(local_cut.domain_secret(SECRET)) and not loaded.verify(SECRET)


# ---- I2: atomic pending check + strict pre-dispatch audit + publish ---------------------------------------------------
def test_a_dispatched_cut_has_exactly_one_durable_row_written_before_the_publish(core):
    response = cut(core)
    assert response["ok"] is True and response["code"] == "CUT_PUBLISHED"
    [(event, details, _level, published_before)] = pre_dispatch_rows(core)
    assert event == "CUT_PRE_DISPATCH" and published_before == 0
    assert f"msg_id={response['msg_id']}" in details and f"seq={response['seq']}" in details and REASON in details
    [command] = cuts(core)
    assert command.fields["msg_id"] == response["msg_id"]


def test_refused_pending_requests_create_no_pre_dispatch_rows(core):
    assert cut(core)["code"] == "CUT_PUBLISHED"
    for _ in range(25):
        again = cut(core)
        assert again["ok"] is False and again["code"] == "COMMAND_PENDING"
    assert len(pre_dispatch_rows(core)) == 1 and len(cuts(core)) == 1


def test_an_unavailable_audit_store_prevents_publication_and_is_explicit(core):
    core.audit.fail_strict = True
    response = cut(core)
    assert response["ok"] is False and response["code"] == "AUDIT_UNAVAILABLE"
    assert response["evidence"]["published"] == "NOT_PUBLISHED"
    assert core.commands() == [] and core.supervisor.pending_command is None
    core.audit.fail_strict = False
    assert cut(core)["code"] == "CUT_PUBLISHED"
    assert len(pre_dispatch_rows(core)) == 1 and len(cuts(core)) == 1


def test_concurrent_requests_publish_one_command_with_one_row(core):
    results = []
    barrier = threading.Barrier(8)

    def fire():
        barrier.wait()
        results.append(cut(core)["code"])

    threads = [threading.Thread(target=fire) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results.count("CUT_PUBLISHED") == 1 and results.count("COMMAND_PENDING") == 7
    assert len(cuts(core)) == 1 and len(pre_dispatch_rows(core)) == 1


def test_the_pre_dispatch_audit_runs_inside_the_supervisor_command_lock(core):
    observed = []

    def hook(info):
        result = []
        probe = threading.Thread(target=lambda: result.append(core.supervisor._command_lock.acquire(blocking=False)))
        probe.start()
        probe.join()
        observed.append((result[0], len(core.client.published)))

    result = core.supervisor.issue_command(CUT_UPLINK, "x", critical=True, origin="test", pre_publish=hook)
    assert result.sent
    assert observed == [(False, 0)]  # another thread cannot take the lock while the hook runs; nothing published yet


def test_the_hook_does_not_run_when_the_supervisor_refuses(core):
    ran = []
    core.supervisor.pending_command = {"action": CUT_UPLINK, "sent_at": 0, "nonce": "n" * 32}
    refused = core.supervisor.issue_command(CUT_UPLINK, "x", origin="test", pre_publish=lambda i: ran.append(i))
    assert refused.reason_code == "COMMAND_PENDING" and ran == []
    core.supervisor.pending_command = None
    core.clock.current = "UNSYNCED"
    untrusted = core.supervisor.issue_command(CUT_UPLINK, "x", origin="test", pre_publish=lambda i: ran.append(i))
    assert untrusted.reason_code == "CORE_TIME_UNTRUSTED" and ran == []


def test_a_cut_deferred_behind_a_restore_gets_its_row_only_when_it_is_actually_dispatched(core):
    core.supervisor.pending_command = {"action": RESTORE_UPLINK, "sent_at": 0, "nonce": "r" * 32}
    queued = cut(core)
    assert queued["code"] == "CUT_QUEUED" and queued["ok"] is True
    assert pre_dispatch_rows(core) == [] and core.commands() == []
    with core.supervisor._command_lock:
        core.supervisor.pending_command = None
        core.supervisor._drain_deferred_cut_locked()
    assert len(cuts(core)) == 1 and len(pre_dispatch_rows(core)) == 1


def test_a_dry_run_command_writes_no_pre_dispatch_row(core):
    core.supervisor.controller.dry_run = True
    response = cut(core)
    assert response["code"] == "CUT_DRY_RUN" and pre_dispatch_rows(core) == [] and core.commands() == []


def test_restore_protection_is_unchanged_by_the_hook(core):
    # RESTORE is refused while a CUT awaits ACK, exactly as before, and a hook never runs for a refused RESTORE.
    ran = []
    assert cut(core)["code"] == "CUT_PUBLISHED"
    refused = core.supervisor.issue_command(
        RESTORE_UPLINK, "r", origin="x", authorize_restore=True, pre_publish=lambda i: ran.append(i),
    )
    assert refused.ok is False and ran == []
    assert [c.fields["action"] for c in core.commands()] == [CUT_UPLINK]


def test_the_controller_hook_failure_marks_the_reserved_command_unpublished(core):
    def boom(_info):
        raise OSError("disk full")

    result = core.supervisor.issue_command(CUT_UPLINK, "x", critical=True, origin="test", pre_publish=boom)
    assert result.reason_code == "AUDIT_UNAVAILABLE" and not result.sent
    assert core.commands() == [] and core.supervisor.pending_command is None


def test_a_flood_of_refusals_is_rate_limited_in_the_audit_chain(core):
    for _ in range(200):
        cut(core, secret="wrong wrong wrong wrong")
    for _ in range(200):
        core.cut_gate.handle(local_cut.cut_request(REASON, SECRET), lr.Peer(uid=MY_UID + 1, pid=4))
    refusal_rows = [e for e in core.audit.events if e[0] == "CUT_REFUSED"]
    assert 1 <= len(refusal_rows) <= 6  # one per (code, uid) per interval, never one per request
    core.clock_now[0] += local_cut.REFUSAL_AUDIT_INTERVAL_SEC + 1
    cut(core, secret="wrong wrong wrong wrong")
    assert any("suppressed_since_last=" in e[1] and "suppressed_since_last=0" not in e[1] for e in core.audit.events)


# ---- lifecycle and evidence -----------------------------------------------------------------------------------------------
def test_a_valid_request_goes_through_the_supervisor_command_boundary(core):
    response = cut(core)
    assert response["evidence"] == {
        "requested": "ACCEPTED", "published": "PUBLISHED", "ack": "PENDING", "executed": "NOT_OBSERVED",
        "relay_confirmation": "NOT_AVAILABLE", "physical_evidence": "NOT_PROVEN",
    }
    assert core.supervisor.pending_command["action"] == CUT_UPLINK
    assert core.supervisor.pending_command["nonce"] == response["msg_id"]


def test_an_untrusted_core_clock_publishes_nothing(core):
    core.clock.current = "UNSYNCED"
    response = cut(core)
    assert response["ok"] is False and response["code"] == "CORE_TIME_UNTRUSTED"
    assert core.commands() == [] and pre_dispatch_rows(core) == []


def test_a_disconnected_broker_reports_not_published(core):
    core.mqtt.is_connected = False
    response = cut(core)
    assert response["ok"] is False and response["evidence"]["published"] == "NOT_PUBLISHED"
    assert core.commands() == []


def test_a_closing_channel_refuses(core):
    core.cut_gate.disable()
    assert cut(core)["code"] == "CHANNEL_CLOSING" and core.commands() == []


def test_evidence_follows_ack_and_status_and_never_claims_physical_proof(core):
    published = cut(core)
    msg_id, seq = published["msg_id"], published["seq"]

    def ladder():
        return core.cut_gate.handle(local_cut.evidence_request(msg_id), core.peer)["evidence"]

    assert ladder()["ack"] == "PENDING" and ladder()["executed"] == "NOT_OBSERVED"
    core.deliver(p1.ACK, ack_for_msg_id=msg_id, ack_for_seq=seq, result="ACCEPTED")
    assert ladder()["ack"] == "ACCEPTED" and ladder()["executed"] == "NOT_OBSERVED"
    core.deliver(p1.STATUS, output_state="LOCKDOWN", reason="COMMAND", cmd_msg_id=msg_id, cmd_seq=seq, device_seq_hwm=seq)
    final = ladder()
    assert final["executed"] == "DEVICE_REPORTED_LOCKDOWN" and final["physical_evidence"] == "NOT_PROVEN"


def test_a_rejected_ack_is_not_success(core):
    published = cut(core)
    core.deliver(p1.ACK, ack_for_msg_id=published["msg_id"], ack_for_seq=published["seq"], result="REJECTED_EXPIRED")
    evidence = core.cut_gate.handle(local_cut.evidence_request(published["msg_id"]), core.peer)["evidence"]
    assert evidence["ack"] == "REJECTED_EXPIRED" and evidence["executed"] == "NOT_OBSERVED"


@pytest.mark.parametrize("msg_id", ["", "zz" * 16, "0" * 31, "0" * 32, 7, None])
def test_evidence_for_an_unknown_or_malformed_identifier_is_refused(core, msg_id):
    reply = core.cut_gate.handle(local_cut.evidence_request(msg_id), core.peer)
    assert reply["ok"] is False and reply["code"] in {"MALFORMED_REQUEST", "UNKNOWN_COMMAND"}


def test_evidence_is_refused_for_a_peer_that_is_not_the_operator(core):
    published = cut(core)
    reply = core.cut_gate.handle(local_cut.evidence_request(published["msg_id"]), lr.Peer(uid=MY_UID + 1, pid=1))
    assert reply["code"] == "PEER_REFUSED"


# ---- configuration / inertness ---------------------------------------------------------------------------------------------
def test_the_channel_is_inert_unless_everything_is_explicitly_configured(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    for flag in ("", "yes", "1", "true", " YES", "YES "):
        monkeypatch.setattr(config, "LOCAL_CUT_ENABLED", flag)
        core.supervisor.start_local_cut()
        assert core.supervisor.local_cut is None and not path.exists()
    monkeypatch.setattr(config, "LOCAL_CUT_ENABLED", "YES")
    for name, value in (
        ("LOCAL_CUT_OPERATOR_UID", None), ("LOCAL_CUT_OPERATOR_UID", 0), ("LOCAL_CUT_SOCKET", ""),
        ("LOCAL_CUT_CREDENTIAL_FILE", ""), ("LOCAL_CUT_CREDENTIAL_FILE", str(tmp_path / "absent.cred")),
    ):
        original = getattr(config, name)
        monkeypatch.setattr(config, name, value)
        core.supervisor.start_local_cut()
        assert core.supervisor.local_cut is None and not path.exists(), (name, value)
        monkeypatch.setattr(config, name, original)


def test_the_credential_must_be_private_and_distinct_from_restore(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    cred = Path(config.LOCAL_CUT_CREDENTIAL_FILE)
    os.chmod(cred, 0o640)
    core.supervisor.start_local_cut()
    assert core.supervisor.local_cut is None and not path.exists()
    os.chmod(cred, 0o600)
    monkeypatch.setattr(config, "RESTORE_CREDENTIAL_FILE", str(cred))  # same file as RESTORE
    core.supervisor.start_local_cut()
    assert core.supervisor.local_cut is None
    monkeypatch.setattr(config, "RESTORE_CREDENTIAL_FILE", "")
    core.supervisor.restore_credential = lr.RestoreCredential.load(cred)  # same hash as the RESTORE credential
    core.supervisor.start_local_cut()
    assert core.supervisor.local_cut is None
    core.supervisor.restore_credential = None
    core.supervisor.start_local_cut()
    assert core.supervisor.local_cut is not None


def test_the_default_configuration_is_disabled():
    assert config.LOCAL_CUT_ENABLED == "" and config.LOCAL_CUT_CREDENTIAL_FILE == ""
    assert local_cut.controller_from_environment({}) is None
    assert local_cut.controller_from_environment({"AEGIS_LOCAL_CUT_ENABLED": "YES"}) is None
    assert local_cut.controller_from_environment(
        {"AEGIS_LOCAL_CUT_ENABLED": "YES", "AEGIS_LOCAL_CUT_SOCKET": "relative.sock"}) is None
    assert local_cut.controller_from_environment({"AEGIS_LOCAL_CUT_SOCKET": "/run/x/cut.sock"}) is None
    assert local_cut.controller_from_environment(
        {"AEGIS_LOCAL_CUT_ENABLED": "YES", "AEGIS_LOCAL_CUT_SOCKET": "/run/x/cut.sock"}) is not None


# ---- socket security -------------------------------------------------------------------------------------------------------
def test_the_socket_is_private_by_default_and_group_only_when_a_gid_is_configured(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    assert stat.S_IMODE(path.lstat().st_mode) == 0o600
    core.supervisor.stop_local_cut()
    assert not path.exists()
    path = enable(monkeypatch, core, tmp_path, gid=os.getegid())
    core.supervisor.start_local_cut()
    mode = stat.S_IMODE(path.lstat().st_mode)
    assert mode == 0o660 and not mode & 0o007 and local_cut.socket_is_group_reachable_only(path)


def test_a_missing_socket_directory_is_never_created(core, monkeypatch, tmp_path):
    enable(monkeypatch, core, tmp_path)
    monkeypatch.setattr(config, "LOCAL_CUT_SOCKET", str(core.runtime_dir / "absent-dir" / "cut.sock"))
    core.supervisor.start_local_cut()
    assert core.supervisor.local_cut is None and not (core.runtime_dir / "absent-dir").exists()


def test_a_group_or_world_writable_directory_is_refused(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    os.chmod(core.runtime_dir, 0o770)
    core.supervisor.start_local_cut()
    assert core.supervisor.local_cut is None and not path.exists()


def test_a_relative_socket_path_is_refused(credential):
    with pytest.raises(lr.LocalRestoreError):
        local_cut.LocalCutServer("relative/cut.sock", object())


def test_a_non_socket_at_the_path_is_never_replaced(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    path.write_text("not a socket")
    core.supervisor.start_local_cut()
    assert core.supervisor.local_cut is None and path.read_text() == "not a socket"


def test_the_desktop_controller_reaches_a_real_cut_over_the_core_socket(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    controller = local_cut.LocalCutController(path, core_uid=MY_UID, secret_provider=provider())
    result = controller.issue(CUT_UPLINK, REASON, critical=True, origin="gui")
    assert result.ok and result.sent and result.nonce
    assert [c.fields["msg_id"] for c in cuts(core)] == [result.nonce]
    again = controller.issue(CUT_UPLINK, REASON)
    assert not again.ok and again.reason_code == "COMMAND_PENDING" and len(cuts(core)) == 1
    assert len(pre_dispatch_rows(core)) == 1
    assert controller.evidence(result.nonce)["evidence"]["ack"] == "PENDING"
    core.supervisor.stop_local_cut()
    assert not path.exists()


def test_a_wrong_secret_over_the_socket_publishes_nothing(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    controller = local_cut.LocalCutController(path, core_uid=MY_UID, secret_provider=provider("definitely the wrong one"))
    result = controller.issue(CUT_UPLINK, REASON)
    assert not result.ok and result.reason_code == "AUTH_FAILED" and core.commands() == []


def test_a_server_that_is_not_the_core_account_is_refused_by_the_client(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    impostor = local_cut.LocalCutController(path, core_uid=MY_UID + 1, secret_provider=provider())
    result = impostor.issue(CUT_UPLINK, REASON)
    assert not result.ok and not result.sent and result.reason_code == "CHANNEL_UNAVAILABLE"
    assert core.commands() == []


# ---- I3: accept-time peer check, bounded reads, no retry ----------------------------------------------------------------
def raw(path):
    client = socket.socket(socket.AF_UNIX)
    client.settimeout(3)
    client.connect(str(path))
    return client


def request_line(**changes):
    body = local_cut.cut_request(REASON, SECRET)
    body.update(changes)
    return json.dumps(body).encode() + b"\n"


def wait_until(predicate, timeout=3.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_an_unauthorized_uid_is_closed_before_any_byte_is_read(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path, uid=MY_UID + 1000)  # our own connection is now "someone else"
    core.supervisor.start_local_cut()
    client = raw(path)
    started = time.monotonic()
    assert client.recv(1) == b""  # closed by the server without us sending anything
    assert time.monotonic() - started < 1.0
    client.close()
    assert core.commands() == [] and pre_dispatch_rows(core) == []


def test_an_unauthorized_flood_cannot_delay_or_flood_the_audit(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path, uid=MY_UID + 1000)
    core.supervisor.start_local_cut()
    for _ in range(60):
        try:
            raw(path).close()
        except OSError:
            pass  # a flood can briefly fill the listen backlog (EAGAIN); the client sees "unavailable", never a CUT
    time.sleep(0.3)
    assert len([e for e in core.audit.events if e[0] == "CUT_REFUSED"]) <= 2
    assert core.commands() == []


def test_a_stalled_connection_cannot_block_an_authorized_cut(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    stalled = raw(path)
    stalled.sendall(b'{"v": 1, "op": "CUT_UPLINK"')  # never finished, never newline-terminated
    controller = local_cut.LocalCutController(path, core_uid=MY_UID, secret_provider=provider())
    started = time.monotonic()
    result = controller.issue(CUT_UPLINK, REASON)
    assert result.sent and time.monotonic() - started < 1.5
    stalled.close()
    assert len(cuts(core)) == 1


def test_a_slow_connection_is_dropped_at_the_read_deadline(core, monkeypatch, tmp_path):
    monkeypatch.setattr(local_cut, "READ_DEADLINE_SEC", 0.3)
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    slow = raw(path)
    slow.sendall(b'{"v"')
    reply = json.loads(slow.makefile("rb").readline())
    assert reply["code"] == "MALFORMED_REQUEST" and core.commands() == []
    slow.close()


@pytest.mark.parametrize("payload", [None, "partial", "complete_no_newline", "oversize", "not_json"])
def test_an_incomplete_or_disconnected_request_never_causes_a_cut(core, monkeypatch, tmp_path, payload):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    client = raw(path)
    if payload == "partial":
        client.sendall(request_line()[:30])
    elif payload == "complete_no_newline":
        client.sendall(request_line().rstrip(b"\n"))  # a full, valid, authenticated body that was never terminated
    elif payload == "oversize":
        client.sendall(b"x" * (lr.MAX_MESSAGE_BYTES + 100))
    elif payload == "not_json":
        client.sendall(b"hello\n")
    client.close()
    time.sleep(0.3)
    assert core.commands() == [] and pre_dispatch_rows(core) == []


def test_a_client_that_disconnects_before_the_reply_causes_exactly_one_cut_and_no_replay(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    client = raw(path)
    client.sendall(request_line())
    client.close()  # gone before the reply
    assert wait_until(lambda: len(cuts(core)) == 1)
    time.sleep(0.5)
    assert len(cuts(core)) == 1 and len(pre_dispatch_rows(core)) == 1


def test_the_handler_pool_is_bounded(core, monkeypatch, tmp_path):
    monkeypatch.setattr(local_cut, "MAX_HANDLERS", 1)
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    first = raw(path)
    first.sendall(b"{")
    time.sleep(0.2)
    second = raw(path)
    assert second.recv(1) == b""  # over the cap: closed immediately
    second.close()
    first.close()


def test_close_joins_workers_and_removes_the_socket(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    held = raw(path)
    held.sendall(b"{")
    core.supervisor.stop_local_cut()
    assert not path.exists()
    held.close()


# ---- the Desktop controller is never a RESTORE or heartbeat authority ------------------------------------------------------
def test_the_desktop_controller_can_never_restore_or_heartbeat(core):
    sent = []
    controller = local_cut.LocalCutController(
        core.runtime_dir / "none.sock", core_uid=MY_UID, send=lambda *a, **k: sent.append(a), secret_provider=provider(),
    )
    result = controller.issue(RESTORE_UPLINK, "restore", authorize_restore=True)
    assert result.reason_code == "RESTORE_NOT_AVAILABLE" and not result.sent and not result.ok
    assert controller.send_heartbeat() is False and sent == []
    with pytest.raises(ValueError):
        controller.issue("REBOOT", "x")


def test_the_cut_channel_cannot_carry_restore(core):
    for body in (
        {**local_cut.cut_request(REASON, SECRET), "op": RESTORE_UPLINK},
        {"v": 1, "op": RESTORE_UPLINK, "origin": lr.LOCAL_REQUEST_ORIGIN, "secret": SECRET,
         "confirmation": lr.CONFIRMATION, "reason": REASON},
    ):
        assert core.cut_gate.handle(body, core.peer)["ok"] is False
    assert core.commands() == []


def test_an_unreachable_core_is_reported_not_assumed(core):
    controller = local_cut.LocalCutController(core.runtime_dir / "absent.sock", core_uid=MY_UID, secret_provider=provider())
    result = controller.issue(CUT_UPLINK, REASON)
    assert not result.ok and not result.sent and result.reason_code == "CHANNEL_UNAVAILABLE"


def test_a_lost_reply_is_outcome_unknown_and_never_retried(core):
    calls = []

    def lost(*_args, **_kwargs):
        calls.append(1)
        raise lr.OutcomeUnknown("the local result was lost; do not retry automatically")

    controller = local_cut.LocalCutController(core.runtime_dir / "x.sock", core_uid=MY_UID, send=lost,
                                              secret_provider=provider())
    result = controller.issue(CUT_UPLINK, REASON)
    assert result.reason_code == "OUTCOME_UNKNOWN" and not result.sent and not result.ok and calls == [1]


# ---- architecture guards ---------------------------------------------------------------------------------------------------
def test_the_cut_module_has_no_direct_mqtt_or_relay_path():
    tree = ast.parse(Path(local_cut.__file__).read_text(encoding="utf-8"))
    tree.body = tree.body[1:]  # the module docstring documents the missing Desktop work and may name MQTT
    source = ast.unparse(tree)
    for forbidden in ("publish(", "MQTTManager", "paho", "gpio", "GPIO", "mqtt"):
        assert forbidden not in source.replace("pre_publish", ""), forbidden
    assert "issue_command" in source and "authorize_restore=True" not in source


def test_the_supervisor_wires_the_gate_with_the_strict_audit_writer():
    # Read the file, not inspect.getsource: other suites replace classes, which makes getsource order-dependent.
    text = Path(supervisor_module.__file__).read_text(encoding="utf-8")
    source = text.split("def start_local_cut", 1)[1].split("def stop_local_cut", 1)[0]
    assert "audit_strict=db.log_event_strict" in source and "allowed_uid=operator_uid" in source
    assert "credential=credential" in source and "geteuid" not in source


def test_the_existing_restore_evidence_ladder_is_unchanged_for_restore(core):
    assert lr.restore_evidence_ladder(core.supervisor, "0" * 32) is None
    published = cut(core)
    assert lr.restore_evidence_ladder(core.supervisor, published["msg_id"]) is None
    assert lr.restore_evidence_ladder(core.supervisor, published["msg_id"], action=CUT_UPLINK) is not None
