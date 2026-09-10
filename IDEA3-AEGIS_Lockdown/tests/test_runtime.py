"""Autonomous runtime state, preflight, locking, and shutdown safety tests."""

import json
from dataclasses import replace

import pytest

from aegis_soc import config
from aegis_soc.runtime import (
    RuntimeSettings,
    RuntimeState,
    RuntimeStatus,
    platform_capabilities,
    read_status,
    safe_status_projection,
)
from aegis_soc.supervisor import (
    AegisSupervisor,
    AlreadyRunningError,
    ChildProcessSupervisor,
    InstanceLock,
    ManagedProcess,
)


class FakeMQTT:
    def __init__(self):
        self.is_connected = False
        self.online = False
        self.published = []
        self.stopped = False

    def publish(self, topic, payload):
        self.published.append((topic, payload))
        return self.is_connected

    def device_online(self):
        return self.online

    def stop(self):
        self.stopped = True


def _settings(tmp_path, **changes):
    base = RuntimeSettings.from_profile(
        "development",
        dry_run=True,
        start_detector=False,
        start_gui=False,
    )
    return replace(base, runtime_dir=tmp_path / "runtime", log_dir=tmp_path / "logs", **changes)


def test_development_profile_defaults_to_safe_dry_run(monkeypatch):
    monkeypatch.delenv("AEGIS_DRY_RUN", raising=False)
    settings = RuntimeSettings.from_profile("development")
    assert settings.dry_run is True
    assert settings.start_detector is False
    assert settings.start_gui is False


def test_production_preflight_rejects_demo_credentials(tmp_path, monkeypatch):
    settings = replace(_settings(tmp_path), profile="production", dry_run=False)
    monkeypatch.setattr(config, "SECRET_KEY", config.DEMO_SECRET)
    monkeypatch.setattr(config, "ADMIN_PIN_HASH", config.hashlib.sha256(b"1234").hexdigest())

    errors, _ = settings.preflight()

    assert any("non-demo HMAC" in error for error in errors)
    assert any("non-default Admin PIN" in error for error in errors)


def test_windows_capabilities_do_not_claim_linux_components():
    assert platform_capabilities("win32") == {
        "detector": False,
        "operator_gui": False,
        "voice": False,
    }


def test_windows_preflight_rejects_requested_linux_only_components(tmp_path):
    settings = replace(
        _settings(tmp_path),
        start_detector=True,
        start_gui=True,
    )

    errors, _ = settings.preflight(platform="win32")

    assert "detector is unavailable on Windows" in errors
    assert "Tk operator GUI is not packaged on Windows" in errors


def test_dry_run_preflight_accepts_an_explicitly_unconfigured_broker(tmp_path, monkeypatch):
    settings = _settings(tmp_path, dry_run=True)
    monkeypatch.setattr(config, "BROKER_CONFIGURED", False, raising=False)
    monkeypatch.setattr(config, "BROKER_IP", "")

    errors, warnings = settings.preflight(platform="win32")

    assert errors == []
    assert any("broker is not configured" in warning.lower() for warning in warnings)


def test_live_preflight_fails_closed_when_broker_is_unconfigured(tmp_path, monkeypatch):
    settings = _settings(tmp_path, dry_run=False)
    monkeypatch.setattr(config, "BROKER_CONFIGURED", False, raising=False)
    monkeypatch.setattr(config, "BROKER_IP", "")

    errors, _ = settings.preflight(platform="win32")

    assert "live mode requires a configured MQTT broker" in errors


def test_status_write_is_atomic_and_readable(tmp_path):
    path = tmp_path / "runtime" / "status.json"
    status = RuntimeStatus(state=RuntimeState.DEGRADED, detail="device unknown")
    status.write(path)
    loaded = read_status(path)
    assert loaded["state"] == "DEGRADED"
    assert loaded["detail"] == "device unknown"
    assert list(path.parent.glob("*.tmp")) == []


def test_single_instance_lock_rejects_duplicate(tmp_path):
    settings = _settings(tmp_path)
    first = InstanceLock(settings)
    second = InstanceLock(settings)
    first.acquire()
    try:
        with pytest.raises(AlreadyRunningError):
            second.acquire()
    finally:
        first.release()


