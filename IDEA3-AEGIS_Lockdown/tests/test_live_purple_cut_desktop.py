"""The purple Desktop with Core-authenticated Manual CUT: wiring, isolation and truthful dialogs (no MQTT, no controller)."""

from __future__ import annotations

import inspect
import sys
import tkinter as tk
from types import SimpleNamespace

import pytest

from aegis_soc import cut_client as cc
from tools import live_purple_cut_desktop as desktop
from tools import live_purple_observer as live


class FakeFlow:
    def __init__(self, view=None, busy=False):
        self.view = view or cc.View("IDLE", "No manual CUT in progress.", cc.INFO, True)
        self.busy = busy
        self.submitted = []
        self.polls = 0
        self.next_view = cc.View("PUBLISHED", "CUT published by the Core.", cc.INFO, False, "ab" * 16)

    def submit(self, reason, secret):
        self.submitted.append((reason, secret))
        self.view = self.next_view
        self.busy = not self.view.terminal
        return self.view

    def poll(self):
        self.polls += 1
        self.view = cc.View("DEVICE_REPORTED_LOCKDOWN", "Device reported LOCKDOWN. Physical state NOT proven.", cc.OK, True)
        self.busy = False
        return self.view


class FakePrompts:
    def __init__(self, reason="attacker confirmed on the LAN", confirmation=cc.CONFIRMATION, secret="s3cret-per-cut"):
        self.answers = {"reason": reason, "confirmation": confirmation, "secret": secret}
        self.asked = []
        self.notices = []

    def ask_reason(self):
        self.asked.append("reason")
        return self.answers["reason"]

    def ask_confirmation(self):
        self.asked.append("confirmation")
        return self.answers["confirmation"]

    def ask_secret(self):
        self.asked.append("secret")
        return self.answers["secret"]

    def notify(self, title, text):
        self.notices.append((title, text))


def _buttons(widget):
    found = []
    for child in widget.winfo_children():
        if child.winfo_class() == "Button":
            found.append(child)
        found.extend(_buttons(child))
    return found


def _clean_modules():
    for name in list(sys.modules):
        if name == "aegis_soc" or name.startswith("aegis_soc."):
            del sys.modules[name]
    sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]


@pytest.fixture
def app_factory(tmp_path):
    made = []
    # The isolated purple GUI needs a fresh `aegis_soc`; put the suite's own modules back afterwards so no later test
    # sees replaced classes (the pattern behind the order-dependent inspect.getsource failure in other suites).
    saved_modules = {name: module for name, module in sys.modules.items()
                     if name == "aegis_soc" or name.startswith("aegis_soc.")}
    saved_path = list(sys.path)

    def build(flow, prompts):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            pytest.skip(f"Tk display unavailable: {error}")
        root.withdraw()
        _clean_modules()
        made.append(root)
        app, fakes = desktop.create_cut_app(
            root, flow=flow, prompts=prompts, run_async=lambda function, *args: function(*args),
            status_path=tmp_path / "missing-status.json",
        )
        app.session.login("test-admin")
        app._on_authenticated()
        app._show_page("lockdown")
        root.update()
        return app, fakes, root

    yield build
    for root in made:
        try:
            for after_id in root.tk.splitlist(root.tk.call("after", "info")):
                root.after_cancel(after_id)
            root.destroy()
        except tk.TclError:
            pass
    _clean_modules()
    sys.modules.update(saved_modules)
    sys.path[:] = saved_path


def _cut_button(app):
    return next((b for b in _buttons(app.root) if b.cget("text") == desktop.CUT_BUTTON_TEXT), None)


def test_it_refuses_to_start_unless_explicitly_enabled_and_configured(monkeypatch, capsys):
    assert desktop.configuration({}) is None
    assert desktop.configuration({desktop.ENABLE_ENV: "YES"}) is None
    assert desktop.configuration({desktop.ENABLE_ENV: "yes", desktop.SOCKET_ENV: "/run/x/cut.sock"}) is None
    assert desktop.configuration({desktop.ENABLE_ENV: "YES", desktop.SOCKET_ENV: "relative.sock"}) is None
    assert desktop.configuration({desktop.ENABLE_ENV: "YES", desktop.SOCKET_ENV: "/run/x/cut.sock"}) == "/run/x/cut.sock"
    monkeypatch.delenv(desktop.ENABLE_ENV, raising=False)
    monkeypatch.delenv(desktop.SOCKET_ENV, raising=False)
    assert desktop.main() == 2
    assert "disabled" in capsys.readouterr().err


