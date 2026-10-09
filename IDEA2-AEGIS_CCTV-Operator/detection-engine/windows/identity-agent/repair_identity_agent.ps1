[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Medium')]
param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$ExpectedSourceSha256,
    [string]$ReplacementConfigurationFile = '',
    [string]$BasePythonPath = '',
    [string]$InstallRoot = "$env:ProgramFiles\AEGIS\IdentityAgent",
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent",
    [string]$ConfigurationRoot = "$env:ProgramData\AEGIS\IdentityAgentConfiguration",
    [string]$EvidenceRoot = "$env:ProgramData\AEGIS\IdentityAgentProvisioning",
    [switch]$SkipDependencyInstall,
    [switch]$StartNow
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ServiceName = 'AEGISIdentityAgent'
$safetyScript = Join-Path $PSScriptRoot 'identity_agent_safety.ps1'
. $safetyScript
$managedRoots = Assert-IdentityAgentManagedRoots -InstallRoot $InstallRoot -DataRoot $DataRoot `
    -ConfigurationRoot $ConfigurationRoot -EvidenceRoot $EvidenceRoot -SourceRoot $SourceRoot
$InstallRoot = $managedRoots.installRoot
$DataRoot = $managedRoots.dataRoot
$ConfigurationRoot = $managedRoots.configurationRoot
$EvidenceRoot = $managedRoots.evidenceRoot
$null = Assert-IdentityAgentInstallationMarker -ConfigurationRoot $ConfigurationRoot `
    -InstallRoot $InstallRoot -DataRoot $DataRoot -EvidenceRoot $EvidenceRoot -ServiceName $ServiceName

$configurationPath = Join-Path $ConfigurationRoot 'agent.env'
$keyPath = Join-Path $DataRoot 'machine-identity.dpapi'
$configurationForRepair = $configurationPath
if (-not [string]::IsNullOrWhiteSpace($ReplacementConfigurationFile)) {
    $configurationForRepair = [IO.Path]::GetFullPath($ReplacementConfigurationFile)
}
if (-not (Test-Path -LiteralPath $configurationForRepair -PathType Leaf)) {
    throw 'Installed Identity Agent configuration is missing; pass -ReplacementConfigurationFile with the reviewed replacement'
}
# Repair never opens, hashes, copies, deletes, generates, or rotates the
# DPAPI-protected key. Its identity must be preserved by construction because
# install_identity_agent.ps1 owns no key mutation path.

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$engineRun = Get-ItemPropertyValue -Path $runKey -Name 'AEGIS Detection Engine' -ErrorAction SilentlyContinue
$engineTask = Get-ScheduledTask -TaskName 'AEGIS Detection Engine' -ErrorAction SilentlyContinue
$engineService = Get-CimInstance Win32_Service -Filter "Name='AEGIS Detection Engine'" -ErrorAction SilentlyContinue
$ownerCount = @(
    -not [string]::IsNullOrWhiteSpace([string]$engineRun),
    ($null -ne $engineTask -and [string]$engineTask.State -ne 'Disabled'),
    $null -ne $engineService
) | Where-Object { $_ } | Measure-Object | Select-Object -ExpandProperty Count
if ($ownerCount -ne 1 -or [string]::IsNullOrWhiteSpace([string]$engineRun)) {
    throw 'conflicting Engine startup owner: repair requires the sole HKCU Run owner'
}

$installer = Join-Path $PSScriptRoot 'install_identity_agent.ps1'
$arguments = @{
    SourceRoot = $SourceRoot
    ExpectedSourceSha256 = $ExpectedSourceSha256
    ConfigurationFile = $configurationForRepair
    BasePythonPath = $BasePythonPath
    InstallRoot = $InstallRoot
    DataRoot = $DataRoot
    ConfigurationRoot = $ConfigurationRoot
    EvidenceRoot = $EvidenceRoot
    SkipDependencyInstall = $SkipDependencyInstall
    RepairExistingIdentity = $true
    StartNow = $StartNow
}
$repairExecuted = $false
if ($PSCmdlet.ShouldProcess($InstallRoot, 'Repair the Identity Agent while preserving machine identity')) {
    & $installer @arguments
    $repairExecuted = $true
}
if (-not $repairExecuted) {
    'REPAIR=NOT_EXECUTED'
    return
}
'IDENTITY_PRESERVED=YES'
'CAMERA_DEMAND_CREATED=NO'
