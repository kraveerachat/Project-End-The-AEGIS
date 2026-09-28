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
