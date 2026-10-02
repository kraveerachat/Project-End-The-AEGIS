from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ENGINE_ROOT = Path(__file__).resolve().parents[1]
WINDOWS_ROOT = ENGINE_ROOT / "windows"
AGENT_ROOT = WINDOWS_ROOT / "identity-agent"


class WindowsIdentityAgentLifecycleTests(unittest.TestCase):
    def test_temporary_service_commands_pass_binpath_option_and_value_separately(self) -> None:
        commands = {
            "invoke_dpapi_preflight.ps1": (
                "$preflightCommand",
                '"C:\\Program Files\\AEGIS\\agent.exe" --service --dpapi-preflight',
                '\"{0}\" \"{1}\" --service --dpapi-preflight',
            ),
            "provision_identity_key.ps1": (
                "$generateCommand",
                '"C:\\Program Files\\AEGIS\\agent.exe" --service --provision-key',
                '\"{0}\" \"{1}\" --service --provision-key',
            ),
            "invoke_acl_validation.ps1": (
                "$validationCommand",
                '"C:\\Program Files\\AEGIS\\agent.exe" --service --validate-key-store-acl',
                '\"{0}\" \"{1}\" --service --validate-key-store-acl',
            ),
        }
        original = '"C:\\Program Files\\AEGIS\\agent.exe" --service'
        for script_name, (variable, temporary, source_shape) in commands.items():
            with self.subTest(script=script_name):
                source = self.read_agent(script_name)
                self.assertIn(variable, source)
                self.assertIn(source_shape, source)
                script_path = str(AGENT_ROOT / script_name).replace("'", "''")
                script = f"""
                $ErrorActionPreference = 'Stop'
                $tokens = $null
                $errors = $null
                $ast = [System.Management.Automation.Language.Parser]::ParseFile(
                    '{script_path}', [ref]$tokens, [ref]$errors)
                if ($errors.Count -ne 0) {{ throw 'SCRIPT_PARSE_ERROR' }}
                $calls = @($ast.FindAll({{
                    param($node)
                    $node -is [System.Management.Automation.Language.CommandAst] -and
                    $node.GetCommandName() -eq 'Invoke-CheckedServiceControl' -and
                    $node.CommandElements.Count -ge 3 -and
                    $node.CommandElements[2].Extent.Text -eq 'config'
                }}, $true))
                if ($calls.Count -ne 2) {{ throw 'EXPECTED_TEMPORARY_AND_RESTORE_CONFIG_CALLS' }}
                function Invoke-CheckedServiceControl {{
                    param([string]$ServiceName,
                        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
                    ConvertTo-Json -InputObject @($ServiceName, $Arguments[0], $Arguments[1], $Arguments[2]) -Compress
                }}
                $ServiceName = 'AEGISIdentityAgent'
                $original = '{original}'
                $preflightCommand = '{temporary}'
                $generateCommand = '{temporary}'
                $validationCommand = '{temporary}'
                foreach ($call in $calls) {{ & ([scriptblock]::Create($call.Extent.Text)) }}
                """
                result = self._run_powershell(script, cwd=ENGINE_ROOT)
                self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
                self.assertEqual(
                    [json.loads(line) for line in result.stdout.splitlines() if line.strip()],
                    [
                        ["AEGISIdentityAgent", "config", "binPath=", temporary],
                        ["AEGISIdentityAgent", "config", "binPath=", original],
                    ],
                )

    def test_maintenance_service_exit_codes_are_checked_before_evidence_is_accepted(self) -> None:
        for script_name in (
            "invoke_dpapi_preflight.ps1",
            "provision_identity_key.ps1",
            "invoke_acl_validation.ps1",
        ):
            with self.subTest(script=script_name):
                source = self.read_agent(script_name)
                self.assertIn("Assert-IdentityAgentMaintenanceServiceSucceeded", source)
                self.assertLess(
                    source.index("Assert-IdentityAgentMaintenanceServiceSucceeded"),
                    source.rindex("ConvertFrom-Json"),
                )

        safety_path = str(AGENT_ROOT / "identity_agent_safety.ps1").replace("'", "''")
        script = f"""
        $ErrorActionPreference = 'Stop'
        . '{safety_path}'
        function Get-CimInstance {{
            [pscustomobject]@{{
                State = 'Stopped'
                ExitCode = 1066
                ServiceSpecificExitCode = 1
            }}
        }}
        try {{
            Assert-IdentityAgentMaintenanceServiceSucceeded -ServiceName 'AEGISIdentityAgent'
            throw 'FAILED_SERVICE_ACCEPTED'
        }} catch {{
            if ($_.Exception.Message -eq 'FAILED_SERVICE_ACCEPTED') {{ throw }}
            if ($_.Exception.Message -notmatch 'maintenance service failed') {{ throw }}
        }}
        'FAILED_SERVICE_REJECTED'
        """
        result = self._run_powershell(script, cwd=ENGINE_ROOT)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("FAILED_SERVICE_REJECTED", result.stdout)

    def test_service_control_rejects_packed_binpath_and_preserves_native_quote_escape(self) -> None:
        safety_path = str(AGENT_ROOT / "identity_agent_safety.ps1").replace("'", "''")
        script = f"""
        $ErrorActionPreference = 'Stop'
        . '{safety_path}'
        $script:scCalls = @()
        $script:scExit = 0
        function sc.exe {{
            $script:scCalls += ,@($args)
            $global:LASTEXITCODE = $script:scExit
        }}
        $imagePath = '"C:\\Program Files\\AEGIS\\agent.exe" --service'
        Invoke-CheckedServiceControl AEGISIdentityAgent config 'binPath=' $imagePath
        Invoke-CheckedServiceControl AEGISIdentityAgent start
        Invoke-CheckedServiceControl AEGISIdentityAgent stop
        try {{
            Invoke-CheckedServiceControl AEGISIdentityAgent config "binPath= $imagePath"
            throw 'PACKED_BINPATH_ACCEPTED'
        }} catch {{
            if ($_.Exception.Message -eq 'PACKED_BINPATH_ACCEPTED') {{ throw }}
        }}
        $script:scExit = 1639
        try {{
            Invoke-CheckedServiceControl AEGISIdentityAgent config 'binPath=' $imagePath
            throw 'SC_FAILURE_IGNORED'
        }} catch {{
            if ($_.Exception.Message -ne 'sc.exe failed with exit code 1639') {{ throw }}
        }}
        if ($script:scCalls.Count -ne 4) {{ throw 'UNEXPECTED_SC_CALL_COUNT' }}
        foreach ($call in $script:scCalls) {{ ConvertTo-Json -InputObject $call -Compress }}
        """
        result = self._run_powershell(script, cwd=ENGINE_ROOT)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertEqual(
            [json.loads(line) for line in result.stdout.splitlines() if line.strip()],
            [
                ["config", "AEGISIdentityAgent", "binPath=", '\\"C:\\Program Files\\AEGIS\\agent.exe\\" --service'],
                ["start", "AEGISIdentityAgent"],
                ["stop", "AEGISIdentityAgent"],
                ["config", "AEGISIdentityAgent", "binPath=", '\\"C:\\Program Files\\AEGIS\\agent.exe\\" --service'],
            ],
        )

    def test_one_shot_service_restores_original_path_even_when_stop_fails(self) -> None:
        for script_name in (
            "invoke_dpapi_preflight.ps1",
            "provision_identity_key.ps1",
            "invoke_acl_validation.ps1",
        ):
            with self.subTest(script=script_name):
                script_path = str(AGENT_ROOT / script_name).replace("'", "''")
                script = f"""
                $ErrorActionPreference = 'Stop'
                $tokens = $null
                $errors = $null
                $ast = [System.Management.Automation.Language.Parser]::ParseFile(
                    '{script_path}', [ref]$tokens, [ref]$errors)
                if ($errors.Count -ne 0) {{ throw 'SCRIPT_PARSE_ERROR' }}
                $tries = @($ast.FindAll({{
                    param($node)
                    $node -is [System.Management.Automation.Language.TryStatementAst] -and
                    $null -ne $node.Finally -and
                    $node.Body.Extent.Text -match "config 'binPath='"
                }}, $true))
                if ($tries.Count -ne 1) {{ throw 'EXPECTED_ONE_SHOT_TRY_FINALLY' }}
                if ($tries[0].Body.Extent.Text -notmatch "config 'binPath='") {{
                    throw 'TEMPORARY_CONFIG_OUTSIDE_RESTORATION_TRY'
                }}
                $finallyBody = ($tries[0].Finally.Statements | ForEach-Object {{ $_.Extent.Text }}) -join "`n"
                $script:calls = @()
                $ServiceName = 'AEGISIdentityAgent'
                $original = '"C:\\Program Files\\AEGIS\\agent.exe" --service'
                function Get-Service {{ return [pscustomobject]@{{ Status = 'Running' }} }}
                function Invoke-CheckedServiceControl {{
                    param([string]$ServiceName,
                        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
                    $script:calls += ,@($Arguments)
                    if ($Arguments[0] -eq 'stop') {{ throw 'STOP_FAILED' }}
                }}
                try {{ & ([scriptblock]::Create($finallyBody)); throw 'STOP_NOT_PROPAGATED' }}
                catch {{ if ($_.Exception.Message -ne 'STOP_FAILED') {{ throw }} }}
                foreach ($call in $script:calls) {{ ConvertTo-Json -InputObject $call -Compress }}
                """
                result = self._run_powershell(script, cwd=ENGINE_ROOT)
                self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
                self.assertEqual(
                    [json.loads(line) for line in result.stdout.splitlines() if line.strip()],
                    [["stop"], ["config", "binPath=", '"C:\\Program Files\\AEGIS\\agent.exe" --service']],
                )

    def test_service_create_and_config_preserve_exact_native_image_path_arguments(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aegis-agent-service-argv-") as raw_root:
            root = Path(raw_root)
            capture = root / "capture.py"
            capture.write_text(
                "import json, sys\nfrom pathlib import Path\n"
                "Path(sys.argv[1]).write_text(json.dumps(sys.argv[2:]), encoding='utf-8')\n",
                encoding="ascii",
            )
            image_path = (
                '"C:\\Program Files\\AEGIS\\IdentityAgent\\.venv\\Scripts\\python.exe" '
                '"C:\\Program Files\\AEGIS\\IdentityAgent\\run_identity_agent.py" --service'
            )
            for operation in ("create", "config"):
                with self.subTest(operation=operation):
                    output = root / f"{operation}.json"
                    script = (
                        self._load_installer_function("Get-IdentityAgentServiceOptions")
                        + self._load_installer_function("Invoke-CheckedExternal")
                        + f"""
                    $ErrorActionPreference = 'Stop'
                    $options = @(Get-IdentityAgentServiceOptions -ExpectedBinPath '{image_path}' `
                        -ServiceAccount 'NT SERVICE\\AEGISIdentityAgent')
                    Invoke-CheckedExternal '{str(Path(sys.executable)).replace("'", "''")}' `
                        '{str(capture).replace("'", "''")}' '{str(output).replace("'", "''")}' `
                        '{operation}' 'AEGISIdentityAgent' @options
                    """
                    )
                    result = self._run_powershell(script, cwd=root)
                    self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
                    self.assertEqual(
                        json.loads(output.read_text(encoding="utf-8")),
                        [operation, "AEGISIdentityAgent", "binPath=", image_path,
                         "obj=", "NT SERVICE\\AEGISIdentityAgent", "start=", "auto"],
                    )

    def test_service_options_reject_malformed_image_path_and_wrong_account(self) -> None:
        cases = (
            (r'C:\Program Files\AEGIS\IdentityAgent\python.exe --service',
             r'NT SERVICE\AEGISIdentityAgent'),
            ('"C:\\Program Files\\python.exe" "C:\\run.py" --service & whoami',
             r'NT SERVICE\AEGISIdentityAgent'),
            ('"C:\\Program Files\\python.exe" "C:\\run.py" --service\nextra',
             r'NT SERVICE\AEGISIdentityAgent'),
            ('"C:\\Program Files\\python.exe" "C:\\run.py" --service',
             r'LocalSystem'),
        )
        with tempfile.TemporaryDirectory(prefix="aegis-agent-service-reject-") as raw_root:
            root = Path(raw_root)
            for image_path, account in cases:
                with self.subTest(image_path=image_path, account=account):
                    escaped_image = image_path.replace("'", "''")
                    script = self._load_installer_function("Get-IdentityAgentServiceOptions") + f"""
                    $ErrorActionPreference = 'Stop'
                    try {{
                        Get-IdentityAgentServiceOptions -ExpectedBinPath '{escaped_image}' `
                            -ServiceAccount '{account}' | Out-Null
                        throw 'MALFORMED_SERVICE_OPTIONS_ACCEPTED'
                    }} catch {{
                        if ($_.Exception.Message -eq 'MALFORMED_SERVICE_OPTIONS_ACCEPTED') {{ throw }}
                    }}
                    'MALFORMED_SERVICE_OPTIONS_REJECTED'
                    """
                    result = self._run_powershell(script, cwd=root)
                    self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
                    self.assertIn("MALFORMED_SERVICE_OPTIONS_REJECTED", result.stdout)

    def _load_installer_function(self, name: str) -> str:
        installer = str(AGENT_ROOT / "install_identity_agent.ps1").replace("'", "''")
        return f"""
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile('{installer}', [ref]$tokens, [ref]$errors)
        if ($errors.Count -ne 0) {{ throw 'INSTALLER_PARSE_ERROR' }}
        $functionAst = $ast.Find({{
            param($node)
            $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
                $node.Name -eq '{name}'
        }}, $true)
        if ($null -eq $functionAst) {{ throw 'INSTALLER_FUNCTION_MISSING:{name}' }}
        . ([scriptblock]::Create($functionAst.Extent.Text))
        """

    def _run_powershell(self, script: str, *, cwd: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )

    def _write_disposable_ca(self, path: Path) -> None:
        from datetime import datetime, timedelta, timezone

        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "AEGIS disposable installer test CA")])
        now = datetime.now(timezone.utc)
        certificate = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=1))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .sign(key, hashes.SHA256())
        )
        path.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))

    def test_ca_validation_imports_installed_package_from_unrelated_cwd_and_restores_env(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aegis-agent-ca-import-") as raw_root:
            root = Path(raw_root)
            install = root / "installed"
            install.mkdir()
            shutil.copytree(ENGINE_ROOT / "aegis_identity_agent", install / "aegis_identity_agent")
            caller = root / "unrelated-cwd"
            caller.mkdir()
            hostile_package = caller / "aegis_identity_agent"
            hostile_package.mkdir()
            (hostile_package / "__init__.py").write_text(
                "raise SystemExit('HOSTILE_CWD_PACKAGE_IMPORTED')\n", encoding="ascii"
            )
            ca_path = root / "public-ca.pem"
            self._write_disposable_ca(ca_path)
            script = self._load_installer_function("Invoke-AgentCaBundleValidation") + f"""
            $ErrorActionPreference = 'Stop'
            $beforePath = 'previous-process-pythonpath'
            $beforeSource = 'previous-process-ca-source'
            [Environment]::SetEnvironmentVariable('PYTHONPATH', $beforePath, 'Process')
            [Environment]::SetEnvironmentVariable('AEGIS_CA_BUNDLE_SOURCE', $beforeSource, 'Process')
            Invoke-AgentCaBundleValidation -PythonPath '{str(Path(sys.executable)).replace("'", "''")}' `
                -PackageRoot '{str(install).replace("'", "''")}' `
                -CaBundleSource '{str(ca_path).replace("'", "''")}'
            if ([Environment]::GetEnvironmentVariable('PYTHONPATH', 'Process') -ne $beforePath) {{ throw 'PYTHONPATH_LEAK' }}
            if ([Environment]::GetEnvironmentVariable('AEGIS_CA_BUNDLE_SOURCE', 'Process') -ne $beforeSource) {{ throw 'CA_SOURCE_LEAK' }}
            'CA_IMPORT_FROM_UNRELATED_CWD=PASS'
            """
            result = self._run_powershell(script, cwd=caller)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertIn("IDENTITY_AGENT_CA_BUNDLE=VALID", result.stdout)
        self.assertIn("CA_IMPORT_FROM_UNRELATED_CWD=PASS", result.stdout)

    def test_ca_validation_still_rejects_malformed_and_private_key_material(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aegis-agent-ca-reject-") as raw_root:
            root = Path(raw_root)
            invalid = root / "invalid.pem"
            invalid.write_text("not a certificate", encoding="ascii")
            private = root / "private.pem"
            self._write_disposable_ca(private)
            with private.open("ab") as stream:
                stream.write(b"-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n")
            for label, path in (("MALFORMED", invalid), ("PRIVATE_KEY", private)):
                with self.subTest(label=label):
                    script = self._load_installer_function("Invoke-AgentCaBundleValidation") + f"""
                    $ErrorActionPreference = 'Stop'
                    $beforePath = 'previous-process-pythonpath'
                    $beforeSource = 'previous-process-ca-source'
                    [Environment]::SetEnvironmentVariable('PYTHONPATH', $beforePath, 'Process')
                    [Environment]::SetEnvironmentVariable('AEGIS_CA_BUNDLE_SOURCE', $beforeSource, 'Process')
                    try {{
                        Invoke-AgentCaBundleValidation -PythonPath '{str(Path(sys.executable)).replace("'", "''")}' `
                            -PackageRoot '{str(ENGINE_ROOT).replace("'", "''")}' `
                            -CaBundleSource '{str(path).replace("'", "''")}'
                        throw 'INVALID_CA_ACCEPTED'
                    }} catch {{
                        if ($_.Exception.Message -eq 'INVALID_CA_ACCEPTED') {{ throw }}
                    }}
                    if ([Environment]::GetEnvironmentVariable('PYTHONPATH', 'Process') -ne $beforePath) {{ throw 'PYTHONPATH_LEAK' }}
                    if ([Environment]::GetEnvironmentVariable('AEGIS_CA_BUNDLE_SOURCE', 'Process') -ne $beforeSource) {{ throw 'CA_SOURCE_LEAK' }}
                    'INVALID_CA_REJECTED={label}'
                    """
                    result = self._run_powershell(script, cwd=root)
                    self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
                    self.assertIn(f"INVALID_CA_REJECTED={label}", result.stdout)

    def test_exact_pre_identity_in_progress_resume_is_bound_and_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="aegis-agent-in-progress-") as raw_root:
            root = Path(raw_root)
            install, config, evidence, data = (root / name for name in ("install", "config", "evidence", "data"))
            for path in (install, config, evidence):
                path.mkdir()
            marker = config / "install.json"
            script = (
                self._load_installer_function("Test-PathExistsIncludingDenied")
                + self._load_installer_function("Assert-IdentityAgentPreIdentityResume")
                + f"""
            $ErrorActionPreference = 'Stop'
            . '{str(AGENT_ROOT / 'identity_agent_safety.ps1').replace("'", "''")}'
            $install = '{str(install).replace("'", "''")}'
            $config = '{str(config).replace("'", "''")}'
            $evidence = '{str(evidence).replace("'", "''")}'
            $data = '{str(data).replace("'", "''")}'
            $marker = @{{
                schemaVersion = 1; state = 'IN_PROGRESS'; serviceName = 'AEGISIdentityAgent'
                serviceAccount = 'NT SERVICE\\AEGISIdentityAgent'; sourceSha256 = ('A' * 64)
                installRoot = $install; configurationRoot = $config; dataRoot = $data
                evidenceRoot = $evidence
            }}
            $marker | ConvertTo-Json | Set-Content -LiteralPath '{str(marker).replace("'", "''")}'
            Assert-IdentityAgentPreIdentityResume -ConfigurationRoot $config -InstallRoot $install `
                -DataRoot $data -EvidenceRoot $evidence -ServiceName 'AEGISIdentityAgent' `
                -ServiceAccount 'NT SERVICE\\AEGISIdentityAgent' -ExpectedSourceSha256 ('A' * 64)
            'EXACT_IN_PROGRESS=ACCEPTED'
            try {{
                Assert-IdentityAgentPreIdentityResume -ConfigurationRoot $config -InstallRoot $install `
                    -DataRoot $data -EvidenceRoot $evidence -ServiceName 'AEGISIdentityAgent' `
                    -ServiceAccount 'NT SERVICE\\AEGISIdentityAgent' -ExpectedSourceSha256 ('B' * 64)
                throw 'MISMATCHED_SOURCE_ACCEPTED'
            }} catch {{ if ($_.Exception.Message -eq 'MISMATCHED_SOURCE_ACCEPTED') {{ throw }} }}
            'MISMATCHED_SOURCE=REJECTED'
            New-Item -ItemType File -Path (Join-Path $config 'agent.env') | Out-Null
            try {{
                Assert-IdentityAgentPreIdentityResume -ConfigurationRoot $config -InstallRoot $install `
                    -DataRoot $data -EvidenceRoot $evidence -ServiceName 'AEGISIdentityAgent' `
                    -ServiceAccount 'NT SERVICE\\AEGISIdentityAgent' -ExpectedSourceSha256 ('A' * 64)
                throw 'MANAGED_CONFIG_ACCEPTED'
            }} catch {{ if ($_.Exception.Message -eq 'MANAGED_CONFIG_ACCEPTED') {{ throw }} }}
            'MANAGED_CONFIG=REJECTED'
            """
            )
            result = self._run_powershell(script, cwd=root)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        for marker_text in ("EXACT_IN_PROGRESS=ACCEPTED", "MISMATCHED_SOURCE=REJECTED", "MANAGED_CONFIG=REJECTED"):
            self.assertIn(marker_text, result.stdout)

    def test_pre_identity_resume_guard_and_ca_validation_precede_service_creation(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        self.assertLess(
            install.index("Assert-IdentityAgentPreIdentityResume -ConfigurationRoot"),
            install.index("$inProgressSettings | ConvertTo-Json"),
        )
        self.assertLess(
            install.index("Invoke-AgentCaBundleValidation -PythonPath"),
            install.index("Invoke-AgentConfigValidation -PythonPath"),
        )
        self.assertLess(install.index("Invoke-AgentConfigValidation -PythonPath"), install.index("sc.exe create"))
        self.assertNotIn("--generate-key", install)
        self.assertNotIn("--provision-key", install)
        self.assertNotIn("/demand", install)
        self.assertEqual(install.count("Start-Service -Name $ServiceName"), 1)
        self.assertLess(install.index("if ($StartNow)"), install.index("Start-Service -Name $ServiceName"))

    def test_all_installer_python_subprocesses_reject_cwd_import_shadowing(self) -> None:
        install = self.read_agent("install_identity_agent.ps1")
        for invocation in (
            '& $PythonPath -P -c "from aegis_identity_agent.config import AgentConfig',
            '& $PythonPath -P -c "import os; from aegis_identity_agent.config import validate_ca_bundle',
            '& $resolvedBasePython -3.12 -I -m venv $venvRoot',
            '& $resolvedBasePython -I -m venv $venvRoot',
            '& $python -I -c "import struct,sys;',
            '& $python -I -m pip install',
            '& $python -I -c "import win32service,',
        ):
            with self.subTest(invocation=invocation):
                self.assertTrue(invocation in install, f"unsafe Python subprocess: {invocation}")

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
            "'start=', 'auto'",
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
