---
title: Twingate ZTNA Setup and Endpoint Onboarding
tags: [aegis, infrastructure, remote-access, twingate, ztna, zero-trust, security, endpoint-onboarding]
type: infrastructure
status: ✅ remote SSH, AEGIS Web, private CA and Windows onboarding verified
created: 2026-08-06
updated: 2026-08-16
owner: kla
edit_policy: owner-writable
---

# ☁️ Twingate ZTNA — Production Remote Access and Endpoint Onboarding

> ช่องทาง Remote Access ที่ใช้งานจริง; OpenVPN ถูกยกเลิก → [[infrastructure/remote-access/OpenVPN-Deprecated]]
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

## ✅ DONE / VERIFIED

| รายการ | Current state |
| :--- | :--- |
| Remote Network | `Homelab Network` ตาม Admin Console; historical vault label `aegissut` ต้อง reconcile โดยไม่เปลี่ยน Connector |
| Connector | `aegis-connector-02` ตรงกับ Docker `twingate-aegis-connector-02` |
| SSH Resource | `AEGIS-Beelink-SSH` → `192.168.10.10:22/TCP` |
| Web Resource | `AEGIS-Beelink-Web` → `192.168.10.10` จำกัด TCP `80/443` |
| Friendly alias | `aegis.internal` ใช้เป็น URL ภายในผ่าน Twingate; ไม่ใช้ raw IP เป็น employee workflow |
| AEGIS Web | HTTP alias redirect และ HTTPS HUB/Drive/Monitor health path ใช้งานได้ผ่าน Twingate |
| Private CA | Windows `LocalMachine\Root` trust anchor ใช้งานได้; client รับเฉพาะ public Root CA certificate และไม่รับ private key |
| Endpoint onboarding | `scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1` ผ่าน Windows acceptance: VerifyOnly, normal setup, idempotent rerun, parser gate และ final state/shortcut checks |
| Employee entry | Sign in to Twingate → open `https://aegis.internal/` → authenticate to the AEGIS application/RBAC layer |
| Access model | outbound-only Connector; ไม่ต้องเปิด inbound port ผ่าน Double NAT |
| Remote SSH | เคยทดสอบจากเครือข่ายภายนอกผ่าน Mobile Hotspot สำเร็จ |
| Host reboot recovery | Connector กลับมาและ Remote SSH ใช้งานได้หลัง controlled reboot |
| UFW path | ✅ allow `TCP/22` on `docker0` from `172.17.0.0/16` |
| Restart policy | ✅ `twingate-aegis-connector-02 = unless-stopped`; `AutoRemove=false` |
| Runtime identity | container ID prefix / Console hostname `5db5be7e1d28`; private IP `172.17.0.2` |
| Admin Console | ✅ Connected; Controller Connected; Relay Connected; STUN Available; Time Offset `0s` |
| Version | ✅ `1.90.0` · Up to date |
| Functional SSH path | ✅ Remote client → Connector → Beelink SSH → correct Linux identity → sudo |

Resource-level paths ชี้ตรงไปยัง Beelink VLAN 10 และไม่ให้สิทธิ์ทั้ง VLAN 30
ส่วน VLAN 30 เป็น direct on-site management path แยกต่างหากตาม
[[infrastructure/network/VLAN-IP-Plan]]

## ✅ VERIFIED — X1 AEGIS Endpoint Onboarding Automation

**Final status:** `COMPLETE / MERGED / WINDOWS ACCEPTANCE PASS` through PR #17,
merge commit `4796c69017ef91de58188f17c4b27eccacf24c32`.

### Before X1 — secure access worked, but endpoint preparation was manual

The production Twingate Connector and Remote SSH path were already healthy.
The `AEGIS-Beelink-Web` Resource later exposed only TCP `80/443`, the friendly
alias `aegis.internal` routed users to AEGIS Web, and the server certificate was
signed by the AEGIS Internal Root CA. Browser access worked after an administrator
manually transferred and imported the **public** Root CA certificate into Windows
`LocalMachine\Root`.

That architecture was secure but not repeatable for employee onboarding:

```text
Twingate Connector
→ Web Resource
→ aegis.internal
→ private-CA server certificate
→ manual public Root CA transfer/import
→ manual endpoint preparation
```

Every new Windows endpoint still depended on manual certificate import, manual
Twingate verification/installation and knowledge of the friendly URL. X1 replaced
that operator-dependent sequence with one controlled, auditable IT package.

