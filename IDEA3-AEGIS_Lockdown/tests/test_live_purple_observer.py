"""Focused contracts for the real purple live read-only observer."""

from __future__ import annotations

import dataclasses
import hashlib
import inspect
import os
import socket
import sys
import threading
import time
import tkinter as tk
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
import pytest

from aegis_soc.observer import ObserverEvidence, UNKNOWN
from tools import live_purple_observer as live

pytestmark = pytest.mark.usefixtures("restore_aegis_soc_imports")


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
    assert values["timestamp"] == time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(1700000000.0))


def test_shared_operational_page_strings_cover_every_supported_language():
    required = (
        "overview.live_evidence.section",
        "overview.live_evidence.core",
        "overview.live_evidence.connectivity",
        "devices.summary.section",
        "devices.evidence.section",
        "devices.physical_limit.section",
        "lockdown.current.section",
        "lockdown.controls.section",
        "settings.language.label",
        "settings.theme.label",
        "settings.autosave.note",
        "settings.feedback.language",
        "settings.feedback.theme",
        "devices.field.heartbeat",
        "devices.field.reported_uplink",
        "devices.field.physical_relay",
        "devices.physical.not_proven",
        "lockdown.field.armed",
        "lockdown.field.dispatch",
        "lockdown.field.auto_contain",
        "lockdown.field.software_containment",
        "lockdown.control.cut_reason",
        "lockdown.control.restore_reason",
    )

    for key in required:
        entry = live.OBSERVER_STRINGS[key]
        assert set(entry) == {"en", "th", "zh"}
        assert all(entry[language].strip() for language in ("en", "th", "zh"))
        assert entry["th"] != entry["en"]
        assert entry["zh"] != entry["en"]


def test_register_observer_strings_never_replaces_a_pinned_translation():
    fake_i18n = SimpleNamespace(STRINGS={
        "settings.language.label": {"en": "Pinned language label"},
    })

    live.register_observer_strings(fake_i18n)

    assert fake_i18n.STRINGS["settings.language.label"] == {"en": "Pinned language label"}
    assert fake_i18n.STRINGS["settings.theme.label"]["th"] == "ธีม"


@pytest.mark.parametrize("raw", ["not-a-number", "", None])
def test_timestamp_formatting_falls_back_to_unknown_for_anything_unparseable(raw):
    evidence = dataclasses.replace(_fresh_evidence(), evidence_timestamp=raw)
    assert live.evidence_values(evidence)["timestamp"] == UNKNOWN


def test_unknown_timestamp_stays_unknown_and_is_not_parsed_as_a_number():
    evidence = dataclasses.replace(_fresh_evidence(), evidence_timestamp=UNKNOWN)
    assert live.evidence_values(evidence)["timestamp"] == UNKNOWN


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


def _label_texts(widget):
    texts = []
    for child in widget.winfo_children():
        if child.winfo_class() == "Label":
            texts.append(child.cget("text"))
        texts.extend(_label_texts(child))
    return texts


def _widgets(widget, cls):
    found = []
    for child in widget.winfo_children():
        if child.winfo_class() == cls:
            found.append(child)
        found.extend(_widgets(child, cls))
    return found


def _label_ids(root):
    return [id(w) for w in _widgets(root, "Label")]


@contextmanager
def _real_live_app(tmp_path, *, deiconify=False):
    """The same create_live_app isolation dance test_live_real_dashboard_renders_disabled_cut_restore_controls
    uses, as a context manager so the no-flicker/scroll tests below can share it without repeating the
    teardown by hand."""
    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"Tk display unavailable: {error}")
    if deiconify:
        root.deiconify()
        root.geometry("1024x400")
    else:
        root.withdraw()
    for name in list(sys.modules):
        if name == "aegis_soc" or name.startswith("aegis_soc."):
            del sys.modules[name]
    sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]
    try:
        status_path = tmp_path / "status.json"
        from test_live_purple_control_desktop import write_core_status
        write_core_status(status_path, 5, uplink="NORMAL")
        app, fakes = live.create_live_app(root, status_path=status_path)
        app.session.login("test-admin")
        app._on_authenticated()
        yield app, root, status_path
    finally:
        for after_id in root.tk.splitlist(root.tk.call("after", "info")):
            root.after_cancel(after_id)
        root.destroy()
        for name in list(sys.modules):
            if name == "aegis_soc" or name.startswith("aegis_soc."):
                del sys.modules[name]
        sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]


