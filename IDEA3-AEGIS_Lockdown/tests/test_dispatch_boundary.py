"""PR10 S2 Task 7: Core dispatch orchestration across client, ledger, and supervisor.

All effects are local and simulated: fake clients, injected clocks, temporary
SQLite files, and the existing fake/dry-run command boundary only.
"""

from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import pytest

from aegis_soc.controller import CommandResult
from aegis_soc.dispatch_client import (
    ClaimResult,
    DispatchUnavailable,
    PendingAction,
    ReportResult,
)
from aegis_soc.dispatch_ledger import DispatchLedger
from aegis_soc.dispatch_worker import DispatchWorker, build_dispatch_worker_from_environment
from aegis_soc.runtime import RuntimeSettings
from aegis_soc.supervisor import AegisSupervisor

ACTION_ID = "5b0e3c1e-8f6a-4c2d-9b7e-2f1a0c9d8e7f"
OTHER_ACTION_ID = "6c1f4d2f-9a7b-4d3e-8c8f-3a2b1d0e9f8a"
START = 1_788_000_000.0
EXPIRES_AT = START + 120.0
NONCE = "dispatch-nonce"


class Clock:
    def __init__(self, now=START):
        self.now = now

    def __call__(self):
        return self.now


class FakeClient:
    def __init__(self, *, actions=(), claim=None, reports=()):
        self.actions = actions if isinstance(actions, BaseException) else list(actions)
        self.claim_result = ClaimResult("CLAIMED", EXPIRES_AT) if claim is None else claim
        self.report_results = list(reports)
        self.calls = []
        self.on_claim = None

    def list_pending(self):
        self.calls.append(("list",))
        if isinstance(self.actions, BaseException):
            raise self.actions
        return list(self.actions)

    def claim(self, action_id):
        self.calls.append(("claim", action_id))
        if self.on_claim:
            self.on_claim()
        if isinstance(self.claim_result, BaseException):
            raise self.claim_result
        return self.claim_result

    def report(self, action_id, entry):
        self.calls.append(("report", action_id, entry))
        result = self.report_results.pop(0) if self.report_results else ReportResult("RECORDED")
        if isinstance(result, BaseException):
            raise result
        return result


class FakeSupervisor:
    def __init__(self, result=None):
        self.status = SimpleNamespace(armed="ARMED")
        self.pending_command = None
        self.calls = []
        self.result = result or CommandResult("CUT_UPLINK", True, True, False, NONCE, "SENT")

    def issue_command(self, action, description, **kwargs):
        self.calls.append((action, description, kwargs))
        if self.result.sent:
            self.pending_command = {"action": action, "nonce": self.result.nonce, "sent_at": 0.0}
        return self.result


class RecordingLedger(DispatchLedger):
    def __init__(self, path, *, wall_clock, events):
        self.events = events
        super().__init__(path, wall_clock=wall_clock)

    def begin_claim(self, action_id, action, expires_at):
        self.events.append("begin_claim")
        return super().begin_claim(action_id, action, expires_at)


def pending(action_id=ACTION_ID, *, action="CUT_UPLINK", expires_at=EXPIRES_AT):
    return PendingAction(action_id, action, "2026-08-29T10:40:00.000Z", expires_at)


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def ledger(tmp_path, clock):
    instance = DispatchLedger(tmp_path / "core-dispatch.sqlite3", wall_clock=clock)
    yield instance
    instance.close()


