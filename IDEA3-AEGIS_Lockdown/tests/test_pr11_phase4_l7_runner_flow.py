# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L7 owner-runner CONTROL-FLOW simulation.

The real run-l7-owner.sh is executed, unmodified apart from its frozen constants (pin, paths), inside a sandbox: `sudo`, `systemctl`,
`ss`, `sysctl` and friends are stubs, the stage handlers / capture / compare / stage gate are recording stubs, and the stage-independent
host-gate functions are overridden by a wrapper library. The gate LOGIC is tested in test_pr11_phase4_l7_runner.py; this file proves the
runner's ORDER and FAILURE SEMANTICS: read-only gates before the one-attempt marker, one apply / one verify, PRE before apply, strict
PRE->POST, bounded rollback on every failure branch, PRE->RB zero-drift proof, exit 3 (S-11 HOLD) when rollback or the RB proof fails,
and never a retry. Nothing touches the real host.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l7_support as s  # noqa: E402
from test_pr11_phase4_l7_runner import LOGS, git, make_repo  # noqa: E402

ROOT = s.ROOT
RUNNER = ROOT / "deploy" / "pr11-phase4" / "owner-run" / "run-l7-owner.sh"
REAL_LIB = ROOT / "deploy" / "pr11-phase4" / "p4-l7-run-lib.sh"
REL_ID = "rel-20260927"
TODAY = subprocess.run(["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).stdout.strip()

STUB_BINS = {
    "sudo": '[ "$1" = -v ] && exit 0\nexec "$@"',
    "systemctl": r'''# systemctl show -p PROP --value UNIT
prop=$3; unit=$5
case "$prop" in
  ActiveState) echo active ;; SubState) echo running ;; UnitFileState) echo enabled ;; NRestarts) echo 0 ;; Result) echo success ;;
  MainPID) if [ "$unit" = mosquitto.service ] && [ -e "$SIM_DIR/drift_legacy" ]; then echo 999; else echo 4242; fi ;;
esac''',
    "ss": 'echo "LISTEN 0 100 0.0.0.0:1883 0.0.0.0:*"',
    "sysctl": 'echo 0',
    "nft": 'printf "table inet aegis_idea3 {\\n iifname wlp0s20f3 tcp dport 1883 drop\\n}\\n"',
    "ip": "exit 0", "iw": "exit 0", "nmcli": "exit 0", "runuser": "exit 0", "systemd-analyze": "exit 0", "getent": "exit 0", "openssl": "exit 0",
}

WRAPPER_LIB = r'''#!/usr/bin/env bash
source "__REAL_LIB__"
# host-dependent gates are stubbed in the simulation; their logic is unit-tested elsewhere
sim_gate() { [ "${SIM_GATE_FAIL:-}" = "$1" ] && { echo "SIM_GATE_FAIL:$1" >&2; return 1; }; echo "$1" >> "$SIM_DIR/gates.log"; return 0; }
l7_release_gate() { sim_gate release; }
l7_core_prestate_gate() { sim_gate core_prestate; }
l7_broker_runtime_gate() { sim_gate broker; }
l7_tls_probe() { sim_gate tls_probe; }
l7_disk_gate() { sim_gate disk; }
l6b_ap_runtime_gate() { sim_gate ap; }
l6b_nft_text_gate() { cat >/dev/null; sim_gate nft; }
l6b_trustedclock_gate() { sim_gate clock; }
'''

STAGE_GATE = r'''#!/usr/bin/env bash
echo "gate" >> "$SIM_DIR/calls.log"
[ "${SIM_GATE_FAIL:-}" = stage_gate ] && { echo STAGE_GATE=FAIL; exit 1; }
printf 'AUTHORIZATION_RECORD=VALID\nK3_CONFIRMATION=VALID\nROLLBACK_HANDLER=REGISTERED\nSTAGE_GATE=PASS_SIMULATION\n'
'''

CAPTURE = r'''#!/usr/bin/env bash
echo "capture:$CAPTURE_LABEL" >> "$SIM_DIR/calls.log"
grep -qx "capture_fail=$CAPTURE_LABEL" "$SIM_DIR/cfg" && exit 1
mkdir -p "$EVID_DIR"
echo "L0_CAPTURE=COMPLETE" > "$EVID_DIR/capture.log"
(cd "$EVID_DIR" && sha256sum capture.log > SHA256SUMS)
'''

COMPARE = r'''#!/usr/bin/env bash
kind=pre_post; case "$2" in *rb-root*) kind=pre_rb ;; esac
echo "compare:$kind allow=${ALLOW_KEYS_FILE:+yes}" >> "$SIM_DIR/calls.log"
grep -qx "compare_fail=$kind" "$SIM_DIR/cfg" && { echo "COMPARE_RESULT=FAIL"; echo "FINDINGS_NEW_OR_WORSENED_DRIFT=1"; exit 1; }
printf 'FINDINGS_NEW_OR_WORSENED_DRIFT=0\nFINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0\nFINDINGS_INCOMPARABLE=0\nPRESERVATION_S10=PASS\nCOMPARE_RESULT=PASS\n'
'''

HANDLER = r'''#!/usr/bin/env bash
name=$(basename "$0" .sh)
echo "$name" >> "$SIM_DIR/calls.log"
mkdir -p "$AEGIS_L7_WORK_DIR"
case "$name" in
  apply)
    if grep -qx "apply=fail_before" "$SIM_DIR/cfg"; then echo "L7_APPLY=FAIL reason=SIM" >&2; exit 1; fi
    echo YES > "$AEGIS_L7_WORK_DIR/production-mutation"
    if grep -qx "apply=fail_after" "$SIM_DIR/cfg"; then echo "L7_APPLY=FAIL reason=SIM" >&2; exit 1; fi
    echo "L7_APPLY=PASS"; ;;
  verify)
    grep -qx "verify=fail" "$SIM_DIR/cfg" && { echo "L7_VERIFY=FAIL reason=SIM" >&2; exit 1; }
    printf 'schema\t1\n' > "$AEGIS_L7_WORK_DIR/validation-evidence.tsv"
    grep -qx "verify=nozero" "$SIM_DIR/cfg" && { echo L7_VERIFY=PASS; exit 0; }
    printf 'L7_VERIFY=PASS\nL7_ZERO_ACTUATION=PASS\nL7_BROKER_CONNECTION=ESTABLISHED\n' ;;
  rollback)
    grep -qx "rollback=fail" "$SIM_DIR/cfg" && { echo "L7_ROLLBACK=FAIL reason=SIM" >&2; exit 1; }
    echo "L7_ROLLBACK=PASS" ;;
esac
'''


class Sim:
    def __init__(self, tmp: Path, cfg: list[str] | None = None, *, d6: bool = True, secret_in_evidence: bool = False) -> None:
        self.tmp = tmp
        self.dir = tmp / "sim"
        self.cfg = cfg or []
        self.repo = self.dir / "repo"
        self.p4 = self.repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4"
        self.evid_base = self.dir / "evidence"
        self.input = s.make_input(self.dir / "l7-owner-input")
        self.auth = self.dir / "auth"
        self.auth.mkdir(parents=True)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.secret_in_evidence = secret_in_evidence
        self.build(d6)

    def build(self, d6: bool) -> None:
        origin = make_repo(self.dir / "origin")  # receipts L2..L6b at HEAD
        subprocess.run(["git", "-C", str(origin), "branch", "-M", "main"], check=True, capture_output=True)
        shutil.copytree(origin, self.repo)
        (self.repo / "IDEA3-AEGIS_Lockdown").mkdir(exist_ok=True)
        shutil.copytree(ROOT / "aegis_soc", self.repo / "IDEA3-AEGIS_Lockdown/aegis_soc", ignore=shutil.ignore_patterns("__pycache__"))
        (self.p4 / "stages/L7").mkdir(parents=True)
        for name in ("allow-keys.txt", "allow-listeners.txt"):
            shutil.copy(ROOT / "deploy/pr11-phase4/stages/L7" / name, self.p4 / "stages/L7" / name)
        for name in ("apply.sh", "verify.sh", "rollback.sh"):
            (self.p4 / "stages/L7" / name).write_text(HANDLER)
        (self.p4 / "p4-l7-run-lib.sh").write_text(WRAPPER_LIB.replace("__REAL_LIB__", str(REAL_LIB)))
        (self.p4 / "p4-stage-gate.sh").write_text(STAGE_GATE)
        (self.p4 / "p4-l0-capture.sh").write_text(CAPTURE)
        (self.p4 / "p4-compare.sh").write_text(COMPARE)
        (self.p4 / "p4-l5-clock.py").write_text('print("state=SYNCED reason=OK maxerror_us=100 x=1")\n')
        git(self.repo, "checkout", "-q", "-B", "main")
        git(self.repo, "remote", "remove", "origin") if False else None
        subprocess.run(["git", "-C", str(self.repo), "remote", "remove", "origin"], capture_output=True)
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "sim")
        git(self.repo, "remote", "add", "origin", str(self.repo))
        git(self.repo, "fetch", "-q", "origin")
        self.head = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
        for name, body in STUB_BINS.items():
            f = self.bin / name
            f.write_text("#!/usr/bin/env bash\n" + body + "\n")
            f.chmod(0o755)
        (self.dir / "cfg").write_text("\n".join(self.cfg) + "\n")
        records = f"stage=L7\ndate={TODAY}\nauthorizer=music\nscope=sim\nreference=sim/ref\n"
        (self.auth / "authorization-L7.txt").write_text("AEGIS_P4_AUTHORIZATION_V1\n" + records + ("d6_notice=pub\n" if d6 else ""))
        (self.auth / "k3-L7.txt").write_text("AEGIS_P4_K3_CONFIRMATION_V2\n" + records)
        text = RUNNER.read_text()
        text = text.replace("PIN_MAIN_SHA", self.head).replace("RELEASE_ID=PIN_RELEASE_ID", f"RELEASE_ID={REL_ID}")
        text = text.replace("REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L7LIVE", f"REPO={self.repo}")
        text = text.replace("INPUT_DIR=/home/kittipat/Workspace/idea3-p4-evidence/l7-owner-input", f"INPUT_DIR={self.input}")
        text = text.replace("PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python", f"PY={sys.executable}")
        text = text.replace("EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l7-$STAMP", f"EVID={self.evid_base}/$TODAY-l7-$STAMP")
        self.runner = self.dir / "run-l7-owner.sh"
        self.runner.write_text(text)
        self.evid_base.mkdir()

    def run(self, **env: str) -> subprocess.CompletedProcess[str]:
        e = dict(os.environ, SIM_DIR=str(self.dir), PATH=f"{self.bin}:{os.environ['PATH']}", TZ="Asia/Bangkok")
        e.update(env)
        return subprocess.run(["bash", str(self.runner), str(self.auth)], text=True, capture_output=True, env=e, check=False)

    def calls(self) -> list[str]:
        f = self.dir / "calls.log"
        return [l.split()[0] for l in f.read_text().splitlines() if l.strip()] if f.exists() else []

    def evidence(self) -> list[Path]:
        return sorted(self.evid_base.iterdir())


@pytest.fixture()
def sim(tmp_path: Path) -> Sim:
    return Sim(tmp_path)


HAPPY = ["gate", "capture:pre", "apply", "verify", "capture:post", "compare:pre_post"]


def test_flow_success_runs_each_step_once_in_order_and_is_persistent(sim: Sim) -> None:
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert sim.calls() == HAPPY
    assert "L7_LIVE_ACCEPTANCE=PROVEN" in res.stdout and "L8_STARTED=NO" in res.stdout and "NOT deleted" in res.stdout
    assert (sim.auth / "L7-ATTEMPT-CONSUMED").is_file()
    assert (sim.input / "k_c2d").exists()  # the owner input is never deleted by the runner
    assert "rollback" not in "\n".join(sim.calls())


def test_flow_compare_uses_allow_files_only_for_pre_post(sim: Sim) -> None:
    assert sim.run().returncode == 0
    log = (sim.dir / "calls.log").read_text()
    assert "compare:pre_post allow=yes" in log


def test_flow_evidence_is_private_and_contains_only_non_secret_records(sim: Sim) -> None:
    assert sim.run().returncode == 0
    evid = sim.evidence()[0]
    assert (evid.stat().st_mode & 0o077) == 0
    for name in ("owner-run.log", "frozen-inputs.txt", "authorization-L7.txt", "k3-L7.txt", "journal_since.txt"):
        assert (evid / name).is_file(), name
    frozen = (evid / "frozen-inputs.txt").read_text()
    assert f"MAIN={sim.head}" in frozen and f"RELEASE={REL_ID}" in frozen and "RUNNER_SHA256=" in frozen
    for secret in s.SECRETS:
        assert secret not in "".join(p.read_text(errors="ignore") for p in evid.rglob("*") if p.is_file())


# ── pre-gates fail closed BEFORE the authorization is consumed ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("gate", ["release", "core_prestate", "broker", "tls_probe", "disk", "ap", "nft", "clock", "stage_gate"])
def test_flow_a_failing_pre_gate_consumes_nothing_and_changes_nothing(sim: Sim, gate: str) -> None:
    res = sim.run(SIM_GATE_FAIL=gate)
    assert res.returncode == 1 and "GATE_FAIL" in res.stderr and "NOTHING was created or changed" in res.stderr
    assert not (sim.auth / "L7-ATTEMPT-CONSUMED").exists()
    assert sim.evidence() == []
    assert not [c for c in sim.calls() if c.startswith(("capture", "apply", "verify", "rollback", "compare"))]


def test_flow_missing_d6_notice_in_the_authorization_blocks_before_consumption(tmp_path: Path) -> None:
    sim = Sim(tmp_path, d6=False)
    res = sim.run()
    assert res.returncode == 1 and "d6_notice=pub" in res.stderr
    assert not (sim.auth / "L7-ATTEMPT-CONSUMED").exists() and sim.evidence() == []


def test_flow_stale_or_wrong_stage_records_block(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.auth / "k3-L7.txt").write_text((sim.auth / "k3-L7.txt").read_text().replace(f"date={TODAY}", "date=2000-01-01"))
    res = sim.run()
    assert res.returncode == 1 and "date is not today" in res.stderr and not (sim.auth / "L7-ATTEMPT-CONSUMED").exists()


def test_flow_dirty_worktree_or_moved_head_blocks(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.repo / "stray.txt").write_text("x")
    res = sim.run()
    assert res.returncode == 1 and "worktree is not clean" in res.stderr and not (sim.auth / "L7-ATTEMPT-CONSUMED").exists()


def test_flow_missing_receipts_block(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    git(sim.repo, "rm", "-q", "-r", LOGS)
    git(sim.repo, "commit", "-q", "-m", "drop receipts")
    head = subprocess.run(["git", "-C", str(sim.repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    git(sim.repo, "fetch", "-q", "origin")
    sim.runner.write_text(sim.runner.read_text().replace(sim.head, head))
    res = sim.run()
    assert res.returncode == 1 and "predecessor receipt gate failed" in res.stderr


def test_flow_an_already_consumed_authorization_is_refused_without_any_action(sim: Sim) -> None:
    assert sim.run().returncode == 0
    before = sim.calls()
    again = sim.run()
    assert again.returncode == 1 and "already consumed" in again.stderr
    # only the read-only stage gate may run again; nothing mutating, no capture, no handler: never a retry
    assert sim.calls()[len(before):] == ["gate"]


# ── failure after consumption: bounded rollback, strict PRE->RB proof, never a retry ────────────────────────────────────


def assert_rolled_back_once(sim: Sim, res: subprocess.CompletedProcess[str]) -> None:
    calls = sim.calls()
    assert res.returncode == 1, res.stdout + res.stderr
    assert calls.count("rollback") == 1 and calls.count("apply") == 1 and calls.count("verify") <= 1
    assert calls[-2:] == ["capture:rb", "compare:pre_rb"]
    assert "compare:pre_rb allow=yes" not in (sim.dir / "calls.log").read_text()
    assert "NOT retrying" in res.stdout and "L7_LIVE_ACCEPTANCE=NOT_PROVEN" in res.stdout and "L7_LIVE_ACCEPTANCE=PROVEN" not in res.stdout
    assert (sim.auth / "L7-ATTEMPT-CONSUMED").is_file()


@pytest.mark.parametrize("cfg", [["apply=fail_after"], ["verify=fail"], ["verify=nozero"], ["capture_fail=post"], ["compare_fail=pre_post"]])
def test_flow_every_failure_after_the_first_mutation_rolls_back_exactly_once(tmp_path: Path, cfg: list[str]) -> None:
    sim = Sim(tmp_path, cfg)
    assert_rolled_back_once(sim, sim.run())


def test_flow_secret_output_scan_failure_rolls_back(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    # a handler that leaks the admin PIN into its (evidence-bound) output must be caught by the scan and rolled back
    handler = HANDLER.replace('echo YES > "$AEGIS_L7_WORK_DIR/production-mutation"', f'echo YES > "$AEGIS_L7_WORK_DIR/production-mutation"; echo "pin={s.ADMIN_PIN}"')
    (sim.p4 / "stages/L7/apply.sh").write_text(handler)
    git(sim.repo, "add", "-A")
    git(sim.repo, "commit", "-q", "-m", "leak")
    head = subprocess.run(["git", "-C", str(sim.repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    git(sim.repo, "fetch", "-q", "origin")
    sim.runner.write_text(sim.runner.read_text().replace(sim.head, head))
    res = sim.run()
    assert "SECRET_OUTPUT_SCAN failed" in res.stdout
    assert_rolled_back_once(sim, res)


def test_flow_legacy_or_predecessor_drift_after_apply_rolls_back(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.p4 / "stages/L7/verify.sh").write_text(HANDLER.replace('echo "$name" >> "$SIM_DIR/calls.log"', 'echo "$name" >> "$SIM_DIR/calls.log"; touch "$SIM_DIR/drift_legacy"'))
    git(sim.repo, "add", "-A")
    git(sim.repo, "commit", "-q", "-m", "drift")
    head = subprocess.run(["git", "-C", str(sim.repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    git(sim.repo, "fetch", "-q", "origin")
    sim.runner.write_text(sim.runner.read_text().replace(sim.head, head))
    res = sim.run()
    # legacy mosquitto cannot be rolled back by L7: the rollback runs once, but the strict PRE->RB proof then fails and escalates
    assert res.returncode == 3 and "preservation failed" in res.stdout and "PRE_RB_COMPARE=FAIL" in res.stdout and "do NOT retry" in res.stdout
    assert sim.calls().count("rollback") == 1 and sim.calls().count("apply") == 1


def test_flow_apply_failure_before_any_mutation_needs_no_rollback_handler_but_proves_zero_drift(tmp_path: Path) -> None:
    sim = Sim(tmp_path, ["apply=fail_before"])
    res = sim.run()
    calls = sim.calls()
    assert res.returncode == 1 and "NO_PRODUCTION_MUTATION_MARKER" in res.stdout
    assert "rollback" not in calls and calls[-2:] == ["capture:rb", "compare:pre_rb"] and calls.count("apply") == 1


def test_flow_a_failed_rollback_holds_and_never_retries(tmp_path: Path) -> None:
    sim = Sim(tmp_path, ["apply=fail_after", "rollback=fail"])
    res = sim.run()
    assert res.returncode == 3 and "S-11 HOLD" in res.stdout and "do NOT retry" in res.stdout
    assert sim.calls().count("rollback") == 1 and "capture:rb" not in sim.calls()


@pytest.mark.parametrize("cfg,what", [(["apply=fail_after", "capture_fail=rb"], "RB capture FAILED"),
                                       (["apply=fail_after", "compare_fail=pre_rb"], "PRE_RB_COMPARE=FAIL")])
def test_flow_a_failed_pre_rb_proof_escalates_with_exit_3(tmp_path: Path, cfg: list[str], what: str) -> None:
    sim = Sim(tmp_path, cfg)
    res = sim.run()
    assert res.returncode == 3 and what in res.stdout and sim.calls().count("rollback") == 1


def test_flow_failed_pre_capture_stops_before_any_mutation(tmp_path: Path) -> None:
    sim = Sim(tmp_path, ["capture_fail=pre"])
    res = sim.run()
    assert res.returncode == 1 and "PRE capture failed; nothing changed" in res.stdout
    assert "apply" not in sim.calls() and "rollback" not in sim.calls()


def test_flow_interrupt_after_mutation_rolls_back_via_the_trap(tmp_path: Path) -> None:
    """A signal during the run takes the same bounded rollback path (verified with a verify stub that kills its parent shell)."""
    sim = Sim(tmp_path)
    (sim.p4 / "stages/L7/verify.sh").write_text(HANDLER.replace('echo "$name" >> "$SIM_DIR/calls.log"', 'echo "$name" >> "$SIM_DIR/calls.log"; kill -TERM $PPID; sleep 1'))
    git(sim.repo, "add", "-A")
    git(sim.repo, "commit", "-q", "-m", "int")
    head = subprocess.run(["git", "-C", str(sim.repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()
    git(sim.repo, "fetch", "-q", "origin")
    sim.runner.write_text(sim.runner.read_text().replace(sim.head, head))
    res = sim.run()
    assert sim.calls().count("rollback") == 1 and (sim.auth / "L7-ATTEMPT-CONSUMED").is_file()
    assert "L7_LIVE_ACCEPTANCE=PROVEN" not in res.stdout


# ── stage-gate contract for A-L7 / K3 (the REAL p4-stage-gate.sh, simulation mode; it calls no host command) ─────────────


def stage_gate(tmp: Path, *, d6: str | None, mode: str = "live"):
    records = f"stage=L7\ndate={TODAY}\nauthorizer=music\nscope=sim\nreference=sim/ref\n"
    auth = tmp / "a.txt"
    auth.write_text("AEGIS_P4_AUTHORIZATION_V1\n" + records + (f"d6_notice={d6}\n" if d6 else ""))
    k3 = tmp / "k.txt"
    k3.write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage=L7\ndate={TODAY}\nreference=sim/ref\nconfirmed_by=music\n"
                  "confirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\nidea1_window_overlap=NONE_KNOWN\n")
    return subprocess.run(["bash", str(ROOT / "deploy/pr11-phase4/p4-stage-gate.sh"), "--stage", "L7", "--mode", mode, "--authorization", str(auth), "--k3", str(k3)],
                          text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok"))


def test_real_stage_gate_requires_d6_notice_pub_for_l7(tmp_path: Path) -> None:
    ok = stage_gate(tmp_path, d6="pub")
    assert ok.returncode == 0, ok.stdout
    for line in ("AUTHORIZATION_RECORD=VALID", "K3_CONFIRMATION=VALID", "ROLLBACK_HANDLER=REGISTERED"):
        assert line in ok.stdout.splitlines()
    assert "LIVE_STAGE_AUTHORIZED=NO" in ok.stdout  # the gate is necessary, never sufficient
    for bad in (None, "kla", "pub extra"):
        res = stage_gate(tmp_path / f"b{bad}", d6=bad) if (tmp_path / f"b{bad}").mkdir() is None else None
        assert res.returncode == 1 and "AUTHORIZATION_" in res.stdout, bad