def test_overview_evidence_section_does_not_rebuild_on_an_unchanged_evidence_poll(tmp_path):
    with _real_live_app(tmp_path) as (app, root, _status_path):
        app._show_page("overview")
        root.update()
        before = _label_ids(root)
        for _ in range(3):
            app._refresh_live_evidence()
            root.update()
            after = _label_ids(root)
            assert after == before, "an unchanged evidence poll rebuilt the Overview evidence section"


def test_overview_evidence_section_rebuilds_when_evidence_actually_changes(tmp_path):
    from test_live_purple_control_desktop import write_core_status

    with _real_live_app(tmp_path) as (app, root, status_path):
        app._show_page("overview")
        root.update()
        before = _label_ids(root)
        write_core_status(status_path, 5, uplink="LOCKDOWN")
        app._refresh_live_evidence()
        root.update()
        after = _label_ids(root)
        assert after != before
        assert "LOCKDOWN" in _label_texts(root)


def test_overview_evidence_section_preserves_scroll_position_across_an_evidence_rebuild(tmp_path):
    from test_live_purple_control_desktop import write_core_status

    with _real_live_app(tmp_path, deiconify=True) as (app, root, status_path):
        app._show_page("overview")
        root.update()
        canvases = _widgets(root, "Canvas")
        assert canvases, "expected the Overview page's ScrollFrame canvas"
        canvas = canvases[0]
        bbox = canvas.bbox("all")
        assert bbox is not None and bbox[3] > canvas.winfo_height(), "test setup needs real scrollable overflow"
        canvas.yview_moveto(0.5)
        root.update()
        before = canvas.yview()[0]
        assert before > 0.05, "test setup did not actually scroll down"
        write_core_status(status_path, 5, uplink="LOCKDOWN")
        app._refresh_live_evidence()
        root.update()
        assert "LOCKDOWN" in _label_texts(root), "test setup did not actually change the data"
        after = canvas.yview()[0]
        assert abs(after - before) < 0.02, f"scroll position jumped from {before} to {after} on an evidence rebuild"


def test_devices_and_lockdown_pages_do_not_rebuild_on_an_unchanged_evidence_poll(tmp_path):
    with _real_live_app(tmp_path) as (app, root, _status_path):
        for key in ("devices", "lockdown"):
            app._show_page(key)
            root.update()
            before = _label_ids(root)
            for _ in range(3):
                app._refresh_live_evidence()
                root.update()
                after = _label_ids(root)
                assert after == before, f"an unchanged evidence poll rebuilt the {key} page"


def test_devices_and_lockdown_pages_rebuild_when_evidence_actually_changes(tmp_path):
    from test_live_purple_control_desktop import write_core_status

    with _real_live_app(tmp_path) as (app, root, status_path):
        for key in ("devices", "lockdown"):
            app._show_page(key)
            root.update()
            before_ids = _label_ids(root)
            write_core_status(status_path, 5, uplink="LOCKDOWN" if key == "devices" else "NORMAL",
                              dispatch="ACTIVE" if key == "lockdown" else "DISABLED")
            app._refresh_live_evidence()
            root.update()
            after_ids = _label_ids(root)
            assert after_ids != before_ids, f"a real evidence change did not rebuild the {key} page"


def test_the_lockdown_page_preserves_scroll_position_across_an_evidence_rebuild(tmp_path):
    """_refresh_live_evidence's STATIC_EVIDENCE_PAGES path calls self._show_page(shown) on a real change,
    which rebuilds the page's ScrollFrame from scratch (a brand-new canvas object, not just a cleared body's
    children) -- so the scroll fraction itself, not any particular canvas/frame object, is what must survive
    (see _workspace_scroll_fraction/_restore_workspace_scroll_fraction). Devices has too little content to
    ever overflow the window's minimum size, so only Lockdown (which does) is used here."""
    from test_live_purple_control_desktop import write_core_status

    with _real_live_app(tmp_path, deiconify=True) as (app, root, status_path):
        root.geometry("700x400")   # narrower than the base's 1024 default: wraps the longer fact rows, enough
        app._show_page("lockdown")  # extra height on this page's modest content to overflow the 700px minsize
        root.update()
        canvas = _widgets(root, "Canvas")[0]
        bbox = canvas.bbox("all")
        assert bbox is not None and bbox[3] > canvas.winfo_height(), "test setup needs real scrollable overflow"
        canvas.yview_moveto(0.5)
        root.update()
        before_fraction = canvas.yview()[0]
        assert before_fraction > 0.05, "test setup did not actually scroll down"
        write_core_status(status_path, 5, uplink="NORMAL", dispatch="ACTIVE")
        app._refresh_live_evidence()
        root.update()
        new_canvas = _widgets(root, "Canvas")[0]
        after_fraction = new_canvas.yview()[0]
        assert abs(after_fraction - before_fraction) < 0.02, (
            f"scroll position jumped from {before_fraction} to {after_fraction} on the Lockdown page rebuild")


