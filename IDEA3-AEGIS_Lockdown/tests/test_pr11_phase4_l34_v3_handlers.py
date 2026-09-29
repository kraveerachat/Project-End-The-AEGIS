# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L3/L4 reactivation V3 handlers and runner (live attempt 2 remediation). Simulated host only.

Attempt 2's runtime path passed; the preservation model did not. These tests drive the real handlers against a simulator that reproduces the exact
side effects proven live: `nmcli radio wifi on` creates p2p-dev-wlp0s20f3 and starts wpa_supplicant, the AP activation moves the target phy 00 -> TH,
and none of that is undone by rollback (which itself stops only what it started). The two supported baselines (FRESH, RESIDUAL) are both exercised.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l34_sim as sim  # noqa: E402
import test_pr11_phase4_l34_reactivation as base  # noqa: E402
import test_pr11_phase4_l34_nm_radio as radio  # noqa: E402

APPLY, VERIFY, ROLLBACK, RUNNER, LIB = base.APPLY, base.VERIFY, base.ROLLBACK, base.RUNNER, base.LIB
V3 = {"AEGIS_L34_NM_RADIO_ENABLE": "YES", "AEGIS_L34_PRESERVATION": "V3", "AEGIS_L34_PREFLIGHT_ONLY": "NO"}
LIVE_FRESH = dict(nm_software_radio=False, nm_init_side_effects=True, phy_country="00", p2p_present=False, wpa_active=False)
LIVE_RESIDUAL = dict(nm_software_radio=False, nm_init_side_effects=True, phy_country="TH", p2p_present=True, wpa_active=True)


def fresh(tmp: Path, **over) -> base.Fx:
    return base.build(tmp, **{**LIVE_FRESH, **over})


def residual(tmp: Path, **over) -> base.Fx:
    return base.build(tmp, **{**LIVE_RESIDUAL, **over})


def code(path: Path) -> str:
    return base.code_lines(path)


# ── fresh baseline: the exact live sequence, now accepted end to end ─────────────────────────────────────────────────────


def test_fresh_baseline_reproduces_the_proven_side_effects_and_passes_apply_and_verify(tmp_path: Path) -> None:
    fx = fresh(tmp_path)
    before = fx.persistent_state()
    res = fx.run(APPLY, **V3)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L34_BASELINE=FRESH" in res.stdout and (fx.work / "baseline.txt").read_text().strip() == "FRESH"
    s = fx.state()
    # the proven live side effects of NetworkManager Wi-Fi initialization
    assert s["p2p_present"] is True and s["wpa_active"] is True and s["phy_country"] == "TH" and s["ap_active"] == 1
    v = fx.run(VERIFY, **V3)
    assert v.returncode == 0, v.stdout + v.stderr
    assert "L34_V3_SIDE_EFFECTS=WITHIN_ENVELOPE" in v.stdout and "L34_BASELINE=FRESH" in v.stdout
    assert fx.persistent_state() == before


def test_fresh_baseline_rollback_is_safe_equivalent_and_reports_exactness_separately(tmp_path: Path) -> None:
    fx = fresh(tmp_path)
    assert fx.run(APPLY, **V3).returncode == 0
    n = len(fx.calls())
    res = fx.run(ROLLBACK, **V3)
    assert res.returncode == 0, res.stdout + res.stderr
    for m in ("L34_ROLLBACK=PASS", "SAFE_NETWORK_BOUNDARY_RESTORED=YES", "EXACT_PRESTATE_RESTORED=NO", "L34_ROLLBACK_MODEL=SAFE_EQUIVALENT"):
        assert m in res.stdout, m
    s = fx.state()
    # the safety invariants
    assert radio.sim._wifi_radio(s) == "disabled" and s["rfkill_soft"] == 1 and s["ap_active"] == 0 and s["dnsmasq"] == "inactive"
    assert s["other_wifi_active"] is False and s["dev_autoconnect"] == "yes"
    # the proven residuals are left exactly as they are: nothing is stopped, removed or reset to make them disappear
    assert s["wpa_active"] is True and s["p2p_present"] is True and s["phy_country"] == "TH"
    later = fx.calls()[n:]
    assert not any(c.startswith(("systemctl stop wpa_supplicant", "systemctl restart", "iw reg set", "nmcli device delete", "nmcli general", "nmcli connection delete"))
                   for c in later)
    assert [c for c in later if base.MUTATING.match(c)] == [
        "systemctl stop aegis-idea3-dnsmasq.service", "nmcli connection down aegis-idea3-ap", "nmcli device set wlp0s20f3 autoconnect no",
        "nmcli radio wifi off", "nmcli device set wlp0s20f3 autoconnect yes", "rfkill block 1",
    ]


