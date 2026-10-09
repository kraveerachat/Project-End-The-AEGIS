"""
AEGIS IDEA 3 — Theme & reusable widgets (สี ฟอนต์ การ์ด)
แยกออกมาเพื่อให้ gui.py และ wizard.py ใช้ร่วมกันโดยไม่เกิด circular import

Neo refresh: the colors, spacing and type roles now come from
``design_tokens`` (the desktop translation of the IDEA3 Web "Security Center
Neo" layer), and this module turns them into Tk primitives: a Palette, named
fonts, shape-coded status glyphs, button variants, dialog theming and the
presentation widgets (StatusBadge, MetricCard, NavigationItem, PageHeader,
EvidenceRow, EmptyState, InlineAlert) used by the app shell in gui.py.

Every name that existed before this refresh keeps its meaning and call
signature -- wizard.py imports several of them directly. Nothing here
publishes MQTT, touches the controller, or issues a command: widgets render
values handed to them and report clicks to callbacks the caller owns.
"""
import tkinter as tk
import tkinter.font as tkfont
from dataclasses import dataclass
from tkinter import ttk

from . import design_tokens as tokens
from . import theme_state
from .branding import resolve_logo_path, resolve_scaled_logo_path
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
    border_strong: str
    text: str
    text_secondary: str
    muted: str
    accent: str
    accent_hover: str
    accent_soft: str
    accent_fill: str
    accent_fill_hover: str
    on_accent: str
    info: str
    info_soft: str
    danger: str
    danger_hover: str
    danger_highlight: str
    danger_text: str
    danger_soft: str
    success: str
    success_hover: str
    success_highlight: str
    success_soft: str
    good: str
    warn: str
    warn_hover: str
    warn_highlight: str
    warning_soft: str
    purple: str
    blue: str
    blue_highlight: str
    grey: str
    unknown: str
    status_colors: dict[str, str]
    level_colors: dict[str, str]


def _palette(name):
    c = tokens.COLORS[name]
    return Palette(
        name=name,
        background=c["background"],
        panel=c["panel"],
        panel_alt=c["panel_alt"],
        surface_elevated=c["surface_elevated"],
        border=c["border"],
        border_strong=c["border_strong"],
        text=c["text"],
        text_secondary=c["text_secondary"],
        muted=c["muted"],
        accent=c["accent"],
        accent_hover=c["accent_hover"],
        accent_soft=c["accent_soft"],
        accent_fill=c["accent_fill"],
        accent_fill_hover=c["accent_fill_hover"],
        on_accent=c["on_accent"],
        info=c["info"],
        info_soft=c["info_soft"],
        danger=c["danger"],
        danger_hover=c["danger_hover"],
        danger_highlight=c["danger_text"],
        danger_text=c["danger_text"],
        danger_soft=c["danger_soft"],
        success=c["success"],
        success_hover=c["success_hover"],
        success_highlight=c["success_text"],
        success_soft=c["success_soft"],
        good=c["success_text"],
        warn=c["warning"],
        warn_hover=c["warning_hover"],
        warn_highlight=c["warning_text"],
        warning_soft=c["warning_soft"],
        # Decorative purple/blue are retired as separate hues; the names stay
        # so older call sites keep working, but they resolve to the one accent
        # (violet) and the link blue rather than introducing more colors.
        purple=c["accent"],
        blue=c["accent_2_fill"],
        blue_highlight=c["accent_2"],
        grey=c["muted"],
        unknown=c["unknown"],
        status_colors={
            STATUS_HEALTHY: c["success_text"],
            STATUS_WARNING: c["warning_text"],
            STATUS_CRITICAL: c["danger_text"],
            STATUS_UNKNOWN: c["unknown"],
            STATUS_NEUTRAL: c["accent"],
        },
        # INFO log lines stay calm (secondary ink); only WARN/CRITICAL carry color.
        level_colors={"INFO": c["text_secondary"], "WARN": c["warning_text"], "CRITICAL": c["danger_text"]},
    )


PALETTES = {name: _palette(name) for name in tokens.COLORS}


def get_palette(name=None):
    """Return the selected immutable palette; unknown values fail to dark."""

    selected = theme_state.get_theme() if name is None else name
    return PALETTES.get(selected, PALETTES["dark"])

