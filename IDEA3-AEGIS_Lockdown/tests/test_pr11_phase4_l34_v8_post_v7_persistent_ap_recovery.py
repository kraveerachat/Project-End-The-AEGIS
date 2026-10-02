# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L3/L4 POST-V7 PERSISTENT AP RECOVERY (V8, OD-L34-V8-01). Simulated host only.

V7 was RUNTIME_ONLY (K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN): two reboots later the host is back in the radio-disabled / AP-down / broker-churn state.
V8 is a NEW one-shot stage that recovers that state exactly like V7 AND makes ONE persistent change: NetworkManager aegis-idea3-ap connection.autoconnect
no -> yes. These tests prove the exact baseline, the ordered mutation set, the journal-before-mutation rule, the single persistent change, the rollback
that restores autoconnect=no and owns only journaled changes, and the absence of any broker/Core/rfkill-state-file/network-state command.
Live race proven on 2026-10-01: `nmcli radio wifi on` then an immediate unbound `connection up` failed because NetworkManager had not yet moved
wlp0s20f3 unavailable -> disconnected. The bounded ready-wait is the load-bearing control and runs BEFORE the persistent modify.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l34_sim as sim  # noqa: E402
import test_pr11_phase4_l34_reactivation as base  # noqa: E402

DEPLOY = base.DEPLOY
HND = DEPLOY / "reactivation" / "l34-v8-post-v7-persistent-ap-recovery"
APPLY, VERIFY, ROLLBACK = (HND / n for n in ("apply.sh", "verify.sh", "rollback.sh"))
RUNNER = DEPLOY / "owner-run" / "run-l34-v8-post-v7-persistent-ap-recovery-owner.sh"
LIB = base.LIB
DNSMASQ_UNIT = "aegis-idea3-dnsmasq.service"
BROKER_UNIT = "aegis-idea3-mosquitto.service"
CORE_UNIT = "aegis-idea3-core.service"
BROKER_CONF_REL = "etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf"
BROKER_CONF = "# AEGIS IDEA3 L6b broker config — TEMPLATE, NOT DEPLOYED.\nlistener 8883 127.0.0.1\nlistener 8883 10.77.30.1\n"
V7_MARKER = "# ── V7 (RADIO-DISABLED + BROKER-CHURN) reactivation"
PROBE_ARGS = "tls --address 10.77.30.1 --port 8883 --server-name mqtt.aegis.home.arpa --ca-file /etc/aegis-idea3/mqtt/ca.crt --repo-root"

# The exact live baseline (RESIDUAL safe-equivalent network state left by the 2026-10-01 owner attempt):
V8_BASELINE = dict(
    rfkill_soft=1, rfkill_hard=0, nm_software_radio=False, p2p_present=True, wpa_active=True, wpa_pid=9251, phy_country="TH",
    dnsmasq="failed", dev_autoconnect="yes", ap_profile_autoconnect="no", broker_mode="crashloop_until_ap",
    identities={**sim.DEFAULT_STATE["identities"], CORE_UNIT: [883, 0]},
)

PROBE_FIXTURE = """#!/usr/bin/env bash
echo "PROBE $*" >> "$AEGIS_L34_SIM_DIR/calls.log"
case "$(cat "$0.mode")" in
  pass) echo "L7_BROKER_TLS_PROBE=PASS tls=TLSv1.3" ;;
  fail) echo "L7_BROKER_TLS_PROBE=FAIL reason=TLS_VERIFY_FAILED"; exit 1 ;;
esac
"""


def v8(tmp: Path, probe: str = "pass", broker_conf: str = BROKER_CONF, **over) -> base.Fx:
    fx = base.build(tmp, **{**V8_BASELINE, **over})
    bconf = fx.file(BROKER_CONF_REL)
    bconf.parent.mkdir(parents=True, exist_ok=True)
    bconf.write_text(broker_conf)
    bconf.chmod(0o640)
    probe_path = tmp / "probe-fixture.sh"
    probe_path.write_text(PROBE_FIXTURE)
    probe_path.chmod(0o755)
    Path(f"{probe_path}.mode").write_text(probe)
    fx.probe = probe_path  # type: ignore[attr-defined]
    return fx


def run(fx: base.Fx, script: Path, **extra: str):
    env = dict(
        AEGIS_L34_NM_TRIES="8", AEGIS_L34_V8_STABLE_INTERVAL="0.01", AEGIS_L34_V8_TRIES="4", AEGIS_L34_V8_INTERVAL="0.01",
        AEGIS_L34_V8_PROBE_CMD=str(fx.probe), AEGIS_L34_V8_PROBE_TIMEOUT="20",  # type: ignore[attr-defined]
    )
    env.update(extra)
    return fx.run(script, **env)


def applied(fx: base.Fx):
    res = run(fx, APPLY)
    assert res.returncode == 0, res.stdout + res.stderr
    return res


def code(path: Path) -> str:
    return base.code_lines(path)


def lib_v7() -> str:
    return LIB.read_text().split(V7_MARKER, 1)[1]


def broker_commands(fx: base.Fx) -> list[str]:
    """Every recorded call that targets the broker unit other than the read-only `systemctl show` / `journalctl` reads."""
    return [c for c in fx.calls() if "aegis-idea3-mosquitto" in c and not c.startswith(("systemctl show", "journalctl -u"))]


def journal_kinds(fx: base.Fx) -> list[str]:
    return [l.split("\t")[0] for l in (fx.work / "journal.tsv").read_text().splitlines() if l]


def no_mutation(fx: base.Fx) -> None:
    assert fx.mutating_calls() == [], fx.mutating_calls()
    assert not (fx.work / "production-mutation").exists()


ALL_SCRIPTS = [APPLY, VERIFY, ROLLBACK, RUNNER]

# ── 1. static contract ───────────────────────────────────────────────────────────────────────────────────────────────────


def test_v8_files_exist_and_are_syntactically_valid() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-keys-rollback.txt", "allow-listeners.txt"):
        assert (HND / name).is_file(), name
    for script in (*ALL_SCRIPTS, LIB):
        assert subprocess.run(["bash", "-n", str(script)], capture_output=True).returncode == 0, script


def test_v8_never_issues_any_broker_control_command() -> None:  # L
    for script in ALL_SCRIPTS:
        text = code(script)
        assert not re.search(r"systemctl\s+(reset-failed|start|stop|restart|try-restart|reload|kill|enable|disable|mask)\s+\S*mosquitto", text), script.name
        assert not re.search(r"systemctl\s+(reset-failed|start|stop|restart|try-restart|reload|kill|enable|disable|mask)\s+\"?\$\{?BROKER_UNIT", text), script.name
        assert not re.search(r"\b(pkill|killall|kill)\b", text), script.name
        assert not re.search(r"systemctl\s+\S+\s+\S*mosquitto", text.replace("systemctl show", "")), script.name


def test_v8_never_issues_a_core_control_command() -> None:  # M
    for script in ALL_SCRIPTS:
        text = code(script)
        assert not re.search(r"systemctl\s+(reset-failed|start|stop|restart|try-restart|reload|kill|enable|disable|mask)\s+\S*aegis-idea3-core", text)
        assert not re.search(r"systemctl\s+(reset-failed|start|stop|restart|try-restart|reload|kill)\s+\"?\$\{?CORE_UNIT", text)


