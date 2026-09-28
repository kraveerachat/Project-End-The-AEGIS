"""
AEGIS IDEA 3 — Evidence-Driven Incident Recovery UI (R1-R8)

Renders aegis_soc.recovery.RecoveryCoordinator. All security/evidence logic
lives there; this module only displays gate evidence and forwards operator
actions to the coordinator, which independently refuses to advance an
unverified gate no matter what this UI does.
"""
import time
import tkinter as tk
from tkinter import messagebox, simpledialog

from . import config, i18n
from . import database as db
from . import theme as ui_theme
from .recovery import Gate, GateStatus, RecoveryCoordinator
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
    COLOR_WARN_HL,
    FONT_BTN_SM,
    Card,
    ScrollFrame,
)

GATE_ORDER = (
    Gate.R1_INCIDENT_CONTEXT,
    Gate.R2_SAFE_ACCESS,
    Gate.R3_ATTACKER_ISOLATION,
    Gate.R4_RESTORE_AUTHORIZATION,
    Gate.R5_PHYSICAL_RESTORE,
    Gate.R6_NETWORK_RECOVERY,
    Gate.R7_SERVICE_RECOVERY,
    Gate.R8_INCIDENT_CLOSURE,
)

GATE_TITLE_KEYS = {
    Gate.R1_INCIDENT_CONTEXT: "recovery.gate_r1_title",
    Gate.R2_SAFE_ACCESS: "recovery.gate_r2_title",
    Gate.R3_ATTACKER_ISOLATION: "recovery.gate_r3_title",
    Gate.R4_RESTORE_AUTHORIZATION: "recovery.gate_r4_title",
    Gate.R5_PHYSICAL_RESTORE: "recovery.gate_r5_title",
    Gate.R6_NETWORK_RECOVERY: "recovery.gate_r6_title",
    Gate.R7_SERVICE_RECOVERY: "recovery.gate_r7_title",
    Gate.R8_INCIDENT_CLOSURE: "recovery.gate_r8_title",
}


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
        COLOR_WARN_HL=palette.warn_highlight,
    )


def _status_color(status):
    """Unknown/incomplete states must never read as green (success)."""
    return {
        GateStatus.PENDING: COLOR_MUTED,
        GateStatus.CHECKING: COLOR_WARN,
        GateStatus.VERIFIED: COLOR_SUCCESS_HL,
        GateStatus.FAILED: COLOR_DANGER_HL,
        GateStatus.NOT_CONFIGURED: COLOR_WARN,
        GateStatus.NOT_APPLICABLE: COLOR_MUTED,
        GateStatus.SIMULATED: COLOR_WARN_HL,
    }.get(status, COLOR_MUTED)


