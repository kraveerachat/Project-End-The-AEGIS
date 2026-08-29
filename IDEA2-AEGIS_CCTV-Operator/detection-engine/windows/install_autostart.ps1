[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AEGIS\DetectionEngine'),
    [string]$ConfigurationFile = '',
    [string]$BasePythonPath = '',
    [string]$TunnelHost = '',
    [string]$IdentityFile = '',
    [string]$KnownHostsFile = '',
    [string]$TunnelTaskName = 'AEGIS Detection Tunnel',
    [string]$LegacyEngineTaskName = 'AEGIS Detection Engine',
    [string]$MonitorTargetHost = '172.18.0.2',
    [ValidateRange(1, 65535)]
    [int]$MonitorTargetPort = 8002,
    [ValidateRange(1, 65535)]
    [int]$LocalForwardPort = 18002,
    [string]$RemoteBindAddress = '172.18.0.1',
    [ValidateRange(1, 65535)]
    [int]$RemotePort = 18077,
    [ValidateRange(1, 65535)]
    [int]$EnginePort = 8077,
    [switch]$SkipDependencyInstall,
    [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'The IDEA2 Detection Laptop installer can only run on Windows.'
}

function Resolve-OptionalFile {
    param([string]$Path, [string]$Label)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return ''
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Label not found: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Copy-MachineFile {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $resolvedSource = [IO.Path]::GetFullPath($Source)
    $resolvedDestination = [IO.Path]::GetFullPath($Destination)
    if ([string]::Equals(
            $resolvedSource,
            $resolvedDestination,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        return
    }
    Copy-Item -LiteralPath $resolvedSource -Destination $resolvedDestination -Force
}

function Invoke-IcaclsMutation {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Operation
    )

    & icacls.exe $Path @Arguments | Out-Null
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "Private-key ACL mutation failed during $Operation (icacls exit $exitCode)."
    }
}

function Assert-RuntimePrivateKeyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $administratorsSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $allowedSids = @($systemSid.Value, $administratorsSid.Value)
    $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
    $allow = [Security.AccessControl.AccessControlType]::Allow

    $verifiedAcl = Get-Acl -LiteralPath $Path
    $ownerSid = $verifiedAcl.GetOwner(
        [Security.Principal.SecurityIdentifier]
    ).Value
    if ($ownerSid -ne $systemSid.Value) {
        throw "Private-key ACL verification failed: owner is $ownerSid, expected SYSTEM."
    }
    if (-not $verifiedAcl.AreAccessRulesProtected) {
        throw 'Private-key ACL verification failed: inheritance is still enabled.'
    }

    $verifiedRules = @($verifiedAcl.GetAccessRules(
            $true,
            $true,
            [Security.Principal.SecurityIdentifier]
        ))
    foreach ($requiredSid in $allowedSids) {
        $hasFullControl = @($verifiedRules | Where-Object {
                $_.IdentityReference.Value -eq $requiredSid -and
                $_.AccessControlType -eq $allow -and
                -not $_.IsInherited -and
                ($_.FileSystemRights -band $fullControl) -eq $fullControl
            }).Count -gt 0
        if (-not $hasFullControl) {
            throw "Private-key ACL verification failed: $requiredSid lacks explicit FullControl."
        }
    }

    $sensitiveRights = [Security.AccessControl.FileSystemRights]::Read -bor
        [Security.AccessControl.FileSystemRights]::Write -bor
        [Security.AccessControl.FileSystemRights]::Modify -bor
        [Security.AccessControl.FileSystemRights]::FullControl
    $unexpectedAllows = @($verifiedRules | Where-Object {
            $_.AccessControlType -eq $allow -and
            $allowedSids -notcontains $_.IdentityReference.Value -and
            ($_.FileSystemRights -band $sensitiveRights) -ne 0
        })
    if ($unexpectedAllows.Count -gt 0) {
        $unexpectedSids = @($unexpectedAllows | ForEach-Object {
                $_.IdentityReference.Value
            }) -join ', '
        throw "Private-key ACL verification failed: unexpected Allow identity $unexpectedSids."
    }

    $nonContractRules = @($verifiedRules | Where-Object {
            $allowedSids -notcontains $_.IdentityReference.Value -or
            $_.AccessControlType -ne $allow -or
            $_.IsInherited -or
            ($_.FileSystemRights -band $fullControl) -ne $fullControl
        })
    if ($nonContractRules.Count -gt 0 -or $verifiedRules.Count -ne $allowedSids.Count) {
        throw 'Private-key ACL verification failed: DACL contains a non-contract access rule.'
    }
}

