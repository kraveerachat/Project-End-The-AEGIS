#!/usr/bin/env python3
"""Deterministic OFFLINE Core acceptance runner with machine-readable results.

    python3 tests/offline_acceptance.py [--json PATH]      (run from IDEA3-AEGIS_Lockdown/, or anywhere)

Runs a fixed set of existing Core/protocol test modules with pytest, then maps individual tests to the acceptance requirements below.
A requirement is PASS only if at least one mapped test ran, none failed and none was skipped; a pattern that matches no collected test
makes the whole run FAIL (the mapping cannot silently rot). The JSON contains no timestamps or durations and is sorted, so the same
tree produces the same bytes. Evidence class is always SIMULATED_OFFLINE: this tool can never report Production, hardware or physical
acceptance.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
SCHEMA = "aegis-idea3-offline-core-acceptance/1"
EVIDENCE_CLASS = "SIMULATED_OFFLINE"

# Every module that carries a mapped test. Whole-module patterns end with "::".
MODULES = (
    "test_offline_core_acceptance", "test_protocol_v1", "test_protocol_v1_vectors", "test_protocol_inbound", "test_protocol_ordering",
    "test_mqtt_client", "test_dispatch_boundary", "test_dispatch_contract", "test_core_alert_ingress", "test_core_restore_policy",
    "test_firmware_protocol_parity", "test_offline_acceptance_runner",
)
A = "test_offline_core_acceptance::"
REQUIREMENTS: dict[str, tuple[str, ...]] = {
    "OFFLINE_CORE_PIPELINE": (
        A + "test_offline_pipeline_detection_to_audit_evidence", "test_protocol_ordering::test_dispatch_publishes_one_signed_command",
        "test_dispatch_contract::test_the_core_emits_exactly_the_contract_evidence_set",
    ),
    "HMAC_NONCE_TIMESTAMP": (
        A + "test_device_silently_drops_unauthenticated_commands", A + "test_each_command_has_a_fresh_nonce",
        A + "test_expired_stale_and_untrusted_time_commands", A + "test_forged_stale_or_misrouted_device_evidence",
        "test_protocol_v1::", "test_protocol_v1_vectors::", "test_protocol_inbound::",
    ),
    "REPLAY_REJECTION": (
        A + "test_replayed_command_is_rejected_by_sequence", A + "test_replayed_valid_ack_and_status",
        "test_mqtt_client::test_stale_future_wrong_device_and_replayed_status", "test_mqtt_client::test_ack_drives_pending_state_only",
    ),
    "ACK_STATUS_CORRELATION": (
        A + "test_status_for_a_different_command", A + "test_a_periodic_lockdown_status_is_liveness_only",
        A + "test_core_resolves_every_device_rejection", "test_mqtt_client::test_command_status_confirms_only_the_open_command",
        "test_dispatch_boundary::test_c4_", "test_protocol_ordering::test_the_evidence_ladder_is_never_promoted",
    ),
    "AUDIT_EVIDENCE": (
        A + "test_offline_pipeline_detection_to_audit_evidence", A + "test_audit_chain_detects_tampering",
        A + "test_replayed_valid_ack_and_status", "test_protocol_inbound::test_post_auth_audit_contains_codes_only",
        "test_core_alert_ingress::test_a_valid_alert_binds_the_incident",
    ),
    "DETECTOR_CANNOT_BYPASS_CORE_POLICY": (
        A + "test_detector_alerts_never_publish_cut_or_restore", "test_core_alert_ingress::test_a_valid_alert_never_contains_cuts",
        "test_core_alert_ingress::test_the_handler_source_cannot_reach_containment",
    ),
    "RESTORE_GUARD": (
        A + "test_restore_is_blocked_without_the_verified_recovery_policy", A + "test_restore_via_the_local_gate_is_refused",
        "test_core_restore_policy::", "test_protocol_ordering::test_no_restore_on_reconnect",
        "test_protocol_ordering::test_the_headless_supervisor_has_no_restore_authority",
        "test_protocol_ordering::test_a_production_supervisor_refuses_any_restore_origin",
    ),
    "SIMULATED_EVIDENCE_IS_NOT_PHYSICAL": (
        A + "test_simulated_device_rule_order_matches_the_firmware_source", A + "test_offline_evidence_is_labelled_simulated",
        "test_protocol_ordering::test_the_evidence_ladder_is_never_promoted", "test_firmware_protocol_parity::",
        "test_offline_acceptance_runner::",
    ),
}


def test_ids(root: ET.Element) -> list[tuple[str, str]]:
    """(id, outcome) for every JUnit testcase; outcome is passed / failed / skipped."""
    found = []
    for case in root.iter("testcase"):
        module = case.get("classname", "").rsplit(".", 1)[-1]
        outcome = "passed"
        for child in case:
            if child.tag in ("failure", "error"):
                outcome = "failed"
            elif child.tag == "skipped" and outcome != "failed":
                outcome = "skipped"
        found.append((f"{module}::{case.get('name', '')}", outcome))
    return sorted(found)


def build_result(cases: list[tuple[str, str]], pytest_exit: int, head: str, dirty: bool = False) -> dict:
    """Pure and deterministic: the same inputs always produce the same document."""
    requirements = {}
    for name, patterns in sorted(REQUIREMENTS.items()):
        unmatched = [p for p in patterns if not any(case_id.startswith(p) for case_id, _ in cases)]
        matched = [(case_id, outcome) for case_id, outcome in cases if any(case_id.startswith(p) for p in patterns)]
        failed = sorted(case_id for case_id, outcome in matched if outcome == "failed")
        skipped = sorted(case_id for case_id, outcome in matched if outcome == "skipped")
        ok = bool(matched) and not failed and not skipped and not unmatched
        requirements[name] = {
            "status": "PASS" if ok else "FAIL",
            "tests": len(matched),
            "passed": sum(1 for _, outcome in matched if outcome == "passed"),
            "failed": failed,
            "skipped": skipped,
            "unmatched_patterns": sorted(unmatched),
        }
    passed = all(item["status"] == "PASS" for item in requirements.values()) and pytest_exit == 0
    return {
        "schema": SCHEMA,
        "evidence_class": EVIDENCE_CLASS,
        "result": "PASS" if passed else "FAIL",
        "git_head": head,
        "git_tree_dirty": dirty,
        "pytest_exit_code": pytest_exit,
        "tests_total": len(cases),
        "requirements": requirements,
        # Fixed truth statements: nothing in an offline run can establish any of these.
        "production_acceptance": False,
        "physical_acceptance": False,
        "hardware_executed": False,
        "production_mutation": False,
        "recovery_executed": False,
        "note": "Simulated offline software acceptance only: no broker, Production host, ESP32, relay, cut or RESTORE was involved.",
    }


def run_pytest(junit: Path) -> int:
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    for var in ("AEGIS_PROTOCOL_MODE", "AEGIS_BROKER_IP"):
        env.pop(var, None)
    paths = [str(APP / "tests" / f"{module}.py") for module in MODULES]
    command = [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", f"--junitxml={junit}", *paths]
    return subprocess.run(command, cwd=APP, env=env, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode


def git_head() -> str:
    try:
        return subprocess.run(["git", "-C", str(APP), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "UNKNOWN"


def git_dirty() -> bool:
    """True when tracked or untracked files under this tree differ from HEAD (the result then describes uncommitted bytes)."""
    try:
        out = subprocess.run(["git", "-C", str(APP), "status", "--porcelain", "--", str(APP)], capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return True
    return bool(out.strip())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", type=Path, help="also write the result document to this path")
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory(prefix="aegis-offline-acceptance-") as scratch:
        junit = Path(scratch) / "junit.xml"
        exit_code = run_pytest(junit)
        cases = test_ids(ET.parse(junit).getroot()) if junit.is_file() else []
    document = build_result(cases, exit_code, git_head(), git_dirty())
    text = json.dumps(document, indent=2, sort_keys=True) + "\n"
    if args.json:
        args.json.write_text(text, encoding="utf-8")
    sys.stdout.write(text)
    return 0 if document["result"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
