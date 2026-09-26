# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L3/L4 reactivation V3 preservation model (live attempt 2 evidence, 2026-09-27).

Attempt 2 proved V2 functionally (apply PASS, verify PASS, AP/dnsmasq active) and failed only at PRE->POST preservation: NetworkManager Wi-Fi
initialization added a p2p pseudo-device, started wpa_supplicant, moved the target phy regulatory state 00 -> TH (changing wifi.phy.sha256), and
rollback could not return byte-for-byte (p2p device, wpa_supplicant and TH remained). These tests reproduce that evidence exactly and pin the
V3 model: every accepted side effect is exact, operation-specific, target-specific, value-constrained and relationally tied to the authorized
NM radio transition. No generic allow key is added.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import test_pr11_phase4_l34_reactivation as base  # noqa: E402

HND, DEPLOY, COMPARE = base.HND, base.DEPLOY, base.COMPARE
AWK = DEPLOY / "p4-iw-phy-regnorm.awk"
CAPTURE = DEPLOY / "p4-l0-capture.sh"
SVC, W = base.SVC, "svc.wpa_supplicant.service."
HEX = lambda c: c * 64  # noqa: E731

P_POST_FRESH = HND / "allow-dynamic-transitions-v3-post-fresh.txt"
P_POST_RES = HND / "allow-dynamic-transitions-v3-post-residual.txt"
P_RB_FRESH = HND / "allow-dynamic-transitions-v3-rollback-fresh.txt"
P_RB_RES = HND / "allow-dynamic-transitions-v3-rollback-residual.txt"


def rec(**over: str) -> dict[str, str]:
    """The FRESH post-reboot PRE baseline of live attempt 2 (phy 00, no p2p pseudo-device, wpa_supplicant inactive)."""
    r = dict(base.PRE_RECORDS)
    r.update({
        "wifi.iface.wlp0s20f3.phy": "phy0", "wifi.reg.global": "00", "wifi.reg.phy0": "00", "wifi.reg.sha256": HEX("a"),
        "wifi.phy.ap_mode": "supported", "wifi.phy.sha256": HEX("1"), "wifi.phy.regnorm_sha256": HEX("9"), "wifi.phy.channel6_permitted": "YES",
        "nm.active.device.wlp0s20f3": "none", "nm.active.device.enp62s0": "Wired connection 1:802-3-ethernet",
        "nm.device.wlp0s20f3.type": "wifi",
        W + "LoadState": "loaded", W + "UnitFileState": "disabled", W + "ActiveState": "inactive", W + "SubState": "dead", W + "Result": "success",
        W + "MainPID": "0", W + "NRestarts": "0", W + "ExecMainStartTimestamp": "",
    })
    r.update(over)
    return r


def post_fresh(**over: str) -> dict[str, str]:
    """PRE->POST of live attempt 2, exactly as the comparator saw it."""
    r = rec()
    r.update(base.post_records())
    r.update({
        "wifi.reg.phy0": "TH", "wifi.reg.sha256": HEX("b"), "wifi.phy.sha256": HEX("2"),
        "nm.active.device.wlp0s20f3": "aegis-idea3-ap:802-11-wireless",
        "nm.active.device.p2p-dev-wlp0s20f3": "none", "nm.device.p2p-dev-wlp0s20f3.type": "wifi-p2p", "nm.device.p2p-dev-wlp0s20f3.state": "disconnected",
        W + "ActiveState": "active", W + "SubState": "running", W + "MainPID": "1545238", W + "ExecMainStartTimestamp": "Sun 2026-09-27 03:21:03 +07",
        "wifi.rfkill.iface.wlp0s20f3.soft": "unblocked",
    })
    r.update(over)
    return r


def rb_fresh(**over: str) -> dict[str, str]:
    """PRE->RB of live attempt 2: handler PASS but the residuals below remained."""
    r = rec()
    r.update({
        SVC + "ActiveState": "inactive", SVC + "SubState": "dead", SVC + "Result": "success", SVC + "NRestarts": "0",
        SVC + "ExecMainStartTimestamp": "Sun 2026-09-27 03:21:07 +07",
        "wifi.reg.phy0": "TH", "wifi.reg.sha256": HEX("b"), "wifi.phy.sha256": HEX("2"),
        "nm.active.device.p2p-dev-wlp0s20f3": "none", "nm.device.p2p-dev-wlp0s20f3.type": "wifi-p2p", "nm.device.p2p-dev-wlp0s20f3.state": "unavailable",
        W + "ActiveState": "active", W + "SubState": "running", W + "MainPID": "1545238", W + "ExecMainStartTimestamp": "Sun 2026-09-27 03:21:03 +07",
    })
    r.update(over)
    return r


