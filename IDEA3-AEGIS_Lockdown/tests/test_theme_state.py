"""Non-secret desktop theme preference contracts."""

import json

from aegis_soc import theme_state


def test_theme_defaults_to_dark_when_no_preference_exists(tmp_path):
    assert theme_state.load_theme(env={}, path=tmp_path / "missing.json") == "dark"


def test_theme_environment_override_wins_over_the_file(tmp_path):
    path = tmp_path / "ui_theme.json"
    path.write_text('{"theme": "dark"}', encoding="utf-8")

    assert theme_state.load_theme(env={"AEGIS_UI_THEME": "light"}, path=path) == "light"


def test_invalid_or_corrupt_theme_falls_back_to_dark(tmp_path):
    invalid = tmp_path / "invalid.json"
    invalid.write_text('{"theme": "neon"}', encoding="utf-8")
    corrupt = tmp_path / "corrupt.json"
    corrupt.write_text("{not-json", encoding="utf-8")

    assert theme_state.load_theme(env={}, path=invalid) == "dark"
    assert theme_state.load_theme(env={}, path=corrupt) == "dark"


def test_setting_theme_persists_only_the_allowlisted_preference(tmp_path):
    path = tmp_path / "preferences" / "ui_theme.json"

    applied = theme_state.set_theme("light", path=path)

    assert applied == "light"
    assert json.loads(path.read_text(encoding="utf-8")) == {"theme": "light"}
    text = path.read_text(encoding="utf-8").lower()
    assert "pin" not in text
    assert "password" not in text
    assert "secret" not in text
    assert "token" not in text


def test_unknown_theme_is_normalized_before_persistence(tmp_path):
    path = tmp_path / "ui_theme.json"

    assert theme_state.set_theme("cyberpunk", path=path) == "dark"
    assert json.loads(path.read_text(encoding="utf-8")) == {"theme": "dark"}


def test_available_themes_are_stable_and_ordered():
    assert theme_state.available_themes() == ("dark", "light")
