---
title: Open Items Backlog (Infrastructure)
tags: [aegis, infrastructure, status, backlog, todo, priority]
type: status
status: 🔧 living-document
created: 2026-08-06
updated: 2026-08-22
owner: kla
edit_policy: owner-writable
---

# 📌 Open Items Backlog — Infrastructure

> รายการ DONE ด้านล่างถูกเก็บเพื่อป้องกันการเปิดงานเดิมซ้ำ
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

## ✅ CLOSED / PASS — Server infrastructure readiness

| Item | Current state | Canonical evidence |
| :--- | :--- | :--- |
| Ubuntu/hostname/static IP baseline | ✅ CLOSED | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| SSH key baseline, password disabled, root disabled, `ssh.socket` reboot activation | ✅ CLOSED | [[infrastructure/server/SSH-Hardening-Status]] |
| VLAN 30 direct on-site validation | ✅ CLOSED — `.30.99` to gateway and Beelink, `4/4`, `0%` loss | [[infrastructure/network/VLAN-IP-Plan]] |
| Backup checkpoint, SHA256, true restore, Windows off-host copy | ✅ CLOSED | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| Drive/Monitor/HUB-NGINX/PostgreSQL restart persistence | ✅ CLOSED | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| Controlled host reboot and kernel transition | ✅ CLOSED — `7.0.0-27` → `7.0.0-29` | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| Twingate/Docker/account recovery after reboot | ✅ CLOSED | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| UFW production rules | ✅ CLOSED — active; defaults and both SSH source rules verified | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| Docker/Twingate restart policies | ✅ CLOSED — five containers use `unless-stopped`; Twingate `AutoRemove=false` | [[infrastructure/deployment/Docker-Stack-Plan]] |
| Server-side post-reboot health | ✅ CLOSED — entry/Drive/Monitor HTTP 200 with application health | [[infrastructure/server/Beelink-Ubuntu-Host]] |

## 🟠 OPEN — Production security defect patched, acceptance not complete

**File object-level authorization (IDOR) — IDEA1 Drive.** Confirmed during FT-1 role RBAC testing (2026-08-21): role RBAC itself works, but `GET /api/files`, `POST /api/files/:id/verify`, `GET /api/files/:id/download`, and `POST /api/shares` did not check per-file ownership, letting any authenticated user list/verify/download another user's files or mint a public share link for another user's file by supplying its id. `DELETE /api/files/:id` and the file-version routes were already owner-only and are unaffected.

