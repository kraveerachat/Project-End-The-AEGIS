"""R8 and D4: Telegram never restores; the desktop Telegram bridge refuses /restore."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from aegis_soc import gui


@pytest.fixture
def app(monkeypatch):
    replies = []
    events = []
    monkeypatch.setattr(gui.comms, "send_telegram_reply", replies.append)
    monkeypatch.setattr(gui.db, "log_event", lambda *args, **kwargs: events.append(args))
    instance = gui.AegisAdminGUI.__new__(gui.AegisAdminGUI)
    instance.log_message = lambda *args, **kwargs: None
    instance.tg_locked_until = 0
    instance.tg_pin_fails = 0
    instance.armed = True
    instance.lbl_uplink = SimpleNamespace(cget=lambda _name: "NORMAL")

    def forbidden(*_args, **_kwargs):
        pytest.fail("Telegram /restore must never reach the command path")

    instance.send_command = forbidden
    instance.controller = SimpleNamespace(issue=forbidden)
    instance.replies = replies
    instance.events = events
    return instance


@pytest.mark.parametrize("text", ["/restore 4321", "/restore", "/RESTORE 4321", "/restore 0000"])
def test_telegram_restore_is_refused_and_never_reaches_the_controller(app, text):
    app._process_tg_command(text)
    assert len(app.replies) == 1
    assert "refused" in app.replies[0].lower()
    assert ("COMMAND_REJECTED",) == app.events[0][:1]


def test_telegram_help_no_longer_advertises_restore(app):
    app._process_tg_command("/status")
    assert "/restore" not in app.replies[0]
    assert "/cut" in app.replies[0]
