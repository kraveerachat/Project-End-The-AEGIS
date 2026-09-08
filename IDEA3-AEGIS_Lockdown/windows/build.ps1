#Requires -Version 7.0
<#
.SYNOPSIS
    Build the deterministic AEGIS IDEA3 Windows standalone bundle.

.DESCRIPTION
    Fail-fast staged build. Every stage must succeed before the next runs. The
    script never embeds a secret: configuration, databases, logs, and .env files
    are excluded from the payload and a forbidden-artifact scan runs before the
    ZIP is produced. Windows-only by design; it refuses to run elsewhere.
#>

[CmdletBinding()]
param(
    [switch]$SkipTests,
    [string]$NodeArchive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$WindowsDir   = Join-Path $ProjectRoot 'windows'
$WebDir       = Join-Path $ProjectRoot 'web'
$CacheDir     = Join-Path $WindowsDir 'cache'
$OutDir       = Join-Path $WindowsDir 'out'
$StageDir     = Join-Path $OutDir 'AEGIS-IDEA3'

function Write-Stage([string]$Name) { Write-Host "==> $Name" -ForegroundColor Cyan }
function Fail([string]$Message) { throw "BUILD FAILED: $Message" }

# ---------------------------------------------------------------- stage 1
Write-Stage 'Verify host platform'
if (-not $IsWindows) { Fail 'this bundle must be built on Windows' }
if ([System.Environment]::Is64BitOperatingSystem -ne $true) { Fail 'x64 Windows is required' }

# ---------------------------------------------------------------- stage 2
Write-Stage 'Verify clean source tree'
$dirty = & git -C $ProjectRoot status --porcelain
if ($LASTEXITCODE -ne 0) { Fail 'git status failed' }
if ($dirty) { Fail "source tree is dirty; commit or stash first:`n$dirty" }
$sourceSha = (& git -C $ProjectRoot rev-parse HEAD).Trim()

# ---------------------------------------------------------------- stage 3
Write-Stage 'Verify pinned toolchain'
$lock = Get-Content (Join-Path $WindowsDir 'toolchain-lock.json') -Raw | ConvertFrom-Json
$nodeVersion = $lock.node.version
$expectedNodeHash = $lock.node.sha256

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
if (-not $NodeArchive) { $NodeArchive = Join-Path $CacheDir $lock.node.filename }
if (-not (Test-Path $NodeArchive)) {
    Write-Host "downloading $($lock.node.url)"
    Invoke-WebRequest -Uri $lock.node.url -OutFile $NodeArchive -UseBasicParsing
}
$actualNodeHash = (Get-FileHash -Path $NodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualNodeHash -ne $expectedNodeHash) {
    Fail "Node archive SHA-256 mismatch`n  expected $expectedNodeHash`n  actual   $actualNodeHash"
}

# ---------------------------------------------------------------- stage 4
Write-Stage 'Run source verification'
if (-not $SkipTests) {
    & python -m pytest -p no:cacheprovider -q
    if ($LASTEXITCODE -ne 0) { Fail 'Python tests failed' }

    Push-Location $WebDir
    try {
        & npm test
        if ($LASTEXITCODE -ne 0) { Fail 'Web tests failed' }
        & npm run build
        if ($LASTEXITCODE -ne 0) { Fail 'Web production build failed' }
    } finally { Pop-Location }
}

# ---------------------------------------------------------------- stage 5
Write-Stage 'Prepare clean staging directory'
if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

# ---------------------------------------------------------------- stage 6
Write-Stage 'Build launcher executable'
& python -m PyInstaller --noconfirm --clean `
    --distpath (Join-Path $WindowsDir 'dist') `
    --workpath (Join-Path $WindowsDir 'build') `
    (Join-Path $WindowsDir 'aegis-idea3.spec')
if ($LASTEXITCODE -ne 0) { Fail 'pyinstaller failed' }
Copy-Item -Recurse -Force (Join-Path $WindowsDir 'dist' 'AEGIS-IDEA3' '*') $StageDir

# ---------------------------------------------------------------- stage 7
Write-Stage 'Assemble Node runtime'
$nodeStage = Join-Path $StageDir 'node'
$extracted = Join-Path $CacheDir "node-v$nodeVersion-win-x64"
if (-not (Test-Path $extracted)) { Expand-Archive -Path $NodeArchive -DestinationPath $CacheDir -Force }
New-Item -ItemType Directory -Force -Path $nodeStage | Out-Null
Copy-Item -Force (Join-Path $extracted 'node.exe') $nodeStage

# ---------------------------------------------------------------- stage 8
Write-Stage 'Assemble server payload'
$serverStage = Join-Path $StageDir 'server'
New-Item -ItemType Directory -Force -Path $serverStage | Out-Null
foreach ($item in @('server', 'package.json', 'package-lock.json')) {
    Copy-Item -Recurse -Force (Join-Path $WebDir $item) $serverStage
}
Push-Location $serverStage
try {
    & npm ci --omit=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) { Fail 'production dependency install failed' }
} finally { Pop-Location }

Write-Stage 'Assemble built Web assets'
Copy-Item -Recurse -Force (Join-Path $WebDir 'dist') (Join-Path $StageDir 'web')

Write-Stage 'Assemble configuration template and notices'
Copy-Item -Force (Join-Path $ProjectRoot '.env.example') (Join-Path $StageDir 'config.env.template')
Copy-Item -Force (Join-Path $WindowsDir 'toolchain-lock.json') (Join-Path $StageDir 'toolchain-lock.json')

# ---------------------------------------------------------------- stage 9
Write-Stage 'Scan for forbidden artifacts'
$forbiddenNames = @('.env', '*.sqlite', '*.sqlite3', '*.sqlite-wal', '*.sqlite-shm', '*.log', 'secrets.h')
foreach ($pattern in $forbiddenNames) {
    $hits = Get-ChildItem -Path $StageDir -Recurse -Force -Filter $pattern -ErrorAction SilentlyContinue
    if ($hits) { Fail "forbidden artifact in payload: $pattern`n$($hits.FullName -join "`n")" }
}
if (Test-Path (Join-Path $StageDir 'web' 'node_modules')) { Fail 'node_modules leaked into the Web asset layer' }
$secretPattern = 'SESSION_SECRET=\S|AEGIS_MQTT_PASS=\S|AEGIS_HMAC_SECRET=\S|BEGIN [A-Z ]*PRIVATE KEY'
$leaks = Get-ChildItem -Path $StageDir -Recurse -File -Include *.js,*.json,*.txt,*.template |
    Select-String -Pattern $secretPattern -List
