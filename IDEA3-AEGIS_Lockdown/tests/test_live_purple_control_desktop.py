"""Purple Desktop with Core-authenticated CUT and RESTORE plus the read-only severity panel (no MQTT, no controller)."""

from __future__ import annotations

import json
import os
import sys
import tkinter as tk

import pytest

from tools import live_purple_control_desktop as desktop
from tools import live_purple_observer as live

rc = desktop.restore_client


class FakeCutFlow:
    def __init__(self):
        cc = desktop.cut_desktop.client  # the path-loaded client: no aegis_soc import before the isolated GUI loads
        self.view = cc.View("IDLE", "No manual CUT in progress.", cc.INFO, True)
        self.busy = False
        self.submitted = []

    def submit(self, reason, secret):
        self.submitted.append((reason, secret))
        return self.view

    def poll(self):
        return self.view


class FakeRestoreFlow:
    def __init__(self):
        self.view = rc.View("IDLE", "No RESTORE in progress.", rc.INFO, True)
        self.busy = False
        self.submitted = []
        self.polls = 0

    def submit(self, reason, secret, confirmation):
        self.submitted.append((reason, secret, confirmation))
        self.view = rc.View("PUBLISHED", "RESTORE published by the Core.", rc.INFO, False, "cd" * 16)
        self.busy = True
        return self.view

    def poll(self):
        self.polls += 1
        self.view = rc.View("DEVICE_REPORTED_NORMAL", "Device reported NORMAL. Reconnection NOT proven.", rc.OK, True)
        self.busy = False
        return self.view


class FakePrompts:
    def __init__(self, reason="lab acceptance restore after CUT", confirmation=rc.CONFIRMATION, secret="restore-secret"):
        self.answers = {"reason": reason, "confirmation": confirmation, "secret": secret}
        self.asked = []
        self.notices = []

    def ask_restore_reason(self):
        self.asked.append("reason")
        return self.answers["reason"]

    def ask_restore_confirmation(self):
        self.asked.append("confirmation")
        return self.answers["confirmation"]

    def ask_restore_secret(self):
        self.asked.append("secret")
        return self.answers["secret"]

    def notify(self, title, text):
        self.notices.append((title, text))


def _widgets(widget, cls):
    found = []
    for child in widget.winfo_children():
        if child.winfo_class() == cls:
            found.append(child)
        found.extend(_widgets(child, cls))
    return found


def _clean_modules():
    for name in list(sys.modules):
        if name == "aegis_soc" or name.startswith("aegis_soc."):
            del sys.modules[name]
    sys.path[:] = [entry for entry in sys.path if entry != str(live.PYTHONUI_ROOT)]


@pytest.fixture
def app_factory(tmp_path):
    made = []
    saved_modules = {name: module for name, module in sys.modules.items()
                     if name == "aegis_soc" or name.startswith("aegis_soc.")}
    saved_path = list(sys.path)

    def build(restore_flow, prompts, graduated=None):
        try:
            root = tk.Tk()
        except tk.TclError as error:
            pytest.skip(f"Tk display unavailable: {error}")
        root.withdraw()
        _clean_modules()
        made.append(root)
        graduated_path = tmp_path / "graduated-status.json"
        if graduated is not None:
            graduated_path.write_text(json.dumps(graduated), encoding="utf-8")
        app, _fakes = desktop.create_control_app(
            root, cut_flow=FakeCutFlow(), restore_flow=restore_flow, prompts=prompts,
            run_async=lambda function, *args: function(*args), status_path=tmp_path / "missing-status.json",
            graduated_path=graduated_path,
        )
        app.session.login("test-admin")
        app._on_authenticated()
        app._show_page("lockdown")
        root.update()
        return app, root

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


def _restore_button(root):
    return next((b for b in _widgets(root, "Button") if b.cget("text") == desktop.RESTORE_BUTTON_TEXT), None)


def _texts(root):
    return [w.cget("text") for w in _widgets(root, "Label")]


def test_restore_is_wired_and_enabled_when_configured(app_factory):
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts())
    button = _restore_button(root)
    assert button is not None and str(button.cget("state")) == "normal"
    assert not any(b.cget("text") == desktop.RESTORE_DISABLED_TEXT for b in _widgets(root, "Button"))


def test_restore_stays_disabled_without_a_restore_channel(app_factory):
    _app, root = app_factory(None, FakePrompts())
    assert _restore_button(root) is None
    assert any(b.cget("text") == desktop.RESTORE_DISABLED_TEXT for b in _widgets(root, "Button"))


