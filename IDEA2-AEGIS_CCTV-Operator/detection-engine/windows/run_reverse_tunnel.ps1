[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SshPath,

    [Parameter(Mandatory = $true)]
    [string]$TunnelHost,

    [Parameter(Mandatory = $true)]
    [string]$IdentityFile,

    [string]$RemoteBindAddress = '172.18.0.1',

    [ValidateRange(1, 65535)]
    [int]$RemotePort = 18077,

    [string]$LocalHost = '127.0.0.1',

    [ValidateRange(1, 65535)]
    [int]$LocalPort = 8077
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedSsh = (Resolve-Path -LiteralPath $SshPath).Path
$resolvedIdentity = (Resolve-Path -LiteralPath $IdentityFile).Path
if ($TunnelHost -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$') {
    throw 'TunnelHost must use user@host without spaces or shell characters.'
}
$parsedRemoteAddress = $null
if (-not [Net.IPAddress]::TryParse($RemoteBindAddress, [ref]$parsedRemoteAddress)) {
    throw 'RemoteBindAddress must be a literal IP address.'
}

$stateRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) `
    'AEGIS\DetectionEngine'
$logDirectory = Join-Path $stateRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stdoutLog = Join-Path $logDirectory 'reverse-tunnel.stdout.log'
$stderrLog = Join-Path $logDirectory 'reverse-tunnel.stderr.log'
$wrapperLog = Join-Path $logDirectory 'reverse-tunnel-wrapper.log'

$forward = "${RemoteBindAddress}:${RemotePort}:${LocalHost}:${LocalPort}"
$sshArguments = @(
    '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'IdentitiesOnly=yes',
    '-i', ('"{0}"' -f $resolvedIdentity),
    '-R', $forward,
    $TunnelHost
)

$startedAt = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
"[$startedAt] Starting IDEA2 reverse tunnel to $TunnelHost ($forward)." |
    Out-File -LiteralPath $wrapperLog -Encoding utf8 -Append

# Server-side sshd PermitListen remains the final authorization boundary.
# This client only requests the configured bind and cannot broaden that policy.
$tunnelProcess = Start-Process -FilePath $resolvedSsh `
    -ArgumentList $sshArguments `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden -PassThru -Wait
$tunnelExitCode = $tunnelProcess.ExitCode

$stoppedAt = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
"[$stoppedAt] Reverse tunnel exited with code $tunnelExitCode." |
    Out-File -LiteralPath $wrapperLog -Encoding utf8 -Append

# Non-zero lets Task Scheduler apply the same bounded restart policy.
exit $tunnelExitCode
