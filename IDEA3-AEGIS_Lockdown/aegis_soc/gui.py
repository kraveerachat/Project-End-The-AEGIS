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

from . import comms, config
from . import database as db
from . import i18n
from . import presentation as pres
from .controller import AegisCommandController
from .mqtt_client import MQTTManager
from .theme import (
    COLOR_ACCENT,
    COLOR_BG,
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
    EmptyState,
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

# Left-nav items for Slice 1. Only "Overview" is a real implemented page;
# every other entry is an explicit, reachable placeholder that shows an
# EmptyState instead of claiming functionality this slice does not build.
NAV_ITEMS = (
    ("overview", "nav.overview", True),
    ("incidents", "nav.incidents", False),
    ("devices", "nav.devices", False),
    ("lockdown", "nav.lockdown", False),
    ("recovery", "nav.recovery", False),
    ("audit", "nav.audit", False),
    ("diagnostics", "nav.diagnostics", False),
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


class AegisAdminGUI:
    def __init__(self, root, mqtt_manager, command_controller=None):
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

        self.nav_items = {}          # key -> NavigationItem widget
        self.active_page = "overview"
        self.metric_cards = {}       # key -> MetricCard widget
        self.activity_rows = []      # list of EvidenceRow widgets currently shown
        self._logo_image = None      # kept alive here; Tkinter does not retain PhotoImage refs

        self.root.geometry("1366x768")
        self.root.minsize(1024, 700)
        self.root.config(bg=COLOR_BG)
        self.root.protocol("WM_DELETE_WINDOW", self._on_close)

        self._build_ui()
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

    def _rebuild_ui(self):
        """Tear down and rebuild the entire shell in place (used after a
        language change) without restarting the clock/heartbeat/monitor
        timers, which reference self.<widget> freshly on every tick and so
        pick up the rebuilt widgets automatically. Preserves the currently
        active nav page instead of forcing Overview."""
        for child in list(self.root.winfo_children()):
            child.destroy()
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
        self._logo_image = load_logo_image()
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
        self._rebuild_ui()

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

        if key == "overview":
            self._build_overview_page(self.workspace)
        else:
            label_key = dict((k, lk) for k, lk, _enabled in NAV_ITEMS)[key]
            EmptyState(
                self.workspace,
                title=i18n.t(label_key),
                message=i18n.t("empty.message"),
            ).grid(row=0, column=0, sticky="nsew")

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

        controls = Section(page, i18n.t("controls.section_title"), accent=COLOR_DANGER)
        controls.pack(fill="x", padx=16, pady=(0, 16))
        row1 = tk.Frame(controls.body, bg=COLOR_PANEL)
        row1.pack(fill="x")
        self.btn_arm = tk.Button(row1, text=i18n.t("controls.arm_to_disarm"), font=FONT_BTN_SM,
                                 fg="white", bg=COLOR_WARN, activebackground=COLOR_WARN_HL, bd=0,
                                 height=2, cursor="hand2", command=self.toggle_arm)
        self.btn_arm.pack(side="left", fill="x", expand=True, padx=(0, 6))
        self.btn_recovery = tk.Button(row1, text=i18n.t("controls.recovery_button"), font=FONT_BTN_SM,
                                      fg="white", bg=COLOR_WARN, activebackground=COLOR_WARN_HL, bd=0,
                                      height=2, cursor="hand2", command=self.open_recovery_wizard)
        self.btn_recovery.pack(side="left", fill="x", expand=True, padx=(6, 0))
        row2 = tk.Frame(controls.body, bg=COLOR_PANEL)
        row2.pack(fill="x", pady=(8, 0))
        self.btn_cut = tk.Button(row2, text=i18n.t("controls.cut_button"), font=FONT_BTN, fg="white",
                                 bg=COLOR_DANGER, activebackground=COLOR_DANGER_HL, activeforeground="white",
                                 height=2, bd=0, cursor="hand2", command=self.on_cut_clicked)
        self.btn_cut.pack(side="left", fill="x", expand=True, padx=(0, 6))
        self.btn_restore = tk.Button(row2, text=i18n.t("controls.restore_button"), font=FONT_BTN,
                                     fg="white", bg=COLOR_SUCCESS, activebackground=COLOR_SUCCESS_HL,
                                     activeforeground="white", height=2, bd=0, cursor="hand2",
                                     command=self.on_restore_clicked)
        self.btn_restore.pack(side="left", fill="x", expand=True, padx=(6, 0))
        make_hint(controls.body, i18n.t("controls.hint")).pack(anchor="w", pady=(8, 0))

        activity = Section(page, i18n.t("activity.section_title"), accent=COLOR_ACCENT)
        activity.pack(fill="x", padx=16, pady=(0, 16))
        self.activity_body = activity.body
        header_row = EvidenceRow(self.activity_body, i18n.t("activity.col_time"), i18n.t("activity.col_severity"),
                                 i18n.t("activity.col_event"), i18n.t("activity.col_source"), header=True)
        header_row.pack(fill="x", anchor="w")
        self.activity_rows = []
        self._refresh_recent_activity()

        logsec = Section(page, i18n.t("log.section_title"), accent=COLOR_PURPLE)
        logsec.pack(fill="both", expand=True, padx=16, pady=(0, 20))
        logsec.body.grid_rowconfigure(1, weight=1)
        logsec.body.grid_columnconfigure(0, weight=1)

        filt = tk.Frame(logsec.body, bg=COLOR_PANEL)
        filt.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        tk.Label(filt, text=i18n.t("log.filter_label"), font=FONT_HINT, fg=COLOR_MUTED,
                 bg=COLOR_PANEL).pack(side="left")
        filter_all = i18n.t("log.filter_all")
        filter_options = (filter_all, i18n.t("log.filter_warn"), i18n.t("log.filter_crit"))
        self.filter_var = tk.StringVar(value=filter_all)
        om = tk.OptionMenu(filt, self.filter_var, *filter_options,
                           command=lambda _=None: self._redraw_log())
        om.config(font=FONT_HINT, bg=COLOR_PANEL_ALT, fg=COLOR_TEXT, activebackground=COLOR_BORDER,
                  highlightthickness=0, bd=0)
        om["menu"].config(bg=COLOR_PANEL_ALT, fg=COLOR_TEXT)
        om.pack(side="left", padx=(6, 0))

        self.log_box = scrolledtext.ScrolledText(logsec.body, bg=COLOR_PANEL_ALT, fg=COLOR_TEXT,
                                                 font=FONT_MONO, bd=0, insertbackground=COLOR_TEXT,
                                                 highlightthickness=1, highlightbackground=COLOR_BORDER,
                                                 height=10)
        self.log_box.grid(row=1, column=0, sticky="nsew", pady=(0, 10))
        for lvl, col in LEVEL_COLORS.items():
            self.log_box.tag_config(lvl, foreground=col)
        for message, level in self.log_buffer:
            if self._passes_filter(level):
                self.log_box.insert(tk.END, f"{message}\n", level)
        if not self.log_buffer:
            self.log_box.insert(tk.END, i18n.t("log.ready_placeholder") + "\n", "INFO")

        self.btn_verify = tk.Button(logsec.body, text=i18n.t("log.verify_button"), font=FONT_BTN_SM,
                                    fg="white", bg=COLOR_PURPLE, activebackground=COLOR_ACCENT,
                                    command=self.verify_log_integrity, bd=0, cursor="hand2", height=1)
        self.btn_verify.grid(row=2, column=0, sticky="ew", pady=(8, 0))

        self._sync_arm_controls()
        self.refresh_incident_banner()

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
        if not hasattr(self, "activity_body"):
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
        if not hasattr(self, "btn_arm"):
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
        self.lbl_clock.config(text=time.strftime("%H:%M:%S"))
        self.root.after(1000, self._tick_clock)

    def _tick_monitors(self):
        # Device liveness (ESP32 ยังส่งข้อความอยู่ไหม)
        s = self.mqtt.seconds_since_device()
        esp32 = pres.esp32_metric(s, config.DEVICE_OFFLINE_SEC,
                                  getattr(self, "_last_rssi", None), getattr(self, "_last_heap", None))
        self.badge_esp32.update_status(i18n.t("badge.esp32_prefix") + _localize_status_value(esp32.value), esp32.status)

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
        self.badge_broker.update_status(i18n.t("badge.broker_prefix") + _localize_status_value(metric.value),
                                        metric.status)
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
        if hasattr(self, "log_box") and self._passes_filter(level):
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
        self.log_box.delete("1.0", tk.END)
        for msg, lvl in self.log_buffer:
            if self._passes_filter(lvl):
                self.log_box.insert(tk.END, f"{msg}\n", lvl)
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
            messagebox.showinfo("Export Success", "สร้างไฟล์ aegis_security_report.csv สำเร็จ!")
            self.log_message(f"[{time.strftime('%H:%M:%S')}] [INFO] ส่งออก Audit Log เป็น CSV แล้ว", db.INFO)
        except Exception as e:
            messagebox.showerror("Export Error", f"เกิดข้อผิดพลาด: {e}")

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
