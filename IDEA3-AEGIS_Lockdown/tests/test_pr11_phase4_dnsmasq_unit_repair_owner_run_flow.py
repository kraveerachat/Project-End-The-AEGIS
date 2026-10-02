# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — governed dnsmasq unit repair: owner-run CONTROL-FLOW simulation.

The real run-dnsmasq-unit-boot-order-repair-owner.sh is executed, unmodified apart from its frozen constants, inside a sandbox: `sudo`, `systemctl` and the other
host commands are stubs, and the gate functions come from the REAL, unmodified libraries (only p4-stage-gate.sh / p4-l0-capture.sh / p4-compare.sh and the
handler scripts are stand-ins). This proves the runner refuses wrong main / stale authorization / stale K3 / a reused or foreign attempt marker / an unresolved
or refused handler preflight, consumes the one-shot marker only after preflight and the PRE capture and immediately before the first mutation, rolls back on any
failure after consumption, never retries, and emits the explicit terminal verdict. The handler bodies are covered by test_pr11_phase4_dnsmasq_unit_repair.py.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
RUNNER = DEPLOY / "owner-run" / "run-dnsmasq-unit-boot-order-repair-owner.sh"
HND_NAME = "dnsmasq-unit-boot-order-repair"
LIBS = ("p4-l34-reactivation-lib.sh", "p4-l34-v8-lib.sh", "p4-dnsmasq-repair-lib.sh")
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
TODAY = subprocess.run(["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).stdout.strip()
YESTERDAY = subprocess.run(["date", "-d", "yesterday", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).stdout.strip()
PSK = "CANARY-wifi-psk-4f9a8b7c6d5e"
PR305 = "827251f2478f03822c42ab43eadb50f73005d432"

EXPECTED_SCOPE = (
    "DNSMASQ_UNIT_BOOT_ORDER_REPAIR: install canonical rendered dnsmasq unit, daemon-reload, dnsmasq reset-failed/start or restart only; "
    "no AP, network, broker, Core or ESP32 change"
)
HEALTHY = {"ActiveState": "active", "SubState": "running", "LoadState": "loaded", "Result": "success", "MainPID": "883", "NRestarts": "0"}
VERDICT_LINES = (
    "DNSMASQ_REPAIR_APPLIED=YES", "DNSMASQ_UNIT_AUTHORITY=PASS", "DNSMASQ_ACTIVE=YES", "DNSMASQ_RUNNING=YES", "DNSMASQ_START_LIMIT_HIT=NO", "AP_MODE=PASS",
    "AP_SSID=PASS", "AP_CHANNEL=PASS", "AP_IPV4_PREFIX=PASS", "CORE_HEALTH=PASS", "BROKER_UNCHANGED=PASS", "FORWARDING_POLICY=PASS", "ESP32_TOUCHED=NO",
)

HANDLER = r'''#!/usr/bin/env bash
name=$(basename "$0" .sh)
echo "$name" >> "$SIM_DIR/calls.log"
mkdir -p "$AEGIS_DNSREPAIR_WORK_DIR"
marker_state() { if [ -e "$(cat "$SIM_DIR/marker-path")" ]; then echo yes; else echo no; fi; }
case "$name" in
  apply)
    if [ "${AEGIS_DNSREPAIR_PREFLIGHT_ONLY:-NO}" = YES ]; then
      echo "marker@preflight:$(marker_state)" >> "$SIM_DIR/calls.log"
      [ ! -e "$SIM_DIR/fail-preflight" ] || { echo "DNSMASQ_REPAIR_APPLY=FAIL reason=$(cat "$SIM_DIR/fail-preflight")" >&2; exit 1; }
      echo "DNSMASQ_REPAIR_BASELINE=$(cat "$SIM_DIR/baseline")"; echo "DNSMASQ_REPAIR_PREFLIGHT=PASS"; exit 0
    fi
    echo "marker@apply:$(marker_state)" >> "$SIM_DIR/calls.log"
    echo YES > "$AEGIS_DNSREPAIR_WORK_DIR/production-mutation"
    [ ! -e "$SIM_DIR/fail-apply" ] || { echo "DNSMASQ_REPAIR_APPLY=FAIL reason=SIM" >&2; exit 1; }
    echo "DNSMASQ_REPAIR_APPLY=PASS" ;;
  verify)
    [ ! -e "$SIM_DIR/fail-verify" ] || { echo "DNSMASQ_REPAIR_VERIFY=FAIL reason=SIM" >&2; exit 1; }
    echo "DNSMASQ_REPAIR_VERIFY=PASS"
    cat "$SIM_DIR/verify-lines" ;;
  rollback)
    [ ! -e "$SIM_DIR/fail-rollback" ] || { echo "DNSMASQ_REPAIR_ROLLBACK=FAIL reason=SIM" >&2; exit 1; }
    echo "DNSMASQ_REPAIR_ROLLBACK=PASS" ;;
esac
'''
CAPTURE = ('#!/usr/bin/env bash\necho "capture:$CAPTURE_LABEL" >> "$SIM_DIR/calls.log"\n'
           'if [ -e "$(cat "$SIM_DIR/marker-path")" ]; then echo "marker@capture-$CAPTURE_LABEL:yes" >> "$SIM_DIR/calls.log"; else echo "marker@capture-$CAPTURE_LABEL:no" >> "$SIM_DIR/calls.log"; fi\n'
           '[ ! -e "$SIM_DIR/fail-capture-$CAPTURE_LABEL" ] || exit 1\nmkdir -p "$EVID_DIR"\necho "L0_CAPTURE=COMPLETE" > "$EVID_DIR/capture.log"\n(cd "$EVID_DIR" && sha256sum capture.log > SHA256SUMS)\n')
COMPARE = ('#!/usr/bin/env bash\necho "compare:$*" >> "$SIM_DIR/calls.log"\nenv | grep -E "^ALLOW_" >> "$SIM_DIR/calls.log"\n'
           '[ ! -e "$SIM_DIR/fail-compare-$(basename "$1")-$(basename "$2")" ] || { echo "COMPARE_RESULT=FAIL"; exit 1; }\n'
           "printf 'FINDINGS_NEW_OR_WORSENED_DRIFT=0\\nFINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0\\nFINDINGS_INCOMPARABLE=0\\nPRESERVATION_S10=PASS\\nCOMPARE_RESULT=PASS\\n'\n")
STAGE_GATE = "#!/usr/bin/env bash\nprintf 'AUTHORIZATION_RECORD=VALID\\nK3_CONFIRMATION=VALID\\n'\n"


def _systemctl_stub() -> str:
    block = "\n".join(f'      {k}) echo "{v}" ;;' for k, v in HEALTHY.items())
    return r'''#!/usr/bin/env bash
shift
keys=(); value_mode=0; unit=""
while [ $# -gt 0 ]; do
  case "$1" in -p) keys+=("$2"); shift 2 ;; --value) value_mode=1; shift ;; *) unit=$1; shift ;; esac
done
for k in "${keys[@]}"; do
  case "$k" in
''' + block + r'''
  esac | { read -r v; if [ "$value_mode" = 1 ]; then printf '%s\n' "$v"; else printf '%s=%s\n' "$k" "$v"; fi; }
done
'''


class Sim:
    def __init__(self, tmp: Path, *, scope: str = EXPECTED_SCOPE, baseline: str = "FAILED", pr305_in_history: bool = True) -> None:
        self.dir = tmp / "sim"
        self.repo = self.dir / "repo"
        self.origin = self.dir / "origin.git"
        self.p4 = self.repo / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
        self.evid_base = self.dir / "evidence"
        self.auth = self.dir / "auth"
        self.auth.mkdir(parents=True)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.profile = self.dir / "profile.nmconnection"
        self.profile.write_text(f"[wifi-security]\npsk={PSK}\n")
        self.scope, self.baseline, self.pr305_in_history = scope, baseline, pr305_in_history
        self.build()

    def git(self, *args: str, cwd: Path | None = None) -> str:
        env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
        return subprocess.run(["git", "-C", str(cwd or self.repo), *args], check=True, capture_output=True, text=True, env=env).stdout.strip()

    def build(self) -> None:
        self.p4.mkdir(parents=True)
        for lib in LIBS:
            shutil.copy(DEPLOY / lib, self.p4 / lib)
        (self.p4 / "p4-stage-gate.sh").write_text(STAGE_GATE)
        (self.p4 / "p4-l0-capture.sh").write_text(CAPTURE)
        (self.p4 / "p4-compare.sh").write_text(COMPARE)
        hnd = self.p4 / "reactivation" / HND_NAME
        hnd.mkdir(parents=True)
        for name in ("apply.sh", "verify.sh", "rollback.sh"):
            (hnd / name).write_text(HANDLER)
        for name in ("allow-keys.txt", "allow-keys-rollback.txt", "allow-listeners.txt", "allow-dynamic-transitions-failed-post.txt",
                     "allow-dynamic-transitions-failed-rollback.txt"):
            (hnd / name).write_text("")
        (self.repo / LOGS).mkdir(parents=True)
        (self.repo / LOGS / ".keep").write_text("")
        self.git("init", "-q")
        self.git("checkout", "-q", "-B", "main")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "pr305-stand-in")
        pr305 = self.git("rev-parse", "HEAD")
        (self.repo / "README.sim").write_text("later change\n")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "later")
        self.head = self.git("rev-parse", "HEAD")
        # the runner-visible PR305 constant is the stand-in commit, so the REAL ancestry gate is exercised; the negative control points it outside history
        lib = self.p4 / "p4-dnsmasq-repair-lib.sh"
        text = lib.read_text().replace(f"DNSREPAIR_PR305_MERGE={PR305}", f"DNSREPAIR_PR305_MERGE={pr305 if self.pr305_in_history else '1' * 40}")
        lib.write_text(text)
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "pin constants")
        self.head = self.git("rev-parse", "HEAD")
        subprocess.run(["git", "init", "-q", "--bare", str(self.origin)], check=True, capture_output=True)
        self.git("remote", "add", "origin", str(self.origin))
        self.git("push", "-q", "origin", "main")
        self.git("fetch", "-q", "origin")

        (self.bin / "sudo").write_text('#!/usr/bin/env bash\n[ "$1" = -v ] && exit 0\nexec "$@"\n')
        (self.bin / "systemctl").write_text(_systemctl_stub())
        for name in ("nmcli", "iw", "ip", "nft", "sysctl", "ss", "dnsmasq", "journalctl", "systemd-analyze"):
            (self.bin / name).write_text("#!/usr/bin/env bash\nexit 0\n")
        for f in self.bin.iterdir():
            f.chmod(0o755)
        self.write_auth(TODAY, TODAY)
        (self.dir / "baseline").write_text(self.baseline + "\n")
        (self.dir / "verify-lines").write_text("\n".join(VERDICT_LINES) + "\n")

        text = RUNNER.read_text()
        text = text.replace("EXPECTED_MAIN=PIN_MAIN_SHA", f"EXPECTED_MAIN={self.head}")
        text = text.replace("REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-DNSMASQREPAIRLIVE   # clean pinned execution worktree at merged main",
                            f"REPO={self.repo}")
        text = text.replace("PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python", f"PY={sys.executable}")
        text = text.replace("PROFILE=/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection", f"PROFILE={self.profile}")
        text = text.replace("EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-dnsmasq-unit-repair-$STAMP", f"EVID={self.evid_base}/$TODAY-dnsmasq-unit-repair-$STAMP")
        assert str(self.repo) in text and str(self.evid_base) in text and self.head in text, "the freeze substitution must have applied"
        self.runner = self.dir / "run-dnsmasq-repair-owner.sh"
        self.runner.write_text(text)
        self.evid_base.mkdir()
        (self.dir / "marker-path").write_text(str(self.auth / "DNSMASQ-UNIT-REPAIR-ATTEMPT-CONSUMED"))

    def write_auth(self, auth_date: str, k3_date: str, *, stage: str = "L4", k3_stage: str = "L4") -> None:
        (self.auth / "authorization-L4.txt").write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage={stage}\ndate={auth_date}\nauthorizer=music\nscope={self.scope}\nreference=sim/ref\n")
        (self.auth / "k3-L4.txt").write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage={k3_stage}\ndate={k3_date}\nconfirmed_by=music\nreference=sim/ref\n")

    def run(self) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ, SIM_DIR=str(self.dir), PATH=f"{self.bin}:{os.environ['PATH']}", TZ="Asia/Bangkok")
        return subprocess.run(["bash", str(self.runner), str(self.auth)], text=True, capture_output=True, env=env, check=False)

    def inject(self, name: str, text: str = "1") -> None:
        (self.dir / name).write_text(text + "\n")

    def clear(self, name: str) -> None:
        (self.dir / name).unlink()

    def marker(self) -> bool:
        return (self.auth / "DNSMASQ-UNIT-REPAIR-ATTEMPT-CONSUMED").exists()

    def calls(self) -> list[str]:
        return (self.dir / "calls.log").read_text().splitlines() if (self.dir / "calls.log").exists() else []

    def handler_calls(self) -> list[str]:
        return [c for c in self.calls() if c in ("apply", "verify", "rollback")]

    def verdict(self) -> str:
        files = list(self.evid_base.rglob("terminal-verdict.txt"))
        return files[0].read_text() if files else ""


