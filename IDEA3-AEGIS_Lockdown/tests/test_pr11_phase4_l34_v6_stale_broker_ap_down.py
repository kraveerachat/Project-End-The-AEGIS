# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L3/L4 STALE-BROKER / AP-DOWN runtime reactivation (V6). Simulated host only.

Baseline STALE_BROKER_AP_DOWN: the L6b broker is ALREADY active/running and stable, holding the exact stale 8883 pair
(127.0.0.1:8883 + 10.77.30.1:8883) while the AP address is absent and aegis-idea3-dnsmasq.service is cleanly inactive/dead.
V6 brings the AP up, starts dnsmasq (one plain start, no reset-failed), runs ONE handshake-only TLS probe through the unchanged
p4-l7-broker-probe.py, soaks 6 x 5 s, and NEVER commands the broker — it only proves the broker tuple equals PRE.
Every handler runs against stub commands driven by tests/l34_sim.py; nothing here touches a radio, NetworkManager or a service.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l34_sim as sim  # noqa: E402
import test_pr11_phase4_l34_reactivation as base  # noqa: E402

ROOT = base.ROOT
DEPLOY = base.DEPLOY
HND = DEPLOY / "reactivation" / "l34-v6-stale-broker-ap-down"
APPLY, VERIFY, ROLLBACK = (HND / n for n in ("apply.sh", "verify.sh", "rollback.sh"))
LIB = base.LIB
RUNNER = DEPLOY / "owner-run" / "run-l34-v6-stale-broker-ap-down-owner.sh"
ALLOW_KEYS, ALLOW_LISTENERS = HND / "allow-keys.txt", HND / "allow-listeners.txt"
DNSMASQ_UNIT = "aegis-idea3-dnsmasq.service"
BROKER_UNIT = "aegis-idea3-mosquitto.service"
BROKER_CONF_REL = "etc/aegis-idea3/mqtt/aegis-idea3-mosquitto.conf"
V6_MARKER = "# ── V6 (STALE-BROKER / AP-DOWN) reactivation"
PROBE_ARGS = "tls --address 10.77.30.1 --port 8883 --server-name mqtt.aegis.home.arpa --ca-file /etc/aegis-idea3/mqtt/ca.crt --repo-root"

V6_BASELINE = dict(
    rfkill_soft=0, nm_software_radio=True, p2p_present=True, wpa_active=True, wpa_pid=9251,
    dnsmasq="inactive", dev_autoconnect="yes", ap_profile_autoconnect="no",
    identities={**sim.DEFAULT_STATE["identities"], BROKER_UNIT: [5100, 3]},
)

PROBE_FIXTURE = """#!/usr/bin/env bash
echo "PROBE $*" >> "$AEGIS_L34_SIM_DIR/calls.log"
case "$(cat "$0.mode")" in
  pass) echo "L7_BROKER_TLS_PROBE=PASS tls=TLSv1.3" ;;
  tls12) echo "L7_BROKER_TLS_PROBE=PASS tls=TLSv1.2" ;;
  old) echo "L7_BROKER_TLS_PROBE=PASS tls=TLSv1.1" ;;
  garbage) echo "hello" ;;
  fail) echo "L7_BROKER_TLS_PROBE=FAIL reason=TLS_VERIFY_FAILED"; exit 1 ;;
  slow) exec sleep 30 ;;
esac
"""


def v6(tmp: Path, probe: str = "pass", **over) -> base.Fx:
    fx = base.build(tmp, **{**V6_BASELINE, **over})
    bconf = fx.file(BROKER_CONF_REL)
    bconf.parent.mkdir(parents=True, exist_ok=True)
    bconf.write_text("# AEGIS IDEA3 L6b broker config — TEMPLATE, NOT DEPLOYED.\nlisteners 8883\n")
    bconf.chmod(0o640)
    probe_path = tmp / "probe-fixture.sh"
    probe_path.write_text(PROBE_FIXTURE)
    probe_path.chmod(0o755)
    Path(f"{probe_path}.mode").write_text(probe)
    fx.probe = probe_path  # type: ignore[attr-defined]
    return fx


def run(fx: base.Fx, script: Path, **extra: str):
    env = dict(
        AEGIS_L34_V6_STABLE_INTERVAL="0.01", AEGIS_L34_V6_SOAK_INTERVAL="0.01", AEGIS_L34_V6_TRIES="3", AEGIS_L34_V6_INTERVAL="0.01",
        AEGIS_L34_V6_PROBE_CMD=str(fx.probe), AEGIS_L34_V6_PROBE_TIMEOUT="20",  # type: ignore[attr-defined]
    )
    env.update(extra)
    return fx.run(script, **env)


def applied(fx: base.Fx):
    res = run(fx, APPLY)
    assert res.returncode == 0, res.stdout + res.stderr
    return res


def code(path: Path) -> str:
    return base.code_lines(path)


def lib_v6() -> str:
    return LIB.read_text().split(V6_MARKER, 1)[1]


def broker_commands(fx: base.Fx) -> list[str]:
    """Every recorded call that targets the broker unit other than a read-only `systemctl show`."""
    return [c for c in fx.calls() if "aegis-idea3-mosquitto" in c and not c.startswith("systemctl show")]


