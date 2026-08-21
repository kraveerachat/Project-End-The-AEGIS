[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$TaskName = 'AEGIS Detection Engine',
    [string]$TunnelTaskName = 'AEGIS Detection Tunnel'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$removed = $false
foreach ($name in @($TaskName, $TunnelTaskName)) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Host "Scheduled task is already absent: $name"
        continue
    }

    if ($PSCmdlet.ShouldProcess($name, 'Stop and unregister scheduled task')) {
        if ($task.State -eq 'Running') {
            Stop-ScheduledTask -TaskName $name
        }
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "Scheduled task removed: $name"
        $removed = $true
    }
}
if ($removed) {
    Write-Host 'Source, .env, identity key, recordings, and logs were preserved.'
}
