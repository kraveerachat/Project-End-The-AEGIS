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

from .branding import resolve_logo_path
from .presentation import (
    STATUS_CRITICAL,
    STATUS_HEALTHY,
    STATUS_NEUTRAL,
    STATUS_UNKNOWN,
    STATUS_WARNING,
)

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
    return STATUS_COLORS.get(status, COLOR_UNKNOWN)


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
    """การ์ดพื้นหลังเข้ม มีแถบสีคาดซ้ายบอกความหมาย"""
    def __init__(self, parent, accent=COLOR_ACCENT, **kwargs):
        super().__init__(parent, bg=COLOR_BORDER, **kwargs)
        self.inner = tk.Frame(self, bg=COLOR_PANEL)
        self.inner.pack(fill="both", expand=True, padx=(0, 1), pady=1)
        self.bar = tk.Frame(self.inner, bg=accent, width=4)
        self.bar.pack(side="left", fill="y")
        self.body = tk.Frame(self.inner, bg=COLOR_PANEL)
        self.body.pack(side="left", fill="both", expand=True)

    def set_accent(self, color):
        self.bar.config(bg=color)


class Section(tk.Frame):
    """กล่อง section มีหัวข้อคาดบน"""
    def __init__(self, parent, title, accent=COLOR_ACCENT, **kwargs):
        super().__init__(parent, bg=COLOR_PANEL, highlightbackground=COLOR_BORDER,
                          highlightthickness=1, bd=0, **kwargs)
        head = tk.Frame(self, bg=COLOR_PANEL)
        head.pack(fill="x", padx=12, pady=(8, 5))
        tk.Frame(head, bg=accent, width=3, height=14).pack(side="left", padx=(0, 8))
        tk.Label(head, text=title, font=FONT_SECTION, fg=COLOR_TEXT, bg=COLOR_PANEL).pack(side="left")
        tk.Frame(self, bg=COLOR_BORDER, height=1).pack(fill="x")
        self.body = tk.Frame(self, bg=COLOR_PANEL)
        self.body.pack(fill="both", expand=True, padx=12, pady=8)


# SectionCard is the Slice 1 name for the same pattern as Section; kept as a
# thin alias so new code can use the vocabulary from the design brief without
# a second implementation to maintain.
SectionCard = Section


class ScrollFrame(tk.Frame):
    """กล่องเลื่อนแนวตั้ง — ใส่เนื้อหาจริงใน self.inner"""
    def __init__(self, parent, **kwargs):
        super().__init__(parent, bg=COLOR_BG, **kwargs)
        self.canvas = tk.Canvas(self, bg=COLOR_BG, highlightthickness=0, bd=0)
        self.vsb = tk.Scrollbar(self, orient="vertical", command=self.canvas.yview,
                                width=10, troughcolor=COLOR_BG, bg=COLOR_BORDER,
                                activebackground=COLOR_MUTED, bd=0, relief="flat")
        self.inner = tk.Frame(self.canvas, bg=COLOR_BG)
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
    return tk.Label(parent, text=text, font=FONT_HINT, fg=COLOR_MUTED, bg=COLOR_PANEL,
                    wraplength=288, justify="left")


LOGO_MAX_HEIGHT_PX = 40   # within the requested ~36-48px header target


def load_logo_image(path=None, max_height=LOGO_MAX_HEIGHT_PX):
    """Best-effort logo loader for the header brand block.

    Returns a tk.PhotoImage, or None if no usable asset is available -- a
    missing file, an unresolved path (branding.resolve_logo_path() found
    nothing), or any load/format error. Callers MUST fall back to
    text-only branding when this returns None, and MUST keep a reference
    to the returned image alive (e.g. on the owning widget/instance) for as
    long as it is displayed, since Tkinter does not keep PhotoImage objects
    alive on its own.
    """
    resolved = path if path is not None else resolve_logo_path()
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
        outer_bg = kwargs.pop("bg", COLOR_PANEL)
        super().__init__(parent, bg=outer_bg, **kwargs)
        self._chip = tk.Frame(self, bg=COLOR_SURFACE_ELEVATED, highlightthickness=1,
                               highlightbackground=COLOR_BORDER)
        self._chip.pack()
        inner = tk.Frame(self._chip, bg=COLOR_SURFACE_ELEVATED)
        inner.pack(padx=(SPACE_SM, SPACE_SM), pady=3)
        self._dot = tk.Label(inner, text="●", font=FONT_BADGE, bg=COLOR_SURFACE_ELEVATED,
                              fg=status_color(status))
        self._dot.pack(side="left", padx=(0, 4))
        self._label = tk.Label(inner, text=text, font=FONT_BADGE, bg=COLOR_SURFACE_ELEVATED, fg=COLOR_TEXT)
        self._label.pack(side="left")

    def update_status(self, text, status):
        self._label.config(text=text)
        self._dot.config(fg=status_color(status))


