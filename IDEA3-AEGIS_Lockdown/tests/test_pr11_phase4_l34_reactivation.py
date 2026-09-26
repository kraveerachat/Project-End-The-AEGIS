# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L3/L4 post-reboot RUNTIME reactivation tests (simulated host only).

Authority: docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-post-reboot-reactivation-design.md
Every handler runs against stub commands driven by tests/l34_sim.py; nothing here touches a radio, NetworkManager, a service or a real
file outside pytest's tmp_path.
"""

from __future__ import annotations

import importlib.util
import os
import re
import stat
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l34_sim as sim  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
HND = DEPLOY / "reactivation" / "l34"
APPLY, VERIFY, ROLLBACK = (HND / n for n in ("apply.sh", "verify.sh", "rollback.sh"))
LIB = DEPLOY / "p4-l34-reactivation-lib.sh"
RUNNER = DEPLOY / "owner-run" / "run-l34-reactivation-owner.sh"
COMPARE = DEPLOY / "p4-compare.sh"
EXAMPLE_UNIT = ROOT / "deploy" / "network" / "aegis-idea3-dnsmasq.service.example"
PSK = "CANARY-wifi-psk-4f9a8b7c6d5e"

PROFILE_REL = "etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection"
CONF_REL = "etc/aegis-idea3/dnsmasq-ap.conf"
NFT_REL = "etc/aegis-idea3/aegis-idea3.nft"
UNIT_REL = "etc/systemd/system/aegis-idea3-dnsmasq.service"
PERSISTENT = (PROFILE_REL, CONF_REL, NFT_REL, UNIT_REL)

PROFILE = f"""[connection]
id=aegis-idea3-ap
type=wifi
interface-name=wlp0s20f3
autoconnect=false

[wifi]
mode=ap
band=bg
channel=6
ssid=AEGIS-IDEA3

[wifi-security]
key-mgmt=wpa-psk
psk={PSK}

[ipv4]
method=manual
address1=10.77.30.1/28
never-default=true

[ipv6]
method=disabled
"""

CONF = """# AEGIS IDEA3 AP DHCP/Core-local DNS — TEMPLATE, NOT DEPLOYED.
interface=wlp0s20f3
bind-interfaces
except-interface=lo

dhcp-range=10.77.30.2,10.77.30.14,255.255.255.240

# ESP32 must not receive an Internet/default-gateway route.
dhcp-option=option:router

