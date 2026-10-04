"""AEGIS IDEA3 PR11 Phase 4 — PRE-L8p NTP RUNTIME REACTIVATION: lib + apply/verify/rollback handler tests (simulated host).

The REAL, unmodified handler scripts run inside a sandbox where systemctl, ip, ss, id and the L5 clock helper are stateful stubs and /etc/chrony.conf is a file inside the
sandbox (only the three host-path/ownership constants of the library copy are substituted). Nothing here touches the host, systemd, a serial port, a device or MQTT.
The owner-run control flow is covered by test_pr11_phase4_pre_l8p_ntp_reactivation_owner_run_flow.py.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
PKG = "pre-l8p-ntp-runtime-reactivation"
HND_SRC = DEPLOY / "reactivation" / PKG
LIB_SRC = DEPLOY / "p4-ntp-reactivation-lib.sh"
RUNNER_SRC = DEPLOY / "owner-run" / "run-pre-l8p-ntp-runtime-reactivation-owner.sh"
L5_DIR = DEPLOY / "stages" / "L5"

CLOCK_OK = "state=SYNCED reason=OK maxerror_us=74000 adjtimex_ret=0 status=0x2001 sta_unsync=0 time_error=0"
TS, CH = "systemd-timesyncd.service", "chronyd.service"

SYSTEMCTL = r'''#!/usr/bin/env bash
U="$SIM_DIR/units"
case "$1" in
  show)
    shift; keys=(); val=0; unit=""
    while [ $# -gt 0 ]; do case "$1" in -p) keys+=("$2"); shift 2 ;; --value) val=1; shift ;; *) unit=$1; shift ;; esac; done
    for k in "${keys[@]}"; do
      v=$(cat "$U/$unit/$k" 2>/dev/null || true)
      if [ "$val" = 1 ]; then printf '%s\n' "$v"; else printf '%s=%s\n' "$k" "$v"; fi
    done ;;
  stop|start)
    verb=$1; unit=$2
    echo "$verb $unit" >> "$SIM_DIR/calls.log"
    echo "marker@$verb:$unit:$([ -e "$AEGIS_NTPREACT_WORK_DIR/production-mutation" ] && echo yes || echo no)" >> "$SIM_DIR/calls.log"
    [ ! -e "$SIM_DIR/fail-$verb-$unit" ] || exit 1
    set_state() { printf '%s\n' "$2" > "$U/$unit/ActiveState"; printf '%s\n' "$3" > "$U/$unit/SubState"; }
    case "$verb $unit" in
      "stop systemd-timesyncd.service") set_state x inactive dead ;;
      "start systemd-timesyncd.service") set_state x active running ;;
      "stop chronyd.service") set_state x inactive dead; : > "$SIM_DIR/listeners" ;;
      "start chronyd.service")
        set_state x active running
        if [ -e "$SIM_DIR/wildcard-listener" ]; then printf 'udp 0.0.0.0:123\n' > "$SIM_DIR/listeners"
        elif [ -e "$SIM_DIR/other-listener" ]; then printf 'udp 10.77.30.99:123\n' > "$SIM_DIR/listeners"
        elif [ -e "$SIM_DIR/tcp-listener" ]; then printf 'tcp 10.77.30.1:123\n' > "$SIM_DIR/listeners"
        elif [ -e "$SIM_DIR/no-listener" ]; then : > "$SIM_DIR/listeners"
        elif [ -e "$SIM_DIR/dup-listener" ]; then printf 'udp 10.77.30.1:123\nudp 10.77.30.1:123\n' > "$SIM_DIR/listeners"
        else printf 'udp 10.77.30.1:123\nudp 127.0.0.1:323\nudp [::1]:323\n' > "$SIM_DIR/listeners"; fi
        [ ! -e "$SIM_DIR/hook-after-start" ] || bash "$SIM_DIR/hook-after-start" ;;
    esac ;;
  *) echo "FORBIDDEN systemctl $*" >> "$SIM_DIR/calls.log"; exit 99 ;;
esac
'''
SS = '#!/usr/bin/env bash\nwhile read -r p a; do [ -n "$a" ] && printf \'%s UNCONN 0 0 %s 0.0.0.0:*\\n\' "$p" "$a"; done < "$SIM_DIR/listeners"\n'
IP = '#!/usr/bin/env bash\nwhile read -r a; do [ -n "$a" ] && printf \'3: wlp0s20f3    inet %s brd 10.77.30.15 scope global wlp0s20f3\\n\' "$a"; done < "$SIM_DIR/ap-addrs"\n'
ID = '#!/usr/bin/env bash\nif [ "$#" = 1 ] && [ "$1" = -u ]; then echo 0; else exec /usr/bin/id "$@"; fi\n'
PY = r'''#!/usr/bin/env bash
case "${1:-}" in
  */p4-l5-clock.py)
    echo "clock:$2" >> "$SIM_DIR/calls.log"
    case "$2" in
      probe) cat "$SIM_DIR/clock-line"; exit "$(cat "$SIM_DIR/clock-rc")" ;;
      wait) if [ -e "$SIM_DIR/fail-wait" ]; then echo "L5_CLOCK_READY=NO reason=KERNEL_UNSYNCED waited_s=60.00"; exit 1; fi
            echo "L5_CLOCK_READY=YES reason=OK waited_s=0.01" ;;
    esac ;;
  *) exec "$REAL_PYTHON" "$@" ;;
esac
'''


def render_approved_conf(out: Path) -> Path:
    """The REAL L5 renderer with the approved inputs — the committed SHA-256 constant must equal its output."""
    subprocess.run([sys.executable, str(DEPLOY / "p4-ntp.py"), "render", "--ap-address", "10.77.30.1", "--ap-subnet", "10.77.30.0/28",
                    "--trusted-upstream", "2.arch.pool.ntp.org", "--output-dir", str(out)], check=True, capture_output=True)
    return out / "aegis-idea3-chrony.conf"


class Host:
    def __init__(self, tmp: Path) -> None:
        self.dir = tmp / "host"
        self.p4 = self.dir / "p4"
        self.bin = self.dir / "bin"
        self.work = self.dir / "work"
        self.conf = self.dir / "chrony.conf"
        for d in (self.p4, self.bin):
            d.mkdir(parents=True)
        shutil.copy(render_approved_conf(self.dir / "render"), self.conf)
        self.conf.chmod(0o640)
        st = self.conf.stat()
        lib = LIB_SRC.read_text()
        for old, new in (
            ('NTPREACT_CHRONY_CONF="/etc/chrony.conf"', f'NTPREACT_CHRONY_CONF="{self.conf}"'),
            (f'NTPREACT_CHRONY_CONF_MODE_OWNER="640:0:0"', f'NTPREACT_CHRONY_CONF_MODE_OWNER="640:{st.st_uid}:{st.st_gid}"'),
        ):
            assert old in lib, old
            lib = lib.replace(old, new)
        (self.p4 / "p4-ntp-reactivation-lib.sh").write_text(lib)
        self.hnd = self.p4 / "reactivation" / PKG
        shutil.copytree(HND_SRC, self.hnd)
        for name, text in (("systemctl", SYSTEMCTL), ("ss", SS), ("ip", IP), ("id", ID), ("python3", PY)):
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o755)
        self.baseline()

    # ── sim state ──
    def put(self, unit: str, prop: str, value: str) -> None:
        d = self.dir / "units" / unit
        d.mkdir(parents=True, exist_ok=True)
        (d / prop).write_text(value + "\n")

    def baseline(self) -> None:
        for prop, v in (("LoadState", "loaded"), ("ActiveState", "active"), ("SubState", "running"), ("UnitFileState", "enabled"), ("Result", "success")):
            self.put(TS, prop, v)
        for prop, v in (("LoadState", "loaded"), ("ActiveState", "inactive"), ("SubState", "dead"), ("UnitFileState", "disabled"), ("Result", "success"),
                        ("ExecStart", "{ path=/usr/bin/chronyd ; argv[]=/usr/bin/chronyd -n ; ignore_errors=no ; start_time=[n/a] }"), ("Environment", ""), ("EnvironmentFiles", "")):
            self.put(CH, prop, v)
        (self.dir / "listeners").write_text("")
        (self.dir / "ap-addrs").write_text("10.77.30.1/28\n")
        (self.dir / "clock-line").write_text(CLOCK_OK + "\n")
        (self.dir / "clock-rc").write_text("0\n")

    def flag(self, name: str, text: str = "1") -> None:
        (self.dir / name).write_text(text + "\n")

    def set_listeners(self, *lines: str) -> None:
        (self.dir / "listeners").write_text("".join(f"{x}\n" for x in lines))

    def prop(self, unit: str, key: str) -> str:
        return (self.dir / "units" / unit / key).read_text().strip()

    def calls(self) -> list[str]:
        f = self.dir / "calls.log"
        return f.read_text().splitlines() if f.exists() else []

    def actions(self) -> list[str]:
        return [c for c in self.calls() if c.startswith(("stop ", "start "))]

    def sha(self) -> str:
        return hashlib.sha256(self.conf.read_bytes()).hexdigest()

    def run(self, script: str, preflight: bool = False, **env: str) -> subprocess.CompletedProcess[str]:
        e = dict(os.environ, SIM_DIR=str(self.dir), PATH=f"{self.bin}:{os.environ['PATH']}", REAL_PYTHON=sys.executable,
                 AEGIS_NTPREACT_LIVE_AUTHORIZED="YES", AEGIS_NTPREACT_WORK_DIR=str(self.work), AEGIS_NTPREACT_PREFLIGHT_ONLY="YES" if preflight else "NO",
                 AEGIS_NTPREACT_ROLLBACK_CLOCK_TRIES="2")
        e.update(env)
        return subprocess.run(["bash", str(self.hnd / script)], text=True, capture_output=True, env=e, check=False)

    def applied(self) -> None:
        """Preflight + apply + verify-ready state (the happy path up to a PASS apply)."""
        assert self.run("apply.sh", preflight=True).returncode == 0
        shutil.rmtree(self.work)
        res = self.run("apply.sh")
        assert res.returncode == 0, res.stdout + res.stderr


@pytest.fixture()
def host(tmp_path: Path) -> Host:
    return Host(tmp_path)


def refused(res: subprocess.CompletedProcess[str], needle: str) -> None:
    assert res.returncode == 1 and "NTPREACT_APPLY=FAIL" in res.stderr and needle in res.stderr, res.stdout + res.stderr


# ── the committed constants ────────────────────────────────────────────────────────────────────────────────────────────

def test_approved_conf_sha_constant_is_what_the_l5_renderer_produces(tmp_path: Path) -> None:
    sha = hashlib.sha256(render_approved_conf(tmp_path / "r").read_bytes()).hexdigest()
    assert f'NTPREACT_CHRONY_CONF_SHA256="{sha}"' in LIB_SRC.read_text()
    assert sha == "20e283e4616fadeb3f2ae9438b17e3351b7af354844a911038a47089af3a35fe", "must equal the SHA recorded by the historical L5 live acceptance receipt"


def test_scope_fits_the_stage_gate_limit_and_names_the_task() -> None:
    m = re.search(r'^NTPREACT_EXPECTED_SCOPE="(.*)"$', LIB_SRC.read_text(), re.M)
    assert m and len(m.group(1)) <= 200 and m.group(1).startswith("PRE_L8P_NTP_RUNTIME_REACTIVATION:")


# ── PRE gates (read-only preflight) ────────────────────────────────────────────────────────────────────────────────────

def test_exact_pre_baseline_passes_preflight_without_any_mutation(host: Host) -> None:
    res = host.run("apply.sh", preflight=True)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "NTPREACT_PREFLIGHT=PASS" in res.stdout and "PRODUCTION_MUTATION_PERFORMED=NO" in res.stdout
    assert host.actions() == [] and not (host.work / "production-mutation").exists()
    snap = (host.work / "pre_snapshot").read_text()
    assert f"chrony_conf_sha256={host.sha()}" in snap and "chronyd_unitfilestate=disabled" in snap and "timesyncd_unitfilestate=enabled" in snap


def test_live_authorization_flag_and_root_are_required(host: Host) -> None:
    assert host.run("apply.sh", preflight=True, AEGIS_NTPREACT_LIVE_AUTHORIZED="NO").returncode == 1
    (host.bin / "id").write_text("#!/usr/bin/env bash\necho 1000\n")
    refused(host.run("apply.sh", preflight=True), "ROOT_REQUIRED")
    assert host.actions() == []


def test_chronyd_already_active_refuses(host: Host) -> None:
    host.put(CH, "ActiveState", "active"); host.put(CH, "SubState", "running")
    refused(host.run("apply.sh"), "chronyd.service.ActiveState=active")
    assert host.actions() == [] and not (host.work / "production-mutation").exists()


@pytest.mark.parametrize("unit,prop,value", [
    (TS, "ActiveState", "inactive"), (TS, "ActiveState", "failed"), (TS, "SubState", "start"), (TS, "LoadState", "not-found"),
    (CH, "ActiveState", "failed"), (CH, "SubState", "failed"), (CH, "LoadState", "not-found"), (CH, "Result", "exit-code"),
], ids=lambda v: str(v))
def test_unexpected_runtime_unit_state_refuses(host: Host, unit: str, prop: str, value: str) -> None:
    host.put(unit, prop, value)
    refused(host.run("apply.sh"), "NTPREACT_UNIT_STATE_MISMATCH")
    assert host.actions() == []


@pytest.mark.parametrize("unit,value", [(CH, "enabled"), (CH, "static"), (CH, "masked"), (TS, "disabled"), (TS, "static"), (TS, "masked")])
def test_unexpected_unitfilestate_refuses(host: Host, unit: str, value: str) -> None:
    host.put(unit, "UnitFileState", value)
    refused(host.run("apply.sh"), f"{unit}.UnitFileState={value}")
    assert host.actions() == []


@pytest.mark.parametrize("addrs", [[], ["10.77.30.2/28"], ["10.77.30.1/24"], ["10.77.30.1/28", "192.168.1.5/24"], ["10.77.30.1/29"]])
def test_wrong_or_missing_ap_address_refuses(host: Host, addrs: list[str]) -> None:
    (host.dir / "ap-addrs").write_text("".join(f"{a}\n" for a in addrs))
    refused(host.run("apply.sh"), "NTPREACT_AP_ADDRESS_")
    assert host.actions() == []


def test_other_ap_interface_is_refused(host: Host) -> None:
    refused(host.run("apply.sh", AEGIS_AP_INTERFACE="wlan0"), "TARGET_AP_INTERFACE_MUST_BE_WLP0S20F3")


@pytest.mark.parametrize("mutate", [
    lambda c: c.write_text(c.read_text() + "pool 0.arch.pool.ntp.org iburst\n"),
    lambda c: c.write_text(c.read_text().replace("2.arch.pool.ntp.org", "0.arch.pool.ntp.org")),
    lambda c: c.write_text(c.read_text().replace("allow 10.77.30.0/28", "allow 10.77.0.0/16")),
    lambda c: c.write_text(c.read_text().replace("rtcsync", "")),
    lambda c: c.write_text(c.read_text() + "# a comment still changes the approved bytes\n"),
    lambda c: c.write_text(""),
], ids=["extra-directive", "other-upstream", "wider-allow", "no-rtcsync", "comment-only", "empty"])
def test_wrong_chrony_config_refuses(host: Host, mutate) -> None:
    mutate(host.conf)
    refused(host.run("apply.sh"), "NTPREACT_CHRONY_CONF_")
    assert host.actions() == []


def test_missing_symlinked_or_loose_chrony_config_refuses(host: Host) -> None:
    host.conf.chmod(0o644)
    refused(host.run("apply.sh"), "NTPREACT_CHRONY_CONF_MODE_OWNER_MISMATCH")
    host.conf.chmod(0o640)
    real = host.dir / "real.conf"; shutil.copy(host.conf, real); host.conf.unlink(); host.conf.symlink_to(real)
    refused(host.run("apply.sh"), "NTPREACT_CHRONY_CONF_IS_SYMLINK")
    host.conf.unlink()
    refused(host.run("apply.sh"), "NTPREACT_CHRONY_CONF_MISSING")
    assert host.actions() == []


@pytest.mark.parametrize("prop,value", [
    ("ExecStart", "{ path=/usr/bin/chronyd ; argv[]=/usr/bin/chronyd -n -f /etc/chrony/other.conf ; ignore_errors=no }"),
    ("ExecStart", "{ path=/usr/bin/chronyd ; argv[]=/usr/bin/chronyd -f /tmp/x.conf ; ignore_errors=no }"),
    ("ExecStart", "{ path=/usr/bin/chronyd ; argv[]=/usr/bin/chronyd -f ; ignore_errors=no }"),
    ("Environment", "OPTIONS=-f /tmp/x.conf"),
], ids=["other-file", "tmp-file", "no-path", "environment"])
def test_alternate_chronyd_config_path_refuses(host: Host, prop: str, value: str) -> None:
    host.put(CH, prop, value)
    refused(host.run("apply.sh"), "NTPREACT_CHRONYD_ALTERNATE_CONFIG_PATH")
    assert host.actions() == []


def test_alternate_config_path_in_an_environment_file_refuses_and_the_default_path_is_accepted(host: Host) -> None:
    envf = host.dir / "chronyd.env"
    envf.write_text("OPTIONS=-f /elsewhere.conf\n")
    host.put(CH, "EnvironmentFiles", str(envf))
    refused(host.run("apply.sh", preflight=True), "NTPREACT_CHRONYD_ALTERNATE_CONFIG_PATH")
    envf.write_text(f"OPTIONS=-f {host.conf}\n")  # the sandbox substitutes the constant /etc/chrony.conf
    assert host.run("apply.sh", preflight=True).returncode == 0
    host.put(CH, "ExecStart", "{ path=/usr/bin/chronyd ; argv[]=/usr/bin/chronyd -n -f " + str(host.conf) + " ; ignore_errors=no }")
    shutil.rmtree(host.work)
    assert host.run("apply.sh", preflight=True).returncode == 0


@pytest.mark.parametrize("line", ["udp 0.0.0.0:123", "udp 10.77.30.1:123", "udp [::]:123", "udp *:123", "tcp 10.77.30.1:123", "udp 192.168.1.5:123"])
def test_preexisting_udp_123_listener_refuses(host: Host, line: str) -> None:
    host.set_listeners(line)
    refused(host.run("apply.sh"), "NTPREACT_NTP_LISTENER_PRESENT_BEFORE_APPLY")
    assert host.actions() == []


def test_unrelated_listeners_do_not_block(host: Host) -> None:
    host.set_listeners("tcp 127.0.0.1:8080", "udp 10.77.30.1:67", "udp 0.0.0.0:5353")
    assert host.run("apply.sh", preflight=True).returncode == 0


@pytest.mark.parametrize("line,rc,needle", [
    ("state=UNTRUSTED reason=KERNEL_UNSYNCED maxerror_us=16000000 adjtimex_ret=5", 1, "KERNEL_UNSYNCED"),
    ("state=UNKNOWN reason=PROBE_UNAVAILABLE maxerror_us=-1 adjtimex_ret=UNAVAILABLE", 1, "PROBE_UNAVAILABLE"),
    ("state=UNTRUSTED reason=MAXERROR_EXCEEDED maxerror_us=2000000 adjtimex_ret=0", 1, "MAXERROR_EXCEEDED"),
    ("state=SYNCED reason=OK maxerror_us=2000000 adjtimex_ret=0 status=0x2001 sta_unsync=0 time_error=0", 0, "NTPREACT_MAXERROR_EXCEEDED"),
    ("garbage", 0, "UNPARSEABLE"),
], ids=["unsynced", "unavailable", "maxerror-from-helper", "maxerror-defence-in-depth", "unparseable"])
def test_bad_trusted_clock_refuses(host: Host, line: str, rc: int, needle: str) -> None:
    (host.dir / "clock-line").write_text(line + "\n"); (host.dir / "clock-rc").write_text(f"{rc}\n")
    refused(host.run("apply.sh"), needle)
    assert host.actions() == []


# ── APPLY ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

def test_apply_is_exactly_stop_timesyncd_then_start_chronyd(host: Host) -> None:
    res = host.run("apply.sh")
    assert res.returncode == 0, res.stdout + res.stderr
    assert host.actions() == ["stop systemd-timesyncd.service", "start chronyd.service"]
    assert not [c for c in host.calls() if "FORBIDDEN" in c], "no enable/disable/restart/daemon-reload/mask/reload"
    assert "NTPREACT_APPLY=PASS" in res.stdout and "L5_CLOCK_READY=YES" in res.stdout
    assert (host.dir / "calls.log").read_text().index("clock:wait") > (host.dir / "calls.log").read_text().index("start chronyd.service")


def test_mutation_marker_is_durable_before_the_first_systemctl_action(host: Host) -> None:
    res = host.run("apply.sh")
    assert res.stdout.splitlines().index("PRODUCTION_MUTATION_PERFORMED=YES") >= 0
    assert "marker@stop:systemd-timesyncd.service:yes" in host.calls()
    assert (host.work / "production-mutation").read_text().strip() == "YES"


def test_apply_does_not_touch_the_config_or_unitfilestate(host: Host) -> None:
    before_bytes, before_stat = host.conf.read_bytes(), host.conf.stat()
    assert host.run("apply.sh").returncode == 0
    assert host.conf.read_bytes() == before_bytes
    after = host.conf.stat()
    assert (after.st_mtime_ns, after.st_size, after.st_mode) == (before_stat.st_mtime_ns, before_stat.st_size, before_stat.st_mode)
    assert host.prop(CH, "UnitFileState") == "disabled" and host.prop(TS, "UnitFileState") == "enabled"
    assert sorted(p.name for p in host.dir.iterdir() if p.suffix == ".conf") == ["chrony.conf"], "no config file was written anywhere in the sandbox"


def test_apply_stop_failure_fails_after_marking_the_mutation(host: Host) -> None:
    host.flag(f"fail-stop-{TS}")
    res = host.run("apply.sh")
    assert res.returncode == 1 and "TIMESYNCD_STOP_FAILED" in res.stderr
    assert (host.work / "production-mutation").exists() and host.actions() == ["stop systemd-timesyncd.service"], "chronyd is never started after a failed stop"


def test_apply_start_failure_fails(host: Host) -> None:
    host.flag(f"fail-start-{CH}")
    res = host.run("apply.sh")
    assert res.returncode == 1 and "CHRONYD_START_FAILED" in res.stderr


def test_apply_readiness_timeout_fails(host: Host) -> None:
    host.flag("fail-wait")
    res = host.run("apply.sh")
    assert res.returncode == 1 and "TRUSTEDCLOCK_READINESS_TIMEOUT:KERNEL_UNSYNCED" in res.stderr


def test_apply_refuses_a_reused_work_directory(host: Host) -> None:
    assert host.run("apply.sh", preflight=True).returncode == 0
    res = host.run("apply.sh", preflight=True)
    assert res.returncode == 1 and "WORK_DIR_ALREADY_USED" in res.stderr


# ── VERIFY ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

VERIFY_LINES = ["NTPREACT_VERIFY=PASS", "CHRONYD_ACTIVE=YES", "TIMESYNCD_INACTIVE=YES", "NTP_LISTENER=10.77.30.1:123", "WILDCARD_NTP_LISTENER=NO", "TRUSTEDCLOCK=SYNCED",
                "MAXERROR_WITHIN_L5_BOUND=YES", "CHRONYD_UNITFILESTATE=disabled", "TIMESYNCD_UNITFILESTATE=enabled", "CHRONY_CONF_SHA256_PRE_EQ_POST=YES"]


def test_verify_passes_with_the_exact_listener_and_issues_no_systemctl_action(host: Host) -> None:
    host.applied()
    n = len(host.calls())
    res = host.run("verify.sh")
    assert res.returncode == 0, res.stdout + res.stderr
    for line in VERIFY_LINES:
        assert line in res.stdout.splitlines()
    assert host.calls()[n:] == ["clock:probe"], "verify is read-only: only the clock probe"


@pytest.mark.parametrize("flag,needle", [("wildcard-listener", "WILDCARD_NTP_LISTENER_FORBIDDEN"), ("other-listener", "NON_AP_NTP_LISTENER_FORBIDDEN"),
                                         ("tcp-listener", "TCP_NTP_LISTENER_FORBIDDEN"), ("no-listener", "AP_NTP_LISTENER_MISSING"),
                                         ("dup-listener", "AP_NTP_LISTENER_MISSING_OR_DUPLICATED")])
def test_verify_requires_exactly_the_ap_listener_and_rejects_wildcards(host: Host, flag: str, needle: str) -> None:
    host.flag(flag)
    assert host.run("apply.sh").returncode == 0
    res = host.run("verify.sh")
    assert res.returncode == 1 and needle in res.stderr, res.stdout + res.stderr


def test_verify_rejects_a_wildcard_next_to_the_exact_listener(host: Host) -> None:
    host.applied()
    host.set_listeners("udp 10.77.30.1:123", "udp 0.0.0.0:123", "udp 127.0.0.1:323")
    assert "WILDCARD_NTP_LISTENER_FORBIDDEN" in host.run("verify.sh").stderr


def test_verify_rejects_a_non_loopback_command_port(host: Host) -> None:
    host.applied()
    host.set_listeners("udp 10.77.30.1:123", "udp 0.0.0.0:323")
    assert "NON_LOOPBACK_CONTROL_LISTENER_FORBIDDEN" in host.run("verify.sh").stderr


@pytest.mark.parametrize("unit,value,needle", [(CH, "enabled", "CHRONYD_UNITFILESTATE_CHANGED"), (TS, "disabled", "TIMESYNCD_UNITFILESTATE_CHANGED"),
                                               (CH, "static", "CHRONYD_UNITFILESTATE_CHANGED"), (TS, "masked", "TIMESYNCD_UNITFILESTATE_CHANGED")])
def test_verify_protects_unitfilestate(host: Host, unit: str, value: str, needle: str) -> None:
    host.applied()
    host.put(unit, "UnitFileState", value)
    res = host.run("verify.sh")
    assert res.returncode == 1 and needle in res.stderr


def test_verify_rejects_concurrent_or_dead_time_daemons(host: Host) -> None:
    host.applied()
    host.put(TS, "ActiveState", "active")
    assert "CONCURRENT_TIME_DAEMONS_ACTIVE" in host.run("verify.sh").stderr
    host.put(TS, "ActiveState", "inactive"); host.put(CH, "SubState", "dead")
    assert "CHRONYD_NOT_ACTIVE_RUNNING" in host.run("verify.sh").stderr


def test_verify_rejects_a_changed_config_even_if_the_content_is_still_valid(host: Host) -> None:
    host.applied()
    host.conf.write_text(host.conf.read_text() + "# touched\n")
    assert "NTPREACT_CHRONY_CONF_NOT_APPROVED_L5_CONTENT" not in host.run("verify.sh").stdout
    assert "CHRONY_CONF_SHA256_CHANGED" in host.run("verify.sh").stderr
    host.conf.write_text(host.conf.read_text().replace("# touched\n", ""))
    os.utime(host.conf, ns=(1, 1))
    assert "CHRONY_CONF_METADATA_CHANGED" in host.run("verify.sh").stderr


@pytest.mark.parametrize("line,rc", [("state=UNTRUSTED reason=KERNEL_UNSYNCED maxerror_us=16000000 adjtimex_ret=5", 1),
                                     ("state=SYNCED reason=OK maxerror_us=1000001 adjtimex_ret=0 status=0x2001 sta_unsync=0 time_error=0", 0)])
def test_verify_requires_trustedclock_synced_within_the_l5_bound(host: Host, line: str, rc: int) -> None:
    host.applied()
    (host.dir / "clock-line").write_text(line + "\n"); (host.dir / "clock-rc").write_text(f"{rc}\n")
    res = host.run("verify.sh")
    assert res.returncode == 1 and "NTPREACT_VERIFY=FAIL" in res.stderr


def test_verify_without_a_pre_snapshot_fails_closed(host: Host) -> None:
    host.work.mkdir()
    assert "PRE_SNAPSHOT_MISSING" in host.run("verify.sh").stderr


# ── ROLLBACK ───────────────────────────────────────────────────────────────────────────────────────────────────────────

def exact_runtime_baseline(host: Host) -> None:
    assert (host.prop(TS, "ActiveState"), host.prop(TS, "SubState"), host.prop(TS, "UnitFileState")) == ("active", "running", "enabled")
    assert (host.prop(CH, "ActiveState"), host.prop(CH, "SubState"), host.prop(CH, "UnitFileState")) == ("inactive", "dead", "disabled")
    assert (host.dir / "listeners").read_text().strip() == ""


def test_rollback_restores_the_exact_pre_runtime_baseline_without_touching_config_or_unitfiles(host: Host) -> None:
    before = host.sha()
    host.applied()
    res = host.run("rollback.sh")
    assert res.returncode == 0, res.stdout + res.stderr
    for line in ("NTPREACT_ROLLBACK=PASS", "RUNTIME_BASELINE_RESTORED=YES", "UNITFILESTATE_MUTATION=NO", "CHRONY_CONFIG_MUTATION=NO"):
        assert line in res.stdout.splitlines()
    exact_runtime_baseline(host)
    assert host.sha() == before
    assert host.actions() == ["stop systemd-timesyncd.service", "start chronyd.service", "stop chronyd.service", "start systemd-timesyncd.service"]
    assert not [c for c in host.calls() if "FORBIDDEN" in c]


def test_rollback_after_a_failed_chronyd_start_brings_timesyncd_back(host: Host) -> None:
    host.flag(f"fail-start-{CH}")
    assert host.run("apply.sh").returncode == 1
    assert host.prop(TS, "ActiveState") == "inactive"
    assert host.run("rollback.sh").returncode == 0
    exact_runtime_baseline(host)


def test_rollback_after_a_failed_timesyncd_stop_changes_nothing_it_does_not_need_to(host: Host) -> None:
    host.flag(f"fail-stop-{TS}")
    assert host.run("apply.sh").returncode == 1
    n = len(host.actions())
    assert host.run("rollback.sh").returncode == 0
    assert host.actions()[n:] == [], "chronyd was never started and timesyncd never stopped: rollback issues no action"
    exact_runtime_baseline(host)


def test_rollback_is_idempotent(host: Host) -> None:
    host.applied()
    assert host.run("rollback.sh").returncode == 0
    n = len(host.actions())
    assert host.run("rollback.sh").returncode == 0
    assert host.actions()[n:] == []


def test_rollback_requires_timesyncd_back_and_the_clock_acceptable(host: Host) -> None:
    host.applied()
    host.flag(f"fail-start-{TS}")
    host.put(TS, "ActiveState", "inactive")
    assert "ROLLBACK_TIMESYNCD_START_FAILED" in host.run("rollback.sh").stderr
    (host.dir / f"fail-start-{TS}").unlink()
    (host.dir / "clock-line").write_text("state=UNTRUSTED reason=KERNEL_UNSYNCED maxerror_us=16000000\n"); (host.dir / "clock-rc").write_text("1\n")
    assert "ROLLBACK_TIME_SYNC_FAILED" in host.run("rollback.sh").stderr


def test_rollback_fails_closed_if_chronyd_cannot_be_stopped(host: Host) -> None:
    host.applied()
    host.flag(f"fail-stop-{CH}")
    assert "ROLLBACK_CHRONYD_STILL_ACTIVE" in host.run("rollback.sh").stderr


@pytest.mark.parametrize("unit,value,needle", [(CH, "enabled", "ROLLBACK_CHRONYD_UNITFILESTATE_CHANGED_ESCALATE"), (TS, "disabled", "ROLLBACK_TIMESYNCD_UNITFILESTATE_CHANGED_ESCALATE")])
def test_rollback_proves_but_never_repairs_unitfilestate(host: Host, unit: str, value: str, needle: str) -> None:
    host.applied()
    host.put(unit, "UnitFileState", value)
    assert needle in host.run("rollback.sh").stderr
    assert host.prop(unit, "UnitFileState") == value, "rollback must never alter UnitFileState"


def test_rollback_proves_but_never_rewrites_the_config(host: Host) -> None:
    host.applied()
    host.conf.write_text("tampered\n")
    res = host.run("rollback.sh")
    assert "ROLLBACK_CHRONY_CONF_CHANGED_ESCALATE" in res.stderr and host.conf.read_text() == "tampered\n"


def test_rollback_without_a_pre_snapshot_changes_nothing(host: Host) -> None:
    host.work.mkdir()
    res = host.run("rollback.sh")
    assert res.returncode == 1 and "ROLLBACK_PRE_STATE_UNKNOWN" in res.stderr and host.actions() == []


# ── static scope: no unit-file mutation, no config write, no hardware / device / MQTT / relay path ─────────────────────

PKG_FILES = [LIB_SRC, RUNNER_SRC, HND_SRC / "apply.sh", HND_SRC / "verify.sh", HND_SRC / "rollback.sh"]


def code_of(path: Path) -> str:
    """Executable text: comments and the contents of quoted strings removed, so only bare command words remain."""
    out = []
    for line in path.read_text().splitlines():
        if line.lstrip().startswith("#"):
            continue
        line = re.sub(r"'[^']*'", "''", line)
        line = re.sub(r'"(?:[^"\\]|\\.)*"', '""', line)
        out.append(re.sub(r"\s#\s.*$", "", line))
    return "\n".join(out)


@pytest.mark.parametrize("path,allowed", [(HND_SRC / "apply.sh", {"stop", "start"}), (HND_SRC / "verify.sh", set()), (HND_SRC / "rollback.sh", {"stop", "start"}),
                                          (LIB_SRC, {"show"}), (RUNNER_SRC, {"show"})], ids=lambda v: v.name if isinstance(v, Path) else "")
def test_only_the_approved_systemctl_verbs_appear(path: Path, allowed: set[str]) -> None:
    known = r"show|stop|start|restart|reload|enable|disable|mask|unmask|daemon-reload|reset-failed|kill|set-property|edit|link|preset|isolate|try-restart|is-active|is-enabled"
    verbs = set(re.findall(rf"\bsystemctl\s+({known})\b", code_of(path)))
    assert verbs <= allowed, (path.name, verbs)


def test_apply_contains_exactly_the_two_approved_mutating_commands_in_order() -> None:
    cmds = re.findall(r"\bsystemctl\s+(stop|start)\s+(\S+)", code_of(HND_SRC / "apply.sh"))
    assert cmds == [("stop", "systemd-timesyncd.service"), ("start", "chronyd.service")]


FORBIDDEN_WORDS = r"\b(esptool\S*|pyserial|miniterm\S*|minicom|picocom|screen|stty|mosquitto_pub|mosquitto_sub|mosquitto_passwd|paho\S*|nmcli|nft|iw|rfkill|sysctl|dnsmasq|" \
                  r"chmod|chown|cp|mv|rm|tee|install|truncate|sed\s+-i|ln|systemd-analyze|journalctl|reboot|shutdown|poweroff|twingate|curl|wget|nc|ncat|socat|ssh|scp)\b"


@pytest.mark.parametrize("path", [HND_SRC / "verify.sh", LIB_SRC], ids=lambda p: p.name)
def test_read_only_files_have_no_mutating_or_device_commands(path: Path) -> None:
    hits = re.findall(FORBIDDEN_WORDS, code_of(path))
    assert hits == [], hits


def test_apply_and_rollback_use_no_device_network_mqtt_or_config_write_command() -> None:
    for f in (HND_SRC / "apply.sh", HND_SRC / "rollback.sh"):
        hits = [h for h in re.findall(FORBIDDEN_WORDS, code_of(f)) if h not in ("chmod",)]
        assert hits == [], (f.name, hits)
    for f in (HND_SRC / "apply.sh", HND_SRC / "rollback.sh", HND_SRC / "verify.sh"):
        assert not re.search(r">\s*[\"$]*\{?(NTPREACT_CHRONY_CONF|conf)\b", code_of(f)), f"{f.name} must never redirect into the chrony config"


def test_no_package_file_references_hardware_serial_mqtt_publish_cut_or_restore_commands() -> None:
    for f in PKG_FILES:
        text = code_of(f)
        assert not re.search(r"/dev/tty|/dev/serial|esptool|\bmosquitto_pub\b|paho|\bCUT\b|\bRESTORE\b|p4-l8p-device|p4-l8-device|p4-nvs-provision", text), f.name


def test_runner_never_invokes_other_stage_handlers_or_governed_runners() -> None:
    text = code_of(RUNNER_SRC)
    assert not re.search(r"stages/L[0-9]|owner-run/run-|reactivation/l34|dnsmasq-unit-boot-order-repair", text)


def test_allow_catalog_is_no_wider_than_historical_l5_plus_one_sentinel_key_and_protects_unitfilestate_and_config() -> None:
    def keys(p: Path) -> set[str]:
        return {l.strip() for l in p.read_text().splitlines() if l.strip() and not l.lstrip().startswith("#")}
    mine, l5 = keys(HND_SRC / "allow-keys.txt"), keys(L5_DIR / "allow-keys.txt")
    # The ONE approved widening (post-live forensic fix 2026-10-03): the capture records the sentinel for the inactive timesyncd's fallback set, which the PRE (timesyncd active)
    # capture holds as real data. stages/L5 stays unmodified by contract (test below).
    assert mine - l5 == {"time.timesyncd.FallbackNTPServers"} and mine, mine - l5
    assert not [k for k in mine if k.endswith(".UnitFileState") or "/etc/chrony.conf" in k]
    assert keys(HND_SRC / "allow-listeners.txt") == keys(L5_DIR / "allow-listeners.txt")


def test_l5_stage_handlers_are_unchanged_by_this_package() -> None:
    res = subprocess.run(["git", "diff", "--quiet", "origin/main", "--", str(L5_DIR)], cwd=ROOT, check=False)
    assert res.returncode in (0, 128), "stages/L5 (historical L5 handlers) must not be modified"
