"""Behavioural tests of the governed Recovery R2-R8 stage DRIVER (``aegis_soc.recovery_stage``): registry, the operator-side ladder, D4 handling and the claim boundary.

Everything runs against a scripted fake Core client and temporary directories. No socket, SQLite Core, nft, MQTT, service or ESP32 is touched; Recovery LIVE is never executed."""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent / "recovery"))
import recovery_support as sup  # noqa: E402

from aegis_soc import recovery_protocol as rp  # noqa: E402
from aegis_soc import recovery_stage as stage  # noqa: E402

INC = {"id": 7, "attacker_ip": "203.0.113.9"}


def gate(name: str, status: str = rp.VERIFIED, detail: str = "", summary: str = "") -> dict:
    return {"gate": name, "status": status, "summary": summary, "detail": detail}


class Core:
    """A scripted Core: each op returns the configured reply; every call is recorded exactly as the stage sent it."""

    def __init__(self, **replies):
        self.calls: list[tuple] = []
        self.replies = {
            rp.OP_STATUS: self.ok("STATUS", [gate(rp.R1), gate(rp.R3, "PENDING"), gate(rp.R4, "PENDING"), gate(rp.R5, "PENDING"), gate(rp.R8, "PENDING")]),
            rp.OP_PROBE: self.ok("PROBED", [gate(rp.R2, summary="ok", detail="x"), gate(rp.R6, summary="2 network probe(s) passed"), gate(rp.R7, detail="a=OK")]),
            rp.OP_ISOLATE: self.ok("R3_VERIFIED", [gate(rp.R3)]),
            rp.OP_RESTORE_STATUS: self.restore(),
            rp.OP_CLOSE: self.ok("CLOSED", []),
        }
        self.replies.update({getattr(rp, key) if key.startswith("OP_") else key: value for key, value in replies.items()})

    @staticmethod
    def ok(code: str, gates: list, extra: dict | None = None, ok: bool = True) -> dict:
        return {"v": 1, "ok": ok, "code": code, "detail": "", "data": {"incident": dict(INC), "gates": gates, **(extra or {})}}

    @staticmethod
    def restore(ack: str = "ACCEPTED", executed: str = "DEVICE_REPORTED_NORMAL", r45: str = rp.VERIFIED, break_glass: str = "NONE") -> dict:
        return Core.ok("RESTORE_STATUS", [gate(rp.R4, r45), gate(rp.R5, r45)], {"restore": {"requested": "YES", "published": "YES", "ack": ack, "executed": executed}, "break_glass_restore": break_glass})

    def __call__(self, op: str, summary: str | None = None):
        self.calls.append((op,) if summary is None else (op, summary))
        reply = self.replies[op]
        if isinstance(reply, Exception):
            raise reply
        return reply


def steps(tmp_path: Path) -> str:
    path = tmp_path / "steps"
    path.mkdir(exist_ok=True)
    return str(path)


def to_d4(core: Core, tmp_path: Path) -> str:
    s = steps(tmp_path)
    for fn in (stage.step_status, stage.step_probe_pre, stage.step_isolate, stage.step_probe_post_isolate):
        fn(core, s)
    return s


def run_ladder(core: Core, tmp_path: Path, *, d4: int = 0) -> str:
    s = to_d4(core, tmp_path)
    stage.record_d4(s, d4)
    stage.step_restore_status(core, s)
    stage.step_probe_final(core, s)
    stage.step_close(core, s, "Recovery completed through the Core normal-path closure.")
    return s


# --------------------------------------------------------------------------- registry (kept) + claim boundary


def test_recovery_is_registered_once_after_rru_before_l8_mutating_with_no_gap_and_no_authorization_extra() -> None:
    order = sup.stages()
    assert order.count("Recovery") == 1 and order[order.index("R1Bv") + 1] == "RRu" and order[order.index("RRu") + 1] == "CTu" and order[order.index("CTu") + 1] == "CTv" and order[order.index("CTv") + 1] == "Recovery" and order[order.index("Recovery") + 1] == "L8"
    out = sup.bash(f'. "{sup.P4_LIB}"; p4_stage_known Recovery && p4_stage_mutates Recovery && echo MUTATES; p4_stage_gaps Recovery; echo "extra=[$(p4_stage_auth_extra Recovery)]"; p4_stage_handler_status Recovery').stdout.split("\n")
    assert out[0] == "MUTATES" and out[1] == "none" and out[2] == "extra=[]" and out[3] == "REGISTERED"
    assert "L10" not in order and not any(name.startswith("Recovery") and name != "Recovery" for name in order)  # exactly ONE Recovery stage, no new unnecessary stage
    gate_text = (sup.P4 / "p4-stage-gate.sh").read_text()
    assert "p4_stage_mutates" in gate_text and "K3_MISSING" in gate_text and '[ "$STAGE" = Recovery ]' in gate_text