# ---------------------------------------------------------------------------
# Legacy color names (kept compatible with wizard.py, which imports them).
# They are the dark palette; gui.py/wizard.py refresh them through their
# `_sync_palette_aliases()` whenever the theme changes.
# ---------------------------------------------------------------------------
_DARK = PALETTES["dark"]
COLOR_BG        = _DARK.background
COLOR_PANEL     = _DARK.panel
COLOR_PANEL_ALT = _DARK.panel_alt
COLOR_BORDER    = _DARK.border
COLOR_TEXT      = _DARK.text
COLOR_MUTED     = _DARK.muted
COLOR_ACCENT    = _DARK.accent
COLOR_DANGER    = _DARK.danger             # critical / destructive red -- never decorative
COLOR_DANGER_HL = _DARK.danger_highlight
COLOR_SUCCESS   = _DARK.success
COLOR_SUCCESS_HL = _DARK.success_highlight
COLOR_GOOD      = _DARK.good
COLOR_WARN      = _DARK.warn
COLOR_WARN_HL   = _DARK.warn_highlight
COLOR_PURPLE    = _DARK.purple
COLOR_BLUE      = _DARK.blue
COLOR_BLUE_HL   = _DARK.blue_highlight
COLOR_GREY      = _DARK.grey

COLOR_SURFACE          = COLOR_PANEL
COLOR_SURFACE_ELEVATED = _DARK.surface_elevated
COLOR_UNKNOWN          = _DARK.unknown     # "insufficient evidence"

# Status keys (STATUS_HEALTHY etc.) live in presentation.py so that module
# has no tkinter dependency; this table just maps them to actual colors.
STATUS_COLORS = dict(_DARK.status_colors)

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


# Every semantic status has its own SHAPE as well as its own color, so state
# is never carried by color alone (the Web layer does the same with border
# styles). An unmapped status reads as UNKNOWN, never as healthy.
STATUS_GLYPHS = {
    STATUS_HEALTHY: "●",
    STATUS_WARNING: "▲",
    STATUS_CRITICAL: "■",
    STATUS_UNKNOWN: "○",
    STATUS_NEUTRAL: "◆",
}


def status_glyph(status):
    return STATUS_GLYPHS.get(status, STATUS_GLYPHS[STATUS_UNKNOWN])


def status_is_loud(status):
    """Whether a status should visibly demand attention (tinted border, rule
    and value). Healthy, neutral and unknown stay quiet so color appears where
    it carries meaning instead of decorating every card. A status this module
    does not recognise is treated as loud -- never mistaken for calm."""
    return status not in (STATUS_HEALTHY, STATUS_NEUTRAL, STATUS_UNKNOWN)


# สีของ log ตามระดับความรุนแรง (kept for the existing ScrolledText tag_config
# call sites; values derive from the shared palette).
LEVEL_COLORS = dict(_DARK.level_colors)

# ---------------------------------------------------------------------------
# Typography. Fonts are Tk *named* fonts ("aegis.<role>"): call sites pass
# the name as a plain string, and init_fonts() points every role at the best
# installed family once a Tk root exists -- so a font change needs no edits
# at the call sites, and Thai/Chinese glyphs fall back per character.
# ---------------------------------------------------------------------------

def font_name(role):
    return f"aegis.{role}"


FONT_DISPLAY       = font_name("display")
FONT_LOGIN_TITLE   = font_name("title")
FONT_TITLE         = font_name("brand")
FONT_SUB           = font_name("label")
FONT_SECTION       = font_name("section_title")
FONT_CARD_TITLE    = font_name("card_title")
FONT_BODY          = font_name("body")
FONT_LABEL         = font_name("label")
FONT_BTN           = font_name("button")
FONT_BTN_SM        = font_name("button_small")
FONT_HINT          = font_name("caption")
FONT_MONO          = font_name("mono")
FONT_MONO_SMALL    = font_name("mono_small")
FONT_KICKER        = font_name("kicker")

FONT_PAGE_TITLE    = font_name("page_title")
FONT_PAGE_SUBTITLE = font_name("body")
FONT_METRIC_VALUE  = font_name("metric")
FONT_METRIC_LABEL  = font_name("label")
FONT_METRIC_HELPER = font_name("caption")
FONT_NAV_ITEM      = font_name("nav")
FONT_BADGE         = font_name("badge")
FONT_CLOCK         = font_name("clock")

_TK_DEFAULT_FONTS = ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont", "TkCaptionFont",
                     "TkSmallCaptionFont", "TkIconFont", "TkTooltipFont")


