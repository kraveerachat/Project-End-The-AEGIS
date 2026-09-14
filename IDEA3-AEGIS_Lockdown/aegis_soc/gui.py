"""
AEGIS IDEA 3 — SOC GUI (หน้าจอควบคุมหลัก)
รวมฟีเจอร์: ARM/DISARM + ยืนยันคำสั่งซ้อน, ACK tracking, สถานะอุปกรณ์สด,
Log แบ่งระดับความรุนแรง + กรอง, Incident banner
"""
import csv
import ipaddress
import os
import subprocess
import threading
import time
import tkinter as tk
from tkinter import messagebox, scrolledtext, simpledialog

from . import comms, config, i18n, theme_state
from . import database as db
from . import presentation as pres
from . import theme as ui_theme
from .auth import DesktopSession
from .controller import AegisCommandController
from .login_view import LoginView
from .mqtt_client import MQTTManager
from .theme import (
    COLOR_ACCENT,
    COLOR_BG,
    COLOR_BLUE,
    COLOR_BLUE_HL,
    COLOR_BORDER,
    COLOR_DANGER,
    COLOR_DANGER_HL,
    COLOR_MUTED,
    COLOR_PANEL,
    COLOR_PANEL_ALT,
    COLOR_PURPLE,
    COLOR_SUCCESS,
    COLOR_SUCCESS_HL,
    COLOR_TEXT,
    COLOR_WARN,
    COLOR_WARN_HL,
    FONT_BTN,
    FONT_BTN_SM,
    FONT_CLOCK,
    FONT_HINT,
    FONT_MONO,
    FONT_SUB,
    FONT_TITLE,
    LEVEL_COLORS,
    NAV_WIDTH,
    STATUS_WARNING,
    EvidenceRow,
    MetricCard,
    NavigationItem,
    PageHeader,
    ScrollFrame,
    Section,
    StatusBadge,
    load_logo_image,
    make_hint,
)
from .wizard import IncidentRecoveryWizard

_LEVEL_RANK = {"INFO": 0, "WARN": 1, "CRITICAL": 2}
RECENT_ACTIVITY_LIMIT = 8

# Static MetricCard labels, keyed the same way as the Metric objects
# presentation.py produces, resolved through i18n at build/refresh time.
# MetricCard.update() only ever changes the value/status/helper text, never
# the label, so the localized label must be correct from construction time.
METRIC_LABEL_KEYS = {
    "health": "metric.health",
    "uplink": "metric.uplink",
    "broker": "metric.broker",
    "esp32": "metric.esp32",
    "mode": "metric.mode",
    "deadman": "metric.deadman",
    "incidents": "metric.incidents",
    "today": "metric.today",
}

# Authenticated desktop workspaces. Login is intentionally outside this shell.
NAV_ITEMS = (
    ("overview", "nav.overview", True),
    ("incidents", "nav.incidents", True),
    ("devices", "nav.devices", True),
    ("lockdown", "nav.lockdown", True),
    ("recovery", "nav.recovery", True),
    ("audit", "nav.audit", True),
    ("diagnostics", "nav.diagnostics", True),
    ("settings", "nav.settings", True),
)

# presentation.py returns a fixed, stable English vocabulary for status
# values (e.g. "CONNECTED", "LOCKDOWN") -- these are canonical identifiers,
# not prose, and presentation.py itself stays English-only and untranslated
# so its existing tests keep asserting exact values. This table translates
# only the *display* word; the semantic status (color/logic) is unaffected.
_STATUS_VALUE_KEYS = {
    "HEALTHY": "status.healthy",
    "DEGRADED": "status.degraded",
    "UNKNOWN": "status.unknown",
    "CONNECTED": "status.connected",
    "DISCONNECTED": "status.disconnected",
    "ONLINE": "status.online",
    "OFFLINE": "status.offline",
    "NORMAL": "status.normal",
    "LOCKDOWN": "status.lockdown",
    "ARMED": "status.armed",
    "DISARMED": "status.disarmed",
}


def _localize_status_value(value):
    key = _STATUS_VALUE_KEYS.get(value)
    return i18n.t(key) if key else value


def _sync_palette_aliases():
    """Refresh legacy module color aliases before rebuilding Tk widgets."""

    palette = ui_theme.get_palette()
    globals().update(
        COLOR_ACCENT=palette.accent,
        COLOR_BG=palette.background,
        COLOR_BLUE=palette.blue,
        COLOR_BLUE_HL=palette.blue_highlight,
        COLOR_BORDER=palette.border,
        COLOR_DANGER=palette.danger,
        COLOR_DANGER_HL=palette.danger_highlight,
        COLOR_MUTED=palette.muted,
        COLOR_PANEL=palette.panel,
        COLOR_PANEL_ALT=palette.panel_alt,
        COLOR_PURPLE=palette.purple,
        COLOR_SUCCESS=palette.success,
        COLOR_SUCCESS_HL=palette.success_highlight,
        COLOR_TEXT=palette.text,
        COLOR_WARN=palette.warn,
        COLOR_WARN_HL=palette.warn_highlight,
        LEVEL_COLORS=palette.level_colors,
    )


