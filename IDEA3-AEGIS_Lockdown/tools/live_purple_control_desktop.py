"""Purple Python Desktop with Core-authenticated CUT **and** RESTORE, plus the IDEA3 graduated-response severity panel.

A separate entry point built on ``live_purple_cut_desktop`` (which stays unchanged). It adds three things:

  * RESTORE: the accepted page's disabled RESTORE button is wired to the Core-local D4 RESTORE channel through
    ``aegis_soc.restore_client`` (the same request, gate and evidence ladder as ``aegisctl restore``). Every RESTORE asks for a
    reason, the typed confirmation ``RESTORE UPLINK`` and the RESTORE secret, which the CORE verifies and this process never
    stores. The CUT secret and the RESTORE secret are separate credentials.
  * Severity: a read-only panel on the Lockdown page shows the Core's latest graduated-response decisions (level, attacker,
    evidence, what the Core did) from the bounded projection the Core writes (``graduated-status.json``). A HIGH decision is
    shown as "CUT recommended"; the operator still decides with the CUT button.
  * Status path: ``AEGIS_DESKTOP_STATUS_PATH`` points the read-only evidence reader at the running Core's ``status.json``
    (the base launcher always reads the production path).

The Desktop still holds no broker credential, protocol key, database or controller and publishes nothing itself.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, simpledialog

from tools import graceful_exit
from tools import live_purple_control_strings as strings
from tools import live_purple_core_records as records
from tools import live_purple_cut_desktop as cut_desktop
from tools import live_purple_observer as live

RESTORE_ENABLE_ENV = "AEGIS_DESKTOP_RESTORE_ENABLED"
RESTORE_SOCKET_ENV = "AEGIS_LOCAL_RESTORE_SOCKET"
STATUS_PATH_ENV = "AEGIS_DESKTOP_STATUS_PATH"
GRADUATED_PATH_ENV = "AEGIS_GRADUATED_STATUS_PATH"
RECOVERY_PATH_ENV = "AEGIS_DESKTOP_RECOVERY_PATH"
AUDIT_DB_ENV = "AEGIS_DESKTOP_AUDIT_DB"
CONTROL_TITLE = "AEGIS IDEA3 — PURPLE DESKTOP — CUT / RESTORE (CORE-AUTHENTICATED)"
RESTORE_BUTTON_TEXT = "RESTORE NETWORK (Core-authenticated)"
RESTORE_DISABLED_TEXT = "RESTORE NETWORK — DISABLED"
SEVERITY_TITLE = "THREAT SEVERITY — GRADUATED RESPONSE (READ ONLY)"
GRADUATED_MAX_BYTES = 64 * 1024
SEVERITY_POLL_MS = 2000
LEVELS = ("LOW", "MEDIUM", "HIGH", "CRITICAL")

# Severity panel strings (th/en/zh), added to the purple Desktop's own i18n table when the app is created, so the panel follows
# the language selector like the rest of the window. Codes are never translated: the level, action, outcome and kind codes, MITRE IDs
# and addresses (they are data, and are not in this table at all) and the command words CUT, RESTORE, EXECUTED and NOT_AVAILABLE
# (compared or printed verbatim elsewhere, like the CONFIRM word).
SEVERITY_STRINGS = {
    "severity.title": {
        "en": SEVERITY_TITLE,
        "th": "ระดับความรุนแรงของภัยคุกคาม — การตอบสนองแบบไล่ระดับ (อ่านอย่างเดียว)",
        "zh": "威胁严重程度 — 分级响应（只读）",
    },
    "severity.graduated": {"en": "Graduated response", "th": "การตอบสนองแบบไล่ระดับ", "zh": "分级响应"},
    "severity.evidence": {"en": "Core evidence", "th": "หลักฐานจาก Core", "zh": "Core 证据"},
    "severity.evidence_stale": {
        "en": "the Core is not updating: the data below is the last known state and may be out of date",
        "th": "Core ไม่ได้อัปเดต: ข้อมูลด้านล่างเป็นสถานะล่าสุดที่ทราบและอาจล้าสมัย",
        "zh": "Core 未更新：以下数据为最后已知状态，可能已过时",
    },
    "severity.unavailable": {
        "en": "NOT_AVAILABLE — no Core projection",
        "th": "NOT_AVAILABLE — ไม่มีข้อมูลสรุปจาก Core",
        "zh": "NOT_AVAILABLE — Core 未提供数据",
    },
    "severity.highest": {"en": "Highest level", "th": "ระดับสูงสุด", "zh": "最高级别"},
    "severity.cut_recommended": {"en": "CUT recommended", "th": "แนะนำให้ CUT", "zh": "建议执行 CUT"},
    "severity.cut_recommended_value": {
        "en": "{target} — decide with the CUT button",
        "th": "{target} — ตัดสินใจด้วยปุ่ม CUT",
        "zh": "{target} — 请使用 CUT 按钮决定",
    },
    "severity.auto_cut": {"en": "Automatic CUT", "th": "CUT อัตโนมัติ", "zh": "自动 CUT"},
    "severity.auto_cut_value": {
        "en": "EXECUTED this episode — RESTORE needs the RESTORE secret",
        "th": "EXECUTED ในเหตุการณ์นี้ — RESTORE ต้องใช้รหัสลับ RESTORE",
        "zh": "EXECUTED（本次事件）— RESTORE 需要 RESTORE 密钥",
    },
}


def register_severity_strings(i18n_module) -> None:
    """Add the panel strings to the purple i18n table; a key that already exists is never replaced."""
    for key, entry in SEVERITY_STRINGS.items():
        i18n_module.STRINGS.setdefault(key, dict(entry))


def severity_facts(data, translate, evidence_freshness=None):
    """The panel's rows as ``(label, value, level_for_colour)``. Labels and prose go through ``translate``; codes are copied as they are.

    ``graduated-status.json`` is written only when a decision is made, so its own age says nothing about whether the Core is alive. The
    freshness of the Core's ``status.json`` does: when that is anything but FRESH the panel says so first, with the freshness code."""
    rows = []
    if evidence_freshness not in (None, "FRESH"):
        rows.append((translate("severity.evidence"), f"{evidence_freshness} — {translate('severity.evidence_stale')}", "HIGH"))
    if data is None:
        return rows + [(translate("severity.graduated"), translate("severity.unavailable"), None)]
    rows += [(translate("severity.highest"), data["highest_level"], data["highest_level"])]
    if data["cut_recommended_for"]:
        rows.append((translate("severity.cut_recommended"),
                     translate("severity.cut_recommended_value", target=data["cut_recommended_for"]), "HIGH"))
    if data["auto_cut_latched"]:
        rows.append((translate("severity.auto_cut"), translate("severity.auto_cut_value"), "CRITICAL"))
    return rows