def test_residual_baseline_reactivates_and_its_rollback_is_exact(tmp_path: Path) -> None:
    fx = residual(tmp_path)
    res = fx.run(APPLY, **V3)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L34_BASELINE=RESIDUAL" in res.stdout
    assert fx.run(VERIFY, **V3).returncode == 0
    rb = fx.run(ROLLBACK, **V3)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    assert "SAFE_NETWORK_BOUNDARY_RESTORED=YES" in rb.stdout and "EXACT_PRESTATE_RESTORED=YES" in rb.stdout
    s = fx.state()
    assert s["wpa_active"] is True and s["p2p_present"] is True and s["phy_country"] == "TH" and radio.sim._wifi_radio(s) == "disabled"


@pytest.mark.parametrize("builder", [fresh, residual])
def test_both_baselines_use_exactly_the_same_bounded_mutation_set_as_v2(tmp_path: Path, builder) -> None:
    fx = builder(tmp_path)
    assert fx.run(APPLY, **V3).returncode == 0
    assert fx.mutating_calls() == [
        "rfkill unblock 1", "nmcli device set wlp0s20f3 autoconnect no", "nmcli radio wifi on", "nmcli connection up aegis-idea3-ap ifname wlp0s20f3",
        "nmcli device set wlp0s20f3 autoconnect yes", "systemctl reset-failed aegis-idea3-dnsmasq.service", "systemctl start aegis-idea3-dnsmasq.service",
    ]


# ── baseline classification: both supported, mixed rejected before any mutation ───────────────────────────────────────


@pytest.mark.parametrize(
    "over,reason",
    [
        ({"phy_country": "TH"}, "L34_BASELINE_MIXED_OR_UNRECOGNIZED"),                                   # TH without the residual p2p/wpa
        ({"p2p_present": True}, "L34_BASELINE_MIXED_OR_UNRECOGNIZED"),                                    # p2p without TH/wpa
        ({"wpa_active": True}, "L34_BASELINE_MIXED_OR_UNRECOGNIZED"),                                     # wpa active without the residual
        ({"phy_country": "TH", "p2p_present": True}, "L34_BASELINE_MIXED_OR_UNRECOGNIZED"),               # wpa still inactive
        ({"phy_country": "TH", "wpa_active": True}, "L34_BASELINE_MIXED_OR_UNRECOGNIZED"),                # no p2p device
        ({"wpa_unit_file_state": "enabled"}, "WPA_UnitFileState"),
        ({"wpa_nrestarts": 2}, "WPA_NRestarts"),
        ({"nm_software_radio": True, "rfkill_soft": 0}, "NM_RADIO_NOT_DISABLED"),                        # radio already enabled: neither baseline
        ({"p2p_present": True, "p2p_state_override": "disconnected", "phy_country": "TH", "wpa_active": True}, "L34_BASELINE_MIXED_OR_UNRECOGNIZED"),
    ],
)
def test_mixed_or_unrecognized_baselines_are_rejected_before_any_mutation(tmp_path: Path, over: dict, reason: str) -> None:
    fx = base.build(tmp_path, **{**LIVE_FRESH, **over})
    res = fx.run(APPLY, **V3)
    assert res.returncode != 0 and reason in res.stderr, res.stderr
    base.no_mutation(fx)


