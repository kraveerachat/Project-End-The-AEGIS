---
title: LLM Wiki Audit & Operation Log
tags: [aegis, wiki, log, audit, append-only]
type: wiki-admin
created: 2026-07-20
updated: 2026-07-24
---

# 📜 LLM Wiki Audit & Operation Log

> Append-only chronological log of all ingestion, query synthesis, and lint passes performed by the LLM Agent.

---

## [2026-07-20] ingest | AEGIS_Project_Knowledge_v7.md & AEGIS_System_Design.docx
- **Raw Sources**:
  1. `AEGIS_Project_Knowledge.md` (v7 Knowledge Base)
  2. `AEGIS_System_Design.docx` (Official Design Report Document)
- **Actions Taken**:
  - Ingested official report `AEGIS_System_Design.docx` and integrated chapters 1-5 into the LLM Wiki catalog.
  - Added new concept pages: `concepts/ZTNA_Twingate_vs_OpenVPN.md` (Zero Trust Mobile vs Admin OpenVPN) and `concepts/Mnemonic_Recovery_and_Zero_Knowledge.md` (Client-side AES-256 & BIP-39 12-word recovery).
  - Updated hardware entity pages (`MikroTik_hEX_lite`, `TP-Link_TL-SG105E`, `Beelink_Mini_S_NAS`, `ESP32_Relay_Module`).
  - Synthesized team roles, target audience (SMEs/Clinics/PDPA compliance), and OWASP security architecture into Obsidian `[[Wikilinks]]` format.
- **Status**: Completed successfully. 20 interlinked pages active in `AEGIS_Knowledge`.

---

## [2026-07-21] vibe-coding-audit | Codebase Synchronization Verification
- **User Prompt Goal**: Check and verify whether recent code modifications and features in the repository are fully updated inside `Obsidian_AEGIS_Vault\AEGIS_Knowledge`.
- **Modified Code Paths Inspected**:
  - `HUB-AEGIS_Entry/` (`src/App.jsx`, `src/screens/`, `src/components/LuminousModuleCard.jsx`, `server/index.js`, `public/config.json`)
  - `IDEA1-AEGIS_Drive_LC/` (`server/index.js`, `src/lib/vaultCrypto.js`, `src/lib/api.js`, `src/screens/Vault.jsx`, `src/screens/Audit.jsx`)
  - `IDEA2-AEGIS_Monitor/` (`server/index.js`, `src/App.jsx`, `IDEA2-AEGIS_CCTV-Operator/detection-engine/`)
  - `IDEA3-AEGIS_Lockdown/` (`firmware/`, simulation scripts)
- **In-Place Obsidian Updates Performed**:
  - Updated `00 - 🗺️ AEGIS System Overview.md` with current codebase topology and port status.
  - Updated `01 - 🚪 HUB-AEGIS Entry.md` to reflect Routing-Only Entry, `config.json` runtime targets, and `LuminousModuleCard.jsx`.
  - Updated `02 - 💾 IDEA1 AEGIS Drive LC.md` to reflect `vaultCrypto.js` (Client AES-256), `api.js`, and `aegis_drive` Express backend.
  - Updated `03 - 📹 IDEA2 AEGIS Monitor.md` to reflect `aegis_monitor` Express backend, unified dual-view App, and server JOIN on `camera_assignment`.
- **Status**: Verification & in-place update completed. All notes are 100% synchronized with current code.

---

## [2026-07-21] vibe-coding | Revert and Restore Split Vault Login Layout (Picture 2) & Cyber-Physical Blue/Purple Aesthetic
- **User Prompt Goal**: Revert HUB-AEGIS_Entry login screen back to Picture 2 design (split vault card layout with Welcome levitating mark on left, Login form on right, dark theme, and cyber-physical blue/purple gradient accents/glows).
- **Modified Source Code Paths**:
  - `HUB-AEGIS_Entry/src/App.jsx` (restored session state, split vault card morph, dark theme, and demo user hint)
  - `HUB-AEGIS_Entry/src/screens/Login.jsx` (restored Login screen with SparkleButton, Layer 0-3 cascade status, and auth call)
  - `HUB-AEGIS_Entry/src/lib/auth.js` (restored login/authenticate with API + in-memory dev fallback)
  - `HUB-AEGIS_Entry/server/` (restored server routes, session middleware, rate limiter, and DB seed)
- **Obsidian Notes Updated**:
  - `01 - 🚪 HUB-AEGIS Entry.md` updated to reflect the restored split vault card login system and authentication architecture.

---