def _load_restore_client():
    path = Path(__file__).resolve().parents[1] / "aegis_soc" / "restore_client.py"
    spec = importlib.util.spec_from_file_location("aegis_restore_client", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load the Core RESTORE client: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["aegis_restore_client"] = module
    spec.loader.exec_module(module)
    return module


restore_client = _load_restore_client()


def restore_configuration(environ=None) -> str | None:
    """The Core RESTORE socket path, or None (RESTORE stays disabled) unless explicitly enabled and configured."""
    env = os.environ if environ is None else environ
    path = env.get(RESTORE_SOCKET_ENV, "").strip()
    if env.get(RESTORE_ENABLE_ENV) != "YES" or not os.path.isabs(path):
        return None
    return path


def absolute_env_path(name, environ=None) -> Path | None:
    value = (os.environ if environ is None else environ).get(name, "").strip()
    return Path(value) if value and os.path.isabs(value) else None


def read_graduated(path) -> dict | None:
    """The Core's graduated projection, or None. Regular file only, bounded, schema-checked; never raises."""
    if path is None:
        return None
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_size > GRADUATED_MAX_BYTES:
            return None
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, flags)
        with os.fdopen(fd, "rb") as handle:
            raw = handle.read(GRADUATED_MAX_BYTES + 1)
        if len(raw) > GRADUATED_MAX_BYTES:
            return None
        data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("decisions"), list):
        return None
    decisions = []
    for item in data["decisions"][-10:]:
        if not isinstance(item, dict) or item.get("level") not in LEVELS:
            continue
        decisions.append({
            "at": item.get("at") if isinstance(item.get("at"), (int, float)) else None,
            "attacker_ip": str(item.get("attacker_ip", ""))[:45],
            "kind": str(item.get("kind", ""))[:40],
            "level": item["level"],
            "action": str(item.get("action", ""))[:24],
            "outcome": str(item.get("outcome", ""))[:24],
            "score": item.get("score") if isinstance(item.get("score"), int) else 0,
            "reasons": [str(r)[:48] for r in item.get("reasons", [])][:8] if isinstance(item.get("reasons"), list) else [],
            "mitre": [str(m)[:12] for m in item.get("mitre", [])][:6] if isinstance(item.get("mitre"), list) else [],
        })
    highest = data.get("highest_level") if data.get("highest_level") in LEVELS else "LOW"
    recommended = data.get("cut_recommended_for")
    return {
        "highest_level": highest,
        "cut_recommended_for": str(recommended)[:45] if recommended else None,
        "auto_cut_latched": data.get("auto_cut_latched") is True,
        "decisions": decisions,
    }