def journal_kinds(fx: base.Fx) -> list[str]:
    return [l.split("\t")[0] for l in (fx.work / "journal.tsv").read_text().splitlines() if l]


def no_mutation(fx: base.Fx) -> None:
    assert fx.mutating_calls() == [], fx.mutating_calls()
    assert not (fx.work / "production-mutation").exists()


ALL_SCRIPTS = [APPLY, VERIFY, ROLLBACK, RUNNER]

# ── 1. static contract ───────────────────────────────────────────────────────────────────────────────────────────────────


def test_v6_files_exist_executable_and_syntactically_valid() -> None:
    for name in ("apply.sh", "verify.sh", "rollback.sh", "allow-keys.txt", "allow-listeners.txt"):
        assert (HND / name).is_file(), name
    for script in (*ALL_SCRIPTS, LIB):
        assert subprocess.run(["bash", "-n", str(script)], capture_output=True).returncode == 0, script
    for script in ALL_SCRIPTS:
        assert script.stat().st_mode & 0o111, script


BROKER_VERBS = r"(start|stop|restart|reload|reload-or-restart|try-restart|try-reload-or-restart|condrestart|reset-failed|kill|enable|disable|mask|unmask|isolate|clean|freeze|thaw|revert|edit|set-property)"


@pytest.mark.parametrize("target", [*ALL_SCRIPTS, "LIB_V6"], ids=lambda t: t if isinstance(t, str) else t.name)
def test_v6_never_issues_any_broker_control_command(target) -> None:
    text = "\n".join(l for l in lib_v6().splitlines() if not l.lstrip().startswith("#")) if target == "LIB_V6" else code(target)
    assert not re.search(rf"systemctl\s+{BROKER_VERBS}\b[^\n]*(mosquitto|BROKER_UNIT)", text, re.I)
    assert not re.search(rf"systemctl\s+{BROKER_VERBS}\s+\"?\$\{{?(BROKER_UNIT|L34_V6_BROKER_UNIT)", text)
    assert not re.search(r"\b(pkill|killall|kill)\b", text)
    assert not re.search(r"\bmosquitto(_pub|_sub|_passwd)?\s", text)
    assert "openssl" not in text and "mosquitto_pub" not in text and "paho" not in text


def test_v6_systemctl_verbs_are_only_show_and_the_dnsmasq_start_stop_reset() -> None:
    seen: set[tuple[str, str]] = set()
    for script in ALL_SCRIPTS:
        for m in re.finditer(r"\bsystemctl\s+([a-z][a-z-]*)\s+(\"?\$\{?\w*UNIT\w*\}?\"?|[\w.-]+\.service)", code(script)):
            seen.add((script.name, f"{m.group(1)} {m.group(2).strip(chr(34))}"))
    for name, cmd in seen:
        verb, arg = cmd.split(" ", 1)
        if verb == "show":
            continue
        assert (name, verb, arg) in {
            ("apply.sh", "start", "$DNSMASQ_UNIT"),
            ("rollback.sh", "stop", "$DNSMASQ_UNIT"),
            ("rollback.sh", "reset-failed", "$DNSMASQ_UNIT"),
        }, (name, cmd)


def test_v6_reset_failed_exists_only_in_rollback_and_only_for_the_exact_dnsmasq_unit() -> None:
    for script in (APPLY, VERIFY, RUNNER):
        assert "reset-failed" not in code(script), script.name
    assert "reset-failed" not in "\n".join(l for l in lib_v6().splitlines() if not l.lstrip().startswith("#"))
    rb = code(ROLLBACK)
    assert len(re.findall(r"systemctl reset-failed", rb)) == 1
    assert 'systemctl reset-failed "$DNSMASQ_UNIT"' in rb
    assert 'DNSMASQ_UNIT=$L34_UNIT' in rb and L34_UNIT_IS_DEDICATED()
    # guarded: only inside the DNSMASQ_START branch and only when the exact unit reports failed
    assert re.search(r'if \[ "\$j_start" = 1 \]; then.*?if \[ "\$\(dnsmasq_state\)" = failed \]; then\s+systemctl reset-failed', rb, re.S)
    for script in ALL_SCRIPTS:
        assert not re.search(r"(?<![-\w])dnsmasq\.service", code(script)), script.name  # never the generic unit


def L34_UNIT_IS_DEDICATED() -> bool:
    return "L34_UNIT=aegis-idea3-dnsmasq.service" in LIB.read_text()


def test_v6_journal_kinds_are_exactly_the_four_and_there_is_no_reset_failed_kind() -> None:
    kinds_written = re.findall(r"^journal\s+([A-Z_]+)\s", code(APPLY), re.M)
    assert kinds_written == ["NM_DEVICE_AUTOCONNECT_DISABLE", "NM_UP", "NM_DEVICE_AUTOCONNECT_RESTORED", "DNSMASQ_START"]
    kinds_read = re.findall(r"^\s+([A-Z_]+)\)\s+\[", code(ROLLBACK), re.M)
    assert sorted(kinds_read) == sorted(["DNSMASQ_START", "NM_UP", "NM_DEVICE_AUTOCONNECT_DISABLE", "NM_DEVICE_AUTOCONNECT_RESTORED"])
    for script in ALL_SCRIPTS:
        assert "DNSMASQ_RESET_FAILED" not in code(script), script.name


