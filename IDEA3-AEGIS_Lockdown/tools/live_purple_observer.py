"""Live, read-only launcher for the human-accepted purple Python Desktop.

The dirty PYTHONUI package supplies the real AegisAdminGUI, LoginView, theme,
and page builders. This entrypoint supplies only a Core status projection and
fail-closed local fakes for every operational dependency.
"""

from __future__ import annotations

import importlib.util
import sys
import tkinter as tk
from pathlib import Path
from types import ModuleType, SimpleNamespace

from tools.preview_purple_desktop import PYTHONUI_ROOT as ACCEPTED_PURPLE_SOURCE
from tools.preview_purple_desktop import _install_import_isolation, _preview_gui_class


PYTHONUI_ROOT = Path(ACCEPTED_PURPLE_SOURCE).resolve()
LIVE_TITLE = "AEGIS IDEA3 — PURPLE LIVE READ-ONLY OBSERVER — CORE EVIDENCE"
EVIDENCE_POLL_MS = 2000


def _load_reader():
    reader_path = Path(__file__).resolve().parents[1] / "aegis_soc" / "observer.py"
    spec = importlib.util.spec_from_file_location("aegis_observer_reader", reader_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load read-only Core observer: {reader_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["aegis_observer_reader"] = module
    spec.loader.exec_module(module)
    return module


reader = _load_reader()


class LiveMQTT:
    """Non-transport object exposing only the real GUI's read accessor."""

    def __init__(self):
        self.last_attacker_ip = None
        self.protocol = None
        self.device_state = reader.UNKNOWN
        self.start_calls = 0
        self.connect_calls = 0
        self.publish_calls = 0

    def seconds_since_device(self):
        if self.device_state == "ONLINE":
            return 0.0
        if self.device_state == "OFFLINE":
            return 999999.0
        return None

    def start(self):
        self.start_calls += 1
        raise AssertionError("live observer attempted MQTT startup")

    def connect(self, *args, **kwargs):
        self.connect_calls += 1
        raise AssertionError("live observer attempted an MQTT connection")

    def publish(self, *args, **kwargs):
        self.publish_calls += 1
        raise AssertionError("live observer attempted MQTT publication")

    def stop(self):
        return None


class LiveController:
    def __init__(self):
        self.issue_calls = 0

    def issue(self, *args, **kwargs):
        self.issue_calls += 1
        raise AssertionError("live observer attempted a control-plane command")


def _install_database_isolation() -> None:
    """Prevent the operational GUI from opening or writing any database."""

    module = ModuleType("aegis_soc.database")
    module.INFO = "INFO"
    module.WARN = "WARN"
    module.CRITICAL = "CRITICAL"
    module.init_db = lambda: None
    module.log_event = lambda *args, **kwargs: None
    module.log_to_file_only = lambda *args, **kwargs: None
    module.fetch_incidents = lambda **kwargs: []
    module.fetch_all_logs = lambda: []
    module.get_open_incident = lambda: None
    module.count_incidents_today = lambda: 0
    module.create_incident = lambda *args, **kwargs: None
    module.verify_chain = lambda: (False, "NOT_AVAILABLE")
    sys.modules["aegis_soc.database"] = module


def evidence_values(evidence):
    """Return only display values from the bounded evidence projection."""

    if not evidence.valid:
        return {
            "runtime": reader.UNKNOWN,
            "profile": reader.UNKNOWN,
            "broker": reader.UNKNOWN,
            "device": reader.UNKNOWN,
            "uplink": reader.UNKNOWN,
            "armed": reader.UNKNOWN,
            "dispatch": reader.UNKNOWN,
            "trusted_time": reader.UNKNOWN,
            "dry_run": reader.UNKNOWN,
            "auto_contain": reader.UNKNOWN,
            "freshness": evidence.freshness,
            "timestamp": reader.UNKNOWN,
        }
    return {
        "runtime": evidence.runtime_state,
        "profile": evidence.profile,
        "broker": evidence.broker,
        "device": evidence.device,
        "uplink": evidence.uplink,
        "armed": evidence.armed,
        "dispatch": evidence.dispatch,
        "trusted_time": evidence.trusted_time,
        "dry_run": evidence.dry_run,
        "auto_contain": evidence.auto_contain,
        "freshness": evidence.freshness,
        "timestamp": evidence.evidence_timestamp,
    }


def _status(gui, value):
    if value in {"CONNECTED", "ONLINE", "SYNCED", "NORMAL", "RUNNING", "ACTIVE", "FRESH", "FALSE"}:
        return gui.pres.STATUS_HEALTHY
    if value in {"DISCONNECTED", "OFFLINE", "FAILED"}:
        return gui.pres.STATUS_CRITICAL
    if value in {"LOCKDOWN", "ARMED", "DISARMED", "HOLDOVER", "STALE", "UNAVAILABLE", "NOT_VERIFIED", "NOT_AVAILABLE"}:
        return gui.pres.STATUS_WARNING
    return gui.pres.STATUS_UNKNOWN


def _live_gui_class(gui):
    PreviewBase = _preview_gui_class(gui)

    class LivePurpleObserverGUI(PreviewBase):
        live_observer = True

        def __init__(self, root, mqtt_manager, command_controller, *, status_path, max_age_seconds):
            self._status_path = Path(status_path)
            self._max_age_seconds = max_age_seconds
            self.latest = reader.ObserverEvidence(False, "UNAVAILABLE", "Core evidence not read")
            self._observer_page = None
            super().__init__(root, mqtt_manager, command_controller=command_controller)
            self.root.title(LIVE_TITLE)

        def _emit_startup_warnings(self):
            return None

        def _on_authenticated(self):
            self._refresh_live_evidence()
            super()._on_authenticated()
            self.root.title(LIVE_TITLE)
            self._schedule_evidence_poll()

        def _schedule_evidence_poll(self):
            if self.root.winfo_exists():
                self.root.after(EVIDENCE_POLL_MS, self._poll_evidence)

        def _poll_evidence(self):
            if self.session.authenticated:
                self._refresh_live_evidence()
            self._schedule_evidence_poll()

        def _refresh_live_evidence(self):
            self.latest = reader.read_observer_status(
                self._status_path,
                max_age_seconds=self._max_age_seconds,
            )
            self.mqtt.device_state = self.latest.device if self.latest.valid else reader.UNKNOWN
            self._broker_connected = (
                True if self.latest.broker == "CONNECTED" and self.latest.valid
                else False if self.latest.broker == "DISCONNECTED" and self.latest.valid
                else None
            )
            self._last_uplink_state = self.latest.uplink if self.latest.valid else None
            self._last_rssi = None
            self._last_heap = None
            self.armed = self.latest.armed == "ARMED" if self.latest.valid else False
            self._refresh_overview_metrics()
            self._refresh_header_evidence()
            if self._observer_page is not None and self._observer_page.winfo_exists():
                self._render_evidence_section()

        def _refresh_header_evidence(self):
            values = evidence_values(self.latest)
            if hasattr(self, "badge_mode") and self.badge_mode.winfo_exists():
                self.badge_mode.update_status(values["armed"], _status(gui, values["armed"]))
            if hasattr(self, "badge_broker") and self.badge_broker.winfo_exists():
                self.badge_broker.update_status("MQTT: " + values["broker"], _status(gui, values["broker"]))
            if hasattr(self, "badge_esp32") and self.badge_esp32.winfo_exists():
                self.badge_esp32.update_status("ESP32: " + values["device"], _status(gui, values["device"]))

        def _refresh_overview_metrics(self):
            if not self.session.authenticated:
                return
            values = evidence_values(self.latest)
            metrics = {
                "health": values["runtime"],
                "uplink": values["uplink"],
                "broker": values["broker"],
                "esp32": values["device"],
                "mode": values["armed"],
                "deadman": "NOT_AVAILABLE",
                "incidents": "NOT_AVAILABLE",
                "today": "NOT_AVAILABLE",
            }
            for key, value in metrics.items():
                card = self.metric_cards.get(key)
                if card is not None and card.winfo_exists():
                    card.update(value, _status(gui, value), self.latest.reason if value in {reader.UNKNOWN, "NOT_AVAILABLE"} else "Core-reported evidence")

        def _build_overview_page(self, parent):
            super()._build_overview_page(parent)
            scroll = next(child for child in parent.winfo_children() if hasattr(child, "inner"))
            self._observer_page = scroll.inner
            self._render_evidence_section()

        def _render_evidence_section(self):
            if self._observer_page is None or not self._observer_page.winfo_exists():
                return
            if hasattr(self, "_observer_evidence_section") and self._observer_evidence_section.winfo_exists():
                self._observer_evidence_section.destroy()
            values = evidence_values(self.latest)
            section = gui.Section(self._observer_page, "LIVE CORE EVIDENCE — READ ONLY")
            section.pack(fill="x", padx=16, pady=(0, 16))
            for label, key in (
                ("Runtime state", "runtime"), ("Profile", "profile"), ("Broker connection", "broker"),
                ("ESP32 reported presence", "device"), ("Uplink reported state", "uplink"),
                ("ARM/DISARM reported state", "armed"), ("Dispatch mode", "dispatch"),
                ("Trusted time", "trusted_time"), ("Evidence freshness", "freshness"),
                ("Evidence timestamp", "timestamp"),
            ):
                self._add_fact(section.body, label, values[key], status=_status(gui, values[key]))
            self._add_fact(section.body, "Physical cable tester", self.latest.physical_observation, status=gui.pres.STATUS_UNKNOWN)
            self._add_fact(section.body, "Physical source", "OPERATOR OBSERVATION", status=gui.pres.STATUS_UNKNOWN)
            self._add_fact(section.body, "Python verification", "NOT_VERIFIED", status=gui.pres.STATUS_WARNING)
            self._observer_evidence_section = section

        def _build_devices_page(self, parent):
            page = self._new_page(parent, "devices.title", "devices.subtitle")
            section = gui.Section(page, "CORE DEVICE EVIDENCE")
            section.pack(fill="x", padx=16, pady=(0, 16))
            values = evidence_values(self.latest)
            for label, key in (("Broker connection", "broker"), ("ESP32 reported presence", "device"), ("Uplink reported state", "uplink")):
                self._add_fact(section.body, label, values[key], status=_status(gui, values[key]))
            self._add_fact(section.body, "RSSI", "NOT_AVAILABLE", status=gui.pres.STATUS_WARNING)
            self._add_fact(section.body, "Heap", "NOT_AVAILABLE", status=gui.pres.STATUS_WARNING)

        def _build_lockdown_page(self, parent):
            page = self._new_page(parent, "lockdown.title", "lockdown.subtitle", badge=True)
            section = gui.Section(page, "CORE LOCKDOWN EVIDENCE")
            section.pack(fill="x", padx=16, pady=(0, 16))
            values = evidence_values(self.latest)
            for label, key in (("ARM/DISARM reported state", "armed"), ("Uplink reported state", "uplink"), ("Dispatch mode", "dispatch"), ("AUTO_CONTAIN reported mode", "auto_contain"), ("Evidence freshness", "freshness")):
                self._add_fact(section.body, label, values[key], status=_status(gui, values[key]))
            self._add_fact(section.body, "Operational controls", "NOT_AVAILABLE — observer mode", status=gui.pres.STATUS_WARNING)
            controls = gui.Section(page, "READ-ONLY CONTROL AVAILABILITY", accent=gui.COLOR_WARN_HL)
            controls.pack(fill="x", padx=16, pady=(0, 20))
            tk.Button(
                controls.body,
                text="CUT NETWORK — DISABLED",
                state=tk.DISABLED,
                font=gui.ui_theme.FONT_BTN,
                fg="white",
                bg=gui.ui_theme.COLOR_DANGER,
                disabledforeground=gui.ui_theme.COLOR_MUTED,
                bd=0,
                height=2,
            ).pack(fill="x", pady=(0, 6))
            self._add_fact(
                controls.body,
                "CUT reason",
                "DISABLED — no authorized Core-owned manual CUT request interface",
                status=gui.pres.STATUS_WARNING,
            )
            tk.Button(
                controls.body,
                text="RESTORE NETWORK — DISABLED",
                state=tk.DISABLED,
                font=gui.ui_theme.FONT_BTN,
                fg="white",
                bg=gui.ui_theme.COLOR_SUCCESS,
                disabledforeground=gui.ui_theme.COLOR_MUTED,
                bd=0,
                height=2,
            ).pack(fill="x", pady=(8, 6))
            self._add_fact(
                controls.body,
                "RESTORE reason",
                "DISABLED — owner-only D4 terminal Recovery; no live authorization",
                status=gui.pres.STATUS_WARNING,
            )

        def _build_unavailable_observer_page(self, parent, title_key, subtitle_key):
            page = self._new_page(parent, title_key, subtitle_key)
            section = gui.Section(page, "OBSERVER DATA AVAILABILITY")
            section.pack(fill="x", padx=16, pady=(0, 16))
            self._add_fact(section.body, "Panel evidence", "NOT_AVAILABLE", status=gui.pres.STATUS_WARNING)
            self._add_fact(section.body, "Operational actions", "DISABLED — observer mode", status=gui.pres.STATUS_WARNING)

        def _build_incidents_page(self, parent):
            self._build_unavailable_observer_page(parent, "incidents.title", "incidents.subtitle")

        def _build_recovery_page(self, parent):
            page = self._new_page(parent, "recovery.page_title", "recovery.page_subtitle")
            section = gui.Section(page, "RECOVERY READINESS — READ ONLY", accent=gui.COLOR_WARN_HL)
            section.pack(fill="x", padx=16, pady=(0, 16))
            self._add_fact(section.body, "Recovery readiness", "BLOCKED", status=gui.pres.STATUS_WARNING)
            self._add_fact(section.body, "Blocking condition", "D4 owner-only terminal Recovery; no live authorization", status=gui.pres.STATUS_WARNING)
            self._add_fact(section.body, "RESTORE NETWORK", "DISABLED — observer mode", status=gui.pres.STATUS_WARNING)
            self._add_fact(section.body, "Attempt state", "NOT_CONSUMED — no attempt started by this observer", status=gui.pres.STATUS_UNKNOWN)
            gui.make_hint(section.body, "This page never stores D4 secrets, invokes Recovery, or creates a second authority path.").pack(anchor="w", pady=(8, 0))

        def _build_audit_page(self, parent):
            self._build_unavailable_observer_page(parent, "audit.title", "audit.subtitle")

        def _build_diagnostics_page(self, parent):
            page = self._new_page(parent, "diagnostics.title", "diagnostics.subtitle")
            section = gui.Section(page, "LIVE CORE EVIDENCE")
            section.pack(fill="x", padx=16, pady=(0, 16))
            values = evidence_values(self.latest)
            for label, key in (("Runtime state", "runtime"), ("Profile", "profile"), ("Dry-run", "dry_run"), ("AUTO_CONTAIN reported mode", "auto_contain"), ("Trusted time", "trusted_time"), ("Evidence freshness", "freshness"), ("Evidence timestamp", "timestamp")):
                self._add_fact(section.body, label, values[key], status=_status(gui, values[key]))
            self._add_fact(section.body, "Database / audit history", "NOT_AVAILABLE", status=gui.pres.STATUS_WARNING)

        def _sync_arm_controls(self):
            return None

    return LivePurpleObserverGUI


def create_live_app(root, *, status_path=reader.STATUS_PATH, max_age_seconds=reader.DEFAULT_MAX_AGE_SECONDS):
    if any(name == "aegis_soc" or name.startswith("aegis_soc.") for name in sys.modules):
        raise RuntimeError("live observer must start without an imported aegis_soc package")
    sys.path.insert(0, str(PYTHONUI_ROOT))
    _install_import_isolation()
    _install_database_isolation()
    from aegis_soc import gui

    if not str(Path(gui.__file__).resolve()).startswith(str(PYTHONUI_ROOT)):
        raise RuntimeError(f"wrong purple GUI source loaded: {gui.__file__}")
    app_class = _live_gui_class(gui)
    mqtt = LiveMQTT()
    controller = LiveController()
    app = app_class(
        root,
        mqtt,
        controller,
        status_path=Path(status_path),
        max_age_seconds=max_age_seconds,
    )
    return app, SimpleNamespace(mqtt=mqtt, controller=controller)


def main():
    root = tk.Tk()
    app, _isolation = create_live_app(root)
    root.mainloop()
    return app


if __name__ == "__main__":
    main()