def init_fonts(root):
    """Create/refresh the named fonts on `root` and return the families used.

    Safe to call repeatedly and once per Tk interpreter (a new root is a new
    interpreter, so its named fonts start empty). Also points Tk's own default
    fonts at the same families, so native dialogs and menu popups match.
    """
    available = set(tkfont.families(root))
    sans = tokens.resolve_family(tokens.SANS_CANDIDATES, available, "TkDefaultFont")
    mono = tokens.resolve_family(tokens.MONO_CANDIDATES, available, "TkFixedFont")
    families = {"sans": sans, "mono": mono}
    existing = set(root.tk.splitlist(root.tk.call("font", "names")))
    for role, (kind, size, weight) in tokens.FONT_ROLES.items():
        name = font_name(role)
        options = ("-family", families[kind], "-size", size, "-weight", weight)
        # `font create` rather than tkinter.font.Font(): a Font object deletes
        # its named font when garbage-collected, which silently turned every
        # role back into the default font. A Tk-level named font lives as long
        # as the interpreter.
        root.tk.call("font", "configure" if name in existing else "create", name, *options)
    for name in _TK_DEFAULT_FONTS:
        try:
            root.tk.call("font", "configure", name, "-family", sans, "-size", tokens.FONT_ROLES["body"][1])
        except tk.TclError:
            pass
    try:
        root.tk.call("font", "configure", "TkFixedFont", "-family", mono, "-size", tokens.FONT_ROLES["mono"][1])
    except tk.TclError:
        pass
    return families


# Spacing tokens (px).
SPACE_XS = tokens.SPACING["xs"]
SPACE_SM = tokens.SPACING["sm"]
SPACE_MD = tokens.SPACING["md"]
SPACE_LG = tokens.SPACING["lg"]
SPACE_XL = tokens.SPACING["xl"]

# Layout tokens.
NAV_WIDTH = 232


def card_columns(width, choices, min_card_px):
    """Column count for an equal-width card grid: the widest entry of
    `choices` (widest first) whose cards stay at least `min_card_px` wide at
    `width`, else the narrowest. Pure, so the responsive rule is testable."""
    return next((count for count in choices if width >= count * min_card_px), choices[-1])


CONTROL_HEIGHT = 2   # existing tk.Button "height" convention (text lines)


# ---------------------------------------------------------------------------
# Buttons. One factory, five variants, so a destructive control can never
# look like a primary one and no screen hand-rolls its own colors. Hover is
# Tk's own activebackground (no event bindings, no timers); keyboard focus
# shows as an accent ring.
# ---------------------------------------------------------------------------
BUTTON_VARIANTS = tokens.BUTTON_VARIANTS


def button_style(variant, palette=None):
    """Colors for a button variant (see design_tokens.button_colors)."""
    palette = palette or get_palette()
    return tokens.button_colors(variant, tokens.COLORS[palette.name])


def button_disabled_style(palette=None):
    """One disabled look for every variant: a disabled CUT must read as
    unavailable, not as a dimmed red button that still appears to hold authority."""
    palette = palette or get_palette()
    return tokens.button_disabled_colors(tokens.COLORS[palette.name])


def make_button(parent, text, command, variant="secondary", *, small=False, large=False, **overrides):
    """A themed tk.Button. `command` is called exactly as tk.Button would."""
    palette = get_palette()
    options = {
        "text": text,
        "command": command,
        "font": FONT_BTN_SM if small else FONT_BTN,
        "bd": 0,
        "relief": "flat",
        "cursor": "hand2",
        "highlightthickness": 2,
        "padx": SPACE_MD,
        "pady": SPACE_XS + 1 if small else (SPACE_MD - 1 if large else SPACE_SM - 1),
        **button_style(variant, palette),
        "disabledforeground": palette.muted,
    }
    options.update(overrides)
    button = tk.Button(parent, **options)
    button._aegis_variant = variant
    return button


def set_button_variant(button, variant):
    """Re-style a make_button() button as another variant (e.g. the Arm
    control, which reads as a warning while armed and as a success when it
    would re-arm). Leaves state/command untouched."""
    if not button.winfo_exists():
        return
    button._aegis_variant = variant
    if str(button.cget("state")) != "disabled":
        button.config(**button_style(variant, get_palette()))


def set_button_enabled(button, enabled):
    """Enable/disable a make_button() button with a matching look. Purely
    visual state: the caller still decides *whether* an action is allowed."""
    if not button.winfo_exists():
        return
    if enabled:
        style = button_style(getattr(button, "_aegis_variant", "secondary"), get_palette())
        button.config(state="normal", **style)
    else:
        button.config(state="disabled", **button_disabled_style(get_palette()))


def style_option_menu(menu, *, width=None):
    """Theme a tk.OptionMenu and its popup so dropdowns match the shell."""
    palette = get_palette()
    options = dict(
        font=FONT_HINT, bg=palette.surface_elevated, fg=palette.text,
        activebackground=palette.border_strong, activeforeground=palette.text,
        highlightthickness=1, highlightbackground=palette.border, highlightcolor=palette.accent_hover,
        bd=0, relief="flat", cursor="hand2",
    )
    if width:
        options["width"] = width
    menu.config(**options)
    menu["menu"].config(bg=palette.panel, fg=palette.text, activebackground=palette.accent_soft,
                        activeforeground=palette.accent, bd=0, font=FONT_HINT)