class MetricCard(Card):
    """A single Overview summary card: label, large value, and an optional
    helper line. Built on top of Card so the colored accent bar continues to
    carry the semantic status."""

    def __init__(self, parent, label, value="--", status=STATUS_UNKNOWN, helper="", **kwargs):
        super().__init__(parent, accent=status_color(status), **kwargs)
        tk.Label(self.body, text=label, font=FONT_METRIC_LABEL, fg=COLOR_MUTED,
                 bg=COLOR_PANEL).pack(anchor="w", padx=SPACE_MD, pady=(SPACE_SM, 0))
        self._value_label = tk.Label(self.body, text=value, font=FONT_METRIC_VALUE,
                                      fg=status_color(status), bg=COLOR_PANEL)
        self._value_label.pack(anchor="w", padx=SPACE_MD, pady=(0, 2))
        self._helper_label = tk.Label(self.body, text=helper, font=FONT_METRIC_HELPER,
                                       fg=COLOR_MUTED, bg=COLOR_PANEL, wraplength=200,
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
        bg = COLOR_SURFACE_ELEVATED if selected else COLOR_PANEL
        super().__init__(parent, bg=COLOR_PANEL, cursor="hand2" if command else "arrow", **kwargs)
        self._bar = tk.Frame(self, bg=COLOR_ACCENT if selected else COLOR_PANEL, width=self.BAR_WIDTH)
        self._bar.pack(side="left", fill="y")
        self._row = tk.Frame(self, bg=bg)
        self._row.pack(side="left", fill="both", expand=True)
        fg = COLOR_TEXT if (selected or enabled) else COLOR_MUTED
        self._label = tk.Label(self._row, text=f"{text}{suffix}", font=FONT_NAV_ITEM, fg=fg, bg=bg,
                                anchor="w", padx=SPACE_MD, pady=SPACE_SM + 2)
        self._label.pack(fill="x")
        if command:
            for widget in (self, self._row, self._label):
                widget.bind("<Button-1>", lambda _e: command())

    def set_selected(self, selected):
        bg = COLOR_SURFACE_ELEVATED if selected else COLOR_PANEL
        self._bar.config(bg=COLOR_ACCENT if selected else COLOR_PANEL)
        self._row.config(bg=bg)
        self._label.config(bg=bg)


class PageHeader(tk.Frame):
    """Page title + subtitle + an optional environment badge (e.g. DRY RUN)."""

    def __init__(self, parent, title, subtitle="", badge_text=None, badge_status=STATUS_NEUTRAL,
                 badge_note=None, **kwargs):
        super().__init__(parent, bg=COLOR_BG, **kwargs)
        top = tk.Frame(self, bg=COLOR_BG)
        top.pack(fill="x", anchor="w")
        tk.Label(top, text=title, font=FONT_PAGE_TITLE, fg=COLOR_TEXT, bg=COLOR_BG).pack(side="left")
        if badge_text:
            badge = StatusBadge(top, text=badge_text, status=badge_status, bg=COLOR_BG)
            badge.pack(side="left", padx=(SPACE_MD, 0))
        if subtitle:
            tk.Label(self, text=subtitle, font=FONT_PAGE_SUBTITLE, fg=COLOR_MUTED,
                     bg=COLOR_BG).pack(anchor="w", pady=(2, 0))
        if badge_note:
            tk.Label(self, text=badge_note, font=FONT_HINT, fg=status_color(badge_status),
                     bg=COLOR_BG).pack(anchor="w", pady=(4, 0))


class EvidenceRow(tk.Frame):
    """One row of the Recent Activity table: TIME | SEVERITY | EVENT | SOURCE."""

    SEVERITY_COLUMN = 1

    def __init__(self, parent, time_text, severity, event_text, source, header=False, **kwargs):
        super().__init__(parent, bg=COLOR_PANEL, **kwargs)
        widths = (10, 10, 42, 12)
        values = (time_text, severity, event_text, source)
        font = FONT_METRIC_LABEL if header else FONT_HINT
        default_color = COLOR_MUTED if header else COLOR_TEXT
        severity_color = COLOR_MUTED if header else status_color(SEVERITY_STATUS.get(severity, STATUS_NEUTRAL))
        for index, (value, width) in enumerate(zip(values, widths)):
            fg = severity_color if index == self.SEVERITY_COLUMN else default_color
            tk.Label(self, text=value, font=font, fg=fg, bg=COLOR_PANEL, width=width,
                     anchor="w", justify="left").pack(side="left", padx=(0, SPACE_SM))


class EmptyState(tk.Frame):
    """Shown for navigation placeholders that are not implemented yet. Must
    never claim behavior the application does not have."""

    def __init__(self, parent, title, message, **kwargs):
        super().__init__(parent, bg=COLOR_BG, **kwargs)
        wrap = tk.Frame(self, bg=COLOR_BG)
        wrap.pack(expand=True)
        tk.Label(wrap, text=title, font=FONT_PAGE_TITLE, fg=COLOR_MUTED, bg=COLOR_BG).pack(pady=(SPACE_XL, SPACE_SM))
        tk.Label(wrap, text=message, font=FONT_PAGE_SUBTITLE, fg=COLOR_MUTED, bg=COLOR_BG,
                 wraplength=420, justify="center").pack()
