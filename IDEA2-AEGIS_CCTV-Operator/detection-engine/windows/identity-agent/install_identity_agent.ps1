[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedSourceSha256,
    [Parameter(Mandatory = $true)][string]$ConfigurationFile,
    [string]$BasePythonPath = '',
    [string]$InstallRoot = "$env:ProgramFiles\AEGIS\IdentityAgent",
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent",
    [string]$ConfigurationRoot = "$env:ProgramData\AEGIS\IdentityAgentConfiguration",
    [string]$EvidenceRoot = "$env:ProgramData\AEGIS\IdentityAgentProvisioning",
    [switch]$SkipDependencyInstall,
    [switch]$RepairExistingIdentity,
    [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') { throw 'The Identity Agent installer can only run on Windows.' }
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator elevation is required'
}

$ServiceName = 'AEGISIdentityAgent'
$ServiceAccount = 'NT SERVICE\AEGISIdentityAgent'
$safetyScript = Join-Path $PSScriptRoot 'identity_agent_safety.ps1'
. $safetyScript
Assert-IdentityAgentServiceName -ServiceName $ServiceName
$managedRoots = Assert-IdentityAgentManagedRoots -InstallRoot $InstallRoot -DataRoot $DataRoot `
    -ConfigurationRoot $ConfigurationRoot -EvidenceRoot $EvidenceRoot -SourceRoot $SourceRoot
$InstallRoot = $managedRoots.installRoot
$DataRoot = $managedRoots.dataRoot
$ConfigurationRoot = $managedRoots.configurationRoot
$EvidenceRoot = $managedRoots.evidenceRoot
$identitySource = Join-Path $SourceRoot 'aegis_identity_agent'
$runnerSource = Join-Path $SourceRoot 'run_identity_agent.py'
$requirementsSource = Join-Path $SourceRoot 'requirements-identity-agent-windows.txt'
$requirementsLockSource = Join-Path $SourceRoot 'requirements-identity-agent-windows.lock.txt'
$configurationSource = [IO.Path]::GetFullPath($ConfigurationFile)
$installedConfiguration = Join-Path $ConfigurationRoot 'agent.env'
$managedCaBundlePath = Join-Path $ConfigurationRoot 'agent-ca-bundle.pem'
$keyPath = Join-Path $DataRoot 'machine-identity.dpapi'
$settingsPath = Join-Path $ConfigurationRoot 'install.json'
$serviceRegistryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
# The installer copies only the explicit package, runner, and pinned requirements.
# These names remain an auditable deny contract for material that must never enter
# the isolated Agent runtime even if future copy logic changes.
$ExcludedNames = @('.env', '.git', '.venv', 'segments', 'snapshots', '*.pt', '*.npz', '*.onnx', '*.h5')

function Invoke-CheckedExternal {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    & $FilePath @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$FilePath failed with exit code $LASTEXITCODE" }
}

function Test-PathExistsIncludingDenied {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        Get-Item -LiteralPath $Path -Force -ErrorAction Stop | Out-Null
        return $true
    }
    catch [System.UnauthorizedAccessException] { return $true }
    catch [System.Management.Automation.ItemNotFoundException] { return $false }
}

function Read-StrictAgentConfiguration {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Identity Agent configuration file not found: $Path"
    }
    if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Identity Agent configuration file must not be a reparse point'
    }
    $allowed = @(
        'AEGIS_AGENT_MONITOR_BASE_URL', 'AEGIS_AGENT_AUTH_AUDIENCE',
        'AEGIS_AGENT_NODE_ID', 'AEGIS_AGENT_KEY_VERSION',
        'AEGIS_AGENT_ENGINE_USER_SID', 'AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS',
        'AEGIS_AGENT_ENGINE_STREAM_URL', 'AEGIS_AGENT_CONNECT_TIMEOUT_S',
        'AEGIS_AGENT_READ_TIMEOUT_S', 'AEGIS_AGENT_RENEW_BEFORE_S',
        'AEGIS_AGENT_RETRY_MAX_S', 'AEGIS_AGENT_PIPE_NAME',
        'AEGIS_AGENT_PIPE_TIMEOUT_S', 'AEGIS_AGENT_TLS_VERIFY',
        'AEGIS_AGENT_CA_BUNDLE', 'AEGIS_AGENT_CONFIGURATION_ROOT',
        'AEGIS_AGENT_KEY_PATH'
    )
    $required = @(
        'AEGIS_AGENT_MONITOR_BASE_URL', 'AEGIS_AGENT_AUTH_AUDIENCE',
        'AEGIS_AGENT_NODE_ID', 'AEGIS_AGENT_KEY_VERSION',
        'AEGIS_AGENT_ENGINE_USER_SID', 'AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS',
        'AEGIS_AGENT_ENGINE_STREAM_URL'
    )
    $values = [ordered]@{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        if ($trimmed -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') {
            throw 'Identity Agent configuration contains an invalid line'
        }
        $name = $Matches[1]
        $value = $Matches[2].Trim().Trim('"').Trim("'")
        if ($name -notin $allowed) { throw "unsupported Identity Agent configuration key: $name" }
        if ($values.Contains($name)) { throw "duplicate Identity Agent configuration key: $name" }
        if ([string]::IsNullOrWhiteSpace($value)) {
            if ($name -eq 'AEGIS_AGENT_CA_BUNDLE') { continue }
            throw "Identity Agent configuration value is empty: $name"
        }
        $values[$name] = $value
    }
    foreach ($name in $required) {
        if (-not $values.Contains($name)) {
            throw "Identity Agent configuration is missing required key: $name"
        }
    }
    if ($values.Contains('AEGIS_AGENT_KEY_PATH') -and
        -not [string]::Equals(
            [IO.Path]::GetFullPath([string]$values['AEGIS_AGENT_KEY_PATH']),
            [IO.Path]::GetFullPath($keyPath),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'AEGIS_AGENT_KEY_PATH must use the protected Task 12 data root'
    }
    if ($values.Contains('AEGIS_AGENT_CONFIGURATION_ROOT') -and
        -not [string]::Equals(
            [IO.Path]::GetFullPath([string]$values['AEGIS_AGENT_CONFIGURATION_ROOT']),
            [IO.Path]::GetFullPath($ConfigurationRoot),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        throw 'AEGIS_AGENT_CONFIGURATION_ROOT must use the protected Task 12 configuration root'
    }
    $values['AEGIS_AGENT_KEY_PATH'] = $keyPath
    $values['AEGIS_AGENT_CONFIGURATION_ROOT'] = $ConfigurationRoot
    return $values
}

function Invoke-AgentConfigValidation {
    param(
        [Parameter(Mandatory = $true)][string]$PythonPath,
        [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Values,
        [Parameter(Mandatory = $true)][string]$PackageRoot
    )

    $saved = @{}
    $agentNames = @(
        'AEGIS_AGENT_MONITOR_BASE_URL', 'AEGIS_AGENT_AUTH_AUDIENCE',
        'AEGIS_AGENT_NODE_ID', 'AEGIS_AGENT_KEY_VERSION',
        'AEGIS_AGENT_ENGINE_USER_SID', 'AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS',
        'AEGIS_AGENT_ENGINE_STREAM_URL', 'AEGIS_AGENT_CONNECT_TIMEOUT_S',
        'AEGIS_AGENT_READ_TIMEOUT_S', 'AEGIS_AGENT_RENEW_BEFORE_S',
        'AEGIS_AGENT_RETRY_MAX_S', 'AEGIS_AGENT_PIPE_NAME',
        'AEGIS_AGENT_PIPE_TIMEOUT_S', 'AEGIS_AGENT_TLS_VERIFY',
        'AEGIS_AGENT_CA_BUNDLE', 'AEGIS_AGENT_CONFIGURATION_ROOT',
        'AEGIS_AGENT_KEY_PATH'
    )
    $names = @($agentNames) + @('PYTHONPATH')
    foreach ($name in $names) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    try {
        foreach ($name in $agentNames) {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
        foreach ($entry in $Values.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
        }
        [Environment]::SetEnvironmentVariable('PYTHONPATH', $PackageRoot, 'Process')
        & $PythonPath -P -c "from aegis_identity_agent.config import AgentConfig; AgentConfig.from_env(); print('IDENTITY_AGENT_CONFIG=VALID')"
        if ($LASTEXITCODE -ne 0) { throw 'Identity Agent configuration validation failed' }
    }
    finally {
        foreach ($name in $names) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
        }
    }
}

function Invoke-AgentCaBundleValidation {
    param(
        [Parameter(Mandatory = $true)][string]$PythonPath,
        [Parameter(Mandatory = $true)][string]$PackageRoot,
        [Parameter(Mandatory = $true)][string]$CaBundleSource
    )

    $savedBundleSource = [Environment]::GetEnvironmentVariable('AEGIS_CA_BUNDLE_SOURCE', 'Process')
    $savedPythonPath = [Environment]::GetEnvironmentVariable('PYTHONPATH', 'Process')
    try {
        [Environment]::SetEnvironmentVariable('AEGIS_CA_BUNDLE_SOURCE', $CaBundleSource, 'Process')
        [Environment]::SetEnvironmentVariable('PYTHONPATH', $PackageRoot, 'Process')
        & $PythonPath -P -c "import os; from aegis_identity_agent.config import validate_ca_bundle; validate_ca_bundle(os.environ['AEGIS_CA_BUNDLE_SOURCE']); print('IDENTITY_AGENT_CA_BUNDLE=VALID')"
        if ($LASTEXITCODE -ne 0) { throw 'Identity Agent CA bundle validation failed' }
    }
    finally {
        [Environment]::SetEnvironmentVariable('AEGIS_CA_BUNDLE_SOURCE', $savedBundleSource, 'Process')
        [Environment]::SetEnvironmentVariable('PYTHONPATH', $savedPythonPath, 'Process')
    }
}

function Assert-IdentityAgentPreIdentityResume {
    param(
        [Parameter(Mandatory = $true)][string]$ConfigurationRoot,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][string]$EvidenceRoot,
        [Parameter(Mandatory = $true)][string]$ServiceName,
        [Parameter(Mandatory = $true)][string]$ServiceAccount,
        [Parameter(Mandatory = $true)][string]$ExpectedSourceSha256
    )

    $marker = Assert-IdentityAgentInstallationMarker -ConfigurationRoot $ConfigurationRoot `
        -InstallRoot $InstallRoot -DataRoot $DataRoot -EvidenceRoot $EvidenceRoot -ServiceName $ServiceName
    if ([string]$marker.state -ne 'IN_PROGRESS' -or
        [string]$marker.serviceAccount -ne $ServiceAccount -or
        [string]$marker.sourceSha256 -ne $ExpectedSourceSha256) {
        throw 'Pre-identity Identity Agent resume requires the bound IN_PROGRESS marker and identical source'
    }
    foreach ($name in @('agent.env', 'agent-ca-bundle.pem')) {
        if (Test-PathExistsIncludingDenied -Path (Join-Path $ConfigurationRoot $name)) {
            throw 'Pre-identity Identity Agent resume has unexpected managed configuration'
        }
    }
}

