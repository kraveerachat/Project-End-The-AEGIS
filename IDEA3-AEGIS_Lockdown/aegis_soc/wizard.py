"""
AEGIS IDEA 3 — Incident Recovery Wizard (เอกสารข้อ 5.4, Closed-Loop Recovery)
ผูกกับโมเดล Incident: เปิด/อัปเดตสถานะ CONTAINED และปิดเหตุการณ์เมื่อจบ 5 ขั้น
"""
import time
import tkinter as tk
from tkinter import messagebox, simpledialog

from . import config, i18n
from . import database as db
from . import theme as ui_theme
from .theme import (
    COLOR_ACCENT,
    COLOR_BG,
    COLOR_BLUE,
    COLOR_BLUE_HL,
    COLOR_DANGER,
    COLOR_DANGER_HL,
    COLOR_MUTED,
    COLOR_PANEL,
    COLOR_SUCCESS,
    COLOR_SUCCESS_HL,
    COLOR_TEXT,
    COLOR_WARN,
    FONT_BTN_SM,
    Card,
)


def _sync_palette_aliases():
    palette = ui_theme.get_palette()
    globals().update(
        COLOR_ACCENT=palette.accent,
        COLOR_BG=palette.background,
        COLOR_BLUE=palette.blue,
        COLOR_BLUE_HL=palette.blue_highlight,
        COLOR_DANGER=palette.danger,
        COLOR_DANGER_HL=palette.danger_highlight,
        COLOR_MUTED=palette.muted,
        COLOR_PANEL=palette.panel,
        COLOR_SUCCESS=palette.success,
        COLOR_SUCCESS_HL=palette.success_highlight,
        COLOR_TEXT=palette.text,
        COLOR_WARN=palette.warn,
    )


