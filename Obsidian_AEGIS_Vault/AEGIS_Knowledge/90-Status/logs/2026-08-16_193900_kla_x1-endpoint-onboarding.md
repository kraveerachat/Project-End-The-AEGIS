---
title: Task Receipt — X1 Endpoint Onboarding
date: 2026-08-16T19:39:00+07:00
owner: kla
area: infrastructure
branch: feat/x1-endpoint-onboarding
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — X1 Endpoint Onboarding

## What changed

- Added a Windows PowerShell 5.1 endpoint-onboarding package for AEGIS employees and administrators.
- The package validates and trusts only the approved public AEGIS Root CA certificate, detects a pre-existing Twingate client, supports the official managed-device Twingate install contract when installation is required, creates a Start Menu shortcut to `https://aegis.internal/`, verifies HTTPS without `-k`/`--insecure`, and writes only non-secret endpoint state.
- Completed Windows acceptance on the current validation client without uninstalling or recreating its working Twingate installation or private-CA trust.
- Recorded the accepted endpoint workflow and the current Schannel revocation limitation in the canonical Twingate/remote-access note.
- No password, private key, token, service key, production `.env`, credential verifier, database dump, recording or generated clip was added.

## Source files changed

- `.gitattributes` — pins the bundled public `.crt` artifact to LF so its approved SHA-256 remains stable on Windows checkouts.
- `docs/superpowers/plans/2026-08-16-aegis-endpoint-onboarding.md` — implementation plan for X1.
- `docs/superpowers/specs/2026-08-16-aegis-endpoint-onboarding-design.md` — reviewed design and acceptance contract.
- `scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1` — PowerShell 5.1 onboarding implementation, VerifyOnly mode, idempotency, Twingate detection/install contract, Root CA validation, shortcut/state handling and HTTPS probe.
- `scripts/endpoint-onboarding/README.md` — IT/operator usage and verification instructions.
- `scripts/endpoint-onboarding/certificates/aegis-root-ca.crt` — approved **public** AEGIS Root CA certificate only.
- `scripts/endpoint-onboarding/endpoint-onboarding.json` — non-secret onboarding configuration and approved trust-anchor metadata.
- `tests/endpointOnboarding.test.mjs` — regression coverage for package contract, public certificate hash, secret exclusion, PowerShell null/empty-output handling, Twingate registry detection, write protection and documentation.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/remote-access/Twingate-Setup.md` — canonical Windows endpoint-onboarding, friendly URL, private-CA and revocation-limitation state.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-16_193900_kla_x1-endpoint-onboarding.md` — this immutable task receipt.

## Verification evidence

- `node --test tests/endpointOnboarding.test.mjs` — pass: 11 tests, 0 failures on the Windows validation worktree at accepted implementation commit `1aec455`.
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\endpoint-onboarding\AEGIS-Client-Setup.ps1 -VerifyOnly` — pass: Windows/Admin PASS, Root CA and Twingate `ALREADY_INSTALLED`, final shortcut `ALREADY_EXISTS`, HTTPS `PASS_WITH_REVOCATION_LIMITATION`, and no `Failure` field.
- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\endpoint-onboarding\AEGIS-Client-Setup.ps1` — pass: first normal setup created the shortcut; a second run returned `AEGIS Shortcut ALREADY_EXISTS`, proving the exercised path is idempotent.
- `[System.Management.Automation.Language.Parser]::ParseFile(...)` — pass: `PARSER=PASS` for `AEGIS-Client-Setup.ps1`.
- Read-only shortcut/state acceptance commands — pass: `SHORTCUT_EXISTS=True`, `STATE_EXISTS=True`, `SHORTCUT_TARGET_OK=True`, `SHORTCUT_URL_OK=True`, `STATE_VERSION_OK=True`, `STATE_URL_OK=True`, and `STATE_TWINGATE_PREEXISTING=True`.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/remote-access/Twingate-Setup.md` — records AEGIS Web/friendly alias, Windows LocalMachine Root trust, accepted X1 onboarding behavior, endpoint artifacts, clean-install boundary and the no-CRL/OCSP Schannel limitation.

## Shared surfaces touched

- `.gitattributes` — repository-wide checkout behavior for certificate line endings; integration review must confirm no unintended effect on other tracked files.
- `docs/superpowers/plans/2026-08-16-aegis-endpoint-onboarding.md` — shared project implementation-plan surface for the infrastructure task.
- `docs/superpowers/specs/2026-08-16-aegis-endpoint-onboarding-design.md` — shared project design/specification surface for the infrastructure task.
- `scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1` — new repository-level endpoint administration tooling consumed outside a single application module.
- `scripts/endpoint-onboarding/README.md` — shared IT/operator documentation for endpoint onboarding.
- `scripts/endpoint-onboarding/certificates/aegis-root-ca.crt` — public trust anchor distributed to Windows endpoints; security/integration review required.
- `scripts/endpoint-onboarding/endpoint-onboarding.json` — shared onboarding contract and trust-anchor metadata.
- `tests/endpointOnboarding.test.mjs` — repository-level regression coverage for the shared endpoint tooling.

## Integration requests

- Kla/integration review must confirm the endpoint-onboarding package and `.gitattributes` change are acceptable shared repository surfaces and that only the public Root CA certificate is distributed.
- Pub/code-owner review should confirm the shared tooling does not alter IDEA2 application code or its RBAC/runtime contracts.
- A future disposable Windows VM/test PC should exercise the true first-install Twingate path; do **not** uninstall the currently working Twingate client merely to create that evidence.
- If enterprise-grade strict revocation checking is required, plan CRL/CRL Distribution Points and/or OCSP plus server-certificate re-issuance as a separate PKI hardening task rather than weakening TLS verification.

## Known limitations

- The current private PKI does not publish CRL/OCSP revocation data. Windows Schannel strict curl can report `CRYPT_E_NO_REVOCATION_CHECK`; the accepted verifier retries only that documented condition with `--ssl-revoke-best-effort` and never uses insecure certificate bypass.
- The current client already had Twingate installed, so the real Twingate installer branch was not destructively exercised; its contract is source/test covered but awaits a disposable clean Windows environment for runtime proof.
- Enterprise MDM/Intune deployment of the public Root CA and Twingate client remains future work; X1 provides the endpoint script/package, not centralized device management.
- Production Beelink containers, PostgreSQL, volumes, Monitor runtime, network rules and private PKI keys were not modified by the endpoint onboarding acceptance sequence.