def test_supervisor_state_transitions_never_assume_device_normal(tmp_path):
    mqtt = FakeMQTT()
    settings = replace(_settings(tmp_path), dry_run=False, broker_wait_sec=2, device_wait_sec=3)
    supervisor = AegisSupervisor(settings, mqtt_manager=mqtt, monotonic=lambda: 0)

    assert supervisor.evaluate_state(now=1) == RuntimeState.WAIT_BROKER
    assert supervisor.evaluate_state(now=4) == RuntimeState.DEGRADED
    mqtt.is_connected = True
    assert supervisor.evaluate_state(now=2) == RuntimeState.WAIT_DEVICE
    assert supervisor.evaluate_state(now=4) == RuntimeState.DEGRADED
    mqtt.online = True
    assert supervisor.evaluate_state(now=4) == RuntimeState.DEGRADED
    supervisor.status.uplink = "NORMAL"
    assert supervisor.evaluate_state(now=4) == RuntimeState.RUNNING
    supervisor.status.uplink = "LOCKDOWN"
    assert supervisor.evaluate_state(now=4) == RuntimeState.LOCKDOWN


def test_dry_run_auto_containment_does_not_publish(tmp_path):
    mqtt = FakeMQTT()
    settings = replace(_settings(tmp_path), auto_contain=True)
    supervisor = AegisSupervisor(settings, mqtt_manager=mqtt)
    supervisor._on_attacker("203.0.113.50")
    assert mqtt.published == []


def test_live_auto_containment_ack_timeout_degrades_runtime(tmp_path):
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True
    settings = replace(_settings(tmp_path), dry_run=False, auto_contain=True)
    supervisor = AegisSupervisor(settings, mqtt_manager=mqtt, monotonic=lambda: 0)
    supervisor.status.uplink = "NORMAL"

    supervisor._on_attacker("203.0.113.51")

    assert len(mqtt.published) == 1
    assert supervisor.pending_command["action"] == "CUT_UPLINK"
    assert supervisor.evaluate_state(now=config.ACK_TIMEOUT_SEC + 1) == RuntimeState.DEGRADED
    assert supervisor.pending_command is None


def test_shutdown_path_contains_no_restore_command(tmp_path):
    mqtt = FakeMQTT()
    settings = _settings(tmp_path)
    supervisor = AegisSupervisor(settings, mqtt_manager=mqtt)
    supervisor._request_stop()
    assert supervisor.evaluate_state() == RuntimeState.SHUTDOWN
    assert all("RESTORE_UPLINK" not in json.dumps(item) for item in mqtt.published)


def test_component_crash_loop_is_bounded(tmp_path):
    created = []

    class FakeProcess:
        def __init__(self):
            self.pid = 1000 + len(created)
            self.returncode = None

        def poll(self):
            return self.returncode

    def fake_popen(*args, **kwargs):
        process = FakeProcess()
        created.append(process)
        return process

    settings = replace(_settings(tmp_path), max_restarts=1, restart_window_sec=60)
    children = ChildProcessSupervisor(settings, lambda *args, **kwargs: None, popen_factory=fake_popen)
    component = ManagedProcess("fake", ["fake-component"], {})
    children.components["fake"] = component
    children._start(component)

    created[0].returncode = 1
    assert children.poll(now=0)["fake"] == "RESTARTING"
    assert children.poll(now=1)["fake"] == "RUNNING"
    created[1].returncode = 1
    assert children.poll(now=2)["fake"] == "FAILED"
    assert len(created) == 2
    children.stop_all()


def test_supervisor_operational_mode_defaults_to_armed(tmp_path):
    """Operational ARMED/DISARMED state is independent from auto-containment policy."""
    mqtt = FakeMQTT()
    settings = replace(_settings(tmp_path), auto_contain=False)

    supervisor = AegisSupervisor(settings, mqtt_manager=mqtt)

    assert supervisor.status.armed == "ARMED"
    assert supervisor.status.auto_contain is False