def residual_pre(**over: str) -> dict[str, str]:
    """The proven safe-equivalent RESIDUAL baseline (2026-09-27 03:23 read-only): phy TH, p2p unavailable, wpa_supplicant active/running."""
    r = rec()
    r.update({
        "wifi.reg.phy0": "TH", "wifi.reg.sha256": HEX("b"), "wifi.phy.sha256": HEX("2"),
        "nm.active.device.p2p-dev-wlp0s20f3": "none", "nm.device.p2p-dev-wlp0s20f3.type": "wifi-p2p", "nm.device.p2p-dev-wlp0s20f3.state": "unavailable",
        W + "ActiveState": "active", W + "SubState": "running", W + "MainPID": "1545238", W + "ExecMainStartTimestamp": "Sun 2026-09-27 03:21:03 +07",
    })
    r.update(over)
    return r


def post_residual(**over: str) -> dict[str, str]:
    r = residual_pre()
    r.update(base.post_records())
    r.update({
        "wifi.reg.phy0": "TH", "wifi.reg.sha256": HEX("b"), "wifi.phy.sha256": HEX("2"), "nm.active.device.wlp0s20f3": "aegis-idea3-ap:802-11-wireless",
        "nm.device.p2p-dev-wlp0s20f3.state": "disconnected", "nm.active.device.p2p-dev-wlp0s20f3": "none", "nm.device.p2p-dev-wlp0s20f3.type": "wifi-p2p",
        W + "ActiveState": "active", W + "SubState": "running", W + "MainPID": "1545238", W + "ExecMainStartTimestamp": "Sun 2026-09-27 03:21:03 +07",
        "wifi.rfkill.iface.wlp0s20f3.soft": "unblocked",
    })
    r.update(over)
    return r