## [2026-07-21] vibe-coding | Day-0 Bootstrap, Admin Provisioning & Force Password Reset (IDEA1) + SSH-only Operator CLI (IDEA2)
- **User Prompt Goal**: Generate 3 secure backend/database components for AEGIS's closed-registration provisioning model — (1) Day-0 DB seeding for IDEA1's initial Admin via Docker Compose env vars without leaking secrets into git, (2) an IDEA1 Admin API to provision `DataLake-User` accounts with a temp password + Force Password Reset flow, (3) an IDEA2 Python CLI (argparse, SSH-only) to add `CCTV-Operator` accounts and assign cameras — all bcrypt/Argon2-grade, no plaintext passwords anywhere.
- **Modified Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` (+`must_reset_password` column)
  - `IDEA1-AEGIS_Drive_LC/server/db/connection.js` (+`getUserById`, `createUserWithTempPassword`, `updatePasswordHash`, `generateTempPassword`)
  - `IDEA1-AEGIS_Drive_LC/server/db/bootstrapAdmin.js` (new — Day-0 admin from a pre-computed bcrypt hash env var, refuses to boot on a malformed hash)
  - `IDEA1-AEGIS_Drive_LC/server/auth/login.js`, `server/auth/session.js`, `server/middleware/requireRole.js` (mustResetPassword propagated session→gate; new `RESET_EXEMPT_PATHS`)
  - `IDEA1-AEGIS_Drive_LC/server/routes/api.js` (`POST /api/users` now writes real Postgres accounts; new `POST /api/password/reset`)
  - `IDEA1-AEGIS_Drive_LC/server/index.js` (calls `bootstrapAdminIfNeeded()` before listening; exits on failure)
  - `IDEA1-AEGIS_Drive_LC/src/screens/Access.jsx`, `src/lib/strings.js` (one-time temp-password reveal panel; Admin creation removed from the quick-add UI to match the server's role restriction)
  - `IDEA1-AEGIS_Drive_LC/scripts/hash_password.py`, `scripts/requirements.txt` (new — local bcrypt hash generator, getpass-only)
  - `IDEA1-AEGIS_Drive_LC/.env.example` (new)
  - `IDEA2-AEGIS_Monitor/server/db/schema.sql` (+`must_reset_password` column, mirrors IDEA1)
  - `IDEA2-AEGIS_Monitor/server/db/connection.js`, `server/auth/login.js`, `server/auth/session.js`, `server/middleware/requireRole.js`, `server/routes/api.js` (same force-reset gate + `POST /api/password/reset` as IDEA1)
  - `IDEA2-AEGIS_Monitor/server/cli/manage_users.py`, `server/cli/requirements.txt`, `server/cli/README.md` (new — SSH-only provisioning CLI: `add-operator`, `list-cameras`, `list-operators`)
  - `IDEA2-AEGIS_Monitor/.env.example` (new)
  - `docker-compose.yml` (root — `ADMIN_BOOTSTRAP_USERNAME`/`ADMIN_BOOTSTRAP_PASSWORD_HASH` passthrough for the `drive` service)
  - `.env.example` (root, new)
- **Obsidian Updates**: [[00 - 🗺️ AEGIS System Overview]], [[02 - 💾 IDEA1 AEGIS Drive LC]], [[03 - 📹 IDEA2 AEGIS Monitor]], [[05 - 🛡️ Security Architecture]]
- **Key Changes**:
  - No plaintext password ever crosses a process boundary: Day-0 bootstrap accepts only a pre-computed bcrypt hash (validated by regex before boot); Admin/CLI-issued temp passwords are generated server/CLI-side and returned exactly once.
  - Every server-provisioned account (Day-0 admin, IDEA1 `DataLake-User`, IDEA2 `CCTV-Operator`) is created with `must_reset_password = TRUE`; a new gate in both apps' `requireRole.js` blocks all endpoints except `/me`, `/logout`, `/password/reset` until reset, closing a real gap IDEA2's own code had flagged in a comment (`pgAddOperator` issuing unusable random passwords with no reset path).
  - `POST /api/users` (IDEA1) can only create `DataLake-User`, never `Admin`, to limit blast radius from a hijacked Admin session.
  - IDEA2's CLI is SSH-only by design (no new web-exposed write route); transactional (bad camera id / duplicate username rolls back cleanly); confirms before reassigning a camera already held by another operator.
- **Status**: All modified/new JS files passed `node --check`; both Python scripts passed `py_compile`; IDEA1 frontend build (`vite build`) succeeded with the Access.jsx changes included.

---

## [2026-07-21] vibe-coding | Initialized and Pushed Git Repository to GitHub
- **User Prompt Goal**: Commit and push all project files to GitHub remote (`https://github.com/kraveerachat/Project-End-The-AEGIS.git`).
- **Modified Source Code Paths**:
  - `.gitignore` (updated to exclude `__pycache__/`, `*.pyc`, `.pytest_cache/`)
- **Git Actions**:
  - Added remote `origin`: `https://github.com/kraveerachat/Project-End-The-AEGIS.git`
  - Staged and committed all files to `main` branch.
  - Pushed to `origin/main`.
- **Obsidian Updates**: `log.md` updated.

---

