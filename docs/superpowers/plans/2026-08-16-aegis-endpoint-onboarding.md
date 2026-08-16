# AEGIS Endpoint Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Windows onboarding package that an IT administrator runs once so an employee only needs to sign in to Twingate and open `https://aegis.internal/`.

**Architecture:** Keep X1 isolated from production-server code. A single PowerShell entry script owns Windows elevation checks, fail-closed Root CA verification/import, Twingate detection/controlled install, AEGIS shortcut creation, and post-login HTTPS checks. Repository-level Node tests validate package security contracts and constants on any CI platform; Windows PowerShell performs syntax/runtime validation without changing Beelink production state.

**Tech Stack:** Windows PowerShell 5.1-compatible script, Windows certificate store, `curl.exe`/Schannel, Twingate Windows EXE installer, Node.js built-in `node:test` for repository contract tests.

## Global Constraints

- Windows client only for v1.
- The employee's Twingate identity login must never be automated.
- Never embed Gmail credentials, Twingate tokens/service keys, AEGIS passwords, API keys, private keys, password hashes, or production `.env` values.
- The package may contain only the public `aegis-root-ca.crt`; it must never contain `aegis-root-ca.key` or `aegis.internal.key`.
- Approved Root CA SHA-256: `8D03EC3090DE7D3DC38DCE86234219F3675ED0124D44B32D721B6A4EABA10CA7`.
- Approved Root CA thumbprint: `1B3DFBBFA2DD5F2E80F5729D54248B04B8E030A5`.
- Approved Root CA subject must contain `CN=AEGIS Internal Root CA, O=AEGIS, C=TH`.
- Primary URL: `https://aegis.internal/`.
- Health URLs: `https://aegis.internal/drive/healthz` and `https://aegis.internal/monitor/healthz`.
- Do not disable TLS validation globally and do not use `-k`/`--insecure`.
- Current private PKI has no CRL/OCSP; `curl.exe --ssl-revoke-best-effort` is allowed only for the explicit Schannel revocation-availability limitation and must be reported as such.
- Use the official Twingate Windows EXE endpoint `https://api.twingate.com/download/windows` when installation is needed.
- Supported Twingate deployment arguments are `/qn`, `network=<network>.twingate.com`, and `auto_update=true`; an existing Twingate installation must be detected and skipped, never automatically reinstalled or replaced.
- X1 must not modify Beelink containers, Docker Compose, PostgreSQL, volumes, NGINX, VLANs, UFW, Twingate Connector, or production networking.
- Monitor remains **DO NOT RECREATE**.
- Do not update Obsidian during X1; final canonical documentation remains deferred to F5.

---

## File Structure

Create these focused artifacts:

```text
scripts/endpoint-onboarding/
├── AEGIS-Client-Setup.ps1        # administrator-run orchestration
├── endpoint-onboarding.json      # non-secret constants and URLs
├── certificates/
│   └── aegis-root-ca.crt         # public AEGIS trust anchor only
└── README.md                     # IT/admin usage and validation

tests/
└── endpointOnboarding.test.mjs   # package/security contract tests
```

`AEGIS-Client-Setup.ps1` is the only executable entry point. `endpoint-onboarding.json` keeps values testable without parsing implementation details. The certificate file is public material. The test file rejects private-key material, wrong trust-anchor identity, unsafe TLS flags, and missing onboarding behaviors.

---

### Task 1: Establish the package contract and fail-closed trust-anchor tests

**Files:**
- Create: `tests/endpointOnboarding.test.mjs`
- Create: `scripts/endpoint-onboarding/endpoint-onboarding.json`
- Create: `scripts/endpoint-onboarding/certificates/aegis-root-ca.crt`

**Interfaces:**
- Consumes: approved Root CA SHA-256/thumbprint/subject and AEGIS URLs from the global constraints.
- Produces: JSON configuration consumed by `AEGIS-Client-Setup.ps1`; a verified public Root CA artifact; CI-visible security contract tests.