def test_c1_c3_c6_c9_records_claim_intent_before_claim_then_uses_issue_command_once(tmp_path, clock):
    events = []
    ledger = RecordingLedger(tmp_path / "core-dispatch.sqlite3", wall_clock=clock, events=events)
    client = FakeClient(actions=[pending()])
    original_claim = client.claim

    def claim(action_id):
        events.append("claim")
        return original_claim(action_id)

    client.claim = claim
    supervisor = FakeSupervisor()
    original_issue = supervisor.issue_command

    def issue(*args, **kwargs):
        events.append("issue_command")
        return original_issue(*args, **kwargs)

    supervisor.issue_command = issue
    worker = DispatchWorker(supervisor, ledger, client, wall_clock=clock)

    try:
        worker.start()
        worker.tick()

        assert events == ["begin_claim", "claim", "issue_command"]
        assert ledger.get(ACTION_ID)["state"] == "PUBLISHED"
        assert ledger.get(ACTION_ID)["nonce"] == NONCE
        assert supervisor.calls == [(
            "CUT_UPLINK",
            f"server dispatch action {ACTION_ID}",
            {"critical": True, "origin": "server-dispatch"},
        )]

        worker.tick()
        assert len(supervisor.calls) == 1
    finally:
        ledger.close()


def test_c1_restart_marks_unresolved_work_unknown_and_never_republishes(tmp_path, clock):
    path = tmp_path / "core-dispatch.sqlite3"
    first = DispatchLedger(path, wall_clock=clock)
    first.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)
    first.mark_claimed(ACTION_ID)
    first.close()

    reopened = DispatchLedger(path, wall_clock=clock)
    supervisor = FakeSupervisor()
    worker = DispatchWorker(supervisor, reopened, FakeClient(actions=[pending()]), wall_clock=clock)
    try:
        assert worker.start() == [ACTION_ID]
        assert reopened.get(ACTION_ID)["state"] == "OUTCOME_UNKNOWN"
        worker.tick()
        assert supervisor.calls == []
        assert worker.start() == []
    finally:
        reopened.close()


def test_c2_skips_an_action_already_expired_on_the_core_clock(ledger, clock):
    clock.now = EXPIRES_AT
    client = FakeClient(actions=[pending()])
    supervisor = FakeSupervisor()
    worker = DispatchWorker(supervisor, ledger, client, wall_clock=clock)

    worker.start()
    worker.tick()

    assert ledger.get(ACTION_ID) is None
    assert [call[0] for call in client.calls] == ["list"]
    assert supervisor.calls == []


def test_c2_rechecks_expiry_after_claim_and_before_publish(ledger, clock):
    client = FakeClient(actions=[pending()])
    client.on_claim = lambda: setattr(clock, "now", EXPIRES_AT)
    supervisor = FakeSupervisor()
    worker = DispatchWorker(supervisor, ledger, client, wall_clock=clock)

    worker.start()
    worker.tick()

    assert ledger.get(ACTION_ID)["state"] == "EXPIRED_AT_CORE"
    assert supervisor.calls == []
    assert ledger.pending_outbox()[0]["stage"] == "EXPIRED_AT_CORE"


def test_c3_replayed_action_is_never_claimed_or_published_again(ledger, clock):
    ledger.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)
    ledger.mark_claim_rejected(ACTION_ID)
    client = FakeClient(actions=[pending()])
    supervisor = FakeSupervisor()
    worker = DispatchWorker(supervisor, ledger, client, wall_clock=clock)

    worker.start()
    worker.tick()

    assert [call[0] for call in client.calls] == ["list"]
    assert supervisor.calls == []


@pytest.mark.parametrize("action", ["RESTORE_UPLINK", "cut_uplink", ""])
def test_c6_a_non_cut_uplink_pending_action_is_refused_without_claim_or_publish(ledger, clock, action):
    client = FakeClient(actions=[pending(OTHER_ACTION_ID, action=action), pending()])
    supervisor = FakeSupervisor()
    worker = DispatchWorker(supervisor, ledger, client, wall_clock=clock)

    worker.start()
    worker.tick()

    assert ledger.get(OTHER_ACTION_ID) is None
    assert ("claim", OTHER_ACTION_ID) not in client.calls
    assert [call[0] for call in supervisor.calls] == ["CUT_UPLINK"]
    assert ledger.get(ACTION_ID)["state"] == "PUBLISHED"


