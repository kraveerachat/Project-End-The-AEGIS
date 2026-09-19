[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)][string]$NodeId,
    [Parameter(Mandatory=$true)][ValidateRange(1,4294967295)][uint32]$KeyVersion,
    [string]$InstallRoot = "$env:ProgramFiles\AEGIS\IdentityAgent",
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent",
    [string]$EvidenceRoot = "$env:ProgramData\AEGIS\IdentityAgentProvisioning",
    [string]$PublicKeyExport = ''
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'AEGISIdentityAgent'
$ExpectedAccount = 'NT SERVICE\AEGISIdentityAgent'
$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $service -or $service.StartName -ne $ExpectedAccount) { throw 'Identity Agent service identity mismatch' }
if (-not $PublicKeyExport) { $PublicKeyExport = Join-Path $EvidenceRoot 'machine-identity-public.pem' }
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
if (Test-Path -LiteralPath $keyPath) { throw 'Protected identity already exists; rotation requires a separate approved workflow' }

$python = Join-Path $InstallRoot '.venv\Scripts\python.exe'
$runner = Join-Path $InstallRoot 'run_identity_agent.py'
$resultPath = Join-Path $EvidenceRoot 'identity-provision-result.json'

if ($PSCmdlet.ShouldProcess($keyPath, 'Create one DPAPI CurrentUser-protected Ed25519 identity')) {
    if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath -Force }
    if (Test-Path -LiteralPath $PublicKeyExport) { throw 'Public-key export already exists' }
    $original = $service.PathName
    $generateCommand = ('"{0}" "{1}" --generate-key --node-id "{2}" --key-version {3} --key-path "{4}" --public-key-export "{5}" --result-output "{6}"' -f
        $python, $runner, $NodeId, $KeyVersion, $keyPath, $PublicKeyExport, $resultPath)
    & sc.exe config $ServiceName "binPath= $generateCommand" | Out-Null
    try {
        & sc.exe start $ServiceName | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not (Test-Path -LiteralPath $resultPath) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 250
        }
        if (-not (Test-Path -LiteralPath $resultPath)) { throw 'Service-identity key generation did not produce evidence' }
    }
    finally {
        & sc.exe stop $ServiceName | Out-Null
        & sc.exe config $ServiceName "binPath= $original" | Out-Null
    }
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