function Set-RuntimePrivateKeyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $administratorsSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $allowedSids = @($systemSid.Value, $administratorsSid.Value)
    $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
    $allow = [Security.AccessControl.AccessControlType]::Allow

    # Build an exact protected DACL. SYSTEM runs the boot tunnel, while the
    # local Administrators group must retain FullControl so an elevated repair
    # can rotate/re-harden the runtime key. No interactive Users, Authenticated
    # Users, Everyone, or source-file identity is retained.
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    $existingRules = @($acl.GetAccessRules(
            $true,
            $true,
            [Security.Principal.SecurityIdentifier]
        ))
    foreach ($rule in $existingRules) {
        [void]$acl.RemoveAccessRuleSpecific($rule)
    }
    $acl.SetOwner($systemSid)
    [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
                $systemSid,
                $fullControl,
                $allow
            )))
    [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
                $administratorsSid,
                $fullControl,
                $allow
            )))
    Set-Acl -LiteralPath $Path -AclObject $acl

    # Keep every native mutation independently fail-closed. A later successful
    # icacls command must never hide an earlier failure.
    Invoke-IcaclsMutation -Path $Path -Arguments @('/inheritance:r') `
        -Operation 'disabling inheritance'
    Invoke-IcaclsMutation -Path $Path -Arguments @(
        '/grant:r',
        '*S-1-5-18:(F)',
        '*S-1-5-32-544:(F)'
    ) -Operation 'granting SYSTEM and Administrators FullControl'
    Invoke-IcaclsMutation -Path $Path -Arguments @('/setowner', '*S-1-5-18') `
        -Operation 'setting the owner to SYSTEM'

    # Verify the effective contract with PowerShell ACL APIs instead of
    # trusting command exit codes alone.
    Assert-RuntimePrivateKeyAcl -Path $Path
}

function Get-DotEnvKeys {
    param([Parameter(Mandatory = $true)][string]$Path)

    $keys = @{}
    foreach ($line in Get-Content -LiteralPath $Path) {
        if ($line -match '^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
            $value = $Matches[2].Trim().Trim('"').Trim("'")
            $isPlaceholder = $value.StartsWith('<') -or
                $value -match '^(CHANGE_ME|CHANGEME|REPLACE_ME)$'
            $keys[$Matches[1]] = -not [string]::IsNullOrWhiteSpace($value) -and
                -not $isPlaceholder
        }
    }
    return $keys
}

$sourceEngineRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$resolvedRuntimeRoot = [IO.Path]::GetFullPath($RuntimeRoot)
$runtimeApp = Join-Path $resolvedRuntimeRoot 'app'
$runtimeVenv = Join-Path $resolvedRuntimeRoot '.venv'
$runtimePython = Join-Path $runtimeVenv 'Scripts\python.exe'
$runtimeSsh = Join-Path $resolvedRuntimeRoot 'ssh'
$runtimeLogs = Join-Path $resolvedRuntimeRoot 'logs'
$runtimeEnv = Join-Path $runtimeApp '.env'
$runtimeIdentity = Join-Path $runtimeSsh 'idea2_tunnel_ed25519'
$runtimeKnownHosts = Join-Path $runtimeSsh 'known_hosts'
$settingsPath = Join-Path $resolvedRuntimeRoot 'install.json'

$previousSettings = $null
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    try {
        $previousSettings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Existing installer settings are invalid: $settingsPath"
    }
}
if ([string]::IsNullOrWhiteSpace($TunnelHost) -and $null -ne $previousSettings) {
    $TunnelHost = [string]$previousSettings.tunnelHost
}
if ($null -ne $previousSettings -and
    $previousSettings.PSObject.Properties.Name -contains 'identityFileName') {
    $runtimeIdentity = Join-Path $runtimeSsh ([string]$previousSettings.identityFileName)
}
elseif (-not (Test-Path -LiteralPath $runtimeIdentity -PathType Leaf)) {
    $legacyRuntimeIdentity = Join-Path $runtimeSsh 'idea2_tunnel_autostart_ed25519'
    if (Test-Path -LiteralPath $legacyRuntimeIdentity -PathType Leaf) {
        $runtimeIdentity = $legacyRuntimeIdentity
    }
}
if ($TunnelHost -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$') {
    throw 'TunnelHost is required and must use user@host without spaces or shell characters.'
}
if ($MonitorTargetHost -notmatch '^[A-Za-z0-9._:-]+$') {
    throw 'MonitorTargetHost contains unsupported characters.'
}
$parsedRemoteAddress = $null
if (-not [Net.IPAddress]::TryParse($RemoteBindAddress, [ref]$parsedRemoteAddress)) {
    throw 'RemoteBindAddress must be a literal IP address.'
}