class AegisAdminGUI:
    def __init__(self, root, mqtt_manager, command_controller=None):
        _sync_palette_aliases()
        self.root = root
        self.mqtt = mqtt_manager
        self.controller = command_controller or AegisCommandController(
            mqtt_manager,
            dry_run=config.DRY_RUN,
        )
        self.tg_pin_fails = 0          # จำนวนครั้งใส่ PIN ผิดทาง Telegram
        self.tg_locked_until = 0       # ล็อกจนถึงเวลาไหน (timestamp)

        # ---- operational state ----
        self.armed = True                 # ARMED = เฝ้าระวังปกติ, DISARMED = โหมดซ่อมบำรุง
        self.locked = False               # ล็อกเมื่อกรอก PIN ผิดหลายครั้ง
        self.pin_attempts = 0
        self.pending_cmd = None           # {'action','ts'} คำสั่งที่รอ ACK
        self.last_heartbeat_sent_ts = time.time()
        self.log_buffer = []              # (message, level) ทุกบรรทัด เพื่อกรองใหม่ได้
        self.session = DesktopSession()
        self.login_view = None

        self.nav_items = {}          # key -> NavigationItem widget
        self.active_page = "overview"
        self.metric_cards = {}       # key -> MetricCard widget
        self.activity_rows = []      # list of EvidenceRow widgets currently shown
        self._logo_image = None      # kept alive here; Tkinter does not retain PhotoImage refs

        self.root.geometry("1440x900")
        self.root.minsize(1024, 700)
        self.root.config(bg=COLOR_BG)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self._show_login()
        # Heartbeat/clock/ACK-timeout monitoring must run for the whole
        # process lifetime, independent of desktop UI login state -- the
        # Dead Man's Switch heartbeat and ACK-timeout logging are safety
        # behavior, not merely UI updates, and Telegram-issued CUT/RESTORE
        # commands can be pending before anyone ever opens the desktop
        # shell. Starting these only after first login (as this file did
        # previously) would silently stop heartbeats while the console
        # sits at the login screen, which could trigger a spurious
        # ESP32-side Dead Man's Switch lockdown. _tick_clock()/
        # _tick_monitors() already guard every widget touch behind
        # `self.session.authenticated and hasattr(...) and .winfo_exists()`,
        # so they are safe to run before any login.
        self._start_background_heartbeat()
        self._tick_clock()
        self._tick_monitors()
        self._emit_startup_warnings()

    # =========================================================
    # UI BUILD — app shell (header, left nav, workspace, footer)
    # =========================================================
    def _build_ui(self):
        self.root.title(i18n.t("app.title"))
        self.root.grid_rowconfigure(1, weight=1)
        self.root.grid_columnconfigure(0, weight=0)
        self.root.grid_columnconfigure(1, weight=1)
        self._build_header()

        nav_wrap = tk.Frame(self.root, bg=COLOR_PANEL, width=NAV_WIDTH,
                             highlightbackground=COLOR_BORDER, highlightthickness=1)
        nav_wrap.grid(row=1, column=0, sticky="nsw", padx=(16, 8), pady=(0, 8))
        nav_wrap.grid_propagate(False)
        self._build_nav(nav_wrap)

        self.workspace = tk.Frame(self.root, bg=COLOR_BG)
        self.workspace.grid(row=1, column=1, sticky="nsew", padx=(8, 16), pady=(0, 8))
        self.workspace.grid_rowconfigure(0, weight=1)
        self.workspace.grid_columnconfigure(0, weight=1)

        self._build_footer()
        self._show_page(self.active_page)

    def _clear_root(self):
        for child in list(self.root.winfo_children()):
            child.destroy()

    def _show_login(self):
        _sync_palette_aliases()
        self._clear_root()
        self.root.title(i18n.t("login.window_title"))
        self.root.config(bg=COLOR_BG)
        self.login_view = LoginView(
            self.root,
            self.session,
            self._on_authenticated,
            self._set_language,
            self._set_theme,
        )

    def _on_authenticated(self):
        self.login_view = None
        self._clear_root()
        self._build_ui()
        db.log_event("AUTH_LOGIN", "Desktop Admin authenticated", db.INFO)

    def _logout(self):
        if self.session.authenticated:
            db.log_event("AUTH_LOGOUT", "Desktop Admin logged out", db.INFO)
        self.session.logout()
        self._show_login()

    def _rebuild_ui(self):
        """Tear down and rebuild the entire shell in place (used after a
        language change) without restarting the clock/heartbeat/monitor
        timers, which reference self.<widget> freshly on every tick and so
        pick up the rebuilt widgets automatically. Preserves the currently
        active nav page instead of forcing Overview."""
        self._clear_root()
        self.nav_items = {}
        self.metric_cards = {}
        self.activity_rows = []
        self._build_ui()

    def _build_header(self):
        header = tk.Frame(self.root, bg=COLOR_PANEL, highlightbackground=COLOR_BORDER, highlightthickness=1)
        header.grid(row=0, column=0, columnspan=2, sticky="ew", padx=16, pady=16)

        left = tk.Frame(header, bg=COLOR_PANEL)
        left.pack(side="left", fill="y", padx=16, pady=12)
        brand_row = tk.Frame(left, bg=COLOR_PANEL)
        brand_row.pack(anchor="w")
        self._logo_image = load_logo_image(theme_name=theme_state.get_theme())
        if self._logo_image is not None:
            tk.Label(brand_row, image=self._logo_image, bg=COLOR_PANEL).pack(side="left", padx=(0, 8))
        tk.Label(brand_row, text=i18n.t("brand.name"), font=FONT_TITLE, fg=COLOR_ACCENT,
                 bg=COLOR_PANEL).pack(side="left")
        tk.Label(left, text=i18n.t("brand.subtitle"), font=FONT_SUB,
                 fg=COLOR_MUTED, bg=COLOR_PANEL).pack(anchor="w", pady=(2, 0))
        tk.Frame(left, bg=COLOR_ACCENT, height=2, width=48).pack(anchor="w", pady=(6, 0))

        right = tk.Frame(header, bg=COLOR_PANEL)
        right.pack(side="right", fill="y", padx=16, pady=10)
        top_row = tk.Frame(right, bg=COLOR_PANEL)
        top_row.pack(anchor="e")
        self.lbl_clock = tk.Label(top_row, text="--:--:--", font=FONT_CLOCK,
                                  fg=COLOR_TEXT, bg=COLOR_PANEL)
        self.lbl_clock.pack(side="left", padx=(0, 10))
        self._build_language_selector(top_row)
        self._build_theme_selector(top_row)
        tk.Button(
            top_row,
            text=i18n.t("session.logout"),
            font=FONT_HINT,
            fg=COLOR_TEXT,
            bg=COLOR_PANEL_ALT,
            activebackground=COLOR_BORDER,
            activeforeground=COLOR_TEXT,
            bd=0,
            cursor="hand2",
            command=self._logout,
        ).pack(side="left", padx=(8, 0), ipadx=8, ipady=5)
        badges = tk.Frame(right, bg=COLOR_PANEL)
        badges.pack(anchor="e", pady=(6, 0))
        mode_metric = pres.mode_metric(self.armed)
        self.badge_mode = StatusBadge(badges, text=_localize_status_value(mode_metric.value),
                                      status=mode_metric.status, bg=COLOR_PANEL)
        self.badge_mode.pack(side="left", padx=(0, 8))
        broker_metric = pres.broker_metric(getattr(self, "_broker_connected", None))
        self.badge_broker = StatusBadge(
            badges, text=i18n.t("badge.broker_prefix") + _localize_status_value(broker_metric.value),
            status=broker_metric.status, bg=COLOR_PANEL)
        self.badge_broker.pack(side="left", padx=(0, 8))
        esp32_metric = pres.esp32_metric(self.mqtt.seconds_since_device(), config.DEVICE_OFFLINE_SEC)
        self.badge_esp32 = StatusBadge(
            badges, text=i18n.t("badge.esp32_prefix") + _localize_status_value(esp32_metric.value),
            status=esp32_metric.status, bg=COLOR_PANEL)
        self.badge_esp32.pack(side="left")

    def _build_language_selector(self, parent):
        self.language_var = tk.StringVar(value=i18n.LANGUAGE_NATIVE_NAMES[i18n.get_language()])
        options = [name for _code, name in i18n.available_languages()]
        code_by_name = {name: code for code, name in i18n.available_languages()}
        om = tk.OptionMenu(parent, self.language_var, *options,
                           command=lambda name: self._set_language(code_by_name[name]))
        om.config(font=FONT_HINT, bg=COLOR_PANEL_ALT, fg=COLOR_TEXT, activebackground=COLOR_BORDER,
                  highlightthickness=1, highlightbackground=COLOR_BORDER, bd=0, width=6)
        om["menu"].config(bg=COLOR_PANEL_ALT, fg=COLOR_TEXT)
        om.pack(side="left")

    def _set_language(self, code):
        i18n.set_language(code)
        if self.session.authenticated:
            self._rebuild_ui()
        else:
            self._show_login()

    def _build_theme_selector(self, parent):
        labels = {"dark": i18n.t("theme.dark"), "light": i18n.t("theme.light")}
        by_label = {label: name for name, label in labels.items()}
        variable = tk.StringVar(value=labels[theme_state.get_theme()])
        menu = tk.OptionMenu(parent, variable, *labels.values(), command=lambda label: self._set_theme(by_label[label]))
        menu.config(font=FONT_HINT, bg=COLOR_PANEL_ALT, fg=COLOR_TEXT, activebackground=COLOR_BORDER,
                    activeforeground=COLOR_TEXT, highlightthickness=1,
                    highlightbackground=COLOR_BORDER, bd=0, width=6)
        menu["menu"].config(bg=COLOR_PANEL_ALT, fg=COLOR_TEXT)
        menu.pack(side="left", padx=(8, 0))

    def _set_theme(self, name):
        theme_state.set_theme(name)
        _sync_palette_aliases()
        self.root.config(bg=COLOR_BG)
        if self.session.authenticated:
            self._rebuild_ui()
        else:
            self._show_login()

    def _build_nav(self, parent):
        for key, label_key, enabled in NAV_ITEMS:
            suffix = i18n.t("nav.soon_suffix") if not enabled else ""
            item = NavigationItem(parent, i18n.t(label_key), command=lambda k=key: self._show_page(k),
                                   selected=(key == self.active_page), enabled=enabled, suffix=suffix)
            item.pack(fill="x")
            self.nav_items[key] = item

    def _show_page(self, key):
        self.active_page = key
        for item_key, item in self.nav_items.items():
            item.set_selected(item_key == key)
        for child in self.workspace.winfo_children():
            child.destroy()
        self.metric_cards = {}
        builders = {
            "overview": self._build_overview_page,
            "incidents": self._build_incidents_page,
            "devices": self._build_devices_page,
            "lockdown": self._build_lockdown_page,
            "recovery": self._build_recovery_page,
            "audit": self._build_audit_page,
            "diagnostics": self._build_diagnostics_page,
            "settings": self._build_settings_page,
        }
        builders.get(key, self._build_overview_page)(self.workspace)

    def _new_page(self, parent, title_key, subtitle_key, *, badge=False):
        scroll = ScrollFrame(parent)
        scroll.grid(row=0, column=0, sticky="nsew")
        page = scroll.inner
        badge_key = "status.dry_run" if config.DRY_RUN else "status.live"
        badge_status = STATUS_WARNING if config.DRY_RUN else pres.STATUS_HEALTHY
        PageHeader(
            page,
            i18n.t(title_key),
            subtitle=i18n.t(subtitle_key),
            badge_text=i18n.t(badge_key) if badge else None,
            badge_status=badge_status,
            badge_note=i18n.t("overview.dry_run_note") if badge and config.DRY_RUN else None,
        ).pack(anchor="w", fill="x", padx=16, pady=(20, 16))
        return page

    def _add_fact(self, parent, label, value, *, status=pres.STATUS_NEUTRAL):
        palette = ui_theme.get_palette()
        row = tk.Frame(parent, bg=palette.panel)
        row.pack(fill="x", pady=3)
        tk.Label(
            row,
            text=label,
            font=FONT_HINT,
            fg=palette.muted,
            bg=palette.panel,
            width=24,
            anchor="w",
        ).pack(side="left")
        tk.Label(
            row,
            text=value,
            font=FONT_BTN_SM,
            fg=ui_theme.status_color(status),
            bg=palette.panel,
            anchor="w",
        ).pack(side="left", fill="x", expand=True)

    # ---------------------------------------------------------
    # Overview page
    # ---------------------------------------------------------
    def _build_overview_page(self, parent):
        scroll = ScrollFrame(parent)
        scroll.grid(row=0, column=0, sticky="nsew")
        page = scroll.inner

        badge_key = "status.dry_run" if config.DRY_RUN else "status.live"
        badge_status = STATUS_WARNING if config.DRY_RUN else pres.STATUS_HEALTHY
        badge_note = i18n.t("overview.dry_run_note") if config.DRY_RUN else None
        PageHeader(page, i18n.t("overview.title"), subtitle=i18n.t("overview.subtitle"),
                   badge_text=i18n.t(badge_key), badge_status=badge_status,
                   badge_note=badge_note).pack(anchor="w", fill="x", padx=16, pady=(20, 16))

        grid = tk.Frame(page, bg=COLOR_BG)
        grid.pack(fill="x", padx=16, pady=(0, 16))
        for col in range(4):
            grid.grid_columnconfigure(col, weight=1, uniform="metric")

        for index, (metric_key, label_key) in enumerate(METRIC_LABEL_KEYS.items()):
            row, col = divmod(index, 4)
            card = MetricCard(grid, label=i18n.t(label_key), status=pres.STATUS_UNKNOWN)
            card.grid(row=row, column=col, sticky="nsew", padx=8, pady=8)
            self.metric_cards[metric_key] = card
        self._refresh_overview_metrics()

        summary = Section(page, i18n.t("overview.summary_title"), accent=COLOR_ACCENT)
        summary.pack(fill="x", padx=16, pady=(0, 16))
        self._add_fact(
            summary.body,
            i18n.t("overview.command_evidence"),
            i18n.t("overview.no_pending") if self.pending_cmd is None else i18n.t("overview.pending_ack"),
            status=pres.STATUS_HEALTHY if self.pending_cmd is None else pres.STATUS_WARNING,
        )
        self._add_fact(
            summary.body,
            i18n.t("overview.physical_evidence"),
            i18n.t("overview.physical_unknown"),
            status=pres.STATUS_UNKNOWN,
        )

        activity = Section(page, i18n.t("activity.section_title"), accent=COLOR_ACCENT)
        activity.pack(fill="x", padx=16, pady=(0, 16))
        self.activity_body = activity.body
        header_row = EvidenceRow(self.activity_body, i18n.t("activity.col_time"), i18n.t("activity.col_severity"),
                                 i18n.t("activity.col_event"), i18n.t("activity.col_source"), header=True)
        header_row.pack(fill="x", anchor="w")
        self.activity_rows = []
        self._refresh_recent_activity()

        self.refresh_incident_banner()

    # ---------------------------------------------------------
    # Evidence and control workspaces
    # ---------------------------------------------------------
    def _build_incidents_page(self, parent):
        page = self._new_page(parent, "incidents.title", "incidents.subtitle")
        section = Section(page, i18n.t("incidents.section_title"), accent=COLOR_WARN)
        section.pack(fill="x", padx=16, pady=(0, 16))
        try:
            self.incident_records = db.fetch_incidents(limit=100)
        except Exception as error:
            print(f"incident list error: {error}")
            self.incident_records = []
        if not self.incident_records:
            make_hint(section.body, i18n.t("incidents.empty")).pack(anchor="w", pady=(10, 4))
            return
        palette = ui_theme.get_palette()
        self.incident_listbox = tk.Listbox(
            section.body,
            font=FONT_MONO,
            fg=palette.text,
            bg=palette.panel_alt,
            selectforeground=palette.text,
            selectbackground=palette.surface_elevated,
            highlightthickness=1,
            highlightbackground=palette.border,
            relief="flat",
            height=min(7, len(self.incident_records)),
            activestyle="none",
        )
        self.incident_listbox.pack(fill="x")
        for incident in self.incident_records:
            opened = incident.get("opened_at") or "—"
            state = incident.get("state") or "UNKNOWN"
            evidence = incident.get("attacker_ip") or incident.get("summary") or i18n.t("status.unknown")
            self.incident_listbox.insert(tk.END, f"#{incident['id']:<5} {opened:<20} {state:<12} {evidence}")
        self.incident_listbox.bind("<<ListboxSelect>>", self._on_incident_selected)
        self.incident_listbox.selection_set(0)

        details = Section(page, i18n.t("incidents.details_title"), accent=COLOR_ACCENT)
        details.pack(fill="x", padx=16, pady=(0, 20))
        self.incident_detail_body = details.body
        self._render_incident_detail(self.incident_records[0])

    def _on_incident_selected(self, _event=None):
        selection = self.incident_listbox.curselection()
        if selection:
            self._render_incident_detail(self.incident_records[selection[0]])

    def _render_incident_detail(self, incident):
        for child in self.incident_detail_body.winfo_children():
            child.destroy()
        fields = (
            ("incidents.detail_id", f"#{incident['id']}"),
            ("incidents.detail_severity", i18n.t("incidents.severity_unrecorded")),
            ("incidents.detail_state", incident.get("state") or i18n.t("status.unknown")),
            ("incidents.detail_opened", incident.get("opened_at") or "—"),
            ("incidents.detail_closed", incident.get("closed_at") or "—"),
            ("incidents.detail_ip", incident.get("attacker_ip") or i18n.t("incidents.no_evidence")),
            ("incidents.detail_summary", incident.get("summary") or i18n.t("incidents.no_evidence")),
        )
        for label_key, value in fields:
            self._add_fact(self.incident_detail_body, i18n.t(label_key), value)
        tk.Label(
            self.incident_detail_body,
            text=i18n.t("incidents.timeline_title"),
            font=FONT_BTN_SM,
            fg=COLOR_TEXT,
            bg=COLOR_PANEL,
        ).pack(anchor="w", pady=(12, 4))
        linked = [row for row in db.fetch_all_logs() if row[5] == incident["id"]]
        if not linked:
            make_hint(self.incident_detail_body, i18n.t("incidents.timeline_empty")).pack(anchor="w")
        for _row_id, timestamp, level, event_type, _details, _incident_id in linked[:6]:
            EvidenceRow(
                self.incident_detail_body,
                timestamp,
                level,
                event_type,
                f"#{incident['id']}",
                widths=(20, 10, 42, 10),
            ).pack(fill="x")

    def _build_devices_page(self, parent):
        page = self._new_page(parent, "devices.title", "devices.subtitle")
        grid = tk.Frame(page, bg=COLOR_BG)
        grid.pack(fill="x", padx=16, pady=(0, 16))
        for column in range(3):
            grid.grid_columnconfigure(column, weight=1, uniform="device")
        seconds = self.mqtt.seconds_since_device()
        metrics = (
            pres.broker_metric(getattr(self, "_broker_connected", None)),
            pres.esp32_metric(
                seconds,
                config.DEVICE_OFFLINE_SEC,
                getattr(self, "_last_rssi", None),
                getattr(self, "_last_heap", None),
            ),
            pres.uplink_metric(getattr(self, "_last_uplink_state", None)),
        )
        labels = ("metric.broker", "metric.esp32", "metric.uplink")
        for column, (metric, label_key) in enumerate(zip(metrics, labels)):
            card = MetricCard(
                grid,
                label=i18n.t(label_key),
                value=_localize_status_value(metric.value),
                status=metric.status,
                helper=metric.helper,
            )
            card.grid(row=0, column=column, sticky="nsew", padx=8, pady=8)
        evidence = Section(page, i18n.t("devices.evidence_title"), accent=COLOR_ACCENT)
        evidence.pack(fill="x", padx=16, pady=(0, 20))
        esp32_status_metric = metrics[1]
        self._add_fact(
            evidence.body,
            i18n.t("devices.last_seen"),
            f"{seconds:.0f}s" if seconds is not None else i18n.t("status.unknown"),
            # Reuse the same staleness-aware status esp32_metric() already
            # computed above (seconds_since_seen vs. DEVICE_OFFLINE_SEC) --
            # a numeric "seconds ago" value existing is not, by itself,
            # evidence of health. A stale last-seen timestamp must not
            # render as a healthy/green status.
            status=esp32_status_metric.status,
        )
        self._add_fact(
            evidence.body,
            "RSSI",
            f"{self._last_rssi} dBm" if getattr(self, "_last_rssi", None) is not None else "—",
            status=pres.STATUS_NEUTRAL if getattr(self, "_last_rssi", None) is not None else pres.STATUS_UNKNOWN,
        )
        self._add_fact(
            evidence.body,
            i18n.t("devices.heap"),
            f"{self._last_heap} B" if getattr(self, "_last_heap", None) is not None else "—",
            status=pres.STATUS_NEUTRAL if getattr(self, "_last_heap", None) is not None else pres.STATUS_UNKNOWN,
        )

    def _build_lockdown_page(self, parent):
        page = self._new_page(parent, "lockdown.title", "lockdown.subtitle", badge=True)
        readiness = Section(page, i18n.t("lockdown.readiness_title"), accent=COLOR_ACCENT)
        readiness.pack(fill="x", padx=16, pady=(0, 16))
        mode = pres.mode_metric(self.armed)
        broker = pres.broker_metric(getattr(self, "_broker_connected", None))
        self._add_fact(
            readiness.body,
            i18n.t("metric.mode"),
            _localize_status_value(mode.value),
            status=mode.status,
        )
        self._add_fact(
            readiness.body,
            i18n.t("metric.broker"),
            _localize_status_value(broker.value),
            status=broker.status,
        )
        uplink = pres.uplink_metric(getattr(self, "_last_uplink_state", None))
        esp32 = pres.esp32_metric(self.mqtt.seconds_since_device(), config.DEVICE_OFFLINE_SEC)
        self._add_fact(
            readiness.body,
            i18n.t("metric.uplink"),
            _localize_status_value(uplink.value),
            status=uplink.status,
        )
        self._add_fact(
            readiness.body,
            i18n.t("metric.esp32"),
            _localize_status_value(esp32.value),
            status=esp32.status,
        )
        make_hint(readiness.body, i18n.t("lockdown.evidence_note")).pack(anchor="w", pady=(8, 0))

        controls = Section(page, i18n.t("controls.section_title"), accent=COLOR_DANGER)
        controls.pack(fill="x", padx=16, pady=(0, 20))
        row1 = tk.Frame(controls.body, bg=COLOR_PANEL)
        row1.pack(fill="x")
        self.btn_arm = tk.Button(
            row1,
            text=i18n.t("controls.arm_to_disarm"),
            font=FONT_BTN_SM,
            fg="white",
            bg=COLOR_WARN,
            activebackground=COLOR_WARN_HL,
            bd=0,
            height=2,
            cursor="hand2",
            command=self.toggle_arm,
        )
        self.btn_arm.pack(side="left", fill="x", expand=True, padx=(0, 6))
        self.btn_recovery = tk.Button(
            row1,
            text=i18n.t("controls.recovery_button"),
            font=FONT_BTN_SM,
            fg="white",
            bg=COLOR_WARN,
            activebackground=COLOR_WARN_HL,
            bd=0,
            height=2,
            cursor="hand2",
            command=self.open_recovery_wizard,
        )
        self.btn_recovery.pack(side="left", fill="x", expand=True, padx=(6, 0))
        row2 = tk.Frame(controls.body, bg=COLOR_PANEL)
        row2.pack(fill="x", pady=(8, 0))
        self.btn_cut = tk.Button(
            row2,
            text=i18n.t("controls.cut_button"),
            font=FONT_BTN,
            fg="white",
            bg=COLOR_DANGER,
            activebackground=COLOR_DANGER_HL,
            activeforeground="white",
            height=2,
            bd=0,
            cursor="hand2",
            command=self.on_cut_clicked,
        )
        self.btn_cut.pack(side="left", fill="x", expand=True, padx=(0, 6))
        self.btn_restore = tk.Button(
            row2,
            text=i18n.t("controls.restore_button"),
            font=FONT_BTN,
            fg="white",
            bg=COLOR_SUCCESS,
            activebackground=COLOR_SUCCESS_HL,
            activeforeground="white",
            height=2,
            bd=0,
            cursor="hand2",
            command=self.on_restore_clicked,
        )
        self.btn_restore.pack(side="left", fill="x", expand=True, padx=(6, 0))
        make_hint(controls.body, i18n.t("controls.hint")).pack(anchor="w", pady=(8, 0))
        self._sync_arm_controls()

    def _build_recovery_page(self, parent):
        page = self._new_page(parent, "recovery.page_title", "recovery.page_subtitle")
        steps = Section(page, i18n.t("recovery.heading"), accent=COLOR_WARN)
        steps.pack(fill="x", padx=16, pady=(0, 16))
        for index in range(1, 6):
            row = tk.Frame(steps.body, bg=COLOR_PANEL)
            row.pack(fill="x", pady=5)
            tk.Label(
                row,
                text=f"{index:02d}",
                font=FONT_BTN,
                fg=COLOR_WARN_HL,
                bg=COLOR_PANEL_ALT,
                width=4,
                pady=8,
            ).pack(side="left", padx=(0, 10))
            text = tk.Frame(row, bg=COLOR_PANEL)
            text.pack(side="left", fill="x", expand=True)
            tk.Label(
                text,
                text=i18n.t(f"recovery.step{index}_title"),
                font=FONT_BTN_SM,
                fg=COLOR_TEXT,
                bg=COLOR_PANEL,
                anchor="w",
            ).pack(fill="x")
            tk.Label(
                text,
                text=i18n.t(f"recovery.step{index}_desc"),
                font=FONT_HINT,
                fg=COLOR_MUTED,
                bg=COLOR_PANEL,
                anchor="w",
                justify="left",
                wraplength=780,
            ).pack(fill="x")
        tk.Button(
            page,
            text=i18n.t("controls.recovery_button"),
            font=FONT_BTN,
            fg="white",
            bg=COLOR_BLUE,
            activebackground=COLOR_BLUE_HL,
            bd=0,
            height=2,
            cursor="hand2",
            command=self.open_recovery_wizard,
        ).pack(fill="x", padx=16, pady=(0, 20))

    def _build_audit_page(self, parent):
        page = self._new_page(parent, "audit.title", "audit.subtitle")
        structured = Section(page, i18n.t("audit.structured_title"), accent=COLOR_ACCENT)
        structured.pack(fill="x", padx=16, pady=(0, 16))
        EvidenceRow(
            structured.body,
            i18n.t("activity.col_time"),
            i18n.t("activity.col_severity"),
            i18n.t("activity.col_event"),
            i18n.t("activity.col_source"),
            header=True,
        ).pack(fill="x")
        activity_rows = pres.build_activity_rows(db.fetch_all_logs(), limit=6)
        if not activity_rows:
            make_hint(structured.body, i18n.t("activity.empty")).pack(anchor="w", pady=(8, 0))
        for row in activity_rows:
            EvidenceRow(structured.body, row.time, row.severity, row.event, row.source).pack(fill="x")

        logsec = Section(page, i18n.t("log.section_title"), accent=COLOR_PURPLE)
        logsec.pack(fill="both", expand=True, padx=16, pady=(0, 20))
        toolbar = tk.Frame(logsec.body, bg=COLOR_PANEL)
        toolbar.pack(fill="x", pady=(0, 8))
        tk.Label(
            toolbar,
            text=i18n.t("log.filter_label"),
            font=FONT_HINT,
            fg=COLOR_MUTED,
            bg=COLOR_PANEL,
        ).pack(side="left")
        filter_all = i18n.t("log.filter_all")
        filter_options = (filter_all, i18n.t("log.filter_warn"), i18n.t("log.filter_crit"))
        self.filter_var = tk.StringVar(value=filter_all)
        menu = tk.OptionMenu(toolbar, self.filter_var, *filter_options, command=lambda _=None: self._redraw_log())
        menu.config(
            font=FONT_HINT,
            bg=COLOR_PANEL_ALT,
            fg=COLOR_TEXT,
            activebackground=COLOR_BORDER,
            highlightthickness=0,
            bd=0,
        )
        menu["menu"].config(bg=COLOR_PANEL_ALT, fg=COLOR_TEXT)
        menu.pack(side="left", padx=(6, 0))
        tk.Button(
            toolbar,
            text=i18n.t("log.export_button"),
            font=FONT_BTN_SM,
            fg="white",
            bg=COLOR_BLUE,
            activebackground=COLOR_BLUE_HL,
            bd=0,
            cursor="hand2",
            command=self.export_audit_log,
        ).pack(side="right")
        self.log_box = scrolledtext.ScrolledText(
            logsec.body,
            bg=COLOR_PANEL_ALT,
            fg=COLOR_TEXT,
            font=FONT_MONO,
            bd=0,
            insertbackground=COLOR_TEXT,
            highlightthickness=1,
            highlightbackground=COLOR_BORDER,
            height=24,
        )
        self.log_box.pack(fill="both", expand=True, pady=(0, 10))
        for level, color in LEVEL_COLORS.items():
            self.log_box.tag_config(level, foreground=color)
        self._redraw_log()
        tk.Button(
            logsec.body,
            text=i18n.t("log.verify_button"),
            font=FONT_BTN_SM,
            fg="white",
            bg=COLOR_BLUE,
            activebackground=COLOR_BLUE_HL,
            command=self.verify_log_integrity,
            bd=0,
            cursor="hand2",
        ).pack(fill="x")

    def _build_diagnostics_page(self, parent):
        page = self._new_page(parent, "diagnostics.title", "diagnostics.subtitle")
        runtime = Section(page, i18n.t("diagnostics.runtime_title"), accent=COLOR_ACCENT)
        runtime.pack(fill="x", padx=16, pady=(0, 16))
        facts = (
            ("diagnostics.profile", os.getenv("AEGIS_PROFILE", i18n.t("status.unknown"))),
            ("diagnostics.dry_run", self._yes_no(config.DRY_RUN)),
            ("diagnostics.auto_contain", self._yes_no(config.AUTO_CONTAIN)),
            ("diagnostics.broker_config", self._configured(config.BROKER_CONFIGURED)),
            ("diagnostics.mqtt_auth", self._configured(bool(config.MQTT_USER and config.MQTT_PASS))),
            ("diagnostics.hmac", self._configured(config.SECRET_KEY != config.DEMO_SECRET)),
            ("diagnostics.admin_pin", self._configured(config.ADMIN_PIN_CONFIGURED)),
        )
        for label_key, value in facts:
            self._add_fact(runtime.body, i18n.t(label_key), value)
        try:
            audit_ok, _audit_message = db.verify_chain()
            audit_value = i18n.t("diagnostics.audit_valid" if audit_ok else "diagnostics.audit_invalid")
            audit_status = pres.STATUS_HEALTHY if audit_ok else pres.STATUS_CRITICAL
        except Exception:
            audit_value = i18n.t("status.unknown")
            audit_status = pres.STATUS_UNKNOWN
        self._add_fact(
            runtime.body,
            i18n.t("diagnostics.database"),
            self._configured(os.path.exists(config.DB_PATH)),
        )
        self._add_fact(runtime.body, i18n.t("diagnostics.audit_chain"), audit_value, status=audit_status)
        make_hint(runtime.body, i18n.t("diagnostics.no_secrets")).pack(anchor="w", pady=(10, 2))

    def _configured(self, value):
        return i18n.t("diagnostics.configured" if value else "diagnostics.not_configured")

    def _yes_no(self, value):
        return i18n.t("common.yes" if value else "common.no")

    def _build_settings_page(self, parent):
        page = self._new_page(parent, "settings.title", "settings.subtitle")
        preferences = Section(page, i18n.t("settings.preferences_title"), accent=COLOR_ACCENT)
        preferences.pack(fill="x", padx=16, pady=(0, 16))
        controls = tk.Frame(preferences.body, bg=COLOR_PANEL)
        controls.pack(anchor="w")
        self._build_language_selector(controls)
        self._build_theme_selector(controls)
        make_hint(preferences.body, i18n.t("settings.persist_note")).pack(anchor="w", pady=(10, 2))
        session = Section(page, i18n.t("settings.session_title"), accent=COLOR_SUCCESS_HL)
        session.pack(fill="x", padx=16, pady=(0, 20))
        self._add_fact(session.body, i18n.t("settings.admin_id"), self.session.admin_id or "—")
        signed_in = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(self.session.authenticated_at or 0))
        self._add_fact(session.body, i18n.t("settings.signed_in"), signed_in)
        about = Section(page, i18n.t("settings.about_title"), accent=COLOR_ACCENT)
        about.pack(fill="x", padx=16, pady=(0, 20))
        self._add_fact(about.body, i18n.t("settings.product"), "AEGIS IDEA3")
        make_hint(about.body, i18n.t("settings.about_text")).pack(anchor="w", pady=(8, 2))

    def _refresh_overview_metrics(self):
        if "health" not in self.metric_cards:
            return
        seconds_since_seen = self.mqtt.seconds_since_device()
        broker_connected = getattr(self, "_broker_connected", None)
        uplink_state = getattr(self, "_last_uplink_state", None)
        rssi = getattr(self, "_last_rssi", None)
        heap = getattr(self, "_last_heap", None)
        remaining = max(0.0, config.DEADMAN_TIMEOUT_SEC - (time.time() - self.last_heartbeat_sent_ts))

        metrics = {
            "health": pres.system_health_metric(broker_connected, seconds_since_seen, config.DEVICE_OFFLINE_SEC),
            "uplink": pres.uplink_metric(uplink_state),
            "broker": pres.broker_metric(broker_connected),
            "esp32": pres.esp32_metric(seconds_since_seen, config.DEVICE_OFFLINE_SEC, rssi, heap),
            "mode": pres.mode_metric(self.armed),
            "deadman": pres.deadman_metric(remaining),
            "incidents": pres.incidents_metric(self._safe_open_incident()),
            "today": pres.today_metric(self._safe_incidents_today()),
        }
        for key, metric in metrics.items():
            card = self.metric_cards.get(key)
            if card is not None:
                card.update(_localize_status_value(metric.value), metric.status, metric.helper)

    def _refresh_recent_activity(self):
        if not hasattr(self, "activity_body") or not self.activity_body.winfo_exists():
            return
        for row in self.activity_rows:
            row.destroy()
        self.activity_rows = []
        try:
            rows = pres.build_activity_rows(db.fetch_all_logs(), limit=RECENT_ACTIVITY_LIMIT)
        except Exception as e:
            print(f"recent activity error: {e}")
            rows = []
        if not rows:
            empty = tk.Label(self.activity_body, text=i18n.t("activity.empty"), font=FONT_HINT,
                             fg=COLOR_MUTED, bg=COLOR_PANEL)
            empty.pack(anchor="w", pady=(4, 0))
            self.activity_rows.append(empty)
            return
        for row in rows:
            widget = EvidenceRow(self.activity_body, row.time, row.severity, row.event, row.source)
            widget.pack(fill="x", anchor="w")
            self.activity_rows.append(widget)

    def _safe_open_incident(self):
        try:
            return db.get_open_incident()
        except Exception as e:
            print(f"incident lookup error: {e}")
            return None

    def _safe_incidents_today(self):
        try:
            return db.count_incidents_today()
        except Exception as e:
            print(f"incident count error: {e}")
            return 0

    def _sync_arm_controls(self):
        """Re-apply the current armed/locked state to whichever Operational
        Controls widgets exist right now (they are rebuilt on every page
        switch back to Overview)."""
        if not hasattr(self, "btn_arm") or not self.btn_arm.winfo_exists():
            return
        if self.armed:
            self.btn_arm.config(text=i18n.t("controls.arm_to_disarm"), bg=COLOR_WARN,
                                activebackground=COLOR_WARN_HL)
        else:
            self.btn_arm.config(text=i18n.t("controls.arm_to_arm"), bg=COLOR_SUCCESS,
                                activebackground=COLOR_SUCCESS_HL)
        if self.locked:
            for b in (self.btn_cut, self.btn_restore, self.btn_arm, self.btn_recovery):
                b.config(state="disabled")
        else:
            self.btn_restore.config(state="normal")
            self.btn_arm.config(state="normal")
            self.btn_recovery.config(state="normal")
            self.btn_cut.config(state="normal" if self.armed else "disabled")

    def _build_footer(self):
        footer = tk.Frame(self.root, bg=COLOR_PANEL, highlightbackground=COLOR_BORDER, highlightthickness=1)
        footer.grid(row=2, column=0, columnspan=2, sticky="ew", padx=16, pady=(0, 16))
        tk.Label(footer, text="●", font=("Segoe UI", 10), fg=COLOR_SUCCESS_HL, bg=COLOR_PANEL).pack(
            side="left", padx=(12, 4), pady=6)
        tk.Label(footer, text=i18n.t("footer.safety_line"),
                 font=("Segoe UI", 8), fg=COLOR_MUTED, bg=COLOR_PANEL).pack(side="left", pady=6)
        tk.Label(footer, text=i18n.t("footer.brand"), font=("Segoe UI", 8, "bold"), fg=COLOR_MUTED,
                 bg=COLOR_PANEL).pack(side="right", padx=12, pady=6)

    # =========================================================
    # TIMERS / MONITORS
    # =========================================================
    def _tick_clock(self):
        if self.session.authenticated and hasattr(self, "lbl_clock") and self.lbl_clock.winfo_exists():
            self.lbl_clock.config(text=time.strftime("%H:%M:%S"))
        self.root.after(1000, self._tick_clock)

    def _tick_monitors(self):
        # Device liveness (ESP32 ยังส่งข้อความอยู่ไหม)
        s = self.mqtt.seconds_since_device()
        esp32 = pres.esp32_metric(s, config.DEVICE_OFFLINE_SEC,
                                  getattr(self, "_last_rssi", None), getattr(self, "_last_heap", None))
        if self.session.authenticated and hasattr(self, "badge_esp32") and self.badge_esp32.winfo_exists():
            self.badge_esp32.update_status(
                i18n.t("badge.esp32_prefix") + _localize_status_value(esp32.value),
                esp32.status,
            )

        self._refresh_overview_metrics()

        # ACK timeout: ส่งคำสั่งแล้วไม่มี ACK ตอบภายในเวลา
        if self.pending_cmd and (time.time() - self.pending_cmd["ts"]) > config.ACK_TIMEOUT_SEC:
            act = self.pending_cmd["action"]
            self.pending_cmd = None
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [WARN] ไม่มี ACK ตอบกลับสำหรับ {act} "
                             f"ภายใน {config.ACK_TIMEOUT_SEC}s — คำสั่งอาจไปไม่ถึงบอร์ด", db.WARN)

        self.root.after(1000, self._tick_monitors)

    def _emit_startup_warnings(self):
        for w in config.validate_config():
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [WARN] {w}", db.WARN)

    # =========================================================
    # MQTT CALLBACKS (เรียกผ่าน root.after จาก main → thread-safe)
    # =========================================================
    def set_broker_state(self, connected):
        self._broker_connected = bool(connected)
        metric = pres.broker_metric(self._broker_connected)
        if self.session.authenticated and hasattr(self, "badge_broker") and self.badge_broker.winfo_exists():
            self.badge_broker.update_status(
                i18n.t("badge.broker_prefix") + _localize_status_value(metric.value),
                metric.status,
            )
        self._refresh_overview_metrics()

    def on_status(self, state, rssi, heap):
        prev = getattr(self, "_last_uplink_state", None)   # สถานะครั้งก่อน
        changed = (prev != state)                          # เปลี่ยนไหม
        self._last_uplink_state = state
        self._last_rssi = rssi
        self._last_heap = heap

        if state == "LOCKDOWN" and changed:
            self.trigger_alarm(config.SOUND_LOCKDOWN)
            self.refresh_incident_banner()
        elif state == "NORMAL" and changed:
            self.trigger_alarm(config.SOUND_RESTORE)

        self._refresh_overview_metrics()

    def on_ack(self, ack, detail, nonce):
        """จับคู่ ACK กับคำสั่งที่รออยู่ด้วย nonce"""
        if not self.pending_cmd:
            return

        expected_nonce = self.pending_cmd.get("nonce")
        if not nonce or nonce != expected_nonce:
            self.log_message(
                f"[{time.strftime('%H:%M:%S')}] [WARN] ละเว้น ACK ที่ nonce ไม่ตรงกับคำสั่งที่รอ",
                db.WARN,
            )
            return

        act = self.pending_cmd["action"]
        if ack == "OK":
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [OK] ESP32 ยืนยันรับคำสั่ง {act} แล้ว", db.INFO)
        else:
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [WARN] ESP32 ปฏิเสธคำสั่ง {act}: {ack} ({detail})",
                             db.WARN)
        self.pending_cmd = None

    # =========================================================
    # LOG
    # =========================================================
    def log_message(self, message, level="INFO"):
        self.log_buffer.append((message, level))
        if (
            hasattr(self, "log_box")
            and self.log_box.winfo_exists()
            and self._passes_filter(level)
        ):
            self.log_box.insert(tk.END, f"{message}\n", level)
            self.log_box.see(tk.END)
        db.log_to_file_only(message, level)      # ← เพิ่มบรรทัดนี้: บันทึกลงไฟล์ทุกครั้ง
        self._refresh_recent_activity()

    def _passes_filter(self, level):
        # Compared against the *current* language's filter labels (not a
        # fixed module constant) so a language switch -- which rebuilds
        # self.filter_var from scratch -- never leaves a stale comparison.
        f = self.filter_var.get() if hasattr(self, "filter_var") else i18n.t("log.filter_all")
        rank = _LEVEL_RANK.get(level, 0)
        if f == i18n.t("log.filter_warn"):
            return rank >= 1
        if f == i18n.t("log.filter_crit"):
            return rank >= 2
        return True

    def _redraw_log(self):
        if not hasattr(self, "log_box") or not self.log_box.winfo_exists():
            return
        self.log_box.delete("1.0", tk.END)
        rows = []
        try:
            for row_id, timestamp, level, event_type, details, incident_id in reversed(db.fetch_all_logs()):
                incident = f" · incident #{incident_id}" if incident_id else ""
                rows.append((f"[{timestamp}] [{event_type}] {details}{incident}", level))
        except Exception as error:
            print(f"audit log read error: {error}")
        rows.extend(self.log_buffer)
        for msg, lvl in rows:
            if self._passes_filter(lvl):
                self.log_box.insert(tk.END, f"{msg}\n", lvl)
        if not rows:
            self.log_box.insert(tk.END, i18n.t("log.ready_placeholder") + "\n", "INFO")
        self.log_box.see(tk.END)

    # =========================================================
    # INCIDENT BANNER
    # =========================================================
    def refresh_incident_banner(self):
        try:
            self._refresh_overview_metrics()
        except Exception as e:
            print(f"banner error: {e}")

    # =========================================================
    # ARM / DISARM
    # =========================================================
    def toggle_arm(self):
        if self.locked:
            return
        pin = simpledialog.askstring(i18n.t("dialog.admin_auth_title"),
                                     i18n.t("dialog.pin_prompt_mode"), show='*')
        if not config.verify_pin(pin):
            self._handle_bad_pin(pin)
            return
        self.pin_attempts = 0
        self.armed = not self.armed
        mode_metric = pres.mode_metric(self.armed)
        self.badge_mode.update_status(_localize_status_value(mode_metric.value), mode_metric.status)
        self._sync_arm_controls()
        self._refresh_overview_metrics()
        if self.armed:
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [ARMED] เข้าสู่โหมดเฝ้าระวังปกติ", db.INFO)
            db.log_event("MODE_CHANGE", "System ARMED", db.INFO)
        else:
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [DISARMED] เข้าสู่โหมดซ่อมบำรุง — ปิดปุ่มตัดเน็ตชั่วคราว",
                             db.WARN)
            db.log_event("MODE_CHANGE", "System DISARMED (maintenance)", db.WARN)

    # =========================================================
    # COMMANDS
    # =========================================================
    def _handle_bad_pin(self, pin):
        if pin is None:
            return  # ยกเลิก ไม่นับเป็นกรอกผิด
        self.pin_attempts += 1
        remaining = config.MAX_PIN_ATTEMPTS - self.pin_attempts
        db.log_event("SECURITY_ALERT", f"Wrong PIN attempt ({self.pin_attempts}/{config.MAX_PIN_ATTEMPTS})",
                     db.WARN)
        if self.pin_attempts >= config.MAX_PIN_ATTEMPTS:
            self._lock_controls()
        else:
            messagebox.showerror(i18n.t("dialog.access_denied_title"),
                                 i18n.t("dialog.wrong_pin_remaining", remaining=remaining))

    def _lock_controls(self):
        self.locked = True
        self._sync_arm_controls()
        self.log_message(f"[{time.strftime('%H:%M:%S')}] [CRITICAL] ใส่ PIN ผิดครบ "
                         f"{config.MAX_PIN_ATTEMPTS} ครั้ง — ล็อกการควบคุม 60 วินาที", db.CRITICAL)
        db.log_event("SECURITY_ALERT", "Controls locked (too many wrong PIN)", db.CRITICAL)
        messagebox.showerror(i18n.t("dialog.locked_title"),
                             i18n.t("dialog.locked_message", max_attempts=config.MAX_PIN_ATTEMPTS))
        self.root.after(60_000, self._unlock_controls)

    def _unlock_controls(self):
        self.locked = False
        self.pin_attempts = 0
        # The Operational Controls buttons only exist while the Overview page
        # is the active workspace (they are rebuilt on every navigation);
        # _sync_arm_controls() safely no-ops if they are not present right now.
        self._sync_arm_controls()
        self.log_message(f"[{time.strftime('%H:%M:%S')}] [INFO] ปลดล็อกการควบคุมแล้ว", db.INFO)

    def _auth(self, prompt=None):
        if self.locked:
            messagebox.showwarning(i18n.t("dialog.locked_title"), i18n.t("dialog.locked_wait"))
            return False
        pin = simpledialog.askstring(i18n.t("dialog.admin_auth_title"),
                                     prompt or i18n.t("dialog.pin_prompt_default"), show='*')
        if config.verify_pin(pin):
            self.pin_attempts = 0
            return True
        self._handle_bad_pin(pin)
        return False

    def on_cut_clicked(self):
        if not self.armed:
            messagebox.showwarning(i18n.t("dialog.disarmed_title"), i18n.t("dialog.disarmed_message"))
            return
        if not self._auth():
            return
        # Double confirmation: the operator must type the literal word
        # CONFIRM. That word is never translated -- it is compared verbatim
        # below and localizing it would silently change what must be typed
        # to authorize a destructive command.
        confirm = simpledialog.askstring(i18n.t("dialog.confirm_cut_title"),
                                         i18n.t("dialog.confirm_cut_message"))
        if (confirm or "").strip().upper() != "CONFIRM":
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [INFO] ยกเลิกคำสั่งตัด (ไม่ได้ยืนยัน CONFIRM)", db.INFO)
            return
        self.prompt_block_attacker_ip()
        self.send_command("CUT_UPLINK", "ตัดการเชื่อมต่อเครือข่าย", critical=True)

    def on_restore_clicked(self):
        if not self._auth():
            return
        self.send_command(
            "RESTORE_UPLINK",
            "คืนค่าระบบเครือข่ายปกติ",
            authorize_restore=True,
        )

    def send_command(self, action_value, desc, critical=False, authorize_restore=False, origin="gui"):
        result = self.controller.issue(
            action_value,
            desc,
            critical=critical,
            origin=origin,
            authorize_restore=authorize_restore,
        )
        t = time.strftime('%H:%M:%S')
        if result.sent:
            self.pending_cmd = {"action": action_value, "ts": time.time(), "nonce": result.nonce}
            lvl = db.CRITICAL if critical else db.INFO
            self.log_message(f"[{t}] [COMMAND] ส่ง {desc} แล้ว — รอ ACK ยืนยันจากบอร์ด", lvl)
        elif result.dry_run and result.ok:
            lvl = db.CRITICAL if critical else db.INFO
            self.log_message(f"[{t}] [DRY-RUN] WOULD_SEND {action_value} — ไม่ publish ไปยังอุปกรณ์", lvl)
        else:
            self.log_message(f"[{t}] [WARN] ส่งคำสั่งไม่ได้ — MQTT ยังไม่เชื่อมต่อ", db.WARN)
            messagebox.showwarning(i18n.t("dialog.mqtt_not_ready_title"), i18n.t("dialog.mqtt_not_ready_message"))

    def run_ufw_async(self, args, on_done):
        def worker():
            ok, out = comms.ufw_exec(args)
            self.root.after(0, lambda: on_done(ok, out))
        threading.Thread(target=worker, daemon=True).start()

    def prompt_block_attacker_ip(self):
        # ถ้า detector ส่ง IP มาแล้ว → ใช้เลย ไม่ต้องถาม
        auto_ip = self.mqtt.last_attacker_ip
        if auto_ip and self._is_valid_ip(auto_ip):
            ip = auto_ip
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [AUTO] ใช้ IP จาก detector: {ip}", db.WARN)
        else:
            # ไม่มี IP อัตโนมัติ → ค่อยถาม (เผื่อกรอกเอง/เว้นว่างข้าม)
            ip = simpledialog.askstring(i18n.t("dialog.ufw_prompt_title"),
                                        i18n.t("dialog.ufw_prompt_message"))
            if not ip or not ip.strip():
                self.mqtt.last_attacker_ip = None
                return
            ip = ip.strip()
            if not self._is_valid_ip(ip):
                messagebox.showerror(i18n.t("dialog.invalid_ip_title"), i18n.t("dialog.invalid_ip_message", ip=ip))
                self.mqtt.last_attacker_ip = None
                return

        # จากตรงนี้ลงไป: มี ip ที่ถูกต้องแล้ว (ไม่ว่าจาก auto หรือกรอกเอง)
        self.mqtt.last_attacker_ip = ip
        db.create_incident(ip)
        self.refresh_incident_banner()
        t = time.strftime('%H:%M:%S')
        self.log_message(f"[{t}] [UFW] กำลังขอสิทธิ์เพื่อบล็อก {ip} ...", db.WARN)

        def on_done(ok, out):
            t2 = time.strftime('%H:%M:%S')
            if ok:
                self.log_message(f"[{t2}] [UFW] ✅ บล็อก {ip} สำเร็จ", db.WARN)
                db.log_event("UFW_BLOCK", f"deny from {ip} - success", db.WARN)
            else:
                self.log_message(f"[{t2}] [UFW] ❌ บล็อก {ip} ไม่สำเร็จ: {out}", db.WARN)
                db.log_event("UFW_BLOCK", f"deny from {ip} - failed: {out}", db.WARN)

        self.run_ufw_async(["deny", "from", ip], on_done)
    def _is_valid_ip(self, ip):
        """เช็กว่าเป็น IP address ที่ถูกต้องไหม (คืน True/False)"""
        try:
            ipaddress.ip_address(ip)
            return True
        except ValueError:
            return False


    def on_attacker_detected(self, ip):
     """ถูกเรียกเมื่อ detector ส่ง IP ผู้โจมตีมา → ตัดเน็ตอัตโนมัติ"""
     if not config.AUTO_CONTAIN:
        self.log_message(
            f"[{time.strftime('%H:%M:%S')}] [DETECTOR] พบผู้โจมตี {ip} "
            "แต่ AEGIS_AUTO_CONTAIN ปิดอยู่ — บันทึกเหตุการณ์โดยไม่ตัด uplink",
            db.WARN,
        )
        db.log_event("DETECTOR_ALERT", f"Attacker {ip}; auto-contain disabled", db.WARN)
        return
     if not self.armed:
        self.log_message(
            f"[{time.strftime('%H:%M:%S')}] [AUTO] พบผู้โจมตี {ip} "
            "แต่ระบบ DISARMED — ไม่ตัด",
            db.WARN,
        )
        return

     self.log_message(
        f"[{time.strftime('%H:%M:%S')}] [AUTO] 🚨 detector "
        f"พบผู้โจมตี {ip} — ตัดเน็ตอัตโนมัติ",
        db.CRITICAL,
    )

     self.mqtt.last_attacker_ip = ip

     t2_ms = time.time_ns() // 1_000_000
     self.log_message(
        f"[LATENCY] T2 CUT issued for {ip} at {t2_ms} ms",
        db.CRITICAL,
    )

     self.send_command(
        "CUT_UPLINK",
        f"ตัดอัตโนมัติจาก detector (ผู้โจมตี {ip})",
        critical=True,
    )

    def handle_telegram_command(self, text):
        """สมองของ Telegram สองทาง: รับข้อความ → แยกคำสั่ง → ทำ
        ⚠️ ถูกเรียกจาก thread ของ Telegram จึงต้องเด้งกลับ main thread ด้วย root.after"""
        self.root.after(0, self._process_tg_command, text)

    def _process_tg_command(self, text):
        parts = text.split()
        if not parts:
            return
        cmd = parts[0].lower()

        if cmd in ("/status", "/hello", "/help"):
            state = "🔴 LOCKDOWN" if getattr(self, "_last_uplink_state", None) == "LOCKDOWN" else "🟢 NORMAL"
            mode = "ARMED" if self.armed else "DISARMED"
            comms.send_telegram_reply(
                f"🛡️ AEGIS สถานะปัจจุบัน\n"
                f"Uplink: {state}\n"
                f"โหมด: {mode}\n\n"
                f"คำสั่ง:\n/status - ดูสถานะ\n/cut <PIN> - ตัดเน็ต\n/restore <PIN> - คืนค่า"
            )
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [TG] ตอบคำสั่ง {cmd}", db.INFO)

        elif cmd == "/cut":
            if not self._tg_check_pin(parts):
                return
            if not self.armed:
                comms.send_telegram_reply("⚠️ ระบบอยู่โหมด DISARMED — สลับเป็น ARMED ก่อน")
                return
            self.send_command("CUT_UPLINK", "ตัดเน็ต (สั่งผ่าน Telegram)", critical=True)
            comms.send_telegram_reply("🔴 ส่งคำสั่งตัด Uplink แล้ว — รอ ACK จากบอร์ด")
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [TG] สั่งตัดเน็ตผ่าน Telegram", db.CRITICAL)

        elif cmd == "/restore":
            if not self._tg_check_pin(parts):
                return
            self.send_command(
                "RESTORE_UPLINK",
                "คืนค่า (สั่งผ่าน Telegram)",
                authorize_restore=True,
                origin="telegram",
            )
            comms.send_telegram_reply("🟢 ส่งคำสั่งคืนค่า Uplink แล้ว — รอ ACK จากบอร์ด")
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [TG] สั่งคืนค่าผ่าน Telegram", db.INFO)

        else:
            comms.send_telegram_reply(f"❓ ไม่รู้จักคำสั่ง: {text}\nพิมพ์ /status ดูคำสั่งทั้งหมด")

    def _tg_check_pin(self, parts):
        """เช็ก PIN จาก Telegram + ล็อกถ้าเดาผิดหลายครั้ง"""
        # ด่านล็อก: ถ้ายังอยู่ในช่วงถูกล็อก ปฏิเสธทันที
        now = time.time()
        if now < self.tg_locked_until:
            wait = int(self.tg_locked_until - now)
            comms.send_telegram_reply(f"🔒 ถูกล็อกชั่วคราว รออีก {wait} วินาที")
            return False

        """เช็ก PIN ที่แนบมากับคำสั่ง Telegram เช่น /cut 1234"""
        if len(parts) < 2:
            comms.send_telegram_reply("🔒 ต้องใส่ PIN ด้วย เช่น /cut 1234")
            return False

        if not config.verify_pin(parts[1]):
            self.tg_pin_fails += 1
            remaining = config.MAX_PIN_ATTEMPTS - self.tg_pin_fails
            db.log_event("SECURITY_ALERT", f"Wrong PIN via Telegram ({self.tg_pin_fails})", db.WARN)
            if self.tg_pin_fails >= config.MAX_PIN_ATTEMPTS:
                self.tg_locked_until = now + 60          # ล็อก 60 วิ
                self.tg_pin_fails = 0
                comms.send_telegram_reply("🔒 ใส่ PIN ผิดหลายครั้ง — ล็อก 60 วินาที")
                self.log_message(f"[{time.strftime('%H:%M:%S')}] [TG] ล็อก Telegram (เดา PIN)", db.CRITICAL)
            else:
                comms.send_telegram_reply(f"❌ PIN ไม่ถูกต้อง (เหลืออีก {remaining} ครั้ง)")
            return False

        # PIN ถูก → รีเซ็ตตัวนับ
        self.tg_pin_fails = 0
        return True



    def verify_log_integrity(self):
        """ตรวจสอบความสมบูรณ์ของ audit log (hash chain)"""
        ok, msg = db.verify_chain()
        level = db.INFO if ok else db.CRITICAL
        self.log_message(f"[{time.strftime('%H:%M:%S')}] [VERIFY] {msg}", level)
        from tkinter import messagebox
        if ok:
            messagebox.showinfo(i18n.t("log.integrity_title"), msg)
        else:
            messagebox.showerror(i18n.t("log.integrity_tamper_title"), msg)

    # =========================================================
    # MISC
    # =========================================================
    def trigger_alarm(self, sound_file=None):
        path = sound_file or config.SOUND_PATH
        if not os.path.exists(path):
            return

        def _play():
            for player in ("paplay", "aplay"):
                try:
                    subprocess.run([player, path], check=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return
                except (FileNotFoundError, subprocess.CalledProcessError):
                    continue

        threading.Thread(target=_play, daemon=True).start()

    def export_audit_log(self):
        try:
            rows = db.fetch_all_logs()
            with open("aegis_security_report.csv", "w", newline="", encoding="utf-8-sig") as f:
                w = csv.writer(f)
                w.writerow(["ID", "Timestamp", "Level", "Event Type", "Details", "Incident ID"])
                w.writerows(rows)
            messagebox.showinfo(i18n.t("log.export_success_title"), i18n.t("log.export_success_message"))
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [INFO] ส่งออก Audit Log เป็น CSV แล้ว", db.INFO)
        except Exception as e:
            messagebox.showerror(
                i18n.t("log.export_error_title"),
                i18n.t("log.export_error_message", error=e),
            )

    def _start_background_heartbeat(self):
        def worker():
            while True:
                try:
                    if self.controller.send_heartbeat():
                        self.last_heartbeat_sent_ts = time.time()
                except Exception as e:
                    print(f"[heartbeat] send failed, thread alive: {e}")
                time.sleep(config.HEARTBEAT_INTERVAL_SEC)
        threading.Thread(target=worker, daemon=True).start()

    def open_recovery_wizard(self):
        IncidentRecoveryWizard(self)
        self.refresh_incident_banner()

    def _on_close(self):
        try:
            db.log_event("SYSTEM", "SOC GUI shutting down", db.INFO)
            self.mqtt.stop()
        finally:
            self.root.destroy()


def main():
    db.init_db()
    db.log_event("SYSTEM", "SOC เริ่มทำงาน", db.INFO)   # ← เพิ่ม
    root = tk.Tk()
    mqtt = MQTTManager()
    controller = AegisCommandController(mqtt, dry_run=config.DRY_RUN)
    app = AegisAdminGUI(root, mqtt, controller)
    app.refresh_incident_banner()

    mqtt.log_callback = lambda m, l="INFO": root.after(0, app.log_message, m, l)
    mqtt.status_callback = lambda s, r, h, _command_nonce: root.after(
        0, app.on_status, s, r, h
    )
    mqtt.connection_callback = lambda ok: root.after(0, app.set_broker_state, ok)
    mqtt.ack_callback = lambda a, d, n: root.after(0, app.on_ack, a, d, n)
    mqtt.attacker_callback = lambda ip: root.after(0, app.on_attacker_detected, ip)   # ← เพิ่มบรรทัดนี้
    mqtt.start()

    # เพิ่ม 3 บรรทัดนี้: เริ่มตัวฟังคำสั่ง Telegram
    from .telegram_control import TelegramListener
    tg = TelegramListener(on_command=app.handle_telegram_command)
    tg.start()

    root.mainloop()
