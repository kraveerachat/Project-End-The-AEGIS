[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9-]+(\.twingate\.com)?$')]
    [string]$TwingateNetwork,

    [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Results = [ordered]@{}
$script:TwingatePreExisting = $false

function Set-Result {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Status
    )
    $script:Results[$Name] = $Status
}

function Test-IsWindows {
    return ($env:OS -eq 'Windows_NT')
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal -ArgumentList $identity
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-OnboardingConfig {
    $configPath = Join-Path $PSScriptRoot 'endpoint-onboarding.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw 'CONFIG_FILE_MISSING'
    }
    return Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}

function Test-RootCaArtifact {
    param([Parameter(Mandatory = $true)]$Config)

    $certPath = Join-Path $PSScriptRoot 'certificates\aegis-root-ca.crt'
    if (-not (Test-Path -LiteralPath $certPath -PathType Leaf)) {
        throw 'ROOT_CA_FILE_MISSING'
    }

    $hash = (Get-FileHash -LiteralPath $certPath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($hash -ne ([string]$Config.rootCaSha256).ToUpperInvariant()) {
        throw 'ROOT_CA_HASH_DRIFT'
    }

    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $certPath
    if ($cert.Thumbprint.ToUpperInvariant() -ne ([string]$Config.rootCaThumbprint).ToUpperInvariant()) {
        throw 'ROOT_CA_THUMBPRINT_DRIFT'
    }
    if ($cert.Subject -ne [string]$Config.rootCaSubject) {
        throw 'ROOT_CA_SUBJECT_DRIFT'
    }
    if ($cert.Subject -ne $cert.Issuer) {
        throw 'ROOT_CA_NOT_SELF_ISSUED'
    }

    return @{ Path = $certPath; Certificate = $cert }
}

function Ensure-RootCaTrusted {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)]$Artifact,
        [switch]$VerifyOnly
    )

    $expected = ([string]$Config.rootCaThumbprint).ToUpperInvariant()
    $existing = @(Get-ChildItem -Path 'Cert:\LocalMachine\Root' |
        Where-Object { $_.Thumbprint.ToUpperInvariant() -eq $expected })

    if ($existing.Count -gt 1) {
        throw 'ROOT_CA_DUPLICATE_TRUST_ANCHOR'
    }
    if ($existing.Count -eq 1) {
        return 'ALREADY_INSTALLED'
    }
    if ($VerifyOnly) {
        return 'PENDING'
    }

    Import-Certificate -FilePath $Artifact.Path -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null

    $verified = @(Get-ChildItem -Path 'Cert:\LocalMachine\Root' |
        Where-Object { $_.Thumbprint.ToUpperInvariant() -eq $expected })
    if ($verified.Count -ne 1) {
        throw 'ROOT_CA_IMPORT_VERIFY_FAILED'
    }
    return 'PASS'
}

function Get-TwingateInstallState {
    $roots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )

    $match = Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'Twingate*' } |
        Select-Object -First 1

    return $match
}

function Normalize-TwingateNetwork {
    param([Parameter(Mandatory = $true)][string]$Network)

    $value = $Network.Trim().ToLowerInvariant()
    if ($value -match '^[a-z0-9-]+$') {
        return "$value.twingate.com"
    }
    if ($value -match '^[a-z0-9-]+\.twingate\.com$') {
        return $value
    }
    throw 'TWINGATE_NETWORK_INVALID'
}