## [2026-07-21] vibe-coding | Deterministic Local Test Fixture Seeding (6-account matrix, IDEA1 + IDEA2)
- **User Prompt Goal**: Seed a local test environment with 6 specific, pre-determined accounts (fixed usernames/passwords, not random temp passwords) to exercise UI and RBAC flows: 1 Admin + 2 DataLake-User on IDEA1, 1 SOC-Responder + 2 CCTV-Operator (with camera assignments) on IDEA2 — hashes only, no plaintext in SQL/app code.
- **Modified/New Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/server/db/seedTestFixtures.js` (new — reads 3 bcrypt hashes from env, upserts fixed test accounts with `must_reset_password = FALSE` so they're immediately usable; refuses to run when `NODE_ENV=production` or without a real `DATABASE_URL`)
  - `IDEA1-AEGIS_Drive_LC/.env.test.example` (new)
  - `.gitignore` (root — added `!.env.test.example` exception; the existing `!.env.example` pattern didn't cover this new filename)
  - `IDEA2-AEGIS_Monitor/server/cli/manage_users.py` — `add-operator` extended with `--role` (CCTV-Operator/SOC-Responder, was hardcoded), `--password-stdin` (scripted password input, no getpass prompt), `--skip-force-reset` (immediately-usable password for test fixtures); all three off/default-safe unless explicitly passed
  - `IDEA2-AEGIS_Monitor/server/cli/README.md` (documents the new flags and the scripted test-fixture usage pattern)
- **Obsidian Updates**: [[02 - 💾 IDEA1 AEGIS Drive LC]], [[03 - 📹 IDEA2 AEGIS Monitor]]
- **Key Changes**:
  - This is a *separate, parallel* path from the production Day-0/force-reset flow built in the previous session — `seedTestFixtures.js` is not called from `index.js` at boot (must be run manually) and explicitly sets `must_reset_password = FALSE`, the opposite default of `bootstrapAdmin.js`/`POST /api/users`, because the stated goal here is immediate login with known credentials, not real provisioning.
  - The one-off Python hash generator for the 6 known test passwords was deliberately written to the session scratchpad, not the repo — hardcoding even test passwords into a tracked file was avoided per the user's own "no plaintext in code" requirement.
  - IDEA2's CLI can now create `SOC-Responder` accounts (previously `add-operator` only supported `CCTV-Operator`), needed for the `soc_admin` fixture.
- **Status**: New/modified files passed `node --check` / `py_compile`; `.gitignore` fix verified with `git check-ignore`.


---

## [2026-07-22] vibe-coding | Ethics (HREC-SUT) forms for IDEA 2 + Syllabus alignment; TASK 3 discrepancy flagged
- **User Prompt Goal**: (1) จัดวัตถุประสงค์/ประโยชน์ของเอกสาร AEGIS ให้ตรง keyword มคอ.3, (2) ร่างเอกสารจริยธรรมการวิจัยในมนุษย์ (PIS + Consent) สำหรับ IDEA 2 (Facial Recognition), (3) แก้ bug 2 จุดในเล่ม (ประโยค Terminal Account ซ้ำท้าย 2.3.4 และถ้อยคำ BOM หัวข้อ 5.6)
- **Modified/New Paths**:
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/ethics/Participant_Information_Sheet_IDEA2.md` (new)
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/ethics/Informed_Consent_Form_IDEA2.md` (new)
- **Obsidian Updates**: [[ethics/Participant_Information_Sheet_IDEA2]], [[ethics/Informed_Consent_Form_IDEA2]], `index.md`, `log.md`
- **Key Changes**:
  - ร่างฟอร์ม EC 2 ฉบับตามโครงสร้างมาตรฐาน HREC-SUT เน้น 3 ข้อจำกัดความเป็นส่วนตัว: 100% Local Edge Processing (ไม่ขึ้นคลาวด์), เก็บเฉพาะ Name + RBAC Role (ไม่เก็บเลขบัตร/รหัสพนักงาน), และ Data Retention Policy ตาม PDPA.
  - TASK 1 (วัตถุประสงค์/ประโยชน์) ส่งเป็นข้อความให้ผู้ใช้วางลงเล่มเอง — ยังไม่ได้แก้ลงไฟล์ .docx ต้นฉบับ (แก้ .docx โดยตรงไม่ได้จากเครื่องมือปัจจุบัน).
  - **⚠️ TASK 3 — ตรวจแล้วไม่พบของจริง**: `AEGIS_System_Design.docx` (แก้ 19 ก.ค.) และสำเนา extract ไม่มี Section 5.6 / BOM / คำว่า "วางแผนจะใช้" (หัวข้อ 5 จบที่ 5.5 → 6 → 7) และท้าย Section 2.3.4 ไม่มีประโยค "Terminal Account" ซ้ำ (คำว่า Terminal ปรากฏตามบริบทปกติ). พบ duplicate จริงคนละจุด: หัวเรื่อง "2.1 แผนผังการเชื่อมต่อ (Logical Topology)" ปรากฏซ้ำ 2 ครั้ง. รอผู้ใช้ยืนยัน/ส่งไฟล์ v7 ฉบับที่แก้ล่าสุด.
  - ไม่พบไฟล์ Syllabus (มคอ.3) และ SUT Ethics templates ในเครื่อง — ใช้ keyword ที่ผู้ใช้ระบุ + โครงสร้างมาตรฐานแทน.
- **Status**: ไฟล์ ethics 2 ฉบับสร้างสำเร็จ; TASK 3 blocked รอ input.

---

## [2026-07-22] vibe-coding | Phase 1: Storage Layer ของจริง + operator คนที่สอง + แยก session secret + ล้างค่าจริงออกจาก .env.example
- **User Prompt Goal**: ตามคำสั่ง Phase 1 หลัง Discovery Report — (E) เพิ่มบัญชี CCTV-Operator คนที่สองผูกกับกล้องที่ยังว่าง เพื่อพิสูจน์ per-operator isolation, (F) **สร้าง Storage Layer ของ Data Lake ให้มีอยู่จริง** (งานหลักของเฟสนี้), + งานบังคับอีกสองข้อ: ย้ายค่าจริงออกจาก `.env.example` และแยก `SESSION_SECRET` เป็นคนละดอกต่อแอป — โดย **ห้ามแตะ** ประเด็น A/B (HUB) ที่ผู้ใช้สั่ง HOLD และคง shape ของ `camera_assignment` (C) กับ `cameras.id` แบบ TEXT (D) ไว้เหมือนเดิม
- **Modified/New Paths**:
  - `IDEA1-AEGIS_Drive_LC/server/storage/fileStore.js` (**ใหม่** — Storage Layer)
  - `IDEA1-AEGIS_Drive_LC/server/routes/api.js` (upload เป็น multipart, `GET /api/files/:id/download` ใหม่, DELETE ลบ byte ตามด้วย)
  - `IDEA1-AEGIS_Drive_LC/server/db/store.js` (`recordUpload` รับ `storageKey` แทนการประกอบ path สมมุติ)
  - `IDEA1-AEGIS_Drive_LC/server/index.js` (`initStorage()` ก่อนเปิดพอร์ต)
  - `IDEA1-AEGIS_Drive_LC/Dockerfile` (`mkdir /datalake && chown node:node` ก่อน `USER node`)
  - `IDEA1-AEGIS_Drive_LC/package.json` (+ `multer@^2.0.0`)
  - `IDEA1-AEGIS_Drive_LC/src/lib/api.js` (รองรับ `FormData` + `timeoutMs` + export `apiUrl`)
  - `IDEA1-AEGIS_Drive_LC/src/screens/Uploads.jsx` (ส่งไฟล์จริง ไม่ใช่ metadata), `src/screens/Files.jsx` (ปุ่ม download ต่อสายแล้ว)
  - `IDEA2-AEGIS_Monitor/server/db/seed.sql` (+ `operator2` → CAM-06), `server/db/connection.js` + `server/db/store.js` (dev fallback ให้ตรงกับ seed)
  - `docker-compose.yml` (volume `drive_storage`, `STORAGE_ROOT`, แยก `DRIVE_SESSION_SECRET`/`MONITOR_SESSION_SECRET`)
  - `.env.example` (เหลือแต่ placeholder), `.env` (**ใหม่ — git-ignored**, ค่าจริงย้ายมาที่นี่)
  - `docs/auth-test.md` (**ใหม่** — คำสั่ง curl พิสูจน์ครบ 10 ข้อ)
- **Obsidian Updates**: [[00 - 🗺️ AEGIS System Overview]], [[02 - 💾 IDEA1 AEGIS Drive LC]], [[03 - 📹 IDEA2 AEGIS Monitor]]
- **Key Changes**:
  - **Storage Layer มีอยู่จริงแล้ว**: เดิม `POST /api/files/upload` รับแค่ `{name,size,sha256}` แล้วเขียนแถว `files` ที่ชี้ไป path สมมุติ — ไม่มี byte ไหนลงดิสก์เลย ตอนนี้ multer เขียน stream ลง named volume `drive_storage` (mount `/datalake` ที่คอนเทนเนอร์ drive เท่านั้น) แล้วเซิร์ฟเวอร์อ่านขนาด+sha256 จากไฟล์จริงก่อน INSERT metadata
  - ชื่อไฟล์บนดิสก์เป็น **UUID ทึบ** ไม่มีเศษของชื่อผู้ใช้เลยแม้แต่นามสกุล → ชื่อจากผู้ใช้ไม่มีวันกลายเป็น path = ตัด path traversal ตั้งแต่ต้นทาง (มี `resolveKey()` กันซ้ำอีกชั้น) และชื่อจริงอยู่ Metadata Layer เท่านั้น
  - ลำดับ write เป็น **byte ก่อน metadata ทีหลัง** และถ้า INSERT พังจะลบ byte ทิ้ง — ไม่เหลือทั้ง "แถวที่ชี้ไปไฟล์ที่ไม่มีจริง" และ "ไฟล์กำพร้าที่ไม่มีใครลบได้"
  - `sha256` ที่ client ส่งมาใช้แค่ "เทียบ" ไม่ใช่แหล่งความจริง — ไม่ตรง = `422` ทิ้งทั้ง byte และ metadata
  - **แก้ปัญหาสิทธิ์ volume ตั้งแต่ image**: named volume ที่ mount ใหม่จะเป็นของ `root` ขณะที่คอนเทนเนอร์รันด้วย user `node` — จึง `chown` mountpoint ใน Dockerfile ก่อน `USER node` และให้ `initStorage()` เขียนไฟล์ทดสอบจริงตอนบูตเพื่อให้ปัญหาดังตั้งแต่ start ไม่ใช่ตอนผู้ใช้กดอัปโหลด
  - **operator2 → CAM-06** เพิ่มเข้า seed (ไม่แตะบัญชีเดิมทั้ง 4 ตามคำสั่ง) และ mirror ลง dev fallback ให้ตรงกัน — ยืนยันแล้วว่า operator ↔ operator2 ยิงขอกล้องของกันและกันได้ `403` ทั้งสองทิศทาง
  - **`.env.example` ไม่มีค่าจริงเหลือแล้ว** — ค่าที่ดูเหมือนของจริง (POSTGRES_PASSWORD, SESSION_SECRET, bcrypt hash ของ `veerachat05`) อยู่แค่ใน working copy ที่ยังไม่ถูก commit ตรวจกับ `git log`/`origin/main` แล้ว **ไม่เคยถูก push ขึ้น remote** จึงไม่ต้อง rotate
  - พบและแก้กับดัก: ค่า bcrypt ใน root `.env` ต้องเขียน `$` เป็น `$$` ไม่งั้น docker compose กลืน `$eM2QJbR` เป็นชื่อตัวแปรแล้ว hash พังเงียบ ๆ (ตรวจด้วย `docker compose config`)
- **Status**: ✅ ทดสอบจริงบน stack ที่รันอยู่ — upload→download ไฟล์ binary 3MB ได้ sha256 ตรงกันและ `cmp` byte ต่อ byte ผ่าน; checksum ผิด→422, ไม่มี CSRF→403, ไม่มี session→401, ลบแล้ว byte หายจริง; camera scoping ครบทุกกรณี; drive/monitor healthy ทั้งคู่
- **ค้างไว้ (รอ ruling ของผู้ใช้)**: ประเด็น **A** (HUB `src/lib/auth.js` มี `DEMO_ACCOUNTS` client-side fallback ที่ประกาศ role เองและมีรหัสผ่าน plaintext อยู่ใน bundle ที่ ship จริง) และ **B** (ทั้งสองแอปยังต่อ Postgres ด้วย role `aegis` superuser ตัวเดียว ยังไม่มี `drive_app`/`monitor_app` + GRANT/REVOKE) — **ยังไม่แตะทั้งคู่ตามคำสั่ง HOLD**

---

## [2026-07-22] vibe-coding | Phase 1 follow-up: บังคับ Identity Decoupling ระดับ SQL (drive_app / monitor_app) + ถอน node_modules ออกจาก git
- **User Prompt Goal**: ตรวจให้ชัดว่า drive/monitor แชร์ role ของ Postgres กันจริงไหม ถ้าใช่ให้สร้าง role แยกที่ต่อได้เฉพาะฐานตัวเอง แล้วพิสูจน์ว่าข้ามฐานไม่ได้; และถอน `node_modules` ที่ถูก track ไว้ออกจาก git (ยังห้ามแตะ A/B)
- **Modified/New Paths**:
  - `postgres/init/02-app-roles.sh` (**ใหม่** — สร้าง `drive_app`/`monitor_app` + REVOKE/GRANT)
  - `docker-compose.yml` (mount script ใหม่, env `DRIVE_DB_PASSWORD`/`MONITOR_DB_PASSWORD`, ย้าย `DATABASE_URL` ทั้งสองไปใช้ role แยก)
  - `.env` / `.env.example` (รหัสของ role แยกต่อแอป)
  - `docs/auth-test.md` (ข้อ 11 ใหม่ — แทนที่หมายเหตุเดิมที่บอกว่า "ยังไม่ได้ทำ")
- **Obsidian Updates**: [[00 - 🗺️ AEGIS System Overview]], [[05 - 🛡️ Security Architecture]]
- **Key Changes**:
  - **ยืนยันว่าเป็นปัญหาจริง ไม่ใช่ความเข้าใจผิดของเอกสาร**: `\du` มี role เดียวคือ `aegis` (superuser) และ `DATABASE_URL` ทั้งสองบริการต่อด้วย role นั้น — ทดสอบตรงแล้ว credential ของ IDEA1 `SELECT password_hash` จากตาราง `users` ของ `aegis_monitor` ได้จริงทั้ง 3 แถว
  - แก้แล้ว: `drive_app` → `aegis_drive` เท่านั้น, `monitor_app` → `aegis_monitor` เท่านั้น — **ถูกปฏิเสธที่ชั้น connection** (`FATAL: permission denied for database … User does not have CONNECT privilege`) ไม่ใช่ชั้น query จึงไม่ต้องพึ่ง WHERE clause ที่ไหนเลย
  - **กุญแจสำคัญคือ `REVOKE CONNECT … FROM PUBLIC`**: PostgreSQL แจกสิทธิ์ CONNECT ของทุก database ให้ PUBLIC โดยดีฟอลต์ ถ้า GRANT ให้ role ที่ถูกต้องอย่างเดียวโดยไม่ถอนของ PUBLIC ก่อน การแยกจะไม่เกิดขึ้นเลย
  - role ใหม่ได้แค่ DML + USAGE บน sequence ไม่ได้เป็นเจ้าของตาราง → `DROP TABLE` ได้ `must be owner`, `CREATE TABLE` ได้ `permission denied for schema public` — โปรเซสที่ถูกยึดก็แก้ schema ไม่ได้ migration ยังเป็นงาน superuser ตอน deploy
  - superuser `aegis` เหลือหน้าที่แค่ init/migrate/ตรวจสอบ — ไม่มีบริการไหนที่รันอยู่ต่อด้วย role นี้อีกแล้ว
  - ทดสอบเส้นทาง init บน **volume เปล่าจริง ๆ** ด้วย compose project แยก (`-p aegisfresh`) แล้ว `down -v` ทิ้ง — role/สิทธิ์/seed (รวม `operator2`→CAM-06) ถูกสร้างครบตั้งแต่บูตแรก ข้อมูลของ stack จริงไม่ถูกแตะ
  - เจอผลข้างเคียงตอน recreate: nginx ของ gateway cache IP ของ upstream ไว้ตั้งแต่บูต พอ container ถูกสร้างใหม่แล้วได้ IP ใหม่จะขึ้น 502 ทั้งที่ container สุขภาพดี — แก้ด้วย `docker compose restart gateway` (เป็นข้อจำกัดเดิมของ config ไม่ใช่ของใหม่)
  - `git rm -r --cached IDEA1-AEGIS_Drive_LC/node_modules` ถอดไฟล์ 12,551 ไฟล์ออกจาก index (ไฟล์ยังอยู่บนดิสก์ แอปยังรันได้) — `.gitignore` บรรทัด `node_modules/` ครอบคลุมอยู่แล้ว ยืนยันด้วย `git check-ignore`
- **Status**: ✅ regression ครบหลังย้าย role — login/RBAC, upload→download 2MB byte ตรงกัน, audit เขียนได้, camera scoping (soc=6 กล้อง, operator=CAM-05, operator2=CAM-06, ไขว้กัน=403) ทุกอย่างผ่านบน role ใหม่
- **ค้างไว้ (รอ ruling)**: A (HUB client-side `DEMO_ACCOUNTS`) และ B — **ยังไม่แตะตามคำสั่ง HOLD**

---

## [2026-07-23] vibe-coding | แก้ nginx gateway cache IP ของ backend + เพิ่ม healthcheck ให้ gateway
- **User Prompt Goal**: gateway resolve ชื่อ `drive`/`monitor` ครั้งเดียวตอนบูตแล้ว cache IP ไว้ พอ container ถูกสร้างใหม่ (IP เปลี่ยน) จะขึ้น 502 จนกว่าจะ `docker compose restart gateway` เอง — ให้แก้ด้วย `resolver` + `proxy_pass` ผ่านตัวแปร และเพิ่ม healthcheck ให้ gateway ไปด้วยเพราะกำลังแก้ไฟล์นี้อยู่แล้ว
- **Modified Paths**:
  - `gateway/nginx.conf` (`resolver 127.0.0.11 valid=10s ipv6=off` + `resolver_timeout 5s`; `/drive/` และ `/monitor/` เปลี่ยนไปใช้ `set $..._upstream` แล้ว `proxy_pass http://$var`; `/healthz` เพิ่ม `access_log off`)
  - `docker-compose.yml` (เพิ่ม healthcheck ของ gateway ยิงหา `/healthz` ของตัวเอง)