def compare(tmp: Path, pre: dict, post: dict, dyn: Path | None, *, keys: Path | None = None, transitions: bool = True, listeners: bool = False):
    mb = base._make_bundle()
    b, a = mb(tmp / "b", "pre", pre), mb(tmp / "a", "post", post)
    env = os.environ.copy()
    env.update(DISK_THRESHOLD_PCT="90", AEGIS_AP_INTERFACE="wlp0s20f3", AEGIS_AP_ADDRESS="10.77.30.1")
    env.pop("ALLOW_DYNAMIC_TRANSITIONS_FILE", None)
    if keys is not None:
        env["ALLOW_KEYS_FILE"] = str(keys)
    if dyn is not None:
        env["ALLOW_DYNAMIC_TRANSITIONS_FILE"] = str(dyn)
    if transitions:
        env["ALLOW_TRANSITIONS_FILE"] = str(HND / "allow-transitions.txt")
    if listeners:
        env["ALLOW_LISTENERS_FILE"] = str(HND / "allow-listeners.txt")
    return subprocess.run(["bash", str(COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)


def post(tmp: Path, pre: dict, post_: dict, dyn: Path = P_POST_FRESH, **kw):
    return compare(tmp, pre, post_, dyn, keys=HND / "allow-keys.txt", **kw)


def rb(tmp: Path, pre: dict, post_: dict, dyn: Path = P_RB_FRESH, **kw):
    return compare(tmp, pre, post_, dyn, keys=HND / "allow-keys-rollback.txt", **kw)


def drift(res: subprocess.CompletedProcess[str]) -> list[str]:
    return sorted(l.split("\t")[3] for l in res.stdout.splitlines() if l.startswith("FINDING\tNEW_OR_WORSENED_DRIFT"))


# ── the exact live evidence, reproduced RED against the V2 files and GREEN under V3 ─────────────────────────────────────


def test_live_attempt_2_pre_post_findings_are_reproduced_exactly_by_the_v2_files(tmp_path: Path) -> None:
    res = post(tmp_path, rec(), post_fresh(), HND / "allow-dynamic-transitions.txt")
    assert res.returncode == 1
    assert drift(res) == sorted([
        "nm.active.device.p2p-dev-wlp0s20f3", "nm.device.p2p-dev-wlp0s20f3.state", "nm.device.p2p-dev-wlp0s20f3.type",
        W + "ExecMainStartTimestamp", W + "MainPID", W + "ActiveState", W + "SubState", "wifi.phy.sha256",
    ])
    assert "REGULATORY_TRANSITION_APPROVED" in res.stdout  # the 00 -> TH transition was already approved


def test_live_attempt_2_pre_rb_findings_are_reproduced_exactly_by_the_v2_files(tmp_path: Path) -> None:
    res = rb(tmp_path, rec(), rb_fresh(), HND / "allow-dynamic-transitions-rollback.txt", transitions=False)
    assert res.returncode == 1
    d = drift(res)
    for k in ("nm.active.device.p2p-dev-wlp0s20f3", "nm.device.p2p-dev-wlp0s20f3.state", "nm.device.p2p-dev-wlp0s20f3.type", "wifi.reg.phy0", "wifi.reg.sha256",
              W + "MainPID", W + "ActiveState", W + "SubState", "wifi.phy.sha256"):
        assert k in d, k


def test_v3_fresh_post_accepts_exactly_the_live_side_effects(tmp_path: Path) -> None:
    res = post(tmp_path, rec(), post_fresh())
    assert res.returncode == 0, res.stdout + res.stderr
    assert drift(res) == []
    for k in ("nm.device.p2p-dev-wlp0s20f3.type", W + "MainPID", "wifi.phy.sha256", "nm.general"):
        assert f"DYNAMIC_TRANSITION_APPROVED\t{k}\t" in res.stdout, k
    assert "REGULATORY_TRANSITION_APPROVED" in res.stdout


def test_v3_fresh_rollback_accepts_the_proven_safe_equivalent_residuals_only(tmp_path: Path) -> None:
    res = rb(tmp_path, rec(), rb_fresh())
    assert res.returncode == 0, res.stdout + res.stderr
    assert drift(res) == []


# ── A. p2p pseudo-device: exact name/type/state ─────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "over",
    [
        {"nm.device.p2p-dev-wlp0s20f3.state": "connected"},
        {"nm.device.p2p-dev-wlp0s20f3.state": "unavailable"},          # unavailable is the ROLLBACK value, not the POST value
        {"nm.device.p2p-dev-wlp0s20f3.type": "wifi"},
        {"nm.device.p2p-dev-wlp0s20f3.type": "wifi-p2p-x"},
        {"nm.active.device.p2p-dev-wlp0s20f3": "aegis-idea3-ap:802-11-wireless"},
        {"nm.active.device.p2p-dev-wlp0s20f3": "x:wifi-p2p"},
    ],
)
def test_post_wrong_p2p_value_fails(tmp_path: Path, over: dict) -> None:
    res = post(tmp_path, rec(), post_fresh(**over))
    assert res.returncode == 1, res.stdout


@pytest.mark.parametrize(
    "extra",
    [
        {"nm.device.p2p-dev-wlan1.state": "disconnected", "nm.device.p2p-dev-wlan1.type": "wifi-p2p", "nm.active.device.p2p-dev-wlan1": "none"},
        {"nm.device.wlan1.state": "disconnected", "nm.device.wlan1.type": "wifi", "nm.active.device.wlan1": "none"},
        {"nm.device.br0.state": "connected", "nm.device.br0.type": "bridge", "nm.active.device.br0": "none"},
    ],
)
def test_any_other_new_networkmanager_device_remains_drift(tmp_path: Path, extra: dict) -> None:
    res = post(tmp_path, rec(), post_fresh(**extra))
    assert res.returncode == 1 and any("wlan1" in k or "br0" in k for k in drift(res))


def test_p2p_rollback_value_is_unavailable_only(tmp_path: Path) -> None:
    assert rb(tmp_path / "a", rec(), rb_fresh()).returncode == 0
    for bad in ("disconnected", "connected", "unmanaged"):
        assert rb(tmp_path / bad, rec(), rb_fresh(**{"nm.device.p2p-dev-wlp0s20f3.state": bad})).returncode == 1


# ── B. wpa_supplicant: relational, never a generic service allowance ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    "over",
    [
        {W + "UnitFileState": "enabled"},
        {W + "NRestarts": "1"},
        {W + "Result": "failed"},
        {W + "LoadState": "masked"},
        {W + "ActiveState": "activating"},
        {W + "SubState": "start"},
        {W + "MainPID": "0"},
        {W + "ExecMainStartTimestamp": ""},
    ],
)
def test_post_wpa_supplicant_lifecycle_needs_every_exact_condition(tmp_path: Path, over: dict) -> None:
    res = post(tmp_path, rec(), post_fresh(**over))
    assert res.returncode == 1, res.stdout


