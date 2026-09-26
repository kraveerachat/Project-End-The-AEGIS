# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L3/L4 reactivation: live attempt 1 remediation (NM Wi-Fi radio) tests. Simulated host only.

Proven live condition (2026-09-27 attempt 1, evidence 2026-09-27-l34-reactivation-20260927-021304): rfkill target soft-blocked, NetworkManager
radio `disabled`, target device `unavailable`; after the exact rfkill unblock NetworkManager logged "Wi-Fi now enabled by radio killswitch" yet
`nmcli radio wifi` stayed `disabled` and the device stayed `unavailable` (NM's own software radio flag is off), so the bounded readiness wait
timed out with NM_WIFI_RADIO_DISABLED. The old workflow must keep failing closed; the new global-radio path exists only behind an explicit owner flag.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l34_sim as sim  # noqa: E402
import test_pr11_phase4_l34_reactivation as base  # noqa: E402

APPLY, VERIFY, ROLLBACK, RUNNER = base.APPLY, base.VERIFY, base.ROLLBACK, base.RUNNER
GLOBAL_ON = "nmcli radio wifi on"
GLOBAL_OFF = "nmcli radio wifi off"
AUTH = {"AEGIS_L34_NM_RADIO_ENABLE": "YES"}
LIVE = dict(nm_software_radio=False)  # the proven post-reboot NM state


def build(tmp_path: Path, **over) -> base.Fx:
    return base.build(tmp_path, **{**LIVE, **over})


def mut(fx: base.Fx) -> list[str]:
    return fx.mutating_calls()


# ── the proven live failure: the OLD workflow must keep failing closed with no global command ───────────────────────────


def test_proven_live_condition_pre_state(tmp_path: Path) -> None:
    fx = build(tmp_path)
    s = fx.state()
    assert s["rfkill_soft"] == 1 and s["nm_software_radio"] is False
    calls_before = len(fx.calls())
    assert sim._wifi_radio(s) == "disabled" and sim._device_state(s) == "unavailable"
    assert len(fx.calls()) == calls_before


def test_exact_rfkill_unblock_alone_leaves_nm_radio_disabled_and_target_unavailable(tmp_path: Path) -> None:
    fx = build(tmp_path)
    s = fx.state()
    s["rfkill_soft"] = 0  # what the exact unblock does
    assert sim._wifi_radio(s) == "disabled"
    assert sim._device_state(s) == "unavailable"


def test_old_workflow_fails_closed_with_nm_wifi_radio_disabled_and_issues_no_global_command(tmp_path: Path) -> None:
    fx = build(tmp_path)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "NM_WIFI_RADIO_DISABLED" in res.stderr
    assert mut(fx) == ["rfkill unblock 1"]  # the only mutation before failing closed
    assert GLOBAL_ON not in fx.calls() and GLOBAL_OFF not in fx.calls()
    assert not any(c.startswith("nmcli connection up") for c in fx.calls())
    assert (fx.work / "journal.tsv").read_text().splitlines() == ["RFKILL_UNBLOCK\t1"]


def test_old_workflow_rollback_restores_the_safe_pre_state_exactly(tmp_path: Path) -> None:
    fx = build(tmp_path)
    before = fx.persistent_state()
    assert fx.run(APPLY).returncode != 0
    n = len(fx.calls())
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert [c for c in fx.calls()[n:] if base.MUTATING.match(c)] == ["rfkill block 1"]
    s = fx.state()
    assert s["rfkill_soft"] == 1 and s["nm_software_radio"] is False and s["ap_active"] == 0 and s["dnsmasq"] == "failed"
    assert fx.persistent_state() == before


@pytest.mark.parametrize("value", ["", "NO", "1", "yes", "true", "YES "])
def test_only_the_exact_owner_flag_authorizes_the_global_radio_command(tmp_path: Path, value: str) -> None:
    fx = build(tmp_path)
    res = fx.run(APPLY, AEGIS_L34_NM_RADIO_ENABLE=value)
    assert res.returncode != 0 and "NM_WIFI_RADIO_DISABLED" in res.stderr
    assert GLOBAL_ON not in fx.calls()


def test_global_radio_command_is_scripted_exactly_once_and_only_in_the_authorized_branch() -> None:
    text = base.code_lines(APPLY)
    assert len(re.findall(r"nmcli radio wifi on", text)) == 1
    idx = text.index("nmcli radio wifi on")
    branch_start = text.rfind('if [ "${AEGIS_L34_NM_RADIO_ENABLE:-NO}" = YES', 0, idx)
    assert branch_start != -1 and "NM_WIFI_RADIO_ENABLE" in text[branch_start:idx]
    assert "nmcli radio wifi off" not in text and "nmcli radio wifi off" not in base.code_lines(VERIFY)
    assert len(re.findall(r"nmcli radio wifi off", base.code_lines(ROLLBACK))) == 1


# ── remediation model: journaled, guarded, single activation ────────────────────────────────────────────────────────────


def test_authorized_radio_enable_reactivates_with_the_exact_ordered_command_set(tmp_path: Path) -> None:
    fx = build(tmp_path)
    before = fx.persistent_state()
    res = fx.run(APPLY, **AUTH)
    assert res.returncode == 0, res.stdout + res.stderr
    assert mut(fx) == [
        "rfkill unblock 1",
        "nmcli device set wlp0s20f3 autoconnect no",
        "nmcli radio wifi on",
        "nmcli connection up aegis-idea3-ap ifname wlp0s20f3",
        "nmcli device set wlp0s20f3 autoconnect yes",
        "systemctl reset-failed aegis-idea3-dnsmasq.service",
        "systemctl start aegis-idea3-dnsmasq.service",
    ]
    s = fx.state()
    assert s["ap_active"] == 1 and s["dnsmasq"] == "active" and sim._wifi_radio(s) == "enabled"
    assert s["dev_autoconnect"] == "yes" and s["other_wifi_active"] is False and s["bt_rfkill_soft"] == 1
    assert fx.persistent_state() == before
    for m in ("NM_WIFI_RADIO_ENABLED_BY_RUN=YES", "GLOBAL_RADIO_CHANGE=YES", "PERSISTENT_FILES_REWRITTEN=NO"):
        assert m in res.stdout


def test_journal_records_every_new_change_before_it_happens(tmp_path: Path) -> None:
    fx = build(tmp_path)
    assert fx.run(APPLY, **AUTH).returncode == 0
    assert [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()] == [
        ("RFKILL_UNBLOCK", "1"),
        ("NM_DEVICE_AUTOCONNECT_DISABLE", "yes"),
        ("NM_WIFI_RADIO_ENABLE", "disabled"),
        ("NM_UP", "aegis-idea3-ap"),
        ("NM_DEVICE_AUTOCONNECT_RESTORED", "yes"),
        ("DNSMASQ_RESET_FAILED", "aegis-idea3-dnsmasq.service"),
        ("DNSMASQ_START", "aegis-idea3-dnsmasq.service"),
    ]


def test_no_double_activation_and_no_second_radio_command(tmp_path: Path) -> None:
    fx = build(tmp_path)
    assert fx.run(APPLY, **AUTH).returncode == 0
    calls = fx.calls()
    assert calls.count(GLOBAL_ON) == 1 and calls.count("nmcli connection up aegis-idea3-ap ifname wlp0s20f3") == 1
    assert GLOBAL_OFF not in calls
    assert sum(1 for c in calls if c.startswith("nmcli connection up")) == 1


def test_device_autoconnect_is_disabled_before_the_radio_is_enabled_so_no_known_profile_can_grab_the_device(tmp_path: Path) -> None:
    fx = build(tmp_path, autoconnect_profile_in_range=True)  # 12 autoconnect Wi-Fi profiles exist on the live host
    assert fx.run(APPLY, **AUTH).returncode == 0
    calls = fx.calls()
    assert calls.index("nmcli device set wlp0s20f3 autoconnect no") < calls.index(GLOBAL_ON)
    s = fx.state()
    assert s["other_wifi_active"] is False and s["ap_active"] == 1


def test_without_the_autoconnect_guard_the_simulated_host_would_be_hijacked(tmp_path: Path) -> None:
    """Sanity of the model: the guard is load-bearing, not decorative."""
    fx = build(tmp_path, autoconnect_profile_in_range=True, rfkill_soft=0)
    s = fx.state()
    subprocess.run([sys.executable, str(Path(sim.__file__)), "nmcli", "radio", "wifi", "on"], env=dict(os.environ, AEGIS_L34_SIM_DIR=str(fx.simd)), check=True)
    assert fx.state()["other_wifi_active"] is True and s["dev_autoconnect"] == "yes"


def test_already_enabled_radio_needs_no_global_command_and_rollback_never_disables_it(tmp_path: Path) -> None:
    fx = build(tmp_path, nm_software_radio=True)
    assert fx.run(APPLY, **AUTH).returncode == 0
    assert GLOBAL_ON not in fx.calls()
    assert ("NM_WIFI_RADIO_ENABLE", "disabled") not in [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()]
    n = len(fx.calls())
    assert fx.run(ROLLBACK).returncode == 0
    assert GLOBAL_OFF not in fx.calls()[n:]
    assert sim._wifi_radio(fx.state()) == "disabled"  # rfkill re-blocked; the software flag was never touched


# ── topology preflight: the global scope must be provably acceptable ────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "over,reason",
    [
        ({"extra_wifi_device": True}, "L34_WIFI_TOPOLOGY_NOT_SOLE_DEVICE"),
        ({"extra_rfkill_wlan": True}, "L34_WIFI_TOPOLOGY_RFKILL_WLAN_COUNT"),
        ({"other_wifi_active": True}, "L34_WIFI_ACTIVE_CONNECTION_PRESENT"),
    ],
)
def test_topology_that_widens_the_global_radio_scope_is_rejected_before_any_mutation(tmp_path: Path, over: dict, reason: str) -> None:
    fx = build(tmp_path, **over)
    res = fx.run(APPLY, **AUTH)
    assert res.returncode != 0 and reason in res.stderr, res.stderr
    base.no_mutation(fx)
    assert GLOBAL_ON not in fx.calls()


