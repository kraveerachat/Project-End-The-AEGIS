"""
AEGIS IDEA 3 — Logo asset path resolution (pure, no tkinter dependency).

Actual image loading (tkinter.PhotoImage) lives in theme.py, which already
requires tkinter. This module only decides *which path* to try, so the
decision itself stays headlessly testable -- consistent with the
presentation.py split from the Slice 1 UX/UI refresh.

The official AEGIS mark ships at IDEA1-AEGIS_Drive_LC/public/assets/logo,
IDEA2-AEGIS_Monitor/public/assets/logo, and HUB-AEGIS_Entry/public/assets/
logo (aegis-mark-dark-ink.png for light surfaces, aegis-mark-light-ink.png
for dark surfaces; square, transparent background, never stretched/glowed/
shadowed). IDEA3-AEGIS_Lockdown/assets/logo now carries byte-identical
copies of both files. Since this desktop console is dark-surface-only, it
looks for the light-ink mark other AEGIS surfaces already use for dark
backgrounds, keeping the whole product on one shared, official asset
rather than an IDEA3-specific one.
"""
import os
from pathlib import Path

THEME_LOGO_FILENAMES = {
    "dark": "aegis-mark-light-ink.png",
    "light": "aegis-mark-dark-ink.png",
}

# Pre-scaled copies of the same official marks, box-filtered offline to the
# exact sizes the UI renders at. tkinter.PhotoImage can only downscale by
# integer subsampling (it drops pixels rather than averaging them), which
# turns this mark's fine line texture into visual noise. Shipping the sizes
# we actually display keeps the mark legible without adding an imaging
# dependency at runtime. The full-resolution originals stay authoritative:
# these are additive, and a missing variant simply falls back to them.
SCALED_LOGO_SIZES = (40, 96)
DEFAULT_LOGO_RELATIVE_PATH = os.path.join("assets", "logo", THEME_LOGO_FILENAMES["dark"])


def _package_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_logo_path(env=None, base_dir=None, theme="dark"):
    """Return an absolute path to a real, existing logo file, or None.

    Resolution order:
      1. AEGIS_LOGO_PATH environment variable, if set and the file exists.
      2. The official mark variant for the selected dark/light surface.

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
    filename = THEME_LOGO_FILENAMES.get(theme, THEME_LOGO_FILENAMES["dark"])
    default_path = root / "assets" / "logo" / filename
    if default_path.is_file():
        return str(default_path.resolve())
    return None


def resolve_scaled_logo_path(max_height, env=None, base_dir=None, theme="dark"):
    """Return a pre-scaled variant of the official mark, or None.

    Picks the smallest shipped size that still covers `max_height`, so the
    image is never upscaled. Returns None when an AEGIS_LOGO_PATH override
    is in force (a custom asset has no pre-scaled variants), when no shipped
    size is large enough, or when the variant file is absent -- callers then
    fall back to resolve_logo_path() and the original scaling behavior.
    """
    values = os.environ if env is None else env
    if (values.get("AEGIS_LOGO_PATH") or "").strip():
        return None
    try:
        target = int(max_height)
    except (TypeError, ValueError):
        return None
    candidates = [size for size in SCALED_LOGO_SIZES if size >= target]
    if not candidates:
        return None
    filename = THEME_LOGO_FILENAMES.get(theme, THEME_LOGO_FILENAMES["dark"])
    stem = filename.removesuffix(".png")
    root = Path(base_dir) if base_dir is not None else _package_root()
    scaled_path = root / "assets" / "logo" / f"{stem}-{min(candidates)}.png"
    if scaled_path.is_file():
        return str(scaled_path.resolve())
    return None