def describe_decision(item) -> str:
    when = ""
    if item.get("at"):
        import time

        when = time.strftime("%H:%M:%S", time.localtime(item["at"])) + "  "
    mitre = f"  [{', '.join(item['mitre'])}]" if item["mitre"] else ""
    outcome = f" → {item['outcome']}" if item["outcome"] else ""
    return f"{when}{item['level']:<8} {item['attacker_ip']:<15} {item['kind']} score={item['score']}{mitre}  {item['action']}{outcome}"


class ControlPrompts(cut_desktop.Prompts):
    """The CUT and RESTORE inputs and notices, worded in the Desktop's language (th/en/zh). Replaceable in tests.

    Only the wording is translated, at display time: the confirmation words the Core expects, the state codes and the commands stay
    as they are. ``language`` is replaced by the Desktop's language selector when the app is created."""

    language = staticmethod(lambda: "en")

    def _t(self, key, **kwargs):
        return strings.text(key, self.language(), **kwargs)

    def ask_reason(self):
        return simpledialog.askstring(self._t("dialog.cut_title"), self._t("dialog.cut_reason"))

    def ask_confirmation(self):
        return simpledialog.askstring(self._t("dialog.cut_title"), self._t("dialog.confirm", word=cut_desktop.client.CONFIRMATION))

    def ask_secret(self):
        return simpledialog.askstring(self._t("dialog.cut_title"), self._t("dialog.cut_secret"), show="*")

    def notify(self, title, text):
        shown_title, shown_text = strings.notice(title, text, self.language())
        messagebox.showwarning(shown_title, shown_text)

    def ask_restore_reason(self):
        return simpledialog.askstring(self._t("dialog.restore_title"), self._t("dialog.restore_reason"))

    def ask_restore_confirmation(self):
        return simpledialog.askstring(self._t("dialog.restore_title"), self._t("dialog.confirm", word=restore_client.CONFIRMATION))

    def ask_restore_secret(self):
        return simpledialog.askstring(self._t("dialog.restore_title"), self._t("dialog.restore_secret"), show="*")


def _status(gui, level):
    return {
        "LOW": gui.pres.STATUS_NEUTRAL,
        "MEDIUM": gui.pres.STATUS_WARNING,
        "HIGH": gui.pres.STATUS_WARNING,
        "CRITICAL": gui.pres.STATUS_CRITICAL,
    }.get(level, gui.pres.STATUS_UNKNOWN)