$resolvedConfiguration = Resolve-OptionalFile -Path $ConfigurationFile -Label 'Configuration file'
$resolvedIdentitySource = Resolve-OptionalFile -Path $IdentityFile -Label 'SSH identity file'
$resolvedKnownHostsSource = Resolve-OptionalFile -Path $KnownHostsFile -Label 'known_hosts file'

if (-not $PSCmdlet.ShouldProcess($resolvedRuntimeRoot, 'Install portable IDEA2 Detection Laptop runtime and auto-start')) {
    return
}

$currentPrincipal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer from an elevated Windows PowerShell session (Run as administrator).'
}

New-Item -ItemType Directory -Force -Path $runtimeApp, $runtimeSsh, $runtimeLogs | Out-Null

# Copy only durable application source. Machine configuration, recordings,
# snapshots, caches, and local environments are deliberately excluded.
$excludedNames = @('.env', '.venv', 'venv', 'segments', 'snapshots', '__pycache__', '.git')
foreach ($item in Get-ChildItem -LiteralPath $sourceEngineRoot -Force) {
    if ($excludedNames -contains $item.Name) {
        continue
    }
    $runtimeItem = Join-Path $runtimeApp $item.Name
    if ([string]::Equals(
            [IO.Path]::GetFullPath($item.FullName),
            [IO.Path]::GetFullPath($runtimeItem),
            [StringComparison]::OrdinalIgnoreCase
        )) {
        continue
    }
    Copy-Item -LiteralPath $item.FullName -Destination $runtimeApp -Recurse -Force
}

if (-not [string]::IsNullOrWhiteSpace($resolvedConfiguration)) {
    Copy-MachineFile -Source $resolvedConfiguration -Destination $runtimeEnv
}
elseif (-not (Test-Path -LiteralPath $runtimeEnv -PathType Leaf)) {
    Copy-Item -LiteralPath (Join-Path $runtimeApp '.env.example') -Destination $runtimeEnv
    throw "A secret-free template was created at $runtimeEnv. Configure it, then rerun the installer."
}

$dotenvKeys = Get-DotEnvKeys -Path $runtimeEnv
$requiredIntegrationKeys = @(
    'AEGIS_MONITOR_API_BASE',
    'AEGIS_DETECTION_ENGINE_API_KEY',
    'AEGIS_STREAM_PUBLIC_URL'
)
$missingIntegrationKeys = @($requiredIntegrationKeys | Where-Object {
    -not $dotenvKeys.ContainsKey($_) -or -not $dotenvKeys[$_]
})
if ($missingIntegrationKeys.Count -gt 0) {
    throw 'Runtime .env is missing one or more required Monitor integration settings. Values were not printed.'
}

if (-not [string]::IsNullOrWhiteSpace($resolvedIdentitySource)) {
    Copy-MachineFile -Source $resolvedIdentitySource -Destination $runtimeIdentity
}
elseif (-not (Test-Path -LiteralPath $runtimeIdentity -PathType Leaf)) {
    throw 'Provide a unique per-machine -IdentityFile. The key is copied into the runtime and is never committed.'
}

if (-not [string]::IsNullOrWhiteSpace($resolvedKnownHostsSource)) {
    Copy-MachineFile -Source $resolvedKnownHostsSource -Destination $runtimeKnownHosts
}
elseif (-not (Test-Path -LiteralPath $runtimeKnownHosts -PathType Leaf)) {
    throw 'Provide a verified -KnownHostsFile. Strict host-key checking is mandatory.'
}

if (-not (Test-Path -LiteralPath $runtimePython -PathType Leaf)) {
    if ([string]::IsNullOrWhiteSpace($BasePythonPath)) {
        $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($null -ne $pythonCommand) {
            $BasePythonPath = $pythonCommand.Source
        }
        else {
            $pythonCommand = Get-Command py.exe -ErrorAction SilentlyContinue
            if ($null -ne $pythonCommand) {
                $BasePythonPath = $pythonCommand.Source
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($BasePythonPath)) {
        throw 'Python was not found. Install Python 3 or pass -BasePythonPath.'
    }
    $resolvedBasePython = Resolve-OptionalFile -Path $BasePythonPath -Label 'Base Python executable'
    if ([IO.Path]::GetFileName($resolvedBasePython) -ieq 'py.exe') {
        & $resolvedBasePython -3 -m venv $runtimeVenv
    }
    else {
        & $resolvedBasePython -m venv $runtimeVenv
    }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $runtimePython -PathType Leaf)) {
        throw 'Failed to create the runtime-local Python environment.'
    }
}

