"""Admin-only Tkinter login surface for the desktop SOC shell."""

from __future__ import annotations

import tkinter as tk
from dataclasses import dataclass

from . import i18n, theme_state
from .auth import DesktopSession, verify_admin_credentials
from .branding import resolve_login_background_path
from .presentation import STATUS_CRITICAL
from .theme import (
    FONT_BTN_SM,
    FONT_DISPLAY,
    FONT_HINT,
    FONT_LOGIN_TITLE,
    FONT_PAGE_SUBTITLE,
    FONT_SECTION,
    FONT_TITLE,
    InlineAlert,
    get_palette,
    load_logo_image,
    make_button,
    style_option_menu,
)


def _rounded_rect_points(x1, y1, x2, y2, radius):
    """Point list for a smoothed canvas polygon that reads as a rounded rect.

    Tkinter has no native rounded-rectangle primitive; a smoothed polygon
    through the corner-adjacent points is the standard approximation.
    """
    radius = max(0, min(radius, (x2 - x1) / 2, (y2 - y1) / 2))
    return [
        x1 + radius, y1,
        x2 - radius, y1,
        x2, y1,
        x2, y1 + radius,
        x2, y2 - radius,
        x2, y2,
        x2 - radius, y2,
        x1 + radius, y2,
        x1, y2,
        x1, y2 - radius,
        x1, y1 + radius,
        x1, y1,
    ]


@dataclass(frozen=True)
class LoginAttempt:
    accepted: bool
    message_key: str | None
    clear_pin: bool = True


class LoginFlow:
    """Display-independent login transition with uniform failure behavior."""

    def __init__(self, session, on_authenticated, credential_verifier=None):
        self.session = session
        self.on_authenticated = on_authenticated
        self.credential_verifier = credential_verifier or verify_admin_credentials

    def submit(self, admin_id, pin):
        accepted = self.credential_verifier(admin_id, pin)
        if not accepted:
            return LoginAttempt(False, "login.failure")
        self.session.login(admin_id)
        self.on_authenticated()
        return LoginAttempt(True, None)


