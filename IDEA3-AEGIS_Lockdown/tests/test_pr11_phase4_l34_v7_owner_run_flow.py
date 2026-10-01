# shellcheck shell=bash disable=SC1091
"""AEGIS IDEA3 PR11 Phase 4 — L34 V7 owner-run CONTROL-FLOW simulation.

The real run-l34-v7-radio-disabled-broker-churn-owner.sh is executed, unmodified apart from its frozen constants, inside a sandbox:
`sudo`, `systemctl`, `journalctl` and friends are stubs, and the host-gate functions come from the REAL, unmodified
p4-l34-reactivation-lib.sh (only p4-stage-gate.sh / p4-l0-capture.sh / p4-compare.sh and the handler scripts are stand-ins). This proves the
runner's pre-gate section WIRES the real V7 gates correctly (strict broker-churn contract, no 8883 listener, healthy Core, exact V7 scope) and that it
never invokes another stage's handler. The handler bodies themselves are covered by test_pr11_phase4_l34_v7_radio_disabled_broker_churn.py.
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
RUNNER = DEPLOY / "owner-run" / "run-l34-v7-radio-disabled-broker-churn-owner.sh"
L34_RUNNER = DEPLOY / "owner-run" / "run-l34-reactivation-owner.sh"
REAL_LIB = DEPLOY / "p4-l34-reactivation-lib.sh"
HND_NAME = "l34-v7-radio-disabled-broker-churn"
LOGS = "Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs"
TODAY = subprocess.run(["date", "+%F"], text=True, capture_output=True, env=dict(os.environ, TZ="Asia/Bangkok")).stdout.strip()
PSK = "CANARY-wifi-psk-4f9a8b7c6d5e"

EXPECTED_SCOPE = (
    "L3_L4_RUNTIME_REACTIVATION_V7_RADIO_DISABLED_BROKER_CHURN: rfkill and radio on once, one ifname-bound AP up, one dnsmasq start; no broker or Core control, no MQTT/ESP32/L7/L8/Recovery"
)

DNSMASQ_PROPS = {"LoadState": "loaded", "ActiveState": "failed", "SubState": "failed", "UnitFileState": "enabled", "Result": "start-limit-hit", "MainPID": "0"}
BROKER_PROPS = {
    "LoadState": "loaded", "ActiveState": "activating", "SubState": "auto-restart", "UnitFileState": "enabled", "Result": "exit-code", "MainPID": "0",
    "NRestarts": "832", "ExecMainStatus": "1", "Restart": "on-failure", "RestartUSec": "5s", "InvocationID": "0123456789abcdef0123456789abcdef",
}
HEALTHY = {"ActiveState": "active", "SubState": "running", "LoadState": "loaded", "Result": "success", "MainPID": "883", "NRestarts": "0"}
SIGNATURE = "1790808305: Error: Cannot assign requested address"

STUB_NOOP_CMDS = ("rfkill", "nmcli", "iw", "ip", "nft", "sysctl", "dnsmasq")

HANDLER = r'''#!/usr/bin/env bash
name=$(basename "$0" .sh)
echo "$name" >> "$SIM_DIR/calls.log"
mkdir -p "$AEGIS_L34_WORK_DIR"
marker_state() { if [ -e "$(cat "$SIM_DIR/marker-path")" ]; then echo yes; else echo no; fi; }
case "$name" in
  apply)
    if [ "${AEGIS_L34_PREFLIGHT_ONLY:-NO}" = YES ]; then
      echo "marker@preflight:$(marker_state)" >> "$SIM_DIR/calls.log"
      [ ! -e "$SIM_DIR/fail-preflight" ] || { echo "L34_V7_PREFLIGHT=FAIL reason=SIM" >&2; exit 1; }
      echo "L34_BASELINE=RESIDUAL"; echo "L34_V7_PREFLIGHT=PASS"; exit 0
    fi
    echo "marker@apply:$(marker_state)" >> "$SIM_DIR/calls.log"
    echo YES > "$AEGIS_L34_WORK_DIR/production-mutation"
    [ ! -e "$SIM_DIR/fail-apply" ] || { echo "L34_V7_APPLY=FAIL reason=SIM" >&2; exit 1; }
    echo "L34_V7_APPLY=PASS" ;;
  verify) echo "L34_V7_VERIFY=PASS" ;;
  rollback) echo "L34_V7_ROLLBACK=PASS" ;;
esac
'''
CAPTURE = '#!/usr/bin/env bash\necho "capture:$CAPTURE_LABEL" >> "$SIM_DIR/calls.log"\nif [ -e "$(cat "$SIM_DIR/marker-path")" ]; then echo "marker@capture-$CAPTURE_LABEL:yes" >> "$SIM_DIR/calls.log"; else echo "marker@capture-$CAPTURE_LABEL:no" >> "$SIM_DIR/calls.log"; fi\n[ ! -e "$SIM_DIR/fail-capture-$CAPTURE_LABEL" ] || exit 1\nmkdir -p "$EVID_DIR"\necho "L0_CAPTURE=COMPLETE" > "$EVID_DIR/capture.log"\n(cd "$EVID_DIR" && sha256sum capture.log > SHA256SUMS)\n'
COMPARE = ('#!/usr/bin/env bash\necho "compare:$*" >> "$SIM_DIR/calls.log"\nenv | grep -E "^ALLOW_" >> "$SIM_DIR/calls.log"\n'
           "printf 'FINDINGS_NEW_OR_WORSENED_DRIFT=0\\nFINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0\\nFINDINGS_INCOMPARABLE=0\\nPRESERVATION_S10=PASS\\nCOMPARE_RESULT=PASS\\n'\n")
STAGE_GATE = "#!/usr/bin/env bash\nprintf 'AUTHORIZATION_RECORD=VALID\\nK3_CONFIRMATION=VALID\\n'\n"


def _systemctl_stub(dnsmasq: dict, broker: dict, core: dict) -> str:
    def block(props: dict) -> str:
        return "\n".join(f'      {k}) echo "{v}" ;;' for k, v in props.items())

    return r'''#!/usr/bin/env bash
shift
keys=(); value_mode=0; unit=""
while [ $# -gt 0 ]; do
  case "$1" in -p) keys+=("$2"); shift 2 ;; --value) value_mode=1; shift ;; *) unit=$1; shift ;; esac
done
prop_for() {
  local u=$1 k=$2
  case "$u" in
    aegis-idea3-dnsmasq.service) case "$k" in
''' + block(dnsmasq) + r'''
    esac ;;
    aegis-idea3-mosquitto.service) case "$k" in
''' + block(broker) + r'''
    esac ;;
    aegis-idea3-core.service) case "$k" in
''' + block(core) + r'''
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
    def __init__(self, tmp: Path, *, journal: str = SIGNATURE, broker: dict | None = None, core: dict | None = None,
                 listener_rows: str = "", scope: str = EXPECTED_SCOPE) -> None:
        self.dir = tmp / "sim"
        self.repo = self.dir / "repo"
        self.p4 = self.repo / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
        self.evid_base = self.dir / "evidence"
        self.auth = self.dir / "auth"
        self.auth.mkdir(parents=True)
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        self.profile = self.dir / "profile.nmconnection"
        self.profile.write_text(f"[wifi-security]\npsk={PSK}\n")
        self.journal, self.listener_rows, self.scope = journal, listener_rows, scope
        self.broker = {**BROKER_PROPS, **(broker or {})}
        self.core = {**HEALTHY, **(core or {})}
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
        for name in ("allow-keys.txt", "allow-keys-rollback.txt", "allow-listeners.txt"):
            (hnd / name).write_text("")
        v3 = self.p4 / "reactivation" / "l34"
        v3.mkdir(parents=True)
        for name in ("allow-transitions.txt", "allow-dynamic-transitions-v3-post-fresh.txt", "allow-dynamic-transitions-v3-post-residual.txt",
                     "allow-dynamic-transitions-v3-rollback-fresh.txt", "allow-dynamic-transitions-v3-rollback-residual.txt"):
            (v3 / name).write_text("")
        self._git("init", "-q")
        self._git("checkout", "-q", "-B", "main")
        self._git("add", "-A")
        self._git("commit", "-q", "-m", "sim")
        self._git("remote", "add", "origin", str(self.repo))
        self._git("fetch", "-q", "origin")
        self.head = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], text=True, capture_output=True, check=True).stdout.strip()

        (self.bin / "sudo").write_text('#!/usr/bin/env bash\n[ "$1" = -v ] && exit 0\nexec "$@"\n')
        (self.bin / "systemctl").write_text(_systemctl_stub(DNSMASQ_PROPS, self.broker, self.core))
        (self.bin / "journalctl").write_text(f'#!/usr/bin/env bash\ncat <<\'EOF\'\n{self.journal}\nEOF\n')
        (self.bin / "ss").write_text(f'#!/usr/bin/env bash\ncat <<\'EOF\'\n{self.listener_rows}\nEOF\n')
        for name in STUB_NOOP_CMDS:
            (self.bin / name).write_text("#!/usr/bin/env bash\nexit 0\n")
        for f in self.bin.iterdir():
            f.chmod(0o755)

        (self.auth / "authorization-L4.txt").write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage=L4\ndate={TODAY}\nauthorizer=music\nscope={self.scope}\nreference=sim/ref\n")
        (self.auth / "k3-L4.txt").write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage=L4\ndate={TODAY}\nconfirmed_by=music\nreference=sim/ref\n")

        text = RUNNER.read_text()
        text = text.replace("EXPECTED_MAIN=PIN_MAIN_SHA", f"EXPECTED_MAIN={self.head}")
        text = text.replace("REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-L34LIVE   # clean pinned execution worktree at merged main",
                            f"REPO={self.repo}")
        text = text.replace("PY=/home/kittipat/.venvs/aegis-idea3-core/bin/python", f"PY={sys.executable}")
        text = text.replace("PROFILE=/etc/NetworkManager/system-connections/aegis-idea3-ap.nmconnection", f"PROFILE={self.profile}")
        text = text.replace("EVID=/home/kittipat/Workspace/idea3-p4-evidence/$TODAY-l34-v7-$STAMP", f"EVID={self.evid_base}/$TODAY-l34-v7-$STAMP")
        self.runner = self.dir / "run-l34-v7-owner.sh"
        self.runner.write_text(text)
        self.evid_base.mkdir()
        (self.dir / "marker-path").write_text(str(self.auth / "L34-V7-REACTIVATION-ATTEMPT-CONSUMED"))

    def run(self) -> subprocess.CompletedProcess[str]:
        env = dict(os.environ, SIM_DIR=str(self.dir), PATH=f"{self.bin}:{os.environ['PATH']}", TZ="Asia/Bangkok")
        return subprocess.run(["bash", str(self.runner), str(self.auth)], text=True, capture_output=True, env=env, check=False)

    def inject(self, name: str) -> None:
        (self.dir / name).write_text("1\n")

    def clear(self, name: str) -> None:
        (self.dir / name).unlink()

    def marker(self) -> bool:
        return (self.auth / "L34-V7-REACTIVATION-ATTEMPT-CONSUMED").exists()

    def calls(self) -> list[str]:
        return (self.dir / "calls.log").read_text().splitlines() if (self.dir / "calls.log").exists() else []


def test_v7_runner_is_unpinned_as_committed() -> None:
    res = subprocess.run(["bash", str(RUNNER), "/nonexistent"], text=True, capture_output=True, check=False)
    assert res.returncode == 2 and "runner is not pinned" in res.stdout


def test_v7_runner_full_flow_succeeds_against_the_intended_baseline(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    assert "L3_L4_RUNTIME_REACTIVATION_V7=PASS" in res.stdout and sim.marker()
    assert "RECOVERY_R1_R8_PROVEN=NO" in res.stdout and "L8_AUTHORIZED=NO" in res.stdout and "CORE_RESTARTED=NO" in res.stdout
    assert [c for c in sim.calls() if c in ("apply", "verify", "rollback")] == ["apply", "apply", "verify"], "preflight, apply once, verify; no rollback"
    for forbidden in ("L3_LIVE_ACCEPTANCE=PROVEN", "L6B_LIVE_ACCEPTANCE=PROVEN"):
        assert forbidden not in res.stdout


def test_v7_runner_compare_uses_the_v7_catalogs_and_the_exact_v3_baseline_catalog(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert sim.run().returncode == 0
    calls = "\n".join(sim.calls())
    assert f"ALLOW_KEYS_FILE={sim.p4}/reactivation/{HND_NAME}/allow-keys.txt" in calls
    assert f"ALLOW_DYNAMIC_TRANSITIONS_FILE={sim.p4}/reactivation/l34/allow-dynamic-transitions-v3-post-residual.txt" in calls


@pytest.mark.parametrize("kw,needle", [
    (dict(journal="mosquitto[1]: Error: Unable to load server certificate"), "L34_V7_BROKER_JOURNAL_SIGNATURE_MISSING"),
    (dict(journal=SIGNATURE + "\nmosquitto[1]: Error: Unable to load server certificate"), "L34_V7_BROKER_JOURNAL_OTHER_ERROR"),
    (dict(broker={"InvocationID": ""}), "L34_V7_BROKER_INVOCATION_ID_INVALID"),
    (dict(broker={"InvocationID": "not-a-valid-invocation-id"}), "L34_V7_BROKER_INVOCATION_ID_INVALID"),
    (dict(broker={"Restart": "always"}), "L34_V7_BROKER_PRESTATE_UNEXPECTED:Restart"),
    (dict(broker={"ActiveState": "active", "SubState": "running", "MainPID": "5100"}), "L34_V7_BROKER_PRESTATE_UNEXPECTED"),
    (dict(listener_rows="LISTEN 0 100 127.0.0.1:8883 0.0.0.0:*"), "L34_V7_UNEXPECTED_8883_LISTENER"),
    (dict(core={"ActiveState": "inactive", "SubState": "dead", "MainPID": "0"}), "aegis-idea3-core.service not active/running"),
    (dict(scope="L3_L4_RUNTIME_REACTIVATION_V3: rfkill 1 unblock"), "authorization scope is not exactly the approved V7 scope"),
])
def test_v7_runner_pre_gate_refuses_without_mutating_or_consuming(tmp_path: Path, kw: dict, needle: str) -> None:
    sim = Sim(tmp_path, **kw)
    res = sim.run()
    assert res.returncode == 1 and needle in res.stderr, res.stdout + res.stderr
    assert not sim.marker() and sim.calls() == []


def test_v7_runner_consumes_the_one_attempt_and_refuses_a_second_run(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    assert sim.run().returncode == 0
    second = sim.run()
    assert second.returncode == 1 and "already consumed its one bounded attempt" in second.stderr


def test_v7_runner_leaves_the_original_l34_runner_and_its_broker_gate_untouched() -> None:
    text = L34_RUNNER.read_text()
    assert 'gate "L6b broker is not inactive (L6b must not have started)"' in text
    assert "V7" not in text and "v7" not in text
    assert "run-l34-v7" not in RUNNER.read_text().replace("run-l34-v7-radio-disabled-broker-churn-owner.sh", "")


# ── F1: the one-shot authorization is consumed only AFTER handler preflight and PRE capture, immediately before the first mutation ──────────────

def _non_mutating_calls(sim: Sim) -> list[str]:
    return [c for c in sim.calls() if not c.startswith(("marker@", "compare:", "ALLOW_"))]


def test_v7_f1_preflight_failure_does_not_consume_the_authorization(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-preflight")
    res = sim.run()
    assert res.returncode == 1 and "preflight failed; NOTHING was changed" in res.stdout + res.stderr, res.stdout + res.stderr
    assert not sim.marker(), "a refused preflight must leave the one-shot authorization intact"
    assert _non_mutating_calls(sim) == ["apply"], "only the read-only preflight ran; no PRE capture, no mutation"
    assert "marker@apply:no" not in sim.calls() and "marker@apply:yes" not in sim.calls()


def test_v7_f1_authorization_is_reusable_after_a_refused_preflight(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-preflight")
    assert sim.run().returncode == 1 and not sim.marker()
    sim.clear("fail-preflight")
    time.sleep(1.1)  # the evidence directory name has one-second resolution; a real owner retry is always later than that
    retry = sim.run()
    assert retry.returncode == 0 and sim.marker(), retry.stdout + retry.stderr


def test_v7_f1_pre_capture_failure_does_not_consume_the_authorization(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-capture-pre")
    res = sim.run()
    assert res.returncode == 1 and "PRE capture failed; nothing changed" in res.stdout + res.stderr, res.stdout + res.stderr
    assert not sim.marker()
    assert [c for c in sim.calls() if c in ("apply", "verify", "rollback")] == ["apply"], "preflight only: the mutating apply never ran"
    assert "marker@apply:yes" not in sim.calls() and "marker@apply:no" not in sim.calls()


def test_v7_f1_successful_preflight_and_pre_capture_then_consume_immediately_before_mutation(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    res = sim.run()
    assert res.returncode == 0, res.stdout + res.stderr
    calls = sim.calls()
    assert "marker@preflight:no" in calls, "nothing is consumed before the handler preflight"
    assert "marker@capture-pre:no" in calls, "nothing is consumed before the PRE capture"
    assert "marker@apply:yes" in calls, "the mutating apply starts only after the authorization was consumed"
    assert calls.index("marker@capture-pre:no") < calls.index("marker@apply:yes")


def test_v7_f1_apply_failure_leaves_the_authorization_consumed_and_rolls_back(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-apply")
    res = sim.run()
    assert res.returncode == 1, res.stdout + res.stderr
    assert sim.marker(), "once mutation started the attempt is spent, even after a failure"
    assert [c for c in sim.calls() if c in ("apply", "verify", "rollback")] == ["apply", "apply", "rollback"]


def test_v7_f1_replay_after_a_failed_mutation_is_refused_before_any_work(tmp_path: Path) -> None:
    sim = Sim(tmp_path)
    sim.inject("fail-apply")
    assert sim.run().returncode == 1 and sim.marker()
    before = len(sim.calls())
    sim.clear("fail-apply")
    second = sim.run()
    assert second.returncode == 1 and "already consumed its one bounded attempt" in second.stderr
    assert len(sim.calls()) == before, "a replay must not even run the preflight"


def test_v7_f1_runner_source_consumes_the_marker_after_pre_capture_and_before_apply() -> None:
    text = RUNNER.read_text()
    pre_cap = text.index('capture PRE "$EVID/pre-root"')
    consume = text.index("set -o noclobber")
    apply = text.index("handler apply.sh 2>&1")
    preflight = text.index("AEGIS_L34_PREFLIGHT_ONLY_RUN=YES handler apply.sh")
    assert preflight < pre_cap < consume < apply