def test_second_sysfs_wireless_interface_is_rejected(tmp_path: Path) -> None:
    fx = build(tmp_path)
    (fx.root / "sys/class/net/wlan1/phy80211").mkdir(parents=True)
    res = fx.run(APPLY, **AUTH)
    assert res.returncode != 0 and "L34_WIFI_TOPOLOGY_NOT_SOLE_DEVICE" in res.stderr
    base.no_mutation(fx)


def test_unreadable_device_autoconnect_state_fails_before_any_mutation(tmp_path: Path) -> None:
    fx = build(tmp_path, dev_autoconnect="unknown")
    res = fx.run(APPLY, **AUTH)
    assert res.returncode != 0 and "L34_DEVICE_AUTOCONNECT_UNREADABLE" in res.stderr
    base.no_mutation(fx)


def test_topology_is_not_required_when_the_radio_is_already_enabled_but_still_checked_for_active_wifi(tmp_path: Path) -> None:
    fx = build(tmp_path, nm_software_radio=True, other_wifi_active=True)
    res = fx.run(APPLY, **AUTH)
    assert res.returncode != 0
    base.no_mutation(fx)


# ── failure paths and exact rollback ──────────────────────────────────────────────────────────────────────────────────────


def test_rollback_after_full_success_undoes_in_the_safe_order(tmp_path: Path) -> None:
    fx = build(tmp_path)
    before = fx.persistent_state()
    assert fx.run(APPLY, **AUTH).returncode == 0
    n = len(fx.calls())
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert [c for c in fx.calls()[n:] if base.MUTATING.match(c)] == [
        "systemctl stop aegis-idea3-dnsmasq.service",
        "nmcli connection down aegis-idea3-ap",
        "nmcli device set wlp0s20f3 autoconnect no",   # nothing may autoconnect between conn-down and radio-off
        "nmcli radio wifi off",
        "nmcli device set wlp0s20f3 autoconnect yes",  # prior value restored only once the radio is off
        "rfkill block 1",
    ]
    s = fx.state()
    assert sim._wifi_radio(s) == "disabled" and s["nm_software_radio"] is False and s["dev_autoconnect"] == "yes"
    assert s["ap_active"] == 0 and s["rfkill_soft"] == 1 and s["dnsmasq"] == "inactive" and s["other_wifi_active"] is False
    assert fx.persistent_state() == before
    for m in ("NM_WIFI_RADIO_RESTORED=YES", "L34_ROLLBACK=PASS"):
        assert m in res.stdout