def test_disarmed_supervisor_blocks_automatic_containment(tmp_path):
    """DISARMED is a hard safety gate even when automatic containment is enabled."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(
        _settings(tmp_path),
        dry_run=False,
        auto_contain=True,
    )
    supervisor = AegisSupervisor(settings, mqtt_manager=mqtt)
    supervisor.set_armed(False, origin="test")

    supervisor._on_attacker("203.0.113.60")

    assert mqtt.published == []
    assert supervisor.pending_command is None


def test_supervisor_set_armed_changes_operational_mode(tmp_path):
    """Core owns ARMED/DISARMED transitions instead of callers mutating status directly."""
    mqtt = FakeMQTT()
    supervisor = AegisSupervisor(_settings(tmp_path), mqtt_manager=mqtt)

    supervisor.set_armed(False, origin="test")

    assert supervisor.status.armed == "DISARMED"

    supervisor.set_armed(True, origin="test")

    assert supervisor.status.armed == "ARMED"


def test_set_armed_persists_operational_mode(tmp_path):
    """Operational mode changes are immediately visible through runtime status."""
    mqtt = FakeMQTT()
    supervisor = AegisSupervisor(_settings(tmp_path), mqtt_manager=mqtt)

    supervisor.set_armed(False, origin="test")

    persisted = read_status(supervisor.settings.status_path)

    assert persisted is not None
    assert persisted["armed"] == "DISARMED"


def test_set_armed_audits_origin_and_mode_change(tmp_path):
    """Operational mode transitions record who requested the change."""
    mqtt = FakeMQTT()
    supervisor = AegisSupervisor(_settings(tmp_path), mqtt_manager=mqtt)

    supervisor.set_armed(False, origin="desktop-gui")

    event_path = supervisor.settings.log_dir / "aegis-events.jsonl"
    events = [
        json.loads(line)
        for line in event_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    mode_events = [
        event
        for event in events
        if event["event"] == "operational_mode_changed"
    ]

    assert len(mode_events) == 1
    assert mode_events[0]["detail"]["previous"] == "ARMED"
    assert mode_events[0]["detail"]["current"] == "DISARMED"
    assert mode_events[0]["detail"]["origin"] == "desktop-gui"


def test_supervisor_issue_command_owns_pending_command(tmp_path):
    """Core owns command publication and pending-ACK tracking."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 42.0,
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "manual containment test",
        critical=True,
        origin="test",
    )

    assert result.ok is True
    assert result.sent is True
    assert len(mqtt.published) == 1

    assert supervisor.pending_command is not None
    assert supervisor.pending_command["action"] == "CUT_UPLINK"
    assert supervisor.pending_command["sent_at"] == 42.0
    assert supervisor.pending_command["nonce"] == result.nonce
    assert supervisor.ack_timed_out is False


def test_auto_containment_pending_tracks_command_nonce(tmp_path):
    """Automatic containment uses the same Core command lifecycle as manual commands."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(
        _settings(tmp_path),
        dry_run=False,
        auto_contain=True,
    )
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 55.0,
    )

    supervisor._on_attacker("203.0.113.61")

    assert len(mqtt.published) == 1

    _, payload = mqtt.published[0]
    published = json.loads(payload)

    assert supervisor.pending_command is not None
    assert supervisor.pending_command["action"] == "CUT_UPLINK"
    assert supervisor.pending_command["sent_at"] == 55.0
    assert supervisor.pending_command["nonce"] == published["nonce"]


def test_supervisor_ignores_ack_with_mismatched_nonce(tmp_path):
    """An ACK for another command must not clear the current pending command."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "nonce correlation test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert supervisor.pending_command is not None

    pending_before = dict(supervisor.pending_command)

    supervisor._on_ack(
        "OK",
        "late ACK from another command",
        "wrong-nonce",
    )

    assert supervisor.pending_command == pending_before
    assert supervisor.ack_timed_out is False


