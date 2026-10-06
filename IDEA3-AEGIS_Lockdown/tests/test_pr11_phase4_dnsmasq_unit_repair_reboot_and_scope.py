# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — governed dnsmasq unit repair: comparator exactness, the SEPARATE reboot-verification procedure, and scope / immutability pins.

1. Comparator exactness: the REAL p4-compare.sh with this package's allow files. The only approved drift is dnsmasq's own process bookkeeping (+ the exact catalog
   window on the FAILED baseline); every AP / profile / configuration / other-service key stays drift.
2. Reboot verification is a separate, read-only procedure that never reboots, never mutates, records K12_PERSISTENCE_OBSERVED and K12_FORMALLY_PROVEN separately,
   and can never conclude formal proof.
3. Nothing historical changed: the shared libraries, comparator, capture, stage gate, L4 handler, canonical template, V8 handlers and the V8 / PR305 receipts are
   byte-identical to the pins below; this package adds only new files.
Pure repository / simulated-host test: no live command, no Production mutation, no authorization or K3 is created.
"""

from __future__ import annotations

import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import test_pr11_phase4_dnsmasq_unit_repair as rep  # noqa: E402
import test_pr11_phase4_dnsmasq_unit_repair_owner_run_flow as flow  # noqa: E402
import test_pr11_phase4_l34_reactivation as base  # noqa: E402
import test_pr11_phase4_l34_v8_scope_contract as v8c  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
DEPLOY = base.DEPLOY
HND = rep.HND
REBOOT_HANDLER = HND / "reboot-verify.sh"
LOGS = REPO / "Obsidian_AEGIS_Vault" / "AEGIS_Knowledge" / "90-Status" / "logs"
SPEC = ROOT / "docs" / "superpowers" / "specs" / "2026-10-03-idea3-dnsmasq-unit-boot-order-governed-repair-design.md"
STATUS = REPO / "Obsidian_AEGIS_Vault" / "AEGIS_Knowledge" / "idea3" / "idea3-status.md"

# ── 1. comparator exactness (real p4-compare.sh) ─────────────────────────────────────────────────────────────────────────

SVC = "svc.aegis-idea3-dnsmasq.service."
AP_KEYS = {
    "net.link.wlp0s20f3": "UP", "net.addr.wlp0s20f3": "10.77.30.1/28", "wifi.iface.wlp0s20f3.ssid": "AEGIS-IDEA3", "wifi.iface.wlp0s20f3.channel": "6",
    "wifi.iface.wlp0s20f3.type": "AP", "nm.general": "connected:full:enabled:enabled", "nm.device.wlp0s20f3.state": "connected",
    "nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.meta": "mode=600 uid=0 gid=0 size=300 mtime=1",
    "nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.class": "secret-metadata-only",
    "net.idea3_dnsmasq_conf./etc/aegis-idea3/dnsmasq-ap.conf.sha256": "a" * 64,
    "wifi.rfkill.iface.wlp0s20f3.soft": "unblocked",
    "svc.aegis-idea3-mosquitto.service.ActiveState": "active", "svc.aegis-idea3-mosquitto.service.MainPID": "5100", "svc.aegis-idea3-mosquitto.service.NRestarts": "3",
    "svc.aegis-idea3-core.service.ActiveState": "active", "svc.aegis-idea3-core.service.MainPID": "883",
}
FAILED_PRE = {**AP_KEYS, SVC + "LoadState": "loaded", SVC + "UnitFileState": "enabled", SVC + "ActiveState": "failed", SVC + "SubState": "failed",
              SVC + "Result": "start-limit-hit", SVC + "MainPID": "0", SVC + "NRestarts": "5", SVC + "ExecMainStartTimestamp": "Sat 2026-10-03 00:46:54 +07"}
FAILED_POST = {**FAILED_PRE, SVC + "ActiveState": "active", SVC + "SubState": "running", SVC + "Result": "success", SVC + "MainPID": "4343", SVC + "NRestarts": "0",
               SVC + "ExecMainStartTimestamp": "Sat 2026-10-03 01:10:00 +07"}
RUNNING_PRE = {**FAILED_POST, SVC + "MainPID": "4242", SVC + "ExecMainStartTimestamp": "Sat 2026-10-03 00:50:00 +07"}
RUNNING_POST = {**RUNNING_PRE, SVC + "MainPID": "4343", SVC + "ExecMainStartTimestamp": "Sat 2026-10-03 01:10:00 +07"}
ROLLED_BACK = {**FAILED_PRE, SVC + "ActiveState": "inactive", SVC + "SubState": "dead", SVC + "Result": "success", SVC + "NRestarts": "0",
               SVC + "ExecMainStartTimestamp": "Sat 2026-10-03 01:12:00 +07"}


def compare(tmp: Path, pre: dict, post: dict, *, kind: str = "post", dynamic: bool = True, keys: bool = True) -> subprocess.CompletedProcess[str]:
    mk = base._make_bundle()
    b, a = mk(tmp / "b", "pre", pre), mk(tmp / "a", "post", post)
    env = os.environ.copy()
    env.update(DISK_THRESHOLD_PCT="90", AEGIS_AP_INTERFACE="wlp0s20f3", AEGIS_AP_ADDRESS="10.77.30.1")
    if keys:
        env["ALLOW_KEYS_FILE"] = str(HND / ("allow-keys.txt" if kind == "post" else "allow-keys-rollback.txt"))
        env["ALLOW_LISTENERS_FILE"] = str(HND / "allow-listeners.txt")
    if dynamic:
        env["ALLOW_DYNAMIC_TRANSITIONS_FILE"] = str(HND / ("allow-dynamic-transitions-failed-post.txt" if kind == "post" else "allow-dynamic-transitions-failed-rollback.txt"))
    return subprocess.run(["bash", str(base.COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)


def test_failed_baseline_pre_post_passes_with_the_exact_repair_window(tmp_path: Path) -> None:
    res = compare(tmp_path, FAILED_PRE, FAILED_POST)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in res.stdout and "DYNAMIC_TRANSITION_APPROVED" in res.stdout


def test_running_baseline_pre_post_passes_with_keys_only_and_no_dynamic_window(tmp_path: Path) -> None:
    res = compare(tmp_path, RUNNING_PRE, RUNNING_POST, dynamic=False)
    assert res.returncode == 0, res.stdout + res.stderr


def test_the_failed_to_active_change_is_drift_without_the_dynamic_window(tmp_path: Path) -> None:
    res = compare(tmp_path, FAILED_PRE, FAILED_POST, dynamic=False)
    assert res.returncode == 1 and f"{SVC}ActiveState" in res.stdout


def test_keys_only_allowance_never_approves_a_state_change(tmp_path: Path) -> None:
    res = compare(tmp_path / "a", RUNNING_PRE, {**RUNNING_POST, SVC + "ActiveState": "failed"}, dynamic=False)
    assert res.returncode == 1


@pytest.mark.parametrize("over", [
    {"net.addr.wlp0s20f3": "10.77.30.2/28"}, {"net.link.wlp0s20f3": "DOWN"}, {"wifi.iface.wlp0s20f3.ssid": "OTHER"}, {"wifi.iface.wlp0s20f3.channel": "11"},
    {"wifi.iface.wlp0s20f3.type": "managed"}, {"nm.device.wlp0s20f3.state": "disconnected"}, {"nm.general": "connected:full:disabled:enabled"},
    {"nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.meta": "mode=600 uid=0 gid=0 size=301 mtime=2"},
    {"nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.class": "config"},
    {"net.idea3_dnsmasq_conf./etc/aegis-idea3/dnsmasq-ap.conf.sha256": "b" * 64},
    {"wifi.rfkill.iface.wlp0s20f3.soft": "blocked"},
    {"svc.aegis-idea3-mosquitto.service.MainPID": "5101"}, {"svc.aegis-idea3-mosquitto.service.NRestarts": "4"}, {"svc.aegis-idea3-mosquitto.service.ActiveState": "failed"},
    {"svc.aegis-idea3-core.service.MainPID": "884"}, {"svc.aegis-idea3-core.service.ActiveState": "failed"},
    {SVC + "UnitFileState": "disabled"}, {SVC + "LoadState": "masked"}, {SVC + "ActiveState": "activating"}, {SVC + "SubState": "start"}, {SVC + "Result": "failed"},
], ids=lambda o: next(iter(o)).split("/")[-1][-40:] + "=" + next(iter(o.values()))[:12])
def test_any_ap_profile_config_other_service_or_state_outside_the_window_is_drift(tmp_path: Path, over: dict) -> None:
    for name, (pre, post) in {"failed": (FAILED_PRE, FAILED_POST), "running": (RUNNING_PRE, RUNNING_POST)}.items():
        res = compare(tmp_path / name, pre, {**post, **over}, dynamic=(name == "failed"))
        assert res.returncode == 1, (name, res.stdout)


def test_rollback_windows_accept_the_safe_stopped_state_and_the_running_restart_only(tmp_path: Path) -> None:
    assert compare(tmp_path / "a", FAILED_PRE, ROLLED_BACK, kind="rollback").returncode == 0
    assert compare(tmp_path / "b", FAILED_PRE, {**ROLLED_BACK, SVC + "ActiveState": "active", SVC + "SubState": "running"}, kind="rollback").returncode == 1
    assert compare(tmp_path / "c", FAILED_PRE, ROLLED_BACK, kind="rollback", dynamic=False).returncode == 1
    assert compare(tmp_path / "d", RUNNING_PRE, RUNNING_POST, kind="rollback", dynamic=False).returncode == 0
    assert compare(tmp_path / "e", FAILED_PRE, {**ROLLED_BACK, "net.addr.wlp0s20f3": "none"}, kind="rollback").returncode == 1


def test_pre_rb_identical_state_needs_no_transition(tmp_path: Path) -> None:
    assert compare(tmp_path, FAILED_PRE, FAILED_PRE, kind="rollback", dynamic=False).returncode == 0


def _keys(path: Path) -> list[str]:
    return [l.strip() for l in path.read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")]


def test_allow_files_approve_exactly_the_dnsmasq_bookkeeping_and_nothing_wider() -> None:
    expected = [f"{SVC}ExecMainStartTimestamp", f"{SVC}MainPID", f"{SVC}NRestarts"]
    assert sorted(_keys(HND / "allow-keys.txt")) == sorted(_keys(HND / "allow-keys-rollback.txt")) == expected
    for key in _keys(HND / "allow-keys.txt") + _keys(HND / "allow-keys-rollback.txt"):
        assert "*" not in key and not key.startswith(("nm.", "net.", "fw.", "host.", "wifi.", "listen.")) and "mosquitto" not in key and "core" not in key
    assert _keys(HND / "allow-listeners.txt") == ["listen.udp.0.0.0.0%<AEGIS_AP_INTERFACE>:67", "listen.tcp.<AEGIS_AP_ADDRESS>:53", "listen.udp.<AEGIS_AP_ADDRESS>:53"]
    assert not any(":1883" in k or ":8883" in k for k in _keys(HND / "allow-listeners.txt"))
    assert _keys(HND / "allow-dynamic-transitions-failed-post.txt") == [
        "operation L34_RUNTIME_REACTIVATION", f"{SVC}ActiveState failed active", f"{SVC}SubState failed running", f"{SVC}Result start-limit-hit success"]
    assert _keys(HND / "allow-dynamic-transitions-failed-rollback.txt") == [
        "operation L34_RUNTIME_REACTIVATION_ROLLBACK", f"{SVC}ActiveState failed inactive", f"{SVC}SubState failed dead", f"{SVC}Result start-limit-hit success"]


# ── 2. reboot verification: a SEPARATE, read-only procedure ─────────────────────────────────────────────────────────────

MUT_VERBS = re.compile(r"systemctl\s+(daemon-reload|reset-failed|start|stop|restart|try-restart|reload|kill|enable|disable|mask|unmask|reboot|poweroff|halt|isolate|set-property)")


def rebooted_fx(tmp: Path, **over):
    """A host that went through the (separately governed) repair and is healthy: new unit installed, dnsmasq active, AP profile autoconnecting."""
    fx = rep.repair_host(tmp, **over)
    rep.applied(fx)
    profile = fx.file(base.PROFILE_REL)
    profile.write_text("\n".join(l for l in profile.read_text().splitlines() if l != "autoconnect=false") + "\n")
    profile.chmod(0o600)
    boot = fx.file("proc/sys/kernel/random/boot_id")
    boot.parent.mkdir(parents=True, exist_ok=True)
    boot.write_text("11111111-1111-1111-1111-111111111111\n")
    evid = tmp / "repair-evidence"
    evid.mkdir()
    (evid / "terminal-verdict.txt").write_text("DNSMASQ_REPAIR_RESULT=PASS\nK12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN\n")
    fx.evid = evid  # type: ignore[attr-defined]
    fx.rdir = tmp / "reboot-evidence"  # type: ignore[attr-defined]
    return fx


def reboot_run(fx, mode: str, **extra: str) -> subprocess.CompletedProcess[str]:
    env = dict(AEGIS_DNSREPAIR_REBOOT_MODE=mode, AEGIS_DNSREPAIR_REBOOT_DIR=str(fx.rdir), AEGIS_DNSREPAIR_REPAIR_EVIDENCE=str(fx.evid),
               AEGIS_DNSREPAIR_APPROVAL_REF="owner-approval/2026-10-03-orderly-reboot", AEGIS_DNSREPAIR_TRIES="3", AEGIS_DNSREPAIR_INTERVAL="0.01")
    env.update(extra)
    return fx.run(REBOOT_HANDLER, **env)


def recorded(fx) -> None:
    res = reboot_run(fx, "record")
    assert res.returncode == 0, res.stdout + res.stderr


def reboot(fx, new_id: str = "22222222-2222-2222-2222-222222222222") -> None:
    fx.file("proc/sys/kernel/random/boot_id").write_text(new_id + "\n")


def test_reboot_handler_exists_and_is_separate_from_the_repair_run() -> None:
    assert REBOOT_HANDLER.is_file() and (rep.DEPLOY / "owner-run" / "verify-dnsmasq-boot-order-after-reboot.sh").is_file()
    for script in (rep.APPLY, rep.VERIFY, rep.ROLLBACK, rep.RUNNER):
        text = rep.code(script)
        assert "reboot-verify" not in text and "verify-dnsmasq-boot-order-after-reboot" not in text, script.name
        assert not re.search(r"(^|[;&|(]\s*)(sudo\s+)?(reboot|poweroff|shutdown|halt)\b|systemctl\s+(reboot|poweroff|halt|kexec)", text, re.M), script.name


def test_reboot_scripts_never_reboot_or_mutate() -> None:
    for script in (REBOOT_HANDLER, rep.REBOOT):
        text = rep.code(script)
        assert not MUT_VERBS.search(text), script.name
        assert not re.search(r"(^|[;&|(]\s*)(sudo\s+)?(reboot|poweroff|shutdown|halt)\b", text, re.M), script.name
        for pat in (r"nmcli\s+(connection|radio|device|networking)\s+(up|down|modify|delete|add|reload|on|off|set)", r"\bnft\s+(add|delete|flush|-f|insert|replace)", r"sysctl\s+-w",
                    r"\brm\s", r"\bsed\s+-i", r"\binstall\b", r"\bmv\s", r"esptool", r"mosquitto_pub", r"/dev/tty"):
            assert not re.search(pat, text), (script.name, pat)


def test_reboot_wrapper_is_unpinned_as_committed() -> None:
    for args in (["record", "/x", "/y", "ref"], ["verify", "/x"]):
        res = subprocess.run(["bash", str(rep.REBOOT), *args], text=True, capture_output=True, check=False)
        assert res.returncode == 2 and "runner is not pinned" in res.stdout


def test_record_mode_writes_only_its_own_evidence_and_commands_nothing(tmp_path: Path) -> None:
    fx = rebooted_fx(tmp_path)
    n = len(fx.calls())
    res = reboot_run(fx, "record")
    assert res.returncode == 0, res.stdout + res.stderr
    assert rep.mutating(fx, n) == []
    assert "REBOOT_VERIFICATION_RECORDED=YES" in res.stdout and "REBOOT_VERIFICATION_EXECUTED=NO" in res.stdout and "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN" in res.stdout
    pre = (fx.rdir / "reboot-pre.txt").read_text()
    assert "BOOT_ID=11111111-1111-1111-1111-111111111111" in pre and "APPROVAL_REF=owner-approval/2026-10-03-orderly-reboot" in pre
    assert "K12_FORMALLY_PROVEN=YES" not in res.stdout


@pytest.mark.parametrize("breaker,reason", [
    (lambda fx: (fx.evid / "terminal-verdict.txt").unlink(), "REPAIR_EVIDENCE_TERMINAL_VERDICT_MISSING"),
    (lambda fx: (fx.evid / "terminal-verdict.txt").write_text("DNSMASQ_REPAIR_RESULT=ROLLED_BACK\n"), "REPAIR_EVIDENCE_NOT_PASS"),
    (lambda fx: fx.rdir.mkdir(), "REBOOT_DIR_ALREADY_EXISTS"),
    (lambda fx: fx.file(base.UNIT_REL).write_text(rep.OLD_UNIT), "L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY"),
    (lambda fx: fx.set(dnsmasq="failed"), "L34_DNSMASQ_NOT_ACTIVE_RUNNING"),
    (lambda fx: fx.set(ap_profile_autoconnect="no"), "L34_V8_AP_PROFILE_AUTOCONNECT_NOT_ENABLED"),
    (lambda fx: fx.set(ap_active=0), "L34_AP_NOT_IN_AP_MODE"),
], ids=["no-verdict", "verdict-not-pass", "dir-exists", "old-unit", "dnsmasq-failed", "autoconnect-off", "ap-down"])
def test_record_mode_refuses_without_a_passed_repair_and_a_healthy_host(tmp_path: Path, breaker, reason: str) -> None:
    fx = rebooted_fx(tmp_path)
    breaker(fx)
    res = reboot_run(fx, "record")
    assert res.returncode != 0 and reason in res.stderr, res.stdout + res.stderr
    assert not (fx.rdir / "reboot-pre.txt").exists()


@pytest.mark.parametrize("ref", ["", "x", "TODO", "REPLACE-ME-ref", "has space in it", "badé"])
def test_record_mode_requires_a_real_written_approval_reference(tmp_path: Path, ref: str) -> None:
    fx = rebooted_fx(tmp_path)
    res = reboot_run(fx, "record", AEGIS_DNSREPAIR_APPROVAL_REF=ref)
    assert res.returncode != 0 and "REBOOT_APPROVAL_REFERENCE" in res.stderr


def test_verify_after_an_observed_reboot_passes_and_records_observation_and_formal_proof_separately(tmp_path: Path) -> None:
    fx = rebooted_fx(tmp_path)
    recorded(fx)
    reboot(fx)
    n = len(fx.calls())
    res = reboot_run(fx, "verify", AEGIS_DNSREPAIR_NO_MANUAL_INTERVENTION="YES")
    assert res.returncode == 0, res.stdout + res.stderr
    lines = set(res.stdout.splitlines())
    for want in ("REBOOT_OBSERVED=YES", "DNSMASQ_UNIT_AUTHORITY=PASS", "AP_MODE=PASS", "AP_SSID=PASS", "AP_CHANNEL=PASS", "AP_IPV4_PREFIX=PASS", "AP_PROFILE_AUTOCONNECT=PASS",
                 "DNSMASQ_ACTIVE=YES", "DNSMASQ_RUNNING=YES", "DNSMASQ_START_LIMIT_HIT=NO", "DNSMASQ_UNKNOWN_INTERFACE_FAILURES=0", "DNSMASQ_WAITED_FOR_AP=OBSERVED",
                 "CORE_HEALTH=PASS", "BROKER_HEALTH=PASS", "FORWARDING_POLICY=PASS", "L2_FIREWALL=PASS", "PERSISTENT_FILES_UNCHANGED_ACROSS_REBOOT=PASS",
                 "UNEXPECTED_DRIFT=NONE_OBSERVED_IN_CHECKED_SCOPE", "REBOOT_VERIFICATION_EXECUTED=YES", "REBOOT_VERIFICATION_RESULT=PASS", "K12_PERSISTENCE_OBSERVED=YES",
                 "K12_FORMALLY_PROVEN=NO", "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN", "PRODUCTION_MUTATION_PERFORMED=NO", "ESP32_TOUCHED=NO"):
        assert want in lines, (want, res.stdout)
    assert rep.mutating(fx, n) == [], "strictly read-only"
    assert "K12_FORMALLY_PROVEN=YES" not in res.stdout


def test_verify_without_the_no_manual_intervention_attestation_does_not_claim_observation(tmp_path: Path) -> None:
    fx = rebooted_fx(tmp_path)
    recorded(fx)
    reboot(fx)
    res = reboot_run(fx, "verify")
    assert res.returncode == 0 and "REBOOT_VERIFICATION_RESULT=PASS" in res.stdout
    assert "K12_PERSISTENCE_OBSERVED=YES" not in res.stdout and "K12_PERSISTENCE_OBSERVED=NO" in res.stdout and "K12_FORMALLY_PROVEN=NO" in res.stdout


def test_verify_without_an_observed_reboot_is_refused(tmp_path: Path) -> None:
    fx = rebooted_fx(tmp_path)
    recorded(fx)
    res = reboot_run(fx, "verify", AEGIS_DNSREPAIR_NO_MANUAL_INTERVENTION="YES")
    assert res.returncode != 0 and "REBOOT_NOT_OBSERVED_SAME_BOOT_ID" in res.stderr
    assert "K12_PERSISTENCE_OBSERVED=NO" in res.stdout and "K12_FORMALLY_PROVEN=NO" in res.stdout


def test_verify_without_a_pre_reboot_record_or_twice_is_refused(tmp_path: Path) -> None:
    fx = rebooted_fx(tmp_path)
    assert "REBOOT_PRE_RECORD_MISSING" in reboot_run(fx, "verify").stderr
    recorded(fx)
    reboot(fx)
    assert reboot_run(fx, "verify").returncode == 0
    assert "REBOOT_VERIFICATION_ALREADY_RECORDED" in reboot_run(fx, "verify").stderr


REBOOT_FAILURES = [
    ("dnsmasq_start_limit_hit", lambda fx: fx.set(dnsmasq="failed"), "L34_DNSMASQ_NOT_ACTIVE_RUNNING"),
    ("dnsmasq_stopped", lambda fx: fx.set(dnsmasq="inactive"), "L34_DNSMASQ_NOT_ACTIVE_RUNNING"),
    ("unknown_interface_in_journal", lambda fx: fx.set(dnsmasq_journal=["dnsmasq: unknown interface wlp0s20f3", "systemd[1]: aegis-idea3-dnsmasq.service: Failed with result 'exit-code'."]),
     "DNSREPAIR_DNSMASQ_BOOT_FAILURE_SIGNATURES"),
    ("repeated_unknown_interface", lambda fx: fx.set(dnsmasq_journal=["dnsmasq: unknown interface wlp0s20f3"] * 5), "DNSREPAIR_DNSMASQ_BOOT_FAILURE_SIGNATURES"),
    ("bind_failure_in_journal", lambda fx: fx.set(dnsmasq_journal=["dnsmasq: failed to create listening socket: Cannot assign requested address"]), "DNSREPAIR_DNSMASQ_BOOT_FAILURE_SIGNATURES"),
    ("start_limit_in_journal", lambda fx: fx.set(dnsmasq_journal=["systemd[1]: aegis-idea3-dnsmasq.service: Start request repeated too quickly."]), "DNSREPAIR_DNSMASQ_BOOT_FAILURE_SIGNATURES"),
    ("restart_count_unbounded", lambda fx: fx.set(dnsmasq_nrestarts=5), "DNSREPAIR_DNSMASQ_RESTART_COUNT_NOT_BOUNDED"),
    ("old_unit_back", lambda fx: fx.file(base.UNIT_REL).write_text(rep.OLD_UNIT), "L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY"),
    ("ap_down", lambda fx: fx.set(ap_active=0), "L34_AP_NOT_IN_AP_MODE"),
    ("ap_ssid", lambda fx: fx.set(active_ssid="X"), "L34_AP_SSID_MISMATCH"),
    ("ap_channel", lambda fx: fx.set(active_channel=11), "L34_AP_CHANNEL_MISMATCH"),
    ("ap_address", lambda fx: fx.set(ap_addr_override="10.77.30.1/24"), "L34_AP_ADDRESS_MISMATCH"),
    ("autoconnect_off", lambda fx: fx.set(ap_profile_autoconnect="no"), "L34_V8_AP_PROFILE_AUTOCONNECT_NOT_ENABLED"),
    ("core_down", lambda fx: fx.set(identities={**fx.state()["identities"], rep.CORE_UNIT: [0, 0]}), "L34_V7_CORE_NOT_HEALTHY"),
    ("broker_down", lambda fx: fx.set(identities={**fx.state()["identities"], rep.BROKER_UNIT: [0, 0]}), "L34_V4_SERVICE_NOT_READY"),
    ("broker_pair_missing", lambda fx: fx.set(broker_pair_missing="ap"), "L34_V4_BROKER_LISTENERS_INVALID"),
    ("forwarding_on", lambda fx: fx.set(sysctl_override={"net.ipv4.ip_forward": 1}), "L34_FORWARDING_NOT_ZERO"),
    ("nat", lambda fx: fx.set(nft_ruleset_extra="table ip nat { chain post { masquerade } }\n"), "NAT_DETECTED"),
    ("persistent_drift", lambda fx: fx.file(base.CONF_REL).write_text(base.CONF + "# drift\n"), "L34_PERSISTENT_FILE_CHANGED"),
    ("needs_reload", lambda fx: fx.set(dnsmasq_loaded_unit="old"), "DNSREPAIR_NEEDS_DAEMON_RELOAD"),
]


@pytest.mark.parametrize("name,breaker,reason", REBOOT_FAILURES, ids=[f[0] for f in REBOOT_FAILURES])
def test_verify_fails_with_k12_not_observed_for_any_post_reboot_problem(tmp_path: Path, name: str, breaker, reason: str) -> None:
    fx = rebooted_fx(tmp_path)
    recorded(fx)
    reboot(fx)
    breaker(fx)
    res = reboot_run(fx, "verify", AEGIS_DNSREPAIR_NO_MANUAL_INTERVENTION="YES")
    assert res.returncode != 0 and reason in res.stderr, res.stdout + res.stderr
    assert "REBOOT_VERIFICATION_RESULT=FAIL" in res.stdout and "K12_PERSISTENCE_OBSERVED=NO" in res.stdout and "K12_FORMALLY_PROVEN=NO" in res.stdout
    assert "K12_PERSISTENCE_OBSERVED=YES" not in res.stdout


def test_a_bounded_number_of_dnsmasq_retries_is_reported_but_never_hidden(tmp_path: Path) -> None:
    fx = rebooted_fx(tmp_path)
    recorded(fx)
    reboot(fx)
    fx.set(dnsmasq_nrestarts=2)
    res = reboot_run(fx, "verify", AEGIS_DNSREPAIR_NO_MANUAL_INTERVENTION="YES")
    assert res.returncode == 0 and "DNSMASQ_NRESTARTS=2" in res.stdout and "DNSMASQ_WAITED_FOR_AP=OBSERVED_WITH_BOUNDED_RETRIES" in res.stdout


def test_no_script_in_the_package_can_conclude_k12_formal_proof() -> None:
    for script in (REBOOT_HANDLER, rep.REBOOT, rep.RUNNER, rep.APPLY, rep.VERIFY, rep.ROLLBACK):
        text = script.read_text()
        assert not re.search(r"K12_FORMALLY_PROVEN=YES|K12_AUTOMATIC_REBOOT_PERSISTENCE=PROVEN|K12_AUTOMATIC_REBOOT_PERSISTENCE=PASS", text), script.name
    assert "K12_FORMALLY_PROVEN=NO" in REBOOT_HANDLER.read_text()


# ── 3. scope, immutability and exact file set ───────────────────────────────────────────────────────────────────────────

# Files this package reuses unchanged. A deliberate future change must update these pins in its own reviewed task.
SHARED_PINS = {
    "p4-l34-reactivation-lib.sh": "08dd7de16cbc57a43b79f35f11e7b1dff011b29dffca5ddeef478f3524621a37",
    "p4-l34-v8-lib.sh": "4398216c5e83caa4f276d8a0bf66370a8db59c4e1d7a6a7d769733933b695ee0",
    # re-pinned by the governed F1 detector install/start stage task (2026-10-04): p4-lib.sh registers stage F1 (after L8p, before L8) with no repository gap;
    # p4-stage-gate.sh gives F1 the same no-extra-field authorization rule as L7u/L8p. No other stage, gate or record rule changed.
    # re-pinned by the F1i post-L7 repaired-release install stage task (2026-10-04): p4-lib.sh registers stage F1i (after L8p, before F1r; no repository gap), p4-stage-gate.sh binds F1i
    # to the same no-extra-field authorization rule, and p4-compare.sh adds the label `stage F1i` to the existing RELATIONAL one-release catalog allowance (behavior unchanged:
    # every release already present must stay byte-identical, exactly one named id may be added). No other stage, gate or record rule changed.
    "p4-stage-gate.sh": "352aeea2400d109fe235b8888250d1f91ab7e8f8a8cb44b8c4b5ec9d19093480",
    # Re-pinned by the owner-approved R1I registration (2026-10-05): additive
    # R1I stage catalog entry; existing stage behavior remains unchanged.
    # Re-pinned by the owner-approved R1A registration (2026-10-05): additive R1A stage catalog entry (after R1I, before L8), its operational-order comment and `R1A) echo none`
    # in p4_stage_gaps; p4_stage_mutates is unchanged (the existing "every stage except L0" rule). No existing stage behavior changed.
    "p4-lib.sh": "0e4017fe2c168f2adafcb72c8070961cca1a41171a058e78a22bd9eb57b8297c",
    # re-pinned by the SAFE_STOPPED governed-successor task (2026-10-03): ONE additive, task-specific catalog DNSMASQ_SAFE_STOPPED_POST; no existing catalog changed
    "p4-compare.sh": "75d0a0dc0e4d529ed39bf2929cd3c54a9ef7a8a4eb8d643725af1d61862f6294",
    "p4-l0-capture.sh": "e5d82dc5959dbcd1aa13ca0d58aa15ed5375a77e918be9a1ec2a8a2ac740a61b",
    "p4-ap-network.py": "45d2a87a0d7c2c563154466f63cc9994f02dc841ccb0c89832d6001b005f71ef",
    "stages/L4/apply.sh": "c31a7471a0d81514c716d6db670197ea45a6940fbbae84a7f5801485720ed58e",
    "../network/aegis-idea3-dnsmasq.service.example": "bd727bbeb63edce4c2e4082fa7753b55cf4b941c3f0bbd1b291a477a8a0766b6",
    "reactivation/l34-v8-post-v7-persistent-ap-recovery/apply.sh": "bc02016e8af2d32574d7bfa2120b9b844a122ee3b9f9cc0d2a3a663bed252a6f",
    "reactivation/l34-v8-post-v7-persistent-ap-recovery/rollback.sh": "a312392f3c4c644b60da65f721312de89d36a4452a4f3c8a6ad1fa8fe06b96d1",
    "reactivation/l34-v8-post-v7-persistent-ap-recovery/verify.sh": "b4f651538b8a30bd9bf135e1784967d0aedb55977b858e6e5e20999c750161f0",
    "owner-run/run-l34-v8-post-v7-persistent-ap-recovery-owner.sh": "14cfeaf9fc87c83a343391f50d24d9793f9d0dafe1607c2061a7feff95faabba",
}
HISTORICAL_RECEIPT_PINS = {
    "2026-10-02_090710_music_idea3-l34-v8-post-v7-persistent-ap-recovery.md": "34ffbd79878ffc016535756b6891251d7245eb7a1f69fa184b355e878e7331a9",
    "2026-10-02_173500_music_idea3-v8-profile-timestamp-false-positive.md": "597541e621f2995ad964d60a07d6f7ea98bce5fccd2eb5fd6761c71523cc4b6a",
    "2026-10-02_193900_music_idea3-v8-governed-successor-clarification.md": "ff1266afe62ec36826326e7d59a15c57b63ea5efa9db79722819c5911b76c3eb",
    "2026-10-02_195500_music_idea3-v8-governed-successor-live-closeout.md": "57f26da7cfbee67fe4814ab705c95ea7ad9786d3226c1346ea5b2fa202c40472",
    "2026-10-02_222500_music_idea3-dnsmasq-boot-order-repair.md": "3c09529d48c6dbd8f899702ce141f8f3e2c31288bfbfc69c3d9b7e5305b60c8d",
    **v8c.V7_RECEIPT_PINS,
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("rel,digest", sorted(SHARED_PINS.items()))
def test_reused_shared_files_and_the_v8_handlers_are_byte_identical(rel: str, digest: str) -> None:
    assert sha(DEPLOY / rel) == digest, f"{rel} changed: this package must reuse it unchanged"


@pytest.mark.parametrize("name,digest", sorted(HISTORICAL_RECEIPT_PINS.items()))
def test_historical_receipts_are_immutable(name: str, digest: str) -> None:
    assert sha(LOGS / name) == digest


def test_the_new_package_has_exactly_the_frozen_file_set() -> None:
    assert sorted(p.name for p in HND.iterdir()) == [
        "allow-dynamic-transitions-failed-post.txt", "allow-dynamic-transitions-failed-rollback.txt", "allow-dynamic-transitions-safe-stopped-post.txt",
        "allow-keys-rollback.txt", "allow-keys.txt", "allow-listeners.txt", "apply.sh", "reboot-verify.sh", "rollback.sh", "verify.sh"]
    assert (DEPLOY / "p4-dnsmasq-repair-lib.sh").is_file()


def test_no_new_l_number_stage_was_invented() -> None:
    assert (DEPLOY / "p4-lib.sh").read_text().count('readonly P4_STAGES="L0 L1 L2 L3 L4 L5 L6a L6b L6c L7 L7u L8p F1i F1r F1 F1u R1I R1A R1Du R1D R1Dv R1B R1Bv RRu CTu Recovery L8 L9"') == 1
    assert not (DEPLOY / "stages" / "L10").exists() and not (DEPLOY / "stages" / "L4b").exists()


def test_scope_is_distinct_from_every_historical_scope_and_passes_the_real_stage_gate(tmp_path: Path) -> None:
    scope = flow.EXPECTED_SCOPE
    assert scope != v8c.AUTHORITATIVE_V8_SCOPE and "V8" not in scope and "V7" not in scope
    assert flow.RUNNER.read_text().count(f"EXPECTED_SCOPE='{scope}'") == 1
    auth, k3 = tmp_path / "authorization-L4.txt", tmp_path / "k3-L4.txt"
    auth.write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage=L4\ndate={flow.TODAY}\nauthorizer=music\nscope={scope}\nreference=owner-approval/dnsmasq-repair\n")
    k3.write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage=L4\ndate={flow.TODAY}\nconfirmed_by=music\nconfirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\n"
                  "idea1_window_overlap=NONE_KNOWN\nreference=owner-approval/dnsmasq-repair-k3\n")
    res = subprocess.run(["bash", str(rep.DEPLOY / "p4-stage-gate.sh"), "--stage", "L4", "--mode", "live", "--authorization", str(auth), "--k3", str(k3)],
                         text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok"))
    assert res.returncode == 0, res.stdout
    assert "AUTHORIZATION_RECORD=VALID" in res.stdout and "K3_CONFIRMATION=VALID" in res.stdout and "LIVE_STAGE_AUTHORIZED=NO" in res.stdout, "the gate is necessary, never sufficient"
    stale = auth.read_text().replace(flow.TODAY, flow.YESTERDAY)
    auth.write_text(stale)
    assert subprocess.run(["bash", str(rep.DEPLOY / "p4-stage-gate.sh"), "--stage", "L4", "--mode", "live", "--authorization", str(auth), "--k3", str(k3)],
                          text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).returncode == 1


def test_the_package_uses_its_own_marker_and_never_the_marker_of_another_run() -> None:
    assert 'DNSREPAIR_MARKER_NAME="DNSMASQ-UNIT-REPAIR-ATTEMPT-CONSUMED"' in (DEPLOY / "p4-dnsmasq-repair-lib.sh").read_text()
    for script in (rep.APPLY, rep.VERIFY, rep.ROLLBACK, REBOOT_HANDLER):
        assert "ATTEMPT-CONSUMED" not in rep.code(script)


def test_only_the_dnsmasq_unit_is_ever_a_target_of_service_control() -> None:
    lib = rep.code(rep.REPAIR_LIB)
    assert not re.search(r"systemctl\s+(start|stop|restart|reset-failed|daemon-reload|enable|disable)", lib), "the library only reads; handlers act"
    assert lib.count("install -m 0644") == 1 and lib.count("mv -T") == 1, "exactly one file writer"


# ── 4. documentation (the receipt/status facts) ─────────────────────────────────────────────────────────────────────────

REQUIRED_STATEMENTS = (
    "PR305_REPOSITORY_FIX=MERGED", "LIVE_REPAIR_EXECUTED=NO", "REBOOT_VERIFICATION_EXECUTED=NO", "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN",
    "L8P_LIVE_EXECUTED=NO", "RECOVERY_R1_R8=NOT_RUN", "LVR=NOT_RUN", "L8=NOT_RUN", "ESP32_TOUCHED=NO",
)


def _new_receipts() -> list[Path]:
    return [p for p in LOGS.glob("*music_idea3-dnsmasq-governed-live-repair*.md")]


def test_exactly_one_task_receipt_states_the_required_non_claims() -> None:
    receipts = _new_receipts()
    assert len(receipts) == 1, receipts
    text = receipts[0].read_text()
    for statement in REQUIRED_STATEMENTS:
        assert statement in text, statement
    assert "edit_policy: append-by-new-file" in text and "owner: music" in text and "area: idea3" in text and "fix/idea3-dnsmasq-governed-live-repair" in text
    assert "LIVE_REPAIR_EXECUTED=YES" not in text and "K12_FORMALLY_PROVEN=YES" not in text


def test_design_spec_and_status_note_state_the_same_boundary() -> None:
    spec = SPEC.read_text()
    for statement in REQUIRED_STATEMENTS:
        assert statement in spec, statement
    for needle in ("dnsmasq-unit-boot-order-repair", "K12_PERSISTENCE_OBSERVED", "K12_FORMALLY_PROVEN", "DNSMASQ-UNIT-REPAIR-ATTEMPT-CONSUMED", "NOT_PROVEN"):
        assert needle in spec, needle
    status = STATUS.read_text()
    assert "dnsmasq-unit-boot-order-repair" in status and "LIVE_REPAIR_EXECUTED = NO" in status