def style_scrolledtext(widget):
    """Theme a ScrolledText (well, caret, selection and scrollbar)."""
    palette = get_palette()
    widget.config(bg=palette.panel_alt, fg=palette.text, insertbackground=palette.text, font=FONT_MONO_SMALL,
                  selectbackground=palette.accent_soft, selectforeground=palette.text, bd=0, relief="flat",
                  highlightthickness=1, highlightbackground=palette.border, highlightcolor=palette.accent_hover,
                  padx=SPACE_SM, pady=SPACE_SM)
    try:
        widget.vbar.config(width=10, troughcolor=palette.background, bg=palette.border,
                           activebackground=palette.muted, bd=0, relief="flat")
    except (AttributeError, tk.TclError):
        pass


def apply_dialog_theme(root):
    """Make Tk's built-in dialogs (simpledialog prompts, messagebox) and the
    popup menus follow the active palette instead of the stock Tk look.

    Affects only appearance: it adds option-database defaults and restyles
    ttk widgets (which the application itself does not otherwise use). Every
    prompt, message and confirmation string stays exactly as the caller
    supplied it.
    """
    palette = get_palette()
    root.config(bg=palette.background)
    db = root.option_add
    priority = 60
    for pattern, value in (
        ("*Toplevel.background", palette.background),
        ("*Toplevel*Frame.background", palette.background),
        ("*Toplevel*Label.background", palette.background),
        ("*Toplevel*Label.foreground", palette.text),
        ("*Toplevel*Message.background", palette.background),
        ("*Toplevel*Message.foreground", palette.text),
        ("*Toplevel*Button.background", palette.surface_elevated),
        ("*Toplevel*Button.foreground", palette.text),
        ("*Toplevel*Button.activeBackground", palette.border_strong),
        ("*Toplevel*Button.activeForeground", palette.text),
        ("*Toplevel*Button.highlightBackground", palette.background),
        ("*Toplevel*Entry.background", palette.panel_alt),
        ("*Toplevel*Entry.foreground", palette.text),
        ("*Toplevel*Entry.insertBackground", palette.text),
        ("*Toplevel*Entry.highlightBackground", palette.border),
        ("*Toplevel*Entry.highlightColor", palette.accent_hover),
        ("*Menu.background", palette.panel),
        ("*Menu.foreground", palette.text),
        ("*Menu.activeBackground", palette.accent_soft),
        ("*Menu.activeForeground", palette.accent),
    ):
        db(pattern, value, priority)
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except tk.TclError:
        pass
    style.configure(".", background=palette.background, foreground=palette.text, font=FONT_BODY,
                    bordercolor=palette.border, lightcolor=palette.border, darkcolor=palette.border,
                    troughcolor=palette.panel_alt, focuscolor=palette.accent_hover)
    style.configure("TFrame", background=palette.background)
    style.configure("TLabel", background=palette.background, foreground=palette.text, font=FONT_BODY)
    style.configure("TButton", background=palette.surface_elevated, foreground=palette.text, font=FONT_BTN_SM,
                    bordercolor=palette.border_strong, padding=(SPACE_LG, SPACE_SM - 2), relief="flat")
    style.map("TButton",
              background=[("active", palette.border_strong), ("pressed", palette.border_strong)],
              foreground=[("disabled", palette.muted)],
              bordercolor=[("focus", palette.accent_hover)])
    style.configure("TEntry", fieldbackground=palette.panel_alt, foreground=palette.text,
                    insertcolor=palette.text, bordercolor=palette.border)


class Card(tk.Frame):
    """Theme-aware elevated surface with a semantic top rule. A card that
    needs attention also tints its border (see set_tone); a quiet card keeps
    a neutral border and rule so color is reserved for meaning."""

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

    def set_tone(self, rule_color, border_color):
        self.bar.config(bg=rule_color)
        self.config(highlightbackground=border_color)


