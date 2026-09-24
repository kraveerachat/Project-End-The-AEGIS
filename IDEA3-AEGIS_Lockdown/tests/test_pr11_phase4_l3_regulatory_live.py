"""L3 live failure 2 (2026-09-24, after PR #203): the exact rfkill unblock worked, but the self-managed Intel phy0
stayed `country 00`, so the pre-activation `country TH` requirement can never be satisfied on this hardware.

These tests run the L3 regulatory gate (p4-l3-regulatory.sh) against a fake `iw` that reproduces the live output
shape: phy0 (self-managed) country 00 before AND after the unblock, channel 6 unrestricted. Fixtures reproduce the
observed live state; a fake that flips phy0 to TH is NOT live proof and is only used for the accepted-TH branch.
No real iw, no radio access, never `iw reg set`.
"""
from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
HELPER = DEPLOY / "p4-l3-regulatory.sh"
APPLY = DEPLOY / "stages" / "L3" / "apply.sh"
VERIFY = DEPLOY / "stages" / "L3" / "verify.sh"

FAKE_IW = r'''#!/usr/bin/env bash
echo "iw $*" >> "$FAKE_LOG"
case "$1 $2 $3" in
  "dev wlp0s20f3 info")
    [ -n "${FAKE_NO_WIPHY:-}" ] && exit 0
    printf 'Interface wlp0s20f3\n\tifindex 3\n\twdev 0x1\n\ttype %s\n\twiphy 0\n' "${FAKE_TYPE:-managed}"
    [ -n "${FAKE_ACTIVE_CHANNEL:-}" ] && printf '\tchannel %s (2437 MHz), width: 20 MHz, center1: 2437 MHz\n' "$FAKE_ACTIVE_CHANNEL"
    exit 0 ;;
  "reg get "*)
    [ -n "${FAKE_REG_FAIL:-}" ] && exit 1
    printf 'global\ncountry 00: DFS-UNSET\n\t(2402 - 2472 @ 40), (6, 20), (N/A)\n\nphy#0 (self-managed)\ncountry %s: DFS-UNSET\n\t(2402 - 2437 @ 40), (6, 22), (N/A), AUTO-BW\n' "${FAKE_PHY_COUNTRY:-00}"
    [ -n "${FAKE_PHY1_COUNTRY:-}" ] && printf '\nphy#1\ncountry %s: DFS-ETSI\n' "$FAKE_PHY1_COUNTRY"
    exit 0 ;;
  "phy phy0 channels")
    printf 'Band 1:\n'
    for n in 1 2 3 4 5 6 7 8 9 10 11 12 13; do
      f=$((2407 + 5 * n)); line="\t* $f MHz [$n]"
      [ "$n" = 6 ] && [ -n "${FAKE_CH6_DISABLED:-}" ] && line="$line (disabled)"
      printf "$line \n\t  Maximum TX power: 22.0 dBm\n\t  Channel widths: 20MHz HT40- HT40+\n"
      if [ "$n" = 6 ]; then
        [ -n "${FAKE_CH6_NOIR:-}" ] && printf '\t  No IR\n'
        [ -n "${FAKE_CH6_RADAR:-}" ] && printf '\t  Radar detection\n'
        [ -n "${FAKE_CH6_INDOOR:-}" ] && printf '\t  Indoor only\n'
        [ -n "${FAKE_CH6_PASSIVE:-}" ] && printf '\t  Passive scan\n'
      fi
    done
    [ -n "${FAKE_NO_CH6:-}" ] && exit 0
    exit 0 ;;
esac
echo "unexpected iw $*" >&2; exit 1
'''


@pytest.fixture()
def rig(tmp_path: Path):
    bindir = tmp_path / "bin"; bindir.mkdir()
    fake = bindir / "iw"; fake.write_text(FAKE_IW); fake.chmod(0o755)
    log = tmp_path / "calls.log"; log.write_text("")
    env = {k: v for k, v in os.environ.items() if not k.startswith("FAKE_")}
    env.update(PATH=f"{bindir}:{os.environ['PATH']}", FAKE_LOG=str(log))
    return {"env": env, "log": log}


def gate(rig, snippet: str, **extra: str) -> subprocess.CompletedProcess[str]:
    env = {**rig["env"], **extra}
    return subprocess.run(["bash", "-c", f'. "{HELPER}"; {snippet}'], text=True, capture_output=True, env=env)


def run_gate(rig, **extra: str) -> tuple[bool, str, str]:
    r = gate(rig, 'l3_reg_gate wlp0s20f3 6 && echo "OK country=$L3_REG_COUNTRY phy=$L3_REG_PHY" '
                  '|| { echo "REASON=$L3_REG_REASON"; exit 1; }', **extra)
    return r.returncode == 0, r.stdout.strip(), r.stderr


def test_helper_exists():
    assert HELPER.is_file()


# ---- the proven live case: unblocked radio, target self-managed phy still world domain 00 ----
def test_live_case_self_managed_00_with_unrestricted_channel_6_is_accepted(rig):
    ok, out, err = run_gate(rig)                       # FAKE_PHY_COUNTRY defaults to 00: the observed live state
    assert ok, out + err
    assert "country=00" in out and "phy=phy0" in out


