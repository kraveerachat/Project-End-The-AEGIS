[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SourceIdentityFile,
    [Parameter(Mandatory = $true)]
    [string]$RuntimeIdentityFile,
    [Parameter(Mandatory = $true)]
    [string]$KnownHostsFile,
    [Parameter(Mandatory = $true)]
    [string]$TunnelHost,
    [Parameter(Mandatory = $true)]
    [string]$ResultFile,
    [string]$RuntimeRoot = '',
    [string]$SshPath = "$env:SystemRoot\System32\OpenSSH\ssh.exe",
    [string]$MonitorTargetHost = '172.18.0.2',
    [ValidateRange(1, 65535)]
    [int]$MonitorTargetPort = 8002,
    [ValidateRange(1, 65535)]
    [int]$LocalForwardPort = 18002,
    [ValidateRange(5, 120)]
    [int]$ProbeTimeoutSeconds = 45
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($RuntimeRoot)) {
    $RuntimeRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
$logDirectory = Join-Path $RuntimeRoot 'logs'
$probeStdout = Join-Path $logDirectory 'key-migration-ssh.stdout.log'
$probeStderr = Join-Path $logDirectory 'key-migration-ssh.stderr.log'
$probeProcess = $null
$pendingIdentity = ''
$result = [ordered]@{
    schemaVersion = 1
    succeeded = $false
    systemIdentity = $false
    keyAclSystemOnly = $false
    sshAuthenticated = $false
    localForwardListening = $false
    monitorHealth = $false
    unprotectedPrivateKey = $false
    badPermissions = $false
    publicKeyDenied = $false
    errorCode = ''
}

function Test-LocalTcpPort {
    param([Parameter(Mandatory = $true)][int]$Port)

    $client = New-Object Net.Sockets.TcpClient
    try {
        $wait = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        return $wait.AsyncWaitHandle.WaitOne(500) -and $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Assert-SystemOnlyPrivateKeyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $acl = Get-Acl -LiteralPath $Path
    $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($ownerSid -ne $systemSid.Value) {
        throw 'KEY_OWNER_NOT_SYSTEM'
    }
    if (-not $acl.AreAccessRulesProtected) {
        throw 'KEY_INHERITANCE_ENABLED'
    }

    $rules = @($acl.GetAccessRules(
            $true,
            $true,
            [Security.Principal.SecurityIdentifier]
        ))
    $systemRules = @($rules | Where-Object {
            $_.IdentityReference.Value -eq $systemSid.Value -and
            $_.AccessControlType -eq $allow -and
            -not $_.IsInherited -and
            ($_.FileSystemRights -band $fullControl) -eq $fullControl
        })
    if ($systemRules.Count -ne 1) {
        throw 'KEY_SYSTEM_FULLCONTROL_MISSING'
    }
    if ($rules.Count -ne 1) {
        throw 'KEY_ACL_HAS_DISALLOWED_IDENTITY'
    }
}

function Set-SystemOnlyPrivateKeyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $fullControl = [Security.AccessControl.FileSystemRights]::FullControl
    $allow = [Security.AccessControl.AccessControlType]::Allow
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.GetAccessRules(
                $true,
                $true,
                [Security.Principal.SecurityIdentifier]
            ))) {
        [void]$acl.RemoveAccessRuleSpecific($rule)
    }
    $acl.SetOwner($systemSid)
    [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
                $systemSid,
                $fullControl,
                $allow
            )))
    Set-Acl -LiteralPath $Path -AclObject $acl
    Assert-SystemOnlyPrivateKeyAcl -Path $Path
}

function Update-SshErrorFlags {
    if (-not (Test-Path -LiteralPath $probeStderr -PathType Leaf)) {
        return
    }
    $stderrText = Get-Content -LiteralPath $probeStderr -Raw -ErrorAction SilentlyContinue
    $result.unprotectedPrivateKey = $stderrText -match 'UNPROTECTED PRIVATE KEY FILE'
    $result.badPermissions = $stderrText -match '(?i)bad permissions'
    $result.publicKeyDenied = $stderrText -match '(?i)Permission denied \(publickey\)'
}