- **Obsidian Updates**: [[00 - 🗺️ AEGIS System Overview]]
- **Key Changes**:
  - **สาเหตุ**: nginx resolve ชื่อ host ที่เขียนตรง ๆ ใน `proxy_pass` แค่ตอน start แล้วจำ IP ไว้ตลอดอายุโปรเซส การเขียนผ่านตัวแปรทำให้ nginx เลื่อนไป resolve ตอน runtime แทน (ต้องมี `resolver` คู่กันเสมอ ไม่งั้น nginx ไม่รู้จะถาม DNS ตัวไหน)
  - **พิสูจน์แบบ A/B จริง**: บังคับให้ `drive` ได้ IP ใหม่ (หยุด container → ให้ container ชั่วคราวยึด IP เดิม → ยกกลับมาใหม่ได้ `172.18.0.3` → `172.18.0.7`) แล้วยิงผ่าน gateway สองตัวพร้อมกันโดยไม่ restart ตัวไหนเลย — **config เดิม 502 ติดต่อกัน 12 วินาที (และค้างถาวรจนกว่าจะ restart) ส่วน config ใหม่ 200 ทุกครั้งไม่ตกเลยสักครั้ง** ยืนยันซ้ำกับ `monitor` (`172.18.0.2` → `172.18.0.8`) ได้ผลเดียวกัน
  - ยืนยันว่า 502 ของ config เดิมมาจาก DNS ค้างจริง: restart gateway ตัวเก่าแล้วกลับมา 200 ทันทีทั้งที่ backend ไม่ได้แตะเลย
  - **ขอบเขตที่เหลืออยู่ (ไม่ใช่ศูนย์)**: `valid=10s` แปลว่า worst case ยังมีหน้าต่างค้างได้ไม่เกิน ~10 วินาที ถ้า IP เปลี่ยนภายในช่วง TTL — ต่างจากเดิมที่ค้าง "ตลอดไป" ลดค่านี้ได้ถ้าต้องการแต่จะแลกกับ DNS query ถี่ขึ้น
  - healthcheck ของ gateway ยิงหา `/healthz` ของ nginx เอง **ไม่ใช่** `/drive` หรือ `/monitor` โดยเจตนา — gateway เป็น routing-only ถ้าผูก health ไว้กับ backend พอ backend ล่มทีเดียว docker จะรีสตาร์ท router ที่ยังดีอยู่ทิ้งไปด้วย = ขยายวงความเสียหายแทนที่จะจำกัด
  - `HUB-AEGIS_Entry/nginx.conf` (production) **ไม่ต้องแก้** — proxy_pass ไปที่ IP ตรง ๆ (`192.168.10.11:8001` / `192.168.10.12:8002`) ไม่มี DNS เข้ามาเกี่ยวข้องเลย
