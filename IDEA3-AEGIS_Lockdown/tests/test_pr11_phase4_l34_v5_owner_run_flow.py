# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L34 V5 owner-run CONTROL-FLOW simulation.

The real run-l34-v5-post-l6b-degraded-owner.sh is executed, unmodified apart from its frozen constants, inside a
sandbox: `sudo`, `systemctl`, `journalctl` and friends are stubs, and the stage-independent host-gate functions come
from the REAL, unmodified p4-l34-reactivation-lib.sh (only `p4-stage-gate.sh`/`p4-l0-capture.sh`/`p4-compare.sh`/the
handler scripts are stand-ins). This proves the runner's pre-gate section actually WIRES the real
`l34_v5_broker_crashloop_gate` correctly — in particular that it captures a bounded broker journal tail and passes
its path as the gate's required argument. Prior to the 2026-09-28 fix, the pre-gate called the gate with NO journal
argument at all (`unit_props "$BROKER_UNIT" | l34_v5_broker_crashloop_gate`), so the gate unconditionally failed with
L34_V5_BROKER_JOURNAL_UNREADABLE against every host state, including the exact intended baseline — a bug the
existing test suite never caught because it only ever executes apply.sh/verify.sh/rollback.sh through the Python stub
harness, never the owner-run script itself (which was previously checked only with `bash -n` and static regex
assertions on its source text).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "pr11-phase4"
RUNNER = DEPLOY / "owner-run" / "run-l34-v5-post-l6b-degraded-owner.sh"
REAL_LIB = DEPLOY / "p4-l34-reactivation-lib.sh"
HND_NAME = "l34-v5-post-l6b-degraded"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
TODAY = subprocess.run(["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).stdout.strip()

EXPECTED_SCOPE = (
    "L3_L4_RUNTIME_REACTIVATION_V5_POST_L6B_DEGRADED: activate aegis-idea3-ap once, recover dnsmasq, "
    "bounded broker auto-restart wait, no broker control, no persistent rewrite, no L7/ESP32/MQTT action"
)

# The ONE supported V5 broker/dnsmasq pre-state (see l34_service_pre_gate / l34_v5_broker_crashloop_gate).
DNSMASQ_PROPS = {
    "LoadState": "loaded", "ActiveState": "failed", "SubState": "failed",
    "UnitFileState": "enabled", "Result": "start-limit-hit", "MainPID": "0",
}
BROKER_PROPS = {
    "LoadState": "loaded", "ActiveState": "activating", "SubState": "auto-restart",
    "UnitFileState": "enabled", "Result": "exit-code", "MainPID": "0",
}
HEALTHY = {"ActiveState": "active", "SubState": "running"}
JOURNAL_INTENDED_SIGNATURE = "1790591072: Error: Cannot assign requested address"

STUB_NOOP_CMDS = ("rfkill", "nmcli", "iw", "ip", "nft", "sysctl", "ss", "dnsmasq")

HANDLER = r'''#!/usr/bin/env bash
name=$(basename "$0" .sh)
echo "$name" >> "$SIM_DIR/calls.log"
mkdir -p "$AEGIS_L34_WORK_DIR"
case "$name" in
  apply)
    if [ "${AEGIS_L34_PREFLIGHT_ONLY:-NO}" = YES ]; then echo "L34_V5_PREFLIGHT=PASS"; exit 0; fi
    echo YES > "$AEGIS_L34_WORK_DIR/production-mutation"
    echo "L34_V5_APPLY=PASS" ;;
  verify) echo "L34_V5_VERIFY=PASS" ;;
  rollback) echo "L34_V5_ROLLBACK=PASS" ;;
esac
'''

CAPTURE = r'''#!/usr/bin/env bash
echo "capture:$CAPTURE_LABEL" >> "$SIM_DIR/calls.log"
mkdir -p "$EVID_DIR"
echo "L0_CAPTURE=COMPLETE" > "$EVID_DIR/capture.log"
(cd "$EVID_DIR" && sha256sum capture.log > SHA256SUMS)
exit 0
'''

COMPARE = r'''#!/usr/bin/env bash
echo "compare" >> "$SIM_DIR/calls.log"
printf 'FINDINGS_NEW_OR_WORSENED_DRIFT=0\nFINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0\nFINDINGS_INCOMPARABLE=0\nPRESERVATION_S10=PASS\nCOMPARE_RESULT=PASS\n'
'''

STAGE_GATE = r'''#!/usr/bin/env bash
printf 'AUTHORIZATION_RECORD=VALID\nK3_CONFIRMATION=VALID\n'
'''


def _props_lines(props: dict[str, str]) -> str:
    return "\n".join(f'{k}) echo "{v}" ;;' for k, v in props.items())


def _systemctl_stub() -> str:
    # `show -p K1 -p K2 ... [--value] UNIT` — emulate both call shapes used by the runner/lib:
    # show() uses `-p KEY --value UNIT` (single prop, bare value); unit_props() uses multiple
    # `-p KEY` flags with no --value (KEY=VALUE lines, one per requested prop).
    return r'''#!/usr/bin/env bash
shift  # drop "show"
keys=()
value_mode=0
unit=""
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
''' + "\n".join(f'      {k}) echo "{v}" ;;' for k, v in DNSMASQ_PROPS.items()) + r'''
    esac ;;
    aegis-idea3-mosquitto.service) case "$k" in
''' + "\n".join(f'      {k}) echo "{v}" ;;' for k, v in BROKER_PROPS.items()) + r'''
    esac ;;
    *) case "$k" in
''' + "\n".join(f'      {k}) echo "{v}" ;;' for k, v in HEALTHY.items()) + r'''
    esac ;;
  esac
}
for k in "${keys[@]}"; do
  v=$(prop_for "$unit" "$k")
  if [ "$value_mode" = 1 ]; then printf '%s\n' "$v"; else printf '%s=%s\n' "$k" "$v"; fi
done
'''


def _journalctl_stub(with_signature: bool) -> str:
    line = f'echo "{JOURNAL_INTENDED_SIGNATURE}"' if with_signature else 'echo "unrelated broker log line"'
    return f"#!/usr/bin/env bash\n{line}\n"


class Sim:
    def __init__(self, tmp: Path, *, journal_has_signature: bool = True) -> None:
        self.dir = tmp / "sim"
        self.repo = self.dir / "repo"
        self.p4 = self.repo / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
        self.evid_base = self.dir / "evidence"
        self.auth = self.dir / "auth"
        self.auth.mkdir(parents=True)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.journal_has_signature = journal_has_signature
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
        self.head = subprocess.run(
            ["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True
        ).stdout.strip()

        (self.bin / "sudo").write_text('#!/usr/bin/env bash\n[ "$1" = -v ] && exit 0\nexec "$@"\n')
        (self.bin / "systemctl").write_text(_systemctl_stub())
        (self.bin / "journalctl").write_text(_journalctl_stub(self.journal_has_signature))
        for name in STUB_NOOP_CMDS:
            (self.bin / name).write_text("#!/usr/bin/env bash\nexit 0\n")
        for f in self.bin.iterdir():
            f.chmod(0o755)

        records = f"stage=L4\ndate={TODAY}\nauthorizer=music\nscope={EXPECTED_SCOPE}\nreference=sim/ref\n"
        (self.auth / "authorization-L4.txt").write_text("AEGIS_P4_AUTHORIZATION_V1\n" + records)
        (self.auth / "k3-L4.txt").write_text("AEGIS_P4_K3_CONFIRMATION_V2\nstage=L4\ndate=" + TODAY + "\nconfirmed_by=music\nreference=sim/ref\n")

        text = RUNNER.read_text()
        text = text.replace("EXPECTED_MAIN=PIN_MAIN_SHA", f"EXPECTED_MAIN={self.head}")
        text = text.replace(
            "REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L34LIVE   # clean pinned execution worktree at merged main",
            f"REPO={self.repo}/IDEA3-AEGIS_Lockdown",
        )
        # REPO in the runner already includes the IDEA3-AEGIS_Lockdown suffix via P4=$REPO/IDEA3-AEGIS_Lockdown/...
        # — undo the double join: point REPO at the outer repo root instead.
        text = text.replace(f"REPO={self.repo}/IDEA3-AEGIS_Lockdown", f"REPO={self.repo}")
        text = text.replace(
            "EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l34-v5-$STAMP",
            f"EVID={self.evid_base}/$TODAY-l34-v5-$STAMP",
        )
        self.runner = self.dir / "run-l34-v5-post-l6b-degraded-owner.sh"
        self.runner.write_text(text)
        self.evid_base.mkdir()

    def run(self) -> subprocess.CompletedProcess[str]:
        env = dict(
            os.environ, SIM_DIR=str(self.dir), PATH=f"{self.bin}:{os.environ['PATH']}", TZ="Asia/Bangkok",
        )
        return subprocess.run(
            ["bash", str(self.runner), str(self.auth)], text=True, capture_output=True, env=env, check=False,
        )

    def marker(self) -> bool:
        return (self.auth / "L34-V5-REACTIVATION-ATTEMPT-CONSUMED").exists()


@pytest.fixture()
def sim(tmp_path: Path) -> Sim:
    return Sim(tmp_path)


def test_owner_run_pre_gate_wires_the_real_journal_evidence_to_the_broker_gate(sim: Sim) -> None:
    """The exact bug this test exists to catch: the pre-gate must capture a broker journal tail and pass its
    path to l34_v5_broker_crashloop_gate. Before the fix, no argument was ever passed, so the gate always failed
    with L34_V5_BROKER_JOURNAL_UNREADABLE — even against this exact intended baseline."""
    res = sim.run()
    assert "GATE_FAIL: L34_V5_BROKER_JOURNAL_UNREADABLE" not in res.stderr, res.stdout + res.stderr
    assert "one or more pre-gates failed" not in (res.stdout + res.stderr), res.stdout + res.stderr


def test_owner_run_pre_gate_still_refuses_when_the_journal_lacks_the_bind_failure_signature(tmp_path: Path) -> None:
    """Proves the fix didn't just paper over the bug with an empty/always-readable file: an unrelated broker
    failure (same systemd tuple, but no bind-failure line in the journal) must still be refused."""
    sim = Sim(tmp_path, journal_has_signature=False)
    res = sim.run()
    assert "GATE_FAIL: L34_V5_BROKER_JOURNAL_SIGNATURE_MISSING" in res.stderr, res.stdout + res.stderr
    assert res.returncode == 1
    assert not sim.marker()


def test_owner_run_full_flow_succeeds_end_to_end_against_the_intended_baseline(sim: Sim) -> None:
    """End-to-end: with the real gate wired correctly, the runner reaches its final PASS line and consumes the
    one-attempt marker exactly once."""
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L3_L4_RUNTIME_REACTIVATION_V5=PASS" in res.stdout
    assert sim.marker()
