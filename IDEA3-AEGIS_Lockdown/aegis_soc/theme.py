"""
AEGIS IDEA 3 — Theme & reusable widgets (สี ฟอนต์ การ์ด)
แยกออกมาเพื่อให้ gui.py และ wizard.py ใช้ร่วมกันโดยไม่เกิด circular import

Slice 1 UX/UI refresh: adds a small design-token system (semantic status
colors, typography scale, spacing/control-height tokens) plus a handful of
reusable presentation widgets (StatusBadge, MetricCard, NavigationItem,
PageHeader, EvidenceRow, EmptyState) for the new app-shell layout in gui.py.

Every name that existed before this refresh keeps its exact meaning and
call signature -- wizard.py imports several of them directly and is not
part of this slice.
"""
import tkinter as tk
from dataclasses import dataclass

from . import theme_state
from .branding import resolve_logo_path
from .presentation import (
    STATUS_CRITICAL,
    STATUS_HEALTHY,
    STATUS_NEUTRAL,
    STATUS_UNKNOWN,
    STATUS_WARNING,
)


@dataclass(frozen=True)
class Palette:
    name: str
    background: str
    panel: str
    panel_alt: str
    surface_elevated: str
    border: str
    text: str
    muted: str
    accent: str
    danger: str
    danger_highlight: str
    success: str
    success_highlight: str
    good: str
    warn: str
    warn_highlight: str
    purple: str
    blue: str
    blue_highlight: str
    grey: str
    unknown: str
    status_colors: dict[str, str]
    level_colors: dict[str, str]


def _palette(name, *, background, panel, panel_alt, elevated, border, text, muted,
             accent, danger, danger_highlight, success, success_highlight, good,
             warn, warn_highlight, purple, blue, blue_highlight, grey, unknown):
    status_colors = {
        STATUS_HEALTHY: success_highlight,
        STATUS_WARNING: warn_highlight,
        STATUS_CRITICAL: danger_highlight,
        STATUS_UNKNOWN: unknown,
        STATUS_NEUTRAL: accent,
    }
    return Palette(
        name=name,
        background=background,
        panel=panel,
        panel_alt=panel_alt,
        surface_elevated=elevated,
        border=border,
        text=text,
        muted=muted,
        accent=accent,
        danger=danger,
        danger_highlight=danger_highlight,
        success=success,
        success_highlight=success_highlight,
        good=good,
        warn=warn,
        warn_highlight=warn_highlight,
        purple=purple,
        blue=blue,
        blue_highlight=blue_highlight,
        grey=grey,
        unknown=unknown,
        status_colors=status_colors,
        level_colors={"INFO": accent, "WARN": warn_highlight, "CRITICAL": danger_highlight},
    )


PALETTES = {
    "dark": _palette(
        "dark",
        background="#08111f", panel="#111c2e", panel_alt="#0a1424",
        elevated="#192840", border="#2b3d58", text="#f1f5f9",
        muted="#a9b7cc", accent="#60a5fa", danger="#b91c1c",
        danger_highlight="#ef4444", success="#15803d",
        success_highlight="#22c55e", good="#4ade80", warn="#b45309",
        warn_highlight="#f59e0b", purple="#a78bfa", blue="#2563eb",
        blue_highlight="#3b82f6", grey="#a9b7cc", unknown="#8292aa",
    ),
    "light": _palette(
        "light",
        background="#edf2f7", panel="#ffffff", panel_alt="#e5ecf4",
        elevated="#f4f7fb", border="#cbd6e3", text="#13213a",
        muted="#52657f", accent="#2563eb", danger="#b91c1c",
        danger_highlight="#dc2626", success="#15803d",
        success_highlight="#16803b", good="#15803d", warn="#a45108",
        warn_highlight="#b45309", purple="#6d28d9", blue="#1d4ed8",
        blue_highlight="#2563eb", grey="#52657f", unknown="#64748b",
    ),
}


def get_palette(name=None):
    """Return the selected immutable palette; unknown values fail to dark."""

    selected = theme_state.get_theme() if name is None else name
    return PALETTES.get(selected, PALETTES["dark"])