class LoginView(tk.Frame):
    """Theme-aware, localized login UI; owns no control/runtime object."""

    def __init__(self, parent, session: DesktopSession, on_authenticated, on_language, on_theme):
        self.palette = get_palette()
        super().__init__(parent, bg=self.palette.background)
        self.pack(fill="both", expand=True)
        self.flow = LoginFlow(session, on_authenticated)
        self.on_language = on_language
        self.on_theme = on_theme
        self._logo_image = None
        self._background_image = None
        self._background_item = None
        self._card_id = None
        self._card_shadow_id = None
        self._canvas_cx = 0
        self._canvas_cy = 0
        self._return_binding = parent.bind("<Return>", self._submit, add="+")
        self._build()

    def destroy(self):
        if self._return_binding:
            self.master.unbind("<Return>", self._return_binding)
            self._return_binding = None
        super().destroy()

    # Below this canvas width the brand column is dropped and the sign-in
    # card stands alone, so the card is never clipped on a small console.
    COMPACT_WIDTH = 980
    # ~42% / 58% split, matching the IDEA1 web login's brand/form ratio.
    BRAND_WIDTH = 360
    FORM_WIDTH = 500
    CARD_RADIUS = 18
    CARD_PAD = 22
    TOPBAR_MARGIN = 20

    def _build(self):
        self.canvas = tk.Canvas(
            self,
            bg=self.palette.background,
            highlightthickness=0,
            bd=0,
        )
        self.canvas.pack(fill="both", expand=True)

        background_path = resolve_login_background_path(
            theme=theme_state.get_theme()
        )
        if background_path:
            try:
                self._background_image = tk.PhotoImage(file=background_path)
                self._background_item = self.canvas.create_image(
                    0,
                    0,
                    image=self._background_image,
                    anchor="center",
                    tags="login-background",
                )
            except tk.TclError:
                self._background_image = None
                self._background_item = None

        if self._background_item is None:
            self.canvas.bind("<Configure>", self._draw_circuit)

        # Detached top-right controls (IDEA1 places language/theme outside
        # the login surface, not inside the card).
        self._topbar = tk.Frame(self.canvas, bg=self.palette.background)
        self._topbar_window = self.canvas.create_window(
            0, 0, anchor="ne", window=self._topbar
        )
        self._build_topbar(self._topbar)

        self._stage = tk.Frame(self.canvas, bg=self.palette.panel)
        self._stage_window = self.canvas.create_window(0, 0, anchor="center", window=self._stage)
        self._stage.bind("<Configure>", lambda _e: self._redraw_card())
        self._compact = None
        self.canvas.bind("<Configure>", self._on_canvas_resize, add="+")

        # One rounded login surface (card) split into a sunken brand side and
        # a form side by a single divider line, instead of two independently
        # outlined boxes. Both share one grid row with sticky="nsew" so they
        # are always the same height.
        self._brand = tk.Frame(self._stage, bg=self.palette.panel_alt)
        self._brand.grid(row=0, column=0, sticky="nsew")
        self._width_strut(self._brand, self.BRAND_WIDTH, self.palette.panel_alt)
        self._build_brand(self._brand)

        self._divider = tk.Frame(self._stage, bg=self.palette.border, width=1)
        self._divider.grid(row=0, column=1, sticky="ns")

        self._form = tk.Frame(
            self._stage,
            bg=self.palette.panel,
            highlightthickness=0,
            bd=0,
        )
        self._form.grid(row=0, column=2, sticky="nsew")
        self._width_strut(self._form, self.FORM_WIDTH, self.palette.panel)
        self._build_form(self._form)
        self._stage.grid_rowconfigure(0, weight=1)

    @staticmethod
    def _width_strut(parent, width, background):
        """Pin a column's width without pinning its height.

        grid_propagate(False) would lock both axes, which is what left the
        card padded out to a fixed height with dead space below the form.
        A zero-height strut sets the minimum width and lets the height
        follow the content.
        """
        strut = tk.Frame(parent, bg=background, width=width, height=0)
        strut.pack(fill="x")
        return strut

    def _on_canvas_resize(self, event):
        if self._background_item is not None:
            self.canvas.coords(
                self._background_item,
                event.width / 2,
                event.height / 2,
            )
            self.canvas.tag_lower(self._background_item)

        self._canvas_cx = event.width / 2
        self._canvas_cy = event.height / 2
        self.canvas.coords(self._stage_window, self._canvas_cx, self._canvas_cy)
        self.canvas.coords(
            self._topbar_window,
            event.width - self.TOPBAR_MARGIN,
            self.TOPBAR_MARGIN,
        )
        self._apply_layout(event.width)
        self._redraw_card()

    def _apply_layout(self, width):
        """Re-flow between the two-column and single-column arrangements.

        Only the arrangement changes -- every field, control, and binding is
        the same object in both, so nothing is rebuilt and no entry loses
        what the operator has already typed.
        """
        compact = width < self.COMPACT_WIDTH
        if compact != self._compact:
            self._compact = compact
            if compact:
                self._brand.grid_remove()
                self._divider.grid_remove()
                self._form.grid_configure(row=0, column=0)
            else:
                self._form.grid_configure(row=0, column=2)
                self._brand.grid()
                self._divider.grid()
            if compact:
                self._compact_brand.pack(fill="x", pady=(24, 0), before=self._title)
            else:
                self._compact_brand.pack_forget()

    def _redraw_card(self):
        """Draw the single rounded login surface behind the stage content.

        A smoothed canvas polygon stands in for the CSS rounded card
        (border-radius has no Tkinter Frame equivalent); a flat, slightly
        offset polygon behind it gives a restrained elevation cue in place
        of a blurred box-shadow, which Tkinter cannot render.
        """
        self._stage.update_idletasks()
        width = self._stage.winfo_reqwidth() + 2 * self.CARD_PAD
        height = self._stage.winfo_reqheight() + 2 * self.CARD_PAD
        if width <= 1 or height <= 1:
            return
        x1, y1 = self._canvas_cx - width / 2, self._canvas_cy - height / 2
        x2, y2 = self._canvas_cx + width / 2, self._canvas_cy + height / 2
        card_points = _rounded_rect_points(x1, y1, x2, y2, self.CARD_RADIUS)
        shadow_points = _rounded_rect_points(x1, y1 + 4, x2, y2 + 4, self.CARD_RADIUS)

        if self._card_id is None:
            self._card_shadow_id = self.canvas.create_polygon(
                shadow_points,
                smooth=True,
                splinesteps=24,
                fill=self.palette.border,
                outline="",
                tags="login-card-shadow",
            )
            self._card_id = self.canvas.create_polygon(
                card_points,
                smooth=True,
                splinesteps=24,
                fill=self.palette.panel,
                outline=self.palette.border,
                width=1,
                tags="login-card",
            )
        else:
            self.canvas.coords(self._card_shadow_id, *shadow_points)
            self.canvas.coords(self._card_id, *card_points)

        if self._background_item is not None:
            self.canvas.tag_lower(self._background_item)
        self.canvas.tag_raise(self._card_shadow_id)
        self.canvas.tag_raise(self._card_id)
        self.canvas.tag_raise(self._stage_window)
        self.canvas.tag_raise(self._topbar_window)

    def _build_brand(self, parent):
        # IDEA1's brand panel is centered, not left-aligned -- a restrained,
        # symmetric lockup rather than a ragged left edge.
        block = tk.Frame(parent, bg=self.palette.panel_alt)
        # expand=True centres the block against whatever height the row
        # takes from the sign-in card beside it, so the two columns share a
        # vertical centre at every window size.
        block.pack(expand=True, padx=32)
        self._logo_image = load_logo_image(max_height=92)
        if self._logo_image is not None:
            tk.Label(block, image=self._logo_image, bg=self.palette.panel_alt).pack()
        tk.Label(
            block,
            text="AEGIS",
            font=FONT_DISPLAY,
            fg=self.palette.text,
            bg=self.palette.panel_alt,
        ).pack(pady=(18, 0))
        tk.Label(
            block,
            text=i18n.t("login.brand_tagline"),
            font=FONT_SECTION,
            fg=self.palette.accent,
            bg=self.palette.panel_alt,
        ).pack(pady=(4, 14))
        tk.Label(
            block,
            text=i18n.t("login.brand_description"),
            font=FONT_PAGE_SUBTITLE,
            fg=self.palette.muted,
            bg=self.palette.panel_alt,
            wraplength=self.BRAND_WIDTH - 64,
            justify="center",
        ).pack()

    def _build_form(self, parent):
        body = tk.Frame(parent, bg=self.palette.panel)
        body.pack(fill="both", expand=True, padx=40, pady=32)

        # Shown only in the single-column arrangement, where the brand
        # column is hidden and the card would otherwise carry no mark.
        self._compact_brand = tk.Frame(body, bg=self.palette.panel)
        self._compact_logo_image = load_logo_image(max_height=40)
        if self._compact_logo_image is not None:
            tk.Label(self._compact_brand, image=self._compact_logo_image,
                     bg=self.palette.panel).pack(side="left", padx=(0, 10))
        tk.Label(
            self._compact_brand,
            text="AEGIS",
            font=FONT_TITLE,
            fg=self.palette.text,
            bg=self.palette.panel,
        ).pack(side="left")

        self._title = tk.Label(
            body,
            text=i18n.t("login.title"),
            font=FONT_LOGIN_TITLE,
            fg=self.palette.text,
            bg=self.palette.panel,
        )
        self._title.pack(anchor="w", pady=(0, 4))
        tk.Label(
            body,
            text=i18n.t("login.subtitle"),
            font=FONT_PAGE_SUBTITLE,
            fg=self.palette.muted,
            bg=self.palette.panel,
            wraplength=self.FORM_WIDTH - 90,
            justify="left",
        ).pack(anchor="w", pady=(0, 24))

        self.admin_entry = self._field(body, "login.admin_id", masked=False)
        self.pin_entry = self._field(body, "login.pin", masked=True)
        # Height is reserved whether or not a message is showing, so a
        # failed attempt never shifts the Sign In button out from under
        # the pointer. The failure itself is a bordered, tinted alert with a
        # state glyph -- readable without relying on red text alone. Its
        # wording is always the single generic login.failure message.
        self._status_slot = tk.Frame(body, bg=self.palette.panel, height=56)
        self._status_slot.pack(fill="x", pady=(2, 8))
        self._status_slot.pack_propagate(False)
        self._alert = InlineAlert(self._status_slot, "", STATUS_CRITICAL, wraplength=self.FORM_WIDTH - 130)
        self._alert_visible = False

        make_button(body, i18n.t("login.sign_in"), self._submit, "primary", large=True).pack(fill="x")
        tk.Label(
            body,
            text=i18n.t("login.security_note"),
            font=FONT_HINT,
            fg=self.palette.muted,
            bg=self.palette.panel,
            wraplength=self.FORM_WIDTH - 90,
            justify="left",
        ).pack(anchor="w", pady=(18, 0))
        self.admin_entry.focus_set()

    def _field(self, parent, label_key, *, masked):
        tk.Label(
            parent,
            text=i18n.t(label_key),
            font=FONT_BTN_SM,
            fg=self.palette.text,
            bg=self.palette.panel,
        ).pack(anchor="w", pady=(0, 6))
        entry = tk.Entry(
            parent,
            font=FONT_PAGE_SUBTITLE,
            fg=self.palette.text,
            bg=self.palette.panel_alt,
            insertbackground=self.palette.text,
            selectbackground=self.palette.accent_fill,
            selectforeground=self.palette.on_accent,
            relief="flat",
            highlightthickness=1,
            highlightbackground=self.palette.border,
            highlightcolor=self.palette.accent_hover,
            show="•" if masked else "",
        )
        entry.pack(fill="x", ipady=9, pady=(0, 16))
        # Clear a previous failure as soon as the operator starts a new
        # attempt, so a stale error is never read as a fresh one.
        entry.bind("<KeyPress>", self._clear_status, add="+")
        # Focus shows as the accent ring (as in the Neo web login) plus the
        # sunken-to-card background swap, so it is visible to keyboard users.
        entry.bind("<FocusIn>", lambda _e, w=entry: w.config(bg=self.palette.panel))
        entry.bind("<FocusOut>", lambda _e, w=entry: w.config(bg=self.palette.panel_alt))
        return entry

    def _build_topbar(self, parent):
        utility = tk.Frame(parent, bg=self.palette.background)
        utility.pack()
        self._build_language_selector(utility)
        self._build_theme_selector(utility)

    def _clear_status(self, _event=None):
        alert = getattr(self, "_alert", None)
        if alert is not None and alert.winfo_exists() and self._alert_visible:
            alert.pack_forget()
            self._alert_visible = False

    def _show_failure(self, message):
        self._alert.set_text(message)
        if not self._alert_visible:
            self._alert.pack(fill="x", anchor="n")
            self._alert_visible = True

    def _build_language_selector(self, parent):
        names = dict(i18n.available_languages())
        by_name = {name: code for code, name in names.items()}
        variable = tk.StringVar(value=names[i18n.get_language()])
        menu = tk.OptionMenu(parent, variable, *names.values(), command=lambda name: self.on_language(by_name[name]))
        self._style_menu(menu)
        menu.pack(side="left")

    def _build_theme_selector(self, parent):
        labels = {"dark": i18n.t("theme.dark"), "light": i18n.t("theme.light")}
        by_label = {label: name for name, label in labels.items()}
        variable = tk.StringVar(value=labels[theme_state.get_theme()])
        menu = tk.OptionMenu(parent, variable, *labels.values(), command=lambda label: self.on_theme(by_label[label]))
        self._style_menu(menu)
        menu.pack(side="right")

    def _style_menu(self, menu):
        style_option_menu(menu)

    def _submit(self, _event=None):
        result = self.flow.submit(self.admin_entry.get(), self.pin_entry.get())
        if result.clear_pin and self.winfo_exists():
            self.pin_entry.delete(0, tk.END)
        if not result.accepted and self.winfo_exists():
            self._show_failure(i18n.t(result.message_key))
            self.pin_entry.focus_set()

    def _draw_circuit(self, event):
        self.canvas.delete("circuit")
        width, height = event.width, event.height
        line = self.palette.border
        node = self.palette.accent
        step = max(84, width // 16)
        for index, x in enumerate(range(0, width + step, step)):
            offset = 36 if index % 2 else 0
            self.canvas.create_line(x, 0, x, height, fill=line, width=1, tags="circuit")
            for y in range(offset, height + step, step * 2):
                self.canvas.create_line(x, y, min(width, x + step // 2), y, fill=line, width=1, tags="circuit")
                self.canvas.create_oval(x - 2, y - 2, x + 2, y + 2, fill=node, outline="", tags="circuit")
