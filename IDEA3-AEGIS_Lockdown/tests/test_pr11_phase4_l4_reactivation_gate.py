"""L4 refresh after L3 live acceptance (PR #207): L4 starts from the already-applied L3 AP and reactivates it.

Semantic requirements (owner, 2026-09-24):
  * L4 live fails closed unless L3 is active (AP type, SSID AEGIS-IDEA3, channel 6, no IPv4, no global IPv6, no default
    route through the AP, an alternate default route) and the M-14 channel/regulatory gate passes read-only BEFORE the
    profile is changed;
  * every live activation is bound with `ifname <AP_IF>`, so NetworkManager never selects another device (enp62s0);
  * after reactivation the AP type, exact channel 6, target-phy country TH-or-00 and an unrestricted channel are
    re-verified through the merged L3 helper `l3_reg_verify_active`;
  * the L4 comparator accepts only 00->00, 00->TH, TH->TH on the target phy (stage-specific allow-transitions);
  * never `iw reg set`, `nmcli radio wifi on`, rfkill, NAT, or forwarding enable.

Everything runs against fake `iw`/`nmcli`/`ip`; no radio, no NetworkManager, no host change.
"""
from __future__ import annotations

import importlib.util
import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
L4 = DEPLOY / "stages" / "L4"
HELPER = DEPLOY / "p4-l4-live.sh"
APPLY = L4 / "apply.sh"
ROLLBACK = L4 / "rollback.sh"
COMPARE = DEPLOY / "p4-compare.sh"
TRANSITIONS = L4 / "allow-transitions.txt"

_spec = importlib.util.spec_from_file_location("l3_handler_tests", ROOT / "tests" / "test_pr11_phase4_l3_handler.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
make_bundle = _mod.make_bundle

FAKE_IW = r'''#!/usr/bin/env bash
echo "iw $*" >> "$FAKE_LOG"
case "$1 $2 $3" in
  "dev wlp0s20f3 info")
    printf 'Interface wlp0s20f3\n\tifindex 3\n\twdev 0x1\n'
    [ -n "${FAKE_SSID_OFF:-}" ] || printf '\tssid %s\n' "${FAKE_SSID:-AEGIS-IDEA3}"
    printf '\ttype %s\n\twiphy 0\n' "${FAKE_TYPE:-AP}"
    printf '\tchannel %s (2437 MHz), width: 20 MHz, center1: 2437 MHz\n' "${FAKE_ACTIVE_CHANNEL:-6}"
    exit 0 ;;
  "reg get "*)
    printf 'global\ncountry 00: DFS-UNSET\n\t(2402 - 2472 @ 40), (6, 20), (N/A)\n\nphy#0 (self-managed)\ncountry %s: DFS-UNSET\n' "${FAKE_PHY_COUNTRY:-00}"
    exit 0 ;;
  "phy phy0 channels")
    printf 'Band 1:\n'
    for n in 1 2 3 4 5 6 7 8 9 10 11 12 13; do
      f=$((2407 + 5 * n)); line="\t* $f MHz [$n]"
      [ "$n" = 6 ] && [ -n "${FAKE_CH6_DISABLED:-}" ] && line="$line (disabled)"
      printf "$line \n\t  Maximum TX power: 22.0 dBm\n"
      if [ "$n" = 6 ]; then
        [ -n "${FAKE_CH6_NOIR:-}" ] && printf '\t  No IR\n'
        [ -n "${FAKE_CH6_RADAR:-}" ] && printf '\t  Radar detection\n'
        [ -n "${FAKE_CH6_DFS:-}" ] && printf '\t  DFS state: usable\n\t  DFS\n'
        [ -n "${FAKE_CH6_PASSIVE:-}" ] && printf '\t  Passive scan\n'
      fi
    done
    exit 0 ;;
esac
echo "FORBIDDEN iw $*" >> "$FAKE_LOG"; exit 9
'''

FAKE_NMCLI = r'''#!/usr/bin/env bash
echo "nmcli $*" >> "$FAKE_LOG"
case "$*" in
  "connection up "*)
    case "$*" in *" ifname wlp0s20f3") ;; *) echo "Error: No suitable device found (device enp62s0 ...)" >&2; exit 4 ;; esac
    [ -n "${FAKE_UP_FAIL:-}" ] && exit 4
    echo "Connection successfully activated"; exit 0 ;;
esac
echo "FORBIDDEN nmcli $*" >> "$FAKE_LOG"; exit 9
'''

FAKE_IP = r'''#!/usr/bin/env bash
echo "ip $*" >> "$FAKE_LOG"
case "$*" in
  "-4 addr show dev wlp0s20f3") [ -n "${FAKE_AP_V4:-}" ] && printf '3: wlp0s20f3    inet %s/28 scope global wlp0s20f3\n' "$FAKE_AP_V4"; exit 0 ;;
  "-6 addr show dev wlp0s20f3 scope global") [ -n "${FAKE_AP_V6:-}" ] && printf '3: wlp0s20f3    inet6 %s/64 scope global\n' "$FAKE_AP_V6"; exit 0 ;;
  "route show default dev wlp0s20f3") [ -n "${FAKE_AP_DEFAULT:-}" ] && echo "default via 10.77.30.254 dev wlp0s20f3"; exit 0 ;;
  "route show default")
    [ -n "${FAKE_NO_ALT_DEFAULT:-}" ] || echo "default via 192.168.1.1 dev enp62s0"
    [ -n "${FAKE_AP_DEFAULT:-}" ] && echo "default via 10.77.30.254 dev wlp0s20f3"; exit 0 ;;
esac
echo "FORBIDDEN ip $*" >> "$FAKE_LOG"; exit 9
'''


@pytest.fixture()
def rig(tmp_path: Path):
    bindir = tmp_path / "bin"; bindir.mkdir()
    for name, body in (("iw", FAKE_IW), ("nmcli", FAKE_NMCLI), ("ip", FAKE_IP)):
        f = bindir / name; f.write_text(body); f.chmod(0o755)
    log = tmp_path / "calls.log"; log.write_text("")
    env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}
    env.update(PATH=f"{bindir}:{os.environ['PATH']}", FAKE_LOG=str(log))
    return {"env": env, "log": log}