# ---------------------------------------------------------------------------
# Legacy color/font names (kept byte-for-byte compatible with wizard.py).
# Values are tuned toward a restrained enterprise SOC palette; semantics are
# unchanged (COLOR_DANGER still means real danger, COLOR_SUCCESS still means
# healthy/safe, etc).
# ---------------------------------------------------------------------------
COLOR_BG        = "#0b1220"   # app background: near-black navy
COLOR_PANEL     = "#151f32"   # surface
COLOR_PANEL_ALT = "#0a0f1a"
COLOR_BORDER    = "#263349"   # subtle slate border
COLOR_TEXT      = "#e2e8f0"
COLOR_MUTED     = "#7c8aa5"
COLOR_ACCENT    = "#38bdf8"   # primary blue/cyan
COLOR_DANGER    = "#dc2626"   # critical / destructive red -- never decorative
COLOR_DANGER_HL = "#ef4444"
COLOR_SUCCESS   = "#16a34a"   # healthy green
COLOR_SUCCESS_HL= "#22c55e"
COLOR_GOOD      = "#4ade80"
COLOR_WARN      = "#d97706"   # warning amber
COLOR_WARN_HL   = "#f59e0b"
COLOR_PURPLE    = "#c084fc"
COLOR_BLUE      = "#2563eb"
COLOR_BLUE_HL   = "#3b82f6"
COLOR_GREY      = "#94a3b8"

# ---------------------------------------------------------------------------
# New semantic tokens for Slice 1.
# ---------------------------------------------------------------------------
COLOR_SURFACE          = COLOR_PANEL
COLOR_SURFACE_ELEVATED = "#1c2942"   # slightly lighter than COLOR_SURFACE
COLOR_UNKNOWN          = "#64748b"   # slate/blue-gray for "insufficient evidence"

# Status keys (STATUS_HEALTHY etc.) live in presentation.py so that module
# has no tkinter dependency; this table just maps them to actual colors.
STATUS_COLORS = {
    STATUS_HEALTHY:  COLOR_SUCCESS_HL,
    STATUS_WARNING:  COLOR_WARN_HL,
    STATUS_CRITICAL: COLOR_DANGER_HL,
    STATUS_UNKNOWN:  COLOR_UNKNOWN,
    STATUS_NEUTRAL:  COLOR_ACCENT,
}

# Severity labels (as stored in audit_logs.level) reuse the same palette so
# the Recent Activity / log views stay visually consistent with the metric
# cards above them.
SEVERITY_STATUS = {
    "INFO": STATUS_NEUTRAL,
    "WARN": STATUS_WARNING,
    "CRITICAL": STATUS_CRITICAL,
}


def status_color(status):
    palette = get_palette()
    return palette.status_colors.get(status, palette.unknown)


# สีของ log ตามระดับความรุนแรง (kept for the existing ScrolledText tag_config
# call sites; values now derive from the shared status palette).
LEVEL_COLORS = {"INFO": "#7dd3fc", "WARN": COLOR_WARN_HL, "CRITICAL": COLOR_DANGER_HL}

FONT_TITLE   = ("Segoe UI", 15, "bold")
FONT_SUB     = ("Segoe UI", 9)
FONT_SECTION = ("Segoe UI", 10, "bold")
FONT_BTN     = ("Segoe UI", 10, "bold")
FONT_BTN_SM  = ("Segoe UI", 9, "bold")
FONT_HINT    = ("Segoe UI", 8)
FONT_MONO    = ("Consolas", 9)

# New typography scale for the app-shell / Overview page.
FONT_PAGE_TITLE   = ("Segoe UI", 18, "bold")
FONT_PAGE_SUBTITLE= ("Segoe UI", 10)
FONT_METRIC_VALUE = ("Segoe UI", 20, "bold")
FONT_METRIC_LABEL = ("Segoe UI", 9)
FONT_METRIC_HELPER= ("Segoe UI", 8)
FONT_NAV_ITEM     = ("Segoe UI", 10)
FONT_BADGE        = ("Segoe UI", 8, "bold")
FONT_CLOCK        = ("Segoe UI", 14, "bold")

