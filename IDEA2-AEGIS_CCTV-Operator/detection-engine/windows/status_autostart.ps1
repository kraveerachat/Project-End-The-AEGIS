[CmdletBinding()]
param(
    [string]$TaskName = 'AEGIS Detection Engine',
    [string]$TunnelTaskName = 'AEGIS Detection Tunnel',
    [int]$LogTail = 40
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$foundTask = $false
foreach ($name in @($TaskName, $TunnelTaskName)) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Host "Scheduled task is not installed: $name"
        continue
    }
    $foundTask = $true
    $info = Get-ScheduledTaskInfo -TaskName $name
    [pscustomobject]@{
        TaskName       = $task.TaskName
        State          = $task.State
        LastRunTime    = $info.LastRunTime
        LastTaskResult = $info.LastTaskResult
        NextRunTime    = $info.NextRunTime
    } | Format-List
}
if (-not $foundTask) {
    exit 1
}

$logDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) `
    'AEGIS\DetectionEngine\logs'
$logFiles = @(
    (Join-Path $logDirectory 'detection-engine-wrapper.log'),
    (Join-Path $logDirectory 'detection-engine.stderr.log'),
    (Join-Path $logDirectory 'detection-engine.stdout.log'),
    (Join-Path $logDirectory 'reverse-tunnel-wrapper.log'),
    (Join-Path $logDirectory 'reverse-tunnel.stderr.log'),
    (Join-Path $logDirectory 'reverse-tunnel.stdout.log')
)
$foundLog = $false
foreach ($logFile in $logFiles) {
    if (Test-Path -LiteralPath $logFile -PathType Leaf) {
        $foundLog = $true
        Write-Host "Last $LogTail log lines from $logFile"
        Get-Content -LiteralPath $logFile -Tail $LogTail
    }
}
if (-not $foundLog) {
    Write-Host "No engine logs exist yet under: $logDirectory"
}
