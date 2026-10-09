"""Human-facing preview for the existing uncommitted PYTHONUI Dashboard.

The source package is loaded directly from the dirty PYTHONUI worktree. This
module does not copy, patch, or otherwise modify that source. The preview
provides only temporary storage and fail-closed fakes for runtime dependencies.
"""

from __future__ import annotations

import os
import sys
import tempfile
import tkinter as tk
from pathlib import Path
from types import ModuleType, SimpleNamespace


PYTHONUI_ROOT = os.environ.get(
    "AEGIS_PYTHONUI_SOURCE",
    str(Path(__file__).resolve().parent / "purple_ui_source"),
)
PYTHONUI_ROOT = str(Path(PYTHONUI_ROOT).resolve())
PREVIEW_TITLE = "AEGIS IDEA3 — OFFLINE PURPLE DESKTOP PREVIEW — SYNTHETIC DATA"
PREVIEW_ADMIN_ID = "preview-admin"
PREVIEW_ADMIN_PIN = "preview-only-pin"


def _prepare_environment(data_dir: Path) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    os.environ.pop("CREDENTIALS_DIRECTORY", None)
    os.environ["AEGIS_PROFILE"] = "offline-purple-preview"
    os.environ["AEGIS_DATA_DIR"] = str(data_dir)
    os.environ["AEGIS_DB_PATH"] = str(data_dir / "preview.sqlite3")
    os.environ["AEGIS_LOG_PATH"] = str(data_dir / "preview.log")
    os.environ["AEGIS_DRY_RUN"] = "true"
    os.environ["AEGIS_AUTO_CONTAIN"] = "false"
    os.environ["AEGIS_UI_THEME"] = "dark"
    os.environ["AEGIS_ADMIN_ID"] = PREVIEW_ADMIN_ID
    os.environ["AEGIS_ADMIN_PIN"] = PREVIEW_ADMIN_PIN
    os.environ["AEGIS_MQTT_USER"] = ""
    os.environ["AEGIS_MQTT_PASS"] = ""
    os.environ["AEGIS_TG_TOKEN"] = ""
    os.environ["AEGIS_TG_CHAT"] = ""


class PreviewMQTT:
    """Only the read-only liveness accessor used by the real Dashboard."""

    def __init__(self) -> None:
        self.start_calls = 0
        self.stop_calls = 0
        self.connect_calls = 0
        self.publish_calls = 0
        self.last_attacker_ip = None
        self.protocol = None

    def seconds_since_device(self):
        return 2.0

    def start(self):
        self.start_calls += 1
        raise AssertionError("offline preview attempted MQTT startup")

    def connect(self, *args, **kwargs):
        self.connect_calls += 1
        raise AssertionError("offline preview attempted an MQTT connection")

    def publish(self, *args, **kwargs):
        self.publish_calls += 1
        raise AssertionError("offline preview attempted MQTT publication")

    def stop(self):
        self.stop_calls += 1


class PreviewController:
    """Fail-closed command boundary for the visual-only process."""

    def __init__(self) -> None:
        self.issue_calls = 0

    def issue(self, *args, **kwargs):
        self.issue_calls += 1
        raise AssertionError("offline preview attempted a control-plane command")


def _install_import_isolation() -> None:
    """Satisfy gui.py's class imports without importing transport modules."""

    mqtt_module = ModuleType("aegis_soc.mqtt_client")
    mqtt_module.MQTTManager = PreviewMQTT
    controller_module = ModuleType("aegis_soc.controller")
    controller_module.AegisCommandController = PreviewController
    sys.modules["aegis_soc.mqtt_client"] = mqtt_module
    sys.modules["aegis_soc.controller"] = controller_module