- [ ] **Step 1: Write the failing package-contract tests**

Create `tests/endpointOnboarding.test.mjs` with tests equivalent to:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../scripts/endpoint-onboarding/', import.meta.url);
const configPath = new URL('endpoint-onboarding.json', root);
const certPath = new URL('certificates/aegis-root-ca.crt', root);
const scriptPath = new URL('AEGIS-Client-Setup.ps1', root);

const EXPECTED_HASH = '8D03EC3090DE7D3DC38DCE86234219F3675ED0124D44B32D721B6A4EABA10CA7';
const EXPECTED_THUMBPRINT = '1B3DFBBFA2DD5F2E80F5729D54248B04B8E030A5';

test('endpoint onboarding config defines the approved AEGIS contract', () => {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.rootCaSha256, EXPECTED_HASH);
  assert.equal(config.rootCaThumbprint, EXPECTED_THUMBPRINT);
  assert.equal(config.rootCaSubject, 'CN=AEGIS Internal Root CA, O=AEGIS, C=TH');
  assert.equal(config.aegisUrl, 'https://aegis.internal/');
  assert.deepEqual(config.healthUrls, [
    'https://aegis.internal/drive/healthz',
    'https://aegis.internal/monitor/healthz',
  ]);
  assert.equal(config.twingateInstallerUri, 'https://api.twingate.com/download/windows');
});

test('bundled public Root CA matches the approved SHA-256', () => {
  const bytes = readFileSync(certPath);
  const actual = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  assert.equal(actual, EXPECTED_HASH);
});

test('onboarding package contains no private-key material', () => {
  for (const candidate of [
    new URL('certificates/aegis-root-ca.key', root),
    new URL('certificates/aegis.internal.key', root),
  ]) {
    assert.equal(existsSync(candidate), false);
  }
});

