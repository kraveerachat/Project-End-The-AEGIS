import ast
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "deploy" / "pr11-phase4" / "inactive-core-successor" / "inactive_core_successor_contract.py"
SPEC = importlib.util.spec_from_file_location("inactive_core_successor_contract", CHECKER)
CONTRACT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(CONTRACT)


def evidence():
    old = "954ce1c191885e9e90198a6f54a3d990bcf144fc"
    digest = "a" * 64
    files = {
        "aegis_soc/__init__.py": "0" * 64,
        "aegis_soc/cli.py": "3" * 64,
        "aegis_soc/production_detector.py": "4" * 64,
        "aegis_soc/supervisor.py": digest,
        "aegis_soc/recovery_core.py": "b" * 64,
        "aegis_soc/recovery_ui.py": "5" * 64,
        "aegis_soc/local_cut.py": "c" * 64,
    }
    payload_files = {**files, "requirements.txt": "8" * 64, "venv/bin/python": "9" * 64}
    manifest = {
        "schema_version": 1,
        "release_id": "new-release-20261010",
        "source_git_sha": "d" * 40,
        "source_tree_dirty": False,
        "python_version": "3.14.7",
        "requirements_sha256": payload_files["requirements.txt"],
        "file_count": len(payload_files),
        "created_by_tool_version": "1",
    }
    manifest_bytes = json.dumps(manifest, indent=2).encode("ascii") + b"\n"
    payload_files["RELEASE-MANIFEST.json"] = hashlib.sha256(manifest_bytes).hexdigest()
    sums = "".join(f"{payload_files[path]}  {path}\n" for path in sorted(payload_files))
    detector = {
        "load_state": "loaded", "active_state": "inactive", "sub_state": "dead",
        "unit_file_state": "disabled", "pid": 0, "process_count": 0, "unit_sha256": "c" * 64,
    }
    services = {
        "idea1": "active", "idea2": "active", "mqtt_broker": "active", "mqtt_service_2": "active",
        "twingate": "active", "tunnel": "active", "firewall": "unchanged", "nftables": "unchanged",
        "network": "unchanged", "relay": "unknown", "esp32": "unknown", "incidents": "unchanged",
        "recovery_markers": "unchanged", "database": "unchanged",
    }
    return {
        "schema": "idea3-inactive-core-successor-evidence-v1",
        "source": {"base_main": "dbf00185331474053f46486fcefa795a46f5b821", "reviewed_main": "d" * 40, "clean_tree": True},
        "releases": {
            "old": {"release_id": old, "tree_sha256": "e" * 64, "digest_basis": "OWNER_VERIFIED", "rollback_approved": True},
            "candidate": {"release_id": "new-release-20261010", "source_git_sha": "d" * 40,
                          "tree_sha256": hashlib.sha256(sums.encode("ascii")).hexdigest(),
                          "manifest": manifest, "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
                          "release_sums_sha256": hashlib.sha256(sums.encode("ascii")).hexdigest(),
                          "release_sums_content": sums,
                          "guard": "VERIFIED", "source_files": files, "payload_files": payload_files,
                          "payload_kinds": {path: "regular" for path in payload_files},
                          "guard_payload_paths": sorted(payload_files)},
        },
        "detector": {"pre": dict(detector), "post": dict(detector)},
        "systemd": {"dependency_verified": True, "inactive_restart_behavior_verified": True, "restart_argv": ["restart", "aegis-idea3-core.service"], "job_mode": "default"},
        "rollback": {"target_release_id": old, "target_tree_sha256": "e" * 64, "pre_tree_sha256": "e" * 64, "safety_class": "EXACT_RELEASE", "owner_approved": True},
        "history": {
            "ctu": {"result": "FAIL_IMMUTABLE", "attempt_consumed": True, "rerun_allowed": False},
            "ctv": {"result": "FAIL_IMMUTABLE", "live": "CLOSED_FAIL", "attempt_consumed": True,
                    "rerun_allowed": False, "s10": "FAIL", "s10_promoted": False},
        },
        "preservation": {"pre": services, "post": dict(services)},
        "effects": [],
    }


def test_offline_contract_checker_is_added_in_the_inactive_successor_boundary():
    assert CHECKER.is_file()
    report = CONTRACT.evaluate(evidence())
    assert report["checks"]["inactive_detector"] == "CONSISTENT"
    assert report["live_executor"] == "BLOCKED"


def test_detector_activation_or_pid_drift_rejects_preservation():
    for field, value in (("active_state", "active"), ("pid", 321), ("process_count", 1)):
        sample = evidence()
        sample["detector"]["post"][field] = value
        report = CONTRACT.evaluate(sample)
        assert report["checks"]["inactive_detector"] == "REJECTED"
        assert "DETECTOR_NOT_INACTIVE_AND_UNCHANGED" in report["blockers"]


def test_release_digest_or_source_mismatch_rejects_content_closure():
    sample = evidence()
    sample["releases"]["candidate"]["payload_files"]["aegis_soc/supervisor.py"] = "9" * 64
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["release_content_closure"] == "REJECTED"

    sample = evidence()
    sample["releases"]["candidate"]["source_git_sha"] = "8" * 40
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["source_binding"] == "REJECTED"

    sample = evidence()
    sample["releases"]["candidate"]["payload_files"]["RELEASE-MANIFEST.json"] = "7" * 64
    assert CONTRACT.evaluate(sample)["checks"]["release_content_closure"] == "REJECTED"


