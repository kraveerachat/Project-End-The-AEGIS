# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — V6 owner-runner TrustedClock stabilization gate (repository only).

Live attempt 2026-09-29-l34-v6-20260929-170043 failed ONLY on `time.trustedclock.state SYNCED -> UNTRUSTED` at POST and again at RB; the clock
was SYNCED/OK on every later read-only probe. The exact transient subreason was not recorded. The remediation is a bounded, read-only gate
in the V6 owner runner that reuses the existing p4-l5-clock.py acceptance predicate before the POST and the RB capture. These tests run the
real runner in the flow sandbox and prove: recovery within the bound proceeds, anything else fails closed, capture never precedes the gate,
nothing mutates the clock or a time service, and the comparator / L5 predicate / scope / V1–V5 are untouched.
"""

from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
from test_pr11_phase4_l34_v6_owner_run_flow import DEPLOY, EXPECTED_SCOPE, RUNNER, Sim, sim  # noqa: E402,F401  (sim is the shared pytest fixture)

OK = "state=SYNCED reason=OK maxerror_us=75500 adjtimex_ret=0 status=0x2001 sta_unsync=0 time_error=0"
UNTRUSTED = "state=UNTRUSTED reason=TRUSTEDCLOCK_NOT_SYNCED maxerror_us=50000 adjtimex_ret=0 status=0x2001 sta_unsync=0 time_error=0"
KERNEL_UNSYNCED = "state=UNTRUSTED reason=KERNEL_UNSYNCED maxerror_us=50000 adjtimex_ret=5 status=0x2041 sta_unsync=1 time_error=1"
MAXERROR = "state=UNTRUSTED reason=MAXERROR_EXCEEDED maxerror_us=1000001 adjtimex_ret=0 status=0x2001 sta_unsync=0 time_error=0"
UNAVAILABLE = "state=UNKNOWN reason=PROBE_UNAVAILABLE maxerror_us=-1 adjtimex_ret=UNAVAILABLE"

# sha256 pins: the comparator, the shared L5 predicate and the L0 capture must not change in the V6 remediation.
# Re-pinned for p4-compare.sh and p4-l0-capture.sh by the L7u task (2026-10-01): additive L7u observability (recovery group/runtime-dir/socket keys,
# drop-in + tmpfiles records) and the `stage L7u` token in ALLOW_L6C_RELEASE_FILE; the L5 predicate (p4-l5-clock.py) is unchanged.
# Re-pinned again by OD-F1-DEPLOY-01 (2026-10-02): additive F1 alert observability (alert group/runtime-dir/socket keys, alert tmpfiles record,
# the `alert` key family in p4-compare.sh's approvable host keys); the L5 predicate (p4-l5-clock.py) is still unchanged.
PINS = {
    "p4-compare.sh": "6caa482def07b50e462828f10ba117fb66779e9dde67e1fea8fad5b9b9f71c08",
    "p4-l5-clock.py": "dd322fbdc0538df09b8a35f01f080422e1523519d70dd8d1e7a1d9bbfd3f41f0",
    "p4-l0-capture.sh": "370c0db47ea0ceed878ec8ca5565593d67fe158529b73d4f8d548c132542e4d4",
}


def forbidden(sim: Sim) -> list[str]:
    return [c for c in sim.calls() if c.startswith("FORBIDDEN:")]


def test_committed_bound_is_the_reviewed_l5_readiness_bound() -> None:
    text = RUNNER.read_text()
    assert re.search(r"^CLOCK_STAB_TIMEOUT_S=60\b", text, re.M) and re.search(r"^CLOCK_STAB_INTERVAL_S=1\b", text, re.M)
    l5 = (DEPLOY / "stages" / "L5" / "apply.sh").read_text()
    assert "AEGIS_L5_READINESS_TIMEOUT_SEC:-60" in l5 and "AEGIS_L5_READINESS_INTERVAL_SEC:-1" in l5


def test_immediate_synced_needs_no_extra_wait_and_one_probe_per_gate(sim: Sim) -> None:
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert sim.calls().count("clock") == 1
    assert "CLOCK_STABILIZATION_POST=PASS SAMPLES=1" in res.stdout
    log = (sim.evid() / "clock-stabilization-post.log").read_text()
    assert "state=SYNCED reason=OK maxerror_us=50000 adjtimex_ret=0 status=0x2001 sta_unsync=0 time_error=0" in log and "gate=POST" in log


@pytest.mark.parametrize("transient", [UNTRUSTED, KERNEL_UNSYNCED, MAXERROR, UNAVAILABLE], ids=["untrusted", "kernel-unsynced", "maxerror", "probe-unavailable"])
def test_transient_condition_then_ok_proceeds_and_records_every_sample(sim: Sim, transient: str) -> None:
    sim.clock_seq("post", transient, transient, OK)
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert "CLOCK_STABILIZATION_POST=PASS SAMPLES=3" in res.stdout
    log = (sim.evid() / "clock-stabilization-post.log").read_text().splitlines()
    assert len([l for l in log if "gate=POST" in l]) == 3
    assert log[0].endswith(transient) and log[2].endswith(OK)  # full, unmodified predicate output for every sample
    assert sim.calls()[-5:] == ["clock", "clock", "clock", "capture:post marker=YES", "compare"]
    assert not forbidden(sim)


def test_post_never_recovering_fails_closed_before_post_capture_and_rolls_back(sim: Sim) -> None:
    sim.clock_seq("post", UNTRUSTED)
    res = sim.run()
    assert res.returncode == 1, res.stdout + res.stderr
    assert "CLOCK_STABILIZATION_POST=FAIL" in res.stdout and "Authorization is consumed" in res.stdout
    calls = sim.calls()
    assert "capture:post marker=YES" not in calls, "POST capture must not occur before stabilization success"
    assert "rollback" in calls and calls.count("apply:full marker=YES") == 1
    assert sim.marker()
    log = (sim.evid() / "clock-stabilization-post.log").read_text()
    assert UNTRUSTED in log and "CLOCK_STABILIZATION_POST=FAIL" in log


def test_malformed_probe_output_fails_closed_immediately(sim: Sim) -> None:
    sim.clock_seq("post", "garbage without fields")
    res = sim.run()
    assert res.returncode == 1 and "CLOCK_STABILIZATION_POST=FAIL" in res.stdout
    calls = sim.calls()
    assert calls[: calls.index("rollback")].count("clock") == 1, "malformed output is never retried"
    assert "capture:post marker=YES" not in sim.calls()


def test_crashing_probe_fails_closed(sim: Sim) -> None:
    sim.clock_seq("post", "@crash")
    res = sim.run()
    assert res.returncode == 1 and "CLOCK_STABILIZATION_POST=FAIL" in res.stdout
    assert "capture:post marker=YES" not in sim.calls()


@pytest.mark.parametrize("lookalike", ["state=HOLDOVER reason=OK maxerror_us=5 adjtimex_ret=0", "state=SYNCED reason=KERNEL_UNSYNCED maxerror_us=5 adjtimex_ret=0",
                                       "state=UNTRUSTED reason=OK maxerror_us=5 adjtimex_ret=0", "xstate=SYNCED reason=OK maxerror_us=5 adjtimex_ret=0"])
def test_only_the_exact_synced_ok_line_is_accepted(sim: Sim, lookalike: str) -> None:
    sim.clock_seq("post", lookalike)
    res = sim.run()
    assert res.returncode == 1 and "capture:post marker=YES" not in sim.calls()


def test_rollback_capture_waits_for_stabilization_and_recovers(sim: Sim) -> None:
    sim.flag("compare-fail")  # PRE->POST fails, so the rollback flow (handler, gate, RB capture, compare) runs
    sim.clock_seq("rb", UNTRUSTED, OK)
    res = sim.run()
    assert res.returncode == 1 and "PRE_RB_COMPARE=PASS" in res.stdout, res.stdout + res.stderr
    calls = sim.calls()
    assert calls[calls.index("rollback") :] == ["rollback", "clock", "clock", "capture:rb marker=YES", "compare"]
    assert "CLOCK_STABILIZATION_RB=PASS SAMPLES=2" in res.stdout
    assert (sim.evid() / "clock-stabilization-rb.log").read_text().count("gate=RB") == 2


def test_rollback_stabilization_failure_is_an_s11_hold_without_rb_capture(sim: Sim) -> None:
    sim.flag("compare-fail")
    sim.clock_seq("rb", KERNEL_UNSYNCED)
    res = sim.run()
    assert res.returncode == 3 and "CLOCK_STABILIZATION_RB=FAIL" in res.stdout and "S-11 HOLD" in res.stdout, res.stdout + res.stderr
    assert "capture:rb marker=YES" not in sim.calls()
    assert (sim.evid() / "clock-stabilization-rb.log").is_file()


def test_gate_never_mutates_a_time_service_or_the_clock(sim: Sim) -> None:
    sim.clock_seq("post", UNTRUSTED, KERNEL_UNSYNCED, OK)
    sim.flag("compare-fail")
    sim.clock_seq("rb", MAXERROR, OK)
    sim.run()
    assert not forbidden(sim), forbidden(sim)  # no systemctl mutation, timedatectl, chronyc, hwclock, adjtimex, ntpdate


def test_gate_source_only_invokes_the_existing_state_probe() -> None:
    text = RUNNER.read_text()
    body = re.search(r"^clock_gate\(\) \{.*?^\}", text, re.M | re.S)
    assert body, "clock_gate function missing"
    code = "\n".join(l for l in body.group(0).splitlines() if not l.lstrip().startswith("#"))
    assert '"$P4/p4-l5-clock.py" state' in code
    for token in ("systemctl", "timedatectl", "chronyc", "makestep", "burst", "set-ntp", "hwclock", "adjtimex", "date -s", "sudo", "nmcli", "mosquitto"):
        assert not re.search(rf"(?<![\w-]){re.escape(token)}(?![\w-])", code), token  # the raw-field names (adjtimex_ret) are output patterns, not commands
    assert "wait --timeout" not in code, "p4-l5-clock.py wait requires chronyd, which is inactive on the V6 host"


def test_capture_is_gated_in_the_runner_source_order() -> None:
    lines = [l for l in RUNNER.read_text().splitlines() if not l.lstrip().startswith("#")]
    def at(pattern: str) -> int:
        hits = [i for i, l in enumerate(lines) if re.search(pattern, l)]
        assert hits, pattern
        return hits[0]
    assert at(r'clock_gate POST') < at(r'capture POST "\$EVID/post-root"')
    assert at(r'clock_gate RB') < at(r'capture RB "\$EVID/rb-root"')
    assert at(r'handler rollback\.sh') < at(r'clock_gate RB')
    assert at(r"handler verify\.sh") < at(r"clock_gate POST")


def test_comparator_l5_predicate_and_l0_capture_are_unchanged() -> None:
    for rel, sha in PINS.items():
        assert hashlib.sha256((DEPLOY / rel).read_bytes()).hexdigest() == sha, f"{rel} changed"


def test_authorization_scope_is_the_frozen_188_ascii_characters() -> None:
    m = re.search(r"^EXPECTED_SCOPE='([^']+)'", RUNNER.read_text(), re.M)
    assert m and m.group(1) == EXPECTED_SCOPE
    raw = EXPECTED_SCOPE.encode("ascii")
    assert len(raw) == 188 and all(32 <= b <= 126 for b in raw)


def test_broker_mqtt_esp32_restrictions_are_unchanged() -> None:
    text = RUNNER.read_text()
    for needle in ("It NEVER issues any command", "never sends an MQTT command, never touches ESP32", "never starts L7", "NO automatic retry",
                   "BROKER_CONTROL_COMMAND_ISSUED=NO", "No ESP32, no L7, no MQTT command"):
        assert needle in text, needle
    code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
    assert not re.search(r"systemctl\s+(start|stop|restart|reload|reset-failed|kill|try-restart|enable|disable|mask)\b[^\n]*mosquitto", code)