- **Status**: ✅ `nginx -t` ผ่าน; routing เดิมครบ (`/`, `/drive/`, `/monitor/`, 301 ของ `/drive`→`/drive/`, path ซ้อน, query string); gateway healthy ใน docker; regression ครบหลัง IP เปลี่ยนทั้งสองตัว — login/RBAC, upload→download 1.5MB byte ตรงกัน, camera scoping + 403 ไขว้กัน ผ่านหมด; container ทดสอบถูกลบทิ้งแล้ว
- **ค้างไว้ (รอ ruling)**: A (HUB client-side `DEMO_ACCOUNTS`) และ B — **ยังไม่แตะตามคำสั่ง HOLD**

---

## [2026-07-23] wiki-lint | ตรวจ vault ตามคอนเวนชัน Obsidian + ซ่อมลิงก์เสีย
- **User Prompt Goal**: รัน `/obsidian` — ตรวจ vault ให้ตรงคอนเวนชัน (frontmatter / wikilinks / mermaid / canvas) และซ่อมสิ่งที่ไม่ตรง
- **Modified Paths**: `.schema.md`, `log.md`, `index.md`, `00 - 🗺️ AEGIS System Overview.md`, `02 - 💾 IDEA1 AEGIS Drive LC.md`, `03 - 📹 IDEA2 AEGIS Monitor.md`, `concepts/*.md` (7 ไฟล์), `entities/*.md` (2 ไฟล์)
- **Key Changes**:
  - **ซ่อมลิงก์ที่ตัวเองทำพังในรอบก่อน**: `[[docs/auth-test]]` ใน 4 โน้ต — `docs/auth-test.md` อยู่ **นอก** vault (รากของ repo) Obsidian จึง resolve ไม่ได้ตลอดกาล เปลี่ยนเป็น path ใน inline code แทน และเพิ่มหมายเหตุใน `index.md` ว่าไฟล์นอก vault ต้องอ้างเป็น path ล้วนเสมอ
  - **ซ่อมลิงก์ค้างเก่า 17 จุดใน 11 ไฟล์**: `[[modules/02_IDEA1_AEGIS_Drive_LC]]` และ `[[modules/04_IDEA3_AEGIS_Lockdown]]` ชี้ไปยังโน้ตที่ **ไม่มีอยู่จริง** ส่วน `[[modules/03_IDEA2_AEGIS_Monitor]]` ชี้ไปยังไฟล์ที่มีอยู่แต่ **ว่างเปล่า 0 ไบต์** (แย่กว่าลิงก์เสีย เพราะผู้อ่านกดแล้วเจอหน้าว่างโดยไม่รู้ว่าผิด) — ทั้งหมดถูกชี้กลับไปยังโน้ตหมายเลขที่ใช้งานจริง โดยรักษา label หลัง `|` ไว้ครบ
  - เพิ่ม YAML frontmatter ให้ `log.md` และ `.schema.md` (เดิมไม่มี) — ไฟล์ `raw/` และ `AEGIS_Project_Knowledge.md` **จงใจไม่แตะ** เพราะ `.schema.md` ระบุว่าเป็น Immutable Raw Source
  - ตรวจ mermaid: 13 โน้ตมี fence ครบคู่ทุกไฟล์ (เคยมี fence เกินหนึ่งอันในไฟล์ overview จากรอบก่อน แก้ไปแล้ว)
