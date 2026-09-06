# Pull Request: IDEA1 Admin-only IDEA3 Security Status

เอกสารนี้เป็นข้อความพร้อมใช้สำหรับเปิด Pull Request จากงาน IDEA3 ไปยังเว็บ
AEGIS หลักของทีม โดยไม่บันทึกรหัสผ่าน โทเคน PIN คีย์ หรือค่า secret ใด ๆ

## สถานะปัจจุบัน

- Pull Request: `https://github.com/kraveerachat/Project-End-The-AEGIS/pull/60`
- ผู้ส่ง: `Kittipat050871`
- สถานะ: `OPEN` และ `MERGEABLE`; รอ reviewer (`REVIEW_REQUIRED`)
- Base: `main`
- Head: `codex/idea1-idea3-security-status`
- Head commit: `c58aa8d4d83b8251824db2dd4762e070299b7b30`
- Change set: 11 ไฟล์, เพิ่ม 627 บรรทัด, ลบ 3 บรรทัด
- `collaboration-guardrails`: `SUCCESS`
- ยังไม่ได้ merge หรือ deploy

## จุดหมายของ Pull Request

- Upstream repository: `kraveerachat/Project-End-The-AEGIS`
- Base branch: `main`
- Source branch: `codex/idea1-idea3-security-status`
- Local source commit: `c58aa8d4d83b8251824db2dd4762e070299b7b30`
- Task area: `idea1`
- Owner: `kla`
- Integration review: `yes` — งานนี้เพิ่มสัญญาอ่านสถานะระหว่าง IDEA1 และ IDEA3

## ชื่อ Pull Request ที่แนะนำ

```text
feat(idea1): add admin-only IDEA3 security status
```

## ข้อความ Pull Request พร้อมวาง

```markdown
<!-- collaboration-policy
area: idea1
owner: kla
integration-review: yes
-->

## Summary

- Add a theme-matched `Security` screen to the authenticated IDEA1 shell.
- Expose the menu and status API only to the existing server-enforced `Admin`
  role; ordinary users receive neither the Admin navigation item nor API access.
- Read IDEA3 Supervisor status from an operator-configured server-side file and
  return only a strict, non-secret allow-listed schema.
- Fail closed to unavailable/`UNKNOWN` when evidence is missing, stale,
  future-dated, malformed, oversized, or outside the supported contract.
- Keep the first integration read-only: no CUT, RESTORE, relay, MQTT, recovery,
  or automatic-containment control is exposed to the browser.

## Why

IDEA1 and IDEA2 already share the AEGIS web experience. This change gives an
authorised administrator a single read-only place to inspect IDEA3 runtime and
hardware-path status without moving security-critical command authority into
the browser. No board is connected yet, so the truthful current result is
`UNKNOWN`, not simulated healthy telemetry.

## Security boundary

- `GET /api/security/status` repeats server-side `requireRole(Admin)` checks;
  hiding the menu is not treated as authorization.
- Responses use `Cache-Control: no-store`.
- The status path comes only from server environment configuration and is never
  accepted from a browser request.
- The adapter checks and reads the same file handle, accepts only a regular,
  non-empty file up to 64 KiB, and validates a strict JSON object.
- Raw detail, component payloads, credentials, secrets, HMAC material, PINs,
  automatic-containment fields, and filesystem paths have no browser output path.
- Stale or future-dated evidence cannot appear healthy; operational fields
  become `UNKNOWN`.

## Verification

- `node --test --test-concurrency=1 tests/securityStatus.test.js` — **3/3 pass**.
- `npm test` — **785 discovered, 718 pass, 0 fail, 67 PostgreSQL-gated skips**.
- `npm run build` — pass; Security remains a lazy-loaded chunk.
- Impeccable detector — `[]`.
- In-app localhost browser QA — pass:
  - Admin sees and opens Security.
  - User sees no Admin group or Security menu.
  - Direct User navigation to `/drive/security` returns to Dashboard.
  - No connected hardware produces an honest unavailable/`UNKNOWN` state.
- Vault validation — pass with two pre-existing owner-review canvas warnings.
- Repository policy tests — **43/43 pass**.
- Collaboration-policy validation — pass for the exact change set with
  integration review enabled.

## Obsidian receipt

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-02_075800_kla_idea1-idea3-security-status.md`

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`
- IDEA3's owner-writable status note is intentionally not edited by this branch;
  its owner should record the approved cross-area contract after review.

## Shared surfaces touched

- `IDEA1-AEGIS_Drive_LC/server/idea3/status.js` — sanitised read-only
  IDEA1↔IDEA3 status contract.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — Admin-only status endpoint.
- `IDEA1-AEGIS_Drive_LC/server/rbac/permissions.js` — Admin navigation contract.
- `IDEA1-AEGIS_Drive_LC/src/App.jsx` — protected lazy screen routing.
- `IDEA1-AEGIS_Drive_LC/src/components/Sidebar.jsx` — Security navigation icon.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — TH/EN/ZH Security copy.
- `IDEA1-AEGIS_Drive_LC/src/screens/Security.jsx` — read-only status UI.

## Integration requests

- Kla: review IDEA1 RBAC, navigation, API, UI and bundle impact.
- Music: review the IDEA3 status schema and confirm that no command authority or
  secret crosses into IDEA1.
- Kla and Music: agree the later read-only deployment mount and stale-evidence
  threshold before enabling a real Supervisor status source.
- Keep deployment and hardware-lab validation as separately authorised tasks.

## Known limitations

- No ESP32, MQTT broker, relay, PostgreSQL service, production network, or real
  Supervisor status file was connected or tested.
- `AEGIS_IDEA3_STATUS_PATH` is blank by default, so the page intentionally shows
  unavailable/`UNKNOWN` until deployment is reviewed and configured.
- Three existing dependency-audit findings and the existing Vite main-chunk
  warning are recorded but not automatically rewritten by this scoped task.
- This PR must not be treated as authorisation to deploy or operate hardware.
```

