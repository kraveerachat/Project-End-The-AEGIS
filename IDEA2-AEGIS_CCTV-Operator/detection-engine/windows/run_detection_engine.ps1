[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PythonPath,

    [string]$EngineRoot = (Split-Path -Parent $PSScriptRoot)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedEngineRoot = (Resolve-Path -LiteralPath $EngineRoot).Path
$resolvedPython = (Resolve-Path -LiteralPath $PythonPath).Path
$runFile = Join-Path $resolvedEngineRoot 'run.py'
$envFile = Join-Path $resolvedEngineRoot '.env'

if (-not (Test-Path -LiteralPath $runFile -PathType Leaf)) {
    throw "Detection Engine entrypoint not found: $runFile"
}

if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
    throw "Detection Engine configuration not found: $envFile"
}

# Keep operational logs outside the repository so an unattended process never
# turns runtime output into source changes or risks committing local evidence.
$stateRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AEGIS\DetectionEngine'
$logDirectory = Join-Path $stateRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$wrapperLog = Join-Path $logDirectory 'detection-engine-wrapper.log'
$stdoutLog = Join-Path $logDirectory 'detection-engine.stdout.log'
$stderrLog = Join-Path $logDirectory 'detection-engine.stderr.log'

Set-Location -LiteralPath $resolvedEngineRoot

$startedAt = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
"[$startedAt] Starting AEGIS Detection Engine with scheduled-task wrapper." |
    Out-File -LiteralPath $wrapperLog -Encoding utf8 -Append

# Redirect the native process at the process boundary instead of through the
# Windows PowerShell 5.1 pipeline. Python logs normally use stderr; piping that
# stream through PowerShell can promote an ordinary log line to a terminating
# NativeCommandError or mix UTF-16 records into an existing UTF-8 log.
$pythonArguments = @('-u', ('"{0}"' -f $runFile))
$engineProcess = Start-Process -FilePath $resolvedPython `
    -ArgumentList $pythonArguments `
    -WorkingDirectory $resolvedEngineRoot `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -NoNewWindow -PassThru -Wait
$engineExitCode = $engineProcess.ExitCode

$stoppedAt = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK'
"[$stoppedAt] Detection Engine exited with code $engineExitCode." |
    Out-File -LiteralPath $wrapperLog -Encoding utf8 -Append

# A non-zero exit lets Task Scheduler apply its configured restart policy.
exit $engineExitCode
