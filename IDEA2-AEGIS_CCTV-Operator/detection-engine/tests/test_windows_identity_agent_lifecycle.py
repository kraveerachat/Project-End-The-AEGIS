from __future__ import annotations

import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ENGINE_ROOT = Path(__file__).resolve().parents[1]
WINDOWS_ROOT = ENGINE_ROOT / "windows"
AGENT_ROOT = WINDOWS_ROOT / "identity-agent"


class WindowsIdentityAgentLifecycleTests(unittest.TestCase):
    def read_agent(self, name: str) -> str:
        return (AGENT_ROOT / name).read_text(encoding="utf-8")

    def read_windows(self, name: str) -> str:
        return (WINDOWS_ROOT / name).read_text(encoding="utf-8")

    def test_complete_identity_agent_operator_toolset_exists(self) -> None:
        expected = {
            "identity_agent_safety.ps1",
            "get_identity_agent_source_hash.ps1",
            "install_identity_agent.ps1",
            "status_identity_agent.ps1",
            "repair_identity_agent.ps1",
            "uninstall_identity_agent.ps1",
            "verify_machine_a_no_powershell.ps1",
            "invoke_dpapi_preflight.ps1",
            "invoke_acl_validation.ps1",
            "provision_identity_key.ps1",
            "README.md",
        }
        self.assertTrue(expected.issubset({path.name for path in AGENT_ROOT.iterdir()}))

    def test_mutating_lifecycle_scripts_share_fail_closed_path_and_marker_guards(self) -> None:
        safety = self.read_agent("identity_agent_safety.ps1")
        for required in (
            "Assert-IdentityAgentServiceName",
            "Assert-IdentityAgentManagedRoots",
            "Assert-IdentityAgentInstallationMarker",
            "GetFullPath",
            "GetPathRoot",
            "ReparsePoint",
            "install.json",
            "evidenceRoot",
            "sourceRoot",
            "paths overlap",
        ):
            self.assertIn(required, safety)
        for script_name in (
            "install_identity_agent.ps1",
            "repair_identity_agent.ps1",
            "uninstall_identity_agent.ps1",
            "invoke_dpapi_preflight.ps1",
            "provision_identity_key.ps1",
        ):
            script = self.read_agent(script_name)
            self.assertIn("identity_agent_safety.ps1", script)
            self.assertIn("Assert-IdentityAgentManagedRoots", script)
            self.assertIn("Assert-IdentityAgentInstallationMarker", script)
        uninstall = self.read_agent("uninstall_identity_agent.ps1")
        self.assertIn("Assert-IdentityAgentServiceName", uninstall)
        self.assertIn("Assert-IdentityAgentInstallationMarker", uninstall)
        self.assertLess(
            uninstall.index("Assert-IdentityAgentInstallationMarker"),
            uninstall.index("sc.exe delete"),
        )
        self.assertLess(
            uninstall.index("Assert-IdentityAgentInstallationMarker"),
            uninstall.index("takeown.exe"),
        )

    def test_path_guard_rejects_broad_overlap_reparse_and_unbound_marker(self) -> None:
        helper = (AGENT_ROOT / "identity_agent_safety.ps1").resolve()
        with tempfile.TemporaryDirectory(prefix="aegis-task12-path-safety-") as raw_root:
            root = Path(raw_root).resolve()
            script = f"""
            $ErrorActionPreference = 'Stop'
            . '{helper}'
            function Expect-Rejection([scriptblock]$Case, [string]$Name) {{
                try {{ & $Case | Out-Null; throw "UNSAFE_CASE_ACCEPTED:$Name" }}
                catch {{
                    if ($_.Exception.Message -like 'UNSAFE_CASE_ACCEPTED:*') {{ throw }}
                    "REJECTED=$Name"
                }}
            }}
            $base = '{root}'
            $install = Join-Path $base 'install'
            $data = Join-Path $base 'data'
            $config = Join-Path $base 'config'
            $evidence = Join-Path $base 'evidence'
            Expect-Rejection {{
                Assert-IdentityAgentManagedRoots -InstallRoot ([IO.Path]::GetPathRoot($base)) `
                    -DataRoot $data -ConfigurationRoot $config -EvidenceRoot $evidence
            }} 'BROAD'
            Expect-Rejection {{
                Assert-IdentityAgentManagedRoots -InstallRoot $install `
                    -DataRoot (Join-Path $install 'nested') -ConfigurationRoot $config `
                    -EvidenceRoot $evidence -AllowDisposableTestRoot -DisposableTestRoot $base
            }} 'OVERLAP'
            New-Item -ItemType Directory -Path (Join-Path $base 'target'), $data, $config, $evidence | Out-Null
            New-Item -ItemType Junction -Path $install -Target (Join-Path $base 'target') | Out-Null
            Expect-Rejection {{
                Assert-IdentityAgentManagedRoots -InstallRoot $install -DataRoot $data `
                    -ConfigurationRoot $config -EvidenceRoot $evidence `
                    -AllowDisposableTestRoot -DisposableTestRoot $base
            }} 'REPARSE'
            Remove-Item -LiteralPath $install -Force
            New-Item -ItemType Directory -Path $install | Out-Null
            @{{
                schemaVersion = 1
                serviceName = 'AEGISIdentityAgent'
                installRoot = $install
                dataRoot = (Join-Path $base 'wrong-data')
                configurationRoot = $config
                evidenceRoot = $evidence
            }} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $config 'install.json')
            Expect-Rejection {{
                Assert-IdentityAgentInstallationMarker -ConfigurationRoot $config `
                    -InstallRoot $install -DataRoot $data -EvidenceRoot $evidence
            }} 'UNBOUND_MARKER'
            "PATH_SAFETY_TEST=PASS"
            """
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        for expected in (
            "REJECTED=BROAD",
            "REJECTED=OVERLAP",
            "REJECTED=REPARSE",
            "REJECTED=UNBOUND_MARKER",
            "PATH_SAFETY_TEST=PASS",
        ):
            self.assertIn(expected, result.stdout)

    def test_existing_data_root_requires_bound_marker_and_exact_directory_acl(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        status = self.read_agent("status_identity_agent.ps1")
        existing_block = install[install.index("if ($dataRootExisted)") :]
        self.assertIn("Assert-IdentityAgentInstallationMarker", existing_block)
        self.assertIn("invoke_acl_validation.ps1", existing_block)
        self.assertNotIn("Test-IdentityAgentProtectedAcl -Path $DataRoot", install)
        self.assertIn("IDENTITY_DATA_ROOT_ACL", status)
        self.assertIn("SERVICE_ATTESTED", status)
        self.assertNotIn("Get-Acl -LiteralPath $keyPath", status)

    def test_acl_attestation_runs_under_stopped_bound_service_without_reading_key(self) -> None:
        validator = self.read_agent("invoke_acl_validation.ps1")
        runner = (ENGINE_ROOT / "run_identity_agent.py").read_text(encoding="utf-8")
        key_store = (ENGINE_ROOT / "aegis_identity_agent" / "key_store.py").read_text(encoding="utf-8")
        for required in (
            "Assert-IdentityAgentInstallationMarker",
            "service must be stopped",
            "Invoke-CheckedServiceControl",
            "WaitForStatus('Stopped'",
            "--validate-key-store-acl",
            "$evidence.keyAcl",
        ):
            self.assertIn(required, validator)
        self.assertNotIn("Get-Acl -LiteralPath $DataRoot", validator)
        self.assertIn("--validate-key-store-acl", runner)
        self.assertIn("validate_acl", runner)
        self.assertIn("def validate_acl", key_store)
        provision = self.read_agent("provision_identity_key.ps1")
        self.assertNotIn("Test-Path -LiteralPath $keyPath", provision)
        self.assertIn("atomically", provision)

    def test_install_is_fail_closed_repeatable_and_uses_separate_pinned_runtime(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        for required in (
            "WindowsBuiltInRole]::Administrator",
            "ExpectedSourceSha256",
            "requirements-identity-agent-windows.txt",
            "--requirement",
            "win32service",
            "win32serviceutil",
            "win32event",
            "win32security",
            "win32crypt",
            "Get-CimInstance Win32_Service",
            "service account mismatch",
            "service executable mismatch",
            "start= auto",
        ):
            self.assertIn(required, install)
        self.assertNotIn("pip install pywin32", install)
        self.assertNotIn("requirements.txt", install.replace("requirements-identity-agent-windows.txt", ""))

    def test_install_uses_a_hash_locked_binary_only_dependency_set(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        lock_path = ENGINE_ROOT / "requirements-identity-agent-windows.lock.txt"
        self.assertTrue(lock_path.is_file())
        lock = lock_path.read_text(encoding="utf-8")
        for package in (
            "cryptography", "requests", "pywin32", "cffi", "certifi",
            "charset-normalizer", "idna", "urllib3", "pycparser",
        ):
            self.assertRegex(lock.lower(), rf"(?m)^{re.escape(package)}==")
        self.assertGreaterEqual(lock.count("--hash=sha256:"), 9)
        self.assertIn("requirements-identity-agent-windows.lock.txt", install)
        self.assertIn("--require-hashes", install)
        self.assertIn("--only-binary=:all:", install)

    def test_install_validates_strict_non_secret_agent_configuration(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        for required in (
            "ConfigurationFile",
            "AEGIS_AGENT_MONITOR_BASE_URL",
            "AEGIS_AGENT_AUTH_AUDIENCE",
            "AEGIS_AGENT_NODE_ID",
            "AEGIS_AGENT_KEY_VERSION",
            "AEGIS_AGENT_ENGINE_USER_SID",
            "AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS",
            "AEGIS_AGENT_ENGINE_STREAM_URL",
            "AEGIS_AGENT_KEY_PATH",
            "AgentConfig.from_env",
            "127.0.0.1",
            "8078",
        ):
            self.assertIn(required, install)
        self.assertIn("unsupported Identity Agent configuration key", install)
        self.assertNotIn("AEGIS_DETECTION_ENGINE_API_KEY", install)

    def test_install_owns_a_bounded_public_ca_bundle_lifecycle(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        for required in (
            "AEGIS_AGENT_CA_BUNDLE",
            "agent-ca-bundle.pem",
            "$managedCaBundlePath",
            "Copy-Item -LiteralPath $caBundleSource",
            "$configuration['AEGIS_AGENT_CA_BUNDLE'] = $managedCaBundlePath",
            '"${ServiceAccount}:R"',
            "'SYSTEM:F'",
            "'BUILTIN\\Administrators:F'",
        ):
            self.assertIn(required, install)
        self.assertLess(
            install.index("Invoke-AgentConfigValidation -PythonPath $python -Values $configuration"),
            install.index("sc.exe create"),
        )

    def test_empty_optional_ca_bundle_uses_default_trust(self) -> None:
        for script_name in ("install_identity_agent.ps1", "status_identity_agent.ps1"):
            script = self.read_agent(script_name)
            with self.subTest(script=script_name):
                self.assertIn(
                    "if ($name -eq 'AEGIS_AGENT_CA_BUNDLE') { continue }",
                    script,
                )

    def test_status_reports_only_safe_ca_bundle_state(self) -> None:
        status = self.read_agent("status_identity_agent.ps1")
        self.assertIn("AGENT_CA_BUNDLE_STATE", status)
        self.assertIn("AGENT_CA_BUNDLE_VALID", status)
        for state in ("DEFAULT", "MANAGED", "MISSING", "INVALID", "REQUIRES_ELEVATION"):
            self.assertIn(state, status)
        self.assertNotIn("Get-Content -LiteralPath $caBundlePath -Raw", status)

    def test_repair_and_uninstall_cover_ca_bundle_without_touching_identity(self) -> None:
        repair = self.read_agent("repair_identity_agent.ps1")
        uninstall = self.read_agent("uninstall_identity_agent.ps1")
        readme = self.read_agent("README.md")
        self.assertIn("ReplacementConfigurationFile", repair)
        self.assertIn("install_identity_agent.ps1", repair)
        self.assertIn("agent-ca-bundle.pem", uninstall)
        self.assertIn("Remove-Item -LiteralPath $caBundlePath -Force", uninstall)
        self.assertIn("AEGIS_AGENT_CA_BUNDLE", readme)
        self.assertIn("rollback", readme.lower())
        self.assertIn("public CA certificates only", readme)

    def test_install_is_safe_for_existing_service_and_protected_configuration(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        self.assertIn("if ($null -eq $existingService)", install)
        self.assertIn("sc.exe config", install)
        self.assertIn("BUILTIN\\Administrators:F", install)
        self.assertNotIn("BUILTIN\\Users", install)
        self.assertNotIn("Authenticated Users", install)
        self.assertLess(install.index("AgentConfig.from_env"), install.index("sc.exe create"))
        self.assertIn("WaitForStatus", install)

    def test_install_separates_admin_managed_runtime_from_service_only_identity_data(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        self.assertIn("ConfigurationRoot", install)
        self.assertIn("Join-Path $ConfigurationRoot 'agent.env'", install)
        self.assertIn("Join-Path $ConfigurationRoot 'install.json'", install)
        self.assertIn('"${ServiceAccount}:(OI)(CI)RX"', install)
        self.assertIn("'BUILTIN\\Administrators:(OI)(CI)F'", install)
        self.assertIn(
            "icacls.exe $DataRoot /inheritance:r /grant:r "
            '"${ServiceAccount}:(OI)(CI)F" \'SYSTEM:(OI)(CI)F\'',
            install.replace("`\n", ""),
        )
        self.assertNotIn("Join-Path $DataRoot 'agent.env'", install)
        self.assertNotIn("Join-Path $DataRoot 'install.json'", install)
        self.assertIn("$dataRootExisted", install)
        self.assertIn("if (-not $dataRootExisted)", install)

    def test_start_now_relies_on_fail_closed_service_start_not_admin_key_read(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        start_block = install[install.index("if ($StartNow)") :]
        self.assertNotIn("Test-Path -LiteralPath $keyPath", start_block)
        self.assertIn("Start-Service -Name $ServiceName", start_block)
        self.assertIn("WaitForStatus('Running'", start_block)

    def test_dpapi_preflight_does_not_require_admin_access_to_service_only_key_data(self) -> None:
        preflight = self.read_agent("invoke_dpapi_preflight.ps1")
        self.assertNotIn("Get-Acl -LiteralPath $DataRoot", preflight)
        self.assertIn("IdentityKeyStore validates the exact data ACL", preflight)

    def test_repository_provides_the_exact_source_manifest_hash_command(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        helper = self.read_agent("get_identity_agent_source_hash.ps1")
        readme = self.read_agent("README.md")
        self.assertIn("get_identity_agent_source_hash.ps1", install)
        self.assertIn("get_identity_agent_source_hash.ps1", readme)
        for required in (
            "aegis_identity_agent",
            "run_identity_agent.py",
            "requirements-identity-agent-windows.txt",
            "SHA256",
        ):
            self.assertIn(required, helper)

    def test_repeat_install_replaces_the_agent_package_without_stale_modules(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        remove_index = install.index("Remove-Item -LiteralPath $installedPackage")
        create_index = install.index("New-Item -ItemType Directory -Path $installedPackage")
        copy_index = install.index("Copy-Item -Destination $installedPackage")
        self.assertLess(remove_index, create_index)
        self.assertLess(create_index, copy_index)

    def test_install_preserves_single_engine_startup_owner(self) -> None:
        install = self.read_windows("install_autostart.ps1")
        agent_install = self.read_agent("install_identity_agent.ps1")
        self.assertIn("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", install)
        self.assertNotIn("IdentityAgentConfigurationFile", install)
        self.assertNotIn("AEGIS Detection Engine", agent_install)
        self.assertNotIn("New-Service -Name 'AEGIS Detection Engine'", install)
        self.assertNotRegex(install, r"Register-ScheduledTask[^\n]+AEGIS Detection Engine")

    def test_status_reports_truthful_categories_without_secret_values(self) -> None:
        status = self.read_agent("status_identity_agent.ps1")
        for required in (
            "INSTALLATION_STATE",
            "SERVICE_STATE",
            "SERVICE_STARTUP",
            "SERVICE_IDENTITY",
            "LOOPBACK_8078",
            "CONFIGURATION_STATE",
            "IDENTITY_KEY_STATE",
            "IDENTITY_KEY_ACL",
            "ENGINE_STARTUP_OWNER",
            "TUNNEL_TASK_STATE",
            "INSTALLED",
            "NOT_INSTALLED",
            "RUNNING",
            "STOPPED",
            "DEGRADED",
            "MISCONFIGURED",
        ):
            self.assertIn(required, status)
        self.assertNotIn("Get-Content -LiteralPath $keyPath", status)
        self.assertNotRegex(status, r"Write-(?:Host|Output)[^\n]*(?:API_KEY|PRIVATE_KEY|KEY_PATH)")
        self.assertIn("AgentConfig.from_env", status)
        self.assertIn("SERVICE_ATTESTED", status)

    def test_status_requires_the_loopback_listener_to_belong_to_the_service(self) -> None:
        status = self.read_agent("status_identity_agent.ps1")
        self.assertIn("ExpectedProcessId", status)
        self.assertIn("OwningProcess", status)
        self.assertIn("$service.ProcessId", status)

    def test_status_does_not_label_an_alternate_engine_owner_as_hkcu_run(self) -> None:
        status = self.read_agent("status_identity_agent.ps1")
        self.assertIn(
            "$engineOwnerCount -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$engineRun)",
            status,
        )
        self.assertIn("else { 'MISCONFIGURED' }", status)

    def test_protected_key_acl_is_attested_by_the_running_service_identity(self) -> None:
        status = self.read_agent("status_identity_agent.ps1")
        self.assertIn("/v1/health/key-store", status)
        self.assertIn("processId", status)
        self.assertIn("$serviceProcessId", status)
        self.assertIn("keyState", status)
        self.assertIn("keyAcl", status)
        self.assertIn("dataRootAcl", status)
        self.assertIn("$loopback -eq 'RUNNING'", status)
        self.assertNotIn("Test-ProtectedAcl -Path $keyPath", status)

    def test_status_does_not_synthesize_current_key_attestation_from_listener_state(self) -> None:
        status = self.read_agent("status_identity_agent.ps1")
        self.assertNotIn("if ($serviceAclAttested) { 'PRESENT_SERVICE_ATTESTED' }", status)
        self.assertNotIn("if ($serviceAclAttested) { 'SERVICE_ATTESTED' }", status)
        self.assertIn("NOT_ATTESTED", status)

    def test_repair_preserves_identity_and_refuses_startup_conflicts(self) -> None:
        repair = self.read_agent("repair_identity_agent.ps1")
        install = self.read_agent("install_identity_agent.ps1")
        for required in (
            "install_identity_agent.ps1",
            "machine-identity.dpapi",
            "identity must be preserved",
            "conflicting Engine startup owner",
            "ExpectedSourceSha256",
            "ConfigurationRoot",
        ):
            self.assertIn(required, repair)
        self.assertNotIn("--generate-key", repair)
        self.assertNotIn("Remove-Item -LiteralPath $keyPath", repair)
        self.assertNotIn("Get-FileHash -LiteralPath $keyPath", repair)
        self.assertNotIn("Get-Content -LiteralPath $keyPath", repair)
        self.assertIn("$ownerCount -ne 1", repair)
        self.assertIn("[string]::IsNullOrWhiteSpace([string]$engineRun)", repair)
        self.assertIn("ReplacementConfigurationFile", repair)
        self.assertIn("RepairExistingIdentity", repair)
        self.assertIn("RepairExistingIdentity", install)
        self.assertIn("missing service", install.lower())

    def test_key_provisioning_is_idempotently_resumable_under_service_identity(self) -> None:
        provision = self.read_agent("provision_identity_key.ps1")
        runner = (ENGINE_ROOT / "run_identity_agent.py").read_text(encoding="utf-8")
        self.assertIn("--provision-key", provision)
        self.assertNotIn("--generate-key", provision)
        self.assertIn("--provision-key", runner)
        self.assertIn("generate_signer", runner)
        self.assertIn("allow_identical=True", runner)

    def test_uninstall_preserves_identity_by_default_and_requires_explicit_destruction(self) -> None:
        uninstall = self.read_agent("uninstall_identity_agent.ps1")
        for required in (
            "SupportsShouldProcess",
            "DestroyIdentity",
            "machine-identity.dpapi",
            "IDENTITY_PRESERVED=YES",
            "IDENTITY_DESTRUCTION=DESTROYED",
            "IDENTITY_DESTRUCTION=ALREADY_ABSENT",
            "IDENTITY_DESTRUCTION=NOT_EXECUTED",
            "sc.exe delete",
            "ConfigurationRoot",
        ):
            self.assertIn(required, uninstall)
        self.assertIn("if ($DestroyIdentity)", uninstall)
        self.assertIn("takeown.exe", uninstall)
        self.assertLess(uninstall.index("if ($DestroyIdentity)"), uninstall.index("takeown.exe"))
        self.assertNotIn("AEGIS Detection Tunnel", uninstall)
        self.assertNotIn("AEGIS Detection Engine", uninstall)
        self.assertIn("WaitForStatus", uninstall)
        self.assertNotIn("'IDENTITY_DESTROYED=YES'", uninstall)

    def test_verifier_requires_boot_idle_and_no_terminal_helpers(self) -> None:
        verify = self.read_agent("verify_machine_a_no_powershell.ps1")
        for required in (
            "EngineStartupOwner",
            "IdentityAgentService",
            "IdentityAgentLoopback8078",
            "TunnelTask",
            "CameraDemanded",
            "CameraConnected",
            "ManualPowerShellRequired",
            "ManualHeartbeatRequired",
            "TemporaryBridge18078Required",
        ):
            self.assertIn(required, verify)
        self.assertIn("CAMERA_IDLE_OFF=PASS", verify)
        self.assertNotIn("/demand", verify)
        for required_gate in (
            "IDENTITY_KEY_ACL",
            "IDENTITY_DATA_ROOT_ACL",
            "TUNNEL_TASK_PRINCIPAL",
            "TUNNEL_TASK_TRIGGER",
            "ENGINE_STARTUP_COMMAND",
            "TUNNEL_TASK_ACTION",
            "MONITOR_FORWARD_HEALTH",
        ):
            self.assertIn(required_gate, verify)
        self.assertIn("-notin @('READY', 'RUNNING')", verify)

    def test_one_shot_service_helpers_require_stopped_state_and_checked_transitions(self) -> None:
        for script_name in ("invoke_dpapi_preflight.ps1", "provision_identity_key.ps1"):
            script = self.read_agent(script_name)
            self.assertIn("service must be stopped", script)
            self.assertIn("Invoke-CheckedServiceControl", script)
            self.assertIn("WaitForStatus('Stopped'", script)
            self.assertNotIn("sc.exe stop $ServiceName", script)

    def test_whatif_never_reports_successful_mutation(self) -> None:
        preflight = self.read_agent("invoke_dpapi_preflight.ps1")
        provision = self.read_agent("provision_identity_key.ps1")
        repair = self.read_agent("repair_identity_agent.ps1")
        uninstall = self.read_agent("uninstall_identity_agent.ps1")
        self.assertIn("DPAPI_CURRENTUSER_PREFLIGHT=NOT_EXECUTED", preflight)
        self.assertIn("IDENTITY_PROVISIONING=NOT_EXECUTED", provision)
        self.assertIn("REPAIR=NOT_EXECUTED", repair)
        self.assertIn("IDENTITY_DESTRUCTION=NOT_EXECUTED", uninstall)

    def test_default_uninstall_preserves_a_bound_reinstall_marker(self) -> None:
        uninstall = self.read_agent("uninstall_identity_agent.ps1")
        install = self.read_agent("install_identity_agent.ps1")
        self.assertIn("PRESERVED", uninstall)
        self.assertIn("IN_PROGRESS", install)
        self.assertIn("INSTALLED", install)
        self.assertIn("preserved-identity marker", install)

    def test_acl_validation_uses_sids_instead_of_localized_account_names(self) -> None:
        safety = self.read_agent("identity_agent_safety.ps1")
        self.assertIn("SecurityIdentifier", safety)
        self.assertIn("S-1-5-18", safety)
        self.assertIn("Translate([Security.Principal.SecurityIdentifier])", safety)

    def test_lifecycle_scripts_do_not_create_camera_demand_or_reintroduce_old_network_defaults(self) -> None:
        sources = "\n".join(
            path.read_text(encoding="utf-8")
            for path in AGENT_ROOT.glob("*.ps1")
        )
        for forbidden in (
            "/demand",
            "camera/open",
            "VideoCapture",
            "127.0.0.1:18078",
            "172.18.",
            "AEGIS_CAMERA_ID",
        ):
            self.assertNotIn(forbidden, sources)

    def test_top_level_status_aggregates_identity_agent_without_printing_configuration(self) -> None:
        status = self.read_windows("status_autostart.ps1")
        self.assertIn("status_identity_agent.ps1", status)
        self.assertIn("ENGINE_STARTUP_OWNER", status)
        self.assertIn("CONFLICT", status)
        self.assertNotIn("Get-Content -LiteralPath $identityKeyPath", status)
        self.assertNotIn("Get-Content -LiteralPath $path -Tail", status)

    def test_status_treats_acl_denial_as_unknown_not_false_misconfiguration(self) -> None:
        status = self.read_agent("status_identity_agent.ps1")
        self.assertIn("REQUIRES_ELEVATION", status)
        self.assertIn("UnauthorizedAccessException", status)

    def test_readme_documents_one_time_admin_lifecycle_and_safe_key_semantics(self) -> None:
        readme = self.read_agent("README.md")
        for required in (
            "install_identity_agent.ps1",
            "status_identity_agent.ps1",
            "repair_identity_agent.ps1",
            "uninstall_identity_agent.ps1",
            "verify_machine_a_no_powershell.ps1",
            "CurrentUser",
            "NT SERVICE\\AEGISIdentityAgent",
            "identity is preserved by default",
            "DestroyIdentity",
            "127.0.0.1:8078",
            "camera remains off",
        ):
            self.assertIn(required, readme)
        self.assertIn("does not open, hash, copy, delete, generate, or rotate", " ".join(readme.split()))
        self.assertNotIn("hashes the existing protected identity", readme)

    def test_no_private_key_or_secret_payload_is_embedded(self) -> None:
        private_key = re.compile(r"BEGIN (?:OPENSSH|RSA|EC) PRIVATE KEY")
        secret_assignment = re.compile(
            r"(?im)^\s*(?:AEGIS_DETECTION_ENGINE_API_KEY|PASSWORD|TOKEN)\s*=\s*[^<$\s]"
        )
        for path in AGENT_ROOT.rglob("*"):
            if path.is_file():
                text = path.read_text(encoding="utf-8")
                self.assertIsNone(private_key.search(text), path)
                self.assertIsNone(secret_assignment.search(text), path)


if __name__ == "__main__":
    unittest.main()
