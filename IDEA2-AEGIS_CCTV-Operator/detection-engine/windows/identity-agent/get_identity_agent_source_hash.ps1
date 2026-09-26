[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$identitySource = Join-Path $SourceRoot 'aegis_identity_agent'
$runnerSource = Join-Path $SourceRoot 'run_identity_agent.py'
$requirementsSource = Join-Path $SourceRoot 'requirements-identity-agent-windows.txt'
$requirementsLockSource = Join-Path $SourceRoot 'requirements-identity-agent-windows.lock.txt'
foreach ($requiredPath in @($identitySource, $runnerSource, $requirementsSource, $requirementsLockSource)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Missing Identity Agent source: $requiredPath"
    }
}

$manifestText = Get-ChildItem -LiteralPath $identitySource -File -Filter '*.py' |
    Sort-Object Name |
    ForEach-Object { "{0} {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash, $_.Name }
$manifestText += "{0} run_identity_agent.py" -f (Get-FileHash -LiteralPath $runnerSource -Algorithm SHA256).Hash
$manifestText += "{0} requirements-identity-agent-windows.txt" -f (Get-FileHash -LiteralPath $requirementsSource -Algorithm SHA256).Hash
$manifestText += "{0} requirements-identity-agent-windows.lock.txt" -f (Get-FileHash -LiteralPath $requirementsLockSource -Algorithm SHA256).Hash

$bytes = [Text.Encoding]::UTF8.GetBytes(($manifestText -join "`n"))
$sha = [Security.Cryptography.SHA256]::Create()
try {
    ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '')
}
finally {
    $sha.Dispose()
}