def test_runner_is_unpinned_as_committed() -> None:
    res = subprocess.run(["bash", str(RUNNER), "/nonexistent"], text=True, capture_output=True, check=False)
    assert res.returncode == 2 and "runner is not pinned" in res.stdout


def test_full_flow_succeeds_and_emits_the_explicit_terminal_verdict(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert sim.marker() and sim.handler_calls() == ["apply", "apply", "verify"], "preflight, apply once, verify; no rollback"
    verdict = sim.verdict().splitlines()
    for want in (*VERDICT_LINES, "UNEXPECTED_DRIFT=NONE", "DNSMASQ_REPAIR_RESULT=PASS", "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN", "REBOOT_VERIFICATION_EXECUTED=NO"):
        assert want in verdict, (want, verdict)
    out = res.stdout
    assert "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN" in out and "CORE_RESTARTED=NO" in out
    assert "K12_PERSISTENCE_OBSERVED" not in out and "K12_FORMALLY_PROVEN=YES" not in out, "the repair run makes no K12 claim"


@pytest.mark.parametrize("baseline,has_dynamic", [("FAILED", True), ("RUNNING", False)])
def test_compare_uses_only_the_repair_catalogs_and_the_dynamic_window_only_for_the_failed_baseline(tmp_path: Path, baseline: str, has_dynamic: bool) -> None:
    sim = Sim(tmp_path, baseline=baseline)
    assert sim.run().returncode == 0
    calls = "\n".join(sim.calls())
    assert f"ALLOW_KEYS_FILE={sim.p4}/reactivation/{HND_NAME}/allow-keys.txt" in calls
    assert f"ALLOW_LISTENERS_FILE={sim.p4}/reactivation/{HND_NAME}/allow-listeners.txt" in calls
    assert (f"ALLOW_DYNAMIC_TRANSITIONS_FILE={sim.p4}/reactivation/{HND_NAME}/allow-dynamic-transitions-failed-post.txt" in calls) == has_dynamic
    assert "ALLOW_TRANSITIONS_FILE" not in calls.replace("ALLOW_DYNAMIC_TRANSITIONS_FILE", ""), "no regulatory transition is ever approved"
    assert "/reactivation/l34" not in calls, "no other stage's catalog is used"


# ── pre-gate refusals: nothing is created, mutated or consumed ──────────────────────────────────────────────────────────

def _refused(sim: Sim, needle: str) -> None:
    res = sim.run()
    assert res.returncode == 1 and needle in res.stderr, res.stdout + res.stderr
    assert "DNSMASQ_REPAIR_RESULT=NOT_STARTED_NO_MUTATION" in res.stdout + res.stderr
    assert not sim.marker() and sim.calls() == [] and not list(sim.evid_base.iterdir())


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


def test_a_pinned_commit_without_pr305_is_refused(tmp_path: Path) -> None:
    sim = Sim(tmp_path, pr305_in_history=False)
    _refused(sim, "is not an ancestor")


def test_stale_authorization_is_refused(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.write_auth(YESTERDAY, TODAY)
    _refused(sim, "authorization-L4.txt date is not today")


def test_stale_k3_is_refused(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.write_auth(TODAY, YESTERDAY)
    _refused(sim, "k3-L4.txt date is not today")


@pytest.mark.parametrize("kw", [dict(stage="L7"), dict(k3_stage="L7")], ids=["auth-stage", "k3-stage"])
def test_another_stage_record_is_refused(tmp_path: Path, kw: dict) -> None:
    sim = Sim(tmp_path)
    sim.write_auth(TODAY, TODAY, **kw)
    _refused(sim, "is not stage=L4")


@pytest.mark.parametrize("scope", [
    "L3_L4_RUNTIME_RECOVERY_V8_POST_V7_PERSISTENT_AP: rfkill and radio on once, AP profile autoconnect no->yes once, one ifname-bound AP up, one dnsmasq start; no broker or Core control",
    "L3_L4_RUNTIME_REACTIVATION_V3: rfkill 1 unblock",
    EXPECTED_SCOPE + " and restart the broker",
])
def test_a_historical_or_widened_scope_is_refused(tmp_path: Path, scope: str) -> None:
    _refused(Sim(tmp_path, scope=scope), "authorization scope is not exactly the approved dnsmasq repair scope")


def test_a_consumed_attempt_is_refused_and_never_retried(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert sim.run().returncode == 0
    before = len(sim.calls())
    second = sim.run()
    assert second.returncode == 1 and "already consumed its one bounded attempt" in second.stderr
    assert len(sim.calls()) == before, "a replay must not even run the preflight"


@pytest.mark.parametrize("name", ["L34-V8-REACTIVATION-ATTEMPT-CONSUMED", "L34-V7-REACTIVATION-ATTEMPT-CONSUMED", "L34-REACTIVATION-ATTEMPT-CONSUMED",
                                  "L7U-ATTEMPT-CONSUMED", "L34-V9-FUTURE-ATTEMPT-CONSUMED"])
def test_an_authorization_directory_carrying_any_other_runs_marker_is_refused(tmp_path: Path, name: str) -> None:
    sim = Sim(tmp_path)
    (sim.auth / name).write_text("consumed_at=2026-10-02T12:33:35Z\n")
    _refused(sim, "attempt marker of another governed run")


def test_unresolved_template_ap_mismatch_or_old_unit_missing_in_preflight_refuses_without_consuming(tmp_path: Path) -> None:
    for reason in ("DNSREPAIR_RENDER_UNRESOLVED", "L34_AP_SSID_MISMATCH", "DNSREPAIR_UNIT_UNKNOWN_AUTHORITY", "L34_V7_CORE_NOT_HEALTHY:ActiveState"):
        sim = Sim(tmp_path / reason.lower().replace(":", "-"))
        sim.inject("fail-preflight", reason)
        res = sim.run()
        assert res.returncode == 1 and "preflight failed; NOTHING was changed" in res.stdout + res.stderr and reason in res.stdout + res.stderr
        assert not sim.marker() and sim.handler_calls() == ["apply"], "only the read-only preflight ran"
        assert "DNSMASQ_REPAIR_RESULT=NOT_STARTED_NO_MUTATION" in res.stdout + res.stderr


def test_authorization_is_reusable_after_a_refused_preflight(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-preflight", "L34_AP_SSID_MISMATCH")
    assert sim.run().returncode == 1 and not sim.marker()
    sim.clear("fail-preflight")
    time.sleep(1.1)  # the evidence directory name has one-second resolution
    assert sim.run().returncode == 0 and sim.marker()


def test_pre_capture_failure_does_not_consume_the_authorization(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-capture-pre")
    res = sim.run()
    assert res.returncode == 1 and "PRE capture failed; nothing changed" in res.stdout + res.stderr
    assert not sim.marker() and sim.handler_calls() == ["apply"]


def test_consume_happens_after_preflight_and_pre_capture_and_immediately_before_apply(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert sim.run().returncode == 0
    calls = sim.calls()
    assert "marker@preflight:no" in calls and "marker@capture-pre:no" in calls and "marker@apply:yes" in calls
    assert calls.index("marker@capture-pre:no") < calls.index("marker@apply:yes")


def test_runner_source_order_preflight_then_pre_capture_then_consume_then_apply_with_no_retry() -> None:
    text = RUNNER.read_text()
    preflight = text.index("AEGIS_DNSREPAIR_PREFLIGHT_ONLY_RUN=YES handler apply.sh")
    pre_cap = text.index('capture PRE "$EVID/pre-root"')
    consume = text.index("set -o noclobber")
    apply = text.index("handler apply.sh 2>&1")
    assert preflight < pre_cap < consume < apply
    assert text.count("handler apply.sh") == 2, "exactly the preflight and the one apply; no retry loop"
    assert "while " not in text.replace('while IFS=', '') and "until " not in text


# ── failure after consumption: rollback, terminal verdict, no retry ──────────────────────────────────────────────────────

def test_apply_failure_rolls_back_leaves_the_attempt_consumed_and_reports_rolled_back(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-apply")
    res = sim.run()
    assert res.returncode == 1, res.stdout + res.stderr
    assert sim.marker() and sim.handler_calls() == ["apply", "apply", "rollback"]
    assert "DNSMASQ_REPAIR_RESULT=ROLLED_BACK" in res.stdout and sim.verdict().strip() == "DNSMASQ_REPAIR_RESULT=ROLLED_BACK"
    assert "DNSMASQ_REPAIR_APPLIED=NO" in res.stdout and "UNEXPECTED_DRIFT=NONE" not in res.stdout and "DNSMASQ_REPAIR_RESULT=PASS" not in res.stdout
    assert any(c.startswith("capture:rb") for c in sim.calls()) and any("compare:" in c and "rb-root" in c for c in sim.calls())


def test_verify_failure_rolls_back(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-verify")
    res = sim.run()
    assert res.returncode == 1 and sim.handler_calls() == ["apply", "apply", "verify", "rollback"]
    assert "DNSMASQ_REPAIR_RESULT=ROLLED_BACK" in res.stdout


def test_a_verify_that_omits_a_required_verdict_line_rolls_back(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    (sim.dir / "verify-lines").write_text("\n".join(l for l in VERDICT_LINES if l != "BROKER_UNCHANGED=PASS") + "\n")
    res = sim.run()
    assert res.returncode == 1 and sim.handler_calls()[-1] == "rollback" and "verify did not report BROKER_UNCHANGED=PASS" in res.stdout


def test_unexpected_production_drift_in_the_pre_post_compare_rolls_back(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-compare-pre-root-post-root")
    res = sim.run()
    assert res.returncode == 1 and sim.handler_calls() == ["apply", "apply", "verify", "rollback"]
    assert "PRE->POST compare failed" in res.stdout and "DNSMASQ_REPAIR_RESULT=ROLLED_BACK" in res.stdout and sim.marker()


def test_a_failed_rollback_escalates_with_exit_3_and_never_retries(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-apply")
    sim.inject("fail-rollback")
    res = sim.run()
    assert res.returncode == 3 and "ESCALATE" in res.stdout and "DNSMASQ_REPAIR_RESULT=ROLLBACK_FAILED_ESCALATE" in res.stdout
    assert sim.verdict().strip() == "DNSMASQ_REPAIR_RESULT=ROLLBACK_FAILED_ESCALATE" and sim.marker()
    before = len(sim.calls())
    sim.clear("fail-apply"); sim.clear("fail-rollback")
    assert sim.run().returncode == 1 and len(sim.calls()) == before


def test_a_failed_rollback_compare_escalates(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-apply")
    sim.inject("fail-compare-pre-root-rb-root")
    res = sim.run()
    assert res.returncode == 3 and "PRE_RB_COMPARE=FAIL" in res.stdout and "ROLLBACK_FAILED_ESCALATE" in res.stdout


def test_a_post_capture_failure_after_a_clean_apply_and_verify_rolls_back(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-capture-post")  # fails after a clean apply+verify: the handler wrote its marker, so rollback runs
    res = sim.run()
    assert res.returncode == 1 and sim.handler_calls()[-1] == "rollback"


# ── static governance ────────────────────────────────────────────────────────────────────────────────────────────────────

def test_runner_scope_is_printable_ascii_le_200_and_the_runner_never_touches_other_stages() -> None:
    raw = EXPECTED_SCOPE.encode("ascii")
    assert 1 <= len(raw) <= 200 and all(32 <= b <= 126 for b in raw)
    text = RUNNER.read_text()
    assert f"EXPECTED_SCOPE='{EXPECTED_SCOPE}'" in text
    code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
    for pat in ("run-l34", "run-l7", "run-l8", "reactivation/l34", "stages/L", "reboot-verify", "verify-dnsmasq-boot-order-after-reboot"):
        assert pat not in code, pat
    assert not re.search(r"(^|[;&|(]\s*)(sudo\s+)?(reboot|poweroff|shutdown|halt)\b|systemctl\s+(reboot|poweroff|halt|kexec)", code, re.M)
    assert 'DNSREPAIR_MARKER_NAME' in code and 'L34-V' not in code