def test_a_non_unavailable_target_is_not_a_baseline(tmp_path: Path) -> None:
    fx = fresh(tmp_path, device_state_override="disconnected")
    res = fx.run(APPLY, **V3)
    assert res.returncode != 0 and "TARGET_NOT_UNAVAILABLE" in res.stderr
    base.no_mutation(fx)


def test_preflight_only_reports_the_baseline_for_the_runner(tmp_path: Path) -> None:
    for name, builder in (("FRESH", fresh), ("RESIDUAL", residual)):
        fx = builder(tmp_path / name)
        res = fx.run(APPLY, **{**V3, "AEGIS_L34_PREFLIGHT_ONLY": "YES"})
        assert res.returncode == 0 and f"L34_BASELINE={name}" in res.stdout and "L34_PREFLIGHT=PASS" in res.stdout, res.stderr
        base.no_mutation(fx)


def test_v3_requires_the_explicit_radio_authorization_flag(tmp_path: Path) -> None:
    fx = fresh(tmp_path)
    res = fx.run(APPLY, AEGIS_L34_PRESERVATION="V3")
    assert res.returncode != 0 and "L34_V3_REQUIRES_NM_RADIO_ENABLE" in res.stderr
    base.no_mutation(fx)


def test_without_the_v3_flag_the_v2_behaviour_and_baseline_free_preflight_are_unchanged(tmp_path: Path) -> None:
    fx = fresh(tmp_path)
    res = fx.run(APPLY, AEGIS_L34_NM_RADIO_ENABLE="YES")
    assert res.returncode == 0 and "L34_BASELINE" not in res.stdout and not (fx.work / "baseline.txt").exists()


# ── verify: the envelope is exact ─────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "mutate,reason",
    [
        ({"extra_nm_device": True}, "L34_V3_UNEXPECTED_NM_DEVICE"),
        ({"p2p_state_override": "connected"}, "L34_V3_P2P_DEVICE_STATE"),
        ({"p2p_state_override": "unavailable"}, "L34_V3_P2P_DEVICE_STATE"),
        ({"wpa_unit_file_state": "enabled"}, "L34_V3_WPA_SUPPLICANT_UnitFileState"),
        ({"wpa_nrestarts": 1}, "L34_V3_WPA_SUPPLICANT_NRestarts"),
        ({"wpa_active": False}, "L34_V3_WPA_SUPPLICANT_ActiveState"),
        ({"other_wifi_active": True}, "L34_UNRELATED_WIFI_ACTIVE"),
    ],
)
def test_verify_rejects_anything_outside_the_v3_envelope(tmp_path: Path, mutate: dict, reason: str) -> None:
    fx = fresh(tmp_path)
    assert fx.run(APPLY, **V3).returncode == 0
    fx.set(**mutate)
    res = fx.run(VERIFY, **V3)
    assert res.returncode != 0 and reason in res.stderr, res.stderr


# ── rollback: unsafe residuals are rejected ────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "mutate,reason",
    [
        ({"wpa_unit_file_state": "enabled"}, "L34_V3_ROLLBACK_WPA_UNIT_UnitFileState"),
        ({"wpa_nrestarts": 4}, "L34_V3_ROLLBACK_WPA_UNIT_NRestarts"),
        ({"p2p_state_override": "connected"}, "L34_V3_ROLLBACK_P2P_DEVICE_STATE"),
        ({"extra_nm_device": True}, "L34_V3_ROLLBACK_UNEXPECTED_NM_DEVICE"),
        ({"phy_country": "US"}, "L34_V3_ROLLBACK_REGULATORY_STATE"),
    ],
)
def test_unsafe_rollback_residuals_fail_the_handler_proof(tmp_path: Path, mutate: dict, reason: str) -> None:
    fx = fresh(tmp_path)
    assert fx.run(APPLY, **V3).returncode == 0
    fx.set(**mutate)
    res = fx.run(ROLLBACK, **V3)
    assert res.returncode != 0 and reason in res.stderr, res.stderr