def test_post_wpa_requires_the_nm_radio_to_have_gone_disabled_to_enabled(tmp_path: Path) -> None:
    res = post(tmp_path, rec(), post_fresh(**{"nm.general": "connected:full:enabled:disabled"}))
    assert res.returncode == 1 and W + "ActiveState" in drift(res)


def test_post_wpa_requires_the_approved_ap_to_be_the_active_connection(tmp_path: Path) -> None:
    for v in ("none", "Pboo_5G:802-11-wireless", "aegis-idea3-ap:802-3-ethernet"):
        res = post(tmp_path / v.replace(":", "_"), rec(), post_fresh(**{"nm.active.device.wlp0s20f3": v}))
        assert res.returncode == 1, v


@pytest.mark.parametrize("dev", ["wlan1", "p2p-dev-wlp0s20f3"])
def test_post_wpa_fails_when_an_unrelated_wifi_connection_is_active(tmp_path: Path, dev: str) -> None:
    res = post(tmp_path, rec(), post_fresh(**{f"nm.active.device.{dev}": "Pboo_5G:802-11-wireless", "nm.device.wlan1.state": "connected",
                                              "nm.device.wlan1.type": "wifi"}))
    assert res.returncode == 1


def test_wpa_state_change_is_not_approved_by_any_key_only_allowance(tmp_path: Path) -> None:
    res = post(tmp_path, rec(), post_fresh(), dyn=None)
    assert res.returncode == 1 and W + "ActiveState" in drift(res) and W + "MainPID" in drift(res)


def test_wpa_active_to_inactive_is_not_a_catalog_transition(tmp_path: Path) -> None:
    res = post(tmp_path, residual_pre(), post_residual(**{W + "ActiveState": "inactive", W + "SubState": "dead", W + "MainPID": "0"}), dyn=P_POST_RES)
    assert res.returncode == 1


def test_wpa_rules_are_absent_from_the_residual_catalogs() -> None:
    for f in (P_POST_RES, P_RB_RES):
        assert not re.search(r"^svc\.wpa_supplicant", f.read_text(), re.M)


# ── C. regulatory + iw-phy digest ─────────────────────────────────────────────────────────────────────────────────────────


def test_target_regulatory_00_to_th_is_accepted_only_under_the_existing_window(tmp_path: Path) -> None:
    assert post(tmp_path / "w", rec(), post_fresh()).returncode == 0
    res = post(tmp_path / "n", rec(), post_fresh(), transitions=False)
    assert res.returncode == 1 and "wifi.reg.phy0" in drift(res)


@pytest.mark.parametrize(
    "over",
    [
        {"wifi.reg.global": "TH"},
        {"wifi.reg.phy0": "US"},
        {"wifi.reg.phy1": "TH"},
        {"wifi.reg.phy0": "00"},  # unchanged reg with a changed phy digest: not regulatory-derived
    ],
)
def test_unrelated_regulatory_change_fails(tmp_path: Path, over: dict) -> None:
    res = post(tmp_path, rec(), post_fresh(**over))
    assert res.returncode == 1, res.stdout


def test_regulatory_derived_iw_phy_delta_is_accepted_only_with_an_equal_regnorm_digest(tmp_path: Path) -> None:
    assert post(tmp_path / "ok", rec(), post_fresh()).returncode == 0
    res = post(tmp_path / "bad", rec(), post_fresh(**{"wifi.phy.regnorm_sha256": HEX("8")}))
    assert res.returncode == 1 and "wifi.phy.sha256" in drift(res)


