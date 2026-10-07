from __future__ import annotations

import re
import unittest
from pathlib import Path


ENGINE_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ENGINE_ROOT / "windows" / "preflight_target_node.ps1"


class WindowsMultiNodePreflightTests(unittest.TestCase):
    def source(self) -> str:
        self.assertTrue(SCRIPT.is_file(), "target-node preflight script must exist")
        return SCRIPT.read_text(encoding="utf-8")

    def test_preflight_is_local_read_only_and_does_not_open_camera(self) -> None:
        source = self.source()

        for marker in (
            "ServerContact = 'NO'",
            "ProductionMutation = 'NO'",
            "TwingateMutation = 'NO'",
            "CameraOpen = 'NO'",
            "CameraConfigWrite = 'NO'",
            "ConfigWrite = 'NO'",
            "PrivateKeyRead = 'NO'",
            "MN_P1_TARGET_PREFLIGHT_COMPLETE=YES",
        ):
            self.assertIn(marker, source)

        forbidden = (
            "Invoke-RestMethod",
            "Invoke-WebRequest",
            "Test-NetConnection",
            "Resolve-DnsName",
            "Start-Service",
            "Stop-Service",
            "Set-Service",
            "Register-ScheduledTask",
            "Unregister-ScheduledTask",
            "Set-ItemProperty",
            "New-ItemProperty",
            "Set-Content",
            "Add-Content",
            "Out-File",
            "setup_camera.py",
            "VideoCapture",
            "provision_identity_key.ps1",
            "prepare_tunnel_key.ps1",
        )
        for token in forbidden:
            self.assertNotIn(token, source)

    def test_preflight_collects_required_windows_target_facts(self) -> None:
        source = self.source()

        for token in (
            "Win32_OperatingSystem",
            "Win32_ComputerSystem",
            "Win32_Processor",
            "Win32_VideoController",
            "Win32_PnPEntity",
            "PNPClass -eq 'Camera'",
            "ffmpeg.exe",
            "libx264",
            "ssh.exe",
            "AEGISIdentityAgent",
            "AEGIS Detection Tunnel",
            "AEGIS Detection Engine",
            "8077",
            "8078",
            "18002",
            "Python312Available",
            "Python314Available",
        ):
            self.assertIn(token, source)

    def test_preflight_has_no_machine_a_or_deployment_specific_constants(self) -> None:
        source = self.source()

        for forbidden in (
            r"C:\Users\puppu",
            "NARUEBET",
            "machine-a-node",
            "physical-camera-a",
            "192.168.",
            "172.18.",
            "aegis-stream-host.internal",
        ):
            self.assertNotIn(forbidden, source)

        self.assertIsNone(
            re.search(r"BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY", source)
        )

    def test_ssh_version_probe_is_safe_under_windows_powershell_51(self) -> None:
        source = self.source()

        self.assertIn("Diagnostics.ProcessStartInfo", source)
        self.assertIn("RedirectStandardOutput = $true", source)
        self.assertIn("RedirectStandardError = $true", source)
        self.assertIn("$process.StandardError.ReadToEnd()", source)
        self.assertNotIn("& $sshPath -V 2>&1", source)


if __name__ == "__main__":
    unittest.main()
