"""Desktop RESTORE client: wire constants match the Core gate, and the lifecycle never claims more than the Core said."""

from __future__ import annotations

import pytest

from aegis_soc import local_restore as lr
from aegis_soc import restore_client as rc


def test_wire_constants_match_the_core_gate():
    assert rc.CONFIRMATION == lr.CONFIRMATION
    assert rc.LOCAL_REQUEST_ORIGIN == lr.LOCAL_REQUEST_ORIGIN
    assert rc.MAX_MESSAGE_BYTES == lr.MAX_MESSAGE_BYTES
    assert (rc.REASON_MIN_CHARS, rc.REASON_MAX_CHARS, rc.REASON_MAX_BYTES) == (
        lr.REASON_MIN_CHARS, lr.REASON_MAX_CHARS, lr.REASON_MAX_BYTES)
    body = rc.restore_request("lab acceptance restore", "s", rc.CONFIRMATION)
    assert body == lr.restore_request("s", rc.CONFIRMATION, "lab acceptance restore")
    assert rc.evidence_request("ab" * 16) == lr.evidence_request("ab" * 16)


def test_the_client_imports_nothing_from_aegis_soc():
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(rc))
    imported = {node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    assert not any(name.startswith((".", "aegis_soc")) or name == "" for name in imported - {"__future__", "collections.abc", "dataclasses"})


class Sender:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.bodies = []

    def __call__(self, path, body, *, expected_uid):
        self.bodies.append(body)
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def flow(sender, clock=None):
    clock = clock or [0.0]
    return rc.ManualRestoreFlow("/run/x.sock", expected_uid=1000, send=sender, monotonic=lambda: clock[0]), clock


def test_publish_then_evidence_to_device_reported_normal():
    sender = Sender(
        {"ok": True, "code": "PUBLISHED", "msg_id": "ab" * 16},
        {"ok": True, "code": "EVIDENCE", "evidence": {"published": "PUBLISHED", "ack": "PENDING"}},
        {"ok": True, "code": "EVIDENCE", "evidence": {"published": "PUBLISHED", "ack": "ACCEPTED",
                                                      "executed": "DEVICE_REPORTED_NORMAL"}},
    )
    f, _ = flow(sender)
    assert f.submit("lab acceptance restore", "secret").state == "PUBLISHED" and f.busy
    assert sender.bodies[0]["secret"] == "secret" and sender.bodies[0]["confirmation"] == rc.CONFIRMATION
    assert f.poll().state == "ACK_PENDING"
    final = f.poll()
    assert final.state == "DEVICE_REPORTED_NORMAL" and final.terminal and not f.busy
    assert "NOT proven" in final.text


@pytest.mark.parametrize("reason, secret, confirmation, state", [
    ("short", "s", rc.CONFIRMATION, "REFUSED_INPUT"),
    ("lab acceptance restore", "", rc.CONFIRMATION, "REFUSED_AUTH"),
    ("lab acceptance restore", "s", "restore uplink", "REFUSED_INPUT"),
])
def test_local_refusals_send_nothing(reason, secret, confirmation, state):
    sender = Sender()
    f, _ = flow(sender)
    assert f.submit(reason, secret, confirmation).state == state
    assert sender.bodies == []


@pytest.mark.parametrize("code, state", [
    ("AUTH_FAILED", "REFUSED_AUTH"), ("RESTORE_ALREADY_PENDING", "REFUSED_PENDING"),
    ("UPLINK_NOT_LOCKDOWN", "REFUSED_STATE"), ("RECOVERY_PRECONDITION_UNMET", "REFUSED_POLICY"),
    ("DRY_RUN", "DRY_RUN"), ("SOMETHING_NEW", "REFUSED_OTHER"),
])
def test_core_refusals_are_reported_as_said(code, state):
    f, _ = flow(Sender({"ok": False, "code": code}))
    view = f.submit("lab acceptance restore", "s")
    assert view.state == state and view.terminal and not f.busy


def test_a_lost_reply_is_outcome_unknown_and_never_retried():
    sender = Sender(rc.OutcomeUnknown("lost"))
    f, _ = flow(sender)
    view = f.submit("lab acceptance restore", "s")
    assert view.state == "OUTCOME_UNKNOWN" and "Do NOT run it again" in view.text
    assert len(sender.bodies) == 1


def test_a_second_submit_while_busy_sends_nothing():
    sender = Sender({"ok": True, "code": "PUBLISHED", "msg_id": "ab" * 16})
    f, _ = flow(sender)
    f.submit("lab acceptance restore", "s")
    assert f.submit("lab acceptance restore", "s").state == "REFUSED_BUSY"
    assert len(sender.bodies) == 1


def test_no_evidence_within_the_deadline_times_out_without_retrying():
    sender = Sender({"ok": True, "code": "PUBLISHED", "msg_id": "ab" * 16},
                    {"ok": True, "code": "EVIDENCE", "evidence": {"published": "PUBLISHED", "ack": "PENDING"}})
    f, clock = flow(sender)
    f.submit("lab acceptance restore", "s")
    clock[0] += rc.EVIDENCE_TIMEOUT_SEC + 1
    view = f.poll()
    assert view.state == "NO_ACK_TIMEOUT" and not f.busy
    assert [b["op"] for b in sender.bodies] == ["RESTORE_UPLINK", "RESTORE_EVIDENCE"]


def test_a_device_rejection_is_reported_as_not_restored():
    sender = Sender({"ok": True, "code": "PUBLISHED", "msg_id": "ab" * 16},
                    {"ok": True, "code": "EVIDENCE", "evidence": {"published": "PUBLISHED", "ack": "REJECTED_REPLAY"}})
    f, _ = flow(sender)
    f.submit("lab acceptance restore", "s")
    view = f.poll()
    assert view.state == "REJECTED" and "NOT restored" in view.text
