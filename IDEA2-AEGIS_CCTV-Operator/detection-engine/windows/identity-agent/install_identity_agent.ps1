[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory=$true)][string]$SourceRoot,
    [Parameter(Mandatory=$true)][string]$ExpectedSourceSha256,
    [string]$InstallRoot = "$env:ProgramFiles\AEGIS\IdentityAgent",
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent"
)

$ErrorActionPreference = 'Stop'
$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($currentIdentity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Administrator elevation is required'
}
$ServiceName = 'AEGISIdentityAgent'
$ServiceAccount = 'NT SERVICE\AEGISIdentityAgent'
$identitySource = Join-Path $SourceRoot 'aegis_identity_agent'
$runnerSource = Join-Path $SourceRoot 'run_identity_agent.py'
$requirementsSource = Join-Path $SourceRoot 'requirements-identity-agent-windows.txt'
foreach ($required in @($identitySource, $runnerSource, $requirementsSource)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing source: $required" }
}

$manifestText = Get-ChildItem -LiteralPath $identitySource -File -Filter '*.py' |
    Sort-Object FullName |
    ForEach-Object { "{0} {1}" -f (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash, $_.Name }
$manifestText += "{0} run_identity_agent.py" -f (Get-FileHash -LiteralPath $runnerSource -Algorithm SHA256).Hash
$manifestText += "{0} requirements-identity-agent-windows.txt" -f (Get-FileHash -LiteralPath $requirementsSource -Algorithm SHA256).Hash
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($manifestText -join "`n")))
    $actualSha = ([BitConverter]::ToString($hashBytes)).Replace('-', '')
}
finally { $sha.Dispose() }
if ($actualSha -ne $ExpectedSourceSha256.ToUpperInvariant()) { throw 'Identity Agent source SHA mismatch' }

# Explicit deny-list for staged source. The Agent runtime never receives Engine
# .env, Git metadata, virtual environments, recordings, snapshots, models, or enrollment.
$ExcludedNames = @('.env', '.git', '.venv', 'segments', 'snapshots', '*.pt', '*.npz', '*.onnx', '*.h5')
if ($PSCmdlet.ShouldProcess($InstallRoot, 'Install isolated Identity Agent runtime')) {
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
    $installedPackage = Join-Path $InstallRoot 'aegis_identity_agent'
    New-Item -ItemType Directory -Path $installedPackage -Force | Out-Null
    Get-ChildItem -LiteralPath $identitySource -File -Filter '*.py' |
        Copy-Item -Destination $installedPackage -Force
    Copy-Item -LiteralPath $runnerSource -Destination $InstallRoot -Force
    Copy-Item -LiteralPath $requirementsSource -Destination $InstallRoot -Force
    py -3.14 -m venv (Join-Path $InstallRoot '.venv')
    $python = Join-Path $InstallRoot '.venv\Scripts\python.exe'
    & $python -m pip install --requirement (Join-Path $InstallRoot 'requirements-identity-agent-windows.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Identity Agent dependency installation failed' }

    & icacls.exe $InstallRoot /inheritance:r /grant:r "${ServiceAccount}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
    & icacls.exe $DataRoot /inheritance:r /grant:r "${ServiceAccount}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' /setowner "$ServiceAccount" | Out-Null
    $runner = Join-Path $InstallRoot 'run_identity_agent.py'
    $binPath = ('"{0}" "{1}" --service' -f $python, $runner)
    & sc.exe create $ServiceName "binPath= $binPath" "obj= $ServiceAccount" 'start= auto' | Out-Null
    & sc.exe sidtype $ServiceName unrestricted | Out-Null
    & sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/none/0 | Out-Null
    & sc.exe stop $ServiceName | Out-Null
}

'SERVICE_NAME=AEGISIdentityAgent'
'SERVICE_ACCOUNT=NT SERVICE\AEGISIdentityAgent'
'SERVICE_START_MODE=Automatic'
'SERVICE_STARTED=NO'
'DPAPI_PREFLIGHT_REQUIRED=YES'