def test_release_ids_must_be_distinct_and_guard_inventory_must_close_payload():
    sample = evidence()
    sample["releases"]["candidate"]["release_id"] = sample["releases"]["old"]["release_id"]
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["release_content_closure"] == "REJECTED"

    sample = evidence()
    del sample["releases"]["candidate"]["payload_files"]["aegis_soc/local_cut.py"]
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["release_content_closure"] == "REJECTED"


def test_malformed_non_ascii_release_paths_are_rejected_without_raising():
    sample = evidence()
    sample["releases"]["candidate"]["payload_files"]["aegis_soc/😀.py"] = "7" * 64
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["release_content_closure"] == "REJECTED"


def test_incomplete_release_closure_and_unmeasured_old_release_block_preflight():
    sample = evidence()
    del sample["releases"]["candidate"]["source_files"]["aegis_soc/local_cut.py"]
    sample["releases"]["candidate"]["payload_files"].pop("aegis_soc/local_cut.py")
    sample["releases"]["old"]["tree_sha256"] = None
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["release_content_closure"] == "REJECTED"
    assert report["checks"]["rollback_target"] == "REJECTED"
    assert "OLD_RELEASE_TREE_DIGEST_NOT_OWNER_VERIFIED" in report["blockers"]

    sample = evidence()
    sample["releases"]["candidate"]["payload_kinds"]["venv/bin/python"] = "symlink"
    assert CONTRACT.evaluate(sample)["checks"]["release_content_closure"] == "REJECTED"


def test_rollback_target_mismatch_or_unapproved_class_is_rejected():
    sample = evidence()
    sample["rollback"]["target_release_id"] = "different-release"
    sample["rollback"]["safety_class"] = "SAFE_EQUIVALENT"
    sample["rollback"]["owner_approved"] = False
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["rollback_target"] == "REJECTED"
    assert "ROLLBACK_TARGET_OR_APPROVAL_UNPROVEN" in report["blockers"]


def test_ctu_ctv_failures_cannot_be_promoted_or_retried():
    sample = evidence()
    sample["history"]["ctu"]["rerun_allowed"] = True
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["ctu_ctv_history"] == "REJECTED"

    sample = evidence()
    sample["history"]["ctv"]["s10_promoted"] = True
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["ctu_ctv_history"] == "REJECTED"

    sample = evidence()
    sample["history"]["ctv"]["ctv_pass_claim"] = True
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["ctu_ctv_history"] == "REJECTED"


@pytest.mark.parametrize("effect", ["CUT", "RESTORE", "ISOLATE", "MQTT_PUBLISH", "NETWORK_MUTATION", "FIREWALL_MUTATION", "CORE_RESTART", "DETECTOR_START", "PRODUCTION_DEPLOYMENT", "UNLISTED_EFFECT"])
def test_any_prohibited_effect_rejects_the_offline_contract(effect):
    sample = evidence()
    sample["effects"] = [effect]
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["prohibited_effects_absent"] == "REJECTED"


def test_preservation_drift_and_unproven_systemd_behavior_are_reported_as_blockers():
    sample = evidence()
    sample["preservation"]["post"]["idea2"] = "unknown"
    sample["systemd"]["inactive_restart_behavior_verified"] = False
    report = CONTRACT.evaluate(sample)
    assert report["checks"]["service_preservation_input"] == "REJECTED"
    assert report["checks"]["systemd_contract_input"] == "REJECTED"

    sample = evidence()
    sample["preservation"]["post"]["unlisted_service"] = "changed"
    assert CONTRACT.evaluate(sample)["checks"]["service_preservation_input"] == "REJECTED"


def test_report_never_claims_production_readiness_authorization_or_physical_effect():
    report = CONTRACT.evaluate(evidence())
    assert report["live_executor"] == "BLOCKED"
    assert report["production_readiness"] == "NOT_ASSESSED"
    assert report["authorization"] == "NONE"
    assert report["physical_containment"] == "NOT_PROVEN"
    assert "INSTALLED_SYSTEMD_BEHAVIOR_NOT_LIVE_PROVEN" in report["blockers"]
    assert "CURRENT_OLD_RELEASE_TREE_DIGEST_NOT_SUPPLIED" in report["blockers"]


def test_checker_has_no_filesystem_process_network_or_host_control_imports():
    tree = ast.parse(CHECKER.read_text())
    forbidden_imports = {"os", "pathlib", "subprocess", "socket", "urllib", "requests", "paho"}
    imported = {
        alias.name.split(".")[0]
        for node in ast.walk(tree)
        if isinstance(node, (ast.Import, ast.ImportFrom))
        for alias in node.names
    }
    assert not (imported & forbidden_imports)
    forbidden_calls = {"open", "system", "popen", "run", "connect", "publish", "restart", "start", "unlink"}
    called = {node.func.id for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
    assert not (called & forbidden_calls)
