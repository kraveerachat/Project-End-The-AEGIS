# AEGIS Endpoint Onboarding (Windows v1)

This package is for IT/Admin preparation of Windows employee PCs. The employee should not need to import certificates, remember a private IP address, or run PowerShell after onboarding. After preparation, the employee opens Twingate, signs in with the identity authorized by the Twingate administrator, and opens **AEGIS** from the Start menu to reach `https://aegis.internal/`.

## Security boundaries

- Run the setup from an elevated **Administrator: Windows PowerShell**.
- The package contains only the public `certificates/aegis-root-ca.crt` trust anchor.
- It must never contain the AEGIS Root CA private key, server private key, passwords, Twingate tokens/service keys, API keys, or production `.env` files.
- Root CA import is fail-closed: SHA-256, thumbprint, and subject are validated before any certificate-store write.
- Existing Twingate installations are detected and left in place. X1 never uninstalls or replaces an existing installation automatically.
- The script never uses `-k`/`--insecure`. The current private PKI does not publish CRL/OCSP; only the specific Windows Schannel revocation-availability case may be retried with `--ssl-revoke-best-effort` and is reported as `PASS_WITH_REVOCATION_LIMITATION`.

## 1. Read-only verification

From the repository/worktree root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\endpoint-onboarding\AEGIS-Client-Setup.ps1 -VerifyOnly
```

`-VerifyOnly` does not import the Root CA, install Twingate, create a shortcut, or write onboarding state. Missing setup state is reported as `PENDING`/`DRIFT`.

## 2. Prepare a Windows employee PC

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\endpoint-onboarding\AEGIS-Client-Setup.ps1 -TwingateNetwork '<organization-subdomain>'
```

`<organization-subdomain>` is an IT deployment value such as the organization's Twingate network name; it is **not** an employee credential. The script accepts either the short network name or `<name>.twingate.com`.

If Twingate is absent, the script downloads the latest official Windows EXE from Twingate, verifies its Authenticode signature, and performs a silent installation with the documented managed-device parameters. If Twingate is already installed, it is reported as `ALREADY_INSTALLED` and is not reinstalled.

## Employee workflow after IT setup

1. Open Twingate.
2. Sign in using the identity authorized by the administrator.
3. Open **AEGIS** from the Windows Start menu.
4. Use `https://aegis.internal/` and sign in to the AEGIS application according to the employee's role.

A Twingate login dependency is reported as `PENDING_TWINGATE_LOGIN`, not as a destructive setup failure.

## Expected idempotent second run

```text
AEGIS Root CA   ALREADY_INSTALLED
Twingate        ALREADY_INSTALLED
AEGIS Shortcut  ALREADY_EXISTS
```

The setup records non-secret ownership metadata at `%ProgramData%\AEGIS\endpoint-onboarding-state.json` so a future uninstall workflow can distinguish AEGIS-created artifacts from a Twingate client that existed before onboarding.
