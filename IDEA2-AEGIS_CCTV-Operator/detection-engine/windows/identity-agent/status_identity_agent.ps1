[CmdletBinding()]
param(
    [string]$ServiceName = 'AEGISIdentityAgent',
    [string]$InstallRoot = "$env:ProgramFiles\AEGIS\IdentityAgent",
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent",
    [string]$ConfigurationRoot = "$env:ProgramData\AEGIS\IdentityAgentConfiguration",
    [string]$EvidenceRoot = "$env:ProgramData\AEGIS\IdentityAgentProvisioning",
    [string]$EngineRuntimeRoot = "$env:LOCALAPPDATA\AEGIS\DetectionEngine",
    [string]$TunnelTaskName = 'AEGIS Detection Tunnel'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$safetyScript = Join-Path $PSScriptRoot 'identity_agent_safety.ps1'
. $safetyScript
Assert-IdentityAgentServiceName -ServiceName $ServiceName
$managedRoots = Assert-IdentityAgentManagedRoots -InstallRoot $InstallRoot -DataRoot $DataRoot `
    -ConfigurationRoot $ConfigurationRoot -EvidenceRoot $EvidenceRoot
$InstallRoot = $managedRoots.installRoot
$DataRoot = $managedRoots.dataRoot
$ConfigurationRoot = $managedRoots.configurationRoot
$EvidenceRoot = $managedRoots.evidenceRoot
$ServiceAccount = 'NT SERVICE\AEGISIdentityAgent'
$configurationPath = Join-Path $ConfigurationRoot 'agent.env'
$keyPath = Join-Path $DataRoot 'machine-identity.dpapi'
$settingsPath = Join-Path $ConfigurationRoot 'install.json'
$expectedPython = Join-Path $InstallRoot '.venv\Scripts\python.exe'
$expectedRunner = Join-Path $InstallRoot 'run_identity_agent.py'
$expectedBinPath = ('"{0}" "{1}" --service' -f $expectedPython, $expectedRunner)
$markerState = try {
    $marker = Assert-IdentityAgentInstallationMarker -ConfigurationRoot $ConfigurationRoot `
        -InstallRoot $InstallRoot -DataRoot $DataRoot -EvidenceRoot $EvidenceRoot -ServiceName $ServiceName
    if ([string]$marker.state -eq 'INSTALLED') { 'VALID' } else { [string]$marker.state }
}
catch { 'MISCONFIGURED' }

function Test-LocalLoopbackListener {
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [Parameter(Mandatory = $true)][uint32]$ExpectedProcessId
    )
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { return 'STOPPED' }
    if ($ExpectedProcessId -eq 0 -or @($listeners | Where-Object {
                $_.LocalAddress -ne '127.0.0.1' -or
                [uint32]$_.OwningProcess -ne $ExpectedProcessId
            }).Count -gt 0) {
        return 'MISCONFIGURED'
    }
    return 'RUNNING'
}

function Get-ProtectedFilePresence {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($item.PSIsContainer) { return 'MISCONFIGURED' }
        return 'PRESENT'
    }
    catch [System.UnauthorizedAccessException] { return 'REQUIRES_ELEVATION' }
    catch [System.Management.Automation.ItemNotFoundException] { return 'MISSING' }
    catch { return 'DEGRADED' }
}

