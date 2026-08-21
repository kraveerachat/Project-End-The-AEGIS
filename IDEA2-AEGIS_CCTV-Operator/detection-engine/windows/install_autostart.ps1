[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$TaskName = 'AEGIS Detection Engine',
    [string]$PythonPath = '',
    [string]$TunnelTaskName = 'AEGIS Detection Tunnel',
    [string]$TunnelHost = '',
    [string]$IdentityFile = '',
    [string]$RemoteBindAddress = '172.18.0.1',
    [ValidateRange(1, 65535)]
    [int]$RemotePort = 18077,
    [string]$LocalHost = '127.0.0.1',
    [ValidateRange(1, 65535)]
    [int]$LocalPort = 8077,
    [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
    throw 'Windows Task Scheduler installation can only run on Windows.'
}

$engineRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
$runner = Join-Path $PSScriptRoot 'run_detection_engine.ps1'
$tunnelRunner = Join-Path $PSScriptRoot 'run_reverse_tunnel.ps1'
$envFile = Join-Path $engineRoot '.env'

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Create and validate $envFile before installing auto-start."
}

if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    $candidates = @(
        (Join-Path $engineRoot '.venv\Scripts\python.exe'),
        (Join-Path $engineRoot 'venv\Scripts\python.exe')
    )
    $PythonPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1

    if ([string]::IsNullOrWhiteSpace($PythonPath)) {
        $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($null -ne $pythonCommand) {
            $PythonPath = $pythonCommand.Source
        }
    }
}

if ([string]::IsNullOrWhiteSpace($PythonPath) -or
    -not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    throw 'Python was not found. Pass -PythonPath or create .venv/venv first.'
}

$resolvedPython = (Resolve-Path -LiteralPath $PythonPath).Path

# Validate imports and configuration without opening the camera or starting any
# worker. Installation must fail before registering a broken background task.
Push-Location -LiteralPath $engineRoot
try {
    & $resolvedPython -c "from aegis_engine.config import EngineConfig; EngineConfig.from_env().validate(); from aegis_engine.engine import DetectionEngine; print('AEGIS auto-start preflight passed')"
    if ($LASTEXITCODE -ne 0) {
        throw "Detection Engine preflight failed with exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$actionArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ' +
    "-File `"$runner`" -PythonPath `"$resolvedPython`" -EngineRoot `"$engineRoot`""
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name

# AtLogOn intentionally keeps the process in the interactive user session.
# Windows services run in Session 0 and are not a reliable webcam boundary.
$action = New-ScheduledTaskAction -Execute $windowsPowerShell `
    -Argument $actionArguments -WorkingDirectory $engineRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentIdentity
$principal = New-ScheduledTaskPrincipal -UserId $currentIdentity `
    -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 10 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew
$task = New-ScheduledTask -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings `
    -Description 'Starts the AEGIS IDEA2 Detection Engine after this camera-laptop user logs on.'

$tunnelTask = $null
if (-not [string]::IsNullOrWhiteSpace($TunnelHost)) {
    if ($TunnelHost -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$') {
        throw 'TunnelHost must use user@host without spaces or shell characters.'
    }
    $parsedRemoteAddress = $null
    if (-not [Net.IPAddress]::TryParse($RemoteBindAddress, [ref]$parsedRemoteAddress)) {
        throw 'RemoteBindAddress must be a literal IP address.'
    }
    if ([string]::IsNullOrWhiteSpace($IdentityFile) -or
        -not (Test-Path -LiteralPath $IdentityFile -PathType Leaf)) {
        throw 'IdentityFile is required when TunnelHost is set.'
    }
    $resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile).Path
    $sshCommand = Get-Command ssh.exe -ErrorAction SilentlyContinue
    if ($null -eq $sshCommand) {
        throw 'Windows OpenSSH client (ssh.exe) is required for the reverse tunnel.'
    }

    # The private key remains outside the repository. BatchMode makes an
    # unattended task fail and restart instead of hanging on a passphrase.
    # A passphrase-protected key must already be available through ssh-agent.
    $tunnelArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ' +
        "-File `"$tunnelRunner`" -SshPath `"$($sshCommand.Source)`" " +
        "-TunnelHost `"$TunnelHost`" -IdentityFile `"$resolvedIdentity`" " +
        "-RemoteBindAddress `"$RemoteBindAddress`" -RemotePort $RemotePort " +
        "-LocalHost `"$LocalHost`" -LocalPort $LocalPort"
    $tunnelAction = New-ScheduledTaskAction -Execute $windowsPowerShell `
        -Argument $tunnelArguments -WorkingDirectory $engineRoot
    $tunnelTask = New-ScheduledTask -Action $tunnelAction -Trigger $trigger `
        -Principal $principal -Settings $settings `
        -Description 'Maintains the IDEA2 camera reverse tunnel for the current Windows user.'
}

if ($PSCmdlet.ShouldProcess($TaskName, 'Register current-user AtLogOn scheduled task')) {
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    Write-Host "Registered scheduled task: $TaskName"

    if ($null -ne $tunnelTask) {
        Register-ScheduledTask -TaskName $TunnelTaskName `
            -InputObject $tunnelTask -Force | Out-Null
        Write-Host "Registered scheduled task: $TunnelTaskName"
    }

    if ($StartNow) {
        Start-ScheduledTask -TaskName $TaskName
        if ($null -ne $tunnelTask) {
            Start-ScheduledTask -TaskName $TunnelTaskName
        }
        Write-Host 'Start requested. Use status_autostart.ps1 to inspect tasks and logs.'
    }
}