def test_rollback_is_idempotent_with_the_radio_model(tmp_path: Path) -> None:
    fx = build(tmp_path)
    assert fx.run(APPLY, **AUTH).returncode == 0
    assert fx.run(ROLLBACK).returncode == 0
    n = len(fx.calls())
    again = fx.run(ROLLBACK)
    assert again.returncode == 0, again.stdout + again.stderr
    assert not [c for c in fx.calls()[n:] if c.startswith(("systemctl stop", "nmcli connection down", GLOBAL_ON))]
    assert sim._wifi_radio(fx.state()) == "disabled"


def test_readiness_timeout_after_radio_enable_restores_radio_autoconnect_and_rfkill(tmp_path: Path) -> None:
    fx = build(tmp_path, nm_ready_after_unblock=False)
    res = fx.run(APPLY, **AUTH)
    assert res.returncode != 0 and "NM_TARGET_DEVICE_NOT_READY" in res.stderr
    assert sum(1 for c in fx.calls() if c.startswith("nmcli connection up")) == 0
    assert fx.run(ROLLBACK).returncode == 0
    s = fx.state()
    assert s["nm_software_radio"] is False and s["dev_autoconnect"] == "yes" and s["rfkill_soft"] == 1


def test_radio_enable_failure_needs_no_radio_off_and_still_restores_everything_else(tmp_path: Path) -> None:
    fx = build(tmp_path, radio_on_works=False)
    res = fx.run(APPLY, **AUTH)
    assert res.returncode != 0
    n = len(fx.calls())
    assert fx.run(ROLLBACK).returncode == 0
    assert GLOBAL_OFF not in fx.calls()[n:]  # the radio was never enabled by this run
    s = fx.state()
    assert s["dev_autoconnect"] == "yes" and s["rfkill_soft"] == 1 and s["nm_software_radio"] is False