### X1 execution contract

The single entry point is
`scripts/endpoint-onboarding/AEGIS-Client-Setup.ps1`. X1 v1 supports Windows,
is compatible with Windows PowerShell 5.1 and requires Administrator privileges
because it can change the machine trust store. It accepts `-TwingateNetwork` for
the organization network name and `-VerifyOnly` for a read-only assessment.

`-VerifyOnly` verifies Windows/Admin state, the Root CA artifact/trust state,
Twingate installation, shortcut drift and HTTPS reachability. It does **not**
import a certificate, install Twingate, create a shortcut or write onboarding state.

```text
AEGIS-Client-Setup.ps1
├─ verify Windows and Administrator context
├─ validate the public Root CA artifact
├─ verify or install machine trust
├─ detect or install Twingate
├─ create the AEGIS shortcut
├─ verify HTTPS
└─ record non-secret endpoint state
```

### Root CA trust handling

- The endpoint package contains only the approved **public** Root CA certificate.
- Before import, X1 verifies its file SHA-256, certificate thumbprint, expected
  Subject and self-issued `Subject == Issuer` property.
- Trust is checked in `Cert:\LocalMachine\Root`; one exact match returns
  `ALREADY_INSTALLED`.
- Missing trust returns `PENDING` in `-VerifyOnly` or is imported and verified in
  normal mode.
- Hash, identity or duplicate-trust-anchor drift fails closed before a trust-store
  write.
- The Root CA private key and `aegis.internal` server private key are never placed
  in the endpoint package or distributed to Windows clients.

### Twingate handling

- X1 searches both 64-bit and 32-bit Windows uninstall registry paths.
- Registry records without `DisplayName` are handled safely by checking property
  existence before evaluating the value.
- A working installation returns `ALREADY_INSTALLED`; X1 does not reinstall,
  replace or reconfigure it.
- If absent, the script downloads the official installer specified by the
  non-secret configuration, validates its Authenticode signature, performs a
  silent managed-device install with auto-update enabled and verifies installation
  state afterwards.
- Temporary installer files are removed in the cleanup path.

The accepted Windows client already had Twingate installed. Existing-install
detection is runtime verified; the true first-install path is implemented and
source-tested but remains **NOT RUNTIME-PROVEN** until tested on a disposable
Windows VM/test PC. The working client must not be uninstalled merely to create
that evidence.

### Shortcut and non-secret state

X1 creates one idempotent Start Menu shortcut:

- `%ProgramData%\Microsoft\Windows\Start Menu\Programs\AEGIS.lnk`
- target: Windows Explorer
- URL: `https://aegis.internal/`

It writes non-secret ownership/verification metadata to
`%ProgramData%\AEGIS\endpoint-onboarding-state.json`, including the package
version, public Root CA thumbprint reference, shortcut path, primary URL and
whether Twingate existed before X1. The state file does not store credentials,
tokens or private keys.

### HTTPS verification and revocation boundary

X1 first performs normal trusted TLS verification and never uses `-k`,
`--insecure` or a global TLS bypass. Windows Schannel can return
`CRYPT_E_NO_REVOCATION_CHECK` (`0x80092012`) because the current private PKI does
not publish CRL/OCSP information. For that specific condition only, X1 retries
with `curl.exe --ssl-revoke-best-effort` and reports
`PASS_WITH_REVOCATION_LIMITATION` when the application responds successfully.

This accepted status means certificate trust and hostname validation work. It is
not `UNTRUSTED_ROOT`, not a hostname mismatch and not disabled TLS verification.
CRL/CRL Distribution Points and/or OCSP remain future PKI hardening work.

### Windows acceptance evidence

`node --test tests/endpointOnboarding.test.mjs`:

```text
tests 11
pass  11
fail  0
```

| Checkpoint | Windows | Administrator | Root CA | Twingate | Shortcut | HTTPS |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Pre-write `-VerifyOnly` | PASS | PASS | ALREADY_INSTALLED | ALREADY_INSTALLED | PENDING | PASS_WITH_REVOCATION_LIMITATION |
| Normal setup #1 | PASS | PASS | ALREADY_INSTALLED | ALREADY_INSTALLED | PASS | PASS_WITH_REVOCATION_LIMITATION |
| Normal setup #2 | PASS | PASS | ALREADY_INSTALLED | ALREADY_INSTALLED | ALREADY_EXISTS | PASS_WITH_REVOCATION_LIMITATION |
| Final `-VerifyOnly` | PASS | PASS | ALREADY_INSTALLED | ALREADY_INSTALLED | ALREADY_EXISTS | PASS_WITH_REVOCATION_LIMITATION |

