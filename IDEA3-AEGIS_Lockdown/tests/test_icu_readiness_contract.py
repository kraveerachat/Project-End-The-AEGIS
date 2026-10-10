import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "deploy/pr11-phase4/inactive-core-successor/inactive_core_successor_contract.py"
SPEC = importlib.util.spec_from_file_location("icu_readiness_contract", MODULE)
CONTRACT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(CONTRACT)


def evidence():
    return {
        "schema": "idea3-icu-readiness-evidence-v1",
        "main_sha": CONTRACT.CURRENT_MAIN,
        "old_release": {
            "release_id": CONTRACT.OLD_RELEASE,
            "sums_sha256": "9b2faeb4f44225bcf38ba6df5b5403e014998c7310e7c04a77c30c03f2d177df",
            "manifest_sha256": "732d6af5afb0451e51655078abd8c6dc04a72ed258fb04e79c806210f2002a18",
            "tree_sha256": "9b2faeb4f44225bcf38ba6df5b5403e014998c7310e7c04a77c30c03f2d177df",
            "guard": "PASS",
            "rollback_approval": "DESIGN_ONLY",
        },
        "new_release": {
            "release_id": CONTRACT.NEW_RELEASE,
            "sums_sha256": "0fbe8c208b49242c4ede3a097f019879dad2e0e1ab2dd7ec1a468bc289fc5749",
            "manifest_sha256": "b6dfa93168f43d7471de3d5092baefda9f0b1027cf5dba3d6b1e3f99eb5a16cf",
            "source_main_sha": CONTRACT.CURRENT_MAIN,
            "guard": "OWNER_REPORTED_PASS",
        },
        "installed": {
            "current_release_id": CONTRACT.OLD_RELEASE,
            "core_unit_sha256": "a" * 64,
            "core_dropins_sha256": ["b" * 64],
            "detector_unit_sha256": "c" * 64,
            "detector_dropins_sha256": [],
            "core_active_state": "active",
            "detector_load_state": "loaded",
            "detector_active_state": "inactive",
            "detector_sub_state": "dead",
            "detector_unit_file_state": "disabled",
            "detector_pid": 0,
            "detector_process_count": 0,
            "detector_requires_core": True,
            "detector_after_core": True,
            "detector_restart": "no",
        },
        "restart_effect": {
            "result": "PASS",
            "evidence_class": "SYNTHETIC_USER_SYSTEMD_TEST",
            "core_restart_argv": ["systemctl", "restart", "aegis-idea3-core.service"],
        },
        "authority": {
            "stage": "ICu",
            "exact_main": CONTRACT.CURRENT_MAIN,
            "independent_review": False,
            "owner_execution_approval": False,
            "core_upgrade_authorized": False,
            "rollback_live_authorized": False,
            "recovery_authorized": False,
        },
        "attempt": {"marker": "ABSENT", "journal": "ABSENT", "attempt_count": 0},
        "rollback": {
            "release_id": CONTRACT.OLD_RELEASE,
            "mode": "EXACT_RELEASE",
            "preflight_required": True,
            "max_restart_invocations": 1,
        },
        "preservation": {
            "pre": {
            "idea1": "RUNNING",
            "idea2": "RUNNING",
            "mqtt_broker": "RUNNING",
            "mqtt_service_2": "RUNNING",
            "twingate": "RUNNING",
            "tunnel": "RUNNING",
            "firewall": "ACTIVE",
            "nftables": "UNCHANGED",
            "network": "UNCHANGED",
            "database": "UNCHANGED",
            "relay": "UNCHANGED",
            "esp32": "UNCHANGED",
            "incidents": "UNCHANGED",
            "ctu_ctv_markers": "UNCHANGED",
            "recovery_markers": "UNCHANGED",
            },
            "post": {
                "idea1": "RUNNING", "idea2": "RUNNING", "mqtt_broker": "RUNNING",
                "mqtt_service_2": "RUNNING", "twingate": "RUNNING", "tunnel": "RUNNING",
                "firewall": "ACTIVE", "nftables": "UNCHANGED", "network": "UNCHANGED",
                "database": "UNCHANGED", "relay": "UNCHANGED", "esp32": "UNCHANGED",
                "incidents": "UNCHANGED", "ctu_ctv_markers": "UNCHANGED", "recovery_markers": "UNCHANGED",
            },
        },
        "detector_commands": [],
        "effects": [],
    }


def test_synthetic_restart_pass_does_not_prove_installed_unit_consequence():
    report = CONTRACT.evaluate_icu_readiness(evidence())

    assert report["systemd_restart_effect"] == "NOT_PROVEN"
    assert report["live_executor"] == "BLOCKED"
    assert report["attempt_marker_may_be_consumed"] is False
    assert "ACTUAL_INSTALLED_UNIT_RESTART_EFFECT_NOT_PROVEN" in report["blockers"]


def test_readiness_requires_exact_installed_unit_detector_authority_attempt_and_preservation():
    sample = evidence()
    sample["restart_effect"] = {
        "result": "PASS",
        "evidence_class": "ACTUAL_INSTALLED_UNIT_RESTART_OBSERVATION",
        "core_restart_argv": ["systemctl", "restart", "aegis-idea3-core.service"],
    }
    report = CONTRACT.evaluate_icu_readiness(sample)

    assert report["checks"]["installed_units"] == "CONSISTENT"
    assert report["checks"]["inactive_detector"] == "CONSISTENT"
    assert report["checks"]["release_pins"] == "CONSISTENT"
    assert report["checks"]["authority"] == "REJECTED"
    assert report["checks"]["one_attempt_journal"] == "REJECTED"
    assert report["checks"]["rollback"] == "CONSISTENT"
    assert report["checks"]["preservation"] == "CONSISTENT"
    assert report["live_executor"] == "BLOCKED"


def test_pin_unit_or_attempt_drift_fails_closed():
    sample = evidence()
    sample["new_release"]["sums_sha256"] = "0" * 64
    sample["installed"]["detector_pid"] = 12
    sample["attempt"]["attempt_count"] = 1
    sample["preservation"]["post"]["idea2"] = "STOPPED"

    report = CONTRACT.evaluate_icu_readiness(sample)

    assert report["checks"]["release_pins"] == "REJECTED"
    assert report["checks"]["inactive_detector"] == "REJECTED"
    assert report["checks"]["one_attempt_journal"] == "REJECTED"
    assert report["checks"]["preservation"] == "REJECTED"
    assert report["attempt_marker_may_be_consumed"] is False
    assert report["live_executor"] == "BLOCKED"
