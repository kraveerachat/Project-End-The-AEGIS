from __future__ import annotations

import hashlib
import importlib.util
import os
import json
import re
import shutil
import subprocess
import sys
import pytest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
CTV_LIB = DEPLOY / "p4-ctv-run-lib.sh"
CTV_RUNNER = DEPLOY / "owner-run" / "run-ctv-owner.sh"
FREEZE = DEPLOY / "ctv-acceptance" / "ctv_runner_freeze.py"
SNAPSHOT = DEPLOY / "ctv-acceptance" / "ctv_verifier_snapshot.py"


def run_bash(script: str, *args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    merged = os.environ.copy()
    merged.update(env or {})
    return subprocess.run(["bash", "-c", script, "bash", *args], text=True, capture_output=True, env=merged)


def test_ctv_has_distinct_provenance_domains_and_preconsume_rehearsal():
    text = CTV_LIB.read_text()
    for name in (
        "CTV_FROZEN_RUNNER_SHA256",
        "CTV_RUNNER_TEMPLATE_SHA256",
        "CTV_BUNDLE_MANIFEST_SHA256",
        "CTV_CONTROL_MANIFEST_SHA256",
        "ctv_preconsume_rehearsal",
        "ALL_DETERMINISTIC_PROVENANCE_GATES_PRECONSUME",
        "ctv_target_unit_preflight",
        "CTV_CORE_RESTARTS=1",
        "CTV_EXPLICIT_DETECTOR_LIFECYCLE_COMMANDS=0",
    ):
        assert name in text
    assert "CTV_FROZEN_RUNNER_SHA256=\"$CTV_RUNNER_TEMPLATE_SHA256\"" not in text


def test_ctv_production_default_targets_reviewed_core_unit_and_override_is_preserved():
    text = CTV_RUNNER.read_text()
    match = re.search(r"^UNIT_SOURCE=(.+)$", text, re.MULTILINE)
    assert match, "CTv production UNIT_SOURCE default must remain explicit"
    default = match.group(1).replace("$MERGED_MAIN_WORKTREE", str(ROOT), 1)
    assert default == str(ROOT / "IDEA3-AEGIS_Lockdown/deploy/aegis-idea3-core.service.example")
    assert Path(default).is_file()
    assert "pr11-phase4/units/aegis-idea3-core.service" not in match.group(1)

    unit = Path(default).read_text().splitlines()
    properties = {line.split("=", 1)[0]: line.split("=", 1)[1] for line in unit if "=" in line}
    assert properties["ProtectClock"] == "false"
    assert properties["User"] == "aegis-idea3"
    assert properties["NoNewPrivileges"] == "true"
    assert properties["CapabilityBoundingSet"] == ""
    assert properties["AmbientCapabilities"] == ""

    assert "--unit-source" in text
    assert re.search(r"--unit-source\).*UNIT_SOURCE=\$2", text)


@pytest.mark.parametrize(
    ("protect_clock", "no_new_privileges", "expected"),
    [("no", "yes", 0), ("false", "true", 0), ("yes", "no", 1), ("true", "false", 1)],
)
def test_ctv_effective_runtime_boolean_serialization_is_semantic(
    tmp_path: Path, protect_clock: str, no_new_privileges: str, expected: int
):
    unit = tmp_path / "aegis-idea3-core.service"
    unit.write_text("ProtectClock=false\nUser=aegis-idea3\nNoNewPrivileges=true\nCapabilityBoundingSet=\nAmbientCapabilities=\n")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    (bindir / "systemctl").write_text(
        f'''#!/bin/bash
case "$*" in
  *"aegis-idea3-core.service"*)
    case "$*" in
      *"ProtectClock"*) printf 'ProtectClock={protect_clock}\\nUser=aegis-idea3\\nNoNewPrivileges={no_new_privileges}\\nCapabilityBoundingSet=\\nAmbientCapabilities=\\n' ;;
      *"DropInPaths"*) printf '/etc/systemd/system/aegis-idea3-core.service.d/10-recovery.conf /etc/systemd/system/aegis-idea3-core.service.d/20-f1-alert.conf\\n' ;;
      *) printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nResult=success\\nMainPID=123\\n' ;;
    esac ;;
  *"aegis-idea3-detector.service"*) printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nUnitFileState=disabled\\nRestart=no\\nResult=success\\nMainPID=123\\nInvocationID=0123456789abcdef0123456789abcdef\\nExecMainStartTimestampMonotonic=1\\nNRestarts=0\\n' ;;
  *) exit 1 ;;
esac
'''
    )
    (bindir / "systemctl").chmod(0o755)
    (bindir / "pgrep").write_text("#!/bin/bash\nprintf '1\\n'\n")
    (bindir / "pgrep").chmod(0o755)
    (bindir / "diff").write_text("#!/bin/bash\ncat >/dev/null\nexit 0\n")
    (bindir / "diff").chmod(0o755)
    script = f'''set -Eeuo pipefail
source "{CTV_LIB}"
CTV_SUDO="" CTV_TEST_ONLY_CANONICAL_DIR_ENABLED=YES \\
CTV_TEST_ONLY_CANONICAL_DIR="{tmp_path}" PATH="{bindir}:/usr/bin:/bin" \\
ctv_host_runtime_verify "{unit}" "{hashlib.sha256(unit.read_bytes()).hexdigest()}" aegis-relay-01 ACTIVE
'''
    result = run_bash(script, env={"CTV_SUDO": "", "PATH": f"{bindir}:/usr/bin:/bin"})
    assert result.returncode == expected, result.stderr


def test_historical_ctu_template_comparison_is_a_real_domain_mismatch():
    spec = importlib.util.spec_from_file_location("ctu_freeze", DEPLOY / "ctu-acceptance" / "ctu_runner_freeze.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    template = module.read_template(ROOT, "4706b5f8d9798ac5248572b04a13a00d77846e1c")
    pins = {
        "EXPECTED_MAIN": "4706b5f8d9798ac5248572b04a13a00d77846e1c",
        "OPERATOR_USER": "music",
        "OPERATOR_UID": "1000",
        "UNIT_SHA256": "a" * 64,
        "MERGED_MAIN_WORKTREE": "/srv/aegis",
        "EVIDENCE_ROOT": "/var/lib/aegis/evidence",
        "DEVICE_ID": "aegis-relay-01",
    }
    frozen = module.render(template, pins).encode()
    assert hashlib.sha256(frozen).hexdigest() != hashlib.sha256(template.encode()).hexdigest()


def test_consumed_no_mutation_journal_is_durable_and_rollback_is_non_mutating(tmp_path):
    work = tmp_path / "work"
    script = f'''
        set -Eeuo pipefail
        source "{CTV_LIB}"
        ctv_prepare_work_dir "{work}"
        ctv_prepare_no_mutation_journal "{work}/journal"
        ctv_establish_consumed_no_mutation_journal "{work}/journal"
        grep -qx 'phase=consumed-no-production-mutation' "{work}/journal"
        ctv_rollback_governed "{work}/journal"
    '''
    result = run_bash(script, env={"CTV_SUDO": ""})
    assert result.returncode == 0, result.stderr
    assert "CTV_ROLLBACK=PASS reason=NO_MUTATION" in result.stdout


def test_ctv_predecessor_and_recovery_successor_contracts_are_registered():
    stage_gate = (DEPLOY / "p4-lib.sh").read_text()
    recovery = (DEPLOY / "p4-recovery-run-lib.sh").read_text()
    runner = CTV_RUNNER.read_text()
    assert "CTu CTv Recovery" in stage_gate
    assert "recovery_ctv_successor_gate" in recovery
    for field in ("CTV_IS_CTU_RETRY=NO", "CTV_ATTEMPT_CONSUMED", "CTV_RUNNER_TEMPLATE_SHA256"):
        assert field in runner


def test_ctv_bundle_and_handlers_exist_and_direct_handler_is_refused():
    for rel in (
        "ctv-acceptance/ctv_runner_freeze.py",
        "ctv-acceptance/ctv_verifier_snapshot.py",
        "owner-run/run-ctv-owner.sh",
        "stages/CTv/apply.sh",
        "stages/CTv/verify.sh",
        "stages/CTv/rollback.sh",
        "stages/CTv/allow-keys.txt",
        "stages/CTv/allow-listeners.txt",
        "stages/CTv/allow-keys-rollback.txt",
    ):
        assert (DEPLOY / rel).is_file(), rel
    result = subprocess.run(["bash", str(DEPLOY / "stages/CTv/apply.sh")], text=True, capture_output=True)
    assert result.returncode != 0
    assert "DIRECT_HANDLER_INVOCATION_REFUSED" in result.stderr


def test_ctv_rehearsal_is_explicitly_non_consuming():
    text = CTV_RUNNER.read_text()
    assert "CTV_PRECONSUME_REHEARSAL=PASS" in text
    assert "ctv_consume_attempt" in text
    assert text.index("CTV_PRECONSUME_REHEARSAL=PASS") < text.index("ctv_consume_attempt")
    assert "CTV_ATTEMPT_CONSUMED=NO" in text


def test_ctv_closeout_is_one_shot_and_separate_from_ctu(tmp_path):
    canon = tmp_path / "governance"
    canon.mkdir()
    marker = canon / "CTV-GLOBAL-ATTEMPT-CONSUMED"
    marker.write_text("CTV_ATTEMPT_CONSUMED=YES\n")
    script = f'''
        set -Eeuo pipefail
        source "{CTV_LIB}"
        CTV_SUDO="" CTV_TEST_ONLY_CANONICAL_DIR_ENABLED=YES CTV_TEST_ONLY_CANONICAL_DIR="{canon}" \\
          CTV_CANONICAL_DIR="{canon}" CTV_DETECTOR_BASELINE_MODE=INACTIVE CTV_DEVICE_ID=aegis-relay-01 CTV_EVIDENCE_MANIFEST_SHA256="{'1' * 64}" \
          ctv_record_success "{'a' * 40}" "{'b' * 64}" NOT_CREATED_PRELIVE "{'c' * 64}" "{'d' * 64}" "{'e' * 64}" "{'f' * 64}"
        grep -qx CTV_RESULT=CLOSED_PASS "{canon}/CTV-GLOBAL-CLOSEOUT-PASS"
        ! CTV_SUDO="" CTV_TEST_ONLY_CANONICAL_DIR_ENABLED=YES CTV_TEST_ONLY_CANONICAL_DIR="{canon}" \\
          CTV_CANONICAL_DIR="{canon}" ctv_record_failure SECOND_ATTEMPT
        ! grep -q CTU_RESULT=PASS "{canon}/CTV-GLOBAL-CLOSEOUT-PASS"
    '''
    result = run_bash(script, env={"CTV_SUDO": ""})
    assert result.returncode == 0, result.stderr


def test_ctv_closeout_refuses_unvalidated_identity_and_never_writes_unknown(tmp_path):
    canon = tmp_path / "governance"
    canon.mkdir()
    (canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").write_text("CTV_ATTEMPT_CONSUMED=YES\n")
    script = f'''
        set -Eeuo pipefail
        source "{CTV_LIB}"
        CTV_SUDO="" CTV_TEST_ONLY_CANONICAL_DIR_ENABLED=YES CTV_TEST_ONLY_CANONICAL_DIR="{canon}" \
          CTV_CANONICAL_DIR="{canon}" CTV_DEVICE_ID=UNKNOWN CTV_DETECTOR_BASELINE_MODE=UNKNOWN \
          ctv_record_success "{'a' * 40}" "{'b' * 64}" NOT_CREATED_PRELIVE "{'c' * 64}" "{'d' * 64}" "{'e' * 64}" "{'f' * 64}"
    '''
    result = run_bash(script, env={"CTV_SUDO": ""})
    assert result.returncode != 0
    assert not (canon / "CTV-GLOBAL-CLOSEOUT-PASS").exists()


def test_nonhermetic_runner_uses_fresh_l0_capture_and_compare_not_fixture_runtime_proof():
    text = CTV_RUNNER.read_text()
    assert "p4-l0-capture.sh" in text
    assert "p4-compare.sh" in text
    assert "FIXTURE_ROOT" in text
    assert "if [ \"$HERMETIC\" = YES ]" in text
    assert "ctv_host_runtime_verify \"$UNIT_DEST\" \"$UNIT_SHA256\"" in text


def test_ctv_bundle_closure_contains_shared_l0_compare_and_device_validator():
    text = CTV_LIB.read_text()
    for rel in ("p4-l0-capture.sh", "p4-compare.sh", "p4-ctu-run-lib.sh"):
        assert rel in text


def test_hermetic_apply_and_post_restart_rollback_have_bounded_restarts(tmp_path):
    source = tmp_path / "target.service"
    destination = tmp_path / "installed.service"
    source.write_text("ProtectClock=false\nUser=aegis-idea3\nNoNewPrivileges=true\nCapabilityBoundingSet=\nAmbientCapabilities=\n")
    destination.write_text("preimage\n")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    work = tmp_path / "work"
    script = f'''
        set -Eeuo pipefail
        source "{CTV_LIB}"
        CTV_SUDO="" CTV_TEST_MODE=YES CTV_UNIT_DEST="{destination}" CTV_CORE_RESTARTS_FILE="{tmp_path}/restarts" \
          ctv_prepare_work_dir "{work}"
        CTV_SUDO="" CTV_TEST_MODE=YES CTV_UNIT_DEST="{destination}" CTV_CORE_RESTARTS_FILE="{tmp_path}/restarts" \
          ctv_prepare_no_mutation_journal "{work}/journal"
        CTV_SUDO="" CTV_TEST_MODE=YES CTV_UNIT_DEST="{destination}" CTV_CORE_RESTARTS_FILE="{tmp_path}/restarts" \
          ctv_establish_consumed_no_mutation_journal "{work}/journal"
        CTV_SUDO="" CTV_TEST_MODE=YES CTV_UNIT_DEST="{destination}" CTV_CORE_RESTARTS_FILE="{tmp_path}/restarts" \
          CTV_LIVE_AUTHORIZED=YES ctv_apply_governed "{work}/journal" "{source}" "{destination}" "{digest}"
        grep -qx 'phase=apply-verified' "{work}/journal"
        grep -qx 1 "{tmp_path}/restarts"
        CTV_SUDO="" CTV_TEST_MODE=YES CTV_UNIT_DEST="{destination}" CTV_CORE_RESTARTS_FILE="{tmp_path}/restarts" \
          ctv_rollback_governed "{work}/journal"
        grep -qx 2 "{tmp_path}/restarts"
        grep -qx 'preimage' "{destination}"
    '''
    result = run_bash(script, env={"CTV_SUDO": ""})
    assert result.returncode == 0, result.stderr
    assert "CTV_APPLY=PASS" in result.stdout
    assert "CTV_ROLLBACK=PASS reason=RESTORED_PREIMAGE" in result.stdout


def _git(repo: Path, *args: str, env: dict[str, str] | None = None) -> str:
    clean = os.environ.copy()
    clean.update({"HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null", "GIT_NO_REPLACE_OBJECTS": "1"})
    clean.update(env or {})
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True, env=clean).strip()


def _write_fixture(root: Path, main: str, device: str) -> None:
    values = {
        "remote-main": main,
        "device-id": device,
        "work-topology": "PASS",
        "operator-identity": "PASS",
        "auth-k3-binding": "PASS",
        "auth-fresh": "PASS",
        "k3-fresh": "PASS",
        "frozen-derivation": "PASS",
        "target-unit": "PASS",
        "core.state": "active running 0",
        "core-security": "ProtectClock=true",
        "detector.state": "ACTIVE",
        "dropins": "10-recovery.conf 20-f1-alert.conf",
        "l0-pre.result": "COMPLETE",
        "rollback-preflight": "PASS",
        "evidence-capacity": "PASS",
        "runtime-verify": "PASS",
        "detector-preservation": "PASS",
        "remote-main-equality": "PASS",
        "recovery-unconsumed": "PASS",
    }
    for name, value in values.items():
        (root / name).write_text(value + "\n")


def _frozen_ctv_world(tmp_path: Path) -> tuple[Path, Path, Path, Path, Path, Path, str, str]:
    repo = tmp_path / "repo"
    (repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run").mkdir(parents=True)
    (repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctv-acceptance").mkdir(parents=True)
    shutil.copy2(CTV_RUNNER, repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh")
    shutil.copy2(CTV_LIB, repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh")
    shutil.copy2(ROOT / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh", repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh")
    (repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/units").mkdir(parents=True)
    unit = repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/units/aegis-idea3-core.service"
    unit.write_text("ProtectClock=false\nUser=aegis-idea3\nNoNewPrivileges=true\nCapabilityBoundingSet=\nAmbientCapabilities=\n")
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "ctv-test@example.invalid")
    _git(repo, "config", "user.name", "CTv Test")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "test exact main")
    main = _git(repo, "rev-parse", "HEAD")
    device = "aegis-relay-01"
    evidence = tmp_path / "evidence"
    bundle = evidence / "ctv-bundle"
    control = evidence / "ctv-control"
    fixture = evidence / "ctv-fixture"
    auth = tmp_path / "auth"
    canon = tmp_path / "governance"
    work = evidence / "ctv-work"
    for path in (evidence, bundle, fixture, auth, canon):
        path.mkdir(parents=True)
    (canon / "CTU-GLOBAL-ATTEMPT-CONSUMED").write_text("CTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\n")
    (canon / "CTU-GLOBAL-CLOSEOUT-FAIL").write_text("CTU_RESULT=FAIL_IMMUTABLE\nCTU_FAILURE_REASON=APPLY\nCTU_ATTEMPT_CONSUMED=YES\n")
    shutil.copy2(repo / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh", bundle / "p4-ctv-run-lib.sh")
    shutil.copy2(ROOT / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh", bundle / "p4-ctu-run-lib.sh")
    bundle_manifest = bundle / "CTV-BUNDLE-SHA256SUMS"
    bundle_manifest.write_text(
        f"{hashlib.sha256((bundle / 'p4-ctv-run-lib.sh').read_bytes()).hexdigest()}  p4-ctv-run-lib.sh\n"
        f"{hashlib.sha256((bundle / 'p4-ctu-run-lib.sh').read_bytes()).hexdigest()}  p4-ctu-run-lib.sh\n"
    )
    bundle_manifest.chmod(0o444); (bundle / "p4-ctv-run-lib.sh").chmod(0o555)
    subprocess.run([sys.executable, str(SNAPSHOT), "control-snapshot", "--repo", str(repo), "--main", main, "--out", str(control), "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh"], check=True, text=True, capture_output=True)
    checked = subprocess.run([sys.executable, str(SNAPSHOT), "control-check", "--repo", str(repo), "--main", main, "--control", str(control)], text=True, capture_output=True)
    assert checked.returncode == 0, checked.stderr
    shutil.copy2(unit, evidence / "unit")
    pins = {"EXPECTED_MAIN": main, "OPERATOR_USER": "music", "OPERATOR_UID": "1000", "UNIT_SHA256": hashlib.sha256(unit.read_bytes()).hexdigest(), "MERGED_MAIN_WORKTREE": str(repo), "EVIDENCE_ROOT": str(evidence), "DEVICE_ID": device}
    pins_file = tmp_path / "pins.json"; pins_file.write_text(json.dumps(pins))
    runner = evidence / "run-ctv-owner.FROZEN.sh"
    frozen = subprocess.run([sys.executable, str(FREEZE), "freeze", "--repo", str(repo), "--main", main, "--pins", str(pins_file), "--out", str(runner)], text=True, capture_output=True)
    assert frozen.returncode == 0, frozen.stderr
    checked_runner = subprocess.run([sys.executable, str(FREEZE), "check", "--repo", str(repo), "--main", main, "--pins", str(pins_file), "--runner", str(runner)], text=True, capture_output=True)
    assert checked_runner.returncode == 0, checked_runner.stderr
    runner_sha = hashlib.sha256(runner.read_bytes()).hexdigest()
    template_sha = hashlib.sha256((_git(repo, "show", f"{main}:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh") + "\n").encode()).hexdigest()
    auth_text = f"stage=CTv\nexpected_main={main}\nfrozen_runner_sha256={runner_sha}\nrunner_template_sha256={template_sha}\n"
    (auth / "authorization-CTv.txt").write_text(auth_text)
    (auth / "k3-CTv.txt").write_text(auth_text)
    _write_fixture(fixture, main, device)
    return runner, auth, canon, evidence, bundle, control, fixture, main


def test_ctv_canonical_authority_field_is_accepted_by_stage_gate_and_rehearsal(tmp_path: Path):
    runner, auth, canon, evidence, bundle, control, fixture, main = _frozen_ctv_world(tmp_path)
    unit_sha = hashlib.sha256((evidence / "unit").read_bytes()).hexdigest()
    runner_sha = hashlib.sha256(runner.read_bytes()).hexdigest()
    template_sha = text_sha(runner, main, tmp_path)
    bundle_sha = hashlib.sha256((bundle / "CTV-BUNDLE-SHA256SUMS").read_bytes()).hexdigest()
    control_sha = hashlib.sha256((control / "CTV-CONTROL-SHA256SUMS").read_bytes()).hexdigest()
    today = subprocess.run(["bash", "-c", "TZ=Asia/Bangkok date +%F"], text=True, capture_output=True, check=True).stdout.strip()
    authority = (
        "AEGIS_P4_AUTHORIZATION_V1\n"
        f"stage=CTv\ndate={today}\nauthorizer=music\nscope=CTv authority binding\nreference=ctv-authority-regression\n"
        f"expected_main={main}\nfrozen_runner_sha256={runner_sha}\nrunner_template_sha256={template_sha}\n"
        f"bundle_manifest_sha256={bundle_sha}\ncontrol_manifest_sha256={control_sha}\nunit_sha256={unit_sha}\n"
        "operator_user=music\noperator_uid=1000\ndevice_id=aegis-relay-01\n"
    )
    k3 = (
        "AEGIS_P4_K3_CONFIRMATION_V2\n"
        f"stage=CTv\ndate={today}\nconfirmed_by=music\nconfirmation_mode=IDEA3_OWNER_SELF_ATTESTATION\n"
        "idea1_window_overlap=NONE_KNOWN\nreference=ctv-authority-regression\n"
        f"expected_main={main}\nfrozen_runner_sha256={runner_sha}\nrunner_template_sha256={template_sha}\n"
        f"bundle_manifest_sha256={bundle_sha}\ncontrol_manifest_sha256={control_sha}\nunit_sha256={unit_sha}\n"
        "operator_user=music\noperator_uid=1000\ndevice_id=aegis-relay-01\n"
    )
    (auth / "authorization-CTv.txt").write_text(authority)
    (auth / "k3-CTv.txt").write_text(k3)
    gate = subprocess.run(
        ["bash", str(DEPLOY / "p4-stage-gate.sh"), "--stage", "CTv", "--mode", "simulate", "--authorization", str(auth / "authorization-CTv.txt"), "--k3", str(auth / "k3-CTv.txt")],
        text=True, capture_output=True, env={"TZ": "Asia/Bangkok", "PATH": os.environ["PATH"]},
    )
    assert gate.returncode == 0, gate.stdout + gate.stderr
    assert "AUTHORIZATION_RECORD=VALID" in gate.stdout and "K3_CONFIRMATION=VALID" in gate.stdout
    rehearsal = subprocess.run(
        [str(runner), str(auth), "--rehearse", "--hermetic", "--canonical-dir", str(canon), "--bundle-dir", str(bundle), "--control-dir", str(control), "--fixture-root", str(fixture), "--unit-source", str(evidence / "unit"), "--unit-dest", str(evidence / "installed"), "--work-dir", str(evidence / "ctv-work")],
        text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"},
    )
    assert rehearsal.returncode == 0, rehearsal.stdout + rehearsal.stderr
    assert "CTV_PRECONSUME_REHEARSAL=PASS" in rehearsal.stdout

    legacy = authority.replace("frozen_runner_sha256=", "runner_sha256=")
    (auth / "authorization-CTv.txt").write_text(legacy)
    (auth / "k3-CTv.txt").write_text(k3.replace("frozen_runner_sha256=", "runner_sha256="))
    rejected = subprocess.run(
        ["bash", str(DEPLOY / "p4-stage-gate.sh"), "--stage", "CTv", "--mode", "simulate", "--authorization", str(auth / "authorization-CTv.txt"), "--k3", str(auth / "k3-CTv.txt")],
        text=True, capture_output=True, env={"TZ": "Asia/Bangkok", "PATH": os.environ["PATH"]},
    )
    assert rejected.returncode != 0
    assert "AUTHORIZATION_RECORD=INVALID" in rejected.stdout
    legacy_rehearsal = subprocess.run(
        [str(runner), str(auth), "--rehearse", "--hermetic", "--canonical-dir", str(canon), "--bundle-dir", str(bundle), "--control-dir", str(control), "--fixture-root", str(fixture), "--unit-source", str(evidence / "unit"), "--unit-dest", str(evidence / "installed-legacy"), "--work-dir", str(evidence / "ctv-work-legacy")],
        text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"},
    )
    assert legacy_rehearsal.returncode != 0


def test_full_frozen_runner_rehearsal_is_non_consuming_and_executes_real_gates(tmp_path):
    runner, auth, canon, evidence, bundle, control, fixture, main = _frozen_ctv_world(tmp_path)
    unit = evidence / "unit"
    command = [str(runner), str(auth), "--rehearse", "--hermetic", "--canonical-dir", str(canon), "--bundle-dir", str(bundle), "--control-dir", str(control), "--fixture-root", str(fixture), "--unit-source", str(unit), "--unit-dest", str(evidence / "installed"), "--work-dir", str(evidence / "ctv-work")]
    result = subprocess.run(command, text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"})
    assert result.returncode == 0, result.stderr
    assert "CTV_PRECONSUME_REHEARSAL=PASS" in result.stdout
    assert not (canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").exists()
    assert not (canon / "CTV-GLOBAL-CLOSEOUT-PASS").exists()


def test_full_isolated_live_state_machine_consumes_once_and_closes_pass(tmp_path):
    runner, auth, canon, evidence, bundle, control, fixture, main = _frozen_ctv_world(tmp_path)
    unit = evidence / "unit"
    installed = evidence / "installed"
    command = [str(runner), str(auth), "--live", "--hermetic", "--canonical-dir", str(canon), "--bundle-dir", str(bundle), "--control-dir", str(control), "--fixture-root", str(fixture), "--unit-source", str(unit), "--unit-dest", str(installed), "--work-dir", str(evidence / "ctv-work")]
    result = subprocess.run(command, text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"})
    assert result.returncode == 0, result.stderr
    assert "CTV_RESULT=CLOSED_PASS" in result.stdout
    marker = canon / "CTV-GLOBAL-ATTEMPT-CONSUMED"
    assert marker.exists() and "CTV_ATTEMPT_CONSUMED=YES" in marker.read_text()
    assert "phase=apply-verified" in (evidence / "ctv-work/journal").read_text()
    assert (evidence / "ctv-work/core-restarts").read_text() == "1\n"
    assert installed.read_bytes() == unit.read_bytes()
    assert (canon / "CTV-GLOBAL-CLOSEOUT-PASS").read_text().count("CTV_LIVE_EXECUTED=YES") == 1


@pytest.mark.parametrize("blocker", [
    "runner", "template", "bundle", "control", "auth-k3", "wrong-main", "ctu", "recovery",
    "protect-clock", "detector", "dropins", "device", "l0",
])
def test_deterministic_failure_injection_is_rejected_before_ctv_marker(tmp_path, blocker):
    runner, auth, canon, evidence, bundle, control, fixture, main = _frozen_ctv_world(tmp_path)
    unit = evidence / "unit"
    if blocker == "runner":
        text = (auth / "authorization-CTv.txt").read_text().replace("frozen_runner_sha256=" + hashlib.sha256(runner.read_bytes()).hexdigest(), "frozen_runner_sha256=" + "0" * 64)
        (auth / "authorization-CTv.txt").write_text(text)
    elif blocker == "template":
        text = (auth / "authorization-CTv.txt").read_text().replace("runner_template_sha256=" + text_sha(runner, main, tmp_path), "runner_template_sha256=" + "0" * 64)
        (auth / "authorization-CTv.txt").write_text(text)
    elif blocker == "bundle":
        manifest = bundle / "CTV-BUNDLE-SHA256SUMS"; manifest.chmod(0o644); manifest.write_text("0" * 64 + "  p4-ctv-run-lib.sh\n"); manifest.chmod(0o444)
    elif blocker == "control":
        lib = control / "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctv-run-lib.sh"
        lib.chmod(0o644); lib.write_text(lib.read_text() + "\n# drift\n"); lib.chmod(0o444)
    elif blocker == "auth-k3":
        (auth / "k3-CTv.txt").write_text((auth / "k3-CTv.txt").read_text().replace("stage=CTv", "stage=CTu"))
    elif blocker == "wrong-main":
        (fixture / "remote-main").write_text("0" * 40 + "\n")
    elif blocker == "ctu":
        (canon / "CTU-GLOBAL-CLOSEOUT-FAIL").unlink()
    elif blocker == "recovery":
        (canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").write_text("RECOVERY_ATTEMPT_CONSUMED=YES\n")
    elif blocker == "protect-clock":
        (fixture / "core-security").write_text("ProtectClock=false\n")
    elif blocker == "detector":
        (fixture / "detector.state").write_text("BROKEN\n")
    elif blocker == "dropins":
        (fixture / "dropins").write_text("unexpected.conf\n")
    elif blocker == "device":
        (fixture / "device-id").write_text("wrong-device\n")
    elif blocker == "l0":
        (fixture / "l0-pre.result").write_text("PARTIAL\n")
    command = [str(runner), str(auth), "--rehearse", "--hermetic", "--canonical-dir", str(canon), "--bundle-dir", str(bundle), "--control-dir", str(control), "--fixture-root", str(fixture), "--unit-source", str(unit), "--unit-dest", str(evidence / "installed"), "--work-dir", str(evidence / "ctv-work")]
    result = subprocess.run(command, text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"})
    assert result.returncode != 0
    assert not (canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").exists()


def text_sha(runner: Path, main: str, tmp_path: Path) -> str:
    repo = tmp_path / "repo"
    return hashlib.sha256((_git(repo, "show", f"{main}:IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctv-owner.sh") + "\n").encode()).hexdigest()


@pytest.mark.parametrize("phase", [
    "after-marker", "consumed-journal", "preimage-capture", "mutation-started",
    "unit-install", "unit-installed", "daemon-reload", "after-daemon-reload",
    "before-core-restart", "core-restart", "after-core-restart", "post-runtime-verify",
    "post-capture", "preservation-compare", "detector-preservation", "evidence-manifest",
    "pass-closeout",
])
def test_every_postconsume_failure_is_immutable_and_bounded(tmp_path, phase):
    runner, auth, canon, evidence, bundle, control, fixture, main = _frozen_ctv_world(tmp_path)
    unit = evidence / "unit"
    installed = evidence / "installed"
    installed.write_text("PREIMAGE\n")
    command = [str(runner), str(auth), "--live", "--hermetic", "--fail-phase", phase,
               "--canonical-dir", str(canon), "--bundle-dir", str(bundle), "--control-dir", str(control),
               "--fixture-root", str(fixture), "--unit-source", str(unit), "--unit-dest", str(installed),
               "--work-dir", str(evidence / "ctv-work")]
    result = subprocess.run(command, text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"})
    assert result.returncode != 0, (phase, result.stdout, result.stderr)
    marker = canon / "CTV-GLOBAL-ATTEMPT-CONSUMED"
    closeout = canon / "CTV-GLOBAL-CLOSEOUT-FAIL"
    assert marker.is_file() and closeout.is_file()
    closeout_text = closeout.read_text()
    assert "CTV_RESULT=FAIL_IMMUTABLE" in closeout_text
    assert "CTV_LIVE_EXECUTED=YES" in closeout_text
    assert "CTV_ATTEMPT_CONSUMED=YES" in closeout_text
    assert "CTV_RERUN_ALLOWED=NO" in closeout_text
    journal = (evidence / "ctv-work/journal").read_text()
    expected_phase = "rollback-complete" if phase not in {"after-marker", "consumed-journal", "preimage-capture"} else ("prepared-no-production-mutation" if phase == "after-marker" else "consumed-no-production-mutation")
    assert f"phase={expected_phase}" in journal
    restarts = int((evidence / "ctv-work/core-restarts").read_text()) if (evidence / "ctv-work/core-restarts").exists() else 0
    assert 0 <= restarts <= 2
    assert "CTV_DETECTOR_COMMANDS=0" in result.stdout
    assert installed.read_text() == "PREIMAGE\n"


def _recovery_ctv_world(tmp_path: Path) -> tuple[Path, str, Path, Path, Path]:
    repo = tmp_path / "receipt-repo"
    repo.mkdir()
    _git(repo, "init", "-q")
    _git(repo, "config", "user.email", "test@example.invalid")
    _git(repo, "config", "user.name", "test")
    receipt_rel = Path("Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/ctv-live-receipt.md")
    receipt = repo / receipt_rel
    receipt.parent.mkdir(parents=True)
    receipt.write_text("CTV_LIVE=CLOSED_PASS\nCTV_IS_CTU_RETRY=NO\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "receipt")
    execution_main = _git(repo, "rev-parse", "HEAD")

    canon = tmp_path / "canon"
    canon.mkdir(mode=0o700)
    (canon / "CTU-GLOBAL-ATTEMPT-CONSUMED").write_text("CTU_ATTEMPT_CONSUMED=YES\n")
    (canon / "CTU-GLOBAL-CLOSEOUT-FAIL").write_text(
        "CTU_RESULT=FAIL_IMMUTABLE\nCTU_FAILURE_REASON=APPLY\n"
        "CTU_ATTEMPT_CONSUMED=YES\nCTU_RERUN_ALLOWED=NO\n"
    )
    (canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").write_text("CTV_ATTEMPT_CONSUMED=YES\n")
    unit = tmp_path / "aegis-idea3-core.service"
    unit.write_text("ProtectClock=false\nUser=aegis-idea3\nNoNewPrivileges=true\nCapabilityBoundingSet=\nAmbientCapabilities=\n")
    unit_sha = hashlib.sha256(unit.read_bytes()).hexdigest()
    closeout = canon / "CTV-GLOBAL-CLOSEOUT-PASS"
    closeout.write_text(
        "CTV_RESULT=CLOSED_PASS\nCTV_IS_CTU_RETRY=NO\nCTV_ATTEMPT_CONSUMED=YES\nCTV_RERUN_ALLOWED=NO\n"
        f"CTV_EXPECTED_MAIN={execution_main}\nCTV_EXECUTION_MAIN={execution_main}\nCTV_LIVE_EXECUTED=YES\nCTV_DETECTOR_BASELINE_MODE=INACTIVE\n"
        "CTV_DEVICE_ID=aegis-relay-01\n" + "CTV_EVIDENCE_MANIFEST_SHA256=" + "a" * 64 + "\n"
        + "CTV_FROZEN_RUNNER_SHA256=" + "b" * 64 + "\nCTV_RUNNER_TEMPLATE_SHA256=" + "c" * 64 + "\n"
        + "CTV_BUNDLE_MANIFEST_SHA256=" + "d" * 64 + "\nCTV_CONTROL_MANIFEST_SHA256=" + "e" * 64 + "\n"
        + f"CTV_UNIT_SHA256={unit_sha}\nCTV_RUNTIME_PROOF=PASS\nCTV_PRE_POST_PRESERVATION=PASS\n"
    )
    closeout.chmod(0o600)
    digest = hashlib.sha256(closeout.read_bytes()).hexdigest()
    sidecar = canon / "CTV-GLOBAL-CLOSEOUT-PASS.sha256"
    sidecar.write_text(f"{digest}  {closeout.name}\n")
    sidecar.chmod(0o444)
    receipt.write_text(
        "CTV_LIVE=CLOSED_PASS\nCTV_IS_CTU_RETRY=NO\n"
        f"CTV_EXECUTION_MAIN={execution_main}\nCTV_HOST_CLOSEOUT_SHA256={digest}\n"
        "CTV_DETECTOR_BASELINE_MODE=INACTIVE\nCTV_DEVICE_ID=aegis-relay-01\n"
        + "CTV_FROZEN_RUNNER_SHA256=" + "b" * 64 + "\nCTV_RUNNER_TEMPLATE_SHA256=" + "c" * 64 + "\n"
        + "CTV_BUNDLE_MANIFEST_SHA256=" + "d" * 64 + "\nCTV_CONTROL_MANIFEST_SHA256=" + "e" * 64 + "\n"
        + f"CTV_UNIT_SHA256={unit_sha}\nCTV_EVIDENCE_MANIFEST_SHA256=" + "a" * 64 + "\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "reviewed CTv closeout receipt")
    main = _git(repo, "rev-parse", "HEAD")
    return repo, main, canon, unit, receipt_rel


def test_recovery_requires_reviewed_successor_receipt_bound_to_host_closeout(tmp_path):
    repo, _review_main, canon, unit, receipt_rel = _recovery_ctv_world(tmp_path)
    execution_main = next(line.split("=", 1)[1] for line in (canon / "CTV-GLOBAL-CLOSEOUT-PASS").read_text().splitlines() if line.startswith("CTV_EXECUTION_MAIN="))
    receipt = repo / receipt_rel
    receipt.unlink()
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "remove unreviewed receipt")
    unreviewed_main = _git(repo, "rev-parse", "HEAD")
    result = _run_recovery_ctv_gate(repo, unreviewed_main, canon, unit, receipt_rel)
    assert result.returncode != 0, "Recovery must block without a reviewed repository receipt"

    receipt.write_text(
        "CTV_LIVE=CLOSED_PASS\nCTV_IS_CTU_RETRY=NO\n"
        f"CTV_EXECUTION_MAIN={execution_main}\n"
        f"CTV_HOST_CLOSEOUT_SHA256={hashlib.sha256((canon / 'CTV-GLOBAL-CLOSEOUT-PASS').read_bytes()).hexdigest()}\n"
        "CTV_DETECTOR_BASELINE_MODE=INACTIVE\nCTV_DEVICE_ID=aegis-relay-01\n"
        + "CTV_FROZEN_RUNNER_SHA256=" + "b" * 64 + "\nCTV_RUNNER_TEMPLATE_SHA256=" + "c" * 64 + "\n"
        + "CTV_BUNDLE_MANIFEST_SHA256=" + "d" * 64 + "\nCTV_CONTROL_MANIFEST_SHA256=" + "e" * 64 + "\n"
        + f"CTV_UNIT_SHA256={hashlib.sha256(unit.read_bytes()).hexdigest()}\nCTV_EVIDENCE_MANIFEST_SHA256=" + "a" * 64 + "\n"
    )
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "reviewed successor receipt")
    successor_main = _git(repo, "rev-parse", "HEAD")
    result = _run_recovery_ctv_gate(repo, successor_main, canon, unit, receipt_rel)
    assert result.returncode == 0, result.stderr


def _run_recovery_ctv_gate(repo: Path, main: str, canon: Path, unit: Path, receipt_rel: Path) -> subprocess.CompletedProcess[str]:
    receipt_path = repo / receipt_rel
    receipt_sha = hashlib.sha256(receipt_path.read_bytes()).hexdigest() if receipt_path.exists() else "0" * 64
    script = f'''set -Eeuo pipefail
export SUDO="" RECOVERY_TEST_ONLY_CANONICAL_DIR_ENABLED=YES
export RECOVERY_TEST_ONLY_CANONICAL_DIR="{canon}" RECOVERY_TEST_ONLY_TRUST_ROOT="{canon.parent}"
export CTV_LIVE_RECEIPT_RELATIVE="{receipt_rel}" CTV_REPO_RECEIPT_SHA256="{receipt_sha}"
export AEGIS_CORE_UNIT_FILE="{unit}"
source "{DEPLOY / 'p4-recovery-run-lib.sh'}"
recovery_ctv_successor_gate "{repo}" "{main}"
recovery_successor_detector_mode_gate
test ! -e "{canon / 'RECOVERY-GLOBAL-ATTEMPT-CONSUMED'}"
'''
    return subprocess.run(["bash", "-c", script], text=True, capture_output=True, env={"PATH": "/usr/bin:/bin"})


def test_recovery_ctv_successor_gate_and_detector_mode_are_hermetic(tmp_path):
    repo, main, canon, unit, receipt_rel = _recovery_ctv_world(tmp_path)
    result = _run_recovery_ctv_gate(repo, main, canon, unit, receipt_rel)
    assert result.returncode == 0, result.stderr
    assert not (canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").exists()


@pytest.mark.parametrize("mutation", [
    "ctu-pass", "ctv-marker", "ctv-fail", "main", "runner", "template", "bundle", "control",
    "unit", "device", "detector", "evidence", "preservation", "receipt-pin", "receipt-main",
    "protect-clock", "user", "nnp", "capability", "ambient", "closeout-digest",
])
def test_recovery_ctv_successor_gate_rejects_each_governance_break(tmp_path, mutation):
    repo, main, canon, unit, receipt_rel = _recovery_ctv_world(tmp_path)
    closeout = canon / "CTV-GLOBAL-CLOSEOUT-PASS"
    if mutation == "ctu-pass": (canon / "CTU-GLOBAL-CLOSEOUT-PASS").write_text("fake\n")
    elif mutation == "ctv-marker": (canon / "CTV-GLOBAL-ATTEMPT-CONSUMED").unlink()
    elif mutation == "ctv-fail": (canon / "CTV-GLOBAL-CLOSEOUT-FAIL").write_text("fake\n")
    elif mutation == "main": closeout.write_text(closeout.read_text().replace("CTV_EXECUTION_MAIN=", "CTV_EXECUTION_MAIN=" + "0" * 40 + " #"))
    elif mutation in {"runner", "template", "bundle", "control", "evidence"}:
        field = {"runner": "CTV_FROZEN_RUNNER_SHA256", "template": "CTV_RUNNER_TEMPLATE_SHA256", "bundle": "CTV_BUNDLE_MANIFEST_SHA256", "control": "CTV_CONTROL_MANIFEST_SHA256", "evidence": "CTV_EVIDENCE_MANIFEST_SHA256"}[mutation]
        closeout.write_text(closeout.read_text().replace(field + "=" + ({"runner": "b", "template": "c", "bundle": "d", "control": "e", "evidence": "a"}[mutation] * 64), field + "=" + "0" * 63 + "X"))
    elif mutation == "unit": closeout.write_text(closeout.read_text().replace("CTV_UNIT_SHA256=", "CTV_UNIT_SHA256=" + "0" * 64 + " #"))
    elif mutation == "device": closeout.write_text(closeout.read_text().replace("CTV_DEVICE_ID=aegis-relay-01", "CTV_DEVICE_ID=bad device"))
    elif mutation == "detector": closeout.write_text(closeout.read_text().replace("CTV_DETECTOR_BASELINE_MODE=INACTIVE", "CTV_DETECTOR_BASELINE_MODE=BAD"))
    elif mutation == "preservation": closeout.write_text(closeout.read_text().replace("CTV_PRE_POST_PRESERVATION=PASS", "CTV_PRE_POST_PRESERVATION=FAIL"))
    elif mutation == "receipt-pin": receipt = repo / receipt_rel; receipt.write_text(receipt.read_text() + "drift\n")
    elif mutation == "receipt-main": (repo / receipt_rel).write_text((repo / receipt_rel).read_text().replace("CTV_IS_CTU_RETRY=NO", "CTV_IS_CTU_RETRY=NO\nCTV_EXPECTED_MAIN=" + "0" * 40))
    elif mutation == "protect-clock": unit.write_text(unit.read_text().replace("ProtectClock=false", "ProtectClock=true"))
    elif mutation == "user": unit.write_text(unit.read_text().replace("User=aegis-idea3", "User=root"))
    elif mutation == "nnp": unit.write_text(unit.read_text().replace("NoNewPrivileges=true", "NoNewPrivileges=false"))
    elif mutation == "capability": unit.write_text(unit.read_text().replace("CapabilityBoundingSet=", "CapabilityBoundingSet=CAP_SYS_ADMIN"))
    elif mutation == "ambient": unit.write_text(unit.read_text().replace("AmbientCapabilities=", "AmbientCapabilities=CAP_SYS_ADMIN"))
    elif mutation == "closeout-digest":
        sidecar = canon / "CTV-GLOBAL-CLOSEOUT-PASS.sha256"
        sidecar.chmod(0o644)
        sidecar.write_text("0" * 64 + "  CTV-GLOBAL-CLOSEOUT-PASS\n")
    else: raise AssertionError(mutation)
    result = _run_recovery_ctv_gate(repo, main, canon, unit, receipt_rel)
    assert result.returncode != 0, (mutation, result.stdout, result.stderr)
    assert not (canon / "RECOVERY-GLOBAL-ATTEMPT-CONSUMED").exists()


CTU_LIB = DEPLOY / "p4-ctu-run-lib.sh"


def test_ctv_core_env_device_id_validator_is_available_and_delegates_to_ctu(tmp_path):
    env_file = tmp_path / "core.env"
    cmd = f'export CTV_SUDO="" CTU_SUDO="" SUDO=""; . "{CTV_LIB}"; . "{CTU_LIB}"; ctv_validate_core_env_device_id "$1" "$2"'
    assert run_bash('. "$1"; declare -F ctv_validate_core_env_device_id', str(CTV_LIB)).returncode == 0

    env_file.write_text("# c\nAEGIS_P1_DEVICE_ID=\"aegis-relay-01\"\n")
    assert run_bash(cmd, str(env_file), "aegis-relay-01").returncode == 0
    for body, expected in (
        ("AEGIS_P1_DEVICE_ID=other-device\n", "aegis-relay-01"),
        ("OTHER=1\n", "aegis-relay-01"),
        ("AEGIS_P1_DEVICE_ID=a\nAEGIS_P1_DEVICE_ID=a\n", "a"),
        ("AEGIS_P1_DEVICE_ID=aegis-relay-01\n", "bad id;"),
        ("AEGIS_P1_DEVICE_ID=aegis-relay-01\n", ""),
    ):
        env_file.write_text(body)
        assert run_bash(cmd, str(env_file), expected).returncode != 0, (body, expected)
    link = tmp_path / "link.env"
    link.symlink_to(env_file)
    env_file.write_text("AEGIS_P1_DEVICE_ID=aegis-relay-01\n")
    assert run_bash(cmd, str(link), "aegis-relay-01").returncode != 0
    assert run_bash(cmd, str(tmp_path / "absent.env"), "aegis-relay-01").returncode != 0


def test_ctv_missing_ctu_validator_is_rejected_before_attempt_consumption(tmp_path):
    env_file = tmp_path / "core.env"
    env_file.write_text("AEGIS_P1_DEVICE_ID=aegis-relay-01\n")
    canon = tmp_path / "canon"
    canon.mkdir()
    # CTu library deliberately not sourced: the validator must fail closed.
    cmd = (
        f'export CTV_SUDO="" SUDO=""; . "{CTV_LIB}"; '
        'if ctv_validate_core_env_device_id "$1" aegis-relay-01; then echo ACCEPTED; exit 0; fi; echo REJECTED'
    )
    proc = run_bash(cmd, str(env_file))
    assert proc.stdout.strip() == "REJECTED"
    assert "CTV_DEVICE_ID_VALIDATOR_MISSING" in proc.stderr
    assert list(canon.iterdir()) == []


def test_ctv_runner_validates_device_id_before_marker_consumption():
    text = CTV_RUNNER.read_text()
    assert text.index("ctv_validate_core_env_device_id /etc/aegis-idea3/core.env") < text.index("ctv_marker_unconsumed")
    assert text.index("ctv_validate_core_env_device_id /etc/aegis-idea3/core.env") < text.index("ctv_consume_attempt")
