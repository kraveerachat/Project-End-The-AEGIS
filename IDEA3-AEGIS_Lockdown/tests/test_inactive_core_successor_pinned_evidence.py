import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "deploy" / "pr11-phase4" / "inactive-core-successor" / "inactive_core_successor_contract.py"
SPEC = importlib.util.spec_from_file_location("inactive_core_successor_contract_pinned", CHECKER)
CONTRACT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(CONTRACT)


def current_evidence():
    return {
        "schema": "idea3-inactive-core-successor-pinned-evidence-v1",
        "main_sha": "728c2d9b56d2d8b0b5933202ca20f45e6687602b",
        "rollback_decision": {"exact_release_design_approved": True, "live_authorized": False},
        "old_release": {
            "release_id": "954ce1c191885e9e90198a6f54a3d990bcf144fc",
            "verify": "PASS",
            "file_count": 54,
            "sums_sha256": "9b2faeb4f44225bcf38ba6df5b5403e014998c7310e7c04a77c30c03f2d177df",
            "manifest_sha256": "732d6af5afb0451e51655078abd8c6dc04a72ed258fb04e79c806210f2002a18",
        },
        "new_release": {
            "release_id": "idea3-core-728c2d9b-20261010",
            "verify": "PASS",
            "file_count": 55,
            "sums_sha256": "0fbe8c208b49242c4ede3a097f019879dad2e0e1ab2dd7ec1a468bc289fc5749",
            "manifest_sha256": "b6dfa93168f43d7471de3d5092baefda9f0b1027cf5dba3d6b1e3f99eb5a16cf",
            "source_main_sha": "728c2d9b56d2d8b0b5933202ca20f45e6687602b",
            "runtime_closure": "PASS",
            "local_cut_default": "DISABLED",
        },
        "runtime_baseline": {
            "core": "ACTIVE",
            "detector": {
                "load_state": "loaded", "active_state": "inactive", "sub_state": "dead",
                "unit_file_state": "disabled", "pid": 0,
            },
        },
        "systemd": {"detector_requires_core": True, "detector_after_core": True, "actual_restart_effect": "NOT_PROVEN"},
        "history": {"ctu_ctv": "FAIL_IMMUTABLE_CONSUMED", "recovery_authorized": False},
        "effects": [],
    }


def test_owner_exact_release_approval_is_design_only_and_evidence_pins_bind():
    report = CONTRACT.evaluate_pinned_evidence(current_evidence())

    assert report["binding"] == "PINNED_EVIDENCE_CONSISTENT"
    assert report["rollback_design_approval_claim_matches"] == "YES"
    assert report["rollback_live_authorized"] == "NO"
    assert report["old_release_evidence"] == "OWNER_ATTESTED_PIN_SET_MATCHES"
    assert report["new_release_evidence"] == "PIN_SET_MATCHES_REPORTED_CANDIDATE"
    assert report["systemd_restart_effect"] == "NOT_PROVEN"
    assert report["proposed_stage_id"] == "ICu"
    assert report["stage_registration"] == "NOT_REGISTERED"
    assert report["live_executor"] == "BLOCKED"
    assert report["authorization"] == "NONE"
    assert "ACTUAL_SYSTEMD_RESTART_EFFECT_NOT_PROVEN" in report["blockers"]
    assert report["successor_contract"]["attempt"] == "ONE_GLOBAL_MARKER_AFTER_PASSING_PRE_MARKER_BLOCKS_RERUN"
    assert report["successor_contract"]["journal"] == "DURABLE_WRITE_AHEAD_PHASE_RECORD_BEFORE_EACH_MUTATION"
    assert report["successor_contract"]["forward_restart_limit"] == "ONE_PLAIN_CORE_RESTART"
    assert report["successor_contract"]["rollback_restart_limit"] == "AT_MOST_ONE_AFTER_SAFE_ROLLBACK_PREFLIGHT"
    assert report["successor_contract"]["rollback"].startswith("EXACT_RELEASE_ONLY")
    assert report["successor_contract"]["unknown_systemd_effect"] == "REFUSE_BEFORE_POINTER_SWITCH_OR_RESTART"
    assert {"idea1", "idea2", "mqtt_broker", "database", "ctu_ctv_markers", "recovery_markers"}.issubset(
        report["successor_contract"]["preserve"]
    )
    assert report["successor_contract"]["detector_commands"] == "NONE"


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("old_release", "sums_sha256", "0" * 64),
        ("old_release", "manifest_sha256", "0" * 64),
        ("old_release", "verify", "FAIL"),
        ("old_release", "file_count", 53),
        ("new_release", "sums_sha256", "0" * 64),
        ("new_release", "manifest_sha256", "0" * 64),
        ("new_release", "verify", "FAIL"),
        ("new_release", "file_count", 54),
        ("new_release", "source_main_sha", "0" * 40),
        ("new_release", "runtime_closure", "FAIL"),
        ("new_release", "local_cut_default", "ENABLED"),
    ],
)
def test_release_pin_or_runtime_closure_mismatch_rejects_evidence(section, field, value):
    evidence = current_evidence()
    evidence[section][field] = value
    report = CONTRACT.evaluate_pinned_evidence(evidence)
    assert report["binding"] == "INCONSISTENT"


def test_live_authority_or_attempt_effect_claim_is_rejected():
    evidence = current_evidence()
    evidence["rollback_decision"]["live_authorized"] = True
    assert CONTRACT.evaluate_pinned_evidence(evidence)["binding"] == "INCONSISTENT"

    evidence = current_evidence()
    evidence["effects"] = ["CORE_RESTART"]
    report = CONTRACT.evaluate_pinned_evidence(evidence)
    assert report["binding"] == "INCONSISTENT"
    assert report["live_executor"] == "BLOCKED"


def test_detector_drift_unknown_systemd_effect_and_recovery_claim_stay_blocked():
    evidence = current_evidence()
    evidence["runtime_baseline"]["detector"]["pid"] = 44
    evidence["systemd"]["actual_restart_effect"] = "UNKNOWN"
    evidence["history"]["recovery_authorized"] = True
    report = CONTRACT.evaluate_pinned_evidence(evidence)
    assert report["binding"] == "INCONSISTENT"
    assert report["live_executor"] == "BLOCKED"
    assert report["authorization"] == "NONE"


def test_invalid_schema_and_dependency_claim_cannot_upgrade_readiness():
    evidence = current_evidence()
    evidence["schema"] = "unrecognized"
    assert CONTRACT.evaluate_pinned_evidence(evidence)["binding"] == "INCONSISTENT"

    evidence = current_evidence()
    evidence["systemd"]["detector_requires_core"] = False
    report = CONTRACT.evaluate_pinned_evidence(evidence)
    assert report["binding"] == "INCONSISTENT"
    assert report["live_executor"] == "BLOCKED"