# Spacing tokens (px).
SPACE_XS = 4
SPACE_SM = 8
SPACE_MD = 12
SPACE_LG = 16
SPACE_XL = 24

# Layout tokens.
NAV_WIDTH = 232
CONTROL_HEIGHT = 2   # existing tk.Button "height" convention (text lines)


class Card(tk.Frame):
    """Theme-aware elevated surface with a restrained semantic top rule."""

    def __init__(self, parent, accent=None, **kwargs):
        palette = get_palette()
        accent = accent or palette.accent
        super().__init__(
            parent,
            bg=palette.panel,
            highlightbackground=palette.border,
            highlightthickness=1,
            bd=0,
            **kwargs,
        )
        self.inner = tk.Frame(self, bg=palette.panel)
        self.inner.pack(fill="both", expand=True)
        self.bar = tk.Frame(self.inner, bg=accent, height=2)
        self.bar.pack(side="top", fill="x")
        self.body = tk.Frame(self.inner, bg=palette.panel)
        self.body.pack(side="top", fill="both", expand=True)

    def set_accent(self, color):
        self.bar.config(bg=color)


class Section(tk.Frame):
    """กล่อง section มีหัวข้อคาดบน"""
    def __init__(self, parent, title, accent=None, **kwargs):
        palette = get_palette()
        accent = accent or palette.accent
        super().__init__(parent, bg=palette.panel, highlightbackground=palette.border,
                          highlightthickness=1, bd=0, **kwargs)
        head = tk.Frame(self, bg=palette.panel)
        head.pack(fill="x", padx=12, pady=(8, 5))
        tk.Label(head, text="●", font=FONT_BADGE, fg=accent, bg=palette.panel).pack(
            side="left", padx=(0, 8)
        )
        tk.Label(head, text=title, font=FONT_SECTION, fg=palette.text, bg=palette.panel).pack(side="left")
        tk.Frame(self, bg=palette.border, height=1).pack(fill="x")
        self.body = tk.Frame(self, bg=palette.panel)
        self.body.pack(fill="both", expand=True, padx=12, pady=8)


# SectionCard is the Slice 1 name for the same pattern as Section; kept as a
# thin alias so new code can use the vocabulary from the design brief without
# a second implementation to maintain.
SectionCard = Section