def _control_gui_class(gui, cut_flow, restore_flow, prompts, run_async, graduated_path, *, incident_source=None,
                       recovery_path=None, audit_path=None):
    Base = cut_desktop._cut_gui_class(gui, cut_flow, prompts, run_async, incident_source=incident_source)

    class LivePurpleControlDesktopGUI(Base):
        manual_restore_enabled = restore_flow is not None

        def __init__(self, *args, **kwargs):
            self._restore_button = None
            self._restore_status = None
            self._severity_body = None
            self._severity_after = None
            self._page_tick = None
            self._page_after = None
            super().__init__(*args, **kwargs)
            self.root.title(CONTROL_TITLE)

        def _on_authenticated(self):
            super()._on_authenticated()
            self.root.title(CONTROL_TITLE)

        def _show_page(self, key):
            self._stop_live_page()
            super()._show_page(key)  # the CUT base installs its CUT control on the lockdown page
            if key == "lockdown":
                self._install_restore_control()
                self._install_severity_panel()
                self._translate_controls()
            elif key == "recovery":
                self._enable_navigation_button()   # the preview base disables every Button after a page is built

        # -- RESTORE ----------------------------------------------------------------------------------------------------
        def _install_restore_control(self):
            button = next((w for w in self._walk(self.workspace) if isinstance(w, tk.Button)
                           and w.cget("text") == RESTORE_DISABLED_TEXT), None)
            if button is None or restore_flow is None:
                return
            for label in [w for w in self._walk(self.workspace) if isinstance(w, tk.Label)]:
                if "owner-only D4 terminal Recovery" in str(label.cget("text")):
                    label.master.destroy()
                    break
            for label in [w for w in self._walk(self.workspace) if isinstance(w, tk.Label)]:
                text = str(label.cget("text"))
                language = gui.i18n.get_language()
                if text == "READ-ONLY CONTROL AVAILABILITY":
                    label.configure(text=strings.text("control.caption", language))
                elif text == "NOT_AVAILABLE — observer mode":
                    label.configure(text=strings.text("control.caption_note", language))
            button.configure(text=RESTORE_BUTTON_TEXT, state=tk.NORMAL, command=self._on_restore_pressed)
            self._restore_button = button
            self._restore_status = tk.Label(
                button.master, text=self._restore_text(), anchor="w", justify="left", wraplength=640,
                font=gui.ui_theme.FONT_BODY, bg=button.master.cget("bg"), fg=gui.ui_theme.COLOR_MUTED,
            )
            self._restore_status.pack(fill="x", pady=(0, 6), after=button)
            self._refresh_restore_button()

        def _restore_text(self):
            view = restore_flow.view
            return f"{view.state}: {strings.flow_text(view.text, gui.i18n.get_language())}"

        def _status_text(self):   # the CUT status line of the base class, worded in the Desktop's language
            view = cut_flow.view
            return f"{view.state}: {strings.flow_text(view.text, gui.i18n.get_language())}"

        def _translate_controls(self):
            """Button texts in the Desktop's language. The base classes find their buttons by the English texts while they build the
            page; this runs after that, so only what is displayed changes."""
            language = gui.i18n.get_language()
            if language == "en":
                return
            shown = {
                cut_desktop.CUT_BUTTON_TEXT: strings.text("control.cut_button", language),
                RESTORE_BUTTON_TEXT: strings.text("control.restore_button", language),
                RESTORE_DISABLED_TEXT: strings.text("control.restore_disabled", language),
            }
            for widget in self._walk(self.workspace):
                if isinstance(widget, tk.Button) and widget.cget("text") in shown:
                    widget.configure(text=shown[widget.cget("text")])

        def _refresh_restore_button(self):
            if self._restore_button is not None and self._restore_button.winfo_exists():
                self._restore_button.configure(state=tk.DISABLED if restore_flow.busy else tk.NORMAL)
            if self._restore_status is not None and self._restore_status.winfo_exists():
                self._restore_status.configure(text=self._restore_text())

        def on_restore_clicked(self):  # the preview base callback stays neutral; only the flow below may RESTORE
            self._preview_control_attempt = True

        def _on_restore_pressed(self):
            if restore_flow.busy:
                return
            reason = prompts.ask_restore_reason()
            if reason is None:
                return
            confirmation = prompts.ask_restore_confirmation()
            if confirmation != restore_client.CONFIRMATION:
                prompts.notify("RESTORE", "Confirmation did not match. Nothing was sent.")
                return
            secret = prompts.ask_restore_secret()  # a fresh secret for every RESTORE; nothing is remembered
            if not secret:
                prompts.notify("RESTORE", "The RESTORE secret is required. Nothing was sent.")
                return
            if self._restore_button is not None:
                self._restore_button.configure(state=tk.DISABLED)
            run_async(self._restore_worker, reason, confirmation, secret)

        def _restore_worker(self, reason, confirmation, secret):
            try:
                view = restore_flow.submit(reason, secret, confirmation)
            finally:
                secret = None
            self._call_later(0, self._after_restore_submit, view)

        def _after_restore_submit(self, view):
            self._refresh_restore_button()
            if restore_flow.busy:
                self._call_later(cut_desktop.POLL_MS, self._schedule_restore_poll)
            elif view.state != "IDLE":
                prompts.notify("RESTORE", f"{view.state}\n\n{view.text}")

        def _schedule_restore_poll(self):
            run_async(self._restore_poll_worker)

        def _restore_poll_worker(self):
            view = restore_flow.poll()
            self._call_later(0, self._after_restore_poll, view)

        def _after_restore_poll(self, view):
            self._refresh_restore_button()
            if restore_flow.busy:
                self._call_later(cut_desktop.POLL_MS, self._schedule_restore_poll)
            elif view.terminal:
                prompts.notify("RESTORE", f"{view.state}\n\n{view.text}")


        # -- read-only Core pages (Recovery; Incidents and Audit follow) ------------------------------------------------
        def _start_live_page(self, key, render):
            """Render now and again every SEVERITY_POLL_MS while the page ``key`` is shown; the timer dies with the page."""
            self._stop_live_page()
            self._page_tick = (key, render)
            self._tick_live_page(first=True)

        def _stop_live_page(self):
            if self._page_after is not None:
                try:
                    self.root.after_cancel(self._page_after)
                except (tk.TclError, ValueError):
                    pass
            self._page_after = None
            self._page_tick = None

        def _tick_live_page(self, first=False):
            self._page_after = None
            if self._page_tick is None:
                return
            key, render = self._page_tick
            if getattr(self, "active_page", None) != key:
                self._page_tick = None
                return
            try:
                render()
            except tk.TclError:   # the page was destroyed under us
                self._page_tick = None
                return
            try:
                self._page_after = self.root.after(SEVERITY_POLL_MS, self._tick_live_page)
            except (tk.TclError, RuntimeError):
                self._page_after = None

        def _clear(self, body):
            for child in body.winfo_children():
                child.destroy()

        def _lines(self, body, lines):
            for line in lines:
                tk.Label(body, text=line, anchor="w", justify="left", font=gui.ui_theme.FONT_BODY,
                         bg=body.cget("bg"), fg=gui.ui_theme.COLOR_MUTED).pack(fill="x")

        def _build_incidents_page(self, parent):
            if incident_source is not None:   # the incident Desktop's own register is wired: keep it
                return super()._build_incidents_page(parent)
            page = self._new_page(parent, "incidents.title", "incidents.subtitle")
            section = gui.Section(page, gui.i18n.t("incidents.view.section"), accent=gui.COLOR_WARN_HL)
            section.pack(fill="x", padx=16, pady=(0, 16))
            self._start_live_page("incidents", lambda: self._render_incidents(section.body))

        def _render_incidents(self, body):
            t = gui.i18n.t
            self._clear(body)
            data = read_graduated(graduated_path)
            reason = "" if data is not None else records.file_reason(graduated_path)
            for label, value, level in records.incident_facts(data, reason, t):
                self._add_fact(body, label, value, status=_status(gui, level))
            if data is not None:
                self._lines(body, [describe_decision(item) for item in reversed(data["decisions"])] or [t("incidents.view.none")])

        def _build_audit_page(self, parent):
            page = self._new_page(parent, "audit.title", "audit.subtitle")
            section = gui.Section(page, gui.i18n.t("audit.view.section"))
            section.pack(fill="x", padx=16, pady=(0, 16))
            self._start_live_page("audit", lambda: self._render_audit(section.body))

        def _render_audit(self, body):
            t = gui.i18n.t
            self._clear(body)
            rows, reason = records.read_audit(audit_path, records.AUDIT_KINDS, records.AUDIT_LIMIT)
            for label, value, level in records.audit_facts(rows, reason, t):
                self._add_fact(body, label, value, status=_status(gui, level))
            if rows is not None:
                self._lines(body, [records.audit_line(row) for row in rows] or [t("audit.view.none")])

        def _enable_navigation_button(self):
            button = getattr(self, "_go_button", None)
            if button is not None and button.winfo_exists():
                button.configure(state=tk.NORMAL, command=lambda: self._show_page("lockdown"))

        def _evidence_freshness(self):
            latest = getattr(self, "latest", None)
            return None if latest is None else ("FRESH" if latest.valid else latest.freshness)

        def _build_recovery_page(self, parent):
            t = gui.i18n.t
            page = self._new_page(parent, "recovery.page_title", "recovery.page_subtitle")
            checklist = gui.Section(page, t("recovery.section"), accent=gui.COLOR_WARN_HL)
            checklist.pack(fill="x", padx=16, pady=(0, 16))
            attempts = gui.Section(page, t("recovery.attempts_section"))
            attempts.pack(fill="x", padx=16, pady=(0, 16))
            gui.make_hint(page, t("recovery.hint")).pack(anchor="w", padx=16, pady=(0, 8))
            # Navigation only: the RESTORE control exists on the Lockdown page and nowhere else.
            self._go_button = tk.Button(page, text=t("recovery.go_lockdown"), font=gui.ui_theme.FONT_BODY)
            self._go_button.pack(anchor="w", padx=16, pady=(0, 20))
            self._start_live_page("recovery", lambda: self._render_recovery(checklist.body, attempts.body))

        def _render_recovery(self, body, attempts_body):
            self._clear(body)
            self._clear(attempts_body)
            view, view_reason = records.read_recovery_view(recovery_path)
            rows, rows_reason = records.read_audit(audit_path, records.ATTEMPT_KINDS, 5)
            graduated = read_graduated(graduated_path)
            evidence = live.evidence_values(self.latest)
            facts = records.recovery_facts(evidence, view, view_reason, graduated, rows, rows_reason,
                                           self._evidence_freshness(), gui.i18n.t)
            for label, value, level in facts:
                self._add_fact(body, label, value, status=_status(gui, level))
            if rows:
                self._lines(attempts_body, [records.audit_line(row) for row in rows])
            else:
                self._lines(attempts_body, [gui.i18n.t("audit.view.none") if rows is not None else
                                            gui.i18n.t("recovery.unavailable", reason=rows_reason)])

        # -- severity panel ---------------------------------------------------------------------------------------------
        def _new_page(self, parent, title_key, subtitle_key, **kwargs):
            page = super()._new_page(parent, title_key, subtitle_key, **kwargs)
            if title_key == "lockdown.title":
                self._lockdown_page = page
            return page

        def _install_severity_panel(self):
            page = getattr(self, "_lockdown_page", None)
            if page is None or not page.winfo_exists():
                return
            section = gui.Section(page, gui.i18n.t("severity.title"), accent=gui.COLOR_WARN_HL)
            section.pack(fill="x", padx=16, pady=(0, 20))
            self._severity_body = section.body
            self._render_severity()
            self._schedule_severity()

        def _schedule_severity(self):
            if self._severity_after is not None:
                try:
                    self.root.after_cancel(self._severity_after)
                except (tk.TclError, ValueError):
                    pass
            try:
                self._severity_after = self.root.after(SEVERITY_POLL_MS, self._tick_severity)
            except (tk.TclError, RuntimeError):
                self._severity_after = None

        def _tick_severity(self):
            self._severity_after = None
            if self._severity_body is None or not self._severity_body.winfo_exists():
                return
            self._render_severity()
            self._schedule_severity()

        def _render_severity(self):
            body = self._severity_body
            for child in body.winfo_children():
                child.destroy()
            data = read_graduated(graduated_path)
            latest = getattr(self, "latest", None)
            freshness = None if latest is None else ("FRESH" if latest.valid else latest.freshness)
            for label, value, level in severity_facts(data, gui.i18n.t, freshness):
                self._add_fact(body, label, value, status=_status(gui, level))
            if data is None:
                return
            for item in reversed(data["decisions"][-6:]):
                tk.Label(body, text=describe_decision(item), anchor="w", justify="left", font=gui.ui_theme.FONT_BODY,
                         bg=body.cget("bg"), fg=gui.ui_theme.COLOR_MUTED).pack(fill="x")

    return LivePurpleControlDesktopGUI