def test_current_ordering_is_unsatisfiable_on_the_observed_hardware_state():
    """Documents WHY the old contract cannot pass: it demanded TH from the state that live evidence proves stays 00."""
    text = APPLY.read_text()
    assert not re.search(r'\[\s*"\$\(target_country\)"\s*=\s*TH\s*\]', text), "old pre-activation TH-only poll is still present"
    assert "REGULATORY_DOMAIN_MISMATCH" in text + HELPER.read_text()


def test_th_is_still_accepted_when_the_phy_reports_the_owner_country(rig):
    ok, out, _ = run_gate(rig, FAKE_PHY_COUNTRY="TH")
    assert ok and "country=TH" in out


@pytest.mark.parametrize("country", ["US", "JP", "ZZ", "GB"])
def test_any_other_target_country_fails_closed(rig, country):
    ok, out, _ = run_gate(rig, FAKE_PHY_COUNTRY=country)
    assert not ok and "REGULATORY_DOMAIN_MISMATCH" in out


def test_unreadable_regulatory_state_fails_closed(rig):
    ok, out, _ = run_gate(rig, FAKE_REG_FAIL="1")
    assert not ok and "REGULATORY_STATE_UNREADABLE" in out


def test_unresolvable_target_phy_fails_closed(rig):
    ok, out, _ = run_gate(rig, FAKE_NO_WIPHY="1")
    assert not ok and "REGULATORY_STATE_UNREADABLE" in out


def test_unrelated_phy_country_does_not_influence_the_target_decision(rig):
    ok, out, _ = run_gate(rig, FAKE_PHY1_COUNTRY="US")     # another phy in US; target phy0 is still 00 -> accepted
    assert ok and "country=00" in out


@pytest.mark.parametrize("flag", ["FAKE_CH6_DISABLED", "FAKE_CH6_NOIR", "FAKE_CH6_RADAR", "FAKE_CH6_INDOOR", "FAKE_CH6_PASSIVE"])
def test_restricted_channel_6_fails_closed_even_when_country_is_th(rig, flag):
    ok, out, _ = run_gate(rig, FAKE_PHY_COUNTRY="TH", **{flag: "1"})
    assert not ok and "CHANNEL_NOT_PERMITTED" in out


def test_missing_channel_fails_closed(rig):
    r = gate(rig, 'l3_reg_gate wlp0s20f3 14 || echo "REASON=$L3_REG_REASON"')
    assert "CHANNEL_NOT_PERMITTED" in r.stdout


def test_wrong_channel_argument_is_rejected(rig):
    r = gate(rig, 'l3_reg_gate wlp0s20f3 6x || echo "REASON=$L3_REG_REASON"')
    assert "CHANNEL_NOT_PERMITTED" in r.stdout


def test_gate_never_writes_regulatory_state_or_touches_the_radio(rig):
    run_gate(rig)
    seen = rig["log"].read_text()
    assert seen and not re.search(r"\breg set\b|\bset\b|\bdel\b|\badd\b", seen)


# ---- post-activation verification ----
def test_post_activation_requires_ap_type_on_the_approved_channel(rig):
    cmd = 'l3_reg_verify_active wlp0s20f3 6 && echo OK || echo "REASON=$L3_REG_REASON"'
    assert "OK" in gate(rig, cmd, FAKE_TYPE="AP", FAKE_ACTIVE_CHANNEL="6").stdout
    r = gate(rig, cmd, FAKE_TYPE="AP", FAKE_ACTIVE_CHANNEL="11")
    assert "AP_CHANNEL_MISMATCH" in r.stdout
    r = gate(rig, cmd, FAKE_TYPE="managed")
    assert "AP_MODE_NOT_ACTIVE" in r.stdout


def test_post_activation_reruns_the_regulatory_gate(rig):
    cmd = 'l3_reg_verify_active wlp0s20f3 6 && echo OK || echo "REASON=$L3_REG_REASON"'
    r = gate(rig, cmd, FAKE_TYPE="AP", FAKE_ACTIVE_CHANNEL="6", FAKE_PHY_COUNTRY="US")
    assert "REGULATORY_DOMAIN_MISMATCH" in r.stdout


# ---- handler wiring (source contract; live path is owner-run only) ----
def test_apply_uses_the_gate_before_profile_install_and_verifies_after_activation():
    text = APPLY.read_text()
    assert 'p4-l3-regulatory.sh' in text
    pre = text.index("l3_reg_gate")
    install = text.index('install -D -m 0600')
    up = text.index('nmcli connection up')
    post = text.index("l3_reg_verify_active")
    assert pre < install < up < post


def test_apply_takes_the_ap_down_itself_when_post_activation_verification_fails():
    text = APPLY.read_text()
    tail = text[text.index("l3_reg_verify_active"):]
    assert "nmcli connection down" in tail.split("fail ", 1)[0] + tail[:400]


def test_no_iw_reg_set_and_no_long_sleep_anywhere_in_l3():
    for p in [HELPER, APPLY, VERIFY, DEPLOY / "stages" / "L3" / "rollback.sh"]:
        code = "\n".join(l for l in p.read_text().splitlines() if not l.lstrip().startswith("#"))
        assert not re.search(r"\breg\s+set\b", code), p
        assert not re.search(r"\bsleep\s+[0-9]{2,}", code), p


def test_verify_checks_the_effective_channel_and_regulatory_state():
    text = VERIFY.read_text()
    assert "l3_reg_verify_active" in text
