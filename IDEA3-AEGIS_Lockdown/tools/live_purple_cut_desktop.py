"""Purple Python Desktop with Core-authenticated Manual CUT. Explicitly enabled; no MQTT; RESTORE stays disabled.

This is a SEPARATE entry point from ``live_purple_observer`` (which stays strictly read-only and is unchanged). It loads the same
accepted purple GUI and the same read-only Core evidence, and does exactly one more thing: the already-present CUT button is
re-labelled and wired to the Core-local CUT channel through ``aegis_soc.cut_client``.

  * The Desktop holds no broker credential, protocol key, database or controller. It never publishes anything; the Core does.
  * Every CUT asks the human for a fresh reason, the typed confirmation (intent evidence only) and a secret that the CORE verifies.
    The secret is passed to one ``submit`` call and never stored.
  * Results and the ACK/STATUS lifecycle are shown exactly as the Core reports them; physical disconnection is never claimed.
  * It refuses to start unless ``AEGIS_DESKTOP_CUT_ENABLED`` is exactly ``YES`` and ``AEGIS_LOCAL_CUT_SOCKET`` is absolute.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, simpledialog
from types import SimpleNamespace

from tools import live_purple_observer as live

ENABLE_ENV = "AEGIS_DESKTOP_CUT_ENABLED"
SOCKET_ENV = "AEGIS_LOCAL_CUT_SOCKET"
CUT_TITLE = "AEGIS IDEA3 — PURPLE DESKTOP — MANUAL CUT (CORE-AUTHENTICATED)"
CUT_BUTTON_TEXT = "CUT NETWORK (Core-authenticated)"
POLL_MS = 1000


def _load_client():
    path = Path(__file__).resolve().parents[1] / "aegis_soc" / "cut_client.py"
    spec = importlib.util.spec_from_file_location("aegis_cut_client", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load the Core CUT client: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["aegis_cut_client"] = module
    spec.loader.exec_module(module)
    return module


client = _load_client()


def configuration(environ=None) -> str | None:
    """The Core CUT socket path, or None (Manual CUT disabled) unless explicitly enabled and configured."""
    env = os.environ if environ is None else environ
    path = env.get(SOCKET_ENV, "").strip()
    if env.get(ENABLE_ENV) != "YES" or not os.path.isabs(path):
        return None
    return path


class Prompts:
    """The three human inputs for ONE CUT. Replaceable in tests; the real ones are modal dialogs."""

    def ask_reason(self):
        return simpledialog.askstring("Manual CUT", "Reason for this CUT (12-240 characters):")

    def ask_confirmation(self):
        return simpledialog.askstring("Manual CUT", f"Type {client.CONFIRMATION} to confirm your intent:")

    def ask_secret(self):
        return simpledialog.askstring("Manual CUT", "CUT secret (verified by the Core; never stored):", show="*")

    def notify(self, title, text):
        messagebox.showwarning(title, text)


def _thread_runner(function, *args):
    threading.Thread(target=function, args=args, name="aegis-cut-desktop", daemon=True).start()


def _cut_gui_class(gui, flow, prompts, run_async):
    Base = live._live_gui_class(gui)

    class LivePurpleCutDesktopGUI(Base):
        manual_cut_enabled = True

        def __init__(self, *args, **kwargs):
            self._cut_button = None
            self._cut_status = None
            super().__init__(*args, **kwargs)
            self.root.title(CUT_TITLE)

        def _on_authenticated(self):
            super()._on_authenticated()
            self.root.title(CUT_TITLE)

        def _show_page(self, key):
            super()._show_page(key)  # the preview base disables every button on each page change
            if key == "lockdown":
                self._install_cut_control()

        # The preview base neutralizes these callbacks; only the dedicated Core-authenticated flow below may CUT.
        def on_cut_clicked(self):
            self._preview_control_attempt = True

        def _walk(self, widget):
            for child in widget.winfo_children():
                yield child
                yield from self._walk(child)

        def _install_cut_control(self):
            """Re-label and wire the accepted page's existing CUT button in place; drop only its 'disabled' explanation."""
            button = next((w for w in self._walk(self.workspace) if isinstance(w, tk.Button)
                           and w.cget("text") == "CUT NETWORK — DISABLED"), None)
            if button is None:
                return
            for label in [w for w in self._walk(self.workspace) if isinstance(w, tk.Label)]:
                if "no authorized Core-owned manual CUT request interface" in str(label.cget("text")):
                    label.master.destroy()
                    break
            button.configure(text=CUT_BUTTON_TEXT, state=tk.NORMAL, command=self._on_cut_pressed)
            self._cut_button = button
            self._cut_status = tk.Label(
                button.master, text=self._status_text(), anchor="w", justify="left", wraplength=640,
                font=gui.ui_theme.FONT_BODY,
                bg=button.master.cget("bg"), fg=gui.ui_theme.COLOR_MUTED,
            )
            self._cut_status.pack(fill="x", pady=(0, 6), after=button)
            self._refresh_cut_button()

        def _status_text(self):
            view = flow.view
            return f"{view.state}: {view.text}"

        def _refresh_cut_button(self):
            if self._cut_button is not None and self._cut_button.winfo_exists():
                self._cut_button.configure(state=tk.DISABLED if flow.busy else tk.NORMAL)
            if self._cut_status is not None and self._cut_status.winfo_exists():
                self._cut_status.configure(text=self._status_text())

        def _on_cut_pressed(self):
            if flow.busy:
                return
            reason = prompts.ask_reason()
            if reason is None:
                return
            if prompts.ask_confirmation() != client.CONFIRMATION:
                prompts.notify("Manual CUT", "Confirmation did not match. Nothing was sent.")
                return
            secret = prompts.ask_secret()  # a fresh secret for every CUT; nothing is remembered
            if not secret:
                prompts.notify("Manual CUT", "Authentication is required. Nothing was sent.")
                return
            if self._cut_button is not None:
                self._cut_button.configure(state=tk.DISABLED)
            run_async(self._submit_worker, reason, secret)

        def _submit_worker(self, reason, secret):
            try:
                view = flow.submit(reason, secret)
            finally:
                secret = None
            self._call_later(0, self._after_submit, view)

        def _call_later(self, delay, function, *args):
            try:
                self.root.after(delay, function, *args)
            except (tk.TclError, RuntimeError):
                pass  # the window is gone; nothing to render

        def _after_submit(self, view):
            self._refresh_cut_button()
            if flow.busy:
                self._call_later(POLL_MS, self._schedule_poll)
            elif view.state != "IDLE":
                prompts.notify("Manual CUT", f"{view.state}\n\n{view.text}")

        def _schedule_poll(self):
            run_async(self._poll_worker)

        def _poll_worker(self):
            view = flow.poll()
            self._call_later(0, self._after_poll, view)

        def _after_poll(self, view):
            self._refresh_cut_button()
            if flow.busy:
                self._call_later(POLL_MS, self._schedule_poll)
            elif view.terminal:
                prompts.notify("Manual CUT", f"{view.state}\n\n{view.text}")

    return LivePurpleCutDesktopGUI


