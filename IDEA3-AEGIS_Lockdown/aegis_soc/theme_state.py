"""Allow-listed, non-secret desktop theme preference persistence."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path

from . import config

DEFAULT_THEME = "dark"
THEMES = ("dark", "light")


def _validate_theme(name: object) -> str:
    return name if isinstance(name, str) and name in THEMES else DEFAULT_THEME


def preference_path() -> Path:
    return Path(config.DB_PATH).expanduser().resolve().parent / "ui_theme.json"


def load_theme(
    *, env: Mapping[str, str] | None = None, path: str | os.PathLike[str] | None = None
) -> str:
    values = os.environ if env is None else env
    override = (values.get("AEGIS_UI_THEME") or "").strip().lower()
    if override in THEMES:
        return override
    target = Path(path) if path is not None else preference_path()
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, TypeError, ValueError):
        return DEFAULT_THEME
    if not isinstance(data, dict):
        return DEFAULT_THEME
    return _validate_theme(data.get("theme"))


_state = {"theme": load_theme()}


def get_theme() -> str:
    return _state["theme"]


def set_theme(name: str, *, path: str | os.PathLike[str] | None = None) -> str:
    resolved = _validate_theme(name)
    _state["theme"] = resolved
    target = Path(path) if path is not None else preference_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=target.parent, delete=False
        ) as handle:
            json.dump({"theme": resolved}, handle)
            handle.write("\n")
            temporary = Path(handle.name)
        os.replace(temporary, target)
    except OSError:
        try:
            temporary.unlink(missing_ok=True)
        except (OSError, UnboundLocalError):
            pass
    return resolved


def available_themes() -> tuple[str, str]:
    return THEMES