function Ensure-TwingateInstalled {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [string]$Network,
        [switch]$VerifyOnly
    )

    $existing = Get-TwingateInstallState
    if ($null -ne $existing) {
        $script:TwingatePreExisting = $true
        return 'ALREADY_INSTALLED'
    }

    $script:TwingatePreExisting = $false
    if ($VerifyOnly) {
        return 'PENDING'
    }
    if ([string]::IsNullOrWhiteSpace($Network)) {
        throw 'TWINGATE_NETWORK_REQUIRED'
    }

    $normalized = Normalize-TwingateNetwork -Network $Network
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("AEGIS-Twingate-" + [guid]::NewGuid().ToString('N'))
    $installer = Join-Path $tempDir 'TwingateWindowsInstaller.exe'

    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    try {
        Invoke-WebRequest -Uri ([string]$Config.twingateInstallerUri) -OutFile $installer -UseBasicParsing

        $signature = Get-AuthenticodeSignature -FilePath $installer
        if ($signature.Status -ne 'Valid') {
            throw "TWINGATE_INSTALLER_SIGNATURE_$($signature.Status)"
        }

        $args = @('/qn', "network=$normalized", 'auto_update=true')
        $process = Start-Process -FilePath $installer -ArgumentList $args -Wait -PassThru
        if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
            throw "TWINGATE_INSTALL_FAILED_$($process.ExitCode)"
        }

        if ($null -eq (Get-TwingateInstallState)) {
            throw 'TWINGATE_INSTALL_VERIFY_FAILED'
        }

        if ($process.ExitCode -eq 3010) {
            return 'PASS_REBOOT_REQUIRED'
        }
        return 'PASS'
    }
    finally {
        if (Test-Path -LiteralPath $tempDir) {
            Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-AegisShortcutPath {
    $programs = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'
    return Join-Path $programs 'AEGIS.lnk'
}

function Ensure-AegisShortcut {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [switch]$VerifyOnly
    )

    $shortcutPath = Get-AegisShortcutPath
    $shell = New-Object -ComObject WScript.Shell

    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        $existing = $shell.CreateShortcut($shortcutPath)
        if (($existing.TargetPath -ieq "$env:SystemRoot\explorer.exe") -and
            ($existing.Arguments.Trim('"') -eq $Url)) {
            return 'ALREADY_EXISTS'
        }
        if ($VerifyOnly) {
            return 'DRIFT'
        }
    }
    elseif ($VerifyOnly) {
        return 'PENDING'
    }

    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = "$env:SystemRoot\explorer.exe"
    $shortcut.Arguments = $Url
    $shortcut.Description = 'Open AEGIS secure internal portal'
    $shortcut.WorkingDirectory = $env:SystemRoot
    $shortcut.Save()

    $check = $shell.CreateShortcut($shortcutPath)
    if (($check.TargetPath -ine "$env:SystemRoot\explorer.exe") -or
        ($check.Arguments.Trim('"') -ne $Url)) {
        throw 'AEGIS_SHORTCUT_VERIFY_FAILED'
    }
    return 'PASS'
}

function Invoke-CurlProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [switch]$BestEffortRevocation
    )

    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($null -eq $curl) {
        return @{ ExitCode = 127; HttpCode = '000'; Error = 'CURL_NOT_FOUND' }
    }

    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("AEGIS-Curl-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $stdout = Join-Path $tempDir 'stdout.txt'
    $stderr = Join-Path $tempDir 'stderr.txt'

    try {
        $arguments = @('-sS', '-o', 'NUL', '-w', '%{http_code}')
        if ($BestEffortRevocation) {
            $arguments += '--ssl-revoke-best-effort'
        }
        $arguments += $Url

        $process = Start-Process -FilePath $curl.Source -ArgumentList $arguments -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $httpCode = if (Test-Path $stdout) { (Get-Content -LiteralPath $stdout -Raw).Trim() } else { '000' }
        $errorText = if (Test-Path $stderr) { (Get-Content -LiteralPath $stderr -Raw).Trim() } else { '' }
        return @{ ExitCode = $process.ExitCode; HttpCode = $httpCode; Error = $errorText }
    }
    finally {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-AegisEndpoint {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][bool]$TwingateInstalled
    )

    $probe = Invoke-CurlProbe -Url $Url
    if ($probe.ExitCode -eq 0 -and $probe.HttpCode -eq '200') {
        return 'PASS'
    }

    if ($probe.Error -match 'CRYPT_E_NO_REVOCATION_CHECK|0x80092012') {
        $retry = Invoke-CurlProbe -Url $Url -BestEffortRevocation
        if ($retry.ExitCode -eq 0 -and $retry.HttpCode -eq '200') {
            return 'PASS_WITH_REVOCATION_LIMITATION'
        }
        return "FAIL_TLS_REVOCATION_RETRY_$($retry.ExitCode)"
    }

    if ($TwingateInstalled -and ($probe.HttpCode -eq '000')) {
        return 'PENDING_TWINGATE_LOGIN'
    }
    if ($probe.ExitCode -eq 0) {
        return "FAIL_HTTP_$($probe.HttpCode)"
    }
    return "FAIL_CONNECT_$($probe.ExitCode)"
}

