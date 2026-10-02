# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — governed dnsmasq unit boot-order REPAIR handlers (apply / verify / rollback). Simulated host only.

PR #305 fixed the canonical ``aegis-idea3-dnsmasq.service.example`` (bounded AP-readiness gate) in the repository. The live host still carries the OLD
pre-PR305 unit, which the corrected L34 authority deliberately refuses. This package replaces exactly that one file and touches exactly one service:
render the canonical template with the fixed approved values, install it, ``systemctl daemon-reload``, ``reset-failed`` (only when failed) and
``start`` / ``restart`` aegis-idea3-dnsmasq.service. These tests prove the exact mutation scope, the fail-closed pre-gates, the journal-before-mutation
rule, the rollback before/after the unit replacement, and the absence of any AP / network / broker / Core / ESP32 command.

Every handler runs against stubs (tests/dnsmasq_repair_sim.py over tests/l34_sim.py). Nothing here touches a real host.
"""

from __future__ import annotations

import hashlib
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import dnsmasq_repair_sim as dsim  # noqa: E402
import l34_sim as sim  # noqa: E402
import test_pr11_phase4_l34_dnsmasq_unit_authority as auth  # noqa: E402
import test_pr11_phase4_l34_reactivation as base  # noqa: E402

DEPLOY = base.DEPLOY
HND = DEPLOY / "reactivation" / "dnsmasq-unit-boot-order-repair"
APPLY, VERIFY, ROLLBACK = (HND / n for n in ("apply.sh", "verify.sh", "rollback.sh"))
RUNNER = DEPLOY / "owner-run" / "run-dnsmasq-unit-boot-order-repair-owner.sh"
REBOOT = DEPLOY / "owner-run" / "verify-dnsmasq-boot-order-after-reboot.sh"
REPAIR_LIB = DEPLOY / "p4-dnsmasq-repair-lib.sh"
TEMPLATE = base.EXAMPLE_UNIT
OLD_UNIT = auth.OLD_PRE_PR305_UNIT
OLD_SHA = hashlib.sha256(OLD_UNIT.encode()).hexdigest()
NEW_UNIT = base.canonical_dnsmasq_unit()
DNSMASQ_UNIT, BROKER_UNIT, CORE_UNIT = "aegis-idea3-dnsmasq.service", "aegis-idea3-mosquitto.service", "aegis-idea3-core.service"
BROKER_CONF_REL = "etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf"
BROKER_CONF = "# AEGIS IDEA3 L6b broker config — TEMPLATE, NOT DEPLOYED.\nlistener 8883 127.0.0.1\nlistener 8883 10.77.30.1\n"

MUTATING = re.compile(
    r"^(systemctl (daemon-reload|reset-failed|start|stop|restart|enable|disable|mask|unmask|kill|reload|set-property|edit|link)"
    r"|nmcli (connection (up|down|modify|delete|reload|add)|radio|device set|networking)|rfkill (block|unblock)|iw reg set"
    r"|nft (add|delete|flush|insert|replace|-f)|sysctl -w)"
)


def repair_host(tmp: Path, baseline: str = "failed", unit_text: str = OLD_UNIT, **over) -> base.Fx:
    """The exact intended host: AP up and correct, Core/broker healthy, OLD pre-PR305 unit installed, dnsmasq failed/start-limit-hit (or running)."""
    state = dict(
        rfkill_soft=0, nm_software_radio=True, ap_active=1, ap_ever_up=True, p2p_present=True, wpa_active=True, phy_country="TH",
        dnsmasq="failed" if baseline == "failed" else "active", dev_autoconnect="yes", ap_profile_autoconnect="yes",
        identities={**sim.DEFAULT_STATE["identities"], CORE_UNIT: [883, 0], BROKER_UNIT: [5100, 3]},
    )
    state.update(over)
    fx = base.build(tmp, **state)
    dsim.install(fx.stubs, fx.simd, **state)
    unit = fx.file(base.UNIT_REL)
    if unit_text is None:
        unit.unlink()
    else:
        unit.write_text(unit_text)
        unit.chmod(0o644)
    bconf = fx.file(BROKER_CONF_REL)
    bconf.parent.mkdir(parents=True, exist_ok=True)
    bconf.write_text(BROKER_CONF)
    bconf.chmod(0o640)
    return fx


def run(fx: base.Fx, script: Path, **extra: str) -> subprocess.CompletedProcess[str]:
    env = dict(
        AEGIS_DNSREPAIR_WORK_DIR=str(fx.work), AEGIS_DNSREPAIR_STABLE_INTERVAL="0.01", AEGIS_DNSREPAIR_TRIES="4", AEGIS_DNSREPAIR_INTERVAL="0.01",
        AEGIS_L34_NM_TRIES="3",
    )
    env.update(extra)
    return fx.run(script, **env)


def applied(fx: base.Fx, **extra: str) -> subprocess.CompletedProcess[str]:
    res = run(fx, APPLY, **extra)
    assert res.returncode == 0, res.stdout + res.stderr
    return res


def mutating(fx: base.Fx, since: int = 0) -> list[str]:
    return [c for c in fx.calls()[since:] if MUTATING.match(c)]


def journal_kinds(fx: base.Fx) -> list[str]:
    return [l.split("\t")[0] for l in (fx.work / "journal.tsv").read_text().splitlines() if l]


def installed(fx: base.Fx) -> bytes:
    return fx.file(base.UNIT_REL).read_bytes()


def no_mutation(fx: base.Fx) -> None:
    assert mutating(fx) == [], mutating(fx)
    assert not (fx.work / "production-mutation").exists()


def code(path: Path) -> str:
    return base.code_lines(path)


ALL_SCRIPTS = [APPLY, VERIFY, ROLLBACK, RUNNER, REBOOT]

# ── 1. static contract ───────────────────────────────────────────────────────────────────────────────────────────────────


def test_files_exist_and_are_syntactically_valid() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-keys-rollback.txt", "allow-listeners.txt",
                 "allow-dynamic-transitions-failed-post.txt", "allow-dynamic-transitions-failed-rollback.txt"):
        assert (HND / name).is_file(), name
    for script in (*ALL_SCRIPTS, REPAIR_LIB):
        assert subprocess.run(["bash", "-n", str(script)], capture_output=True).returncode == 0, script
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER, REBOOT):
        assert stat.S_IMODE(script.stat().st_mode) & 0o111, script


def test_old_unit_constant_matches_the_historical_pre_pr305_unit() -> None:
    assert f'DNSREPAIR_OLD_UNIT_SHA256={OLD_SHA}' in REPAIR_LIB.read_text()
    assert OLD_SHA == "a684746d6e20bf672c93b11f8a8ded32d867b8f72050e88e1f26ab86aad10036"
    assert OLD_UNIT != NEW_UNIT and "ExecStartPre=/usr/bin/timeout" not in OLD_UNIT and "ExecStartPre=/usr/bin/timeout" in NEW_UNIT


def test_exact_allowed_mutation_scope_is_enforced_statically() -> None:
    """Only dnsmasq daemon-reload / reset-failed / start / restart / stop; the unit file is the only file written; nothing else is commanded."""
    verbs = r"(reset-failed|start|stop|restart|try-restart|reload|kill|enable|disable|mask|unmask|preset|set-property|edit|link|isolate|reboot|poweroff|halt)"
    for script in (APPLY, VERIFY, ROLLBACK):
        text = code(script)
        for m in re.finditer(r"systemctl\s+" + verbs + r"\s+(\S+)", text):
            assert m.group(2) in ('"$DNSMASQ_UNIT"', '"$L34_UNIT"'), (script.name, m.group(0))
        assert not re.search(r"systemctl\s+(daemon-reexec|reboot|poweroff|halt|isolate)", text)
        for pat in (r"\bnft\s+(add|delete|flush|-f|insert|replace)", r"sysctl\s+-w", r"nmcli\s+(connection|radio|device|networking)\s+(up|down|modify|delete|add|reload|on|off|set|import|edit|clone)",
                    r"\brfkill\s+(un)?block", r"iw\s+reg\s+set", r"\bsed\s+-i", r"\brm\s", r"esptool", r"mosquitto_pub", r"\bpaho\b", r"/dev/tty", r"\bscreen\b|\bminicom\b|\bpyserial\b",
                    r"/var/lib/NetworkManager", r"/etc/NetworkManager", r"/etc/aegis-idea3/", r"\bpkill|\bkillall|\bkill\s"):
            assert not re.search(pat, text, re.M), (script.name, pat)
    # the only file writes in the handlers are the unit install and the WORK evidence
    for script in (APPLY, ROLLBACK):
        assert re.search(r"dnsrepair_install_unit", code(script))
    assert "dnsrepair_install_unit()" in REPAIR_LIB.read_text()


def test_core_broker_twingate_are_only_ever_read() -> None:
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER, REBOOT):
        text = code(script)
        for unit in (r"mosquitto", r"aegis-idea3-core", r"twingate", r"BROKER_UNIT", r"CORE_UNIT", r"aegis-detection"):
            assert not re.search(r"systemctl\s+(reset-failed|start|stop|restart|try-restart|reload|kill|enable|disable|mask)\s+\"?\$?\{?[\w.\-]*" + unit, text), (script.name, unit)


def test_handlers_never_invoke_other_stage_handlers_or_devices() -> None:
    for script in ALL_SCRIPTS:
        text = code(script)
        for pat in (r"stages/L[0-9]", r"run-l7", r"run-l8", r"run-l34", r"reactivation/l34", r"p4-l8", r"p4-nvs", r"p4-l9", r"recovery_r[1-8]", r"/dev/ttyUSB|/dev/ttyACM"):
            assert not re.search(pat, text), (script.name, pat)


# ── 2. preflight (read-only) ─────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("baseline", ["failed", "running"])
def test_preflight_accepts_the_two_supported_baselines_and_changes_nothing(tmp_path: Path, baseline: str) -> None:
    fx = repair_host(tmp_path, baseline)
    unit_before = installed(fx)
    res = run(fx, APPLY, AEGIS_DNSREPAIR_PREFLIGHT_ONLY="YES")
    assert res.returncode == 0, res.stdout + res.stderr
    assert "DNSMASQ_REPAIR_PREFLIGHT=PASS" in res.stdout and f"DNSMASQ_REPAIR_BASELINE={baseline.upper()}" in res.stdout
    assert "PRODUCTION_MUTATION_PERFORMED=NO" in res.stdout
    no_mutation(fx)
    assert installed(fx) == unit_before


def test_old_installed_unit_is_recognized_as_needing_repair_and_the_corrected_authority_refuses_it(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    gate = subprocess.run(["bash", "-c", f'source "{base.LIB}"; l34_dnsmasq_unit_gate "{fx.file(base.UNIT_REL)}" "{TEMPLATE}"'], text=True, capture_output=True)
    assert gate.returncode != 0 and "L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY" in gate.stderr
    assert run(fx, APPLY, AEGIS_DNSREPAIR_PREFLIGHT_ONLY="YES").returncode == 0


def test_canonical_rendered_unit_is_accepted_by_the_corrected_l34_authority(tmp_path: Path) -> None:
    out = tmp_path / "rendered.service"
    res = subprocess.run(["bash", "-c", f'source "{base.LIB}"; source "{REPAIR_LIB}"; dnsrepair_render_gate "{TEMPLATE}" "{out}"'], text=True, capture_output=True)
    assert res.returncode == 0, res.stderr
    assert out.read_text() == NEW_UNIT and "<AEGIS_" not in out.read_text()
    assert auth.accepted(auth.gate(out))


@pytest.mark.parametrize("mutate", [
    lambda t: t + "# <AEGIS_UNKNOWN>\n",                                  # unresolved placeholder survives rendering
    lambda t: t.replace("<AEGIS_AP_CHANNEL>", "<AEGIS_AP_CHANEL>"),       # a misspelled placeholder is never substituted
], ids=["unknown-placeholder", "misspelled-placeholder"])
def test_template_with_unresolved_placeholder_is_refused(tmp_path: Path, mutate) -> None:
    tpl = tmp_path / "bad.example"
    tpl.write_text(mutate(TEMPLATE.read_text()))
    res = subprocess.run(["bash", "-c", f'source "{base.LIB}"; source "{REPAIR_LIB}"; dnsrepair_render_gate "{tpl}" "{tmp_path / "o.service"}"'], text=True, capture_output=True)
    assert res.returncode != 0 and "UNRESOLVED" in res.stderr


def test_a_mutated_rendered_unit_is_refused_by_the_authority_gate(tmp_path: Path) -> None:
    for mutated in (NEW_UNIT.replace("RestartSec=2", "RestartSec=0"), NEW_UNIT.replace("channel 6 ", "channel 11 "), NEW_UNIT + "\n"):
        assert not auth.accepted(auth.gate(auth.install(tmp_path, mutated)))


REFUSALS = [
    # AP state
    (dict(ap_active=0), "L34_AP_NOT_IN_AP_MODE", "failed"),
    (dict(active_ssid="OTHER"), "L34_AP_SSID_MISMATCH", "failed"),
    (dict(active_channel=11), "L34_AP_CHANNEL_MISMATCH", "failed"),
    (dict(ap_addr_override="10.77.30.2/28"), "L34_AP_ADDRESS_MISMATCH", "failed"),
    (dict(ap_addr_override="10.77.30.1/24"), "L34_AP_ADDRESS_MISMATCH", "failed"),
    (dict(ap_default_route=True), "L34_AP_INTERFACE_HAS_DEFAULT_ROUTE", "failed"),
    # dnsmasq state
    # the exact inactive/dead/success/MainPID 0 state is now the SAFE_STOPPED baseline (test_pr11_phase4_dnsmasq_safe_stopped_successor.py); every other inactive shape refuses
    (dict(dnsmasq="inactive", dnsmasq_props_override={"Result": "exit-code"}), "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED", "failed"),
    (dict(dnsmasq_props_override={"Result": "exit-code"}), "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED", "failed"),
    (dict(dnsmasq_props_override={"UnitFileState": "disabled"}), "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED", "failed"),
    (dict(stray_ap_listeners=["udp67"]), "L34_V6_AP_DNS_DHCP_LISTENER_PRESENT", "failed"),
    (dict(dnsmasq_props_override={"MainPID": "0"}), "DNSREPAIR_DNSMASQ_BASELINE_UNSUPPORTED", "running"),
    # systemd reload exposure
    (dict(need_reload_override={DNSMASQ_UNIT: "yes"}), "DNSREPAIR_NEEDS_DAEMON_RELOAD", "failed"),
    (dict(need_reload_override={CORE_UNIT: "yes"}), "DNSREPAIR_NEEDS_DAEMON_RELOAD", "failed"),
    (dict(need_reload_override={BROKER_UNIT: "yes"}), "DNSREPAIR_NEEDS_DAEMON_RELOAD", "failed"),
    (dict(analyze_ok=False), "DNSREPAIR_SYSTEMD_ANALYZE_FAILED", "failed"),
    # Core / broker / forwarding / L2
    (dict(identities={**sim.DEFAULT_STATE["identities"], CORE_UNIT: [0, 0], BROKER_UNIT: [5100, 3]}), "L34_V7_CORE_NOT_HEALTHY", "failed"),
    (dict(identities={**sim.DEFAULT_STATE["identities"], CORE_UNIT: [883, 0], BROKER_UNIT: [0, 0]}), "L34_V4_SERVICE_NOT_READY", "failed"),
    (dict(broker_pair_missing="ap"), "L34_V4_BROKER_LISTENERS_INVALID", "failed"),
    (dict(broker_mutate={"field": "NRestarts", "trigger": "shows:5"}), "L34_V6_BROKER_TUPLE_UNSTABLE", "failed"),
    (dict(sysctl_override={"net.ipv4.ip_forward": 1}), "L34_FORWARDING_NOT_ZERO", "failed"),
    (dict(nft_ruleset_extra="table ip nat { chain post { masquerade } }\n"), "NAT_DETECTED", "failed"),
    (dict(nft=""), "TABLE_MISSING", "failed"),
    (dict(dnsmasq_syntax_ok=False), "DNSMASQ_CONFIG_SYNTAX_FAIL", "failed"),
    (dict(other_wifi_active=True), "DNSREPAIR_UNRELATED_WIFI_ACTIVE", "failed"),
]


@pytest.mark.parametrize("over,reason,baseline", REFUSALS, ids=[f"{i}-{r[1]}" for i, r in enumerate(REFUSALS)])
def test_preflight_fails_closed_without_any_mutation(tmp_path: Path, over: dict, reason: str, baseline: str) -> None:
    fx = repair_host(tmp_path, baseline, **over)
    res = run(fx, APPLY)
    assert res.returncode != 0 and reason in res.stderr, res.stdout + res.stderr
    no_mutation(fx)
    assert installed(fx) == OLD_UNIT.encode()


def test_wrong_ap_interface_is_refused_before_anything_runs(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    res = run(fx, APPLY, AEGIS_AP_INTERFACE="wlan1")
    assert res.returncode != 0 and "TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3" in res.stderr
    assert fx.calls() == [] and not fx.work.exists()


@pytest.mark.parametrize("unit_text,reason", [
    (None, "L34_DNSMASQ_UNIT_MISSING"),
    (NEW_UNIT, "DNSREPAIR_UNIT_ALREADY_CANONICAL"),
    (OLD_UNIT + "# local edit\n", "DNSREPAIR_UNIT_UNKNOWN_AUTHORITY"),
    (OLD_UNIT.replace("Restart=on-failure", "Restart=always"), "DNSREPAIR_UNIT_UNKNOWN_AUTHORITY"),
    (base.EXAMPLE_UNIT.read_text(), "DNSREPAIR_UNIT_UNKNOWN_AUTHORITY"),          # the raw placeholder template
])
def test_only_the_exact_old_unit_is_replaced(tmp_path: Path, unit_text: str | None, reason: str) -> None:
    fx = repair_host(tmp_path, unit_text=unit_text)
    res = run(fx, APPLY)
    assert res.returncode != 0 and reason in res.stderr, res.stdout + res.stderr
    no_mutation(fx)


def test_a_symlinked_unit_is_refused(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    real = tmp_path / "real.service"
    real.write_text(OLD_UNIT)
    fx.file(base.UNIT_REL).unlink()
    fx.file(base.UNIT_REL).symlink_to(real)
    res = run(fx, APPLY)
    assert res.returncode != 0 and "L34_DNSMASQ_UNIT_MISSING" in res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("rel,text", [(base.CONF_REL, base.CONF + "# extra\nlog-queries\n"), (base.PROFILE_REL, base.PROFILE.replace("channel=6", "channel=11"))])
def test_changed_persistent_ap_configuration_is_refused(tmp_path: Path, rel: str, text: str) -> None:
    fx = repair_host(tmp_path)
    fx.file(rel).write_text(text)
    res = run(fx, APPLY)
    assert res.returncode != 0
    no_mutation(fx)


# ── 3. apply: the exact mutation sequence ────────────────────────────────────────────────────────────────────────────────


def test_apply_from_failed_start_limit_hit_has_exactly_the_approved_command_set(tmp_path: Path) -> None:
    fx = repair_host(tmp_path, "failed")
    res = applied(fx)
    assert mutating(fx) == ["systemctl daemon-reload", f"systemctl reset-failed {DNSMASQ_UNIT}", f"systemctl start {DNSMASQ_UNIT}"]
    assert installed(fx) == NEW_UNIT.encode(), "the exact canonical rendered unit"
    assert stat.S_IMODE(fx.file(base.UNIT_REL).stat().st_mode) == 0o644
    assert "DNSMASQ_REPAIR_APPLY=PASS" in res.stdout and "PRODUCTION_MUTATION_PERFORMED=YES" in res.stdout
    assert fx.state()["dnsmasq"] == "active"


def test_apply_from_running_old_unit_restarts_only_dnsmasq(tmp_path: Path) -> None:
    fx = repair_host(tmp_path, "running")
    applied(fx)
    assert mutating(fx) == ["systemctl daemon-reload", f"systemctl restart {DNSMASQ_UNIT}"]
    assert installed(fx) == NEW_UNIT.encode()


def test_unit_is_installed_before_the_reload_and_the_reload_precedes_the_start(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    applied(fx)
    assert journal_kinds(fx) == ["UNIT_BACKUP", "UNIT_INSTALL", "DAEMON_RELOAD", "DNSMASQ_RESET_FAILED", "DNSMASQ_START"]
    calls = fx.calls()
    assert calls.index("systemctl daemon-reload") < calls.index(f"systemctl start {DNSMASQ_UNIT}")


def test_journal_and_backup_exist_before_the_unit_is_replaced(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    res = run(fx, APPLY, AEGIS_DNSREPAIR_FAIL_AT="after_backup")
    assert res.returncode != 0 and "FIXTURE_INJECTED_FAILURE:after_backup" in res.stderr
    assert installed(fx) == OLD_UNIT.encode(), "not yet replaced"
    assert (fx.work / "unit.old").read_bytes() == OLD_UNIT.encode() and "UNIT_BACKUP" in journal_kinds(fx) and "UNIT_INSTALL" not in journal_kinds(fx)
    assert (fx.work / "production-mutation").exists(), "the mutation marker is written before the first write"


def test_apply_makes_no_ap_network_core_broker_or_esp32_command(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    applied(fx)
    for call in fx.calls():
        assert not call.startswith(("nmcli connection", "nmcli radio", "nmcli device set", "rfkill block", "rfkill unblock", "iw reg", "ip addr", "ip link", "ip route add")), call
        assert not re.match(r"nft (add|delete|flush|insert|replace|-f)", call) and not call.startswith("sysctl -w"), call
        if "mosquitto" in call or "aegis-idea3-core" in call or "twingate" in call or "aegis-detection" in call:
            assert call.startswith(("systemctl show", "journalctl -u")), call
    assert all(not c.startswith(("esptool", "mosquitto_pub", "screen", "minicom")) for c in fx.calls())


def test_apply_leaves_every_other_persistent_path_byte_identical(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    before = {rel: fx.file(rel).read_bytes() for rel in (base.PROFILE_REL, base.CONF_REL, base.NFT_REL, BROKER_CONF_REL)}
    meta = {rel: fx.file(rel).stat() for rel in before}
    applied(fx)
    for rel, data in before.items():
        assert fx.file(rel).read_bytes() == data
        assert fx.file(rel).stat().st_mtime_ns == meta[rel].st_mtime_ns
    assert fx.state()["ap_active"] == 1 and fx.state()["ap_profile_autoconnect"] == "yes"


def test_apply_fails_and_marks_failure_when_dnsmasq_does_not_come_up(tmp_path: Path) -> None:
    fx = repair_host(tmp_path, dnsmasq_fail_after_reload=True)
    res = run(fx, APPLY)
    assert res.returncode != 0 and "DNSMASQ_REPAIR_APPLY=FAIL" in res.stderr
    assert (fx.work / "production-mutation").exists()


def test_fixture_mode_refuses_real_host_tools_and_live_needs_flag_and_root(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    env = fx.env(AEGIS_DNSREPAIR_WORK_DIR=str(fx.work))
    env["PATH"] = "/usr/bin:/bin"
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, env=env)
    assert res.returncode != 0 and "FIXTURE_COMMAND_NOT_STUBBED" in res.stderr
    live_env = {k: v for k, v in fx.env().items() if k != "AEGIS_P4_FS_ROOT"}
    live_env["AEGIS_DNSREPAIR_WORK_DIR"] = str(tmp_path / "w2")
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, env=live_env)
    assert res.returncode != 0 and ("LIVE_AUTHORIZATION_FLAG_REQUIRED" in res.stderr)
    live_env["AEGIS_DNSREPAIR_LIVE_AUTHORIZED"] = "YES"
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, env=live_env)
    assert res.returncode != 0 and "ROOT_REQUIRED" in res.stderr or __import__("os").getuid() == 0


def test_work_dir_must_be_new_and_outside_etc(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    fx.work.mkdir()
    assert "WORK_DIR_ALREADY_EXISTS" in run(fx, APPLY).stderr
    assert "WORK_DIR_INSIDE_ETC" in run(fx, APPLY, AEGIS_DNSREPAIR_WORK_DIR="/etc/aegis-x").stderr


# ── 4. verify ────────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_verify_passes_after_apply_and_reports_the_required_verdict_lines(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    applied(fx)
    res = run(fx, VERIFY)
    assert res.returncode == 0, res.stdout + res.stderr
    lines = set(res.stdout.splitlines())
    for want in ("DNSMASQ_REPAIR_VERIFY=PASS", "DNSMASQ_REPAIR_APPLIED=YES", "DNSMASQ_UNIT_AUTHORITY=PASS", "DNSMASQ_ACTIVE=YES", "DNSMASQ_RUNNING=YES",
                 "DNSMASQ_START_LIMIT_HIT=NO", "AP_MODE=PASS", "AP_SSID=PASS", "AP_CHANNEL=PASS", "AP_IPV4_PREFIX=PASS", "CORE_HEALTH=PASS", "BROKER_UNCHANGED=PASS",
                 "FORWARDING_POLICY=PASS", "ESP32_TOUCHED=NO", "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"):
        assert want in lines, (want, res.stdout)
    assert not [c for c in mutating(fx) if c not in ("systemctl daemon-reload", f"systemctl reset-failed {DNSMASQ_UNIT}", f"systemctl start {DNSMASQ_UNIT}")]


def test_verify_is_read_only(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    applied(fx)
    n = len(fx.calls())
    assert run(fx, VERIFY).returncode == 0
    assert mutating(fx, n) == []


VERIFY_BREAKS = [
    ("unit_mutated", lambda fx: fx.file(base.UNIT_REL).write_text(NEW_UNIT.replace("RestartSec=2", "RestartSec=0")), "L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY"),
    ("unit_old_again", lambda fx: fx.file(base.UNIT_REL).write_text(OLD_UNIT), "L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY"),
    ("dnsmasq_stopped", lambda fx: fx.set(dnsmasq="inactive"), "L34_DNSMASQ_NOT_ACTIVE_RUNNING"),
    ("start_limit_hit", lambda fx: fx.set(dnsmasq="failed"), "L34_DNSMASQ_NOT_ACTIVE_RUNNING"),
    ("need_reload", lambda fx: fx.set(dnsmasq_loaded_unit="old"), "DNSREPAIR_NEEDS_DAEMON_RELOAD"),
    ("ap_down", lambda fx: fx.set(ap_active=0), "L34_AP_NOT_IN_AP_MODE"),
    ("ssid", lambda fx: fx.set(active_ssid="X"), "L34_AP_SSID_MISMATCH"),
    ("channel", lambda fx: fx.set(active_channel=1), "L34_AP_CHANNEL_MISMATCH"),
    ("address", lambda fx: fx.set(ap_addr_override="10.77.30.3/28"), "L34_AP_ADDRESS_MISMATCH"),
    ("core_changed", lambda fx: fx.set(identities={**fx.state()["identities"], CORE_UNIT: [884, 0]}), "L34_V7_CORE_CHANGED"),
    ("core_down", lambda fx: fx.set(identities={**fx.state()["identities"], CORE_UNIT: [0, 0]}), "L34_V7_CORE_NOT_HEALTHY"),
    ("broker_changed", lambda fx: fx.set(identities={**fx.state()["identities"], BROKER_UNIT: [5101, 3]}), "L34_V6_BROKER_TUPLE_CHANGED"),
    ("forwarding", lambda fx: fx.set(sysctl_override={"net.ipv4.ip_forward": 1}), "L34_FORWARDING_NOT_ZERO"),
    ("nft_changed", lambda fx: fx.set(nft=sim.NFT_GOOD + "# drift\n"), "L2_NFT_TABLE_CHANGED"),
    ("twingate_changed", lambda fx: fx.set(identities={**fx.state()["identities"], "twingate.service": [1202, 2]}), "LEGACY_OR_TWINGATE_OR_IDEA2_IDENTITY_CHANGED"),
    ("conf_touched", lambda fx: fx.file(base.CONF_REL).write_text(base.CONF + "# touched\n"), "L34_PERSISTENT_FILE_CHANGED"),
    ("broker_conf_touched", lambda fx: fx.file(BROKER_CONF_REL).write_text(BROKER_CONF + "# touched\n"), "L34_PERSISTENT_FILE_CHANGED"),
    ("dnsmasq_listeners", lambda fx: fx.set(dnsmasq="active", stray_ap_listeners=[]), None),
]


@pytest.mark.parametrize("name,breaker,reason", [v for v in VERIFY_BREAKS if v[2]], ids=[v[0] for v in VERIFY_BREAKS if v[2]])
def test_verify_rejects_any_drift_after_apply(tmp_path: Path, name: str, breaker, reason: str) -> None:
    fx = repair_host(tmp_path)
    applied(fx)
    breaker(fx)
    res = run(fx, VERIFY)
    assert res.returncode != 0 and reason in res.stderr, res.stdout + res.stderr
    assert "DNSMASQ_REPAIR_VERIFY=PASS" not in res.stdout


# ── 5. rollback ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def test_failure_before_the_unit_replacement_rolls_back_without_touching_the_unit_or_systemd(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    assert run(fx, APPLY, AEGIS_DNSREPAIR_FAIL_AT="after_backup").returncode != 0
    n = len(fx.calls())
    res = run(fx, ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert mutating(fx, n) == [], "nothing was replaced, so nothing is reloaded, reset or stopped"
    assert installed(fx) == OLD_UNIT.encode()
    assert "DNSMASQ_REPAIR_ROLLBACK=PASS" in res.stdout and fx.state()["dnsmasq"] == "failed", "dnsmasq state is exactly as before (start-limit-hit)"


def test_failure_after_the_unit_replacement_restores_the_exact_old_unit_and_reloads(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    assert run(fx, APPLY, AEGIS_DNSREPAIR_FAIL_AT="after_install").returncode != 0
    assert installed(fx) == NEW_UNIT.encode()
    n = len(fx.calls())
    res = run(fx, ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert installed(fx) == OLD_UNIT.encode() and stat.S_IMODE(fx.file(base.UNIT_REL).stat().st_mode) == 0o644
    assert mutating(fx, n) == ["systemctl daemon-reload"], "dnsmasq was never reset or started, so it is not commanded"
    assert fx.state()["dnsmasq"] == "failed" and fx.state()["dnsmasq_loaded_unit"] == "old"


def test_failure_after_start_attempt_restores_unit_reloads_and_stops_only_dnsmasq(tmp_path: Path) -> None:
    fx = repair_host(tmp_path, dnsmasq_fail_after_reload=True)
    assert run(fx, APPLY).returncode != 0
    n = len(fx.calls())
    res = run(fx, ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert installed(fx) == OLD_UNIT.encode()
    assert mutating(fx, n) == ["systemctl daemon-reload", f"systemctl stop {DNSMASQ_UNIT}"]
    assert fx.state()["dnsmasq"] == "inactive", "the stale start-limit-hit artifact is never recreated; the unit is left safely stopped"


def test_failure_after_reload_in_the_running_baseline_leaves_the_old_unit_and_a_running_dnsmasq(tmp_path: Path) -> None:
    fx = repair_host(tmp_path, "running")
    assert run(fx, APPLY, AEGIS_DNSREPAIR_FAIL_AT="after_reload").returncode != 0
    n = len(fx.calls())
    res = run(fx, ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert installed(fx) == OLD_UNIT.encode()
    assert mutating(fx, n) == ["systemctl daemon-reload"], "the running dnsmasq was never restarted, so it is not restarted again"
    assert fx.state()["dnsmasq"] == "active"


def test_failed_restart_in_the_running_baseline_is_recovered_by_the_rollback(tmp_path: Path) -> None:
    fx = repair_host(tmp_path, "running", restart_works=False)
    assert run(fx, APPLY).returncode != 0
    assert fx.state()["dnsmasq"] == "failed"
    fx.set(restart_works=True)
    n = len(fx.calls())
    res = run(fx, ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert installed(fx) == OLD_UNIT.encode()
    assert mutating(fx, n) == ["systemctl daemon-reload", f"systemctl reset-failed {DNSMASQ_UNIT}", f"systemctl restart {DNSMASQ_UNIT}"]
    assert fx.state()["dnsmasq"] == "active"


def test_rollback_after_a_fully_successful_apply_restores_the_pre_state(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    applied(fx)
    res = run(fx, ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert installed(fx) == OLD_UNIT.encode() and fx.state()["dnsmasq"] == "inactive"


def test_rollback_is_idempotent(tmp_path: Path) -> None:
    fx = repair_host(tmp_path, dnsmasq_fail_after_reload=True)
    assert run(fx, APPLY).returncode != 0
    assert run(fx, ROLLBACK).returncode == 0
    n = len(fx.calls())
    again = run(fx, ROLLBACK)
    assert again.returncode == 0, again.stdout + again.stderr
    assert installed(fx) == OLD_UNIT.encode()
    assert all(c.startswith("systemctl daemon-reload") or c.startswith("systemctl stop") for c in mutating(fx, n))


def test_rollback_requires_journal_and_the_pre_baseline(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    assert run(fx, APPLY, AEGIS_DNSREPAIR_FAIL_AT="after_install").returncode != 0
    (fx.work / "journal.tsv").unlink()
    assert "JOURNAL_MISSING" in run(fx, ROLLBACK).stderr
    fx2 = repair_host(tmp_path / "second")
    assert run(fx2, APPLY, AEGIS_DNSREPAIR_FAIL_AT="after_install").returncode != 0
    (fx2.work / "unit.old").write_bytes(b"tampered backup\n")
    res = run(fx2, ROLLBACK)
    assert res.returncode != 0 and "UNIT_BACKUP_CORRUPT" in res.stderr


def test_rollback_refuses_unowned_or_unknown_journal_entries(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    assert run(fx, APPLY, AEGIS_DNSREPAIR_FAIL_AT="after_install").returncode != 0
    with (fx.work / "journal.tsv").open("a") as f:
        f.write("DNSMASQ_START\taegis-idea3-mosquitto.service\n")
    n = len(fx.calls())
    res = run(fx, ROLLBACK)
    assert res.returncode != 0 and "JOURNAL_ENTRY_NOT_OWNED" in res.stderr and mutating(fx, n) == []
    with (fx.work / "journal.tsv").open("a") as f:
        f.write("NM_UP\taegis-idea3-ap\n")
    assert "JOURNAL_ENTRY" in run(fx, ROLLBACK).stderr


def test_rollback_detects_a_changed_persistent_file_or_ap(tmp_path: Path) -> None:
    fx = repair_host(tmp_path)
    assert run(fx, APPLY, AEGIS_DNSREPAIR_FAIL_AT="after_install").returncode != 0
    fx.file(base.CONF_REL).write_text(base.CONF + "# touched\n")
    assert "L34_PERSISTENT_FILE_CHANGED" in run(fx, ROLLBACK).stderr


def test_rollback_never_commands_anything_but_the_unit_reload_and_dnsmasq(tmp_path: Path) -> None:
    fx = repair_host(tmp_path, dnsmasq_fail_after_reload=True)
    assert run(fx, APPLY).returncode != 0
    n = len(fx.calls())
    assert run(fx, ROLLBACK).returncode == 0
    for call in mutating(fx, n):
        assert call in ("systemctl daemon-reload", f"systemctl stop {DNSMASQ_UNIT}", f"systemctl reset-failed {DNSMASQ_UNIT}", f"systemctl restart {DNSMASQ_UNIT}"), call
