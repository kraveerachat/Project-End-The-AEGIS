# Windows Identity Agent lifecycle

These repository-native scripts prepare the dedicated Windows Identity Agent
without changing the Detection Engine's interactive webcam ownership. One-time
administrator operations may use PowerShell; normal boot/login operation does
not require the end user to open a terminal.

The Agent runs automatically as `NT SERVICE\AEGISIdentityAgent`, owns no camera,
and exposes only the fixed browser-association listener at `127.0.0.1:8078`.
Its Ed25519 key is protected with DPAPI `CurrentUser` under that exact service
identity and exact service/SYSTEM filesystem ACLs. The camera remains off when
the service starts, authenticates, renews, or reports physical availability.

## One-time administrator sequence

1. Prepare a non-secret Agent configuration outside the repository. Include the
   canonical Monitor URL/audience, Node ID, key version, Engine user SID,
   allowed browser origins, and stable physical stream URL. Do not put an API
   key, private key, password, token, or logical camera alias in this file.
2. Compute the exact source-manifest SHA-256 with the repository helper, then
   pass it to the installer:

   ```powershell
   $sourceHash = & .\windows\identity-agent\get_identity_agent_source_hash.ps1 `
       -SourceRoot (Get-Location).Path
   & .\windows\identity-agent\install_identity_agent.ps1 `
       -SourceRoot (Get-Location).Path `
       -ExpectedSourceSha256 $sourceHash `
       -ConfigurationFile C:\AEGIS-Local\identity-agent.env
   ```
3. Keep the Agent service stopped and run `invoke_dpapi_preflight.ps1`. It
   proves DPAPI CurrentUser behavior under the service identity without
   generating the application key.
4. While the Agent remains stopped, run `provision_identity_key.ps1` and register only the exported public
   key through the separately reviewed server workflow. The operation is
   resumable: if a service-context interruption happened after the protected
   identity was committed, a retry validates that same identity and recreates
   only identical public evidence; it never rotates the key.
5. Use `status_identity_agent.ps1`, then start the service only when status and
   registration are valid.
6. After reboot, run `verify_machine_a_no_powershell.ps1` as the human
   acceptance evidence collector.

Pinned Agent dependencies, including pywin32, are installed into the separate
`%ProgramFiles%\AEGIS\IdentityAgent\.venv`; the Engine environment is not
modified. The installer requires 64-bit CPython 3.12 and uses the reviewed,
fully transitive Windows wheel lock with `--require-hashes` and binary-only
resolution.

The runtime and non-secret management configuration deliberately remain
administrator-maintainable. Only `%ProgramData%\AEGIS\IdentityAgent`, which
contains the DPAPI-protected identity, is owned exclusively by the Agent service
and SYSTEM. This separation permits repeat repair and normal uninstall without
widening private-key access.

## Repair and uninstall

`repair_identity_agent.ps1` refreshes the reviewed runtime, dependencies,
configuration ACL, and service registration. It does not open, hash, copy,
delete, generate, or rotate the existing protected identity; preservation is
enforced by keeping all key mutation outside the repair path. A missing service
can be recreated from the bound installation marker. If `agent.env` is missing
or invalid, pass a reviewed `-ReplacementConfigurationFile`; repair validates
and installs it without reading the private key.

`uninstall_identity_agent.ps1` removes only Task-12-managed Agent service,
runtime, active configuration, and non-secret provisioning evidence. The
machine identity is preserved by default, together with the small non-secret
`install.json` ownership marker that binds the preserved identity to its exact
managed roots. Permanent key removal requires the explicit `-DestroyIdentity`
switch, a matching ownership marker, and normal PowerShell confirmation
semantics. Broad, overlapping, source-tree, or reparse-point roots fail before
any service or filesystem mutation.

Run the final no-PowerShell verifier elevated. It requires a fresh, non-secret
key-presence and exact-ACL attestation from the running service process, the sole
HKCU Engine startup owner, and the reviewed SYSTEM AtStartup tunnel task before
it can report PASS.

The scripts do not own or remove the Engine startup entry, tunnel task, camera
data, recordings, model assets, Production configuration, or other services.

## Machine A Human Installation Gate (Original Task 15)

This is the authoritative paste-ready handoff for the later Human Owner session.
Task 15 prepares these commands but **does not run H1, H2, H3, H4, or H5**.
Run one numbered step at a time, return only the named evidence, and wait for
ChatGPT review before proceeding. Never return a password, token, private key,
session cookie, database URL, or environment-file contents.

The reviewed constants are:

- Engine startup owner: one `HKCU Run` entry named `AEGIS Detection Engine`;
- Agent: automatic service `AEGISIdentityAgent` running as
  `NT SERVICE\AEGISIdentityAgent` on `127.0.0.1:8078`;
- Engine API: `127.0.0.1:8077`;
- Monitor forward: `127.0.0.1:18002`;
- physical stream endpoint:
  `http://aegis-stream-host.internal:18077/stream.mjpg`;
- temporary diagnostic port `18078`: forbidden and unnecessary;
- Machine A account aliases: `operator` -> `CAM-01`, `operator2` -> `CAM-02`;
- both accounts retain the same server-registered Machine A physical camera.

Values that depend on the real machine, deployment, or approved non-Production
database are labelled `DISCOVER_AT_HUMAN_GATE`. Do not guess them.

### H0 — read-only precheck

#### H0-1 — bind evidence to the reviewed checkout

- Purpose: prove branch, checkpoint, clean tree, and repository paths.
- Shell: Windows PowerShell 5.1, non-elevated is sufficient.
- Admin required: NO.
- Mutation: NO.
- Command:

```powershell
$ErrorActionPreference = 'Stop'
$RepoRoot = (git rev-parse --show-toplevel).Trim()
$ExpectedCheckpoint = Read-Host 'Paste the approved Task 15 checkpoint SHA from ChatGPT'
$Branch = (git -C $RepoRoot branch --show-current).Trim()
$Head = (git -C $RepoRoot rev-parse HEAD).Trim()
$Dirty = @(git -C $RepoRoot status --porcelain)
if ($Branch -ne 'feat/idea2-machine-a-no-powershell-runtime') { throw 'WRONG_BRANCH' }
if ($Head -ne $ExpectedCheckpoint) { throw 'WRONG_CHECKPOINT' }
if ($Dirty.Count -ne 0) { throw 'DIRTY_WORKTREE' }
$EngineSource = Join-Path $RepoRoot 'IDEA2-AEGIS_CCTV-Operator\detection-engine'
$AgentScripts = Join-Path $EngineSource 'windows\identity-agent'
if (-not (Test-Path -LiteralPath $EngineSource -PathType Container)) { throw 'ENGINE_SOURCE_MISSING' }
if (-not (Test-Path -LiteralPath $AgentScripts -PathType Container)) { throw 'AGENT_SCRIPTS_MISSING' }
[pscustomobject]@{
  STEP = 'H0-1'; BRANCH = $Branch; HEAD = $Head; WORKTREE_CLEAN = 'YES'
  ENGINE_SOURCE = $EngineSource; AGENT_SCRIPTS = $AgentScripts
}
```

- Expected: the exact approved checkpoint and `WORKTREE_CLEAN=YES`.
- Abort if: wrong branch/checkpoint, dirty tree, or either path is absent.
- Return to chat: the object above; no Git remote credentials.

#### H0-2 — Windows, Administrator, and pinned Python prerequisite

- Purpose: identify the interactive Engine owner and prove 64-bit CPython 3.12
  is available before any install.
- Shell: Windows PowerShell 5.1.
- Admin required: NO for H0; `ADMINISTRATOR=True` is required before H1.
- Mutation: NO.
- Command:

```powershell
$Identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$Principal = New-Object Security.Principal.WindowsPrincipal($Identity)
$IsAdmin = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$Python312 = (& py.exe -3.12 -c "import struct,sys; assert sys.version_info[:2] == (3,12) and struct.calcsize('P') == 8; print(sys.executable)").Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Python312 -PathType Leaf)) { throw 'CPYTHON_3_12_X64_REQUIRED' }
$EngineUserSid = $Identity.User.Value
[pscustomobject]@{
  STEP = 'H0-2'; WINDOWS = [Environment]::OSVersion.VersionString
  POWERSHELL = $PSVersionTable.PSVersion.ToString(); ADMINISTRATOR = $IsAdmin
  ENGINE_USER_SID = $EngineUserSid; PYTHON_312_X64 = $Python312
}
```

- Expected: PowerShell 5.1, `ADMINISTRATOR=True` when later H1 runs, a
  canonical SID, and a real CPython 3.12 x64 executable.
- Abort if: Python proof fails or the intended interactive Engine account is
  not the current identity.
- Return to chat: fields above; the SID is identity metadata, not a secret.

##### H0-2R — CPython 3.12 prerequisite remediation

Use this bounded remediation only when H0-2 returns
`CPYTHON_3_12_X64_REQUIRED`. It is not Agent or Engine installation. Machine A
evidence on 2026-09-27 showed an existing Python 3.14 x64 installation at
`C:\Users\puppu\AppData\Local\Python\pythoncore-3.14-64\python.exe` and no
Python 3.12. Preserve that interpreter byte-for-byte.

The reviewed prerequisite is Python 3.12.10 x64 installed side-by-side for all
users at `C:\Program Files\Python312\python.exe`. Machine scope is required so
the later `NT SERVICE\AEGISIdentityAgent` virtual environment does not depend
on the interactive user's private AppData tree. The installation deliberately
does not change system/user `PATH` and does not install or replace the shared
Python launcher. The existing `py.exe` remains the discovery mechanism.

###### H0-2R-1 — read-only package and preservation snapshot

- Purpose: bind the proposed prerequisite to the exact WinGet manifest and
  record Python 3.14 before any mutation.
- Shell: elevated Windows PowerShell 5.1 in the same interactive Engine account.
- Admin required: YES, so the next separately approved machine-scope step uses
  the same identity and shell.
- Mutation: NO.
- Command:

```powershell
$ErrorActionPreference = 'Stop'
$Winget = (Get-Command winget.exe -ErrorAction Stop).Source
$PythonInventoryBefore = @(& py.exe -0p)
if ($LASTEXITCODE -ne 0) { throw 'PYTHON_LAUNCHER_INVENTORY_FAILED' }
$Python314Before = (& py.exe -3.14 -c "import struct,sys; assert sys.version_info[:2] == (3,14) and struct.calcsize('P') == 8; print(sys.executable)").Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Python314Before -PathType Leaf)) { throw 'PYTHON_314_BASELINE_FAILED' }
$Python314HashBefore = (Get-FileHash -LiteralPath $Python314Before -Algorithm SHA256).Hash
if (@($PythonInventoryBefore | Select-String -Pattern '3\.12').Count -ne 0) { throw 'UNEXPECTED_PYTHON_312_PRESENT' }
$PackageDetails = @(& $Winget show --exact --id Python.Python.3.12 --version 3.12.10 --source winget)
if ($LASTEXITCODE -ne 0) { throw 'PYTHON_312_PACKAGE_LOOKUP_FAILED' }
$PackageText = $PackageDetails -join "`n"
if ($PackageText -notmatch '(?m)^Version:\s*3\.12\.10\s*$') { throw 'PYTHON_312_VERSION_MISMATCH' }
if ($PackageText -notmatch '(?m)^Publisher:\s*Python Software Foundation\s*$') { throw 'PYTHON_312_PUBLISHER_MISMATCH' }
if ($PackageText -notmatch '(?m)^\s*Installer Url:\s*https://www\.python\.org/ftp/python/3\.12\.10/python-3\.12\.10-amd64\.exe\s*$') { throw 'PYTHON_312_INSTALLER_URL_MISMATCH' }
if ($PackageText -notmatch '(?im)^\s*Installer SHA256:\s*67B5635E80EA51072B87941312D00EC8927C4DB9BA18938F7AD2D27B328B95FB\s*$') { throw 'PYTHON_312_INSTALLER_HASH_MISMATCH' }
[pscustomobject]@{
  STEP='H0-2R-1'; PACKAGE='Python.Python.3.12'; VERSION='3.12.10'
  ARCHITECTURE='x64'; SCOPE='machine'
  INSTALLER_SHA256='67B5635E80EA51072B87941312D00EC8927C4DB9BA18938F7AD2D27B328B95FB'
  PYTHON_314_PATH=$Python314Before; PYTHON_314_SHA256=$Python314HashBefore
  PYTHON_312_PRESENT='NO'; MUTATION='NO'
}
```

- Expected: exact package/version/publisher/URL/hash, no existing 3.12, and one
  recorded 3.14 path/hash.
- Abort if: any assertion fails, the installed inventory is unexpected, WinGet
  requests source-agreement mutation, or Python 3.14 differs from the Human
  evidence above.
- State change: none.
- Rollback reference: none.
- Return to chat: the object above and `py.exe -0p` paths only.

**STOP after H0-2R-1.** H0-2R-2 requires a separate Human/ChatGPT approval.

###### H0-2R-2 — exact side-by-side prerequisite install

- Purpose: install only CPython 3.12.10 x64 at a service-readable machine path.
- Shell: elevated Windows PowerShell 5.1, continuing the H0-2R-1 shell.
- Admin required: YES. WinGet selects the manifest's machine/x64 installer,
  whose elevation requirement is `elevatesSelf`.
- Mutation: YES — installs only Python 3.12.10 x64 machine-wide.
- Command (prepared only; do not run during this documentation checkpoint):

```powershell
& $Winget install `
  --exact `
  --id Python.Python.3.12 `
  --version 3.12.10 `
  --source winget `
  --scope machine `
  --architecture x64 `
  --silent `
  --disable-interactivity `
  --accept-package-agreements `
  --no-upgrade `
  --override '/quiet InstallAllUsers=1 TargetDir="C:\Program Files\Python312" PrependPath=0 AppendPath=0 Include_exe=1 Include_lib=1 Include_dev=1 Include_pip=1 Include_launcher=0 InstallLauncherAllUsers=0 Include_test=0 Shortcuts=0'
if ($LASTEXITCODE -ne 0) { throw "PYTHON_312_INSTALL_FAILED_$LASTEXITCODE" }
'H0-2R-2=INSTALL_COMMAND_COMPLETED'
```

- Expected: WinGet validates the manifest SHA-256 and installs the exact x64
  version under `C:\Program Files\Python312`; it does not replace 3.14, modify
  PATH, install a Store alias, or replace the existing launcher.
- Abort if: package/version/scope/architecture selection changes, UAC is not
  approved, a hash/security warning occurs, WinGet proposes an upgrade or
  unrelated dependency, the target already exists, or the command is nonzero.
- Expected state change: one machine-scope Python 3.12.10 installation only.
- Rollback reference: H0-2R-4, valid only before H1 begins.
- Return to chat: WinGet result/exit code only; do not continue automatically.

###### H0-2R-3 — read-only post-install proof

- Purpose: prove exact 3.12 version/path/bitness and byte-identical Python 3.14.
- Shell: the same elevated Windows PowerShell 5.1.
- Admin required: YES for consistent machine-scope visibility.
- Mutation: NO.
- Command:

```powershell
$PythonInventoryAfter = @(& py.exe -0p)
if ($LASTEXITCODE -ne 0) { throw 'PYTHON_LAUNCHER_INVENTORY_FAILED' }
$Python312 = (& py.exe -3.12 -c "import struct,sys; assert sys.version_info[:3] == (3,12,10) and struct.calcsize('P') == 8; print(sys.executable)").Trim()
if ($LASTEXITCODE -ne 0) { throw 'CPYTHON_3_12_10_X64_REQUIRED' }
$ExpectedPython312 = 'C:\Program Files\Python312\python.exe'
if (-not [string]::Equals($Python312,$ExpectedPython312,[StringComparison]::OrdinalIgnoreCase)) { throw 'PYTHON_312_PATH_MISMATCH' }
$Python314After = (& py.exe -3.14 -c "import struct,sys; assert sys.version_info[:2] == (3,14) and struct.calcsize('P') == 8; print(sys.executable)").Trim()
if ($LASTEXITCODE -ne 0) { throw 'PYTHON_314_POSTCHECK_FAILED' }
$Python314HashAfter = (Get-FileHash -LiteralPath $Python314After -Algorithm SHA256).Hash
if (-not [string]::Equals($Python314After,$Python314Before,[StringComparison]::OrdinalIgnoreCase) -or $Python314HashAfter -ne $Python314HashBefore) { throw 'PYTHON_314_CHANGED' }
[pscustomobject]@{
  STEP='H0-2R-3'; PYTHON_312_VERSION='3.12.10'; PYTHON_312_X64=$Python312
  PYTHON_314_PATH=$Python314After; PYTHON_314_UNCHANGED='YES'
  PATH_CHANGED='NO_BY_INSTALL_CONTRACT'; AGENT_ENGINE_RUNTIME_CHANGED='NO'
  PYTHON_INVENTORY=($PythonInventoryAfter -join '; ')
}
```