class ScrollFrame(tk.Frame):
    """กล่องเลื่อนแนวตั้ง — ใส่เนื้อหาจริงใน self.inner"""
    def __init__(self, parent, **kwargs):
        palette = get_palette()
        super().__init__(parent, bg=palette.background, **kwargs)
        self.canvas = tk.Canvas(self, bg=palette.background, highlightthickness=0, bd=0)
        self.vsb = tk.Scrollbar(self, orient="vertical", command=self.canvas.yview,
                                width=10, troughcolor=palette.background, bg=palette.border,
                                activebackground=palette.muted, bd=0, relief="flat")
        self.inner = tk.Frame(self.canvas, bg=palette.background)
        self.inner.bind("<Configure>",
                        lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self._win = self.canvas.create_window((0, 0), window=self.inner, anchor="nw")
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfig(self._win, width=e.width))
        self.canvas.configure(yscrollcommand=self.vsb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.vsb.pack(side="right", fill="y")
        for seq in ("<Button-4>", "<Button-5>", "<MouseWheel>"):
            self.canvas.bind_all(seq, self._on_wheel)

    def _on_wheel(self, event):
        if getattr(event, "num", None) == 4:
            self.canvas.yview_scroll(-1, "units")
        elif getattr(event, "num", None) == 5:
            self.canvas.yview_scroll(1, "units")
        elif getattr(event, "delta", 0):
            self.canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")


def make_hint(parent, text):
    palette = get_palette()
    return tk.Label(parent, text=text, font=FONT_HINT, fg=palette.muted, bg=palette.panel,
                    wraplength=288, justify="left")


LOGO_MAX_HEIGHT_PX = 40   # within the requested ~36-48px header target


def load_logo_image(path=None, max_height=LOGO_MAX_HEIGHT_PX, theme_name=None):
    """Best-effort logo loader for the header brand block.

    Returns a tk.PhotoImage, or None if no usable asset is available -- a
    missing file, an unresolved path (branding.resolve_logo_path() found
    nothing), or any load/format error. Callers MUST fall back to
    text-only branding when this returns None, and MUST keep a reference
    to the returned image alive (e.g. on the owning widget/instance) for as
    long as it is displayed, since Tkinter does not keep PhotoImage objects
    alive on its own.
    """
    resolved = path if path is not None else resolve_logo_path(theme=theme_name or theme_state.get_theme())
    if not resolved:
        return None
    try:
        image = tk.PhotoImage(file=resolved)
    except Exception:
        return None
    height = image.height()
    if height > max_height > 0:
        factor = max(1, round(height / max_height))
        try:
            image = image.subsample(factor, factor)
        except Exception:
            return None
    return image


# ---------------------------------------------------------------------------
# Slice 1 presentation widgets. Business/control logic stays in gui.py; these
# widgets only render values handed to them and never publish MQTT, touch the
# controller, or issue commands themselves.
# ---------------------------------------------------------------------------

class StatusBadge(tk.Frame):
    """A compact status chip: a colored dot plus a short text label, in a
    subtly bordered pill so it reads as a distinct control rather than
    floating text. Never relies on color alone -- the text always names the
    actual state."""

    def __init__(self, parent, text="", status=STATUS_UNKNOWN, **kwargs):
        palette = get_palette()
        outer_bg = kwargs.pop("bg", palette.panel)
        super().__init__(parent, bg=outer_bg, **kwargs)
        self._chip = tk.Frame(self, bg=palette.surface_elevated, highlightthickness=1,
                               highlightbackground=palette.border)
        self._chip.pack()
        inner = tk.Frame(self._chip, bg=palette.surface_elevated)
        inner.pack(padx=(SPACE_SM, SPACE_SM), pady=3)
        self._dot = tk.Label(inner, text="●", font=FONT_BADGE, bg=palette.surface_elevated,
                              fg=status_color(status))
        self._dot.pack(side="left", padx=(0, 4))
        self._label = tk.Label(inner, text=text, font=FONT_BADGE, bg=palette.surface_elevated, fg=palette.text)
        self._label.pack(side="left")

    def update_status(self, text, status):
        self._label.config(text=text)
        self._dot.config(fg=status_color(status))


class MetricCard(Card):
    """A single Overview summary card: label, large value, and an optional
    helper line. Built on top of Card so the colored accent bar continues to
    carry the semantic status."""

    def __init__(self, parent, label, value="--", status=STATUS_UNKNOWN, helper="", **kwargs):
        palette = get_palette()
        super().__init__(parent, accent=status_color(status), **kwargs)
        tk.Label(self.body, text=label, font=FONT_METRIC_LABEL, fg=palette.muted,
                 bg=palette.panel).pack(anchor="w", padx=SPACE_MD, pady=(SPACE_SM, 0))
        self._value_label = tk.Label(self.body, text=value, font=FONT_METRIC_VALUE,
                                      fg=status_color(status), bg=palette.panel)
        self._value_label.pack(anchor="w", padx=SPACE_MD, pady=(0, 2))
        self._helper_label = tk.Label(self.body, text=helper, font=FONT_METRIC_HELPER,
                                       fg=palette.muted, bg=palette.panel, wraplength=200,
                                       justify="left")
        self._helper_label.pack(anchor="w", padx=SPACE_MD, pady=(0, SPACE_SM))

    def update(self, value, status, helper=""):
        color = status_color(status)
        self._value_label.config(text=value, fg=color)
        self._helper_label.config(text=helper)
        self.set_accent(color)


class NavigationItem(tk.Frame):
    """One row in the left navigation rail, with a left accent bar marking
    the selected item (the same visual language MetricCard/Card use for
    status) rather than relying on background color alone. `enabled=False`
    renders it as a reachable-but-placeholder item (never claims
    functionality that does not exist yet); it still invokes `command` so
    the workspace can show an explicit EmptyState rather than doing
    nothing."""

    BAR_WIDTH = 3

    def __init__(self, parent, text, command=None, selected=False, enabled=True, suffix="", **kwargs):
        palette = get_palette()
        self._palette = palette
        bg = palette.surface_elevated if selected else palette.panel
        super().__init__(parent, bg=palette.panel, cursor="hand2" if command else "arrow", **kwargs)
        self._bar = tk.Frame(self, bg=palette.accent if selected else palette.panel, width=self.BAR_WIDTH)
        self._bar.pack(side="left", fill="y")
        self._row = tk.Frame(self, bg=bg)
        self._row.pack(side="left", fill="both", expand=True)
        fg = palette.text if (selected or enabled) else palette.muted
        self._label = tk.Label(self._row, text=f"{text}{suffix}", font=FONT_NAV_ITEM, fg=fg, bg=bg,
                                anchor="w", padx=SPACE_MD, pady=SPACE_SM + 2)
        self._label.pack(fill="x")
        if command:
            for widget in (self, self._row, self._label):
                widget.bind("<Button-1>", lambda _e: command())

    def set_selected(self, selected):
        bg = self._palette.surface_elevated if selected else self._palette.panel
        self._bar.config(bg=self._palette.accent if selected else self._palette.panel)
        self._row.config(bg=bg)
        self._label.config(bg=bg)


class PageHeader(tk.Frame):
    """Page title + subtitle + an optional environment badge (e.g. DRY RUN)."""

    def __init__(self, parent, title, subtitle="", badge_text=None, badge_status=STATUS_NEUTRAL,
                 badge_note=None, **kwargs):
        palette = get_palette()
        super().__init__(parent, bg=palette.background, **kwargs)
        top = tk.Frame(self, bg=palette.background)
        top.pack(fill="x", anchor="w")
        tk.Label(top, text=title, font=FONT_PAGE_TITLE, fg=palette.text, bg=palette.background).pack(side="left")
        if badge_text:
            badge = StatusBadge(top, text=badge_text, status=badge_status, bg=palette.background)
            badge.pack(side="left", padx=(SPACE_MD, 0))
        if subtitle:
            tk.Label(self, text=subtitle, font=FONT_PAGE_SUBTITLE, fg=palette.muted,
                     bg=palette.background).pack(anchor="w", pady=(2, 0))
        if badge_note:
            tk.Label(self, text=badge_note, font=FONT_HINT, fg=status_color(badge_status),
                     bg=palette.background).pack(anchor="w", pady=(4, 0))


class EvidenceRow(tk.Frame):
    """One row of the Recent Activity table: TIME | SEVERITY | EVENT | SOURCE."""

    SEVERITY_COLUMN = 1

    def __init__(self, parent, time_text, severity, event_text, source, header=False, **kwargs):
        palette = get_palette()
        super().__init__(parent, bg=palette.panel, **kwargs)
        widths = (10, 10, 42, 12)
        values = (time_text, severity, event_text, source)
        font = FONT_METRIC_LABEL if header else FONT_HINT
        default_color = palette.muted if header else palette.text
        severity_color = palette.muted if header else status_color(SEVERITY_STATUS.get(severity, STATUS_NEUTRAL))
        for index, (value, width) in enumerate(zip(values, widths)):
            fg = severity_color if index == self.SEVERITY_COLUMN else default_color
            tk.Label(self, text=value, font=font, fg=fg, bg=palette.panel, width=width,
                     anchor="w", justify="left").pack(side="left", padx=(0, SPACE_SM))


class EmptyState(tk.Frame):
    """Shown for navigation placeholders that are not implemented yet. Must
    never claim behavior the application does not have."""

    def __init__(self, parent, title, message, **kwargs):
        palette = get_palette()
        super().__init__(parent, bg=palette.background, **kwargs)
        wrap = tk.Frame(self, bg=palette.background)
        wrap.pack(expand=True)
        tk.Label(wrap, text=title, font=FONT_PAGE_TITLE, fg=palette.muted, bg=palette.background).pack(pady=(SPACE_XL, SPACE_SM))
        tk.Label(wrap, text=message, font=FONT_PAGE_SUBTITLE, fg=palette.muted, bg=palette.background,
                 wraplength=420, justify="center").pack()
