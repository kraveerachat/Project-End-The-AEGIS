"""L3 stage-specific regulatory transition (owner Option 1, comparator approach a).

The L3 handler never mutates regulatory state. The only tolerated regulatory
change in a PRE/POST comparison is the target phy of wlp0s20f3 going 00 -> TH
(or staying TH), and only when the L3 allow-transitions file is supplied.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
HANDLER = DEPLOY / "stages" / "L3"
COMPARE = DEPLOY / "p4-compare.sh"
TRANSITIONS = HANDLER / "allow-transitions.txt"

_spec = importlib.util.spec_from_file_location("l3_handler_tests", ROOT / "tests" / "test_pr11_phase4_l3_handler.py")
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
make_bundle = _mod.make_bundle

BASE = {
    "wifi.iface.wlp0s20f3.phy": "phy0",
    "wifi.reg.global": "00",
    "wifi.reg.phy0": "00",
    "wifi.reg.sha256": "a" * 64,
}
IDEA2 = {"idea2.tunnel.MainPID": "398125", "idea2.tunnel.NRestarts": "16", "idea2.engine.MainPID": "868"}


def compare(tmp_path: Path, before: dict, after: dict, *, transitions: Path | None = TRANSITIONS,
            allow_keys: bool = True, iface: str = "wlp0s20f3") -> subprocess.CompletedProcess[str]:
    b = make_bundle(tmp_path / "b", "before", {**BASE, **IDEA2, **before})
    a = make_bundle(tmp_path / "a", "after", {**BASE, **IDEA2, **after})
    env = os.environ.copy()
    env["DISK_THRESHOLD_PCT"] = "90"
    env["AEGIS_AP_INTERFACE"] = iface
    if allow_keys:
        env["ALLOW_KEYS_FILE"] = str(HANDLER / "allow-keys.txt")
    if transitions is not None:
        env["ALLOW_TRANSITIONS_FILE"] = str(transitions)
    return subprocess.run(["bash", str(COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)


def reg(before_phy0: str, after_phy0: str, sha: bool = True, **extra) -> tuple[dict, dict]:
    b = {"wifi.reg.phy0": before_phy0}
    a = {"wifi.reg.phy0": after_phy0, **extra}
    if sha and before_phy0 != after_phy0:
        a["wifi.reg.sha256"] = "b" * 64
    return b, a


def passed(r: subprocess.CompletedProcess[str]) -> bool:
    return r.returncode == 0 and "COMPARE_RESULT=PASS" in r.stdout


def failed(r: subprocess.CompletedProcess[str]) -> bool:
    return r.returncode != 0 and "COMPARE_RESULT=FAIL" in r.stdout


def test_transitions_file_exists_and_is_exact() -> None:
    lines = [ln.split() for ln in TRANSITIONS.read_text().splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    assert lines == [["stage", "L3"], ["wifi.reg.<AEGIS_AP_PHY>", "00", "TH"]]


def test_l3_00_to_th_passes(tmp_path: Path) -> None:
    r = compare(tmp_path, *reg("00", "TH"))
    assert passed(r), r.stdout
    assert "REGULATORY_TRANSITION_APPROVED" in r.stdout


def test_l3_th_to_th_passes(tmp_path: Path) -> None:
    r = compare(tmp_path, *reg("TH", "TH"))
    assert passed(r), r.stdout


@pytest.mark.parametrize("b,a", [("00", "US"), ("00", "JP"), ("TH", "US"), ("TH", "00"), ("US", "TH"), ("00", "ZZ")])
def test_l3_other_transitions_fail(tmp_path: Path, b: str, a: str) -> None:
    r = compare(tmp_path, *reg(b, a))
    assert failed(r), r.stdout


def test_l3_unchanged_but_not_th_fails(tmp_path: Path) -> None:
    assert failed(compare(tmp_path, *reg("00", "00")))
    assert "REGULATORY_TARGET_NOT_APPROVED" in compare(tmp_path / "x", *reg("00", "00")).stdout


@pytest.mark.parametrize("side", ["before", "after", "both"])
def test_l3_missing_target_regulatory_state_fails(tmp_path: Path, side: str) -> None:
    def strip(records: dict) -> dict:
        return {k: v for k, v in records.items()}
    b, a = reg("00", "TH")
    b_full, a_full = {**BASE, **IDEA2, **b}, {**BASE, **IDEA2, **a}
    from_bundle = {"before": b_full, "after": a_full}
    bdir = make_bundle(tmp_path / "b", "before", {k: v for k, v in b_full.items() if not (side in ("before", "both") and k == "wifi.reg.phy0")})
    adir = make_bundle(tmp_path / "a", "after", {k: v for k, v in a_full.items() if not (side in ("after", "both") and k == "wifi.reg.phy0")})
    env = {**os.environ, "DISK_THRESHOLD_PCT": "90", "AEGIS_AP_INTERFACE": "wlp0s20f3",
           "ALLOW_KEYS_FILE": str(HANDLER / "allow-keys.txt"), "ALLOW_TRANSITIONS_FILE": str(TRANSITIONS)}
    r = subprocess.run(["bash", str(COMPARE), str(bdir), str(adir)], text=True, capture_output=True, env=env)
    assert failed(r), r.stdout
    assert from_bundle


def test_l3_unparseable_regulatory_value_fails(tmp_path: Path) -> None:
    assert failed(compare(tmp_path, *reg("00", "UNAVAILABLE")))
    assert failed(compare(tmp_path / "y", *reg("00", "th")))


def test_l3_missing_phy_mapping_fails(tmp_path: Path) -> None:
    b, a = reg("00", "TH")
    b["wifi.iface.wlp0s20f3.phy"] = "UNAVAILABLE"
    a["wifi.iface.wlp0s20f3.phy"] = "UNAVAILABLE"
    assert failed(compare(tmp_path, b, a))


def test_l3_phy_mapping_change_fails(tmp_path: Path) -> None:
    b, a = reg("00", "TH")
    a["wifi.iface.wlp0s20f3.phy"] = "phy1"
    a["wifi.reg.phy1"] = "TH"
    b["wifi.reg.phy1"] = "00"
    assert failed(compare(tmp_path, b, a))


def test_non_l3_00_to_th_fails(tmp_path: Path) -> None:
    r = compare(tmp_path, *reg("00", "TH"), transitions=None)
    assert failed(r)
    assert "REGULATORY_DRIFT" in r.stdout


def test_wrong_phy_00_to_th_fails(tmp_path: Path) -> None:
    b = {"wifi.reg.phy1": "00"}
    a = {"wifi.reg.phy1": "TH", "wifi.reg.sha256": "b" * 64, "wifi.reg.phy0": "TH"}
    b["wifi.reg.phy0"] = "TH"
    r = compare(tmp_path, b, a)
    assert failed(r)
    assert "REGULATORY_DRIFT" in r.stdout


def test_wrong_interface_fails(tmp_path: Path) -> None:
    r = compare(tmp_path, *reg("00", "TH"), iface="wlan1")
    assert failed(r) or r.returncode == 2


def test_global_unexpected_drift_fails(tmp_path: Path) -> None:
    b, a = reg("00", "TH", **{"wifi.reg.global": "TH"})
    assert failed(compare(tmp_path, b, a))
    b, a = reg("00", "TH", **{"wifi.reg.global": "US"})
    assert failed(compare(tmp_path / "z", b, a))


def test_hidden_regulatory_change_behind_sha_fails(tmp_path: Path) -> None:
    b, a = reg("00", "TH", **{"wifi.reg.phy1": "US"})
    assert failed(compare(tmp_path, b, a))


def test_sha_change_without_transition_fails(tmp_path: Path) -> None:
    assert failed(compare(tmp_path, {}, {"wifi.reg.sha256": "c" * 64}))


GOOD_STAGE = "stage L3"
GOOD_RULE = "wifi.reg.<AEGIS_AP_PHY> 00 TH"


@pytest.mark.parametrize("body", [
    f"{GOOD_STAGE}\nwifi.reg.<AEGIS_AP_PHY> 00 US\n",
    f"{GOOD_STAGE}\nwifi.reg.<AEGIS_AP_PHY> * TH\n",
    f"{GOOD_STAGE}\nwifi.reg.<AEGIS_AP_PHY> 00 *\n",
    f"{GOOD_STAGE}\nwifi.reg.phy1 00 TH\n",
    f"{GOOD_STAGE}\nwifi.reg.* 00 TH\n",
    f"{GOOD_STAGE}\nwifi.reg.global 00 TH\n",
    f"{GOOD_STAGE}\nwifi.reg.<AEGIS_AP_PHY> US TH\n",
    f"{GOOD_STAGE}\nwifi.reg.<AEGIS_AP_PHY>  00 TH\n",
    f"{GOOD_STAGE}\nwifi.reg.<AEGIS_AP_PHY> 00 TH extra\n",
    f"{GOOD_STAGE}\nwifi.reg.[a-z]+ 00 TH\n",
    f"{GOOD_STAGE}\n{GOOD_RULE}\n{GOOD_RULE}\n",
    f"{GOOD_STAGE}\n{GOOD_STAGE}\n{GOOD_RULE}\n",
    f"{GOOD_STAGE}\n{GOOD_RULE}\nwifi.reg.<AEGIS_AP_PHY> 00 US\n",
    f"{GOOD_STAGE}\n{GOOD_RULE}\nnet.dns.nameservers 1 2\n",
    f"stage L4\n{GOOD_RULE}\n",
    f"{GOOD_RULE}\n",
    f"{GOOD_STAGE}\n",
    "",
    f"{GOOD_STAGE}\r\n{GOOD_RULE}\r\n",
])
def test_transitions_file_cannot_be_broadened(tmp_path: Path, body: str) -> None:
    f = tmp_path / "t.txt"
    f.write_bytes(body.encode())
    r = compare(tmp_path / "d", *reg("00", "TH"), transitions=f)
    assert r.returncode == 2 and "STOP" in r.stdout, (body, r.stdout)


def test_transitions_file_comments_and_blank_lines_are_ignored(tmp_path: Path) -> None:
    f = tmp_path / "t.txt"
    f.write_text(f"# c\n\n{GOOD_STAGE}\n  \n# d\n{GOOD_RULE}\n")
    assert passed(compare(tmp_path / "d", *reg("00", "TH"), transitions=f))


def test_wifi_reg_can_never_be_approved_through_allow_keys(tmp_path: Path) -> None:
    for key in ("wifi.reg.phy0", "wifi.reg.global", "wifi.reg.sha256"):
        f = tmp_path / "k.txt"
        f.write_text(key + "\n")
        b = make_bundle(tmp_path / f"b{key}", "before", {**BASE, **IDEA2})
        a = make_bundle(tmp_path / f"a{key}", "after", {**BASE, **IDEA2})
        env = {**os.environ, "DISK_THRESHOLD_PCT": "90", "ALLOW_KEYS_FILE": str(f), "ALLOW_TRANSITIONS_FILE": str(TRANSITIONS)}
        r = subprocess.run(["bash", str(COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)
        assert r.returncode == 2 and "protected key cannot be approved" in r.stdout


def test_l3_allow_keys_file_does_not_contain_regulatory_keys() -> None:
    text = (HANDLER / "allow-keys.txt").read_text()
    assert "wifi.reg" not in "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))


# ---- capture schema / backward compatibility ----
def test_old_bundle_without_phy_key_is_still_comparable_outside_l3(tmp_path: Path) -> None:
    b = make_bundle(tmp_path / "b", "before", {"wifi.reg.global": "00", "wifi.reg.phy0": "TH"})
    a = make_bundle(tmp_path / "a", "after", {"wifi.reg.global": "00", "wifi.reg.phy0": "TH", "wifi.iface.wlp0s20f3.phy": "phy0"})
    env = {**os.environ, "DISK_THRESHOLD_PCT": "90"}
    r = subprocess.run(["bash", str(COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)
    assert passed(r), r.stdout
    assert "CAPTURE_FIELD_ADDED" in r.stdout


def test_removed_or_changed_phy_key_is_still_drift_outside_l3(tmp_path: Path) -> None:
    for before, after in (({"wifi.iface.wlp0s20f3.phy": "phy0"}, {}), ({"wifi.iface.wlp0s20f3.phy": "phy0"}, {"wifi.iface.wlp0s20f3.phy": "phy1"})):
        b = make_bundle(tmp_path / "b", "before", before)
        a = make_bundle(tmp_path / "a", "after", after)
        env = {**os.environ, "DISK_THRESHOLD_PCT": "90"}
        r = subprocess.run(["bash", str(COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)
        assert failed(r), r.stdout
        shutil.rmtree(tmp_path / "b"); shutil.rmtree(tmp_path / "a")


def test_l3_mode_requires_the_phy_key_in_both_bundles_even_for_old_evidence(tmp_path: Path) -> None:
    b = make_bundle(tmp_path / "b", "before", {"wifi.reg.global": "00", "wifi.reg.phy0": "00"})
    a = make_bundle(tmp_path / "a", "after", {"wifi.reg.global": "00", "wifi.reg.phy0": "TH", "wifi.iface.wlp0s20f3.phy": "phy0"})
    env = {**os.environ, "DISK_THRESHOLD_PCT": "90", "AEGIS_AP_INTERFACE": "wlp0s20f3", "ALLOW_TRANSITIONS_FILE": str(TRANSITIONS)}
    r = subprocess.run(["bash", str(COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)
    assert failed(r) and "REGULATORY_TARGET_PHY_UNRESOLVED" in r.stdout


def test_host_evidence_class_forces_the_target_interface(tmp_path: Path) -> None:
    text = COMPARE.read_text()
    assert 'TRANS_IFACE="wlp0s20f3"' in text


@pytest.mark.parametrize("key,b,a,code", [
    ("wifi.rfkill.iface.wlp0s20f3.hard", "unblocked", "blocked", "RFKILL_HARD_DRIFT"),
    ("net.dns.nameservers", "127.0.0.53", "1.1.1.1", "DNS_CONFIGURATION_DRIFT"),
    ("net.route4.default", "via 192.168.1.1 dev enp62s0", "via 10.0.0.1 dev wlp0s20f3", "DEFAULT_ROUTE_DRIFT"),
    ("sysctl.net.ipv4.ip_forward", "0", "1", "FORWARDING_ENABLED"),
    ("idea2.tunnel.MainPID", "398125", "999", "IDEA2_TUNNEL_RESTART_DRIFT"),
    ("idea2.tunnel.NRestarts", "16", "17", "IDEA2_TUNNEL_RESTART_DRIFT"),
    ("idea2.engine.MainPID", "868", "999", "IDEA2_ENGINE_DRIFT"),
    ("nm.device.enp62s0.state", "connected", "disconnected", "NM_DEVICE_DRIFT"),
])
def test_other_drift_still_fails_alongside_valid_transition(tmp_path: Path, key: str, b: str, a: str, code: str) -> None:
    rb, ra = reg("00", "TH")
    rb[key], ra[key] = b, a
    r = compare(tmp_path, rb, ra)
    assert failed(r), r.stdout
    assert code in r.stdout


def test_apply_checks_regulatory_state_only_after_rfkill_unblock_and_before_profile_install() -> None:
    text = _mod.code_text(HANDLER / "apply.sh")
    unblock = text.index('rfkill unblock "$rfkill_id"')
    gate = text.index("REGULATORY_DOMAIN_MISMATCH")
    install = text.index("install -D")
    activate = text.index("nmcli connection up")
    assert unblock < gate < install < activate


def test_apply_never_sets_regulatory_domain_and_only_reads_target_phy() -> None:
    import re
    text = _mod.code_text(HANDLER / "apply.sh")
    assert re.search(r"\biw\s+reg\s+set\b|\biw\s+phy\b.*\breg\b", text) is None
    assert "AP_COUNTRY_MUST_BE_TH" in text
    assert 'iw dev "$AP_IF" info' in text


def test_l3_regulatory_state_is_not_read_before_unblock() -> None:
    text = _mod.code_text(HANDLER / "apply.sh")
    before_unblock = text[: text.index('rfkill unblock "$rfkill_id"')]
    assert "iw reg get" not in before_unblock
