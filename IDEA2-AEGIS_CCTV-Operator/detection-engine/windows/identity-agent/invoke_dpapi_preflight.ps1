[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ServiceName = 'AEGISIdentityAgent',
    [string]$InstallRoot = "$env:ProgramFiles\AEGIS\IdentityAgent",
    [string]$DataRoot = "$env:ProgramData\AEGIS\IdentityAgent",
    [string]$ConfigurationRoot = "$env:ProgramData\AEGIS\IdentityAgentConfiguration",
    [string]$EvidenceRoot = "$env:ProgramData\AEGIS\IdentityAgentProvisioning",
    [string]$PythonPath = '',
    [string]$RunnerPath = ''
)

$ErrorActionPreference = 'Stop'
$safetyScript = Join-Path $PSScriptRoot 'identity_agent_safety.ps1'
. $safetyScript
$ExpectedAccount = 'NT SERVICE\AEGISIdentityAgent'
Assert-IdentityAgentServiceName -ServiceName $ServiceName
$managedRoots = Assert-IdentityAgentManagedRoots -InstallRoot $InstallRoot -DataRoot $DataRoot `
    -ConfigurationRoot $ConfigurationRoot -EvidenceRoot $EvidenceRoot
$InstallRoot = $managedRoots.installRoot
$DataRoot = $managedRoots.dataRoot
$ConfigurationRoot = $managedRoots.configurationRoot
$EvidenceRoot = $managedRoots.evidenceRoot
$null = Assert-IdentityAgentInstallationMarker -ConfigurationRoot $ConfigurationRoot `
    -InstallRoot $InstallRoot -DataRoot $DataRoot -EvidenceRoot $EvidenceRoot -ServiceName $ServiceName
if ([string]::IsNullOrWhiteSpace($PythonPath)) { $PythonPath = Join-Path $InstallRoot '.venv\Scripts\python.exe' }
if ([string]::IsNullOrWhiteSpace($RunnerPath)) { $RunnerPath = Join-Path $InstallRoot 'run_identity_agent.py' }
$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $service) { throw 'Identity Agent service is not installed' }
if ($service.StartName -ne $ExpectedAccount) { throw 'Identity Agent service account mismatch' }
if ([string]$service.State -ne 'Stopped') {
    throw 'Identity Agent service must be stopped before the DPAPI preflight'
}
$expectedBinPath = ('"{0}" "{1}" --service' -f $PythonPath, $RunnerPath)
if (-not [string]::Equals(([string]$service.PathName).Trim(), $expectedBinPath, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Identity Agent service executable mismatch'
}
if (-not (Test-Path -LiteralPath $PythonPath) -or -not (Test-Path -LiteralPath $RunnerPath)) {
    throw 'Installed Identity Agent runtime is incomplete'
}

# The elevated administrator intentionally has no read-control permission on
# the service-only identity directory. IdentityKeyStore validates the exact data ACL
# from inside the service identity before it creates or loads key material.
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
$preflightExecuted = $false
if ($PSCmdlet.ShouldProcess($ServiceName, 'Run DPAPI CurrentUser preflight under the verified service identity')) {
    $original = $service.PathName
    if (Test-Path -LiteralPath $passPath) { Remove-Item -LiteralPath $passPath -Force }
    $preflightCommand = ('"{0}" "{1}" --dpapi-preflight --preflight-output "{2}"' -f $PythonPath, $RunnerPath, $passPath)
    try {
        Invoke-CheckedServiceControl $ServiceName config 'binPath=' $preflightCommand
        Invoke-CheckedServiceControl $ServiceName start
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
        $serviceController = Get-Service -Name $ServiceName -ErrorAction Stop
        $serviceController.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    finally {
        try {
            $serviceController = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
            if ($null -ne $serviceController -and $serviceController.Status -ne 'Stopped') {
                Invoke-CheckedServiceControl $ServiceName stop
                $serviceController.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
            }
        }
        finally {
            Invoke-CheckedServiceControl $ServiceName config 'binPath=' $original
        }
    }
    $preflightExecuted = $true
}

if (-not $preflightExecuted) {
    'DPAPI_CURRENTUSER_PREFLIGHT=NOT_EXECUTED'
    return
}

'DPAPI_CURRENTUSER_PREFLIGHT=PASS'
'SERVICE_IDENTITY=NT SERVICE\AEGISIdentityAgent'
'KEY_GENERATED=NO'
