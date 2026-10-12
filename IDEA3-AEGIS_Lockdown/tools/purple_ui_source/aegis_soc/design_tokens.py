"""
AEGIS IDEA 3 -- desktop design tokens (pure data; imports nothing).

This is the single source of truth for the colors, spacing and typography of
the IDEA3 Python desktop, expressed with the same semantic vocabulary as the
IDEA3 Web "Security Center Neo" layer (canvas / card / sunken / elevated
surfaces, one violet accent, success / warning / danger / info states).

It is deliberately a leaf module: no tkinter, no ``config``, no
``theme_state``. Two consumers depend on that:

* ``theme.py`` builds the Tk palette, fonts and widgets from these values.
* ``recovery_ui.py`` is import-isolated by security tests (it must never load
  ``config``, which carries the desktop demo defaults) and reads the same
  values lazily, inside its window function only.

Values are hex strings Tk accepts directly. Every status/accent text color is
checked for >= 4.5:1 contrast on the background, card and sunken surfaces, and
every filled-button color for >= 4.5:1 against ``on_accent``, in
``tests/test_design_tokens.py``.
"""
from __future__ import annotations

from collections.abc import Iterable

COLORS: dict[str, dict[str, str]] = {
    # Neo dark: ink-black canvas, near-black cards, violet accent.
    "dark": {
        "background": "#08080a",
        "panel": "#111116",
        "panel_alt": "#0b0b0f",        # sunken: inputs, log boxes, table wells
        "surface_elevated": "#17171f",  # chips, hovered/selected rows
        "border": "#262633",
        "border_strong": "#3b3b4f",
        "text": "#f8fafc",
        "text_secondary": "#cbd5e1",
        "muted": "#a3a3b8",
        "accent": "#a78bfa",
        "accent_hover": "#c4b5fd",
        "accent_soft": "#1a1533",
        "accent_fill": "#6d4aed",
        "accent_fill_hover": "#5b3fd6",
        "on_accent": "#ffffff",
        "accent_2": "#60a5fa",
        "accent_2_fill": "#2563eb",
        "info": "#22d3ee",
        "info_soft": "#082a33",
        # Filled (button) and text variants of each state. Text variants are
        # tuned for small type on dark surfaces; fills for white labels.
        "success": "#15803d",
        "success_hover": "#166534",
        "success_text": "#34d399",
        "success_soft": "#092c28",
        "warning": "#b45309",
        "warning_hover": "#92400e",
        "warning_text": "#fbbf24",
        "warning_soft": "#30250b",
        "danger": "#b91c1c",
        "danger_hover": "#991b1b",
        "danger_text": "#f87171",
        "danger_soft": "#361519",
        "unknown": "#8a8aa3",
    },
    # Neo light: cool paper canvas, white cards, indigo accent.
    "light": {
        "background": "#f6f7fb",
        "panel": "#ffffff",
        "panel_alt": "#f0f2f8",
        "surface_elevated": "#eceff8",
        "border": "#dfe3ee",
        "border_strong": "#c3c9da",
        "text": "#0f172a",
        "text_secondary": "#475569",
        "muted": "#5b6b80",
        "accent": "#4f46e5",
        "accent_hover": "#4338ca",
        "accent_soft": "#eef0ff",
        "accent_fill": "#4f46e5",
        "accent_fill_hover": "#4338ca",
        "on_accent": "#ffffff",
        "accent_2": "#2563eb",
        "accent_2_fill": "#1d4ed8",
        "info": "#0e7490",
        "info_soft": "#ecfeff",
        "success": "#15803d",
        "success_hover": "#166534",
        "success_text": "#047857",
        "success_soft": "#ecfdf5",
        "warning": "#b45309",
        "warning_hover": "#92400e",
        "warning_text": "#9a4a06",
        "warning_soft": "#fffbeb",
        "danger": "#b91c1c",
        "danger_hover": "#991b1b",
        "danger_text": "#c81e1e",
        "danger_soft": "#fef2f2",
        "unknown": "#5f6f86",
    },
}

SPACING = {"xs": 4, "sm": 8, "md": 12, "lg": 16, "xl": 24}

# Candidate families, best first. The first one actually installed wins; the
# Web layer leads with Inter / IBM Plex Sans Thai / JetBrains Mono, and the
# Windows and Linux system faces follow so a bare workstation still resolves.
SANS_CANDIDATES = (
    "Inter", "InterVariable", "IBM Plex Sans Thai", "Segoe UI", "IBM Plex Sans", "Noto Sans", "DejaVu Sans",
)
MONO_CANDIDATES = (
    "JetBrains Mono", "IBM Plex Mono", "Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono",
)

# role -> (family kind, size in points, weight). Nothing below 9 pt: status
# text must stay legible on a dense console.
FONT_ROLES: dict[str, tuple[str, int, str]] = {
    "display": ("sans", 34, "bold"),
    "title": ("sans", 22, "bold"),
    "brand": ("sans", 15, "bold"),
    "page_title": ("sans", 18, "bold"),
    "section_title": ("sans", 11, "bold"),
    "card_title": ("sans", 10, "bold"),
    "body": ("sans", 10, "normal"),
    "label": ("sans", 9, "normal"),
    "caption": ("sans", 9, "normal"),
    "metric": ("sans", 20, "bold"),
    "mono": ("mono", 10, "normal"),
    "mono_small": ("mono", 9, "normal"),
    "kicker": ("mono", 9, "bold"),
    "button": ("sans", 10, "bold"),
    "button_small": ("sans", 9, "bold"),
    "badge": ("sans", 9, "bold"),
    "nav": ("sans", 10, "normal"),
    "clock": ("mono", 13, "bold"),
}


def resolve_family(candidates: Iterable[str], available: Iterable[str], fallback: str) -> str:
    """First candidate present in `available` (case-insensitive), else `fallback`."""
    installed = {name.casefold() for name in available}
    for candidate in candidates:
        if candidate.casefold() in installed:
            return candidate
    return fallback


BUTTON_VARIANTS = ("primary", "secondary", "danger", "success", "warning")


def button_colors(variant: str, colors: dict[str, str]) -> dict[str, str]:
    """Resting / hover / focus colors for a button variant, from one theme's
    `colors`. An unknown variant degrades to the quiet secondary style --
    never to a danger/success/primary look. Pure: Tk applies the result."""
    fills = {
        "primary": ("accent_fill", "accent_fill_hover"),
        "danger": ("danger", "danger_hover"),
        "success": ("success", "success_hover"),
        "warning": ("warning", "warning_hover"),
    }
    if variant in fills:
        rest, hover = fills[variant]
        bg, active, fg = colors[rest], colors[hover], colors["on_accent"]
        frame = bg
    else:
        bg, active, fg = colors["surface_elevated"], colors["border_strong"], colors["text"]
        frame = colors["border"]
    return {
        "bg": bg,
        "fg": fg,
        "activebackground": active,
        "activeforeground": fg,
        "highlightbackground": frame,
        "highlightcolor": colors["accent_hover"],
    }


def button_disabled_colors(colors: dict[str, str]) -> dict[str, str]:
    """One disabled look for every variant: a disabled control must read as
    unavailable, not as a dimmed colored button that still seems to hold authority."""
    return {
        "bg": colors["surface_elevated"],
        "fg": colors["muted"],
        "activebackground": colors["surface_elevated"],
        "activeforeground": colors["muted"],
        "disabledforeground": colors["muted"],
        "highlightbackground": colors["border"],
    }