| Field | State |
| :--- | :--- |
| Fix status | **PATCH DEPLOYED TO PRODUCTION / ACCEPTANCE STILL PENDING — NOT RESOLVED** |
| Production status | Beelink `aegis-system` Drive now runs the patched build; the previously recorded "still runs the pre-fix build" state is **superseded** |
| Acceptance observed | ✅ Cross-owner **listing** isolation PASS in FT-1D, both directions (Admin ↔ DataLake-User) |
| Acceptance outstanding | ⏳ Cross-owner **verify** (`POST /api/files/:id/verify`) and **share creation** (`POST /api/shares`) not yet accepted against production |
| Code | `IDEA1-AEGIS_Drive_LC/server/db/store.js`, `server/routes/api.js` |
| Tests | New `tests/fileObjectAuthorization.test.js` (8 tests); full IDEA1 suite 175/175 non-skipped pass, 0 fail, in-memory mode; Postgres-mode branch not run in this environment |
| Evidence | `90-Status/logs/2026-08-21_231500_kla_idea1-file-object-authorization-fix.md`; narrative in [[idea1/idea1-status#🛡️ FT-1 security finding — File object-level authorization (2026-08-21)]] |
| Deliberately not touched | `GET /api/shares` (list) and `DELETE /api/shares/:id` (revoke) remain unscoped — pinned as intentional current behavior by an existing test; a decision to gate those must be separate and explicit |
| Next step | Execute and record the outstanding cross-owner verify/share acceptance against production, alongside FT-0 baseline and FT-1 role RBAC, before marking this resolved |

Do not mark this item resolved until the outstanding cross-owner verify and share acceptance above is actually executed and recorded.

## 🔴 P1 — Security housekeeping still requiring direct evidence

| Item | Why still open |
| :--- | :--- |
| Record Twingate token lifecycle metadata only if the console exposes it | Current token pair is SET and functional; creation/rotation timestamp = NOT EXPOSED / NOT VERIFIED; no rotation required now |
| Review Twingate Admin group membership | ต้องยืนยัน least privilege ด้วย current console evidence |
| Final Linux account least-privilege audit | `pubpup2006p`/`krayukantk` key-only SSH และ functional sudo PASS; ยังต้องเก็บ policy enumeration, ตรวจ `docker` membership และทบทวนความจำเป็นรายบุคคล |
| Verify OpenVPN service remains disabled | deprecated design ต้องไม่เหลือ unnecessary service |

## ✅ P2 — Formal Current Production Audit completed

**Phase B audit execution = COMPLETED**

**Checkpoint 1 + Documentation Checkpoint 2 = COMPLETED**

| Step | Current state / follow-up |
| :--- | :--- |
| 1–5 Git, Compose, image, network, persistence | ✅ COMPLETED — ดู [[infrastructure/deployment/Docker-Stack-Plan]] |
| 6 PostgreSQL Audit | ✅ PASS — DB/roles/privileges/CONNECT isolation/schema/default ACL/credential state verified |
| 7 Application Account / RBAC Audit | ✅ PASS — current accounts match; missing test identities/cameras are readiness gaps |
| 8 Runtime Files Outside Repository | ✅ BASELINED — hashes/metadata recorded without secret values |
| 9 SSH + Twingate side checks | ✅ PASS — per-account SSH/sudo and Admin Console/runtime identity verified |
| Monitor image rollback gap | 🔴 running + healthy แต่ running image ไม่ตรง local `latest`; **DO NOT RECREATE** ก่อน Phase D rollback plan |
| Anonymous Docker volume | ⚠️ owner/purpose unknown; **DO NOT DELETE**; investigate read-only |
| `aegis_internal Internal=false` | ⚠️ security/design observation; review dependency/outbound/blast radius ภายหลัง |

Final source-of-truth matrix, service contract, dependency/blast-radius map,
data-preservation map และ runtime integrity baseline ถูกบันทึกแล้ว.

### Phase C gate — NOT STARTED

- รอ human approval ของ Phase B final documentation
- ทำ Source Freeze / Source-Runtime Alignment เป็นงานแยก
- วาง Monitor rollback plan ก่อน recreate
- อนุมัติการ provision Drive `DataLake-User`, Monitor `CCTV-Operator` และ camera fixtures
- รักษา first-login reset ของ Drive `admin` และ Monitor `soc`
- ทดสอบ self-signed/internal TLS ใน Web Functional Testing โดยไม่ seed production แบบไม่ควบคุม

ข้อห้ามยังคงเดิม: ห้ามทำลาย state, ลบ volumes/databases, redeploy จากศูนย์
หรือเริ่ม Web Functional Testing ก่อน human final review

รายละเอียด safety boundary: [[infrastructure/deployment/Docker-Stack-Plan]]

## 🟡 P3 — Project follow-up

- ยืนยัน IP และ integration ของ Detection Laptop บน VLAN 20
- ⚠️ **OPEN / FUTURE HARDENING — Private PKI CRL/OCSP:** trusted Root CA และ `aegis.internal` hostname validation ผ่านแล้ว แต่ PKI ยังไม่มี revocation publication; X1 จึงรายงาน `PASS_WITH_REVOCATION_LIMITATION` โดยไม่ใช้ `-k`/`--insecure`
- ⚠️ **OPEN / TEST ON DISPOSABLE VM — Clean Windows Twingate first-install:** accepted client มี Twingate อยู่ก่อนแล้ว; ห้ามถอน client ที่ใช้งานจริงเพื่อทดสอบ ให้ใช้ Windows VM/test PC แยก
- ⏳ **FUTURE — Enterprise endpoint deployment:** X1 เป็น endpoint onboarding package; Intune/MDM centralized certificate, Twingate client และ shortcut rollout ยังไม่ได้ทำ
- ทำ monitoring/alerting และ incident runbook โดยไม่แก้สถานะ infrastructure pass ย้อนหลัง
- reconcile รายงาน/diagram เก่าที่อ้างว่า Beelink ว่างหรือ stack ยังไม่อยู่บน host

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[infrastructure/remote-access/Twingate-Setup]]
* [[summaries/08_Outstanding_Items_Consolidated]]
