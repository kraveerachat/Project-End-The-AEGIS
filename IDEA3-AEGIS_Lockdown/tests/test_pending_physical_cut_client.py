"""Pending CUT client authorization display; fake socket response only."""

from aegis_soc import cut_client as cc


def _pending(source="__local__", target="LOCAL_CORE_RELAY"):
    return {
        "source": source,
        "address": "203.0.113.9",
        "request_id": "a" * 32,
        "target_name": target,
    }


def test_local_physical_publication_is_not_claimed_as_isolation():
    calls = []

    def send(path, body, *, expected_uid):
        calls.append(body)
        return {"ok": True, "code": "CUT_PUBLISHED", "msg_id": "a" * 32, "seq": 1}

    view = cc.confirm_pending_cut(
        "/tmp/not-a-real-socket",
        _pending(),
        "confirmed simulated incident",
        "test-only-secret",
        cc.CONFIRMATION,
        expected_uid=123,
        send=send,
    )

    assert view.state == "PUBLISHED"

    assert view.msg_id == "a" * 32
    assert "(seq=1)" in view.text
    assert "NOT yet verified" in view.text
    assert len(calls) == 1
    assert calls[0]["target"] == "LOCAL_CORE_RELAY"
    assert calls[0]["source"] == "__local__"


def test_unapproved_target_is_rejected_before_socket_send():
    calls = []

    def send(path, body, *, expected_uid):
        calls.append(body)
        raise AssertionError("must never reach transport")

    view = cc.confirm_pending_cut(
        "/tmp/not-a-real-socket",
        _pending("beelink", "LOCAL_CORE_RELAY"),
        "confirmed simulated incident",
        "test-only-secret",
        cc.CONFIRMATION,
        expected_uid=123,
        send=send,
    )

    assert view.state == "REFUSED_INPUT"
    assert calls == []


def test_conflicting_publication_response_is_not_success():
    def send(path, body, *, expected_uid):
        return {"ok": False, "code": "CUT_PUBLISHED"}

    view = cc.confirm_pending_cut(
        "/tmp/not-a-real-socket",
        _pending(),
        "confirmed simulated incident",
        "test-only-secret",
        cc.CONFIRMATION,
        expected_uid=123,
        send=send,
    )

    assert view.state == "OUTCOME_UNKNOWN"



def test_published_response_without_command_id_is_unknown():
    def send(path, body, *, expected_uid):
        return {"ok": True, "code": "CUT_PUBLISHED"}

    view = cc.confirm_pending_cut(
        "/tmp/not-a-real-socket",
        _pending(),
        "confirmed simulated incident",
        "test-only-secret",
        cc.CONFIRMATION,
        expected_uid=123,
        send=send,
    )

    assert view.state == "OUTCOME_UNKNOWN"

    assert view.msg_id is None
