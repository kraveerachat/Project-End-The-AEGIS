"""Offline isolation tests for the existing dirty PYTHONUI Dashboard."""

from __future__ import annotations

import inspect
import os
import subprocess
import sys
import tkinter as tk

import pytest

from tools import preview_purple_desktop


def test_preview_module_has_no_operational_launcher_or_transport():
    source = inspect.getsource(preview_purple_desktop)
    for forbidden in (
        "MQTTManager(",
        "AegisCommandController(",
        "AegisSupervisor(",
        "TelegramListener(",
        "subprocess.",
        "serial.",
    ):
        assert forbidden not in source


def test_fake_control_boundaries_fail_closed():
    mqtt = preview_purple_desktop.PreviewMQTT()
    controller = preview_purple_desktop.PreviewController()
    with pytest.raises(AssertionError):
        mqtt.start()
    with pytest.raises(AssertionError):
        mqtt.connect()
    with pytest.raises(AssertionError):
        mqtt.publish("topic", "payload")
    with pytest.raises(AssertionError):
        controller.issue("CUT_UPLINK")
    assert mqtt.start_calls == 1
    assert mqtt.connect_calls == 1
    assert mqtt.publish_calls == 1
    assert controller.issue_calls == 1


def _submit_preview_login(app, admin_id=preview_purple_desktop.PREVIEW_ADMIN_ID, pin=preview_purple_desktop.PREVIEW_ADMIN_PIN):
    app.login_view.admin_entry.insert(0, admin_id)
    app.login_view.pin_entry.insert(0, pin)
    app.login_view._submit()


def test_missing_paho_subprocess_still_imports_real_gui():
    """Regression: isolation must precede gui.py's transitive paho import."""
    project_dir = os.path.dirname(os.path.dirname(__file__))
    script = (
        "import builtins,tempfile; from pathlib import Path; "
        "from tools import preview_purple_desktop as preview; "
        "real=builtins.__import__; "
        "builtins.__import__=lambda n,*a,**k: (_ for _ in ()).throw(ModuleNotFoundError('simulated missing paho-mqtt')) if n == 'paho' or n.startswith('paho.') else real(n,*a,**k); "
        "d=Path(tempfile.mkdtemp()); preview._prepare_environment(d); preview.sys.path.insert(0, preview.PYTHONUI_ROOT); preview._install_import_isolation(); "
        "from aegis_soc import gui; assert gui.MQTTManager is preview.PreviewMQTT; assert gui.AegisCommandController is preview.PreviewController; assert str(Path(gui.__file__).resolve()).startswith(preview.PYTHONUI_ROOT)"
    )
    env = os.environ.copy()
    env["PYTHONPATH"] = project_dir
    env["AEGIS_PYTHONUI_SOURCE"] = preview_purple_desktop.PYTHONUI_ROOT
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=project_dir,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr or result.stdout


@pytest.fixture
def preview_app(tmp_path):
    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"Tk display unavailable: {error}")
    root.withdraw()
    for name in list(sys.modules):
        if name == "aegis_soc" or name.startswith("aegis_soc."):
            del sys.modules[name]
    sys.path[:] = [entry for entry in sys.path if entry != preview_purple_desktop.PYTHONUI_ROOT]
    app, fakes = preview_purple_desktop.create_preview_app(root, data_dir=tmp_path)
    yield app, fakes
    for after_id in root.tk.splitlist(root.tk.call("after", "info")):
        root.after_cancel(after_id)
    root.destroy()
    for name in list(sys.modules):
        if name == "aegis_soc" or name.startswith("aegis_soc."):
            del sys.modules[name]
    sys.path[:] = [entry for entry in sys.path if entry != preview_purple_desktop.PYTHONUI_ROOT]


def test_preview_uses_dirty_pythonui_aegis_admin_gui_and_starts_no_control_plane(preview_app):
    app, fakes = preview_app
    from aegis_soc import gui

    _submit_preview_login(app)
    assert app.__class__.__mro__[1] is gui.AegisAdminGUI
    assert str(gui.__file__).startswith(preview_purple_desktop.PYTHONUI_ROOT)
    assert app._build_overview_page.__func__ is gui.AegisAdminGUI._build_overview_page
    assert app.active_page == "overview"
    assert set(app.metric_cards) == {"health", "uplink", "broker", "esp32", "mode", "deadman", "incidents", "today"}
    assert app.root.title() == preview_purple_desktop.PREVIEW_TITLE
    assert fakes.mqtt.start_calls == 0
    assert fakes.mqtt.connect_calls == 0
    assert fakes.mqtt.publish_calls == 0
    assert fakes.controller.issue_calls == 0
    assert fakes.heartbeat_workers == 0
    assert fakes.monitor_polls == 0

    for key, _label, _enabled in gui.NAV_ITEMS:
        app._show_page(key)
    assert app.active_page == "settings"