def test_v6_tls_probe_is_the_unchanged_probe_script_and_never_openssl_or_loopback() -> None:
    v6lib = lib_v6()
    assert "p4-l7-broker-probe.py" in v6lib
    assert "openssl" not in v6lib.lower() and "s_client" not in v6lib
    fn = v6lib.split("l34_v6_tls_probe() {", 1)[1].split("\n}\n", 1)[0]
    assert '--address "$L34_AP_ADDR"' in fn and '--port 8883' in fn and '--server-name "$L34_BROKER_HOST"' in fn
    assert '--ca-file "$L34_V6_CA_FILE"' in fn and "L34_V6_CA_FILE=/etc/aegis-idea3/mqtt/ca.crt" in v6lib
    assert "127.0.0.1" not in fn and "localhost" not in fn
    assert "timeout" in fn
    for script in ALL_SCRIPTS:
        assert "openssl" not in script.read_text().lower(), script.name
    assert len(re.findall(r"l34_v6_tls_probe \"", code(APPLY))) == 1  # exactly one call site (the failure reason is read from that single run)


def test_v6_probe_override_and_timing_knobs_are_fixture_only() -> None:
    apply = code(APPLY)
    assert re.search(r'if \[ -n "\$ROOT" \]; then.*?L34_V6_PROBE_CMD="\$\{AEGIS_L34_V6_PROBE_CMD:-\}".*?else\s+L34_V6_PROBE_CMD=""\s+fi', apply, re.S)
    verify = code(VERIFY)
    assert "SOAK_SAMPLES=$L34_V6_SOAK_SAMPLES" in verify and "L34_V6_SOAK_SAMPLES=6" in LIB.read_text()
    assert re.search(r'SOAK_INTERVAL=5\s+if \[ -n "\$ROOT" \]; then SOAK_INTERVAL="\$\{AEGIS_L34_V6_SOAK_INTERVAL:-5\}"; fi', verify)
    assert "STABLE_INTERVAL=5" in apply and "L34_V6_STABLE_SAMPLES=3" in LIB.read_text()


def test_v6_never_mutates_rfkill_or_the_global_radio_or_touches_other_handlers() -> None:
    for script in (APPLY, VERIFY, ROLLBACK, RUNNER):
        text = code(script)
        assert not re.search(r"\brfkill\s+(un)?block\b", text)
        assert not re.search(r"nmcli\s+radio\s+wifi\s+(on|off)", text)
        assert "reactivation/l34/" not in text and "reactivation/l34-v4" not in text and "reactivation/l34-v5" not in text
        assert "run-l7-owner" not in text and "stages/L7" not in text and "esptool" not in text and "/dev/tty" not in text
        assert "RESTORE_UPLINK" not in text


def test_v6_scope_string_and_marker_are_distinct_and_the_runner_is_unpinned_by_default() -> None:
    text = RUNNER.read_text()
    assert "L3_L4_RUNTIME_REACTIVATION_V6_STALE_BROKER_AP_DOWN" in text
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text and "runner is not pinned" in text
    assert "L34-V6-REACTIVATION-ATTEMPT-CONSUMED" in text
    assert "L34-V5-REACTIVATION-ATTEMPT-CONSUMED" not in text and "L34-V4-REACTIVATION-ATTEMPT-CONSUMED" not in text
    assert "L3_LIVE_ACCEPTANCE=PROVEN" not in code(APPLY) + code(RUNNER)
    assert "L6B_LIVE_ACCEPTANCE=PROVEN" not in code(APPLY) + code(RUNNER)


def test_v6_allow_files_approve_only_the_dnsmasq_footprint_and_never_the_broker() -> None:
    keys = [l for l in ALLOW_KEYS.read_text().splitlines() if l and not l.startswith("#")]
    assert not [k for k in keys if "mosquitto" in k], keys
    assert sorted(k for k in keys if k.startswith("svc.")) == sorted(
        f"svc.{DNSMASQ_UNIT}.{f}" for f in ("ActiveState", "SubState", "MainPID", "ExecMainStartTimestamp"))
    assert not [k for k in keys if k.startswith("nm.profile") or k.startswith("fw.")]
    assert not [k for k in keys if "*" in k]
    listeners = [l for l in ALLOW_LISTENERS.read_text().splitlines() if l and not l.startswith("#")]
    assert sorted(listeners) == sorted([
        "listen.udp.0.0.0.0%<AEGIS_AP_INTERFACE>:67", "listen.tcp.<AEGIS_AP_ADDRESS>:53", "listen.udp.<AEGIS_AP_ADDRESS>:53"])
    assert not [l for l in listeners if "8883" in l or "1883" in l]


# ── 2. baseline acceptance / rejection ───────────────────────────────────────────────────────────────────────────────────


