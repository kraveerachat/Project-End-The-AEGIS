[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AEGIS\DetectionEngine'),
    [string]$TunnelTaskName = 'AEGIS Detection Tunnel',
    [string]$KeyMigrationTaskName = 'AEGIS Detection Key Migration'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$settingsPath = Join-Path $RuntimeRoot 'install.json'
if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    if ($settings.PSObject.Properties.Name -contains 'tunnelTaskName') {
        $TunnelTaskName = [string]$settings.tunnelTaskName
    }
    if ($settings.PSObject.Properties.Name -contains 'keyMigrationTaskName') {
        $KeyMigrationTaskName = [string]$settings.keyMigrationTaskName
    }
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ($PSCmdlet.ShouldProcess('AEGIS Detection Engine', 'Remove HKCU auto-start entry')) {
    Remove-ItemProperty -Path $runKey -Name 'AEGIS Detection Engine' `
        -ErrorAction SilentlyContinue
}

$runtimeApp = Join-Path $RuntimeRoot 'app'
$scriptNames = @(
    'run_engine_supervisor.ps1',
    'run_detection_tunnel.ps1',
    'prepare_tunnel_key.ps1'
)
$processes = @(Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" `
    -ErrorAction SilentlyContinue | Where-Object {
        $command = [string]$_.CommandLine
        $command.IndexOf($runtimeApp, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        @($scriptNames | Where-Object {
            $command.IndexOf($_, [StringComparison]::OrdinalIgnoreCase) -ge 0
        }).Count -gt 0
    })
foreach ($process in $processes) {
    if ($PSCmdlet.ShouldProcess("PID $($process.ProcessId)", 'Stop AEGIS supervisor and its child process tree')) {
        & taskkill.exe /PID $process.ProcessId /T /F | Out-Null
    }
}

$task = Get-ScheduledTask -TaskName $TunnelTaskName -ErrorAction SilentlyContinue
if ($null -ne $task -and $PSCmdlet.ShouldProcess($TunnelTaskName, 'Stop and unregister SYSTEM tunnel task')) {
    if ($task.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $TunnelTaskName
    }
    Unregister-ScheduledTask -TaskName $TunnelTaskName -Confirm:$false
}

$migrationTask = Get-ScheduledTask -TaskName $KeyMigrationTaskName -ErrorAction SilentlyContinue
if ($null -ne $migrationTask -and
    $PSCmdlet.ShouldProcess($KeyMigrationTaskName, 'Remove stale one-time SYSTEM key helper task')) {
    if ($migrationTask.State -eq 'Running') {
        Stop-ScheduledTask -TaskName $KeyMigrationTaskName
    }
    Unregister-ScheduledTask -TaskName $KeyMigrationTaskName -Confirm:$false
}

if ($WhatIfPreference) {
    Write-Host 'WhatIf completed; no auto-start registration or process was changed.'
}
else {
    Write-Host 'AEGIS IDEA2 auto-start registrations were removed.'
}
Write-Host 'Runtime app, .env, per-machine SSH material, logs, recordings, and .venv were preserved.'