class Section(tk.Frame):
    """กล่อง section มีหัวข้อคาดบน

    `accent` marks a *semantic* section (warning, danger...). The marker dot
    is drawn only when the accent differs from the default, so ordinary
    sections stay quiet; `emphasis=True` additionally tints the border.
    """
    def __init__(self, parent, title, accent=None, emphasis=False, **kwargs):
        palette = get_palette()
        semantic = accent is not None and accent != palette.accent
        accent = accent or palette.accent
        super().__init__(parent, bg=palette.panel,
                         highlightbackground=accent if (emphasis and semantic) else palette.border,
                         highlightthickness=1, bd=0, **kwargs)
        head = tk.Frame(self, bg=palette.panel)
        head.pack(fill="x", padx=SPACE_MD, pady=(SPACE_SM, SPACE_SM - 2))
        if semantic:
            tk.Label(head, text="●", font=FONT_BADGE, fg=accent, bg=palette.panel).pack(
                side="left", padx=(0, SPACE_SM)
            )
        tk.Label(head, text=title, font=FONT_SECTION, fg=palette.text, bg=palette.panel).pack(side="left")
        tk.Frame(self, bg=palette.border, height=1).pack(fill="x")
        self.body = tk.Frame(self, bg=palette.panel)
        self.body.pack(fill="both", expand=True, padx=SPACE_MD, pady=SPACE_SM)


# SectionCard is the Slice 1 name for the same pattern as Section; kept as a
# thin alias so new code can use the vocabulary from the design brief without
# a second implementation to maintain.
SectionCard = Section


class ScrollFrame(tk.Frame):
    """กล่องเลื่อนแนวตั้ง — ใส่เนื้อหาจริงใน self.inner

    Mouse-wheel scrolling goes through one application-wide dispatcher that
    scrolls whichever ScrollFrame is under the pointer. Each frame used to
    install its own bind_all handler, so after a page switch, a rebuild or a
    closed panel the surviving handler belonged to a destroyed canvas: the
    wheel either raised TclError or scrolled nothing in the live page.
    """
    def __init__(self, parent, **kwargs):
        palette = get_palette()
        super().__init__(parent, bg=palette.background, **kwargs)
        self.canvas = tk.Canvas(self, bg=palette.background, highlightthickness=0, bd=0)
        self.canvas._aegis_scroll_frame = self
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
        root = self._root()
        if not getattr(root, "_aegis_wheel_bound", False):
            root._aegis_wheel_bound = True
            for seq in ("<Button-4>", "<Button-5>", "<MouseWheel>"):
                root.bind_all(seq, _dispatch_wheel, add="+")


def _scroll_frame_at(widget):
    """The innermost ScrollFrame containing `widget`, or None."""
    while widget is not None:
        frame = getattr(widget, "_aegis_scroll_frame", None)
        if frame is not None:
            return frame
        widget = getattr(widget, "master", None)
    return None


def _dispatch_wheel(event):
    try:
        under_pointer = event.widget.winfo_containing(event.x_root, event.y_root)
    except (tk.TclError, KeyError, AttributeError):
        return
    frame = _scroll_frame_at(under_pointer)
    if frame is None or not frame.canvas.winfo_exists():
        return
    if frame.canvas.yview() == (0.0, 1.0):
        return   # everything already fits; nothing to scroll
    if getattr(event, "num", None) == 4:
        frame.canvas.yview_scroll(-1, "units")
    elif getattr(event, "num", None) == 5:
        frame.canvas.yview_scroll(1, "units")
    elif getattr(event, "delta", 0):
        frame.canvas.yview_scroll(-1 if event.delta > 0 else 1, "units")


HINT_MIN_WRAP = 288   # never wrap narrower than the previous fixed value


def bind_wraplength(label, container=None, padding=32, minimum=HINT_MIN_WRAP):
    """Let a wrapping Label use the width it is actually given.

    Fixed `wraplength` values force text to wrap into a narrow ribbon on a
    wide console while still overflowing a narrow one. This re-wraps the
    label whenever its container is resized, never below `minimum` so the
    layout is never worse than the previous fixed behavior.
    """

    target = container if container is not None else label.master

    def _resize(event):
        # A resize can be delivered while the page is being torn down.
        if not label.winfo_exists():
            return
        width = event.width - padding
        if width > minimum:
            label.config(wraplength=width)

    target.bind("<Configure>", _resize, add="+")
    return label


def make_hint(parent, text, *, responsive=True):
    palette = get_palette()
    label = tk.Label(parent, text=text, font=FONT_HINT, fg=palette.muted, bg=palette.panel,
                     wraplength=HINT_MIN_WRAP, justify="left")
    if responsive:
        bind_wraplength(label, parent)
    return label


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
    theme = theme_name or theme_state.get_theme()
    if path is None:
        # Prefer a pre-scaled variant of the same official mark. PhotoImage
        # can only downscale by integer subsampling, which discards pixels
        # instead of averaging them and reduces this mark's fine line work
        # to noise; the shipped variants were box-filtered offline instead.
        resolved = resolve_scaled_logo_path(max_height, theme=theme) or resolve_logo_path(theme=theme)
    else:
        resolved = path
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
# Presentation widgets. Business/control logic stays in gui.py; these
# widgets only render values handed to them and never publish MQTT, touch the
# controller, or issue commands themselves.
# ---------------------------------------------------------------------------