def test_rollback_after_a_failed_apply_still_reports_the_safe_boundary(tmp_path: Path) -> None:
    fx = fresh(tmp_path, nm_activation_works=False)
    assert fx.run(APPLY, **V3).returncode != 0
    res = fx.run(ROLLBACK, **V3)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "SAFE_NETWORK_BOUNDARY_RESTORED=YES" in res.stdout and "EXACT_PRESTATE_RESTORED=NO" in res.stdout  # NM already created p2p/wpa
    s = fx.state()
    assert radio.sim._wifi_radio(s) == "disabled" and s["ap_active"] == 0 and s["rfkill_soft"] == 1


# ── no new host mutation is introduced ────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("script", [APPLY, VERIFY, ROLLBACK, RUNNER, LIB])
def test_no_v3_surface_stops_wpa_supplicant_sets_the_regulatory_domain_or_restarts_networkmanager(script: Path) -> None:
    text = code(script)
    for pat in (
        r"systemctl\s+(stop|restart|kill|disable|mask|reload)\s+[^\n]*wpa_supplicant", r"\bpkill\b[^\n]*wpa", r"\bkillall\b", r"wpa_cli\b", r"wpa_supplicant\s+-",
        r"iw\s+reg\s+set", r"\biw\s+dev\s+\S+\s+(del|set)\b", r"iw\s+phy\s+\S+\s+interface\s+(add|del)",
        r"systemctl\s+(restart|reload|stop|start)\s+[^\n]*NetworkManager", r"nmcli\s+(general|networking)\s+", r"nmcli\s+device\s+(delete|disconnect|reapply|modify)",
        r"nmcli\s+connection\s+(delete|modify|reload|add|import)", r"nmcli\s+radio\s+wifi\s+off\b(?!.*rollback)" if script is not ROLLBACK else r"nmcli\s+radio\s+all",
    ):
        assert not re.search(pat, text), (script.name, pat)


def test_the_only_systemctl_mutations_remain_the_exact_dnsmasq_unit() -> None:
    for script in (APPLY, ROLLBACK):
        for m in re.finditer(r"systemctl\s+(reset-failed|start|stop)\s+(\S+)", code(script)):
            assert "L34_UNIT" in m.group(2), (script.name, m.group(0))


def test_the_comparator_change_adds_no_generic_allowance() -> None:
    compare = base.COMPARE.read_text()
    assert "DYN_CATALOG_L34_V3_POST_FRESH" in compare and "DYN_CATALOG_L34_V3_ROLLBACK_FRESH" in compare
    for f in base.HND.glob("allow-keys*.txt"):
        text = f.read_text()
        assert "wpa_supplicant" not in text and "p2p-dev" not in text and "wifi.phy" not in text, f.name


# ── runner V3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_runner_is_still_an_unpinned_template_that_refuses_to_run(tmp_path: Path) -> None:
    import subprocess

    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in RUNNER.read_text()
    res = subprocess.run(["bash", str(RUNNER), str(tmp_path)], text=True, capture_output=True)
    assert res.returncode == 2 and "not pinned" in res.stdout


def test_runner_scope_is_the_v3_scope_and_v2_and_v1_are_not_accepted() -> None:
    t = RUNNER.read_text()
    scope = re.search(r"^EXPECTED_SCOPE='([^']+)'", t, re.M).group(1)
    assert scope == radio.V3_SCOPE and len(scope) <= 200 and "_V3:" in scope
    assert radio.V2_SCOPE not in t and radio.V1_SCOPE not in t and radio.SUPERSEDED_V2_SCOPE not in t
    assert 'grep -qxF "scope=$EXPECTED_SCOPE"' in t