if (-not $SkipDependencyInstall) {
    & $runtimePython -m pip install --disable-pip-version-check --requirement `
        (Join-Path $runtimeApp 'requirements.txt')
    if ($LASTEXITCODE -ne 0) {
        throw 'Dependency installation failed.'
    }
}

Push-Location -LiteralPath $runtimeApp
try {
    & $runtimePython -c "from aegis_engine.config import EngineConfig; EngineConfig.from_env().validate(); from aegis_engine.engine import DetectionEngine; print('AEGIS Windows preflight passed')"
    if ($LASTEXITCODE -ne 0) {
        throw 'Detection Engine preflight failed.'
    }
}
finally {
    Pop-Location
}

# Harden and verify only the runtime copy. The source key passed through
# -IdentityFile is never given to the ACL function.
Set-RuntimePrivateKeyAcl -Path $runtimeIdentity

$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$engineSupervisor = Join-Path $runtimeApp 'windows\run_engine_supervisor.ps1'
$engineCommand = "`"$windowsPowerShell`" -NoProfile -NonInteractive -WindowStyle Hidden " +
    "-ExecutionPolicy Bypass -File `"$engineSupervisor`" " +
    "-EngineRoot `"$runtimeApp`" -PythonPath `"$runtimePython`" -ApiPort $EnginePort"
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
New-Item -Path $runKey -Force | Out-Null
New-ItemProperty -Path $runKey -Name 'AEGIS Detection Engine' `
    -Value $engineCommand -PropertyType String -Force | Out-Null

# Keep the old task as rollback evidence but prevent the unreliable interactive
# wrapper from racing the HKCU supervisor.
$legacyTask = Get-ScheduledTask -TaskName $LegacyEngineTaskName -ErrorAction SilentlyContinue
if ($null -ne $legacyTask -and $legacyTask.State -ne 'Disabled') {
    if ($legacyTask.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $LegacyEngineTaskName
    }
    Disable-ScheduledTask -TaskName $LegacyEngineTaskName | Out-Null
}

$tunnelRunner = Join-Path $runtimeApp 'windows\run_detection_tunnel.ps1'
$tunnelArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ' +
    "-File `"$tunnelRunner`" -TunnelHost `"$TunnelHost`" " +
    "-IdentityFile `"$runtimeIdentity`" -KnownHostsFile `"$runtimeKnownHosts`" " +
    "-MonitorTargetHost `"$MonitorTargetHost`" -MonitorTargetPort $MonitorTargetPort " +
    "-LocalForwardPort $LocalForwardPort -RemoteBindAddress `"$RemoteBindAddress`" " +
    "-RemotePort $RemotePort -EnginePort $EnginePort"
$tunnelAction = New-ScheduledTaskAction -Execute $windowsPowerShell `
    -Argument $tunnelArguments -WorkingDirectory $runtimeApp
$tunnelTrigger = New-ScheduledTaskTrigger -AtStartup
$tunnelTrigger.Delay = 'PT30S'
$tunnelPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' `
    -LogonType ServiceAccount -RunLevel Highest
$tunnelSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$tunnelTask = New-ScheduledTask -Action $tunnelAction -Trigger $tunnelTrigger `
    -Principal $tunnelPrincipal -Settings $tunnelSettings `
    -Description 'Maintains the AEGIS IDEA2 SSH tunnel as SYSTEM with automatic reconnect.'
Register-ScheduledTask -TaskName $TunnelTaskName -InputObject $tunnelTask -Force | Out-Null

$settings = [ordered]@{
    schemaVersion = 1
    runtimeRoot = $resolvedRuntimeRoot
    tunnelTaskName = $TunnelTaskName
    legacyEngineTaskName = $LegacyEngineTaskName
    tunnelHost = $TunnelHost
    identityFileName = [IO.Path]::GetFileName($runtimeIdentity)
    monitorTargetHost = $MonitorTargetHost
    monitorTargetPort = $MonitorTargetPort
    localForwardPort = $LocalForwardPort
    remoteBindAddress = $RemoteBindAddress
    remotePort = $RemotePort
    enginePort = $EnginePort
}
$settings | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8

if ($StartNow) {
    Start-ScheduledTask -TaskName $TunnelTaskName
    Start-Process -FilePath $windowsPowerShell -ArgumentList (
        '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ' +
        "-File `"$engineSupervisor`" -EngineRoot `"$runtimeApp`" " +
        "-PythonPath `"$runtimePython`" -StartupDelaySeconds 0 -ApiPort $EnginePort"
    ) -WindowStyle Hidden
}

Write-Host 'AEGIS IDEA2 Detection Laptop installation completed.'
Write-Host "Runtime: $resolvedRuntimeRoot"
Write-Host 'Engine startup: HKCU Run (after user login)'
Write-Host "Tunnel startup: SYSTEM Scheduled Task ($TunnelTaskName)"
Write-Host 'No private-key or .env value was written to repository output.'
