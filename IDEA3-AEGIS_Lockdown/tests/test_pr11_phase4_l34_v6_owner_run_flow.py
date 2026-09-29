# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L34 V6 owner-run CONTROL-FLOW simulation.

The real run-l34-v6-stale-broker-ap-down-owner.sh is executed, unmodified apart from its frozen constants, inside a sandbox: `sudo`,
`systemctl` and friends are stubs, the stage-independent gate functions come from the REAL, unmodified p4-l34-reactivation-lib.sh
(only p4-stage-gate.sh / p4-l0-capture.sh / p4-compare.sh and the handler scripts are stand-ins). This proves the runner's CONSUME ORDER:

    pre-gates -> handler PREFLIGHT_ONLY -> PRE capture + hash verify -> final broker tuple equality -> consume marker -> apply (once)

and that a failure anywhere before the marker changes nothing and does NOT consume the one bounded attempt, while a failure after it
rolls back, leaves the attempt consumed and can never be retried with the same AUTH_DIR.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
RUNNER = DEPLOY / "owner-run" / "run-l34-v6-stale-broker-ap-down-owner.sh"
REAL_LIB = DEPLOY / "p4-l34-reactivation-lib.sh"
HND_NAME = "l34-v6-stale-broker-ap-down"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
TODAY = subprocess.run(["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).stdout.strip()

EXPECTED_SCOPE = (
    "L3_L4_RUNTIME_REACTIVATION_V6_STALE_BROKER_AP_DOWN: one AP up, one dnsmasq start, one TLS handshake probe; no broker control, no nft/forwarding, no IDEA1/IDEA2 change, no MQTT/ESP32/L6c/L7"
)
INVOCATION = "0123456789abcdef0123456789abcdef"
DRIFTED = "fedcba9876543210fedcba9876543210"

DNSMASQ_PROPS = {"LoadState": "loaded", "ActiveState": "inactive", "SubState": "dead", "UnitFileState": "enabled", "Result": "success", "MainPID": "0"}
BROKER_PROPS = {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "enabled", "Result": "success",
                "MainPID": "5100", "NRestarts": "3"}
HEALTHY = {"ActiveState": "active", "SubState": "running"}

STUB_NOOP_CMDS = ("rfkill", "nmcli", "iw", "ip", "nft", "sysctl", "ss", "dnsmasq")

# Behaviour flags are plain files in $SIM_DIR so each test can flip exactly one failure.
HANDLER = r'''#!/usr/bin/env bash
name=$(basename "$0" .sh)
marker=NO; [ -e "$SIM_MARKER" ] && marker=YES
mkdir -p "$AEGIS_L34_WORK_DIR"
tuple() { printf 'MainPID=5100\nNRestarts=3\nInvocationID=%s\n' "$1"; }
case "$name" in
  apply)
    if [ "${AEGIS_L34_PREFLIGHT_ONLY:-NO}" = YES ]; then
      echo "apply:preflight marker=$marker" >> "$SIM_DIR/calls.log"
      [ ! -e "$SIM_DIR/preflight-fail" ] || { echo "preflight failed" >&2; exit 1; }
      tuple 0123456789abcdef0123456789abcdef > "$AEGIS_L34_WORK_DIR/broker-tuple-pre.txt"
      echo "L34_V6_PREFLIGHT=PASS"; exit 0
    fi
    echo "apply:full marker=$marker" >> "$SIM_DIR/calls.log"
    if [ -e "$SIM_DIR/apply-tuple-differs" ]; then tuple fedcba9876543210fedcba9876543210 > "$AEGIS_L34_WORK_DIR/broker-tuple-pre.txt"
    else tuple 0123456789abcdef0123456789abcdef > "$AEGIS_L34_WORK_DIR/broker-tuple-pre.txt"; fi
    echo YES > "$AEGIS_L34_WORK_DIR/production-mutation"
    [ ! -e "$SIM_DIR/apply-fail" ] || { echo "apply failed" >&2; exit 1; }
    echo "L34_V6_APPLY=PASS" ;;
  verify)
    echo "verify" >> "$SIM_DIR/calls.log"
    [ ! -e "$SIM_DIR/verify-fail" ] || { echo "verify failed" >&2; exit 1; }
    echo "L34_V6_VERIFY=PASS"
    [ -e "$SIM_DIR/soak-missing" ] || echo "L34_V6_SOAK=PASS SAMPLES=6 INTERVAL_S=5" ;;
  rollback)
    echo "rollback" >> "$SIM_DIR/calls.log"
    [ ! -e "$SIM_DIR/rollback-fail" ] || { echo "rollback failed" >&2; exit 1; }
    echo "L34_V6_ROLLBACK=PASS" ;;
esac
'''

CAPTURE = r'''#!/usr/bin/env bash
marker=NO; [ -e "$SIM_MARKER" ] && marker=YES
echo "capture:$CAPTURE_LABEL marker=$marker" >> "$SIM_DIR/calls.log"
if [ "$CAPTURE_LABEL" = pre ] && [ -e "$SIM_DIR/capture-pre-fail" ]; then exit 1; fi
mkdir -p "$EVID_DIR"
echo "L0_CAPTURE=COMPLETE" > "$EVID_DIR/capture.log"
(cd "$EVID_DIR" && sha256sum capture.log > SHA256SUMS)
if [ "$CAPTURE_LABEL" = pre ] && [ -e "$SIM_DIR/drift-after-pre-capture" ]; then touch "$SIM_DIR/drifted"; fi
exit 0
'''

COMPARE = r'''#!/usr/bin/env bash
echo "compare" >> "$SIM_DIR/calls.log"
# compare-fail fails only the FIRST comparison (PRE->POST); the rollback comparison (PRE->RB) then passes
if [ -e "$SIM_DIR/compare-fail" ] && [ ! -e "$SIM_DIR/compare-failed-once" ]; then
  touch "$SIM_DIR/compare-failed-once"; printf 'PRESERVATION_S10=FAIL\nCOMPARE_RESULT=FAIL\n'; exit 1
fi
printf 'FINDINGS_NEW_OR_WORSENED_DRIFT=0\nFINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0\nFINDINGS_INCOMPARABLE=0\nPRESERVATION_S10=PASS\nCOMPARE_RESULT=PASS\n'
'''

# Stand-in for the read-only p4-l5-clock.py: `state` prints the next line of $SIM_DIR/clock-<phase>.seq (the last line repeats); with no
# sequence file it reports the accepted predicate. phase=rb once the rollback handler ran, else post. Every call is logged as "clock".
CLOCK = r'''#!/usr/bin/env python3
import os, sys
sim = os.environ["SIM_DIR"]
assert sys.argv[1:] == ["state"], sys.argv
calls = os.path.join(sim, "calls.log")
log = open(calls).read().splitlines() if os.path.exists(calls) else []
phase = "rb" if "rollback" in log else "post"
open(calls, "a").write("clock\n")
seq = os.path.join(sim, f"clock-{phase}.seq")
lines = open(seq).read().splitlines() if os.path.exists(seq) else ["state=SYNCED reason=OK maxerror_us=50000 adjtimex_ret=0 status=0x2001 sta_unsync=0 time_error=0"]
idx_path = os.path.join(sim, f"clock-{phase}.idx")
i = int(open(idx_path).read()) if os.path.exists(idx_path) else 0
open(idx_path, "w").write(str(i + 1))
line = lines[min(i, len(lines) - 1)]
if line == "@crash":
    sys.exit(2)
print(line)
'''

FORBIDDEN_CMDS = ("timedatectl", "chronyc", "hwclock", "adjtimex", "ntpdate")

STAGE_GATE = r'''#!/usr/bin/env bash
printf 'AUTHORIZATION_RECORD=VALID\nK3_CONFIRMATION=VALID\n'
'''


def _systemctl_stub() -> str:
    def block(props: dict[str, str]) -> str:
        return "\n".join(f'      {k}) echo "{v}" ;;' for k, v in props.items())

    return r'''#!/usr/bin/env bash
[ "$1" = show ] || echo "FORBIDDEN:systemctl $*" >> "$SIM_DIR/calls.log"
shift  # drop "show"
keys=(); value_mode=0; unit=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) keys+=("$2"); shift 2 ;;
    --value) value_mode=1; shift ;;
    *) unit=$1; shift ;;
  esac
done
prop_for() {
  local u=$1 k=$2
  case "$u" in
    aegis-idea3-dnsmasq.service) case "$k" in
''' + block(DNSMASQ_PROPS) + r'''
    esac ;;
    aegis-idea3-mosquitto.service) case "$k" in
''' + block(BROKER_PROPS) + r'''
      InvocationID) if [ -e "$SIM_DIR/drifted" ]; then echo "''' + DRIFTED + r'''"; else echo "''' + INVOCATION + r'''"; fi ;;
    esac ;;
    *) case "$k" in
''' + block(HEALTHY) + r'''
    esac ;;
  esac
}
for k in "${keys[@]}"; do
  v=$(prop_for "$unit" "$k")
  if [ "$value_mode" = 1 ]; then printf '%s\n' "$v"; else printf '%s=%s\n' "$k" "$v"; fi
done
'''


class Sim:
    def __init__(self, tmp: Path, *, scope: str = EXPECTED_SCOPE, dnsmasq_props: dict[str, str] | None = None) -> None:
        self.dir = tmp / "sim"
        self.repo = self.dir / "repo"
        self.p4 = self.repo / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
        self.evid_base = self.dir / "evidence"
        self.auth = self.dir / "auth"
        self.auth.mkdir(parents=True)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.scope = scope
        self.dnsmasq_props = dnsmasq_props
        self.build()

    def _git(self, *args: str) -> None:
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True, env=env)

    def build(self) -> None:
        logs = self.repo / LOGS
        logs.mkdir(parents=True)
        (logs / "2026-09-23_000000_music_idea3-pr11-l3-live-acceptance.md").write_text("`L3_LIVE_ACCEPTANCE = PROVEN`\n")
        (logs / "2026-09-24_000000_music_idea3-pr11-l4-live-acceptance.md").write_text("`L4_LIVE_ACCEPTANCE = PROVEN`\n")
        self.p4.mkdir(parents=True)
        shutil.copy(REAL_LIB, self.p4 / "p4-l34-reactivation-lib.sh")
        (self.p4 / "p4-stage-gate.sh").write_text(STAGE_GATE)
        (self.p4 / "p4-l0-capture.sh").write_text(CAPTURE)
        (self.p4 / "p4-compare.sh").write_text(COMPARE)
        (self.p4 / "p4-l5-clock.py").write_text(CLOCK)
        hnd = self.p4 / "reactivation" / HND_NAME
        hnd.mkdir(parents=True)
        for name in ("apply.sh", "verify.sh", "rollback.sh"):
            (hnd / name).write_text(HANDLER)
        for name in ("allow-keys.txt", "allow-listeners.txt"):
            (hnd / name).write_text("")
        self._git("init", "-q")
        self._git("checkout", "-q", "-B", "main")
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "sim")
        self._git("remote", "add", "origin", str(self.repo))
        self._git("fetch", "-q", "origin")
        self.head = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()

        (self.bin / "sudo").write_text('#!/usr/bin/env bash\n[ "$1" = -v ] && exit 0\nexec "$@"\n')
        stub = _systemctl_stub()
        if self.dnsmasq_props:
            for k, v in self.dnsmasq_props.items():
                stub = stub.replace(f'      {k}) echo "{DNSMASQ_PROPS[k]}" ;;', f'      {k}) echo "{v}" ;;', 1)
        (self.bin / "systemctl").write_text(stub)
        for name in STUB_NOOP_CMDS:
            (self.bin / name).write_text("#!/usr/bin/env bash\nexit 0\n")
        for name in FORBIDDEN_CMDS:
            (self.bin / name).write_text(f'#!/usr/bin/env bash\necho "FORBIDDEN:{name} $*" >> "$SIM_DIR/calls.log"\nexit 0\n')
        for f in self.bin.iterdir():
            f.chmod(0o755)

        records = f"stage=L4\ndate={TODAY}\nauthorizer=music\nscope={self.scope}\nreference=sim/ref\n"
        (self.auth / "authorization-L4.txt").write_text("AEGIS_P4_AUTHORIZATION_V1\n" + records)
        (self.auth / "k3-L4.txt").write_text("AEGIS_P4_K3_CONFIRMATION_V2\nstage=L4\ndate=" + TODAY + "\nconfirmed_by=music\nreference=sim/ref\n")

        text = RUNNER.read_text()
        text = text.replace("EXPECTED_MAIN=PIN_MAIN_SHA", f"EXPECTED_MAIN={self.head}")
        text = text.replace(
            "REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L34LIVE   # clean pinned execution worktree at merged main",
            f"REPO={self.repo}",
        )
        text = text.replace("EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l34-v6-$STAMP", f"EVID={self.evid_base}/$TODAY-l34-v6-$STAMP")
        # the sandbox has no venv; the stabilization bound is shortened (the committed 60 s / 1 s is asserted by its own test)
        for old, new in (("PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python", "PY=python3"), ("CLOCK_STAB_TIMEOUT_S=60", "CLOCK_STAB_TIMEOUT_S=2"),
                         ("CLOCK_STAB_INTERVAL_S=1", "CLOCK_STAB_INTERVAL_S=0.2")):
            assert old in text, old
            text = text.replace(old, new, 1)
        assert f"REPO={self.repo}" in text and str(self.evid_base) in text
        self.runner = self.dir / "run-l34-v6-stale-broker-ap-down-owner.sh"
        self.runner.write_text(text)
        self.evid_base.mkdir()

    @property
    def marker_path(self) -> Path:
        return self.auth / "L34-V6-REACTIVATION-ATTEMPT-CONSUMED"

    def flag(self, name: str) -> None:
        (self.dir / name).write_text("")

    def calls(self) -> list[str]:
        p = self.dir / "calls.log"
        return p.read_text().splitlines() if p.exists() else []

    def run(self) -> subprocess.CompletedProcess[str]:
        time.sleep(1.05)  # the evidence directory name has 1 s resolution
        env = dict(os.environ, SIM_DIR=str(self.dir), SIM_MARKER=str(self.marker_path), PATH=f"{self.bin}:{os.environ['PATH']}", TZ="Asia/Bangkok")
        return subprocess.run(["bash", str(self.runner), str(self.auth)], text=True, capture_output=True, env=env, check=False)

    def clock_seq(self, phase: str, *lines: str) -> None:
        (self.dir / f"clock-{phase}.seq").write_text("\n".join(lines) + "\n")

    def evid(self) -> Path:
        (d,) = self.evid_base.iterdir()
        return d

    def marker(self) -> bool:
        return self.marker_path.exists()


