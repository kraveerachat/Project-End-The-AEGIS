"""Recovery wizard lifecycle: observer registration, window-manager close, single instance.

The wizard registers on the GUI as a forwarded-evidence observer. Closing it
through the window-manager X button must unregister it exactly like a Python
``destroy()``, and only one Recovery wizard may exist at a time, because each
wizard owns its own coordinator and correlation state. These tests build the
real Tk wizard in a withdrawn root and skip only when no Tk display exists.
No MQTT, broker, containment, or device path is involved.
"""

import tkinter as tk
from types import SimpleNamespace

import pytest

from aegis_soc import database as db
from aegis_soc import gui, wizard


class FakeGui:
    """The narrow GUI surface the wizard uses, with the real observer registry."""

    def __init__(self, root):
        self.root = root
        self.controller = object()
        self.mqtt = object()
        self._recovery_observers = []
        self.logged = []

    register_recovery_observer = gui.AegisAdminGUI.register_recovery_observer
    unregister_recovery_observer = gui.AegisAdminGUI.unregister_recovery_observer
    on_ack = gui.AegisAdminGUI.on_ack
    on_status = gui.AegisAdminGUI.on_status

    def log_message(self, text, level=None):
        self.logged.append(text)

    def refresh_incident_banner(self):
        pass


@pytest.fixture
def tk_root():
    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"Tk display unavailable: {error}")
    root.withdraw()
    yield root
    root.destroy()


@pytest.fixture(autouse=True)
def no_database(monkeypatch):
    monkeypatch.setattr(db, "get_open_incident", lambda: None)


@pytest.fixture
def fake_gui(tk_root):
    return FakeGui(tk_root)


def _click_window_manager_close(window):
    """Invoke exactly what the window manager's X button invokes."""
    handler = window.protocol("WM_DELETE_WINDOW")
    assert handler, "no WM_DELETE_WINDOW handler: the X button would bypass the Python destroy()"
    window.tk.call(handler)


def test_opening_the_wizard_registers_exactly_one_observer(fake_gui):
    window = wizard.IncidentRecoveryWizard(fake_gui)

    assert fake_gui._recovery_observers == [window]
    window.destroy()


def test_python_destroy_unregisters_the_observer(fake_gui):
    window = wizard.IncidentRecoveryWizard(fake_gui)

    window.destroy()

    assert fake_gui._recovery_observers == []


def test_window_manager_close_unregisters_the_observer(fake_gui):
    window = wizard.IncidentRecoveryWizard(fake_gui)

    _click_window_manager_close(window)

    assert fake_gui._recovery_observers == []
    assert not window.winfo_exists()


def test_destroy_after_window_manager_close_is_idempotent(fake_gui):
    window = wizard.IncidentRecoveryWizard(fake_gui)
    _click_window_manager_close(window)

    window.destroy()  # a second close path must not raise or double-unregister

    assert fake_gui._recovery_observers == []


def test_open_close_reopen_leaves_no_stale_observer(fake_gui):
    first = wizard.IncidentRecoveryWizard(fake_gui)
    _click_window_manager_close(first)
    second = wizard.IncidentRecoveryWizard(fake_gui)

    assert fake_gui._recovery_observers == [second]
    second.destroy()
    assert fake_gui._recovery_observers == []


def test_forwarded_evidence_reaches_only_the_live_wizard(fake_gui):
    first = wizard.IncidentRecoveryWizard(fake_gui)
    stale_calls, live_calls = [], []
    first.on_ack_evidence = lambda *args: stale_calls.append(args)
    _click_window_manager_close(first)
    second = wizard.IncidentRecoveryWizard(fake_gui)
    second.on_ack_evidence = lambda *args: live_calls.append(args)
    fake_gui.pending_cmd = None

    fake_gui.on_ack("OK", "ACCEPTED", "msg-1")

    assert stale_calls == []
    assert live_calls == [("OK", "ACCEPTED", "msg-1")]
    second.destroy()


def test_a_wizard_that_fails_to_build_is_never_left_registered(fake_gui, monkeypatch):
    def broken(self, parent, gate):
        raise RuntimeError("row build failed")

    monkeypatch.setattr(wizard.IncidentRecoveryWizard, "_build_gate_row", broken)

    with pytest.raises(RuntimeError):
        wizard.IncidentRecoveryWizard(fake_gui)

    assert fake_gui._recovery_observers == []


# ---- single instance -------------------------------------------------------

class FakeWizard:
    instances = []

    def __init__(self, owner):
        self.owner = owner
        self.alive = True
        self.raised = 0
        FakeWizard.instances.append(self)

    def winfo_exists(self):
        return self.alive

    def lift(self):
        self.raised += 1

    def focus_force(self):
        pass


@pytest.fixture
def opener(monkeypatch):
    FakeWizard.instances = []
    monkeypatch.setattr(gui, "IncidentRecoveryWizard", FakeWizard)
    owner = SimpleNamespace(refresh_incident_banner=lambda: None)
    return lambda: gui.AegisAdminGUI.open_recovery_wizard(owner)


def test_second_open_reuses_the_live_wizard(opener):
    opener()
    opener()  # a double click on the Recovery button

    assert len(FakeWizard.instances) == 1
    assert FakeWizard.instances[0].raised == 1


def test_a_closed_wizard_may_be_reopened(opener):
    opener()
    FakeWizard.instances[0].alive = False

    opener()

    assert len(FakeWizard.instances) == 2


def test_wizard_r5_button_never_reaches_the_controller_once_restore_is_spent(fake_gui):
    class ForbiddenController:
        def issue(self, *args, **kwargs):
            raise AssertionError("a spent RESTORE must never reach the controller again")

    fake_gui.controller = ForbiddenController()
    window = wizard.IncidentRecoveryWizard(fake_gui)
    window.coordinator._restore_attempted = True

    window._on_r5_clicked()
    window._on_r5_clicked()

    assert any("already requested" in line for line in fake_gui.logged)
    window.destroy()