test('setup entry point exists', () => {
  assert.equal(existsSync(scriptPath), true);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test tests/endpointOnboarding.test.mjs
```

Expected: FAIL because the X1 package artifacts do not exist yet.

- [ ] **Step 3: Add the minimal non-secret configuration**

Create `scripts/endpoint-onboarding/endpoint-onboarding.json`:

```json
{
  "rootCaSha256": "8D03EC3090DE7D3DC38DCE86234219F3675ED0124D44B32D721B6A4EABA10CA7",
  "rootCaThumbprint": "1B3DFBBFA2DD5F2E80F5729D54248B04B8E030A5",
  "rootCaSubject": "CN=AEGIS Internal Root CA, O=AEGIS, C=TH",
  "aegisUrl": "https://aegis.internal/",
  "healthUrls": [
    "https://aegis.internal/drive/healthz",
    "https://aegis.internal/monitor/healthz"
  ],
  "twingateInstallerUri": "https://api.twingate.com/download/windows"
}
```

Add the exact public PEM certificate whose Windows/Beelink file hash is the approved SHA-256. Do not reconstruct or add either private key.

- [ ] **Step 4: Add a temporary minimal setup entry point only to satisfy file existence**

Create `scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1` with the real parameter contract that later tasks will fill in:

```powershell
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [ValidatePattern('^[A-Za-z0-9-]+(\.twingate\.com)?$')]
    [string]$TwingateNetwork,

    [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
```

- [ ] **Step 5: Run the contract test and verify GREEN**

Run:

```bash
node --test tests/endpointOnboarding.test.mjs
```

Expected: PASS for configuration, certificate hash, private-key absence, and setup entry-point existence.

- [ ] **Step 6: Commit**

```bash
git add tests/endpointOnboarding.test.mjs scripts/endpoint-onboarding/
git commit -m "test(onboarding): establish X1 package contract"
```

---

### Task 2: Implement Windows elevation and idempotent Root CA installation

**Files:**
- Modify: `tests/endpointOnboarding.test.mjs`
- Modify: `scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1`

**Interfaces:**
- Consumes: `endpoint-onboarding.json`, `certificates/aegis-root-ca.crt`.
- Produces: `Test-IsAdministrator`, `Get-OnboardingConfig`, `Test-RootCaArtifact`, and `Ensure-RootCaTrusted` functions. `Ensure-RootCaTrusted` returns `PASS`, `ALREADY_INSTALLED`, or throws before any trust-store write.

- [ ] **Step 1: Add failing source-contract tests**

Append tests that require the setup script to contain the Windows Administrator check, SHA-256 verification, exact thumbprint lookup in `Cert:\LocalMachine\Root`, and `Import-Certificate`, while rejecting `--insecure`, `-k`, private-key names, and secret-like variable names.

Use concrete assertions such as:

```js
test('setup script fails closed before Root CA import and avoids unsafe TLS bypass', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /WindowsBuiltInRole\]::Administrator/);
  assert.match(source, /Get-FileHash/);
  assert.match(source, /Cert:\\LocalMachine\\Root/);
  assert.match(source, /Import-Certificate/);
  assert.doesNotMatch(source, /--insecure/i);
  assert.doesNotMatch(source, /(^|\s)-k(\s|$)/m);
  assert.doesNotMatch(source, /aegis-root-ca\.key|aegis\.internal\.key/i);
  assert.doesNotMatch(source, /password\s*=|token\s*=|service[_-]?key\s*=/i);
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
node --test tests/endpointOnboarding.test.mjs
```

Expected: FAIL because the trust functions are not implemented.

- [ ] **Step 3: Implement the minimal trust functions**

Implement PowerShell logic with these exact safety properties:

```powershell
function Test-IsAdministrator {
    $principal = [Security.Principal.WindowsPrincipal]::new(
        [Security.Principal.WindowsIdentity]::GetCurrent()
    )
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-OnboardingConfig {
    $configPath = Join-Path $PSScriptRoot 'endpoint-onboarding.json'
    return Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}

function Test-RootCaArtifact {
    param($Config)
    $certPath = Join-Path $PSScriptRoot 'certificates\aegis-root-ca.crt'
    if (-not (Test-Path -LiteralPath $certPath -PathType Leaf)) {
        throw 'ROOT_CA_FILE_MISSING'
    }
    $hash = (Get-FileHash -LiteralPath $certPath -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($hash -ne $Config.rootCaSha256) {
        throw 'ROOT_CA_HASH_DRIFT'
    }
    $cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath)
    if ($cert.Thumbprint.ToUpperInvariant() -ne $Config.rootCaThumbprint) {
        throw 'ROOT_CA_THUMBPRINT_DRIFT'
    }
    if ($cert.Subject -ne $Config.rootCaSubject) {
        throw 'ROOT_CA_SUBJECT_DRIFT'
    }
    return @{ Path = $certPath; Certificate = $cert }
}

function Ensure-RootCaTrusted {
    param($Config, $Artifact, [switch]$VerifyOnly)
    $existing = Get-ChildItem -Path 'Cert:\LocalMachine\Root' |
        Where-Object { $_.Thumbprint -eq $Config.rootCaThumbprint }
    if ($existing) { return 'ALREADY_INSTALLED' }
    if ($VerifyOnly) { return 'PENDING' }
    Import-Certificate -FilePath $Artifact.Path -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
    $verified = Get-ChildItem -Path 'Cert:\LocalMachine\Root' |
        Where-Object { $_.Thumbprint -eq $Config.rootCaThumbprint }
    if (-not $verified) { throw 'ROOT_CA_IMPORT_VERIFY_FAILED' }
    return 'PASS'
}
```

The orchestration must check Windows and Administrator elevation before calling `Ensure-RootCaTrusted`; `-VerifyOnly` must never write to the certificate store.

- [ ] **Step 4: Run Node tests and Windows parser validation**

Repository test:

```bash
node --test tests/endpointOnboarding.test.mjs
```

Windows syntax validation:

```powershell
$Errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  "$PWD\scripts\endpoint-onboarding\AEGIS-Client-Setup.ps1",
  [ref]$null,
  [ref]$Errors
) | Out-Null
if ($Errors.Count -ne 0) { $Errors | Format-List; exit 1 }
```

Expected: Node tests PASS; parser reports zero errors.

- [ ] **Step 5: Commit**

```bash
git add tests/endpointOnboarding.test.mjs scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1
git commit -m "feat(onboarding): install AEGIS Root CA safely"
```

---

### Task 3: Implement controlled Twingate detection and installation

**Files:**
- Modify: `tests/endpointOnboarding.test.mjs`
- Modify: `scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1`

**Interfaces:**
- Consumes: optional `-TwingateNetwork`; official installer URI from config.
- Produces: `Get-TwingateInstallState`, `Normalize-TwingateNetwork`, and `Ensure-TwingateInstalled`. Existing installation returns `ALREADY_INSTALLED`; missing client with `-VerifyOnly` returns `PENDING`; missing client in install mode requires `-TwingateNetwork` and installs with `/qn network=<fqdn> auto_update=true`.

- [ ] **Step 1: Add failing Twingate contract tests**

Append assertions requiring:

```js
test('setup uses the supported Twingate managed-device install contract', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /api\.twingate\.com\/download\/windows/);
  assert.match(source, /\/qn/);
  assert.match(source, /network=/);
  assert.match(source, /auto_update=true/);
  assert.match(source, /ALREADY_INSTALLED/);
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.doesNotMatch(source, /Uninstall|Remove-Msi|Win32_Product/i);
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node --test tests/endpointOnboarding.test.mjs
```

Expected: FAIL because Twingate installation logic is absent.

- [ ] **Step 3: Implement Twingate detection without touching an existing install**

Use uninstall registry keys rather than `Win32_Product`:

```powershell
function Get-TwingateInstallState {
    $roots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    $match = Get-ItemProperty $roots -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like 'Twingate*' } |
        Select-Object -First 1
    if ($match) { return $match }
    return $null
}
```

- [ ] **Step 4: Implement normalized network input and controlled install**

`Normalize-TwingateNetwork` must accept either `example` or `example.twingate.com`, and return only `example.twingate.com`. Reject any other suffix or characters.

`Ensure-TwingateInstalled` must:
1. return `ALREADY_INSTALLED` immediately when detection succeeds;
2. return `PENDING` in `-VerifyOnly` mode when absent;
3. require `-TwingateNetwork` when absent and install mode is active;
4. download the EXE only from the configured official HTTPS URI into a newly-created temporary directory;
5. validate `Get-AuthenticodeSignature $installer` has `Status -eq 'Valid'` before execution;
6. execute with argument list `/qn`, `network=<normalized>`, `auto_update=true`;
7. require exit code `0` or `3010`; treat `3010` as `PASS_REBOOT_REQUIRED`;
8. re-run detection and fail if Twingate still cannot be found;
9. remove the downloaded temporary installer in `finally`.

Do not set `no_optional_updates=true` in v1 because X1 does not yet provide an enterprise client-update lifecycle.

- [ ] **Step 5: Run tests, parser validation, and safe existing-client verification**

```bash
node --test tests/endpointOnboarding.test.mjs
```

On the current Windows client where Twingate is already installed, run only:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\endpoint-onboarding\AEGIS-Client-Setup.ps1 -VerifyOnly
```

Expected: Twingate reports `ALREADY_INSTALLED`; no installer download or reinstall occurs.

- [ ] **Step 6: Commit**

```bash
git add tests/endpointOnboarding.test.mjs scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1
git commit -m "feat(onboarding): automate Twingate client preparation"
```

---

### Task 4: Add AEGIS shortcut, HTTPS verification, and operator-friendly summary

**Files:**
- Modify: `tests/endpointOnboarding.test.mjs`
- Modify: `scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1`
- Create: `scripts/endpoint-onboarding/README.md`

**Interfaces:**
- Consumes: trusted Root CA state, Twingate state, AEGIS URLs.
- Produces: `Ensure-AegisShortcut`, `Test-AegisEndpoint`, final component result table, and clear next action `Sign in to Twingate, then open AEGIS` when authentication/connectivity is pending.

- [ ] **Step 1: Add failing UX/security tests**

Append tests equivalent to:

```js
test('setup creates the friendly AEGIS shortcut and verifies HTTPS without insecure bypass', () => {
  const source = readFileSync(scriptPath, 'utf8');
  assert.match(source, /https:\/\/aegis\.internal\//);
  assert.match(source, /WScript\.Shell/);
  assert.match(source, /--ssl-revoke-best-effort/);
  assert.match(source, /PASS|PENDING|FAIL/);
  assert.doesNotMatch(source, /192\.168\.10\.10/);
  assert.doesNotMatch(source, /--insecure/i);
});
```

- [ ] **Step 2: Run tests and verify RED**

```bash
node --test tests/endpointOnboarding.test.mjs
```

Expected: FAIL until shortcut/verification/reporting exists.

- [ ] **Step 3: Implement idempotent shortcut creation**

Create a Start Menu shortcut for all users at:

```text
%ProgramData%\Microsoft\Windows\Start Menu\Programs\AEGIS.lnk
```

with target URL `https://aegis.internal/`. If an existing shortcut already points to the exact URL, return `ALREADY_EXISTS`; if a file with the same name exists but targets something else, replace only that AEGIS shortcut after confirming it is a `.lnk` under the exact managed path.

Use `WScript.Shell` COM for `.lnk` creation; do not create a raw-IP shortcut.

- [ ] **Step 4: Implement endpoint verification with explicit revocation limitation**

For each configured URL, call Windows `curl.exe` without `-k`. First attempt ordinary verification. If and only if stderr/exit state represents the known Schannel `CRYPT_E_NO_REVOCATION_CHECK` limitation, retry that URL with `--ssl-revoke-best-effort` and classify it as `PASS_WITH_REVOCATION_LIMITATION`. Any hostname, trust-chain, HTTP, DNS, or connection error remains FAIL/PENDING as appropriate; never broadly suppress TLS verification.

Expected target after Twingate authentication:

```text
AEGIS_ROOT     HTTP 200
AEGIS_DRIVE    HTTP 200
AEGIS_MONITOR  HTTP 200
```

If Twingate is installed but the user has not authenticated yet and `aegis.internal` cannot resolve/connect, report `PENDING_TWINGATE_LOGIN` rather than modifying the server.

- [ ] **Step 5: Implement final summary**

Print a deterministic table such as:

```text
AEGIS ENDPOINT ONBOARDING
Windows              PASS
Administrator        PASS
AEGIS Root CA        PASS|ALREADY_INSTALLED
Twingate             PASS|ALREADY_INSTALLED|PENDING
AEGIS Shortcut       PASS|ALREADY_EXISTS
AEGIS HTTPS          PASS|PASS_WITH_REVOCATION_LIMITATION|PENDING

NEXT: Sign in to Twingate, then open https://aegis.internal/
```

Return non-zero only for actual setup failure. A user-login dependency is PENDING, not failure.

- [ ] **Step 6: Write the IT/admin README**

Document exactly these two supported modes:

```powershell
# Verify a machine without changing it
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\AEGIS-Client-Setup.ps1 -VerifyOnly

# Prepare a machine; when Twingate is absent supply the organization's Twingate network
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\AEGIS-Client-Setup.ps1 -TwingateNetwork '<organization-subdomain>'
```

The README must state that `<organization-subdomain>` is an IT deployment input, not an employee credential; the employee does not run PowerShell. It must also state that the package intentionally contains no private key or account secret.

- [ ] **Step 7: Run tests and parser validation**

```bash
node --test tests/endpointOnboarding.test.mjs
node --test tests/collaborationPolicy.test.mjs
```

Windows parser command from Task 2 must also report zero syntax errors.

- [ ] **Step 8: Commit**

```bash
git add tests/endpointOnboarding.test.mjs scripts/endpoint-onboarding/
git commit -m "feat(onboarding): complete employee access bootstrap"
```

---

### Task 5: Validate idempotency and perform controlled Windows acceptance

**Files:**
- Modify only if a validation defect is found: `scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1`, `tests/endpointOnboarding.test.mjs`, `scripts/endpoint-onboarding/README.md`

**Interfaces:**
- Consumes: completed X1 package.
- Produces: evidence that existing-client and second-run paths do not duplicate trust anchors, reinstall Twingate, or create duplicate shortcuts.

- [ ] **Step 1: Run repository regression tests**

```bash
node --test tests/endpointOnboarding.test.mjs tests/collaborationPolicy.test.mjs
node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs
```

Expected: all pass. X1 must not require an Obsidian write.

- [ ] **Step 2: Run a Windows read-only preflight on the already-working client**

From an Administrator PowerShell in the branch worktree:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\endpoint-onboarding\AEGIS-Client-Setup.ps1 -VerifyOnly
```

Expected on the current prepared workstation: Root CA `ALREADY_INSTALLED`, Twingate `ALREADY_INSTALLED`, HTTPS reachable after user authentication, and no system changes.

- [ ] **Step 3: Run the normal setup once on the already-prepared client**

Run the setup with the organization's Twingate network parameter only after reviewing the output of `-VerifyOnly`. Because Twingate and the Root CA already exist, the script must skip both and only create/verify the AEGIS shortcut and endpoints.

Record only status outputs; do not record identity credentials or session data.

- [ ] **Step 4: Run the normal setup a second time**

Expected second-run statuses:

```text
AEGIS Root CA   ALREADY_INSTALLED
Twingate        ALREADY_INSTALLED
AEGIS Shortcut  ALREADY_EXISTS
```

There must be exactly one AEGIS Root CA thumbprint in `Cert:\LocalMachine\Root` and one managed AEGIS shortcut.

- [ ] **Step 5: Perform a clean-client acceptance when a disposable Windows VM/test PC is available**

Acceptance sequence:

```text
Fresh Windows client
-> run one administrator setup command
-> Root CA imported after hash/thumbprint/subject validation
-> Twingate installed from official signed EXE and network preconfigured
-> employee signs in to Twingate
-> open AEGIS shortcut
-> https://aegis.internal/
-> no browser certificate-warning bypass
-> Drive and Monitor health reachable
```

Do not uninstall the working production-access Twingate client merely to simulate a clean machine.

- [ ] **Step 6: Security and diff review**

Run:

```bash
git diff --check main...HEAD
git diff --name-only main...HEAD
```

Review the branch diff to confirm it contains no `.env`, private key, credential, token, password/hash, generated installer binary, or production runtime configuration.

- [ ] **Step 7: Final X1 commit only if validation required fixes**

```bash
git add scripts/endpoint-onboarding tests/endpointOnboarding.test.mjs
git commit -m "fix(onboarding): address X1 acceptance findings"
```

If no fixes are needed, do not create an empty commit.

---

## Completion Gate

X1 v1 is complete when:

```text
IT/Admin runs setup once
-> employee opens Twingate
-> employee signs in with the identity authorized by the Twingate administrator
-> employee opens the AEGIS shortcut
-> https://aegis.internal/
-> no manual Root CA import
-> no raw-IP URL
-> no certificate-warning bypass
-> no post-setup PowerShell work for the employee
```

After X1 is accepted, return to the existing production-readiness sequence: D4 Monitor SOC credential work, D3/D5 provisioning, D7 regression, E1-E9 functional/authorization/E2E validation, then F1-F8 final evidence/documentation/integration. X1 must not be used as a reason to recreate Monitor or otherwise broaden production-write scope.