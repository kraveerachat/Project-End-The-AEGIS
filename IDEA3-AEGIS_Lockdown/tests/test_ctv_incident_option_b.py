"""Hermetic tests for the CTv incident Option B read-only verifier and the (unauthorized, unexecuted) disposition action.

Nothing here touches the real host: systemctl/pgrep are stubs on a test-only PATH, the canonical/work dirs are temp dirs, and the
exact-main git repository is a temp repo holding byte-copies of the real scripts and libraries.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "IDEA3-AEGIS_Lockdown"
P4 = APP / "deploy" / "pr11-phase4"
INCIDENT = P4 / "ctv-incident"
VERIFIER_SRC = INCIDENT / "ctv-option-b-verify.sh"
ACTION_SRC = INCIDENT / "ctv-incident-disposition.sh"
UNIT_EXAMPLE = APP / "deploy" / "aegis-idea3-core.service.example"
PIN_UNIT = "82446332f6367f16390f432370ec9bcb7f16f78d0bc6badb4f187b7a74c1627c"
REPO_FILES = (
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-option-b-verify.sh",
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-incident/ctv-incident-disposition.sh",
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh",
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh",
    "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l5-clock.py",
    "IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.service.example",
    "IDEA3-AEGIS_Lockdown/aegis_soc/__init__.py",
    "IDEA3-AEGIS_Lockdown/aegis_soc/trusted_time.py",
    "IDEA3-AEGIS_Lockdown/aegis_soc/protocol_v1.py",
)
DEVICE = "aegis-relay-01"
DROPINS = "/etc/systemd/system/aegis-idea3-core.service.d/10-recovery.conf /etc/systemd/system/aegis-idea3-core.service.d/20-f1-alert.conf"

SYSTEMCTL = r'''#!/usr/bin/env python3
import json, os, sys
state_path = os.environ["FAKE_STATE"]
st = json.load(open(state_path))
open(os.environ["FAKE_CALLS"], "a").write("systemctl " + " ".join(sys.argv[1:]) + "\n")
args = sys.argv[1:]
if not args or args[0] != "show":
    sys.exit(0)
props, value_only, unit = [], False, None
i = 1
while i < len(args):
    if args[i] == "-p": props.append(args[i + 1]); i += 2
    elif args[i] == "--value": value_only = True; i += 1
    else: unit = args[i]; i += 1
side = "core" if unit == "aegis-idea3-core.service" else "detector"
vals = dict(st[side])
if side == "core":
    n = st.get("calls", 0) + 1
    st["calls"] = n
    json.dump(st, open(state_path, "w"))
    if st.get("flip_after") is not None and n > st["flip_after"] and "MainPID" in props:
        vals["MainPID"] = "4321"
for p in props:
    v = vals.get(p, "")
    print(v if value_only else f"{p}={v}")
'''
PGREP = '#!/bin/bash\necho "${FAKE_PGREP_COUNT:-0}"\n[ "${FAKE_PGREP_COUNT:-0}" != 0 ]\n'


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git(repo: Path, *args: str) -> str:
    env = dict(os.environ, HOME="/nonexistent", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null")
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True, env=env).strip()


class World:
    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        self.repo = tmp / "repo"
        for rel in REPO_FILES:
            dest = self.repo / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / rel, dest)
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@example.invalid")
        git(self.repo, "config", "user.name", "T")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "exact main")
        self.main = git(self.repo, "rev-parse", "HEAD")
        self.verifier = self.repo / REPO_FILES[0]
        self.action = self.repo / REPO_FILES[1]
        self.canon = tmp / "canon"
        self.work = tmp / "work"
        self.unit = tmp / "installed.service"
        self.core_env = tmp / "core.env"
        self.bin = tmp / "bin"
        self.state = tmp / "state.json"
        self.calls = tmp / "calls"
        self.auth = tmp / "authorization.txt"
        for d in (self.canon, self.work / "pre-root", self.work / "post-root", self.bin):
            d.mkdir(parents=True)
        shutil.copy2(UNIT_EXAMPLE, self.unit)
        self.unit.chmod(0o644)
        self.preimage = self.work / "journal.preimage"
        self.preimage.write_text("ORIGINAL-UNIT-BYTES\n")
        self.pre_sha = sha(self.preimage)
        (self.work / "journal").write_text(f"phase=apply-verified\npreimage={self.preimage}\n")
        (self.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").write_text(
            f"CTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\nCTV_FROZEN_RUNNER_SHA256={'a' * 64}\nwork={self.work}\n")
        (self.canon / "CTU-GLOBAL-ATTEMPT-CONSUMED").write_text("CTU_ATTEMPT_CONSUMED=YES\n")
        (self.canon / "CTU-GLOBAL-CLOSEOUT-FAIL").write_text("CTU_RESULT=FAIL_IMMUTABLE\n")
        self.core_env.write_text(f"AEGIS_P1_DEVICE_ID={DEVICE}\n")
        for d in ("pre-root", "post-root"):
            (self.work / d / "capture.log").write_text("L0_CAPTURE=COMPLETE\n")
            (self.work / d / "SHA256SUMS").write_text(f"{sha(self.work / d / 'capture.log')}  capture.log\n")
        (self.work / "compare-pre-post.txt").write_text("PRESERVATION_S10=FAIL\nCOMPARE_RESULT=FAIL\n")
        (self.bin / "systemctl").write_text(SYSTEMCTL)
        (self.bin / "pgrep").write_text(PGREP)
        for b in self.bin.iterdir():
            b.chmod(0o755)
        self.set_state({
            "core": {"LoadState": "loaded", "ActiveState": "active", "SubState": "running", "Result": "success", "MainPID": "1234",
                     "InvocationID": "0123456789abcdef0123456789abcdef", "ExecMainStartTimestampMonotonic": "555", "NRestarts": "0",
                     "FragmentPath": str(self.unit), "NeedDaemonReload": "no", "ProtectClock": "no", "User": "aegis-idea3",
                     "NoNewPrivileges": "yes", "CapabilityBoundingSet": "", "AmbientCapabilities": "", "DropInPaths": DROPINS},
            "detector": {"LoadState": "loaded", "ActiveState": "inactive", "SubState": "dead", "UnitFileState": "disabled", "Restart": "no",
                         "Result": "success", "MainPID": "0", "InvocationID": "", "ExecMainStartTimestampMonotonic": "0", "NRestarts": "0"},
        })
        self.write_auth()

    def set_state(self, state: dict) -> None:
        self.state.write_text(json.dumps(state))

    def edit_state(self, side: str, **kv: str) -> None:
        st = json.loads(self.state.read_text())
        st[side].update(kv)
        self.set_state(st)

    def write_auth(self, extra: str = "", drop: str = "") -> None:
        lines = [
            "stage=CTv-incident-disposition", "disposition=OPTION_B_TARGET_UNIT_RETAINED", f"expected_main={self.main}",
            f"unit_sha256={PIN_UNIT}", f"preimage_sha256={self.pre_sha}", f"device_id={DEVICE}",
            f"verifier_sha256={sha(self.verifier)}", f"action_sha256={sha(self.action)}", "authorization_id=AUTH-TEST-0001",
        ]
        lines = [l for l in lines if not (drop and l.startswith(drop))]
        self.auth.write_text("\n".join(lines) + "\n" + extra)
        self.auth.chmod(0o600)

    def common(self, main: str | None = None) -> list[str]:
        return ["--repo", str(self.repo), "--main", main or self.main, "--canon", str(self.canon), "--work", str(self.work), "--device", DEVICE,
                "--hermetic", "--unit-dest", str(self.unit), "--core-env", str(self.core_env), "--clock-fixture", "synced:5",
                "--preimage-sha256", self.pre_sha, "--path-prefix", str(self.bin)]

    def env(self, **extra: str) -> dict[str, str]:
        return dict(os.environ, FAKE_STATE=str(self.state), FAKE_CALLS=str(self.calls), **extra)

    def verify(self, *more: str, main: str | None = None, **env: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(self.verifier), *self.common(main), *more], text=True, capture_output=True, env=self.env(**env))

    def action_run(self, *more: str, **env: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([str(self.action), "--authorization", str(self.auth), *self.common(), *more], text=True, capture_output=True, env=self.env(**env))

    def snapshot(self) -> dict[str, str]:
        out = {}
        for base in (self.canon, self.work):
            for p in sorted(base.rglob("*")):
                if p.is_file():
                    out[str(p)] = sha(p)
        out[str(self.unit)] = sha(self.unit)
        return out


@pytest.fixture()
def world(tmp_path: Path) -> World:
    return World(tmp_path)


def test_verifier_passes_on_the_verified_incident_state_and_is_strictly_read_only(world: World) -> None:
    before = world.snapshot()
    r = world.verify()
    assert r.returncode == 0, r.stderr
    last = r.stdout.strip().splitlines()[-1]
    assert last == "CTV_OPTION_B_VERIFY=PASS"
    for expected in ("CTV_OPTION_B_UNIT_SHA256=" + PIN_UNIT, "CTV_OPTION_B_TRUSTEDCLOCK=SYNCED", "CTV_OPTION_B_DETECTOR_BASELINE_MODE=INACTIVE",
                     "CTV_OPTION_B_DROPINS=EXACT", "CTV_OPTION_B_ROLLBACK_COMPLETE=NO", "CTV_OPTION_B_S10_HISTORICAL_COMPARE=FAIL",
                     "CTV_OPTION_B_S10_PROMOTED_TO_PASS=NO", "CTV_OPTION_B_RECOVERY_AUTHORITY_UNCHANGED=YES", "CTV_OPTION_B_ADDITIONAL_RESTART=NO"):
        assert expected in r.stdout, expected
    assert world.snapshot() == before
    verbs = {line.split()[1] for line in world.calls.read_text().splitlines()}
    assert verbs == {"show"}


def test_verifier_refuses_every_test_seam_without_hermetic(world: World) -> None:
    for flag, val in (("--unit-dest", str(world.unit)), ("--core-env", str(world.core_env)), ("--clock-fixture", "synced:5"),
                      ("--preimage-sha256", "0" * 64), ("--path-prefix", str(world.bin))):
        r = subprocess.run([str(world.verifier), "--repo", str(world.repo), "--main", world.main, "--canon", str(world.canon), "--work", str(world.work),
                            "--device", DEVICE, flag, val], text=True, capture_output=True, env=world.env())
        assert r.returncode == 1 and "NON_HERMETIC_OVERRIDE_REFUSED" in r.stderr, flag


def _mut_unit(w: World) -> None:
    w.unit.write_text(w.unit.read_text() + "# tampered\n")


def _mut_preimage(w: World) -> None:
    w.preimage.write_text("DIFFERENT\n")


def _mut_phase(w: World) -> None:
    (w.work / "journal").write_text(f"phase=rollback-complete\npreimage={w.preimage}\n")


def _mut_pass_closeout(w: World) -> None:
    (w.canon / "CTV-GLOBAL-CLOSEOUT-PASS").write_text("x\n")


def _mut_fail_closeout(w: World) -> None:
    (w.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").write_text("x\n")


def _mut_recovery(w: World) -> None:
    (w.canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").write_text("x\n")


def _mut_marker_work(w: World) -> None:
    (w.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").write_text("CTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\nwork=/some/other/work\n")


def _mut_marker_rerun(w: World) -> None:
    (w.canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").write_text(f"CTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=YES\nwork={w.work}\n")


def _mut_evidence(w: World) -> None:
    (w.work / "post-root" / "capture.log").write_text("L0_CAPTURE=COMPLETE\ntampered\n")


def _mut_s10_pass(w: World) -> None:
    (w.work / "compare-pre-post.txt").write_text("PRESERVATION_S10=PASS\nCOMPARE_RESULT=PASS\n")


def _mut_device(w: World) -> None:
    w.core_env.write_text("AEGIS_P1_DEVICE_ID=another-device\n")


def _mut_unit_symlink(w: World) -> None:
    real = w.tmp / "real.service"
    shutil.move(str(w.unit), real)
    w.unit.symlink_to(real)


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (_mut_unit, "UNIT_IDENTITY_INVALID"),
        (_mut_unit_symlink, "UNIT_IDENTITY_INVALID"),
        (_mut_preimage, "PREIMAGE_SHA256_MISMATCH"),
        (_mut_phase, "JOURNAL_NOT_APPLY_VERIFIED"),
        (_mut_pass_closeout, "CTV_PASS_CLOSEOUT_PRESENT"),
        (_mut_fail_closeout, "CTV_FAIL_CLOSEOUT_ALREADY_PRESENT"),
        (_mut_recovery, "RECOVERY_AUTHORITY_PRESENT"),
        (_mut_marker_work, "CTV_MARKER_WORK_DIR_MISMATCH"),
        (_mut_marker_rerun, "CTV_MARKER_INVALID"),
        (_mut_evidence, "EVIDENCE_INTEGRITY_FAIL"),
        (_mut_s10_pass, "HISTORICAL_S10_IS_NOT_A_FAIL"),
        (_mut_device, "DEVICE_ID_MISMATCH"),
    ],
)
def test_verifier_fails_closed_on_file_and_governance_drift(world: World, mutate, reason: str) -> None:
    mutate(world)
    r = world.verify()
    assert r.returncode == 1 and f"reason={reason}" in r.stderr, r.stderr
    assert "CTV_OPTION_B_VERIFY=PASS" not in r.stdout


@pytest.mark.parametrize(
    ("side", "kv", "reason"),
    [
        ("core", {"ActiveState": "inactive", "SubState": "dead"}, "CORE_NOT_ACTIVE_RUNNING"),
        ("core", {"Result": "exit-code"}, "CORE_NOT_ACTIVE_RUNNING"),
        ("core", {"MainPID": "0"}, "CORE_MAINPID_INVALID"),
        ("core", {"NeedDaemonReload": "yes"}, "CORE_NEEDS_DAEMON_RELOAD"),
        ("core", {"FragmentPath": "/etc/systemd/system/other.service"}, "CORE_FRAGMENT_PATH_MISMATCH"),
        ("core", {"ProtectClock": "yes"}, "EFFECTIVE_SECURITY_PROPERTIES_INVALID"),
        ("core", {"User": "root"}, "EFFECTIVE_SECURITY_PROPERTIES_INVALID"),
        ("core", {"NoNewPrivileges": "no"}, "EFFECTIVE_SECURITY_PROPERTIES_INVALID"),
        ("core", {"CapabilityBoundingSet": "cap_sys_time"}, "EFFECTIVE_SECURITY_PROPERTIES_INVALID"),
        ("core", {"AmbientCapabilities": "cap_sys_time"}, "EFFECTIVE_SECURITY_PROPERTIES_INVALID"),
        ("core", {"DropInPaths": DROPINS + " /etc/systemd/system/aegis-idea3-core.service.d/99-extra.conf"}, "DROPINS_NOT_EXACT"),
        ("core", {"DropInPaths": DROPINS.split()[0]}, "DROPINS_NOT_EXACT"),
        ("detector", {"ActiveState": "active", "SubState": "running", "MainPID": "77"}, "DETECTOR_BASELINE_NOT_INACTIVE"),
    ],
)
def test_verifier_fails_closed_on_runtime_drift(world: World, side: str, kv: dict[str, str], reason: str) -> None:
    world.edit_state(side, **kv)
    r = world.verify()
    assert r.returncode == 1 and f"reason={reason}" in r.stderr, r.stderr


def test_verifier_fails_closed_on_untrusted_clock_wrong_main_and_dirty_authority(world: World) -> None:
    assert world.verify().returncode == 0
    args = world.common()
    args[args.index("synced:5")] = "unsynced:5"
    r = subprocess.run([str(world.verifier), *args], text=True, capture_output=True, env=world.env())
    assert r.returncode == 1 and ("TRUSTEDCLOCK_NOT_OK" in r.stderr or "TRUSTEDCLOCK_NOT_SYNCED" in r.stderr), r.stderr
    wrong_main = world.verify(main="0" * 40)
    assert wrong_main.returncode == 1 and "REPO_HEAD_NOT_EXPECTED_MAIN" in wrong_main.stderr
    lib = world.repo / REPO_FILES[2]
    lib.write_text(lib.read_text() + "\n# uncommitted change\n")
    dirty = world.verify()
    assert dirty.returncode == 1 and "AUTHORITY_FILE_DIFFERS_FROM_MAIN" in dirty.stderr


def test_verifier_detects_state_change_during_verification(world: World) -> None:
    world.set_state({**json.loads(world.state.read_text()), "flip_after": 1})
    r = world.verify()
    assert r.returncode == 1 and "reason=STATE_CHANGED_DURING_VERIFY" in r.stderr, r.stderr


def test_verifier_post_phase_requires_the_fail_closeout(world: World) -> None:
    assert "CTV_FAIL_CLOSEOUT_MISSING" in world.verify("--phase", "post").stderr
    (world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL").write_text("x\n")
    assert world.verify("--phase", "post").returncode == 0


# ── disposition action ─────────────────────────────────────────────────────────────────────────────────────────────
def test_action_dry_check_writes_nothing_and_record_requires_exact_authorization(world: World) -> None:
    before = world.snapshot()
    dry = world.action_run()
    assert dry.returncode == 0 and "CHECK_ONLY_NOTHING_WRITTEN" in dry.stdout
    assert world.snapshot() == before
    for label, setup in (
        ("AUTHORIZATION_MISSING", lambda: world.auth.unlink()),
        ("AUTHORIZATION_NOT_EXACT", lambda: world.write_auth(extra="rogue=1\n")),
        ("AUTHORIZATION_NOT_EXACT", lambda: world.write_auth(drop="device_id")),
        ("AUTHORIZATION_ID_INVALID", lambda: world.auth.write_text("authorization_id=x\n")),
    ):
        setup()
        r = world.action_run("--record")
        assert r.returncode == 1 and label in r.stderr, (label, r.stderr)
        assert world.snapshot() == before
        world.write_auth()
    world.auth.chmod(0o666)
    assert "AUTHORIZATION_WRITABLE" in world.action_run("--record").stderr
    assert world.snapshot() == before


def test_action_rejects_authorization_bound_to_a_different_verifier_or_main(world: World) -> None:
    world.write_auth()
    text = world.auth.read_text().replace(sha(world.verifier), "0" * 64)
    world.auth.write_text(text)
    assert "AUTHORIZATION_NOT_EXACT" in world.action_run("--record").stderr
    world.write_auth()
    world.auth.write_text(world.auth.read_text().replace(world.main, "1" * 40))
    assert "AUTHORIZATION_NOT_EXACT" in world.action_run("--record").stderr


def test_action_records_one_truthful_append_only_fail_closeout_without_touching_anything_else(world: World) -> None:
    before = world.snapshot()
    r = world.action_run("--record")
    assert r.returncode == 0, r.stderr
    assert "CTV_INCIDENT_DISPOSITION=RECORDED" in r.stdout and "CTV_INCIDENT_ADDITIONAL_RESTART=NO" in r.stdout
    closeout = world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL"
    text = closeout.read_text()
    for line in ("CTV_RESULT=FAIL_IMMUTABLE", "CTV_LIVE=CLOSED_FAIL", "CTV_ATTEMPT_CONSUMED=YES", "CTV_RERUN_ALLOWED=NO", "CTV_IS_CTU_RETRY=NO",
                 "CTV_INCIDENT_DISPOSITION=OPTION_B_TARGET_UNIT_RETAINED", "CTV_ROLLBACK_COMPLETE=NO", "CTV_TARGET_UNIT_RETAINED=YES",
                 "CTV_ADDITIONAL_CORE_RESTART=NO", "CTV_S10_HISTORICAL_COMPARE=FAIL", "CTV_S10_PROMOTED_TO_PASS=NO", "CTV_RECOVERY_AUTHORIZED=NO",
                 "CTV_JOURNAL_PHASE=apply-verified", f"CTV_UNIT_SHA256={PIN_UNIT}", f"CTV_PREIMAGE_SHA256={world.pre_sha}", f"CTV_DEVICE_ID={DEVICE}",
                 "CTV_DETECTOR_BASELINE_MODE=INACTIVE", "CTV_TRUSTEDCLOCK_AT_DISPOSITION=SYNCED", "CTV_INCIDENT_AUTHORIZATION_ID=AUTH-TEST-0001"):
        assert line in text.splitlines(), line
    assert "CLOSED_PASS" not in text
    assert oct(closeout.stat().st_mode & 0o777) == "0o600"
    assert (world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256").read_text() == f"{sha(closeout)}  CTV-GLOBAL-CLOSEOUT-FAIL\n"
    assert oct((world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL.sha256").stat().st_mode & 0o777) == "0o444"
    after = world.snapshot()
    created = {k for k in after if k not in before}
    assert created == {str(closeout), str(closeout) + ".sha256"}
    assert {k: v for k, v in after.items() if k in before} == before  # marker, journal, evidence, CTu closeout, unit: untouched
    assert not list(world.canon.glob("*.tmp.*"))
    assert {line.split()[1] for line in world.calls.read_text().splitlines()} == {"show"}


def test_action_is_idempotent_and_never_overwrites_a_foreign_or_existing_closeout(world: World) -> None:
    assert world.action_run("--record").returncode == 0
    closeout = world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL"
    first = closeout.read_bytes()
    again = world.action_run("--record")
    assert again.returncode == 0 and "ALREADY_RECORDED" in again.stdout and closeout.read_bytes() == first
    # a different authorization id must not be accepted as "already recorded"
    world.auth.write_text(world.auth.read_text().replace("AUTH-TEST-0001", "AUTH-OTHER-0002"))
    other = world.action_run("--record")
    assert other.returncode == 1 and "DIFFERENT_FAIL_CLOSEOUT_PRESENT" in other.stderr and closeout.read_bytes() == first


def test_action_refuses_a_preexisting_foreign_fail_closeout(world: World) -> None:
    foreign = world.canon / "CTV-GLOBAL-CLOSEOUT-FAIL"
    foreign.write_text("CTV_RESULT=FAIL_IMMUTABLE\nCTV_FAILURE_REASON=APPLY\n")
    r = world.action_run("--record")
    assert r.returncode == 1 and "DIFFERENT_FAIL_CLOSEOUT_PRESENT" in r.stderr
    assert foreign.read_text() == "CTV_RESULT=FAIL_IMMUTABLE\nCTV_FAILURE_REASON=APPLY\n"


def test_action_refuses_when_the_verifier_fails_and_writes_nothing(world: World) -> None:
    world.edit_state("core", NeedDaemonReload="yes")
    before = world.snapshot()
    r = world.action_run("--record")
    assert r.returncode == 1 and "VERIFIER_FAILED" in r.stderr
    assert world.snapshot() == before


def test_action_is_exclusive_under_the_canonical_directory_lock(world: World) -> None:
    fd = os.open(world.canon, os.O_RDONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        before = world.snapshot()
        r = world.action_run("--record")
        assert r.returncode == 1 and "LOCK_HELD" in r.stderr
        assert world.snapshot() == before
    finally:
        os.close(fd)


def test_action_refuses_when_core_moves_between_verification_and_write(world: World) -> None:
    # The core MainPID flips after the first call of each verifier run: the in-verifier race check must refuse and nothing is written.
    world.set_state({**json.loads(world.state.read_text()), "flip_after": 1})
    before = world.snapshot()
    r = world.action_run("--record")
    assert r.returncode == 1 and "VERIFIER_FAILED" in r.stderr
    assert world.snapshot() == before


def test_action_rejects_an_action_script_that_differs_from_main(world: World) -> None:
    world.action.write_text(world.action.read_text() + "\n# local edit\n")
    r = world.action_run()
    assert r.returncode == 1 and "ACTION_DIFFERS_FROM_MAIN" in r.stderr


# ── static safety / scope guards ───────────────────────────────────────────────────────────────────────────────────
def _code(path: Path) -> str:
    return "\n".join(l for l in path.read_text().splitlines() if not l.lstrip().startswith("#"))


def test_scripts_contain_no_mutating_host_verbs_and_do_not_use_the_broken_or_consuming_helpers() -> None:
    for path in (VERIFIER_SRC, ACTION_SRC):
        code = _code(path)
        assert not re.search(r"systemctl\s+(?!show\b)\w+", code), path.name
        for forbidden in ("daemon-reload", "restart", "ctv_apply_governed", "ctv_rollback_governed", "ctv_consume_attempt", "ctv_host_runtime_verify",
                          "ctv_record_failure", "ctv_record_success", "run-ctv-owner", "run-ctu-owner", "install ", "chown", "kill "):
            assert forbidden not in code, (path.name, forbidden)
    verifier = _code(VERIFIER_SRC)
    assert not re.search(r"(^|[\s;|&])(cp|mv|rm|tee|touch|mkdir|ln|chmod|sync)\s", verifier)
    action = _code(ACTION_SRC)
    assert len(re.findall(r"\brm\b", action)) == 2 and len(re.findall(r'rm -f -- "\$tmp"', action)) == 2  # only its own temp file
    assert not re.search(r"(^|[\s;|&])(cp|mv|tee|touch|mkdir|chmod\s+[0-7]+\s+(?!\"\$tmp\"|\"\$closeout\.sha256\"))", action)


def test_recovery_gate_still_refuses_any_ctv_fail_closeout_so_the_disposition_grants_no_recovery() -> None:
    text = (P4 / "p4-recovery-run-lib.sh").read_text()
    assert 'RECOVERY_CTV_FAIL_CLOSEOUT_PRESENT' in text
    assert re.search(r'\[ ! -e "\$canon/CTV-GLOBAL-CLOSEOUT-FAIL" \]', text)


def test_pins_match_the_owner_evidence_and_the_reviewed_unit_source() -> None:
    for path in (VERIFIER_SRC, ACTION_SRC):
        text = path.read_text()
        assert f"PIN_UNIT_SHA256={PIN_UNIT}" in text
        assert "PIN_PREIMAGE_SHA256=b2425b0bdc4402f09b7ff616afb66b0686f045459d3b7826796e73ad64a59890" in text
    assert sha(UNIT_EXAMPLE) == PIN_UNIT