def test_device_set_failure_fails_before_the_global_command(tmp_path: Path) -> None:
    fx = build(tmp_path, device_set_works=False)
    res = fx.run(APPLY, **AUTH)
    assert res.returncode != 0 and GLOBAL_ON not in fx.calls()
    assert [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()][0] == ("RFKILL_UNBLOCK", "1")


def test_activation_failure_after_radio_enable_rolls_back_the_radio(tmp_path: Path) -> None:
    fx = build(tmp_path, nm_activation_works=False)
    res = fx.run(APPLY, **AUTH)
    assert res.returncode != 0 and "NMCLI_UP_FAILED" in res.stderr
    assert sum(1 for c in fx.calls() if c.startswith("nmcli connection up")) == 1  # one attempt only
    assert fx.run(ROLLBACK).returncode == 0
    s = fx.state()
    assert sim._wifi_radio(s) == "disabled" and s["ap_active"] == 0 and s["dev_autoconnect"] == "yes"


@pytest.mark.parametrize("line", ["NM_WIFI_RADIO_ENABLE\tall", "NM_DEVICE_AUTOCONNECT_DISABLE\tmaybe", "NM_DEVICE_AUTOCONNECT_RESTORED\tX Y"])
def test_rollback_rejects_tampered_radio_journal_entries(tmp_path: Path, line: str) -> None:
    fx = build(tmp_path)
    assert fx.run(APPLY, **AUTH).returncode == 0
    with (fx.work / "journal.tsv").open("a") as fh:
        fh.write(line + "\n")
    n = len(fx.calls())
    res = fx.run(ROLLBACK)
    assert res.returncode != 0 and ("JOURNAL_ENTRY_NOT_OWNED" in res.stderr or "JOURNAL_ENTRY_UNKNOWN" in res.stderr)
    assert not [c for c in fx.calls()[n:] if base.MUTATING.match(c)]