def test_v8_handlers_never_touch_firewall_nat_forwarding_profile_or_broker_config() -> None:
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER):
        text = code(script).replace('trap \'rm -f "$BROKER_JOURNAL_PREGATE" "$BROKER_SHOW_PREGATE"\' EXIT', "")  # the runner's only rm: its own mktemp broker captures
        for pat in (r"\bnft\s+(add|delete|flush|-f|insert|replace)", r"sysctl\s+-w", r"nmcli\s+connection\s+(delete|add|reload|import|edit|clone)", r"nmcli\s+connection\s+modify\s+(?!\"\$L34_CONN\"\s+connection\.autoconnect\s+)", r"/var/lib/systemd/rfkill",
                    r"NetworkManager\.state", r"/var/lib/NetworkManager", r"systemctl\s+(enable|disable|mask|unmask|preset)",
                    r"rfkill\s+(un)?block\s+all", r"iw\s+reg\s+set", r"\btee\s+/etc", r"\bsed\s+-i", r"\brm\s", r"\bmv\s", r"esptool",
                    r"mosquitto_pub", r"\bpaho\b", r"run-l7-owner", r"stages/L7", r"stages/L8", r"recovery_r[1-8]"):
            assert not re.search(pat, text, re.M), (script.name, pat)


def test_v8_does_not_weaken_or_invoke_the_existing_handlers() -> None:
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER):
        text = code(script)
        for other in ("reactivation/l34/apply.sh", "reactivation/l34/verify.sh", "reactivation/l34-v4-post-l6b", "reactivation/l34-v5-post-l6b-degraded",
                      "reactivation/l34-v6-stale-broker-ap-down", "run-l34-reactivation-owner.sh", "l34-v7-radio-disabled-broker-churn",
                      "run-l34-v7-radio-disabled-broker-churn-owner.sh", "stages/L7u", "run-l7u-owner"):
            assert other not in text, (script.name, other)


def test_v8_activation_is_always_ifname_bound_and_the_radio_is_enabled_exactly_once() -> None:  # C
    text = code(APPLY)
    assert len(re.findall(r"nmcli\s+radio\s+wifi\s+on", text)) == 1
    assert "l3_nm_activate" in text and "l3_nm_wait_ready" in text
    assert text.index("nmcli radio wifi on") < text.index("l3_nm_wait_ready") < text.index("l3_nm_activate")
    assert not re.search(r"nmcli\s+connection\s+up\s+\S+\s*$", text, re.M)
    assert "nmcli radio wifi on" not in code(VERIFY) and "nmcli radio wifi on" not in code(ROLLBACK)


def test_v8_lib_section_is_additive_and_isolated() -> None:
    lib = LIB.read_text()
    assert V7_MARKER in lib
    for name in re.findall(r"^(l34_v7_[a-z_0-9]+)\(\)", lib_v7(), re.M):
        for script in (DEPLOY / "reactivation" / d / f for d in ("l34", "l34-v4-post-l6b", "l34-v5-post-l6b-degraded", "l34-v6-stale-broker-ap-down")
                       for f in ("apply.sh", "verify.sh", "rollback.sh")):
            assert name not in script.read_text(), (name, script)


def test_v8_runner_is_unpinned_and_states_its_non_claims() -> None:
    text = RUNNER.read_text()
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text and "runner is not pinned" in text
    assert "RECOVERY_R1_R8_PROVEN=NO" in text and "L8_AUTHORIZED=NO" in text and "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN" in text
    assert "L34-V8-REACTIVATION-ATTEMPT-CONSUMED" in text
    assert "L3_L4_RUNTIME_RECOVERY_V8_POST_V7_PERSISTENT_AP" in text
    assert "L3_L4_RUNTIME_REACTIVATION_V7" not in text, "V8 never reuses the V7 scope"
    assert "L3_LIVE_ACCEPTANCE=PROVEN" not in text and "L6B_LIVE_ACCEPTANCE=PROVEN" not in text and "K12_AUTOMATIC_REBOOT_PERSISTENCE=PROVEN" not in text


# ── 2. baseline acceptance (A) ───────────────────────────────────────────────────────────────────────────────────────────


def test_v8_exact_current_baseline_is_accepted(tmp_path: Path) -> None:  # A
    fx = v8(tmp_path)
    res = applied(fx)
    assert "L34_V8_APPLY=PASS" in res.stdout and "PRODUCTION_MUTATION_PERFORMED=YES" in res.stdout
    assert "L34_BASELINE=RESIDUAL" in res.stdout
    st = fx.state()
    assert st["rfkill_soft"] == 0 and st["ap_active"] == 1 and st["dnsmasq"] == "active" and st["nm_software_radio"] is True
    assert st["dev_autoconnect"] == "yes", "device autoconnect restored to its PRE value"


def test_v8_fresh_post_reboot_baseline_is_also_accepted(tmp_path: Path) -> None:
    fx = v8(tmp_path, phy_country="00", p2p_present=False, wpa_active=False, nm_init_side_effects=True)
    res = applied(fx)
    assert "L34_BASELINE=FRESH" in res.stdout