@pytest.fixture()
def sim(tmp_path: Path) -> Sim:
    return Sim(tmp_path)


HAPPY_CALLS = [
    "apply:preflight marker=NO", "capture:pre marker=NO", "apply:full marker=YES", "verify", "clock", "capture:post marker=YES", "compare",
]


def test_full_flow_uses_the_frozen_consume_order_and_applies_exactly_once(sim: Sim) -> None:
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L3_L4_RUNTIME_REACTIVATION_V6=PASS" in res.stdout and "L34_V6_SOAK=PASS" in res.stdout
    assert "BROKER_CONTROL_COMMAND_ISSUED=NO" in res.stdout
    assert sim.calls() == HAPPY_CALLS
    assert sim.marker()


def test_the_committed_template_refuses_to_run_unpinned() -> None:
    res = subprocess.run(["bash", str(RUNNER), "/nonexistent"], text=True, capture_output=True, check=False)
    assert res.returncode == 2 and "runner is not pinned" in res.stdout


def test_pre_capture_failure_does_not_consume_the_attempt(sim: Sim) -> None:
    sim.flag("capture-pre-fail")
    res = sim.run()
    assert res.returncode == 1 and "PRE capture failed; nothing changed and the attempt is NOT consumed" in res.stdout, res.stdout + res.stderr
    assert not sim.marker()
    assert sim.calls() == ["apply:preflight marker=NO", "capture:pre marker=NO"], "no apply, no rollback, no second capture"
    # the SAME AUTH_DIR is still usable once the cause is fixed
    (sim.dir / "capture-pre-fail").unlink()
    ok = sim.run()
    assert ok.returncode == 0, ok.stdout + ok.stderr


