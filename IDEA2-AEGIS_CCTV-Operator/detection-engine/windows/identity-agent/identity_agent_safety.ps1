Set-StrictMode -Version Latest

$script:IdentityAgentServiceName = 'AEGISIdentityAgent'
$script:IdentityAgentServiceAccount = 'NT SERVICE\AEGISIdentityAgent'

function Assert-IdentityAgentServiceName {
    param([Parameter(Mandatory = $true)][string]$ServiceName)
    if (-not [string]::Equals(
            $ServiceName,
            $script:IdentityAgentServiceName,
            [StringComparison]::Ordinal
        )) {
        throw 'Only the AEGISIdentityAgent service is managed by this tool'
    }
}

function ConvertTo-CanonicalIdentityAgentPath {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Path
    )
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
        throw "$Name must be an absolute path"
    }
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    if ([string]::Equals($full.TrimEnd('\'), $root.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name must not be a filesystem root"
    }
    return $full.TrimEnd('\')
}

function Test-IdentityAgentPathContains {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )
    $prefix = $Parent.TrimEnd('\') + '\'
    return $Child.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Test-IdentityAgentPathsOverlap {
    param(
        [Parameter(Mandatory = $true)][string]$Left,
        [Parameter(Mandatory = $true)][string]$Right
    )
    return [string]::Equals($Left, $Right, [StringComparison]::OrdinalIgnoreCase) -or
        (Test-IdentityAgentPathContains -Parent $Left -Child $Right) -or
        (Test-IdentityAgentPathContains -Parent $Right -Child $Left)
}

function Assert-IdentityAgentManagedRoots {
    param(
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][string]$ConfigurationRoot,
        [Parameter(Mandatory = $true)][string]$EvidenceRoot,
        [string]$SourceRoot = '',
        [switch]$AllowDisposableTestRoot,
        [string]$DisposableTestRoot = ''
    )
    $roots = [ordered]@{
        installRoot = ConvertTo-CanonicalIdentityAgentPath -Name 'InstallRoot' -Path $InstallRoot
        dataRoot = ConvertTo-CanonicalIdentityAgentPath -Name 'DataRoot' -Path $DataRoot
        configurationRoot = ConvertTo-CanonicalIdentityAgentPath -Name 'ConfigurationRoot' -Path $ConfigurationRoot
        evidenceRoot = ConvertTo-CanonicalIdentityAgentPath -Name 'EvidenceRoot' -Path $EvidenceRoot
    }

    $names = @($roots.Keys)
    for ($leftIndex = 0; $leftIndex -lt $names.Count; $leftIndex++) {
        for ($rightIndex = $leftIndex + 1; $rightIndex -lt $names.Count; $rightIndex++) {
            $leftName = $names[$leftIndex]
            $rightName = $names[$rightIndex]
            if (Test-IdentityAgentPathsOverlap -Left $roots[$leftName] -Right $roots[$rightName]) {
                throw "Identity Agent managed paths overlap: $leftName and $rightName"
            }
        }
    }

    if ($AllowDisposableTestRoot) {
        $testRoot = ConvertTo-CanonicalIdentityAgentPath -Name 'DisposableTestRoot' -Path $DisposableTestRoot
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if (-not (Test-IdentityAgentPathContains -Parent $tempRoot -Child $testRoot) -or
            [IO.Path]::GetFileName($testRoot) -notlike 'aegis-task12-*') {
            throw 'DisposableTestRoot must be a dedicated aegis-task12-* child of the Windows temp directory'
        }
        foreach ($entry in $roots.GetEnumerator()) {
            if (-not (Test-IdentityAgentPathContains -Parent $testRoot -Child $entry.Value)) {
                throw "$($entry.Key) must be a child of DisposableTestRoot"
            }
        }
    }
    else {
        $expected = [ordered]@{
            installRoot = [IO.Path]::GetFullPath("$env:ProgramFiles\AEGIS\IdentityAgent").TrimEnd('\')
            dataRoot = [IO.Path]::GetFullPath("$env:ProgramData\AEGIS\IdentityAgent").TrimEnd('\')
            configurationRoot = [IO.Path]::GetFullPath("$env:ProgramData\AEGIS\IdentityAgentConfiguration").TrimEnd('\')
            evidenceRoot = [IO.Path]::GetFullPath("$env:ProgramData\AEGIS\IdentityAgentProvisioning").TrimEnd('\')
        }
        foreach ($entry in $roots.GetEnumerator()) {
            if (-not [string]::Equals($entry.Value, $expected[$entry.Key], [StringComparison]::OrdinalIgnoreCase)) {
                throw "$($entry.Key) must use the exact reviewed Identity Agent root"
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($SourceRoot)) {
        $canonicalSource = ConvertTo-CanonicalIdentityAgentPath -Name 'SourceRoot' -Path $SourceRoot
        foreach ($entry in $roots.GetEnumerator()) {
            if (Test-IdentityAgentPathsOverlap -Left $entry.Value -Right $canonicalSource) {
                throw "$($entry.Key) must not overlap sourceRoot"
            }
        }
    }

    foreach ($entry in $roots.GetEnumerator()) {
        $candidate = $entry.Value
        $volumeRoot = [IO.Path]::GetPathRoot($candidate).TrimEnd('\')
        while (-not [string]::Equals($candidate.TrimEnd('\'), $volumeRoot, [StringComparison]::OrdinalIgnoreCase)) {
            if (Test-Path -LiteralPath $candidate) {
                $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                    throw "$($entry.Key) or an existing ancestor must not be a ReparsePoint"
                }
            }
            $candidate = [IO.Path]::GetDirectoryName($candidate)
        }
    }

    return [pscustomobject]$roots
}

function Assert-IdentityAgentInstallationMarker {
    param(
        [Parameter(Mandatory = $true)][string]$ConfigurationRoot,
        [Parameter(Mandatory = $true)][string]$InstallRoot,
        [Parameter(Mandatory = $true)][string]$DataRoot,
        [Parameter(Mandatory = $true)][string]$EvidenceRoot,
        [string]$ServiceName = 'AEGISIdentityAgent'
    )
    Assert-IdentityAgentServiceName -ServiceName $ServiceName
    $markerPath = Join-Path $ConfigurationRoot 'install.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        throw 'Identity Agent installation marker is missing'
    }
    $markerItem = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
    if ($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Identity Agent installation marker must not be a reparse point'
    }
    $marker = Get-Content -LiteralPath $markerPath -Raw -ErrorAction Stop | ConvertFrom-Json
    if ([int]$marker.schemaVersion -ne 1 -or [string]$marker.serviceName -ne $ServiceName -or
        [string]$marker.state -notin @('IN_PROGRESS', 'INSTALLED', 'PRESERVED')) {
        throw 'Identity Agent installation marker identity is invalid'
    }
    $expected = [ordered]@{
        installRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
        dataRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
        configurationRoot = [IO.Path]::GetFullPath($ConfigurationRoot).TrimEnd('\')
        evidenceRoot = [IO.Path]::GetFullPath($EvidenceRoot).TrimEnd('\')
    }
    foreach ($entry in $expected.GetEnumerator()) {
        if ($null -eq $marker.PSObject.Properties[$entry.Key] -or
            -not [string]::Equals(
                [IO.Path]::GetFullPath([string]$marker.($entry.Key)).TrimEnd('\'),
                $entry.Value,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            throw "Identity Agent installation marker does not bind $($entry.Key)"
        }
    }
    return $marker
}

function Test-IdentityAgentProtectedAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
        if (-not $acl.AreAccessRulesProtected -or $acl.Access.Count -ne 2) {
            return 'MISCONFIGURED'
        }
        $serviceSid = (New-Object Security.Principal.NTAccount($script:IdentityAgentServiceAccount)).Translate(
            [Security.Principal.SecurityIdentifier]
        ).Value
        $systemSid = 'S-1-5-18'
        $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($ownerSid -ne $serviceSid) { return 'MISCONFIGURED' }
        $seen = @{}
        foreach ($rule in $acl.Access) {
            $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
            if ($sid -notin @($serviceSid, $systemSid) -or $seen.ContainsKey($sid) -or
                $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
                $rule.IsInherited) {
                return 'MISCONFIGURED'
            }
            $seen[$sid] = $true
        }
        if (-not $seen.ContainsKey($serviceSid) -or -not $seen.ContainsKey($systemSid)) {
            return 'MISCONFIGURED'
        }
        return 'VALID'
    }
    catch [System.UnauthorizedAccessException] { return 'REQUIRES_ELEVATION' }
    catch { return 'DEGRADED' }
}

function Invoke-CheckedServiceControl {
    param(
        [Parameter(Mandatory = $true)][string]$ServiceName,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )
    Assert-IdentityAgentServiceName -ServiceName $ServiceName
    if ($Arguments.Count -lt 1) { throw 'A service-control verb is required' }
    $verb = $Arguments[0]
    $remaining = if ($Arguments.Count -gt 1) { $Arguments[1..($Arguments.Count - 1)] } else { @() }
    & sc.exe $verb $ServiceName @remaining | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "sc.exe failed with exit code $LASTEXITCODE"
    }
}
