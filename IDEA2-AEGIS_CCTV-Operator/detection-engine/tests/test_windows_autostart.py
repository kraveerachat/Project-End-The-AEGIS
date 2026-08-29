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
            "prepare_tunnel_key.ps1",
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
        self.assertIn("[string]$IdentityFile", installer)
        self.assertIn("SOURCE_KEY_MISSING", self.read("prepare_tunnel_key.ps1"))
        self.assertIn("verified -KnownHostsFile", installer)
        helper = self.read("prepare_tunnel_key.ps1")
        self.assertIn("S-1-5-18", helper)

    def test_installer_can_repair_an_existing_runtime_in_place(self) -> None:
        installer = self.read("install_autostart.ps1")
        self.assertIn("function Copy-MachineFile", installer)
        self.assertIn("[StringComparison]::OrdinalIgnoreCase", installer)
        self.assertIn("$runtimeItem = Join-Path $runtimeApp $item.Name", installer)
        self.assertIn("Resolve-SystemFilePath", installer)
        self.assertNotIn("Copy-MachineFile -Source $resolvedIdentitySource", installer)
        self.assertLess(
            installer.index("Invoke-SystemKeyPreparation"),
            installer.index("Register-ScheduledTask -TaskName $TunnelTaskName"),
        )

    def test_legacy_migration_selects_only_the_verified_key_name(self) -> None:
        installer = self.read("install_autostart.ps1")
        self.assertIn("idea2_tunnel_autostart_ed25519", installer)
        selection = installer.split("$previousSettings = $null", 1)[1].split(
            "if ($TunnelHost -notmatch", 1
        )[0]
        self.assertIn("$runtimeIdentity = $legacyRuntimeIdentity", selection)
        self.assertNotIn("Get-ChildItem", selection)
        self.assertNotIn("idea2_tunnel_ed25519' -or", selection)

    def test_private_key_is_never_read_or_copied_by_administrator_installer(self) -> None:
        installer = self.read("install_autostart.ps1")
        resolver = installer.split("function Resolve-SystemFilePath", 1)[1].split(
            "function Invoke-SystemKeyPreparation", 1
        )[0]
        self.assertNotIn("Test-Path", resolver)
        self.assertNotIn("Get-Content", resolver)
        self.assertNotIn("Copy-Item", resolver)
        self.assertNotIn("Get-Acl", installer)
        self.assertNotIn("Set-Acl", installer)

    def test_private_key_acl_is_exact_system_only(self) -> None:
        helper = self.read("prepare_tunnel_key.ps1")
        acl = helper.split("function Assert-SystemOnlyPrivateKeyAcl", 1)[1].split(
            "function Set-SystemOnlyPrivateKeyAcl", 1
        )[0]
        self.assertIn("S-1-5-18", acl)
        self.assertIn("GetOwner", acl)
        self.assertIn("AreAccessRulesProtected", acl)
        self.assertIn("FileSystemRights]::FullControl", acl)
        self.assertIn("$rules.Count -ne 1", acl)
        self.assertIn("KEY_ACL_HAS_DISALLOWED_IDENTITY", acl)

        mutation = helper.split("function Set-SystemOnlyPrivateKeyAcl", 1)[1].split(
            "function Update-SshErrorFlags", 1
        )[0]
        self.assertIn("SetAccessRuleProtection($true, $false)", mutation)
        self.assertIn("RemoveAccessRuleSpecific", mutation)
        self.assertIn("Assert-SystemOnlyPrivateKeyAcl -Path $Path", mutation)
        self.assertNotIn("S-1-5-32-544", helper)

    def test_system_helper_copies_hardens_then_proves_real_ssh_forward(self) -> None:
        installer = self.read("install_autostart.ps1")
        helper = self.read("prepare_tunnel_key.ps1")
        self.assertIn("HELPER_NOT_RUNNING_AS_SYSTEM", helper)
        self.assertLess(helper.index("Copy-Item -LiteralPath $sourcePath"), helper.index("Set-SystemOnlyPrivateKeyAcl -Path $preparedIdentity"))
        self.assertLess(helper.index("Set-SystemOnlyPrivateKeyAcl -Path $preparedIdentity"), helper.index("Start-Process -FilePath $SshPath"))
        self.assertIn("'BatchMode=yes'", helper)
        self.assertIn("'IdentitiesOnly=yes'", helper)
        self.assertIn("'StrictHostKeyChecking=yes'", helper)
        self.assertIn("Invoke-RestMethod", helper)
        self.assertIn("/healthz", helper)
        self.assertIn("$result.localForwardListening = $true", helper)
        self.assertIn("$result.sshAuthenticated = $true", helper)
        self.assertIn(".pending-", helper)
        self.assertLess(helper.index("$result.sshAuthenticated = $true"), helper.index("Move-Item -LiteralPath $pendingIdentity"))
        self.assertNotIn("StrictHostKeyChecking=no", helper)

        invoke = installer.split("function Invoke-SystemKeyPreparation", 1)[1].split(
            "function Get-DotEnvKeys", 1
        )[0]
        self.assertRegex(invoke, r"-UserId\s+'SYSTEM'")
        self.assertIn("finally", invoke)
        self.assertIn("Unregister-ScheduledTask", invoke)

    def test_persistent_tunnel_registration_waits_for_system_verification(self) -> None:
        installer = self.read("install_autostart.ps1")
        verification = "Invoke-SystemKeyPreparation `"
        registration = "Register-ScheduledTask -TaskName $TunnelTaskName"
        self.assertLess(installer.rindex(verification), installer.index(registration))
        for required in (
            "$helperResult.keyAclSystemOnly -ne $true",
            "$helperResult.sshAuthenticated -ne $true",
            "$helperResult.localForwardListening -ne $true",
            "$helperResult.monitorHealth -ne $true",
        ):
            self.assertIn(required, installer)

    def test_repair_routes_through_the_hardened_installer(self) -> None:
        repair = self.read("repair_autostart.ps1")
        self.assertIn("install_autostart.ps1", repair)
        self.assertIn("& $installer @arguments", repair)
        self.assertIn("KeyMigrationTaskName", repair)
        self.assertNotIn("IdentityFile", repair)
        self.assertNotIn("Copy-Item", repair)

        installer = self.read("install_autostart.ps1")
        for preserved in ("'.env'", "'.venv'", "'segments'", "'snapshots'"):
            self.assertIn(preserved, installer)
        self.assertNotIn("'models'", installer.split("$excludedNames =", 1)[1].split(")", 1)[0])

    def test_uninstall_removes_stale_helper_registration_but_preserves_runtime(self) -> None:
        uninstall = self.read("uninstall_autostart.ps1")
        self.assertIn("AEGIS Detection Key Migration", uninstall)
        self.assertIn("Unregister-ScheduledTask -TaskName $KeyMigrationTaskName", uninstall)
        self.assertIn("Runtime app, .env, per-machine SSH material", uninstall)
        self.assertNotIn("Remove-Item -LiteralPath $RuntimeRoot", uninstall)

    def test_status_reports_acl_task_process_ports_health_and_ssh_errors(self) -> None:
        status = self.read("status_autostart.ps1")
        for field in (
            "PrivateKeyExists",
            "PrivateKeyOwnerIsSystem",
            "PrivateKeyInheritanceDisabled",
            "PrivateKeySystemFullControl",
            "PrivateKeyNoDisallowedIdentities",
            "PrivateKeyAclValid",
            "TunnelTaskPrincipalIsSystem",
            "TunnelTaskTriggerIsAtStartup",
            "TunnelSupervisorRunning",
            "UNPROTECTED_PRIVATE_KEY",
            "BAD_PERMISSIONS",
            "PUBLICKEY_DENIED",
            "EnginePortListening",
            "MonitorForwardListening",
        ):
            self.assertIn(field, status)
        self.assertIn("RequiresElevation", status)
        self.assertIn("UNPROTECTED PRIVATE KEY FILE", status)
        self.assertIn("Permission denied \\(publickey\\)", status)

    def test_tunnel_runner_stops_retrying_on_fatal_key_configuration(self) -> None:
        tunnel = self.read("run_detection_tunnel.ps1")
        self.assertIn("[string]$RuntimeRoot", tunnel)
        self.assertIn("FATAL_CONFIG", tunnel)
        self.assertIn("UNPROTECTED_PRIVATE_KEY", tunnel)
        self.assertIn("BAD_PERMISSIONS", tunnel)
        self.assertIn("PUBLICKEY_DENIED", tunnel)
        self.assertIn("exit 78", tunnel)

    def test_install_receipt_contains_no_secret_values(self) -> None:
        installer = self.read("install_autostart.ps1")
        settings_block = installer.split("$settings = [ordered]@{", 1)[1].split(
            "$settings | ConvertTo-Json", 1
        )[0]
        self.assertNotIn("detection_engine_api_key", settings_block.lower())
        self.assertNotIn("telegram", settings_block.lower())
        self.assertNotIn("IdentityFile =", settings_block)
        self.assertIn("identityFileName", settings_block)
        self.assertIn("installerVersion", settings_block)
        self.assertIn("startuptype", settings_block.lower())

    def test_no_private_key_payload_is_present_under_windows_source(self) -> None:
        private_key_marker = re.compile(r"BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY")
        for path in WINDOWS_ROOT.rglob("*"):
            if path.is_file():
                self.assertIsNone(private_key_marker.search(path.read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