@pytest.mark.parametrize(
    "over",
    [
        {"wifi.phy.channel6_permitted": "NO"},
        {"wifi.phy.channel6_permitted": "MISSING"},
        {"wifi.phy.ap_mode": "not-listed"},
        {"wifi.iface.wlp0s20f3.phy": "phy1"},
        {"wifi.phy.regnorm_sha256": "UNAVAILABLE"},
    ],
)
def test_iw_phy_delta_is_not_accepted_when_any_relational_condition_breaks(tmp_path: Path, over: dict) -> None:
    res = post(tmp_path, rec(), post_fresh(**over))
    assert res.returncode == 1, (over, res.stdout)


def test_iw_phy_delta_without_a_regnorm_digest_in_the_bundles_fails(tmp_path: Path) -> None:
    pre = rec()
    po = post_fresh()
    for d in (pre, po):
        d.pop("wifi.phy.regnorm_sha256")
    assert post(tmp_path, pre, po).returncode == 1


def test_wifi_phy_sha256_is_never_a_generic_allow_key() -> None:
    for f in HND.glob("allow-keys*.txt"):
        assert "wifi.phy" not in f.read_text(), f.name
    # and the compare script refuses to let ALLOW_KEYS approve it as a host/wifi protected key? it is not protected: the guard is absence + tests
    assert "wifi.phy.sha256 <sha256> <sha256>" in P_POST_FRESH.read_text()


def test_phy_rule_needs_the_fresh_operation_gate(tmp_path: Path) -> None:
    res = post(tmp_path, residual_pre(), post_residual(**{"wifi.phy.sha256": HEX("3")}), dyn=P_POST_RES)
    assert res.returncode == 1 and "wifi.phy.sha256" in drift(res)


# ── D. safe-equivalent rollback: proven residuals accepted, unsafe residuals rejected ─────────────────────────────────


@pytest.mark.parametrize(
    "over",
    [
        {"nm.general": "connected:full:enabled:enabled"},                       # radio still enabled
        {"wifi.rfkill.iface.wlp0s20f3.soft": "unblocked"},                      # target rfkill not restored
        {"nm.active.device.wlp0s20f3": "aegis-idea3-ap:802-11-wireless"},       # AP still active
        {"nm.active.device.wlan1": "Pboo_5G:802-11-wireless"},                  # some Wi-Fi connection active
        {"nm.device.wlp0s20f3.state": "connected"},
        {"net.addr.wlp0s20f3": "10.77.30.1/28"},                                # target still has IPv4
        {W + "UnitFileState": "enabled"},
        {W + "NRestarts": "3"},
        {W + "Result": "failed"},
        {SVC + "ActiveState": "active", SVC + "SubState": "running"},          # dnsmasq still running
        {"wifi.phy.regnorm_sha256": HEX("8")},                                  # a non-regulatory phy change
        {"wifi.reg.global": "TH"},
        {"listen.tcp.10.77.30.1:53": "present"},
        {"sysctl.net.ipv4.ip_forward": "1"},
    ],
)
def test_unsafe_rollback_residual_state_fails(tmp_path: Path, over: dict) -> None:
    res = rb(tmp_path, rec(), rb_fresh(**over))
    assert res.returncode == 1, (over, res.stdout)


def test_rollback_wpa_running_is_not_accepted_when_it_was_running_pre_and_changed(tmp_path: Path) -> None:
    res = rb(tmp_path, residual_pre(), residual_pre(**{W + "MainPID": "42"}), dyn=P_RB_RES, transitions=False)
    assert res.returncode == 1 and W + "MainPID" in drift(res)


# ── baselines: fresh and residual both work; mixed does not get accepted by the wrong catalog ───────────────────────────


def test_residual_baseline_pre_post_passes_with_the_residual_catalog(tmp_path: Path) -> None:
    res = post(tmp_path, residual_pre(), post_residual(), dyn=P_POST_RES)
    assert res.returncode == 0, res.stdout + res.stderr
    assert drift(res) == []


def test_residual_baseline_rollback_must_equal_pre_except_dnsmasq(tmp_path: Path) -> None:
    safe = residual_pre(**{SVC + "ActiveState": "inactive", SVC + "SubState": "dead", SVC + "Result": "success", SVC + "NRestarts": "0"})
    assert rb(tmp_path / "ok", residual_pre(), safe, dyn=P_RB_RES, transitions=False).returncode == 0
    for over in ({"nm.device.p2p-dev-wlp0s20f3.state": "disconnected"}, {W + "ActiveState": "inactive", W + "SubState": "dead"}, {"wifi.reg.phy0": "00"}):
        res = rb(tmp_path / str(len(over)) / next(iter(over)).replace(".", "_"), residual_pre(), {**safe, **over}, dyn=P_RB_RES, transitions=False)
        assert res.returncode == 1, over


