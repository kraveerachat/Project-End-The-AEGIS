"""Tk widget-lifecycle regression tests for the desktop Overview metrics.

A passive real-ESP32 run raised
``_tkinter.TclError: invalid command name "...!metriccard...!label2"``
from ``_tick_monitors() -> _refresh_overview_metrics() -> MetricCard.update()``.
The monitor loop runs for the whole process lifetime, independent of login
state, so it must never touch a MetricCard whose Tk widgets were destroyed by
a logout, a page switch, or a language/theme shell rebuild -- and an uncaught
TclError there also stopped the loop from rescheduling itself.

These tests build the real Tk shell in a withdrawn root and skip only when no
Tk display is available. MQTT is a read-only fake; no network, broker, board,
or command path is involved.
"""

import tkinter as tk

import pytest

from aegis_soc import config, gui, i18n, theme_state
from aegis_soc import database as db
from aegis_soc import presentation as pres
from aegis_soc.theme import MetricCard

SECONDS_SINCE_DEVICE = 3.0
RSSI = -58
HEAP = 123456


class FakeMQTT:
    """Only the read-only liveness accessor the desktop shell calls."""

    def seconds_since_device(self):
        return SECONDS_SINCE_DEVICE

    def stop(self):
        pass


@pytest.fixture
def tk_root():
    try:
        root = tk.Tk()
    except tk.TclError as error:
        pytest.skip(f"Tk display unavailable: {error}")
    root.withdraw()
    yield root
    for after_id in _pending_after_ids(root):
        root.after_cancel(after_id)
    root.destroy()


@pytest.fixture
def app(tk_root, tmp_path, monkeypatch):
    # Language/theme preferences persist next to DB_PATH, so this also keeps
    # the rebuild tests from writing into the working tree.
    monkeypatch.setattr(config, "DB_PATH", str(tmp_path / "lifecycle.db"))
    db.init_db()
    # No background heartbeat thread and no audio in a unit test.
    monkeypatch.setattr(gui.AegisAdminGUI, "_start_background_heartbeat", lambda self: None)
    monkeypatch.setattr(gui.AegisAdminGUI, "trigger_alarm", lambda self, *_args: None)
    original_language = i18n.get_language()
    original_theme = theme_state.get_theme()
    yield gui.AegisAdminGUI(tk_root, FakeMQTT(), command_controller=object())
    i18n.set_language(original_language)
    theme_state.set_theme(original_theme)
    gui._sync_palette_aliases()


@pytest.fixture
def card_updates(monkeypatch):
    """Record every MetricCard.update() call, then run the real update."""
    updated = []
    original_update = MetricCard.update

    def recording_update(self, *args, **kwargs):
        updated.append(self)
        return original_update(self, *args, **kwargs)

    monkeypatch.setattr(MetricCard, "update", recording_update)
    return updated


def _pending_after_ids(root):
    return root.tk.splitlist(root.tk.call("after", "info"))


def _sign_in(app):
    # Same success path as login_view.LoginFlow: session.login(), then the
    # shell's on_authenticated callback.
    app.session.login("admin")
    app._on_authenticated()


def _live_overview_cards(app):
    cards = list(app.metric_cards.values())
    assert len(cards) == len(gui.METRIC_LABEL_KEYS)
    assert all(card.winfo_exists() for card in cards)
    return cards


def _other_language():
    return next(code for code, _name in i18n.available_languages() if code != i18n.get_language())


def _other_theme():
    return "light" if theme_state.get_theme() == "dark" else "dark"


def test_monitor_survives_logout_and_login_screen_rebuilds_without_touching_destroyed_cards(
    app, tk_root, card_updates
):
    _sign_in(app)
    old_cards = _live_overview_cards(app)

    app._logout()

    assert not app.session.authenticated
    assert not any(card.winfo_exists() for card in old_cards)
    assert app.metric_cards == {}

    card_updates.clear()
    pending_before = len(_pending_after_ids(tk_root))
    app._tick_monitors()
    # The tick ran to completion and rescheduled itself: the monitor loop is alive.
    assert len(_pending_after_ids(tk_root)) == pending_before + 1
    app.on_status("NORMAL", RSSI, HEAP)
    app.set_broker_state(True)
    app._set_language(_other_language())
    app._tick_monitors()
    app._set_theme(_other_theme())
    app._tick_monitors()
    assert card_updates == []

    _sign_in(app)
    new_cards = _live_overview_cards(app)
    assert not set(new_cards) & set(old_cards)

    card_updates.clear()
    app._tick_monitors()

    assert set(card_updates) == set(new_cards)
    broker = app.metric_cards["broker"]
    assert broker._value_label.cget("text") == gui._localize_status_value(pres.broker_metric(True).value)
    esp32 = app.metric_cards["esp32"]
    assert esp32._helper_label.cget("text") == gui._device_helper(SECONDS_SINCE_DEVICE, RSSI, HEAP)


def test_overview_refresh_skips_a_destroyed_card_and_still_updates_the_live_ones(app, card_updates):
    _sign_in(app)
    cards = _live_overview_cards(app)
    stale = app.metric_cards["esp32"]
    # Preserve the exact failure condition: the dict still owns a card whose
    # Tk widgets no longer exist.
    stale.destroy()
    assert app.metric_cards["esp32"] is stale
    assert not stale.winfo_exists()

    card_updates.clear()
    app.set_broker_state(True)
    app._tick_monitors()

    assert stale not in card_updates
    assert set(card_updates) == set(cards) - {stale}
    broker = app.metric_cards["broker"]
    assert broker._value_label.cget("text") == gui._localize_status_value(pres.broker_metric(True).value)


def test_navigating_away_from_overview_and_back_keeps_metrics_updating(app, card_updates):
    _sign_in(app)
    old_cards = _live_overview_cards(app)

    app._show_page("settings")

    assert app.metric_cards == {}
    assert not any(card.winfo_exists() for card in old_cards)
    card_updates.clear()
    app._tick_monitors()
    assert card_updates == []

    app._show_page("overview")
    new_cards = _live_overview_cards(app)

    card_updates.clear()
    app._tick_monitors()
    assert set(card_updates) == set(new_cards)


@pytest.mark.parametrize("rebuild", ["language", "theme"])
def test_authenticated_shell_rebuild_hands_metrics_to_the_new_cards(app, card_updates, rebuild):
    _sign_in(app)
    old_cards = _live_overview_cards(app)

    if rebuild == "language":
        app._set_language(_other_language())
    else:
        app._set_theme(_other_theme())

    assert app.session.authenticated
    assert not any(card.winfo_exists() for card in old_cards)
    new_cards = _live_overview_cards(app)

    card_updates.clear()
    app._tick_monitors()
    assert set(card_updates) == set(new_cards)