- **ยังค้าง (ต้องให้ผู้ใช้ตัดสิน ไม่ลบเอง)**:
  - `modules/03_IDEA2_AEGIS_Monitor.md` และ `2026-07-21.md` เป็นไฟล์ว่าง 0 ไบต์ และตอนนี้ไม่มีลิงก์เข้าเลย → โฟลเดอร์ `modules/` ว่างเปล่าโดยพฤตินัยแล้ว ทั้งที่ `.schema.md` ยังประกาศไว้ในโครงสร้าง
  - `.schema.md` ขึ้นต้นด้วยจุด → **Obsidian ไม่ index ไฟล์/โฟลเดอร์ที่ขึ้นต้นด้วย `.`** แปลว่าเอกสารกฎของ vault มองไม่เห็นในแอป และ `[[.schema.md]]` ใน `index.md` กดไม่ได้จริง (เปลี่ยนชื่อเป็น `schema.md` จะแก้ได้ แต่กระทบโครงสร้างที่ประกาศไว้ จึงยังไม่ทำเอง)
- **Status**: ✅ ลิงก์เสียเหลือศูนย์ (ที่เหลือเป็น false positive: ตัวอย่างในเอกสารกฎ และข้อความในเครื่องหมาย backtick ซึ่ง Obsidian ไม่แปลงเป็นลิงก์อยู่แล้ว)

---

## [2026-07-24] vibe-coding | ปิดช่องโหว่ HUB client-side auth + เปลี่ยน HUB เป็น app-picker ล้วน
- **User Prompt Goal**: ปิดช่องโหว่ที่ HUB login fallback ไปตรวจรหัสผ่านฝั่ง client (`DEMO_ACCOUNTS`) เมื่อไม่มี backend ตอบ — เลือกแนวทาง "ลบฟอร์มล็อกอินทิ้ง ให้ HUB เหลือแค่หน้าเลือกแอป" (แทนการสร้าง HUB backend ใหม่) เพื่อปลดล็อกให้เข้าเช็คระบบได้ทันที
- **Root Cause**: `src/lib/auth.js` มี `DEMO_ACCOUNTS` + logic "API offline → authenticate client-side" เงื่อนไข offline เป็นจริงเสมอ เพราะ `docker-compose.yml` ไม่เคยมี service `hub` (gateway เสิร์ฟ HUB เป็น static → `/api/login` ตอบ 405) = แจก session Admin โดยไม่มี server enforcement
- **Modified Code Paths**:
  - **ลบทิ้ง**: `HUB-AEGIS_Entry/server/` (ทั้งโฟลเดอร์), `src/screens/Login.jsx`, `src/lib/auth.js`, `src/lib/modules.js`
  - **แก้**: `src/App.jsx` (state machine เหลือ welcome→hub ตัด screen 'login'/'session' ออก), `src/lib/strings.js` (ลบสตริงหมวด Login + LAYER 0–3 ทั้ง en/th/zh), `Dockerfile` (runtime เป็น nginx เสิร์ฟ static ไม่รัน `node server/index.js` แล้ว), `package.json` (ตัด express + scripts `start`/`server`/`dev:server`), `docker-compose.yml` (port 80/443 + certs volume), `nginx.conf` (comment)
  - **แก้ prose**: `README.md` (ราก), `HUB-AEGIS_Entry/README.md`
  - **หมายเหตุ**: `Hub.jsx` มีโครงเป็น stateless app-picker (window.location.href + config.json) อยู่แล้ว จึงไม่ต้องแก้ตรรกะ — งานหลักคือ "ลบ" ไม่ใช่ "สร้าง"
