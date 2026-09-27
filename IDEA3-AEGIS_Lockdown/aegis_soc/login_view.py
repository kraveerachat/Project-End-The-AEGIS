"""Admin-only Tkinter login surface for the desktop SOC shell."""

from __future__ import annotations

import tkinter as tk
from dataclasses import dataclass

from . import i18n, theme_state
from .auth import DesktopSession, verify_admin_credentials
from .theme import FONT_BTN, FONT_HINT, FONT_PAGE_SUBTITLE, get_palette, load_logo_image


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
    BRAND_WIDTH = 420
    FORM_WIDTH = 420
    COLUMN_GAP = 48

    def _build(self):
        self.canvas = tk.Canvas(
            self,
            bg=self.palette.background,
            highlightthickness=0,
            bd=0,
        )
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", self._draw_circuit)

        self._stage = tk.Frame(self.canvas, bg=self.palette.background)
        self._stage_window = self.canvas.create_window(0, 0, anchor="center", window=self._stage)
        self._compact = None
        self.canvas.bind("<Configure>", self._on_canvas_resize, add="+")

        # Both columns share one grid row with sticky="nsew" so the brand
        # block and the card are the same height and share a baseline,
        # instead of two independently sized boxes that only looked aligned
        # at one specific window size.
        self._brand = tk.Frame(self._stage, bg=self.palette.background)
        self._brand.grid(row=0, column=0, sticky="nsew", padx=(0, self.COLUMN_GAP))
        self._width_strut(self._brand, self.BRAND_WIDTH, self.palette.background)
        self._build_brand(self._brand)

        self._form = tk.Frame(
            self._stage,
            bg=self.palette.panel,
            highlightbackground=self.palette.border,
            highlightthickness=1,
            bd=0,
        )
        self._form.grid(row=0, column=1, sticky="nsew")
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
        self.canvas.coords(self._stage_window, event.width / 2, event.height / 2)
        self._apply_layout(event.width)

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
                self._form.grid_configure(row=0, column=0)
            else:
                self._form.grid_configure(row=0, column=1)
                self._brand.grid()
            if compact:
                self._compact_brand.pack(fill="x", pady=(24, 0), before=self._title)
            else:
                self._compact_brand.pack_forget()


    def _build_brand(self, parent):
        block = tk.Frame(parent, bg=self.palette.background)
        # expand=True centres the block against whatever height the row
        # takes from the sign-in card beside it, so the two columns share a
        # vertical centre at every window size.
        block.pack(anchor="w", expand=True)
        self._logo_image = load_logo_image(max_height=92)
        if self._logo_image is not None:
            tk.Label(block, image=self._logo_image, bg=self.palette.background).pack(anchor="w")
        tk.Label(
            block,
            text="AEGIS",
            font=("Segoe UI", 34, "bold"),
            fg=self.palette.text,
            bg=self.palette.background,
        ).pack(anchor="w", pady=(18, 0))
        tk.Label(
            block,
            text=i18n.t("login.brand_tagline"),
            font=("Segoe UI", 13, "bold"),
            fg=self.palette.accent,
            bg=self.palette.background,
        ).pack(anchor="w", pady=(4, 14))
        tk.Label(
            block,
            text=i18n.t("login.brand_description"),
            font=FONT_PAGE_SUBTITLE,
            fg=self.palette.muted,
            bg=self.palette.background,
            wraplength=self.BRAND_WIDTH - 30,
            justify="left",
        ).pack(anchor="w")

    def _build_form(self, parent):
        body = tk.Frame(parent, bg=self.palette.panel)
        body.pack(fill="both", expand=True, padx=40, pady=32)

        utility = tk.Frame(body, bg=self.palette.panel)
        utility.pack(fill="x")
        self._build_language_selector(utility)
        self._build_theme_selector(utility)

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
            font=("Segoe UI", 20, "bold"),
            fg=self.palette.text,
            bg=self.palette.panel,
        ).pack(side="left")

        self._title = tk.Label(
            body,
            text=i18n.t("login.title"),
            font=("Segoe UI", 24, "bold"),
            fg=self.palette.text,
            bg=self.palette.panel,
        )
        self._title.pack(anchor="w", pady=(34, 4))
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
        # the pointer.
        status_slot = tk.Frame(body, bg=self.palette.panel, height=30)
        status_slot.pack(fill="x", pady=(2, 8))
        status_slot.pack_propagate(False)
        self.status_label = tk.Label(
            status_slot,
            text="",
            font=FONT_HINT,
            fg=self.palette.danger_highlight,
            bg=self.palette.panel,
            anchor="w",
            justify="left",
            wraplength=self.FORM_WIDTH - 90,
        )
        self.status_label.pack(fill="both", expand=True)

        tk.Button(
            body,
            text=i18n.t("login.sign_in"),
            font=FONT_BTN,
            fg="white",
            bg=self.palette.blue,
            activebackground=self.palette.blue_highlight,
            activeforeground="white",
            bd=0,
            relief="flat",
            cursor="hand2",
            height=2,
            command=self._submit,
        ).pack(fill="x")
        tk.Label(
            body,
            text=i18n.t("login.security_note"),
            font=FONT_HINT,
            fg=self.palette.muted,
            bg=self.palette.panel,
            wraplength=340,
            justify="left",
        ).pack(anchor="w", pady=(18, 0))
        self.admin_entry.focus_set()

    def _field(self, parent, label_key, *, masked):
        tk.Label(
            parent,
            text=i18n.t(label_key),
            font=("Segoe UI", 9, "bold"),
            fg=self.palette.text,
            bg=self.palette.panel,
        ).pack(anchor="w", pady=(0, 6))
        entry = tk.Entry(
            parent,
            font=("Segoe UI", 11),
            fg=self.palette.text,
            bg=self.palette.panel_alt,
            insertbackground=self.palette.text,
            selectbackground=self.palette.accent,
            relief="flat",
            highlightthickness=2,
            highlightbackground=self.palette.border,
            highlightcolor=self.palette.accent,
            show="•" if masked else "",
        )
        entry.pack(fill="x", ipady=9, pady=(0, 16))
        # Clear a previous failure as soon as the operator starts a new
        # attempt, so a stale error is never read as a fresh one.
        entry.bind("<KeyPress>", self._clear_status, add="+")
        return entry

    def _clear_status(self, _event=None):
        label = getattr(self, "status_label", None)
        if label is not None and label.winfo_exists() and label.cget("text"):
            label.config(text="")

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
        menu.config(
            font=FONT_HINT,
            bg=self.palette.panel_alt,
            fg=self.palette.text,
            activebackground=self.palette.border,
            activeforeground=self.palette.text,
            highlightthickness=1,
            highlightbackground=self.palette.border,
            bd=0,
        )
        menu["menu"].config(bg=self.palette.panel, fg=self.palette.text)

    def _submit(self, _event=None):
        result = self.flow.submit(self.admin_entry.get(), self.pin_entry.get())
        if result.clear_pin and self.winfo_exists():
            self.pin_entry.delete(0, tk.END)
        if not result.accepted and self.winfo_exists():
            self.status_label.config(text=i18n.t(result.message_key))
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