def create_cut_app(root, *, flow, prompts=None, run_async=_thread_runner, status_path=live.reader.STATUS_PATH,
                   max_age_seconds=live.reader.DEFAULT_MAX_AGE_SECONDS):
    if any(name == "aegis_soc" or name.startswith("aegis_soc.") for name in sys.modules):
        raise RuntimeError("the CUT Desktop must start without an imported aegis_soc package")
    sys.path.insert(0, str(live.PYTHONUI_ROOT))
    live._install_import_isolation()
    live._install_database_isolation()
    from aegis_soc import gui

    if not str(Path(gui.__file__).resolve()).startswith(str(live.PYTHONUI_ROOT)):
        raise RuntimeError(f"wrong purple GUI source loaded: {gui.__file__}")
    mqtt = live.LiveMQTT()
    controller = live.LiveController()
    app_class = _cut_gui_class(gui, flow, prompts or Prompts(), run_async)
    app = app_class(root, mqtt, controller, status_path=Path(status_path), max_age_seconds=max_age_seconds)
    return app, SimpleNamespace(mqtt=mqtt, controller=controller, flow=flow)


def main():
    path = configuration()
    if path is None:
        print(f"Manual CUT is disabled: set {ENABLE_ENV}=YES and an absolute {SOCKET_ENV}. "
              "Use tools/live_purple_observer.py for the read-only observer.", file=sys.stderr)
        return 2
    root = tk.Tk()
    app, _isolation = create_cut_app(root, flow=client.ManualCutFlow(path))
    root.mainloop()
    return 0 if app else 1


if __name__ == "__main__":
    sys.exit(main())