def test_source_builds_no_operational_runtime_and_the_observer_stays_read_only():
    source = inspect.getsource(desktop)
    for forbidden in ("MQTTManager(", "AegisCommandController(", "AegisSupervisor(", "TelegramListener(", "subprocess.",
                      "serial.", "sqlite3", ".issue(", "local_restore", "from aegis_soc import local", "paho"):
        assert forbidden not in source, forbidden
    assert "CUT NETWORK — DISABLED" in inspect.getsource(live)  # the read-only observer is unchanged


def test_the_accepted_cut_button_is_wired_in_place_and_restore_stays_disabled(app_factory):
    flow = FakeFlow()
    app, fakes, _root = app_factory(flow, FakePrompts())
    button = _cut_button(app)
    assert button is not None and button.cget("state") == "normal"
    assert not any(b.cget("text") == "CUT NETWORK — DISABLED" for b in _buttons(app.root))
    restore = [b for b in _buttons(app.root) if "RESTORE" in b.cget("text") and "DISABLED" in b.cget("text")]
    assert restore and all(b.cget("state") == "disabled" for b in restore)
    assert app.root.title() == desktop.CUT_TITLE


def test_pressing_cut_asks_for_a_fresh_reason_confirmation_and_secret_then_submits_once(app_factory):
    flow, prompts = FakeFlow(), FakePrompts()
    app, fakes, root = app_factory(flow, prompts)
    _cut_button(app).invoke()
    root.update()
    assert prompts.asked[:3] == ["reason", "confirmation", "secret"]
    assert flow.submitted == [("attacker confirmed on the LAN", "s3cret-per-cut")]
    assert fakes.mqtt.publish_calls == 0 and fakes.controller.issue_calls == 0
    assert _cut_button(app).cget("state") == "disabled"  # one CUT in flight; no double click
    app._cut_button.invoke()
    assert len(flow.submitted) == 1


def test_the_lifecycle_is_polled_until_terminal_and_reported_honestly(app_factory):
    flow, prompts = FakeFlow(), FakePrompts()
    app, _fakes, root = app_factory(flow, prompts)
    _cut_button(app).invoke()
    root.update()
    app._schedule_poll()  # the Tk after-timer would do this; step it explicitly
    root.update()
    assert flow.polls == 1 and not flow.busy
    assert _cut_button(app).cget("state") == "normal"
    assert prompts.notices and "NOT proven" in prompts.notices[-1][1]
    assert "DEVICE_REPORTED_LOCKDOWN" in app._cut_status.cget("text")


def test_a_wrong_confirmation_or_missing_secret_sends_nothing(app_factory):
    flow = FakeFlow()
    prompts = FakePrompts(confirmation="cut uplink")
    app, _f, root = app_factory(flow, prompts)
    _cut_button(app).invoke()
    assert flow.submitted == [] and prompts.notices and "Nothing was sent" in prompts.notices[-1][1]
    prompts.answers.update(confirmation=cc.CONFIRMATION, secret="")
    _cut_button(app).invoke()
    assert flow.submitted == [] and "secret" in prompts.asked


def test_cancelling_the_reason_dialog_does_nothing(app_factory):
    flow = FakeFlow()
    prompts = FakePrompts(reason=None)
    app, _f, _root = app_factory(flow, prompts)
    _cut_button(app).invoke()
    assert flow.submitted == [] and prompts.asked == ["reason"]


def test_a_refusal_is_shown_as_not_sent_and_the_button_is_usable_again(app_factory):
    flow, prompts = FakeFlow(), FakePrompts()
    flow.next_view = cc.describe_code("AUTH_FAILED", False)
    app, _f, root = app_factory(flow, prompts)
    _cut_button(app).invoke()
    root.update()
    assert prompts.notices and "Nothing was sent" in prompts.notices[-1][1]
    assert _cut_button(app).cget("state") == "normal"


def test_the_control_survives_page_changes(app_factory):
    flow = FakeFlow()
    app, _f, root = app_factory(flow, FakePrompts())
    app._show_page("overview")
    app._show_page("lockdown")
    root.update()
    button = _cut_button(app)
    assert button is not None and button.cget("state") == "normal"


def test_the_gui_callbacks_that_would_reach_a_controller_remain_neutralized(app_factory):
    flow = FakeFlow()
    app, fakes, _root = app_factory(flow, FakePrompts())
    app.on_cut_clicked()
    app.on_restore_clicked()
    app.send_command("CUT_UPLINK", "x")
    assert fakes.controller.issue_calls == 0 and fakes.mqtt.publish_calls == 0 and flow.submitted == []
