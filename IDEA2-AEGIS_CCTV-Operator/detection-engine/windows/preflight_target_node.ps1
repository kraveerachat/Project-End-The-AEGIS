[CmdletBinding()]
param(
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) { return $null }
    return [string]$command.Source
}

function Get-PythonProbe {
    param(
        [Parameter(Mandatory = $true)][string]$Launcher,
        [Parameter(Mandatory = $true)][string]$Version
    )

    try {
        $payload = & $Launcher "-$Version" -c "import json,struct,sys; print(json.dumps({'version':sys.version.split()[0],'path':sys.executable,'x64':struct.calcsize('P')==8}))" 2>$null
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($payload -join ''))) {
            return [pscustomobject]@{
                Available = $false
                Version = $null
                Path = $null
                X64 = $false
            }
        }
        $parsed = ($payload -join '') | ConvertFrom-Json
        return [pscustomobject]@{
            Available = $true
            Version = [string]$parsed.version
            Path = [string]$parsed.path
            X64 = [bool]$parsed.x64
        }
    }
    catch {
        return [pscustomobject]@{
            Available = $false
            Version = $null
            Path = $null
            X64 = $false
        }
    }
}

function Get-ListenerProbe {
    param([Parameter(Mandatory = $true)][int]$Port)

    try {
        $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
        return [pscustomobject]@{
            Port = $Port
            ListenerCount = $listeners.Count
            Pids = @($listeners | ForEach-Object { [int]$_.OwningProcess })
        }
    }
    catch {
        return [pscustomobject]@{
            Port = $Port
            ListenerCount = -1
            Pids = @()
        }
    }
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$cpu = @(Get-CimInstance Win32_Processor)
$gpu = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue)

$pyLauncher = Get-CommandPath -Name 'py.exe'
$python312 = if ($null -ne $pyLauncher) {
    Get-PythonProbe -Launcher $pyLauncher -Version '3.12'
}
else {
    [pscustomobject]@{ Available = $false; Version = $null; Path = $null; X64 = $false }
}
$python314 = if ($null -ne $pyLauncher) {
    Get-PythonProbe -Launcher $pyLauncher -Version '3.14'
}
else {
    [pscustomobject]@{ Available = $false; Version = $null; Path = $null; X64 = $false }
}

$ffmpegPath = Get-CommandPath -Name 'ffmpeg.exe'
$ffmpegVersion = $null
$libx264Present = $false
if ($null -ne $ffmpegPath) {
    $ffmpegVersion = [string]((& $ffmpegPath -version 2>$null | Select-Object -First 1))
    $encoders = @(& $ffmpegPath -hide_banner -encoders 2>$null)
    $libx264Present = @($encoders | Select-String '\blibx264\b').Count -gt 0
}

$cameraDevices = @(
    Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.PNPClass -eq 'Camera' -or $_.PNPClass -eq 'Image') -and
            $_.Status -eq 'OK'
        } |
        ForEach-Object { [string]$_.Name }
)

$sshPath = Get-CommandPath -Name 'ssh.exe'
$sshVersion = $null
if ($null -ne $sshPath) {
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $sshPath
    $psi.Arguments = '-V'
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $process = [Diagnostics.Process]::Start($psi)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    if ($process.ExitCode -eq 0) {
        $versionText = ($stderr + "`n" + $stdout).Trim()
        $sshVersion = [string](($versionText -split "`r?`n")[0])
    }
    else {
        $sshVersion = 'VERSION_QUERY_FAILED'
    }

    $process.Dispose()
}

$ports = @(
    Get-ListenerProbe -Port 8077
    Get-ListenerProbe -Port 8078
    Get-ListenerProbe -Port 18002
)

$agent = Get-CimInstance Win32_Service -Filter "Name='AEGISIdentityAgent'" -ErrorAction SilentlyContinue

$tunnelTask = $null
$legacyEngineTask = $null
if ($null -ne (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)) {
    $tunnelTask = Get-ScheduledTask -TaskName 'AEGIS Detection Tunnel' -ErrorAction SilentlyContinue
    $legacyEngineTask = Get-ScheduledTask -TaskName 'AEGIS Detection Engine' -ErrorAction SilentlyContinue
}

