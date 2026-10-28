"""A view-layer content-area design system for the IDEA3 purple Desktop.

Scope: page CONTENT only -- never the shell (sidebar, top status bar, footer), which stays exactly as the
pinned ``aegis_soc`` package built it. This module is deliberately NOT part of that pinned package: it is a
new file so the 5 immutable purple snapshot files (gui.py, theme.py, login_view.py, design_tokens.py,
i18n.py) stay byte-identical. Nothing here invents a color -- every color used is read from the pinned
theme's own ``Palette`` (``aegis_soc.theme.get_palette()``) or its existing status-color/glyph helpers.

Type scale (Tk *pixel* sizes -- a negative Tk font size is an exact pixel height, not a DPI-scaled point
size, which is what "~26px" etc below actually means):
    page_title     ~26px bold   -- a page's own <h1>, bigger than the pinned shell's nav/page header
    section_title  ~19px bold   -- a card/section header
    card_title     ~14px bold   -- a smaller card inside a section (e.g. one incident's card)
    body           ~14px normal -- the main readable size for prose/intro text
    label          ~13px normal -- an info-row's label column
    note           ~12px, dim   -- a secondary/supporting line (reuses palette.muted for "dim")

Spacing scale (px): SPACE_SM=8, SPACE_MD=16, SPACE_LG=24, applied consistently for card padding, gaps
between rows and section margins.

Fonts are created as brand-new Tk *named* fonts (``purple_design.<role>``) on first use, in the SAME family
the pinned theme already resolved for its own "sans" role -- so this never touches, overwrites, or
reconfigures theme.py's own ``aegis.*`` named fonts, which every other page and the whole shell keep using
unchanged.

Components here are built from plain tk.Frame/tk.Label primitives -- the same primitives the pinned
theme.Section/_add_fact already use -- or by taking a widget the pinned package built (e.g. gui.Section,
gui.MetricCard) and only restyling what it exposes (its ``.body``, or its own title Label, found by walking
its already-fixed child order) rather than re-implementing it.
"""
from __future__ import annotations

import tkinter as tk
import tkinter.font as tkfont

SPACE_SM = 8
SPACE_MD = 16
SPACE_LG = 24

# role -> (pixel size, weight). Negative size = exact pixel height (Tk convention), not points.
_TYPE_SCALE = {
    "page_title": (-26, "bold"),
    "section_title": (-19, "bold"),
    "card_title": (-14, "bold"),
    "body": (-14, "normal"),
    "label": (-13, "normal"),
    "note": (-12, "normal"),
}

_initialized_roots: set[str] = set()


def _resolve_family(root) -> str:
    """The same family the pinned theme already resolved for its "sans" role, read from its own already-
    created named font -- never a second, independent font-probe that could drift from theme.py's choice."""
    from aegis_soc import theme as ui_theme

    try:
        return tkfont.nametofont(ui_theme.FONT_BODY).actual("family")
    except tk.TclError:
        return "TkDefaultFont"


def _font_name(role: str) -> str:
    return f"purple_design.{role}"


def ensure_fonts(root) -> None:
    """Create this module's named fonts on ``root`` once per Tk interpreter; safe to call repeatedly
    (each page build calls it) -- a no-op after the first call for a given root."""
    key = str(root)
    if key in _initialized_roots:
        return
    family = _resolve_family(root)
    existing = set(root.tk.splitlist(root.tk.call("font", "names")))
    for role, (size, weight) in _TYPE_SCALE.items():
        name = _font_name(role)
        options = ("-family", family, "-size", size, "-weight", weight)
        root.tk.call("font", "configure" if name in existing else "create", name, *options)
    _initialized_roots.add(key)


def font(role: str) -> str:
    """The Tk named font for a type-scale role (call ``ensure_fonts(root)`` once first)."""
    return _font_name(role)


# ---------------------------------------------------------------------------
# Components
# ---------------------------------------------------------------------------

def page_title(parent, text, *, palette, bg=None):
    """A page's own big title label, at the new page_title scale -- distinct from the shell's own page
    header (gui.PageHeader, untouched), for a page that wants a bigger opening statement in its content."""
    return tk.Label(parent, text=text, font=font("page_title"), fg=palette.text,
                    bg=bg if bg is not None else palette.background, anchor="w", justify="left")


def intro_text(parent, text, *, palette, bg=None, wraplength=1100):
    """A page's one-line (or wrapped) explanatory sentence, at the new body scale -- bigger and clearer
    than the pinned theme.make_hint's caption-sized hint, for the same "what is this page for" role."""
    return tk.Label(parent, text=text, font=font("body"), fg=palette.text_secondary,
                    bg=bg if bg is not None else palette.background, anchor="w", justify="left",
                    wraplength=wraplength)


def restyle_section_titles(container, *, gui):
    """Walk an already-built page's widget tree and bump every gui.Section's own title Label to this
    design system's section_title font, in place -- for the two pages (Diagnostics, Settings) built
    entirely inside the pinned gui.py with no override point to build their sections with
    style_section_title() directly in the first place. Only each Section's title font changes; its
    border/divider/body/accent dot and every fact row inside it (built by the pinned theme._add_fact,
    which keeps no reference to what it builds) stay exactly as the pinned code drew them."""
    def walk(widget):
        if isinstance(widget, gui.Section):
            style_section_title(widget)
        for child in widget.winfo_children():
            walk(child)

    walk(container)


def style_section_title(section, *, role="section_title"):
    """Restyle an existing, already-built gui.Section's own title Label to this design system's font --
    the Section itself (border, divider, body, accent dot) is untouched; only the title Label's font grows.
    Relies only on gui.Section's fixed, documented child order (title bar, then a 1px divider, then body),
    not on any attribute gui.Section does not already expose."""
    head = section.winfo_children()[0]
    title_label = head.winfo_children()[-1]
    title_label.configure(font=font(role))
    return section