- Expected: 3.12.10 x64 at the exact Program Files path, 3.14 path/hash
  unchanged, and both versions listed by `py.exe -0p`.
- Abort if: any assertion fails or PATH/launcher/another Python changed.
- State change: none.
- Rollback reference: H0-2R-4.
- Return to chat: the object above. Then rerun the original H0-2 block and stop;
  do not continue to H0-3 without review.

###### H0-2R-4 — Python-3.12-only rollback

Use only before H1 has begun, after explicit Human/ChatGPT approval:

```powershell
$Winget = (Get-Command winget.exe -ErrorAction Stop).Source
$ExpectedPython314Path = 'C:\Users\puppu\AppData\Local\Python\pythoncore-3.14-64\python.exe'
$ExpectedPython314Sha256 = (Read-Host 'Paste PYTHON_314_SHA256 from H0-2R-1').Trim().ToUpperInvariant()
& $Winget uninstall --exact --id Python.Python.3.12 --version 3.12.10 --source winget --scope machine --silent --disable-interactivity
if ($LASTEXITCODE -ne 0) { throw "PYTHON_312_ROLLBACK_FAILED_$LASTEXITCODE" }
$Inventory = @(& py.exe -0p)
if ($LASTEXITCODE -ne 0) { throw 'PYTHON_LAUNCHER_INVENTORY_FAILED' }
if (@($Inventory | Select-String -Pattern '3\.12').Count -ne 0 -or (Test-Path -LiteralPath 'C:\Program Files\Python312\python.exe')) { throw 'PYTHON_312_ROLLBACK_INCOMPLETE' }
$Python314AfterRollback = (& py.exe -3.14 -c "import struct,sys; assert sys.version_info[:2] == (3,14) and struct.calcsize('P') == 8; print(sys.executable)").Trim()
$Python314HashAfterRollback = (Get-FileHash -LiteralPath $Python314AfterRollback -Algorithm SHA256).Hash
if (-not [string]::Equals($Python314AfterRollback,$ExpectedPython314Path,[StringComparison]::OrdinalIgnoreCase) -or $Python314HashAfterRollback -ne $ExpectedPython314Sha256) { throw 'PYTHON_314_ROLLBACK_POSTCHECK_FAILED' }
'H0-2R-4=PYTHON_312_REMOVED_PYTHON_314_UNCHANGED'
```

This rollback targets only package `Python.Python.3.12` version 3.12.10 in
machine scope. It must not use `--all-versions`, modify Python 3.14, remove the
shared launcher, or run after Agent/Engine H1 installation without a new review.

#### H0-3 — existing owners, services, tasks, and listeners

- Purpose: detect conflicts without normalizing them.
- Shell: elevated Windows PowerShell 5.1 for complete ACL evidence.
- Admin required: YES.
- Mutation: NO.
- Command:

```powershell
& "$EngineSource\windows\status_autostart.ps1"
& "$AgentScripts\status_identity_agent.ps1"
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 8077,8078,18002,18078 } |
  ForEach-Object {
    $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
    [pscustomobject]@{ Address=$_.LocalAddress; Port=$_.LocalPort; PID=$_.OwningProcess; Process=$p.ProcessName; Path=$p.Path }
  }
Get-ScheduledTask -TaskName 'AEGIS Detection Engine','AEGIS Detection Tunnel' -ErrorAction SilentlyContinue |
  Select-Object TaskName,State,@{n='UserId';e={$_.Principal.UserId}},Actions,Triggers
Get-CimInstance Win32_Service -Filter "Name='AEGISIdentityAgent'" -ErrorAction SilentlyContinue |
  Select-Object Name,State,StartMode,StartName,PathName,ProcessId
```

- Expected: no competing Engine service/task owner, no unexpected `8078`
  owner, tunnel contract understood, and `18078` absent.
- Abort if: `UNEXPECTED_ENGINE_OWNER`, `UNEXPECTED_AGENT_SERVICE`,
  `UNEXPECTED_PORT_OWNER`, `UNKNOWN_EXISTING_RUNTIME`, or `18078` is required.
- Return to chat: status fields and process metadata only; never raw logs.

#### H0-4 — source hash, camera idle, and stable-endpoint prerequisites

- Purpose: bind the Agent install to reviewed source and prove the camera is
  idle before mutation.
- Shell: elevated Windows PowerShell 5.1.
- Admin required: YES.
- Mutation: NO.
- Command:

```powershell
$AgentSourceSha256 = (& "$AgentScripts\get_identity_agent_source_hash.ps1" -SourceRoot $EngineSource).Trim()
if ($AgentSourceSha256 -notmatch '^[A-F0-9]{64}$') { throw 'SOURCE_HASH_INVALID' }
$Health = $null
try { $Health = Invoke-RestMethod -Uri 'http://127.0.0.1:8077/health' -TimeoutSec 5 } catch { }
if ($null -ne $Health -and ([bool]$Health.camera_demanded -or [bool]$Health.camera_connected)) { throw 'CAMERA_NOT_IDLE' }
[pscustomobject]@{
  STEP='H0-4'; AGENT_SOURCE_SHA256=$AgentSourceSha256
  ENGINE_HEALTH=$(if ($null -eq $Health) { 'UNREACHABLE_OR_NOT_INSTALLED' } else { 'REACHABLE' })
  CAMERA_DEMANDED=$(if ($null -eq $Health) { 'NOT_PROVEN' } else { [bool]$Health.camera_demanded })
  CAMERA_CONNECTED=$(if ($null -eq $Health) { 'NOT_PROVEN' } else { [bool]$Health.camera_connected })
  STABLE_STREAM='http://aegis-stream-host.internal:18077/stream.mjpg'
  TEMP_18078_REQUIRED='NO'
}
```

