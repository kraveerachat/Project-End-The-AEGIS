"""R13 ordered commits, time-gated dispatch, the evidence ladder, and no automatic RESTORE.

A real supervisor, controller, MQTT adapter (fake paho client), protocol store,
dispatch ledger, and dispatch worker are joined; only the network edges are
fakes. Design §5, §7, §9, §12.
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import pytest

from aegis_soc import protocol_v1 as p1
from aegis_soc.dispatch_client import ClaimResult, PendingAction, ReportResult
from aegis_soc.dispatch_ledger import DispatchLedger
from aegis_soc.dispatch_worker import ACTIVE, PAUSED_CREDENTIAL, UNAVAILABLE, DispatchWorker
from aegis_soc.mqtt_client import MQTTManager
from aegis_soc.protocol_inbound import ProtocolContext
from aegis_soc.protocol_store import ProtocolStore
from aegis_soc.runtime import RuntimeSettings, RuntimeState
from aegis_soc.supervisor import STATE_DETAIL, AegisSupervisor

DEVICE = "test-device-01"
# Public TEST-ONLY golden-vector keys; Core key loading refuses them.
KEYS = p1.ProtocolKeys(c2d=bytes(range(0x20)), d2c=bytes(range(0x20, 0x40)))
NOW = p1.TIME_FLOOR + 3_600
ACTION_ID = "5b0e3c1e-8f6a-4c2d-9b7e-2f1a0c9d8e7f"
TOPICS = p1.topics(DEVICE)


class ScenarioClock:
    """state() and trusted_now() are independent so a claim/publish race can be modelled."""

    def __init__(self, state="SYNCED", now=NOW, trusted_now=True):
        self.current = state
        self.now = now
        self.gives_time = trusted_now

    def state(self):
        return self.current

    def trusted_now(self):
        if not self.gives_time or self.current not in {"SYNCED", "HOLDOVER"}:
            return None
        return self.now


class FakePahoClient:
    def __init__(self):
        self.published = []
        self.publish_rc = 0

    def publish(self, topic, payload, qos=0, retain=False):
        self.published.append((topic, payload, qos, retain))
        return SimpleNamespace(rc=self.publish_rc)


class FakeDispatchClient:
    def __init__(self, deadline=NOW + 120):
        self.deadline = deadline
        self.calls = []

    def list_pending(self):
        self.calls.append("list")
        return [PendingAction(ACTION_ID, "CUT_UPLINK", "2026-09-15T01:00:00.000Z", self.deadline)]

    def claim(self, action_id):
        self.calls.append("claim")
        return ClaimResult("CLAIMED", self.deadline)

    def report(self, action_id, entry):
        self.calls.append("report")
        return ReportResult("RECORDED")


class Harness:
    def __init__(self, tmp_path, *, clock=None, deadline=NOW + 120):
        self.tmp_path = tmp_path
        self.clock = clock or ScenarioClock()
        self.store = ProtocolStore(tmp_path / "data" / "core-protocol.sqlite3", wall_clock=lambda: NOW)
        self.context = ProtocolContext(DEVICE, KEYS, self.store, self.clock)
        self.client = FakePahoClient()
        self.mqtt = MQTTManager(protocol=self.context, client_factory=lambda: self.client, protocol_mode="v1")
        self.mqtt.is_connected = True
        base = RuntimeSettings.from_profile("development", dry_run=False, start_detector=False, start_gui=False)
        self.settings = replace(base, runtime_dir=tmp_path / "runtime", log_dir=tmp_path / "logs")
        self.ledger = DispatchLedger(tmp_path / "data" / "core-dispatch.sqlite3", wall_clock=lambda: NOW)
        self.dispatch = FakeDispatchClient(deadline)
        self.supervisor = AegisSupervisor(
            self.settings, mqtt_manager=self.mqtt, protocol=self.context, dispatch_worker=None, monotonic=lambda: 100.0,
        )
        self.supervisor.bind_callbacks()
        self.worker = DispatchWorker(self.supervisor, self.ledger, self.dispatch, wall_clock=lambda: NOW)
        self.supervisor.dispatch_worker = self.worker

    def frames(self, kind):
        return [payload for topic, payload, _, _ in self.client.published if topic == TOPICS.for_kind(kind)]

    def commands(self):
        return [
            p1.parse(raw, topic=TOPICS.command, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
            for raw in self.frames(p1.COMMAND)
        ]

    def deliver(self, kind, **fields):
        base = {"msg_id": p1.new_msg_id(), "device_time": NOW - 1}
        if kind == p1.STATUS:
            base.update(time_trust="SYNCED", output_state="NORMAL", reason="PERIODIC", cmd_msg_id="", cmd_seq=0,
                        device_seq_hwm=0, rssi_dbm=-55, heap_free=100000)
        base.update(fields)
        topic, raw = p1.encode(kind, device_id=DEVICE, fields=base, keys=KEYS)
        self.mqtt._on_message(None, None, SimpleNamespace(topic=topic, payload=raw, retain=False))

    def stages(self):
        return [entry["stage"] for entry in self.ledger.pending_outbox()]

    def close(self):
        self.store.close()
        self.ledger.close()


@pytest.fixture
def harness(tmp_path):
    instance = Harness(tmp_path)
    yield instance
    instance.close()


def _dispatch_once(harness):
    harness.worker.start()
    harness.worker.tick()


def test_dispatch_publishes_one_signed_command_after_claim_and_reservation(harness):
    _dispatch_once(harness)

    [command] = harness.commands()
    assert p1.verify(command, KEYS) is True
    assert command.fields["action"] == "CUT_UPLINK"
    action = harness.ledger.get(ACTION_ID)
    assert action["state"] == "PUBLISHED"
    assert action["nonce"] == command.fields["msg_id"]
    assert harness.store.command(command.fields["msg_id"])["state"] == "PUBLISHED"
    assert harness.dispatch.calls[:2] == ["list", "claim"]


def test_the_dispatch_deadline_caps_device_expiry(tmp_path):
    harness = Harness(tmp_path, deadline=NOW + 10)
    try:
        _dispatch_once(harness)
        assert harness.commands()[0].int("expires_at") == NOW + 10
    finally:
        harness.close()


def test_a_store_failure_before_publish_sends_nothing_and_is_terminal(harness, monkeypatch):
    monkeypatch.setattr(harness.store, "reserve_command", lambda *_args: (_ for _ in ()).throw(OSError("disk")))
    _dispatch_once(harness)
    harness.worker.tick()

    assert harness.frames(p1.COMMAND) == []
    assert harness.ledger.get(ACTION_ID)["state"] == "FAILED"
    assert harness.dispatch.calls.count("claim") == 1


def test_a_publish_failure_burns_the_sequence_and_is_never_retried(harness):
    harness.client.publish_rc = 4
    _dispatch_once(harness)
    harness.worker.tick()

    [attempt] = [
        p1.parse(raw, topic=TOPICS.command, device_id=DEVICE, accept_kinds=frozenset({p1.COMMAND}))
        for raw in harness.frames(p1.COMMAND)
    ]
    assert harness.ledger.get(ACTION_ID)["state"] == "FAILED"
    assert harness.store.command(attempt.fields["msg_id"])["state"] == "NOT_PUBLISHED"
    assert harness.dispatch.calls.count("claim") == 1
    harness.client.publish_rc = 0
    manual = harness.supervisor.issue_command("CUT_UPLINK", "operator", critical=True, origin="gui")
    assert manual.seq == attempt.int("seq") + 1


@pytest.mark.parametrize("state", ["UNTRUSTED", "UNKNOWN"])
def test_untrusted_core_time_never_claims_publishes_or_heartbeats(tmp_path, state):
    harness = Harness(tmp_path, clock=ScenarioClock(state=state))
    try:
        _dispatch_once(harness)
        assert "claim" not in harness.dispatch.calls
        assert harness.worker.status == UNAVAILABLE
        assert harness.supervisor.controller.send_heartbeat() is False
        assert harness.client.published == []
        harness.supervisor._refresh_protocol_state()
        assert harness.supervisor.status.time_trust == state
        assert harness.supervisor.evaluate_state() == RuntimeState.DEGRADED
    finally:
        harness.close()


def test_holdover_time_still_heartbeats_and_dispatches(tmp_path):
    harness = Harness(tmp_path, clock=ScenarioClock(state="HOLDOVER"))
    try:
        _dispatch_once(harness)
        assert len(harness.frames(p1.COMMAND)) == 1
        assert harness.supervisor.controller.send_heartbeat() is True
    finally:
        harness.close()


def test_time_lost_between_claim_and_publish_fails_as_not_sent(tmp_path):
    harness = Harness(tmp_path, clock=ScenarioClock(state="SYNCED", trusted_now=False))
    try:
        _dispatch_once(harness)
        assert harness.frames(p1.COMMAND) == []
        assert harness.ledger.get(ACTION_ID)["state"] == "FAILED"
        assert harness.ledger.pending_outbox()[-1]["detail"] == {"reasonCode": "CORE_TIME_UNTRUSTED"}
    finally:
        harness.close()


def test_a_crash_after_the_point_of_no_return_is_outcome_unknown_and_never_republished(tmp_path, monkeypatch):
    first = Harness(tmp_path)
    monkeypatch.setattr(first.ledger, "mark_published", lambda *_args: (_ for _ in ()).throw(OSError("crash")))
    first.worker.start()
    with pytest.raises(OSError):
        first.worker.tick()
    [command] = first.commands()
    first.close()

    restarted = Harness(tmp_path)
    try:
        restarted.supervisor.recover_protocol_state()
        restarted.worker.start()
        restarted.worker.tick()
        assert restarted.frames(p1.COMMAND) == []
        assert restarted.ledger.get(ACTION_ID)["state"] == "OUTCOME_UNKNOWN"
        assert restarted.store.command(command.fields["msg_id"])["state"] == "CLOSED"
        restarted.deliver(p1.ACK, ack_for_msg_id=command.fields["msg_id"], ack_for_seq=command.int("seq"),
                          result="ACCEPTED")
        assert restarted.ledger.get(ACTION_ID)["state"] == "OUTCOME_UNKNOWN"
    finally:
        restarted.close()


def test_the_replay_row_commits_before_any_dispatch_evidence(harness, monkeypatch):
    _dispatch_once(harness)
    [command] = harness.commands()
    events = []
    record_seen, record_ack = harness.store.record_seen, harness.ledger.record_ack
    monkeypatch.setattr(harness.store, "record_seen", lambda *args: events.append("replay") or record_seen(*args))
    monkeypatch.setattr(harness.ledger, "record_ack", lambda *args: events.append("evidence") or record_ack(*args))

    harness.deliver(p1.ACK, ack_for_msg_id=command.fields["msg_id"], ack_for_seq=command.int("seq"), result="ACCEPTED")

    assert events == ["replay", "evidence"]


def test_the_evidence_ladder_is_never_promoted(harness):
    _dispatch_once(harness)
    [command] = harness.commands()
    msg_id, seq = command.fields["msg_id"], command.int("seq")

    harness.deliver(p1.STATUS, output_state="LOCKDOWN", reason="DEADMAN")
    assert harness.stages() == ["PUBLISHED"]
    assert harness.supervisor.awaiting_physical_confirmation["physical_confirmed_at"] is None

    harness.deliver(p1.ACK, ack_for_msg_id=msg_id, ack_for_seq=seq, result="ACCEPTED")
    assert harness.stages() == ["PUBLISHED", "ACK"]
    assert harness.ledger.get(ACTION_ID)["state"] == "ACK_RECEIVED"
    assert harness.supervisor.awaiting_physical_confirmation["physical_confirmed_at"] is None

    harness.deliver(p1.STATUS, output_state="LOCKDOWN", reason="COMMAND", cmd_msg_id=msg_id, cmd_seq=seq,
                    device_seq_hwm=seq)
    assert harness.stages() == ["PUBLISHED", "ACK", "STATUS"]
    assert harness.ledger.get(ACTION_ID)["state"] == "STATUS_CORRELATED"
    assert not {"CONTAINED", "RELAY_EVIDENCE", "EXECUTED", "PHYSICAL"} & set(harness.stages())
    assert "physical" not in STATE_DETAIL[RuntimeState.LOCKDOWN].lower()


def test_a_rejected_ack_is_outcome_unknown_and_never_redispatched(harness):
    _dispatch_once(harness)
    [command] = harness.commands()
    harness.deliver(p1.ACK, ack_for_msg_id=command.fields["msg_id"], ack_for_seq=command.int("seq"),
                    result="REJECTED_SEQUENCE")
    harness.worker.tick()
    assert harness.ledger.get(ACTION_ID)["state"] == "OUTCOME_UNKNOWN"
    assert len(harness.frames(p1.COMMAND)) == 1


def _restores(harness):
    return [command for command in harness.commands() if command.fields["action"] == "RESTORE_UPLINK"]


def test_no_restore_on_reconnect_restart_time_recovery_or_certificate_recovery(tmp_path):
    clock = ScenarioClock(state="UNTRUSTED")
    harness = Harness(tmp_path, clock=clock)
    try:
        harness.supervisor.status.uplink = "LOCKDOWN"
        harness.supervisor._on_connection(False)
        harness.supervisor._on_connection(True)
        assert harness.supervisor.controller.send_heartbeat() is False
        clock.current = "SYNCED"
        assert harness.supervisor.controller.send_heartbeat() is True
        harness.worker.status = PAUSED_CREDENTIAL
        harness.worker.status = ACTIVE
        harness.supervisor._tick_dispatch()
        harness.supervisor.recover_protocol_state()
        assert _restores(harness) == []
        assert harness.frames(p1.HEARTBEAT) and all(
            topic != TOPICS.command or b"RESTORE_UPLINK" not in payload
            for topic, payload, _, _ in harness.client.published
        )
    finally:
        harness.close()


def test_the_headless_supervisor_has_no_restore_authority(harness):
    result = harness.supervisor.issue_command(
        "RESTORE_UPLINK", "operator restore", critical=True, origin="gui", authorize_restore=True,
    )
    assert (result.sent, result.reason_code) == (False, "RESTORE_ORIGIN_REFUSED")
    assert _restores(harness) == []


def test_a_production_supervisor_refuses_any_restore_origin(harness):
    production = replace(harness.settings, profile="production")
    with pytest.raises(ValueError):
        AegisSupervisor(production, mqtt_manager=harness.mqtt, protocol=harness.context, dispatch_worker=None,
                        restore_origins=frozenset({"aegisctl"}))