def test_fresh_catalog_does_not_accept_a_residual_baseline_run_and_vice_versa(tmp_path: Path) -> None:
    # fresh catalog on residual bundles: p2p unavailable -> disconnected is not a fresh-catalog transition
    assert post(tmp_path / "1", residual_pre(), post_residual(), dyn=P_POST_FRESH).returncode == 1
    # residual catalog on fresh bundles: the appearance of the p2p device / wpa start is not a residual-catalog transition
    assert post(tmp_path / "2", rec(), post_fresh(), dyn=P_POST_RES).returncode == 1


def test_pre_rb_equal_states_need_no_transition(tmp_path: Path) -> None:
    assert rb(tmp_path, residual_pre(), residual_pre(), dyn=P_RB_RES, transitions=False).returncode == 0


# ── the opt-in file remains a closed catalog ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "content",
    [
        "operation L34_V3_POST_RESIDUAL\nsvc.wpa_supplicant.service.ActiveState inactive active\n",                   # fresh-only member in the residual op
        "operation L34_V3_POST_FRESH\nsvc.wpa_supplicant.service.ActiveState inactive *\n",
        "operation L34_V3_POST_FRESH\nsvc.wpa_supplicant.service.MainPID 0 5\n",
        "operation L34_V3_POST_FRESH\nsvc.wpa_supplicant.service.MainPID <positive> <positive>\n",
        "operation L34_V3_POST_FRESH\nwifi.phy.sha256 <sha256> abc\n",
        "operation L34_V3_POST_FRESH\nwifi.phy.regnorm_sha256 <sha256> <sha256>\n",
        "operation L34_V3_POST_FRESH\nnm.device.p2p-dev-wlan1.state <absent> disconnected\n",
        "operation L34_V3_POST_FRESH\nnm.device.p2p-dev-wlp0s20f3.state <absent> unavailable\n",                       # rollback value in the POST op
        "operation L34_V3_ROLLBACK_FRESH\nnm.device.p2p-dev-wlp0s20f3.state <absent> disconnected\n",
        "operation L34_V3_ROLLBACK_RESIDUAL\nnm.device.p2p-dev-wlp0s20f3.state <absent> unavailable\n",
        "operation L34_V3_POST_FRESH\nsvc.wpa_supplicant.service.UnitFileState disabled enabled\n",
        "operation L34_V3_POST_FRESH\noperation L34_V3_ROLLBACK_FRESH\nwifi.phy.sha256 <sha256> <sha256>\n",
        "operation L34_V3_UNKNOWN\nwifi.phy.sha256 <sha256> <sha256>\n",
    ],
)
def test_v3_dynamic_file_is_a_closed_catalog(tmp_path: Path, content: str) -> None:
    bad = tmp_path / "dyn.txt"
    bad.write_text(content)
    res = compare(tmp_path / "w", rec(), post_fresh(), bad, keys=HND / "allow-keys.txt")
    assert res.returncode == 2 and "COMPARE_RESULT=FAIL" in res.stdout, res.stdout


def test_v3_dynamic_files_contain_exactly_the_catalog_and_nothing_broader() -> None:
    for f in (P_POST_FRESH, P_POST_RES, P_RB_FRESH, P_RB_RES):
        lines = [l for l in f.read_text().splitlines() if l.strip() and not l.startswith("#")]
        assert lines[0].startswith("operation L34_V3_")
        assert len(lines) == len(set(lines)) and not any("*" in l for l in lines)


def test_v3_operations_do_not_change_v1_v2_behaviour(tmp_path: Path) -> None:
    assert base.cmp(tmp_path, base.PRE_RECORDS, base.post_records()).returncode == 0


# ── the regulatory-insensitive iw-phy normalizer ─────────────────────────────────────────────────────────────────────────