class IncidentRecoveryWizard(tk.Toplevel):
    STEP_TITLE_KEYS = [
        "recovery.step1_title",
        "recovery.step2_title",
        "recovery.step3_title",
        "recovery.step4_title",
        "recovery.step5_title",
    ]
    STEP_DESC_KEYS = [
        "recovery.step1_desc",
        "recovery.step2_desc",
        "recovery.step3_desc",
        "recovery.step4_desc",
        "recovery.step5_desc",
    ]

    def __init__(self, gui):
        _sync_palette_aliases()
        super().__init__(gui.root)
        self.gui = gui
        self.status_labels = []
        # เปิด/ดึงเหตุการณ์ที่ค้างอยู่ เพื่อผูกทุกขั้นเข้ากับ incident เดียว
        self.incident_id = db.create_incident(gui.mqtt.last_attacker_ip)

        self.title(i18n.t("recovery.window_title"))
        self.configure(bg=COLOR_BG)
        self.geometry("640x620")
        self.minsize(600, 560)
        self.transient(gui.root)

        tk.Label(self, text=i18n.t("recovery.heading"), font=("Segoe UI", 13, "bold"),
                 fg=COLOR_ACCENT, bg=COLOR_BG).pack(anchor="w", padx=18, pady=(16, 2))
        tk.Label(self, text=i18n.t("recovery.subheading", incident_id=self.incident_id),
                 font=("Segoe UI", 8), fg=COLOR_MUTED, bg=COLOR_BG).pack(anchor="w", padx=18, pady=(0, 12))

        self._build_step(0, self._step1)
        self._build_step(1, self._step2, extra="ip_entry")
        self._build_step(2, self._step3)
        self._build_step(3, self._step4)
        self._build_step(4, self._step5, extra="lessons_text")

    def _step_frame(self, idx):
        card = Card(self, accent=COLOR_WARN)
        card.pack(fill="x", padx=18, pady=6)
        head = tk.Frame(card.body, bg=COLOR_PANEL)
        head.pack(fill="x", pady=(8, 2))
        tk.Label(head, text=i18n.t(self.STEP_TITLE_KEYS[idx]), font=("Segoe UI", 10, "bold"), fg=COLOR_TEXT,
                 bg=COLOR_PANEL).pack(side="left", padx=12)
        status = tk.Label(head, text=i18n.t("recovery.status_pending"), font=("Segoe UI", 8), fg=COLOR_MUTED,
                          bg=COLOR_PANEL)
        status.pack(side="right", padx=12)
        self.status_labels.append(status)
        tk.Label(card.body, text=i18n.t(self.STEP_DESC_KEYS[idx]), font=("Segoe UI", 9), fg=COLOR_TEXT, bg=COLOR_PANEL,
                 wraplength=560, justify="left").pack(anchor="w", padx=12)
        return card.body

    def _build_step(self, idx, command, extra=None):
        body = self._step_frame(idx)
        row = tk.Frame(body, bg=COLOR_PANEL)
        row.pack(fill="x", padx=12, pady=(6, 10))
        if extra == "ip_entry":
            self.ip_entry = tk.Entry(
                row,
                font=("Consolas", 10),
                width=18,
                fg=COLOR_TEXT,
                bg=ui_theme.get_palette().panel_alt,
                insertbackground=COLOR_TEXT,
                relief="flat",
            )
            self.ip_entry.pack(side="left")
            self._ip_placeholder = i18n.t("recovery.step2_placeholder")
            if self.gui.mqtt.last_attacker_ip:
                self.ip_entry.insert(0, self.gui.mqtt.last_attacker_ip)
            else:
                self.ip_entry.insert(0, self._ip_placeholder)
            tk.Button(row, text=i18n.t("recovery.step2_button"), font=FONT_BTN_SM, fg="white", bg=COLOR_DANGER,
                      activebackground=COLOR_DANGER_HL, bd=0, cursor="hand2",
                      command=command).pack(side="left", padx=(8, 0))
        elif extra == "lessons_text":
            self.lessons_text = tk.Text(
                body,
                height=3,
                width=60,
                font=("Segoe UI", 9),
                fg=COLOR_TEXT,
                bg=ui_theme.get_palette().panel_alt,
                insertbackground=COLOR_TEXT,
                relief="flat",
            )
            self.lessons_text.pack(anchor="w", padx=12, pady=(0, 6))
            tk.Button(body, text=i18n.t("recovery.step5_button"), font=FONT_BTN_SM, fg="white", bg=COLOR_SUCCESS,
                      activebackground=COLOR_SUCCESS_HL, bd=0, cursor="hand2",
                      command=command).pack(anchor="w", padx=12, pady=(0, 10))
        else:
            labels = {0: i18n.t("recovery.step1_button"), 2: i18n.t("recovery.step3_button"),
                      3: i18n.t("recovery.step4_button")}
            colors = {0: COLOR_BLUE, 2: COLOR_SUCCESS, 3: COLOR_BLUE}
            hl = {0: COLOR_BLUE_HL, 2: COLOR_SUCCESS_HL, 3: COLOR_BLUE_HL}
            tk.Button(row, text=labels[idx], font=FONT_BTN_SM, fg="white", bg=colors[idx],
                      activebackground=hl[idx], bd=0, cursor="hand2", command=command).pack(anchor="w")

    def _mark_done(self, idx):
        self.status_labels[idx].config(text=i18n.t("recovery.status_done"), fg=COLOR_SUCCESS_HL)

    def _log(self, text, level=db.INFO):
        t = time.strftime('%H:%M:%S')
        self.gui.log_message(f"[{t}] [RECOVERY] {text}", level)

    def _step1(self):
        self._mark_done(0)
        db.set_incident_state(self.incident_id, "CONTAINED")
        db.log_event("RECOVERY_STEP", "1. Out-of-band access confirmed", db.INFO, self.incident_id)
        self._log("ขั้น 1: ยืนยันเข้าถึงผ่าน Management VLAN แล้ว")

    def _step2(self):
        ip = self.ip_entry.get().strip()
        if not ip or ip == self._ip_placeholder:
            messagebox.showwarning(i18n.t("recovery.step2_missing_ip_title"),
                                   i18n.t("recovery.step2_missing_ip_message"), parent=self)
            return
        db.set_incident_ip(self.incident_id, ip)
        self._log(f"ขั้น 2: กำลังขอสิทธิ์ผู้ดูแลระบบเพื่อบล็อก {ip} ...", db.WARN)

        def on_done(ok, out):
            if ok:
                self._mark_done(1)
                db.log_event("RECOVERY_STEP", f"2. Blocked {ip} permanently", db.WARN, self.incident_id)
                self._log(f"ขั้น 2: บล็อก {ip} สำเร็จถาวร")
            else:
                self._log(f"ขั้น 2: บล็อกไม่สำเร็จ: {out}", db.WARN)

        self.gui.run_ufw_async(["deny", "from", ip], on_done)

    def _step3(self):
        pin = simpledialog.askstring(i18n.t("dialog.admin_auth_title"), i18n.t("dialog.pin_prompt_default"),
                                     show='*', parent=self)
        if not config.verify_pin(pin):
            if pin is not None:
                messagebox.showerror(i18n.t("dialog.access_denied_title"), i18n.t("dialog.wrong_pin_simple"),
                                     parent=self)
            return
        result = self.gui.controller.issue(
            "RESTORE_UPLINK",
            "Incident Recovery Wizard step 3",
            origin="recovery-wizard",
            authorize_restore=True,
        )
        if result.ok:
            self._mark_done(2)
            event = "Would send RESTORE_UPLINK" if result.dry_run else "Sent RESTORE_UPLINK"
            db.log_event("RECOVERY_STEP", f"3. {event}", db.INFO, self.incident_id)
            self._log("ขั้น 3: จำลองคำสั่ง RESTORE_UPLINK แล้ว" if result.dry_run
                      else "ขั้น 3: ส่งคำสั่งปลดล็อกกายภาพแล้ว")
        else:
            self._log(f"ขั้น 3: ส่ง RESTORE_UPLINK ไม่สำเร็จ: {result.detail}", db.WARN)

    def _step4(self):
        self._log("ขั้น 4: กำลังขอสิทธิ์เพื่อ reload UFW ...")

        def on_done(ok, out):
            if ok:
                self._mark_done(3)
                db.log_event("RECOVERY_STEP", "4. UFW reloaded", db.INFO, self.incident_id)
                self._log("ขั้น 4: เปิดบริการกลับคืนแล้ว")
            else:
                self._log(f"ขั้น 4: ล้มเหลว: {out}", db.WARN)

        self.gui.run_ufw_async(["reload"], on_done)

    def _step5(self):
        summary = self.lessons_text.get("1.0", "end").strip()
        if not summary:
            messagebox.showwarning(i18n.t("recovery.step5_missing_title"),
                                   i18n.t("recovery.step5_missing_message"), parent=self)
            return
        db.close_incident(self.incident_id, summary)
        db.log_event("INCIDENT_CLOSED", summary, db.INFO, self.incident_id)
        self._mark_done(4)
        self._log(f"ขั้น 5: ปิด Incident #{self.incident_id} แล้ว (Closed-Loop)")
        self.gui.refresh_incident_banner()
        messagebox.showinfo(i18n.t("recovery.closed_title"),
                            i18n.t("recovery.closed_message", incident_id=self.incident_id), parent=self)