# ── verify ────────────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_verify_passes_after_authorized_radio_reactivation(tmp_path: Path) -> None:
    fx = build(tmp_path)
    assert fx.run(APPLY, **AUTH).returncode == 0
    res = fx.run(VERIFY, **AUTH)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "NM_WIFI_RADIO=ENABLED_BY_RUN" in res.stdout and "UNRELATED_WIFI_ACTIVE=NO" in res.stdout


def test_verify_rejects_an_unrelated_wifi_connection(tmp_path: Path) -> None:
    fx = build(tmp_path)
    assert fx.run(APPLY, **AUTH).returncode == 0
    fx.set(other_wifi_active=True)
    res = fx.run(VERIFY, **AUTH)
    assert res.returncode != 0 and "L34_UNRELATED_WIFI_ACTIVE" in res.stderr


def test_verify_rejects_device_autoconnect_left_changed(tmp_path: Path) -> None:
    fx = build(tmp_path)
    assert fx.run(APPLY, **AUTH).returncode == 0
    fx.set(dev_autoconnect="no")
    res = fx.run(VERIFY, **AUTH)
    assert res.returncode != 0 and "L34_DEVICE_AUTOCONNECT_NOT_RESTORED" in res.stderr


def test_verify_never_issues_a_radio_command(tmp_path: Path) -> None:
    fx = build(tmp_path)
    assert fx.run(APPLY, **AUTH).returncode == 0
    n = len(fx.calls())
    fx.run(VERIFY, **AUTH)
    assert not [c for c in fx.calls()[n:] if c.startswith("nmcli radio wifi ") and c != "nmcli radio wifi"]


# ── comparator: exact-value radio transition only ─────────────────────────────────────────────────────────────────────────


def test_pre_post_approves_only_the_exact_radio_flag_transition(tmp_path: Path) -> None:
    res = base.cmp(tmp_path, base.PRE_RECORDS, base.post_records())
    assert res.returncode == 0 and "nm.general" in res.stdout and "DYNAMIC_TRANSITION_APPROVED" in res.stdout


@pytest.mark.parametrize("value", ["connected:full:disabled:enabled", "connected:limited:enabled:enabled", "disconnected:full:enabled:enabled",
                                   "connected:full:enabled:enabled:extra"])
def test_pre_post_rejects_any_other_nm_general_value(tmp_path: Path, value: str) -> None:
    res = base.cmp(tmp_path, base.PRE_RECORDS, base.post_records(**{"nm.general": value}))
    assert res.returncode == 1, res.stdout


def test_an_unchanged_radio_flag_is_not_comparator_drift_so_verify_owns_the_enabled_proof(tmp_path: Path) -> None:
    """The comparator only judges CHANGES; that the radio really became enabled is proven by verify.sh (L34_NM_RADIO_NOT_ENABLED)."""
    res = base.cmp(tmp_path, base.PRE_RECORDS, base.post_records(**{"nm.general": "connected:full:enabled:disabled"}))
    assert res.returncode == 0
    fx = build(tmp_path / "v")
    assert fx.run(APPLY, **AUTH).returncode == 0
    fx.set(nm_software_radio=False)
    assert "L34_NM_RADIO_NOT_ENABLED" in fx.run(VERIFY, **AUTH).stderr or fx.run(VERIFY, **AUTH).returncode != 0


