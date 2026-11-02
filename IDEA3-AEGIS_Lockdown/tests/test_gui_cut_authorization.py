"""Regression tests for unsafe legacy GUI CUT entry points.

All interactions are mocked. No MQTT, ESP32 or physical
relay command is sent by these tests.
"""

from types import SimpleNamespace

from aegis_soc import gui as gui_module
from aegis_soc.controller import AegisCommandController


def fake_gui():
    app = gui_module.AegisAdminGUI.__new__(
        gui_module.AegisAdminGUI
    )

    commands = []
    app.armed = True
    app.log_message = lambda *args, **kwargs: None

    def capture_command(action, *args, **kwargs):
        commands.append(action)

    app.send_command = capture_command

    return app, commands


def test_detector_event_does_not_cut_without_operator_confirmation(
    monkeypatch,
):
    app, commands = fake_gui()

    monkeypatch.setattr(
        gui_module.config,
        "AUTO_CONTAIN",
        True,
    )

    app._safe_open_incident = lambda: None
    app._refresh_notification_indicator = lambda: None
    app._show_security_toast = lambda ip: None

    app.notifications = SimpleNamespace(
        notify_attacker_detected=lambda *a, **k: None
    )

    app.mqtt = SimpleNamespace(
        last_attacker_ip=None
    )

    app.on_attacker_detected("198.51.100.10")

    assert "CUT_UPLINK" not in commands


def test_telegram_pin_alone_cannot_authorize_physical_cut(
    monkeypatch,
):
    app, commands = fake_gui()
    replies = []

    app._tg_check_pin = lambda parts: True

    monkeypatch.setattr(
        gui_module.comms,
        "send_telegram_reply",
        lambda message: replies.append(message),
    )

    app._process_tg_command("/cut test-only-pin")

    assert "CUT_UPLINK" not in commands

    assert not any(
        "ส่งคำสั่งตัด Uplink แล้ว" in message
        for message in replies
    )


def test_unauthorized_standalone_gui_controller_cannot_publish_cut(monkeypatch):
    published = []
    mqtt = SimpleNamespace(publish=lambda *args: published.append(args) or True)
    controller = AegisCommandController(
        mqtt,
        protocol_mode="legacy-v0-lab",
        cut_target_device="test-device-01",
        audit_log=lambda *_args: None,
    )
    app = gui_module.AegisAdminGUI.__new__(gui_module.AegisAdminGUI)
    app.controller = controller
    app.pending_cmd = None
    app.log_message = lambda *_args, **_kwargs: None
    monkeypatch.setattr(gui_module.messagebox, "showwarning", lambda *_args, **_kwargs: None)

    app.send_command("CUT_UPLINK", "standalone GUI must not be an authority", critical=True, origin="gui")

    assert published == []
    assert app.pending_cmd is None