def test_a_restore_carries_reason_confirmation_and_secret_to_the_core_flow_and_reports_evidence(app_factory):
    flow, prompts = FakeRestoreFlow(), FakePrompts()
    app, root = app_factory(flow, prompts)
    app._on_restore_pressed()
    assert prompts.asked == ["reason", "confirmation", "secret"]
    assert flow.submitted == [("lab acceptance restore after CUT", "restore-secret", rc.CONFIRMATION)]
    for _ in range(30):
        root.update()
        if flow.polls:
            break
        root.after(100)
    app._restore_poll_worker()
    root.update()
    assert prompts.notices and prompts.notices[-1][0] == "RESTORE"
    assert "DEVICE_REPORTED_NORMAL" in prompts.notices[-1][1]


@pytest.mark.parametrize("answers, note", [
    ({"confirmation": "restore uplink"}, "Confirmation did not match"),
    ({"secret": ""}, "secret is required"),
])
def test_a_wrong_confirmation_or_missing_secret_sends_nothing(app_factory, answers, note):
    flow, prompts = FakeRestoreFlow(), FakePrompts(**answers)
    app, _root = app_factory(flow, prompts)
    app._on_restore_pressed()
    assert flow.submitted == []
    assert note in prompts.notices[-1][1]


def test_a_cancelled_reason_sends_nothing_and_says_nothing(app_factory):
    flow, prompts = FakeRestoreFlow(), FakePrompts(reason=None)
    app, _root = app_factory(flow, prompts)
    app._on_restore_pressed()
    assert flow.submitted == [] and prompts.notices == []


def test_the_severity_panel_shows_the_core_projection(app_factory):
    graduated = {
        "v": 1, "highest_level": "CRITICAL", "cut_recommended_for": "203.0.113.7", "auto_cut_latched": True,
        "decisions": [
            {"at": 1, "attacker_ip": "203.0.113.7", "kind": "port_scan", "level": "MEDIUM", "action": "SOFTWARE_BLOCK",
             "outcome": "BLOCKED", "score": 30, "reasons": ["port_scan+30"], "mitre": ["T1046"]},
            {"at": 2, "attacker_ip": "203.0.113.7", "kind": "ssh_login_after_failures", "level": "CRITICAL",
             "action": "AUTO_CUT", "outcome": "CUT_SENT", "score": 140, "reasons": [], "mitre": ["T1078", "T1110"]},
        ],
    }
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts(), graduated)
    texts = " | ".join(_texts(root))
    assert desktop.SEVERITY_TITLE in texts
    assert "CRITICAL" in texts and "203.0.113.7" in texts
    assert "AUTO_CUT → CUT_SENT" in texts and "T1046" in texts
    assert "EXECUTED this episode" in texts


def test_the_severity_panel_says_not_available_without_a_projection(app_factory):
    _app, root = app_factory(FakeRestoreFlow(), FakePrompts())
    assert any("NOT_AVAILABLE — no Core projection" in t for t in _texts(root))


# --------------------------------------------------------------------------- pure helpers (no display)


def test_read_graduated_refuses_symlinks_oversize_and_bad_schema(tmp_path):
    good = tmp_path / "g.json"
    good.write_text(json.dumps({"v": 1, "decisions": [{"level": "HIGH", "attacker_ip": "203.0.113.9"}]}))
    assert desktop.read_graduated(good)["decisions"][0]["level"] == "HIGH"
    link = tmp_path / "link.json"
    os.symlink(good, link)
    assert desktop.read_graduated(link) is None
    big = tmp_path / "big.json"
    big.write_text(" " * (desktop.GRADUATED_MAX_BYTES + 1))
    assert desktop.read_graduated(big) is None
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"v": 2, "decisions": []}))
    assert desktop.read_graduated(bad) is None
    assert desktop.read_graduated(tmp_path / "missing.json") is None
    odd = tmp_path / "odd.json"
    odd.write_text(json.dumps({"v": 1, "decisions": [{"level": "PANIC"}, "x", {"level": "LOW", "score": "9"}]}))
    assert [d["level"] for d in desktop.read_graduated(odd)["decisions"]] == ["LOW"]


def test_restore_needs_both_explicit_settings():
    assert desktop.restore_configuration({}) is None
    assert desktop.restore_configuration({desktop.RESTORE_ENABLE_ENV: "YES", desktop.RESTORE_SOCKET_ENV: "rel.sock"}) is None
    assert desktop.restore_configuration({desktop.RESTORE_ENABLE_ENV: "yes", desktop.RESTORE_SOCKET_ENV: "/run/x.sock"}) is None
    assert desktop.restore_configuration({desktop.RESTORE_ENABLE_ENV: "YES", desktop.RESTORE_SOCKET_ENV: "/run/x.sock"}) == "/run/x.sock"


def test_the_desktop_module_imports_no_aegis_soc_package():
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(desktop))
    top = tree.body  # module-level imports only: the isolated purple GUI is imported later, by design
    modules = {node.module for node in top if isinstance(node, ast.ImportFrom)}
    modules |= {alias.name for node in top if isinstance(node, ast.Import) for alias in node.names}
    assert not any(str(name).startswith("aegis_soc") for name in modules)