- **Docs**: `docs/auth-test.md` — เพิ่มหมายเหตุหัวไฟล์ (HUB ไม่มี login) + เพิ่ม **§12** (regression test: bundle ไม่มี credential, `/api/login`→405, หน้า HUB ไม่ยิง auth request, ไม่มี `server/`)
- **Obsidian Updates**: [[01 - 🚪 HUB-AEGIS Entry]] (เขียนใหม่ทั้งโน้ต), [[00 - 🗺️ AEGIS System Overview]] (ลบ HUB_API :3001 จาก mermaid + แก้ตารางสถานะ), [[concepts/Identity_Decoupling]] (เพิ่มเหตุผลว่าทำไม HUB ต้องไม่มี identity), `index.md`
- **Verification (จริง ไม่ใช่ "should work")**:
  - `docker compose build --no-cache && up -d` → 4 container healthy, container postdate source ทุกไฟล์, bundle ที่ deploy = `index-DNSXLW2W.js` ตรงกับ local build
  - Browser (playwright/chrome): หน้า HUB — 0 password input, 0 form, 0 auth request (มีแค่ `GET /` + `/config.json`); กด Drive card → `/drive/` เจอ login จริง; กด Monitor card → `/monitor/` เจอ login จริง
  - Login ผ่านหน้าจอจริง: `admin`/`aegis-drive-admin` → Admin session + เมนู 9 รายการ + `/api/*` ตอบ 200
  - `docs/auth-test.md` §1–12 รันจริงผ่านทั้งหมด (§8 rate limit: attempt 6 → 429 Retry-After 120; §9 roundtrip IDENTICAL + UUID บนดิสก์; §11 cross-DB connect → permission denied)
- **Key Changes**: ปิดช่องโหว่ด้วยการ**ลบพื้นผิวการโจมตี** ไม่ใช่เพิ่ม guard — HUB กลับไปเป็น routing-only ตามสถาปัตยกรรมเดิม Drive/Monitor ไม่ถูกแตะเลย (ยืนยันด้วย §1–11)
- **Constraints ที่รักษาไว้**: ไม่แตะ IDEA2/Add Operator, ไม่แตะ `camera_assignment`/RBAC, ไม่สร้าง HUB DB/backend/session, ดีไซน์เดิมทุกประการ

---

## [2026-07-24] vibe-coding | Verify in-web Add Operator E2E (real Postgres) + document the feature
- **User Prompt Goal**: รันสแตกจริง (ไม่ใช่ dev-fallback), พิสูจน์ `docs/auth-test.md` §13 ด้วย output จริงทุกบรรทัด, เปิดเบราว์เซอร์จริง (Playwright) เพิ่ม operator ผ่านหน้า Nodes & routing แล้วยืนยัน temp-password modal + isolation ของ operator ใหม่ แล้วอัปเดต vault
- **Verification (จริง ไม่ใช่ "should work")**:
  - `docker compose build --no-cache && up -d` → 4 container healthy; monitor ต่อ `aegis_monitor` ผ่าน `monitor_app` (ยืนยันจาก `docker compose config`) = โหมด Postgres จริง ไม่ใช่ in-memory DEV_USERS
  - `docs/auth-test.md` §13 รันจริงผ่านทั้งหมด: §13.1 `201` + temp password 24-char + `grep -c` ใน log = **0**; §13.2 กล้องซ้ำ → `409` + rollback (`x.taken` count = 0); §13.3 operator (ไม่ใช่ SOC) → `403 Forbidden`; §13.4 operator ใหม่ก่อนรีเซ็ต `/cameras` → `403`, หลังรีเซ็ตเห็นแค่ CAM-04; §13.5 สร้างอีกบัญชีผ่าน CLI จริง (Python container บน network เดียวกัน ต่อ `postgres:5432`) แล้วเทียบสองแถวใน DB
  - **Browser (Playwright chromium จริง)**: login `soc` → Nodes & routing → Add operator → dropdown โชว์เฉพาะกล้องว่าง (CAM-03 ตัวเดียว เพราะที่เหลือถูกจับจอง) → submit → `TempPasswordModal` เรนเดอร์ครบ: รหัส 24-char, ปุ่ม Copy (กดแล้วเป็น "Copied" + เขียน clipboard ตรงกับที่โชว์จริง), คำเตือน "won't be shown again" (screenshot เก็บไว้)
  - **Isolation ของ operator ใหม่ (`g.torres.gui` → CAM-03, §5 pattern)**: ก่อนรีเซ็ต `/cameras` → 403; หลังรีเซ็ตเห็นแค่ CAM-03; ขอ CAM-05/CAM-01 ของคนอื่น → 403; `/alerts` (SOC-only) → 403; และไขว้กลับ `operator` (CAM-05) ขอ CAM-03 → 403
  - บัญชีทดสอบทั้ง 4 (`m.reyes.web`, `m.reyes.cli`, `m.reyes.web2`, `g.torres.gui`) ถูกลบทิ้ง คืน DB เป็น seeded baseline (3 บัญชี, CASCADE เก็บ `camera_assignment` ให้)
