"""The single launcher composes the existing incident and manual CUT paths safely."""

import sys
import tkinter as tk

import pytest

from aegis_soc import cut_client, incident_view
from tools import live_purple_desktop as desktop
from tools import live_purple_cut_desktop as cut_desktop
from tools import live_purple_observer as live


def _walk(widget):
    for child in widget.winfo_children():
        yield child
        yield from _walk(child)


@pytest.fixture
def purple_root():
    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"Tk display unavailable: {error}")
    root.withdraw()
    saved_modules = {name: module for name, module in sys.modules.items()
                     if name == "aegis_soc" or name.startswith("aegis_soc.")}
    saved_path = list(sys.path)
    for name in saved_modules:
        del sys.modules[name]
    sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]
    yield root
    try:
        for after_id in root.tk.splitlist(root.tk.call("after", "info")):
            root.after_cancel(after_id)
        root.destroy()
    finally:
        for name in list(sys.modules):
            if name == "aegis_soc" or name.startswith("aegis_soc."):
                del sys.modules[name]
        sys.modules.update(saved_modules)
        sys.path[:] = saved_path


def _incident():
    return incident_view.parse_status({
        "v": 1, "ok": True, "code": "STATUS",
        "data": {"incident": {"id": 7, "state": "OPEN", "opened_at": "2026-10-10 10:00:00",
                              "attacker_ip": "192.0.2.7"},
                 "gates": [{"gate": name, "status": "PENDING", "summary": "Core check pending"}
                           for name, _label in incident_view.GATES]},
    })


def test_disabled_cut_launches_read_only_incident_desktop(monkeypatch, purple_root, tmp_path):
    monkeypatch.delenv(cut_desktop.ENABLE_ENV, raising=False)
    app, isolation = desktop.create_app(
        purple_root, incident_source=_incident, run_async=lambda function, *args: function(*args),
        status_path=tmp_path / "missing-status.json",
    )
    app.session.login("test-admin")
    app._on_authenticated()
    purple_root.update()
    app._show_page("incidents")
    purple_root.update()
    shown = [w.cget("text") for w in _walk(purple_root) if isinstance(w, tk.Label)]
    assert "192.0.2.7" in shown
    app._show_page("lockdown")
    purple_root.update()
    buttons = [w for w in _walk(purple_root) if isinstance(w, tk.Button)]
    assert any("CUT NETWORK — DISABLED" == b.cget("text") and b.cget("state") == "disabled" for b in buttons)
    assert isolation.mqtt.publish_calls == isolation.controller.issue_calls == 0


def test_enabled_cut_and_incident_share_one_desktop_without_mixing_evidence(monkeypatch, purple_root, tmp_path):
    monkeypatch.setenv(cut_desktop.ENABLE_ENV, "YES")
    monkeypatch.setenv(cut_desktop.SOCKET_ENV, "/run/aegis/cut.sock")

    class Flow:
        busy = False
        view = cut_client.View("IDLE", "No manual CUT in progress.", cut_client.INFO, True)
        calls = 0

        def submit(self, reason, secret):
            self.calls += 1
            assert (reason, secret) == ("confirmed attacker on LAN", "fresh-secret")
            self.view = cut_client.View("PUBLISHED", "Core published CUT; physical state not proven.",
                                        cut_client.INFO, False, "ab" * 16)
            self.busy = True
            return self.view

        def poll(self):
            self.busy = False
            self.view = cut_client.View("ACK_ACCEPTED", "Device ACKed; physical state not proven.",
                                        cut_client.INFO, True, "ab" * 16)
            return self.view

    class Prompts:
        def ask_reason(self):
            return "confirmed attacker on LAN"

        def ask_confirmation(self):
            return cut_client.CONFIRMATION

        def ask_secret(self):
            return "fresh-secret"

        def notify(self, *args):
            pass

    flow = Flow()

    class Source:
        calls = 0

        def __call__(self):
            self.calls += 1
            return _incident()

    source = Source()
    app, isolation = desktop.create_app(
        purple_root, flow=flow, prompts=Prompts(), incident_source=source,
        run_async=lambda function, *args: function(*args), status_path=tmp_path / "missing-status.json",
    )
    app.session.login("test-admin")
    app._on_authenticated()
    purple_root.update()
    app._show_page("incidents")
    purple_root.update()
    shown = [w.cget("text") for w in _walk(purple_root) if isinstance(w, tk.Label)]
    assert "192.0.2.7" in shown
    assert any("Core-attested Recovery STATUS" in text for text in shown)
    assert all(label in shown for _name, label in incident_view.GATES)
    assert any("PENDING" in text for text in shown)
    before = source.calls
    app._start_poll()
    purple_root.update()
    assert source.calls == before + 1 and flow.calls == 0
    app._show_page("lockdown")
    purple_root.update()
    buttons = [w for w in _walk(purple_root) if isinstance(w, tk.Button)]
    cut = next(b for b in buttons if b.cget("text") == cut_desktop.CUT_BUTTON_TEXT)
    assert cut.cget("state") == "normal"
    assert any("RESTORE" in b.cget("text") and b.cget("state") == "disabled" for b in buttons)
    cut.invoke()
    purple_root.update()
    assert flow.calls == 1
    app._schedule_poll()
    purple_root.update()
    assert "ACK_ACCEPTED" in app._cut_status.cget("text")
    assert isolation.mqtt.publish_calls == isolation.controller.issue_calls == 0


def test_invalid_explicit_cut_configuration_fails_before_tk(monkeypatch, capsys):
    monkeypatch.setenv(cut_desktop.ENABLE_ENV, "YES")
    monkeypatch.setenv(cut_desktop.SOCKET_ENV, "relative.sock")
    assert desktop.main() == 2
    assert "absolute Core CUT socket" in capsys.readouterr().err
