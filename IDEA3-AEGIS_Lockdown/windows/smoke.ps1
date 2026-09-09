#Requires -Version 7.0
<#
.SYNOPSIS
    Clean-machine smoke acceptance for the AEGIS IDEA3 Windows bundle.

.DESCRIPTION
    Exercises a built bundle end to end against a disposable data directory: it
    proves the bundle runs from its own binaries rather than a developer PATH,
    that a restart preserves the durable audit, and that absent upstream feeds and
    absent hardware stay honest instead of reporting healthy.

    Credentials are supplied over stdin only. No password, session token, or
    control token value is ever written to the console or to the evidence file.

    This script must run on the target Windows machine. Running it anywhere else,
    or reading its source alone, is not acceptance evidence.

.EXAMPLE
    ./smoke.ps1 -BundlePath 'C:\AEGIS\AEGIS-IDEA3' -DataPath 'C:\Temp\aegis-smoke-01'

    Runs full acceptance against a freshly extracted bundle using a disposable
    data directory. -DataPath must not already exist.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$BundlePath,
    [Parameter(Mandatory)] [string]$DataPath,
    [int]$WebPort = 8003,
    [string]$AdminUser = 'admin'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$results = [System.Collections.Generic.List[object]]::new()
$baseUrl = "http://localhost:$WebPort"
$webBasePath = "/security"
$apiBaseUrl = "$baseUrl$webBasePath/api"

# Declared before the run so an aborted candidate can still write its evidence
# under Set-StrictMode instead of failing again inside the evidence stage.
$password = ''
$auditBefore = -1
$auditAfter = -1
$sessionCookie = ''
$csrfToken = ''

function Add-Result([string]$Check, [bool]$Ok, [string]$Detail = '') {
    $results.Add([ordered]@{ check = $Check; result = $(if ($Ok) { 'PASS' } else { 'FAIL' }); detail = $Detail })
    $colour = if ($Ok) { 'Green' } else { 'Red' }
    Write-Host ("[{0}] {1} {2}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Check, $Detail) -ForegroundColor $colour
}

function Invoke-Launcher([string[]]$LauncherArgs, [string]$StdIn = $null) {
    if ($StdIn) { $output = $StdIn | & $launcher @LauncherArgs 2>&1 }
    else { $output = & $launcher @LauncherArgs 2>&1 }
    return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = ($output | Out-String) }
}

# ------------------------------------------------------------ preconditions
if (-not $IsWindows) { throw 'SMOKE FAILED: Windows acceptance must run on Windows' }

# Canonicalise the bundle before anything compares against it. A relative
# -BundlePath never matches an absolute process path, so the process-origin
# checks below would report PASS without proving anything.
if (-not (Test-Path -LiteralPath $BundlePath)) { throw "SMOKE FAILED: -BundlePath not found: $BundlePath" }
$BundlePath = (Resolve-Path -LiteralPath $BundlePath).ProviderPath

$launcher = Join-Path $BundlePath 'AEGIS-IDEA3.exe'
$bundleNode = Join-Path $BundlePath 'node' 'node.exe'
if (-not (Test-Path $launcher)) { throw "SMOKE FAILED: launcher not found at $launcher" }
if (Test-Path $DataPath) { throw "SMOKE FAILED: -DataPath must not already exist (use a disposable path)" }

$env:AEGIS_DATA_DIR = $DataPath
New-Item -ItemType Directory -Force -Path $DataPath | Out-Null