def test_handler_preflight_failure_does_not_consume_and_does_not_capture(sim: Sim) -> None:
    sim.flag("preflight-fail")
    res = sim.run()
    assert res.returncode == 1 and "the attempt is NOT consumed" in res.stdout
    assert not sim.marker()
    assert sim.calls() == ["apply:preflight marker=NO"]


def test_broker_tuple_drift_between_preflight_and_pre_capture_does_not_consume(sim: Sim) -> None:
    sim.flag("drift-after-pre-capture")
    res = sim.run()
    assert res.returncode == 1 and "broker tuple changed between preflight and PRE capture" in res.stdout
    assert not sim.marker()
    assert sim.calls() == ["apply:preflight marker=NO", "capture:pre marker=NO"]


def test_second_use_of_a_consumed_auth_dir_is_rejected(sim: Sim) -> None:
    assert sim.run().returncode == 0
    n = len(sim.calls())
    again = sim.run()
    assert again.returncode == 1 and "this authorization already consumed its one bounded attempt" in again.stderr
    assert len(sim.calls()) == n, "the second use ran no handler and no capture"


def test_consumed_marker_is_never_reset_by_a_failed_apply_and_apply_is_never_retried(sim: Sim) -> None:
    sim.flag("apply-fail")
    res = sim.run()
    assert res.returncode == 1 and "Authorization is consumed" in res.stdout, res.stdout + res.stderr
    assert sim.marker()
    calls = sim.calls()
    assert calls.count("apply:full marker=YES") == 1
    assert calls == ["apply:preflight marker=NO", "capture:pre marker=NO", "apply:full marker=YES", "rollback", "clock", "capture:rb marker=YES", "compare"]
    assert sim.run().returncode == 1 and sim.calls().count("apply:full marker=YES") == 1