class StatusBadge(tk.Frame):
    """A compact status chip: a state glyph (its own shape per status) plus a
    short text label, in a bordered pill. Never relies on color alone -- the
    shape and the text both name the actual state."""

    def __init__(self, parent, text="", status=STATUS_UNKNOWN, **kwargs):
        palette = get_palette()
        outer_bg = kwargs.pop("bg", palette.panel)
        super().__init__(parent, bg=outer_bg, **kwargs)
        self._chip = tk.Frame(self, bg=palette.surface_elevated, highlightthickness=1,
                               highlightbackground=palette.border)
        self._chip.pack()
        inner = tk.Frame(self._chip, bg=palette.surface_elevated)
        inner.pack(padx=(SPACE_SM, SPACE_SM), pady=3)
        self._dot = tk.Label(inner, text=status_glyph(status), font=FONT_BADGE, bg=palette.surface_elevated,
                              fg=status_color(status))
        self._dot.pack(side="left", padx=(0, 4))
        self._label = tk.Label(inner, text=text, font=FONT_BADGE, bg=palette.surface_elevated, fg=palette.text)
        self._label.pack(side="left")

    def update_status(self, text, status):
        self._label.config(text=text)
        self._dot.config(fg=status_color(status), text=status_glyph(status))


class MetricCard(Card):
    """A single Overview summary card: label, large value, and an optional
    helper line.

    Healthy, neutral and unknown cards stay quiet (neutral border and rule,
    plain-ink value, state carried by the glyph); warning and critical cards
    tint the border, rule and value so attention goes where it is needed.
    Every card reserves the same geometry whatever it shows.
    """

    def __init__(self, parent, label, value="--", status=STATUS_UNKNOWN, helper="", **kwargs):
        palette = get_palette()
        super().__init__(parent, accent=palette.border_strong, **kwargs)
        tk.Label(self.body, text=label, font=FONT_METRIC_LABEL, fg=palette.muted,
                 bg=palette.panel, anchor="w").pack(fill="x", padx=SPACE_MD, pady=(SPACE_SM + 2, 0))
        row = tk.Frame(self.body, bg=palette.panel)
        row.pack(fill="x", padx=SPACE_MD, pady=(SPACE_XS, 2))
        self._glyph_label = tk.Label(row, text=status_glyph(status), font=FONT_BADGE,
                                      fg=status_color(status), bg=palette.panel)
        self._glyph_label.pack(side="left", padx=(0, SPACE_SM))
        self._value_label = tk.Label(row, text=value, font=FONT_METRIC_VALUE,
                                      fg=palette.text, bg=palette.panel, anchor="w")
        self._value_label.pack(side="left")
        self._helper_label = tk.Label(self.body, text=helper, font=FONT_METRIC_HELPER,
                                       fg=palette.muted, bg=palette.panel, wraplength=200,
                                       justify="left", anchor="w")
        self._helper_label.pack(fill="x", padx=SPACE_MD, pady=(0, SPACE_SM + 2))
        # Helper lines carry the evidence behind the value ("last seen 12s
        # ago - RSSI -58 dBm"). Wrapping them at a fixed 200px broke them
        # over three lines in a card twice that wide.
        bind_wraplength(self._helper_label, self, padding=2 * SPACE_MD, minimum=140)
        self._apply_status(status)

    def _apply_status(self, status):
        palette = get_palette()
        color = status_color(status)
        loud = status_is_loud(status)
        if loud:
            value_color = color
        elif status == STATUS_UNKNOWN:
            value_color = palette.unknown
        else:
            value_color = palette.text
        self._glyph_label.config(text=status_glyph(status), fg=color)
        self._value_label.config(fg=value_color)
        self.set_tone(color if loud else palette.border_strong, color if loud else palette.border)

    def update(self, value, status, helper=""):
        self._value_label.config(text=value)
        self._helper_label.config(text=helper)
        self._apply_status(status)


