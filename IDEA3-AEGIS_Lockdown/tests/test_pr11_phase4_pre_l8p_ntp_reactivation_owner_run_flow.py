"""AEGIS IDEA3 PR11 Phase 4 — PRE-L8p NTP RUNTIME REACTIVATION: owner-run CONTROL-FLOW simulation.

The real run-pre-l8p-ntp-runtime-reactivation-owner.sh is executed, unmodified apart from its frozen constants, inside a sandbox: `sudo`, `systemctl` and the other host
commands are stubs and the gate functions come from the REAL, unmodified library (only p4-stage-gate.sh / p4-l0-capture.sh / p4-compare.sh and the three handler scripts are
stand-ins; the handlers are covered by test_pr11_phase4_pre_l8p_ntp_reactivation.py). It proves the runner refuses an unpinned runner, a wrong/moved main, a dirty tree, a
missing historical L5 receipt, the wrong operator, stale/foreign/reused Authorization and K3, a widened scope, a consumed or foreign marker and a runner inside the repository;
consumes the one-shot marker only after preflight, PRE capture and the S10 guard and immediately before the first mutation; rolls back on any later failure; never retries; and
emits only the narrow verdict. No serial, ESP32, MQTT, CUT or RESTORE path exists in the sandbox.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
RUNNER = DEPLOY / "owner-run" / "run-pre-l8p-ntp-runtime-reactivation-owner.sh"
PKG = "pre-l8p-ntp-runtime-reactivation"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
MARKER = "PRE-L8P-NTP-RUNTIME-REACTIVATION-ATTEMPT-CONSUMED"
TODAY = subprocess.run(["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).stdout.strip()
YESTERDAY = subprocess.run(["date", "-d", "yesterday", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).stdout.strip()
SCOPE = re.search(r'^NTPREACT_EXPECTED_SCOPE="(.*)"$', (DEPLOY / "p4-ntp-reactivation-lib.sh").read_text(), re.M).group(1)
L5_RECEIPT = "L5_LIVE_ACCEPTANCE = PROVEN\n"
VERIFY_LINES = ("CHRONYD_ACTIVE=YES", "TIMESYNCD_INACTIVE=YES", "NTP_LISTENER=10.77.30.1:123", "WILDCARD_NTP_LISTENER=NO", "TRUSTEDCLOCK=SYNCED",
                "MAXERROR_WITHIN_L5_BOUND=YES", "CHRONYD_UNITFILESTATE=disabled", "TIMESYNCD_UNITFILESTATE=enabled", "CHRONY_CONF_SHA256_PRE_EQ_POST=YES")

HANDLER = r'''#!/usr/bin/env bash
name=$(basename "$0" .sh)
echo "$name" >> "$SIM_DIR/calls.log"
mkdir -p "$AEGIS_NTPREACT_WORK_DIR"
marker_state() { if [ -e "$(cat "$SIM_DIR/marker-path")" ]; then echo yes; else echo no; fi; }
case "$name" in
  apply)
    if [ "${AEGIS_NTPREACT_PREFLIGHT_ONLY:-NO}" = YES ]; then
      echo "marker@preflight:$(marker_state)" >> "$SIM_DIR/calls.log"
      [ ! -e "$SIM_DIR/fail-preflight" ] || { echo "NTPREACT_APPLY=FAIL reason=$(cat "$SIM_DIR/fail-preflight")" >&2; exit 1; }
      echo "NTPREACT_PREFLIGHT=PASS"; exit 0
    fi
    echo "marker@apply:$(marker_state)" >> "$SIM_DIR/calls.log"
    echo YES > "$AEGIS_NTPREACT_WORK_DIR/production-mutation"
    [ ! -e "$SIM_DIR/bump-pid" ] || echo 200 > "$SIM_DIR/pid"
    [ ! -e "$SIM_DIR/fail-apply" ] || { echo "NTPREACT_APPLY=FAIL reason=SIM" >&2; exit 1; }
    echo "NTPREACT_APPLY=PASS" ;;
  verify)
    [ ! -e "$SIM_DIR/fail-verify" ] || { echo "NTPREACT_VERIFY=FAIL reason=SIM" >&2; exit 1; }
    echo "NTPREACT_VERIFY=PASS"; cat "$SIM_DIR/verify-lines" ;;
  rollback)
    [ ! -e "$SIM_DIR/fail-rollback" ] || { echo "NTPREACT_ROLLBACK=FAIL reason=SIM" >&2; exit 1; }
    echo "NTPREACT_ROLLBACK=PASS" ;;
esac
'''
CAPTURE = ('#!/usr/bin/env bash\necho "capture:$CAPTURE_LABEL" >> "$SIM_DIR/calls.log"\n'
           'if [ -e "$(cat "$SIM_DIR/marker-path")" ]; then echo "marker@capture-$CAPTURE_LABEL:yes" >> "$SIM_DIR/calls.log"; else echo "marker@capture-$CAPTURE_LABEL:no" >> "$SIM_DIR/calls.log"; fi\n'
           '[ ! -e "$SIM_DIR/fail-capture-$CAPTURE_LABEL" ] || exit 1\n'
           '[ ! -e "$SIM_DIR/ntp-lost-by-capture-$CAPTURE_LABEL" ] || echo inactive > "$SIM_DIR/props/chronyd.service.ActiveState"\nmkdir -p "$EVID_DIR"\necho "L0_CAPTURE=COMPLETE" > "$EVID_DIR/capture.log"\n(cd "$EVID_DIR" && sha256sum capture.log > SHA256SUMS)\n')
COMPARE = r'''#!/usr/bin/env bash
echo "compare:$(basename "$1")>$(basename "$2")" >> "$SIM_DIR/calls.log"
env | grep -E "^ALLOW_" >> "$SIM_DIR/calls.log"
[ ! -e "$SIM_DIR/fail-compare-$(basename "$1")-$(basename "$2")" ] || { echo "COMPARE_RESULT=FAIL"; exit 1; }
lines="FINDINGS_NEW_OR_WORSENED_DRIFT=0
FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0
FINDINGS_INCOMPARABLE=0
PRESERVATION_S10=PASS
COMPARE_RESULT=PASS"
if [ "$(basename "$2")" = s10-root ] && [ -e "$SIM_DIR/s10-line" ]; then
  key=$(cut -d= -f1 "$SIM_DIR/s10-line"); lines=$(printf '%s\n' "$lines" | sed "s|^$key=.*|$(cat "$SIM_DIR/s10-line")|")
fi
printf '%s\n' "$lines"
'''
STAGE_GATE = "#!/usr/bin/env bash\necho \"stage-gate:$*\" >> \"$SIM_DIR/calls.log\"\n[ ! -e \"$SIM_DIR/fail-stage-gate\" ] || { echo STAGE_GATE=FAIL; exit 1; }\nprintf 'AUTHORIZATION_RECORD=VALID\\nK3_CONFIRMATION=VALID\\n'\n"
SYSTEMCTL = r'''#!/usr/bin/env bash
shift
keys=(); value=0; unit=""
while [ $# -gt 0 ]; do case "$1" in -p) keys+=("$2"); shift 2 ;; --value) value=1; shift ;; *) unit=$1; shift ;; esac; done
default() { case "$1" in LoadState) echo loaded ;; ActiveState) echo active ;; SubState) echo running ;; UnitFileState) echo enabled ;; Result) echo success ;; NRestarts) echo 0 ;; MainPID) cat "$SIM_DIR/pid" ;; esac; }
for k in "${keys[@]}"; do
  v=$(cat "$SIM_DIR/props/$unit.$k" 2>/dev/null || default "$k")
  if [ "$value" = 1 ]; then printf '%s\n' "$v"; else printf '%s=%s\n' "$k" "$v"; fi
done
'''



class Sim:
    def __init__(self, tmp: Path, *, scope: str = SCOPE, receipt: str = L5_RECEIPT, operator_uid: str | None = None, runner_in_repo: bool = False) -> None:
        self.dir = tmp / "sim"
        self.repo = self.dir / "repo"
        self.origin = self.dir / "origin.git"
        self.p4 = self.repo / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
        self.evid_base = self.dir / "evidence"
        self.auth = self.dir / "auth"
        self.bin = self.dir / "bin"
        for d in (self.auth, self.bin, self.evid_base):
            d.mkdir(parents=True)
        self.scope, self.receipt, self.operator_uid, self.runner_in_repo = scope, receipt, operator_uid, runner_in_repo
        self.build()

    def git(self, *args: str, cwd: Path | None = None) -> str:
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        return subprocess.run(["git", "-C", str(cwd or self.repo), *args], check=True, capture_output=True, text=True, env=env).stdout.strip()

    def build(self) -> None:
        self.p4.mkdir(parents=True)
        shutil.copy(DEPLOY / "p4-ntp-reactivation-lib.sh", self.p4 / "p4-ntp-reactivation-lib.sh")
        self.build_ntp_sandbox()
        (self.p4 / "p4-stage-gate.sh").write_text(STAGE_GATE)
        (self.p4 / "p4-l0-capture.sh").write_text(CAPTURE)
        (self.p4 / "p4-compare.sh").write_text(COMPARE)
        hnd = self.p4 / "reactivation" / PKG
        hnd.mkdir(parents=True)
        for name in ("apply.sh", "verify.sh", "rollback.sh"):
            (hnd / name).write_text(HANDLER)
        for name in ("allow-keys.txt", "allow-listeners.txt"):
            shutil.copy(DEPLOY / "reactivation" / PKG / name, hnd / name)
        (self.repo / LOGS).mkdir(parents=True)
        (self.repo / LOGS / "2026-09-25_000000_music_l5-live-acceptance.md").write_text(self.receipt)
        self.git("init", "-q")
        self.git("checkout", "-q", "-B", "main")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "pinned main stand-in")
        self.head = self.git("rev-parse", "HEAD")
        subprocess.run(["git", "init", "-q", "--bare", str(self.origin)], check=True, capture_output=True)
        self.git("remote", "add", "origin", str(self.origin))
        self.git("push", "-q", "origin", "main")
        self.git("fetch", "-q", "origin")

        (self.bin / "sudo").write_text('#!/usr/bin/env bash\n[ "$1" = -v ] && exit 0\nexec "$@"\n')
        (self.bin / "systemctl").write_text(SYSTEMCTL)
        (self.bin / "ip").write_text("#!/usr/bin/env bash\nexit 0\n")
        (self.bin / "ss").write_text('#!/usr/bin/env bash\n[ "$*" = "-H -ltnu" ] || exit 1\ncat "$SIM_DIR/ss-lines"\n')
        for f in self.bin.iterdir():
            f.chmod(0o755)
        (self.dir / "pid").write_text("100\n")
        (self.dir / "verify-lines").write_text("\n".join(VERIFY_LINES) + "\n")
        self.write_auth(TODAY, TODAY)

        user = subprocess.run(["id", "-un"], text=True, capture_output=True).stdout.strip()
        uid = self.operator_uid or subprocess.run(["id", "-u"], text=True, capture_output=True).stdout.strip()
        text = RUNNER.read_text()
        for old, new in (("EXPECTED_MAIN=PIN_MAIN_SHA", f"EXPECTED_MAIN={self.head}"), ("OPERATOR_USER=PIN_OPERATOR_USER", f"OPERATOR_USER={user}"),
                         ("OPERATOR_UID=PIN_OPERATOR_UID", f"OPERATOR_UID={uid}"), ("S10_WINDOW_SEC=30 ", "S10_WINDOW_SEC=0 "),
                         ("REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-NTPREACTLIVE   # clean pinned execution worktree at merged main", f"REPO={self.repo}"),
                         ("EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-pre-l8p-ntp-reactivation-$STAMP", f"EVID={self.evid_base}/$TODAY-pre-l8p-ntp-reactivation-$STAMP")):
            assert old in text, old
            text = text.replace(old, new)
        self.runner = (self.repo / "frozen-runner.sh") if self.runner_in_repo else (self.dir / "frozen-runner.sh")
        self.runner.write_text(text)
        if self.runner_in_repo:
            self.git("add", "-A"); self.git("commit", "-q", "-m", "runner inside repo")
            self.runner_head = self.git("rev-parse", "HEAD")
            self.runner.write_text(text.replace(f"EXPECTED_MAIN={self.head}", f"EXPECTED_MAIN={self.runner_head}"))
            self.git("push", "-q", "origin", "main"); self.git("fetch", "-q", "origin")
            self.git("checkout", "-q", "--", "frozen-runner.sh")
            self.runner.write_text(text.replace(f"EXPECTED_MAIN={self.head}", f"EXPECTED_MAIN={self.runner_head}"))
            self.git("update-index", "--assume-unchanged", "frozen-runner.sh")
        (self.dir / "marker-path").write_text(str(self.auth / MARKER))

    def build_ntp_sandbox(self) -> None:
        """The REAL ntpreact_runtime_ready_gate (final verification) runs against a sandbox host: config path/hash/mode constants of the COPIED lib point at a sandbox file,
        `ss` and the clock probe are stand-ins, unit states come from the systemctl stub's props. Healthy post-apply NTP runtime by default."""
        conf = self.dir / "chrony.conf"
        conf.write_text("# approved L5 runtime configuration (sandbox)\nserver 2.arch.pool.ntp.org iburst\nbindaddress 10.77.30.1\nallow 10.77.30.0/28\nrtcsync\n")
        conf.chmod(0o640)
        import hashlib
        lib = self.p4 / "p4-ntp-reactivation-lib.sh"
        text = lib.read_text()
        for pattern, repl in ((r'^NTPREACT_CHRONY_CONF="[^"]*"$', f'NTPREACT_CHRONY_CONF="{conf}"'),
                              (r'^NTPREACT_CHRONY_CONF_SHA256="[0-9a-f]{64}"$', f'NTPREACT_CHRONY_CONF_SHA256="{hashlib.sha256(conf.read_bytes()).hexdigest()}"'),
                              (r'^NTPREACT_CHRONY_CONF_MODE_OWNER="[^"]*"', f'NTPREACT_CHRONY_CONF_MODE_OWNER="640:{os.getuid()}:{os.getgid()}"')):
            text, n = re.subn(pattern, lambda _m, r=repl: r, text, count=1, flags=re.MULTILINE)
            assert n == 1, pattern
        lib.write_text(text)
        (self.p4 / "p4-l5-clock.py").write_text(
            "import os, sys\nsim = os.environ['SIM_DIR']\n"
            "if os.path.exists(os.path.join(sim, 'clock-unsynced')):\n    print('state=UNSYNCED reason=KERNEL_UNSYNCED maxerror_us=16000000 sim=1'); sys.exit(1)\n"
            "print('state=SYNCED reason=OK maxerror_us=1000 sim=1')\n")
        (self.dir / "props").mkdir()
        for unit, state in (("chronyd.service", ("active", "running", "disabled")), ("systemd-timesyncd.service", ("inactive", "dead", "enabled"))):
            for key, value in zip(("ActiveState", "SubState", "UnitFileState"), state):
                self.prop(unit, key, value)
        self.ss_lines("udp UNCONN 0 0 10.77.30.1:123 0.0.0.0:*", "udp UNCONN 0 0 127.0.0.1:323 0.0.0.0:*")

    def prop(self, unit: str, key: str, value: str) -> None:
        (self.dir / "props" / f"{unit}.{key}").write_text(value + "\n")

    def ss_lines(self, *lines: str) -> None:
        (self.dir / "ss-lines").write_text("".join(f"{line}\n" for line in lines))

    def write_auth(self, auth_date: str, k3_date: str, *, stage: str = "L5", k3_stage: str = "L5", reference: str = "sim/ref", scope: str | None = None) -> None:
        (self.auth / "authorization-L5.txt").write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage={stage}\ndate={auth_date}\nauthorizer=music\nscope={scope or self.scope}\nreference={reference}\n")
        (self.auth / "k3-L5.txt").write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage={k3_stage}\ndate={k3_date}\nconfirmed_by=music\nreference={reference}\n")

    def run(self) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ, SIM_DIR=str(self.dir), PATH=f"{self.bin}:{os.environ['PATH']}", TZ="Asia/Bangkok")
        return subprocess.run(["bash", str(self.runner), str(self.auth)], text=True, capture_output=True, env=env, check=False)

    def inject(self, name: str, text: str = "1") -> None:
        (self.dir / name).write_text(text + "\n")

    def marker(self) -> bool:
        return (self.auth / MARKER).exists()

    def calls(self) -> list[str]:
        return (self.dir / "calls.log").read_text().splitlines() if (self.dir / "calls.log").exists() else []

    def handler_calls(self) -> list[str]:
        return [c for c in self.calls() if c in ("apply", "verify", "rollback")]

    def verdict(self) -> str:
        files = list(self.evid_base.rglob("terminal-verdict.txt"))
        return files[0].read_text() if files else ""


