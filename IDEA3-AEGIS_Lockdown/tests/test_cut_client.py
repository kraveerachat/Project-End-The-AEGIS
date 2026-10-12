"""Desktop CUT client: truthful lifecycle, no retries, no secret retention, and an end-to-end run against the real Core fixture."""

from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest
from test_local_cut import MY_UID, REASON, SECRET, core, credential, cuts, enable, pre_dispatch_rows  # noqa: F401
from test_local_restore import p1

from aegis_soc import cut_client as cc
from aegis_soc import local_cut
from aegis_soc import local_restore as lr

MSG = "ab" * 16


def scripted(*steps):
    """A fake transport: each call consumes one step (a dict reply or an exception to raise). Records every body."""
    calls = []
    queue = list(steps)

    def send(path, body, *, expected_uid):
        calls.append(body)
        step = queue.pop(0)
        if isinstance(step, Exception):
            raise step
        return step

    send.calls = calls
    return send


def published(msg_id=MSG):
    return {"ok": True, "code": "CUT_PUBLISHED", "msg_id": msg_id, "seq": 1}


def ev(ack="PENDING", executed="NOT_OBSERVED", published_state="PUBLISHED"):
    return {"ok": True, "code": "EVIDENCE", "evidence": {"published": published_state, "ack": ack, "executed": executed,
                                                          "physical_evidence": "NOT_PROVEN"}}


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def make_flow(*steps, clock=None):
    send = scripted(*steps)
    return cc.ManualCutFlow("/run/x/cut.sock", expected_uid=1, send=send, monotonic=clock or Clock()), send


# ---- contract and isolation ------------------------------------------------------------------------------------------------
def test_wire_constants_match_the_core_channel():
    assert (cc.CUT_ORIGIN, cc.CONFIRMATION, cc.EVIDENCE_OP) == (local_cut.CUT_ORIGIN, local_cut.CONFIRMATION, local_cut.EVIDENCE_OP)
    assert cc.MAX_MESSAGE_BYTES == lr.MAX_MESSAGE_BYTES
    assert (cc.REASON_MIN_CHARS, cc.REASON_MAX_CHARS) == (lr.REASON_MIN_CHARS, lr.REASON_MAX_CHARS)
    assert cc.cut_request(REASON, SECRET).keys() == local_cut.cut_request(REASON, SECRET).keys()
    assert cc.cut_request(REASON, SECRET) == local_cut.cut_request(REASON, SECRET)
    assert cc.evidence_request(MSG) == local_cut.evidence_request(MSG)


