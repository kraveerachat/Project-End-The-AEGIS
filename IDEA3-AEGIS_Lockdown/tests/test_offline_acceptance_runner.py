"""The offline acceptance runner must be deterministic, fail closed, and unable to claim physical or Production acceptance."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path

import offline_acceptance as oa

APP = Path(__file__).resolve().parent.parent


def _all_passing_cases() -> list[tuple[str, str]]:
    cases = set()
    for patterns in oa.REQUIREMENTS.values():
        for pattern in patterns:
            cases.add((pattern + ("case" if pattern.endswith("::") else ""), "passed"))
    return sorted(cases)


def test_every_requirement_pattern_matches_a_real_collected_test():
    """The mapping cannot rot: each pattern must select at least one test that pytest actually collects."""
    paths = [str(APP / "tests" / f"{module}.py") for module in oa.MODULES]
    out = subprocess.run([sys.executable, "-m", "pytest", "--collect-only", "-q", "-p", "no:cacheprovider", *paths],
                         cwd=APP, capture_output=True, text=True, check=True).stdout
    collected = [line.split("/")[-1].replace(".py::", "::", 1) for line in out.splitlines() if ".py::" in line]
    assert collected
    for name, patterns in oa.REQUIREMENTS.items():
        for pattern in patterns:
            assert any(case.startswith(pattern) for case in collected), (name, pattern)


def test_all_passing_cases_yield_pass_with_fixed_truth_flags():
    result = oa.build_result(_all_passing_cases(), 0, "deadbeef")
    assert result["result"] == "PASS"
    assert result["evidence_class"] == "SIMULATED_OFFLINE"
    for flag in ("production_acceptance", "physical_acceptance", "hardware_executed", "production_mutation", "recovery_executed"):
        assert result[flag] is False
    assert all(item["status"] == "PASS" for item in result["requirements"].values())


def test_a_failed_skipped_or_missing_test_fails_the_requirement_and_the_run():
    base = _all_passing_cases()
    target = oa.REQUIREMENTS["RESTORE_GUARD"][0]
    for outcome in ("failed", "skipped"):
        cases = [(c, outcome if c.startswith(target) else o) for c, o in base]
        result = oa.build_result(cases, 0, "x")
        assert result["result"] == "FAIL" and result["requirements"]["RESTORE_GUARD"]["status"] == "FAIL"
    missing = [(c, o) for c, o in base if not c.startswith(target)]
    result = oa.build_result(missing, 0, "x")
    assert result["result"] == "FAIL" and target in result["requirements"]["RESTORE_GUARD"]["unmatched_patterns"]
    assert oa.build_result(base, 1, "x")["result"] == "FAIL"  # a non-zero pytest exit can never be PASS
    assert oa.build_result([], 0, "x")["result"] == "FAIL"


def test_a_requirement_with_no_tests_is_never_vacuously_passing():
    result = oa.build_result([("test_unrelated::test_x", "passed")], 0, "x")
    assert all(item["status"] == "FAIL" and item["tests"] == 0 for item in result["requirements"].values())


def test_output_is_deterministic_and_has_no_time_fields():
    cases = _all_passing_cases()
    first = json.dumps(oa.build_result(copy.deepcopy(cases), 0, "abc"), sort_keys=True)
    second = json.dumps(oa.build_result(list(reversed(cases)), 0, "abc"), sort_keys=True)
    assert first == second
    assert not any(token in first for token in ("timestamp", "duration", "time\":", "date"))


def test_the_runner_has_no_network_hardware_or_privileged_calls():
    source = (APP / "tests" / "offline_acceptance.py").read_text()
    for forbidden in ("socket", "requests", "urllib", "sudo", "systemctl", "esptool", "paho", "RESTORE_UPLINK"):
        assert forbidden not in source, forbidden


def test_the_tree_state_is_reported_so_a_dirty_run_cannot_pass_as_a_clean_commit():
    assert oa.build_result(_all_passing_cases(), 0, "abc")["git_tree_dirty"] is False
    assert oa.build_result(_all_passing_cases(), 0, "abc", True)["git_tree_dirty"] is True
