"""TDD tests for detector-originated incident recording and R1 binding.

Proves that legitimate detector events create and bind the OPEN incident
context independently of containment policy (AUTO_CONTAIN=false/true, armed/disarmed).
"""

from __future__ import annotations

import tkinter as tk
from unittest.mock import MagicMock

import pytest

from aegis_soc import config, gui, recovery
from aegis_soc import database as db


@pytest.fixture
def tk_root():
    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"Tk display unavailable: {error}")
    root.withdraw()
    yield root
    # Cancel pending after calls
    for after_id in root.tk.call("after", "info"):
        try:
            root.after_cancel(after_id)
        except Exception:
            pass
    root.destroy()


@pytest.fixture
def test_app(tk_root, tmp_path, monkeypatch):
    """Instantiate a headless AegisAdminGUI backed by a disposable SQLite database."""
    test_db = str(tmp_path / "test_detector.db")
    monkeypatch.setattr(config, "DB_PATH", test_db)
    monkeypatch.setattr(db.config, "DB_PATH", test_db)
    db.init_db()

    # Disable background heartbeat and external subprocesses
    monkeypatch.setattr(gui.AegisAdminGUI, "_start_background_heartbeat", lambda self: None)
    monkeypatch.setattr(gui.AegisAdminGUI, "trigger_alarm", lambda self, *_args: None)

    fake_mqtt = MagicMock()
    fake_mqtt.last_attacker_ip = None
    fake_mqtt.publish = MagicMock()
    fake_mqtt.seconds_since_device = lambda: 5.0
    fake_mqtt.stop = lambda: None

    fake_controller = MagicMock()

    app = gui.AegisAdminGUI(tk_root, fake_mqtt, command_controller=fake_controller)
    app.send_command = MagicMock()
    app.run_ufw_async = MagicMock()
    return app


def test_auto_contain_false_creates_incident_and_no_cut(test_app, monkeypatch):
    """A. AUTO_CONTAIN=false + valid detector IP:

    - creates/binds one OPEN incident
    - incident attacker_ip equals detector IP
    - provenance/audit DETECTOR_ALERT is present
    - CUT_UPLINK not issued
    - UFW not invoked
    - MQTT publish not performed
    """
    monkeypatch.setattr(config, "AUTO_CONTAIN", False)
    test_app.armed = True
    test_ip = "198.51.100.55"

    test_app.on_attacker_detected(test_ip)

    open_inc = db.get_open_incident()
    assert open_inc is not None, "Expected an open incident to be created by on_attacker_detected"
    assert open_inc["state"] == "OPEN"
    assert open_inc["attacker_ip"] == test_ip

    # Verify audit provenance
    logs = db.fetch_all_logs()
    detector_logs = [l for l in logs if l[3] == "DETECTOR_ALERT"]
    assert len(detector_logs) >= 1
    assert test_ip in detector_logs[0][4]
    # If incident_id is associated:
    assert detector_logs[0][5] == open_inc["id"]

    # Verify NO actuation
    test_app.send_command.assert_not_called()
    test_app.run_ufw_async.assert_not_called()
    test_app.mqtt.publish.assert_not_called()


def test_repeated_detection_does_not_create_multiple_incidents(test_app, monkeypatch):
    """B. AUTO_CONTAIN=false repeated same detection:

    - does not create multiple concurrent incidents.
    """
    monkeypatch.setattr(config, "AUTO_CONTAIN", False)
    test_ip = "198.51.100.55"

    test_app.on_attacker_detected(test_ip)
    first_inc = db.get_open_incident()
    assert first_inc is not None

    # Repeated detection
    test_app.on_attacker_detected(test_ip)
    second_inc = db.get_open_incident()
    assert second_inc is not None
    assert second_inc["id"] == first_inc["id"]

    # Ensure total open incidents count remains 1
    all_incidents = db.fetch_incidents(limit=10)
    open_incidents = [i for i in all_incidents if i["state"] != "CLOSED"]
    assert len(open_incidents) == 1


def test_disarmed_records_incident_without_cut(test_app, monkeypatch):
    """C. DISARMED detector event:

    - incident is still recorded
    - no CUT is issued.
    """
    monkeypatch.setattr(config, "AUTO_CONTAIN", True)
    test_app.armed = False  # DISARMED
    test_ip = "198.51.100.66"

    test_app.on_attacker_detected(test_ip)

    open_inc = db.get_open_incident()
    assert open_inc is not None
    assert open_inc["attacker_ip"] == test_ip

    test_app.send_command.assert_not_called()
    test_app.run_ufw_async.assert_not_called()


def test_auto_contain_true_records_incident_and_issues_cut(test_app, monkeypatch):
    """D. AUTO_CONTAIN=true:

    - incident is recorded BEFORE/independently of actuation
    - existing actuation behavior (CUT_UPLINK) is preserved.
    """
    monkeypatch.setattr(config, "AUTO_CONTAIN", True)
    test_app.armed = True
    test_ip = "198.51.100.77"

    test_app.on_attacker_detected(test_ip)

    open_inc = db.get_open_incident()
    assert open_inc is not None
    assert open_inc["attacker_ip"] == test_ip

    # Actuation is issued
    test_app.send_command.assert_called_once()
    assert test_app.send_command.call_args[0][0] == "CUT_UPLINK"


def test_recovery_coordinator_r1_binds_detector_incident(test_app, monkeypatch):
    """E. RecoveryCoordinator.resolve_incident_context():

    - binds the resulting real incident
    - R1 becomes VERIFIED
    - attacker_ip and incident_id are preserved in evidence.
    """
    monkeypatch.setattr(config, "AUTO_CONTAIN", False)
    test_ip = "198.51.100.88"

    test_app.on_attacker_detected(test_ip)
    open_inc = db.get_open_incident()
    assert open_inc is not None

    coordinator = recovery.RecoveryCoordinator()
    evidence = coordinator.resolve_incident_context()

    assert evidence.status == recovery.GateStatus.VERIFIED
    assert coordinator.incident_id == open_inc["id"]
    assert f"incident #{open_inc['id']}" in evidence.summary
    assert f"attacker_ip={test_ip}" in evidence.detail


def test_invalid_source_input_rejected_safely(test_app, monkeypatch):
    """F. Invalid/unusable source input:

    - fail safely; do not create a bogus incident.
    """
    monkeypatch.setattr(config, "AUTO_CONTAIN", False)

    for bad_input in ["", "   ", "not-an-ip", "999.999.999.999", None, "::1"]:
        test_app.on_attacker_detected(bad_input)
        assert db.get_open_incident() is None, f"Expected no incident for invalid input: {bad_input!r}"
        test_app.send_command.assert_not_called()