def test_runner_passes_the_v3_flags_and_selects_catalogs_from_the_reported_baseline() -> None:
    t = RUNNER.read_text()
    assert "AEGIS_L34_NM_RADIO_ENABLE=YES AEGIS_L34_PRESERVATION=V3" in t
    assert 'grep -x \'L34_BASELINE=\\(FRESH\\|RESIDUAL\\)\'' in t and "exactly one recognized L34_BASELINE" in t
    assert 'allow-dynamic-transitions-v3-post-$BASELINE.txt' in t and 'allow-dynamic-transitions-v3-rollback-$BASELINE.txt' in t
    assert '[ "$BASELINE" != fresh ] || env_allow+=(ALLOW_TRANSITIONS_FILE=' in t   # the 00->TH window in rollback only for the fresh baseline
    assert 'ALLOW_TRANSITIONS_FILE="$HND/allow-transitions.txt"' in t                # POST always carries the existing regulatory window


def test_runner_rollback_flow_rechecks_l6b_inactive_and_no_8883_and_reports_the_safe_boundary() -> None:
    t = RUNNER.read_text()
    flow = t[t.index("rollback_flow() {"): t.index("fail_after_mutation() {")]
    assert "aegis-idea3-mosquitto.service ActiveState" in flow and 'sport = :8883' in flow and "identity_unchanged" in flow
    assert "SAFE_NETWORK_BOUNDARY_RESTORED=YES" in flow and "NOT retrying" in flow


def test_runner_one_attempt_semantics_and_governance_are_unchanged() -> None:
    t = RUNNER.read_text()
    assert "l34_consume_attempt" in t and "--stage L4 --mode live" in t and "stage=L4" in t
    assert len(re.findall(r"handler apply\.sh", t)) == 2 and len(re.findall(r"handler rollback\.sh", t)) == 1
    assert t.index("l34_consume_attempt") < t.index('capture PRE "$EVID/pre-root"') < t.index("apply_out=$(handler apply.sh")
    assert "NO new L3_LIVE_ACCEPTANCE / L4_LIVE_ACCEPTANCE claim" in t


def test_runner_never_issues_network_commands_itself() -> None:
    assert not re.search(r"nmcli\s+(radio|connection|device)\b|\brfkill\s+(un)?block|\biw\s+(dev|phy|reg)\b|systemctl\s+(start|stop|restart|reset-failed|enable|disable)", code(RUNNER))


def test_runner_compare_function_runs_clean_for_both_baselines_and_kinds(tmp_path: Path) -> None:
    func = radio.compare_function(RUNNER.read_text())
    for baseline in ("fresh", "residual"):
        for kind in ("post", "rollback"):
            work = tmp_path / f"{baseline}-{kind}"
            work.mkdir()
            res = radio.run_runner_compare(work, func, allow_mode=kind, baseline=baseline)
            assert "not a valid identifier" not in res.stderr, res.stderr
            assert "COMPARE_FUNCTION_RC=" in res.stdout


def test_runner_compare_function_refuses_an_unknown_baseline(tmp_path: Path) -> None:
    res = radio.run_runner_compare(tmp_path, radio.compare_function(RUNNER.read_text()), baseline="unknown")
    assert "COMPARE_BASELINE_UNKNOWN" in res.stdout and "COMPARE_FUNCTION_RC=1" in res.stdout


# ══ Review round 2 (PR #225): strict P2P inventory, baseline-aware rollback proofs, WPA safe state ══════════════════════════════════

REASON = "L34_BASELINE_MIXED_OR_UNRECOGNIZED"


def with_(profile: dict, **over) -> dict:
    return {**profile, **over}