def _preview_gui_class(gui):
    class OfflinePurplePreviewGUI(gui.AegisAdminGUI):
        synthetic_preview = True

        def _start_background_heartbeat(self):
            self._preview_heartbeat_workers = 0

        def _tick_monitors(self):
            self._preview_monitor_polls = 0

        def _disable_operational_controls(self):
            def walk(widget):
                for child in widget.winfo_children():
                    if child.winfo_exists():
                        # Logout is the one session control intentionally
                        # retained so the complete Login -> Dashboard ->
                        # Logout -> Login preview flow remains exercisable.
                        is_logout = isinstance(child, tk.Button) and child.cget("text") in {
                            "Logout",
                            "ออกจากระบบ",
                            "退出登录",
                        }
                        if isinstance(child, tk.Button) and not is_logout:
                            child.configure(state="disabled", command=lambda: None)
                        walk(child)

            walk(self.root)

        def _show_page(self, key):
            super()._show_page(key)
            self._disable_operational_controls()

        def _on_authenticated(self):
            super()._on_authenticated()
            self.root.title(PREVIEW_TITLE)

        # These overrides protect direct callback invocation as well as the
        # disabled visual controls. None reaches the injected controller or
        # any system/hardware boundary.
        def on_cut_clicked(self):
            self._preview_control_attempt = True

        def on_restore_clicked(self):
            self._preview_control_attempt = True

        def toggle_arm(self):
            self._preview_control_attempt = True

        def open_recovery_wizard(self):
            self._preview_control_attempt = True

        def send_command(self, *args, **kwargs):
            self._preview_control_attempt = True

        def run_ufw_async(self, *args, **kwargs):
            self._preview_control_attempt = True

        def export_audit_log(self):
            self._preview_control_attempt = True

        def verify_log_integrity(self):
            self._preview_control_attempt = True

    return OfflinePurplePreviewGUI


def create_preview_app(root, *, data_dir: Path):
    """Construct the actual dirty-PYTHONUI Dashboard with isolated fakes."""

    _prepare_environment(Path(data_dir))
    if any(name == "aegis_soc" or name.startswith("aegis_soc.") for name in sys.modules):
        raise RuntimeError("preview must start in a process without an already-imported aegis_soc package")
    sys.path.insert(0, PYTHONUI_ROOT)

    # Import only after the environment is sealed and the dirty source root is
    # first on sys.path. This is the actual PYTHONUI package, not a copy.
    _install_import_isolation()
    from aegis_soc import database as db
    from aegis_soc import gui

    if not str(Path(gui.__file__).resolve()).startswith(PYTHONUI_ROOT):
        raise RuntimeError(f"wrong Dashboard source loaded: {gui.__file__}")
    if gui.MQTTManager is not PreviewMQTT or gui.AegisCommandController is not PreviewController:
        raise RuntimeError("preview control-plane imports were not isolated")

    db.init_db()
    preview_mqtt = PreviewMQTT()
    preview_controller = PreviewController()
    preview_class = _preview_gui_class(gui)
    app = preview_class(root, preview_mqtt, command_controller=preview_controller)

    # Keep the real LoginView and LoginFlow. Only its verifier is replaced by
    # a temporary, process-local fixture; no production PIN or credential
    # file is read, and the operator must submit these preview credentials.
    app.login_view.flow.credential_verifier = (
        lambda admin_id, pin: admin_id == PREVIEW_ADMIN_ID and pin == PREVIEW_ADMIN_PIN
    )
    app._broker_connected = True
    app._last_uplink_state = "LOCKDOWN"
    app._last_rssi = -58
    app._last_heap = 123456
    app.root.title(PREVIEW_TITLE)

    return app, SimpleNamespace(
        mqtt=preview_mqtt,
        controller=preview_controller,
        heartbeat_workers=getattr(app, "_preview_heartbeat_workers", 0),
        monitor_polls=getattr(app, "_preview_monitor_polls", 0),
        hardware_actions=0,
    )


def main() -> None:
    import tkinter as tk

    with tempfile.TemporaryDirectory(prefix="aegis-purple-desktop-preview-") as data_dir:
        root = tk.Tk()
        app, _fakes = create_preview_app(root, data_dir=Path(data_dir))
        root.mainloop()
        _ = app


if __name__ == "__main__":
    main()
