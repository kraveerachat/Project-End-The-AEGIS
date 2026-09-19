[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ServiceName = 'AEGISIdentityAgent',
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent",
    [string]$EvidenceRoot = "$env:ProgramData\AEGIS\IdentityAgentProvisioning",
    [string]$PythonPath = "$env:ProgramFiles\AEGIS\IdentityAgent\.venv\Scripts\python.exe",
    [string]$RunnerPath = "$env:ProgramFiles\AEGIS\IdentityAgent\run_identity_agent.py"
)

$ErrorActionPreference = 'Stop'
$ExpectedAccount = 'NT SERVICE\AEGISIdentityAgent'
if ($ServiceName -ne 'AEGISIdentityAgent') { throw 'Unexpected service name' }
$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $service) { throw 'Identity Agent service is not installed' }
if ($service.StartName -ne $ExpectedAccount) { throw 'Identity Agent service account mismatch' }
if (-not (Test-Path -LiteralPath $PythonPath) -or -not (Test-Path -LiteralPath $RunnerPath)) {
    throw 'Installed Identity Agent runtime is incomplete'
}

$acl = Get-Acl -LiteralPath $DataRoot
if (-not $acl.AreAccessRulesProtected) { throw 'Identity Agent data ACL inherits permissions' }
$allowed = @($ExpectedAccount, 'NT AUTHORITY\SYSTEM')
$unexpected = @($acl.Access | Where-Object {
    $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowed
})
if ($unexpected.Count -ne 0) { throw 'Identity Agent data ACL is broader than service plus SYSTEM' }
if ($PSCmdlet.ShouldProcess($EvidenceRoot, 'Create non-secret provisioning evidence exchange')) {
    New-Item -ItemType Directory -Path $EvidenceRoot -Force | Out-Null
    if ((Get-Item -LiteralPath $EvidenceRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Provisioning evidence root must not be a reparse point'
    }
    & icacls.exe $EvidenceRoot /inheritance:r /grant:r "${ExpectedAccount}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' | Out-Null
}
$passPath = Join-Path $EvidenceRoot 'dpapi-preflight.pass.json'

# The executable performs a disposable random DPAPI CurrentUser round trip and
# overwrites its transient marker. It never imports or generates the application key.
if ($PSCmdlet.ShouldProcess($ServiceName, 'Run DPAPI CurrentUser preflight under the verified service identity')) {
    $original = $service.PathName
    if (Test-Path -LiteralPath $passPath) { Remove-Item -LiteralPath $passPath -Force }
    $preflightCommand = ('"{0}" "{1}" --dpapi-preflight --preflight-output "{2}"' -f $PythonPath, $RunnerPath, $passPath)
    & sc.exe config $ServiceName "binPath= $preflightCommand" | Out-Null
    try {
        & sc.exe start $ServiceName | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        while (-not (Test-Path -LiteralPath $passPath) -and [DateTime]::UtcNow -lt $deadline) {
            Start-Sleep -Milliseconds 250
        }
        if (-not (Test-Path -LiteralPath $passPath)) { throw 'DPAPI CurrentUser PASS evidence was not produced' }
        $evidence = Get-Content -LiteralPath $passPath -Raw | ConvertFrom-Json
        if ($evidence.result -ne 'PASS' -or $evidence.protectionScope -ne 'CurrentUser' -or
            $evidence.serviceAccount -ne $ExpectedAccount -or $evidence.keyGenerated -ne $false) {
            throw 'DPAPI CurrentUser PASS evidence is invalid'
        }
    }
    finally {
        & sc.exe stop $ServiceName | Out-Null
        & sc.exe config $ServiceName "binPath= $original" | Out-Null
    }
}

'DPAPI_CURRENTUSER_PREFLIGHT=PASS'
'SERVICE_IDENTITY=NT SERVICE\AEGISIdentityAgent'
'KEY_GENERATED=NO'