def create_control_app(root, *, cut_flow, restore_flow, prompts=None, run_async=cut_desktop._thread_runner,
                       incident_source=None, status_path=live.reader.STATUS_PATH, graduated_path=None,
                       max_age_seconds=live.DESKTOP_MAX_AGE_SECONDS, recovery_path=None, audit_path=None):
    if any(name == "aegis_soc" or name.startswith("aegis_soc.") for name in sys.modules):
        raise RuntimeError("the control Desktop must start without an imported aegis_soc package")
    sys.path.insert(0, str(live.PYTHONUI_ROOT))
    live._install_import_isolation()
    live._install_database_isolation()
    from aegis_soc import gui

    if not str(Path(gui.__file__).resolve()).startswith(str(live.PYTHONUI_ROOT)):
        raise RuntimeError(f"wrong purple GUI source loaded: {gui.__file__}")
    register_severity_strings(gui.i18n)
    records.register_record_strings(gui.i18n)
    mqtt = live.LiveMQTT()
    controller = live.LiveController()
    prompts = prompts or ControlPrompts()
    if isinstance(prompts, ControlPrompts):
        prompts.language = gui.i18n.get_language   # the dialogs follow the language selector
    app_class = _control_gui_class(gui, cut_flow, restore_flow, prompts, run_async, graduated_path,
                                   incident_source=incident_source, recovery_path=recovery_path, audit_path=audit_path)
    app = app_class(root, mqtt, controller, status_path=Path(status_path), max_age_seconds=max_age_seconds)
    return app, (mqtt, controller)