- **Finding (bcrypt version prefix)**: เส้นทางเว็บ (`bcryptjs`) ออก `$2a$12$` ส่วน CLI (Python `bcrypt`) ออก `$2b$12$` — cost 12 และ 60-char เท่ากัน cross-verify ได้ ต่างแค่ตัวอักษร variant; sample ใน `docs/auth-test.md` §13.5 ที่โชว์ทั้งคู่เป็น `$2b$12$` เป็นค่าที่ idealized (จดไว้ในโน้ต IDEA2 แล้ว)
- **operator2 fixture clarification**: `DEV_USERS` ใน `server/db/connection.js` (รวมแถว `operator2`) ถูก gate ด้วย `DATABASE_URL ? [] : [...]` → เมื่อรันโหมด Postgres อาเรย์นี้ **ว่างเปล่า** ไม่เคย mirror/เขียนลง DB จริง ไม่มี collision กับแถว seed จริงใน `seed.sql` (คนละโหมด, in-memory ล้วน, และ seed ใช้ `ON CONFLICT DO NOTHING`)
- **Modified Code Paths**: ไม่มี (verification-only งานพิสูจน์ + เอกสาร ไม่แตะโค้ดฟีเจอร์)
- **Obsidian Updates**: [[03 - 📹 IDEA2 AEGIS Monitor]] (เพิ่มหัวข้อ In-Web Add Operator + แก้กรอบ CLI จาก "only" + finding bcrypt + code paths), [[00 - 🗺️ AEGIS System Overview]] (หมายเหตุ 2026-07-24)
- **Housekeeping**: commit `README.md` แยกเป็น `docs(readme):` (HUB static-only), และ vault นี้เป็น `docs(vault):` แยกจากโค้ดตามคอนเวนชัน
- **Status**: ✅ Part 1 ผ่านจริงทุกข้อกับ Postgres จริง; DB คืน baseline; ไม่แตะ RBAC/`camera_assignment`/โค้ดฟีเจอร์

---

## [2026-07-25] vibe-coding | ต่อท่อ Detection Engine เข้า aegis_monitor DB จริง (ถอด demo generator)
- **User Prompt Goal**: เชื่อม Detection Engine (Python) กับ Monitor DB จริง — engine ยิงผ่าน internal API (ไม่ถือ DB credential), backend เขียน Postgres, ถอด in-memory demo generator, พิสูจน์ end-to-end จริง
- **Architecture**: Detection Engine → `POST /internal/{detections,clips,alerts}` (service key `X-Detection-Engine-Key`) → backend เขียน DB — trust boundary เดิม: มีแต่ backend ของแอปที่แตะฐานตัวเอง
- **Modified Code Paths**:
  - **Monitor backend**: `server/routes/internal.js` [NEW] (3 endpoints), `server/middleware/requireDetectionEngineKey.js` [NEW] (timing-safe, fail-secure, Thai comments), `server/db/store.js` (ถอด generator + seed arrays ทิ้ง; เพิ่ม `insertDetection/insertClip/insertAlert`; เขียน `listDetections/listAlerts/listClips/ackAlert` ใหม่ให้ query Postgres + แปลงรูปทรงกลับให้ frontend), `server/routes/api.js` (await async reads + ส่ง req.user เข้า ackAlert), `server/index.js` (mount `/internal` แยกจาก `/api` ไม่มี CSRF)
  - **Detection Engine**: `aegis_engine/monitor_client.py` [NEW] (HTTP client fail-soft), wired 3 seams — `engine.py._on_detection`, `nas_sync.py._finish_ok` (หลัง verify เท่านั้น), `alert_manager.py._handle` (persist ไม่ว่า Telegram ผลใด)
  - **Gateway**: `gateway/nginx.conf` — `location /monitor/internal/ { return 404; }` (defense-in-depth)
  - **Frontend**: `src/views/Archive.jsx` — guard `segs ?? []` (option A: ไม่มี segs/live clip)
  - **Config**: `docker-compose.yml` + `.env.example` — `DETECTION_ENGINE_API_KEY` (fail-secure default ว่าง)
  - **Docs**: `docs/auth-test.md` §14 (7 ข้อพิสูจน์)
- **Rulings ที่ทำตาม**: (1) ยึด schema.sql เป๊ะ ไม่มี migration (`at`/`frame_id`, severity amber/red, `file_path`); (2) clips option A (derive kind, ไม่มี segs/live clip); (3) gateway 404; (4) sshd NAS ชั่วคราว + `AEGIS_SEGMENT_SECONDS=20` (test override เท่านั้น, default config.py ยัง 600) แล้วรื้อทิ้งหลังทดสอบ
- **Verification (จริง ไม่ smoke-test)**:
  - API key: no key/wrong key → 401; key ถูก body ผิด → เข้า handler (400); gateway `/monitor/internal/*` → 404 (เว็บ path ปกติ 401 = ถึงแอป)
  - รัน DetectionEngine จริงครบ pipeline (deterministic recognizer inject ตรง AI seam + วิดีโอทดสอบ) ในคอนเทนเนอร์บน network เดียวกับ stack ยิง `monitor:8002`: detections รวม tailgating (2 คน/frame แชร์ frame_id, matched_name NULL เมื่อ Unknown); clips 2 แถว `stored_on_nas=t` + `file_path` ชี้ NAS **หลัง** rsync+sha256 verify จริง (ไบต์ 10MB อยู่บน NAS จริง); alerts `telegram_sent=f` (dry-run) แต่ persist ครบ
  - Browser (Playwright): soc เห็น Detection CAM-01/05/06 (การ์ด tailgating 2/2 + ชื่อ Authorized + Unknown%) + Archive ทุกกล้อง; operator เมนูมีแค่ Live/Archive/Diagnostics/Settings (ไม่มี Detection/Alerts) + Archive เห็นแค่ CAM-05
  - restart monitor แล้ว detections/alerts นิ่ง (68/5 คงที่ 30s) = generator หายจริง
  - รื้อ throwaway NAS+engine (containers+images) ทิ้งแล้ว; main stack healthy; `.env` (key จริง) ยัง gitignored
- **Obsidian Updates**: [[03 - 📹 IDEA2 AEGIS Monitor]] (แก้ mermaid: engine→/internal→backend→DB แทน engine→DB ตรง ๆ; เพิ่มหัวข้อ Phase 3 + code paths), [[00 - 🗺️ AEGIS System Overview]] (หมายเหตุ 2026-07-25)
- **Status**: ✅ ครบทุก Phase; ไม่แตะ IDEA1/HUB/Add-Operator/RBAC/camera_assignment; engine ไม่มี DB credential