class NavigationItem(tk.Frame):
    """One row in the left navigation rail. The selected row carries an
    accent-soft fill, accent text and a left accent bar (not color alone), and
    the row is reachable and operable from the keyboard. `enabled=False`
    renders it as a reachable-but-placeholder item (never claims
    functionality that does not exist yet); it still invokes `command` so
    the workspace can show an explicit EmptyState rather than doing
    nothing."""

    BAR_WIDTH = 3

    def __init__(self, parent, text, command=None, selected=False, enabled=True, suffix="", **kwargs):
        palette = get_palette()
        self._palette = palette
        self._selected = selected
        self._hovered = False
        bg = palette.accent_soft if selected else palette.panel
        super().__init__(parent, bg=palette.panel, cursor="hand2" if command else "arrow",
                         takefocus=1 if command else 0, highlightthickness=1,
                         highlightbackground=palette.panel, highlightcolor=palette.accent_hover, **kwargs)
        self._bar = tk.Frame(self, bg=palette.accent if selected else palette.panel, width=self.BAR_WIDTH)
        self._bar.pack(side="left", fill="y")
        self._row = tk.Frame(self, bg=bg)
        self._row.pack(side="left", fill="both", expand=True)
        self._enabled = enabled
        fg = palette.accent if selected else (palette.text if enabled else palette.muted)
        self._label = tk.Label(self._row, text=f"{text}{suffix}", font=FONT_NAV_ITEM, fg=fg, bg=bg,
                                anchor="w", padx=SPACE_MD, pady=SPACE_SM + 2)
        self._label.pack(fill="x")
        if command:
            for widget in (self, self._row, self._label):
                widget.bind("<Button-1>", lambda _e: command())
                widget.bind("<Enter>", self._on_enter)
                widget.bind("<Leave>", self._on_leave)
            for key in ("<Return>", "<space>"):
                self.bind(key, lambda _e: command())

    # Hover feedback: a navigation rail with no pointer response reads as
    # static text rather than as controls. Purely visual -- it never changes
    # which page is active; only a click or Enter/Space does.
    def _on_enter(self, _event=None):
        self._hovered = True
        self._apply()

    def _on_leave(self, _event=None):
        self._hovered = False
        self._apply()

    def _apply(self):
        palette = self._palette
        if self._selected:
            bg, bar, fg = palette.accent_soft, palette.accent, palette.accent
        elif self._hovered:
            bg, bar = palette.surface_elevated, palette.border_strong
            fg = palette.text if self._enabled else palette.muted
        else:
            bg, bar = palette.panel, palette.panel
            fg = palette.text if self._enabled else palette.muted
        self._bar.config(bg=bar)
        self._row.config(bg=bg)
        self._label.config(bg=bg, fg=fg)

    def set_selected(self, selected):
        self._selected = selected
        self._apply()


class NavSectionLabel(tk.Label):
    """A quiet grouping caption above a run of NavigationItems. Purely an
    information-architecture cue -- it is not itself selectable."""

    def __init__(self, parent, text, **kwargs):
        palette = get_palette()
        # Indent to match NavigationItem's label, which sits after the
        # selection bar, so captions and items share one left edge.
        super().__init__(parent, text=text.upper(), font=FONT_KICKER, fg=palette.muted,
                         bg=palette.panel, anchor="w",
                         padx=SPACE_MD + NavigationItem.BAR_WIDTH, **kwargs)


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
                     bg=palette.background, anchor="w").pack(anchor="w", pady=(2, 0))
        if badge_note:
            tk.Label(self, text=badge_note, font=FONT_HINT, fg=status_color(badge_status),
                     bg=palette.background).pack(anchor="w", pady=(SPACE_XS, 0))


class EvidenceRow(tk.Frame):
    """One row of the Recent Activity table: TIME | SEVERITY | EVENT | SOURCE.

    Columns are laid out on a grid with pixel minimums rather than by
    packing fixed character widths. Character widths are measured in the
    widget's own font, so the header (which is set slightly larger than the
    data rows to read as a header) drifted out of alignment with the rows
    beneath it. Pixel minimums are font-independent, and giving the EVENT
    column the spare width lets the table use the full panel instead of
    ending halfway across a wide console.

    Each row ends in a hairline so a dense table scans by line; severity is a
    glyph plus its word; the time column is monospaced so timestamps align.
    """

    SEVERITY_COLUMN = 1
    # Roughly the previous character widths, converted to pixels once so
    # header and data rows resolve to identical column positions.
    COLUMN_MIN_PX = (84, 92, 200, 96)
    # Leftover width goes to an empty trailing column rather than to any of
    # the four real ones, so the columns stay adjacent and scannable instead
    # of SOURCE drifting to the far edge of a wide console.
    SPACER_COLUMN = 4
    EVENT_WRAP_PX = 480

    def __init__(
        self,
        parent,
        time_text,
        severity,
        event_text,
        source,
        header=False,
        widths=None,
        **kwargs
    ):
        palette = get_palette()
        super().__init__(parent, bg=palette.panel, **kwargs)
        minimums = self._minimums(widths)
        if header:
            severity_text = severity
        else:
            severity_text = f"{status_glyph(SEVERITY_STATUS.get(severity, STATUS_UNKNOWN))} {severity}"
        values = (time_text, severity_text, event_text, source)
        default_color = palette.muted if header else palette.text
        severity_color = palette.muted if header else status_color(SEVERITY_STATUS.get(severity, STATUS_UNKNOWN))
        for index, (value, minimum) in enumerate(zip(values, minimums)):
            fg = severity_color if index == self.SEVERITY_COLUMN else default_color
            if header:
                font = FONT_KICKER
            elif index == 0:
                font = FONT_MONO_SMALL
            elif index == self.SEVERITY_COLUMN:
                font = FONT_BADGE
            else:
                font = FONT_HINT
            self.grid_columnconfigure(index, minsize=minimum, weight=0)
            tk.Label(self, text=value.upper() if header else value, font=font, fg=fg, bg=palette.panel,
                     anchor="w", justify="left",
                     wraplength=self.EVENT_WRAP_PX if index == 2 else 0).grid(
                row=0, column=index, sticky="w", padx=(0, SPACE_SM), pady=(SPACE_XS, SPACE_XS))
        self.grid_columnconfigure(self.SPACER_COLUMN, weight=1)
        tk.Frame(self, bg=palette.border_strong if header else palette.border, height=1).grid(
            row=1, column=0, columnspan=self.SPACER_COLUMN + 1, sticky="ew")

    @classmethod
    def _minimums(cls, widths):
        """Accept the legacy character-width tuple and convert it, so the
        existing incident-timeline call site keeps its wider TIME column."""
        if not widths:
            return cls.COLUMN_MIN_PX
        approx_char_px = 7
        return tuple(
            max(minimum, chars * approx_char_px)
            for chars, minimum in zip(widths, cls.COLUMN_MIN_PX)
        )