function Test-AgentConfiguration {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$PythonPath,
        [Parameter(Mandatory = $true)][string]$PackageRoot
    )

    $presence = Get-ProtectedFilePresence -Path $Path
    if ($presence -ne 'PRESENT') { return $presence }
    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { return 'DEGRADED' }
    try {
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
            'AEGIS_AGENT_ENGINE_STREAM_URL', 'AEGIS_AGENT_KEY_PATH',
            'AEGIS_AGENT_CONFIGURATION_ROOT'
        )
        $values = [ordered]@{}
        foreach ($line in Get-Content -LiteralPath $Path -ErrorAction Stop) {
            $trimmed = $line.Trim()
            if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
            if ($trimmed -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') { return 'MISCONFIGURED' }
            $name = $Matches[1]
            $value = $Matches[2].Trim().Trim('"').Trim("'")
            if ($name -notin $allowed -or $values.Contains($name)) {
                return 'MISCONFIGURED'
            }
            if ([string]::IsNullOrWhiteSpace($value)) {
                if ($name -eq 'AEGIS_AGENT_CA_BUNDLE') { continue }
                return 'MISCONFIGURED'
            }
            $values[$name] = $value
        }
        if (@($required | Where-Object { -not $values.Contains($_) }).Count -gt 0) {
            return 'MISCONFIGURED'
        }
        if (-not [string]::Equals(
                [IO.Path]::GetFullPath([string]$values['AEGIS_AGENT_KEY_PATH']),
                [IO.Path]::GetFullPath($keyPath),
                [StringComparison]::OrdinalIgnoreCase
            )) {
            return 'MISCONFIGURED'
        }

        $saved = @{}
        $names = @($allowed) + @('PYTHONPATH')
        foreach ($name in $names) {
            $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        }
        try {
            foreach ($name in $allowed) {
                [Environment]::SetEnvironmentVariable($name, $null, 'Process')
            }
            foreach ($entry in $values.GetEnumerator()) {
                [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
            }
            [Environment]::SetEnvironmentVariable('PYTHONPATH', $PackageRoot, 'Process')
            $null = & $PythonPath -c 'from aegis_identity_agent.config import AgentConfig; AgentConfig.from_env()' 2>&1
            if ($LASTEXITCODE -ne 0) { return 'MISCONFIGURED' }
        }
        finally {
            foreach ($name in $names) {
                [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
            }
        }
        return 'VALID'
    }
    catch [System.UnauthorizedAccessException] { return 'REQUIRES_ELEVATION' }
    catch { return 'DEGRADED' }
}

function Get-AgentCaBundleStatus {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$ConfigurationState
    )
    $presence = Get-ProtectedFilePresence -Path $Path
    if ($presence -eq 'REQUIRES_ELEVATION') {
        return [pscustomobject]@{ state = 'REQUIRES_ELEVATION'; valid = 'UNKNOWN' }
    }
    if ($presence -ne 'PRESENT') {
        return [pscustomobject]@{ state = 'MISSING'; valid = 'NO' }
    }
    try {
        $matches = @(Get-Content -LiteralPath $Path -ErrorAction Stop | Where-Object {
                $_.Trim() -match '^AEGIS_AGENT_CA_BUNDLE='
            })
        if ($matches.Count -eq 0) {
            $valid = if ($ConfigurationState -eq 'VALID') { 'YES' } else { 'NO' }
            return [pscustomobject]@{ state = 'DEFAULT'; valid = $valid }
        }
        if ($matches.Count -ne 1) {
            return [pscustomobject]@{ state = 'INVALID'; valid = 'NO' }
        }
        $bundlePath = ($matches[0] -replace '^AEGIS_AGENT_CA_BUNDLE=', '').Trim().Trim('"').Trim("'")
        if ([string]::IsNullOrWhiteSpace($bundlePath)) {
            $valid = if ($ConfigurationState -eq 'VALID') { 'YES' } else { 'NO' }
            return [pscustomobject]@{ state = 'DEFAULT'; valid = $valid }
        }
        try {
            $item = Get-Item -LiteralPath $bundlePath -Force -ErrorAction Stop
        }
        catch [System.UnauthorizedAccessException] {
            return [pscustomobject]@{ state = 'REQUIRES_ELEVATION'; valid = 'UNKNOWN' }
        }
        catch [System.Management.Automation.ItemNotFoundException] {
            return [pscustomobject]@{ state = 'MISSING'; valid = 'NO' }
        }
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            return [pscustomobject]@{ state = 'INVALID'; valid = 'NO' }
        }
        $valid = if ($ConfigurationState -eq 'VALID') { 'YES' } else { 'NO' }
        return [pscustomobject]@{ state = 'MANAGED'; valid = $valid }
    }
    catch [System.UnauthorizedAccessException] {
        return [pscustomobject]@{ state = 'REQUIRES_ELEVATION'; valid = 'UNKNOWN' }
    }
    catch {
        return [pscustomobject]@{ state = 'INVALID'; valid = 'NO' }
    }
}

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
$serviceState = if ($null -eq $service) { 'NOT_INSTALLED' } elseif ($service.State -eq 'Running') { 'RUNNING' } else { 'STOPPED' }
$serviceStartup = if ($null -eq $service) {
    'NOT_INSTALLED'
}
elseif ($service.StartMode -eq 'Auto') {
    'AUTOMATIC'
}
else { 'MISCONFIGURED' }
$serviceIdentity = if ($null -eq $service) {
    'NOT_INSTALLED'
}
elseif ([string]$service.StartName -eq $ServiceAccount) {
    'VALID'
}
else { 'MISCONFIGURED' }
$serviceExecutable = if ($null -eq $service) {
    'NOT_INSTALLED'
}
elseif ([string]::Equals(([string]$service.PathName).Trim(), $expectedBinPath, [StringComparison]::OrdinalIgnoreCase)) {
    'VALID'
}
else { 'MISCONFIGURED' }