@pytest.mark.parametrize(
    "label,over",
    [
        ("same name, wrong type (fresh-looking host)", with_(LIVE_FRESH, p2p_present=True, p2p_type_override="ethernet")),
        ("same name, wrong type (residual-looking host)", with_(LIVE_RESIDUAL, p2p_type_override="ethernet")),
        ("same name, type wifi (a second Wi-Fi device)", with_(LIVE_RESIDUAL, p2p_type_override="wifi")),
        ("a second p2p device on a fresh host", with_(LIVE_FRESH, extra_p2p_device=True)),
        ("correct residual p2p plus a second p2p device", with_(LIVE_RESIDUAL, extra_p2p_device=True)),
        ("differently named p2p only (fresh-looking)", with_(LIVE_FRESH, p2p_present=True, p2p_name_override="p2p-dev-wlan9")),
        ("differently named p2p only (residual-looking)", with_(LIVE_RESIDUAL, p2p_name_override="p2p-dev-wlan9")),
        ("wrong residual p2p state", with_(LIVE_RESIDUAL, p2p_state_override="disconnected")),
        ("residual p2p state connected", with_(LIVE_RESIDUAL, p2p_state_override="connected")),
        ("fresh host with the residual p2p device but 00/inactive", with_(LIVE_FRESH, p2p_present=True)),
        ("a second Wi-Fi device (target no longer sole)", with_(LIVE_FRESH, extra_wifi_device=True)),
    ],
)
def test_p2p_inventory_is_validated_completely_and_never_inferred_from_an_empty_typed_query(tmp_path: Path, label: str, over: dict) -> None:
    fx = base.build(tmp_path, **over)
    res = fx.run(APPLY, **V3)
    assert res.returncode != 0 and REASON in res.stderr, (label, res.stderr)
    base.no_mutation(fx)
    assert not (fx.work / "baseline.txt").exists()


def test_exact_fresh_and_residual_inventories_are_the_only_accepted_ones(tmp_path: Path) -> None:
    for name, builder in (("FRESH", fresh), ("RESIDUAL", residual)):
        fx = builder(tmp_path / name)
        res = fx.run(APPLY, **{**V3, "AEGIS_L34_PREFLIGHT_ONLY": "YES"})
        assert res.returncode == 0 and f"L34_BASELINE={name}" in res.stdout, res.stderr


def test_the_classifier_takes_the_whole_inventory_not_a_typed_helper_result() -> None:
    lib = code(LIB)
    assert "l34_p2p_inventory" in lib
    apply = code(APPLY)
    assert "l34_p2p_device_state" not in apply.split("radio_authorized=0")[0]        # baseline classification no longer uses the typed helper


# ── baseline-aware rollback proofs ─────────────────────────────────────────────────────────────────────────────────────


def applied_v3(fx: base.Fx) -> None:
    res = fx.run(APPLY, **V3)
    assert res.returncode == 0, res.stdout + res.stderr


def rollback_v3(fx: base.Fx):
    return fx.run(ROLLBACK, **V3)


@pytest.mark.parametrize("baseline_builder", [fresh, residual])
@pytest.mark.parametrize(
    "mutate",
    [
        {"p2p_type_override": "ethernet"},
        {"p2p_name_override": "p2p-dev-wlan9"},
        {"extra_p2p_device": True},
        {"p2p_state_override": "disconnected"},
        {"p2p_state_override": "connected"},
    ],
)
def test_rollback_rejects_every_p2p_inventory_that_is_not_the_exact_unavailable_row(tmp_path: Path, baseline_builder, mutate: dict) -> None:
    fx = baseline_builder(tmp_path)
    applied_v3(fx)
    fx.set(**mutate)
    res = rollback_v3(fx)
    assert res.returncode != 0 and "L34_V3_ROLLBACK_P2P" in res.stderr, res.stderr
    assert "SAFE_NETWORK_BOUNDARY_RESTORED=YES" not in res.stdout


def test_fresh_rollback_accepts_p2p_absent_or_the_exact_unavailable_row(tmp_path: Path) -> None:
    exact = fresh(tmp_path / "exact")
    applied_v3(exact)
    assert rollback_v3(exact).returncode == 0
    absent = fresh(tmp_path / "absent")
    applied_v3(absent)
    absent.set(p2p_present=False)
    res = rollback_v3(absent)
    assert res.returncode == 0, res.stderr and "SAFE_NETWORK_BOUNDARY_RESTORED=YES" in res.stdout


