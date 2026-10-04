[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')]
    [string]$NodeLabel,

    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'pre_viewer',
        'operator_live',
        'post_operator_release',
        'operator2_live',
        'post_operator2_release',
        'post_reboot'
    )]
    [string]$Phase,

    [string]$OutputDirectory = (Join-Path $PWD 'mn-p3-evidence')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ListenerSnapshot {
    param([Parameter(Mandatory = $true)][int]$Port)

    $listeners = @(
        Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    )

    [pscustomobject]@{
        port = $Port
        listener_count = $listeners.Count
        pids = @($listeners | ForEach-Object { [int]$_.OwningProcess })
    }
}

function Get-LocalEngineHealth {
    $uri = 'http://127.0.0.1:8077/health'
    try {
        $response = Invoke-RestMethod `
            -Uri $uri `
            -Method Get `
            -TimeoutSec 5 `
            -ErrorAction Stop

        return [pscustomobject]@{
            reachable = $true
            status = [string]$response.status
            camera_connected = [bool]$response.camera_connected
            camera_demanded = [bool]$response.camera_demanded
            stream_viewers = [int]$response.stream_viewers
            recognizer_backend = [string]$response.recognizer_backend
            gpu_required = [bool]$response.gpu_required
            requested_inference_device = [string]$response.requested_inference_device
            accelerator_active = [bool]$response.accelerator_active
            accelerator_failure = [bool]$response.accelerator_failure
            uptime_s = [double]$response.uptime_s
            capture_fps = [double]$response.capture_fps
            detect_fps = [double]$response.detect_fps
        }
    }
    catch {
        return [pscustomobject]@{
            reachable = $false
            status = 'UNREACHABLE'
            camera_connected = $false
            camera_demanded = $false
            stream_viewers = 0
            recognizer_backend = $null
            gpu_required = $null
            requested_inference_device = $null
            accelerator_active = $null
            accelerator_failure = $null
            uptime_s = $null
            capture_fps = $null
            detect_fps = $null
        }
    }
}

$agent = Get-CimInstance Win32_Service `
    -Filter "Name='AEGISIdentityAgent'" `
    -ErrorAction SilentlyContinue

$tunnelTask = Get-ScheduledTask `
    -TaskName 'AEGIS Detection Tunnel' `
    -ErrorAction SilentlyContinue

$legacyEngineTask = Get-ScheduledTask `
    -TaskName 'AEGIS Detection Engine' `
    -ErrorAction SilentlyContinue

$runEntry = Get-ItemPropertyValue `
    -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
    -Name 'AEGIS Detection Engine' `
    -ErrorAction SilentlyContinue

$engineHealth = Get-LocalEngineHealth

$record = [ordered]@{
    schema_version = 1
    collected_at_utc = [DateTime]::UtcNow.ToString('o')
    node_label = $NodeLabel
    phase = $Phase

    collection_boundary = [ordered]@{
        server_contact = 'NO'
        production_mutation = 'NO'
        twingate_mutation = 'NO'
        camera_open_by_collector = 'NO'
        private_key_read = 'NO'
        config_read = 'NO'
        localhost_engine_health_only = 'YES'
    }

    lifecycle = [ordered]@{
        identity_agent_installed = $null -ne $agent
        identity_agent_state = if ($null -ne $agent) { [string]$agent.State } else { 'Missing' }
        identity_agent_start_mode = if ($null -ne $agent) { [string]$agent.StartMode } else { 'Missing' }

        detection_tunnel_task_present = $null -ne $tunnelTask
        detection_tunnel_task_state = if ($null -ne $tunnelTask) { [string]$tunnelTask.State } else { 'Missing' }

        legacy_engine_task_present = $null -ne $legacyEngineTask
        legacy_engine_task_state = if ($null -ne $legacyEngineTask) { [string]$legacyEngineTask.State } else { 'Missing' }

        engine_hkcu_run_present = -not [string]::IsNullOrWhiteSpace([string]$runEntry)
    }

    listeners = @(
        Get-ListenerSnapshot -Port 8077
        Get-ListenerSnapshot -Port 8078
        Get-ListenerSnapshot -Port 18002
    )

    engine_health = $engineHealth
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

$safeNode = $NodeLabel -replace '[^A-Za-z0-9._-]', '_'
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$fileName = '{0}-{1}-{2}.json' -f $safeNode, $Phase, $stamp
$path = Join-Path $OutputDirectory $fileName

[pscustomobject]$record |
    ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath $path -Encoding UTF8

$hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()

Write-Output "MN_P3_SNAPSHOT=$path"
Write-Output "MN_P3_SNAPSHOT_SHA256=$hash"
Write-Output "NODE_LABEL=$NodeLabel"
Write-Output "PHASE=$Phase"
Write-Output "ENGINE_HEALTH_REACHABLE=$($engineHealth.reachable)"
Write-Output "ENGINE_STATUS=$($engineHealth.status)"
Write-Output "CAMERA_DEMANDED=$($engineHealth.camera_demanded)"
Write-Output "CAMERA_CONNECTED=$($engineHealth.camera_connected)"
Write-Output "STREAM_VIEWERS=$($engineHealth.stream_viewers)"
Write-Output "CAPTURE_FPS=$($engineHealth.capture_fps)"
Write-Output "DETECT_FPS=$($engineHealth.detect_fps)"
Write-Output "SERVER_CONTACT=NO"
Write-Output "PRODUCTION_MUTATION=NO"
Write-Output "TWINGATE_MUTATION=NO"
Write-Output "CAMERA_OPEN_BY_COLLECTOR=NO"
Write-Output "PRIVATE_KEY_READ=NO"
Write-Output "CONFIG_READ=NO"
Write-Output "MN_P3_LOCAL_SNAPSHOT_COMPLETE=YES"
