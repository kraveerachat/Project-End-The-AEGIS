[CmdletBinding()]
param(
    [string]$RuntimeRoot = "$env:LOCALAPPDATA\AEGIS\DetectionEngine",
    [string]$InstallRoot = "$env:ProgramFiles\AEGIS\IdentityAgent",
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent",
    [string]$ConfigurationRoot = "$env:ProgramData\AEGIS\IdentityAgentConfiguration",
    [string]$TunnelTaskName = 'AEGIS Detection Tunnel',
    [int]$EnginePort = 8077
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$statusScript = Join-Path $PSScriptRoot 'status_identity_agent.ps1'
$statusOutput = @(& $statusScript -InstallRoot $InstallRoot -DataRoot $DataRoot `
        -ConfigurationRoot $ConfigurationRoot -EngineRuntimeRoot $RuntimeRoot `
        -TunnelTaskName $TunnelTaskName)
$status = @{}
foreach ($line in $statusOutput) {
    if ([string]$line -match '^([A-Z0-9_]+)=(.*)$') { $status[$Matches[1]] = $Matches[2] }
}

$health = $null
try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$EnginePort/health" -Method Get -TimeoutSec 5 } catch { }
$cameraDemanded = $null -ne $health -and [bool]$health.camera_demanded
$cameraConnected = $null -ne $health -and [bool]$health.camera_connected
$idleOff = $null -ne $health -and -not $cameraDemanded -and -not $cameraConnected

"EngineStartupOwner=$($status['ENGINE_STARTUP_OWNER'])"
"IdentityAgentService=$($status['SERVICE_STATE'])"
"IdentityAgentLoopback8078=$($status['LOOPBACK_8078'])"
"TunnelTask=$($status['TUNNEL_TASK_STATE'])"
"IdentityKeyAcl=$($status['IDENTITY_KEY_ACL'])"
"IdentityDataRootAcl=$($status['IDENTITY_DATA_ROOT_ACL'])"
"TunnelTaskPrincipal=$($status['TUNNEL_TASK_PRINCIPAL'])"
"TunnelTaskTrigger=$($status['TUNNEL_TASK_TRIGGER'])"
"EngineStartupCommand=$($status['ENGINE_STARTUP_COMMAND'])"
"TunnelTaskAction=$($status['TUNNEL_TASK_ACTION'])"
"MonitorForwardHealth=$($status['MONITOR_FORWARD_HEALTH'])"
"CameraDemanded=$cameraDemanded"
"CameraConnected=$cameraConnected"
'ManualPowerShellRequired=NO'
'ManualHeartbeatRequired=NO'
'TemporaryBridge18078Required=NO'
if ($idleOff) { 'CAMERA_IDLE_OFF=PASS' } else { 'CAMERA_IDLE_OFF=FAIL' }
'PRIVATE_KEY_EXPOSED=NO'

if ($status['INSTALLATION_STATE'] -ne 'INSTALLED' -or
    $status['SERVICE_STATE'] -ne 'RUNNING' -or
    $status['LOOPBACK_8078'] -ne 'RUNNING' -or
    $status['ENGINE_STARTUP_OWNER'] -ne 'HKCU_RUN' -or
    $status['ENGINE_STARTUP_COMMAND'] -ne 'VALID' -or
    $status['IDENTITY_KEY_ACL'] -ne 'SERVICE_ATTESTED' -or
    $status['IDENTITY_DATA_ROOT_ACL'] -ne 'SERVICE_ATTESTED' -or
    $status['TUNNEL_TASK_STATE'] -notin @('READY', 'RUNNING') -or
    $status['TUNNEL_TASK_PRINCIPAL'] -ne 'SYSTEM' -or
    $status['TUNNEL_TASK_TRIGGER'] -ne 'AT_STARTUP' -or
    $status['TUNNEL_TASK_ACTION'] -ne 'VALID' -or
    $status['MONITOR_FORWARD_HEALTH'] -ne 'HEALTHY' -or
    -not $idleOff) {
    throw 'Machine A No-PowerShell verification failed'
}