def test_v8_preflight_only_mutates_nothing(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    res = run(fx, APPLY, AEGIS_L34_PREFLIGHT_ONLY="YES")
    assert res.returncode == 0 and "L34_V8_PREFLIGHT=PASS" in res.stdout and "PRODUCTION_MUTATION_PERFORMED=NO" in res.stdout
    no_mutation(fx)


# ── 3. the readiness race (B, C) ─────────────────────────────────────────────────────────────────────────────────────────


def test_v8_activation_waits_until_the_device_is_disconnected(tmp_path: Path) -> None:  # B
    fx = v8(tmp_path, nm_ready_lag_polls=3)
    res = applied(fx)
    assert "L3_NM_TARGET_STATE=unavailable" in res.stdout and "L3_NM_TARGET_STATE=disconnected" in res.stdout
    ups = [c for c in fx.calls() if c.startswith("nmcli connection up")]
    assert ups == ["nmcli connection up aegis-idea3-ap ifname wlp0s20f3"], "exactly one activation, never a retry"
    calls = fx.calls()
    assert calls.index("nmcli radio wifi on") < calls.index(ups[0])


def test_v8_bounded_readiness_wait_fails_closed_without_activating(tmp_path: Path) -> None:  # B
    fx = v8(tmp_path, nm_ready_lag_polls=50)
    res = run(fx, APPLY, AEGIS_L34_NM_TRIES="3")
    assert res.returncode == 1 and "NM_TARGET_DEVICE_NOT_READY" in res.stderr
    assert not any(c.startswith("nmcli connection up") for c in fx.calls()), "never activates before disconnected"


def test_v8_activation_is_explicitly_bound_to_the_target_interface(tmp_path: Path) -> None:  # C
    fx = v8(tmp_path)
    applied(fx)
    for c in fx.calls():
        if c.startswith("nmcli connection up"):
            assert c.endswith("ifname wlp0s20f3") and " aegis-idea3-ap " in c


def test_v8_autoconnect_is_off_before_the_radio_is_enabled_and_restored_after(tmp_path: Path) -> None:
    fx = v8(tmp_path, autoconnect_profile_in_range=True)
    res = applied(fx)
    calls = fx.calls()
    assert calls.index("nmcli device set wlp0s20f3 autoconnect no") < calls.index("nmcli radio wifi on")
    assert calls[-1 - calls[::-1].index("nmcli device set wlp0s20f3 autoconnect yes")] == "nmcli device set wlp0s20f3 autoconnect yes"
    assert fx.state()["other_wifi_active"] is False and "L34_V8_APPLY=PASS" in res.stdout


# ── 4. baseline refusals (E, F, G, H, I, J, K) ───────────────────────────────────────────────────────────────────────────


def test_v8_refuses_hard_blocked_rfkill(tmp_path: Path) -> None:  # G
    fx = v8(tmp_path, rfkill_hard=1)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "RFKILL_HARD_BLOCKED" in res.stderr
    no_mutation(fx)


def test_v8_requires_the_target_to_be_soft_blocked(tmp_path: Path) -> None:
    fx = v8(tmp_path, rfkill_soft=0)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V8_RFKILL_NOT_SOFT_BLOCKED" in res.stderr
    no_mutation(fx)


def test_v8_refuses_when_the_radio_is_already_enabled(tmp_path: Path) -> None:
    fx = v8(tmp_path, rfkill_soft=0, nm_software_radio=True)
    res = run(fx, APPLY)
    assert res.returncode == 1 and not (fx.work / "production-mutation").exists()
    no_mutation(fx)


def test_v8_refuses_an_active_wifi_connection(tmp_path: Path) -> None:  # H
    fx = v8(tmp_path, other_wifi_active=True)
    res = run(fx, APPLY)
    assert res.returncode == 1
    no_mutation(fx)


def test_v8_refuses_the_wrong_interface(tmp_path: Path) -> None:  # I
    fx = v8(tmp_path)
    res = run(fx, APPLY, AEGIS_AP_INTERFACE="wlan1")
    assert res.returncode == 1 and "TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3" in res.stderr
    no_mutation(fx)


def test_v8_refuses_a_second_wifi_device_or_second_wlan_rfkill(tmp_path: Path) -> None:  # I
    for over in (dict(extra_wifi_device=True), dict(extra_rfkill_wlan=True)):
        fx = v8(tmp_path / f"t{len(over)}{list(over)[0]}", **over)
        res = run(fx, APPLY)
        assert res.returncode == 1
        no_mutation(fx)


@pytest.mark.parametrize("old,new,reason", [
    ("band=bg", "band=a", "L34_PROFILE_BAND_MISMATCH"),
    ("channel=6", "channel=11", "L34_PROFILE_CHANNEL_MISMATCH"),
    ("mode=ap", "mode=infrastructure", "L34_PROFILE_MODE_NOT_AP"),
    ("address1=10.77.30.1/28", "address1=10.77.30.9/28", "L34_PROFILE_ADDRESS_MISMATCH"),
    ("interface-name=wlp0s20f3", "interface-name=wlan1", "L34_PROFILE_INTERFACE_MISMATCH"),
])
def test_v8_refuses_ap_profile_drift(tmp_path: Path, old: str, new: str, reason: str) -> None:  # J
    fx = v8(tmp_path)
    p = fx.file(base.PROFILE_REL)
    p.write_text(p.read_text().replace(old, new))
    res = run(fx, APPLY)
    assert res.returncode == 1 and reason in res.stderr
    no_mutation(fx)


def test_v8_refuses_when_networkmanager_reports_a_different_effective_profile(tmp_path: Path) -> None:  # J
    fx = v8(tmp_path, effective=["ap", "AEGIS-IDEA3", "a", "36", "manual", "10.77.30.1/28", "yes"])
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_PROFILE_EFFECTIVE_MISMATCH" in res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("over,reason", [
    (dict(ap_default_route=True), "L34_AP_INTERFACE_HAS_DEFAULT_ROUTE"),
    (dict(alt_default=False), "L34_NO_ALTERNATE_DEFAULT_ROUTE"),
])
def test_v8_refuses_an_unsafe_default_route_or_management_path(tmp_path: Path, over: dict, reason: str) -> None:  # K
    fx = v8(tmp_path, **over)
    res = run(fx, APPLY)
    assert res.returncode == 1 and reason in res.stderr
    no_mutation(fx)


def test_v8_refuses_a_healthy_or_otherwise_different_dnsmasq_state(tmp_path: Path) -> None:
    for state in ("active", "inactive"):
        fx = v8(tmp_path / state, dnsmasq=state)
        res = run(fx, APPLY)
        assert res.returncode == 1 and "L34_DNSMASQ_PRESTATE_UNEXPECTED" in res.stderr
        no_mutation(fx)


# ── 5. the broker-churn contract (D, E, F) ───────────────────────────────────────────────────────────────────────────────


def test_v8_accepts_the_churn_baseline_only_under_the_exact_contract(tmp_path: Path) -> None:  # D
    fx = v8(tmp_path)
    res = run(fx, APPLY, AEGIS_L34_PREFLIGHT_ONLY="YES")
    assert res.returncode == 0 and "L34_V8_PREFLIGHT=PASS" in res.stdout
    no_mutation(fx)


@pytest.mark.parametrize("over,reason", [
    (dict(broker_crashloop_cause="other"), "L34_V7_BROKER_JOURNAL_SIGNATURE_MISSING"),                                       # E unrelated failure
    (dict(broker_journal_extra=["mosquitto[7579]: Error: Unable to load server certificate \"/x\"."]), "L34_V7_BROKER_JOURNAL_OTHER_ERROR"),   # E mixed causes
    (dict(broker_crashloop_override={"Restart": "always"}), "L34_V7_BROKER_PRESTATE_UNEXPECTED:Restart"),
    (dict(broker_crashloop_override={"RestartUSec": "30s"}), "L34_V7_BROKER_PRESTATE_UNEXPECTED:RestartUSec"),
    (dict(broker_crashloop_override={"ExecMainStatus": "139"}), "L34_V7_BROKER_PRESTATE_UNEXPECTED:ExecMainStatus"),
    (dict(broker_crashloop_override={"Result": "signal"}), "L34_V7_BROKER_PRESTATE_UNEXPECTED:Result"),
    (dict(broker_crashloop_override={"Result": "start-limit-hit", "ActiveState": "failed", "SubState": "failed"}), "L34_V7_BROKER_PRESTATE_UNEXPECTED"),
    (dict(broker_crashloop_override={"UnitFileState": "disabled"}), "L34_V7_BROKER_PRESTATE_UNEXPECTED:UnitFileState"),
    (dict(broker_crashloop_override={"LoadState": "not-found"}), "L34_V7_BROKER_PRESTATE_UNEXPECTED:LoadState"),
    (dict(broker_crashloop_override={"MainPID": "4242"}), "L34_V7_BROKER_PRESTATE_UNEXPECTED:MainPID"),
])
def test_v8_rejects_unrelated_or_malformed_broker_failures(tmp_path: Path, over: dict, reason: str) -> None:  # E
    fx = v8(tmp_path, **over)
    res = run(fx, APPLY)
    assert res.returncode == 1 and reason in res.stderr, res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("conf", [
    "listener 8883 127.0.0.1\n",                                                                     # AP listener removed
    "listener 8883 127.0.0.1\nlistener 8883 10.77.30.1\nlistener 1883 0.0.0.0\n",                   # extra plaintext listener
    "listener 8883 0.0.0.0\nlistener 8883 10.77.30.1\n",                                             # widened bind
    "listener 8883 127.0.0.1\nlistener 8883 10.77.30.1\nlistener 8883 10.77.30.1\n",                 # duplicate
    "listeners 8883\n",                                                                              # the old template shape
])
def test_v8_rejects_a_broker_config_that_is_not_the_proven_listener_pair(tmp_path: Path, conf: str) -> None:  # E
    fx = v8(tmp_path, broker_conf=conf)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V7_BROKER_CONF" in res.stderr, res.stderr
    no_mutation(fx)


