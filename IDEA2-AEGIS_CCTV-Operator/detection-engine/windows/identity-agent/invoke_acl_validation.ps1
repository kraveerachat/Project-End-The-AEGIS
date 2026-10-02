[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ServiceName = 'AEGISIdentityAgent',
    [string]$InstallRoot = "$env:ProgramFiles\AEGIS\IdentityAgent",
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent",
    [string]$ConfigurationRoot = "$env:ProgramData\AEGIS\IdentityAgentConfiguration",
    [string]$EvidenceRoot = "$env:ProgramData\AEGIS\IdentityAgentProvisioning",
    [switch]$RequireKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$safetyScript = Join-Path $PSScriptRoot 'identity_agent_safety.ps1'
. $safetyScript
Assert-IdentityAgentServiceName -ServiceName $ServiceName
$managedRoots = Assert-IdentityAgentManagedRoots -InstallRoot $InstallRoot -DataRoot $DataRoot `
    -ConfigurationRoot $ConfigurationRoot -EvidenceRoot $EvidenceRoot
$InstallRoot = $managedRoots.installRoot
$DataRoot = $managedRoots.dataRoot
$ConfigurationRoot = $managedRoots.configurationRoot
$EvidenceRoot = $managedRoots.evidenceRoot
$null = Assert-IdentityAgentInstallationMarker -ConfigurationRoot $ConfigurationRoot `
    -InstallRoot $InstallRoot -DataRoot $DataRoot -EvidenceRoot $EvidenceRoot -ServiceName $ServiceName

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'" -ErrorAction Stop
if ($null -eq $service -or [string]$service.StartName -ne 'NT SERVICE\AEGISIdentityAgent') {
    throw 'Identity Agent service identity mismatch'
}
if ([string]$service.State -ne 'Stopped') {
    throw 'Identity Agent service must be stopped before ACL validation'
}
$python = Join-Path $InstallRoot '.venv\Scripts\python.exe'
$runner = Join-Path $InstallRoot 'run_identity_agent.py'
$expectedBinPath = ('"{0}" "{1}" --service' -f $python, $runner)
if (-not [string]::Equals(([string]$service.PathName).Trim(), $expectedBinPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Identity Agent service executable mismatch'
}
$resultPath = Join-Path $EvidenceRoot 'identity-acl-validation.json'

if (-not $PSCmdlet.ShouldProcess($ServiceName, 'Validate protected identity ACLs under the service identity')) {
    'ACL_VALIDATION=NOT_EXECUTED'
    return
}
if (Test-Path -LiteralPath $resultPath -PathType Leaf) {
    Remove-Item -LiteralPath $resultPath -Force
}
$original = $service.PathName
$requireKeyArgument = if ($RequireKey) { ' --require-key' } else { '' }
$validationCommand = ('"{0}" "{1}" --validate-key-store-acl{2} --result-output "{3}"' -f
    $python, $runner, $requireKeyArgument, $resultPath)
try {
    Invoke-CheckedServiceControl $ServiceName config 'binPath=' $validationCommand
    Invoke-CheckedServiceControl $ServiceName start
    $serviceController = Get-Service -Name $ServiceName -ErrorAction Stop
    $serviceController.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
        throw 'Service-identity ACL validation evidence was not produced'
    }
    $evidence = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    $expectedKeyAcl = if ($RequireKey) { 'VALID' } else { 'NOT_REQUIRED' }
    if ($evidence.result -ne 'PASS' -or
        $evidence.serviceAccount -ne 'NT SERVICE\AEGISIdentityAgent' -or
        $evidence.dataRootAcl -ne 'VALID' -or
        $evidence.keyAcl -ne $expectedKeyAcl -or
        $evidence.privateKeyRead -ne $false) {
        throw 'Service-identity ACL validation evidence is invalid'
    }
}
finally {
    try {
        $serviceController = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -ne $serviceController -and $serviceController.Status -ne 'Stopped') {
            Invoke-CheckedServiceControl $ServiceName stop
            $serviceController.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
        }
    }
    finally {
        Invoke-CheckedServiceControl $ServiceName config 'binPath=' $original
    }
}

'ACL_VALIDATION=PASS'
'DATA_ROOT_ACL=VALID'
"KEY_ACL=$(if ($RequireKey) { 'VALID' } else { 'NOT_REQUIRED' })"
'PRIVATE_KEY_READ=NO'
