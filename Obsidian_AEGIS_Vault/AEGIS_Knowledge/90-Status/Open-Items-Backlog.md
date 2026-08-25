---
title: Open Items Backlog (Infrastructure)
tags: [aegis, infrastructure, status, backlog, todo, priority]
type: status
status: 🔧 living-document
created: 2026-08-06
updated: 2026-08-25
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

## ✅ CLOSED / PASS — IDEA1 file object-level authorization production acceptance

**File object-level authorization (IDOR) — IDEA1 Drive.** Confirmed during FT-1 role RBAC testing (2026-08-21): role RBAC itself works, but `GET /api/files`, `POST /api/files/:id/verify`, `GET /api/files/:id/download`, and `POST /api/shares` did not check per-file ownership, letting any authenticated user list/verify/download another user's files or mint a public share link for another user's file by supplying its id. `DELETE /api/files/:id` and the file-version routes were already owner-only and are unaffected.

| Field | State |
| :--- | :--- |
| Fix status | **PATCH DEPLOYED / FT1D PRODUCTION ACCEPTANCE PASS / CLOSED** |
| Production status | Beelink `aegis-system` Drive now runs the patched build; the previously recorded "still runs the pre-fix build" state is **superseded** |
| Acceptance observed | ✅ Listing isolation PASS in both directions; DataLake → Admin download returned 404 without bytes, verify returned 404 without checksum fields, and share creation returned 400 without creating a row or usable share |
| Final production state | `FT1D.1=PASS`; `FT1D.2=PASS`; `FT1D.3=PASS`; `FT1D_CROSS_OWNER_AUTHORIZATION=PASS / CLOSED`; `PRODUCTION_FAILURE=NO` |
| Code | `IDEA1-AEGIS_Drive_LC/server/db/store.js`, `server/routes/api.js` |
| Tests | New `tests/fileObjectAuthorization.test.js` (8 tests); full IDEA1 suite 175/175 non-skipped pass, 0 fail, in-memory mode; Postgres-mode branch not run in this environment |
| Evidence | `90-Status/logs/2026-08-21_231500_kla_idea1-file-object-authorization-fix.md`; `90-Status/logs/2026-08-24_202849_kla_idea1-ft1d-authorization-closure.md`; narrative in [[idea1/idea1-status#🛡️ FT-1 security finding — File object-level authorization (2026-08-21)]] |
| Share list/revoke follow-up | The separate OWNER ONLY decision is now implemented locally in `78f631492ad65a903cfb88c21c4288739017d6ce`; see the still-open acceptance item below. This does not change FT1D's existing production closure. |
| Non-blocking audit improvement | Cross-owner `FILE_DOWNLOAD` and `FILE_VERIFY` emit `DENIED`; rejected `POST /api/shares` returns 400 before a `SHARE_CREATE / DENIED` event is written. Add privacy-safe denied auditing in a future scoped task without reopening FT1D. |

FT1D closure does not change B4 (`PASS / CLOSED`) or Public External Share
(`NOT IMPLEMENTED`). No Formal Report state is changed by this documentation task.

## 🟠 IDEA1 Share Ownership Authorization Hardening — test-harness integration pending

| Field | Current state |
| :--- | :--- |
| Share Ownership Authorization Hardening | **POSTGRESQL VERIFIED / FOLLOW-UP TEST-HARNESS INTEGRATION PENDING** |
| Approved policy | **OWNER ONLY** for Admin and DataLake-User |
| Share list authorization | Owner-scoped; active and non-expired shares only |
| Dashboard share data | Uses the same authenticated owner scope |
| Share revoke authorization | Atomic owner/state-scoped mutation; no Admin cross-owner override |
| Object hiding | Cross-owner, nonexistent, revoked, expired, and malformed/unusable targets return the same 404 contract |
| Audit | Owner success records `SHARE_REVOKE / OK`; authenticated failure records `SHARE_REVOKE / DENIED` |
| Implementation commit | `78f631492ad65a903cfb88c21c4288739017d6ce` |
| Source integration | **PASS / CLOSED** through PR #30 |
| PostgreSQL verification | **PASS** — share redemption 17/17; ownership 9/9; affected regression 57/57; full IDEA1 233/233 |
| Test-harness normalization | `6c16f137988e4c09f5eff31aa60f1d8779a1b86e` — `source_ip ?? sourceIp`; pending merge |
| Production state | **NOT DEPLOYED / PRODUCTION ACCEPTANCE NOT STARTED / READY_FOR_PRODUCTION=NO** |

This item is no longer an undecided design question, but it is **not closed**.
Completed evidence:

- OWNER ONLY policy implementation and PR #30 source integration.
- Isolated PostgreSQL execution covering owner-list behavior, atomic revoke,
  object hiding, Admin no-override, audit attribution, and the full PostgreSQL
  regression suite.
- PostgreSQL audit `source_ip=203.0.113.42` was persisted and observed correctly;
  the initial failure was a test field-shape mismatch, not a runtime defect.

Remaining blockers, in order:

1. Merge the test-only `source_ip` / `sourceIp` normalization.
2. Complete production deployment preparation.
3. Perform a Drive-only deployment through the approved production workflow.
4. Run controlled production owner/cross-owner list, Dashboard, revoke, audit,
   privacy, and object-hiding acceptance.
5. Verify post-deployment Drive health and preserve unrelated production state.
6. Record final production closure documentation.

Orphan shares with `created_by=NULL` remain a separate governance problem, and
Public External Share remains **NOT IMPLEMENTED**.

## ✅ IDEA1 production acceptance — Batch A and B4 Network Scope

| Item | Current state | Required follow-up before closure |
| :--- | :--- | :--- |
| Upload completion | ✅ **VERIFIED IN PRODUCTION / REGRESSION PASS** | A6 PASS; success popup exactly once = YES; active queue idle = YES; uploaded file remains visible. |
| Theme continuity | ✅ **VERIFIED IN PRODUCTION / RESOLVED** | PR #24 Batch A: A1 Dark PASS and A2 Light PASS. Preserve the former PR #22 failure as regression history only. |
| Password-protected share redemption | ✅ **VERIFIED IN PRODUCTION / RESOLVED** | A3 PASS with duplicated `/s/s/` = NO; A4 wrong-password denial PASS; A5 no-password Share PASS. |
| Share Copy | ✅ **VERIFIED IN PRODUCTION** | A7 Share Copy PASS. |
| Network-scoped share acceptance | ✅ **VERIFIED IN PRODUCTION / PASS / CLOSED** | B2 local hardening was the historical predecessor. B4.3 supersedes that open state: `172.18.0.6` allowed with HTTP 200; `172.18.0.7` denied with HTTP 403; spoofed forwarding headers could not replace canonical source attribution. Windows/Twingate requests are canonically observed as `172.19.255.1`, so endpoint-subnet attribution through Twingate is limited/not available, but the application CIDR engine passed. |
| Public external share | ⚪ **NOT IMPLEMENTED** | `aegis.internal` remains private/Twingate-only. If approved later, design a separate share-only public gateway limited to `GET/POST /s/:token`; do not expose the authenticated Drive application or claim this mode exists today. |

Canonical detail: [[idea1/idea1-status#Secure Share production findings (2026-08-23)]].

Batch A reconfirmed Upload (A6 PASS, popup once YES, queue idle YES). B4.3 closes
Network Scope at the application layer while preserving the documented Twingate
endpoint-IP limitation. Post-cleanup verification confirms Drive and Monitor HTTPS
health at HTTP 200, all four production containers healthy, no `b4-network-*`
containers remaining, `network_zones` at 0 rows, and temporary B4 test shares
revoked. The final filtered SQL check for active, non-expired
`AEGIS_BATCH_A_UPLOAD_REGRESSION.txt` shares returned 0 rows. Therefore
`B4_TEMP_SHARES=NONE`, `B4_TEMP_ZONES=NONE`, `B4_TEMP_CONTAINERS=NONE`, and
`B4_POST_CLEANUP=PASS / CLOSED`. Public Share remains unimplemented. The Formal
Report is outside this documentation task and remains unchanged.

## 🟠 IDEA1 acceptance evidence provenance reconciliation

This is a bounded documentation/provenance item, **not a production failure**.
Current canonical production closures remain Batch A, B4, and FT1D
**PASS / CLOSED**, including FT1D documentation integration.

- Recover or formally disposition the missing detailed evidence for E1, E2, FT0,
  and FT1A–C. E1, E2, and FT1A–C are currently `USER_SUPPLIED_ONLY`; FT0 is
  `RECOVERED_PARTIAL_EVIDENCE`.
- The referenced
  `2026-08-21_214500_kla_idea1-production-deployment-checkpoint.md` is
  `REFERENCED_ONLY`; the file itself was not recovered from reachable repository
  or PR history.
- Determine whether any actual IDEA1 functional gap remains before defining a new
  test matrix. **FT2_SCOPE = NOT CANONICALLY DEFINED**, **FT2_EXECUTION = NOT
  AUTHORIZED**, and **READY_TO_EXECUTE_FT2 = NO**.
- Phase C is `PARTIALLY_SUPERSEDED` for IDEA1 by later Batch A/B4/FT1D evidence.
  The infrastructure owner must reconcile older Phase C wording separately while
  preserving Monitor/SOC/CCTV/camera prerequisites as cross-system concerns. No
  Monitor recreation is authorized by this documentation item.

This item does not change the existing privacy-safe `SHARE_CREATE / DENIED` audit
follow-up, Public External Share `NOT IMPLEMENTED`, or the `MemoryStore`
session-durability limitation. The former share list/revoke ownership decision is
superseded by the locally implemented, acceptance-pending hardening item above.

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