IW_PHY_00 = """Wiphy phy0
\tmax # scan SSIDs: 20
\tSupported interface modes:
\t\t * managed
\t\t * AP
\t\t * P2P-client
\tBand 1:
\t\tCapabilities: 0x19ef
\t\t\tRX LDPC
\t\tFrequencies:
\t\t\t* 2412.0 MHz [1] (22.0 dBm)
\t\t\t* 2437.0 MHz [6] (22.0 dBm)
\t\t\t* 2484.0 MHz [14] (22.0 dBm)
\tBand 2:
\t\tFrequencies:
\t\t\t* 5180.0 MHz [36] (22.0 dBm)
\t\t\t* 5500.0 MHz [100] (22.0 dBm)
\tSupported commands:
\t\t * new_interface
"""
IW_PHY_TH = (IW_PHY_00.replace("[14] (22.0 dBm)", "[14] (disabled)").replace("[36] (22.0 dBm)", "[36] (22.0 dBm) (no IR)")
             .replace("[100] (22.0 dBm)", "[100] (22.0 dBm) (no IR, radar detection)"))


def norm(text: str, mode: str = "norm") -> str:
    return subprocess.run(["awk", "-v", f"mode={mode}", "-f", str(AWK)], input=text, text=True, capture_output=True).stdout


def test_regulatory_annotations_are_removed_and_only_them() -> None:
    assert norm(IW_PHY_00) == norm(IW_PHY_TH)
    assert IW_PHY_00 != IW_PHY_TH
    n = norm(IW_PHY_00)
    assert "* 2437.0 MHz [6]\n" in n and "dBm" not in n and "Supported commands:" in n and "* AP" in n


@pytest.mark.parametrize(
    "edit",
    [
        lambda t: t.replace("\t\t * AP\n", ""),                                            # interface mode removed
        lambda t: t.replace("\t\t * new_interface\n", "\t\t * new_interface\n\t\t * start_ap\n"),   # supported command added
        lambda t: t.replace("RX LDPC", "RX LDPC\n\t\t\tTX STBC"),                            # capability added
        lambda t: t.replace("[6] (22.0 dBm)", "[7] (22.0 dBm)"),                            # a different channel set
        lambda t: t.replace("max # scan SSIDs: 20", "max # scan SSIDs: 4"),
        lambda t: t.replace("Wiphy phy0", "Wiphy phy1"),                                    # hardware/phy identity
        lambda t: t.replace("\t\t\t* 2412.0 MHz [1] (22.0 dBm)\n", ""),                    # a frequency entry removed
    ],
)
def test_non_regulatory_phy_differences_still_change_the_normalized_digest(edit) -> None:
    assert norm(edit(IW_PHY_00)) != norm(IW_PHY_00)


def test_channel6_fact_is_read_from_the_frequency_entry() -> None:
    assert norm(IW_PHY_00, "ch6").strip() == "YES"
    assert norm(IW_PHY_00.replace("[6] (22.0 dBm)", "[6] (22.0 dBm) (no IR)"), "ch6").strip() == "NO"
    assert norm(IW_PHY_00.replace("[6] (22.0 dBm)", "[6] (disabled)"), "ch6").strip() == "NO"
    assert norm(IW_PHY_00.replace("[6] (22.0 dBm)", "[6] (22.0 dBm) (radar detection)"), "ch6").strip() == "NO"
    assert norm(IW_PHY_00.replace("* 2437.0 MHz [6] (22.0 dBm)\n", ""), "ch6").strip() == "MISSING"


def test_the_normalizer_handles_multi_line_attribute_blocks() -> None:
    text = IW_PHY_00.replace("\t\t\t* 5180.0 MHz [36] (22.0 dBm)\n", "\t\t\t* 5180.0 MHz [36] (22.0 dBm)\n\t\t\t\tNo IR\n\t\t\t\tDFS state: usable (for 3 sec)\n")
    assert norm(text) == norm(IW_PHY_00)


def test_capture_records_the_normalized_digest_and_channel6_fact_through_the_helper() -> None:
    t = CAPTURE.read_text()
    assert "wifi.phy.regnorm_sha256" in t and "wifi.phy.channel6_permitted" in t and "p4-iw-phy-regnorm.awk" in t
    assert 'p4_rec "$WIFI" wifi.phy.sha256' in t  # the raw digest is still recorded unchanged
    assert AWK.is_file()