def test_pre_rb_requires_the_radio_flag_to_be_restored(tmp_path: Path) -> None:
    safe = dict(base.PRE_RECORDS, **{base.SVC + "ActiveState": "inactive", base.SVC + "SubState": "dead", base.SVC + "Result": "success",
                                     base.SVC + "NRestarts": "0"})
    assert base.cmp(tmp_path / "ok", base.PRE_RECORDS, safe, kind="rollback").returncode == 0
    still_on = dict(safe, **{"nm.general": "connected:full:enabled:enabled"})
    assert base.cmp(tmp_path / "bad", base.PRE_RECORDS, still_on, kind="rollback").returncode == 1


# ── runner: shell defect regression and V2 authority ──────────────────────────────────────────────────────────────────


def compare_function(text: str) -> str:
    start = text.index("compare() {")
    end = text.index("\nhandler() {", start)
    return text[start:end]


def run_runner_compare(tmp_path: Path, func: str, *, allow_mode: str = "post") -> subprocess.CompletedProcess[str]:
    mb = base._make_bundle()
    reg = {"wifi.iface.wlp0s20f3.phy": "phy0", "wifi.reg.phy0": "00"}  # the regulatory window needs the target phy in both bundles
    pre = mb(tmp_path / "b", "pre", {**base.PRE_RECORDS, **reg})
    post = mb(tmp_path / "a", "post", {**(base.post_records() if allow_mode == "post" else base.PRE_RECORDS), **reg})
    stubs = tmp_path / "bin"
    stubs.mkdir()
    (stubs / "sudo").write_text('#!/usr/bin/env bash\nexec "$@"\n')
    (stubs / "sudo").chmod(0o755)
    script = f"""set -uo pipefail
HND='{base.HND}'; P4='{base.DEPLOY}'; AP_IF=wlp0s20f3; AP_ADDR=10.77.30.1
{func}
compare '{pre}' '{post}' '{tmp_path / "report.txt"}' {allow_mode}
echo "COMPARE_FUNCTION_RC=$?"
"""
    return subprocess.run(["bash", "-c", script], text=True, capture_output=True, env=dict(os.environ, PATH=f"{stubs}:{os.environ['PATH']}"))


def test_runner_compare_function_has_valid_local_declarations_and_actually_runs(tmp_path: Path) -> None:
    res = run_runner_compare(tmp_path, compare_function(RUNNER.read_text()))
    assert "not a valid identifier" not in res.stderr, res.stderr
    assert res.stderr.strip() == "", res.stderr
    assert "COMPARE_FUNCTION_RC=0" in res.stdout and "COMPARE_RESULT=PASS" in res.stdout, res.stdout


def test_runner_compare_function_rollback_path_also_runs_clean(tmp_path: Path) -> None:
    res = run_runner_compare(tmp_path, compare_function(RUNNER.read_text()), allow_mode="rollback")
    assert "not a valid identifier" not in res.stderr, res.stderr


def test_the_regression_harness_detects_the_original_defect(tmp_path: Path) -> None:
    buggy = 'compare() { local kind=${4:-post} rc=0 local -a env_allow\n  :\n}'
    res = subprocess.run(["bash", "-c", buggy + "\ncompare a b c post"], text=True, capture_output=True)
    assert "not a valid identifier" in res.stderr  # bash -n accepts this text; only execution reveals it
    assert subprocess.run(["bash", "-n", "/dev/stdin"], input=buggy, text=True, capture_output=True).returncode == 0


def test_every_local_declaration_in_the_runner_and_handlers_is_valid_bash() -> None:
    for script in (RUNNER, APPLY, VERIFY, ROLLBACK, base.LIB):
        for m in re.finditer(r"^[^#\n]*\blocal\b[^\n;]*", script.read_text(), re.M):
            decl = m.group(0)
            assert not re.search(r"\blocal\b[^\n]*\s\blocal\b\s", decl), (script.name, decl)