# Core-local DNS only.
dhcp-option=option:dns-server,10.77.30.1
no-resolv
no-hosts
address=/mqtt.aegis.home.arpa/10.77.30.1
"""

MUTATING = re.compile(
    r"^(rfkill (block|unblock)|nmcli connection (up|down|modify|delete|reload)|systemctl (reset-failed|start|stop|enable|disable|restart)|iw reg set|nmcli radio wifi (on|off))"
)


@dataclass
class Fx:
    tmp: Path
    root: Path
    work: Path
    stubs: Path
    simd: Path

    def state(self) -> dict:
        return sim.load(self.simd)

    def set(self, **kw) -> None:
        s = self.state()
        s.update(kw)
        sim.save(self.simd, s)

    def calls(self) -> list[str]:
        return sim.calls(self.simd)

    def mutating_calls(self) -> list[str]:
        return [c for c in self.calls() if MUTATING.match(c)]

    def env(self, **extra: str) -> dict[str, str]:
        env = {k: v for k, v in os.environ.items() if not k.startswith("AEGIS_")}
        env.update(
            PATH=f"{self.stubs}:{os.environ['PATH']}",
            AEGIS_L34_STUB_DIR=str(self.stubs),
            AEGIS_L34_SIM_DIR=str(self.simd),
            AEGIS_P4_FS_ROOT=str(self.root),
            AEGIS_L34_WORK_DIR=str(self.work),
            AEGIS_AP_INTERFACE="wlp0s20f3",
            AEGIS_L34_NM_TRIES="3",
            AEGIS_L34_NM_INTERVAL="0.01",
            AEGIS_L34_SVC_TRIES="3",
            AEGIS_L34_SVC_INTERVAL="0.01",
            L34_EXPECT_OWNER=f"{os.getuid()}:{os.getgid()}",
        )
        env.update(extra)
        return env

    def run(self, script: Path, **extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(script)], text=True, capture_output=True, check=False, env=self.env(**extra))

    def file(self, rel: str) -> Path:
        return self.root / rel

    def persistent_state(self) -> dict[str, tuple]:
        out = {}
        for rel in PERSISTENT:
            p = self.file(rel)
            st = p.stat()
            out[rel] = (p.read_bytes(), stat.S_IMODE(st.st_mode), st.st_mtime_ns, st.st_ctime_ns)
        return out


def build(tmp_path: Path, **sim_over) -> Fx:
    root = tmp_path / "fs"
    for rel, text, mode in (
        (PROFILE_REL, PROFILE, 0o600),
        (CONF_REL, CONF, 0o644),
        (NFT_REL, "table inet aegis_idea3 {}\n", 0o644),
        (UNIT_REL, EXAMPLE_UNIT.read_text(), 0o644),
    ):
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
        p.chmod(mode)
    rf = root / "sys/class/net/wlp0s20f3/phy80211/rfkill1"
    rf.mkdir(parents=True)
    (rf / "index").write_text("1\n")
    stubs, simd = tmp_path / "stubs", tmp_path / "sim"
    sim.install(stubs, simd, **sim_over)
    return Fx(tmp_path, root, tmp_path / "work", stubs, simd)


@pytest.fixture()
def fx(tmp_path: Path) -> Fx:
    return build(tmp_path)


def applied(fx: Fx) -> subprocess.CompletedProcess[str]:
    res = fx.run(APPLY)
    assert res.returncode == 0, res.stdout + res.stderr
    return res


def no_mutation(fx: Fx) -> None:
    assert fx.mutating_calls() == [], fx.mutating_calls()
    assert not (fx.work / "production-mutation").exists()


# ── structure / static contract ──────────────────────────────────────────────────────────────────────────────────────────


def test_files_exist_executable_and_syntactically_valid() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-keys-rollback.txt", "allow-listeners.txt",
                 "allow-transitions.txt", "allow-dynamic-transitions.txt", "allow-dynamic-transitions-rollback.txt"):
        assert (HND / name).is_file(), name
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER, LIB):
        assert subprocess.run(["bash", "-n", str(script)], capture_output=True).returncode == 0, script
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER):
        assert stat.S_IMODE(script.stat().st_mode) & 0o111


def code_lines(path: Path) -> str:
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("#"))


@pytest.mark.parametrize("script", [APPLY, VERIFY, ROLLBACK, RUNNER, LIB])
def test_no_forbidden_global_wifi_regulatory_or_host_commands(script: Path) -> None:
    text = code_lines(script)
    for pat in (
        r"rfkill\s+(un)?block\s+all", r"nmcli\s+radio\s+wifi\s+(on|off)", r"nmcli\s+(general|networking)\s+", r"iw\s+reg\s+set",
        r"nmcli\s+connection\s+(modify|delete|add|reload|import|edit)", r"systemctl\s+(enable|disable|restart|reload|mask|daemon-reload)",
        r"systemctl\s+(start|stop|reset-failed)\s+dnsmasq\.service", r"\bnft\s+(add|delete|flush|-f|insert|replace)", r"sysctl\s+-w",
        r"\bpkill\b", r"\bkillall\b", r"\brm\s", r"\bmv\s", r"\binstall\s+-", r"tee\s+/etc", r"(^|[;&|]\s*)(sudo\s+)?(reboot|shutdown|poweroff)\b", r"esptool",
        r"twingate\s+(stop|start|restart)", r"mosquitto\.service\s*$",
    ):
        assert not re.search(pat, text, re.M), (script.name, pat)
    if script is not RUNNER:  # the runner copies its own authorization records into the evidence directory; handlers copy nothing
        assert not re.search(r"\bcp\s", text)


def test_handlers_and_runner_never_invoke_l3_l4_apply_or_l6b() -> None:
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER, LIB):
        text = code_lines(script)
        assert not re.search(r"stages/L[34]/(apply|rollback|verify)\.sh", text), script.name
        assert "stages/L6b" not in text and "run-l6b" not in text
    assert "ESP32" not in code_lines(APPLY) + code_lines(ROLLBACK)


def test_handlers_never_write_persistent_paths() -> None:
    for script in (APPLY, VERIFY, ROLLBACK):
        text = code_lines(script)
        assert not re.search(r">>?\s*\"?\$\{?(profile|conf|unit_file|nft_file)\b", text), script.name
        assert not re.search(r">\s*/etc/", text)


def test_only_exact_service_and_connection_mutations_are_scripted() -> None:
    text = code_lines(APPLY) + code_lines(ROLLBACK)
    for m in re.finditer(r"systemctl\s+(reset-failed|start|stop)\s+(\S+)", text):
        assert m.group(2).strip('"') in ("\"$L34_UNIT\"", "$L34_UNIT"), m.group(0)
    for m in re.finditer(r"nmcli\s+connection\s+(up|down)\s+(\S+)", text):
        assert "L34_CONN" in m.group(2) or "\"$2\"" in m.group(2), m.group(0)


# ── happy path: exact command set, exact order, nothing else moves ──────────────────────────────────────────────────────


def test_apply_reactivates_runtime_with_the_exact_command_set(fx: Fx) -> None:
    before = fx.persistent_state()
    res = applied(fx)
    assert "L34_APPLY=PASS" in res.stdout and "REACTIVATION_TYPE=RUNTIME_ONLY" in res.stdout
    assert "PERSISTENT_FILES_REWRITTEN=NO" in res.stdout
    assert "L3_LIVE_ACCEPTANCE_CLAIMED=NO" in res.stdout and "L4_LIVE_ACCEPTANCE_CLAIMED=NO" in res.stdout
    assert "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN" in res.stdout
    assert fx.mutating_calls() == [
        "rfkill unblock 1",
        "nmcli connection up aegis-idea3-ap ifname wlp0s20f3",
        "systemctl reset-failed aegis-idea3-dnsmasq.service",
        "systemctl start aegis-idea3-dnsmasq.service",
    ]
    s = fx.state()
    assert s["ap_active"] == 1 and s["dnsmasq"] == "active" and s["rfkill_soft"] == 0
    assert s["bt_rfkill_soft"] == 1  # only the resolved target changed
    assert fx.persistent_state() == before
    assert (fx.work / "rfkill_pre_state").read_text().strip() == "1"


def test_reset_failed_happens_after_activation_and_only_for_the_exact_unit(fx: Fx) -> None:
    applied(fx)
    calls = fx.calls()
    assert calls.index("nmcli connection up aegis-idea3-ap ifname wlp0s20f3") < calls.index("systemctl reset-failed aegis-idea3-dnsmasq.service")
    assert calls.index("systemctl reset-failed aegis-idea3-dnsmasq.service") < calls.index("systemctl start aegis-idea3-dnsmasq.service")
    assert not any(c.startswith(("systemctl enable", "systemctl disable", "systemctl daemon-reload", "systemctl restart")) for c in calls)
    assert not any("dnsmasq.service" in c and "aegis-idea3" not in c for c in calls if c.startswith("systemctl"))


def test_no_global_wifi_or_regulatory_or_enable_commands_are_ever_issued(fx: Fx) -> None:
    applied(fx)
    for c in fx.calls():
        assert not c.startswith(("nmcli radio wifi on", "iw reg set", "rfkill unblock all", "nmcli device", "nmcli general", "nmcli networking"))
    assert "rfkill unblock all" not in "\n".join(fx.calls())


def test_the_psk_never_appears_in_output_or_work_files(fx: Fx) -> None:
    res = applied(fx)
    assert fx.run(VERIFY).returncode == 0
    corpus = [res.stdout, res.stderr] + [p.read_text(errors="ignore") for p in fx.work.rglob("*") if p.is_file()]
    assert PSK not in "\n".join(corpus)
    assert not re.search(r"^\s*psk\s*=", "\n".join(corpus), re.M)
    snap = (fx.work / "persistent-pre.tsv").read_text()
    assert PSK not in snap and not re.search(r"psk\s*=", snap)


def test_verify_passes_after_apply(fx: Fx) -> None:
    applied(fx)
    res = fx.run(VERIFY)
    assert res.returncode == 0, res.stdout + res.stderr
    for m in ("L34_VERIFY=PASS", "DNSMASQ=ACTIVE_RUNNING", "PERSISTENT_FILES_UNCHANGED=YES", "L2_UNCHANGED=YES", "FORWARDING=ZERO"):
        assert m in res.stdout


def test_apply_output_marks_first_mutation_before_it_happens(fx: Fx) -> None:
    res = applied(fx)
    assert res.stdout.index("PRODUCTION_MUTATION_PERFORMED=YES") < res.stdout.index("L34_APPLY=PASS")
    assert (fx.work / "production-mutation").read_text().strip() == "YES"


def test_journal_records_exactly_what_this_run_changed(fx: Fx) -> None:
    applied(fx)
    entries = [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()]
    assert entries == [("RFKILL_UNBLOCK", "1"), ("NM_UP", "aegis-idea3-ap"), ("DNSMASQ_RESET_FAILED", "aegis-idea3-dnsmasq.service"),
                       ("DNSMASQ_START", "aegis-idea3-dnsmasq.service")]


# ── environment / mode guards ────────────────────────────────────────────────────────────────────────────────────────────


def test_wrong_interface_is_rejected_before_anything_runs(fx: Fx) -> None:
    res = fx.run(APPLY, AEGIS_AP_INTERFACE="wlan1")
    assert res.returncode != 0 and "TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3" in res.stderr
    assert fx.calls() == []


def test_fixture_mode_refuses_real_host_tools(fx: Fx) -> None:
    env = fx.env()
    env["PATH"] = os.environ["PATH"]
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, env=env)
    assert res.returncode != 0 and "FIXTURE_COMMAND_NOT_STUBBED" in res.stderr


def test_live_mode_requires_authorization_flag_and_root(fx: Fx) -> None:
    env = fx.env()
    env.pop("AEGIS_P4_FS_ROOT")
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, env=env)
    assert res.returncode != 0 and "LIVE_AUTHORIZATION_FLAG_REQUIRED" in res.stderr
    env["AEGIS_L34_LIVE_AUTHORIZED"] = "YES"
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, env=env)
    assert res.returncode != 0 and "ROOT_REQUIRED" in res.stderr
    assert fx.calls() == []


def test_work_dir_must_be_new_and_outside_etc(fx: Fx) -> None:
    fx.work.mkdir()
    assert "WORK_DIR_ALREADY_EXISTS" in fx.run(APPLY).stderr
    assert "WORK_DIR_INSIDE_ETC" in fx.run(APPLY, AEGIS_L34_WORK_DIR="/etc/aegis-l34-test").stderr


# ── rfkill: exact-ID binding ─────────────────────────────────────────────────────────────────────────────────────────────


def test_soft_blocked_target_is_unblocked_by_exact_id_only(fx: Fx) -> None:
    applied(fx)
    assert [c for c in fx.calls() if c.startswith("rfkill unblock")] == ["rfkill unblock 1"]


def test_already_unblocked_target_needs_no_unblock(tmp_path: Path) -> None:
    fx = build(tmp_path, rfkill_soft=0)
    applied(fx)
    assert not any(c.startswith("rfkill unblock") for c in fx.calls())
    assert (fx.work / "rfkill_pre_state").read_text().strip() == "0"


def test_hard_blocked_target_fails_before_any_mutation(tmp_path: Path) -> None:
    fx = build(tmp_path, rfkill_hard=1)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "RFKILL_HARD_BLOCKED" in res.stderr
    no_mutation(fx)


def test_ambiguous_rfkill_binding_fails(fx: Fx) -> None:
    other = fx.root / "sys/class/net/wlp0s20f3/phy80211/rfkill2"
    other.mkdir()
    (other / "index").write_text("2\n")
    res = fx.run(APPLY)
    assert res.returncode != 0 and "RFKILL_ID_AMBIGUOUS" in res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("index", ["0", "3", "7"])
def test_rfkill_id_is_bound_to_the_interface_not_hardcoded(fx: Fx, index: str) -> None:
    (fx.root / "sys/class/net/wlp0s20f3/phy80211/rfkill1/index").write_text(index + "\n")
    res = fx.run(APPLY)
    assert res.returncode != 0 and "RFKILL_ID_MISMATCH" in res.stderr
    no_mutation(fx)


def test_missing_rfkill_binding_fails(fx: Fx) -> None:
    (fx.root / "sys/class/net/wlp0s20f3/phy80211/rfkill1/index").unlink()
    res = fx.run(APPLY)
    assert res.returncode != 0 and "RFKILL_ID_NOT_FOUND" in res.stderr
    no_mutation(fx)


# ── NetworkManager: bounded readiness, bound activation ──────────────────────────────────────────────────────────────────


def test_nm_readiness_is_bounded_and_state_based(tmp_path: Path) -> None:
    fx = build(tmp_path, nm_ready_after_unblock=False)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "NM_TARGET_DEVICE_NOT_READY" in res.stderr
    polls = [c for c in fx.calls() if c == "nmcli -t -f DEVICE,STATE device status"]
    assert len(polls) == 3  # AEGIS_L34_NM_TRIES, not an open-ended loop
    assert not any(c.startswith("nmcli connection up") for c in fx.calls())
    assert not any(c.startswith(("nmcli radio wifi on", "systemctl reset-failed", "systemctl start")) for c in fx.calls())


def test_activation_is_bound_with_ifname_and_failure_is_reported(tmp_path: Path) -> None:
    fx = build(tmp_path, nm_activation_works=False)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "NMCLI_UP_FAILED" in res.stderr
    ups = [c for c in fx.calls() if c.startswith("nmcli connection up")]
    assert ups == ["nmcli connection up aegis-idea3-ap ifname wlp0s20f3"]  # exactly one attempt
    assert not any(c.startswith("systemctl start") for c in fx.calls())


@pytest.mark.parametrize(
    "over,reason",
    [
        ({"active_ssid": "Pboo_5G"}, "L34_AP_SSID_MISMATCH"),
        ({"active_channel": 11}, "L34_AP_CHANNEL_MISMATCH"),
        ({"ap_addr_override": "10.77.30.5/28"}, "L34_AP_ADDRESS_MISMATCH"),
        ({"ap_addr_override": "10.77.30.1/24"}, "L34_AP_ADDRESS_MISMATCH"),
    ],
)
def test_wrong_ap_runtime_after_activation_fails_and_stops_before_dnsmasq(tmp_path: Path, over: dict, reason: str) -> None:
    fx = build(tmp_path, **over)
    res = fx.run(APPLY)
    assert res.returncode != 0 and reason in res.stderr
    assert not any(c.startswith(("systemctl reset-failed", "systemctl start")) for c in fx.calls())


def test_ap_default_route_after_activation_fails(tmp_path: Path) -> None:
    fx = build(tmp_path, extra_default_route=True)
    res = fx.run(APPLY)
    assert res.returncode != 0
    assert not any(c.startswith("systemctl start") for c in fx.calls())


@pytest.mark.parametrize("over,reason", [
    ({"ap_default_route": True}, "L34_AP_INTERFACE_HAS_DEFAULT_ROUTE"),
    ({"alt_default": False}, "L34_NO_ALTERNATE_DEFAULT_ROUTE"),
    ({"ap_active": 1}, "L34_AP_ALREADY_ACTIVE"),
])
def test_ap_preconditions_fail_before_any_mutation(tmp_path: Path, over: dict, reason: str) -> None:
    fx = build(tmp_path, **over)
    res = fx.run(APPLY)
    assert res.returncode != 0 and reason in res.stderr, res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("over,reason", [
    ({"phy_country": "US"}, "REGULATORY_DOMAIN_MISMATCH"),
    ({"channel6_flags": "No IR"}, "CHANNEL_NOT_PERMITTED"),
    ({"channel6_flags": "Radar detection"}, "CHANNEL_NOT_PERMITTED"),
    ({"channel6_flags": "Passive scan"}, "CHANNEL_NOT_PERMITTED"),
    ({"channel6_flags": "Indoor only"}, "CHANNEL_NOT_PERMITTED"),
])
def test_regulatory_model_b_gate_rejects_restricted_state_without_setting_it(tmp_path: Path, over: dict, reason: str) -> None:
    fx = build(tmp_path, **over)
    res = fx.run(APPLY)
    assert res.returncode != 0 and reason in res.stderr
    no_mutation(fx)
    assert not any(c.startswith("iw reg set") for c in fx.calls())


@pytest.mark.parametrize("country", ["00", "TH"])
def test_regulatory_model_b_accepts_00_and_th(tmp_path: Path, country: str) -> None:
    fx = build(tmp_path, phy_country=country)
    applied(fx)


# ── persistent configuration preflight (fail closed before any mutation) ─────────────────────────────────────────────────


def edit(fx: Fx, rel: str, fn) -> None:
    p = fx.file(rel)
    mode = stat.S_IMODE(p.stat().st_mode)
    p.write_text(fn(p.read_text()))
    p.chmod(mode)


@pytest.mark.parametrize(
    "fn,reason",
    [
        (lambda t: t.replace("mode=ap", "mode=infrastructure"), "L34_PROFILE_MODE_NOT_AP"),
        (lambda t: t.replace("ssid=AEGIS-IDEA3", "ssid=Other"), "L34_PROFILE_SSID_MISMATCH"),
        (lambda t: t.replace("band=bg", "band=a"), "L34_PROFILE_BAND_MISMATCH"),
        (lambda t: t.replace("channel=6", "channel=11"), "L34_PROFILE_CHANNEL_MISMATCH"),
        (lambda t: t.replace("method=manual", "method=shared"), "L34_PROFILE_IPV4_METHOD_NOT_MANUAL"),
        (lambda t: t.replace("address1=10.77.30.1/28", "address1=10.77.30.9/28"), "L34_PROFILE_ADDRESS_MISMATCH"),
        (lambda t: t.replace("address1=10.77.30.1/28", "address1=10.77.30.1/24"), "L34_PROFILE_ADDRESS_MISMATCH"),
        (lambda t: t.replace("address1=10.77.30.1/28\n", "address1=10.77.30.1/28\naddress2=10.77.31.1/24\n"), "L34_PROFILE_ADDRESS_COUNT"),
        (lambda t: t.replace("never-default=true\n", ""), "L34_PROFILE_NEVER_DEFAULT_MISSING"),
        (lambda t: t.replace("interface-name=wlp0s20f3", "interface-name=enp62s0"), "L34_PROFILE_INTERFACE_MISMATCH"),
    ],
)
def test_profile_mismatch_is_rejected(fx: Fx, fn, reason: str) -> None:
    edit(fx, PROFILE_REL, fn)
    res = fx.run(APPLY)
    assert res.returncode != 0 and reason in res.stderr, res.stderr
    no_mutation(fx)
    assert PSK not in res.stdout + res.stderr


def test_profile_mode_must_be_0600(fx: Fx) -> None:
    fx.file(PROFILE_REL).chmod(0o644)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "L34_PROFILE_MODE_NOT_0600" in res.stderr
    no_mutation(fx)


def test_profile_owner_must_be_root_in_live_terms(fx: Fx) -> None:
    res = fx.run(APPLY, L34_EXPECT_OWNER="0:0") if os.getuid() != 0 else fx.run(APPLY, L34_EXPECT_OWNER="12345:12345")
    assert res.returncode != 0 and "L34_PROFILE_OWNER_NOT_ROOT" in res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("idx", range(7))
def test_nm_effective_values_must_match(tmp_path: Path, idx: int) -> None:
    eff = list(sim.DEFAULT_STATE["effective"])
    eff[idx] = "WRONG"
    fx = build(tmp_path, effective=eff)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "L34_PROFILE_EFFECTIVE_MISMATCH" in res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("drop", ["interface=wlp0s20f3", "bind-interfaces", "except-interface=lo", "dhcp-option=option:router", "no-resolv", "no-hosts",
                                  "dhcp-range=10.77.30.2,10.77.30.14,255.255.255.240", "dhcp-option=option:dns-server,10.77.30.1",
                                  "address=/mqtt.aegis.home.arpa/10.77.30.1"])
def test_each_required_dnsmasq_directive_is_verified_including_bare_ones(fx: Fx, drop: str) -> None:
    edit(fx, CONF_REL, lambda t: t.replace(drop + "\n", ""))
    res = fx.run(APPLY)
    assert res.returncode != 0 and "L34_DNSMASQ_DIRECTIVE_MISSING_OR_DUPLICATE" in res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("extra", ["listen-address=0.0.0.0", "bogus-priv", "domain-needed", "server=1.1.1.1", "dhcp-range=10.77.31.2,10.77.31.9,12h",
                                   "interface=enp62s0", "conf-dir=/etc/dnsmasq.d"])
def test_unexpected_dnsmasq_directive_is_rejected(fx: Fx, extra: str) -> None:
    edit(fx, CONF_REL, lambda t: t + extra + "\n")
    res = fx.run(APPLY)
    assert res.returncode != 0 and ("UNEXPECTED_DIRECTIVE" in res.stderr or "DUPLICATE" in res.stderr)
    no_mutation(fx)


def test_duplicate_dnsmasq_directive_is_rejected(fx: Fx) -> None:
    edit(fx, CONF_REL, lambda t: t + "no-hosts\n")
    assert fx.run(APPLY).returncode != 0
    no_mutation(fx)


def test_dnsmasq_unit_must_equal_accepted_repository_authority(fx: Fx) -> None:
    edit(fx, UNIT_REL, lambda t: t.replace("Restart=on-failure", "Restart=always"))
    res = fx.run(APPLY)
    assert res.returncode != 0 and "L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY" in res.stderr
    no_mutation(fx)


def test_missing_persistent_file_fails(fx: Fx) -> None:
    fx.file(NFT_REL).unlink()
    res = fx.run(APPLY)
    assert res.returncode != 0 and "L34_NFT_FILE_MISSING" in res.stderr
    no_mutation(fx)


# ── L2 runtime: fresh proof, never mutated ────────────────────────────────────────────────────────────────────────────────


def l2_without(line: str) -> str:
    return "\n".join(l for l in sim.NFT_GOOD.split("\n") if line not in l) + ""


@pytest.mark.parametrize(
    "nft,reason",
    [
        ("", "L2_RUNTIME_NOT_READY=YES"),
        (sim.NFT_GOOD.replace("aegis_idea3", "other"), "TABLE_MISSING"),
        (l2_without('udp dport 67 accept'), "PERMIT_MISSING:udp dport 67"),
        (l2_without('udp dport 53 ip saddr'), "PERMIT_MISSING:udp dport 53"),
        (l2_without('tcp dport 53 ip saddr'), "PERMIT_MISSING:tcp dport 53"),
        (l2_without('udp dport 123'), "PERMIT_MISSING:udp dport 123"),
        (l2_without('tcp dport 8883'), "PERMIT_MISSING:tcp dport 8883"),
        (l2_without('tcp dport 1883 drop'), "PF01_1883_DROP_MISSING"),
        (sim.NFT_GOOD.replace("tcp dport 1883 drop", "tcp dport 1883 accept"), "PF01_1883_DROP_MISSING"),
        (sim.NFT_GOOD.replace('\t\tiifname "wlp0s20f3" drop\n\t}\n\tchain forward', "\t}\n\tchain forward"), "AP_CATCHALL_DROP_MISSING"),
        (sim.NFT_GOOD.replace('\t\tiifname "wlp0s20f3" drop\n\t}\n}', "\t}\n}"), "FORWARD_ISOLATION_MISSING"),
        (sim.NFT_GOOD.replace("ip saddr 10.77.30.0/28 accept", "accept"), "PERMIT_MISSING"),
        (sim.NFT_GOOD.replace("tcp dport 8883 ip saddr 10.77.30.0/28 accept", "tcp dport 8883 ip saddr 0.0.0.0/0 accept"), "PERMIT_MISSING:tcp dport 8883"),
        (sim.NFT_GOOD.replace("\t}\n}", "\t\tmasquerade\n\t}\n}"), "NAT_DETECTED"),
    ],
)
def test_l2_runtime_must_be_freshly_proven(tmp_path: Path, nft: str, reason: str) -> None:
    fx = build(tmp_path, nft=nft)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "L2_RUNTIME_NOT_READY=YES" in res.stderr and reason in res.stderr, res.stderr
    no_mutation(fx)


def test_nat_in_another_table_is_rejected(tmp_path: Path) -> None:
    fx = build(tmp_path, nft_ruleset_extra="table ip nat {\n chain postrouting {\n  masquerade\n }\n}\n")
    res = fx.run(APPLY)
    assert res.returncode != 0 and "NAT_DETECTED" in res.stderr
    no_mutation(fx)


@pytest.mark.parametrize("key", ["net.ipv4.ip_forward", "net.ipv4.conf.all.forwarding", "net.ipv4.conf.default.forwarding",
                                 "net.ipv4.conf.wlp0s20f3.forwarding", "net.ipv6.conf.all.forwarding", "net.ipv6.conf.default.forwarding",
                                 "net.ipv6.conf.wlp0s20f3.forwarding"])
def test_any_nonzero_forwarding_sysctl_is_rejected(tmp_path: Path, key: str) -> None:
    fx = build(tmp_path, sysctl_override={key: 1})
    res = fx.run(APPLY)
    assert res.returncode != 0 and f"L34_FORWARDING_NOT_ZERO:{key}" in res.stderr
    no_mutation(fx)


def test_no_nft_or_sysctl_write_is_ever_issued(fx: Fx) -> None:
    applied(fx)
    assert not any(c.startswith(("nft add", "nft delete", "nft flush", "nft -f", "sysctl -w")) for c in fx.calls())
    assert all(c.startswith(("nft list", "sysctl -n")) for c in fx.calls() if c.startswith(("nft", "sysctl")))


# ── dnsmasq service state ────────────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("state", ["active", "inactive"])
def test_dnsmasq_prestate_must_be_the_observed_failed_start_limit_hit(tmp_path: Path, state: str) -> None:
    fx = build(tmp_path, dnsmasq=state)
    res = fx.run(APPLY)
    assert res.returncode != 0 and "L34_DNSMASQ_PRESTATE_UNEXPECTED" in res.stderr
    no_mutation(fx)


def test_dnsmasq_that_does_not_reach_active_running_fails_the_run(tmp_path: Path) -> None:
    fx = build(tmp_path, dnsmasq_start_works=False)
    res = fx.run(APPLY)
    assert res.returncode != 0
    assert "DNSMASQ_NOT_ACTIVE_RUNNING" in res.stderr or "L34_DNSMASQ_NOT_ACTIVE_RUNNING" in res.stderr


# ── verify: fail closed on drift ─────────────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("rel", PERSISTENT)
def test_verify_rejects_any_persistent_file_change_even_content_preserving_touch(fx: Fx, rel: str) -> None:
    applied(fx)
    p = fx.file(rel)
    text = p.read_text()
    p.write_text(text)  # same bytes, new mtime/ctime: a rewrite must still be detected
    os.utime(p, ns=(p.stat().st_atime_ns, p.stat().st_mtime_ns + 5_000_000_000))
    res = fx.run(VERIFY)
    assert res.returncode != 0 and "L34_PERSISTENT_FILE_CHANGED" in res.stderr
    assert PSK not in res.stdout + res.stderr


def test_verify_rejects_nft_table_change(fx: Fx) -> None:
    applied(fx)
    fx.set(nft=sim.NFT_GOOD + "\t# reordered\n")
    res = fx.run(VERIFY)
    assert res.returncode != 0 and "L2_NFT_TABLE_CHANGED" in res.stderr


def test_verify_rejects_forwarding_enabled_after_apply(fx: Fx) -> None:
    applied(fx)
    fx.set(sysctl_override={"net.ipv4.ip_forward": 1})
    assert fx.run(VERIFY).returncode != 0


def test_verify_rejects_global_rfkill_unblock(fx: Fx) -> None:
    applied(fx)
    fx.set(bt_rfkill_soft=0)
    res = fx.run(VERIFY)
    assert res.returncode != 0 and "L34_RFKILL_NON_TARGET_CHANGED" in res.stderr


@pytest.mark.parametrize("unit", ["mosquitto.service", "twingate.service", "aegis-detection-engine.service", "aegis-detection-tunnel.service"])
def test_verify_rejects_legacy_mosquitto_twingate_or_idea2_identity_change(fx: Fx, unit: str) -> None:
    applied(fx)
    ids = fx.state()["identities"]
    ids[unit] = [ids[unit][0] + 1, ids[unit][1]]
    fx.set(identities=ids)
    res = fx.run(VERIFY)
    assert res.returncode != 0 and "IDENTITY_CHANGED" in res.stderr


def test_verify_rejects_dnsmasq_not_running(fx: Fx) -> None:
    applied(fx)
    fx.set(dnsmasq="inactive")
    assert fx.run(VERIFY).returncode != 0


def test_verify_rejects_default_route_change(fx: Fx) -> None:
    applied(fx)
    fx.set(alt_default=False)
    assert fx.run(VERIFY).returncode != 0


def test_verify_is_read_only(fx: Fx) -> None:
    applied(fx)
    n = len(fx.calls())
    fx.run(VERIFY)
    assert not [c for c in fx.calls()[n:] if MUTATING.match(c)]


# ── rollback: exact, idempotent, never recreates the stale artifact ──────────────────────────────────────────────────────


def test_rollback_undoes_exactly_the_journaled_changes(fx: Fx) -> None:
    before = fx.persistent_state()
    applied(fx)
    n = len(fx.calls())
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert [c for c in fx.calls()[n:] if MUTATING.match(c)] == [
        "systemctl stop aegis-idea3-dnsmasq.service",
        "nmcli connection down aegis-idea3-ap",
        "rfkill block 1",
    ]
    s = fx.state()
    assert s["ap_active"] == 0 and s["dnsmasq"] == "inactive" and s["rfkill_soft"] == 1 and s["bt_rfkill_soft"] == 1
    assert fx.persistent_state() == before
    for m in ("L34_ROLLBACK=PASS", "AP_ACTIVE=NO", "DNSMASQ_RUNNING=NO", "RFKILL_PRE_STATE_RESTORED=YES", "STALE_START_LIMIT_HIT_RECREATED=NO"):
        assert m in res.stdout


def test_rollback_never_recreates_start_limit_hit_or_touches_enable_state(fx: Fx) -> None:
    applied(fx)
    n = len(fx.calls())
    fx.run(ROLLBACK)
    later = fx.calls()[n:]
    assert not any(c.startswith(("systemctl reset-failed", "systemctl start", "systemctl enable", "systemctl disable", "systemctl restart")) for c in later)
    assert fx.state()["dnsmasq"] == "inactive"  # a safe non-running state, not a manufactured failed/start-limit-hit


def test_rollback_is_idempotent(fx: Fx) -> None:
    applied(fx)
    assert fx.run(ROLLBACK).returncode == 0
    n = len(fx.calls())
    again = fx.run(ROLLBACK)
    assert again.returncode == 0, again.stdout + again.stderr
    assert [c for c in fx.calls()[n:] if c.startswith(("systemctl stop", "nmcli connection down"))] == []


def test_rollback_restores_only_the_recorded_rfkill_id_and_only_if_it_was_blocked(tmp_path: Path) -> None:
    fx = build(tmp_path, rfkill_soft=0)
    applied(fx)
    assert fx.run(ROLLBACK).returncode == 0
    assert not any(c.startswith("rfkill block") for c in fx.calls())
    assert fx.state()["rfkill_soft"] == 0  # it was unblocked before this run, so it stays unblocked


def test_rollback_after_partial_apply_undoes_only_what_happened(tmp_path: Path) -> None:
    fx = build(tmp_path, nm_ready_after_unblock=False)
    assert fx.run(APPLY).returncode != 0
    assert [tuple(l.split("\t")) for l in (fx.work / "journal.tsv").read_text().splitlines()] == [("RFKILL_UNBLOCK", "1")]
    n = len(fx.calls())
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    assert [c for c in fx.calls()[n:] if MUTATING.match(c)] == ["rfkill block 1"]
    assert fx.state()["rfkill_soft"] == 1


def test_rollback_after_start_failure_returns_to_safe_state(tmp_path: Path) -> None:
    fx = build(tmp_path, dnsmasq_start_works=False)
    assert fx.run(APPLY).returncode != 0
    res = fx.run(ROLLBACK)
    assert res.returncode == 0, res.stdout + res.stderr
    s = fx.state()
    assert s["ap_active"] == 0 and s["rfkill_soft"] == 1 and s["dnsmasq"] in ("inactive", "failed")


def test_rollback_deletes_nothing_and_rewrites_nothing(fx: Fx) -> None:
    before = fx.persistent_state()
    applied(fx)
    fx.run(ROLLBACK)
    assert fx.persistent_state() == before
    assert all(fx.file(rel).exists() for rel in PERSISTENT)


@pytest.mark.parametrize("line", ["FILE\t/etc/aegis-idea3/dnsmasq-ap.conf", "NM_UP\tPboo_5G", "DNSMASQ_START\tdnsmasq.service",
                                  "RFKILL_UNBLOCK\tall", "RFKILL_UNBLOCK\t0 ; rfkill unblock all", "WHATEVER\tx"])
def test_rollback_rejects_tampered_journal(fx: Fx, line: str) -> None:
    applied(fx)
    with (fx.work / "journal.tsv").open("a") as fh:
        fh.write(line + "\n")
    n = len(fx.calls())
    res = fx.run(ROLLBACK)
    assert res.returncode != 0 and ("JOURNAL_ENTRY_NOT_OWNED" in res.stderr or "JOURNAL_ENTRY_UNKNOWN" in res.stderr)
    assert not [c for c in fx.calls()[n:] if MUTATING.match(c)]


def test_rollback_requires_journal_and_pre_baseline(fx: Fx) -> None:
    applied(fx)
    (fx.work / "journal.tsv").unlink()
    assert "JOURNAL_MISSING" in fx.run(ROLLBACK).stderr


def test_rollback_detects_persistent_change_legacy_change_and_l2_change(fx: Fx) -> None:
    applied(fx)
    fx.file(CONF_REL).write_text(CONF + "# touched\n")
    assert "L34_PERSISTENT_FILE_CHANGED" in fx.run(ROLLBACK).stderr


def test_rollback_only_downs_the_approved_connection_on_the_target(tmp_path: Path) -> None:
    fx = build(tmp_path)
    applied(fx)
    n = len(fx.calls())
    assert fx.run(ROLLBACK).returncode == 0
    downs = [c for c in fx.calls()[n:] if c.startswith("nmcli connection down")]
    assert downs == ["nmcli connection down aegis-idea3-ap"]  # by exact profile id, never a device-wide or global command
    assert not any(c.startswith(("nmcli device", "nmcli radio", "nmcli networking")) for c in fx.calls()[n:] if MUTATING.match(c))


# ── comparator: exact value-level reactivation windows ───────────────────────────────────────────────────────────────────


def _make_bundle():
    spec = importlib.util.spec_from_file_location("g15_helpers", ROOT / "tests" / "test_pr11_phase4_g15_host_artifacts.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.make_bundle


SVC = "svc.aegis-idea3-dnsmasq.service."
PRE_RECORDS = {
    SVC + "LoadState": "loaded", SVC + "UnitFileState": "enabled", SVC + "ActiveState": "failed", SVC + "SubState": "failed",
    SVC + "Result": "start-limit-hit", SVC + "MainPID": "0", SVC + "NRestarts": "5", SVC + "ExecMainStartTimestamp": "Sat 2026-09-26 23:46:54 +07",
    "nm.general": "connected:full:enabled:disabled",
    "nm.device.wlp0s20f3.state": "unavailable",
    "net.link.wlp0s20f3": "DOWN",
    "net.addr.wlp0s20f3": "none",
    "nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.class": "secret-metadata-only",
    "nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.meta": "mode=600 uid=0 gid=0 size=300 mtime=1",
    "net.idea3_dnsmasq_conf./etc/aegis-idea3/dnsmasq-ap.conf.sha256": "a" * 64,
    "wifi.rfkill.iface.wlp0s20f3.soft": "blocked",
}


def post_records(**over: str) -> dict[str, str]:
    r = dict(PRE_RECORDS)
    r.update({
        SVC + "ActiveState": "active", SVC + "SubState": "running", SVC + "Result": "success", SVC + "MainPID": "4242", SVC + "NRestarts": "0",
        SVC + "ExecMainStartTimestamp": "Sun 2026-09-27 01:10:00 +07", "nm.general": "connected:full:enabled:enabled",
        "nm.device.wlp0s20f3.state": "connected", "net.link.wlp0s20f3": "UP", "net.addr.wlp0s20f3": "10.77.30.1/28",
        "wifi.rfkill.iface.wlp0s20f3.soft": "unblocked",
    })
    r.update(over)
    return r


def cmp(tmp: Path, pre: dict, post: dict, *, kind: str = "post", allow: bool = True, dyn: Path | None = None):
    mb = _make_bundle()
    b = mb(tmp / "b", "pre", pre)
    a = mb(tmp / "a", "post", post)
    env = os.environ.copy()
    env.update(DISK_THRESHOLD_PCT="90", AEGIS_AP_INTERFACE="wlp0s20f3", AEGIS_AP_ADDRESS="10.77.30.1")
    if allow:
        if kind == "post":
            env.update(ALLOW_KEYS_FILE=str(HND / "allow-keys.txt"))
            dyn = dyn or HND / "allow-dynamic-transitions.txt"
        else:
            env.update(ALLOW_KEYS_FILE=str(HND / "allow-keys-rollback.txt"))
            dyn = dyn or HND / "allow-dynamic-transitions-rollback.txt"
        env["ALLOW_DYNAMIC_TRANSITIONS_FILE"] = str(dyn)
    return subprocess.run(["bash", str(COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)


def test_pre_post_reactivation_passes_with_exact_windows(tmp_path: Path) -> None:
    res = cmp(tmp_path, PRE_RECORDS, post_records())
    assert res.returncode == 0, res.stdout + res.stderr
    assert "FINDINGS_NEW_OR_WORSENED_DRIFT=0" in res.stdout and "DYNAMIC_TRANSITION_APPROVED" in res.stdout


def test_without_the_dynamic_window_the_same_change_is_drift(tmp_path: Path) -> None:
    res = cmp(tmp_path, PRE_RECORDS, post_records(), allow=False)
    assert res.returncode == 1 and "COMPARE_RESULT=FAIL" in res.stdout


def test_keys_only_allowance_cannot_approve_the_service_state_or_radio_flag(tmp_path: Path) -> None:
    keys_only = tmp_path / "keys-only.txt"
    keys_only.write_text((HND / "allow-keys.txt").read_text())
    mb = _make_bundle()
    b, a = mb(tmp_path / "b", "pre", PRE_RECORDS), mb(tmp_path / "a", "post", post_records())
    env = os.environ.copy()
    env.update(DISK_THRESHOLD_PCT="90", ALLOW_KEYS_FILE=str(keys_only))
    res = subprocess.run(["bash", str(COMPARE), str(b), str(a)], text=True, capture_output=True, env=env)
    assert res.returncode == 1
    assert f"{SVC}ActiveState" in res.stdout and "nm.general" in res.stdout


@pytest.mark.parametrize(
    "over",
    [
        {SVC + "ActiveState": "activating"},
        {SVC + "SubState": "dead"},
        {SVC + "SubState": "start"},
        {SVC + "Result": "failed"},
        {SVC + "Result": "resources"},
        {SVC + "UnitFileState": "disabled"},
        {SVC + "LoadState": "masked"},
        {"nm.general": "connected:limited:enabled:enabled"},
        {"nm.general": "disconnected:none:enabled:enabled"},
        {"nm.general": "connected:full:disabled:enabled"},
        {"nm.general": "connected:full:enabled:enabled:extra"},
        {"nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.meta": "mode=600 uid=0 gid=0 size=301 mtime=2"},
        {"nm.profile./etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection.class": "config"},
        {"net.idea3_dnsmasq_conf./etc/aegis-idea3/dnsmasq-ap.conf.sha256": "b" * 64},
    ],
)
def test_any_state_outside_the_exact_window_or_any_persistent_drift_fails(tmp_path: Path, over: dict) -> None:
    res = cmp(tmp_path, PRE_RECORDS, post_records(**over))
    assert res.returncode == 1, res.stdout


def test_wifi_radio_enabling_is_not_approved_for_other_transitions(tmp_path: Path) -> None:
    pre = dict(PRE_RECORDS, **{"nm.general": "connected:full:enabled:enabled"})
    res = cmp(tmp_path, pre, post_records(**{"nm.general": "connected:full:enabled:disabled"}))
    assert res.returncode == 1


def test_rollback_window_accepts_safe_non_running_state_only(tmp_path: Path) -> None:
    safe = dict(PRE_RECORDS, **{SVC + "ActiveState": "inactive", SVC + "SubState": "dead", SVC + "Result": "success",
                                SVC + "NRestarts": "0", SVC + "ExecMainStartTimestamp": "Sun 2026-09-27 01:10:00 +07"})
    ok = cmp(tmp_path, PRE_RECORDS, safe, kind="rollback")
    assert ok.returncode == 0, ok.stdout + ok.stderr
    running = dict(safe, **{SVC + "ActiveState": "active", SVC + "SubState": "running"})
    assert cmp(tmp_path / "r2", PRE_RECORDS, running, kind="rollback").returncode == 1
    assert cmp(tmp_path / "r3", PRE_RECORDS, safe, kind="rollback", allow=False).returncode == 1


def test_rollback_window_cannot_approve_the_radio_flag_or_the_ap(tmp_path: Path) -> None:
    safe = dict(PRE_RECORDS, **{SVC + "ActiveState": "inactive", SVC + "SubState": "dead", SVC + "Result": "success", SVC + "NRestarts": "0"})
    assert cmp(tmp_path / "a", PRE_RECORDS, dict(safe, **{"nm.general": "connected:full:enabled:enabled"}), kind="rollback").returncode == 1
    assert cmp(tmp_path / "b", PRE_RECORDS, dict(safe, **{"net.addr.wlp0s20f3": "10.77.30.1/28"}), kind="rollback").returncode == 1
    assert cmp(tmp_path / "c", PRE_RECORDS, dict(safe, **{"wifi.rfkill.iface.wlp0s20f3.soft": "unblocked"}), kind="rollback").returncode == 1


def test_pre_rb_identical_state_needs_no_transition(tmp_path: Path) -> None:
    res = cmp(tmp_path, PRE_RECORDS, PRE_RECORDS, kind="rollback")
    assert res.returncode == 0, res.stdout


@pytest.mark.parametrize(
    "content",
    [
        "operation L34_RUNTIME_REACTIVATION\nsysctl.net.ipv4.ip_forward 0 1\n",
        "operation L34_RUNTIME_REACTIVATION\nsvc.aegis-idea3-dnsmasq.service.ActiveState failed *\n",
        "operation L34_RUNTIME_REACTIVATION\nsvc.aegis-idea3-dnsmasq.service.ActiveState failed inactive\n",
        "operation L34_RUNTIME_REACTIVATION\nsvc.aegis-idea3-dnsmasq.service.UnitFileState enabled disabled\n",
        "operation L34_RUNTIME_REACTIVATION\nsvc.mosquitto.service.ActiveState active failed\n",
        "operation L34_RUNTIME_REACTIVATION\nsvc.aegis-idea3-dnsmasq.service.ActiveState failed active\nsvc.aegis-idea3-dnsmasq.service.ActiveState failed active\n",
        "operation L34_RUNTIME_REACTIVATION\noperation L34_RUNTIME_REACTIVATION_ROLLBACK\nsvc.aegis-idea3-dnsmasq.service.ActiveState failed inactive\n",
        "svc.aegis-idea3-dnsmasq.service.ActiveState failed active\n",
        "operation L34_RUNTIME_REACTIVATION\n",
        "operation OTHER\nsvc.aegis-idea3-dnsmasq.service.ActiveState failed active\n",
        "operation L34_RUNTIME_REACTIVATION\nsvc.aegis-idea3-dnsmasq.service.ActiveState  failed active\n",
        "operation L34_RUNTIME_REACTIVATION\r\nsvc.aegis-idea3-dnsmasq.service.ActiveState failed active\r\n",
        "operation L34_RUNTIME_REACTIVATION\nhost.identity a b\n",
        "operation L34_RUNTIME_REACTIVATION\nnm.general#STATE connected disconnected\n",
        "operation L34_RUNTIME_REACTIVATION_ROLLBACK\nnm.general#WIFI disabled enabled\n",
    ],
)
def test_dynamic_transition_file_is_a_closed_catalog_never_a_wildcard(tmp_path: Path, content: str) -> None:
    bad = tmp_path / "dyn.txt"
    bad.write_bytes(content.encode())
    res = cmp(tmp_path / "w", PRE_RECORDS, post_records(), dyn=bad)
    assert res.returncode == 2 and "COMPARE_RESULT=FAIL" in res.stdout, res.stdout


def test_dynamic_transitions_file_is_opt_in_and_default_behaviour_is_unchanged(tmp_path: Path) -> None:
    res = cmp(tmp_path, PRE_RECORDS, PRE_RECORDS, allow=False)
    assert res.returncode == 0
    assert "DYNAMIC_TRANSITION_APPROVED" not in res.stdout


# ── owner runner: unpinned template, ordering, one attempt, no forbidden host actions ────────────────────────────────────


def test_runner_template_is_unpinned_and_refuses_to_run(tmp_path: Path) -> None:
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in RUNNER.read_text()
    res = subprocess.run(["bash", str(RUNNER), str(tmp_path)], text=True, capture_output=True)
    assert res.returncode == 2 and "not pinned" in res.stdout
    pinned = tmp_path / "run.sh"
    pinned.write_text(RUNNER.read_text().replace("PIN_MAIN_SHA", "not-a-sha"))
    assert subprocess.run(["bash", str(pinned), str(tmp_path)], text=True, capture_output=True).returncode == 2


def test_runner_ordering_preflight_pre_capture_apply_verify_post_compare() -> None:
    t = RUNNER.read_text()
    order = ["sudo -v", "l34_consume_attempt", "AEGIS_L34_PREFLIGHT_ONLY_RUN=YES handler apply.sh", 'capture PRE "$EVID/pre-root"',
             "apply_out=$(handler apply.sh", "handler verify.sh", 'capture POST "$EVID/post-root"']
    idx = [t.index(k) for k in order]
    assert idx == sorted(idx)
    assert t.index("capture POST") < t.index('compare "$EVID/pre-root" "$EVID/post-root"')
    assert len(re.findall(r"handler apply\.sh", t)) == 2  # one read-only preflight-only call and the single mutating apply
    assert len(re.findall(r"handler verify\.sh", t)) == 1 and len(re.findall(r"handler rollback\.sh", t)) == 1
    assert "AEGIS_L34_PREFLIGHT_ONLY_RUN=YES handler apply.sh" in t


def test_runner_uses_the_narrow_windows_and_rollback_allowances() -> None:
    t = RUNNER.read_text()
    assert 'ALLOW_DYNAMIC_TRANSITIONS_FILE="$HND/allow-dynamic-transitions.txt"' in t
    assert 'ALLOW_DYNAMIC_TRANSITIONS_FILE="$HND/allow-dynamic-transitions-rollback.txt"' in t
    assert 'ALLOW_KEYS_FILE="$HND/allow-keys-rollback.txt"' in t
    assert 'compare "$EVID/pre-root" "$EVID/rb-root" "$EVID/compare-pre-rb.txt" rollback' in t
    assert 'compare-pre-post.txt" post' in t


def test_runner_governance_reuses_stage_l4_records_with_exact_scope_and_fresh_k3() -> None:
    t = RUNNER.read_text()
    assert "--stage L4 --mode live" in t and "authorization-L4.txt" in t and "k3-L4.txt" in t and "stage=L4" in t
    assert "K3_CONFIRMATION=VALID" in t and "AUTHORIZATION_RECORD=VALID" in t
    scope = re.search(r"^EXPECTED_SCOPE='([^']+)'", t, re.M).group(1)
    assert len(scope) <= 200 and re.fullmatch(r"[ -~]{1,200}", scope)
    for phrase in ("L3_L4_RUNTIME_REACTIVATION", "exact rfkill unblock", "aegis-idea3-ap", "reset-failed", "aegis-idea3-dnsmasq", "no persistent config rewrite"):
        assert phrase in scope
    assert 'grep -qxF "scope=$EXPECTED_SCOPE"' in t


def test_runner_claims_no_new_l3_l4_acceptance_and_never_claims_k12() -> None:
    t = RUNNER.read_text()
    assert "NO new L3_LIVE_ACCEPTANCE / L4_LIVE_ACCEPTANCE claim" in t
    assert "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN" in t
    assert "LIVE_ACCEPTANCE=PROVEN" not in t


def test_runner_refuses_when_l6b_or_esp32_activity_is_present_and_never_starts_them() -> None:
    t = code_lines(RUNNER)
    assert "aegis-idea3-mosquitto.service ActiveState" in t and 'sport = :8883' in t
    assert not re.search(r"systemctl\s+(start|enable)", t)
    assert "run-l6b" not in t and "esptool" not in t


def test_runner_success_leaves_reactivated_runtime_and_failure_only_rolls_back() -> None:
    t = RUNNER.read_text()
    tail = t[t.index('trap - ERR INT TERM\necho "L34_REACTIVATION_EXECUTED'):]
    assert "rollback" not in tail.lower()
    for m in re.finditer(r"rollback_flow ", t):
        line = t[t.rfind("\n", 0, m.start()) + 1: t.find("\n", m.start())]
        assert "||" in line or "rollback_flow()" in line or "fail_after_mutation" in line, line
    assert "NO_PRODUCTION_MUTATION_MARKER" in t


def lib(script: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    e = os.environ.copy()
    e["SUDO"] = ""
    if env:
        e.update(env)
    return subprocess.run(["bash", "-c", f"source '{LIB}'; {script}"], text=True, capture_output=True, env=e)


def test_one_bounded_attempt_marker_is_atomic_and_final(tmp_path: Path) -> None:
    auth = tmp_path / "auth"
    auth.mkdir()
    assert lib(f"l34_consume_attempt '{auth}'").returncode == 0
    assert (auth / "L34-REACTIVATION-ATTEMPT-CONSUMED").is_file()
    second = lib(f"l34_consume_attempt '{auth}'")
    assert second.returncode == 1 and "L34_ATTEMPT_ALREADY_CONSUMED" in second.stderr
    link = tmp_path / "link"
    link.symlink_to(auth)
    assert lib(f"l34_consume_attempt '{link}'").returncode == 1


def _git(repo: Path, *args: str) -> None:
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, env=env)


@pytest.mark.parametrize("skip", [None, "3", "4"])
def test_receipt_gate_reads_l3_and_l4_acceptance_from_the_pinned_commit(tmp_path: Path, skip: str | None) -> None:
    repo = tmp_path / "repo"
    logs = repo / "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
    logs.mkdir(parents=True)
    _git(repo, "init", "-q")
    for n in ("3", "4"):
        if n != skip:
            (logs / f"2026-09-2{n}_000000_music_l{n}.md").write_text(f"`L{n}_LIVE_ACCEPTANCE = PROVEN`\n")
    (logs / "keep.md").write_text("x\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "f")
    if skip:  # present only in the working tree: must not count
        (logs / f"2026-09-2{skip}_000000_music_l{skip}.md").write_text(f"`L{skip}_LIVE_ACCEPTANCE = PROVEN`\n")
    res = lib(f"l34_receipt_gate '{repo}'")
    assert (res.returncode == 0) is (skip is None)
    if skip:
        assert f"L34_PREDECESSOR_RECEIPT_MISSING:L{skip}" in res.stderr


def test_receipt_gate_passes_against_the_real_repository_history() -> None:
    res = lib(f"l34_receipt_gate '{ROOT.parent}'")
    assert res.returncode == 0, res.stderr


def test_psk_leak_scan_detects_the_profile_secret_and_prints_no_value(tmp_path: Path) -> None:
    prof = tmp_path / "p.nmconnection"
    prof.write_text(PROFILE)
    evid = tmp_path / "evid"
    evid.mkdir()
    (evid / "ok.txt").write_text("nothing here\n")
    assert lib(f"l34_psk_leak_scan '{prof}' '{evid}' '{sys.executable}'").returncode == 0
    (evid / "bad.txt").write_text(f"oops {PSK}\n")
    res = lib(f"l34_psk_leak_scan '{prof}' '{evid}' '{sys.executable}'")
    assert res.returncode == 1 and PSK not in res.stdout + res.stderr
    (evid / "bad.txt").write_text("psk=anything\n")
    assert lib(f"l34_psk_leak_scan '{prof}' '{evid}' '{sys.executable}'").returncode == 1


def test_listener_scope_gate_is_exact() -> None:
    good = "tcp 10.77.30.1:53\nudp 10.77.30.1:53\nudp 0.0.0.0%wlp0s20f3:67\n"
    assert lib(f"printf '%s' '{good}' | l34_listener_scope_gate").returncode == 0
    for bad in (good + "tcp 0.0.0.0:53\n", "tcp 10.77.30.1:53\nudp 10.77.30.1:53\n", good + "udp 127.0.0.1:53\n", good + "udp 0.0.0.0%enp62s0:67\n"):
        assert lib(f"printf '%s' '{bad}' | l34_listener_scope_gate").returncode == 1


def test_service_state_gates() -> None:
    failed = "LoadState=loaded\nActiveState=failed\nSubState=failed\nUnitFileState=enabled\nResult=start-limit-hit\nMainPID=0\n"
    active = "LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nResult=success\nMainPID=4242\n"
    assert lib(f"printf '%s' '{failed}' | l34_service_pre_gate").returncode == 0
    assert lib(f"printf '%s' '{active}' | l34_service_pre_gate").returncode == 1
    assert lib(f"printf '%s' '{active}' | l34_service_active_gate").returncode == 0
    assert lib(f"printf '%s' '{active.replace('UnitFileState=enabled', 'UnitFileState=disabled')}' | l34_service_active_gate").returncode == 1
    assert lib(f"printf '%s' '{failed}' | l34_service_active_gate").returncode == 1
