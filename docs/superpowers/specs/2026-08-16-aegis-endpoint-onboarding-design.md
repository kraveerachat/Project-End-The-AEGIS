# AEGIS Endpoint Onboarding Automation — Design

## Status
Approved concept; implementation pending user review of this written spec.

## Objective
Create a Windows onboarding package that prepares an employee PC for AEGIS access so the employee only needs to authenticate to Twingate and then open `https://aegis.internal/`.

The onboarding flow must eliminate these manual end-user steps:
- importing the AEGIS Root CA by hand;
- remembering or using `192.168.10.10` as the primary URL;
- clicking through browser certificate warnings;
- manually configuring the Twingate network;
- running ad-hoc PowerShell commands after setup.

## Scope
### In scope
- Windows client only for v1.
- One administrator-run setup script: `AEGIS-Client-Setup.ps1`.
- Verification that the script is running elevated.
- Verification of the bundled AEGIS Root CA by fixed SHA-256 before import.
- Import of the public AEGIS Root CA into `Cert:\LocalMachine\Root` only when absent.
- Detection of an existing Twingate client.
- Controlled installation of Twingate when absent, using an official installer and supported silent-install arguments.
- Preconfiguration of the AEGIS Twingate network when supported by the installer contract.
- Creation of an AEGIS shortcut to `https://aegis.internal/`.
- Connectivity and HTTPS verification after Twingate authentication.
- Clear PASS/PENDING/FAIL output.
- Idempotent re-runs: existing correct state is verified and skipped rather than replaced.

### Out of scope for v1
- Automating the employee's Twingate identity login.
- Storing or embedding Gmail credentials, Twingate tokens, AEGIS passwords, API keys, private keys, or production `.env` values.
- Mobile onboarding.
- Intune/MDM deployment implementation.
- Full CRL/OCSP infrastructure.
- Any change to Beelink containers, PostgreSQL, volumes, application code, NGINX, or production networking.

## Package Layout
```text
AEGIS-Client-Onboarding/
├── AEGIS-Client-Setup.ps1
├── certificates/
│   └── aegis-root-ca.crt
└── README.md
```

The package MUST NOT contain:
- `aegis-root-ca.key`;
- `aegis.internal.key`;
- passwords or hashes;
- Twingate service keys/tokens;
- production `.env` files.

## Trust Anchor
The setup script must fail closed unless the bundled Root CA matches the approved SHA-256:

```text
8D03EC3090DE7D3DC38DCE86234219F3675ED0124D44B32D721B6A4EABA10CA7
```

The trusted certificate subject is expected to contain:

```text
CN=AEGIS Internal Root CA, O=AEGIS, C=TH
```

The certificate is public material; the CA private key remains only on the Beelink.

## Runtime Flow
1. Detect Windows and supported PowerShell environment.
2. Confirm Administrator elevation; fail with an actionable message when not elevated.
3. Locate the bundled `certificates/aegis-root-ca.crt` relative to the script path.
4. Compute SHA-256 and compare it to the approved value.
5. Parse the certificate and confirm it is the expected AEGIS Root CA.
6. Check `Cert:\LocalMachine\Root` for the expected certificate/thumbprint.
7. Import the certificate only when absent; otherwise report `ALREADY_INSTALLED`.
8. Detect whether Twingate is installed.
9. If Twingate already exists, do not uninstall or replace it automatically.
10. If absent, perform a controlled installation using the official Windows installer and documented silent-install/preconfiguration switches.
11. Create or verify an AEGIS shortcut targeting `https://aegis.internal/`.
12. Check whether `aegis.internal` is reachable. If Twingate authentication is still required, return `PENDING` instead of treating that state as setup failure.
13. When connectivity is available, verify HTTPS trust and the AEGIS endpoints.
14. Print a final summary with PASS/PENDING/FAIL for each component.

## Idempotency
Re-running the script must be safe.

Examples:
```text
AEGIS Root CA = ALREADY_INSTALLED -> SKIP
Twingate      = ALREADY_INSTALLED -> SKIP
Shortcut      = EXISTS            -> VERIFY
```

The script must not replace a pre-existing Twingate installation merely because it did not install it itself.

## User Experience
After IT/Admin runs the setup once, the employee workflow is:

```text
Open Twingate
-> sign in with the identity authorized by the administrator
-> open the AEGIS shortcut
-> https://aegis.internal/
-> sign in to AEGIS according to the employee's application role
```

The employee must not need to perform certificate-management steps or bypass browser security warnings.

## Authorization Boundary
Endpoint onboarding grants no AEGIS application role by itself.

Access remains layered:
1. Twingate identity/group grants network access to the AEGIS web resource.
2. AEGIS application RBAC grants Drive/Monitor capabilities.

## Error Handling
The script must stop before certificate import when any of these occur:
- Root CA file missing;
- Root CA SHA-256 drift;
- unexpected certificate identity;
- insufficient Administrator privileges.

Twingate login not yet completed is `PENDING`, not a destructive failure.

The script must never print secrets because no secrets are accepted or bundled.

## Verification Targets
After authentication to Twingate, the validation target is:

```text
https://aegis.internal/
https://aegis.internal/drive/healthz
https://aegis.internal/monitor/healthz
```

Expected web results are HTTP 200 for the three HTTPS requests. Windows Schannel may require best-effort revocation handling while the current private PKI has no CRL/OCSP infrastructure; this limitation must be reported distinctly rather than bypassing all TLS verification with `-k`.

## Rollback and Ownership
The first implementation should record enough local state to distinguish AEGIS-created artifacts from pre-existing ones, especially:
- AEGIS Root CA thumbprint;
- AEGIS shortcut;
- whether Twingate was already installed before onboarding.

A future uninstall script may remove the AEGIS certificate and shortcut by exact identity, but must not uninstall a pre-existing Twingate client.

## Security Guardrails
- Never distribute the Root CA private key.
- Never embed Twingate credentials or service keys.
- Never embed AEGIS credentials.
- Never disable TLS validation globally.
- Never modify production server state from the endpoint installer.
- Never use the endpoint installer to recreate or restart AEGIS production containers.

## Definition of Done
X1 v1 is complete when a Windows test client can be prepared by running one administrator setup script and then, after the employee signs into Twingate, can open `https://aegis.internal/` without manually importing certificates, using a raw IP URL, or bypassing a certificate warning.

The script must also pass a second run without duplicating or corrupting correctly installed state.

## Future Enterprise Path
The v1 package is intentionally compatible with later replacement by centralized device management. In an enterprise deployment, the same outcomes should move to Intune/MDM:
- deploy Twingate client;
- preconfigure the Twingate network;
- deploy `aegis-root-ca.crt` as a trusted root certificate;
- deploy AEGIS shortcuts/configuration.

The employee-facing workflow must remain the same.
