# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — governed dnsmasq repair SUCCESSOR: the exact SAFE_STOPPED baseline. Simulated host only.

The first live attempt (PR #308 runner) was consumed and ended ROLLBACK_FAILED_ESCALATE at S10 (IDEA2 already unhealthy). Its governed rollback left dnsmasq in the
exact safe stopped state (loaded/enabled/inactive/dead/success/MainPID 0). This file proves the narrow extension that lets a FUTURE, separately authorized successor
attempt start from that state, and that nothing else was widened:

* the classifier admits SAFE_STOPPED only for that exact property set (any other inactive shape refuses; FAILED / RUNNING are unchanged);
* SAFE_STOPPED apply is exactly `daemon-reload` then `start dnsmasq` (no reset-failed, no restart) plus the owned unit install;
* SAFE_STOPPED rollback restores the exact old unit bytes, reloads, stops only dnsmasq and returns to the exact SAFE_STOPPED state;
* the comparator window is the task-specific catalog DNSMASQ_SAFE_STOPPED_POST (inactive->active, dead->running) and nothing wider.

The runner-level pieces (pre-consume S10 guard, historical AUTH_DIR refusal, brand-new AUTH_DIR) are in test_pr11_phase4_dnsmasq_unit_repair_owner_run_flow.py.
Pure repository / simulated-host test: no live command, no Production mutation, no authorization or K3 is created.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import test_pr11_phase4_dnsmasq_unit_repair as rep  # noqa: E402
import test_pr11_phase4_dnsmasq_unit_repair_reboot_and_scope as scope  # noqa: E402
import test_pr11_phase4_l34_reactivation as base  # noqa: E402

DNSMASQ_UNIT = rep.DNSMASQ_UNIT
OLD_UNIT, NEW_UNIT = rep.OLD_UNIT, rep.NEW_UNIT
HND = rep.HND
SS_FILE = HND / "allow-dynamic-transitions-safe-stopped-post.txt"
SVC = scope.SVC

SAFE_STOPPED_PROPS = "LoadState=loaded\nUnitFileState=enabled\nActiveState=inactive\nSubState=dead\nResult=success\nMainPID=0\n"


def stopped_host(tmp: Path, **over):
    """The exact post-rollback host of the first attempt: AP up and correct, OLD pre-PR305 unit, dnsmasq inactive/dead/success, no dnsmasq listener."""
    return rep.repair_host(tmp, "failed", dnsmasq="inactive", **over)


def classify(props: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", "-c", f'source "{base.LIB}"; source "{rep.REPAIR_LIB}"; dnsrepair_baseline_classify'], input=props, text=True, capture_output=True)


# ── 1. exact classifier ──────────────────────────────────────────────────────────────────────────────────────────────────


def test_classifier_accepts_exactly_the_safe_stopped_state() -> None:
    res = classify(SAFE_STOPPED_PROPS)
    assert res.returncode == 0 and res.stdout.strip() == "SAFE_STOPPED", res.stderr


@pytest.mark.parametrize("key,value", [
    ("Result", "exit-code"), ("Result", "start-limit-hit"), ("Result", "signal"),             # wrong Result
    ("UnitFileState", "disabled"), ("UnitFileState", "masked"), ("UnitFileState", "static"),  # wrong UnitFileState
    ("LoadState", "masked"), ("LoadState", "not-found"),
    ("SubState", "failed"), ("SubState", "exited"),
    ("MainPID", "7"),
])
def test_classifier_refuses_every_other_inactive_shape(key: str, value: str) -> None:
    props = SAFE_STOPPED_PROPS.replace(next(l for l in SAFE_STOPPED_PROPS.splitlines() if l.startswith(key + "=")), f"{key}={value}")
    res = classify(props)
    assert res.returncode != 0 and f"DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED:{key}" in res.stderr and res.stdout.strip() == ""


@pytest.mark.parametrize("active", ["activating", "deactivating", "reloading", "maintenance"])
def test_classifier_still_refuses_unknown_active_states(active: str) -> None:
    res = classify(SAFE_STOPPED_PROPS.replace("ActiveState=inactive", f"ActiveState={active}"))
    assert res.returncode != 0 and "BASELINE_UNSUPPORTED:ActiveState" in res.stderr


def test_classifier_failed_and_running_are_unchanged() -> None:
    failed = classify("LoadState=loaded\nUnitFileState=enabled\nActiveState=failed\nSubState=failed\nResult=start-limit-hit\nMainPID=0\n")
    running = classify("LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nSubState=running\nResult=success\nMainPID=4242\n")
    assert failed.stdout.strip() == "FAILED" and running.stdout.strip() == "RUNNING"
    assert classify("LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nSubState=running\nResult=success\nMainPID=0\n").returncode != 0


# ── 2. preflight (read-only) ─────────────────────────────────────────────────────────────────────────────────────────────


def test_safe_stopped_preflight_is_read_only_and_reports_the_baseline(tmp_path: Path) -> None:
    fx = stopped_host(tmp_path)
    res = rep.run(fx, rep.APPLY, AEGIS_DNSREPAIR_PREFLIGHT_ONLY="YES")
    assert res.returncode == 0, res.stdout + res.stderr
    assert "DNSMASQ_REPAIR_BASELINE=SAFE_STOPPED" in res.stdout and "DNSMASQ_REPAIR_PREFLIGHT=PASS" in res.stdout and "PRODUCTION_MUTATION_PERFORMED=NO" in res.stdout
    rep.no_mutation(fx)
    assert rep.installed(fx) == OLD_UNIT.encode() and fx.state()["dnsmasq"] == "inactive"


@pytest.mark.parametrize("over,reason", [
    (dict(stray_ap_listeners=["udp67"]), "L34_V6_AP_DNS_DHCP_LISTENER_PRESENT"),
    (dict(stray_ap_listeners=["tcp53"]), "L34_V6_AP_DNS_DHCP_LISTENER_PRESENT"),
    (dict(stray_ap_listeners=["udp53"]), "L34_V6_AP_DNS_DHCP_LISTENER_PRESENT"),
    (dict(dnsmasq_props_override={"Result": "exit-code"}), "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED:Result"),
    (dict(dnsmasq_props_override={"UnitFileState": "disabled"}), "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED:UnitFileState"),
    (dict(dnsmasq_props_override={"MainPID": "9"}), "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED:MainPID"),
    (dict(need_reload_override={DNSMASQ_UNIT: "yes"}), "DNSREPAIR_NEEDS_DAEMON_RELOAD"),
    (dict(ap_active=0), "L34_AP_NOT_IN_AP_MODE"),
    (dict(active_ssid="OTHER"), "L34_AP_SSID_MISMATCH"),
    (dict(active_channel=11), "L34_AP_CHANNEL_MISMATCH"),
    (dict(sysctl_override={"net.ipv4.ip_forward": 1}), "L34_FORWARDING_NOT_ZERO"),
    (dict(nft=""), "TABLE_MISSING"),
    (dict(identities={**rep.sim.DEFAULT_STATE["identities"], rep.CORE_UNIT: [0, 0], rep.BROKER_UNIT: [5100, 3]}), "L34_V7_CORE_NOT_HEALTHY"),
])
def test_safe_stopped_preflight_keeps_every_existing_gate(tmp_path: Path, over: dict, reason: str) -> None:
    fx = stopped_host(tmp_path, **over)
    res = rep.run(fx, rep.APPLY)
    assert res.returncode != 0 and reason in res.stderr, res.stdout + res.stderr
    rep.no_mutation(fx)
    assert rep.installed(fx) == OLD_UNIT.encode()


def test_safe_stopped_with_an_unknown_or_canonical_unit_is_refused(tmp_path: Path) -> None:
    for unit_text, reason in ((OLD_UNIT + "# edit\n", "DNSREPAIR_UNIT_UNKNOWN_AUTHORITY"), (NEW_UNIT, "DNSREPAIR_UNIT_ALREADY_CANONICAL")):
        fx = stopped_host(tmp_path / reason, unit_text=unit_text)
        res = rep.run(fx, rep.APPLY)
        assert res.returncode != 0 and reason in res.stderr
        rep.no_mutation(fx)


# ── 3. apply: exactly daemon-reload + start ──────────────────────────────────────────────────────────────────────────────


def test_safe_stopped_apply_command_set_is_exactly_daemon_reload_then_start(tmp_path: Path) -> None:
    fx = stopped_host(tmp_path)
    res = rep.applied(fx)
    assert rep.mutating(fx) == ["systemctl daemon-reload", f"systemctl start {DNSMASQ_UNIT}"]
    assert rep.installed(fx) == NEW_UNIT.encode() and fx.state()["dnsmasq"] == "active"
    assert "DNSMASQ_REPAIR_APPLY=PASS" in res.stdout and "DNSMASQ_REPAIR_BASELINE=SAFE_STOPPED" in res.stdout


def test_safe_stopped_apply_has_no_reset_failed_and_no_restart(tmp_path: Path) -> None:
    fx = stopped_host(tmp_path)
    rep.applied(fx)
    assert not any("reset-failed" in c or " restart " in c + " " for c in fx.calls())
    assert rep.journal_kinds(fx) == ["UNIT_BACKUP", "UNIT_INSTALL", "DAEMON_RELOAD", "DNSMASQ_START"]
    calls = fx.calls()
    assert calls.index("systemctl daemon-reload") < calls.index(f"systemctl start {DNSMASQ_UNIT}")


def test_safe_stopped_apply_never_commands_ap_network_core_broker_twingate_idea2_or_esp32(tmp_path: Path) -> None:
    fx = stopped_host(tmp_path)
    rep.applied(fx)
    for call in fx.calls():
        assert not call.startswith(("nmcli connection", "nmcli radio", "nmcli device set", "rfkill block", "rfkill unblock", "iw reg", "ip addr", "ip link", "ip route add")), call
        assert not call.startswith(("nft add", "nft delete", "nft flush", "nft insert", "nft replace", "nft -f", "sysctl -w", "esptool", "mosquitto_pub", "screen", "minicom")), call
        if any(k in call for k in ("mosquitto", "aegis-idea3-core", "twingate", "aegis-detection")):
            assert call.startswith(("systemctl show", "journalctl -u")), call


def test_safe_stopped_apply_then_verify_passes(tmp_path: Path) -> None:
    fx = stopped_host(tmp_path)
    rep.applied(fx)
    res = rep.run(fx, rep.VERIFY)
    assert res.returncode == 0 and "DNSMASQ_REPAIR_VERIFY=PASS" in res.stdout and "DNSMASQ_REPAIR_BASELINE=SAFE_STOPPED" in res.stdout, res.stdout + res.stderr


def test_failed_and_running_apply_command_sets_are_unchanged(tmp_path: Path) -> None:
    f = rep.repair_host(tmp_path / "f", "failed")
    rep.applied(f)
    assert rep.mutating(f) == ["systemctl daemon-reload", f"systemctl reset-failed {DNSMASQ_UNIT}", f"systemctl start {DNSMASQ_UNIT}"]
    r = rep.repair_host(tmp_path / "r", "running")
    rep.applied(r)
    assert rep.mutating(r) == ["systemctl daemon-reload", f"systemctl restart {DNSMASQ_UNIT}"]


# ── 4. rollback returns SAFE_STOPPED ─────────────────────────────────────────────────────────────────────────────────────


def _props(fx) -> str:
    return subprocess.run(["bash", "-c", "systemctl show -p LoadState -p ActiveState -p SubState -p UnitFileState -p Result -p MainPID " + DNSMASQ_UNIT],
                          text=True, capture_output=True, env=fx.env()).stdout


def test_rollback_after_start_failure_restores_exact_old_unit_stops_only_dnsmasq_and_returns_safe_stopped(tmp_path: Path) -> None:
    fx = stopped_host(tmp_path, dnsmasq_fail_after_reload=True)
    assert rep.run(fx, rep.APPLY).returncode != 0
    n = len(fx.calls())
    res = rep.run(fx, rep.ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert rep.installed(fx) == OLD_UNIT.encode(), "the digest-proven old unit bytes"
    assert rep.mutating(fx, n) == ["systemctl daemon-reload", f"systemctl stop {DNSMASQ_UNIT}"]
    assert fx.state()["dnsmasq"] == "inactive" and classify(_props(fx)).stdout.strip() == "SAFE_STOPPED", "inactive/dead/success/MainPID 0; no manufactured start-limit-hit"
    assert "DNSMASQ_REPAIR_ROLLBACK=PASS" in res.stdout and "STALE_START_LIMIT_HIT_RECREATED=NO" in res.stdout and "DNSMASQ_BASELINE=SAFE_STOPPED" in res.stdout
    assert not any("reset-failed" in c or "restart" in c for c in rep.mutating(fx, n))


def test_rollback_after_a_fully_successful_apply_returns_to_safe_stopped(tmp_path: Path) -> None:
    fx = stopped_host(tmp_path)
    rep.applied(fx)
    n = len(fx.calls())
    res = rep.run(fx, rep.ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert rep.installed(fx) == OLD_UNIT.encode() and rep.mutating(fx, n) == ["systemctl daemon-reload", f"systemctl stop {DNSMASQ_UNIT}"]
    assert classify(_props(fx)).stdout.strip() == "SAFE_STOPPED"


@pytest.mark.parametrize("stage", ["after_backup", "after_install", "after_reload"])
def test_rollback_after_an_early_failure_never_stops_or_starts_a_service_it_did_not_start(tmp_path: Path, stage: str) -> None:
    fx = stopped_host(tmp_path)
    assert rep.run(fx, rep.APPLY, AEGIS_DNSREPAIR_FAIL_AT=stage).returncode != 0
    n = len(fx.calls())
    res = rep.run(fx, rep.ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert rep.installed(fx) == OLD_UNIT.encode()
    assert not any(c.startswith(("systemctl stop", "systemctl start", "systemctl restart", "systemctl reset-failed")) for c in rep.mutating(fx, n)), "journal ownership: no start was journaled"
    assert classify(_props(fx)).stdout.strip() == "SAFE_STOPPED"


def test_rollback_ownership_is_journal_based_and_fails_closed(tmp_path: Path) -> None:
    fx = stopped_host(tmp_path, dnsmasq_fail_after_reload=True)
    assert rep.run(fx, rep.APPLY).returncode != 0
    with (fx.work / "journal.tsv").open("a") as f:
        f.write("DNSMASQ_START\taegis-idea3-mosquitto.service\n")
    n = len(fx.calls())
    res = rep.run(fx, rep.ROLLBACK)
    assert res.returncode != 0 and "JOURNAL_ENTRY_NOT_OWNED" in res.stderr and rep.mutating(fx, n) == []
    (fx.work / "unit.old").write_bytes(b"tampered\n")
    fx2 = stopped_host(tmp_path / "two", dnsmasq_fail_after_reload=True)
    assert rep.run(fx2, rep.APPLY).returncode != 0
    (fx2.work / "unit.old").write_bytes(b"tampered\n")
    assert "UNIT_BACKUP_CORRUPT" in rep.run(fx2, rep.ROLLBACK).stderr


def test_rollback_with_unrecognized_baseline_is_refused(tmp_path: Path) -> None:
    fx = stopped_host(tmp_path)
    assert rep.run(fx, rep.APPLY, AEGIS_DNSREPAIR_FAIL_AT="after_install").returncode != 0
    (fx.work / "baseline.txt").write_text("INACTIVE\n")
    assert "BASELINE_UNRECOGNIZED" in rep.run(fx, rep.ROLLBACK).stderr


# ── 5. exact comparator window (real p4-compare.sh) ──────────────────────────────────────────────────────────────────────

SS_PRE = {**scope.ROLLED_BACK, SVC + "MainPID": "0", SVC + "NRestarts": "0"}
SS_POST = {**SS_PRE, SVC + "ActiveState": "active", SVC + "SubState": "running", SVC + "MainPID": "4343", SVC + "ExecMainStartTimestamp": "Sat 2026-10-03 03:00:00 +07"}


def cmp_ss(tmp: Path, pre: dict, post: dict, window: Path | None = SS_FILE, *, keys: bool = True) -> subprocess.CompletedProcess[str]:
    import os

    mk = base._make_bundle()
    b, a = mk(tmp / "b", "pre", pre), mk(tmp / "a", "post", post)
    env = os.environ.copy()
    env.update(DISK_THRESHOLD_PCT="90", AEGIS_AP_INTERFACE="wlp0s20f3", AEGIS_AP_ADDRESS="10.77.30.1")
    if keys:
        env["ALLOW_KEYS_FILE"] = str(HND / "allow-keys.txt")
        env["ALLOW_LISTENERS_FILE"] = str(HND / "allow-listeners.txt")
    if window is not None:
        env["ALLOW_DYNAMIC_TRANSITIONS_FILE"] = str(window)
    return subprocess.run(["bash", str(base.COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)


def test_safe_stopped_post_accepts_exactly_inactive_to_active_and_dead_to_running(tmp_path: Path) -> None:
    res = cmp_ss(tmp_path, SS_PRE, SS_POST)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "DYNAMIC_TRANSITION_APPROVED" in res.stdout and "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in res.stdout


def test_safe_stopped_post_is_drift_without_the_window(tmp_path: Path) -> None:
    res = cmp_ss(tmp_path, SS_PRE, SS_POST, None)
    assert res.returncode == 1 and f"{SVC}ActiveState" in res.stdout


@pytest.mark.parametrize("over", [
    {SVC + "ActiveState": "failed"}, {SVC + "ActiveState": "activating"}, {SVC + "SubState": "start"}, {SVC + "SubState": "failed"},
    {SVC + "Result": "exit-code"}, {SVC + "Result": "start-limit-hit"}, {SVC + "UnitFileState": "disabled"}, {SVC + "LoadState": "masked"},
    {"net.addr.wlp0s20f3": "10.77.30.2/28"}, {"wifi.iface.wlp0s20f3.ssid": "OTHER"}, {"svc.aegis-idea3-core.service.MainPID": "884"},
    {"svc.aegis-idea3-mosquitto.service.NRestarts": "4"},
], ids=lambda o: next(iter(o)).split(".")[-1] + "=" + next(iter(o.values())))
def test_anything_outside_the_exact_safe_stopped_window_is_drift(tmp_path: Path, over: dict) -> None:
    assert cmp_ss(tmp_path, SS_PRE, {**SS_POST, **over}).returncode == 1


def test_the_window_does_not_approve_a_wrong_direction_or_a_failed_baseline_transition(tmp_path: Path) -> None:
    # active -> inactive is not in the POST catalog; failed -> active needs the FAILED catalog, not this one
    assert cmp_ss(tmp_path / "a", SS_POST, SS_PRE).returncode == 1
    assert cmp_ss(tmp_path / "b", scope.FAILED_PRE, scope.FAILED_POST).returncode == 1


def test_widened_or_foreign_transitions_in_the_safe_stopped_file_are_refused(tmp_path: Path) -> None:
    head = "operation DNSMASQ_SAFE_STOPPED_POST\n"
    for i, extra in enumerate((
        f"{SVC}ActiveState inactive failed", f"{SVC}ActiveState failed active", f"{SVC}Result start-limit-hit success", f"{SVC}SubState dead failed",
        f"{SVC}ActiveState inactive active\n{SVC}ActiveState inactive active", "nm.general#WIFI disabled enabled", f"{SVC}MainPID 0 4343",
    )):
        f = tmp_path / f"w{i}.txt"
        f.write_text(head + extra + "\n")
        res = cmp_ss(tmp_path / f"c{i}", SS_PRE, SS_POST, f)
        assert res.returncode != 0 and ("not in the approved catalog" in res.stdout + res.stderr or "duplicate" in res.stdout + res.stderr), (extra, res.stdout, res.stderr)


def test_other_operations_cannot_be_used_with_the_safe_stopped_pair_and_the_file_declares_exactly_one_operation() -> None:
    lines = [l.strip() for l in SS_FILE.read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]
    assert lines == ["operation DNSMASQ_SAFE_STOPPED_POST", f"{SVC}ActiveState inactive active", f"{SVC}SubState dead running"]


def test_safe_stopped_pre_rb_is_identical_state_and_needs_no_transition(tmp_path: Path) -> None:
    assert cmp_ss(tmp_path, SS_PRE, SS_PRE, None, keys=False).returncode == 0
    rb = {**SS_PRE, SVC + "MainPID": "0", SVC + "ExecMainStartTimestamp": "Sat 2026-10-03 03:01:00 +07"}
    res = cmp_ss(tmp_path / "x", SS_PRE, rb, None)
    assert res.returncode == 0, res.stdout + res.stderr


def test_existing_failed_and_running_comparator_behaviour_is_unchanged(tmp_path: Path) -> None:
    assert scope.compare(tmp_path / "f", scope.FAILED_PRE, scope.FAILED_POST).returncode == 0
    assert scope.compare(tmp_path / "r", scope.RUNNING_PRE, scope.RUNNING_POST, dynamic=False).returncode == 0
    assert scope.compare(tmp_path / "fr", scope.FAILED_PRE, scope.ROLLED_BACK, kind="rollback").returncode == 0
    assert scope.compare(tmp_path / "x", scope.FAILED_PRE, scope.FAILED_POST, dynamic=False).returncode == 1