V2_SCOPE = ("L3_L4_RUNTIME_REACTIVATION_V2: rfkill 1 unblock, temp wlp0s20f3 autoconnect off, NM radio on, activate aegis-idea3-ap, "
            "reset-failed+start dnsmasq, no persistent rewrite")
SUPERSEDED_V2_SCOPE = ("L3_L4_RUNTIME_REACTIVATION_V2: exact rfkill unblock, NM radio enable (sole Wi-Fi device), activate aegis-idea3-ap on wlp0s20f3, "
                       "reset-failed+start aegis-idea3-dnsmasq, no persistent config rewrite")
V1_SCOPE = ("L3_L4_RUNTIME_REACTIVATION: exact rfkill unblock, activate existing aegis-idea3-ap on wlp0s20f3, reset-failed+start aegis-idea3-dnsmasq, "
            "no persistent config rewrite")


def runner_scope() -> str:
    return re.search(r"^EXPECTED_SCOPE='([^']+)'", RUNNER.read_text(), re.M).group(1)


def test_runner_scope_is_exactly_the_final_v2_scope() -> None:
    scope = runner_scope()
    assert scope == V2_SCOPE
    assert len(scope) == 168 and len(scope) <= 200 and re.fullmatch(r"[ -~]{1,200}", scope)
    assert "AEGIS_L34_NM_RADIO_ENABLE=YES" in RUNNER.read_text()
    assert 'grep -qxF "scope=$EXPECTED_SCOPE"' in RUNNER.read_text()


def test_scope_names_every_runtime_mutation_including_the_temporary_autoconnect_change() -> None:
    scope = runner_scope()
    for phrase in ("rfkill 1 unblock", "temp wlp0s20f3 autoconnect off", "NM radio on", "activate aegis-idea3-ap", "reset-failed+start dnsmasq",
                   "no persistent rewrite"):
        assert phrase in scope, phrase
    # every mutation the handlers perform is covered by the scope text
    apply_text = base.code_lines(APPLY)
    assert "nmcli device set" in apply_text and "autoconnect" in scope
    assert "nmcli radio wifi on" in apply_text and "radio on" in scope


@pytest.mark.parametrize("stale", [SUPERSEDED_V2_SCOPE, V1_SCOPE, V2_SCOPE + " ", V2_SCOPE[:-1], V2_SCOPE.replace("temp wlp0s20f3 autoconnect off, ", ""),
                                   V2_SCOPE.lower()])
def test_any_other_scope_is_rejected_by_the_runner_gate(tmp_path: Path, stale: str) -> None:
    """The runner's gate is `grep -qxF "scope=$EXPECTED_SCOPE" <auth>`: run exactly that check against a record carrying the other scope."""
    auth = tmp_path / "authorization-L4.txt"
    auth.write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage=L4\ndate=2026-09-27\nauthorizer=music\nscope={stale}\nreference=file:/x#A-L4\n")
    res = subprocess.run(["bash", "-c", 'grep -qxF "scope=$S" "$A"'], env=dict(os.environ, S=runner_scope(), A=str(auth)))
    assert res.returncode == 1
    ok = tmp_path / "ok.txt"
    ok.write_text(f"scope={V2_SCOPE}\n")
    assert subprocess.run(["bash", "-c", 'grep -qxF "scope=$S" "$A"'], env=dict(os.environ, S=runner_scope(), A=str(ok))).returncode == 0


def test_superseded_and_v1_scopes_appear_nowhere_as_the_active_scope() -> None:
    text = RUNNER.read_text()
    assert SUPERSEDED_V2_SCOPE not in text and V1_SCOPE not in text
    docs = (base.ROOT / "docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-nm-radio-remediation-design.md").read_text()
    assert V2_SCOPE in docs and SUPERSEDED_V2_SCOPE not in docs


STALE_GLOBAL_RADIO_CLAIMS = [
    r"never touch(es)?[^,;.\n]*\bthe global (Wi-Fi )?radio",      # unqualified claim in one clause
    r"never touch(es)?[^;.\n]*regulatory state,\s*the global",
    r"regulatory state,\s*the global (Wi-Fi )?radio",
    r"never `nmcli radio wifi on`",
]