def info_row(parent, label, value, *, palette, status=None, label_min_px=200):
    """One label/value row at the new label/body scale -- the same visual language as the pinned
    theme._add_fact (glyph-first status, label muted, value colored only when the status is loud, wraps
    inside the row), built from the same tk.Frame/tk.Label primitives and the same existing color/glyph
    helpers (aegis_soc.theme.status_glyph/status_color/status_is_loud), just at bigger fonts. No reference
    to a built row is kept by the pinned _add_fact, so a row that must be restyled later is built here
    instead of there."""
    from aegis_soc import theme as ui_theme
    from aegis_soc.presentation import STATUS_NEUTRAL, STATUS_UNKNOWN

    status = status or STATUS_NEUTRAL
    row = tk.Frame(parent, bg=palette.panel)
    row.pack(fill="x", pady=SPACE_SM // 2)
    row.grid_columnconfigure(0, minsize=label_min_px, weight=0)
    row.grid_columnconfigure(1, minsize=28, weight=0)
    row.grid_columnconfigure(2, weight=1)
    tk.Label(row, text=label, font=font("label"), fg=palette.muted, bg=palette.panel,
             anchor="w", justify="left").grid(row=0, column=0, sticky="nw", padx=(0, SPACE_MD))
    if status != STATUS_NEUTRAL:
        tk.Label(row, text=ui_theme.status_glyph(status), font=font("card_title"),
                 fg=ui_theme.status_color(status), bg=palette.panel).grid(row=0, column=1, sticky="nw")
    if ui_theme.status_is_loud(status):
        value_color = ui_theme.status_color(status)
    elif status == STATUS_UNKNOWN:
        value_color = palette.unknown
    else:
        value_color = palette.text
    value_label = tk.Label(row, text=value, font=font("body"), fg=value_color, bg=palette.panel,
                           anchor="w", justify="left")
    value_label.grid(row=0, column=2, sticky="w")
    row.bind("<Configure>", lambda e, w=value_label: w.winfo_exists() and w.config(
        wraplength=max(200, e.width - label_min_px - 3 * SPACE_MD)), add="+")
    return row


def severity_badge(parent, text, *, palette, status):
    """A small colored dot + text badge -- the same glyph/color pairing every status already uses
    elsewhere (aegis_soc.theme.status_glyph/status_color), just at the card_title scale so it reads clearly
    as a short, loud label (e.g. a level code) rather than a quiet detail row."""
    from aegis_soc import theme as ui_theme

    row = tk.Frame(parent, bg=palette.panel)
    tk.Label(row, text=ui_theme.status_glyph(status), font=font("card_title"),
             fg=ui_theme.status_color(status), bg=palette.panel).pack(side="left", padx=(0, SPACE_SM // 2))
    tk.Label(row, text=text, font=font("card_title"), fg=ui_theme.status_color(status),
             bg=palette.panel).pack(side="left")
    return row


def explained_row(parent, label, value, meaning, *, palette, status=None):
    """An info_row (label/value, colored exactly as the caller's own verified status logic says) plus a
    short muted one-line plain-language meaning directly underneath it -- for a health-dashboard style
    page where a raw code (e.g. "HOLDOVER") means nothing to an operator without technical background.
    The meaning text is supplied entirely by the caller; this component never invents or judges it --
    callers are responsible for verifying each meaning against the real field semantics first."""
    row = info_row(parent, label, value, palette=palette, status=status)
    note = tk.Label(parent, text=meaning, anchor="w", justify="left", font=font("note"), fg=palette.muted,
                    bg=palette.panel, wraplength=900)
    note.pack(fill="x", pady=(0, SPACE_SM))
    # Wraplength is fixed at creation and the enclosing card is often much narrower than 900px once laid
    # out (e.g. one of several columns), so without this the line runs past the card's own edge instead
    # of wrapping -- the same <Configure> responsive-rewrap technique the pinned theme._add_fact already
    # uses for its value column (bound on `row`, the one full-width sibling info_row just built, which
    # tracks the card's content width exactly as the note label's own eventual width will).
    row.bind("<Configure>", lambda e, w=note: w.winfo_exists() and w.config(wraplength=max(200, e.width - 4)),
             add="+")
    return row


def empty_state(parent, *, title, detail=None, palette, bg=None, icon="○"):
    """A designed, centered empty-state block that uses the available vertical space with generous,
    balanced padding (rather than one small muted line hugging the top), for a page's "nothing to show yet"
    content area. ``icon`` reuses one of the pinned theme's own status glyphs (default: the UNKNOWN/neutral
    ring), never a new symbol set."""
    host = tk.Frame(parent, bg=bg if bg is not None else palette.panel)
    host.pack(fill="both", expand=True)
    center = tk.Frame(host, bg=host.cget("bg"))
    center.pack(expand=True, pady=(SPACE_LG * 3, SPACE_LG * 3))
    tk.Label(center, text=icon, font=("TkDefaultFont", -40), fg=palette.muted,
             bg=center.cget("bg")).pack(pady=(0, SPACE_MD))
    tk.Label(center, text=title, font=font("section_title"), fg=palette.text, bg=center.cget("bg"),
             anchor="center", justify="center", wraplength=680).pack()
    if detail:
        tk.Label(center, text=detail, font=font("note"), fg=palette.muted, bg=center.cget("bg"),
                 anchor="center", justify="center", wraplength=680).pack(pady=(SPACE_SM, 0))
    return host
