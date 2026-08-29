[CmdletBinding()]
param(
    [string]$EngineRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$PythonPath = '',
    [ValidateRange(0, 600)]
    [int]$StartupDelaySeconds = 60,
    [ValidateRange(1, 300)]
    [int]$RestartDelaySeconds = 10,
    [ValidateRange(1, 65535)]
    [int]$ApiPort = 8077
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedEngineRoot = (Resolve-Path -LiteralPath $EngineRoot).Path
if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    $PythonPath = Join-Path (Split-Path -Parent $resolvedEngineRoot) '.venv\Scripts\python.exe'
}

$runner = Join-Path $resolvedEngineRoot 'windows\run_detection_engine.ps1'
$stateRoot = Split-Path -Parent $resolvedEngineRoot
$logDirectory = Join-Path $stateRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$supervisorLog = Join-Path $logDirectory 'detection-engine-supervisor.log'

function Write-SupervisorLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    $timestamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
    "[$timestamp] $Message" | Out-File -LiteralPath $supervisorLog `
        -Encoding utf8 -Append
}

function Test-LocalTcpPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $client = New-Object Net.Sockets.TcpClient
    try {
        $wait = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        return $wait.AsyncWaitHandle.WaitOne(500) -and $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

$createdNew = $false
$mutex = [Threading.Mutex]::new($false, 'Local\AEGISDetectionEngineSupervisor', [ref]$createdNew)
if (-not $createdNew) {
    Write-SupervisorLog 'Another Detection Engine supervisor already owns the user-session mutex; exiting.'
    $mutex.Dispose()
    exit 0
}

try {
    Write-SupervisorLog "Detection Engine supervisor started. PID=$PID"
    if ($StartupDelaySeconds -gt 0) {
        Start-Sleep -Seconds $StartupDelaySeconds
    }

    while ($true) {
        if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) {
            Write-SupervisorLog "Runner unavailable; retrying in $RestartDelaySeconds seconds."
            Start-Sleep -Seconds $RestartDelaySeconds
            continue
        }

        if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
            Write-SupervisorLog "Runtime Python unavailable; retrying in $RestartDelaySeconds seconds."
            Start-Sleep -Seconds $RestartDelaySeconds
            continue
        }

        # Never replace an already-running engine. This lets a repaired
        # supervisor adopt the machine safely after an older child exits.
        if (Test-LocalTcpPort -Port $ApiPort) {
            Write-SupervisorLog "Port $ApiPort is already listening; waiting before re-check."
            Start-Sleep -Seconds $RestartDelaySeconds
            continue
        }

        try {
            Write-SupervisorLog 'Starting Detection Engine child.'
            $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass ' +
                "-File `"$runner`" -PythonPath `"$PythonPath`" " +
                "-EngineRoot `"$resolvedEngineRoot`""
            $child = Start-Process `
                -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
                -ArgumentList $arguments `
                -WorkingDirectory $resolvedEngineRoot `
                -WindowStyle Hidden `
                -PassThru
            Write-SupervisorLog "Detection Engine child started. PID=$($child.Id)"
            $child.WaitForExit()
            Write-SupervisorLog "Detection Engine child exited. ExitCode=$($child.ExitCode)"
        }
        catch {
            Write-SupervisorLog "Detection Engine launch/wait error: $($_.Exception.Message)"
        }

        Write-SupervisorLog "Restarting Detection Engine in $RestartDelaySeconds seconds."
        Start-Sleep -Seconds $RestartDelaySeconds
    }
}
finally {
    try { $mutex.ReleaseMutex() } catch { }
    $mutex.Dispose()
}