class IncidentRecoveryWizard(tk.Toplevel):
    def __init__(self, gui):
        _sync_palette_aliases()
        super().__init__(gui.root)
        self.gui = gui
        self.coordinator = RecoveryCoordinator()
        self._gate_rows = {}

        self.title(i18n.t("recovery.window_title"))
        self.configure(bg=COLOR_BG)
        self.geometry("760x760")
        self.minsize(680, 620)
        self.transient(gui.root)

        # Bind to whatever incident already caused containment -- never
        # fabricate one just because this window opened (R1).
        self.coordinator.resolve_incident_context(get_open_incident=db.get_open_incident)
        self.gui.register_recovery_observer(self)

        if config.DRY_RUN:
            banner = tk.Frame(self, bg=COLOR_WARN)
            banner.pack(fill="x")
            tk.Label(
                banner, text=i18n.t("recovery.dry_run_banner"), font=("Segoe UI", 9, "bold"),
                fg="white", bg=COLOR_WARN, wraplength=720, justify="left",
            ).pack(padx=12, pady=6, anchor="w")

        header = tk.Frame(self, bg=COLOR_BG)
        header.pack(fill="x", padx=18, pady=(16, 4))
        tk.Label(header, text=i18n.t("recovery.evidence_heading"), font=("Segoe UI", 13, "bold"),
                 fg=COLOR_ACCENT, bg=COLOR_BG).pack(anchor="w")
        self._subheading_label = tk.Label(header, text="", font=("Segoe UI", 8), fg=COLOR_MUTED, bg=COLOR_BG,
                                           justify="left")
        self._subheading_label.pack(anchor="w", pady=(2, 0))

        scroll = ScrollFrame(self)
        scroll.pack(fill="both", expand=True, padx=18, pady=(4, 14))
        for gate in GATE_ORDER:
            self._build_gate_row(scroll.inner, gate)

        self._refresh_all()

    def destroy(self):
        self.gui.unregister_recovery_observer(self)
        super().destroy()

    # ---- rendering ----------------------------------------------------------

    def _bound_incident_attacker_ip(self):
        detail = self.coordinator.gate(Gate.R1_INCIDENT_CONTEXT).detail
        for part in detail.split("; "):
            if part.startswith("attacker_ip="):
                return part[len("attacker_ip="):]
        return ""

    def _build_gate_row(self, parent, gate):
        card = Card(parent, accent=COLOR_MUTED)
        card.pack(fill="x", pady=6)
        head = tk.Frame(card.body, bg=COLOR_PANEL)
        head.pack(fill="x", pady=(8, 2))
        tk.Label(head, text=i18n.t(GATE_TITLE_KEYS[gate]), font=("Segoe UI", 10, "bold"), fg=COLOR_TEXT,
                 bg=COLOR_PANEL).pack(side="left", padx=12)
        status_label = tk.Label(head, text="", font=("Segoe UI", 8, "bold"), bg=COLOR_PANEL)
        status_label.pack(side="right", padx=12)
        summary_label = tk.Label(card.body, text="", font=("Segoe UI", 9), fg=COLOR_MUTED, bg=COLOR_PANEL,
                                  wraplength=620, justify="left")
        summary_label.pack(anchor="w", padx=12, pady=(0, 6))
        self._gate_rows[gate] = {"card": card, "status": status_label, "summary": summary_label}

        control_row = tk.Frame(card.body, bg=COLOR_PANEL)
        control_row.pack(fill="x", padx=12, pady=(0, 10))

        if gate == Gate.R2_SAFE_ACCESS:
            tk.Button(control_row, text=i18n.t("recovery.r2_button"), font=FONT_BTN_SM, fg="white", bg=COLOR_BLUE,
                      activebackground=COLOR_BLUE_HL, bd=0, cursor="hand2",
                      command=self._on_r2_clicked).pack(side="left")
        elif gate == Gate.R3_ATTACKER_ISOLATION:
            self.ip_entry = tk.Entry(control_row, font=("Consolas", 10), width=18, fg=COLOR_TEXT,
                                      bg=ui_theme.get_palette().panel_alt, insertbackground=COLOR_TEXT, relief="flat")
            self.ip_entry.pack(side="left")
            prefill = self._bound_incident_attacker_ip()
            if prefill:
                self.ip_entry.insert(0, prefill)
            tk.Button(control_row, text=i18n.t("recovery.r3_button"), font=FONT_BTN_SM, fg="white", bg=COLOR_DANGER,
                      activebackground=COLOR_DANGER_HL, bd=0, cursor="hand2",
                      command=self._on_r3_clicked).pack(side="left", padx=(8, 0))
        elif gate == Gate.R4_RESTORE_AUTHORIZATION:
            tk.Button(control_row, text=i18n.t("recovery.r4_button"), font=FONT_BTN_SM, fg="white", bg=COLOR_BLUE,
                      activebackground=COLOR_BLUE_HL, bd=0, cursor="hand2",
                      command=self._on_r4_clicked).pack(side="left")
        elif gate == Gate.R5_PHYSICAL_RESTORE:
            tk.Button(control_row, text=i18n.t("recovery.r5_button"), font=FONT_BTN_SM, fg="white", bg=COLOR_BLUE,
                      activebackground=COLOR_BLUE_HL, bd=0, cursor="hand2",
                      command=self._on_r5_clicked).pack(side="left")
        elif gate == Gate.R6_NETWORK_RECOVERY:
            tk.Button(control_row, text=i18n.t("recovery.r6_button"), font=FONT_BTN_SM, fg="white", bg=COLOR_BLUE,
                      activebackground=COLOR_BLUE_HL, bd=0, cursor="hand2",
                      command=self._on_r6_clicked).pack(side="left")
        elif gate == Gate.R7_SERVICE_RECOVERY:
            tk.Button(control_row, text=i18n.t("recovery.r7_button"), font=FONT_BTN_SM, fg="white", bg=COLOR_BLUE,
                      activebackground=COLOR_BLUE_HL, bd=0, cursor="hand2",
                      command=self._on_r7_clicked).pack(side="left")
        elif gate == Gate.R8_INCIDENT_CLOSURE:
            self.lessons_text = tk.Text(control_row, height=3, width=50, font=("Segoe UI", 9), fg=COLOR_TEXT,
                                         bg=ui_theme.get_palette().panel_alt, insertbackground=COLOR_TEXT,
                                         relief="flat")
            self.lessons_text.pack(anchor="w", fill="x")
            tk.Button(card.body, text=i18n.t("recovery.r8_button"), font=FONT_BTN_SM, fg="white", bg=COLOR_SUCCESS,
                      activebackground=COLOR_SUCCESS_HL, bd=0, cursor="hand2",
                      command=self._on_r8_clicked).pack(anchor="w", padx=12, pady=(0, 10))
        # R1 needs no control: it is resolved automatically when this window opens.

    def _refresh_gate_display(self, gate):
        evidence = self.coordinator.gate(gate)
        row = self._gate_rows[gate]
        row["status"].config(text=evidence.status.value, fg=_status_color(evidence.status))
        row["card"].set_accent(_status_color(evidence.status))
        text = evidence.summary
        if evidence.detail:
            text = f"{text} — {evidence.detail}"
        row["summary"].config(text=text)

    def _refresh_subheading(self):
        if self.coordinator.incident_id is None:
            self._subheading_label.config(text=i18n.t("recovery.no_incident"))
        else:
            self._subheading_label.config(text=i18n.t("recovery.subheading", incident_id=self.coordinator.incident_id))

    def _refresh_all(self):
        for gate in GATE_ORDER:
            self._refresh_gate_display(gate)
        self._refresh_subheading()

    def _log(self, text, level=db.INFO):
        stamp = time.strftime("%H:%M:%S")
        self.gui.log_message(f"[{stamp}] [RECOVERY] {text}", level)

    # ---- gate actions ---------------------------------------------------------

    def _on_r2_clicked(self):
        evidence = self.coordinator.verify_safe_access()
        self._log(f"R2: {evidence.summary}", db.INFO if evidence.status == GateStatus.VERIFIED else db.WARN)
        self._refresh_gate_display(Gate.R2_SAFE_ACCESS)

    def _on_r3_clicked(self):
        ip = self.ip_entry.get().strip()
        if not ip:
            messagebox.showwarning(i18n.t("recovery.step2_missing_ip_title"),
                                   i18n.t("recovery.step2_missing_ip_message"), parent=self)
            return
        evidence = self.coordinator.apply_and_verify_attacker_isolation(ip)
        self._log(f"R3: {evidence.summary}", db.INFO if evidence.status == GateStatus.VERIFIED else db.WARN)
        self._refresh_gate_display(Gate.R3_ATTACKER_ISOLATION)

    def _on_r4_clicked(self):
        pin = simpledialog.askstring(i18n.t("dialog.admin_auth_title"), i18n.t("dialog.pin_prompt_default"),
                                     show='*', parent=self)
        if pin is None:
            return
        evidence = self.coordinator.authorize_restore(pin, origin="recovery-wizard")
        if evidence.status != GateStatus.VERIFIED:
            messagebox.showerror(i18n.t("dialog.access_denied_title"), i18n.t("dialog.wrong_pin_simple"), parent=self)
        self._log(f"R4: {evidence.summary}", db.INFO if evidence.status == GateStatus.VERIFIED else db.WARN)
        self._refresh_gate_display(Gate.R4_RESTORE_AUTHORIZATION)

    def _on_r5_clicked(self):
        evidence = self.coordinator.request_physical_restore(self.gui.controller, origin="recovery-wizard")
        self._log(f"R5: {evidence.summary}", db.INFO if evidence.status in
                  (GateStatus.CHECKING, GateStatus.VERIFIED, GateStatus.SIMULATED) else db.WARN)
        self._refresh_gate_display(Gate.R5_PHYSICAL_RESTORE)

    def _on_r6_clicked(self):
        evidence = self.coordinator.verify_network_recovery()
        self._log(f"R6: {evidence.summary}", db.INFO if evidence.status == GateStatus.VERIFIED else db.WARN)
        self._refresh_gate_display(Gate.R6_NETWORK_RECOVERY)

    def _on_r7_clicked(self):
        evidence = self.coordinator.verify_service_recovery(mqtt_manager=self.gui.mqtt)
        self._log(f"R7: {evidence.summary}", db.INFO if evidence.status == GateStatus.VERIFIED else db.WARN)
        self._refresh_gate_display(Gate.R7_SERVICE_RECOVERY)

    def _on_r8_clicked(self):
        summary = self.lessons_text.get("1.0", "end").strip()
        evidence = self.coordinator.close_incident(summary)
        self._log(f"R8: {evidence.summary}", db.INFO if evidence.status == GateStatus.VERIFIED else db.WARN)
        self._refresh_gate_display(Gate.R8_INCIDENT_CLOSURE)
        if evidence.status == GateStatus.VERIFIED:
            self.gui.refresh_incident_banner()
            messagebox.showinfo(i18n.t("recovery.closed_title"),
                                i18n.t("recovery.closed_message", incident_id=self.coordinator.incident_id), parent=self)
        else:
            messagebox.showwarning(i18n.t("recovery.step5_missing_title"), evidence.summary, parent=self)

    # ---- forwarded MQTT evidence (see gui.py's register_recovery_observer) ----

    def on_ack_evidence(self, ack, detail, nonce):
        self.coordinator.on_ack_evidence(ack, detail, nonce)
        if self.winfo_exists():
            self._refresh_gate_display(Gate.R5_PHYSICAL_RESTORE)

    def on_status_evidence(self, state, rssi, heap, command_nonce):
        self.coordinator.on_status_evidence(state, rssi, heap, command_nonce)
        if self.winfo_exists():
            self._refresh_gate_display(Gate.R5_PHYSICAL_RESTORE)
