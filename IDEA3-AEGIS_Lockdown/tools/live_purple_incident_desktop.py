"""Purple Python Desktop with live, READ-ONLY incident visibility from the Core-attested Recovery STATUS operation.

A separate entry point from ``live_purple_observer`` (unchanged). It fills exactly one accepted page, Incidents, with what the
Core itself reports: incident id, state, opened-at, source IP and the R1-R8 gate results, each labelled with its authority and
the Core's own check time. Old VERIFIED checks are shown STALE. It never infers the relay, ESP32, broker, uplink or Core
runtime; those stay UNKNOWN.

Safety properties (each is pinned by tests):
  * The only request this process can make is ``STATUS`` (``incident_view.fetch`` has no operation parameter). There is no code
    path to ISOLATE, PROBE, RESTORE_STATUS, CLOSE, CUT or RESTORE, and no button is added or enabled.
  * Transport is the existing ``recovery_client`` unchanged: absolute socket path, the server must be the Core account
    (SO_PEERCRED), bounded reply, fail closed. It is loaded by path under a private package name, so the operational
    ``aegis_soc`` package, MQTT, databases and credentials are never imported.
  * A failed read shows NOT_AVAILABLE for everything; no historical value is kept on screen.
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import threading
import tkinter as tk
from pathlib import Path
from types import ModuleType, SimpleNamespace

from tools import live_purple_observer as live

INCIDENT_TITLE = "AEGIS IDEA3 — PURPLE DESKTOP — LIVE INCIDENT VISIBILITY (READ ONLY)"
POLL_MS = 5000
_PRIVATE_PACKAGE = "aegis_incident_recovery"
_AEGIS_SOC_DIR = Path(__file__).resolve().parents[1] / "aegis_soc"


def _load_view():
    spec = importlib.util.spec_from_file_location("aegis_incident_view", _AEGIS_SOC_DIR / "incident_view.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load the incident view model")
    module = importlib.util.module_from_spec(spec)
    sys.modules["aegis_incident_view"] = module
    spec.loader.exec_module(module)
    return module


view = _load_view()


def load_recovery_transport():
    """The EXISTING recovery_client/recovery_protocol files, loaded as a private package (no ``aegis_soc`` import)."""
    package = sys.modules.get(_PRIVATE_PACKAGE)
    if package is None:
        package = ModuleType(_PRIVATE_PACKAGE)
        package.__path__ = [str(_AEGIS_SOC_DIR)]
        sys.modules[_PRIVATE_PACKAGE] = package
    return importlib.import_module(f"{_PRIVATE_PACKAGE}.recovery_client")


def default_source():
    """A callable returning a Snapshot from the live Core STATUS operation (read-only, fail closed)."""
    client = load_recovery_transport()
    errors = (client.RecoveryUnavailable, client.RecoveryOutcomeUnknown)

    def read():
        return view.fetch(client.request, errors)

    return read


def _thread_runner(function, *args):
    threading.Thread(target=function, args=args, name="aegis-incident-desktop", daemon=True).start()


def _incident_gui_class(gui, source, run_async):
    Base = live._live_gui_class(gui)

    def status_for(state):
        if state == view.VERIFIED:
            return gui.pres.STATUS_HEALTHY
        if state == view.FAILED:
            return gui.pres.STATUS_CRITICAL
        if state in {view.PENDING, view.CHECKING, view.STALE}:
            return gui.pres.STATUS_WARNING
        return gui.pres.STATUS_UNKNOWN

    class LivePurpleIncidentDesktopGUI(Base):
        incident_visibility = True

        def __init__(self, *args, **kwargs):
            self.snapshot = view.unavailable("Core STATUS not read yet")
            self._incident_page = None
            self._incident_section = None
            self._poll_started = False
            self._closed = False
            super().__init__(*args, **kwargs)
            self.root.title(INCIDENT_TITLE)

        def _on_authenticated(self):
            super()._on_authenticated()
            self.root.title(INCIDENT_TITLE)
            if not self._poll_started:
                self._poll_started = True
                self._start_poll()

        def _start_poll(self):
            if self._closed:
                return
            run_async(self._poll_worker)

        def _poll_worker(self):
            snapshot = source()
            self._later(0, self._apply_snapshot, snapshot)

        def _later(self, delay, function, *args):
            try:
                self.root.after(delay, function, *args)
            except (tk.TclError, RuntimeError):
                self._closed = True

        def _apply_snapshot(self, snapshot):
            self.snapshot = snapshot
            self._render_incident_section()
            if self.session.authenticated and not self._closed:
                self._later(POLL_MS, self._start_poll)

        def _on_close(self):
            self._closed = True
            super()._on_close()

        def _build_incidents_page(self, parent):
            self._incident_page = self._new_page(parent, "incidents.title", "incidents.subtitle")
            self._incident_section = None
            self._render_incident_section()

        def _render_incident_section(self):
            page = self._incident_page
            if page is None or not page.winfo_exists():
                return
            if self._incident_section is not None and self._incident_section.winfo_exists():
                self._incident_section.destroy()
            shot = self.snapshot
            host = tk.Frame(page, bg=page.cget("bg"))
            host.pack(fill="x")
            self._incident_section = host

            summary = gui.Section(host, "INCIDENT — CORE-ATTESTED, READ ONLY")
            summary.pack(fill="x", padx=16, pady=(0, 16))
            self._add_fact(summary.body, "Authority", shot.authority, status=gui.pres.STATUS_NEUTRAL)
            self._add_fact(summary.body, "Fetched (Desktop clock)", shot.fetched_text, status=gui.pres.STATUS_NEUTRAL)
            if not shot.available:
                self._add_fact(summary.body, "Core Recovery STATUS", view.NOT_AVAILABLE + " — " + shot.reason,
                               status=gui.pres.STATUS_UNKNOWN)
            elif shot.incident is None:
                self._add_fact(summary.body, "Incident", "NO OPEN INCIDENT REPORTED BY THE CORE", status=gui.pres.STATUS_HEALTHY)
            else:
                incident = shot.incident
                self._add_fact(summary.body, "Incident ID", incident.incident_id, status=gui.pres.STATUS_NEUTRAL)
                self._add_fact(summary.body, "Incident state", incident.state,
                               status=gui.pres.STATUS_WARNING if incident.state == "OPEN" else gui.pres.STATUS_UNKNOWN)
                self._add_fact(summary.body, "Opened at (as reported by the Core)", incident.opened_at,
                               status=gui.pres.STATUS_NEUTRAL)
                self._add_fact(summary.body, "Source IP (detector alert bound by the Core)", incident.source_ip,
                               status=gui.pres.STATUS_WARNING)

            gates = gui.Section(host, "RECOVERY GATES R1–R8 — CORE-ATTESTED")
            gates.pack(fill="x", padx=16, pady=(0, 16))
            for gate in shot.gates:
                parts = [gate.state]
                if gate.checked_at_text not in {"NOT_AVAILABLE", view.UNKNOWN}:
                    parts.append("checked " + gate.checked_at_text)
                if gate.summary != view.UNKNOWN and gate.summary:
                    parts.append(gate.summary)
                self._add_fact(gates.body, gate.label, " · ".join(parts), status=status_for(gate.state))
            gui.make_hint(gates.body, "VERIFIED older than 15 minutes is shown STALE. " + shot.not_physical).pack(
                anchor="w", pady=(8, 0))

            absent = gui.Section(host, "NOT PROVIDED BY RECOVERY STATUS")
            absent.pack(fill="x", padx=16, pady=(0, 20))
            for label in view.NOT_PROVIDED:
                self._add_fact(absent.body, label, "UNKNOWN — not provided by this source", status=gui.pres.STATUS_UNKNOWN)

    return LivePurpleIncidentDesktopGUI


def create_incident_app(root, *, source=None, run_async=_thread_runner, status_path=live.reader.STATUS_PATH,
                        max_age_seconds=live.reader.DEFAULT_MAX_AGE_SECONDS):
    if any(name == "aegis_soc" or name.startswith("aegis_soc.") for name in sys.modules):
        raise RuntimeError("the incident Desktop must start without an imported aegis_soc package")
    reader_source = source if source is not None else default_source()
    sys.path.insert(0, str(live.PYTHONUI_ROOT))
    live._install_import_isolation()
    live._install_database_isolation()
    from aegis_soc import gui

    if not str(Path(gui.__file__).resolve()).startswith(str(live.PYTHONUI_ROOT)):
        raise RuntimeError(f"wrong purple GUI source loaded: {gui.__file__}")
    mqtt = live.LiveMQTT()
    controller = live.LiveController()
    app_class = _incident_gui_class(gui, reader_source, run_async)
    app = app_class(root, mqtt, controller, status_path=Path(status_path), max_age_seconds=max_age_seconds)
    return app, SimpleNamespace(mqtt=mqtt, controller=controller)


def main():
    root = tk.Tk()
    app, _isolation = create_incident_app(root)
    root.mainloop()
    return 0 if app else 1


if __name__ == "__main__":
    sys.exit(main())