@pytest.mark.parametrize("claim_status", ["NOT_FOUND", "EXPIRED", "ALREADY_CLAIMED", "NOT_DISPATCHABLE"])
def test_rejected_claim_is_terminal_and_never_published(ledger, clock, claim_status):
    client = FakeClient(actions=[pending()], claim=ClaimResult(claim_status))
    supervisor = FakeSupervisor()
    worker = DispatchWorker(supervisor, ledger, client, wall_clock=clock)

    worker.start()
    worker.tick()

    assert ledger.get(ACTION_ID)["state"] == "CLAIM_REJECTED"
    assert supervisor.calls == []


def test_lost_claim_response_becomes_unknown_without_publish_or_retry(ledger, clock):
    client = FakeClient(actions=[pending()], claim=DispatchUnavailable("NETWORK"))
    supervisor = FakeSupervisor()
    worker = DispatchWorker(supervisor, ledger, client, wall_clock=clock)

    worker.start()
    worker.tick()
    worker.tick()

    assert ledger.get(ACTION_ID)["state"] == "OUTCOME_UNKNOWN"
    assert supervisor.calls == []
    assert [call[0] for call in client.calls].count("claim") == 1


@pytest.mark.parametrize("gate", ["DISARMED", "PENDING_COMMAND", "LEDGER_IN_FLIGHT"])
def test_worker_does_not_claim_while_a_core_safety_gate_is_closed(ledger, clock, gate):
    client = FakeClient(actions=[pending()])
    supervisor = FakeSupervisor()
    worker = DispatchWorker(supervisor, ledger, client, wall_clock=clock)
    worker.start()
    if gate == "DISARMED":
        supervisor.status.armed = "DISARMED"
    elif gate == "PENDING_COMMAND":
        supervisor.pending_command = {"action": "CUT_UPLINK", "nonce": "other"}
    else:
        ledger.begin_claim(OTHER_ACTION_ID, "CUT_UPLINK", EXPIRES_AT)
        ledger.mark_claimed(OTHER_ACTION_ID)
        ledger.mark_published(OTHER_ACTION_ID, "other")

    worker.tick()

    assert not any(call[0] in {"list", "claim"} for call in client.calls)
    assert supervisor.calls == []


def test_c4_supervisor_forwards_only_nonce_correlated_ack_and_status(tmp_path):
    settings = replace(
        RuntimeSettings.from_profile("development", dry_run=True, start_detector=False, start_gui=False),
        runtime_dir=tmp_path / "runtime",
        log_dir=tmp_path / "logs",
    )

    class SpyWorker:
        def __init__(self):
            self.events = []

        def on_ack(self, ack, nonce):
            self.events.append(("ACK", ack, nonce))

        def on_status(self, state, nonce):
            self.events.append(("STATUS", state, nonce))

    spy = SpyWorker()
    supervisor = AegisSupervisor(settings, mqtt_manager=SimpleNamespace(), dispatch_worker=spy, monotonic=lambda: 5.0)
    supervisor.pending_command = {"action": "CUT_UPLINK", "nonce": NONCE, "sent_at": 0.0}
    supervisor.awaiting_physical_confirmation = {
        "action": "CUT_UPLINK", "nonce": NONCE, "expected_state": "LOCKDOWN",
        "observed_state": None, "acknowledged_at": None, "physical_confirmed_at": None,
        "physical_timeout_at": None,
    }

    supervisor._on_status("LOCKDOWN", -50, 100_000, "wrong")
    supervisor._on_status("LOCKDOWN", -50, 100_000, NONCE)
    supervisor._on_ack("OK", "done", "wrong")
    supervisor._on_ack("OK", "done", NONCE)

    assert spy.events == [("STATUS", "LOCKDOWN", NONCE), ("ACK", "OK", NONCE)]


