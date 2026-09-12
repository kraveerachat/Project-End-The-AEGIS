"""PR10 S2 Core dispatch ledger (spec §5.1): durable, forward-only, CUT_UPLINK only."""

from __future__ import annotations

import sqlite3

import pytest

from aegis_soc.dispatch_ledger import DispatchLedger, evidence_timestamp

ACTION_ID = "5b0e3c1e-8f6a-4c2d-9b7e-2f1a0c9d8e7f"
OTHER_ACTION_ID = "6c1f4d2f-9a7b-4d3e-8c8f-3a2b1d0e9f8a"
START = 1_788_000_000.0
EXPIRES_AT = START + 120.0
NONCE = "a1b2c3d4"


class Clock:
    def __init__(self, now: float = START):
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def ledger_path(tmp_path):
    return tmp_path / "external data" / "data" / "core-dispatch.sqlite3"


@pytest.fixture
def ledger(ledger_path, clock):
    instance = DispatchLedger(ledger_path, wall_clock=clock)
    yield instance
    instance.close()


def _published(ledger, action_id=ACTION_ID, nonce=NONCE):
    assert ledger.begin_claim(action_id, "CUT_UPLINK", EXPIRES_AT) is True
    assert ledger.mark_claimed(action_id) is True
    assert ledger.mark_published(action_id, nonce) is True


def _outbox(ledger, action_id=ACTION_ID):
    return [
        (entry["sequence"], entry["stage"], entry["detail"])
        for entry in ledger.pending_outbox()
        if entry["action_id"] == action_id
    ]


def test_c3_the_claim_intent_is_durable_and_a_replayed_action_id_is_refused(ledger_path, clock):
    first = DispatchLedger(ledger_path, wall_clock=clock)
    assert first.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT) is True
    assert first.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT) is False
    first.close()

    reopened = DispatchLedger(ledger_path, wall_clock=clock)
    try:
        assert reopened.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT) is False
        row = reopened.get(ACTION_ID)
        assert row["state"] == "CLAIM_REQUESTED"
        assert row["action"] == "CUT_UPLINK"
        assert row["expires_at"] == EXPIRES_AT
        assert row["claim_requested_at"] == START
    finally:
        reopened.close()


def test_c4_publishing_stores_the_nonce_and_queues_published_evidence(ledger, clock):
    clock.now = START + 1.5
    _published(ledger)

    row = ledger.get(ACTION_ID)
    assert row["state"] == "PUBLISHED"
    assert row["nonce"] == NONCE
    assert row["published_at"] == START + 1.5
    assert ledger.pending_outbox() == [{
        "id": 1,
        "action_id": ACTION_ID,
        "sequence": 1,
        "stage": "PUBLISHED",
        "observed_at": evidence_timestamp(START + 1.5),
        "detail": {},
    }]


def test_c4_ack_and_status_are_correlated_by_nonce_only(ledger):
    _published(ledger)

    assert ledger.record_ack("ffffffff", "OK") is None
    assert ledger.get(ACTION_ID)["state"] == "PUBLISHED"
    assert ledger.record_ack(NONCE, "OK") == ACTION_ID
    assert ledger.get(ACTION_ID)["state"] == "ACK_RECEIVED"
    assert ledger.record_status("ffffffff", "LOCKDOWN") is None
    assert ledger.get(ACTION_ID)["state"] == "ACK_RECEIVED"
    assert ledger.record_status(NONCE, "LOCKDOWN") == ACTION_ID

    assert ledger.get(ACTION_ID)["state"] == "STATUS_CORRELATED"
    assert _outbox(ledger) == [
        (1, "PUBLISHED", {}),
        (2, "ACK", {"ackCode": "OK"}),
        (3, "STATUS", {"deviceState": "LOCKDOWN"}),
    ]


def test_c4_a_correlated_normal_status_is_recorded_but_is_not_a_lockdown_correlation(ledger):
    _published(ledger)
    ledger.record_ack(NONCE, "OK")

    assert ledger.record_status(NONCE, "NORMAL") == ACTION_ID

    assert ledger.get(ACTION_ID)["state"] == "ACK_RECEIVED"
    assert _outbox(ledger)[-1] == (3, "STATUS", {"deviceState": "NORMAL"})