## ไฟล์ใน local commit ที่รอส่ง (11 ไฟล์)

```text
M  IDEA1-AEGIS_Drive_LC/.env.example
A  IDEA1-AEGIS_Drive_LC/server/idea3/status.js
M  IDEA1-AEGIS_Drive_LC/server/rbac/permissions.js
M  IDEA1-AEGIS_Drive_LC/server/routes/api.js
M  IDEA1-AEGIS_Drive_LC/src/App.jsx
M  IDEA1-AEGIS_Drive_LC/src/components/Sidebar.jsx
M  IDEA1-AEGIS_Drive_LC/src/lib/strings.js
A  IDEA1-AEGIS_Drive_LC/src/screens/Security.jsx
A  IDEA1-AEGIS_Drive_LC/tests/securityStatus.test.js
A  Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-02_075800_kla_idea1-idea3-security-status.md
M  Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md
```

## ยืนยันตำแหน่ง repository

Pull Request สร้างก่อน push ไม่ได้ เพราะ GitHub ต้องเห็น source branch ก่อน
สำหรับงานนี้ตรวจและดำเนินการแล้วดังนี้:

1. โค้ดหน้าเว็บรวมส่งไปที่
   `https://github.com/kraveerachat/Project-End-The-AEGIS.git` ผ่าน feature branch
   และ PR #60 ไปยัง `main` ของ Kla.
2. โค้ดโปรแกรม IDEA3 autonomous runtime อยู่ที่
   `https://github.com/Kittipat050871/NETWORK-SEC-Project.git`; local IDEA3
   repository ตั้ง `origin` ไปที่ repository นี้อยู่แล้ว.

บัญชี Git มี Write access ต่อ repository เว็บหลักจริง: `git push --dry-run` ผ่าน,
feature branch ถูก push แล้ว และ PR ถูกสร้างโดยบัญชี `Kittipat050871`.

## คำสั่งตรวจสอบหลังส่ง PR

ตรวจสถานะก่อนทุกครั้ง:

```bash
cd "/home/kittipat/Workspace/Project-End-The-AEGIS-git"
git status --short --branch
git rev-parse HEAD
git log -1 --oneline
```

ตรวจ branch เว็บที่ push แล้ว:

```bash
git status --short --branch
git log -1 --oneline
```

ตรวจ repository โปรแกรม IDEA3 แยกต่างหาก:

```bash
cd "/home/kittipat/Workspace/Final Project Network Cyber/Projects/AEGIS_IDEA3"
git remote -v
git status --short --branch
git rev-parse HEAD
```

ขั้นต่อไปของเว็บคือรอ Kla และ Music review PR #60 และแก้เฉพาะ feedback ที่ได้รับ
ห้าม merge หรือ deploy เองโดยไม่มีการอนุมัติ ส่วนโปรแกรม IDEA3 ต้องจัดชุด
uncommitted autonomous-runtime แยกเป็น commit/PR ใน
`Kittipat050871/NETWORK-SEC-Project` หลังทบทวน diff และทดสอบรอบสุดท้าย
