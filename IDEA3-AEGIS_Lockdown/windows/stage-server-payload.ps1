#Requires -Version 7.0
<#
.SYNOPSIS
    Stage the IDEA3 Web server payload into the bundle's server/ directory.

.DESCRIPTION
    The launcher resolves <bundle>\server\index.js and <bundle>\server\passwordHash.js
    directly, so this layout is a contract rather than a convenience.

    A recursive copy of a *directory* onto a destination that already exists
    nests the source inside it (<bundle>\server\server\...), while the same call
    against a missing destination copies the contents. That difference is the
    packaging defect this script removes: every entry is copied to an explicit
    destination path, so the result never depends on what the destination
    happened to be beforehand, and the staged layout is verified before the
    caller installs production dependencies into it.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$WebDir,
    [Parameter(Mandatory)][string]$ServerStage
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$serverSource = Join-Path $WebDir 'server'
if (-not (Test-Path -LiteralPath $serverSource -PathType Container)) {
    throw "BUILD FAILED: Web server sources are missing: $serverSource"
}

# Stage from a known-empty directory so a leftover tree cannot survive into the bundle.
if (Test-Path -LiteralPath $ServerStage) { Remove-Item -LiteralPath $ServerStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ServerStage | Out-Null

foreach ($entry in Get-ChildItem -LiteralPath $serverSource -Force) {
    Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $ServerStage $entry.Name) -Recurse -Force
}

foreach ($file in @('package.json', 'package-lock.json')) {
    $source = Join-Path $WebDir $file
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "BUILD FAILED: Web manifest is missing: $source"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $ServerStage $file) -Force
}

# Fail here rather than at the evaluator's first `configure`: the launcher opens
# these exact paths, and npm ci would otherwise install into a broken layout.
foreach ($required in @('index.js', 'passwordHash.js', 'package.json', 'package-lock.json')) {
    $staged = Join-Path $ServerStage $required
    if (-not (Test-Path -LiteralPath $staged -PathType Leaf)) {
        throw "BUILD FAILED: staged server payload is missing $required at $staged"
    }
}

# web\server has no `server` child, so this can only be the nesting defect.
$nested = Join-Path $ServerStage 'server'
if (Test-Path -LiteralPath $nested) {
    throw "BUILD FAILED: server payload was nested at $nested; the launcher resolves <bundle>\server\index.js"
}