def test_c4_a_non_ok_ack_becomes_outcome_unknown(ledger):
    _published(ledger)

    assert ledger.record_ack(NONCE, "ERROR") == ACTION_ID

    assert ledger.get(ACTION_ID)["state"] == "OUTCOME_UNKNOWN"
    assert _outbox(ledger)[-1] == (2, "OUTCOME_UNKNOWN", {"reasonCode": "ACK_NOT_OK"})
    assert ledger.record_ack(NONCE, "OK") is None


def test_c4_a_repeated_device_status_is_recorded_once(ledger):
    _published(ledger)
    ledger.record_ack(NONCE, "OK")

    ledger.record_status(NONCE, "NORMAL")
    ledger.record_status(NONCE, "NORMAL")

    assert [entry for entry in _outbox(ledger) if entry[1] == "STATUS"] == [(3, "STATUS", {"deviceState": "NORMAL"})]


def test_c4_a_lockdown_status_before_the_ack_is_correlated_once_the_ack_arrives(ledger):
    _published(ledger)

    assert ledger.record_status(NONCE, "LOCKDOWN") == ACTION_ID
    assert ledger.get(ACTION_ID)["state"] == "PUBLISHED"
    ledger.record_ack(NONCE, "OK")

    assert ledger.get(ACTION_ID)["state"] == "STATUS_CORRELATED"
    assert _outbox(ledger) == [
        (1, "PUBLISHED", {}),
        (2, "STATUS", {"deviceState": "LOCKDOWN"}),
        (3, "ACK", {"ackCode": "OK"}),
    ]


def test_c6_only_cut_uplink_can_enter_the_ledger(ledger, ledger_path):
    for action in ("RESTORE_UPLINK", "cut_uplink", ""):
        with pytest.raises(ValueError, match="CUT_UPLINK"):
            ledger.begin_claim(OTHER_ACTION_ID, action, EXPIRES_AT)

    raw = sqlite3.connect(ledger_path)
    try:
        with pytest.raises(sqlite3.IntegrityError, match="CHECK"):
            raw.execute(
                "INSERT INTO core_dispatch_actions "
                "(action_id, action, expires_at, state, claim_requested_at, updated_at) "
                "VALUES (?, 'RESTORE_UPLINK', ?, 'CLAIM_REQUESTED', ?, ?)",
                (OTHER_ACTION_ID, EXPIRES_AT, START, START),
            )
    finally:
        raw.close()
    assert ledger.get(OTHER_ACTION_ID) is None


def test_transitions_only_move_forward_from_their_allowed_state(ledger):
    assert ledger.mark_claimed(ACTION_ID) is False
    ledger.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)

    assert ledger.mark_published(ACTION_ID, NONCE) is False
    assert ledger.mark_claimed(ACTION_ID) is True
    assert ledger.mark_claimed(ACTION_ID) is False
    assert ledger.mark_published(ACTION_ID, NONCE) is True
    assert ledger.mark_failed(ACTION_ID, "MQTT_UNAVAILABLE") is False
    assert ledger.get(ACTION_ID)["state"] == "PUBLISHED"


@pytest.mark.parametrize(
    ("mark", "state", "stage", "detail"),
    [
        (lambda ledger: ledger.mark_dry_run(ACTION_ID, NONCE), "DRY_RUN_ONLY", "DRY_RUN", {}),
        (lambda ledger: ledger.mark_failed(ACTION_ID, "MQTT_UNAVAILABLE"), "FAILED", "FAILED", {"reasonCode": "MQTT_UNAVAILABLE"}),
        (lambda ledger: ledger.mark_expired_at_core(ACTION_ID), "EXPIRED_AT_CORE", "EXPIRED_AT_CORE", {}),
    ],
)
def test_terminal_outcomes_after_a_claim_are_recorded_and_reported(ledger, mark, state, stage, detail):
    ledger.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)
    ledger.mark_claimed(ACTION_ID)

    assert mark(ledger) is True

    assert ledger.get(ACTION_ID)["state"] == state
    assert _outbox(ledger) == [(1, stage, detail)]


def test_a_rejected_claim_is_terminal_and_is_not_reported(ledger):
    ledger.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)

    assert ledger.mark_claim_rejected(ACTION_ID) is True

    assert ledger.get(ACTION_ID)["state"] == "CLAIM_REJECTED"
    assert _outbox(ledger) == []
    assert ledger.mark_claimed(ACTION_ID) is False


