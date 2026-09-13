"""PR10 S2 shared Web <-> Core dispatch contract: the Core side.

The Web suite reads the same fixture. Every effect here is local and simulated:
temporary SQLite files, injected clocks, fake transports, fake clients, and a
fake supervisor command owner.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from aegis_soc import config
from aegis_soc.controller import CommandResult
from aegis_soc.dispatch_client import (
    ACTION_ID,
    CANONICAL_TIMESTAMP,
    ClaimResult,
    DispatchClient,
    DispatchUnavailable,
    PendingAction,
    ReportResult,
)
from aegis_soc.dispatch_ledger import DISPATCHABLE_ACTIONS, DispatchLedger, evidence_timestamp
from aegis_soc.dispatch_worker import DispatchWorker

CONTRACT = json.loads((Path(__file__).parent / "fixtures" / "dispatch-contract.json").read_text(encoding="utf-8"))
ROUTE = CONTRACT["machineRoute"]
EVIDENCE = CONTRACT["evidence"]
ACTION_ID_VALUE = CONTRACT["action"]["validActionIds"][0]
# A placeholder machine route on a reserved .invalid name; never contacted.
BASE_URL = f"https://idea3-core.aegis.invalid{ROUTE['productionBasePath']}"
START = 1_788_000_000.0


class Clock:
    def __init__(self, now=START):
        self.now = now

    def __call__(self):
        return self.now


class FakeTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, body, headers):
        self.calls.append((method, url, None if body is None else json.loads(body)))
        status, document = self.responses.pop(0)
        return status, json.dumps(document).encode("utf-8")


class FakeClient:
    """Serves one pending action; report is unreachable so every emitted entry stays queued."""

    def __init__(self, action, claim):
        self.action = action
        self.claim_result = claim

    def list_pending(self):
        return [self.action]

    def claim(self, _action_id):
        if isinstance(self.claim_result, BaseException):
            raise self.claim_result
        return self.claim_result

    def report(self, _action_id, _entry):
        raise DispatchUnavailable("NETWORK")


class FakeSupervisor:
    def __init__(self, result):
        self.status = SimpleNamespace(armed="ARMED")
        self.pending_command = None
        self.result = result

    def issue_command(self, action, _description, **_kwargs):
        if self.result.sent:
            self.pending_command = {"action": action, "nonce": self.result.nonce}
        return self.result


SENT = CommandResult("CUT_UPLINK", True, True, False, "contract-nonce", "SENT")
DRY_RUN = CommandResult("CUT_UPLINK", True, False, True, "contract-nonce", "WOULD_SEND")
NOT_SENT = CommandResult("CUT_UPLINK", False, False, False, None, "MQTT unavailable")


def _run_worker(tmp_path, name, *, command=SENT, claim=None, claim_offset=100.0, after=None):
    clock = Clock()
    ledger = DispatchLedger(tmp_path / f"{name}.sqlite3", wall_clock=clock)
    action = PendingAction(ACTION_ID_VALUE, "CUT_UPLINK", "2026-09-12T08:00:00.000Z", clock.now + 100.0)
    worker = DispatchWorker(
        FakeSupervisor(command),
        ledger,
        FakeClient(action, ClaimResult("CLAIMED", clock.now + claim_offset) if claim is None else claim),
        wall_clock=clock,
    )
    try:
        worker.tick()
        if after is not None:
            after(worker, clock)
        return ledger.pending_outbox()
    finally:
        ledger.close()


def _core_emitted_entries(tmp_path):
    nonce = SENT.nonce

    def acked_then_status(worker, _clock):
        worker.on_ack("OK", nonce)
        worker.on_status("NORMAL", nonce)
        worker.on_status("LOCKDOWN", nonce)

    def ack_not_ok(worker, _clock):
        worker.on_ack("ERROR", nonce)

    def ack_timeout(worker, clock):
        clock.now += config.ACK_TIMEOUT_SEC
        worker.tick()

    def status_timeout(worker, clock):
        worker.on_ack("OK", nonce)
        clock.now += config.PHYSICAL_CONFIRM_TIMEOUT_SEC
        worker.tick()

    entries = []
    entries += _run_worker(tmp_path, "acked", after=acked_then_status)
    entries += _run_worker(tmp_path, "ack-not-ok", after=ack_not_ok)
    entries += _run_worker(tmp_path, "ack-timeout", after=ack_timeout)
    entries += _run_worker(tmp_path, "status-timeout", after=status_timeout)
    entries += _run_worker(tmp_path, "dry-run", command=DRY_RUN)
    entries += _run_worker(tmp_path, "not-sent", command=NOT_SENT)
    entries += _run_worker(tmp_path, "claim-uncertain", claim=DispatchUnavailable("NETWORK"))
    entries += _run_worker(tmp_path, "expired-at-core", claim_offset=0.0)

    clock = Clock()
    ledger = DispatchLedger(tmp_path / "restart.sqlite3", wall_clock=clock)
    try:
        ledger.begin_claim(ACTION_ID_VALUE, "CUT_UPLINK", clock.now + 100.0)
        DispatchWorker(FakeSupervisor(SENT), ledger, FakeClient(None, None), wall_clock=clock).start()
        entries += ledger.pending_outbox()
    finally:
        ledger.close()
    return entries


def _key(stage, detail):
    return stage, json.dumps(detail, sort_keys=True)


def test_core_action_rules_match_the_contract():
    assert DISPATCHABLE_ACTIONS == frozenset(CONTRACT["action"]["dispatchable"])
    pattern = re.compile(CONTRACT["action"]["actionIdPattern"])
    for action_id in CONTRACT["action"]["validActionIds"]:
        assert pattern.fullmatch(action_id) and ACTION_ID.fullmatch(action_id)
    for action_id in CONTRACT["action"]["invalidActionIds"]:
        assert not pattern.fullmatch(action_id) and not ACTION_ID.fullmatch(action_id)


def test_the_ledger_never_accepts_an_action_the_contract_forbids(tmp_path):
    ledger = DispatchLedger(tmp_path / "forbidden.sqlite3", wall_clock=Clock())
    try:
        for action in CONTRACT["action"]["neverDispatchable"]:
            with pytest.raises(ValueError, match="CUT_UPLINK"):
                ledger.begin_claim(ACTION_ID_VALUE, action, START + 100.0)
    finally:
        ledger.close()


def test_the_ledger_outbox_stage_check_matches_the_contract_stages(tmp_path):
    path = tmp_path / "stages.sqlite3"
    DispatchLedger(path, wall_clock=Clock()).close()
    raw = sqlite3.connect(path)
    try:
        raw.execute(
            "INSERT INTO core_dispatch_actions (action_id, action, expires_at, state, claim_requested_at, updated_at) "
            "VALUES (?, 'CUT_UPLINK', ?, 'CLAIMED', ?, ?)",
            (ACTION_ID_VALUE, START + 100.0, START, START),
        )
        insert = (
            "INSERT INTO core_reconciliation_outbox (action_id, sequence, stage, observed_at, detail_json) "
            "VALUES (?, ?, ?, ?, '{}')"
        )
        for sequence, stage in enumerate(EVIDENCE["stages"], start=1):
            raw.execute(insert, (ACTION_ID_VALUE, sequence, stage, CONTRACT["timestamps"]["valid"][0]))
        for stage in ("CONTAINED", "RELAY_EVIDENCE", "EXECUTED"):
            with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
                raw.execute(insert, (ACTION_ID_VALUE, 999, stage, CONTRACT["timestamps"]["valid"][0]))
    finally:
        raw.close()


def test_core_timestamps_match_the_contract_and_invalid_ones_are_refused():
    pattern = re.compile(CONTRACT["timestamps"]["pattern"])
    for value in (evidence_timestamp(START), evidence_timestamp(START + 0.1239), *CONTRACT["timestamps"]["valid"]):
        assert pattern.fullmatch(value) and CANONICAL_TIMESTAMP.fullmatch(value)
    listing = CONTRACT["examples"]["listPending"]
    for value in CONTRACT["timestamps"]["invalid"]:
        body = {"actions": [{**listing["actions"][0], "expiresAt": value}]}
        with pytest.raises(DispatchUnavailable) as raised:
            DispatchClient(BASE_URL, FakeTransport((200, body))).list_pending()
        assert raised.value.reason == "PROTOCOL"


def test_the_core_emits_exactly_the_contract_evidence_set_and_nothing_outside_the_allowlist(tmp_path):
    entries = _core_emitted_entries(tmp_path)
    allow = EVIDENCE["detailAllowlist"]
    reason = re.compile(allow["reasonCodePattern"])
    timestamp = re.compile(CONTRACT["timestamps"]["pattern"])

    assert {_key(entry["stage"], entry["detail"]) for entry in entries} == {
        _key(item["stage"], item["detail"]) for item in EVIDENCE["coreEmitted"]
    }
    for entry in entries:
        assert entry["stage"] in EVIDENCE["stages"]
        assert EVIDENCE["sequence"]["min"] <= entry["sequence"] <= EVIDENCE["sequence"]["max"]
        assert timestamp.fullmatch(entry["observed_at"])
        for key, value in entry["detail"].items():
            assert key in {"ackCode", "deviceState", "reasonCode"}
            if key == "reasonCode":
                assert reason.fullmatch(value)
            else:
                assert value in allow[key]


def test_the_core_client_parses_the_pinned_web_responses_and_uses_the_pinned_paths():
    listing = CONTRACT["examples"]["listPending"]
    success = CONTRACT["examples"]["claimSuccess"]
    transport = FakeTransport((200, listing), (200, success))
    client = DispatchClient(BASE_URL, transport)

    [action] = client.list_pending()
    claimed = client.claim(success["actionId"])

    assert action.action_id == listing["actions"][0]["actionId"]
    assert action.action in CONTRACT["action"]["dispatchable"]
    assert claimed == ClaimResult("CLAIMED", action.expires_at)
    assert transport.calls == [
        (ROUTE["listPending"]["method"], f"{BASE_URL}{ROUTE['listPending']['path']}", None),
        (
            ROUTE["claim"]["method"],
            f"{BASE_URL}{ROUTE['claim']['path'].replace('{actionId}', success['actionId'])}",
            ROUTE["claim"]["requestBody"],
        ),
    ]
    accepted = listing["actions"][0]["acceptedAt"]
    accepted_epoch = DispatchClient(BASE_URL, FakeTransport((200, {"actions": [{**listing["actions"][0], "expiresAt": accepted}]}))).list_pending()[0].expires_at
    assert (action.expires_at - accepted_epoch) * 1000 == CONTRACT["action"]["ttlMs"]


def test_the_core_client_maps_every_pinned_refusal_outcome_and_identity_rejection():
    for refusal in ROUTE["claim"]["refusals"]:
        transport = FakeTransport((refusal["status"], {"error": {"code": refusal["code"]}}))
        assert DispatchClient(BASE_URL, transport).claim(ACTION_ID_VALUE) == ClaimResult(refusal["coreResult"])

    entry = {"sequence": 1, "stage": "PUBLISHED", "observedAt": CONTRACT["timestamps"]["valid"][0], "detail": {}}
    for outcome in ROUTE["report"]["outcomes"]:
        body = {"status": outcome["serverStatus"]} if "serverStatus" in outcome else {"error": {"code": outcome["code"]}}
        transport = FakeTransport((outcome["status"], body))
        assert DispatchClient(BASE_URL, transport).report(ACTION_ID_VALUE, entry) == ReportResult(outcome["coreResult"])
        assert transport.calls[0][1] == f"{BASE_URL}{ROUTE['report']['path'].replace('{actionId}', ACTION_ID_VALUE)}"

    rejected = ROUTE["identityRejected"]
    transport = FakeTransport((rejected["status"], {"error": {"code": rejected["code"]}}))
    with pytest.raises(DispatchUnavailable) as raised:
        DispatchClient(BASE_URL, transport).list_pending()
    assert raised.value.reason == rejected["coreReason"]
