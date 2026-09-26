[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)][string]$NodeId,
    [Parameter(Mandatory=$true)][ValidateRange(1,4294967295)][uint32]$KeyVersion,
    [string]$InstallRoot = "$env:ProgramFiles\AEGIS\IdentityAgent",
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent",
    [string]$ConfigurationRoot = "$env:ProgramData\AEGIS\IdentityAgentConfiguration",
    [string]$EvidenceRoot = "$env:ProgramData\AEGIS\IdentityAgentProvisioning",
    [string]$PublicKeyExport = ''
)

$ErrorActionPreference = 'Stop'
$safetyScript = Join-Path $PSScriptRoot 'identity_agent_safety.ps1'
. $safetyScript
$ServiceName = 'AEGISIdentityAgent'
$ExpectedAccount = 'NT SERVICE\AEGISIdentityAgent'
$managedRoots = Assert-IdentityAgentManagedRoots -InstallRoot $InstallRoot -DataRoot $DataRoot `
    -ConfigurationRoot $ConfigurationRoot -EvidenceRoot $EvidenceRoot
$InstallRoot = $managedRoots.installRoot
$DataRoot = $managedRoots.dataRoot
$ConfigurationRoot = $managedRoots.configurationRoot
$EvidenceRoot = $managedRoots.evidenceRoot
$null = Assert-IdentityAgentInstallationMarker -ConfigurationRoot $ConfigurationRoot `
    -InstallRoot $InstallRoot -DataRoot $DataRoot -EvidenceRoot $EvidenceRoot -ServiceName $ServiceName
$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $service -or $service.StartName -ne $ExpectedAccount) { throw 'Identity Agent service identity mismatch' }
if ([string]$service.State -ne 'Stopped') {
    throw 'Identity Agent service must be stopped before identity provisioning'
}
$python = Join-Path $InstallRoot '.venv\Scripts\python.exe'
$runner = Join-Path $InstallRoot 'run_identity_agent.py'
$expectedBinPath = ('"{0}" "{1}" --service' -f $python, $runner)
if (-not [string]::Equals(([string]$service.PathName).Trim(), $expectedBinPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Identity Agent service executable mismatch'
}
if (-not $PublicKeyExport) { $PublicKeyExport = Join-Path $EvidenceRoot 'machine-identity-public.pem' }
$PublicKeyExport = [IO.Path]::GetFullPath($PublicKeyExport)
if (-not [string]::Equals(
        [IO.Path]::GetDirectoryName($PublicKeyExport),
        $EvidenceRoot,
        [StringComparison]::OrdinalIgnoreCase
    )) {
    throw 'Public-key export must be a direct child of the bound evidence root'
}
if (-not (Test-Path -LiteralPath $EvidenceRoot)) { throw 'Provisioning evidence root is missing' }
if ((Get-Item -LiteralPath $EvidenceRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Provisioning evidence root must not be a reparse point'
}
$preflightPath = Join-Path $EvidenceRoot 'dpapi-preflight.pass.json'
if (-not (Test-Path -LiteralPath $preflightPath)) { throw 'DPAPI CurrentUser preflight PASS is required before key generation' }
$preflight = Get-Content -LiteralPath $preflightPath -Raw | ConvertFrom-Json
if ($preflight.result -ne 'PASS' -or $preflight.protectionScope -ne 'CurrentUser' -or
    $preflight.serviceAccount -ne $ExpectedAccount -or $preflight.keyGenerated -ne $false) {
    throw 'DPAPI CurrentUser preflight evidence is invalid'
}
$keyPath = Join-Path $DataRoot 'machine-identity.dpapi'
# The idempotent provision operation runs under the service identity. It atomically creates
# a key only when absent, otherwise validates and resumes public-only evidence
# export from the existing DPAPI identity. The administrator never probes it.

$resultPath = Join-Path $EvidenceRoot 'identity-provision-result.json'

$provisionExecuted = $false
if ($PSCmdlet.ShouldProcess($keyPath, 'Create one DPAPI CurrentUser-protected Ed25519 identity')) {
    if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath -Force }
    $original = $service.PathName
    $generateCommand = ('"{0}" "{1}" --provision-key --node-id "{2}" --key-version {3} --key-path "{4}" --public-key-export "{5}" --result-output "{6}"' -f
        $python, $runner, $NodeId, $KeyVersion, $keyPath, $PublicKeyExport, $resultPath)
    Invoke-CheckedServiceControl $ServiceName config "binPath= $generateCommand"
    try {
        Invoke-CheckedServiceControl $ServiceName start
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not (Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 250
        }
        if (-not (Test-Path -LiteralPath $resultPath)) { throw 'Service-identity key generation did not produce evidence' }
        $serviceController = Get-Service -Name $ServiceName -ErrorAction Stop
        $serviceController.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    finally {
        $serviceController = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -ne $serviceController -and $serviceController.Status -ne 'Stopped') {
            Invoke-CheckedServiceControl $ServiceName stop
            $serviceController.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
        }
        Invoke-CheckedServiceControl $ServiceName config "binPath= $original"
    }
    $provisionExecuted = $true
}

if (-not $provisionExecuted) {
    'IDENTITY_PROVISIONING=NOT_EXECUTED'
    return
}

$result = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
if ($result.nodeId -ne $NodeId -or [uint32]$result.keyVersion -ne $KeyVersion -or $result.privateKeyExported -ne $false) {
    throw 'Identity provisioning evidence is invalid'
}
"NODE_ID=$($result.nodeId)"
"KEY_VERSION=$($result.keyVersion)"
"Fingerprint=$($result.fingerprintSha256)"
"PUBLIC_KEY_EXPORT=$PublicKeyExport"
'PRIVATE_KEY_EXPORTED=NO'
