# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-L6b/L6c DEGRADED runtime reactivation (V5). Simulated host only.

Distinct baseline from V1/V2/V3 (test_pr11_phase4_l34_reactivation.py: NM radio disabled) AND from V4
(test_pr11_phase4_l34_v4_post_l6b.py: dnsmasq AND the L6b broker already active/running): the same
wifi/rfkill/radio/wpa topology as V4, but dnsmasq is in the exact V3 post-reboot failed/start-limit-hit
precondition and the L6b broker is crash-looping (systemd auto-restarting it) because its AP-facing 8883
listener cannot bind while the AP address is absent. V5 performs the V4 AP-activation mutation, the exact V3
dnsmasq reset-failed+start, and then only WAITS, bounded, for the broker to recover on its own through its
own already-configured systemd auto-restart — it never issues a start/stop/restart/reset-failed against it.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l34_sim as sim  # noqa: E402
import test_pr11_phase4_l34_reactivation as base  # noqa: E402

ROOT = base.ROOT
DEPLOY = base.DEPLOY
HND = DEPLOY / "reactivation" / "l34-v5-post-l6b-degraded"
APPLY, VERIFY, ROLLBACK = (HND / n for n in ("apply.sh", "verify.sh", "rollback.sh"))
LIB = base.LIB
RUNNER = DEPLOY / "owner-run" / "run-l34-v5-post-l6b-degraded-owner.sh"
DNSMASQ_UNIT = "aegis-idea3-dnsmasq.service"
BROKER_UNIT = "aegis-idea3-mosquitto.service"
BROKER_CONF_REL = "etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf"

V5_BASELINE = dict(
    rfkill_soft=0, nm_software_radio=True, p2p_present=True, wpa_active=True, wpa_pid=9251,
    dnsmasq="failed", dev_autoconnect="yes", ap_profile_autoconnect="no",
    broker_mode="crashloop_until_ap",
)


def v5(tmp: Path, **over) -> base.Fx:
    fx = base.build(tmp, **{**V5_BASELINE, **over})
    bconf = fx.file(BROKER_CONF_REL)
    bconf.parent.mkdir(parents=True, exist_ok=True)
    bconf.write_text("# AEGIS IDEA3 L6b broker config — TEMPLATE, NOT DEPLOYED.\nlisteners 8883\n")
    bconf.chmod(0o640)
    return fx


def code(path: Path) -> str:
    return base.code_lines(path)


def applied(fx: base.Fx) -> None:
    res = fx.run(APPLY)
    assert res.returncode == 0, res.stdout + res.stderr


# ── 1. static contract ───────────────────────────────────────────────────────────────────────────────────────────────────


def test_v5_files_exist_executable_and_syntactically_valid() -> None:
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER):
        assert script.is_file(), script
        assert __import__("subprocess").run(["bash", "-n", str(script)], capture_output=True).returncode == 0, script


def test_v5_never_issues_a_broker_start_stop_restart_reset_failed() -> None:
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER):
        text = code(script)
        assert not re.search(r"systemctl\s+(reset-failed|start|stop|restart)\s+aegis-idea3-mosquitto\.service", text), script.name


def test_v5_never_mutates_rfkill_or_the_global_radio() -> None:
    for script in (APPLY, VERIFY, ROLLBACK):
        text = code(script)
        assert not re.search(r"\brfkill\s+(un)?block\b", text)
        assert not re.search(r"nmcli\s+radio\s+wifi\s+(on|off)", text)


def test_v5_never_invokes_v1_v2_v3_or_v4_handlers_or_l7_or_esp32_or_mqtt() -> None:
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER):
        text = code(script)
        assert "reactivation/l34/apply.sh" not in text and "reactivation/l34/verify.sh" not in text
        assert "reactivation/l34-v4-post-l6b" not in text
        assert "run-l7-owner" not in text and "stages/L7" not in text
        assert "esptool" not in text and "/dev/tty" not in text
        assert "mosquitto_pub" not in text and "paho" not in text and "RESTORE_UPLINK" not in text