def _refused(sim: Sim, needle: str) -> None:
    res = sim.run()
    out = res.stdout + res.stderr
    assert res.returncode in (1, 2) and needle in out, out
    # the read-only stage gate is evaluated alongside the other pre-gates (they accumulate); nothing else runs, nothing is created, nothing is consumed
    assert not sim.marker() and all(c.startswith("stage-gate:") for c in sim.calls()) and not list(sim.evid_base.iterdir()), "refused before ANY effect"
    return out


# ── pinning ────────────────────────────────────────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("pin", ["EXPECTED_MAIN=PIN_MAIN_SHA", "OPERATOR_USER=PIN_OPERATOR_USER", "OPERATOR_UID=PIN_OPERATOR_UID"])
def test_runner_is_unpinned_as_committed(pin: str, tmp_path: Path) -> None:
    assert pin in RUNNER.read_text()
    res = subprocess.run(["bash", str(RUNNER), str(tmp_path)], text=True, capture_output=True, check=False)
    assert res.returncode == 2 and "runner is not pinned" in res.stdout


def test_a_non_sha_main_pin_is_refused(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.runner.write_text(sim.runner.read_text().replace(sim.head, "main"))
    _refused(sim, "EXPECTED_MAIN is not a 40-hex SHA")


def test_wrong_main_is_refused(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.runner.write_text(sim.runner.read_text().replace(sim.head, "0" * 40))
    _refused(sim, "worktree HEAD is not")


def test_origin_main_that_moved_is_refused_not_repinned(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    other = sim.dir / "other"
    subprocess.run(["git", "clone", "-q", str(sim.origin), str(other)], check=True, capture_output=True)
    sim.git("config", "user.name", "t", cwd=other); sim.git("config", "user.email", "t@t", cwd=other)
    (other / "moved.txt").write_text("main moved after the pin\n")
    sim.git("add", "-A", cwd=other); sim.git("commit", "-q", "-m", "moved", cwd=other); sim.git("push", "-q", "origin", "main", cwd=other)
    _refused(sim, "origin/main is not")


def test_dirty_worktree_is_refused(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.repo / "stray.txt").write_text("x\n")
    _refused(sim, "worktree is not clean")


def test_the_frozen_runner_must_live_outside_the_repository(tmp_path: Path) -> None:
    sim = Sim(tmp_path, runner_in_repo=True)
    out = sim.run()
    assert out.returncode == 1 and "OUTSIDE the repository" in out.stdout + out.stderr
    assert not sim.marker() and sim.calls() == [] and not list(sim.evid_base.iterdir())


# ── operator identity, receipt ─────────────────────────────────────────────────────────────────────────────────────────

def test_wrong_operator_identity_is_refused(tmp_path: Path) -> None:
    current = int(subprocess.run(["id", "-u"], text=True, capture_output=True).stdout)
    _refused(Sim(tmp_path, operator_uid=str(current + 1)), "NTPREACT_OPERATOR_IDENTITY_MISMATCH")


@pytest.mark.parametrize("receipt", ["", "L5_LIVE_ACCEPTANCE=NOT_PROVEN\n", "L5_LIVE_ACCEPTANCE = NOT_PROVEN\n", "L4_LIVE_ACCEPTANCE = PROVEN\n"])
def test_missing_or_unproven_historical_l5_receipt_is_refused(tmp_path: Path, receipt: str) -> None:
    _refused(Sim(tmp_path, receipt=receipt), "NTPREACT_L5_ACCEPTANCE_RECEIPT_MISSING")


# ── Authorization / K3 / marker ────────────────────────────────────────────────────────────────────────────────────────

def test_stale_authorization_is_refused(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.write_auth(YESTERDAY, TODAY)
    _refused(sim, "NTPREACT_RECORD_NOT_SAME_DAY:authorization-L5.txt")


def test_stale_k3_is_refused(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.write_auth(TODAY, YESTERDAY)
    _refused(sim, "NTPREACT_RECORD_NOT_SAME_DAY:k3-L5.txt")


@pytest.mark.parametrize("kw,which", [(dict(stage="L8p"), "authorization"), (dict(k3_stage="L4"), "k3")])
def test_another_stage_record_is_refused(tmp_path: Path, kw: dict, which: str) -> None:
    sim = Sim(tmp_path); sim.write_auth(TODAY, TODAY, **kw)
    _refused(sim, "NTPREACT_RECORD_NOT_STAGE_L5")


@pytest.mark.parametrize("scope", [
    "L5_LIVE_APPLY: render and install chrony.conf, stop systemd-timesyncd, start chronyd",
    "PRE_L8P_NTP_RUNTIME_REACTIVATION: systemctl stop systemd-timesyncd.service then start chronyd.service only; no enable, disable, config, network, AP, dnsmasq, broker, Core or ESP32 change and enable chronyd",
    SCOPE.replace("PRE_L8P_", "POST_L8P_"),
    SCOPE + " ",
    "",
], ids=["historical-l5", "widened", "other-task", "trailing-space", "empty"])
def test_a_historical_or_widened_scope_is_refused(tmp_path: Path, scope: str) -> None:
    sim = Sim(tmp_path); sim.write_auth(TODAY, TODAY, scope=scope or "x")
    if not scope:
        (sim.auth / "authorization-L5.txt").write_text((sim.auth / "authorization-L5.txt").read_text().replace("scope=x", "scope="))
    _refused(sim, "NTPREACT_SCOPE_NOT_EXACT")


def test_the_historical_l5_authorization_reference_is_refused(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.write_auth(TODAY, TODAY, reference="https://github.com/kraveerachat/Project-End-The-AEGIS/pull/215#issuecomment-5833985188")
    _refused(sim, "NTPREACT_HISTORICAL_L5_REFERENCE_REUSE_FORBIDDEN")


@pytest.mark.parametrize("marker", ["L5-ATTEMPT-CONSUMED", "DNSMASQ-UNIT-REPAIR-ATTEMPT-CONSUMED", "L8p-ATTEMPT-CONSUMED", "L34-ATTEMPT-CONSUMED"])
def test_another_governed_runs_attempt_marker_in_auth_dir_is_refused(tmp_path: Path, marker: str) -> None:
    sim = Sim(tmp_path); (sim.auth / marker).write_text("consumed_at=x\n")
    _refused(sim, "NTPREACT_FOREIGN_ATTEMPT_MARKER")


def test_a_consumed_attempt_is_refused_and_never_retried(tmp_path: Path) -> None:
    sim = Sim(tmp_path); assert sim.run().returncode == 0
    effective = lambda: [c for c in sim.calls() if not c.startswith("stage-gate:")]  # the read-only stage gate runs alongside the other pre-gates
    n = len(effective())
    second = sim.run()
    assert second.returncode == 1 and "NTPREACT_ATTEMPT_ALREADY_CONSUMED" in second.stdout + second.stderr
    assert len(effective()) == n, "no handler, capture or compare call on the second invocation"


def test_stage_gate_refusal_is_a_pre_gate(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.inject("fail-stage-gate")
    out = sim.run()
    assert out.returncode == 1 and "stage gate failed" in out.stderr and not sim.marker()
    assert sim.handler_calls() == [] and not list(sim.evid_base.iterdir())


def test_stage_gate_is_called_for_stage_l5_live_only(tmp_path: Path) -> None:
    sim = Sim(tmp_path); assert sim.run().returncode == 0
    gate = [c for c in sim.calls() if c.startswith("stage-gate:")]
    assert len(gate) == 1 and "--stage L5 --mode live" in gate[0] and "authorization-L5.txt" in gate[0] and "k3-L5.txt" in gate[0]


# ── happy path and ordering ────────────────────────────────────────────────────────────────────────────────────────────

def test_full_flow_succeeds_with_only_the_narrow_claims(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert sim.marker() and sim.handler_calls() == ["apply", "apply", "verify"], "preflight, apply once, verify; no rollback"
    verdict = sim.verdict().splitlines()
    for want in (*VERIFY_LINES, "PRE_L8P_NTP_RUNTIME_REACTIVATION=PASS", "NTP_RUNTIME_READY_FOR_L8P=YES", "NTP_LISTENER_ADDRESS=10.77.30.1:123", "UNITFILESTATE_MUTATION=NO",
                 "CHRONY_CONFIG_MUTATION=NO", "UNEXPECTED_DRIFT=NONE", "L5_LIVE_ACCEPTANCE=HISTORICAL_PROVEN_UNCHANGED", "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN",
                 "L8P_LIVE_EXECUTED=NO", "ESP32_FLASH_PERFORMED=NO", "RECOVERY_EXECUTED=NO", "LVR_EXECUTED=NO", "L8_ACCEPTANCE=NO", "NTP_REACTIVATION_RESULT=PASS"):
        assert want in verdict, (want, verdict)
    assert not re.search(r"K12_(PERSISTENCE_OBSERVED|FORMALLY_PROVEN=YES)|L5_LIVE_ACCEPTANCE=(NEW|RERUN|PROVEN$)|L8P_LIVE_EXECUTED=YES|L8_ACCEPTANCE=YES", sim.verdict() + res.stdout)
    frozen = list(sim.evid_base.rglob("frozen-inputs.txt"))[0].read_text()
    import hashlib
    assert f"RUNNER_SHA256={hashlib.sha256(sim.runner.read_bytes()).hexdigest()}" in frozen and f"MAIN={sim.head}" in frozen


def test_the_attempt_is_consumed_only_after_preflight_pre_capture_and_s10_guard_and_before_the_first_mutation(tmp_path: Path) -> None:
    sim = Sim(tmp_path); assert sim.run().returncode == 0
    calls = sim.calls()
    keep = [c for c in calls if re.match(r"(marker@|capture:|apply$|verify$|rollback$|compare:)", c)]
    assert keep == ["apply", "marker@preflight:no", "capture:pre", "marker@capture-pre:no", "capture:s10", "marker@capture-s10:no", "compare:pre-root>s10-root",
                    "apply", "marker@apply:yes", "verify", "capture:post", "marker@capture-post:yes", "compare:pre-root>post-root"]


def test_compare_uses_only_the_package_catalogs(tmp_path: Path) -> None:
    sim = Sim(tmp_path); assert sim.run().returncode == 0
    text = "\n".join(sim.calls())
    assert f"ALLOW_KEYS_FILE={sim.p4}/reactivation/{PKG}/allow-keys.txt" in text and f"ALLOW_LISTENERS_FILE={sim.p4}/reactivation/{PKG}/allow-listeners.txt" in text
    assert "ALLOW_TRANSITIONS_FILE" not in text and "ALLOW_DYNAMIC_TRANSITIONS_FILE" not in text
    assert "/stages/L5" not in text and "/reactivation/l34" not in text


# ── pre-consume refusals: authorization stays unconsumed ───────────────────────────────────────────────────────────────

def test_a_refused_handler_preflight_leaves_the_authorization_unconsumed(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.inject("fail-preflight", "NTPREACT_UNIT_STATE_MISMATCH:chronyd.service.ActiveState=active")
    res = sim.run()
    out = res.stdout + res.stderr   # after the evidence dir exists, the runner tees both streams into stdout
    assert res.returncode == 1 and "preflight failed" in out and "NTP_REACTIVATION_RESULT=NOT_STARTED_NO_MUTATION" in out
    assert not sim.marker() and sim.handler_calls() == ["apply"] and not [c for c in sim.calls() if c.startswith("capture:")]


def test_a_failed_pre_capture_leaves_the_authorization_unconsumed(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.inject("fail-capture-pre")
    res = sim.run()
    assert res.returncode == 1 and not sim.marker() and sim.handler_calls() == ["apply"]
    assert "PRE capture failed" in res.stdout + res.stderr


@pytest.mark.parametrize("line", ["FINDINGS_NEW_OR_WORSENED_DRIFT=2", "FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=1", "FINDINGS_INCOMPARABLE=1", "PRESERVATION_S10=FAIL", "COMPARE_RESULT=FAIL"])
def test_the_pre_consume_s10_guard_refuses_unstable_or_unhealthy_baselines(tmp_path: Path, line: str) -> None:
    sim = Sim(tmp_path); sim.inject("s10-line", line)
    res = sim.run()
    out = res.stdout + res.stderr
    assert res.returncode == 1 and "S10_STABILITY_GUARD failed" in out and "authorization NOT consumed" in out
    assert not sim.marker() and sim.handler_calls() == ["apply"], "only the read-only preflight ran: no mutation, no marker"
    assert "NTP_REACTIVATION_RESULT=NOT_STARTED_NO_MUTATION" in out


def test_a_failed_second_s10_capture_leaves_the_authorization_unconsumed(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.inject("fail-capture-s10")
    res = sim.run()
    assert res.returncode == 1 and not sim.marker() and sim.handler_calls() == ["apply"] and "second capture failed" in res.stdout + res.stderr


# ── failure after consumption: roll back, never retry ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("flag,rolled", [("fail-apply", "NTPREACT_APPLY failed"), ("fail-verify", "NTPREACT_VERIFY failed")])
def test_apply_or_verify_failure_rolls_back_and_never_retries(tmp_path: Path, flag: str, rolled: str) -> None:
    sim = Sim(tmp_path); sim.inject(flag)
    res = sim.run()
    out = res.stdout + res.stderr
    assert res.returncode == 1 and rolled in out and "ROLLBACK_RESULT=PASS" in out
    assert sim.marker() and sim.handler_calls().count("apply") == 2 and sim.handler_calls().count("rollback") == 1
    assert "NTP_REACTIVATION_RESULT=ROLLED_BACK" in sim.verdict() and "NTP_RUNTIME_READY_FOR_L8P=NO" in out
    assert "PRE_L8P_NTP_RUNTIME_REACTIVATION=PASS" not in out + sim.verdict()
    assert sim.run().returncode == 1 and sim.handler_calls().count("apply") == 2, "no automatic retry"


@pytest.mark.parametrize("drop", list(VERIFY_LINES))
def test_every_required_verify_line_is_enforced(tmp_path: Path, drop: str) -> None:
    sim = Sim(tmp_path)
    (sim.dir / "verify-lines").write_text("\n".join(l for l in VERIFY_LINES if l != drop) + "\n")
    res = sim.run()
    assert res.returncode == 1 and f"verify did not report {drop}" in res.stdout + res.stderr and "rollback" in sim.handler_calls()


def test_a_wildcard_or_other_listener_line_from_verify_cannot_satisfy_the_exact_one(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.dir / "verify-lines").write_text("\n".join(l.replace("NTP_LISTENER=10.77.30.1:123", "NTP_LISTENER=0.0.0.0:123") for l in VERIFY_LINES) + "\n")
    res = sim.run()
    assert res.returncode == 1 and "verify did not report NTP_LISTENER=10.77.30.1:123" in res.stdout + res.stderr


def test_post_capture_or_compare_failure_rolls_back(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.inject("fail-capture-post")
    assert sim.run().returncode == 1 and sim.handler_calls().count("rollback") == 1
    sim2 = Sim(tmp_path / "b"); sim2.inject("fail-compare-pre-root-post-root")
    out = sim2.run()
    assert out.returncode == 1 and "PRE->POST compare failed" in out.stdout + out.stderr and sim2.handler_calls().count("rollback") == 1


def test_a_changed_legacy_service_identity_rolls_back_and_escalates_if_it_cannot_be_restored(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.inject("bump-pid")
    res = sim.run()
    out = res.stdout + res.stderr
    assert "identity changed" in out and sim.handler_calls().count("rollback") == 1, "the rollback handler ran"
    # this package never commands those services, so a PID that stays changed after rollback cannot be explained: PRE->RB identity check fails -> ESCALATE
    assert res.returncode == 3 and "ROLLBACK_FAILED_ESCALATE" in sim.verdict()


def test_a_failing_rollback_escalates_and_is_not_retried(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.inject("fail-apply"); sim.inject("fail-rollback")
    res = sim.run()
    out = res.stdout + res.stderr
    assert res.returncode == 3 and "ESCALATE" in out and "NTP_REACTIVATION_RESULT=ROLLBACK_FAILED_ESCALATE" in sim.verdict()
    assert sim.handler_calls().count("rollback") == 1 and sim.marker()


def test_a_failed_post_rollback_compare_escalates(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.inject("fail-apply"); sim.inject("fail-compare-pre-root-rb-root")
    res = sim.run()
    assert res.returncode == 3 and "PRE_RB_COMPARE=FAIL" in res.stdout + res.stderr and "ROLLBACK_FAILED_ESCALATE" in sim.verdict()


def test_the_runner_only_ever_invokes_the_three_package_handlers(tmp_path: Path) -> None:
    sim = Sim(tmp_path); sim.inject("fail-verify"); sim.run()
    assert set(sim.handler_calls()) <= {"apply", "verify", "rollback"}
    assert not [c for c in sim.calls() if not c.startswith("ALLOW_") and re.search(r"esptool|serial|mosquitto|publish|CUT|RESTORE|l8p", c, re.I)]


# ── FINAL read-only verification AFTER the POST capture (root cause of the consumed 2026-10-03 attempt) ─────────────────────────────────────────────
# That attempt passed VERIFY, then its own POST capture stopped chronyd (timedatectl show-timesync activated systemd-timesyncd, which conflicts with chronyd), yet the runner
# printed PASS from the stale VERIFY output. The stub VERIFY handler below always passes, so these tests prove the verdict now depends on the runtime as it is AFTER capture.

def test_the_final_verification_runs_after_post_capture_and_compare_and_gates_the_pass_verdict(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    out = res.stdout
    assert res.returncode == 0, out
    marks = ["CAPTURE_POST=COMPLETE", "== PRE -> POST compare", "== FINAL read-only NTP runtime verification", "FINAL_NTP_RUNTIME_VERIFICATION=PASS_AFTER_POST_CAPTURE",
             "NTP_RUNTIME_READY_FOR_L8P=YES"]
    positions = [out.index(m) for m in marks]
    assert positions == sorted(positions), positions
    assert out.count("FINAL_NTP_RUNTIME_VERIFICATION=PASS_AFTER_POST_CAPTURE") == 2, "once as the live line, once inside the terminal verdict block"
    assert "FINAL_NTP_RUNTIME_VERIFICATION=PASS_AFTER_POST_CAPTURE" in sim.verdict()
    assert list(sim.evid_base.rglob("final-ntp-runtime-verification.txt"))


def test_ntp_lost_by_the_post_capture_is_never_reported_as_ready(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("ntp-lost-by-capture-post")
    res = sim.run()
    out = res.stdout
    assert res.returncode == 1
    assert "FINAL_NTP_RUNTIME_VERIFICATION=FAIL" in out and "NTPREACT_UNIT_STATE_MISMATCH:chronyd.service.ActiveState=inactive" in out
    assert "NTP_RUNTIME_READY_FOR_L8P=YES" not in out and "PRE_L8P_NTP_RUNTIME_REACTIVATION=PASS" not in out and "NTP_REACTIVATION_RESULT=PASS" not in out
    assert "NTP_RUNTIME_READY_FOR_L8P=NO" in out and sim.verdict().strip() == "NTP_REACTIVATION_RESULT=ROLLED_BACK"
    assert "rollback" in sim.handler_calls() and sim.calls().count("marker@apply:yes") == 1, "rolled back; the mutating apply ran once (the other apply call is the read-only preflight)"
    assert sim.marker(), "the one-shot marker stays consumed"


@pytest.mark.parametrize("name,breaker,reason", [
    ("timesyncd-reactivated", lambda s: (s.prop("systemd-timesyncd.service", "ActiveState", "active"), s.prop("systemd-timesyncd.service", "SubState", "running")),
     "NTPREACT_UNIT_STATE_MISMATCH:systemd-timesyncd.service.ActiveState=active"),
    ("listener-gone", lambda s: s.ss_lines("udp UNCONN 0 0 127.0.0.1:323 0.0.0.0:*"), "AP_NTP_LISTENER_MISSING_OR_DUPLICATED:0"),
    ("wildcard-listener", lambda s: s.ss_lines("udp UNCONN 0 0 0.0.0.0:123 0.0.0.0:*"), "WILDCARD_NTP_LISTENER_FORBIDDEN"),
    ("clock-lost", lambda s: s.inject("clock-unsynced"), "NTPREACT_TRUSTEDCLOCK_NOT_OK"),
    ("conf-changed", lambda s: (s.dir / "chrony.conf").write_text("server other.example iburst\n"), "NTPREACT_CHRONY_CONF_NOT_APPROVED_L5_CONTENT"),
    ("chronyd-unitfile-enabled", lambda s: s.prop("chronyd.service", "UnitFileState", "enabled"), "NTPREACT_UNIT_STATE_MISMATCH:chronyd.service.UnitFileState=enabled"),
], ids=lambda v: v if isinstance(v, str) and " " not in v and ":" not in v else "")
def test_every_final_runtime_check_failing_after_a_passing_verify_rolls_back(tmp_path: Path, name: str, breaker, reason: str) -> None:
    sim = Sim(tmp_path)
    breaker(sim)
    res = sim.run()
    out = res.stdout
    assert "NTPREACT_VERIFY=PASS" in out, "the stale VERIFY output passed; only the final check can catch this"
    assert res.returncode == 1 and reason in out and "FINAL_NTP_RUNTIME_VERIFICATION=FAIL" in out
    assert "NTP_RUNTIME_READY_FOR_L8P=YES" not in out and "rollback" in sim.handler_calls()


def test_the_final_verification_is_read_only_and_sits_between_the_compare_and_the_verdict() -> None:
    code = "\n".join(l for l in RUNNER.read_text().splitlines() if not l.lstrip().startswith("#"))
    final = code.index("ntpreact_runtime_ready_gate")
    assert code.index('capture POST') < code.index('compare "$EVID/pre-root" "$EVID/post-root"') < code.index("identity_unchanged || rollback_flow") < final < code.rindex("trap - ERR INT TERM")
    assert code.rindex("trap - ERR INT TERM") < code.index("NTP_RUNTIME_READY_FOR_L8P=YES")
    assert code.count("NTP_RUNTIME_READY_FOR_L8P=YES") == 1 and code.count("ntpreact_runtime_ready_gate") == 1
    assert "FINAL_NTP_RUNTIME_VERIFICATION" in code
    lib = (DEPLOY / "p4-ntp-reactivation-lib.sh").read_text()
    body = lib[lib.index("ntpreact_runtime_ready_gate()"):]
    body = "\n".join(l for l in body[:body.index("\n}\n")].splitlines() if not l.lstrip().startswith("#"))
    assert not re.search(r"\b(start|stop|restart|enable|disable|set-ntp|show-timesync|timedatectl|chronyc)\b", body)