def test_gui_ignores_ack_with_mismatched_nonce():
    """Legacy Desktop GUI must not clear pending state for another command's ACK."""
    from aegis_soc.gui import AegisAdminGUI

    gui = AegisAdminGUI.__new__(AegisAdminGUI)
    gui.pending_cmd = {
        "action": "CUT_UPLINK",
        "ts": 100.0,
        "nonce": "expected-nonce",
    }
    gui.log_message = lambda *args, **kwargs: None

    pending_before = dict(gui.pending_cmd)

    gui.on_ack(
        "OK",
        "late ACK from another command",
        "wrong-nonce",
    )

    assert gui.pending_cmd == pending_before


def test_supervisor_accepts_ack_with_matching_nonce(tmp_path):
    """Core accepts an ACK only when it matches the pending command nonce."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "matching nonce test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert result.nonce is not None
    assert supervisor.pending_command is not None

    supervisor._on_ack(
        "OK",
        "uplink cut",
        result.nonce,
    )

    assert supervisor.pending_command is None
    assert supervisor.ack_timed_out is False


def test_gui_accepts_ack_with_matching_nonce():
    """Legacy Desktop GUI clears pending state for the matching ACK."""
    from aegis_soc.gui import AegisAdminGUI

    gui = AegisAdminGUI.__new__(AegisAdminGUI)
    gui.pending_cmd = {
        "action": "CUT_UPLINK",
        "ts": 100.0,
        "nonce": "expected-nonce",
    }
    gui.log_message = lambda *args, **kwargs: None

    gui.on_ack(
        "OK",
        "uplink cut",
        "expected-nonce",
    )

    assert gui.pending_cmd is None


def test_matching_ack_moves_command_to_physical_confirmation(tmp_path):
    """ACK confirms command handling, not the resulting physical uplink state."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "physical confirmation lifecycle test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert result.nonce is not None
    assert supervisor.pending_command is not None

    supervisor._on_ack(
        "OK",
        "uplink cut",
        result.nonce,
    )

    # ACK tracking is complete...
    assert supervisor.pending_command is None

    # ...but physical isolation is still awaiting STATUS evidence.
    assert supervisor.awaiting_physical_confirmation is not None
    assert supervisor.awaiting_physical_confirmation["action"] == "CUT_UPLINK"
    assert supervisor.awaiting_physical_confirmation["nonce"] == result.nonce


