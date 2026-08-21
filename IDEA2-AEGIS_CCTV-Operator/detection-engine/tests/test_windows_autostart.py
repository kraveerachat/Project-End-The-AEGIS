from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WINDOWS = ROOT / "windows"


class WindowsAutostartContractTests(unittest.TestCase):
    def read_script(self, name: str) -> str:
        return (WINDOWS / name).read_text(encoding="utf-8")

    def test_expected_scripts_exist(self) -> None:
        for name in (
            "install_autostart.ps1",
            "run_detection_engine.ps1",
            "run_reverse_tunnel.ps1",
            "status_autostart.ps1",
            "uninstall_autostart.ps1",
        ):
            self.assertTrue((WINDOWS / name).is_file(), name)

    def test_installer_uses_interactive_logon_not_session_zero(self) -> None:
        script = self.read_script("install_autostart.ps1")
        self.assertIn("New-ScheduledTaskTrigger -AtLogOn", script)
        self.assertIn("-LogonType Interactive", script)
        self.assertIn("-RunLevel Limited", script)
        self.assertNotRegex(script, re.compile(r"-AtStartup\b", re.IGNORECASE))
        self.assertNotRegex(script, re.compile(r"-UserId\s+['\"]?SYSTEM", re.IGNORECASE))

    def test_installer_preflights_without_opening_camera(self) -> None:
        script = self.read_script("install_autostart.ps1")
        self.assertIn("EngineConfig.from_env().validate()", script)
        self.assertIn("from aegis_engine.engine import DetectionEngine", script)
        self.assertNotIn("DetectionEngine()", script)
        self.assertIn("SupportsShouldProcess = $true", script)

    def test_task_has_restart_and_single_instance_guards(self) -> None:
        script = self.read_script("install_autostart.ps1")
        self.assertIn("-RestartCount 10", script)
        self.assertIn("-RestartInterval", script)
        self.assertIn("-MultipleInstances IgnoreNew", script)
        self.assertIn("-WindowStyle Hidden", script)

    def test_installer_keeps_tunnel_optional_and_current_user_scoped(self) -> None:
        script = self.read_script("install_autostart.ps1")
        self.assertIn("[string]$TunnelHost = ''", script)
        self.assertIn("[string]$IdentityFile = ''", script)
        self.assertIn("$null -ne $tunnelTask", script)
        self.assertIn("-Principal $principal", script)
        self.assertNotIn("New-ScheduledTaskPrincipal -UserId 'SYSTEM'", script)

    def test_tunnel_is_fail_fast_reverse_only_and_has_keepalives(self) -> None:
        script = self.read_script("run_reverse_tunnel.ps1")
        for expected in (
            "BatchMode=yes",
            "ExitOnForwardFailure=yes",
            "ServerAliveInterval=30",
            "ServerAliveCountMax=3",
            "IdentitiesOnly=yes",
            "'-R'",
            "Start-Process -FilePath $resolvedSsh",
            "-WindowStyle Hidden -PassThru -Wait",
            "exit $tunnelExitCode",
        ):
            self.assertIn(expected, script)
        self.assertNotIn("'-L'", script)
        self.assertNotIn("Password", script)

    def test_tunnel_parameters_are_validated_not_hardcoded_as_credentials(self) -> None:
        installer = self.read_script("install_autostart.ps1")
        runner = self.read_script("run_reverse_tunnel.ps1")
        self.assertIn("TunnelHost must use user@host", installer)
        self.assertIn("IdentityFile is required", installer)
        self.assertIn("[Net.IPAddress]::TryParse", runner)
        self.assertNotIn("pubpup2006p@", runner)
        self.assertNotIn("id_ed25519_pubpup2006p", runner)

    def test_runner_uses_engine_working_directory_and_external_logs(self) -> None:
        script = self.read_script("run_detection_engine.ps1")
        self.assertIn("Set-Location -LiteralPath $resolvedEngineRoot", script)
        self.assertIn("GetFolderPath('LocalApplicationData')", script)
        self.assertIn("Start-Process -FilePath $resolvedPython", script)
        self.assertIn("-RedirectStandardOutput $stdoutLog", script)
        self.assertIn("-RedirectStandardError $stderrLog", script)
        self.assertIn("-NoNewWindow -PassThru -Wait", script)
        self.assertIn("exit $engineExitCode", script)

    def test_runner_does_not_treat_python_logging_as_a_startup_failure(self) -> None:
        script = self.read_script("run_detection_engine.ps1")
        self.assertNotIn("& $resolvedPython", script)
        self.assertNotIn("2>&1", script)
        self.assertNotIn("*>>", script)

    def test_scripts_contain_no_database_or_hardcoded_secret_contract(self) -> None:
        combined = "\n".join(
            path.read_text(encoding="utf-8") for path in WINDOWS.glob("*.ps1")
        )
        for forbidden in (
            "DATABASE_URL",
            "POSTGRES_PASSWORD",
            "TELEGRAM_BOT_TOKEN=",
            "DETECTION_ENGINE_API_KEY=",
            "TELEGRAM_CHAT_ID=",
        ):
            self.assertNotIn(forbidden, combined)


if __name__ == "__main__":
    unittest.main()