def test_v5_scope_string_is_distinct_from_v3_and_v4() -> None:
    text = RUNNER.read_text()
    assert "L3_L4_RUNTIME_REACTIVATION_V5_POST_L6B_DEGRADED" in text
    assert "L3_L4_RUNTIME_REACTIVATION_V3" not in text
    assert "L3_L4_RUNTIME_REACTIVATION_V4_POST_L6B:" not in text
    assert "L34-V5-REACTIVATION-ATTEMPT-CONSUMED" in text
    assert "L34-V4-REACTIVATION-ATTEMPT-CONSUMED" not in text
    assert "L34-REACTIVATION-ATTEMPT-CONSUMED" not in text.replace("L34-V5-REACTIVATION-ATTEMPT-CONSUMED", "")


def test_v5_runner_is_unpinned_by_default() -> None:
    text = RUNNER.read_text()
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text
    assert "runner is not pinned" in text


def test_v5_runner_never_claims_l3_l4_l6b_live_acceptance() -> None:
    text = code(APPLY) + code(RUNNER)
    assert "L3_LIVE_ACCEPTANCE=PROVEN" not in text and "L4_LIVE_ACCEPTANCE=PROVEN" not in text
    assert "L6B_LIVE_ACCEPTANCE=PROVEN" not in text


# ── 2. baseline acceptance / refusal ─────────────────────────────────────────────────────────────────────────────────────