- Expected: one uppercase SHA-256, camera idle if Engine is reachable, and the
  exact stable endpoint above.
- Abort if: camera is active, source hash fails, the reviewed DNS name does not
  resolve through the approved deployment mapping, or the SSH bind is not one
  explicit non-loopback IPv4 server interface.
- Return to chat: the object above. Server-side mapping is proven later by the
  H1-5 physical-stream validator; no environment-file contents are returned.

#### H0-5 — rollback inventory

- Purpose: preserve enough non-secret state to choose a safe rollback.
- Shell: elevated Windows PowerShell 5.1.
- Admin required: YES.
- Mutation: NO.
- Command:

```powershell
$RuntimeRoot = Join-Path $env:LOCALAPPDATA 'AEGIS\DetectionEngine'
[pscustomobject]@{
  STEP='H0-5'
  RUNTIME_ROOT=$RuntimeRoot
  RUNTIME_PRESENT=(Test-Path -LiteralPath $RuntimeRoot)
  ENGINE_RUN=(Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' 'AEGIS Detection Engine' -ErrorAction SilentlyContinue)
  ENGINE_INSTALL_MARKER=(Test-Path -LiteralPath (Join-Path $RuntimeRoot 'install.json'))
  AGENT_INSTALL_MARKER=(Test-Path -LiteralPath (Join-Path $env:ProgramData 'AEGIS\IdentityAgentConfiguration\install.json'))
}
```

- Expected: exact existing-state classification, without printing `.env`, key,
  cookie, or token contents.
- Abort if: roots differ from the reviewed defaults or an unknown marker/state
  exists.
- Return to chat: booleans and paths only.

### Mutation start boundary

**STOP here during Task 15.** H1 and later are prepared commands for Task 16;
they are not authorization to run an installer. Before H1, ChatGPT must review
all H0 evidence and explicitly authorize one bounded step.

### H1 — reviewed mutation plan (do not execute in Task 15)

#### H1-1 — create the non-secret Agent configuration

- Purpose: create the external Agent configuration using runtime-discovered
  Node ID, key version, and current Engine user SID.
- Shell: elevated Windows PowerShell 5.1.
- Admin required: YES.
- Mutation: YES — writes only `C:\AEGIS-Local\identity-agent.env`.
- Command:

```powershell
$NodeId = Read-Host 'Approved Machine A Node ID (DISCOVER_AT_HUMAN_GATE)'
$KeyVersion = [uint32](Read-Host 'Approved registry key version; use 1 only for a new registration')
$MonitorBaseUrl = Read-Host 'Approved isolated non-Production Monitor HTTPS base URL'
$MonitorAudience = Read-Host 'Approved isolated non-Production Monitor HTTPS origin'
$BrowserOrigin = Read-Host 'Approved isolated non-Production browser HTTPS origin'
$EngineUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$AgentConfiguration = 'C:\AEGIS-Local\identity-agent.env'
New-Item -ItemType Directory -Path (Split-Path -Parent $AgentConfiguration) -Force | Out-Null
@"
AEGIS_AGENT_MONITOR_BASE_URL=$MonitorBaseUrl
AEGIS_AGENT_AUTH_AUDIENCE=$MonitorAudience
AEGIS_AGENT_NODE_ID=$NodeId
AEGIS_AGENT_KEY_VERSION=$KeyVersion
AEGIS_AGENT_ENGINE_USER_SID=$EngineUserSid
AEGIS_IDENTITY_BROWSER_ALLOWED_ORIGINS=$BrowserOrigin
AEGIS_AGENT_ENGINE_STREAM_URL=http://aegis-stream-host.internal:18077/stream.mjpg
AEGIS_AGENT_TLS_VERIFY=true
"@ | Set-Content -LiteralPath $AgentConfiguration -Encoding ASCII
if ((Get-Item -LiteralPath $AgentConfiguration).Length -le 0) { throw 'AGENT_CONFIG_WRITE_FAILED' }
'H1-1=PASS_NON_SECRET_CONFIG_WRITTEN'
```

- Expected: non-empty file; it contains no credential or logical alias.
- Abort if: Node/key version does not match the approved non-Production
  registry plan, SID is not the interactive Engine user, any URL is Production
  or not reviewed HTTPS, or any secret would be added.
- State change: one external non-secret file.
- Rollback: delete only that exact file after confirming H1-2 did not run.
- Return to chat: `H1-1=PASS_NON_SECRET_CONFIG_WRITTEN`, Node ID, key version,
  SID, and the three URL hostnames only; never file contents.

#### H1-2 — install the Agent runtime and service, stopped

- Purpose: install the pinned/hash-locked CPython 3.12 Agent runtime without
  generating a key or creating camera demand.
- Shell: elevated Windows PowerShell 5.1.
- Admin required: YES.
- Mutation: YES.
- Command:

```powershell
$AgentSourceSha256 = (& "$AgentScripts\get_identity_agent_source_hash.ps1" -SourceRoot $EngineSource).Trim()
& "$AgentScripts\install_identity_agent.ps1" `
  -SourceRoot $EngineSource `
  -ExpectedSourceSha256 $AgentSourceSha256 `
  -ConfigurationFile $AgentConfiguration `
  -BasePythonPath $Python312
```

- Expected: `SERVICE_NAME=AEGISIdentityAgent`, service account exact,
  `SERVICE_STARTED=NO`, `CAMERA_DEMAND_CREATED=NO`, and dependency installation
  through `requirements-identity-agent-windows.lock.txt` with
  `--require-hashes --only-binary=:all:`.
- Abort if: hash mismatch, dependency/import failure, wrong service identity,
  wrong root, unexpected existing Agent, or service starts.