$runEntry = Get-ItemPropertyValue `
    -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
    -Name 'AEGIS Detection Engine' `
    -ErrorAction SilentlyContinue

$engineRuntime = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AEGIS\DetectionEngine'
$agentRuntime = Join-Path $env:ProgramFiles 'AEGIS\IdentityAgent'

$result = [ordered]@{
    SchemaVersion = 1
    ReadOnly = $true
    ComputerName = [string]$env:COMPUTERNAME
    WindowsCaption = [string]$os.Caption
    WindowsVersion = [string]$os.Version
    Architecture = [string]$env:PROCESSOR_ARCHITECTURE
    RamGB = [math]::Round([double]$computer.TotalPhysicalMemory / 1GB, 1)
    Cpu = (@($cpu | ForEach-Object { [string]$_.Name }) -join '; ')
    GpuCount = $gpu.Count
    Gpus = @($gpu | ForEach-Object { [string]$_.Name })
    Administrator = $isAdmin
    PythonLauncherPresent = $null -ne $pyLauncher
    Python312Available = [bool]$python312.Available
    Python312Version = $python312.Version
    Python312Path = $python312.Path
    Python312X64 = [bool]$python312.X64
    Python314Available = [bool]$python314.Available
    Python314Version = $python314.Version
    Python314Path = $python314.Path
    Python314X64 = [bool]$python314.X64
    FfmpegPresent = $null -ne $ffmpegPath
    FfmpegVersion = $ffmpegVersion
    Libx264Present = $libx264Present
    CameraDeviceCount = $cameraDevices.Count
    CameraDevices = $cameraDevices
    CameraFrameProbe = 'NOT_RUN'
    CameraConfigWrite = 'NO'
    SshClientPresent = $null -ne $sshPath
    SshVersion = $sshVersion
    Port8077ListenerCount = [int]$ports[0].ListenerCount
    Port8077Pids = @($ports[0].Pids)
    Port8078ListenerCount = [int]$ports[1].ListenerCount
    Port8078Pids = @($ports[1].Pids)
    Port18002ListenerCount = [int]$ports[2].ListenerCount
    Port18002Pids = @($ports[2].Pids)
    IdentityAgentInstalled = $null -ne $agent
    IdentityAgentState = if ($null -ne $agent) { [string]$agent.State } else { 'Missing' }
    IdentityAgentStartMode = if ($null -ne $agent) { [string]$agent.StartMode } else { 'Missing' }
    DetectionTunnelTaskPresent = $null -ne $tunnelTask
    DetectionTunnelTaskState = if ($null -ne $tunnelTask) { [string]$tunnelTask.State } else { 'Missing' }
    LegacyEngineTaskPresent = $null -ne $legacyEngineTask
    LegacyEngineTaskState = if ($null -ne $legacyEngineTask) { [string]$legacyEngineTask.State } else { 'Missing' }
    EngineHkcuRunPresent = -not [string]::IsNullOrWhiteSpace([string]$runEntry)
    EngineRuntimePresent = Test-Path -LiteralPath $engineRuntime
    AgentRuntimePresent = Test-Path -LiteralPath $agentRuntime
    ServerContact = 'NO'
    ProductionMutation = 'NO'
    TwingateMutation = 'NO'
    CameraOpen = 'NO'
    ConfigWrite = 'NO'
    PrivateKeyRead = 'NO'
}

if ($Json) {
    [pscustomobject]$result | ConvertTo-Json -Depth 6
    exit 0
}

foreach ($entry in $result.GetEnumerator()) {
    $value = $entry.Value
    if ($value -is [System.Array]) {
        $value = @($value) -join ';'
    }
    Write-Output ("{0}={1}" -f $entry.Key.ToString().ToUpperInvariant(), $value)
}

Write-Output 'MN_P1_TARGET_PREFLIGHT_COMPLETE=YES'