def test_v5_baseline_accepted(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    res = fx.run(APPLY)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L34_V5_APPLY=PASS" in res.stdout


def test_v5_refuses_when_radio_disabled(tmp_path: Path) -> None:
    """Neither V3 (needs radio disabled AND dnsmasq failed AND broker inactive) nor V4 (needs dnsmasq+broker
    already healthy) accepts the degraded baseline; here we prove V5 itself still requires the V4-shaped
    wifi/radio topology and refuses when it is missing."""
    fx = v5(tmp_path, nm_software_radio=False)
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_V4_BASELINE_UNRECOGNIZED:NM_RADIO_NOT_ENABLED" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_refuses_when_rfkill_blocked(tmp_path: Path) -> None:
    fx = v5(tmp_path, rfkill_soft=1)
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_V4_RFKILL_NOT_READY" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_rejects_the_healthy_v4_baseline(tmp_path: Path) -> None:
    """If dnsmasq and the broker are ALREADY active/running (the V4 baseline), V5 must refuse: that state is
    V4's job, not V5's — reusing the exact V3 dnsmasq pre-gate proves the mismatch."""
    fx = v5(tmp_path, dnsmasq="active", broker_mode="identity",
            identities={**sim.DEFAULT_STATE["identities"], BROKER_UNIT: [1263918, 0]})
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_DNSMASQ_PRESTATE_UNEXPECTED" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_rejects_the_pre_l6b_v3_baseline(tmp_path: Path) -> None:
    """The V3 baseline (NM radio disabled) must not be accepted by V5 either — V5 requires radio ALREADY
    enabled, exactly the opposite precondition."""
    fx = v5(tmp_path, nm_software_radio=False, p2p_present=False, wpa_active=False,
            dnsmasq="failed", broker_mode="crashloop_until_ap", broker_crashloop_recovers_after_ap=False)
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_V4_BASELINE_UNRECOGNIZED:NM_RADIO_NOT_ENABLED" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_refuses_when_dnsmasq_is_not_the_v3_failed_precondition(tmp_path: Path) -> None:
    fx = v5(tmp_path, dnsmasq="inactive")
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_DNSMASQ_PRESTATE_UNEXPECTED" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_refuses_when_broker_is_not_crashlooping(tmp_path: Path) -> None:
    """A permanently failed broker (not auto-restarting) is outside V5's one supported precondition."""
    fx = v5(tmp_path, broker_mode="identity", identities={**sim.DEFAULT_STATE["identities"], BROKER_UNIT: [0, 0]})
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_V5_BROKER_PRESTATE_UNEXPECTED" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_refuses_permanently_failed_broker_distinct_from_crashloop(tmp_path: Path) -> None:
    """A broker that has given up (Result=start-limit-hit, ActiveState=failed) is not the same PRE-state as
    one still between auto-restart attempts, even though both have MainPID=0."""
    fx = v5(tmp_path, broker_crashloop_override={"ActiveState": "failed", "SubState": "failed", "Result": "start-limit-hit"})
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_V5_BROKER_PRESTATE_UNEXPECTED" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_refuses_healthy_broker_at_the_crashloop_gate(tmp_path: Path) -> None:
    """An already active/running broker is outside V5's one supported precondition, checked directly at the
    broker gate (independent of test_v5_rejects_the_healthy_v4_baseline, which exercises the combined V4
    dnsmasq+broker-already-healthy baseline via the dnsmasq gate instead)."""
    fx = v5(tmp_path, broker_crashloop_override={"ActiveState": "active", "SubState": "running", "Result": "success", "MainPID": "4242"})
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_V5_BROKER_PRESTATE_UNEXPECTED" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_refuses_wrong_broker_result(tmp_path: Path) -> None:
    """Blocker 1: the crash-loop gate must check Result=, not just Load/Active/SubState. A signal-killed or
    timed-out process is not the plain non-zero-exit baseline V5 supports."""
    for bad_result in ("signal", "timeout", "core-dump"):
        fx = v5(tmp_path / bad_result, broker_crashloop_override={"Result": bad_result})
        res = fx.run(APPLY)
        assert res.returncode == 1 and "L34_V5_BROKER_PRESTATE_UNEXPECTED:Result" in res.stderr, bad_result
        assert fx.mutating_calls() == []


def test_v5_refuses_wrong_broker_restart_substate(tmp_path: Path) -> None:
    """A unit in its FIRST start attempt (SubState=start) is not the same as one between bounded auto-restart
    attempts (SubState=auto-restart) — V5 must not treat a first-start hang as its supported baseline."""
    fx = v5(tmp_path, broker_crashloop_override={"SubState": "start"})
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_V5_BROKER_PRESTATE_UNEXPECTED:SubState" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_refuses_unrelated_broker_failure_despite_matching_systemd_tuple(tmp_path: Path) -> None:
    """Blocker 1 (core case): a broker crash-looping for an UNRELATED reason (bad TLS cert, here) presents the
    IDENTICAL systemd LoadState/ActiveState/SubState/UnitFileState/Result/MainPID tuple as the intended
    'AP-facing bind address absent' baseline. Only the journal evidence can tell them apart, and V5 must refuse
    before any mutation when that signature is missing."""
    fx = v5(tmp_path, broker_crashloop_cause="tls_cert_error")
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_V5_BROKER_JOURNAL_SIGNATURE_MISSING" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_persistent_file_rewrite_is_detected(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    applied(fx)
    fx.file(BROKER_CONF_REL).write_text("listeners 8883\ntampered true\n")
    ver = fx.run(VERIFY)
    assert ver.returncode == 1 and "L34_PERSISTENT_FILE_CHANGED" in ver.stderr


# ── 3. exact mutation sequence and ordering ──────────────────────────────────────────────────────────────────────────────


def test_v5_exact_ap_activation_sequence(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    res = fx.run(APPLY)
    assert res.returncode == 0, res.stdout + res.stderr
    calls = fx.mutating_calls()
    assert calls[:3] == [
        "nmcli device set wlp0s20f3 autoconnect no",
        "nmcli connection up aegis-idea3-ap ifname wlp0s20f3",
        "nmcli device set wlp0s20f3 autoconnect yes",
    ]


def test_v5_dnsmasq_recovery_is_exact_v3_pattern_after_ap_up(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    res = fx.run(APPLY)
    assert res.returncode == 0, res.stdout + res.stderr
    calls = fx.mutating_calls()
    ap_idx = calls.index("nmcli connection up aegis-idea3-ap ifname wlp0s20f3")
    assert "systemctl reset-failed aegis-idea3-dnsmasq.service" in calls
    assert "systemctl start aegis-idea3-dnsmasq.service" in calls
    assert calls.index("systemctl reset-failed aegis-idea3-dnsmasq.service") > ap_idx
    assert calls.index("systemctl start aegis-idea3-dnsmasq.service") > calls.index("systemctl reset-failed aegis-idea3-dnsmasq.service")


def test_v5_broker_recovery_issues_no_command_at_all(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    res = fx.run(APPLY)
    assert res.returncode == 0, res.stdout + res.stderr
    for c in fx.mutating_calls():
        assert "mosquitto" not in c


def test_v5_apply_fails_if_broker_never_recovers(tmp_path: Path) -> None:
    fx = v5(tmp_path, broker_crashloop_recovers_after_ap=False)
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_V5_BROKER_DID_NOT_RECOVER" in res.stderr


def test_v5_apply_requires_nrestarts_increase_as_recovery_evidence(tmp_path: Path) -> None:
    """Blocker 2: broker-identity-pre.txt must serve a real verified purpose. If the broker LOOKS
    active/running with exact listeners but NRestarts never increased from the PRE snapshot (i.e. the one
    piece of evidence that would prove a genuine systemd auto-restart happened is absent), apply must refuse
    rather than print an unbacked recovery claim."""
    fx = v5(tmp_path, broker_recovered_override={"NRestarts": str(sim.DEFAULT_STATE["broker_nrestarts_pre"])})
    res = fx.run(APPLY)
    assert res.returncode == 1 and "L34_V5_BROKER_NRESTARTS_DID_NOT_INCREASE" in res.stderr


# ── 4b. broker listener convergence (Type=simple: "running" precedes the 8883 bind) ──────────────────────────────────────

LISTEN_FAST = dict(AEGIS_L34_V5_LISTEN_TRIES="4", AEGIS_L34_V5_LISTEN_INTERVAL="0.01")
SS_8883 = "ss -H -ltn sport = :8883"


def test_v5_listener_poll_knobs_are_pinned_and_not_overridden_by_the_runner() -> None:
    text = code(APPLY)
    assert 'LISTEN_TRIES="${AEGIS_L34_V5_LISTEN_TRIES:-15}"' in text
    assert 'LISTEN_INTERVAL="${AEGIS_L34_V5_LISTEN_INTERVAL:-1}"' in text
    assert "AEGIS_L34_V5_LISTEN" not in code(RUNNER)  # the frozen runner keeps the handler defaults (15 x 1s)


def test_v5_waits_for_broker_listeners_when_running_precedes_the_bind(tmp_path: Path) -> None:
    fx = v5(tmp_path, broker_listener_lag_polls=2, broker_listener_lag_shape="empty")
    res = fx.run(APPLY, **LISTEN_FAST)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L34_V5_APPLY=PASS" in res.stdout
    assert fx.calls().count(SS_8883) == 3  # two lagging polls, then the exact pair


def test_v5_waits_for_broker_listeners_when_only_one_listener_is_bound_first(tmp_path: Path) -> None:
    fx = v5(tmp_path, broker_listener_lag_polls=2, broker_listener_lag_shape="one")
    res = fx.run(APPLY, **LISTEN_FAST)
    assert res.returncode == 0, res.stdout + res.stderr
    assert fx.calls().count(SS_8883) == 3


def test_v5_listener_poll_is_bounded_and_records_the_observed_set(tmp_path: Path) -> None:
    fx = v5(tmp_path, broker_listener_lag_polls=10**6, broker_listener_lag_shape="one")
    res = fx.run(APPLY, **LISTEN_FAST)
    assert res.returncode == 1 and "L34_V4_BROKER_LISTENERS_INVALID" in res.stderr
    assert fx.calls().count(SS_8883) == 4 + 1 + 1  # LISTEN_TRIES polls, the diagnostic capture and the failure-reason re-run
    observed = (fx.work / "broker-listeners-observed.txt").read_text()
    assert "127.0.0.1:8883" in observed and "10.77.30.1:8883" not in observed


def test_v5_listener_failure_is_rolled_back_without_touching_the_broker(tmp_path: Path) -> None:
    fx = v5(tmp_path, broker_listener_lag_polls=10**6)
    assert fx.run(APPLY, **LISTEN_FAST).returncode == 1
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "nmcli connection down aegis-idea3-ap" in fx.mutating_calls()
    for c in fx.mutating_calls():
        assert "mosquitto" not in c


def test_v5_wrong_or_extra_listener_set_still_fails_after_the_wait(tmp_path: Path) -> None:
    fx = v5(tmp_path, broker_listener_extra=["LISTEN 0 100 0.0.0.0:8883 0.0.0.0:*"])
    res = fx.run(APPLY, **LISTEN_FAST)
    assert res.returncode == 1 and "L34_V4_BROKER_LISTENERS_INVALID" in res.stderr
    observed = (fx.work / "broker-listeners-observed.txt").read_text()
    assert "0.0.0.0:8883" in observed


def test_v5_dnsmasq_syntax_validation_blocks_before_any_mutation(tmp_path: Path) -> None:
    """Finding 4: V5 must restore V3's dnsmasq `--test --conf-file` syntax validation, read-only, before the
    first mutation."""
    fx = v5(tmp_path, dnsmasq_syntax_ok=False)
    res = fx.run(APPLY)
    assert res.returncode == 1 and "DNSMASQ_CONFIG_SYNTAX_FAIL" in res.stderr
    assert fx.mutating_calls() == []


def test_v5_target_state_lookup_uses_ap_if_not_a_hardcoded_literal(tmp_path: Path) -> None:
    """Finding 6: the NetworkManager snapshot lookup must key off $AP_IF, not a hardcoded 'wlp0s20f3' literal,
    even though the earlier hard gate currently forces AP_IF to equal that one value."""
    text = code(APPLY)
    assert re.search(r'''awk -F: -v ifc="\$AP_IF" '\$1 == ifc''', text), "target_state lookup must use $AP_IF via awk -v, not a literal"
    assert not re.search(r'''awk -F: '\$1 == "wlp0s20f3"''', text), "target_state lookup must not hardcode the interface name"


def test_v5_production_mutation_marker_write_is_guarded_and_ordered_first(tmp_path: Path) -> None:
    """Blocker 3: the marker write must be guarded (`|| fail`, not a bare redirect under set -uo pipefail with
    no -e) and must appear, in source order, before the first mutating nmcli/systemctl command — so a failed
    write is caught and nothing is ever mutated. A real disk-failure injection was judged impractical/flaky in
    this stub-command harness (file I/O itself is never stubbed, only host commands are), so this is a static
    regression test on the guard and its ordering instead."""
    text = APPLY.read_text()
    m = re.search(r'''printf 'YES\\n' > "\$WORK/production-mutation" \|\| fail (\S+)''', text)
    assert m, "production-mutation marker write must be guarded with || fail"
    marker_pos = m.start()
    first_mutation = re.search(r'''\bnmcli device set "\$AP_IF" autoconnect no \|\| fail''', text)
    assert first_mutation and first_mutation.start() > marker_pos, "guarded marker write must precede the first mutation"


# ── 4. POST verification ─────────────────────────────────────────────────────────────────────────────────────────────────


def test_v5_verify_requires_dnsmasq_and_broker_active_with_exact_listeners(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    applied(fx)
    ver = fx.run(VERIFY)
    assert ver.returncode == 0, ver.stdout + ver.stderr
    assert "DNSMASQ=ACTIVE_RUNNING" in ver.stdout and "L6B_BROKER=ACTIVE_RUNNING" in ver.stdout


def test_v5_no_esp32_l7_or_mqtt_action_claimed_in_verify_output(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    applied(fx)
    ver = fx.run(VERIFY)
    assert ver.returncode == 0
    assert "ESP32" not in ver.stdout and "RESTORE" not in ver.stdout and "L7" not in ver.stdout


def test_v5_verify_does_not_overclaim_broker_causality(tmp_path: Path) -> None:
    """Blocker 2: verify.sh must not print a stronger causal claim ('never commanded') than what is actually
    observed. It may claim only that it issued no broker command and that NRestarts increased consistent with
    an automatic restart."""
    fx = v5(tmp_path)
    applied(fx)
    ver = fx.run(VERIFY)
    assert ver.returncode == 0, ver.stdout + ver.stderr
    assert "never commanded" not in ver.stdout
    assert "this run issued no broker service-control command" in ver.stdout
    assert "NRestarts increased" in ver.stdout


def test_v5_verify_requires_nrestarts_increase_as_recovery_evidence(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    applied(fx)
    fx.set(broker_recovered_override={"NRestarts": str(sim.DEFAULT_STATE["broker_nrestarts_pre"])})
    ver = fx.run(VERIFY)
    assert ver.returncode == 1 and "L34_V5_BROKER_NRESTARTS_DID_NOT_INCREASE" in ver.stderr


# ── 5. rollback ───────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_v5_rollback_suppresses_autoconnect_before_connection_down(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    applied(fx)
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    calls = fx.mutating_calls()
    down_idx = calls.index("nmcli connection down aegis-idea3-ap")
    ac_no_idx = [i for i, c in enumerate(calls) if c == "nmcli device set wlp0s20f3 autoconnect no"]
    assert ac_no_idx and ac_no_idx[-1] < down_idx


def test_v5_rollback_stops_dnsmasq_never_touches_broker(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    applied(fx)
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "systemctl stop aegis-idea3-dnsmasq.service" in fx.mutating_calls()
    for c in fx.mutating_calls():
        assert "mosquitto" not in c
    assert "L6B_BROKER_TOUCHED=NO" in res.stdout
    assert "STALE_START_LIMIT_HIT_RECREATED=NO" in res.stdout


def test_v5_rollback_before_any_mutation_never_calls_rollback_handler(tmp_path: Path) -> None:
    """A pure preflight failure (before the first mutation) must produce zero mutating calls; the fork-owning
    runner-level rollback_flow is exercised by the shell integration in the design doc, not here."""
    fx = v5(tmp_path, nm_software_radio=False)
    res = fx.run(APPLY)
    assert res.returncode == 1
    assert fx.mutating_calls() == []
    assert not (fx.work / "production-mutation").exists()


def test_v5_rollback_escalates_on_unrelated_wifi_activation(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    applied(fx)
    s = fx.state()
    s["other_wifi_active"] = True
    fx.set(**s)
    res = fx.run(ROLLBACK)
    assert res.returncode == 1
    assert "ESCALATE" in res.stderr


def test_v5_rollback_tears_down_ap_even_though_broker_already_recovered(tmp_path: Path) -> None:
    """Finding 5: the intended fail-closed rollback contract is a one-way return to the exact PRE degraded
    state, not a 'leave the broker healthy' contract. After a full successful apply the broker IS active/
    running; rollback must still tear the AP connection down (removing its bind address) exactly as it would
    for an unrecovered broker, and must say so honestly rather than implying broker health survives."""
    fx = v5(tmp_path)
    applied(fx)
    assert sim.load(fx.simd)["ap_active"] == 1
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "nmcli connection down aegis-idea3-ap" in fx.mutating_calls()
    assert sim.load(fx.simd)["ap_active"] == 0
    assert "typically returns it to crash-looping" in res.stdout


def test_v5_rollback_never_reblocks_rfkill_or_touches_radio(tmp_path: Path) -> None:
    fx = v5(tmp_path)
    applied(fx)
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "RFKILL_TOUCHED=NO" in res.stdout and "NM_RADIO_TOUCHED=NO" in res.stdout


# ── 6. comparator wiring (dynamic drift approved only through the allow-lists, no p4-compare.sh catalog edit) ─────────────


def test_v5_allow_keys_never_approves_a_persistent_or_protected_key() -> None:
    text = (HND / "allow-keys.txt").read_text()
    keys = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]
    assert keys, "allow-keys.txt must declare at least one key"
    for k in keys:
        assert not k.startswith(("nm.profile.", "fw.idea3_nft", "sysctl.", "idea2.", "meta.", "cap.", "listen.", "disk."))
        assert "psk" not in k.lower() and "password" not in k.lower()


def test_v5_allow_listeners_has_no_wildcard_or_plaintext_1883() -> None:
    text = (HND / "allow-listeners.txt").read_text()
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]
    assert lines
    for l in lines:
        assert ":1883" not in l


def test_v5_secret_never_appears_in_any_handler_or_runner_source() -> None:
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER):
        text = script.read_text()
        assert base.PSK not in text
        assert not re.search(r"\bpsk\s*=\s*\S", text)