- State change: managed Agent runtime/config/evidence roots and an automatic,
  stopped service; no application key.
- Rollback: H5 `PARTIAL_AGENT_INSTALL`; identity is absent or preserved.
- Return to chat: the installer fields listed under Expected plus the source
  hash; no pip output containing local credentials.

#### H1-3 — DPAPI CurrentUser preflight

- Purpose: prove DPAPI under the exact service identity before key generation.
- Shell: elevated Windows PowerShell 5.1.
- Admin required: YES.
- Mutation: YES — disposable non-secret preflight evidence only.
- Command:

```powershell
& "$AgentScripts\invoke_dpapi_preflight.ps1"
```

- Expected: `DPAPI_CURRENTUSER_PREFLIGHT=PASS`, service identity exact, and
  `KEY_GENERATED=NO`.
- Abort if: service is not stopped, service path/identity differs, or PASS
  evidence is missing.
- State change: non-secret preflight evidence.
- Rollback: H5 `PARTIAL_AGENT_INSTALL` removes provisioning evidence and
  preserves identity state.
- Return to chat: the three expected preflight fields only.

#### H1-4 — provision one protected identity and export only its public key

- Purpose: create/resume the DPAPI-protected Ed25519 identity under the service
  account and export public evidence.
- Shell: elevated Windows PowerShell 5.1.
- Admin required: YES.
- Mutation: YES.
- Command:

```powershell
& "$AgentScripts\provision_identity_key.ps1" -NodeId $NodeId -KeyVersion $KeyVersion
```

- Expected: matching Node/key version, a public fingerprint/export path, and
  `PRIVATE_KEY_EXPORTED=NO`.
- Abort if: preflight is missing, service is running, Node/key version differs,
  ACL validation fails, or any private material appears.
- State change: one DPAPI CurrentUser-protected identity in the service-only
  data root plus public-only evidence.
- Rollback: preserve identity by default; H5 `DESTRUCTIVE_IDENTITY_REMOVAL`
  needs separate explicit authorization.
- Return to chat: Node ID, key version, public fingerprint, export path, and
  `PRIVATE_KEY_EXPORTED=NO`; never public/private key contents.

#### H1-5 — register Machine A in an approved non-Production Monitor database

- Purpose: bind the exported public key to one server-generated physical camera
  and account aliases. This step runs in the approved Monitor administration
  shell, not in a browser.
- Shell: approved non-Production Monitor admin shell with `DATABASE_URL` already
  supplied out-of-band. Administrator on Machine A is not required.
- Admin required: NO on Machine A; approved Monitor database administrator
  authorization is required.
- Mutation: YES — approved non-Production registry only; never Production.
- Command for a fresh Node (replace the public-key path only with the exact
  H1-4 export path; do not paste its contents):

```bash
python3 IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py list
python3 IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py register --node-id "$NODE_ID" --alias-mode account --public-key "$PUBLIC_KEY_EXPORT"
python3 IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py reconcile-account-aliases --node-id "$NODE_ID" --account-alias operator=CAM-01 --account-alias operator2=CAM-02 --dry-run
python3 IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py reconcile-account-aliases --node-id "$NODE_ID" --account-alias operator=CAM-01 --account-alias operator2=CAM-02
python3 IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py set-ingest-auth-mode --node-id "$NODE_ID" --mode ed25519_required
python3 IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py list
node --input-type=module -e "import { approvedStreamUrlForPhysicalCamera as approved } from './IDEA2-AEGIS_Monitor/server/auth/physicalStreamSource.js'; const id=Number(process.argv[1]); const url=approved(id,process.argv[2]); if(url!=='http://aegis-stream-host.internal:18077/stream.mjpg') process.exit(1); console.log('PHYSICAL_STREAM_SOURCE=PASS')" "$PHYSICAL_CAMERA_ID" "$NODE_ID"
```

- Expected: one active Node, one globally unique physical camera, account
  policy with two mappings, key version matching H1-4, strict auth mode, and
  `PHYSICAL_STREAM_SOURCE=PASS` from the server-owned environment mapping.
- Abort if: database is Production, Node already exists unexpectedly, public
  fingerprint differs, aliases/users/cameras are absent, dry-run fails, or any
  mapping implies separate physical cameras for the two accounts.
- State change: approved non-Production registry rows only.
- Rollback: H5 `IDENTITY_CREATED_RUNTIME_FAILED` disables the exact Node;
  strict-to-legacy reversion requires a separate owner decision and must not
  affect Detector B.
- Return to chat: the `register`, dry-run, reconciliation, auth-mode, final
  `list`, and `PHYSICAL_STREAM_SOURCE=PASS` lines only. Run each CLI line only
  after ChatGPT accepts the preceding line; never return `DATABASE_URL`.

#### H1-6 — install/refresh the Engine and tunnel ownership

- Purpose: install the reviewed interactive Engine runtime, sole HKCU owner,
  and SYSTEM boot tunnel using existing protected machine files.
- Shell: elevated Windows PowerShell 5.1 in the interactive Engine account.
- Admin required: YES.
- Mutation: YES.
- Before running, set these path/deployment values from H0 without printing
  file contents: `$EngineConfigurationFile`, `$TunnelIdentityFile`,
  `$KnownHostsFile`, `$TunnelHost`, `$MonitorTargetHost`, and
  `$RemoteBindAddress` (`DISCOVER_AT_HUMAN_GATE`). Choose exactly one command
  after H0 classification; do not guess whether the runtime is fresh.
- Fresh install command (only when H0 proved the managed runtime/marker absent):

