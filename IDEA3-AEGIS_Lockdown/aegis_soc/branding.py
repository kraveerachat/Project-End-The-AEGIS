"""
AEGIS IDEA 3 — Logo asset path resolution (pure, no tkinter dependency).

Actual image loading (tkinter.PhotoImage) lives in theme.py, which already
requires tkinter. This module only decides *which path* to try, so the
decision itself stays headlessly testable -- consistent with the
presentation.py split from the Slice 1 UX/UI refresh.

No logo asset ships with this repository today: every existing brand asset
folder (IDEA1-AEGIS_Drive_LC/public/assets/logo, IDEA2-AEGIS_Monitor/public/
assets/logo, HUB-AEGIS_Entry/public/assets/logo) contains only a
PUT-LOGOS-HERE.md placeholder describing the shared AEGIS mark convention
(aegis-mark-dark-ink.png for light surfaces, aegis-mark-light-ink.png for
dark surfaces, square, transparent background, never stretched/glowed/
shadowed) -- and IDEA3 had no logo folder at all before this change. Since
this desktop console is dark-surface-only, it looks for the same
light-ink mark other AEGIS surfaces already use, so a single shared PNG
drop-in works across the whole product rather than requiring an
IDEA3-specific asset.
"""
import os
from pathlib import Path

DEFAULT_LOGO_RELATIVE_PATH = os.path.join("assets", "logo", "aegis-mark-light-ink.png")


def _package_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_logo_path(env=None, base_dir=None):
    """Return an absolute path to a real, existing logo file, or None.

    Resolution order:
      1. AEGIS_LOGO_PATH environment variable, if set and the file exists.
      2. <base_dir or package root>/assets/logo/aegis-logo.png, if it exists.

    Never raises; a missing, unreadable, or unset asset simply returns None
    so callers can fall back to text-only branding.
    """
    values = os.environ if env is None else env
    override = (values.get("AEGIS_LOGO_PATH") or "").strip()
    if override:
        path = Path(override).expanduser()
        if path.is_file():
            return str(path.resolve())
        return None

    root = Path(base_dir) if base_dir is not None else _package_root()
    default_path = root / DEFAULT_LOGO_RELATIVE_PATH
    if default_path.is_file():
        return str(default_path.resolve())
    return None
