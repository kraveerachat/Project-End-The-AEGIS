"""L8u frozen-runner FLOW, end to end and hermetic: the real runner template is frozen mechanically from a throwaway repository, run against a root-less sandbox (PATH stubs for sudo/systemctl/ss/df/pgrep, stub capture/compare/
observer/verify in the throwaway repository's control tree) and its ordering, one-attempt marker, closeouts, failure model and signal handling are asserted.

Documented divergences from production (test copies only; the production files are covered by the static and unit tests): the runner copy gets the snapshot-owner/trust-root constants the template documents as
substitutable for a test copy plus a stub-first PATH; the library copy gets a temporary canonical directory/unit path/trust root. Nothing here touches the host, a device, a socket or a service."""

from __future__ import annotations

import hashlib
import os
import shutil
import signal
import subprocess
import time
from pathlib import Path

import pytest

import l8u_support as s

freeze = s.load(s.FREEZE, "l8u_runner_freeze")
snap = s.load(s.SNAP, "l8u_control_snapshot")
P4_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4"

SUDO_STUB = '''#!/bin/sh
case "$1" in -v) exit 0 ;; -n) shift ;; esac
case "$1" in -v) exit 0 ;; esac
exec env L8U_E2E_FAKEROOT=1 "$@"
'''
SYSTEMCTL_STUB = '''#!/bin/sh
# systemctl show -p A -p B [--value] UNIT  -> values from $L8U_E2E_STATE/units/UNIT/PROP (missing = empty)
props=""; value=0; unit=""
while [ $# -gt 0 ]; do
  case "$1" in show) ;; --value) value=1 ;; -p) props="$props $2"; shift ;; *) unit=$1 ;; esac; shift
done
for p in $props; do
  v=$(cat "$L8U_E2E_STATE/units/$unit/$p" 2>/dev/null || true)
  if [ "$value" = 1 ]; then printf '%s\\n' "$v"; else printf '%s=%s\\n' "$p" "$v"; fi
done
'''
OBSERVE_STUB = '''#!/usr/bin/env python3
import os, sys
state = os.environ["L8U_E2E_STATE"]
mode = sys.argv[1]
open(os.path.join(state, "observer-calls.log"), "a").write(mode + "\\n")
if os.path.exists(os.path.join(state, mode.lstrip("-") + ".fail")):
    print("L8U_OBSERVE=FAIL reason=STUB", file=sys.stderr); sys.exit(1)
if mode == "--capture-boundary":
    print("L8U_PRE_PROTOCOL_SEEN_ID=7\\nL8U_PRE_AUDIT_ID=11\\nL8U_PRE_COMMAND_ROWID=3")
'''
CAPTURE_STUB = '''#!/usr/bin/env bash
set -eu
[ ! -e "$L8U_E2E_STATE/capture-$CAPTURE_LABEL.fail" ] || exit 1
[ ! -e "$L8U_E2E_STATE/capture-$CAPTURE_LABEL.sleep" ] || sleep "$(cat "$L8U_E2E_STATE/capture-$CAPTURE_LABEL.sleep")"
mkdir -p "$EVID_DIR"; echo "$CAPTURE_LABEL" > "$EVID_DIR/label.txt"; echo "capture $CAPTURE_LABEL" >> "$L8U_E2E_STATE/calls.log"
'''
COMPARE_STUB = '''#!/usr/bin/env bash
echo "compare $ALLOW_KEYS_FILE" >> "$L8U_E2E_STATE/calls.log"
if [ -e "$L8U_E2E_STATE/compare.fail" ]; then echo COMPARE_RESULT=FAIL; else echo PRESERVATION_S10=PASS; echo COMPARE_RESULT=PASS; fi
'''
VERIFY_STUB = '''#!/usr/bin/env bash
echo "verify" >> "$L8U_E2E_STATE/calls.log"
[ ! -e "$L8U_E2E_STATE/verify.sleep" ] || sleep "$(cat "$L8U_E2E_STATE/verify.sleep")"
[ ! -e "$L8U_E2E_STATE/verify.fail" ] || { echo "L8U_VERIFY=FAIL reason=STUB" >&2; exit 1; }
echo "L8U_VERIFY=PASS"
'''
ID_STUB = '''#!/bin/sh
if [ -n "$L8U_E2E_FAKEROOT" ] && [ "$1" = "-u" ] && [ $# -eq 1 ]; then echo 0; exit 0; fi
exec /usr/bin/id "$@"
'''
SIMPLE = {"ss": '#!/bin/sh\necho "LISTEN 0 128 10.77.30.1:8883 0.0.0.0:*"\necho "LISTEN 0 128 127.0.0.1:8883 0.0.0.0:*"\n', "df": '#!/bin/sh\necho "Filesystem 1K-blocks Used Available Use% Mounted on"\necho "x 100 10 90 10% /"\n',
          "pgrep": '#!/bin/sh\necho 1\n', "chattr": '#!/bin/sh\nexit 0\n'}
