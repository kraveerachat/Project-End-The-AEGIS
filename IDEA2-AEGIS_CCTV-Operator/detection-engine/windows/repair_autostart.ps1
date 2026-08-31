[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$RuntimeRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AEGIS\DetectionEngine'),
    [string]$BasePythonPath = '',
    [switch]$SkipDependencyInstall,
    [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$settingsPath = Join-Path $RuntimeRoot 'install.json'
if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
    throw "Installer settings not found: $settingsPath. Run install_autostart.ps1 first."
}
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$installer = Join-Path $PSScriptRoot 'install_autostart.ps1'
$keyMigrationTaskName = if ($settings.PSObject.Properties.Name -contains 'keyMigrationTaskName') {
    [string]$settings.keyMigrationTaskName
}
else {
    'AEGIS Detection Key Migration'
}

$arguments = @{
    RuntimeRoot = $RuntimeRoot
    BasePythonPath = $BasePythonPath
    TunnelHost = [string]$settings.tunnelHost
    TunnelTaskName = [string]$settings.tunnelTaskName
    KeyMigrationTaskName = $keyMigrationTaskName
    LegacyEngineTaskName = [string]$settings.legacyEngineTaskName
    MonitorTargetHost = [string]$settings.monitorTargetHost
    MonitorTargetPort = [int]$settings.monitorTargetPort
    LocalForwardPort = [int]$settings.localForwardPort
    RemoteBindAddress = [string]$settings.remoteBindAddress
    RemotePort = [int]$settings.remotePort
    EnginePort = [int]$settings.enginePort
    SkipDependencyInstall = $SkipDependencyInstall
    StartNow = $StartNow
}

if ($PSCmdlet.ShouldProcess($RuntimeRoot, 'Repair IDEA2 runtime files, dependencies, and auto-start registrations')) {
    & $installer @arguments
}