try {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($currentSid -ne 'S-1-5-18') {
        throw 'HELPER_NOT_RUNNING_AS_SYSTEM'
    }
    $result.systemIdentity = $true

    if ($TunnelHost -notmatch '^[A-Za-z0-9._-]+@[A-Za-z0-9._:-]+$') {
        throw 'INVALID_TUNNEL_HOST'
    }
    if ($MonitorTargetHost -notmatch '^[A-Za-z0-9._:-]+$') {
        throw 'INVALID_MONITOR_TARGET_HOST'
    }
    foreach ($requiredFile in @(
            @{ Path = $SshPath; Code = 'SSH_EXE_MISSING' },
            @{ Path = $SourceIdentityFile; Code = 'SOURCE_KEY_MISSING' },
            @{ Path = $KnownHostsFile; Code = 'KNOWN_HOSTS_MISSING' }
        )) {
        if (-not (Test-Path -LiteralPath $requiredFile.Path -PathType Leaf)) {
            throw $requiredFile.Code
        }
    }

    New-Item -ItemType Directory -Force -Path `
        (Split-Path -Parent $RuntimeIdentityFile), $logDirectory | Out-Null
    $sourcePath = [IO.Path]::GetFullPath($SourceIdentityFile)
    $destinationPath = [IO.Path]::GetFullPath($RuntimeIdentityFile)
    $preparedIdentity = $destinationPath
    if (-not [string]::Equals(
            $sourcePath,
            $destinationPath,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        # Keep an existing authorized runtime key intact until the explicitly
        # supplied replacement proves SSH authentication and Monitor health.
        $pendingIdentity = "$destinationPath.pending-$([Guid]::NewGuid().ToString('N'))"
        Copy-Item -LiteralPath $sourcePath -Destination $pendingIdentity -Force
        $preparedIdentity = $pendingIdentity
    }

    Set-SystemOnlyPrivateKeyAcl -Path $preparedIdentity
    $result.keyAclSystemOnly = $true

    if (Test-LocalTcpPort -Port $LocalForwardPort) {
        throw 'LOCAL_FORWARD_PORT_ALREADY_IN_USE'
    }

    Remove-Item -LiteralPath $probeStdout, $probeStderr -Force -ErrorAction SilentlyContinue
    $localForward = "127.0.0.1:${LocalForwardPort}:${MonitorTargetHost}:${MonitorTargetPort}"
    $sshArguments = @(
        '-N',
        '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ConnectTimeout=15',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', ('"UserKnownHostsFile={0}"' -f $KnownHostsFile),
        '-i', ('"{0}"' -f $preparedIdentity),
        '-L', $localForward,
        $TunnelHost
    )
    $probeProcess = Start-Process -FilePath $SshPath `
        -ArgumentList $sshArguments `
        -RedirectStandardOutput $probeStdout `
        -RedirectStandardError $probeStderr `
        -WindowStyle Hidden `
        -PassThru

    $deadline = (Get-Date).AddSeconds($ProbeTimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($probeProcess.HasExited) {
            break
        }
        if (Test-LocalTcpPort -Port $LocalForwardPort) {
            $result.localForwardListening = $true
            try {
                $health = Invoke-RestMethod `
                    -Uri "http://127.0.0.1:$LocalForwardPort/healthz" `
                    -Method Get `
                    -TimeoutSec 5
                if ($health.ok -eq $true) {
                    $result.monitorHealth = $true
                    $result.sshAuthenticated = $true
                    break
                }
            }
            catch {
                # The forward is live; keep polling until Monitor answers or timeout.
            }
        }
        Start-Sleep -Milliseconds 500
    }

    Update-SshErrorFlags
    if ($result.unprotectedPrivateKey) { throw 'SSH_UNPROTECTED_PRIVATE_KEY' }
    if ($result.badPermissions) { throw 'SSH_BAD_PERMISSIONS' }
    if ($result.publicKeyDenied) { throw 'SSH_PUBLICKEY_DENIED' }
    if (-not $result.sshAuthenticated -or
        -not $result.localForwardListening -or
        -not $result.monitorHealth) {
        throw 'SSH_FORWARD_HEALTH_VERIFICATION_FAILED'
    }

    if ($null -ne $probeProcess -and -not $probeProcess.HasExited) {
        Stop-Process -Id $probeProcess.Id -Force -ErrorAction SilentlyContinue
        $probeProcess.WaitForExit()
    }
    $probeProcess = $null
    if (-not [string]::IsNullOrWhiteSpace($pendingIdentity)) {
        Move-Item -LiteralPath $pendingIdentity -Destination $destinationPath -Force
        $pendingIdentity = ''
    }
    Assert-SystemOnlyPrivateKeyAcl -Path $destinationPath
    $result.succeeded = $true
}
catch {
    $result.errorCode = [string]$_.Exception.Message
}
finally {
    if ($null -ne $probeProcess -and -not $probeProcess.HasExited) {
        Stop-Process -Id $probeProcess.Id -Force -ErrorAction SilentlyContinue
        $probeProcess.WaitForExit()
    }
    if (-not [string]::IsNullOrWhiteSpace($pendingIdentity)) {
        Remove-Item -LiteralPath $pendingIdentity -Force -ErrorAction SilentlyContinue
    }
    Update-SshErrorFlags
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ResultFile) | Out-Null
    $temporaryResult = "$ResultFile.tmp"
    $result | ConvertTo-Json | Set-Content -LiteralPath $temporaryResult -Encoding UTF8
    Move-Item -LiteralPath $temporaryResult -Destination $ResultFile -Force
}

if ($result.succeeded) {
    exit 0
}
exit 1
