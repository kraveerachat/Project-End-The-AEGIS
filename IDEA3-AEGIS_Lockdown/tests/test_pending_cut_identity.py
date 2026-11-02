"""Pending CUT identity tests. No physical commands or sockets."""

import re

from aegis_soc import remote_response as rr


def make_gate():
    target = rr.DryRunRelayTarget()
    gate = rr.RemoteResponse(
        sources=["beelink"],
        clock=lambda: 123.0,
        targets={"beelink": target},
        audit=lambda *args: None,
        log=lambda *args, **kwargs: None,
        record=lambda *args: None,
        notify=lambda *args: None,
    )
    return gate, target


def test_pending_has_unique_request_id_and_target_binding():
    gate, target = make_gate()

    first = gate.request_cut(
        "beelink", "198.51.100.25", 140, ("critical",)
    )

    assert re.fullmatch(r"[0-9a-f]{32}", first.request_id)
    assert first.created_at == 123.0
    assert first.source == "beelink"
    assert first.address == "198.51.100.25"
    assert first.target_name == "DRYRUN"
    assert target.would_cut == []

    second = gate.request_cut(
        "beelink", "198.51.100.25", 140, ("critical",)
    )

    assert second.request_id != first.request_id
    assert gate.pending("beelink") == second
    assert target.would_cut == []

 
def test_confirmation_requires_current_request_id():
    gate, target = make_gate()
    address = "198.51.100.25"

    pending = gate.request_cut(
        "beelink", address, 140, ("critical",)
    )

    missing = gate.confirm_cut(
        "beelink", address, operator="lab-operator"
    )
    assert missing.code == "REQUEST_ID_REQUIRED"

    wrong = gate.confirm_cut(
        "beelink", address,
        operator="lab-operator",
        request_id="0" * 32,
    )
    assert wrong.code == "REQUEST_ID_MISMATCH"
    assert target.would_cut == []

    accepted = gate.confirm_cut(
        "beelink", address,
        operator="lab-operator",
        request_id=pending.request_id,
    )
    assert accepted == rr.RelayResult(True, "WOULD_CUT")

    replay = gate.confirm_cut(
        "beelink", address,
        operator="lab-operator",
        request_id=pending.request_id,
    )
    assert replay.code == "NO_PENDING_CUT"
    assert len(target.would_cut) == 1


def test_replaced_request_rejects_previous_id():
    gate, target = make_gate()
    address = "198.51.100.25"

    old = gate.request_cut(
        "beelink", address, 140, ("critical",)
    )
    current = gate.request_cut(
        "beelink", address, 160, ("critical",)
    )

    refused = gate.confirm_cut(
        "beelink", address,
        operator="lab-operator",
        request_id=old.request_id,
    )

    assert refused.code == "REQUEST_ID_MISMATCH"
    assert gate.pending("beelink") == current
    assert target.would_cut == []


def test_expired_pending_cannot_cut():
    gate, target = make_gate()
    now = [123.0]
    gate._clock = lambda: now[0]

    pending = gate.request_cut(
        "beelink", "198.51.100.25", 140, ("critical",)
    )

    now[0] += 121.0

    refused = gate.confirm_cut(
        "beelink", "198.51.100.25",
        operator="lab-operator",
        request_id=pending.request_id,
    )

    assert refused.code == "PENDING_EXPIRED"
    assert gate.pending("beelink") is None
    assert target.would_cut == []

