"""Contract tests for the isolated fail-closed negative-control driver."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

DRIVER_PATH = Path(__file__).resolve().parent.parent / "deploy" / "production-like-negative-controls.py"
SPEC = importlib.util.spec_from_file_location("production_like_negative_controls", DRIVER_PATH)
assert SPEC is not None and SPEC.loader is not None
CONTROLS = importlib.util.module_from_spec(SPEC)
# dataclasses resolve their defining module through sys.modules.
sys.modules[SPEC.name] = CONTROLS
SPEC.loader.exec_module(CONTROLS)


def _observation(**overrides):
    observation = {
        "exit": 0,
        "exitedDuringStart": False,
        "controlTokenResidue": False,
        "survivingProcesses": [],
        "webListenerAfter": False,
        "secretLeak": False,
        "finalServiceStatus": {"status": "STOPPED", "physicalEvidence": "UNKNOWN"},
        "runningServiceStatus": {
            "idea1": "NOT_CONFIGURED",
            "idea2": "NOT_CONFIGURED",
            "mqtt": "NOT_CONFIGURED",
            "physicalEvidence": "UNKNOWN",
        },
        "idea1": {"status": "NOT_CONFIGURED"},
        "idea2": {"status": "NOT_CONFIGURED"},
        "operationalErrors": [],
        "incidents": 0,
        "coreBroker": None,
    }
    observation.update(overrides)
    return observation


def test_driver_requires_an_explicit_data_root():
    with pytest.raises(SystemExit):
        CONTROLS.build_parser().parse_args([])


def test_cases_cover_every_required_fail_closed_category():
    categories = {case.category for case in CONTROLS.CASES}
    names = [case.name for case in CONTROLS.CASES]

    assert {
        "control",
        "invalid-config",
        "audit-failure",
        "mqtt",
        "idea1",
        "idea2",
        "stale-evidence",
        "malformed-evidence",
    } <= categories
    assert len(names) == len(set(names))


def test_fail_closed_requires_a_failed_exit_and_no_residue():
    failed = _observation(
        exit=1,
        exitedDuringStart=True,
        finalServiceStatus={"status": "FAILED", "physicalEvidence": "UNKNOWN"},
    )

    assert CONTROLS.fails_closed(failed)
    assert not CONTROLS.fails_closed({**failed, "survivingProcesses": [4242]})
    assert not CONTROLS.fails_closed({**failed, "controlTokenResidue": True})
    assert not CONTROLS.fails_closed({**failed, "webListenerAfter": True})
    assert not CONTROLS.fails_closed(_observation())


def test_rejected_before_start_requires_exit_two_and_no_service_status():
    rejected = _observation(exit=2, exitedDuringStart=True, finalServiceStatus=None)

    assert CONTROLS.rejected_before_start(rejected)
    assert not CONTROLS.rejected_before_start({**rejected, "exit": 1})
    assert not CONTROLS.rejected_before_start(
        {**rejected, "finalServiceStatus": {"status": "FAILED"}}
    )


def test_degraded_feed_stays_unknown_explicit_and_incident_free():
    check = CONTROLS.degrades("idea1", "ADAPTER_UNAVAILABLE")
    degraded = _observation(
        idea1={"status": "UNKNOWN"},
        operationalErrors=["ADAPTER_UNAVAILABLE"],
        runningServiceStatus={"idea1": "UNKNOWN", "physicalEvidence": "UNKNOWN"},
    )

    assert check(degraded)
    assert not check({**degraded, "idea1": {"status": "HEALTHY"}})
    assert not check({**degraded, "incidents": 1})
    assert not check({**degraded, "operationalErrors": []})
    assert not check(
        {**degraded, "runningServiceStatus": {"idea1": "UNAVAILABLE", "physicalEvidence": "UNKNOWN"}}
    )


def test_mqtt_configured_but_unprobed_preserves_unknown_truth():
    mqtt_case = next(case for case in CONTROLS.CASES if case.category == "mqtt")
    unprobed = _observation(
        coreBroker="UNKNOWN",
        runningServiceStatus={"mqtt": "UNKNOWN", "physicalEvidence": "UNKNOWN"},
    )

    assert mqtt_case.name == "mqtt-configured-unprobed-dry-run"
    assert CONTROLS.mqtt_unprobed(unprobed)
    assert not CONTROLS.mqtt_unprobed(
        {**unprobed, "runningServiceStatus": {"mqtt": "UNAVAILABLE", "physicalEvidence": "UNKNOWN"}}
    )
    assert not CONTROLS.mqtt_unprobed({**unprobed, "coreBroker": "DISCONNECTED"})


def test_mqtt_unavailable_and_positive_control_predicates():
    assert CONTROLS.mqtt_unavailable(
        _observation(runningServiceStatus={"mqtt": "UNAVAILABLE", "physicalEvidence": "UNKNOWN"})
    )
    assert not CONTROLS.mqtt_unavailable(
        _observation(runningServiceStatus={"mqtt": "CONNECTED", "physicalEvidence": "UNKNOWN"})
    )

    healthy = _observation(
        idea1={"status": "HEALTHY"},
        runningServiceStatus={"idea1": "UNKNOWN", "physicalEvidence": "UNKNOWN"},
    )
    assert CONTROLS.healthy_control(healthy)
    assert not CONTROLS.healthy_control(
        {**healthy, "runningServiceStatus": {"idea1": "UNAVAILABLE", "physicalEvidence": "UNKNOWN"}}
    )
    assert not CONTROLS.healthy_control({**healthy, "survivingProcesses": [4242]})
