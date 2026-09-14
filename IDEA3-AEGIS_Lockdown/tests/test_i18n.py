"""Focused tests for aegis_soc.i18n -- the polish-pass UI localization layer.

Pure/headless: i18n.py imports no tkinter, so these tests require no
DISPLAY and no tkinter installation, exactly like test_presentation.py.
"""
import json
import os

import pytest

from aegis_soc import i18n


@pytest.fixture(autouse=True)
def _reset_language():
    """Every test starts and ends on the default language so tests cannot
    leak state into each other via the shared module-level _state dict."""
    original = i18n.get_language()
    yield
    i18n.set_language(original)


def test_default_language_is_english_when_nothing_persisted(tmp_path, monkeypatch):
    monkeypatch.setattr(i18n.config, "DB_PATH", str(tmp_path / "does-not-exist" / "test.db"))
    monkeypatch.delenv("AEGIS_UI_LANGUAGE", raising=False)
    assert i18n._load_persisted_language() == i18n.DEFAULT_LANGUAGE


def test_translate_returns_requested_language():
    i18n.set_language("th")
    assert i18n.t("nav.overview") == "ภาพรวม"
    i18n.set_language("zh")
    assert i18n.t("nav.overview") == "概览"
    i18n.set_language("en")
    assert i18n.t("nav.overview") == "Overview"


def test_translate_supports_format_placeholders():
    i18n.set_language("en")
    assert i18n.t("dialog.wrong_pin_remaining", remaining=2) == "Incorrect PIN (2 attempt(s) remaining)"
    i18n.set_language("th")
    assert "2" in i18n.t("dialog.wrong_pin_remaining", remaining=2)


def test_translate_falls_back_to_english_for_missing_language_entry():
    # Simulate an entry that only has an English translation.
    i18n.STRINGS["_test_only_key"] = {"en": "English only"}
    try:
        i18n.set_language("th")
        assert i18n.t("_test_only_key") == "English only"
    finally:
        del i18n.STRINGS["_test_only_key"]


def test_translate_falls_back_to_raw_key_when_entirely_missing():
    assert i18n.t("this.key.does.not.exist") == "this.key.does.not.exist"


def test_translate_never_raises_on_missing_format_argument():
    # Missing a required kwarg for a template must degrade gracefully, not crash the GUI.
    result = i18n.t("dialog.wrong_pin_remaining")
    assert isinstance(result, str)


def test_set_language_rejects_unknown_code_by_falling_back_to_default():
    applied = i18n.set_language("fr")
    assert applied == i18n.DEFAULT_LANGUAGE
    assert i18n.get_language() == i18n.DEFAULT_LANGUAGE


def test_set_language_accepts_every_supported_language():
    for code in i18n.LANGUAGES:
        assert i18n.set_language(code) == code
        assert i18n.get_language() == code


def test_available_languages_lists_all_three_with_native_names():
    codes = [code for code, _name in i18n.available_languages()]
    assert codes == ["en", "th", "zh"]
    names = dict(i18n.available_languages())
    assert names["en"] == "English"
    assert names["th"] == "ไทย"
    assert names["zh"] == "中文"


def test_set_language_persists_to_disk_next_to_the_db(tmp_path, monkeypatch):
    fake_db = tmp_path / "runtime" / "test.db"
    monkeypatch.setattr(i18n.config, "DB_PATH", str(fake_db))

    i18n.set_language("zh")

    pref_path = tmp_path / "runtime" / "ui_language.json"
    assert pref_path.exists()
    with open(pref_path, encoding="utf-8") as f:
        assert json.load(f) == {"language": "zh"}


def test_load_persisted_language_reads_back_what_was_saved(tmp_path, monkeypatch):
    fake_db = tmp_path / "runtime" / "test.db"
    monkeypatch.setattr(i18n.config, "DB_PATH", str(fake_db))
    monkeypatch.delenv("AEGIS_UI_LANGUAGE", raising=False)

    i18n.set_language("th")
    # Simulate "reopening the window" (a fresh process) by reading the
    # persisted preference back independently of in-memory _state.
    assert i18n._load_persisted_language() == "th"


def test_load_persisted_language_falls_back_safely_on_corrupt_file(tmp_path, monkeypatch):
    fake_db = tmp_path / "runtime" / "test.db"
    os.makedirs(fake_db.parent, exist_ok=True)
    monkeypatch.setattr(i18n.config, "DB_PATH", str(fake_db))
    monkeypatch.delenv("AEGIS_UI_LANGUAGE", raising=False)
    with open(fake_db.parent / "ui_language.json", "w", encoding="utf-8") as f:
        f.write("{not valid json")

    assert i18n._load_persisted_language() == i18n.DEFAULT_LANGUAGE


def test_env_override_takes_priority_over_persisted_file(tmp_path, monkeypatch):
    fake_db = tmp_path / "runtime" / "test.db"
    monkeypatch.setattr(i18n.config, "DB_PATH", str(fake_db))
    i18n.set_language("th")  # persists "th" to disk

    monkeypatch.setenv("AEGIS_UI_LANGUAGE", "zh")
    assert i18n._load_persisted_language() == "zh"


def test_every_string_table_entry_has_all_three_languages():
    missing = {
        key: sorted(set(i18n.LANGUAGES) - set(entry))
        for key, entry in i18n.STRINGS.items()
        if not set(i18n.LANGUAGES).issubset(entry)
    }
    assert missing == {}, f"Incomplete translations: {missing}"


def test_notification_center_keys_are_localized_in_all_languages():
    keys = (
        "notif.button_label", "notif.panel_title", "notif.empty", "notif.ack_button",
        "notif.ack_all_button", "notif.severity_info", "notif.severity_warning",
        "notif.severity_critical", "notif.security_alert_title", "notif.security_alert_message",
        "notif.security_alert_message_unknown", "notif.broker_disconnected_title",
        "notif.esp32_offline_title", "notif.lockdown_engaged_title", "notif.normal_restored_title",
        "notif.audit_invalid_title",
    )
    for key in keys:
        for code in i18n.LANGUAGES:
            i18n.set_language(code)
            assert i18n.t(key) != key


def test_security_alert_message_formats_source_ip_without_translating_it():
    i18n.set_language("en")
    assert "203.0.113.5" in i18n.t("notif.security_alert_message", source_ip="203.0.113.5")
    i18n.set_language("th")
    assert "203.0.113.5" in i18n.t("notif.security_alert_message", source_ip="203.0.113.5")
    i18n.set_language("zh")
    assert "203.0.113.5" in i18n.t("notif.security_alert_message", source_ip="203.0.113.5")


def test_overview_banner_keys_exist_for_all_languages():
    keys = (
        "overview.banner_active_title", "overview.banner_incident_label",
        "overview.banner_source_ip_label", "overview.banner_empty_title",
        "overview.banner_empty_message",
    )
    for key in keys:
        for code in i18n.LANGUAGES:
            i18n.set_language(code)
            assert i18n.t(key) != key


def test_devices_staleness_keys_exist_for_all_languages():
    for code in i18n.LANGUAGES:
        i18n.set_language(code)
        assert i18n.t("devices.stale_badge") != "devices.stale_badge"
        assert "3" in i18n.t("devices.last_seen_seconds_ago", seconds=3)


def test_diagnostics_section_grouping_keys_exist_for_all_languages():
    for key in ("diagnostics.section_connectivity", "diagnostics.section_security", "diagnostics.section_data"):
        for code in i18n.LANGUAGES:
            i18n.set_language(code)
            assert i18n.t(key) != key