def test_the_client_imports_only_the_standard_library():
    tree = ast.parse(Path(cc.__file__).read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "no package-relative imports"
            imported.add((node.module or "").split(".")[0])
    assert imported <= {"json", "os", "socket", "struct", "threading", "time", "collections", "dataclasses", "pwd", "__future__"}


def test_every_code_the_core_channel_can_refuse_with_has_an_honest_description():
    source = Path(local_cut.__file__).read_text(encoding="utf-8")
    codes = set(re.findall(r'_refuse\(\s*"([A-Z_]+)"', source)) | {"REASON_REQUIRED", "REASON_INVALID"}
    codes |= {"COMMAND_PENDING", "CORE_TIME_UNTRUSTED", "MQTT_UNAVAILABLE", "AUDIT_UNAVAILABLE", "EXPIRED_AT_CORE",
              "PROTOCOL_STORE_UNAVAILABLE", "PROTOCOL_NOT_CONFIGURED", "CUT_QUEUED", "CUT_DRY_RUN", "CUT_PUBLISHED"}
    missing = {code for code in codes if code not in cc._CODES}
    assert not missing, missing
    for code in codes - {"CUT_PUBLISHED", "CUT_QUEUED", "CUT_DRY_RUN"}:
        assert not cc.describe_code(code, False).text.lower().startswith("cut published")


def test_an_unknown_code_is_never_reported_as_success():
    view = cc.describe_code("SOMETHING_NEW", False)
    assert view.state == "REFUSED_OTHER" and view.terminal and "SOMETHING_NEW" in view.text


@pytest.mark.parametrize(
    "ladder,state,terminal",
    [
        ({"published": "NOT_PUBLISHED", "ack": "NOT_APPLICABLE", "executed": "NOT_APPLICABLE"}, "NOT_SENT", True),
        ({"published": "OUTCOME_UNKNOWN", "ack": "OUTCOME_UNKNOWN", "executed": "OUTCOME_UNKNOWN"}, "OUTCOME_UNKNOWN", True),
        ({"published": "PUBLISHED", "ack": "PENDING", "executed": "NOT_OBSERVED"}, "ACK_PENDING", False),
        ({"published": "PUBLISHED", "ack": "ACCEPTED", "executed": "NOT_OBSERVED"}, "ACK_ACCEPTED", False),
        ({"published": "PUBLISHED", "ack": "ACCEPTED", "executed": "DEVICE_REPORTED_LOCKDOWN"}, "DEVICE_REPORTED_LOCKDOWN", True),
        ({"published": "PUBLISHED", "ack": "ACCEPTED", "executed": "DEVICE_STATUS_CORRELATED"}, "DEVICE_STATUS_CORRELATED", True),
        ({"published": "PUBLISHED", "ack": "REJECTED_EXPIRED", "executed": "NOT_OBSERVED"}, "REJECTED", True),
        ({"published": "PUBLISHED", "ack": "OUTCOME_UNKNOWN", "executed": "NOT_OBSERVED"}, "OUTCOME_UNKNOWN", True),
        ({"published": "PUBLISHED", "ack": "???", "executed": "NOT_OBSERVED"}, "OUTCOME_UNKNOWN", True),
    ],
)
def test_the_evidence_ladder_maps_to_an_honest_lifecycle_state(ladder, state, terminal):
    view = cc.describe_evidence(ladder, MSG)
    assert view.state == state and view.terminal is terminal and view.msg_id == MSG


def test_no_state_ever_claims_physical_disconnection():
    for ack in ("PENDING", "ACCEPTED", "REJECTED_EXPIRED", "OUTCOME_UNKNOWN"):
        for executed in ("NOT_OBSERVED", "DEVICE_REPORTED_LOCKDOWN", "DEVICE_STATUS_CORRELATED"):
            view = cc.describe_evidence({"published": "PUBLISHED", "ack": ack, "executed": executed}, MSG)
            assert "physical disconnection is proven" not in view.text.lower()
            if view.state in {"DEVICE_REPORTED_LOCKDOWN", "DEVICE_STATUS_CORRELATED", "ACK_ACCEPTED", "ACK_PENDING"}:
                assert "not proven" in view.text.lower()


# ---- flow ------------------------------------------------------------------------------------------------------------------
def test_a_full_lifecycle_ends_in_a_terminal_protocol_state_and_frees_the_flow():
    flow, send = make_flow(published(), ev("PENDING"), ev("ACCEPTED"), ev("ACCEPTED", "DEVICE_REPORTED_LOCKDOWN"))
    first = flow.submit(REASON, SECRET)
    assert first.state == "PUBLISHED" and not first.terminal and flow.busy
    assert flow.poll().state == "ACK_PENDING" and flow.busy
    assert flow.poll().state == "ACK_ACCEPTED" and flow.busy
    last = flow.poll()
    assert last.state == "DEVICE_REPORTED_LOCKDOWN" and last.terminal and not flow.busy
    assert [call["op"] for call in send.calls] == ["CUT_UPLINK", "CUT_EVIDENCE", "CUT_EVIDENCE", "CUT_EVIDENCE"]


def test_a_second_submit_while_one_is_tracked_sends_nothing():
    flow, send = make_flow(published())
    flow.submit(REASON, SECRET)
    again = flow.submit(REASON, SECRET)
    assert again.state == "REFUSED_BUSY" and len(send.calls) == 1


def test_a_lost_reply_is_unknown_and_is_never_retried():
    flow, send = make_flow(cc.OutcomeUnknown("lost"))
    view = flow.submit(REASON, SECRET)
    assert view.state == "OUTCOME_UNKNOWN" and view.terminal and not flow.busy
    assert "not retried" in view.text.lower() and len(send.calls) == 1
    assert flow.poll().state == "OUTCOME_UNKNOWN" and len(send.calls) == 1  # nothing to track, nothing sent


def test_an_unreachable_core_reports_nothing_was_sent():
    flow, send = make_flow(cc.ChannelUnavailable("the Core CUT channel is unavailable"))
    view = flow.submit(REASON, SECRET)
    assert view.state == "CHANNEL_UNAVAILABLE" and "nothing was sent" in view.text.lower() and not flow.busy


@pytest.mark.parametrize("reason,secret", [("", SECRET), ("short", SECRET), ("x" * 300, SECRET), (REASON, ""), (REASON, None), (None, SECRET)])
def test_local_input_problems_are_refused_before_any_send(reason, secret):
    flow, send = make_flow()
    view = flow.submit(reason, secret)
    assert view.state in {"REFUSED_INPUT", "REFUSED_AUTH"} and send.calls == [] and not flow.busy


@pytest.mark.parametrize("code,state", [
    ("AUTH_FAILED", "REFUSED_AUTH"), ("AUTH_LOCKED_OUT", "REFUSED_LOCKED"), ("AUDIT_UNAVAILABLE", "REFUSED_AUDIT"),
    ("COMMAND_PENDING", "REFUSED_PENDING"), ("CORE_TIME_UNTRUSTED", "REFUSED_TIME"), ("MQTT_UNAVAILABLE", "NOT_SENT"),
    ("PEER_REFUSED", "REFUSED_PEER"),
])
def test_core_refusals_are_reported_as_not_sent_and_not_tracked(code, state):
    flow, send = make_flow({"ok": False, "code": code, "msg_id": None})
    view = flow.submit(REASON, SECRET)
    assert view.state == state and view.terminal and not flow.busy
    assert "nothing" in view.text.lower() or "not" in view.text.lower()


def test_a_queued_cut_has_no_id_and_is_not_presented_as_sent():
    flow, _ = make_flow({"ok": True, "code": "CUT_QUEUED", "msg_id": None})
    view = flow.submit(REASON, SECRET)
    assert view.state == "QUEUED" and not flow.busy and "no command id" in view.text.lower()


def test_a_publish_without_an_id_is_treated_as_unknown():
    flow, _ = make_flow({"ok": True, "code": "CUT_PUBLISHED", "msg_id": None})
    assert flow.submit(REASON, SECRET).state == "OUTCOME_UNKNOWN"


def test_the_absence_of_an_ack_times_out_to_an_unknown_state_without_retry():
    clock = Clock()
    flow, send = make_flow(published(), ev("PENDING"), ev("PENDING"), clock=clock)
    flow.submit(REASON, SECRET)
    assert flow.poll().state == "ACK_PENDING"
    clock.now += cc.EVIDENCE_TIMEOUT_SEC + 1
    view = flow.poll()
    assert view.state == "NO_ACK_TIMEOUT" and view.terminal and not flow.busy
    assert [c["op"] for c in send.calls].count("CUT_UPLINK") == 1


def test_repeated_evidence_failures_end_in_an_honest_unavailable_state():
    flow, _ = make_flow(published(), *[cc.OutcomeUnknown("x")] * cc.MAX_EVIDENCE_ERRORS)
    flow.submit(REASON, SECRET)
    states = [flow.poll().state for _ in range(cc.MAX_EVIDENCE_ERRORS)]
    assert states[-1] == "EVIDENCE_UNAVAILABLE" and not flow.busy


def test_a_rejected_ack_is_never_shown_as_success():
    flow, _ = make_flow(published(), ev("REJECTED_EXPIRED"))
    flow.submit(REASON, SECRET)
    view = flow.poll()
    assert view.state == "REJECTED" and "NOT cut" in view.text


def test_the_secret_is_never_retained():
    flow, send = make_flow(published())
    view = flow.submit(REASON, "this-secret-must-not-be-kept-1")
    blob = repr(vars(flow)) + repr(view) + repr(flow.view)
    assert "this-secret-must-not-be-kept-1" not in blob


# ---- end to end against the real Core fixture ------------------------------------------------------------------------------
def test_end_to_end_against_the_real_core_channel(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    flow = cc.ManualCutFlow(path, expected_uid=MY_UID)
    first = flow.submit(REASON, SECRET)
    assert first.state == "PUBLISHED" and first.msg_id and flow.busy
    assert [c.fields["msg_id"] for c in cuts(core)] == [first.msg_id] and len(pre_dispatch_rows(core)) == 1
    assert flow.poll().state == "ACK_PENDING"
    seq = cuts(core)[0].fields["seq"]
    core.deliver(p1.ACK, ack_for_msg_id=first.msg_id, ack_for_seq=seq, result="ACCEPTED")
    assert flow.poll().state == "ACK_ACCEPTED"
    core.deliver(p1.STATUS, output_state="LOCKDOWN", reason="COMMAND", cmd_msg_id=first.msg_id, cmd_seq=seq, device_seq_hwm=seq)
    final = flow.poll()
    assert final.state == "DEVICE_REPORTED_LOCKDOWN" and final.terminal and not flow.busy
    assert "NOT proven" in final.text


def test_end_to_end_refusals_publish_nothing(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    wrong = cc.ManualCutFlow(path, expected_uid=MY_UID).submit(REASON, "definitely the wrong secret")
    assert wrong.state == "REFUSED_AUTH" and core.commands() == []
    ok = cc.ManualCutFlow(path, expected_uid=MY_UID)
    assert ok.submit(REASON, SECRET).state == "PUBLISHED"
    pending = cc.ManualCutFlow(path, expected_uid=MY_UID).submit(REASON, SECRET)  # a second Desktop instance
    assert pending.state == "REFUSED_PENDING" and len(cuts(core)) == 1 and len(pre_dispatch_rows(core)) == 1


def test_end_to_end_an_impostor_server_uid_is_refused(core, monkeypatch, tmp_path):
    path = enable(monkeypatch, core, tmp_path)
    core.supervisor.start_local_cut()
    view = cc.ManualCutFlow(path, expected_uid=MY_UID + 1).submit(REASON, SECRET)
    assert view.state == "CHANNEL_UNAVAILABLE" and core.commands() == []