def test_the_claim_constants_never_promote_prior_failures_or_later_stages() -> None:
    assert stage.CLAIMS == {"F1_REAL_DETECTOR_ACCEPTANCE": "NOT_PROVEN", "R1_VERIFIED": "NOT_CLAIMED", "LVR_PROVEN": "NO", "L8_ACCEPTANCE": "NO", "L9_PROVEN": "NO", "R1B_RESULT": "FAIL_IMMUTABLE",
                            "R1B_RESULT_REWRITTEN": "NO", "R1BV_RESULT": "PASS", "R1BV_RESULT_REWRITTEN": "NO", "RECOVERY_PROMOTION": "NOT_AUTOMATIC"}


# --------------------------------------------------------------------------- Core derives the target; the stage accepts nothing


def test_isolate_sends_only_the_operation_and_no_target_and_core_derives_it() -> None:
    assert rp._PARAMS[rp.OP_ISOLATE] == frozenset()
    core = Core()
    with tempfile.TemporaryDirectory() as tmp:
        s = steps(Path(tmp))
        stage.step_status(core, s)
        stage.step_probe_pre(core, s)
        stage.step_isolate(core, s)
    assert core.calls[2] == (rp.OP_ISOLATE,)  # no argument at all: not an IP, not a path, not a command
    core_text = (sup.ROOT / "aegis_soc/recovery_core.py").read_text()
    assert "def isolate(self)" in core_text and "parse_ipv4(incident.get" in core_text


def test_no_cli_surface_accepts_an_attacker_ip_a_secret_or_break_glass_and_there_is_no_direct_write_path() -> None:
    text = (sup.ROOT / "aegis_soc/recovery_stage.py").read_text()
    for forbidden in ("--ip", "--attacker", "--secret", "--password", "--break-glass", "import subprocess", "paho", "restore_request", "INSERT", "UPDATE incidents", "close_incident", "publish("):
        assert forbidden not in text, forbidden
    with pytest.raises(SystemExit):
        stage.main(["isolate", "--steps-dir", "x", "--ip", "1.2.3.4"], request=Core())


# --------------------------------------------------------------------------- the ordered, once-only ladder


def test_the_full_ladder_runs_in_the_fixed_order_with_one_core_call_per_step(tmp_path: Path) -> None:
    core = Core()
    s = run_ladder(core, tmp_path)
    assert [c[0] for c in core.calls] == [rp.OP_STATUS, rp.OP_PROBE, rp.OP_ISOLATE, rp.OP_PROBE, rp.OP_RESTORE_STATUS, rp.OP_PROBE, rp.OP_CLOSE]
    assert sorted(p.name for p in Path(s).iterdir()) == sorted(v[0] for v in stage.LADDER.values())
    assert json.loads((Path(s) / "01-status.json").read_text())["authority"] == "OPERATOR_TRACE_NON_AUTHORITATIVE"


@pytest.mark.parametrize("first", ["probe_pre", "isolate", "probe_post_isolate", "restore_status", "probe_final", "close"])
def test_a_step_refuses_without_its_recorded_verified_predecessors(tmp_path: Path, first: str) -> None:
    core = Core()
    fn = getattr(stage, f"step_{first}")
    args = (core, steps(tmp_path), "Recovery completed through the Core normal-path closure.") if first == "close" else (core, steps(tmp_path))
    with pytest.raises(stage.StageError, match="PREDECESSOR_MISSING"):
        fn(*args)
    assert core.calls == []  # nothing was asked of the Core


def test_every_step_runs_once_and_is_never_overwritten(tmp_path: Path) -> None:
    core = Core()
    s = steps(tmp_path)
    stage.step_status(core, s)
    before = (Path(s) / "01-status.json").read_text()
    with pytest.raises(stage.StageError, match="STEP_ALREADY_RECORDED"):
        stage.step_status(core, s)
    assert (Path(s) / "01-status.json").read_text() == before and len(core.calls) == 1


def test_prior_recovery_progress_for_the_bound_incident_refuses_the_first_step(tmp_path: Path) -> None:
    core = Core(OP_STATUS=Core.ok("STATUS", [gate(rp.R1), gate(rp.R3)]))
    with pytest.raises(stage.StageError, match="RECOVERY_ALREADY_PROGRESSED"):
        stage.step_status(core, steps(tmp_path))