if ($leaks) { Fail "possible secret value in payload:`n$($leaks.Path -join "`n")" }

# ---------------------------------------------------------------- stage 10
Write-Stage 'Write manifest'
$files = Get-ChildItem -Path $StageDir -Recurse -File | Sort-Object FullName
$manifest = [ordered]@{
    schemaVersion = 1
    sourceCommit  = $sourceSha
    builtOn       = 'windows-x64'
    node          = @{ version = $nodeVersion; sha256 = $expectedNodeHash }
    fileCount     = $files.Count
    files         = @($files | ForEach-Object {
        [ordered]@{
            path   = $_.FullName.Substring($StageDir.Length + 1).Replace('\', '/')
            sha256 = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    })
}
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $StageDir 'manifest.json') -Encoding utf8

# ---------------------------------------------------------------- stage 11
Write-Stage 'Create distributable archive'
$zipPath = Join-Path $OutDir "AEGIS-IDEA3-$($sourceSha.Substring(0,12)).zip"
Compress-Archive -Path $StageDir -DestinationPath $zipPath -Force
$zipHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()

# ---------------------------------------------------------------- stage 12
Write-Stage 'Verify source tree is still clean'
$dirtyAfter = & git -C $ProjectRoot status --porcelain
if ($dirtyAfter) { Fail "build modified the source tree:`n$dirtyAfter" }

Write-Host ''
Write-Host "BUILD OK" -ForegroundColor Green
Write-Host "  source commit : $sourceSha"
Write-Host "  artifact      : $zipPath"
Write-Host "  artifact hash : $zipHash"
Write-Host "  NOTE: Windows smoke acceptance is a separate manual gate."