def test_c4_worker_callbacks_preserve_ack_status_evidence_ladder(ledger, clock):
    ledger.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)
    ledger.mark_claimed(ACTION_ID)
    ledger.mark_published(ACTION_ID, NONCE)
    worker = DispatchWorker(FakeSupervisor(), ledger, FakeClient(), wall_clock=clock)

    worker.on_status("LOCKDOWN", NONCE)
    assert ledger.get(ACTION_ID)["state"] == "PUBLISHED"
    worker.on_ack("OK", NONCE)

    assert ledger.get(ACTION_ID)["state"] == "STATUS_CORRELATED"
    assert [entry["stage"] for entry in ledger.pending_outbox()] == ["PUBLISHED", "STATUS", "ACK"]


def test_c5_timeout_becomes_unknown_without_a_second_publish(ledger, clock):
    supervisor = FakeSupervisor()
    client = FakeClient()
    worker = DispatchWorker(supervisor, ledger, client, wall_clock=clock, ack_timeout_sec=8, status_timeout_sec=8)
    worker.start()
    ledger.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)
    ledger.mark_claimed(ACTION_ID)
    ledger.mark_published(ACTION_ID, NONCE)

    clock.now += 8
    worker.tick()
    worker.tick()

    assert ledger.get(ACTION_ID)["state"] == "OUTCOME_UNKNOWN"
    assert supervisor.calls == []


@pytest.mark.parametrize("failure_reason", ["NETWORK", "CREDENTIAL"])
def test_c5_local_timeout_still_runs_when_outbox_delivery_is_unavailable(ledger, clock, failure_reason):
    worker = DispatchWorker(
        FakeSupervisor(),
        ledger,
        FakeClient(reports=[DispatchUnavailable(failure_reason)]),
        wall_clock=clock,
        ack_timeout_sec=8,
        status_timeout_sec=8,
    )
    worker.start()
    ledger.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)
    ledger.mark_claimed(ACTION_ID)
    ledger.mark_published(ACTION_ID, NONCE)

    clock.now += 8
    worker.tick()

    assert ledger.get(ACTION_ID)["state"] == "OUTCOME_UNKNOWN"
    assert [entry["stage"] for entry in ledger.pending_outbox()] == ["PUBLISHED", "OUTCOME_UNKNOWN"]


@pytest.mark.parametrize(
    ("result", "expected_state", "expected_stage"),
    [
        (CommandResult("CUT_UPLINK", True, False, True, NONCE, "WOULD_SEND"), "DRY_RUN_ONLY", "DRY_RUN"),
        (CommandResult("CUT_UPLINK", False, False, False, NONCE, "unavailable"), "FAILED", "FAILED"),
    ],
)
def test_publish_outcomes_are_terminal_and_not_retried(ledger, clock, result, expected_state, expected_stage):
    supervisor = FakeSupervisor(result)
    worker = DispatchWorker(supervisor, ledger, FakeClient(actions=[pending()]), wall_clock=clock)

    worker.start()
    worker.tick()

    assert ledger.pending_outbox()[0]["stage"] == expected_stage
    worker.tick()

    assert ledger.get(ACTION_ID)["state"] == expected_state
    assert ledger.outbox_dispositions(ACTION_ID) == [(1, "DELIVERED")]
    assert len(supervisor.calls) == 1


def test_c7_outbox_is_retained_while_unreachable_then_delivered_idempotently(ledger, clock):
    ledger.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)
    ledger.mark_claimed(ACTION_ID)
    ledger.mark_dry_run(ACTION_ID, NONCE)
    client = FakeClient(reports=[DispatchUnavailable("NETWORK"), ReportResult("UNCHANGED")])
    worker = DispatchWorker(FakeSupervisor(), ledger, client, wall_clock=clock)
    worker.start()

    worker.tick()
    assert ledger.outbox_dispositions(ACTION_ID) == [(1, None)]
    worker.tick()

    assert ledger.outbox_dispositions(ACTION_ID) == [(1, "DELIVERED")]
    report_calls = [call for call in client.calls if call[0] == "report"]
    assert len(report_calls) == 2
    assert report_calls[0][2] == report_calls[1][2]
    assert report_calls[0][2] == {
        "sequence": 1,
        "stage": "DRY_RUN",
        "observedAt": "2026-08-29T10:40:00.000Z",
        "detail": {},
    }