def test_an_unverified_isolation_stops_the_ladder_and_records_nothing(tmp_path: Path) -> None:
    core = Core(OP_ISOLATE=Core.ok("R3_FAILED", [gate(rp.R3, rp.FAILED)], ok=False))
    s = steps(tmp_path)
    stage.step_status(core, s)
    stage.step_probe_pre(core, s)
    with pytest.raises(stage.StageError, match="ISOLATE_NOT_VERIFIED"):
        stage.step_isolate(core, s)
    assert not (Path(s) / "03-isolate.json").exists()


def test_a_changed_incident_between_steps_is_refused(tmp_path: Path) -> None:
    core = Core()
    s = steps(tmp_path)
    stage.step_status(core, s)
    changed = Core.ok("PROBED", [gate(rp.R2)])
    changed["data"]["incident"] = {"id": 8, "attacker_ip": "203.0.113.9"}
    core.replies[rp.OP_PROBE] = changed
    with pytest.raises(stage.StageError, match="INCIDENT_CHANGED"):
        stage.step_probe_pre(core, s)


# --------------------------------------------------------------------------- D4: one owner-interactive normal RESTORE; never resent


@pytest.mark.parametrize("code,meaning", [(0, "D4_ACCEPTED"), (3, "D4_NOT_CONFIRMED_NORMAL_RECONCILE_READ_ONLY")])
def test_d4_exit_0_and_3_continue_only_into_read_only_reconciliation(tmp_path: Path, code: int, meaning: str) -> None:
    core = Core()
    s = to_d4(core, tmp_path)
    assert stage.record_d4(s, code)["meaning"] == meaning and "NORMAL_OBSERVED" not in json.dumps(stage.D4_MEANING)
    doc = json.loads((Path(s) / "05-d4.json").read_text())
    assert doc["retry"] == "NEVER" and doc["resend"] == "NEVER" and doc["verified"] is True
    stage.step_restore_status(core, s)  # read-only RESTORE_STATUS only
    assert core.calls[-1] == (rp.OP_RESTORE_STATUS,) and rp.OP_ISOLATE not in [c[0] for c in core.calls[4:]]


@pytest.mark.parametrize("code", [1, 2, 4, 5, 255])
def test_d4_exit_1_2_4_and_anything_else_is_terminal_and_never_resent(tmp_path: Path, code: int) -> None:
    core = Core()
    s = to_d4(core, tmp_path)
    with pytest.raises(stage.StageError, match="D4_STOP"):
        stage.record_d4(s, code)
    with pytest.raises(stage.StageError, match="PREDECESSOR_NOT_VERIFIED:D4"):
        stage.step_restore_status(core, s)  # the ladder cannot continue
    with pytest.raises(stage.StageError, match="STEP_ALREADY_RECORDED"):
        stage.record_d4(s, 0)  # a second D4 can never be recorded: there is no retry
    assert core.calls[-1] == (rp.OP_PROBE,) and not (Path(s) / "06-restore-status.json").exists()


@pytest.mark.parametrize("code", [-1, 256, "0", None, 1.5])
def test_a_malformed_d4_exit_code_is_refused(tmp_path: Path, code) -> None:
    core = Core()
    s = to_d4(core, tmp_path)
    with pytest.raises(stage.StageError, match="D4_EXIT_CODE_INVALID"):
        stage.record_d4(s, code)


# --------------------------------------------------------------------------- R4/R5 normal-path evidence only; break-glass can never count


@pytest.mark.parametrize("reply,code", [
    (Core.restore(break_glass="CLAIMED"), "BREAK_GLASS_REPORTED_OR_UNKNOWN"),
    (Core.restore(break_glass="UNKNOWN"), "BREAK_GLASS_REPORTED_OR_UNKNOWN"),
    (Core.restore(ack="OUTCOME_UNKNOWN", r45="PENDING"), "OUTCOME_UNKNOWN"),
    (Core.restore(ack="REJECTED_BAD", r45="PENDING"), "RESTORE_NOT_ACCEPTED_OR_LOCKDOWN"),
    (Core.restore(executed="DEVICE_REPORTED_LOCKDOWN", r45="PENDING"), "RESTORE_NOT_ACCEPTED_OR_LOCKDOWN"),
    (Core.restore(ack="NONE", executed="NOT_OBSERVED"), "R5_WITHOUT_CORRELATED_ACK_AND_STATUS_NORMAL"),
])
def test_restore_status_refuses_break_glass_unknown_rejected_lockdown_and_uncorrelated_evidence(tmp_path: Path, reply: dict, code: str) -> None:
    core = Core(OP_RESTORE_STATUS=reply)
    s = to_d4(core, tmp_path)
    stage.record_d4(s, 0)
    with pytest.raises(stage.StageError, match=code):
        stage.step_restore_status(core, s)
    assert not (Path(s) / "06-restore-status.json").exists()