def test_v6_baseline_accepted_with_the_exact_mutation_set_and_order(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    before = fx.persistent_state()
    res = applied(fx)
    assert "L34_V6_APPLY=PASS" in res.stdout and "REACTIVATION_TYPE=RUNTIME_ONLY" in res.stdout
    assert "BROKER_CONTROL_COMMAND_ISSUED=NO" in res.stdout and "BROKER_TUPLE_EQUALS_PRE=YES" in res.stdout
    assert fx.mutating_calls() == [
        "nmcli device set wlp0s20f3 autoconnect no",
        "nmcli connection up aegis-idea3-ap ifname wlp0s20f3",
        "nmcli device set wlp0s20f3 autoconnect yes",
        "systemctl start aegis-idea3-dnsmasq.service",
    ]
    assert not [c for c in fx.calls() if "reset-failed" in c], "the normal path never issues reset-failed"
    assert journal_kinds(fx) == ["NM_DEVICE_AUTOCONNECT_DISABLE", "NM_UP", "NM_DEVICE_AUTOCONNECT_RESTORED", "DNSMASQ_START"]
    assert broker_commands(fx) == []
    s = fx.state()
    assert s["ap_active"] == 1 and s["dnsmasq"] == "active" and s["dev_autoconnect"] == "yes"
    assert fx.persistent_state() == before
    assert (fx.work / "production-mutation").read_text().strip() == "YES"


def test_v6_apply_ordering_probe_after_dnsmasq_and_tuple_check_after_probe(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    calls = fx.calls()
    idx = lambda pred: next(i for i, c in enumerate(calls) if pred(c))
    i_dis = idx(lambda c: c == "nmcli device set wlp0s20f3 autoconnect no")
    i_up = idx(lambda c: c.startswith("nmcli connection up"))
    i_res = idx(lambda c: c == "nmcli device set wlp0s20f3 autoconnect yes")
    i_start = idx(lambda c: c == "systemctl start aegis-idea3-dnsmasq.service")
    probes = [i for i, c in enumerate(calls) if c.startswith("PROBE ")]
    assert len(probes) == 1
    assert i_dis < i_up < i_res < i_start < probes[0]
    assert any(c.startswith("ss ") for c in calls[i_start:probes[0]]), "dnsmasq/broker polls happen before the probe"
    assert any(c.startswith("systemctl show -p InvocationID --value") and c.endswith(BROKER_UNIT) for c in calls[probes[0]:]), \
        "the broker tuple equality check runs after the probe"
    mark = (fx.work / "production-mutation").stat().st_mtime_ns  # written before the first mutation, inside the handler
    assert mark > 0
    assert calls.index("PROBE " + calls[probes[0]][6:]) == probes[0]
    assert calls[probes[0]].startswith("PROBE " + PROBE_ARGS)
    assert not any("127.0.0.1" in c for c in calls if c.startswith("PROBE "))


def test_v6_refuses_the_v3_baseline(tmp_path: Path) -> None:
    fx = v6(tmp_path, rfkill_soft=1, nm_software_radio=False, p2p_present=False, wpa_active=False, dnsmasq="failed")
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V4_RFKILL_NOT_READY" in res.stderr
    no_mutation(fx)


def test_v6_refuses_the_v3_baseline_even_when_rfkill_is_unblocked(tmp_path: Path) -> None:
    fx = v6(tmp_path, nm_software_radio=False, p2p_present=False, wpa_active=False, dnsmasq="failed")
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V4_BASELINE_UNRECOGNIZED:NM_RADIO_NOT_ENABLED" in res.stderr
    no_mutation(fx)


def test_v6_refuses_the_healthy_v4_baseline(tmp_path: Path) -> None:
    fx = v6(tmp_path, dnsmasq="active")
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED:ActiveState" in res.stderr
    no_mutation(fx)


def test_v6_refuses_the_v5_crashloop_baseline(tmp_path: Path) -> None:
    fx = v6(tmp_path, dnsmasq="failed", broker_mode="crashloop_until_ap")
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED:ActiveState" in res.stderr
    no_mutation(fx)
    fx2 = v6(tmp_path / "b", dnsmasq="inactive", broker_mode="crashloop_until_ap")
    res2 = run(fx2, APPLY)
    assert res2.returncode == 1 and "L34_V4_SERVICE_NOT_READY:aegis-idea3-mosquitto.service:ActiveState" in res2.stderr
    no_mutation(fx2)


REJECTIONS = [
    ("dnsmasq_failed", dict(dnsmasq="failed"), "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED:ActiveState"),
    ("dnsmasq_disabled", dict(dnsmasq_props_override={"UnitFileState": "disabled"}), "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED:UnitFileState"),
    ("dnsmasq_result", dict(dnsmasq_props_override={"Result": "exit-code"}), "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED:Result"),
    ("dnsmasq_mainpid", dict(dnsmasq_props_override={"MainPID": "77"}), "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED:MainPID"),
    ("dnsmasq_substate", dict(dnsmasq_props_override={"SubState": "exited"}), "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED:SubState"),
    ("dnsmasq_notfound", dict(dnsmasq_props_override={"LoadState": "not-found"}), "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED:LoadState"),
    ("tcp53_listener", dict(stray_ap_listeners=["tcp53"]), "L34_V6_AP_DNS_DHCP_LISTENER_PRESENT"),
    ("udp53_listener", dict(stray_ap_listeners=["udp53"]), "L34_V6_AP_DNS_DHCP_LISTENER_PRESENT"),
    ("udp67_listener", dict(stray_ap_listeners=["udp67"]), "L34_V6_AP_DNS_DHCP_LISTENER_PRESENT"),
    ("ap_address_elsewhere", dict(foreign_ap_addr=True), "L34_V6_AP_ADDRESS_PRESENT"),
    ("ap_route_present", dict(ap_route_present=True), "L34_V6_AP_ROUTE_PRESENT"),
    ("ap_already_up", dict(ap_active=1), "L34_AP_ALREADY_ACTIVE"),
    ("rfkill_blocked", dict(rfkill_soft=1), "L34_V4_RFKILL_NOT_READY"),
    ("radio_disabled", dict(nm_software_radio=False), "L34_V4_BASELINE_UNRECOGNIZED:NM_RADIO_NOT_ENABLED"),
    ("second_wifi_device", dict(extra_wifi_device=True), "L34_WIFI_TOPOLOGY_NOT_SOLE_DEVICE"),
    ("second_wlan_rfkill", dict(extra_rfkill_wlan=True), "L34_WIFI_TOPOLOGY_RFKILL_WLAN_COUNT"),
    ("wifi_already_active", dict(other_wifi_active=True), "L34_WIFI_ACTIVE_CONNECTION_PRESENT"),
    ("device_autoconnect_no", dict(dev_autoconnect="no"), "L34_V4_AUTOCONNECT_UNEXPECTED:DEVICE=no"),
    ("profile_autoconnect_yes", dict(ap_profile_autoconnect="yes"), "L34_V4_AUTOCONNECT_UNEXPECTED:AP_PROFILE=yes"),
    ("forwarding_on", dict(sysctl_override={"net.ipv4.ip_forward": 1}), "L34_FORWARDING_NOT_ZERO:net.ipv4.ip_forward"),
    ("ap_forwarding_on", dict(sysctl_override={"net.ipv4.conf.wlp0s20f3.forwarding": 1}), "L34_FORWARDING_NOT_ZERO"),
    ("nat_present", dict(nft_ruleset_extra="table ip nat {\n chain post { type nat hook postrouting priority 100; masquerade }\n}\n"),
     "L2_RUNTIME_NOT_READY=YES:NAT_DETECTED"),
    ("pf01_missing", dict(nft=sim.NFT_GOOD.replace('\t\tiifname "wlp0s20f3" tcp dport 1883 drop\n', "")), "PF01_1883_DROP_MISSING"),
    ("no_alternate_default", dict(alt_default=False), "L34_NO_ALTERNATE_DEFAULT_ROUTE"),
    ("dnsmasq_syntax", dict(dnsmasq_syntax_ok=False), "DNSMASQ_CONFIG_SYNTAX_FAIL"),
    ("broker_absent", dict(identities={**sim.DEFAULT_STATE["identities"], BROKER_UNIT: [0, 0]}),
     "L34_V4_SERVICE_NOT_READY:aegis-idea3-mosquitto.service"),
    ("pair_missing_loopback", dict(broker_pair_missing="loopback"), "L34_V4_BROKER_LISTENERS_INVALID"),
    ("pair_missing_ap", dict(broker_pair_missing="ap"), "L34_V4_BROKER_LISTENERS_INVALID"),
    ("pair_extra_wildcard", dict(broker_listener_extra=["LISTEN 0 100 0.0.0.0:8883 0.0.0.0:*"]), "L34_V4_BROKER_LISTENERS_INVALID"),
    ("pair_extra_other_ip", dict(broker_listener_extra=["LISTEN 0 100 192.168.1.144:8883 0.0.0.0:*"]), "L34_V4_BROKER_LISTENERS_INVALID"),
]


@pytest.mark.parametrize(("over", "reason"), [(o, r) for _, o, r in REJECTIONS], ids=[n for n, _, _ in REJECTIONS])
def test_v6_pre_contract_rejections_mutate_nothing(tmp_path: Path, over: dict, reason: str) -> None:
    fx = v6(tmp_path, **over)
    res = run(fx, APPLY)
    assert res.returncode == 1 and reason in res.stderr, res.stdout + res.stderr
    no_mutation(fx)
    assert broker_commands(fx) == []


@pytest.mark.parametrize("field", ["MainPID", "NRestarts", "InvocationID"])
def test_v6_unstable_broker_tuple_is_refused_before_any_mutation(tmp_path: Path, field: str) -> None:
    fx = v6(tmp_path, broker_mutate={"field": field, "trigger": "shows:4"})
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V6_BROKER_TUPLE_UNSTABLE" in res.stderr, res.stdout + res.stderr
    no_mutation(fx)
    assert broker_commands(fx) == []


def test_v6_broker_tuple_is_sampled_three_times_before_any_mutation(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    calls = fx.calls()
    first_mut = next(i for i, c in enumerate(calls) if base.MUTATING.match(c))
    pre_reads = [c for c in calls[:first_mut] if c.startswith("systemctl show -p InvocationID --value") and c.endswith(BROKER_UNIT)]
    assert len(pre_reads) == 3
    assert (fx.work / "broker-tuple-pre.txt").read_text().splitlines()[0].startswith("MainPID=5100")


def test_v6_preflight_only_mode_mutates_nothing_and_records_the_pre_tuple(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    res = run(fx, APPLY, AEGIS_L34_PREFLIGHT_ONLY="YES")
    assert res.returncode == 0 and "L34_V6_PREFLIGHT=PASS" in res.stdout and "PRODUCTION_MUTATION_PERFORMED=NO" in res.stdout
    no_mutation(fx)
    assert (fx.work / "broker-tuple-pre.txt").is_file() and (fx.work / "legacy-1883-pre.txt").is_file()


def test_v6_live_mode_refuses_without_the_explicit_authorization_flag(tmp_path: Path) -> None:
    env = {"PATH": "/usr/bin:/bin", "AEGIS_L34_WORK_DIR": str(tmp_path / "w")}
    res = subprocess.run(["bash", str(APPLY)], text=True, capture_output=True, env=env, check=False)
    assert res.returncode == 1 and "LIVE_AUTHORIZATION_FLAG_REQUIRED" in res.stderr
    assert not (tmp_path / "w").exists()


# ── 3. failure paths + rollback ──────────────────────────────────────────────────────────────────────────────────────────


def test_v6_tls_probe_pass_variants_and_arguments(tmp_path: Path) -> None:
    for i, mode in enumerate(("pass", "tls12")):
        fx = v6(tmp_path / str(i), probe=mode)
        applied(fx)
        probes = [c for c in fx.calls() if c.startswith("PROBE ")]
        assert len(probes) == 1 and probes[0].startswith("PROBE " + PROBE_ARGS)
        assert (fx.work / "tls-probe.txt").read_text().strip().startswith("L7_BROKER_TLS_PROBE=PASS tls=TLSv1.")


@pytest.mark.parametrize(("mode", "reason"), [
    ("fail", "L34_V6_TLS_PROBE_FAILED:TLS_VERIFY_FAILED"),
    ("old", "L34_V6_TLS_PROBE_NOT_PASS"),
    ("garbage", "L34_V6_TLS_PROBE_NOT_PASS"),
    ("slow", "L34_V6_TLS_PROBE_TIMEOUT"),
])
def test_v6_tls_probe_failures_are_one_probe_only_and_roll_back_cleanly(tmp_path: Path, mode: str, reason: str) -> None:
    fx = v6(tmp_path, probe=mode)
    res = run(fx, APPLY, AEGIS_L34_V6_PROBE_TIMEOUT="1")
    assert res.returncode == 1 and reason in res.stderr, res.stdout + res.stderr
    assert len([c for c in fx.calls() if c.startswith("PROBE ")]) == 1, "the probe is never retried nor re-run to read its reason"
    assert (fx.work / "production-mutation").exists()
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0 and "L34_V6_ROLLBACK=PASS" in rb.stdout, rb.stdout + rb.stderr
    assert broker_commands(fx) == []


def test_v6_dnsmasq_start_failure_rolls_back_with_one_exact_unit_reset_failed(tmp_path: Path) -> None:
    fx = v6(tmp_path, dnsmasq_start_works=False)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "DNSMASQ" in res.stderr or "L34_DNSMASQ_NOT_ACTIVE_RUNNING" in res.stderr, res.stdout + res.stderr
    n_apply = len(fx.calls())
    assert not [c for c in fx.calls() if "reset-failed" in c], "apply never issues reset-failed"
    assert fx.state()["dnsmasq"] == "failed"
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0 and "L34_V6_ROLLBACK=PASS" in rb.stdout, rb.stdout + rb.stderr
    resets = [c for c in fx.calls()[n_apply:] if "reset-failed" in c]
    assert resets == ["systemctl reset-failed aegis-idea3-dnsmasq.service"]
    s = fx.state()
    assert s["dnsmasq"] == "inactive" and s["ap_active"] == 0 and s["dev_autoconnect"] == "yes"
    assert broker_commands(fx) == []


def test_v6_dnsmasq_start_command_failure_also_rolls_back(tmp_path: Path) -> None:
    fx = v6(tmp_path, dnsmasq_start_fails_rc=True)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "DNSMASQ_SERVICE_START_FAILED" in res.stderr
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    assert len([c for c in fx.calls() if c.startswith("systemctl reset-failed")]) == 1
    assert fx.state()["dnsmasq"] == "inactive"


def test_v6_rollback_after_success_stops_dnsmasq_without_reset_failed(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    n = len(fx.calls())
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0 and "L34_V6_ROLLBACK=PASS" in rb.stdout, rb.stdout + rb.stderr
    after = fx.calls()[n:]
    assert "systemctl stop aegis-idea3-dnsmasq.service" in after
    assert not [c for c in after if "reset-failed" in c]
    assert "nmcli connection down aegis-idea3-ap" in after
    s = fx.state()
    assert s["ap_active"] == 0 and s["dnsmasq"] == "inactive" and s["dev_autoconnect"] == "yes" and s["rfkill_soft"] == 0
    assert [c for c in after if c.startswith(("rfkill", "iw reg")) or "radio wifi" in c and "on" in c.split()] == []
    assert broker_commands(fx) == []
    assert "BROKER_CONTROL_COMMAND_ISSUED=NO" in rb.stdout and "BROKER_TUPLE_EQUALS_PRE=YES" in rb.stdout


def test_v6_rollback_twice_is_idempotent(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    first = run(fx, ROLLBACK)
    state_after_first = fx.state()
    second = run(fx, ROLLBACK)
    assert first.returncode == 0 and second.returncode == 0, second.stdout + second.stderr
    assert fx.state() == state_after_first
    assert len([c for c in fx.calls() if c == "systemctl stop aegis-idea3-dnsmasq.service"]) == 1
    assert len([c for c in fx.calls() if c == "nmcli connection down aegis-idea3-ap"]) == 1
    assert broker_commands(fx) == []


def test_v6_reset_failed_is_not_issued_when_dnsmasq_start_was_never_journaled(tmp_path: Path) -> None:
    fx = v6(tmp_path, nm_activation_works=False)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "NMCLI_UP_FAILED" in res.stderr
    assert "DNSMASQ_START" not in journal_kinds(fx)
    fx.set(dnsmasq="failed")  # an unrelated failure of the dedicated unit: NOT this run's to clean up
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED:ActiveState" in rb.stderr
    assert not [c for c in fx.calls() if "reset-failed" in c or c.startswith("systemctl stop")]


def test_v6_early_apply_failure_restores_device_autoconnect_on_rollback(tmp_path: Path) -> None:
    fx = v6(tmp_path, nm_activation_works=False)
    res = run(fx, APPLY)
    assert res.returncode == 1
    assert fx.state()["dev_autoconnect"] == "no"
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0, rb.stdout + rb.stderr
    assert fx.state()["dev_autoconnect"] == "yes"


def test_v6_broker_change_after_ap_up_fails_apply_and_holds_rollback_without_repairing(tmp_path: Path) -> None:
    for i, field in enumerate(("MainPID", "NRestarts", "InvocationID")):
        fx = v6(tmp_path / str(i), broker_mutate={"field": field, "trigger": "ap_active"})
        res = run(fx, APPLY)
        assert res.returncode == 1 and "L34_V6_BROKER_TUPLE_CHANGED" in res.stderr, res.stdout + res.stderr
        rb = run(fx, ROLLBACK)
        assert rb.returncode == 1 and "S11_HOLD_ESCALATE:BROKER_NOT_PRESERVED" in rb.stderr and "L34_V6_BROKER_TUPLE_CHANGED" in rb.stderr
        assert broker_commands(fx) == [], "S-11 HOLD: the broker is never repaired"
        assert fx.state()["ap_active"] == 0, "everything V6 owns was still rolled back before the HOLD"


@pytest.mark.parametrize("missing", ["loopback", "ap"])
def test_v6_rollback_holds_when_the_stale_pair_is_no_longer_preserved(tmp_path: Path, missing: str) -> None:
    fx = v6(tmp_path)
    applied(fx)
    fx.set(broker_pair_missing=missing)
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "S11_HOLD_ESCALATE:BROKER_NOT_PRESERVED" in rb.stderr and "L34_V4_BROKER_LISTENERS_INVALID" in rb.stderr
    assert broker_commands(fx) == []


def test_v6_rollback_holds_when_the_broker_is_no_longer_active(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    fx.set(identities={**sim.DEFAULT_STATE["identities"], BROKER_UNIT: [0, 3]})
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "S11_HOLD_ESCALATE" in rb.stderr
    assert broker_commands(fx) == []


def test_v6_unrelated_wifi_profile_during_rollback_escalates(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    fx.set(other_wifi_active=True)
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "UNRELATED_WIFI_ACTIVATED_DURING_ROLLBACK=YES:ESCALATE_TO_OWNER" in rb.stderr
    assert not [c for c in fx.calls() if c.startswith("nmcli connection down") and c != "nmcli connection down aegis-idea3-ap"]


def test_v6_rollback_refuses_an_unknown_or_foreign_journal_entry(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    with (fx.work / "journal.tsv").open("a") as fh:
        fh.write("BROKER_RESTART\taegis-idea3-mosquitto.service\n")
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "JOURNAL_ENTRY_UNKNOWN" in rb.stderr
    with (fx.work / "journal.tsv").open("w") as fh:
        fh.write("DNSMASQ_START\tdnsmasq.service\n")
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "JOURNAL_ENTRY_NOT_OWNED" in rb.stderr
    assert not [c for c in fx.calls() if c.startswith("systemctl stop") or "reset-failed" in c]


# ── 4. legacy :1883 preservation ─────────────────────────────────────────────────────────────────────────────────────────


def test_v6_legacy_1883_exists_at_pre_and_is_preserved_byte_identical_through_post_and_rollback(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    pre = (fx.work / "legacy-1883-pre.txt").read_text()
    assert "0.0.0.0:1883" in pre and "[::]:1883" in pre, "the sim host has a legacy plaintext mosquitto at PRE"
    ver = run(fx, VERIFY)
    assert ver.returncode == 0 and "LEGACY_MOSQUITTO_1883_TWINGATE_IDEA2=UNCHANGED" in ver.stdout, ver.stdout + ver.stderr
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 0 and "LEGACY_1883_UNCHANGED=YES" in rb.stdout
    assert (fx.work / "legacy-1883-pre.txt").read_text() == pre
    assert not [c for c in fx.calls() if "1883" in c and c.startswith(("systemctl", "nft", "sysctl"))]


def test_v6_a_changed_legacy_1883_listener_fails_apply_and_rollback(tmp_path: Path) -> None:
    fx = v6(tmp_path, legacy_1883_mutate=True)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V6_LEGACY_1883_CHANGED" in res.stderr
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "L34_V6_LEGACY_1883_CHANGED" in rb.stderr


def test_v6_a_new_plaintext_1883_listener_on_the_ap_is_refused(tmp_path: Path) -> None:
    fx = v6(tmp_path, new_1883_on_ap=True)
    res = run(fx, APPLY)
    assert res.returncode == 1 and "L34_V6_PLAINTEXT_1883_ON_AP" in res.stderr
    rb = run(fx, ROLLBACK)
    assert rb.returncode == 1 and "L34_V6_PLAINTEXT_1883_ON_AP" in rb.stderr


# ── 5. verify + soak ─────────────────────────────────────────────────────────────────────────────────────────────────────


def test_v6_verify_passes_and_soaks_six_samples(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    n = len(fx.calls())
    ver = run(fx, VERIFY)
    assert ver.returncode == 0 and "L34_V6_VERIFY=PASS" in ver.stdout, ver.stdout + ver.stderr
    assert re.findall(r"^L34_V6_SOAK_SAMPLE=(\d) PASS$", ver.stdout, re.M) == ["1", "2", "3", "4", "5", "6"]
    assert "L34_V6_SOAK=PASS SAMPLES=6" in ver.stdout
    assert "BROKER_CONTROL_COMMAND_ISSUED=NO" in ver.stdout and "TUPLE_EQUALS_PRE=YES" in ver.stdout
    after = fx.calls()[n:]
    assert fx.mutating_calls() == fx.mutating_calls()[:4], "verify is read-only"
    assert len([c for c in after if c == "iw dev wlp0s20f3 info"]) >= 7, "AP gate once up front and once per soak sample"
    assert len([c for c in after if c.startswith("systemctl show -p InvocationID --value") and c.endswith(BROKER_UNIT)]) >= 7
    assert broker_commands(fx) == []


def test_v6_verify_requires_the_pre_baseline_files(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    res = run(fx, VERIFY)
    assert res.returncode == 1 and "WORK_DIR_MISSING" in res.stderr


def test_v6_verify_detects_a_broker_change(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    fx.set(broker_mutate={"field": "InvocationID", "trigger": "ap_active"})
    ver = run(fx, VERIFY)
    assert ver.returncode == 1 and "L34_V6_BROKER_TUPLE_CHANGED" in ver.stderr


@pytest.mark.parametrize(("state", "reason"), [
    (dict(ap_default_route=True), "L34_AP_INTERFACE_HAS_DEFAULT_ROUTE"),
    (dict(active_channel=11), "L34_AP_CHANNEL_MISMATCH"),
    (dict(broker_pair_missing="ap"), "L34_V4_BROKER_LISTENERS_INVALID"),
    (dict(dnsmasq="inactive"), "L34_DNSMASQ_NOT_ACTIVE_RUNNING"),
    (dict(nm_software_radio=False), "L34_RADIO_STATE_CHANGED"),
])
def test_v6_verify_rejects_post_state_deviations(tmp_path: Path, state: dict, reason: str) -> None:
    fx = v6(tmp_path)
    applied(fx)
    fx.set(**state)
    ver = run(fx, VERIFY)
    assert ver.returncode == 1 and reason in ver.stderr, ver.stdout + ver.stderr
    assert broker_commands(fx) == []


def test_v6_soak_fails_when_the_broker_drifts_mid_soak(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    applied(fx)
    n0 = len([c for c in fx.calls() if c.startswith("systemctl show") and c.endswith(BROKER_UNIT)])
    # the single-check phase reads the broker 4 times and every soak sample 4 more; drift from the third sample on
    fx.set(broker_mutate={"field": "MainPID", "trigger": f"shows:{n0 + 4 + 8}"})
    ver = run(fx, VERIFY)
    assert ver.returncode == 1 and "L34_V6_SOAK_FAILED:sample=3:L34_V6_BROKER_TUPLE_CHANGED" in ver.stderr, ver.stdout + ver.stderr
    assert re.findall(r"^L34_V6_SOAK_SAMPLE=(\d) PASS$", ver.stdout, re.M) == ["1", "2"]
    assert "L34_V6_SOAK=PASS" not in ver.stdout


def test_v6_verify_is_idempotent_and_never_prints_secrets(tmp_path: Path) -> None:
    fx = v6(tmp_path)
    a = applied(fx)
    v1, v2 = run(fx, VERIFY), run(fx, VERIFY)
    assert v1.returncode == 0 and v2.returncode == 0
    for out in (a.stdout + a.stderr, v1.stdout + v1.stderr):
        assert base.PSK not in out
