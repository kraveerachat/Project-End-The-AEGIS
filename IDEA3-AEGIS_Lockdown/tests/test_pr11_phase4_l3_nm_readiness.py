"""L3 live failure 3 (2026-09-24, rerun5): after the exact rfkill unblock and the regulatory pre-gate, `nmcli connection up`
failed with "No suitable device found ... (device enp62s0 not available because profile is not compatible with device
(mismatching interface name))". NetworkManager saw the unblock ("Wi-Fi now enabled by radio killswitch") but wlp0s20f3
never left `unavailable`: activation came 37 ms after the unblock, and the earlier rerun3 window showed NO device state
change in 10 s either. So the cause is not a short race.

The fix is a bounded, state-based NetworkManager readiness gate for the exact target device, run after the rfkill and
regulatory gates and before any profile is installed, plus an activation bound explicitly to the approved interface. It
only READS NetworkManager state (`device status`, `radio wifi`); it never changes the global radio, rfkill or regulatory
state, and never touches any other device.

Tests run against a fake `nmcli`; no real NetworkManager, no radio, no host change.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
HELPER = DEPLOY / "p4-l3-nm.sh"
APPLY = DEPLOY / "stages" / "L3" / "apply.sh"
ROLLBACK = DEPLOY / "stages" / "L3" / "rollback.sh"

FAKE_NMCLI = r'''#!/usr/bin/env bash
echo "nmcli $*" >> "$FAKE_LOG"
case "$*" in
  "-t -f DEVICE,STATE device status")
    n=$(cat "$FAKE_COUNTER" 2>/dev/null || echo 0); echo $((n + 1)) > "$FAKE_COUNTER"
    IFS=, read -r -a seq <<< "$FAKE_STATES"; i=$n; [ "$i" -lt "${#seq[@]}" ] || i=$((${#seq[@]} - 1))
    [ -n "${FAKE_NO_TARGET:-}" ] || echo "wlp0s20f3:${seq[$i]}"
    echo "enp62s0:${FAKE_ENP_STATE:-connected}"
    echo "lo:connected (externally)"; exit 0 ;;
  "radio wifi") echo "${FAKE_RADIO:-enabled}"; exit 0 ;;
  "connection up "*) [ -n "${FAKE_UP_FAIL:-}" ] && { echo "Error: Connection activation failed" >&2; exit 4; }; echo "Connection successfully activated"; exit 0 ;;
esac
echo "FORBIDDEN nmcli $*" >> "$FAKE_LOG"; exit 9
'''


@pytest.fixture()
def rig(tmp_path: Path):
    bindir = tmp_path / "bin"; bindir.mkdir()
    fake = bindir / "nmcli"; fake.write_text(FAKE_NMCLI); fake.chmod(0o755)
    log = tmp_path / "calls.log"; log.write_text("")
    env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}
    env.update(PATH=f"{bindir}:{os.environ['PATH']}", FAKE_LOG=str(log), FAKE_COUNTER=str(tmp_path / "counter"))
    return {"env": env, "log": log}


def sh(rig, snippet: str, **extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", f'. "{HELPER}"; {snippet}'], text=True, capture_output=True, env={**rig["env"], **extra})


def wait(rig, tries: int = 4, **extra: str):
    return sh(rig, f'l3_nm_wait_ready wlp0s20f3 {tries} 0 && echo READY || echo "REASON=$L3_NM_REASON"', **extra)


def ready(r: subprocess.CompletedProcess[str]) -> bool:
    return "READY" in r.stdout.splitlines()


def calls(rig) -> list[str]:
    return [l for l in rig["log"].read_text().splitlines() if l]


def test_helper_exists():
    assert HELPER.is_file()


# ---- 1. the proven live case: the target stays unavailable after the unblock -> fail closed, no activation ----
def test_target_stays_unavailable_fails_closed_with_a_stable_reason(rig):
    r = wait(rig, FAKE_STATES="unavailable")
    assert "REASON=NM_TARGET_DEVICE_NOT_READY" in r.stdout and not ready(r)
    assert not any("connection up" in c for c in calls(rig))


def test_radio_disabled_in_networkmanager_gets_its_own_reason(rig):
    r = wait(rig, FAKE_STATES="unavailable", FAKE_RADIO="disabled")
    assert "REASON=NM_WIFI_RADIO_DISABLED" in r.stdout
    assert not any("connection up" in c for c in calls(rig))


def test_target_missing_from_networkmanager_fails_closed(rig):
    r = wait(rig, FAKE_STATES="unavailable", FAKE_NO_TARGET="1")
    assert "REASON=NM_TARGET_DEVICE_NOT_FOUND" in r.stdout


@pytest.mark.parametrize("state", ["unmanaged", "connecting (prepare)", "connected", "disconnected-ish"])
def test_only_disconnected_counts_as_ready(rig, state):
    assert not ready(wait(rig, FAKE_STATES=state))


# ---- 2. unavailable -> disconnected: ready, observed transition is logged ----
def test_transition_to_disconnected_is_ready_and_logged(rig):
    r = wait(rig, FAKE_STATES="unavailable,unavailable,disconnected")
    assert ready(r)
    assert "L3_NM_TARGET_STATE=unavailable" in r.stdout and "L3_NM_TARGET_STATE=disconnected" in r.stdout


def test_immediately_ready_target_needs_a_single_poll(rig):
    assert ready(wait(rig, FAKE_STATES="disconnected"))
    assert len([c for c in calls(rig) if "device status" in c]) == 1


# ---- 5. deterministic bound, no retry, no mutation ----
def test_timeout_is_bounded_deterministic_and_makes_no_change(rig):
    wait(rig, tries=6, FAKE_STATES="unavailable")
    polls = [c for c in calls(rig) if "device status" in c]
    assert len(polls) == 6
    assert set(calls(rig)) <= {"nmcli -t -f DEVICE,STATE device status", "nmcli radio wifi"}
    assert not any("FORBIDDEN" in c for c in calls(rig))


def test_default_bound_is_small_and_explicit():
    text = HELPER.read_text()
    m = re.search(r"l3_nm_wait_ready\(\)[^\n]*\n[^\n]*local[^\n]*tries=\$\{2:-(\d+)\}[^\n]*interval=\$\{3:-([0-9.]+)\}", text)
    assert m, "defaults must be spelled out in the function"
    assert int(m.group(1)) * float(m.group(2)) <= 10


# ---- 3 + 4. activation is explicitly bound to the approved interface; no other device is ever selected ----
def test_activation_is_bound_to_the_exact_interface(rig):
    r = sh(rig, 'l3_nm_activate wlp0s20f3 aegis-idea3-ap && echo OK')
    assert "OK" in r.stdout
    assert calls(rig) == ["nmcli connection up aegis-idea3-ap ifname wlp0s20f3"]


def test_other_devices_are_never_selected_or_used(rig):
    assert not ready(wait(rig, FAKE_STATES="unavailable", FAKE_ENP_STATE="disconnected"))   # a ready-looking enp62s0 must not count
    sh(rig, 'l3_nm_activate wlp0s20f3 aegis-idea3-ap')
    assert not any("enp62s0" in c for c in calls(rig))


def test_activation_failure_is_reported_once_without_retry(rig):
    r = sh(rig, 'l3_nm_activate wlp0s20f3 aegis-idea3-ap || echo "REASON=$L3_NM_REASON"', FAKE_UP_FAIL="1")
    assert "REASON=NMCLI_UP_FAILED" in r.stdout
    assert len([c for c in calls(rig) if "connection up" in c]) == 1


def test_helper_rejects_a_malformed_interface_or_connection(rig):
    assert "REASON=" in sh(rig, 'l3_nm_activate "wlp0s20f3;x" c || echo "REASON=$L3_NM_REASON"').stdout
    assert calls(rig) == []


# ---- handler wiring (source contract; the live path is owner-run only) ----
def code(p: Path) -> str:
    return "\n".join(l for l in p.read_text().splitlines() if not l.lstrip().startswith("#"))


def test_apply_order_rfkill_then_regulatory_then_nm_gate_then_install_then_activation():
    a = code(APPLY)
    order = [a.index(x) for x in ("l3_rfkill_prepare", "l3_reg_gate", "l3_nm_wait_ready", "install -D -m 0600", "l3_nm_activate")]
    assert order == sorted(order), order
    assert a.index("l3_nm_wait_ready") < a.index("nmcli connection reload")


def test_apply_fails_with_the_gate_reason_and_never_a_bare_connection_up():
    a = code(APPLY)
    assert 'l3_nm_wait_ready "$AP_IF" || fail "$L3_NM_REASON"' in a
    assert not re.search(r'nmcli connection up "\$CONN_ID"\s*(\|\||$)', a), "activation must not rely on NetworkManager choosing a device"
    assert re.search(r'l3_nm_activate "\$AP_IF" "\$CONN_ID" \|\| fail "\$L3_NM_REASON"', a)


def test_nothing_in_l3_changes_global_radio_rfkill_or_regulatory_state_or_touches_the_wired_device():
    for p in (HELPER, APPLY, ROLLBACK):
        c = code(p)
        assert not re.search(r"radio\s+(wifi|all)\s+(on|off)", c), p
        assert not re.search(r"rfkill\s+(un)?block\s+(all|wlan|wifi)", c), p
        assert not re.search(r"\breg\s+set\b", c), p
        assert "enp62s0" not in c, p
        assert not re.search(r"nmcli\s+device\s+(disconnect|set|reapply)", c), p


def test_rollback_contract_is_unchanged():
    r = code(ROLLBACK)
    assert "l3_rfkill_restore" in r and "nmcli connection delete" in r and "nmcli connection down" in r