def test_preview_starts_at_real_login_and_rejects_invalid_credentials(preview_app):
    app, _fakes = preview_app
    from aegis_soc import gui

    assert isinstance(app.login_view, gui.LoginView)
    assert app.session.authenticated is False
    _submit_preview_login(app, admin_id="wrong", pin="wrong")
    assert app.session.authenticated is False
    assert app.login_view is not None


def test_preview_valid_login_and_logout_return_to_real_login(preview_app):
    app, _fakes = preview_app
    from aegis_soc import gui

    _submit_preview_login(app)
    assert app.session.authenticated is True
    assert app.login_view is None
    assert app._build_overview_page.__func__ is gui.AegisAdminGUI._build_overview_page
    app._logout()
    assert app.session.authenticated is False
    assert isinstance(app.login_view, gui.LoginView)
    assert app.login_view.admin_entry.get() == ""


def test_preview_disables_every_operational_button_and_fails_closed(preview_app):
    app, fakes = preview_app

    _submit_preview_login(app)
    app._show_page("lockdown")
    for button in (app.btn_cut, app.btn_restore, app.btn_arm, app.btn_recovery):
        assert button["state"] == "disabled"

    app.on_cut_clicked()
    app.on_restore_clicked()
    app.toggle_arm()
    app.open_recovery_wizard()
    app.send_command("CUT_UPLINK", "synthetic")
    app.run_ufw_async(["status"], lambda *_args: None)
    app.export_audit_log()
    app.verify_log_integrity()

    assert fakes.mqtt.publish_calls == 0
    assert fakes.controller.issue_calls == 0
    assert fakes.hardware_actions == 0


def test_demo_controller_requires_explicit_confirmation_and_sequence():
    from tools.demo_purple_desktop import DemoController

    controller = DemoController()
    assert controller.issue("CUT_UPLINK", critical=True).ok is False
    controller.raise_critical_alert("198.51.100.7")
    assert controller.issue("CUT_UPLINK", critical=True, confirmed=False).ok is False
    cut = controller.issue("CUT_UPLINK", critical=True, confirmed=True)
    assert cut.ok is True
    assert controller.uplink == "LOCKDOWN"


def test_demo_controller_enforces_recovery_approval():
    from tools.demo_purple_desktop import DemoController

    controller = DemoController()
    controller.raise_critical_alert("198.51.100.7")
    controller.issue("CUT_UPLINK", critical=True, confirmed=True)
    assert controller.issue("RESTORE_UPLINK", authorize_restore=True).ok is False
    controller.approve_recovery()
    restore = controller.issue("RESTORE_UPLINK", authorize_restore=True)
    assert restore.ok is True
    assert controller.uplink == "NORMAL"


def test_demo_controller_has_no_operational_transport_or_hardware_imports():
    source = inspect.getsource(__import__("tools.demo_purple_desktop", fromlist=["DemoController"]))
    for forbidden in ("MQTTManager(", "AegisCommandController(", "AegisSupervisor(", "TelegramListener(", "subprocess.", "serial.", "gpio", "mosquitto_pub"):
        assert forbidden not in source


def test_demo_real_dashboard_exercises_login_cut_restore_flow(tmp_path, monkeypatch):
    from tools import demo_purple_desktop

    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"Tk display unavailable: {error}")
    root.withdraw()
    for name in list(sys.modules):
        if name == "aegis_soc" or name.startswith("aegis_soc."):
            del sys.modules[name]
    sys.path[:] = [entry for entry in sys.path if entry != preview_purple_desktop.PYTHONUI_ROOT]
    try:
        app, fakes = demo_purple_desktop.create_demo_app(root, data_dir=tmp_path)
        _submit_preview_login(app)
        app._show_page("lockdown")
        assert app.root.title() == demo_purple_desktop.DEMO_TITLE
        assert app.request_cut(confirmed=False) is False
        app.simulate_critical_alert()
        monkeypatch.setattr(demo_purple_desktop.messagebox, "askyesno", lambda *_args, **_kwargs: False)
        app.on_cut_clicked()
        assert fakes.controller.uplink == "NORMAL"
        monkeypatch.setattr(demo_purple_desktop.messagebox, "askyesno", lambda *_args, **_kwargs: True)
        app.on_cut_clicked()
        assert fakes.controller.uplink == "LOCKDOWN"
        assert app.request_restore() is False
        app.open_recovery_wizard()
        assert app.request_restore() is True
        assert fakes.controller.commands == ["CUT_UPLINK", "RESTORE_UPLINK"]
        assert fakes.mqtt.publish_calls == 0
        assert fakes.mqtt.connect_calls == 0
    finally:
        for after_id in root.tk.splitlist(root.tk.call("after", "info")):
            root.after_cancel(after_id)
        root.destroy()
        for name in list(sys.modules):
            if name == "aegis_soc" or name.startswith("aegis_soc."):
                del sys.modules[name]
        sys.path[:] = [entry for entry in sys.path if entry != preview_purple_desktop.PYTHONUI_ROOT]
