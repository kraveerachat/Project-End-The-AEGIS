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

    def _build(self):
        self.canvas = tk.Canvas(
            self,
            bg=self.palette.background,
            highlightthickness=0,
            bd=0,
        )
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Configure>", self._draw_circuit)

        stage = tk.Frame(self.canvas, bg=self.palette.background)
        self._stage_window = self.canvas.create_window(0, 0, anchor="center", window=stage)
        self.canvas.bind(
            "<Configure>",
            lambda event: self.canvas.coords(self._stage_window, event.width / 2, event.height / 2),
            add="+",
        )

        brand = tk.Frame(stage, bg=self.palette.background, width=440, height=520)
        brand.grid(row=0, column=0, sticky="nsew", padx=(0, 48))
        brand.grid_propagate(False)
        self._build_brand(brand)

        form = tk.Frame(
            stage,
            bg=self.palette.panel,
            width=440,
            height=560,
            highlightbackground=self.palette.border,
            highlightthickness=1,
            bd=0,
        )
        form.grid(row=0, column=1, sticky="nsew")
        form.grid_propagate(False)
        self._build_form(form)

    def _build_brand(self, parent):
        block = tk.Frame(parent, bg=self.palette.background)
        block.place(relx=0.0, rely=0.5, anchor="w")
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
            wraplength=390,
            justify="left",
        ).pack(anchor="w")

    def _build_form(self, parent):
        body = tk.Frame(parent, bg=self.palette.panel)
        body.pack(fill="both", expand=True, padx=44, pady=38)

        utility = tk.Frame(body, bg=self.palette.panel)
        utility.pack(fill="x")
        self._build_language_selector(utility)
        self._build_theme_selector(utility)

        tk.Label(
            body,
            text=i18n.t("login.title"),
            font=("Segoe UI", 24, "bold"),
            fg=self.palette.text,
            bg=self.palette.panel,
        ).pack(anchor="w", pady=(42, 4))
        tk.Label(
            body,
            text=i18n.t("login.subtitle"),
            font=FONT_PAGE_SUBTITLE,
            fg=self.palette.muted,
            bg=self.palette.panel,
            wraplength=340,
            justify="left",
        ).pack(anchor="w", pady=(0, 28))

        self.admin_entry = self._field(body, "login.admin_id", masked=False)
        self.pin_entry = self._field(body, "login.pin", masked=True)
        self.status_label = tk.Label(
            body,
            text="",
            font=FONT_HINT,
            fg=self.palette.danger_highlight,
            bg=self.palette.panel,
            anchor="w",
        )
        self.status_label.pack(fill="x", pady=(4, 10))

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
            highlightthickness=1,
            highlightbackground=self.palette.border,
            highlightcolor=self.palette.accent,
            show="•" if masked else "",
        )
        entry.pack(fill="x", ipady=10, pady=(0, 18))
        return entry

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