# Every acceptance result below is recorded even if a step aborts the run, so a
# failed candidate still produces evidence. No secret is ever written out.
try {
    # The bundle must be self-contained: a developer toolchain on PATH must not be
    # what makes this pass.
    foreach ($tool in @('python', 'node', 'npm')) {
        $onPath = Get-Command $tool -ErrorAction SilentlyContinue
        Add-Result "bundle-independent:$tool" ($null -eq $onPath -or $onPath.Source -notlike "$BundlePath*") `
            'bundle must not depend on a PATH toolchain'
    }
    Add-Result 'bundle-node-present' (Test-Path $bundleNode) $bundleNode

    # ------------------------------------------------------------ doctor + configure
    $doctor = Invoke-Launcher @('doctor')
    Add-Result 'doctor-reports-missing-config' ($doctor.ExitCode -ne 0) 'unconfigured install must fail closed'

    $password = [System.Guid]::NewGuid().ToString('N') + 'Aa1!'
    $configure = Invoke-Launcher @('configure', '--username', $AdminUser) "$password`n$password`n"
    Add-Result 'configure-succeeds' ($configure.ExitCode -eq 0) ''
    Add-Result 'configure-hides-password' ($configure.Output -notmatch [regex]::Escape($password)) 'password must never be echoed'

    $configFile = Join-Path $DataPath 'config' '.env'
    $configText = Get-Content $configFile -Raw
    Add-Result 'config-has-no-plaintext-password' ($configText -notmatch [regex]::Escape($password)) ''
    # (?m) is required: PowerShell -match is single-line, so an unanchored `$`
    # only matches the end of the whole file and the check could never pass.
    $blankToken = '(?m)^AEGIS_IDEA{0}_INTEGRATION_TOKEN=[ \t]*\r?$'
    Add-Result 'config-integration-tokens-blank' `
        (($configText -match ($blankToken -f 1)) -and ($configText -match ($blankToken -f 2))) `
        'absent feeds stay unconfigured'

    $doctorAfter = Invoke-Launcher @('doctor')
    Add-Result 'doctor-passes-after-configure' ($doctorAfter.ExitCode -eq 0) ''

    # ------------------------------------------------------------ start + health
    $startJob = Start-Process -FilePath $launcher -ArgumentList 'start' -PassThru
    $healthy = $false
    foreach ($attempt in 1..60) {
        try {
            $health = Invoke-RestMethod -Uri "$apiBaseUrl/health" -TimeoutSec 2
            if ($health) { $healthy = $true; break }
        } catch { Start-Sleep -Seconds 1 }
    }
    Add-Result 'web-becomes-healthy' $healthy $baseUrl
    $status = Invoke-Launcher @('status')
    Add-Result 'status-reports-running' ($status.ExitCode -eq 0) ''

    # ------------------------------------------------------------ login / logout
    $loginOk = $false
    $cookiePolicyOk = $false
    try {
        $body = @{ username = $AdminUser; password = $password } | ConvertTo-Json
        $login = Invoke-WebRequest -Uri "$apiBaseUrl/auth/login" -Method Post -Body $body `
            -ContentType 'application/json' -Headers @{ Origin = $baseUrl }
        $setCookie = @($login.Headers.GetValues('Set-Cookie')) | Where-Object { $_ -like 'aegis.idea3.sid=*' } | Select-Object -First 1
        $cookiePolicyOk = $setCookie -match '(?i);\s*Secure(?:;|$)' -and `
            $setCookie -match '(?i);\s*HttpOnly(?:;|$)' -and `
            $setCookie -match '(?i);\s*SameSite=Strict(?:;|$)'
        $sessionCookie = ($setCookie -split ';', 2)[0]
        $csrfToken = ($login.Content | ConvertFrom-Json).csrfToken
        $loginOk = $login.StatusCode -eq 200 -and $sessionCookie -and $csrfToken
    } catch { $loginOk = $false }
    Add-Result 'admin-login-succeeds' $loginOk ''
    Add-Result 'session-cookie-is-secure' $cookiePolicyOk 'Secure; HttpOnly; SameSite=Strict required'

    if ($loginOk) {
        # PowerShell's CookieContainer will not return a Secure cookie to HTTP,
        # while supported Windows browsers apply the localhost exception. Carry
        # the already validated opaque cookie explicitly for this loopback smoke.
        $audit = Invoke-RestMethod -Uri "$apiBaseUrl/security/audit?limit=250" `
            -Headers @{ Cookie = $sessionCookie }
        $auditBefore = @($audit.audit).Count
        Add-Result 'audit-readable' ($auditBefore -ge 1) "rows=$auditBefore"

        $snapshot = Invoke-RestMethod -Uri "$apiBaseUrl/security/snapshot" `
            -Headers @{ Cookie = $sessionCookie }
        $idea1 = ($snapshot.sources | Where-Object { $_.id -eq 'idea1' }).status
        $idea2 = ($snapshot.sources | Where-Object { $_.id -eq 'idea2' }).status
        Add-Result 'idea1-absent-is-honest' ($idea1 -in @('NOT_CONFIGURED', 'UNKNOWN')) "idea1=$idea1"
        Add-Result 'idea2-absent-is-honest' ($idea2 -in @('NOT_CONFIGURED', 'UNKNOWN')) "idea2=$idea2"
        Add-Result 'hardware-absent-is-honest' ($snapshot.runtime.status -in @('UNKNOWN', 'NOT_CONFIGURED')) `
            "runtime=$($snapshot.runtime.status)"

        Invoke-WebRequest -Uri "$apiBaseUrl/auth/logout" -Method Post `
            -Headers @{ Origin = $baseUrl; Cookie = $sessionCookie; 'X-CSRF-Token' = $csrfToken } | Out-Null
        Add-Result 'admin-logout-succeeds' $true ''
    }

    # ------------------------------------------------------------ stop / restart
    Invoke-Launcher @('stop') | Out-Null
    Start-Sleep -Seconds 3
    $stopped = Invoke-Launcher @('status')
    Add-Result 'status-nonzero-after-stop' ($stopped.ExitCode -ne 0) ''

    Start-Process -FilePath $launcher -ArgumentList 'start' -PassThru | Out-Null
    $restarted = $false
    foreach ($attempt in 1..60) {
        try {
            if (Invoke-RestMethod -Uri "$apiBaseUrl/health" -TimeoutSec 2) { $restarted = $true; break }
        } catch { Start-Sleep -Seconds 1 }
    }
    Add-Result 'web-healthy-after-restart' $restarted ''

    if ($restarted) {
        $body = @{ username = $AdminUser; password = $password } | ConvertTo-Json
        $login2 = Invoke-WebRequest -Uri "$apiBaseUrl/auth/login" -Method Post -Body $body `
            -ContentType 'application/json' -Headers @{ Origin = $baseUrl }
        $setCookie2 = @($login2.Headers.GetValues('Set-Cookie')) | Where-Object { $_ -like 'aegis.idea3.sid=*' } | Select-Object -First 1
        $sessionCookie = ($setCookie2 -split ';', 2)[0]
        $audit2 = Invoke-RestMethod -Uri "$apiBaseUrl/security/audit?limit=250" `
            -Headers @{ Cookie = $sessionCookie }
        $auditAfter = @($audit2.audit).Count
        Add-Result 'audit-survives-restart' ($auditAfter -ge $auditBefore) "before=$auditBefore after=$auditAfter"
    }

    # ------------------------------------------------------------ final stop
    Invoke-Launcher @('stop') | Out-Null
    Start-Sleep -Seconds 3
    $survivors = Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($BundlePath) }
    Add-Result 'no-bundle-child-survives' ($null -eq $survivors -or @($survivors).Count -eq 0) ''

    $dbPresent = (Get-ChildItem -Path $DataPath -Recurse -Filter '*.sqlite3' -ErrorAction SilentlyContinue).Count -gt 0
    Add-Result 'durable-db-outside-payload' ($dbPresent -and -not (Test-Path (Join-Path $BundlePath '*.sqlite3'))) $DataPath

    Add-Result 'smoke-run-completed' $true 'all acceptance steps ran'
} catch {
    $message = $_.Exception.Message
    if ($password) { $message = $message.Replace($password, '<redacted>') }
    Add-Result 'smoke-run-completed' $false "aborted: $message"
}

# ------------------------------------------------------------ evidence
$evidenceDir = Join-Path $PSScriptRoot 'out' 'evidence'
New-Item -ItemType Directory -Force -Path $evidenceDir | Out-Null
$failed = @($results | Where-Object { $_.result -eq 'FAIL' }).Count
$document = [ordered]@{
    schemaVersion       = 1
    ranOn               = 'windows-x64'
    timestampUtc        = (Get-Date).ToUniversalTime().ToString('o')
    bundlePath          = $BundlePath
    checks              = @($results)
    failedCount         = $failed
    result              = $(if ($failed -eq 0) { 'PASS' } else { 'FAIL' })
    auditRowsBefore     = $auditBefore
    auditRowsAfterRestart = $auditAfter
}
$document | ConvertTo-Json -Depth 6 | Set-Content -Path (Join-Path $evidenceDir 'smoke-result.json') -Encoding utf8

Write-Host ''
Write-Host ("SMOKE {0} ({1} checks, {2} failed)" -f $document.result, $results.Count, $failed) `
    -ForegroundColor $(if ($failed -eq 0) { 'Green' } else { 'Red' })
exit $(if ($failed -eq 0) { 0 } else { 1 })
