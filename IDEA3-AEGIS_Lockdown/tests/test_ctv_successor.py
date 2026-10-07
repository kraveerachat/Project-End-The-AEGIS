from __future__ import annotations

import hashlib
import importlib.util
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "IDEA3-AEGIS_Lockdown" / "deploy" / "pr11-phase4"
CTV_LIB = DEPLOY / "p4-ctv-run-lib.sh"
CTV_RUNNER = DEPLOY / "owner-run" / "run-ctv-owner.sh"
FREEZE = DEPLOY / "ctv-acceptance" / "ctv_runner_freeze.py"


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
