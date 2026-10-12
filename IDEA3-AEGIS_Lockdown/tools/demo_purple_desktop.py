"""Offline synthetic CUT/RESTORE walkthrough using the real purple Desktop.

This module is deliberately separate from the live observer.  Its controller
is an in-memory state machine: it cannot reach MQTT, Core, Recovery, hardware,
the network, or the host firewall.  The real PYTHONUI GUI and LoginView are
loaded unchanged from the existing preview harness.
"""

from __future__ import annotations

import sys
import tempfile
import tkinter as tk
from tkinter import messagebox
from pathlib import Path
from types import SimpleNamespace

from tools import preview_purple_desktop as preview


DEMO_TITLE = "AEGIS IDEA3 — OFFLINE PURPLE DESKTOP DEMO — SIMULATED"


class DemoResult:
    def __init__(self, *, ok: bool, sent: bool = False, reason: str = "") -> None:
        self.ok = ok
        self.sent = sent
        self.dry_run = False
        self.nonce = None
        self.reason = reason


class DemoController:
    """Synthetic command contract for the offline walkthrough only."""

    def __init__(self) -> None:
        self.uplink = "NORMAL"
        self.alert_ip = None
        self.recovery_approved = False
        self.commands = []

    def raise_critical_alert(self, ip: str) -> None:
        self.alert_ip = ip

    def approve_recovery(self) -> None:
        self.recovery_approved = True

    def issue(self, action, _description="", *, critical=False, authorize_restore=False, confirmed=False, **_kwargs):
        if action == "CUT_UPLINK":
            if not critical or not confirmed or not self.alert_ip or self.uplink != "NORMAL":
                return DemoResult(ok=False, reason="explicit critical confirmation and NORMAL state required")
            self.uplink = "LOCKDOWN"
        elif action == "RESTORE_UPLINK":
            if not authorize_restore or not self.recovery_approved or self.uplink != "LOCKDOWN":
                return DemoResult(ok=False, reason="simulated Recovery approval and LOCKDOWN state required")
            self.uplink = "NORMAL"
        else:
            return DemoResult(ok=False, reason="unsupported synthetic action")
        self.commands.append(action)
        return DemoResult(ok=True, sent=True)


def _demo_gui_class(gui):
    class DemoPurpleGUI(gui.AegisAdminGUI):
        synthetic_demo = True

        def __init__(self, root, mqtt_manager, command_controller=None):
            self.demo_controller = command_controller
            super().__init__(root, mqtt_manager, command_controller=command_controller)
            self.root.title(DEMO_TITLE)

        def _start_background_heartbeat(self):
            self._demo_heartbeat_workers = 0

        def _tick_monitors(self):
            self._demo_monitor_polls = 0

        def _sync_arm_controls(self):
            if not hasattr(self, "btn_cut") or not self.btn_cut.winfo_exists():
                return
            self.btn_arm.configure(state="disabled")
            self.btn_recovery.configure(state="normal" if self.session.authenticated else "disabled")
            self.btn_cut.configure(
                state="normal"
                if self.session.authenticated and self.demo_controller.alert_ip and self.demo_controller.uplink == "NORMAL"
                else "disabled"
            )
            self.btn_restore.configure(
                state="normal"
                if self.session.authenticated and self.demo_controller.recovery_approved and self.demo_controller.uplink == "LOCKDOWN"
                else "disabled"
            )

        def _show_page(self, key):
            super()._show_page(key)
            self._sync_arm_controls()

        def _on_authenticated(self):
            super()._on_authenticated()
            self.root.title(DEMO_TITLE)

        def simulate_critical_alert(self):
            self.demo_controller.raise_critical_alert("198.51.100.7")
            self._last_uplink_state = self.demo_controller.uplink
            self._show_page("lockdown")

        def open_recovery_wizard(self):
            self.demo_controller.approve_recovery()
            self._show_page("lockdown")

        def request_cut(self, *, confirmed: bool):
            if not self.session.authenticated:
                return False
            result = self.demo_controller.issue(
                "CUT_UPLINK",
                "synthetic critical containment",
                critical=True,
                confirmed=confirmed,
            )
            self._last_uplink_state = self.demo_controller.uplink
            self._show_page("lockdown")
            return result.ok

        def request_restore(self):
            if not self.session.authenticated:
                return False
            result = self.demo_controller.issue(
                "RESTORE_UPLINK",
                "synthetic Recovery approval",
                authorize_restore=True,
            )
            self._last_uplink_state = self.demo_controller.uplink
            self._show_page("lockdown")
            return result.ok

        def on_cut_clicked(self):
            confirmed = messagebox.askyesno(
                "OFFLINE DEMO — SIMULATED CUT",
                "Simulate CUT NETWORK? No Core, MQTT, relay, or hardware action will occur.",
                parent=self.root,
            )
            self.request_cut(confirmed=confirmed)

        def on_restore_clicked(self):
            self.request_restore()

        def toggle_arm(self):
            return None

        def send_command(self, *_args, **_kwargs):
            return None

        def run_ufw_async(self, *_args, **_kwargs):
            return None

        def export_audit_log(self):
            return None

        def verify_log_integrity(self):
            return None

        def _build_lockdown_page(self, parent):
            super()._build_lockdown_page(parent)
            scroll = next(child for child in parent.winfo_children() if hasattr(child, "inner"))
            section = gui.Section(scroll.inner, "DEMO / SIMULATED WALKTHROUGH")
            section.pack(fill="x", padx=16, pady=(0, 20))
            tk.Button(
                section.body,
                text="SIMULATE CRITICAL ALERT",
                command=self.simulate_critical_alert,
                font=gui.FONT_BTN_SM,
                fg="white",
                bg=gui.COLOR_WARN_HL,
                bd=0,
            ).pack(fill="x", pady=4)
            gui.make_hint(section.body, "Synthetic only — no detector, Core, MQTT, relay, or firewall action").pack(anchor="w", pady=(6, 0))

    return DemoPurpleGUI


def create_demo_app(root, *, data_dir: Path):
    preview._prepare_environment(Path(data_dir))
    if any(name == "aegis_soc" or name.startswith("aegis_soc.") for name in sys.modules):
        raise RuntimeError("demo must start in a process without an already-imported aegis_soc package")
    sys.path.insert(0, preview.PYTHONUI_ROOT)
    preview._install_import_isolation()
    from aegis_soc import database as db
    from aegis_soc import gui

    if not str(Path(gui.__file__).resolve()).startswith(preview.PYTHONUI_ROOT):
        raise RuntimeError(f"wrong purple GUI source loaded: {gui.__file__}")
    db.init_db()
    mqtt = preview.PreviewMQTT()
    controller = DemoController()
    app = _demo_gui_class(gui)(root, mqtt, command_controller=controller)
    app.login_view.flow.credential_verifier = (
        lambda admin_id, pin: admin_id == preview.PREVIEW_ADMIN_ID and pin == preview.PREVIEW_ADMIN_PIN
    )
    app.root.title(DEMO_TITLE)
    return app, SimpleNamespace(mqtt=mqtt, controller=controller)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="aegis-purple-demo-") as data_dir:
        root = tk.Tk()
        app, _fakes = create_demo_app(root, data_dir=Path(data_dir))
        root.mainloop()
        _ = app


if __name__ == "__main__":
    main()