def test_v8_rejects_a_missing_broker_config(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    fx.file(BROKER_CONF_REL).unlink()
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V7_BROKER_CONF_MISSING" in res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("row", ["LISTEN 0 100 0.0.0.0:8883 0.0.0.0:*", "LISTEN 0 100 127.0.0.1:8883 0.0.0.0:*", "LISTEN 0 100 10.77.30.1:8883 0.0.0.0:*"])
def test_v8_rejects_any_unexpected_8883_listener_before_mutation(tmp_path: Path, row: str) -> None:  # F
    fx = v8(tmp_path, stray_8883=[row])
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V7_UNEXPECTED_8883_LISTENER" in res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("stray", [["tcp53"], ["udp53"], ["udp67"]])
def test_v8_rejects_a_pre_existing_ap_dns_dhcp_listener(tmp_path: Path, stray: list) -> None:  # F
    fx = v8(tmp_path, stray_ap_listeners=stray)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V6_AP_DNS_DHCP_LISTENER_PRESENT" in res.stderr
    no_mutation(fx)


def test_v8_rejects_a_pre_existing_ap_address(tmp_path: Path) -> None:
    fx = v8(tmp_path, foreign_ap_addr=True)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V6_AP_ADDRESS_PRESENT" in res.stderr
    no_mutation(fx)


def test_v8_rejects_a_healthy_broker(tmp_path: Path) -> None:  # E
    fx = v8(tmp_path, broker_mode="identity", identities={**V8_BASELINE["identities"], BROKER_UNIT: [5100, 3]})
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V7_BROKER" in res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("unit_state", [[0, 0]])
def test_v8_requires_a_healthy_unchanged_core(tmp_path: Path, unit_state: list) -> None:
    fx = v8(tmp_path, identities={**V8_BASELINE["identities"], CORE_UNIT: unit_state})
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V7_CORE_NOT_HEALTHY" in res.stderr
    no_mutation(fx)


# ── 6. no broker / Core command, end to end (L, M) ───────────────────────────────────────────────────────────────────────


def test_v8_issues_no_broker_or_core_command_during_apply_verify_rollback(tmp_path: Path) -> None:  # L, M
    fx = v8(tmp_path)
    applied(fx)
    assert run(fx, VERIFY).returncode == 0
    assert run(fx, ROLLBACK, AEGIS_L34_LIVE_AUTHORIZED="NO").returncode == 0
    assert broker_commands(fx) == []
    assert [c for c in fx.calls() if CORE_UNIT in c and not c.startswith(("systemctl show", "journalctl -u"))] == []
    assert fx.state()["identities"][CORE_UNIT] == [883, 0]


def test_v8_the_broker_recovers_only_through_its_own_restart_and_is_then_probed_once(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    res = applied(fx)
    assert "L6B_BROKER_MUTATED=NO" in res.stdout and "L6B_BROKER_RECOVERED_VIA=SYSTEMD_AUTO_RESTART" in res.stdout
    probes = [c for c in fx.calls() if c.startswith("PROBE ")]
    assert len(probes) == 1 and probes[0].startswith("PROBE " + PROBE_ARGS)
    assert not any("127.0.0.1" in c for c in probes)
    assert (fx.work / "tls-probe.txt").read_text().startswith("L7_BROKER_TLS_PROBE=PASS tls=TLSv1.")


def test_v8_fails_when_the_tls_probe_fails(tmp_path: Path) -> None:
    fx = v8(tmp_path, probe="fail")
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V6_TLS_PROBE_FAILED" in res.stderr
    assert len([c for c in fx.calls() if c.startswith("PROBE ")]) == 1


# ── 7. stabilization and bounded failure (O) ─────────────────────────────────────────────────────────────────────────────


def test_v8_broker_that_never_recovers_fails_bounded_without_a_broker_command(tmp_path: Path) -> None:  # O
    fx = v8(tmp_path, broker_crashloop_recovers_after_ap=False)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V8_BROKER_DID_NOT_RECOVER" in res.stderr
    assert broker_commands(fx) == []
    assert (fx.work / "production-mutation").exists()


def test_v8_broker_whose_restart_counter_keeps_moving_is_not_accepted(tmp_path: Path) -> None:  # O
    fx = v8(tmp_path, broker_restart_every_shows=2)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V7_BROKER_NOT_STABLE" in res.stderr, res.stdout + res.stderr
    assert broker_commands(fx) == []


def test_v8_a_wrong_listener_set_after_recovery_fails_after_the_bound(tmp_path: Path) -> None:  # F
    fx = v8(tmp_path, broker_listener_extra=["LISTEN 0 100 0.0.0.0:8883 0.0.0.0:*"])
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V4_BROKER_LISTENERS_INVALID" in res.stderr


def test_v8_core_identity_change_fails_closed(tmp_path: Path) -> None:
    fx = v8(tmp_path, broker_mutate={})
    s = fx.state()
    res = applied(fx)
    assert "CORE_UNCHANGED=YES" in res.stdout
    s = fx.state()
    s["identities"][CORE_UNIT] = [884, 0]
    sim.save(fx.simd, s)
    ver = run(fx, VERIFY)
    assert ver.returncode == 1 and "L34_V7_CORE_CHANGED" in ver.stderr


# ── 8. dnsmasq failure (P) ───────────────────────────────────────────────────────────────────────────────────────────────


def test_v8_dnsmasq_start_failure_then_rollback_restores_only_owned_changes(tmp_path: Path) -> None:  # P
    fx = v8(tmp_path, dnsmasq_start_works=False)
    res = run(fx, APPLY)
    assert res.returncode == 1 and (fx.work / "production-mutation").exists()
    rb = run(fx, ROLLBACK, AEGIS_L34_LIVE_AUTHORIZED="NO")
    assert rb.returncode == 0, rb.stdout + rb.stderr
    st = fx.state()
    assert st["ap_active"] == 0 and st["rfkill_soft"] == 1 and st["nm_software_radio"] is False and st["dev_autoconnect"] == "yes"
    assert "L34_V8_ROLLBACK=PASS" in rb.stdout and broker_commands(fx) == []


def test_v8_broker_never_recovering_then_rollback_returns_to_the_pre_boundary(tmp_path: Path) -> None:  # O
    fx = v8(tmp_path, broker_crashloop_recovers_after_ap=False)
    assert run(fx, APPLY).returncode == 1
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    st = fx.state()
    assert st["ap_active"] == 0 and st["rfkill_soft"] == 1 and st["nm_software_radio"] is False and st["dnsmasq"] != "active"
    assert "L6B_BROKER_TOUCHED=NO" in rb.stdout and broker_commands(fx) == []


# ── 9. rollback ownership (N) ────────────────────────────────────────────────────────────────────────────────────────────


def test_v8_rollback_undoes_only_what_the_journal_proves_this_run_did(tmp_path: Path) -> None:  # N
    fx = v8(tmp_path, radio_on_works=False)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "NM_WIFI_RADIO_ENABLE_FAILED" in res.stderr
    assert "NM_WIFI_RADIO_ENABLE" in journal_kinds(fx), "the intent is journaled before the command"
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    st = fx.state()
    assert st["rfkill_soft"] == 1 and st["dev_autoconnect"] == "yes" and st["nm_software_radio"] is False


def test_v8_rollback_never_disables_a_radio_this_run_did_not_enable(tmp_path: Path) -> None:  # N
    fx = v8(tmp_path, device_set_works=False)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "NM_DEVICE_AUTOCONNECT_SET_FAILED" in res.stderr
    assert "nmcli radio wifi on" not in fx.calls()
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    assert "nmcli radio wifi off" not in fx.calls()
    assert fx.state()["rfkill_soft"] == 1


def test_v8_rollback_refuses_a_journal_it_does_not_own(tmp_path: Path) -> None:  # N
    fx = v8(tmp_path)
    applied(fx)
    with (fx.work / "journal.tsv").open("a") as fh:
        fh.write(f"BROKER_RESTART\t{BROKER_UNIT}\n")
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "JOURNAL_ENTRY_UNKNOWN" in rb.stderr
    with (fx.work / "journal.tsv").open("w") as fh:
        fh.write(f"DNSMASQ_START\t{BROKER_UNIT}\n")
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "JOURNAL_ENTRY_NOT_OWNED" in rb.stderr


def test_v8_rollback_escalates_when_an_unrelated_wifi_profile_becomes_active(tmp_path: Path) -> None:  # N
    fx = v8(tmp_path)
    applied(fx)
    s = fx.state()
    s["other_wifi_active"] = True
    sim.save(fx.simd, s)
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "UNRELATED_WIFI_ACTIVATED_DURING_ROLLBACK=YES" in rb.stderr


def test_v8_full_rollback_after_a_successful_apply_is_safe_equivalent(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    assert "L34_V8_ROLLBACK=PASS" in rb.stdout and "L34_ROLLBACK_MODEL=SAFE_EQUIVALENT" in rb.stdout
    assert "L6B_BROKER_TOUCHED=NO" in rb.stdout and "CORE_TOUCHED=NO" in rb.stdout
    st = fx.state()
    assert st["ap_active"] == 0 and st["rfkill_soft"] == 1 and st["nm_software_radio"] is False and st["dnsmasq"] == "inactive"
    rb_calls = [c for c in fx.calls() if c.startswith(("rfkill block", "nmcli radio wifi off", "nmcli connection down", "systemctl stop"))]
    assert rb_calls == ["systemctl stop aegis-idea3-dnsmasq.service", "nmcli connection down aegis-idea3-ap", "nmcli radio wifi off", "rfkill block 1"]


# ── 10. verify ───────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_v8_verify_passes_after_apply_and_never_mutates(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    before = len(fx.mutating_calls())
    ver = run(fx, VERIFY)
    assert ver.returncode == 0, ver.stdout + ver.stderr
    assert "L34_V8_VERIFY=PASS" in ver.stdout and "PRODUCTION_MUTATION_PERFORMED=NO" in ver.stdout
    assert len(fx.mutating_calls()) == before


def test_v8_only_the_ap_profile_is_rewritten_every_other_persistent_file_is_untouched(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    pre = fx.persistent_state()
    bconf = fx.file(BROKER_CONF_REL).read_bytes()
    applied(fx)
    assert run(fx, VERIFY).returncode == 0
    post = fx.persistent_state()
    for rel in base.PERSISTENT:
        if rel == base.PROFILE_REL:
            assert post[rel] != pre[rel]
        else:
            assert post[rel] == pre[rel], rel
    assert fx.file(BROKER_CONF_REL).read_bytes() == bconf


def test_v8_never_prints_the_psk(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    res = applied(fx)
    ver = run(fx, VERIFY)
    assert base.PSK not in res.stdout + res.stderr + ver.stdout + ver.stderr


# ── 11. F2: broker failure evidence is bound to the CURRENT boot and the failed broker's CURRENT systemd InvocationID ──────────────────────────────

INVOCATION = "0123456789abcdef0123456789abcdef"
SHOW_TUPLE = (
    "LoadState=loaded\nActiveState=activating\nSubState=auto-restart\nUnitFileState=enabled\nResult=exit-code\nMainPID=0\nNRestarts=182\n"
    "ExecMainStatus=1\nRestart=on-failure\nRestartUSec=5s\n"
)
BIND_JOURNAL = "mosquitto[7579]: Opening ipv4 listen socket on port 8883.\nmosquitto[7579]: Error: Cannot assign requested address\n"


def lib_call(body: str, tmp: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", f'source "{LIB}"\n{body}'], text=True, capture_output=True, cwd=tmp, check=False)


def gate_call(tmp: Path, show: str, journal: str) -> subprocess.CompletedProcess[str]:
    (tmp / "show.txt").write_text(show)
    (tmp / "journal.txt").write_text(journal)
    return lib_call('l34_v7_broker_churn_gate "$PWD/journal.txt" < "$PWD/show.txt"', tmp)


def header(boot: str = "current", inv: str = INVOCATION, unit: str = BROKER_UNIT) -> str:
    return f"# AEGIS-V7-CORRELATION boot={boot} unit={unit} invocation={inv}\n"


def test_v8_f2_gate_accepts_only_journal_evidence_correlated_to_the_shows_invocation(tmp_path: Path) -> None:
    ok = gate_call(tmp_path, SHOW_TUPLE + f"InvocationID={INVOCATION}\n", header() + BIND_JOURNAL)
    assert ok.returncode == 0, ok.stderr


@pytest.mark.parametrize("show_extra,journal_head,reason", [
    ("", header(), "L34_V7_BROKER_INVOCATION_ID_INVALID"),                                                    # no InvocationID line at all
    ("InvocationID=\n", header(), "L34_V7_BROKER_INVOCATION_ID_INVALID"),                                     # empty
    ("InvocationID=not-hex\n", header(inv="not-hex"), "L34_V7_BROKER_INVOCATION_ID_INVALID"),                 # malformed
    ("InvocationID=" + INVOCATION.upper() + "\n", header(inv=INVOCATION.upper()), "L34_V7_BROKER_INVOCATION_ID_INVALID"),
    (f"InvocationID={INVOCATION}\n", "", "L34_V7_BROKER_JOURNAL_NOT_CORRELATED"),                              # uncorrelated (legacy shape)
    (f"InvocationID={INVOCATION}\n", header(inv="f" * 32), "L34_V7_BROKER_JOURNAL_NOT_CORRELATED"),           # earlier/other invocation
    (f"InvocationID={INVOCATION}\n", header(boot="previous"), "L34_V7_BROKER_JOURNAL_NOT_CORRELATED"),        # previous boot
    (f"InvocationID={INVOCATION}\n", header(unit="aegis-idea3-core.service"), "L34_V7_BROKER_JOURNAL_NOT_CORRELATED"),  # wrong unit
])
def test_v8_f2_gate_refuses_missing_or_uncorrelated_identity(tmp_path: Path, show_extra: str, journal_head: str, reason: str) -> None:
    res = gate_call(tmp_path, SHOW_TUPLE + show_extra, journal_head + BIND_JOURNAL)
    assert res.returncode == 1 and reason in res.stderr, res.stderr


def test_v8_f2_capture_queries_the_current_boot_and_the_failed_invocation(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    res = run(fx, APPLY, AEGIS_L34_PREFLIGHT_ONLY="YES")
    assert res.returncode == 0, res.stderr
    inv = sim._invocation_id(BROKER_UNIT, 0, fx.state()["broker_nrestarts_pre"])
    assert f"journalctl -u {BROKER_UNIT} -b _SYSTEMD_INVOCATION_ID={inv} -n 30 --no-pager" in fx.calls()
    first = (fx.work / "broker-journal-pre.txt").read_text().splitlines()[0]
    assert first == f"# AEGIS-V7-CORRELATION boot=current unit={BROKER_UNIT} invocation={inv}"


@pytest.mark.parametrize("over", [
    dict(broker_journal_stale_bind="previous_boot"),                                          # expected bind evidence from a previous boot
    dict(broker_journal_stale_bind="earlier_invocation"),                                     # expected bind evidence from an earlier invocation
    dict(broker_journal_stale_bind="earlier_invocation", broker_crashloop_cause="other"),     # stale bind + unrelated current failure
    dict(broker_journal_stale_bind="previous_boot", broker_crashloop_cause="other"),
])
def test_v8_f2_stale_bind_evidence_never_satisfies_the_baseline(tmp_path: Path, over: dict) -> None:
    fx = v8(tmp_path, **over)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V7_BROKER_JOURNAL_SIGNATURE_MISSING" in res.stderr, res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("inv", ["", "not-a-hex-id", "ABCDEF0123456789ABCDEF0123456789"])
def test_v8_f2_missing_or_malformed_invocation_id_is_refused(tmp_path: Path, inv: str) -> None:
    fx = v8(tmp_path, broker_crashloop_override={"InvocationID": inv})
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V7_BROKER_INVOCATION_ID_INVALID" in res.stderr, res.stderr
    no_mutation(fx)


def test_v8_f2_unrelated_current_failure_is_still_refused(tmp_path: Path) -> None:
    fx = v8(tmp_path, broker_crashloop_cause="other")
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V7_BROKER_JOURNAL_SIGNATURE_MISSING" in res.stderr
    no_mutation(fx)


def test_v8_f2_does_not_add_any_broker_control_and_keeps_every_other_churn_check() -> None:
    body = lib_v7()
    assert "_SYSTEMD_INVOCATION_ID=" in body and "journalctl -u" in body and " -b " in body
    assert not re.search(r"systemctl\s+(start|stop|restart|reset-failed|kill)", body)
    gate = body.split("l34_v7_broker_churn_gate() {", 1)[1].split("\n}\n", 1)[0]
    for kept in ("LoadState=loaded", "ActiveState=activating", "SubState=auto-restart", "UnitFileState=enabled", "Result=exit-code", "MainPID=0",
                 "ExecMainStatus=1", "Restart=on-failure", "RestartUSec=$L34_V7_RESTART_USEC", "NRestarts=", "L34_V7_BIND_SIGNATURE", "OTHER_ERROR"):
        assert kept in gate, kept


# ── 12. F3: rfkill identity evidence and rollback fail-closed ownership ──────────────────────────────────────────────────

def test_v8_f3_verify_refuses_missing_rfkill_identity_evidence(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    (fx.work / "rfkill_id").unlink()
    ver = run(fx, VERIFY)
    assert ver.returncode == 1 and "PRE_BASELINE_MISSING:rfkill_id" in ver.stderr


def test_v8_f3_verify_refuses_mismatched_rfkill_identity_evidence(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    (fx.work / "rfkill_id").write_text("0\n")   # the bluetooth rfkill, not the recorded wlan target (1)
    ver = run(fx, VERIFY)
    assert ver.returncode == 1, ver.stdout
    assert "L34_RFKILL_NON_TARGET_CHANGED" in ver.stderr or "L34_TARGET_RFKILL_NOT_UNBLOCKED" in ver.stderr, ver.stderr


def test_v8_f3_rollback_refuses_missing_rfkill_identity_evidence_when_it_unblocked(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    (fx.work / "rfkill_id").unlink()
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "RFKILL_ID_JOURNAL_MISMATCH" in rb.stderr
    assert not [c for c in fx.calls() if c.startswith("rfkill block")], "no block command may be issued without proven identity"


def test_v8_f3_rollback_refuses_mismatched_rfkill_identity_evidence(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    (fx.work / "rfkill_id").write_text("0\n")
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "RFKILL_ID_JOURNAL_MISMATCH" in rb.stderr
    assert not [c for c in fx.calls() if c.startswith("rfkill block")]


def test_v8_f3_rollback_refuses_a_journaled_rfkill_id_that_is_not_numeric(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    with (fx.work / "journal.tsv").open("a") as fh:
        fh.write("RFKILL_UNBLOCK\tall\n")
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "JOURNAL_ENTRY_NOT_OWNED" in rb.stderr
    assert not [c for c in fx.calls() if c.startswith("rfkill block")]


def test_v8_f3_rollback_without_any_journal_fails_closed_and_mutates_nothing(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    (fx.work / "journal.tsv").unlink()
    before = len(fx.mutating_calls())
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "JOURNAL_MISSING" in rb.stderr
    assert len(fx.mutating_calls()) == before


def test_v8_f3_rollback_never_blocks_rfkill_it_did_not_unblock(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    kept = [l for l in (fx.work / "journal.tsv").read_text().splitlines() if not l.startswith("RFKILL_UNBLOCK")]
    (fx.work / "journal.tsv").write_text("\n".join(kept) + "\n")
    run(fx, ROLLBACK)
    assert not [c for c in fx.calls() if c.startswith("rfkill block")], "ownership is proven only by the journal entry"


# ══ 13. V8-specific: the ONE persistent change (connection.autoconnect no -> yes), its ordering, journaling, rollback and ownership ═══════════════════

MODIFY_YES = "nmcli connection modify aegis-idea3-ap connection.autoconnect yes"
MODIFY_NO = "nmcli connection modify aegis-idea3-ap connection.autoconnect no"
PROFILE_PATH = lambda fx: fx.file(base.PROFILE_REL)  # noqa: E731


def modifies(fx: base.Fx) -> list[str]:
    return [c for c in fx.calls() if c.startswith("nmcli connection modify")]


def profile_ac_lines(fx: base.Fx) -> list[str]:
    return [l for l in PROFILE_PATH(fx).read_text().splitlines() if l.strip().startswith("autoconnect")]


def non_autoconnect_lines(fx: base.Fx) -> list[str]:
    return sorted(l for l in PROFILE_PATH(fx).read_text().splitlines() if not l.strip().startswith("autoconnect"))


def test_v8_apply_makes_exactly_one_profile_modification_with_the_exact_arguments(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    res = applied(fx)
    assert modifies(fx) == [MODIFY_YES]
    st = fx.state()
    assert st["ap_profile_autoconnect"] == "yes"
    assert "PERSISTENT_CHANGE_SCOPE=NM_PROFILE_aegis-idea3-ap_connection.autoconnect_no_to_yes_ONLY" in res.stdout
    assert "DIRECT_RFKILL_STATE_FILE_EDIT=NO" in res.stdout and "K12_AUTOMATIC_REBOOT_PERSISTENCE_CLAIMED=NO" in res.stdout
    assert "L7U_EXECUTED=NO" in res.stdout


def test_v8_the_persistent_change_is_journaled_before_it_is_made(tmp_path: Path) -> None:
    fx = v8(tmp_path, profile_modify_works=False)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "NM_PROFILE_AUTOCONNECT_MODIFY_FAILED" in res.stderr
    assert (fx.work / "journal.tsv").read_text().count("NM_PROFILE_AUTOCONNECT_ENABLE\tno") == 1, "intent journaled although the modify failed"
    assert modifies(fx) == [MODIFY_YES] and fx.state()["ap_profile_autoconnect"] == "no"


def test_v8_mutation_order_is_exactly_the_approved_sequence(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    mut = [c for c in fx.mutating_calls()]
    assert mut == [
        "rfkill unblock 1",
        "nmcli device set wlp0s20f3 autoconnect no",
        "nmcli radio wifi on",
        MODIFY_YES,
        "nmcli connection up aegis-idea3-ap ifname wlp0s20f3",
        "nmcli device set wlp0s20f3 autoconnect yes",
        "systemctl reset-failed aegis-idea3-dnsmasq.service",
        "systemctl start aegis-idea3-dnsmasq.service",
    ], mut
    assert journal_kinds(fx) == ["RFKILL_UNBLOCK", "NM_DEVICE_AUTOCONNECT_DISABLE", "NM_WIFI_RADIO_ENABLE", "NM_PROFILE_AUTOCONNECT_ENABLE", "NM_UP",
                                 "NM_DEVICE_AUTOCONNECT_RESTORED", "DNSMASQ_RESET_FAILED", "DNSMASQ_START"]


def test_v8_persists_only_after_the_device_is_ready_and_while_device_autoconnect_is_off(tmp_path: Path) -> None:
    fx = v8(tmp_path, nm_ready_lag_polls=3, autoconnect_profile_in_range=True)
    applied(fx)
    calls = fx.calls()
    i_mod = calls.index(MODIFY_YES)
    assert calls.index("nmcli device set wlp0s20f3 autoconnect no") < calls.index("nmcli radio wifi on") < i_mod
    ready_polls = [i for i, c in enumerate(calls) if c == "nmcli -t -f DEVICE,TYPE,STATE device status"]
    assert any(i < i_mod for i in ready_polls), "the bounded ready-wait runs before the persistent modify"
    assert i_mod < calls.index("nmcli connection up aegis-idea3-ap ifname wlp0s20f3") < calls.index("nmcli device set wlp0s20f3 autoconnect yes")


def test_v8_never_modifies_the_profile_when_the_ready_wait_fails(tmp_path: Path) -> None:
    fx = v8(tmp_path, nm_ready_lag_polls=50)
    res = run(fx, APPLY, AEGIS_L34_NM_TRIES="3")
    assert res.returncode == 1 and "NM_TARGET_DEVICE_NOT_READY" in res.stderr
    assert modifies(fx) == [] and "NM_PROFILE_AUTOCONNECT_ENABLE" not in journal_kinds(fx)
    assert fx.state()["ap_profile_autoconnect"] == "no"


@pytest.mark.parametrize("writes", ["omit", "true"])
def test_v8_accepts_either_keyfile_serialization_of_autoconnect_yes(tmp_path: Path, writes: str) -> None:
    fx = v8(tmp_path, profile_modify_writes=writes)
    applied(fx)
    assert profile_ac_lines(fx) == ([] if writes == "omit" else ["autoconnect=true"])
    ver = run(fx, VERIFY)
    assert ver.returncode == 0, ver.stdout + ver.stderr and "AP_PROFILE_AUTOCONNECT=YES" in ver.stdout


def test_v8_every_non_autoconnect_profile_line_is_identical_after_apply(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    before = non_autoconnect_lines(fx)
    applied(fx)
    assert non_autoconnect_lines(fx) == before
    assert profile_ac_lines(fx) != ["autoconnect=false"]


@pytest.mark.parametrize("over,reason", [
    (dict(ap_profile_autoconnect="yes"), "L34_V8_AP_PROFILE_ALREADY_AUTOCONNECT"),
    (dict(ap_profile_autoconnect="maybe"), "L34_V8_AP_PROFILE_AUTOCONNECT_UNEXPECTED"),
])
def test_v8_refuses_a_profile_that_already_autoconnects_or_is_unreadable(tmp_path: Path, over: dict, reason: str) -> None:
    fx = v8(tmp_path, **over)
    res = run(fx, APPLY)
    assert res.returncode == 1 and reason in res.stderr, res.stderr
    no_mutation(fx)
    assert modifies(fx) == []


@pytest.mark.parametrize("edit,reason", [
    (lambda s: s.replace("autoconnect=false\n", ""), "L34_V8_AP_PROFILE_FILE_AUTOCONNECT_NOT_FALSE:absent"),
    (lambda s: s.replace("autoconnect=false", "autoconnect=true"), "L34_V8_AP_PROFILE_FILE_AUTOCONNECT_NOT_FALSE:true"),
    (lambda s: s.replace("autoconnect=false", "autoconnect=false\nautoconnect=false"), "L34_V8_PROFILE_AUTOCONNECT_DUPLICATE"),
    (lambda s: s.replace("autoconnect=false", "autoconnect=maybe"), "L34_V8_PROFILE_AUTOCONNECT_MALFORMED"),
])
def test_v8_refuses_a_keyfile_whose_autoconnect_is_not_exactly_false(tmp_path: Path, edit, reason: str) -> None:
    fx = v8(tmp_path)
    p = PROFILE_PATH(fx)
    p.write_text(edit(p.read_text()))
    res = run(fx, APPLY)
    assert res.returncode == 1 and reason in res.stderr, res.stderr
    no_mutation(fx)


def test_v8_a_networkmanager_rewrite_that_changes_any_other_profile_line_fails_closed_and_rolls_back_to_escalation(tmp_path: Path) -> None:
    fx = v8(tmp_path, profile_modify_corrupts=True)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in res.stderr, res.stderr
    assert (fx.work / "production-mutation").exists()
    rb = run(fx, ROLLBACK)
    # the autoconnect value is restored, but a drifted line is never "repaired" here: the proof fails closed and the runner escalates (S-11 HOLD)
    assert MODIFY_NO in fx.calls()
    assert rb.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in rb.stderr, rb.stdout + rb.stderr


def test_v8_exactly_one_ap_activation_one_dnsmasq_start_and_zero_broker_or_core_commands(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    assert run(fx, VERIFY).returncode == 0
    assert run(fx, ROLLBACK).returncode == 0
    calls = fx.calls()
    assert len([c for c in calls if c.startswith("nmcli connection up")]) == 1
    assert calls.count("systemctl start aegis-idea3-dnsmasq.service") == 1 and calls.count("systemctl reset-failed aegis-idea3-dnsmasq.service") == 1
    assert calls.count("nmcli radio wifi on") == 1
    assert broker_commands(fx) == []
    assert [c for c in calls if CORE_UNIT in c and not c.startswith(("systemctl show", "journalctl -u"))] == []
    assert not [c for c in calls if re.match(r"systemctl (enable|disable|mask|unmask|preset|daemon-reload|restart|try-restart|kill)", c)]
    assert not [c for c in calls if c.startswith(("nft ", "sysctl -w", "iw reg set")) and not c.startswith("nft list")]


def test_v8_rollback_restores_autoconnect_no_first_and_proves_the_profile_identical_to_pre(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    before = non_autoconnect_lines(fx)
    applied(fx)
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    assert "AP_PROFILE_AUTOCONNECT_RESTORED=YES" in rb.stdout and "L34_V8_ROLLBACK=PASS" in rb.stdout
    st = fx.state()
    assert st["ap_profile_autoconnect"] == "no" and profile_ac_lines(fx) == ["autoconnect=false"]
    assert non_autoconnect_lines(fx) == before
    calls = fx.calls()
    assert modifies(fx) == [MODIFY_YES, MODIFY_NO]
    rb_start = len(calls) - 1 - calls[::-1].index(MODIFY_NO)
    after = [c for c in calls[rb_start:] if c in fx.mutating_calls()]
    assert after[:2] == [MODIFY_NO, "systemctl stop aegis-idea3-dnsmasq.service"], "the persistent policy is restored BEFORE the AP and radio are unwound"
    assert calls.index("nmcli connection down aegis-idea3-ap") > rb_start


def test_v8_rollback_after_a_failure_following_the_modify_restores_autoconnect_no(tmp_path: Path) -> None:
    fx = v8(tmp_path, nm_activation_works=False)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "NM_PROFILE_AUTOCONNECT_ENABLE" in journal_kinds(fx)
    assert fx.state()["ap_profile_autoconnect"] == "yes"
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    st = fx.state()
    assert st["ap_profile_autoconnect"] == "no" and st["rfkill_soft"] == 1 and st["nm_software_radio"] is False and st["dev_autoconnect"] == "yes"
    assert profile_ac_lines(fx) == ["autoconnect=false"]


def test_v8_rollback_does_not_modify_a_profile_whose_change_it_did_not_journal(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    kept = [l for l in (fx.work / "journal.tsv").read_text().splitlines() if not l.startswith("NM_PROFILE_AUTOCONNECT_ENABLE")]
    (fx.work / "journal.tsv").write_text("\n".join(kept) + "\n")
    rb = run(fx, ROLLBACK)
    assert modifies(fx) == [MODIFY_YES], "no journal entry, no profile modification"
    assert rb.returncode == 1 and "L34_V8_PROFILE_AUTOCONNECT_NOT_FALSE" in rb.stderr, rb.stdout + rb.stderr


def test_v8_rollback_with_a_journaled_modify_that_never_took_effect_does_not_modify_again(tmp_path: Path) -> None:
    fx = v8(tmp_path, profile_modify_works=False)
    assert run(fx, APPLY).returncode == 1
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    assert modifies(fx) == [MODIFY_YES], "the profile was already `no`: rollback is idempotent and issues no second modify"


def test_v8_rollback_refuses_a_non_pre_value_in_the_profile_journal_entry(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    with (fx.work / "journal.tsv").open("a") as fh:
        fh.write("NM_PROFILE_AUTOCONNECT_ENABLE\tyes\n")
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "JOURNAL_ENTRY_NOT_OWNED" in rb.stderr
    assert modifies(fx) == [MODIFY_YES]


def test_v8_verify_refuses_when_the_profile_does_not_carry_the_authorized_change(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    s = fx.state()
    s["ap_profile_autoconnect"] = "no"
    sim.save(fx.simd, s)
    ver = run(fx, VERIFY)
    assert ver.returncode == 1 and "L34_V8_AP_PROFILE_AUTOCONNECT_NOT_ENABLED" in ver.stderr, ver.stderr


def test_v8_verify_refuses_a_journal_without_exactly_one_profile_entry(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    kept = [l for l in (fx.work / "journal.tsv").read_text().splitlines() if not l.startswith("NM_PROFILE_AUTOCONNECT_ENABLE")]
    (fx.work / "journal.tsv").write_text("\n".join(kept) + "\n")
    ver = run(fx, VERIFY)
    assert ver.returncode == 1 and "L34_V8_PROFILE_AUTOCONNECT_JOURNAL_NOT_EXACTLY_ONE" in ver.stderr, ver.stderr


def test_v8_verify_refuses_a_profile_line_that_changed_beyond_autoconnect(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    p = PROFILE_PATH(fx)
    p.write_text(p.read_text().replace("ssid=AEGIS-IDEA3", "ssid=OTHER"))
    ver = run(fx, VERIFY)
    assert ver.returncode == 1 and "L34_V8_PROFILE_CHANGED_BEYOND_AUTOCONNECT" in ver.stderr, ver.stderr


def test_v8_verify_refuses_any_other_persistent_file_change(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    applied(fx)
    conf = fx.file(base.CONF_REL)
    conf.write_text(conf.read_text() + "# touched\n")
    ver = run(fx, VERIFY)
    assert ver.returncode == 1 and ("L34_PERSISTENT_FILE_CHANGED" in ver.stderr or "L34_DNSMASQ" in ver.stderr), ver.stderr


def test_v8_the_psk_is_never_digested_printed_or_journaled(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    res = applied(fx)
    rb = run(fx, ROLLBACK)
    blob = res.stdout + res.stderr + rb.stdout + rb.stderr + "".join(p.read_text(errors="ignore") for p in fx.work.rglob("*") if p.is_file())
    assert base.PSK not in blob
    snap = (fx.work / "persistent-pre.tsv").read_text()
    assert "psk_lines=1" in snap and "psk=" not in snap


def test_v8_no_direct_rfkill_state_file_or_networkmanager_state_access_exists_anywhere(tmp_path: Path) -> None:
    for script in (*ALL_SCRIPTS, DEPLOY / "p4-l34-v8-lib.sh"):
        text = code(script)
        for needle in ("/var/lib/systemd/rfkill", "/var/lib/NetworkManager", "NetworkManager.state", "systemd-rfkill", "/sys/class/rfkill"):
            assert needle not in text, (script.name, needle)
        if script != RUNNER:  # the runner's only `cp` copies the authorization records into its own evidence directory
            assert not re.search(r"(^|\s)(tee|cp|mv|rm|install|truncate)\s", text, re.M), script.name
    fx = v8(tmp_path)
    before = sorted(str(p.relative_to(fx.root)) for p in fx.root.rglob("*"))
    applied(fx)
    run(fx, ROLLBACK)
    assert sorted(str(p.relative_to(fx.root)) for p in fx.root.rglob("*")) == before, "no file created or removed under the fixture host root"


def test_v8_uses_the_v7_strict_current_invocation_broker_journal_correlation(tmp_path: Path) -> None:
    fx = v8(tmp_path)
    res = run(fx, APPLY, AEGIS_L34_PREFLIGHT_ONLY="YES")
    assert res.returncode == 0, res.stderr
    inv = sim._invocation_id(BROKER_UNIT, 0, fx.state()["broker_nrestarts_pre"])
    assert f"journalctl -u {BROKER_UNIT} -b _SYSTEMD_INVOCATION_ID={inv} -n 30 --no-pager" in fx.calls()
    for script in (APPLY,):
        assert "l34_v7_broker_journal_capture" in code(script) and "l34_v7_broker_churn_gate" in code(script)


def test_v8_v7_marker_authorization_and_state_are_never_referenced_by_the_handlers() -> None:
    for script in (APPLY, VERIFY, ROLLBACK):
        text = code(script)
        assert "L34-V7-REACTIVATION-ATTEMPT-CONSUMED" not in text and "authorization-L4" not in text and "k3-L4" not in text
        assert "l34-v7-work" not in text and "l34-v7-preflight" not in text