```powershell
$EngineConfig = @{}
Get-Content -LiteralPath $EngineConfigurationFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
    $name,$value = $line.Split('=',2)
    $null = ($EngineConfig[$name.Trim()] = $value.Trim())
  }
}
if ($EngineConfig['AEGIS_MONITOR_INGEST_MODE'] -ne 'identity_agent') { throw 'ENGINE_INGEST_MODE_MISMATCH' }
if ($EngineConfig['AEGIS_CAPTURE_ON_DEMAND'] -ne 'true') { throw 'ENGINE_ON_DEMAND_REQUIRED' }
if ($EngineConfig['AEGIS_AGENT_ENGINE_STREAM_URL'] -ne 'http://aegis-stream-host.internal:18077/stream.mjpg') { throw 'STABLE_ENDPOINT_MISMATCH' }
if ($EngineConfig['AEGIS_STREAM_PUBLIC_URL'] -ne 'http://aegis-stream-host.internal:18077/stream.mjpg') { throw 'PUBLIC_STREAM_ENDPOINT_MISMATCH' }
if (-not $EngineConfig['AEGIS_MONITOR_API_BASE'] -or -not $EngineConfig['AEGIS_DETECTION_ENGINE_API_KEY']) { throw 'ENGINE_MONITOR_CONFIG_INCOMPLETE' }
if ($EngineConfig['AEGIS_MONITOR_API_BASE'].TrimEnd('/') -ne $MonitorBaseUrl.TrimEnd('/')) { throw 'MONITOR_BASE_URL_MISMATCH' }
& "$EngineSource\windows\install_autostart.ps1" `
  -ConfigurationFile $EngineConfigurationFile `
  -BasePythonPath $Python312 `
  -TunnelHost $TunnelHost `
  -MonitorTargetHost $MonitorTargetHost `
  -RemoteBindAddress $RemoteBindAddress `
  -RemotePort 18077 `
  -IdentityFile $TunnelIdentityFile `
  -KnownHostsFile $KnownHostsFile `
  -StartNow
```

- Bound existing-runtime refresh command (only when H0 proved the reviewed
  `install.json`, key filename, and roots match; it deliberately omits
  `-IdentityFile` so SYSTEM reuses the already bound runtime key):

```powershell
& "$EngineSource\windows\install_autostart.ps1" `
  -ConfigurationFile $EngineConfigurationFile `
  -BasePythonPath $Python312 `
  -TunnelHost $TunnelHost `
  -MonitorTargetHost $MonitorTargetHost `
  -RemoteBindAddress $RemoteBindAddress `
  -RemotePort 18077 `
  -KnownHostsFile $KnownHostsFile `
  -StartNow