- PowerShell parser: `PARSER=PASS`.
- Final artifact validation: `SHORTCUT_EXISTS=True`, `STATE_EXISTS=True`,
  `SHORTCUT_TARGET_OK=True`, `SHORTCUT_URL_OK=True`, `STATE_VERSION_OK=True`,
  `STATE_URL_OK=True`, `STATE_TWINGATE_PREEXISTING=True`.

### Engineering regression fixes

These were Windows onboarding compatibility defects, not production-server
incidents:

1. Root CA PEM CRLF/LF checkout drift changed the byte hash on Windows;
   `.gitattributes` now pins tracked certificate files to LF.
2. Some uninstall-registry records had no `DisplayName`; detection now checks
   property existence before reading it.
3. Empty curl stdout/stderr files could make `Get-Content -Raw` return `$null`;
   a null-safe file-content helper now applies explicit fallbacks.
4. Windows PowerShell 5.1 rejected the empty-string fallback for a mandatory
   string parameter; the fallback now permits `[AllowEmptyString()]`.

### After X1 — employee and administrator flow

```text
IT-approved X1 endpoint onboarding
→ Windows trusts the approved AEGIS Internal Root CA
→ Twingate client is available
→ employee signs in to Twingate
→ Twingate Group/Resource authorization
→ open the AEGIS shortcut
→ https://aegis.internal/
→ AEGIS application login and RBAC
→ HUB → Drive / Monitor
```

Twingate authentication and Resource authorization are the network-access layer.
AEGIS application authentication and RBAC are a separate security layer.
**Twingate access does not replace Drive or Monitor application login/RBAC.**

### X1 blast-radius boundary

X1 acceptance did not modify production PostgreSQL data, Drive users/RBAC,
Monitor users/RBAC, camera data, the Monitor runtime/image, production Docker
containers, persistent volumes, production `.env`, MikroTik configuration,
TP-Link VLAN configuration or the Twingate Connector runtime. It did not
distribute the Root CA private key or `aegis.internal` private key. Only the
approved public Root CA certificate belongs in the endpoint package.

### Remaining endpoint hardening

| Item | Current status | Next evidence |
| :--- | :--- | :--- |
| Private PKI CRL/OCSP | ⚠️ OPEN | Publish revocation infrastructure and reissue certificates if required |
| Clean Twingate first-install | ⚠️ NOT RUNTIME-PROVEN | Test on a disposable Windows VM/test PC |
| Enterprise endpoint management | ⏳ FUTURE | Design Intune/MDM certificate, client and shortcut rollout |

X1 is an endpoint onboarding package; it is not yet an Intune deployment, MDM
policy or centralized certificate/client rollout.

## ⚠️ Token and secret handling

- Connector token/service key ต้องอยู่นอก repository และ Obsidian
- Access/Refresh tokens are SET in the running container; values are not displayed or recorded.
- Token creation/rotation timestamp is **NOT EXPOSED / NOT VERIFIED** from the collected evidence.
- Current Connector is healthy, connected and up to date; no token rotation or re-provision is required.
- ไม่มีการบันทึก token/service key จริงใน vault หรือ repository
- หากต้อง audit ซ้ำ ให้ยืนยัน Connector Healthy และ Remote SSH โดยไม่แสดงค่า token
- Root CA private key and `aegis.internal` server private key remain server-side only; endpoint onboarding contains only the public Root CA certificate.

## ✅ VERIFIED — Reboot behavior and runtime policy

ผลหลัง reboot ยืนยันว่า Connector กลับมาและ remote path ใช้งานได้จริง
โดย container `twingate-aegis-connector-02` ใช้ restart policy
`unless-stopped` และ `AutoRemove=false`

Phase B Admin Console evidence matches Docker runtime by both hostname/container-ID
prefix and private IP. Public IP was intentionally omitted for privacy minimization.

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[infrastructure/server/SSH-Hardening-Status]]
* [[infrastructure/network/VLAN-IP-Plan]]
* [[infrastructure/remote-access/OpenVPN-Deprecated]]
* [[90-Status/Open-Items-Backlog]]
