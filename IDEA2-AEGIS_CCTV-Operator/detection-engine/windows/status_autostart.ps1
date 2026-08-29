[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AEGIS\DetectionEngine'),
    [string]$TunnelTaskName = 'AEGIS Detection Tunnel',
    [int]$LogTail = 30,
    [switch]$SkipHealthRequests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$runtimeApp = Join-Path $RuntimeRoot 'app'
$settingsPath = Join-Path $RuntimeRoot 'install.json'
$settings = $null
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if ($settings.PSObject.Properties.Name -contains 'tunnelTaskName') {
        $TunnelTaskName = [string]$settings.tunnelTaskName
    }
}

$enginePort = 8077
$localForwardPort = 18002
if ($null -ne $settings) {
    if ($settings.PSObject.Properties.Name -contains 'enginePort') {
        $enginePort = [int]$settings.enginePort
    }
    if ($settings.PSObject.Properties.Name -contains 'localForwardPort') {
        $localForwardPort = [int]$settings.localForwardPort
    }
}

function Test-LocalTcpPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $client = New-Object Net.Sockets.TcpClient
    try {
        $wait = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        return $wait.AsyncWaitHandle.WaitOne(1000) -and $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Get-HealthResult {
    param([Parameter(Mandatory = $true)][string]$Uri)

    try {
        $response = Invoke-RestMethod -Uri $Uri -Method Get -TimeoutSec 10
        return [pscustomobject]@{
            Uri = $Uri
            Reachable = $true
            Body = ($response | ConvertTo-Json -Compress -Depth 10)
        }
    }
    catch {
        return [pscustomobject]@{
            Uri = $Uri
            Reachable = $false
            Body = $_.Exception.Message
        }
    }
}

function Get-PrivateKeyAclStatus {
    param([Parameter(Mandatory = $true)][string]$Path)

    $status = [ordered]@{
        Exists = $false
        InspectionState = 'Missing'
        OwnerIsSystem = $false
        InheritanceDisabled = $false
        SystemFullControl = $false
        NoDisallowedIdentities = $false
        Valid = $false
    }
    try {
        [void](Get-Item -LiteralPath $Path -Force -ErrorAction Stop)
        $status.Exists = $true
        $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
        $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
        $allow = [Security.AccessControl.AccessControlType]::Allow
        $acl = Get-Acl -LiteralPath $Path
        $rules = @($acl.GetAccessRules(
                $true,
                $true,
                [Security.Principal.SecurityIdentifier]
            ))
        $status.OwnerIsSystem = $acl.GetOwner(
            [Security.Principal.SecurityIdentifier]
        ).Value -eq $systemSid.Value
        $status.InheritanceDisabled = $acl.AreAccessRulesProtected
        $status.SystemFullControl = @($rules | Where-Object {
                $_.IdentityReference.Value -eq $systemSid.Value -and
                $_.AccessControlType -eq $allow -and
                -not $_.IsInherited -and
                ($_.FileSystemRights -band $fullControl) -eq $fullControl
            }).Count -eq 1
        $status.NoDisallowedIdentities = $rules.Count -eq 1 -and
            $rules[0].IdentityReference.Value -eq $systemSid.Value -and
            $rules[0].AccessControlType -eq $allow -and
            -not $rules[0].IsInherited
        $status.Valid = $status.OwnerIsSystem -and
            $status.InheritanceDisabled -and
            $status.SystemFullControl -and
            $status.NoDisallowedIdentities
        $status.InspectionState = if ($status.Valid) { 'Valid' } else { 'Invalid' }
    }
    catch [System.UnauthorizedAccessException] {
        $status.Exists = $true
        $status.InspectionState = 'RequiresElevation'
    }
    catch [System.Management.Automation.ItemNotFoundException] {
        return [pscustomobject]$status
    }
    catch {
        $status.InspectionState = 'Error'
    }
    return [pscustomobject]$status
}

function Get-SshErrorFlags {
    param([Parameter(Mandatory = $true)][string]$LogDirectory)

    $text = @(
        'detection-tunnel-ssh.stderr.log',
        'key-migration-ssh.stderr.log'
    ) | ForEach-Object {
        $path = Join-Path $LogDirectory $_
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue
        }
    }
    $joined = $text -join "`n"
    return [pscustomobject]@{
        UNPROTECTED_PRIVATE_KEY = $joined -match 'UNPROTECTED PRIVATE KEY FILE'
        BAD_PERMISSIONS = $joined -match '(?i)bad permissions'
        PUBLICKEY_DENIED = $joined -match '(?i)Permission denied \(publickey\)'
    }
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runEntry = Get-ItemPropertyValue -Path $runKey -Name 'AEGIS Detection Engine' `
    -ErrorAction SilentlyContinue
$supervisorPath = Join-Path $runtimeApp 'windows\run_engine_supervisor.ps1'
$supervisorProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" `
    -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and $_.CommandLine.IndexOf($supervisorPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })

$tunnelTask = Get-ScheduledTask -TaskName $TunnelTaskName -ErrorAction SilentlyContinue
$tunnelInfo = $null
if ($null -ne $tunnelTask) {
    $tunnelInfo = Get-ScheduledTaskInfo -TaskName $TunnelTaskName
}

$identityFileName = 'idea2_tunnel_autostart_ed25519'
if ($null -ne $settings -and
    $settings.PSObject.Properties.Name -contains 'identityFileName') {
    $candidateName = [string]$settings.identityFileName
    if ([IO.Path]::GetFileName($candidateName) -eq $candidateName) {
        $identityFileName = $candidateName
    }
}
$runtimeIdentity = Join-Path (Join-Path $RuntimeRoot 'ssh') $identityFileName
$keyAcl = Get-PrivateKeyAclStatus -Path $runtimeIdentity
$tunnelPrincipalIsSystem = $null -ne $tunnelTask -and
    [string]$tunnelTask.Principal.UserId -in @('SYSTEM', 'NT AUTHORITY\SYSTEM', 'S-1-5-18')
$tunnelAtStartup = $null -ne $tunnelTask -and @($tunnelTask.Triggers | Where-Object {
        $_.CimClass.CimClassName -eq 'MSFT_TaskBootTrigger'
    }).Count -gt 0
$tunnelRunnerPath = Join-Path $runtimeApp 'windows\run_detection_tunnel.ps1'
$tunnelProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" `
    -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -and
        $_.CommandLine.IndexOf($tunnelRunnerPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
    })
$logDirectory = Join-Path $RuntimeRoot 'logs'
$sshErrorFlags = Get-SshErrorFlags -LogDirectory $logDirectory

$port8077 = Test-LocalTcpPort -Port $enginePort
$port18002 = Test-LocalTcpPort -Port $localForwardPort
$supervisorPids = @($supervisorProcesses | ForEach-Object { $_.ProcessId }) -join ','

[pscustomobject]@{
    RuntimeRoot = $RuntimeRoot
    RuntimeInstalled = (Test-Path -LiteralPath (Join-Path $runtimeApp 'run.py') -PathType Leaf)
    RuntimePython = (Test-Path -LiteralPath (Join-Path $RuntimeRoot '.venv\Scripts\python.exe') -PathType Leaf)
    EngineHkcuRun = -not [string]::IsNullOrWhiteSpace([string]$runEntry)
    EngineSupervisorRunning = $supervisorProcesses.Count -gt 0
    EngineSupervisorPids = $supervisorPids
    TunnelTaskInstalled = $null -ne $tunnelTask
    TunnelTaskState = if ($null -ne $tunnelTask) { [string]$tunnelTask.State } else { 'Missing' }
    TunnelLastTaskResult = if ($null -ne $tunnelInfo) { $tunnelInfo.LastTaskResult } else { $null }
    TunnelTaskPrincipalIsSystem = $tunnelPrincipalIsSystem
    TunnelTaskTriggerIsAtStartup = $tunnelAtStartup
    TunnelSupervisorRunning = $tunnelProcesses.Count -gt 0
    PrivateKeyExists = $keyAcl.Exists
    PrivateKeyAclInspection = $keyAcl.InspectionState
    PrivateKeyOwnerIsSystem = $keyAcl.OwnerIsSystem
    PrivateKeyInheritanceDisabled = $keyAcl.InheritanceDisabled
    PrivateKeySystemFullControl = $keyAcl.SystemFullControl
    PrivateKeyNoDisallowedIdentities = $keyAcl.NoDisallowedIdentities
    PrivateKeyAclValid = $keyAcl.Valid
    UNPROTECTED_PRIVATE_KEY = $sshErrorFlags.UNPROTECTED_PRIVATE_KEY
    BAD_PERMISSIONS = $sshErrorFlags.BAD_PERMISSIONS
    PUBLICKEY_DENIED = $sshErrorFlags.PUBLICKEY_DENIED
    EnginePort = $enginePort
    EnginePortListening = $port8077
    MonitorForwardPort = $localForwardPort
    MonitorForwardListening = $port18002
} | Format-List

if (-not $SkipHealthRequests) {
    Get-HealthResult -Uri "http://127.0.0.1:$enginePort/health" | Format-List
    Get-HealthResult -Uri "http://127.0.0.1:$localForwardPort/healthz" | Format-List
}

$logFiles = @(
    'detection-engine-supervisor.log',
    'detection-engine-wrapper.log',
    'detection-engine.stderr.log',
    'detection-tunnel-wrapper.log',
    'detection-tunnel-ssh.stderr.log',
    'key-migration-ssh.stderr.log'
)
foreach ($name in $logFiles) {
    $path = Join-Path $logDirectory $name
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Write-Host "Last $LogTail lines: $path"
        Get-Content -LiteralPath $path -Tail $LogTail
    }
}