def test_c7_definitive_report_rejection_is_retained_and_never_resent(ledger, clock):
    ledger.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)
    ledger.mark_claimed(ACTION_ID)
    ledger.mark_failed(ACTION_ID, "MQTT_UNAVAILABLE")
    client = FakeClient(reports=[ReportResult("REJECTED")])
    worker = DispatchWorker(FakeSupervisor(), ledger, client, wall_clock=clock)
    worker.start()

    worker.tick()
    worker.tick()

    assert ledger.outbox_dispositions(ACTION_ID) == [(1, "REJECTED_BY_SERVER")]
    assert [call[0] for call in client.calls].count("report") == 1


def test_c8_missing_credentials_pause_before_any_client_call_or_cut(ledger, clock):
    client = FakeClient(actions=[pending()])
    supervisor = FakeSupervisor()
    worker = DispatchWorker(
        supervisor, ledger, client, wall_clock=clock, credential_available=lambda: False,
    )
    worker.start()

    worker.tick()

    assert worker.status == "PAUSED_CREDENTIAL"
    assert client.calls == []
    assert supervisor.calls == []


def test_c8_transport_credential_failure_pauses_without_claim_or_cut(ledger, clock):
    client = FakeClient(actions=DispatchUnavailable("CREDENTIAL"))
    supervisor = FakeSupervisor()
    worker = DispatchWorker(supervisor, ledger, client, wall_clock=clock)
    worker.start()

    worker.tick()

    assert worker.status == "PAUSED_CREDENTIAL"
    assert [call[0] for call in client.calls] == ["list"]
    assert supervisor.calls == []


def test_c8_enabled_environment_with_missing_files_constructs_a_paused_worker(tmp_path, clock):
    supervisor = FakeSupervisor()
    worker = build_dispatch_worker_from_environment(
        supervisor,
        env={
            "AEGIS_CORE_DISPATCH_ENABLED": "1",
            "AEGIS_CORE_DISPATCH_DB_PATH": str(tmp_path / "core-dispatch.sqlite3"),
            "AEGIS_CORE_DISPATCH_BASE_URL": "https://idea3-core.aegis.invalid/security/api/machine/v1",
            "AEGIS_CORE_DISPATCH_CA_FILE": str(tmp_path / "missing-ca.pem"),
            "AEGIS_CORE_DISPATCH_CLIENT_CERT": str(tmp_path / "missing-client.pem"),
            "AEGIS_CORE_DISPATCH_CLIENT_KEY": str(tmp_path / "missing-client.key"),
        },
        wall_clock=clock,
    )
    assert worker is not None
    try:
        worker.start()
        worker.tick()

        assert worker.status == "PAUSED_CREDENTIAL"
        assert supervisor.calls == []
    finally:
        worker.close()


def test_c10_dispatch_is_disabled_by_default_and_an_injected_worker_can_tick(tmp_path, monkeypatch):
    monkeypatch.delenv("AEGIS_CORE_DISPATCH_ENABLED", raising=False)
    settings = replace(
        RuntimeSettings.from_profile("development", dry_run=True, start_detector=False, start_gui=False),
        runtime_dir=tmp_path / "runtime",
        log_dir=tmp_path / "logs",
    )
    disabled = AegisSupervisor(settings, mqtt_manager=SimpleNamespace())
    assert disabled.dispatch_worker is None

    injected = SimpleNamespace(ticks=0)
    injected.tick = lambda: setattr(injected, "ticks", injected.ticks + 1)
    enabled = AegisSupervisor(settings, mqtt_manager=SimpleNamespace(), dispatch_worker=injected)
    enabled._tick_dispatch()

    assert injected.ticks == 1