foreach ($requiredPath in @(
        $identitySource, $runnerSource, $requirementsSource,
        $requirementsLockSource, $configurationSource
    )) {
    if (-not (Test-Path -LiteralPath $requiredPath)) { throw "Missing source: $requiredPath" }
}
if ($ExpectedSourceSha256 -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'ExpectedSourceSha256 must be one SHA-256 digest'
}

$hashHelper = Join-Path $PSScriptRoot 'get_identity_agent_source_hash.ps1'
if (-not (Test-Path -LiteralPath $hashHelper -PathType Leaf)) {
    throw 'Identity Agent source-hash helper is missing'
}
$actualSha = [string](& $hashHelper -SourceRoot $SourceRoot)
if ($actualSha -notmatch '^[A-Fa-f0-9]{64}$') {
    throw 'Identity Agent source-hash calculation failed'
}
$actualSha = $actualSha.ToUpperInvariant()
if ($actualSha -ne $ExpectedSourceSha256.ToUpperInvariant()) { throw 'Identity Agent source SHA mismatch' }

$configuration = Read-StrictAgentConfiguration -Path $configurationSource
$caBundleSource = if ($configuration.Contains('AEGIS_AGENT_CA_BUNDLE')) {
    [IO.Path]::GetFullPath([string]$configuration['AEGIS_AGENT_CA_BUNDLE'])
}
else { $null }
$dataRootExisted = Test-PathExistsIncludingDenied -Path $DataRoot
$existingService = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
$configurationRootExisted = Test-PathExistsIncludingDenied -Path $ConfigurationRoot
if (-not $dataRootExisted -and $configurationRootExisted) {
    if ($null -ne $existingService) {
        throw 'Pre-identity Identity Agent resume has an unexpected service'
    }
    Assert-IdentityAgentPreIdentityResume -ConfigurationRoot $ConfigurationRoot `
        -InstallRoot $InstallRoot -DataRoot $DataRoot -EvidenceRoot $EvidenceRoot `
        -ServiceName $ServiceName -ServiceAccount $ServiceAccount -ExpectedSourceSha256 $actualSha
}
if ($dataRootExisted) {
    $existingMarker = Assert-IdentityAgentInstallationMarker -ConfigurationRoot $ConfigurationRoot `
        -InstallRoot $InstallRoot -DataRoot $DataRoot -EvidenceRoot $EvidenceRoot -ServiceName $ServiceName
    $repairableMarker = $RepairExistingIdentity -and
        [string]$existingMarker.state -in @('IN_PROGRESS', 'INSTALLED', 'PRESERVED')
    if ($null -eq $existingService -and [string]$existingMarker.state -ne 'PRESERVED' -and
        -not $repairableMarker) {
        throw 'Existing Identity Agent data root with missing service requires repair mode or a preserved-identity marker'
    }
}
if (-not $PSCmdlet.ShouldProcess($InstallRoot, 'Install isolated Identity Agent runtime and automatic service')) {
    return
}

try {
    New-Item -ItemType Directory -Path $ConfigurationRoot -Force | Out-Null
    $inProgressSettings = [ordered]@{
        schemaVersion = 1
        state = 'IN_PROGRESS'
        serviceName = $ServiceName
        serviceAccount = $ServiceAccount
        sourceSha256 = $actualSha
        installRoot = [IO.Path]::GetFullPath($InstallRoot)
        dataRoot = [IO.Path]::GetFullPath($DataRoot)
        configurationRoot = [IO.Path]::GetFullPath($ConfigurationRoot)
        evidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
        configurationFile = [IO.Path]::GetFullPath($installedConfiguration)
        keyFileName = 'machine-identity.dpapi'
        browserListener = '127.0.0.1:8078'
        startupType = 'Automatic'
    }
    $inProgressSettings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
}
catch {
    if (-not $configurationRootExisted -and (Test-Path -LiteralPath $ConfigurationRoot -PathType Container)) {
        Remove-Item -LiteralPath $ConfigurationRoot -Recurse -Force
    }
    throw
}

$venvRoot = Join-Path $InstallRoot '.venv'
$python = Join-Path $venvRoot 'Scripts\python.exe'
$runner = Join-Path $InstallRoot 'run_identity_agent.py'
$expectedBinPath = ('"{0}" "{1}" --service' -f $python, $runner)
if ($null -ne $existingService) {
    if ([string]$existingService.StartName -ne $ServiceAccount) {
        throw 'Identity Agent service account mismatch'
    }
    if (-not [string]::Equals(([string]$existingService.PathName).Trim(), $expectedBinPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Identity Agent service executable mismatch'
    }
    if ([string]$existingService.State -ne 'Stopped') {
        Invoke-CheckedExternal sc.exe stop $ServiceName
        $serviceController = Get-Service -Name $ServiceName -ErrorAction Stop
        $serviceController.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
}

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    if ([string]::IsNullOrWhiteSpace($BasePythonPath)) {
        $command = Get-Command py.exe -ErrorAction SilentlyContinue
        if ($null -eq $command) { $command = Get-Command python.exe -ErrorAction SilentlyContinue }
        if ($null -ne $command) { $BasePythonPath = $command.Source }
    }
    if ([string]::IsNullOrWhiteSpace($BasePythonPath)) { throw 'Python was not found; pass -BasePythonPath' }
    $resolvedBasePython = (Resolve-Path -LiteralPath $BasePythonPath).Path
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    if ([IO.Path]::GetFileName($resolvedBasePython) -ieq 'py.exe') {
        & $resolvedBasePython -3.12 -I -m venv $venvRoot
    }
    else { & $resolvedBasePython -I -m venv $venvRoot }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw 'Identity Agent virtual environment creation failed'
    }
}
& $python -I -c "import struct,sys; raise SystemExit(0 if sys.version_info[:2] == (3,12) and struct.calcsize('P') == 8 else 1)"
if ($LASTEXITCODE -ne 0) {
    throw 'Identity Agent requires 64-bit CPython 3.12 for the reviewed Windows wheel lock'
}

New-Item -ItemType Directory -Path $InstallRoot, $ConfigurationRoot, $EvidenceRoot -Force | Out-Null
$installedPackage = Join-Path $InstallRoot 'aegis_identity_agent'
if (Test-Path -LiteralPath $installedPackage) {
    Remove-Item -LiteralPath $installedPackage -Recurse -Force
}
New-Item -ItemType Directory -Path $installedPackage -Force | Out-Null
Get-ChildItem -LiteralPath $identitySource -File -Filter '*.py' | Copy-Item -Destination $installedPackage -Force
Copy-Item -LiteralPath $runnerSource -Destination $InstallRoot -Force
Copy-Item -LiteralPath $requirementsSource -Destination $InstallRoot -Force
Copy-Item -LiteralPath $requirementsLockSource -Destination $InstallRoot -Force

if (-not $SkipDependencyInstall) {
    & $python -I -m pip install --disable-pip-version-check --require-hashes `
        --only-binary=:all: --requirement `
        (Join-Path $InstallRoot 'requirements-identity-agent-windows.lock.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Identity Agent dependency installation failed' }
}
& $python -I -c "import win32service, win32serviceutil, win32event, win32security, win32crypt; print('PYWIN32_IMPORTS=PASS')"
if ($LASTEXITCODE -ne 0) { throw 'Identity Agent pywin32 import validation failed' }

if ($null -ne $caBundleSource) {
    Invoke-AgentCaBundleValidation -PythonPath $python -PackageRoot $InstallRoot -CaBundleSource $caBundleSource
    if (-not [string]::Equals(
            $caBundleSource,
            $managedCaBundlePath,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        $pendingCaBundle = "$managedCaBundlePath.pending"
        if (Test-Path -LiteralPath $pendingCaBundle) {
            Remove-Item -LiteralPath $pendingCaBundle -Force
        }
        Copy-Item -LiteralPath $caBundleSource -Destination $pendingCaBundle
        Move-Item -LiteralPath $pendingCaBundle -Destination $managedCaBundlePath -Force
    }
    $configuration['AEGIS_AGENT_CA_BUNDLE'] = $managedCaBundlePath
}
elseif (Test-Path -LiteralPath $managedCaBundlePath) {
    Remove-Item -LiteralPath $managedCaBundlePath -Force
}
Invoke-AgentConfigValidation -PythonPath $python -Values $configuration -PackageRoot $InstallRoot

if ($null -eq $existingService) {
    Invoke-CheckedExternal sc.exe create $ServiceName "binPath= $expectedBinPath" "obj= $ServiceAccount" 'start= auto'
}
else {
    Invoke-CheckedExternal sc.exe config $ServiceName "binPath= $expectedBinPath" "obj= $ServiceAccount" 'start= auto'
}
Invoke-CheckedExternal sc.exe sidtype $ServiceName unrestricted
Invoke-CheckedExternal sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/none/0

Invoke-CheckedExternal icacls.exe $InstallRoot /inheritance:r /grant:r `
    "${ServiceAccount}:(OI)(CI)RX" 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F'
if (-not $dataRootExisted) {
    New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
    Invoke-CheckedExternal icacls.exe $DataRoot /inheritance:r /grant:r "${ServiceAccount}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' /setowner $ServiceAccount
}
Invoke-CheckedExternal icacls.exe $ConfigurationRoot /inheritance:r /grant:r `
    "${ServiceAccount}:(OI)(CI)RX" 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F'
if ($configuration.Contains('AEGIS_AGENT_CA_BUNDLE')) {
    Invoke-CheckedExternal icacls.exe $managedCaBundlePath /inheritance:r /grant:r `
        "${ServiceAccount}:R" 'SYSTEM:F' 'BUILTIN\Administrators:F'
}
Invoke-CheckedExternal icacls.exe $EvidenceRoot /inheritance:r /grant:r "${ServiceAccount}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F'