def test_restart_recovery_marks_every_unresolved_action_outcome_unknown_and_nothing_else(ledger):
    ids = {
        "CLAIM_REQUESTED": "11111111-1111-4111-8111-111111111111",
        "CLAIMED": "22222222-2222-4222-8222-222222222222",
        "PUBLISHED": "33333333-3333-4333-8333-333333333333",
        "ACK_RECEIVED": "44444444-4444-4444-8444-444444444444",
        "FAILED": "55555555-5555-4555-8555-555555555555",
    }
    for action_id in ids.values():
        ledger.begin_claim(action_id, "CUT_UPLINK", EXPIRES_AT)
    for state in ("CLAIMED", "PUBLISHED", "ACK_RECEIVED", "FAILED"):
        ledger.mark_claimed(ids[state])
    ledger.mark_published(ids["PUBLISHED"], "n-published")
    ledger.mark_published(ids["ACK_RECEIVED"], "n-acked")
    ledger.record_ack("n-acked", "OK")
    ledger.mark_failed(ids["FAILED"], "MQTT_UNAVAILABLE")

    recovered = ledger.recover_after_restart()

    assert sorted(recovered) == sorted(ids[state] for state in ("CLAIM_REQUESTED", "CLAIMED", "PUBLISHED", "ACK_RECEIVED"))
    for state in ("CLAIM_REQUESTED", "CLAIMED", "PUBLISHED", "ACK_RECEIVED"):
        assert ledger.get(ids[state])["state"] == "OUTCOME_UNKNOWN"
        assert _outbox(ledger, ids[state])[-1][1:] == ("OUTCOME_UNKNOWN", {"reasonCode": "CORE_RESTART"})
    assert ledger.get(ids["FAILED"])["state"] == "FAILED"
    assert ledger.recover_after_restart() == []


def test_stale_publish_and_acknowledgement_time_out_to_outcome_unknown_without_retry(ledger, clock):
    _published(ledger)
    _published(ledger, OTHER_ACTION_ID, "n-other")
    ledger.record_ack("n-other", "OK")

    clock.now = START + 7.9
    assert ledger.mark_stale_outcomes(ack_timeout_sec=8, status_timeout_sec=8) == []
    clock.now = START + 8.0
    assert sorted(ledger.mark_stale_outcomes(ack_timeout_sec=8, status_timeout_sec=8)) == sorted([ACTION_ID, OTHER_ACTION_ID])

    assert _outbox(ledger)[-1][1:] == ("OUTCOME_UNKNOWN", {"reasonCode": "ACK_TIMEOUT"})
    assert _outbox(ledger, OTHER_ACTION_ID)[-1][1:] == ("OUTCOME_UNKNOWN", {"reasonCode": "STATUS_TIMEOUT"})
    assert ledger.mark_stale_outcomes(ack_timeout_sec=8, status_timeout_sec=8) == []


def test_in_flight_covers_only_published_or_acknowledged_actions(ledger):
    assert ledger.in_flight() is False
    ledger.begin_claim(ACTION_ID, "CUT_UPLINK", EXPIRES_AT)
    ledger.mark_claimed(ACTION_ID)
    assert ledger.in_flight() is False
    ledger.mark_published(ACTION_ID, NONCE)
    assert ledger.in_flight() is True
    ledger.record_ack(NONCE, "OK")
    assert ledger.in_flight() is True
    ledger.record_status(NONCE, "LOCKDOWN")
    assert ledger.in_flight() is False


def test_outbox_is_delivered_in_order_and_each_disposition_is_kept(ledger):
    _published(ledger)
    ledger.record_ack(NONCE, "OK")
    first, second = ledger.pending_outbox()

    ledger.mark_outbox_delivered(first["id"])
    assert [entry["id"] for entry in ledger.pending_outbox()] == [second["id"]]
    ledger.mark_outbox_rejected(second["id"])

    assert ledger.pending_outbox() == []
    assert ledger.outbox_dispositions(ACTION_ID) == [(1, "DELIVERED"), (2, "REJECTED_BY_SERVER")]


def test_evidence_timestamps_are_canonical_utc_with_milliseconds():
    assert evidence_timestamp(1_788_000_000.1239) == "2026-08-29T10:40:00.123Z"
    assert evidence_timestamp(1_788_000_000.0) == "2026-08-29T10:40:00.000Z"
