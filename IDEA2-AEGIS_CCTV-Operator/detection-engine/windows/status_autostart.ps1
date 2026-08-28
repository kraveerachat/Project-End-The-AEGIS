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
    EnginePort = $enginePort
    EnginePortListening = $port8077
    MonitorForwardPort = $localForwardPort
    MonitorForwardListening = $port18002
} | Format-List

if (-not $SkipHealthRequests) {
    Get-HealthResult -Uri "http://127.0.0.1:$enginePort/health" | Format-List
    Get-HealthResult -Uri "http://127.0.0.1:$localForwardPort/healthz" | Format-List
}

$logDirectory = Join-Path $RuntimeRoot 'logs'
$logFiles = @(
    'detection-engine-supervisor.log',
    'detection-engine-wrapper.log',
    'detection-engine.stderr.log',
    'detection-tunnel-wrapper.log',
    'detection-tunnel-ssh.stderr.log'
)
foreach ($name in $logFiles) {
    $path = Join-Path $logDirectory $name
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        Write-Host "Last $LogTail lines: $path"
        Get-Content -LiteralPath $path -Tail $LogTail
    }
}
