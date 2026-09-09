#Requires -Version 7.0
<#
.SYNOPSIS
    Stage the IDEA3 Web server payload into the bundle's server/ directory.

.DESCRIPTION
    The launcher resolves <bundle>\server\index.js and <bundle>\server\passwordHash.js
    directly, so this layout is a contract rather than a convenience.

    A recursive copy of a *directory* nests the source inside a destination that
    already exists (<bundle>\server\server\...) and copies its contents into a
    destination that does not, so the staged layout depends on the state of the
    destination and on the provider's semantics. Real Windows evidence showed that
    difference shipping as <bundle>\server\server\index.js while the launcher
    opens <bundle>\server\index.js.

    This script therefore never copies a directory: it walks the source files and
    copies each one to an explicit destination *file* path under a directory it
    created itself, so nesting is impossible regardless of the destination's prior
    state. Empty source directories are not reproduced; the payload is JavaScript
    files, and server\node_modules is created by the caller's `npm ci`.
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
# Resolve before measuring relative paths: a relative -WebDir would otherwise not
# be a prefix of the absolute FullName the enumeration reports.
$serverSource = (Resolve-Path -LiteralPath $serverSource).ProviderPath.TrimEnd('\', '/')

# Stage from a known-empty directory so a leftover tree cannot survive into the bundle.
if (Test-Path -LiteralPath $ServerStage) { Remove-Item -LiteralPath $ServerStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $ServerStage | Out-Null

foreach ($file in Get-ChildItem -LiteralPath $serverSource -Recurse -File -Force) {
    $relative = $file.FullName.Substring($serverSource.Length + 1)
    $destination = Join-Path $ServerStage $relative
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
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