function Save-OnboardingState {
    param(
        [Parameter(Mandatory = $true)]$Config,
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][bool]$TwingatePreExisting,
        [switch]$VerifyOnly
    )

    if ($VerifyOnly) { return }

    $stateDir = Join-Path $env:ProgramData 'AEGIS'
    $statePath = Join-Path $stateDir 'endpoint-onboarding-state.json'
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null

    [ordered]@{
        version = 1
        rootCaThumbprint = [string]$Config.rootCaThumbprint
        shortcutPath = $ShortcutPath
        twingatePreExisting = $TwingatePreExisting
        primaryUrl = [string]$Config.aegisUrl
    } | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Show-Summary {
    Write-Host ''
    Write-Host 'AEGIS ENDPOINT ONBOARDING'
    foreach ($item in $script:Results.GetEnumerator()) {
        Write-Host ('{0,-22} {1}' -f $item.Key, $item.Value)
    }
    Write-Host ''
    Write-Host 'NEXT: Sign in to Twingate, then open https://aegis.internal/'
}

$exitCode = 0
try {
    if (-not (Test-IsWindows)) {
        Set-Result 'Windows' 'FAIL'
        throw 'WINDOWS_REQUIRED'
    }
    Set-Result 'Windows' 'PASS'

    if (-not (Test-IsAdministrator)) {
        Set-Result 'Administrator' 'FAIL'
        throw 'ADMINISTRATOR_REQUIRED'
    }
    Set-Result 'Administrator' 'PASS'

    $config = Get-OnboardingConfig
    $artifact = Test-RootCaArtifact -Config $config
    $rootStatus = Ensure-RootCaTrusted -Config $config -Artifact $artifact -VerifyOnly:$VerifyOnly
    Set-Result 'AEGIS Root CA' $rootStatus

    $twingateStatus = Ensure-TwingateInstalled -Config $config -Network $TwingateNetwork -VerifyOnly:$VerifyOnly
    Set-Result 'Twingate' $twingateStatus
    $twingateInstalled = ($twingateStatus -in @('PASS', 'PASS_REBOOT_REQUIRED', 'ALREADY_INSTALLED'))

    $shortcutStatus = Ensure-AegisShortcut -Url ([string]$config.aegisUrl) -VerifyOnly:$VerifyOnly
    Set-Result 'AEGIS Shortcut' $shortcutStatus

    $endpointStatuses = @()
    $allUrls = @([string]$config.aegisUrl) + @($config.healthUrls | ForEach-Object { [string]$_ })
    foreach ($url in $allUrls) {
        $endpointStatuses += Test-AegisEndpoint -Url $url -TwingateInstalled:$twingateInstalled
    }

    if ($endpointStatuses -contains 'PENDING_TWINGATE_LOGIN') {
        Set-Result 'AEGIS HTTPS' 'PENDING_TWINGATE_LOGIN'
    }
    elseif (@($endpointStatuses | Where-Object { $_ -like 'FAIL_*' }).Count -gt 0) {
        Set-Result 'AEGIS HTTPS' (($endpointStatuses | Where-Object { $_ -like 'FAIL_*' } | Select-Object -First 1))
        $exitCode = 1
    }
    elseif ($endpointStatuses -contains 'PASS_WITH_REVOCATION_LIMITATION') {
        Set-Result 'AEGIS HTTPS' 'PASS_WITH_REVOCATION_LIMITATION'
    }
    else {
        Set-Result 'AEGIS HTTPS' 'PASS'
    }

    Save-OnboardingState -Config $config -ShortcutPath (Get-AegisShortcutPath) -TwingatePreExisting:$script:TwingatePreExisting -VerifyOnly:$VerifyOnly
}
catch {
    if (-not $script:Results.Contains('Failure')) {
        Set-Result 'Failure' $_.Exception.Message
    }
    $exitCode = 1
}
finally {
    Show-Summary
}

exit $exitCode