def test_physical_status_before_ack_is_retained(tmp_path):
    """Physical evidence may arrive before ACK and must not destroy ACK tracking."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "status-before-ack race test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert result.nonce is not None
    assert supervisor.pending_command is not None

    # Firmware may publish LOCKDOWN before it publishes the ACK.
    supervisor._on_status(
        "LOCKDOWN",
        -48,
        200000,
        result.nonce,
    )

    # Physical evidence must NOT complete the ACK track.
    assert supervisor.pending_command is not None
    assert supervisor.pending_command["nonce"] == result.nonce

    # The physical evidence must still be retained for this command.
    assert supervisor.awaiting_physical_confirmation is not None
    assert supervisor.awaiting_physical_confirmation["action"] == "CUT_UPLINK"
    assert supervisor.awaiting_physical_confirmation["nonce"] == result.nonce
    assert supervisor.awaiting_physical_confirmation["expected_state"] == "LOCKDOWN"
    assert supervisor.awaiting_physical_confirmation["observed_state"] == "LOCKDOWN"
    assert (
        supervisor.awaiting_physical_confirmation["physical_confirmed_at"]
        == 100.0
    )


def test_status_before_ack_survives_matching_ack(tmp_path):
    """ACK must merge into existing physical evidence instead of replacing it."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "order-independent lifecycle test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert result.nonce is not None

    # Physical evidence arrives first.
    supervisor._on_status(
        "LOCKDOWN",
        -48,
        200000,
        result.nonce,
    )

    physical_before_ack = supervisor.awaiting_physical_confirmation
    assert physical_before_ack is not None
    assert physical_before_ack["observed_state"] == "LOCKDOWN"
    assert physical_before_ack["physical_confirmed_at"] == 100.0

    # Matching ACK arrives afterward.
    supervisor._on_ack(
        "OK",
        "uplink cut",
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation
    assert physical is not None
    assert physical["action"] == "CUT_UPLINK"
    assert physical["nonce"] == result.nonce
    assert physical["expected_state"] == "LOCKDOWN"

    # Evidence from the earlier STATUS must survive.
    assert physical["observed_state"] == "LOCKDOWN"
    assert physical["physical_confirmed_at"] == 100.0

    # ACK evidence must be merged into the same lifecycle.
    assert physical["acknowledged_at"] == 100.0
    assert supervisor.pending_command is None


def test_wrong_physical_state_does_not_confirm_cut(tmp_path):
    """NORMAL status must not physically confirm a pending CUT_UPLINK."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "wrong physical state test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert result.nonce is not None

    physical = supervisor.awaiting_physical_confirmation
    assert physical is not None
    assert physical["expected_state"] == "LOCKDOWN"

    # Device reports the opposite physical state.
    supervisor._on_status(
        "NORMAL",
        -48,
        200000,
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation
    assert physical is not None

    # Record what was observed, but do not falsely confirm the CUT.
    assert physical["observed_state"] == "NORMAL"
    assert physical["physical_confirmed_at"] is None

    # ACK tracking remains independent.
    assert supervisor.pending_command is not None
    assert supervisor.pending_command["nonce"] == result.nonce


def test_restore_requires_normal_physical_confirmation(tmp_path):
    """RESTORE_UPLINK is physically confirmed only by NORMAL status."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    result = supervisor.issue_command(
        "RESTORE_UPLINK",
        "restore physical confirmation test",
        critical=True,
        origin="test",
        authorize_restore=True,
    )

    assert result.sent is True
    assert result.nonce is not None

    physical = supervisor.awaiting_physical_confirmation
    assert physical is not None
    assert physical["action"] == "RESTORE_UPLINK"
    assert physical["expected_state"] == "NORMAL"

    # Opposite state must not confirm recovery.
    supervisor._on_status(
        "LOCKDOWN",
        -48,
        200000,
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation
    assert physical["observed_state"] == "LOCKDOWN"
    assert physical["physical_confirmed_at"] is None

    # Expected state confirms the physical recovery.
    supervisor._on_status(
        "NORMAL",
        -47,
        199000,
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation
    assert physical["observed_state"] == "NORMAL"
    assert physical["physical_confirmed_at"] == 100.0

    # Physical evidence still must not erase ACK tracking.
    assert supervisor.pending_command is not None
    assert supervisor.pending_command["nonce"] == result.nonce


def test_restore_status_before_ack_preserves_both_evidence(tmp_path):
    """RESTORE remains order-independent when NORMAL status arrives before ACK."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 200.0,
    )

    result = supervisor.issue_command(
        "RESTORE_UPLINK",
        "restore order-independent test",
        critical=True,
        origin="test",
        authorize_restore=True,
    )

    assert result.sent is True
    assert result.nonce is not None

    # Physical NORMAL arrives first.
    supervisor._on_status(
        "NORMAL",
        -45,
        198000,
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation
    assert physical is not None
    assert physical["physical_confirmed_at"] == 200.0
    assert supervisor.pending_command is not None

    # Matching ACK arrives later.
    supervisor._on_ack(
        "OK",
        "uplink restored",
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation
    assert physical is not None
    assert physical["action"] == "RESTORE_UPLINK"
    assert physical["expected_state"] == "NORMAL"
    assert physical["observed_state"] == "NORMAL"
    assert physical["physical_confirmed_at"] == 200.0
    assert physical["acknowledged_at"] == 200.0
    assert supervisor.pending_command is None


def test_acked_cut_without_physical_lockdown_degrades_after_timeout(tmp_path):
    """ACK success must not hide a missing physical LOCKDOWN confirmation."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    clock = {"now": 0.0}

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: clock["now"],
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "physical confirmation timeout test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert result.nonce is not None

    # Command ACK succeeds.
    supervisor._on_ack(
        "OK",
        "uplink cut",
        result.nonce,
    )

    assert supervisor.pending_command is None
    assert supervisor.ack_timed_out is False

    # But the device still reports NORMAL instead of the expected LOCKDOWN.
    supervisor._on_status(
        "NORMAL",
        -48,
        200000,
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation
    assert physical is not None
    assert physical["acknowledged_at"] == 0.0
    assert physical["expected_state"] == "LOCKDOWN"
    assert physical["observed_state"] == "NORMAL"
    assert physical["physical_confirmed_at"] is None

    # Initial physical-confirmation timeout policy is 8 seconds.
    clock["now"] = 9.0

    state = supervisor.evaluate_state(now=clock["now"])

    assert state == RuntimeState.DEGRADED
    assert supervisor.ack_timed_out is False

    physical = supervisor.awaiting_physical_confirmation
    assert physical["physical_confirmed_at"] is None
    assert physical["physical_timeout_at"] == 9.0


def test_restore_physical_timeout_preserves_lockdown_runtime(tmp_path):
    """Failed physical RESTORE remains LOCKDOWN even after confirmation timeout."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    clock = {"now": 0.0}

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: clock["now"],
    )

    result = supervisor.issue_command(
        "RESTORE_UPLINK",
        "restore physical timeout precedence test",
        critical=True,
        origin="test",
        authorize_restore=True,
    )

    assert result.sent is True
    assert result.nonce is not None

    # Command transport succeeds.
    supervisor._on_ack(
        "OK",
        "uplink restored",
        result.nonce,
    )

    assert supervisor.pending_command is None
    assert supervisor.ack_timed_out is False

    # Physical device contradicts the RESTORE command.
    supervisor._on_status(
        "LOCKDOWN",
        -48,
        200000,
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation
    assert physical is not None
    assert physical["expected_state"] == "NORMAL"
    assert physical["observed_state"] == "LOCKDOWN"
    assert physical["physical_confirmed_at"] is None

    # Confirmation window expires.
    clock["now"] = config.PHYSICAL_CONFIRM_TIMEOUT_SEC + 1

    state = supervisor.evaluate_state(now=clock["now"])

    # Record command-lifecycle failure...
    assert physical["physical_timeout_at"] == clock["now"]
    assert physical["physical_confirmed_at"] is None
    assert supervisor.ack_timed_out is False

    # ...but never hide the physical truth.
    assert supervisor.status.uplink == "LOCKDOWN"
    assert state == RuntimeState.LOCKDOWN


def test_late_physical_confirmation_recovers_after_timeout(tmp_path):
    """Late expected STATUS is accepted while preserving timeout history."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    clock = {"now": 0.0}

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: clock["now"],
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "late physical confirmation test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert result.nonce is not None

    # Transport-level success arrives first.
    supervisor._on_ack(
        "OK",
        "uplink cut",
        result.nonce,
    )

    # Device still reports the wrong physical state.
    supervisor._on_status(
        "NORMAL",
        -48,
        200000,
        result.nonce,
    )

    # Physical-confirmation deadline expires.
    clock["now"] = config.PHYSICAL_CONFIRM_TIMEOUT_SEC + 1

    state = supervisor.evaluate_state(now=clock["now"])

    physical = supervisor.awaiting_physical_confirmation
    assert physical is not None
    assert state == RuntimeState.DEGRADED
    assert physical["physical_timeout_at"] == clock["now"]
    assert physical["physical_confirmed_at"] is None
    assert supervisor.ack_timed_out is False

    timeout_at = physical["physical_timeout_at"]

    # Expected physical evidence eventually arrives later.
    clock["now"] += 3
    supervisor._on_status(
        "LOCKDOWN",
        -47,
        199000,
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation

    # Preserve the fact that the command was late...
    assert physical["physical_timeout_at"] == timeout_at

    # ...but accept the newer physical truth.
    assert physical["observed_state"] == "LOCKDOWN"
    assert physical["physical_confirmed_at"] == clock["now"]

    state = supervisor.evaluate_state(now=clock["now"])

    # Physical truth takes precedence now that confirmation exists.
    assert supervisor.status.uplink == "LOCKDOWN"
    assert state == RuntimeState.LOCKDOWN
    assert supervisor.ack_timed_out is False



def test_missing_status_command_nonce_does_not_confirm_active_cut(tmp_path):
    """Uncorrelated STATUS updates physical truth but cannot confirm a command."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "missing status nonce test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert result.nonce is not None

    physical_before = dict(supervisor.awaiting_physical_confirmation)

    supervisor._on_status(
        "LOCKDOWN",
        -48,
        200000,
        "",
    )

    physical = supervisor.awaiting_physical_confirmation

    assert supervisor.status.uplink == "LOCKDOWN"
    assert physical == physical_before
    assert physical["physical_confirmed_at"] is None


def test_mismatched_status_command_nonce_does_not_confirm_active_cut(tmp_path):
    """STATUS for another command cannot confirm the active command."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "mismatched status nonce test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert result.nonce is not None

    physical_before = dict(supervisor.awaiting_physical_confirmation)

    supervisor._on_status(
        "LOCKDOWN",
        -48,
        200000,
        "another-command-nonce",
    )

    assert supervisor.status.uplink == "LOCKDOWN"
    assert supervisor.awaiting_physical_confirmation == physical_before
    assert (
        supervisor.awaiting_physical_confirmation["physical_confirmed_at"]
        is None
    )



def test_matching_status_command_nonce_confirms_cut(tmp_path):
    """Matching command nonce allows LOCKDOWN STATUS to confirm CUT."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    result = supervisor.issue_command(
        "CUT_UPLINK",
        "matching cut status nonce test",
        critical=True,
        origin="test",
    )

    assert result.sent is True
    assert result.nonce is not None

    supervisor._on_status(
        "LOCKDOWN",
        -48,
        200000,
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation

    assert physical is not None
    assert supervisor.status.uplink == "LOCKDOWN"
    assert physical["nonce"] == result.nonce
    assert physical["observed_state"] == "LOCKDOWN"
    assert physical["physical_confirmed_at"] == 100.0


def test_matching_status_command_nonce_confirms_restore(tmp_path):
    """Matching command nonce allows NORMAL STATUS to confirm RESTORE."""
    mqtt = FakeMQTT()
    mqtt.is_connected = True
    mqtt.online = True

    settings = replace(_settings(tmp_path), dry_run=False)
    supervisor = AegisSupervisor(
        settings,
        mqtt_manager=mqtt,
        monotonic=lambda: 100.0,
    )

    # Model the physical truth before a recovery command.
    supervisor.status.uplink = "LOCKDOWN"

    result = supervisor.issue_command(
        "RESTORE_UPLINK",
        "matching restore status nonce test",
        critical=True,
        origin="test",
        authorize_restore=True,
    )

    assert result.sent is True
    assert result.nonce is not None

    supervisor._on_status(
        "NORMAL",
        -47,
        199000,
        result.nonce,
    )

    physical = supervisor.awaiting_physical_confirmation

    assert physical is not None
    assert supervisor.status.uplink == "NORMAL"
    assert physical["nonce"] == result.nonce
    assert physical["observed_state"] == "NORMAL"
    assert physical["physical_confirmed_at"] == 100.0


class TestSafeRuntimeProjection:
    """The exported runtime status must stay a safe, versioned projection."""

    def _status(self, **changes):
        base = RuntimeStatus(
            state=RuntimeState.RUNNING,
            profile="production",
            dry_run=False,
            auto_contain=True,
            broker="CONNECTED",
            device="ONLINE",
            uplink="NORMAL",
            armed="ARMED",
            detail="broker 192.168.2.174 ready; secret /etc/aegis/hmac.key loaded",
            updated_at=1_788_000_000.0,
            components={"detector": "RUNNING", "gui": "RUNNING"},
        )
        return replace(base, **changes)

    def test_exports_the_versioned_safe_contract(self):
        projection = safe_status_projection(self._status())

        assert projection == {
            "schemaVersion": 1,
            "generatedAt": "2026-08-29T10:40:00.000Z",
            "status": "HEALTHY",
            "components": {
                "broker": "CONNECTED",
                "device": "ONLINE",
                "uplink": "NORMAL",
                "detector": "RUNNING",
                "gui": "RUNNING",
            },
            "modes": {
                "profile": "production",
                "dryRun": False,
                "autoContain": True,
                "armed": "ARMED",
            },
            "issues": [],
            "evidenceSource": "RUNTIME_STATUS_FILE",
        }

    def test_never_exports_secret_config_or_free_text_values(self):
        projection = safe_status_projection(self._status())
        rendered = json.dumps(projection)

        for leaked in ("192.168.2.174", "hmac.key", "/etc/aegis", "detail", "pid"):
            assert leaked not in rendered
        assert "detail" not in projection
        assert "pid" not in projection

    @pytest.mark.parametrize(
        ("state", "expected"),
        [
            (RuntimeState.RUNNING, "HEALTHY"),
            (RuntimeState.DEGRADED, "DEGRADED"),
            (RuntimeState.LOCKDOWN, "DEGRADED"),
            (RuntimeState.FAILED, "FAILED"),
            (RuntimeState.SHUTDOWN, "FAILED"),
            (RuntimeState.INIT, "UNKNOWN"),
            (RuntimeState.PREFLIGHT, "UNKNOWN"),
            (RuntimeState.WAIT_BROKER, "UNKNOWN"),
            (RuntimeState.WAIT_DEVICE, "UNKNOWN"),
        ],
    )
    def test_maps_every_runtime_state_to_a_canonical_status(self, state, expected):
        assert safe_status_projection(self._status(state=state))["status"] == expected

    def test_fails_closed_on_an_unrecognized_state_or_component(self):
        projection = safe_status_projection(
            self._status(state="TOTALLY_NEW_STATE", components={"detector": "WEIRD", "secret_loader": "RUNNING"})
        )

        assert projection["status"] == "UNKNOWN"
        assert projection["components"]["detector"] == "UNKNOWN"
        assert "secret_loader" not in projection["components"]

    def test_reports_allowlisted_issue_codes_for_unhealthy_evidence(self):
        projection = safe_status_projection(
            self._status(
                state=RuntimeState.DEGRADED,
                broker="DISCONNECTED",
                device="UNKNOWN",
                components={"detector": "FAILED"},
            )
        )

        assert projection["issues"] == [
            "COMPONENT_FAILURE",
            "ESP32_UNAVAILABLE",
            "MQTT_DISCONNECTED",
        ]

    def test_dry_run_without_device_evidence_is_not_healthy(self):
        projection = safe_status_projection(
            self._status(
                dry_run=True,
                broker="UNKNOWN",
                device="UNKNOWN",
                uplink="UNKNOWN",
                components={},
            )
        )

        assert projection["status"] == "UNKNOWN"
        assert projection["components"] == {
            "broker": "UNKNOWN",
            "device": "UNKNOWN",
            "uplink": "UNKNOWN",
        }

    @pytest.mark.parametrize(
        ("changes", "expected"),
        [
            ({"broker": "DISCONNECTED"}, "DEGRADED"),
            ({"device": "OFFLINE"}, "DEGRADED"),
            ({"device": "UNKNOWN"}, "UNKNOWN"),
            ({"uplink": "UNKNOWN"}, "UNKNOWN"),
            ({"components": {"detector": "FAILED"}}, "DEGRADED"),
        ],
    )
    def test_running_process_does_not_override_unhealthy_evidence(self, changes, expected):
        assert safe_status_projection(self._status(**changes))["status"] == expected

    def test_accepts_a_persisted_status_document_read_back_from_disk(self, tmp_path):
        path = tmp_path / "status.json"
        self._status().write(path)

        projection = safe_status_projection(read_status(path))

        assert projection["schemaVersion"] == 1
        assert projection["status"] == "HEALTHY"
        assert projection["evidenceSource"] == "RUNTIME_STATUS_FILE"

    @pytest.mark.parametrize("document", [None, {}, {"state": "RUNNING", "updated_at": "not-a-number"}])
    def test_fails_closed_on_missing_or_malformed_status_documents(self, document):
        projection = safe_status_projection(document)

        assert projection["status"] == "UNKNOWN"
        assert projection["generatedAt"] is None
        assert projection["evidenceSource"] == "RUNTIME_STATUS_ABSENT"