```

- Expected: install complete, Engine owner `HKCU Run`, tunnel owner SYSTEM
  AtStartup, local ports `8077`/`18002`, reverse port `18077`, and camera idle.
- Abort if: stable mapping/bind is unproven, a competing Engine owner exists,
  strict-host-key probe fails, `.env` lacks reviewed integration keys, or camera
  becomes demanded/connected without a viewer.
- State change: managed Engine runtime, HKCU Run entry, tunnel task, protected
  SSH runtime copy; old Engine task may only be disabled.
- Rollback: H5 `ROLLBACK_RUNTIME_ONLY` preserves runtime/config/keys/data.
- Return to chat: installer completion/runtime/startup-owner lines and the H2
  status result; never `.env`, SSH-key, or `known_hosts` contents.

#### H1-7 — start only the registered Agent service

- Purpose: start authentication/heartbeat without camera demand.
- Shell: elevated Windows PowerShell 5.1.
- Admin required: YES.
- Mutation: YES.
- Command:

```powershell
Start-Service -Name 'AEGISIdentityAgent'
(Get-Service -Name 'AEGISIdentityAgent').WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
& "$AgentScripts\status_identity_agent.ps1"
```

- Expected: service RUNNING, `127.0.0.1:8078` owned by its PID, key/ACL service
  attestation PASS, and `CAMERA_DEMAND_CREATED=NO`.
- Abort if: identity/path/ACL differs, auth fails, port owner differs, or camera
  becomes active.
- State change: Agent service running; no Engine ownership change.
- Rollback: stop the exact service, collect evidence, then use H5
  `PARTIAL_AGENT_INSTALL` only after review.
- Return to chat: the redacted Agent status fields and camera-idle health only.

### H2 — immediate post-install verification

Run elevated, return the output, and stop on any failure:

```powershell
& "$EngineSource\windows\status_autostart.ps1"
& "$AgentScripts\status_identity_agent.ps1"
& "$AgentScripts\verify_machine_a_no_powershell.ps1"
$Forbidden = @(Get-NetTCPConnection -State Listen -LocalPort 18078 -ErrorAction SilentlyContinue)
if ($Forbidden.Count -ne 0) { throw 'TEMP_18078_LISTENER_PRESENT' }
$Health = Invoke-RestMethod -Uri 'http://127.0.0.1:8077/health' -TimeoutSec 5
if ([bool]$Health.camera_demanded -or [bool]$Health.camera_connected) { throw 'CAMERA_NOT_IDLE' }
[pscustomobject]@{ STEP='H2'; CAMERA_IDLE='PASS'; TEMP_18078_REQUIRED='NO'; ENGINE_OWNER='HKCU_RUN'; AGENT_IDENTITY='NT SERVICE\AEGISIdentityAgent' }
```

Required evidence: installation `INSTALLED`, service `RUNNING/AUTOMATIC`, exact
service identity/executable, `LOOPBACK_8078=RUNNING`, key and data-root ACL
`SERVICE_ATTESTED`, Engine owner/command valid, tunnel SYSTEM/AtStartup/action
valid, Monitor forward healthy, stable endpoint exact, and camera idle. H2 does
not print key material or configuration values.
Return all named status fields and the final H2 object to chat, but omit raw
logs, cookies, environment contents, database URLs, and key contents.

### H3 — reboot/login and account acceptance (Task 16 only)

1. Reboot Windows normally; do not start any AEGIS helper manually.
2. Log into the approved interactive Engine account.
3. Re-run H0-1 and H0-2 to restore the documented session variables after the
   reboot, then run the H2 command block. It must pass before opening a browser.
4. Open the exact approved isolated non-Production browser origin recorded in
   H1-1, sign in as
   `operator`, and open the Live camera. Browser association must be automatic.
   In a separate PowerShell run:

   ```powershell
   $Health = Invoke-RestMethod 'http://127.0.0.1:8077/health' -TimeoutSec 5
   $Health | Select-Object camera_demanded,camera_connected,demanding_viewers,passive_viewers
   if (-not $Health.camera_demanded -or -not $Health.camera_connected -or $Health.demanding_viewers -lt 1) { throw 'OPERATOR_DEMAND_FAILED' }
   ```

   Return UI evidence `operator -> CAM-01` plus server-side Node/physical-camera
   metadata. It must identify Machine A's one physical camera.
5. Close the final Live viewer and log out. Poll `/health` until
   `camera_demanded=false`, `camera_connected=false`, and
   `demanding_viewers=0`; otherwise abort:

   ```powershell
   $Deadline = [DateTime]::UtcNow.AddSeconds(30)
   do {
     $Health = Invoke-RestMethod 'http://127.0.0.1:8077/health' -TimeoutSec 5
     if (-not $Health.camera_demanded -and -not $Health.camera_connected -and $Health.demanding_viewers -eq 0) { break }
     Start-Sleep -Milliseconds 500
   } while ([DateTime]::UtcNow -lt $Deadline)
   if ($Health.camera_demanded -or $Health.camera_connected -or $Health.demanding_viewers -ne 0) { throw 'FINAL_RELEASE_FAILED' }
   $Health | Select-Object camera_demanded,camera_connected,demanding_viewers,passive_viewers
   ```
6. Sign in as `operator2` and repeat. UI alias must be `CAM-02`, while the
   server-resolved Node and physical-camera ID must equal step 4. Do not switch
   heartbeat, restart a bridge, or start another camera process.
7. Close/logout and prove final idle again.
8. Reboot a second time, log in, rerun H0-1 and H0-2, run H2 again, and prove
   idle recovery with no manually started npm, Vite, Python, heartbeat, or
   port-18078 helper.

Return the two alias/physical-camera observations and each bounded Engine
health object to chat; do not return browser cookies or authentication tokens.

### H4 — stop and repair

Stop immediately for any unexpected owner/path/service, source/dependency hash
failure, key/ACL failure, stable endpoint/tunnel mismatch, camera activation
without demand, or partial installer failure. Do not force an unknown state into
the expected shape.

After evidence review, use at most one applicable bounded repository-supported
repair and re-run all of H2. Agent repair:

```powershell
$AgentSourceSha256 = (& "$AgentScripts\get_identity_agent_source_hash.ps1" -SourceRoot $EngineSource).Trim()
& "$AgentScripts\repair_identity_agent.ps1" -SourceRoot $EngineSource -ExpectedSourceSha256 $AgentSourceSha256 -BasePythonPath $Python312 -StartNow
```

Engine/tunnel repair:

```powershell
& "$EngineSource\windows\repair_autostart.ps1" -BasePythonPath $Python312 -StartNow
```

Agent repair preserves the protected identity by construction and refuses any
Engine owner other than the sole HKCU Run owner. Engine repair reuses the
installed `.env`, SSH key, `known_hosts`, models, recordings, logs, and
`install.json`. Key/ACL attestation failure is an investigation boundary, not
permission to rotate or destroy the identity.
Return the selected repair output and fresh H2 status only.

### H5 — rollback

- `INSTALL_NOT_STARTED`: remove only the external non-secret
  `C:\AEGIS-Local\identity-agent.env` if the Human Owner wants to abandon the
  gate. No installed state exists:

  ```powershell
  Remove-Item -LiteralPath 'C:\AEGIS-Local\identity-agent.env' -Force
  ```
- `PARTIAL_AGENT_INSTALL`, `AGENT_INSTALLED_ENGINE_UNCHANGED`, or
  `POST_INSTALL_VERIFICATION_FAILED`: collect status first, then run the exact
  default Agent uninstall after owner approval:

  ```powershell
  & "$AgentScripts\uninstall_identity_agent.ps1"
  ```

  This removes only managed Agent service/runtime/config/evidence and reports
  `IDENTITY_PRESERVED=YES`. It does not remove Engine ownership or the tunnel.
- `ROLLBACK_RUNTIME_ONLY`: after status/evidence review, run:

  ```powershell
  & "$EngineSource\windows\uninstall_autostart.ps1"
  ```

  This removes only the HKCU Run entry, SYSTEM tunnel task, and managed
  supervisors; it deliberately preserves runtime, `.env`, SSH material,
  recordings, logs, and `.venv`.
- `IDENTITY_CREATED_RUNTIME_FAILED`: preserve the identity, disable the exact
  non-Production Node if necessary with `manage_nodes.py disable`, and
  investigate. Do not rotate or delete automatically.
- `DESTRUCTIVE_IDENTITY_REMOVAL`: **not a normal rollback**. The separate
  `-DestroyIdentity` option permanently removes the protected identity and is
  forbidden unless the Human Owner gives a new, explicit destructive approval
  after reviewing the exact marker and Node disposition.

Every H1 mutation has a paired H2/H3 verification and an H5 rollback reference.
Production, other services/tasks, camera/model assets, recordings, Docker data,
and unrelated user files are outside every rollback command above.
Return the uninstall/disable status lines and fresh exact-resource inventory;
never return preserved identity contents.
