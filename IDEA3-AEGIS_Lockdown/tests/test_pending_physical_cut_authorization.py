"""RED tests for operator-authorized pending physical CUT.

Fake command transport only. No real MQTT or relay access.
"""

from types import SimpleNamespace

from aegis_soc.remote_response import CoreRelayTarget


def test_physical_target_refuses_without_authorization():
    calls = []

    def fake_issue(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(
            ok=True,
            sent=True,
            reason_code=None,
        )

    target = CoreRelayTarget(
        fake_issue,
        "beelink",
    )

    result = target.cut("unapproved pending incident")

    assert result.ok is False
    assert result.code == "CUT_AUTHORIZATION_REQUIRED"
    assert calls == []


def test_physical_target_forwards_bound_authorization():
    calls = []

    def fake_issue(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(
            ok=True,
            sent=True,
            reason_code=None,
        )

    target = CoreRelayTarget(
        fake_issue,
        "beelink",
    )

    grant = object()
    request_id = "a" * 32
    incident_id = "simulated-incident-001"

    result = target.cut(
        "operator approved pending incident",
        cut_authorization=grant,
        cut_request_id=request_id,
        cut_incident_id=incident_id,
    )

    assert result.ok is True
    assert result.code == "CUT_SENT"

    assert len(calls) == 1

    args, kwargs = calls[0]

    assert args[0] == "CUT_UPLINK"
    assert kwargs["cut_authorization"] is grant
    assert kwargs["cut_request_id"] == request_id
    assert kwargs["cut_incident_id"] == incident_id
    assert kwargs["allow_defer"] is False


from aegis_soc import remote_response as pending_rr


def _make_pending_physical_response(*, published=True):
    calls = []

    def fake_issue(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(
            ok=published,
            sent=published,
            reason_code=None if published else "OUTCOME_UNKNOWN",
        )

    target = CoreRelayTarget(
        fake_issue,
        "beelink",
        target_name="LOCAL_CORE_RELAY",
    )

    response = pending_rr.RemoteResponse(
        sources=("beelink",),
        clock=lambda: 1000.0,
        targets={"beelink": target},
        audit=lambda *args: None,
        log=lambda *args, **kwargs: None,
        record=lambda *args: None,
        notify=lambda *args: None,
    )

    pending = response.request_cut(
        "beelink",
        "203.0.113.9",
        140,
        ("simulated_incident",),
    )

    return response, target, pending, calls


def test_pending_physical_uses_authorized_callback_once():
    response, target, pending, calls = _make_pending_physical_response()

    dispatches = []

    def authorized_dispatch(bound_target, bound_pending, description):
        assert bound_target is target
        assert bound_pending is pending
        dispatches.append(bound_pending.request_id)

        return bound_target.cut(
            description,
            cut_authorization=object(),
            cut_request_id=bound_pending.request_id,
            cut_incident_id=bound_pending.request_id,
        )

    result = response.confirm_cut(
        "beelink",
        pending.address,
        operator="uid:1000",
        request_id=pending.request_id,
        physical_cut=authorized_dispatch,
    )

    assert result == pending_rr.RelayResult(True, "CUT_SENT")
    assert dispatches == [pending.request_id]
    assert len(calls) == 1

    args, kwargs = calls[0]
    assert args[0] == "CUT_UPLINK"
    assert kwargs["cut_request_id"] == pending.request_id
    assert kwargs["cut_incident_id"] == pending.request_id
    assert kwargs["allow_defer"] is False

    assert response.pending("beelink") is None


def test_pending_physical_unknown_outcome_cannot_be_retried():
    response, target, pending, calls = _make_pending_physical_response(
        published=False
    )

    def authorized_dispatch(bound_target, bound_pending, description):
        assert bound_target is target
        assert bound_pending is pending

        return bound_target.cut(
            description,
            cut_authorization=object(),
            cut_request_id=bound_pending.request_id,
            cut_incident_id=bound_pending.request_id,
        )

    first = response.confirm_cut(
        "beelink",
        pending.address,
        operator="uid:1000",
        request_id=pending.request_id,
        physical_cut=authorized_dispatch,
    )

    assert first.ok is False
    assert first.code == "OUTCOME_UNKNOWN"

    # Never mint another approval for an uncertain physical attempt.
    assert response.pending("beelink") is None

    second = response.confirm_cut(
        "beelink",
        pending.address,
        operator="uid:1000",
        request_id=pending.request_id,
        physical_cut=authorized_dispatch,
    )

    assert second.ok is False
    assert second.code == "NO_PENDING_CUT"
    assert len(calls) == 1



def test_pending_physical_without_core_callback_remains_refused():
    response, _target, pending, calls = _make_pending_physical_response()

    result = response.confirm_cut(
        "beelink",
        pending.address,
        operator="unverified-string",
        request_id=pending.request_id,
    )

    assert result == pending_rr.RelayResult(
        False, "CUT_AUTHORIZATION_REQUIRED"
    )
    assert calls == []
    assert response.pending("beelink") is pending