def test_failed_verify_soak_or_compare_rolls_back(sim: Sim) -> None:
    for flag, why in (("verify-fail", "L34_V6_VERIFY failed"), ("soak-missing", "L34_V6_VERIFY failed"), ("compare-fail", "PRE->POST compare failed")):
        s = Sim(sim.dir.parent / flag)
        s.flag(flag)
        res = s.run()
        assert res.returncode == 1 and why in res.stdout, (flag, res.stdout + res.stderr)
        assert "rollback" in s.calls() and s.marker()
        assert s.calls().count("apply:full marker=YES") == 1


def test_apply_preflight_tuple_that_differs_from_the_runner_preflight_rolls_back(sim: Sim) -> None:
    sim.flag("apply-tuple-differs")
    res = sim.run()
    assert res.returncode == 1 and "broker tuple differs between the runner preflight and the apply preflight" in res.stdout
    assert "rollback" in sim.calls() and "verify" not in sim.calls()


def test_rollback_failure_is_an_s11_hold_exit_3(sim: Sim) -> None:
    sim.flag("apply-fail")
    sim.flag("rollback-fail")
    res = sim.run()
    assert res.returncode == 3 and "S-11 HOLD" in res.stdout and "the broker is never repaired by V6" in res.stdout
    assert sim.marker()
    assert "capture:rb marker=YES" not in sim.calls()


def test_wrong_scope_is_refused_before_anything_runs(tmp_path: Path) -> None:
    s = Sim(tmp_path, scope="L3_L4_RUNTIME_REACTIVATION_V5_POST_L6B_DEGRADED: something else")
    res = s.run()
    assert res.returncode == 1 and "authorization scope is not exactly the approved V6 scope" in res.stderr
    assert not s.marker() and s.calls() == []


@pytest.mark.parametrize("prop", [("ActiveState", "failed"), ("SubState", "failed"), ("Result", "start-limit-hit"), ("MainPID", "77")])
def test_runner_refuses_when_dnsmasq_is_not_cleanly_inactive(tmp_path: Path, prop: tuple[str, str]) -> None:
    s = Sim(tmp_path, dnsmasq_props={prop[0]: prop[1]})
    res = s.run()
    assert res.returncode == 1 and "L34_V6_DNSMASQ_PRESTATE_UNEXPECTED" in res.stderr, res.stdout + res.stderr
    assert not s.marker() and s.calls() == []
