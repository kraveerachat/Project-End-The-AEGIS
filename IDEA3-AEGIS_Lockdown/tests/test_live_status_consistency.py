"""Web and Desktop must interpret the same authoritative Core status consistently (synthetic TEST_ONLY fixtures).

The Python side computes, for every scenario, what the Desktop reader accepts and the versioned projection the Web is
given. ``web/tests/fixtures/status-consistency-matrix.json`` records both; ``web/tests/server/statusConsistency.test.js``
evaluates the Web adapter against the recorded Desktop semantics. Neither side is allowed to be healthier than the other.
This is a hermetic, synthetic comparison and not cross-host Production evidence.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from aegis_soc import observer
from tools import local_status_bridge

NOW = 1_700_000_100.0
MATRIX = Path(__file__).resolve().parents[1] / "web" / "tests" / "fixtures" / "status-consistency-matrix.json"


def base(**changes):
    value = {
        "state": "RUNNING", "profile": "production", "dry_run": False, "auto_contain": False, "broker": "CONNECTED",
        "device": "ONLINE", "uplink": "NORMAL", "armed": "MONITOR_ONLY", "dispatch": "DISABLED", "time_trust": "SYNCED",
        "updated_at": NOW - 5, "components": {"detector": "RUNNING"},
    }
    value.update(changes)
    return value


# name -> (kind, payload). kind: json (dict), text (raw), missing, unreadable, oversized
SCENARIOS = {
    "S01_fresh_running_healthy_uplink_normal": ("json", base()),
    "S02_lockdown_state_uplink_lockdown": ("json", base(state="LOCKDOWN", uplink="LOCKDOWN")),
    "S03_running_with_uplink_lockdown": ("json", base(uplink="LOCKDOWN")),
    "S04_broker_disconnected": ("json", base(state="DEGRADED", broker="DISCONNECTED")),
    "S05_ap_unavailable_waiting_for_broker": ("json", base(state="WAIT_BROKER", broker="DISCONNECTED", device="UNKNOWN", uplink="UNKNOWN")),
    "S06_device_offline": ("json", base(state="DEGRADED", device="OFFLINE")),
    "S07_missing_status": ("missing", None),
    "S08_unreadable_status": ("unreadable", base()),
    "S09_malformed_json": ("text", "{not json"),
    "S10_oversized_status": ("oversized", base()),
    "S11_expired_timestamp": ("json", base(updated_at=NOW - 3600)),
    "S12_future_timestamp": ("json", base(updated_at=NOW + 3600)),
    "S13_contradictory_lockdown_with_normal_uplink": ("json", base(state="LOCKDOWN", uplink="NORMAL")),
    "S14_unsupported_vocabulary": ("json", base(broker="MAYBE")),
    "S15_production_profile_in_dry_run": ("json", base(dry_run=True)),
    "S16_missing_required_fields": ("json", {"state": "RUNNING", "updated_at": NOW - 5}),
    "S17_unknown_components": ("json", base(broker="UNKNOWN", device="UNKNOWN", uplink="UNKNOWN")),
}

# Where the Web is deliberately allowed to be MORE conservative than the Desktop reader, or merely different but never
# healthier. Any change to this set must be a conscious decision.
KNOWN_DIVERGENCES = {
    "S13_contradictory_lockdown_with_normal_uplink": "Desktop rejects the document as CONTRADICTORY (UNKNOWN); the Web adapter projects the Core LOCKDOWN state as DEGRADED. Never HEALTHY on either side, and the Core itself never emits it; the status projection publisher refuses to publish it.",
    "S14_unsupported_vocabulary": "Overall status is UNKNOWN on both sides, but the Web keeps the individually valid components while the Desktop rejects the whole document.",
    "S15_production_profile_in_dry_run": "Overall status is UNKNOWN on both sides, but the Web keeps the individually valid components while the Desktop rejects the whole document.",
}


def materialize(tmp_path, name, kind, payload):
    path = tmp_path / f"{name}.json"
    if kind == "json":
        path.write_text(json.dumps(payload), encoding="utf-8")
    elif kind == "text":
        path.write_text(payload, encoding="utf-8")
    elif kind == "oversized":
        path.write_text(json.dumps({**payload, "pad": "x" * (128 * 1024)}), encoding="utf-8")
    elif kind == "unreadable":
        path.write_text(json.dumps(payload), encoding="utf-8")
        path.chmod(0)
    return path


def compute(tmp_path):
    rows = {}
    for name, (kind, payload) in SCENARIOS.items():
        path = materialize(tmp_path, name, kind, payload)
        try:
            desktop = observer.read_observer_status(path, now=NOW)
            web = local_status_bridge.projection_for(path)
        finally:
            if path.exists() and kind == "unreadable":
                path.chmod(0o600)
        rows[name] = {
            "desktop": {
                "usable": desktop.valid, "freshness": desktop.freshness, "runtime_state": desktop.runtime_state,
                "broker": desktop.broker, "device": desktop.device, "uplink": desktop.uplink,
            },
            "web_input": web,
        }
    return {"now": NOW, "divergences": sorted(KNOWN_DIVERGENCES), "scenarios": rows}


@pytest.mark.skipif(os.geteuid() == 0, reason="root bypasses file permissions")
def test_matrix_fixture_matches_what_the_python_side_computes(tmp_path):
    assert json.loads(MATRIX.read_text(encoding="utf-8")) == compute(tmp_path)


@pytest.mark.skipif(os.geteuid() == 0, reason="root bypasses file permissions")
def test_desktop_semantics_for_the_required_scenarios(tmp_path):
    rows = compute(tmp_path)["scenarios"]
    desktop = {name: row["desktop"] for name, row in rows.items()}
    assert desktop["S01_fresh_running_healthy_uplink_normal"]["usable"] is True
    assert desktop["S02_lockdown_state_uplink_lockdown"] | {"usable": True} == desktop["S02_lockdown_state_uplink_lockdown"]
    assert desktop["S03_running_with_uplink_lockdown"]["uplink"] == "LOCKDOWN"
    assert desktop["S04_broker_disconnected"]["broker"] == "DISCONNECTED"
    assert desktop["S05_ap_unavailable_waiting_for_broker"]["runtime_state"] == "WAIT_BROKER"
    assert desktop["S06_device_offline"]["device"] == "OFFLINE"
    assert desktop["S07_missing_status"]["freshness"] == "MISSING"
    assert desktop["S08_unreadable_status"]["freshness"] == "UNAVAILABLE"
    assert desktop["S09_malformed_json"]["freshness"] == "INVALID"
    assert desktop["S10_oversized_status"]["freshness"] == "INVALID"
    assert desktop["S11_expired_timestamp"]["freshness"] == "STALE"
    assert desktop["S12_future_timestamp"]["freshness"] == "INVALID"
    assert desktop["S13_contradictory_lockdown_with_normal_uplink"]["freshness"] == "CONTRADICTORY"
    assert desktop["S14_unsupported_vocabulary"]["freshness"] == "INVALID"
    for name, row in desktop.items():
        if not row["usable"]:
            assert (row["runtime_state"], row["broker"], row["device"], row["uplink"]) == ("UNKNOWN",) * 4, name


@pytest.mark.skipif(os.geteuid() == 0, reason="root bypasses file permissions")
def test_unusable_evidence_never_leaks_into_the_web_input_as_physical_or_healthy_claims(tmp_path):
    rows = compute(tmp_path)["scenarios"]
    for name in ("S07_missing_status", "S08_unreadable_status", "S09_malformed_json", "S10_oversized_status"):
        web = rows[name]["web_input"]
        assert web["status"] == "UNKNOWN" and web["generatedAt"] is None and web["evidenceSource"] == "RUNTIME_STATUS_ABSENT", name
    for row in rows.values():
        text = json.dumps(row["web_input"]).lower()
        for inferred in ("relay", "heartbeat", '"ack'):
            assert inferred not in text


def test_every_status_reader_path_is_free_of_privileged_subprocesses(monkeypatch, tmp_path):
    def spawn(*_a, **_k):
        raise AssertionError("no subprocess is allowed on the status path")

    for name in ("run", "Popen", "call", "check_call", "check_output"):
        monkeypatch.setattr(subprocess, name, spawn)
    monkeypatch.setattr(os, "system", spawn)
    path = tmp_path / "status.json"
    path.write_text(json.dumps(base()), encoding="utf-8")
    assert observer.read_observer_status(path, now=NOW).valid is True
    assert local_status_bridge.projection_for(path)["status"] == "HEALTHY"
    assert observer.read_observer_status(tmp_path / "missing.json", now=NOW).valid is False