def test_r4_r5_not_yet_verified_waits_read_only_until_the_deadline_and_never_resends(tmp_path: Path) -> None:
    core = Core(OP_RESTORE_STATUS=Core.restore(r45="PENDING", ack="NONE", executed="NOT_OBSERVED"))
    s = to_d4(core, tmp_path)
    stage.record_d4(s, 3)
    clock = {"t": 0.0}
    with pytest.raises(stage.StageError, match="R4_R5_NOT_VERIFIED_BEFORE_DEADLINE"):
        stage.step_restore_status(core, s, wait_seconds=6.0, sleep=lambda dt: clock.__setitem__("t", clock["t"] + dt), monotonic=lambda: clock["t"])
    assert len([c for c in core.calls if c[0] == rp.OP_RESTORE_STATUS]) >= 2 and all(c[0] in (rp.OP_RESTORE_STATUS,) for c in core.calls[4:])  # only read-only polls
    with pytest.raises(stage.StageError, match="WAIT_OUT_OF_RANGE"):
        stage.step_restore_status(core, s, wait_seconds=stage.MAX_WAIT_SEC + 1)


# --------------------------------------------------------------------------- R6/R7 only after a verified R5; R8 only through the Core CLOSE


def test_r6_r7_are_probed_only_after_a_verified_r5(tmp_path: Path) -> None:
    core = Core()
    s = to_d4(core, tmp_path)
    stage.record_d4(s, 0)
    stage.step_restore_status(core, s)
    path = Path(s) / "06-restore-status.json"
    doc = json.loads(path.read_text())
    doc["gates"][rp.R5] = "PENDING"
    path.write_text(json.dumps(doc))
    calls = len(core.calls)
    with pytest.raises(stage.StageError, match="R6_R7_REQUIRE_VERIFIED_R5"):
        stage.step_probe_final(core, s)
    assert len(core.calls) == calls  # the Core was never probed for R6/R7


@pytest.mark.parametrize("bad", [rp.R2, rp.R6, rp.R7])
def test_close_is_unreachable_unless_r2_r6_r7_are_verified_by_the_final_probe(tmp_path: Path, bad: str) -> None:
    core = Core()
    s = to_d4(core, tmp_path)
    stage.record_d4(s, 0)
    stage.step_restore_status(core, s)
    gates = [gate(rp.R2), gate(rp.R6, summary="1 network probe(s) passed"), gate(rp.R7, detail="a=OK")]
    for g in gates:
        if g["gate"] == bad:
            g["status"] = "FAILED"
    core.replies[rp.OP_PROBE] = Core.ok("PROBED", gates)
    with pytest.raises(stage.StageError, match="GATE_NOT_VERIFIED"):
        stage.step_probe_final(core, s)
    with pytest.raises(stage.StageError, match="PREDECESSOR_MISSING"):
        stage.step_close(core, s, "Recovery completed through the Core normal-path closure.")
    assert all(c[0] != rp.OP_CLOSE for c in core.calls)


def test_the_core_close_is_the_only_closer_and_a_refusal_records_nothing(tmp_path: Path) -> None:
    core = Core(OP_CLOSE=Core.ok("CLOSURE_REFUSED", [], ok=False))
    s = to_d4(core, tmp_path)
    stage.record_d4(s, 0)
    stage.step_restore_status(core, s)
    stage.step_probe_final(core, s)
    with pytest.raises(stage.StageError, match="CLOSE_REFUSED"):
        stage.step_close(core, s, "Recovery completed through the Core normal-path closure.")
    assert not (Path(s) / "08-close.json").exists()


# --------------------------------------------------------------------------- the owner reason (C1): the production validator, shell-safe


@pytest.mark.parametrize("reason", ["", "   ", None, "x", "a" * 241, "bad\nline", "uses $(whoami)", "back`tick`", "slash\\x", "\u202eevil reason text"])
def test_a_missing_or_invalid_reason_is_refused(reason) -> None:
    with pytest.raises(stage.StageError):
        stage.check_reason(reason)


def test_a_valid_non_secret_reason_passes_and_a_leading_dash_is_safe_through_the_cli(capsys) -> None:
    assert stage.check_reason("Owner-approved normal restore after containment") == "REASON_OK"
    assert stage.main(["check-reason", "--reason=-Owner reason starting with a dash"]) == 0
    assert "RECOVERY_REASON_OK" in capsys.readouterr().out
    assert stage.main(["check-reason", "--reason=bad $(x) reason"]) == 1
