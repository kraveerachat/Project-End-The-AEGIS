from __future__ import annotations

import re
import unittest
from pathlib import Path


ENGINE_ROOT = Path(__file__).resolve().parents[1]
WINDOWS_ROOT = ENGINE_ROOT / "windows"


class WindowsAutostartSourceTests(unittest.TestCase):
    def read(self, name: str) -> str:
        return (WINDOWS_ROOT / name).read_text(encoding="utf-8")

    def test_complete_operator_script_set_is_present(self) -> None:
        expected = {
            "install_autostart.ps1",
            "repair_autostart.ps1",
            "run_detection_engine.ps1",
            "run_detection_tunnel.ps1",
            "run_engine_supervisor.ps1",
            "status_autostart.ps1",
            "uninstall_autostart.ps1",
        }
        self.assertTrue(expected.issubset({path.name for path in WINDOWS_ROOT.glob("*.ps1")}))

    def test_scripts_do_not_hardcode_the_verified_operator_profile(self) -> None:
        joined = "\n".join(path.read_text(encoding="utf-8") for path in WINDOWS_ROOT.rglob("*.*"))
        self.assertNotIn(r"C:\Users\puppu", joined)
        self.assertNotIn(r"OneDrive\Desktop\AEGIS_System", joined)

    def test_installer_uses_runtime_local_python_and_excludes_local_artifacts(self) -> None:
        installer = self.read("install_autostart.ps1")
        self.assertIn("'AEGIS\\DetectionEngine'", installer)
        self.assertIn("$runtimeVenv = Join-Path $resolvedRuntimeRoot '.venv'", installer)
        self.assertIn("$runtimePython = Join-Path $runtimeVenv 'Scripts\\python.exe'", installer)
        for excluded in ("'.env'", "'segments'", "'snapshots'", "'__pycache__'"):
            self.assertIn(excluded, installer)

    def test_engine_uses_hkcu_supervisor_not_interactive_task(self) -> None:
        installer = self.read("install_autostart.ps1")
        supervisor = self.read("run_engine_supervisor.ps1")
        self.assertIn("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", installer)
        self.assertIn("Disable-ScheduledTask", installer)
        self.assertNotIn("New-ScheduledTaskTrigger -AtLogOn", installer)
        self.assertIn("while ($true)", supervisor)
        self.assertIn("Detection Engine child exited", supervisor)
        self.assertIn("Local\\AEGISDetectionEngineSupervisor", supervisor)

    def test_tunnel_is_system_startup_with_strict_two_way_forwarding(self) -> None:
        installer = self.read("install_autostart.ps1")
        tunnel = self.read("run_detection_tunnel.ps1")
        self.assertIn("New-ScheduledTaskTrigger -AtStartup", installer)
        self.assertRegex(installer, r"-UserId\s+'SYSTEM'")
        self.assertIn("-LogonType ServiceAccount", installer)
        self.assertIn("'StrictHostKeyChecking=yes'", tunnel)
        self.assertIn("UserKnownHostsFile=", tunnel)
        self.assertIn("'-L', $localForward", tunnel)
        self.assertIn("'-R', $reverseForward", tunnel)
        self.assertIn("while ($true)", tunnel)
        self.assertNotIn("StrictHostKeyChecking=no", tunnel)

    def test_installer_requires_machine_configuration_and_key_material(self) -> None:
        installer = self.read("install_autostart.ps1")
        for key in (
            "AEGIS_MONITOR_API_BASE",
            "AEGIS_DETECTION_ENGINE_API_KEY",
            "AEGIS_STREAM_PUBLIC_URL",
        ):
            self.assertIn(key, installer)
        self.assertIn("unique per-machine -IdentityFile", installer)
        self.assertIn("verified -KnownHostsFile", installer)
        self.assertIn("'*S-1-5-18:(F)'", installer)

    def test_no_private_key_payload_is_present_under_windows_source(self) -> None:
        private_key_marker = re.compile(r"BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY")
        for path in WINDOWS_ROOT.rglob("*"):
            if path.is_file():
                self.assertIsNone(private_key_marker.search(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