class EmptyState(tk.Frame):
    """Shown when there is nothing to list, or for navigation placeholders
    that are not implemented yet. Must never claim behavior the application
    does not have. `compact=True` is the quiet in-panel variant."""

    def __init__(self, parent, title, message, *, compact=False, bg=None, **kwargs):
        palette = get_palette()
        bg = bg or (palette.panel if compact else palette.background)
        super().__init__(parent, bg=bg, **kwargs)
        wrap = tk.Frame(self, bg=bg)
        if compact:
            wrap.pack(anchor="w", pady=(SPACE_XS, SPACE_XS))
            tk.Label(wrap, text=status_glyph(STATUS_UNKNOWN), font=FONT_BADGE, fg=palette.unknown,
                     bg=bg).pack(side="left", padx=(0, SPACE_SM))
            tk.Label(wrap, text=f"{title}  {message}".strip(), font=FONT_HINT, fg=palette.muted, bg=bg,
                     justify="left", anchor="w").pack(side="left")
            return
        wrap.pack(expand=True)
        tk.Label(wrap, text=status_glyph(STATUS_UNKNOWN), font=FONT_PAGE_TITLE, fg=palette.unknown,
                 bg=bg).pack(pady=(SPACE_XL, 0))
        tk.Label(wrap, text=title, font=FONT_PAGE_TITLE, fg=palette.muted, bg=bg).pack(pady=(SPACE_SM, SPACE_SM))
        tk.Label(wrap, text=message, font=FONT_PAGE_SUBTITLE, fg=palette.muted, bg=bg,
                 wraplength=420, justify="center").pack()


_SOFT_FILL = {
    STATUS_CRITICAL: "danger_soft",
    STATUS_WARNING: "warning_soft",
    STATUS_HEALTHY: "success_soft",
    STATUS_NEUTRAL: "accent_soft",
    STATUS_UNKNOWN: "panel_alt",
}


class InlineAlert(tk.Frame):
    """A tinted, bordered message for inline errors and notes: state glyph
    plus wrapped text. Replaces bare colored text so a failure is not just
    "red words" and never depends on color alone."""

    def __init__(self, parent, text="", status=STATUS_CRITICAL, wraplength=320, **kwargs):
        palette = get_palette()
        color = status_color(status)
        fill = getattr(palette, _SOFT_FILL.get(status, "panel_alt"))
        super().__init__(parent, bg=fill, highlightthickness=1, highlightbackground=color, bd=0, **kwargs)
        self._fill = fill
        self._glyph = tk.Label(self, text=status_glyph(status), font=FONT_BADGE, fg=color, bg=fill)
        self._glyph.pack(side="left", padx=(SPACE_MD, SPACE_SM), pady=SPACE_SM)
        self._message = tk.Label(self, text=text, font=FONT_HINT, fg=color, bg=fill, anchor="w",
                                  justify="left", wraplength=wraplength)
        self._message.pack(side="left", fill="x", expand=True, padx=(0, SPACE_MD), pady=SPACE_SM)

    def set_text(self, text):
        self._message.config(text=text)
