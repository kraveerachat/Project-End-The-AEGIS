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

## ✅ VERIFIED — AEGIS Web and Windows endpoint onboarding

X1 endpoint onboarding automation is accepted on the current Windows validation client at commit lineage ending in the accepted implementation branch. The validation intentionally preserved the pre-existing Twingate installation and existing Root CA trust instead of uninstalling or re-provisioning working access.

Verified endpoint behavior:

- `node --test tests/endpointOnboarding.test.mjs` completed **11/11 pass** after the PowerShell 5.1 null/empty-output regressions were fixed.
- PowerShell parser validation returned `PARSER=PASS`.
- Pre-write `-VerifyOnly` reported Windows/Admin PASS, Root CA and Twingate `ALREADY_INSTALLED`, shortcut `PENDING`, and HTTPS `PASS_WITH_REVOCATION_LIMITATION`.
- First normal setup created the AEGIS Start Menu shortcut and recorded non-secret onboarding state.
- Second normal setup returned shortcut `ALREADY_EXISTS`, proving the exercised path is idempotent.
- Final `-VerifyOnly` returned shortcut `ALREADY_EXISTS` with no `Failure` result.
- Read-only acceptance confirmed the shortcut exists, targets Windows Explorer, opens exactly `https://aegis.internal/`, and the state file exists with version `1`, the same primary URL, and `twingatePreExisting=true`.

Endpoint artifacts:

- Start Menu shortcut: `%ProgramData%\Microsoft\Windows\Start Menu\Programs\AEGIS.lnk`
- Non-secret state: `%ProgramData%\AEGIS\endpoint-onboarding-state.json`
- Repository package: `scripts/endpoint-onboarding/`
- Bundled trust artifact: public Root CA certificate only; private CA/server keys remain server-side and are never distributed.

### TLS revocation limitation

Windows Schannel's default strict revocation check can return `CRYPT_E_NO_REVOCATION_CHECK` because the current private PKI does not publish CRL/OCSP revocation information. The onboarding verifier retries only that documented case with `curl.exe --ssl-revoke-best-effort`; it never uses `-k`/`--insecure` and never disables certificate verification globally. HTTPS then returns the expected application response, so the accepted client result is `PASS_WITH_REVOCATION_LIMITATION` rather than an unqualified revocation-service PASS.

Future enterprise hardening can add CRL/CRL Distribution Points and/or OCSP plus certificate re-issuance. This is not required to preserve the currently verified trusted-browser workflow.

### Clean-install boundary

The official Twingate installer path is implemented with the managed-device EXE contract, silent install arguments, Authenticode verification and post-install registry verification, but it was **not** destructively exercised on the current working client because Twingate already existed. A true first-install test belongs on a disposable Windows VM/test PC; never uninstall the working production-access client only to create test evidence.

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