$configurationLines = $configuration.GetEnumerator() | Sort-Object Key | ForEach-Object { '{0}={1}' -f $_.Key, $_.Value }
$configurationLines | Set-Content -LiteralPath $installedConfiguration -Encoding ASCII
Invoke-CheckedExternal icacls.exe $installedConfiguration /inheritance:r /grant:r `
    "${ServiceAccount}:R" 'SYSTEM:F' 'BUILTIN\Administrators:F'
$serviceEnvironment = @($configuration.GetEnumerator() | Sort-Object Key | ForEach-Object { '{0}={1}' -f $_.Key, $_.Value })
New-ItemProperty -Path $serviceRegistryPath -Name Environment -PropertyType MultiString -Value $serviceEnvironment -Force | Out-Null

$aclValidator = Join-Path $PSScriptRoot 'invoke_acl_validation.ps1'
$aclValidationOutput = @(& $aclValidator -InstallRoot $InstallRoot -DataRoot $DataRoot `
        -ConfigurationRoot $ConfigurationRoot -EvidenceRoot $EvidenceRoot -Confirm:$false)
if ('ACL_VALIDATION=PASS' -notin $aclValidationOutput) {
    throw 'Identity Agent data-root ACL validation did not pass under the service identity'
}

$settings = [ordered]@{
    schemaVersion = 1
    state = 'INSTALLED'
    serviceName = $ServiceName
    serviceAccount = $ServiceAccount
    sourceSha256 = $actualSha
    installRoot = [IO.Path]::GetFullPath($InstallRoot)
    dataRoot = [IO.Path]::GetFullPath($DataRoot)
    configurationRoot = [IO.Path]::GetFullPath($ConfigurationRoot)
    evidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot)
    configurationFile = [IO.Path]::GetFullPath($installedConfiguration)
    keyFileName = 'machine-identity.dpapi'
    browserListener = '127.0.0.1:8078'
    startupType = 'Automatic'
}
$settings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
Invoke-CheckedExternal icacls.exe $settingsPath /inheritance:r /grant:r `
    "${ServiceAccount}:R" 'SYSTEM:F' 'BUILTIN\Administrators:F'

if ($StartNow) {
    Start-Service -Name $ServiceName
    $serviceController = Get-Service -Name $ServiceName -ErrorAction Stop
    $serviceController.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
}

'SERVICE_NAME=AEGISIdentityAgent'
'SERVICE_ACCOUNT=NT SERVICE\AEGISIdentityAgent'
'SERVICE_START_MODE=Automatic'
"SERVICE_STARTED=$(if ($StartNow) { 'YES' } else { 'NO' })"
'LOOPBACK_BIND=127.0.0.1:8078'
'CAMERA_DEMAND_CREATED=NO'
'DPAPI_PREFLIGHT_REQUIRED=YES'
