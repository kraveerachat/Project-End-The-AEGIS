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
from tools import purple_design as design

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
            "corroborated": item.get("corroborated") is True,
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


def _feed_status(gui, kind):
    """A feed row's color, from the SAME severity palette as every other page -- no new color is introduced.
    The pinned theme has one amber "warning" tone, not a separate yellow/orange, so GRADUATED_MEDIUM and
    GRADUATED_HIGH both read as warning (exactly as _status() above already does for those two levels
    elsewhere); only GRADUATED_CRITICAL is red and GRADUATED_LOW is neutral."""
    if kind.startswith("GRADUATED_"):
        return _status(gui, kind[len("GRADUATED_"):])
    if kind == "CUT_PRE_DISPATCH":
        return gui.pres.STATUS_CRITICAL
    if kind.startswith("RESTORE"):
        return gui.pres.STATUS_HEALTHY
    return gui.pres.STATUS_NEUTRAL  # COMMAND_SENT, ACK_RECEIVED, ALERT_ACCEPTED, ALERT_REFUSED


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
            self._severity_snapshot_value = None
            self._page_tick = None
            self._page_after = None
            self._page_snapshot = None
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
            elif key == "settings":
                # Built entirely inside the pinned gui.py with no override point to build its sections
                # with style_section_title() directly; restyle the already-built title Labels in place
                # instead (border/divider/body/every fact row inside them untouched). Diagnostics no
                # longer needs this: it has its own override (_build_diagnostics_page) that applies the
                # design system directly while building.
                design.ensure_fonts(self.root)
                design.restyle_section_titles(self.workspace, gui=gui)

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
                if text == gui.i18n.t("lockdown.controls.section"):
                    label.configure(text=strings.text("control.caption", language))
                elif text == gui.i18n.t("lockdown.controls.observer_note"):
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
        def _start_live_page(self, key, compute, render, *, scroll_anchor=None, snap_to_bottom=False):
            """Re-evaluated every SEVERITY_POLL_MS while the page ``key`` is shown; the timer dies with the page.
            ``compute()`` reads the Core sources and returns a plain, ``==``-comparable snapshot of everything the
            page shows (no widgets touched); ``render(snapshot)`` is the one place that destroys and rebuilds the
            page's widgets from it. Every tick re-computes the snapshot and only calls ``render`` when it actually
            differs from the last one rendered -- otherwise the page is left alone. A naive unconditional rebuild
            on every tick is what caused the periodic flicker and the Task-1 scroll jump; comparing first removes
            the flicker in steady state (nothing changed -> no rebuild) while a real change still renders promptly.
            ``scroll_anchor`` is any live widget inside the page's ScrollFrame (e.g. a Section's body): on the
            rebuild path, its scroll position is preserved across the rebuild (see _scroll_yview).
            ``snap_to_bottom`` (the Audit page's live feed only): preserving the exact old fraction is the
            wrong behaviour for a growing newest-at-the-bottom console -- a fixed fraction drifts away from the
            bottom as rows are appended. When the viewport's bottom edge was already at (or essentially at) the
            end before the rebuild, this snaps to the new bottom afterwards instead of restoring the old
            fraction, so a feed the operator is watching keeps following new events, like a terminal "tail -f";
            scrolled up to read history, the normal fraction-preserving restore still applies unchanged."""
            self._stop_live_page()
            self._page_tick = (key, compute, render, scroll_anchor, snap_to_bottom)
            self._page_snapshot = None
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
            key, compute, render, scroll_anchor, snap_to_bottom = self._page_tick
            if getattr(self, "active_page", None) != key:
                self._page_tick = None
                return
            snapshot = compute()
            if first or snapshot != self._page_snapshot:
                self._page_snapshot = snapshot
                saved = self._scroll_yview(scroll_anchor)
                at_bottom = False
                if snap_to_bottom and saved is not None:
                    frame, _position = saved
                    _top, bottom = frame.canvas.yview()
                    at_bottom = bottom >= 0.999
                try:
                    render(snapshot)
                except tk.TclError:   # the page was destroyed under us
                    self._page_tick = None
                    return
                if snap_to_bottom and at_bottom:
                    frame, _position = saved
                    frame.canvas.update_idletasks()
                    if frame.canvas.winfo_exists():
                        frame.canvas.yview_moveto(1.0)
                else:
                    self._restore_scroll_yview(saved)
            try:
                self._page_after = self.root.after(SEVERITY_POLL_MS, self._tick_live_page)
            except (tk.TclError, RuntimeError):
                self._page_after = None

        # _scroll_yview/_restore_scroll_yview now live on the shared LivePurpleObserverGUI base
        # (tools/live_purple_observer.py), so every launcher built on it can reuse them.

        def _clear(self, body):
            for child in body.winfo_children():
                child.destroy()

        def _lines(self, body, lines):
            for line in lines:
                tk.Label(body, text=line, anchor="w", justify="left", font=design.font("note"),
                         bg=body.cget("bg"), fg=gui.ui_theme.COLOR_MUTED).pack(fill="x")

        def _build_incidents_page(self, parent):
            if incident_source is not None:   # the incident Desktop's own register is wired: keep it
                return super()._build_incidents_page(parent)
            page = self._new_page(parent, "incidents.title", "incidents.subtitle")
            t = gui.i18n.t
            design.ensure_fonts(self.root)
            palette = gui.ui_theme.get_palette()

            # Static, never rebuilt: what this page is for, at the new design system's body scale (bigger
            # and clearer than the pinned theme.make_hint's caption-sized hint) -- the page used to say
            # neither this nor what each response level means, so an empty page showed only a cryptic
            # NOT_AVAILABLE row with no explanation.
            design.intro_text(page, t("incidents.intro"), palette=palette, bg=page.cget("bg")).pack(
                anchor="w", padx=16, pady=(0, 16))

            # 1. Summary cards (reuses the pinned gui.MetricCard/_reflow_cards exactly as Overview/Recovery
            # already do): current highest level, the latest event, and the TRUE data-source state. Built
            # once; only .update()'d in place on each refresh (see _render_incidents), never rebuilt, so
            # this alone can never cause flicker or disturb scroll.
            tile_grid = tk.Frame(page, bg=page.cget("bg"))
            tile_grid.pack(fill="x", padx=16, pady=(0, 16))
            self._incidents_tiles = {
                "highest": gui.MetricCard(tile_grid, t("incidents.summary.highest"), status=gui.pres.STATUS_UNKNOWN),
                "latest": gui.MetricCard(tile_grid, t("incidents.summary.latest"), status=gui.pres.STATUS_UNKNOWN),
                "source": gui.MetricCard(tile_grid, t("incidents.summary.source"), status=gui.pres.STATUS_UNKNOWN),
            }
            self._reflow_cards(tile_grid, list(self._incidents_tiles.values()), choices=(3, 2, 1))

            # 2. The "ระดับการตอบสนอง" legend, kept, restyled to the new scale: the existing gui.Section
            # chrome (border/divider/accent), its title Label's font bumped in place, 4 rows via this
            # design system's info_row (same glyph/color logic as the pinned _add_fact, bigger fonts).
            legend = gui.Section(page, t("incidents.legend.title"))
            legend.pack(fill="x", padx=16, pady=(0, 16))
            design.style_section_title(legend)
            legend_grid = tk.Frame(legend.body, bg=legend.body.cget("bg"))
            legend_grid.pack(fill="x")
            legend_cards = []
            for level, text, status_level in records.incident_legend_rows(t):
                card = tk.Frame(legend_grid, bg=legend.body.cget("bg"))
                design.info_row(card, level, text, palette=palette, status=_status(gui, status_level))
                legend_cards.append(card)
            self._reflow_columns(legend_grid, legend_cards)

            section = gui.Section(page, t("incidents.view.section"), accent=gui.COLOR_WARN_HL)
            section.pack(fill="x", padx=16, pady=(0, 20))
            design.style_section_title(section)
            self._start_live_page("incidents", self._incidents_snapshot,
                                  lambda snapshot: self._render_incidents(snapshot, section.body),
                                  scroll_anchor=section.body)

        def _incidents_snapshot(self):
            """Everything _render_incidents shows, read-only -- no widget touched. Compared on every tick so the
            page is rebuilt only when this actually changes (see _start_live_page)."""
            t = gui.i18n.t
            data = read_graduated(graduated_path)
            reason = "" if data is not None else records.file_reason(graduated_path)
            has_decisions = data is not None and len(data["decisions"]) > 0
            tiles = records.incident_summary_tiles(data, reason, t)
            # When there is no source at all, incident_facts()'s only row is the cryptic raw
            # "NOT_AVAILABLE -- {reason} (... graduated-status.json ...)" line -- replaced below by the
            # friendly empty state, not shown alongside it. Once a source exists (even with zero decisions
            # yet), its header facts (decisions recorded, CUT recommended, auto-CUT latched) are plain,
            # useful and not covered by the 3 summary cards above, so they stay.
            facts = tuple(records.incident_facts(data, reason, t)) if data is not None else ()
            if not has_decisions:
                title, empty_reason = records.incident_empty_state(data, reason, t)
                empty = (title, t("incidents.empty.reason", reason=empty_reason) if empty_reason else None)
                return tiles, facts, (), empty
            decisions = tuple(
                (records.incident_card_title(item), tuple(records.incident_decision_rows(item, t)))
                for item in reversed(data["decisions"])
            )
            return tiles, facts, decisions, None

        def _render_incidents(self, snapshot, body):
            tiles, facts, decisions, empty = snapshot
            highest, latest, source = tiles
            self._incidents_tiles["highest"].update(highest[1], _status(gui, highest[2]))
            self._incidents_tiles["latest"].update(latest[1], _status(gui, latest[2]))
            # source[2] is a plain bool (truly available or not) -- never routed through the LOW..CRITICAL
            # level palette, which has nothing to do with "can this page reach the Core's decisions".
            self._incidents_tiles["source"].update(
                source[1], gui.pres.STATUS_HEALTHY if source[2] else gui.pres.STATUS_WARNING)

            palette = gui.ui_theme.get_palette()
            self._clear(body)
            for label, value, level in facts:
                design.info_row(body, label, value, palette=palette, status=_status(gui, level))
            if empty is not None:
                title, detail = empty
                design.empty_state(body, title=title, detail=detail, palette=palette, bg=body.cget("bg"))
                return
            grid = tk.Frame(body, bg=body.cget("bg"))
            grid.pack(fill="x", pady=(design.SPACE_SM, 0))
            cards = []
            accent = {"CRITICAL": gui.COLOR_DANGER_HL, "HIGH": gui.COLOR_WARN_HL, "MEDIUM": gui.COLOR_WARN_HL}
            for title, rows in decisions:
                level = next((value for label, value, lvl in rows if lvl in LEVELS), None)
                card = gui.Section(grid, title, accent=accent.get(level))
                design.style_section_title(card, role="card_title")
                for label, value, lvl in rows:
                    design.info_row(card.body, label, value, palette=palette, status=_status(gui, lvl))
                cards.append(card)
            self._reflow_columns(grid, cards)

        def _diagnostics_audit_row(self):
            """The Diagnostics page's audit row, read the same way the Recovery/Audit pages already read it
            (the same ``AEGIS_DESKTOP_AUDIT_DB``), instead of the base observer's hardcoded placeholder."""
            rows, reason = records.read_audit(audit_path, records.AUDIT_KINDS, records.AUDIT_LIMIT)
            value, level = records.audit_facts(rows, reason, gui.i18n.t)[0][1:]
            return value, _status(gui, level)

        def _build_audit_page(self, parent):
            page = self._new_page(parent, "audit.title", "audit.subtitle")
            design.ensure_fonts(self.root)
            section = gui.Section(page, gui.i18n.t("audit.view.section"))
            section.pack(fill="x", padx=16, pady=(0, 16))
            design.style_section_title(section)
            # snap_to_bottom: a console-style live feed, newest row last -- the operator watching it scroll
            # should follow new events automatically, the same as a terminal "tail -f", but only while they
            # are already at the bottom; scrolling up to read history must not get yanked back down.
            self._start_live_page("audit", self._audit_snapshot,
                                  lambda snapshot: self._render_audit(snapshot, section.body),
                                  scroll_anchor=section.body, snap_to_bottom=True)

        def _audit_snapshot(self):
            """Everything _render_audit shows, read-only -- no widget touched. ``lines`` widens the Audit
            page's own feed (and only this page) to the security kinds too (records.FEED_KINDS = AUDIT_KINDS
            + SECURITY_KINDS); _diagnostics_audit_row above keeps reading records.AUDIT_KINDS unchanged, and
            every row is oldest-first here (read_audit itself returns newest-first) so the feed renders with
            the newest event at the bottom, like a console."""
            t = gui.i18n.t
            rows, reason = records.read_audit(audit_path, records.FEED_KINDS, records.AUDIT_LIMIT_FEED)
            facts = tuple(records.audit_facts(rows, reason, t))
            lines = (tuple((records.feed_record(row), _feed_status(gui, row["kind"])) for row in reversed(rows))
                     or ((t("audit.view.none"), gui.pres.STATUS_NEUTRAL),)) if rows is not None else None
            return facts, lines

        def _render_audit(self, snapshot, body):
            facts, lines = snapshot
            self._clear(body)
            palette = gui.ui_theme.get_palette()
            for label, value, level in facts:
                design.info_row(body, label, value, palette=palette, status=_status(gui, level))
            if lines is not None:
                # A source with zero rows keeps its localized empty state instead of pretending to be a
                # three-column record. Real records use the same oldest-first live-feed order as before.
                if lines and isinstance(lines[0][0], str):
                    design.empty_state(body, title=lines[0][0], palette=palette, bg=body.cget("bg"))
                    return
                design.data_table_row(
                    body,
                    (gui.i18n.t("audit.table.time"), gui.i18n.t("audit.table.event"),
                     gui.i18n.t("audit.table.details")),
                    palette=palette, header=True,
                ).pack(fill="x")
                for record, status in lines:
                    # Keep the machine event token byte-for-byte visible for scanning/copying; carry the
                    # semantic status glyph on the adjacent time column instead of prefixing the token.
                    design.data_table_row(
                        body, record, palette=palette, status=status, status_column=0,
                    ).pack(fill="x")

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
            design.ensure_fonts(self.root)

            # 1. A top row of quick-glance status tiles (reuses the accepted MetricCard/_reflow_cards from the
            # Overview page -- same widget, same responsive 3/2/1-column behaviour, no new styling). Built once;
            # only each tile's value/status is updated on every refresh tick (see _render_recovery), never its
            # label, so this never destroys/rebuilds and cannot disturb scroll position on its own.
            tile_grid = tk.Frame(page, bg=gui.COLOR_BG)
            tile_grid.pack(fill="x", padx=16, pady=(0, 16))
            self._recovery_tiles = [
                gui.MetricCard(tile_grid, t(key), status=gui.pres.STATUS_UNKNOWN)
                for key in records.RECOVERY_TILE_LABEL_KEYS
            ]
            self._reflow_cards(tile_grid, self._recovery_tiles, choices=(3, 2, 1))

            # 2. Two columns (reuses the accepted _reflow_columns from Diagnostics/Settings): left stacks the
            # lockdown-cause detail and the active-blocks card, right holds recent RESTORE attempts.
            columns = tk.Frame(page, bg=gui.COLOR_BG)
            columns.pack(fill="x", padx=16, pady=(0, 16))
            left = tk.Frame(columns, bg=gui.COLOR_BG)
            cause = gui.Section(left, t("recovery.cause_section"), accent=gui.COLOR_WARN_HL)
            cause.pack(fill="x", pady=(0, 16))
            design.style_section_title(cause)
            blocked = gui.Section(left, t("recovery.blocked_section"))
            blocked.pack(fill="x")
            design.style_section_title(blocked)
            attempts = gui.Section(columns, t("recovery.attempts_section"))
            design.style_section_title(attempts)
            self._reflow_columns(columns, (left, attempts))

            # 3. Full width: the 8-step runbook (step 6 / pin-2 keeps its existing red emphasis), the pin-2
            # safety hint, and the one navigation button.
            runbook = gui.Section(page, t("recovery.runbook_section"))
            runbook.pack(fill="x", padx=16, pady=(0, 16))
            design.style_section_title(runbook)
            self._build_runbook(runbook.body)
            palette = gui.ui_theme.get_palette()
            tk.Label(page, text=t("recovery.hint"), anchor="w", justify="left", wraplength=1100,
                     font=design.font("note"), bg=page.cget("bg"), fg=palette.muted,
                     ).pack(anchor="w", padx=16, pady=(0, 8))
            # Navigation only: the RESTORE control exists on the Lockdown page and nowhere else.
            self._go_button = tk.Button(page, text=t("recovery.go_lockdown"), font=gui.ui_theme.FONT_BODY)
            self._go_button.pack(anchor="w", padx=16, pady=(0, 20))
            self._start_live_page(
                "recovery", self._recovery_snapshot,
                lambda snapshot: self._render_recovery(snapshot, cause.body, blocked.body, attempts.body),
                scroll_anchor=cause.body,
            )

        def _build_runbook(self, body):
            """A static, numbered RESTORE runbook. Read-only preview text only — it starts no action and has no
            live state, so it is built once, not re-rendered on every poll tick."""
            t = gui.i18n.t
            for key in records.RUNBOOK_STEPS:
                prominent = key == "recovery.runbook.6"   # "verify pin 2 physically": the system cannot prove this itself
                tk.Label(
                    body, text=t(key), anchor="w", justify="left", wraplength=1000,
                    font=design.font("card_title") if prominent else design.font("body"),
                    bg=body.cget("bg"), fg=gui.ui_theme.COLOR_DANGER if prominent else gui.ui_theme.COLOR_MUTED,
                ).pack(fill="x", pady=(4, 4) if prominent else (0, 0))

        def _recovery_snapshot(self):
            """Everything _render_recovery shows, read-only -- no widget touched. Compared on every tick so the
            page (and the tile row) is rebuilt only when this actually changes (see _start_live_page). Note: a
            live countdown (RESTORE pending/lockout seconds, "time since lockdown") is itself part of what is
            shown, so while one of those is actively counting down this will keep changing every tick and the
            page keeps refreshing promptly -- that is the real, intended behavior, not leftover flicker."""
            view, view_reason = records.read_recovery_view(recovery_path)
            rows, rows_reason = records.read_audit(audit_path, records.ATTEMPT_KINDS, 5)
            graduated = read_graduated(graduated_path)
            evidence = live.evidence_values(self.latest)
            t = gui.i18n.t
            freshness = self._evidence_freshness()

            tiles = tuple(records.recovery_tile_facts(evidence, view, graduated, freshness, t))
            cause_rows = tuple(records.lockdown_cause_facts(evidence, graduated, t))
            # The detail list repeats recovery_facts() exactly, minus the rows shown elsewhere already: the
            # tiles above (records.RECOVERY_TILE_ONLY_LABEL_KEYS) and the "Last RESTORE attempts" summary row,
            # which the attempts card's own line list below covers (same rows/rows_reason). Nothing here is
            # dropped -- only shown once, in the one place it now belongs.
            skip_labels = {t(key) for key in records.RECOVERY_TILE_ONLY_LABEL_KEYS} | {t("recovery.attempts")}
            facts = records.recovery_facts(evidence, view, view_reason, graduated, rows, rows_reason, freshness, t)
            detail_rows = tuple((label, value, level) for label, value, level in facts if label not in skip_labels)

            status_text, blocked_ips = live.containment_status()
            blocked_rows = tuple(records.blocked_ip_facts(blocked_ips, t, known=status_text == live.CONTAINMENT_HEALTHY))
            blocked_extra = (t("diagnostics.containment"), status_text) if status_text != live.CONTAINMENT_HEALTHY else None
            blocked_lines = tuple(blocked_ips) if status_text == live.CONTAINMENT_HEALTHY and blocked_ips else ()

            if rows:
                attempts_lines = tuple(records.audit_line(row) for row in rows)
            else:
                attempts_lines = (t("audit.view.none") if rows is not None else t("recovery.unavailable", reason=rows_reason),)

            return tiles, cause_rows, detail_rows, blocked_rows, blocked_extra, blocked_lines, attempts_lines

        def _render_recovery(self, snapshot, cause_body, blocked_body, attempts_body):
            tiles, cause_rows, detail_rows, blocked_rows, blocked_extra, blocked_lines, attempts_lines = snapshot
            palette = gui.ui_theme.get_palette()

            for tile, (_label, value, level) in zip(self._recovery_tiles, tiles):
                if tile.winfo_exists():
                    tile.update(value, _status(gui, level))

            self._clear(cause_body)
            for label, value, level in cause_rows:
                design.info_row(cause_body, label, value, palette=palette, status=_status(gui, level))
            for label, value, level in detail_rows:
                design.info_row(cause_body, label, value, palette=palette, status=_status(gui, level))

            self._clear(blocked_body)
            for label, value, level in blocked_rows:
                design.info_row(blocked_body, label, value, palette=palette, status=_status(gui, level))
            if blocked_extra is not None:
                design.info_row(blocked_body, blocked_extra[0], blocked_extra[1], palette=palette, status=gui.pres.STATUS_WARNING)
            elif blocked_lines:
                self._lines(blocked_body, list(blocked_lines))

            self._clear(attempts_body)
            self._lines(attempts_body, list(attempts_lines))

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
            design.ensure_fonts(self.root)
            section = gui.Section(page, gui.i18n.t("severity.title"), accent=gui.COLOR_WARN_HL)
            section.pack(fill="x", padx=16, pady=(0, 20))
            design.style_section_title(section)
            self._severity_body = section.body
            self._severity_snapshot_value = self._severity_snapshot()
            self._render_severity(self._severity_snapshot_value)
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
            snapshot = self._severity_snapshot()
            if snapshot != self._severity_snapshot_value:
                self._severity_snapshot_value = snapshot
                saved = self._scroll_yview(self._severity_body)
                self._render_severity(snapshot)
                self._restore_scroll_yview(saved)
            self._schedule_severity()

        def _severity_snapshot(self):
            """Everything _render_severity shows, read-only -- no widget touched. Compared on every tick so the
            panel is rebuilt only when this actually changes (see _tick_severity), the same no-flicker pattern
            _start_live_page uses for Recovery/Incidents/Audit."""
            data = read_graduated(graduated_path)
            latest = getattr(self, "latest", None)
            freshness = None if latest is None else ("FRESH" if latest.valid else latest.freshness)
            facts = tuple(severity_facts(data, gui.i18n.t, freshness))
            lines = tuple(describe_decision(item) for item in reversed(data["decisions"][-6:])) if data is not None else ()
            return facts, lines

        def _render_severity(self, snapshot):
            facts, lines = snapshot
            body = self._severity_body
            palette = gui.ui_theme.get_palette()
            for child in body.winfo_children():
                child.destroy()
            for label, value, level in facts:
                design.info_row(body, label, value, palette=palette, status=_status(gui, level))
            for line in lines:
                tk.Label(body, text=line, anchor="w", justify="left", font=design.font("note"),
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
    live.register_observer_strings(gui.i18n)
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