def main():
    cut_path = cut_desktop.configuration()
    if cut_path is None:
        print(f"Manual CUT is disabled: set {cut_desktop.ENABLE_ENV}=YES and an absolute {cut_desktop.SOCKET_ENV}.",
              file=sys.stderr)
        return 2
    restore_path = restore_configuration()
    if restore_path is None:
        print(f"RESTORE stays disabled: set {RESTORE_ENABLE_ENV}=YES and an absolute {RESTORE_SOCKET_ENV} to enable it.",
              file=sys.stderr)
    status_path = absolute_env_path(STATUS_PATH_ENV) or live.reader.STATUS_PATH
    graduated_path = absolute_env_path(GRADUATED_PATH_ENV) or Path(status_path).with_name("graduated-status.json")
    recovery_path = absolute_env_path(RECOVERY_PATH_ENV) or Path(status_path).with_name("recovery-status.json")
    audit_path = absolute_env_path(AUDIT_DB_ENV)   # None -> the Audit and attempts rows say NOT_AVAILABLE: NOT_CONFIGURED
    root = tk.Tk()
    app, _isolation = create_control_app(
        root, cut_flow=cut_desktop.client.ManualCutFlow(cut_path),
        restore_flow=restore_client.ManualRestoreFlow(restore_path) if restore_path else None,
        status_path=status_path, graduated_path=graduated_path, recovery_path=recovery_path, audit_path=audit_path,
    )
    graceful_exit.install(root, app)
    root.mainloop()
    return 0 if app else 1


if __name__ == "__main__":
    sys.exit(main())
