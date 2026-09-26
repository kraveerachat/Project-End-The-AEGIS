[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [string]$ServiceName = 'AEGISIdentityAgent',
    [string]$InstallRoot = "$env:ProgramFiles\AEGIS\IdentityAgent",
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent",
    [string]$ConfigurationRoot = "$env:ProgramData\AEGIS\IdentityAgentConfiguration",
    [string]$EvidenceRoot = "$env:ProgramData\AEGIS\IdentityAgentProvisioning",
    [switch]$DestroyIdentity
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator elevation is required'
}
$safetyScript = Join-Path $PSScriptRoot 'identity_agent_safety.ps1'
. $safetyScript
Assert-IdentityAgentServiceName -ServiceName $ServiceName
$managedRoots = Assert-IdentityAgentManagedRoots -InstallRoot $InstallRoot -DataRoot $DataRoot `
    -ConfigurationRoot $ConfigurationRoot -EvidenceRoot $EvidenceRoot
$InstallRoot = $managedRoots.installRoot
$DataRoot = $managedRoots.dataRoot
$ConfigurationRoot = $managedRoots.configurationRoot
$EvidenceRoot = $managedRoots.evidenceRoot
$keyPath = Join-Path $DataRoot 'machine-identity.dpapi'
$configurationPath = Join-Path $ConfigurationRoot 'agent.env'
$markerPath = Join-Path $ConfigurationRoot 'install.json'

function Test-PathExistsIncludingDenied {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        Get-Item -LiteralPath $Path -Force -ErrorAction Stop | Out-Null
        return $true
    }
    catch [System.UnauthorizedAccessException] { return $true }
    catch [System.Management.Automation.ItemNotFoundException] { return $false }
}

function Invoke-CheckedExternal {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    & $FilePath @Arguments | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "$FilePath failed with exit code $LASTEXITCODE" }
}

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction SilentlyContinue
$managedStateExists = $null -ne $service -or
    (Test-PathExistsIncludingDenied -Path $InstallRoot) -or
    (Test-PathExistsIncludingDenied -Path $DataRoot) -or
    (Test-PathExistsIncludingDenied -Path $ConfigurationRoot) -or
    (Test-PathExistsIncludingDenied -Path $EvidenceRoot)
if ($managedStateExists) {
    $installationMarker = Assert-IdentityAgentInstallationMarker -ConfigurationRoot $ConfigurationRoot `
        -InstallRoot $InstallRoot -DataRoot $DataRoot -EvidenceRoot $EvidenceRoot -ServiceName $ServiceName
}
if ($null -ne $service) {
    $expectedPython = Join-Path $InstallRoot '.venv\Scripts\python.exe'
    $expectedRunner = Join-Path $InstallRoot 'run_identity_agent.py'
    $expectedBinPath = ('"{0}" "{1}" --service' -f $expectedPython, $expectedRunner)
    if ([string]$service.StartName -ne 'NT SERVICE\AEGISIdentityAgent' -or
        -not [string]::Equals(([string]$service.PathName).Trim(), $expectedBinPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Installed service does not match the bound Identity Agent installation'
    }
}
if ($WhatIfPreference) {
    if ($DestroyIdentity) { 'IDENTITY_DESTRUCTION=NOT_EXECUTED' }
    else { 'UNINSTALL=NOT_EXECUTED' }
    return
}
if ($null -ne $service -and $PSCmdlet.ShouldProcess($ServiceName, 'Stop and remove the Identity Agent service')) {
    if ([string]$service.State -ne 'Stopped') {
        Invoke-CheckedExternal sc.exe stop $ServiceName
        $serviceController = Get-Service -Name $ServiceName -ErrorAction Stop
        $serviceController.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    & sc.exe delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Identity Agent service removal failed' }
}

if (Test-Path -LiteralPath $InstallRoot) {
    if ($PSCmdlet.ShouldProcess($InstallRoot, 'Remove the Task 12 managed Agent runtime')) {
        Remove-Item -LiteralPath $InstallRoot -Recurse -Force
    }
}
if (Test-Path -LiteralPath $configurationPath -PathType Leaf) {
    if ($PSCmdlet.ShouldProcess($configurationPath, 'Remove Task 12 managed Agent configuration')) {
        Remove-Item -LiteralPath $configurationPath -Force
    }
}
if (Test-Path -LiteralPath $EvidenceRoot) {
    if ($PSCmdlet.ShouldProcess($EvidenceRoot, 'Remove non-secret Agent provisioning evidence')) {
        Remove-Item -LiteralPath $EvidenceRoot -Recurse -Force
    }
}

if ($DestroyIdentity) {
    $dataRootExists = Test-PathExistsIncludingDenied -Path $DataRoot
    $identityDestruction = if ($dataRootExists) { 'NOT_EXECUTED' } else { 'ALREADY_ABSENT' }
    if ($dataRootExists -and $PSCmdlet.ShouldProcess(
            $keyPath, 'Permanently destroy the protected machine identity')) {
        Invoke-CheckedExternal takeown.exe /F $DataRoot /A /R /D Y
        Invoke-CheckedExternal icacls.exe $DataRoot /inheritance:r /grant:r `
            'BUILTIN\Administrators:(OI)(CI)F' /T /C
        $keyExisted = Test-Path -LiteralPath $keyPath -PathType Leaf
        if (Test-Path -LiteralPath $keyPath -PathType Leaf) {
            Remove-Item -LiteralPath $keyPath -Force
        }
        if (@(Get-ChildItem -LiteralPath $DataRoot -Force).Count -eq 0) {
            Remove-Item -LiteralPath $DataRoot -Force
        }
        if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
            Remove-Item -LiteralPath $markerPath -Force
        }
        if ((Test-Path -LiteralPath $ConfigurationRoot -PathType Container) -and
            @(Get-ChildItem -LiteralPath $ConfigurationRoot -Force).Count -eq 0) {
            Remove-Item -LiteralPath $ConfigurationRoot -Force
        }
        if (Test-Path -LiteralPath $keyPath -PathType Leaf) {
            throw 'Protected machine identity remains after destructive uninstall'
        }
        $identityDestruction = if ($keyExisted) { 'DESTROYED' } else { 'ALREADY_ABSENT' }
    }
    switch ($identityDestruction) {
        'DESTROYED' { 'IDENTITY_DESTRUCTION=DESTROYED' }
        'ALREADY_ABSENT' { 'IDENTITY_DESTRUCTION=ALREADY_ABSENT' }
        default { 'IDENTITY_DESTRUCTION=NOT_EXECUTED' }
    }
}
else {
    $dataRootExists = Test-PathExistsIncludingDenied -Path $DataRoot
    if ($dataRootExists) {
        $installationMarker.state = 'PRESERVED'
        $installationMarker | ConvertTo-Json | Set-Content -LiteralPath $markerPath -Encoding UTF8
        Invoke-CheckedExternal icacls.exe $markerPath /inheritance:r /grant:r `
            'NT SERVICE\AEGISIdentityAgent:R' 'SYSTEM:F' 'BUILTIN\Administrators:F'
    }
    else {
        if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
            Remove-Item -LiteralPath $markerPath -Force
        }
        if ((Test-Path -LiteralPath $ConfigurationRoot -PathType Container) -and
            @(Get-ChildItem -LiteralPath $ConfigurationRoot -Force).Count -eq 0) {
            Remove-Item -LiteralPath $ConfigurationRoot -Force
        }
    }
    'IDENTITY_PRESERVED=YES'
}
'CAMERA_DEMAND_CREATED=NO'