def test_residual_rollback_requires_the_exact_unavailable_row_absence_is_not_safe(tmp_path: Path) -> None:
    fx = residual(tmp_path)
    applied_v3(fx)
    fx.set(p2p_present=False)
    res = rollback_v3(fx)
    assert res.returncode != 0 and "L34_V3_ROLLBACK_P2P" in res.stderr
    assert "SAFE_NETWORK_BOUNDARY_RESTORED=YES" not in res.stdout


WPA_BAD = [
    {"wpa_state_override": "failed"}, {"wpa_state_override": "activating"}, {"wpa_state_override": "deactivating"}, {"wpa_state_override": "exited"},
    {"wpa_pid_override": 0},  # active/running with MainPID 0
]


@pytest.mark.parametrize("baseline_builder", [fresh, residual])
@pytest.mark.parametrize("mutate", WPA_BAD)
def test_rollback_rejects_every_wpa_supplicant_state_that_is_not_a_proven_safe_state(tmp_path: Path, baseline_builder, mutate: dict) -> None:
    fx = baseline_builder(tmp_path)
    applied_v3(fx)
    fx.set(**mutate)
    res = rollback_v3(fx)
    assert res.returncode != 0 and "L34_V3_ROLLBACK_WPA_STATE" in res.stderr, res.stderr
    assert "SAFE_NETWORK_BOUNDARY_RESTORED=YES" not in res.stdout


def test_fresh_rollback_accepts_wpa_exact_pre_state_or_the_proven_running_residual(tmp_path: Path) -> None:
    running = fresh(tmp_path / "running")
    applied_v3(running)
    assert rollback_v3(running).returncode == 0                                   # active/running/PID>0 (proven residual)
    pre = fresh(tmp_path / "pre")
    applied_v3(pre)
    pre.set(wpa_active=False)                                                     # inactive/dead/MainPID 0 (exact PRE state)
    res = rollback_v3(pre)
    assert res.returncode == 0 and "SAFE_NETWORK_BOUNDARY_RESTORED=YES" in res.stdout, res.stderr
    assert "EXACT_PRESTATE_RESTORED" in res.stdout


def test_residual_rollback_requires_wpa_active_running_and_rejects_inactive(tmp_path: Path) -> None:
    fx = residual(tmp_path)
    applied_v3(fx)
    fx.set(wpa_active=False)
    res = rollback_v3(fx)
    assert res.returncode != 0 and "L34_V3_ROLLBACK_WPA_STATE" in res.stderr
    assert "SAFE_NETWORK_BOUNDARY_RESTORED=YES" not in res.stdout


@pytest.mark.parametrize("baseline_builder", [fresh, residual])
def test_rollback_still_rejects_wpa_unit_facts_and_never_stops_wpa_supplicant(tmp_path: Path, baseline_builder) -> None:
    fx = baseline_builder(tmp_path)
    applied_v3(fx)
    n = len(fx.calls())
    assert rollback_v3(fx).returncode == 0
    assert not any(c.startswith(("systemctl stop wpa_supplicant", "systemctl restart", "systemctl start wpa_supplicant")) for c in fx.calls()[n:])
    for mutate, reason in (({"wpa_unit_file_state": "enabled"}, "UnitFileState"), ({"wpa_nrestarts": 2}, "NRestarts")):
        fx2 = baseline_builder(tmp_path / reason)
        applied_v3(fx2)
        fx2.set(**mutate)
        res = rollback_v3(fx2)
        assert res.returncode != 0 and reason in res.stderr


def test_the_safe_boundary_line_is_printed_only_after_every_proof_including_wpa_and_p2p() -> None:
    text = ROLLBACK.read_text()
    printed = text.index("printf 'SAFE_NETWORK_BOUNDARY_RESTORED=YES")
    for needle in ("L34_V3_ROLLBACK_WPA_STATE", "L34_V3_ROLLBACK_P2P", "L34_V3_ROLLBACK_WPA_UNIT_"):
        assert text.index(needle) < printed, needle