def sh(rig, snippet: str, **extra: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", f'. "{HELPER}"; {snippet}'], text=True, capture_output=True, env={**rig["env"], **extra})


def pre(rig, **extra: str):
    return sh(rig, 'l4_precondition wlp0s20f3 6 && echo OK || echo "REASON=$L4_REASON"', **extra)


def react(rig, **extra: str):
    return sh(rig, 'l4_reactivate wlp0s20f3 aegis-idea3-ap 6 && echo OK || echo "REASON=$L4_REASON"', **extra)


def ok(r: subprocess.CompletedProcess[str]) -> bool:
    return "OK" in r.stdout.splitlines()


def calls(rig) -> list[str]:
    return [line for line in rig["log"].read_text().splitlines() if line]


def code(path: Path) -> str:
    return "\n".join(line for line in path.read_text().splitlines() if not line.lstrip().startswith("#"))


def test_helper_exists_and_reuses_the_merged_l3_helpers() -> None:
    assert HELPER.is_file()
    text = code(HELPER)
    assert "p4-l3-regulatory.sh" in text and "p4-l3-nm.sh" in text


# ---- 3. precondition: L3 must already be active (read-only) ----
def test_precondition_passes_from_the_applied_l3_ap(rig) -> None:
    assert ok(pre(rig))


@pytest.mark.parametrize("extra,reason", [
    ({"FAKE_TYPE": "managed"}, "AP_MODE_NOT_ACTIVE"),
    ({"FAKE_SSID": "OTHER"}, "AP_SSID_MISMATCH"),
    ({"FAKE_SSID_OFF": "1"}, "AP_SSID_MISMATCH"),
    ({"FAKE_ACTIVE_CHANNEL": "11"}, "AP_CHANNEL_MISMATCH"),
    ({"FAKE_AP_V4": "10.77.30.1"}, "AP_IF_ALREADY_HAS_IPV4_ADDRESS"),
    ({"FAKE_AP_V6": "2001:db8::1"}, "AP_IF_HAS_IPV6_ADDRESS"),
    ({"FAKE_AP_DEFAULT": "1"}, "AP_IF_HAS_DEFAULT_ROUTE"),
    ({"FAKE_NO_ALT_DEFAULT": "1"}, "NO_ALTERNATE_DEFAULT_ROUTE"),
])
def test_precondition_fails_closed_when_l3_is_not_active(rig, extra: dict, reason: str) -> None:
    r = pre(rig, **extra)
    assert not ok(r) and f"REASON={reason}" in r.stdout, r.stdout


@pytest.mark.parametrize("env,reason", [
    ({"FAKE_PHY_COUNTRY": "US"}, "REGULATORY_DOMAIN_MISMATCH"),
    ({"FAKE_CH6_NOIR": "1"}, "CHANNEL_NOT_PERMITTED"),
    ({"FAKE_CH6_RADAR": "1"}, "CHANNEL_NOT_PERMITTED"),
    ({"FAKE_CH6_DFS": "1"}, "CHANNEL_NOT_PERMITTED"),
    ({"FAKE_CH6_PASSIVE": "1"}, "CHANNEL_NOT_PERMITTED"),
    ({"FAKE_CH6_DISABLED": "1"}, "CHANNEL_NOT_PERMITTED"),
])
def test_regulatory_pre_gate_runs_read_only_and_fails_closed(rig, env: dict, reason: str) -> None:
    r = pre(rig, **env)
    assert not ok(r) and f"REASON={reason}" in r.stdout, r.stdout


@pytest.mark.parametrize("country", ["TH", "00"])
def test_precondition_accepts_target_phy_th_or_00(rig, country: str) -> None:
    assert ok(pre(rig, FAKE_PHY_COUNTRY=country))


def test_precondition_only_reads(rig) -> None:
    pre(rig)
    assert not any(c.startswith("nmcli") for c in calls(rig))
    assert not any(" set" in c for c in calls(rig))


# ---- 1/2. activation explicitly bound to the approved interface ----
def test_activation_is_bound_with_ifname(rig) -> None:
    r = react(rig)
    assert ok(r), r.stdout
    ups = [c for c in calls(rig) if c.startswith("nmcli connection up")]
    assert ups == ["nmcli connection up aegis-idea3-ap ifname wlp0s20f3"]


def test_enp62s0_can_never_be_selected_for_activation(rig) -> None:
    for bad in ("enp62s0", "eth0", ""):
        r = sh(rig, f'l4_reactivate "{bad}" aegis-idea3-ap 6 && echo OK || echo "REASON=$L4_REASON"')
        assert not ok(r), bad
    assert not any("enp62s0" in c for c in calls(rig))
    assert not any(c.startswith("nmcli connection up") for c in calls(rig))


def test_activation_failure_fails_closed(rig) -> None:
    r = react(rig, FAKE_UP_FAIL="1")
    assert not ok(r) and "REASON=NMCLI_UP_FAILED" in r.stdout


# ---- 3/4/5/6/7. post-reactivation verification through the merged L3 helper ----
@pytest.mark.parametrize("extra,reason", [
    ({"FAKE_TYPE": "managed"}, "AP_MODE_NOT_ACTIVE"),
    ({"FAKE_ACTIVE_CHANNEL": "1"}, "AP_CHANNEL_MISMATCH"),
    ({"FAKE_SSID": "OTHER"}, "AP_SSID_MISMATCH"),
    ({"FAKE_PHY_COUNTRY": "US"}, "REGULATORY_DOMAIN_MISMATCH"),
    ({"FAKE_CH6_NOIR": "1"}, "CHANNEL_NOT_PERMITTED"),
    ({"FAKE_CH6_RADAR": "1"}, "CHANNEL_NOT_PERMITTED"),
    ({"FAKE_CH6_DFS": "1"}, "CHANNEL_NOT_PERMITTED"),
    ({"FAKE_CH6_DISABLED": "1"}, "CHANNEL_NOT_PERMITTED"),
])
def test_post_reactivation_verification_fails_closed(rig, extra: dict, reason: str) -> None:
    r = react(rig, **extra)
    assert not ok(r) and f"REASON={reason}" in r.stdout, r.stdout


@pytest.mark.parametrize("country", ["TH", "00"])
def test_post_reactivation_accepts_th_or_00_with_an_unrestricted_channel(rig, country: str) -> None:
    assert ok(react(rig, FAKE_PHY_COUNTRY=country))


def test_channel_other_than_6_is_refused(rig) -> None:
    r = sh(rig, 'l4_precondition wlp0s20f3 11 && echo OK || echo "REASON=$L4_REASON"')
    assert not ok(r)


def test_helper_never_sets_regulatory_radio_or_rfkill_state(rig) -> None:
    pre(rig); react(rig)
    for c in calls(rig):
        assert not re.search(r"\biw reg set\b|radio wifi (on|off)|rfkill|\bnft\b|forward|masquerade", c), c
    text = code(HELPER)
    assert not re.search(r"iw\s+reg\s+set|radio\s+wifi\s+on|rfkill\s+(un)?block|masquerade|ip_forward\s*=\s*1", text)


# ---- apply.sh / rollback.sh wiring ----
def test_apply_wires_pre_gate_before_mutation_and_post_gate_before_dnsmasq() -> None:
    text = code(APPLY)
    assert "p4-l4-live.sh" in text
    pre_i = text.index("l4_precondition")
    assert pre_i < text.index('cp -p "$target_profile"'), "pre-gate must run before any profile change"
    up_i = text.index("l4_reactivate")
    assert pre_i < up_i < text.index("systemctl enable --now"), "post-gate must run before dnsmasq starts"
    assert 'nmcli connection up "$CONN_ID" ||' not in text and 'nmcli connection up "$CONN_ID"\n' not in text


def test_no_unbound_nmcli_connection_up_remains_in_l4() -> None:
    for path in (APPLY, ROLLBACK, HELPER):
        for line in code(path).splitlines():
            if "nmcli connection up" in line:
                assert "ifname" in line, f"{path.name}: {line.strip()}"


def test_l4_scripts_never_set_regulatory_radio_rfkill_nat_or_forwarding() -> None:
    for path in (APPLY, ROLLBACK, L4 / "verify.sh", HELPER):
        text = code(path)
        assert not re.search(r"iw\s+reg\s+set|radio\s+wifi\s+on|rfkill\s+(un)?block|nft\s+add\s+rule[^\n]*masquerade|ip_forward\s*=\s*1|sysctl\s+-w", text), path.name


# ---- 4. comparator: stage-specific L4 allow-transitions ----
BASE = {"wifi.iface.wlp0s20f3.phy": "phy0", "wifi.reg.global": "00", "wifi.reg.phy0": "00", "wifi.reg.sha256": "a" * 64}
IDEA2 = {"idea2.tunnel.MainPID": "398125", "idea2.tunnel.NRestarts": "16", "idea2.engine.MainPID": "868"}


def compare(tmp_path: Path, b0: str, a0: str, *, extra_b: dict | None = None, extra_a: dict | None = None,
            transitions: Path | None = TRANSITIONS):
    before = {**BASE, **IDEA2, "wifi.reg.phy0": b0, **(extra_b or {})}
    after = {**BASE, **IDEA2, "wifi.reg.phy0": a0, **(extra_a or {})}
    if b0 != a0:
        after["wifi.reg.sha256"] = "b" * 64
    b = make_bundle(tmp_path / "b", "before", before)
    a = make_bundle(tmp_path / "a", "after", after)
    env = {**os.environ, "DISK_THRESHOLD_PCT": "90", "AEGIS_AP_INTERFACE": "wlp0s20f3",
           "ALLOW_KEYS_FILE": str(L4 / "allow-keys.txt")}
    if transitions is not None:
        env["ALLOW_TRANSITIONS_FILE"] = str(transitions)
    return subprocess.run(["bash", str(COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)


def passed(r) -> bool:
    return r.returncode == 0 and "COMPARE_RESULT=PASS" in r.stdout


def failed(r) -> bool:
    return r.returncode != 0 and "COMPARE_RESULT=FAIL" in r.stdout


def test_l4_transitions_file_is_exact() -> None:
    lines = [ln.split() for ln in TRANSITIONS.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    assert lines == [["stage", "L4"], ["wifi.reg.<AEGIS_AP_PHY>", "00", "TH"]]


@pytest.mark.parametrize("b,a", [("00", "00"), ("00", "TH"), ("TH", "TH")])
def test_l4_comparator_accepts_only_the_approved_target_phy_transitions(tmp_path: Path, b: str, a: str) -> None:
    r = compare(tmp_path, b, a, extra_b={"nm.device.wlp0s20f3.state": "connected"}, extra_a={"nm.device.wlp0s20f3.state": "connected"})
    assert passed(r), r.stdout


@pytest.mark.parametrize("b,a", [("TH", "00"), ("00", "US"), ("TH", "US"), ("US", "TH")])
def test_l4_comparator_th_to_00_and_other_transitions_fail_closed(tmp_path: Path, b: str, a: str) -> None:
    assert failed(compare(tmp_path, b, a))


def test_l4_comparator_unrelated_phy_or_global_drift_fails(tmp_path: Path) -> None:
    assert failed(compare(tmp_path / "p", "00", "00", extra_b={"wifi.reg.phy1": "00"}, extra_a={"wifi.reg.phy1": "US"}))
    assert failed(compare(tmp_path / "g", "00", "00", extra_a={"wifi.reg.global": "US"}))


def test_l4_comparator_without_the_transitions_file_still_treats_regulatory_change_as_drift(tmp_path: Path) -> None:
    assert failed(compare(tmp_path, "00", "TH", transitions=None))


def test_l4_transitions_file_cannot_be_broadened(tmp_path: Path) -> None:
    for body in ("stage L4\nstage L3\nwifi.reg.<AEGIS_AP_PHY> 00 TH\n", "stage L5\nwifi.reg.<AEGIS_AP_PHY> 00 TH\n",
                 "stage L4\nwifi.reg.<AEGIS_AP_PHY> TH 00\n", "stage L4\nwifi.reg.* 00 TH\n", "stage L4\n"):
        f = tmp_path / "t.txt"; f.write_text(body)
        r = compare(tmp_path / "d", "00", "TH", transitions=f)
        assert r.returncode == 2 and "STOP" in r.stdout, (body, r.stdout)


def test_l3_transitions_file_still_accepted_and_unchanged(tmp_path: Path) -> None:
    l3 = DEPLOY / "stages" / "L3" / "allow-transitions.txt"
    assert passed(compare(tmp_path, "00", "TH", transitions=l3))


def test_regulatory_keys_are_not_in_l4_allow_keys() -> None:
    assert "wifi.reg" not in code(L4 / "allow-keys.txt")