def test_containment_status_is_not_configured_without_a_socket_env(monkeypatch):
    monkeypatch.delenv(live.containment.SOCKET_ENV, raising=False)
    status, blocked = live.containment_status()
    assert status == live.CONTAINMENT_NOT_CONFIGURED and blocked == []


def test_containment_status_is_unavailable_when_the_socket_does_not_exist(monkeypatch, tmp_path):
    monkeypatch.setenv(live.containment.SOCKET_ENV, str(tmp_path / "missing.sock"))
    status, blocked = live.containment_status()
    assert status.startswith("UNAVAILABLE") and blocked == []


def _serve_one_list(tmp_path, blocked_ips):
    """A real Unix-socket containment helper serving exactly one request, answering 'list' with ``blocked_ips``."""

    class _FixedBlockSet:
        def members(self):
            return set(blocked_ips)

    path = tmp_path / "containment.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    listener.listen(1)
    service = live.containment.ContainmentService(_FixedBlockSet(), ())
    server = live.containment.ContainmentServer(listener, service, allowed_uids={os.geteuid()})
    thread = threading.Thread(target=server.serve_one, daemon=True)
    thread.start()
    return path, listener, thread


def test_containment_status_is_healthy_and_lists_blocked_ips(monkeypatch, tmp_path):
    path, listener, thread = _serve_one_list(tmp_path, ["203.0.113.5", "203.0.113.6"])
    monkeypatch.setenv(live.containment.SOCKET_ENV, str(path))
    # The real helper is root-owned (uid 0), the default ContainmentClient() peer check; this test's fake
    # server runs as the test's own uid, so only the peer-uid check is relaxed here.
    real_client = live.containment.ContainmentClient
    monkeypatch.setattr(live.containment, "ContainmentClient", lambda: real_client(expected_server_uid=os.geteuid()))
    try:
        status, blocked = live.containment_status()
    finally:
        thread.join(2)
        listener.close()
    assert status == live.CONTAINMENT_HEALTHY
    assert blocked == ["203.0.113.5", "203.0.113.6"]


def test_diagnostics_page_shows_containment_health_and_block_count(tmp_path, monkeypatch):
    monkeypatch.delenv(live.containment.SOCKET_ENV, raising=False)
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
        app, _fakes = live.create_live_app(root, status_path=tmp_path / "missing-status.json")
        app.session.login("test-admin")
        app._on_authenticated()
        app._show_page("diagnostics")
        joined = "\n".join(_label_texts(app.root))
        assert "NOT_CONFIGURED" in joined
        # an unconfigured helper never answered op=list: the count is UNKNOWN, not a fake zero
        assert "UNKNOWN" in joined.splitlines()
        assert "0" not in joined.splitlines()
    finally:
        for after_id in root.tk.splitlist(root.tk.call("after", "info")):
            root.after_cancel(after_id)
        root.destroy()
        for name in list(sys.modules):
            if name == "aegis_soc" or name.startswith("aegis_soc."):
                del sys.modules[name]
        sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]


def test_diagnostics_page_says_not_available_with_a_reason_in_pure_observer_mode(tmp_path):
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
        app, _fakes = live.create_live_app(root, status_path=tmp_path / "missing-status.json")
        app.session.login("test-admin")
        app._on_authenticated()
        app._show_page("diagnostics")
        joined = "\n".join(_label_texts(app.root))
        assert "NOT_AVAILABLE — observer mode" in joined
    finally:
        for after_id in root.tk.splitlist(root.tk.call("after", "info")):
            root.after_cancel(after_id)
        root.destroy()
        for name in list(sys.modules):
            if name == "aegis_soc" or name.startswith("aegis_soc."):
                del sys.modules[name]
        sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]


def test_containment_source_never_mutates_the_set():
    source = inspect.getsource(live)
    assert '"op": "list"' not in source   # containment_status() calls .list() only, through the client wrapper
    assert ".block(" not in source and ".unblock(" not in source


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


@pytest.mark.parametrize("status, blocked, expected", [
    (live.CONTAINMENT_HEALTHY, [], "0"),
    (live.CONTAINMENT_HEALTHY, ["203.0.113.5", "203.0.113.6"], "2"),
    ("UNAVAILABLE — ContainmentUnavailable", [], "UNKNOWN"),
    (live.CONTAINMENT_NOT_CONFIGURED, [], "UNKNOWN"),
])
def test_blocked_count_text_is_a_number_only_when_the_helper_really_answered(status, blocked, expected):
    assert live.blocked_count_text(status, blocked) == expected
