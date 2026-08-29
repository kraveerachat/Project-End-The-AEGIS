[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TunnelHost,
    [Parameter(Mandatory = $true)]
    [string]$IdentityFile,
    [Parameter(Mandatory = $true)]
    [string]$KnownHostsFile,
    [string]$SshPath = "$env:SystemRoot\System32\OpenSSH\ssh.exe",
    [string]$MonitorTargetHost = '172.18.0.2',
    [ValidateRange(1, 65535)]
    [int]$MonitorTargetPort = 8002,
    [ValidateRange(1, 65535)]
    [int]$LocalForwardPort = 18002,
    [string]$RemoteBindAddress = '172.18.0.1',
    [ValidateRange(1, 65535)]
    [int]$RemotePort = 18077,
    [string]$EngineHost = '127.0.0.1',
    [ValidateRange(1, 65535)]
    [int]$EnginePort = 8077,
    [ValidateRange(0, 600)]
    [int]$StartupDelaySeconds = 30,
    [ValidateRange(1, 300)]
    [int]$ReconnectDelaySeconds = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

if ($TunnelHost -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$') {
    throw 'TunnelHost must use user@host without spaces or shell characters.'
}
if ($MonitorTargetHost -notmatch '^[A-Za-z0-9._:-]+$') {
    throw 'MonitorTargetHost contains unsupported characters.'
}
$parsedRemoteAddress = $null
if (-not [Net.IPAddress]::TryParse($RemoteBindAddress, [ref]$parsedRemoteAddress)) {
    throw 'RemoteBindAddress must be a literal IP address.'
}

$runtimeRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDirectory = Join-Path $runtimeRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$wrapperLog = Join-Path $logDirectory 'detection-tunnel-wrapper.log'
$stdoutLog = Join-Path $logDirectory 'detection-tunnel-ssh.stdout.log'
$stderrLog = Join-Path $logDirectory 'detection-tunnel-ssh.stderr.log'

function Write-TunnelLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    $timestamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
    "[$timestamp] $Message" | Out-File -LiteralPath $wrapperLog `
        -Encoding utf8 -Append
}

Write-TunnelLog "Detection Tunnel SYSTEM supervisor started. PID=$PID"
if ($StartupDelaySeconds -gt 0) {
    Start-Sleep -Seconds $StartupDelaySeconds
}

while ($true) {
    $missing = @(@(
            @{ Path = $SshPath; Label = 'ssh.exe' },
            @{ Path = $IdentityFile; Label = 'SSH identity' },
            @{ Path = $KnownHostsFile; Label = 'known_hosts' }
        ) | Where-Object { -not (Test-Path -LiteralPath $_.Path -PathType Leaf) })

    if ($missing.Count -gt 0) {
        Write-TunnelLog "Required tunnel file unavailable: $($missing[0].Label). Retrying in $ReconnectDelaySeconds seconds."
        Start-Sleep -Seconds $ReconnectDelaySeconds
        continue
    }

    $localForward = "127.0.0.1:${LocalForwardPort}:${MonitorTargetHost}:${MonitorTargetPort}"
    $reverseForward = "${RemoteBindAddress}:${RemotePort}:${EngineHost}:${EnginePort}"
    $sshArguments = @(
        '-N',
        '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', ('"UserKnownHostsFile={0}"' -f $KnownHostsFile),
        '-i', ('"{0}"' -f $IdentityFile),
        '-L', $localForward,
        '-R', $reverseForward,
        $TunnelHost
    )

    try {
        Write-TunnelLog "Starting SSH tunnel (local :$LocalForwardPort, reverse ${RemoteBindAddress}:$RemotePort)."
        $child = Start-Process -FilePath $SshPath `
            -ArgumentList $sshArguments `
            -RedirectStandardOutput $stdoutLog `
            -RedirectStandardError $stderrLog `
            -WindowStyle Hidden `
            -PassThru
        Write-TunnelLog "SSH child started. PID=$($child.Id)"
        $child.WaitForExit()
        Write-TunnelLog "SSH child exited. ExitCode=$($child.ExitCode)"
    }
    catch {
        Write-TunnelLog "SSH launch/wait error: $($_.Exception.Message)"
    }

    Write-TunnelLog "Reconnecting in $ReconnectDelaySeconds seconds."
    Start-Sleep -Seconds $ReconnectDelaySeconds
}
