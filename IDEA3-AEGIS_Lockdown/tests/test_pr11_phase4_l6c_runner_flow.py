# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L6c owner-runner CONTROL-FLOW simulation.

The real run-l6c-owner.sh is executed, unmodified apart from its frozen constants, inside a sandbox: `sudo`, `systemctl`,
`ss` and friends are stubs, the stage handlers / capture / compare / stage gate are recording stubs, and the
stage-independent host-gate functions are overridden by a wrapper library. This proves the runner's ORDER and FAILURE
SEMANTICS — in particular the 2026-09-27 fix (issue 1): PRE capture is itself part of the read-only gate sequence and
completes BEFORE the one-shot authorization is consumed; a failed PRE capture never consumes A-L6c.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import l6c_support as s  # noqa: E402
from test_pr11_phase4_l7_runner import LOGS, git, make_repo  # noqa: E402
from test_pr11_phase4_l7_release_guard_helper import build_release  # noqa: E402

ROOT = s.ROOT
RUNNER = ROOT / "deploy" / "pr11-phase4" / "owner-run" / "run-l6c-owner.sh"
REAL_LIB = ROOT / "deploy" / "pr11-phase4" / "p4-l6c-run-lib.sh"
REL_ID = "rel-l6c-sim"
TODAY = subprocess.run(["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).stdout.strip()

STUB_BINS = {
    "sudo": '[ "$1" = -v ] && exit 0\nexec "$@"',
    "systemctl": r'''prop=$3; unit=$5
case "$prop" in
  ActiveState) echo active ;; SubState) echo running ;; UnitFileState) echo enabled ;; NRestarts) echo 0 ;; Result) echo success ;;
  MainPID) echo 4242 ;;
esac''',
    "ss": 'echo "LISTEN 0 100 0.0.0.0:1883 0.0.0.0:*"',
    "sysctl": 'echo 0',
}

WRAPPER_LIB = r'''#!/usr/bin/env bash
source "__REAL_LIB__"
sim_gate() { [ "${SIM_GATE_FAIL:-}" = "$1" ] && { echo "SIM_GATE_FAIL:$1" >&2; return 1; }; echo "$1" >> "$SIM_DIR/gates.log"; return 0; }
l6c_receipt_gate() { sim_gate receipt; }
l7_broker_runtime_gate() { sim_gate broker; }
l6c_release_source_gate() { sim_gate source_gate && echo "L6C_SOURCE_SHA=$(printf 'a%.0s' {1..40})"; }
l6c_target_absent_gate() { sim_gate target_absent; }
l7_disk_gate() { sim_gate disk; }
l7_idea2_s10_gate() { sim_gate idea2; }
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
if grep -qx "sha_fail=$CAPTURE_LABEL" "$SIM_DIR/cfg"; then echo "corrupted" >> "$EVID_DIR/capture.log"; fi
exit 0
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
mkdir -p "$AEGIS_L6C_WORK_DIR"
case "$name" in
  apply)
    [ -f "$SIM_AUTH_DIR/L6C-ATTEMPT-CONSUMED" ] || { echo "L6C_APPLY=FAIL reason=MARKER_ABSENT" >&2; exit 1; }
    if grep -qx "apply=fail_before" "$SIM_DIR/cfg"; then echo "L6C_APPLY=FAIL reason=SIM" >&2; exit 1; fi
    echo YES > "$AEGIS_L6C_WORK_DIR/production-mutation"
    if grep -qx "apply=fail_after" "$SIM_DIR/cfg"; then echo "L6C_APPLY=FAIL reason=SIM" >&2; exit 1; fi
    echo "L6C_APPLY=PASS" ;;
  verify)
    grep -qx "verify=fail" "$SIM_DIR/cfg" && { echo "L6C_VERIFY=FAIL reason=SIM" >&2; exit 1; }
    echo "L6C_VERIFY=PASS" ;;
  rollback)
    grep -qx "rollback=fail" "$SIM_DIR/cfg" && { echo "L6C_ROLLBACK=FAIL reason=SIM" >&2; exit 1; }
    echo "L6C_ROLLBACK=PASS" ;;
esac
'''


class Sim:
    def __init__(self, tmp: Path, cfg: list[str] | None = None) -> None:
        self.tmp = tmp
        self.dir = tmp / "sim"
        self.cfg = cfg or []
        self.repo = self.dir / "repo"
        self.p4 = self.repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4"
        self.evid_base = self.dir / "evidence"
        self.auth = self.dir / "auth"
        self.auth.mkdir(parents=True)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.source = build_release(self.dir / "staging", release_id=REL_ID, sha="a" * 40)
        self.build()

    def build(self) -> None:
        origin = make_repo(self.dir / "origin")
        subprocess.run(["git", "-C", str(origin), "branch", "-M", "main"], check=True, capture_output=True)
        shutil.copytree(origin, self.repo)
        (self.p4 / "stages/L6c").mkdir(parents=True)
        for name in ("allow-keys.txt", "allow-listeners.txt"):
            shutil.copy(ROOT / "deploy/pr11-phase4/stages/L6c" / name, self.p4 / "stages/L6c" / name)
        for name in ("apply.sh", "verify.sh", "rollback.sh"):
            (self.p4 / "stages/L6c" / name).write_text(HANDLER)
        (self.p4 / "p4-l6c-run-lib.sh").write_text(WRAPPER_LIB.replace("__REAL_LIB__", str(REAL_LIB)))
        (self.p4 / "p4-stage-gate.sh").write_text(STAGE_GATE)
        (self.p4 / "p4-l0-capture.sh").write_text(CAPTURE)
        (self.p4 / "p4-compare.sh").write_text(COMPARE)
        git(self.repo, "checkout", "-q", "-B", "main")
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
        records = f"stage=L6c\ndate={TODAY}\nauthorizer=music\nscope=sim\nreference=sim/ref\n"
        (self.auth / "authorization-L6c.txt").write_text("AEGIS_P4_AUTHORIZATION_V1\n" + records)
        (self.auth / "k3-L6c.txt").write_text("AEGIS_P4_K3_CONFIRMATION_V2\n" + records)
        text = RUNNER.read_text()
        text = text.replace("PIN_MAIN_SHA", self.head).replace("RELEASE_ID=PIN_RELEASE_ID", f"RELEASE_ID={REL_ID}")
        text = text.replace("EXPECTED_SOURCE_SHA=PIN_SOURCE_SHA", f'EXPECTED_SOURCE_SHA="{"a" * 40}"')
        text = text.replace("REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L6CLIVE", f"REPO={self.repo}")
        text = text.replace("SOURCE_DIR=/home/kittipat/Workspace/idea3-p4-evidence/l6c-owner-source/$RELEASE_ID", f"SOURCE_DIR={self.source}")
        text = text.replace("PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python", f"PY={sys.executable}")
        text = text.replace("EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l6c-$STAMP", f"EVID={self.evid_base}/$TODAY-l6c-$STAMP")
        self.runner = self.dir / "run-l6c-owner.sh"
        self.runner.write_text(text)
        self.evid_base.mkdir()

    def run(self, **env: str) -> subprocess.CompletedProcess[str]:
        e = dict(os.environ, SIM_DIR=str(self.dir), SIM_AUTH_DIR=str(self.auth),
                 PATH=f"{self.bin}:{os.environ['PATH']}", TZ="Asia/Bangkok")
        e.update(env)
        return subprocess.run(["bash", str(self.runner), str(self.auth)], text=True, capture_output=True, env=e, check=False)

    def calls(self) -> list[str]:
        f = self.dir / "calls.log"
        return [l.split()[0] for l in f.read_text().splitlines() if l.strip()] if f.exists() else []

    def evidence(self) -> list[Path]:
        return sorted(self.evid_base.iterdir()) if self.evid_base.exists() else []

    def marker(self) -> bool:
        return (self.auth / "L6C-ATTEMPT-CONSUMED").exists()


@pytest.fixture()
def sim(tmp_path: Path) -> Sim:
    return Sim(tmp_path)


HAPPY = ["gate", "capture:pre", "apply", "verify", "capture:post", "compare:pre_post"]


def test_flow_success_runs_each_step_once_in_order_and_is_persistent(sim: Sim) -> None:
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert sim.calls() == HAPPY
    assert "L6C_LIVE_ACCEPTANCE=PROVEN" in res.stdout and "L7_STARTED=NO" in res.stdout
    assert sim.marker()
    assert "rollback" not in "\n".join(sim.calls())


# ── issue 1: PRE capture is part of the gate sequence and precedes consumption ──────────────────────────────────────────


def test_flow_pre_capture_happens_before_consumption_in_call_order(sim: Sim) -> None:
    assert sim.run().returncode == 0
    calls = sim.calls()
    assert calls.index("capture:pre") < calls.index("apply")  # apply only ever follows consumption (see marker test)


def test_flow_failed_pre_capture_leaves_the_attempt_marker_absent(tmp_path: Path) -> None:
    sim = Sim(tmp_path, ["capture_fail=pre"])
    res = sim.run()
    assert res.returncode == 1
    assert "Production mutation = NO" in res.stdout and "NOT consumed" in res.stdout
    assert not sim.marker()
    assert "apply" not in sim.calls() and "rollback" not in sim.calls()


def test_flow_failed_pre_capture_sha256_leaves_the_attempt_marker_absent(tmp_path: Path) -> None:
    sim = Sim(tmp_path, ["sha_fail=pre"])
    res = sim.run()
    assert res.returncode == 1
    assert not sim.marker()
    assert "apply" not in sim.calls()


def test_flow_successful_pre_then_consumption_creates_the_marker_before_apply(sim: Sim) -> None:
    res = sim.run()
    assert res.returncode == 0
    assert sim.marker()
    calls = sim.calls()
    assert calls[calls.index("capture:pre") + 1] == "apply"  # nothing else external runs between PRE and apply


def test_flow_apply_cannot_occur_before_the_marker_exists(sim: Sim) -> None:
    """Static proof, complementing the dynamic one above: the marker call precedes apply in the script itself."""
    text = RUNNER.read_text()
    assert text.index("l6c_consume_attempt") < text.index('handler apply.sh')
    assert text.index("capture PRE") < text.index("l6c_consume_attempt")


def test_flow_release_allow_file_is_prepared_before_pre_and_not_after_consumption() -> None:
    text = RUNNER.read_text()
    allow_write = text.index("printf 'stage L6c\\nrelease_id %s\\n'")
    pre_capture = text.index('capture PRE "$EVID/pre-root"')
    consume = text.index('l6c_consume_attempt "$AUTH_DIR"')
    apply = text.index("handler apply.sh")
    assert allow_write < pre_capture < consume < apply
    assert "printf 'stage L6c" not in text[consume:apply]


def test_flow_a_second_attempt_after_a_successful_run_still_fails_closed(sim: Sim) -> None:
    assert sim.run().returncode == 0
    before = sim.calls()
    again = sim.run()
    assert again.returncode == 1 and "already consumed" in again.stderr
    assert sim.calls()[len(before):] == ["gate"]  # only the read-only stage gate ran again; no capture, no apply, no retry


def test_flow_no_automatic_retry_on_a_failed_pre_capture() -> None:
    text = "\n".join(l for l in RUNNER.read_text().splitlines() if not l.lstrip().startswith("#"))
    assert not re.search(r"\b(while|until)\b", text)


# ── everything else (rollback flow, evidence, gate ordering) mirrors the L7 flow suite ───────────────────────────────────


def assert_rolled_back_once(sim: Sim, res: subprocess.CompletedProcess[str]) -> None:
    calls = sim.calls()
    assert res.returncode == 1, res.stdout + res.stderr
    assert calls.count("rollback") == 1 and calls.count("apply") == 1
    assert calls[-2:] == ["capture:rb", "compare:pre_rb"]
    assert "compare:pre_rb allow=yes" not in (sim.dir / "calls.log").read_text()
    assert "NOT retrying" in res.stdout and "L6C_LIVE_ACCEPTANCE=PROVEN" not in res.stdout
    assert sim.marker()


@pytest.mark.parametrize("cfg", [["apply=fail_after"], ["verify=fail"], ["capture_fail=post"], ["compare_fail=pre_post"]])
def test_flow_every_failure_after_the_first_mutation_rolls_back_exactly_once(tmp_path: Path, cfg: list[str]) -> None:
    sim = Sim(tmp_path, cfg)
    assert_rolled_back_once(sim, sim.run())


def test_flow_apply_failure_before_any_mutation_needs_no_rollback_handler(tmp_path: Path) -> None:
    sim = Sim(tmp_path, ["apply=fail_before"])
    res = sim.run()
    calls = sim.calls()
    assert res.returncode == 1 and "NO_PRODUCTION_MUTATION_MARKER" in res.stdout
    assert "rollback" not in calls and calls[-2:] == ["capture:rb", "compare:pre_rb"]


def test_flow_a_failed_rollback_holds_and_never_retries(tmp_path: Path) -> None:
    sim = Sim(tmp_path, ["apply=fail_after", "rollback=fail"])
    res = sim.run()
    assert res.returncode == 3 and "S-11 HOLD" in res.stdout and "do NOT retry" in res.stdout
    assert sim.calls().count("rollback") == 1 and "capture:rb" not in sim.calls()


@pytest.mark.parametrize("gate", ["receipt", "broker", "source_gate", "target_absent", "disk", "idea2", "stage_gate"])
def test_flow_a_failing_pre_gate_consumes_nothing(tmp_path: Path, gate: str) -> None:
    sim = Sim(tmp_path)
    res = sim.run(SIM_GATE_FAIL=gate)
    assert res.returncode == 1 and "GATE_FAIL" in res.stderr
    assert not sim.marker() and sim.evidence() == []
