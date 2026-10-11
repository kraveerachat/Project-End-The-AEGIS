"""Focused contracts for the real purple live read-only observer."""

from __future__ import annotations

import hashlib
import inspect
import sys
import tkinter as tk
from pathlib import Path
import pytest

from aegis_soc.observer import ObserverEvidence, UNKNOWN
from tools import live_purple_observer as live


def _fresh_evidence():
    return ObserverEvidence(
        valid=True,
        freshness="FRESH",
        reason="fresh test evidence",
        runtime_state="LOCKDOWN",
        profile="production",
        dry_run="FALSE",
        auto_contain="FALSE",
        broker="CONNECTED",
        device="ONLINE",
        uplink="LOCKDOWN",
        armed="ARMED",
        dispatch="ACTIVE",
        trusted_time="SYNCED",
        evidence_timestamp="1700000000.0",
    )


def test_live_mapping_uses_real_core_fields_only():
    values = live.evidence_values(_fresh_evidence())

    assert values["runtime"] == "LOCKDOWN"
    assert values["profile"] == "production"
    assert values["broker"] == "CONNECTED"
    assert values["device"] == "ONLINE"
    assert values["uplink"] == "LOCKDOWN"
    assert values["armed"] == "ARMED"
    assert values["dispatch"] == "ACTIVE"
    assert values["trusted_time"] == "SYNCED"
    assert values["freshness"] == "FRESH"
    assert values["timestamp"] == "1700000000.0"


def test_live_mapping_projects_auto_contain_only_when_evidence_is_valid():
    values = live.evidence_values(_fresh_evidence())
    assert values["auto_contain"] == "FALSE"
    invalid = live.evidence_values(ObserverEvidence(False, "STALE", "old evidence"))
    assert invalid["auto_contain"] == UNKNOWN


def test_invalid_evidence_removes_historical_values():
    values = live.evidence_values(ObserverEvidence(False, "STALE", "old evidence"))

    assert values["freshness"] == "STALE"
    for key in ("runtime", "profile", "broker", "device", "uplink", "armed", "dispatch", "trusted_time", "timestamp"):
        assert values[key] == UNKNOWN


def test_live_runtime_uses_fail_closed_transport_and_database_fakes():
    mqtt = live.LiveMQTT()
    controller = live.LiveController()
    try:
        mqtt.start()
    except AssertionError:
        pass
    else:
        raise AssertionError("MQTT startup was not fail-closed")
    try:
        mqtt.publish("aegis/command", "synthetic")
    except AssertionError:
        pass
    else:
        raise AssertionError("MQTT publication was not fail-closed")
    try:
        controller.issue("CUT_UPLINK")
    except AssertionError:
        pass
    else:
        raise AssertionError("command dispatch was not fail-closed")
    assert mqtt.start_calls == 1
    assert mqtt.publish_calls == 1
    assert controller.issue_calls == 1


def test_live_source_does_not_construct_operational_runtime():
    source = inspect.getsource(live)
    for forbidden in ("MQTTManager(", "AegisCommandController(", "AegisSupervisor(", "TelegramListener(", "subprocess.", "serial."):
        assert forbidden not in source
    assert "_install_database_isolation" in source
    assert "_preview_gui_class" in source


def test_live_auth_does_not_use_offline_preview_credentials():
    source = inspect.getsource(live)
    assert "PREVIEW_ADMIN_ID" not in source
    assert "PREVIEW_ADMIN_PIN" not in source
    assert "session.login(" not in source
    assert "credential_verifier" not in source


def test_live_uses_real_dirty_gui_and_original_dashboard_builder_contract():
    source = inspect.getsource(live)
    assert "gui.AegisAdminGUI" in source or "_preview_gui_class(gui)" in source
    assert "super()._build_overview_page(parent)" in source
    assert "_build_overview_page" in source


def test_live_lockdown_page_exposes_disabled_control_contract():
    source = inspect.getsource(live)
    assert "CUT NETWORK — DISABLED" in source
    assert "RESTORE NETWORK — DISABLED" in source
    assert "no authorized Core-owned manual CUT request interface" in source
    assert "owner-only D4 terminal Recovery" in source
    assert "Recovery readiness" in source
    assert "NOT_CONSUMED — no attempt started by this observer" in source


def test_live_real_dashboard_renders_disabled_cut_restore_controls(tmp_path):
    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"Tk display unavailable: {error}")
    root.withdraw()
    for name in list(sys.modules):
        if name == "aegis_soc" or name.startswith("aegis_soc."):
            del sys.modules[name]
    sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]
    try:
        app, fakes = live.create_live_app(root, status_path=tmp_path / "missing-status.json")
        app.session.login("test-admin")
        app._on_authenticated()
        app._show_page("lockdown")
        disabled = [
            child for child in app.workspace.winfo_children()
            if child.winfo_exists()
        ]
        assert any(button.cget("text") == "CUT NETWORK — DISABLED" for button in _buttons(app.root))
        assert any(button.cget("text") == "RESTORE NETWORK — DISABLED" for button in _buttons(app.root))
        assert all(button.cget("state") == "disabled" for button in _buttons(app.root) if "NETWORK — DISABLED" in button.cget("text"))
        assert fakes.mqtt.publish_calls == 0
        assert fakes.controller.issue_calls == 0
        assert disabled
    finally:
        for after_id in root.tk.splitlist(root.tk.call("after", "info")):
            root.after_cancel(after_id)
        root.destroy()
        for name in list(sys.modules):
            if name == "aegis_soc" or name.startswith("aegis_soc."):
                del sys.modules[name]
        sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]


def _buttons(widget):
    buttons = []
    for child in widget.winfo_children():
        if child.winfo_class() == "Button":
            buttons.append(child)
        buttons.extend(_buttons(child))
    return buttons


def test_accepted_purple_snapshot_has_exact_owner_accepted_source_hashes():
    expected = {
        "gui.py": "6f2fc08aed68c5a5594b7296d08cbec0d421dac6af5a189a5bc5c89efbd278dd",
        "theme.py": "6956b9953677c2c3d86046078c9ad603e08789d384017b8008b49431ac56eb31",
        "login_view.py": "65a4439be071bc35238b40492a5864a85a38454e654fa04d036ca53699c44314",
        "design_tokens.py": "699479a09e749d1fb0cd2e37f7aa7ab6ca008840df7afb4b26dea353347e490d",
        "i18n.py": "d39117ad5209f5052d8aaf0b431f6702a6f245ae69e9e9dd5347f939f8e8dd52",
    }
    source_root = Path(live.PYTHONUI_ROOT) / "aegis_soc"
    actual = {name: hashlib.sha256((source_root / name).read_bytes()).hexdigest() for name in expected}
    assert actual == expected


def test_status_reader_is_the_only_live_data_source():
    source = inspect.getsource(live)
    assert "read_observer_status" in source
    assert "status.json" not in source
    assert "MQTT" in source