UNITS = {
    "aegis-idea3-core.service": {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "enabled", "Result": "success", "NRestarts": "0", "MainPID": "4242", "DropInPaths": "", "NeedDaemonReload": "no", "ProtectClock": "no"},
    "aegis-idea3-detector.service": {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "UnitFileState": "disabled", "Result": "success", "NRestarts": "0", "MainPID": "4343", "Restart": "no"},
    "aegis-idea3-mosquitto.service": {"ActiveState": "active", "SubState": "running", "UnitFileState": "enabled", "Result": "success", "MainPID": "500", "NRestarts": "1", "InvocationID": "abc"},
    "mosquitto.service": {"ActiveState": "active", "SubState": "running"}, "twingate.service": {"ActiveState": "active", "SubState": "running"},
    "aegis-detection-engine.service": {"ActiveState": "active", "SubState": "running"}, "aegis-detection-tunnel.service": {"ActiveState": "active", "SubState": "running"},
}


class Sandbox:
    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        self.state = tmp / "state"
        self.bin = tmp / "bin"
        self.gov = tmp / "gov"
        self.evid_root = tmp / "evidence"
        self.auth = tmp / "auth"
        for d in (self.state, self.bin, self.evid_root):
            d.mkdir(parents=True, exist_ok=True)
        self.gov.mkdir(mode=0o700)
        (self.gov / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").write_text("RECOVERY_ATTEMPT_CONSUMED=YES\n")  # the governed Recovery ran (its own marker; L8u only READS it)
        self.auth.mkdir(mode=0o700)
        for unit, props in UNITS.items():
            for prop, value in props.items():
                path = self.state / "units" / unit / prop
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
        for name, body in {"sudo": SUDO_STUB, "systemctl": SYSTEMCTL_STUB, "id": ID_STUB, **SIMPLE}.items():
            (self.bin / name).write_text(body)
            (self.bin / name).chmod(0o755)
        self.unit_file = tmp / "core.service"
        self.unit_file.write_text("[Service]\nProtectClock=false\n")
        self.unit_sha = hashlib.sha256(self.unit_file.read_bytes()).hexdigest()
        self.l8p = tmp / "l8p-run.json"
        self.l8p.write_text("{}")
        self.l8p.chmod(0o600)
        self.build_repo()
        self.build_control_and_runner()

    # ---- throwaway repository: the real p4 tree + stubs, LVR PASS as a descendant ------------------------------------------------------------------
    def build_repo(self) -> None:
        self.repo = self.tmp / "repo"
        self.repo.mkdir()
        s.git(self.repo, "init", "-q", "-b", "main")
        s.git(self.repo, "config", "user.email", "t@e.invalid")
        s.git(self.repo, "config", "user.name", "t")
        tree = self.repo / P4_REL
        shutil.copytree(s.P4, tree, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"), symlinks=False)
        for rel, body in {"p4-l0-capture.sh": CAPTURE_STUB, "p4-compare.sh": COMPARE_STUB, "p4-l8u-observe.py": OBSERVE_STUB, "stages/L8u/verify.sh": VERIFY_STUB}.items():
            (tree / rel).write_text(body)
        lib = (tree / "p4-l8u-run-lib.sh").read_text()
        for old, new in (("L8U_CANONICAL_DIR=/var/lib/aegis-idea3-governance", f"L8U_CANONICAL_DIR={self.gov}"), ("owner=0 stop=/", f'owner=$(id -u) stop="{self.tmp}"'),
                         ("L8U_CORE_UNIT_PATH=/etc/systemd/system/aegis-idea3-core.service", f"L8U_CORE_UNIT_PATH={self.unit_file}")):
            assert lib.count(old) == 1, old
            lib = lib.replace(old, new)
        (tree / "p4-l8u-run-lib.sh").write_text(lib)
        (self.repo / s.TEMPLATE_REL).write_text(s.RUNNER.read_text())
        (self.repo / s.L8P_REL).parent.mkdir(parents=True, exist_ok=True)
        (self.repo / s.L8P_REL).write_text(s.L8P_RECEIPT)
        s.git(self.repo, "add", "-A")
        s.git(self.repo, "commit", "-q", "-m", "execution main")
        self.execution = s.git(self.repo, "rev-parse", "HEAD")
        (self.repo / s.LVR_REL).write_text(s.lvr_receipt(self.execution))
        s.git(self.repo, "add", "-A")
        s.git(self.repo, "commit", "-q", "-m", "LVR closeout")
        self.main = s.git(self.repo, "rev-parse", "HEAD")
        origin = self.tmp / "origin.git"
        subprocess.run(["git", "clone", "-q", "--bare", str(self.repo), str(origin)], check=True)
        s.git(self.repo, "remote", "add", "origin", str(origin))
        s.git(self.repo, "fetch", "-q", "origin")

    # ---- control snapshot + mechanically frozen runner (+ the documented test-copy substitutions) --------------------------------------------------
    def build_control_and_runner(self) -> None:
        self.control = self.tmp / "control"
        manifest = snap.control_snapshot(self.repo / P4_REL, self.control, trust_root=str(self.tmp))
        lvr_sha = hashlib.sha256((self.repo / s.LVR_REL).read_bytes()).hexdigest()
        self.lvr_sha, self.fw = lvr_sha, "f" * 64
        user = subprocess.run(["id", "-un"], text=True, capture_output=True).stdout.strip()
        pins = {
            "EXPECTED_MAIN": self.main, "OPERATOR_USER": user, "OPERATOR_UID": str(os.getuid()), "CONTROL_SNAPSHOT_DIR": str(self.control), "CONTROL_MANIFEST_SHA256": manifest, "CORE_UNIT_SHA256": self.unit_sha,
            "DEVICE_ID": "esp32-01", "DEVICE_MAC": s.MAC, "FIRMWARE_SHA256": self.fw, "L8P_EVIDENCE_FILE": str(self.l8p), "L8P_EVIDENCE_SHA256": hashlib.sha256(self.l8p.read_bytes()).hexdigest(), "LVR_CLOSEOUT_SHA256": lvr_sha,
            "EXPECTED_STATE": "LOCKDOWN", "OBSERVE_SECONDS": "30", "REPO": str(self.repo), "PY": "/usr/bin/python3", "EVIDENCE_ROOT": str(self.evid_root),
        }
        self.pins = pins
        frozen = self.tmp / "frozen.sh"
        freeze.freeze(self.repo, self.main, pins, frozen)
        text = frozen.read_text()
        for old, new in (("SNAPSHOT_OWNER_UID=0", f"SNAPSHOT_OWNER_UID={os.getuid()}"), ("SNAPSHOT_TRUST_ROOT=/\n", f"SNAPSHOT_TRUST_ROOT={self.tmp}\n"),
                         ("export PATH=/usr/sbin:/usr/bin:/sbin:/bin", f"export PATH={self.bin}:/usr/sbin:/usr/bin:/sbin:/bin")):
            assert text.count(old) == 1, old
            text = text.replace(old, new)
        self.runner = self.tmp / "runner.sh"
        self.runner.write_text(text)
        self.runner_sha = hashlib.sha256(text.encode()).hexdigest()
        self.write_records()

    def write_records(self, **override: str) -> None:
        today = subprocess.run(["date", "+%F"], env={**os.environ, "TZ": "Asia/Bangkok"}, text=True, capture_output=True).stdout.strip()
        names = {"main": self.main, "runner": self.runner_sha, "mac": s.MAC, "fw": self.fw, "lvr": self.lvr_sha, **override}
        (self.auth / "authorization-L8u.txt").write_text(f"AEGIS_P4_AUTHORIZATION_V1\nstage=L8u\ndate={today}\nauthorizer=music\nscope=L8u logical acceptance main {names['main']} runner {names['runner']}\n"
                                                          f"reference=https://example.test/l8u/{names['mac']}/{names['fw']}/{names['lvr']}\n")
        (self.auth / "k3-L8u.txt").write_text(f"AEGIS_P4_K3_CONFIRMATION_V2\nstage=L8u\ndate={today}\nconfirmed_by=music\nconfirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\nidea1_window_overlap=NONE_KNOWN\nreference=https://example.test/k3/{self.main}\n")

    def env(self, **extra: str) -> dict[str, str]:
        return {"PATH": os.environ["PATH"], "HOME": str(self.tmp), "L8U_E2E_STATE": str(self.state), "TZ": "Asia/Bangkok", **extra}

    def flag(self, name: str, content: str = "") -> None:
        (self.state / name).write_text(content)

    def run(self, **extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(self.runner), str(self.auth)], env=self.env(**extra), text=True, capture_output=True, timeout=120)

    def popen(self, **extra: str) -> subprocess.Popen[str]:
        return subprocess.Popen(["bash", str(self.runner), str(self.auth)], env=self.env(**extra), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)

    def calls(self) -> list[str]:
        path = self.state / "calls.log"
        return path.read_text().splitlines() if path.exists() else []

    def evidence(self) -> Path | None:
        found = sorted(self.evid_root.glob("*-l8u-*"))
        return found[-1] if found else None

    def marker(self) -> Path:
        return self.gov / "L8U-GLOBAL-ATTEMPT-CONSUMED"

    def closeout(self, kind: str) -> Path:
        return self.gov / f"L8U-GLOBAL-CLOSEOUT-{kind}"


def both(run) -> str:
    """After the evidence directory exists the runner's stderr is merged into the tee'd run log (stdout), so assertions read both streams."""
    return run.stdout + run.stderr


@pytest.fixture()
def box(tmp_path: Path):
    sandbox = Sandbox(tmp_path)
    yield sandbox
    # nothing outlives a run: not the sudo keepalive, not the log tee, not a stage handler (a refusal before the attempt included)
    time.sleep(0.3)
    leftovers = subprocess.run(["pgrep", "-f", str(tmp_path / "runner.sh")], text=True, capture_output=True).stdout.split()
    assert leftovers == [], f"runner processes left behind: {leftovers}"


def test_a_valid_run_passes_in_the_documented_order_and_writes_the_durable_closeout(box: Sandbox) -> None:
    run = box.run()
    assert run.returncode == 0, run.stderr + run.stdout
    assert "L8U_LIVE=PASS L8U_CLAIM=LOGICAL_ACCEPTANCE_ONLY L8P_EXECUTED=NO ESP32_TOUCHED=NO ELECTRICAL_RELAY_PROOF=NO L9_PROVEN=NO" in run.stdout
    assert box.calls() == ["capture l8u-pre", "capture l8u-post", f"compare {box.control}/stages/L8u/allow-keys.txt", "verify"]  # apply is the real observe-only handler; no device call exists
    assert box.marker().is_file() and box.closeout("PASS").is_file() and not box.closeout("FAIL").exists()
    marker = box.marker().read_text()
    assert "L8U_ATTEMPT_CONSUMED=YES" in marker and "L8U_RERUN_ALLOWED=NO" in marker and "L8U_PRE_PROTOCOL_SEEN_ID=7" in marker
    closeout = box.closeout("PASS").read_text().splitlines()
    for line in ("L8U_RESULT=PASS", "L8U_LIVE=CLOSED_PASS", f"L8U_EXPECTED_MAIN={box.main}", f"L8U_RUNNER_SHA256={box.runner_sha}", "L8U_LOGICAL_ACCEPTANCE=PASS", "L8_ACCEPTANCE=NOT_PROMOTED_UNTIL_A_REVIEWED_CLOSEOUT", "L8P_EXECUTED=NO", "ESP32_REFLASH_PERFORMED=NO", "NTP_RERUN=NO", "L9_PROVEN=NO"):
        assert line in closeout, line
    evid = box.evidence()
    assert evid is not None and (evid / "terminal-result").read_text().startswith("L8U_RESULT=PASS") and (evid / "pre-root/label.txt").is_file() and (evid / "post-root/label.txt").is_file()
    assert (evid / "authorization-L8u.txt").is_file() and (evid / "frozen-inputs.txt").read_text().count("ESP32_TOUCHED=NO") == 1
    assert (box.state / "observer-calls.log").read_text().split() == ["--preflight", "--check-l8p-evidence", "--preflight", "--capture-boundary"]
    assert (box.state / "units/aegis-idea3-core.service/MainPID").read_text() == "4242"  # nothing restarted anything: the stub never saw a start/stop verb


def test_there_is_no_second_attempt_and_the_closeout_survives(box: Sandbox) -> None:
    assert box.run().returncode == 0
    again = box.run()
    assert again.returncode == 1 and "REFUSED_BEFORE_ATTEMPT" in both(again) and "ONE attempt TOTAL" in both(again)
    assert box.closeout("PASS").is_file() and len(box.calls()) == 4  # no further capture happened


def test_a_verify_failure_is_immutable_with_a_fail_closeout_and_no_rollback_action(box: Sandbox) -> None:
    box.flag("verify.fail")
    run = box.run()
    assert run.returncode == 1 and "L8U_RESULT=FAIL_IMMUTABLE L8U_ATTEMPT_CONSUMED=YES reason=VERIFY" in both(run)
    assert box.marker().is_file() and box.closeout("FAIL").is_file() and not box.closeout("PASS").exists()
    fail = box.closeout("FAIL").read_text().splitlines()
    assert "L8U_FAILURE_REASON=VERIFY" in fail and "L8U_RERUN_ALLOWED=NO" in fail and "L8_ACCEPTANCE=NO" in fail
    result = (box.evidence() / "terminal-result").read_text()
    assert "L8U_RESULT=FAIL_IMMUTABLE" in result and "L8U_ROLLBACK=NOT_REQUIRED" in result and "ESP32_TOUCHED=NO" in result and "L8U_RERUN_ALLOWED=NO" in result
    assert not any("rollback" in call for call in box.calls())
    retry = box.run()
    assert retry.returncode == 1 and "REFUSED_BEFORE_ATTEMPT" in both(retry)  # a consumed attempt is never retried


@pytest.mark.parametrize("flag,reason", [("capture-l8u-post.fail", "POST_CAPTURE"), ("compare.fail", "COMPARE_S10")])
def test_post_capture_and_compare_failures_are_immutable_and_never_reach_verify(box: Sandbox, flag: str, reason: str) -> None:
    box.flag(flag)
    run = box.run()
    assert run.returncode == 1 and f"reason={reason}" in both(run)
    assert "verify" not in box.calls() and box.closeout("FAIL").is_file() and not box.closeout("PASS").exists()


def test_a_secret_in_the_evidence_fails_the_stage_after_the_attempt_and_never_reaches_verify(box: Sandbox) -> None:
    tree = box.repo / P4_REL
    # the control snapshot is immutable: rebuild the sandbox control with a leaking POST capture committed in the throwaway repository
    leaking = CAPTURE_STUB + 'if [ "$CAPTURE_LABEL" = l8u-post ]; then echo "AEGIS_MQTT_PASS=hunter2" > "$EVID_DIR/leak.txt"; fi\n'
    (tree / "p4-l0-capture.sh").write_text(leaking)
    s.git(box.repo, "add", "-A")
    s.git(box.repo, "commit", "-q", "-m", "leaking capture stub")
    s.git(box.repo, "push", "-q", "origin", "main")
    box.main = s.git(box.repo, "rev-parse", "HEAD")
    subprocess.run(["chmod", "-R", "u+w", str(box.control)], check=True)
    shutil.rmtree(box.control)
    (box.tmp / "frozen.sh").unlink()
    box.build_control_and_runner()  # the LVR closeout is an ancestor-added receipt, still valid at the new main
    run = box.run()
    assert run.returncode == 1 and "reason=SECRET_SCAN" in both(run) and "verify" not in box.calls()
    assert "L8U_EVIDENCE_SECRET_SCAN=HITS_OR_FAILED" in (box.evidence() / "terminal-result").read_text()
    assert "hunter2" not in both(run)  # the scanner prints counts only


@pytest.mark.parametrize("flag,reason_part", [("preflight.fail", "L8U_RUNTIME_PREFLIGHT_FAILED"), ("check-l8p-evidence.fail", "L8U_L8P_HISTORICAL_EVIDENCE_INVALID")])
def test_pre_attempt_gate_failures_consume_nothing(box: Sandbox, flag: str, reason_part: str) -> None:
    box.flag(flag)
    run = box.run()
    assert run.returncode == 1 and "REFUSED_BEFORE_ATTEMPT" in both(run) and reason_part in both(run)
    assert not box.marker().exists() and box.evidence() is None and box.calls() == []


def test_a_failed_pre_capture_after_the_pregates_consumes_nothing_and_a_fresh_run_is_allowed(box: Sandbox) -> None:
    box.flag("capture-l8u-pre.fail")
    run = box.run()
    assert run.returncode == 1 and "L8U_RESULT=REFUSED_BEFORE_ATTEMPT L8U_ATTEMPT_CONSUMED=NO reason=PRE_CAPTURE" in both(run)
    assert not box.marker().exists() and not box.closeout("FAIL").exists()
    assert "L8U_RERUN_ALLOWED=ONLY_WITH_A_FRESH_AUTHORIZATION" in (box.evidence() / "terminal-result").read_text()
    (box.state / "capture-l8u-pre.fail").unlink()
    assert box.run().returncode == 0


def test_authorization_not_bound_to_the_frozen_runner_main_device_firmware_or_lvr_closeout_is_refused(box: Sandbox) -> None:
    for override in ({"runner": "e" * 64}, {"main": "e" * 40}, {"mac": "aa:bb:cc:dd:ee:99"}, {"fw": "e" * 64}, {"lvr": "e" * 64}):
        box.write_records(**override)
        run = box.run()
        assert run.returncode == 1 and "REFUSED_BEFORE_ATTEMPT" in both(run) and "L8U_AUTHORIZATION_DOES_NOT_NAME_A_FROZEN_BINDING" in both(run), override
        assert not box.marker().exists()


def test_a_recovery_authorization_cannot_run_l8u(box: Sandbox) -> None:
    path = box.auth / "authorization-L8u.txt"
    path.write_text(path.read_text().replace("stage=L8u", "stage=Recovery"))
    run = box.run()
    assert run.returncode == 1 and "L8U_RECORD_NOT_STAGE_L8U" in both(run) and not box.marker().exists()


def test_lvr_missing_or_failed_in_the_pinned_main_refuses_before_anything_is_touched(box: Sandbox) -> None:
    (box.repo / s.LVR_REL).write_text(s.lvr_receipt(box.execution, LVR_RESULT="FAIL"))  # an uncommitted worktree edit is a dirty tree...
    run = box.run()
    assert run.returncode == 1 and "worktree is not clean" in both(run)
    s.git(box.repo, "checkout", "--", s.LVR_REL)
    s.git(box.repo, "rm", "-q", s.LVR_REL)
    s.git(box.repo, "commit", "-q", "-m", "drop the closeout")
    run = box.run()
    assert run.returncode == 1 and "nothing was sourced, created or touched" in both(run) and not box.marker().exists() and box.calls() == []


def test_a_stale_origin_main_refuses(box: Sandbox) -> None:
    (box.repo / "later.txt").write_text("x")
    s.git(box.repo, "add", "-A")
    s.git(box.repo, "commit", "-q", "-m", "local only")
    s.git(box.repo, "push", "-q", "origin", "main")
    s.git(box.repo, "reset", "-q", "--hard", box.main)  # worktree back at the pinned main, origin/main moved on
    run = box.run()
    assert run.returncode == 1 and "origin/main is not" in both(run) and not box.marker().exists()


def test_a_drifted_control_snapshot_dies_before_the_library_is_sourced(box: Sandbox) -> None:
    os.chmod(box.control / "p4-l8u-run-lib.sh", 0o644)
    (box.control / "p4-l8u-run-lib.sh").write_text("echo SOURCED_TAMPERED_LIB >&2\n")
    run = box.run()
    assert run.returncode == 1 and "control snapshot is not the frozen immutable authority" in both(run) and "SOURCED_TAMPERED_LIB" not in both(run)
    assert not box.marker().exists() and box.evidence() is None


def test_a_core_restart_unit_drift_or_wrong_runtime_state_refuses_before_the_attempt(box: Sandbox) -> None:
    box.unit_file.write_text("[Service]\nProtectClock=true\n")
    run = box.run()
    assert run.returncode == 1 and "L8U_CORE_UNIT_NOT_THE_PINNED_UNIT" in both(run) and not box.marker().exists()
    box.unit_file.write_text("[Service]\nProtectClock=false\n")
    (box.state / "units/aegis-idea3-core.service/NRestarts").write_text("2")
    run = box.run()
    assert run.returncode == 1 and "REFUSED_BEFORE_ATTEMPT" in both(run) and not box.marker().exists()


def test_a_missing_recovery_marker_refuses_before_the_attempt(box: Sandbox) -> None:
    (box.gov / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").unlink()
    run = box.run()
    assert run.returncode == 1 and "Recovery attempt marker is missing" in both(run) and not box.marker().exists()


@pytest.mark.parametrize("sig,name", [(signal.SIGTERM, "TERM"), (signal.SIGHUP, "HUP"), (signal.SIGINT, "INT")])
def test_a_signal_after_the_attempt_is_a_terminal_immutable_failure_without_rollback(box: Sandbox, sig: int, name: str) -> None:
    box.flag("verify.sleep", "3")
    proc = box.popen()
    deadline = time.time() + 60
    while time.time() < deadline and not box.marker().exists():
        time.sleep(0.1)
    assert box.marker().exists(), "the attempt was never consumed"
    while time.time() < deadline and "verify" not in box.calls():
        time.sleep(0.1)
    proc.send_signal(sig)
    out, err = proc.communicate(timeout=60)
    assert proc.returncode == 1, (out, err)
    assert f"reason=SIGNAL_{name}" in out + err
    assert box.closeout("FAIL").is_file() and not box.closeout("PASS").exists()
    assert f"L8U_FAILURE_REASON=SIGNAL_{name}" in (box.evidence() / "terminal-result").read_text()
    assert not any("rollback" in call for call in box.calls())


def test_a_signal_before_the_attempt_consumes_nothing_and_leaves_no_closeout(box: Sandbox) -> None:
    box.flag("capture-l8u-pre.sleep", "3")  # the PRE capture is the long pre-attempt step
    proc = box.popen()
    deadline = time.time() + 60
    while time.time() < deadline and box.evidence() is None:
        time.sleep(0.05)
    assert box.evidence() is not None
    proc.send_signal(signal.SIGTERM)
    out, err = proc.communicate(timeout=60)
    assert proc.returncode == 1 and "REFUSED_BEFORE_ATTEMPT L8U_ATTEMPT_CONSUMED=NO reason=SIGNAL_TERM" in out + err
    assert not box.marker().exists() and not box.closeout("FAIL").exists() and not box.closeout("PASS").exists()


def test_no_l8u_stage_call_ever_reaches_a_device_or_a_service_control_verb(box: Sandbox) -> None:
    assert box.run().returncode == 0
    log = "\n".join(box.calls())
    assert "esptool" not in log and "flash" not in log and "restart" not in log
    systemctl_args = [p for p in (box.state / "units").rglob("*") if p.is_file()]
    assert all(p.read_text() != "restarted" for p in systemctl_args)