$configState = Test-AgentConfiguration -Path $configurationPath `
    -PythonPath $expectedPython -PackageRoot $InstallRoot
$caBundleStatus = Get-AgentCaBundleStatus -Path $configurationPath `
    -ConfigurationState $configState

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$engineRun = Get-ItemPropertyValue -Path $runKey -Name 'AEGIS Detection Engine' -ErrorAction SilentlyContinue
$engineSettingsPath = Join-Path $EngineRuntimeRoot 'install.json'
$engineSettings = if (Test-Path -LiteralPath $engineSettingsPath -PathType Leaf) {
    Get-Content -LiteralPath $engineSettingsPath -Raw | ConvertFrom-Json
}
else { $null }
$runtimeApp = Join-Path $EngineRuntimeRoot 'app'
$runtimePython = Join-Path $EngineRuntimeRoot '.venv\Scripts\python.exe'
$engineSupervisor = Join-Path $runtimeApp 'windows\run_engine_supervisor.ps1'
$windowsPowerShell = (Get-Command powershell.exe -ErrorAction SilentlyContinue).Source
$enginePort = if ($null -ne $engineSettings) { [int]$engineSettings.enginePort } else { 8077 }
$expectedEngineCommand = if (-not [string]::IsNullOrWhiteSpace($windowsPowerShell)) {
    "`"$windowsPowerShell`" -NoProfile -NonInteractive -WindowStyle Hidden " +
        "-ExecutionPolicy Bypass -File `"$engineSupervisor`" " +
        "-EngineRoot `"$runtimeApp`" -PythonPath `"$runtimePython`" -ApiPort $enginePort"
}
else { '' }
$engineCommandState = if (-not [string]::IsNullOrWhiteSpace([string]$engineRun) -and
    [string]::Equals([string]$engineRun, $expectedEngineCommand, [StringComparison]::OrdinalIgnoreCase)) {
    'VALID'
}
else { 'MISCONFIGURED' }
$engineTask = Get-ScheduledTask -TaskName 'AEGIS Detection Engine' -ErrorAction SilentlyContinue
$engineService = Get-CimInstance Win32_Service -Filter "Name='AEGIS Detection Engine'" -ErrorAction SilentlyContinue
$enabledEngineTask = $null -ne $engineTask -and [string]$engineTask.State -ne 'Disabled'
$engineOwnerCount = @(
    -not [string]::IsNullOrWhiteSpace([string]$engineRun),
    $enabledEngineTask,
    $null -ne $engineService
) | Where-Object { $_ } | Measure-Object | Select-Object -ExpandProperty Count
$engineOwner = if ($engineOwnerCount -gt 1) {
    'CONFLICT'
}
elseif ($engineOwnerCount -eq 0) {
    'MISSING'
}
elseif ($engineOwnerCount -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$engineRun)) {
    'HKCU_RUN'
}
else { 'MISCONFIGURED' }
$tunnelTask = Get-ScheduledTask -TaskName $TunnelTaskName -ErrorAction SilentlyContinue
$tunnelState = if ($null -eq $tunnelTask) { 'NOT_INSTALLED' } else { [string]$tunnelTask.State.ToString().ToUpperInvariant() }
$tunnelPrincipal = if ($null -eq $tunnelTask) {
    'NOT_INSTALLED'
}
elseif ([string]$tunnelTask.Principal.UserId -in @('SYSTEM', 'NT AUTHORITY\SYSTEM')) {
    'SYSTEM'
}
else { 'MISCONFIGURED' }
$tunnelActionState = 'MISCONFIGURED'
$monitorForwardHealth = 'UNREACHABLE'
if ($null -ne $tunnelTask -and $null -ne $engineSettings -and $tunnelTask.Actions.Count -eq 1) {
    $action = $tunnelTask.Actions[0]
    $tunnelRunner = Join-Path $runtimeApp 'windows\run_detection_tunnel.ps1'
    $runtimeIdentity = Join-Path (Join-Path $EngineRuntimeRoot 'ssh') ([string]$engineSettings.identityFileName)
    $runtimeKnownHosts = Join-Path (Join-Path $EngineRuntimeRoot 'ssh') 'known_hosts'
    $expectedArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ' +
        "-File `"$tunnelRunner`" -TunnelHost `"$($engineSettings.tunnelHost)`" " +
        "-IdentityFile `"$runtimeIdentity`" -KnownHostsFile `"$runtimeKnownHosts`" " +
        "-RuntimeRoot `"$EngineRuntimeRoot`" " +
        "-MonitorTargetHost `"$($engineSettings.monitorTargetHost)`" -MonitorTargetPort $($engineSettings.monitorTargetPort) " +
        "-LocalForwardPort $($engineSettings.localForwardPort) -RemoteBindAddress `"$($engineSettings.remoteBindAddress)`" " +
        "-RemotePort $($engineSettings.remotePort) -EnginePort $($engineSettings.enginePort)"
    if ([string]::Equals([string]$action.Execute, $windowsPowerShell, [StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string]$action.Arguments, $expectedArguments, [StringComparison]::Ordinal) -and
        [string]::Equals([string]$action.WorkingDirectory, $runtimeApp, [StringComparison]::OrdinalIgnoreCase)) {
        $tunnelActionState = 'VALID'
    }
    try {
        $forwardHealth = Invoke-RestMethod -Uri "http://127.0.0.1:$([int]$engineSettings.localForwardPort)/healthz" `
            -Method Get -TimeoutSec 5
        if ($forwardHealth.ok -eq $true) { $monitorForwardHealth = 'HEALTHY' }
    }
    catch { $monitorForwardHealth = 'UNREACHABLE' }
}
$tunnelTrigger = if ($null -eq $tunnelTask) {
    'NOT_INSTALLED'
}
elseif (@($tunnelTask.Triggers | Where-Object {
            $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger' -and $_.Enabled
        }).Count -eq 1) {
    'AT_STARTUP'
}
else { 'MISCONFIGURED' }
$serviceProcessId = if ($null -eq $service) { [uint32]0 } else { [uint32]$service.ProcessId }
$loopback = Test-LocalLoopbackListener -Port 8078 -ExpectedProcessId $serviceProcessId
$keyState = 'NOT_ATTESTED'
$keyAcl = 'NOT_ATTESTED'
$dataRootAcl = 'NOT_ATTESTED'
if ($serviceState -eq 'RUNNING' -and $loopback -eq 'RUNNING' -and
    $serviceIdentity -eq 'VALID' -and $serviceExecutable -eq 'VALID') {
    try {
        $attestation = Invoke-RestMethod -Uri 'http://127.0.0.1:8078/v1/health/key-store' `
            -Method Get -TimeoutSec 5
        if ($attestation.status -eq 'ok' -and
            [uint32]$attestation.processId -eq $serviceProcessId -and
            $attestation.keyState -eq 'PRESENT' -and
            $attestation.keyAcl -eq 'VALID' -and
            $attestation.dataRootAcl -eq 'VALID' -and
            $attestation.privateKeyRead -eq $false) {
            $keyState = 'PRESENT_SERVICE_ATTESTED'
            $keyAcl = 'SERVICE_ATTESTED'
            $dataRootAcl = 'SERVICE_ATTESTED'
        }
    }
    catch {
        $keyState = 'NOT_ATTESTED'
        $keyAcl = 'NOT_ATTESTED'
        $dataRootAcl = 'NOT_ATTESTED'
    }
}

$installationState = if ($null -eq $service -and -not (Test-Path -LiteralPath $InstallRoot)) {
    'NOT_INSTALLED'
}
elseif ($null -eq $service -or -not (Test-Path -LiteralPath $expectedPython) -or $markerState -ne 'VALID') {
    'DEGRADED'
}
elseif ($configState -in @('REQUIRES_ELEVATION', 'DEGRADED')) {
    'DEGRADED'
}
elseif ($serviceIdentity -ne 'VALID' -or $serviceExecutable -ne 'VALID' -or
    $serviceStartup -ne 'AUTOMATIC' -or $configState -ne 'VALID') {
    'MISCONFIGURED'
}
else { 'INSTALLED' }

"INSTALLATION_STATE=$installationState"
"SERVICE_STATE=$serviceState"
"SERVICE_STARTUP=$serviceStartup"
"SERVICE_IDENTITY=$serviceIdentity"
"SERVICE_EXECUTABLE=$serviceExecutable"
"LOOPBACK_8078=$loopback"
"CONFIGURATION_STATE=$configState"
"AGENT_CA_BUNDLE_STATE=$($caBundleStatus.state)"
"AGENT_CA_BUNDLE_VALID=$($caBundleStatus.valid)"
"IDENTITY_KEY_STATE=$keyState"
"IDENTITY_KEY_ACL=$keyAcl"
"IDENTITY_DATA_ROOT_ACL=$dataRootAcl"
"ENGINE_STARTUP_OWNER=$engineOwner"
"ENGINE_STARTUP_COMMAND=$engineCommandState"
"TUNNEL_TASK_STATE=$tunnelState"
"TUNNEL_TASK_PRINCIPAL=$tunnelPrincipal"
"TUNNEL_TASK_TRIGGER=$tunnelTrigger"
"TUNNEL_TASK_ACTION=$tunnelActionState"
"MONITOR_FORWARD_HEALTH=$monitorForwardHealth"
'PRIVATE_KEY_EXPOSED=NO'
'CAMERA_DEMAND_CREATED=NO'