@pytest.mark.parametrize("path", [RUNNER, APPLY, ROLLBACK, VERIFY, base.LIB])
def test_no_stale_never_touches_global_radio_claim_remains_in_the_v2_surfaces(path: Path) -> None:
    text = re.sub(r"\s*\n#\s*", " ", path.read_text())  # join wrapped comment lines
    for pat in STALE_GLOBAL_RADIO_CLAIMS:
        assert not re.search(pat, text), (path.name, pat)


@pytest.mark.parametrize("path", [RUNNER, APPLY, ROLLBACK])
def test_v2_surfaces_state_the_global_radio_rules_accurately(path: Path) -> None:
    text = re.sub(r"\s*\n#\s*", " ", path.read_text())
    assert "FORBIDDEN BY DEFAULT" in text
    assert re.search(r"only|EXACTLY ONCE|exactly ONCE|single owner-authorized", text)
    assert "persistent" in text and "NetworkManager" in text


def test_the_comments_state_the_four_required_rules() -> None:
    joined = " ".join(re.sub(r"\s*\n#\s*", " ", p.read_text()) for p in (RUNNER, APPLY, ROLLBACK))
    assert "FORBIDDEN BY DEFAULT" in joined                                                        # 1. forbidden by default
    assert "EXACTLY ONCE" in joined and "sole Wi-Fi device" in joined                              # 2. once, under V2 + sole-device topology gate
    assert "only when the journal proves THIS run enabled it" in joined                            # 3. rollback only if this run enabled it
    assert "No persistent NetworkManager configuration is rewritten" in joined                     # 4. no persistent NM config rewrite


def test_stage_gate_accepts_a_v2_scope_record(tmp_path: Path) -> None:
    scope = re.search(r"^EXPECTED_SCOPE='([^']+)'", RUNNER.read_text(), re.M).group(1)
    today = subprocess.run(["date", "+%F"], env=dict(os.environ, TZ="Asia/Bangkok"), text=True, capture_output=True).stdout.strip()
    auth = tmp_path / "authorization-L4.txt"
    auth.write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage=L4\ndate={today}\nauthorizer=music\nscope={scope}\nreference=file:/x/OWNER-APPROVAL.txt#A-L4\n")
    k3 = tmp_path / "k3-L4.txt"
    k3.write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage=L4\ndate={today}\nconfirmed_by=music\nconfirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\n"
                  "idea1_window_overlap=NONE_KNOWN\nreference=file:/x/OWNER-APPROVAL.txt#K3-L4\n")
    res = subprocess.run(["bash", str(base.DEPLOY / "p4-stage-gate.sh"), "--stage", "L4", "--mode", "simulate", "--authorization", str(auth), "--k3", str(k3)],
                         text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok"))
    assert res.returncode == 0 and "AUTHORIZATION_RECORD=VALID" in res.stdout, res.stdout + res.stderr


def test_one_attempt_semantics_and_governance_are_unchanged() -> None:
    t = RUNNER.read_text()
    assert "l34_consume_attempt" in t and t.count("nmcli connection up") == 0
    assert "--stage L4 --mode live" in t and "stage=L4" in t
    assert len(re.findall(r"handler apply\.sh", t)) == 2 and len(re.findall(r"handler rollback\.sh", t)) == 1
    assert "NO new L3_LIVE_ACCEPTANCE / L4_LIVE_ACCEPTANCE claim" in t


def test_runner_still_forbids_l3_l4_apply_l6b_esp32_and_persistent_rewrites() -> None:
    t = base.code_lines(RUNNER)
    assert not re.search(r"stages/L[34]/(apply|rollback|verify)\.sh", t) and "run-l6b" not in t and "esptool" not in t
    assert not re.search(r"nmcli\s+(radio|connection|device)\b", t)  # the runner never issues NM commands itself; only the handlers do
