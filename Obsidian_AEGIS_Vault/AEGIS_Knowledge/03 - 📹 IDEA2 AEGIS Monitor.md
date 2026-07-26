---
title: IDEA2 AEGIS Monitor
tags: [aegis, monitor, cctv, soc, face-recognition, dual-view]
type: module-doc
created: 2026-07-20
updated: 2026-07-25
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 📹 IDEA2: AEGIS Monitor (Dual-View SOC & CCTV Operator)

> **สถานะโค้ดปัจจุบัน (Code Status)**: ✅ Built & Implemented (Backend Express `:8002` + Single Unified React App `:5176` + Database `aegis_monitor` + Python Detection Engine **ต่อท่อเข้า DB จริงผ่าน internal API แล้ว** — ถอด in-memory demo generator ทิ้งทั้งหมด)  
> **ไฟล์โค้ดหลัก**: `IDEA2-AEGIS_Monitor/server/`, `IDEA2-AEGIS_Monitor/src/`, `IDEA2-AEGIS_CCTV-Operator/detection-engine/`

---

## 📽️ สถาปัตยกรรมระบบที่พัฒนาขึ้นจริง (Verified Architecture)

```mermaid
flowchart TD
    subgraph EdgeEngine [Detection Engine (Laptop Edge Node, VLAN 20)]
        CamFeed["CCTV Camera Feeds"] --> FaceRec["Python Face Recognition Engine"]
        FaceRec -->|"~10-min segments<br/>(rsync + sha256 verify)"| NAS[("Local NAS<br/>raw video bytes")]
    end

    subgraph BackendServer [AEGIS Monitor Server :8002]
        Internal["/internal ingest endpoints<br/>X-Detection-Engine-Key (no DB creds)"]
        SessionAuth["Server Session & Role Resolver"]
        CameraResolver["Camera Access Control<br/>(Server JOIN camera_assignment)"]
    end

    subgraph ClientViews [Unified React App :5176]
        SOCView["🛡️ SOC-Responder View<br/>(Aggregate Overview, All Cameras & System Stream)"]
        OpView["🎥 CCTV-Operator View<br/>(Scoped View, Assigned Cameras Only + Self-Diagnostics)"]
    end

    FaceRec -->|"POST /internal/{detections,clips,alerts}<br/>HTTP + API key — engine ไม่ถือ DB credential"| Internal
    Internal -->|"backend เขียนแถวจริง"| MonitorDB[("Database: aegis_monitor<br/>(owns camera_assignment)")]
    MonitorDB <--> BackendServer
    BackendServer -->|Role: SOC-Responder| SOCView
    BackendServer -->|Role: CCTV-Operator| CameraResolver
    CameraResolver -->|Filtered Payload| OpView

    classDef socStyle fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#fff;
    classDef opStyle fill:#0f172a,stroke:#4ade80,stroke-width:2px,color:#fff;
    class SOCView socStyle;
    class OpView opStyle;
```

---

## 🔐 ฟีเจอร์หลักและการควบคุมสิทธิ์ฝั่ง Server (Implemented Features)

1. **Unified Split Vault Card Login Page, Dual Theme & Motion Physics (2026-07-25)**:
   * อัปเกรดหน้า Login จากเดิมที่เป็นการ์ดใบเล็กเรียบๆ ให้เป็น **50/50 Split Panel Card** บนพื้นหลัง Cyber-Physical Dark/Light Grid (`.gate-bg`, `.gate-halo`)
   * **Volumetric Aura Glow Layer**: เพิ่มเลเยอร์แสงเรืองซ้อนด้านหลังการ์ดหลัก (`absolute -inset-2 blur-2xl opacity-70`) เล่นแอนิเมชันหายใจช้าๆ — แสง Electric Cyan & Sky-Blue (`shadow-[0_0_70px_15px_rgba(6,182,212,0.35)]`) ในโหมดสว่าง และแสง Neon Purple & Fuchsia Plasma (`dark:shadow-[0_0_80px_20px_rgba(168,85,247,0.4)]`) ในโหมดมืด
   * **Left Panel & Logo Emblem (180px)**: ขยายตราสัญลักษณ์ AEGIS Mark ขนาดใหญ่ `180px` พร้อมออร่าแสงหายใจ (Breathing Backlight Aura 4s) ชื่อแบรนด์ `AEGIS` และ Tagline สี Gradient
   * **Framer Motion Unfold Entrance & Tactile Physics**: การ์ดกางตัวด้วย Spring Physics (`stiffness: 260, damping: 20`), แถบความปลอดภัย 4 เลเยอร์สไลด์ขึ้นแบบ Staggered (`staggerChildren: 0.08s`), Card Hover 3D Tilt และ Active Micro-compression (`whileTap={{ scale: 0.995 }}`)
   * **Tailwind CSS v4 `@variant dark` Fix**: กำหนดสเปค `@variant dark (&:where(.dark, .dark *));` ใน `index.css` ป้องกันปัญหา Tailwind v4 บังคับอ่าน OS Theme พากดสลับโหมดสว่าง-มืดผ่าน React State
   * **Complete i18n & Theme Chrome**: รองรับ 3 ภาษา (`TH`, `EN`, `ZH`) พร้อมสวิตช์ `ThemeToggle`
2. **Single App, Server-Resolved Dual Views**:
   * รวมการทำงานของศูนย์ควบคุม SOC และ CCTV Operator ไว้ในแอปพลิเคชันเดียว โดยเซิร์ฟเวอร์ฝั่ง Backend `:8002` จะเป็นผู้ระบุบทบาทและกรอง Payload ส่งให้หน้าจอแบบอัตโนมัติ
3. **Server-Side Camera JOIN Enforcement**:
   * ตาราง `camera_assignment` จัดเก็บและเป็นเจ้าของโดยฐานข้อมูล `aegis_monitor`
   * ทุก Request คำสั่งขอกล้องของผู้ใช้บทบาท `CCTV-Operator` จะถูกจับ JOIN กับตาราง `camera_assignment` ฝั่งเซิร์ฟเวอร์ หากส่ง Request ระบุ ID กล้องที่ตนไม่มีสิทธิ์ จะได้รับ `403 Forbidden` ทันที
   * **บัญชีเดโม่มี operator สองคน (2026-07-22)**: `operator` → CAM-05 และ
     `operator2` → CAM-06 (`server/db/seed.sql`) — operator คนเดียวพิสูจน์ได้แค่
     "เห็นน้อยกว่า SOC" แต่สิ่งที่ต้องพิสูจน์จริงคือ **operator A มองไม่เห็นกล้องของ
     operator B**: `operator` ยิงขอ CAM-06 → `403` และ `operator2` ยิงขอ CAM-05 → `403`
     (ผลตรวจจริงอยู่ใน `docs/auth-test.md` ข้อ 3–5)
   * `soc` (SOC-Responder) **ไม่มีแถวใน `camera_assignment` เลย** = เห็นทุกกล้อง —
     การไม่มีแถวคือ "สิทธิ์เต็ม" โดยเจตนา ไม่ใช่ช่องโหว่: `getVisibleCameras()`
     แยกเส้นทาง SOC ออกก่อนถึง JOIN (`server/db/connection.js`)
4. **Scoped View & Hidden Menus**:
   * บทบาท `CCTV-Operator` จะสโคปภาพเห็นเฉพาะกล้องที่ได้รับมอบหมาย เมนู Alerts และ Detection Log ระดับระบบจะถูกซ่อนไว้โดยอัตโนมัติ
5. **Camera Self-Diagnostics**:
   * หน้าจอ Operator แสดงกราฟการตรวจวินิจฉัยสุขภาพกล้อง (Heartbeat, Latency, FPS, Uptime, จำนวนครั้งที่สัญญาณขาด) เพื่อการดูแลรักษาเชิงรุก

---

## 🆕 SSH-only Operator Provisioning CLI (2026-07-21)

`server/cli/manage_users.py` — the **SSH** path for provisioning real
`CCTV-Operator` accounts (there is now also an in-web SOC-only path, below —
the two share one rule set, see the next section). Password entry is
interactive `getpass` and hashing (bcrypt cost 12) happens locally before it
ever reaches Postgres.

* `python server/cli/manage_users.py add-operator --username … --display-name … --camera CAM-05`
  — password entered twice via `getpass` (never a CLI arg, never in shell
  history/`ps`), bcrypt-hashed locally (cost 12) before it ever reaches
  Postgres. Account creation + all `camera_assignment` writes happen in a
  single transaction (bad camera id or duplicate username rolls back
  cleanly). Reassigning a camera already held by someone else prompts for
  confirmation (`--yes` to skip).
* `list-cameras` / `list-operators` — read-only helpers.
* Connects via `DATABASE_URL` from the shell environment (same variable the
  Node app uses) — never a hardcoded credential.
* Created accounts get `must_reset_password = TRUE` (new `users` column,
  mirrors IDEA1) — `server/middleware/requireRole.js` now blocks every
  endpoint except `/me`, `/logout`, and the new `POST /api/password/reset`
  until the operator sets their own password on first login.
* IDEA2 has no `audit_log` table yet (unlike IDEA1), so the CLI prints a
  `provisioned by <user>@<host> at <UTC time>` line for the admin's own SSH
  session scrollback to carry instead — see `server/cli/README.md` for the
  full reasoning and why there's intentionally no `--password` flag.
* `add-operator` now takes `--role` (`CCTV-Operator` default, or
  `SOC-Responder`) instead of hardcoding one role, plus two opt-in flags for
  scripted local test-fixture provisioning: `--password-stdin` (pipe the
  password instead of an interactive `getpass` prompt) and
  `--skip-force-reset` (account is usable with that exact password
  immediately). Both default off — real provisioning is unaffected.

---

## 🆕 In-Web "Add Operator" — SOC-only endpoint (2026-07-24)

SOC-Responder can now provision a `CCTV-Operator` **from the web UI** (the
*Nodes & routing* view) without SSH — `POST /monitor/api/operators`. The CLI
above stays as-is; the two are separate routes that are held to **identical
results**, not a shared function (Node vs Python can't share an object).

* **One source of truth for the Node path**: `store.provisionOperator()`
  (`server/db/store.js`) backs the endpoint. Username validation
  (`USERNAME_RE`), `BCRYPT_COST = 12`, and `must_reset_password` default TRUE
  are exported constants deliberately kept equal to `manage_users.py`, so a
  web-created account and a CLI-created account land the **same shape** in the
  same `users` / `camera_assignment` tables under the same CHECK/PK.
* **Server-side enforced, not UI-hidden**: `requireRole('SOC-Responder')`
  guards the route — a `CCTV-Operator` hitting it directly with `curl` gets
  `403` regardless of what the UI shows. Camera-availability for the form's
  dropdown is decided server-side too (`GET /operators/available-cameras`):
  a camera already owned is filtered out, and a forged request for a taken
  camera is rejected `409` **inside the same transaction** as the INSERT, so
  no orphan account is ever left behind.
* **One-time temp password**: generated server-side (~24-char base64url),
  returned **once** in the response body, shown in a copy-once modal
  (`TempPasswordModal` in `src/views/Nodes.jsx`) with a "won't be shown
  again" warning. It is **never logged** anywhere — only the bcrypt hash
  reaches the DB. The new account carries `must_reset_password = TRUE`, so it
  is gated out of every endpoint except `/me`, `/logout`, `/password/reset`
  until it sets its own password, then it is Scoped-View bound to exactly its
  assigned camera — identical to a CLI-made account.
* ⚠️ **Note on bcrypt version prefix (verification finding, 2026-07-24)**: the
  web path hashes with Node `bcryptjs` → `$2a$12$`, the CLI with Python
  `bcrypt` → `$2b$12$`. Both are cost-12, 60-char, cross-verifiable bcrypt —
  the security property (cost) is identical; only the algorithm-variant letter
  differs. The equality that holds across both paths is
  role/active/must_reset/cost-12/hash-len-60, **not** the `$2a`/`$2b` letter.
  (`docs/auth-test.md` §13.5's sample showing both as `$2b$12$` is idealized.)
* **Proven end-to-end** against real Postgres in `docs/auth-test.md` §13
  (§13.1 `201` + one-time password not in logs, §13.2 `409` + rollback,
  §13.3 non-SOC `403`, §13.4 new operator scoped to its camera, §13.5 web-vs-CLI
  row parity) — the exact same Scoped-View guarantees as §3–5.

---

## 🆕 Detection Engine ↔ DB wiring (Phase 3, 2026-07-25)

Detection Engine (Python, Laptop VLAN 20) ต่อเข้ากับ `aegis_monitor` **จริง** แล้ว —
เลิกใช้ตัวจำลอง in-memory (`store.js` generator ถูกถอดทิ้งทั้งหมด) ข้อมูล
`detections`/`clips`/`alerts` มาจาก engine จริงที่ยิงผ่าน **internal API** ของ backend

* **Trust boundary คงเดิม**: Detection Engine **ไม่ถือ credential ต่อ Postgres** — ยิง
  `POST /internal/{detections,clips,alerts}` ผ่าน HTTP ยืนยันด้วย service key
  `X-Detection-Engine-Key` (คนละกลไกกับ session/CSRF ของผู้ใช้; ไม่ผูก role) มีแต่
  backend ของ Monitor ที่แตะฐานของตัวเอง ถ้า Laptop ถูกยึด ก็แตะ DB ตรง ๆ ไม่ได้
  (`server/middleware/requireDetectionEngineKey.js` — timing-safe, fail-secure: ไม่ตั้ง
  `DETECTION_ENGINE_API_KEY` = `/internal` ปิดตาย 503)
* **สาม seams ฝั่ง engine** (fail-soft ทุกจุด — Monitor ล่มชั่วคราวไม่ทำ pipeline พัง,
  หลักเดียวกับ "NAS ล่ม → Local Cache"): `engine.py._on_detection` (ทุกเฟรมที่มีหน้า →
  หนึ่ง event หลาย entity, backend เขียนหนึ่งแถวต่อคน แชร์ `frame_id`);
  `nas_sync.py._finish_ok` (**หลัง** verify sha256 บน NAS สำเร็จเท่านั้น → `stored_on_nas=TRUE`
  ไม่มีทาง optimistic); `alert_manager.py._handle` (persist **หลัง** พยายามส่ง Telegram
  เสมอ ไม่ว่าจะสำเร็จหรือล่ม)
* **Edge hardening — บล็อกแล้วทั้งสอง config (defense-in-depth ทับ API key อีกชั้น)**:
  `/internal` ต้องเข้าถึงจาก **ในเครือข่าย** ตรงที่ `monitor:8002` / `192.168.10.12:8002`
  เท่านั้น (VLAN 20/LAN) ไม่ใช่ผ่านประตูสาธารณะ
  * `gateway/nginx.conf` (สแตก localhost): `location /monitor/internal/ { return 404; }`
  * `HUB-AEGIS_Entry/nginx.conf` (production, **เพิ่มแล้ว 2026-07-26**):
    `location ~* ^/monitor/internal(/|$) { return 404; }`
  > ✅ **แก้แล้วในคอมมิตเดียวกับ routing fix ของ `/monitor` (2026-07-26)** — เดิม
  > production ไม่มี guard นี้เลย และ `/monitor/internal/*` ถูกบังไว้ด้วย **"บั๊ก" ไม่ใช่นโยบาย**
  > (prefix ไม่ถูกตัด → Express ตอบ `Cannot POST /monitor/internal/detections` 404
  > และ `GET /monitor/internal/anything` ตอบ `200` index.html) การเติม rewrite เพียงลำพัง
  > จะเปลี่ยนมันเป็น ingest ที่ยิงได้จริงจากพอร์ต 443 ทันที จึงต้องมาพร้อมกัน
  >
  > 🔴 **ทำไม production ใช้ regex `~*` ไม่ใช่ literal prefix แบบ gateway**: nginx prefix
  > location เป็น **case-sensitive** แต่ **Express match แบบ case-INSENSITIVE ตามค่าเริ่มต้น**
  > — วัดจริงกับ `monitor:8002`: `POST /Internal/detections` · `/INTERNAL/detections` ·
  > `/internal/Detections` → **`201 Created` ทั้งหมด** ⇒ guard แบบตัวอักษรตรง ๆ ถูกข้ามได้
  > ด้วย `/monitor/Internal/detections` **⚠️ `gateway/nginx.conf` ยังมีช่องนี้อยู่ (ยังไม่แก้)**
  >
  > ผลวัดหลังแก้: 14 คำขอผ่าน edge (มี/ไม่มี key · case variants · `//` · `%2F` · `./` ·
  > query string) ได้ `404` ของ nginx เอง และ **เขียนลง DB ศูนย์แถว** ขณะที่ payload
  > เดียวกันยิงตรงไป `monitor:8002` ได้ `201` — ดู [[01 - 🚪 HUB-AEGIS Entry]]
* **เว็บอ่านจากตารางจริง**: `listDetections`/`listAlerts`/`listClips` เขียนใหม่ให้ query
  Postgres แล้วแปลงกลับเป็นรูปทรงที่ frontend ใช้ (detections group ตาม `frame_id` →
  `people[]`; clips **option A** — ไม่มี segs, ไม่มี live clip, `kind` ('auth'/'unknown')
  ได้จากการเช็ค Unknown detection ในช่วงเวลาคลิป) กรองด้วย `camera_assignment` ฝั่ง server
  เหมือนเดิม → soc เห็นทุกกล้อง, operator เห็นเฉพาะกล้องตน (พิสูจน์จริง `docs/auth-test.md` §14)
* **Schema note**: ยึดคอลัมน์ตาม `schema.sql` เป๊ะ (`detections.at`, `frame_id`,
  `result CHECK IN ('Authorized','Unknown')`; `alerts.severity CHECK IN ('amber','red')`
  — engine map `'warning'→'amber'`; `alerts.type/telegram_sent/acked`; `clips.file_path`)
  ไม่มี migration ใหม่

## 📂 รายการไฟล์ซอร์สโค้ดสำคัญ (Codebase Paths)
* `IDEA2-AEGIS_Monitor/server/index.js` - Express API Server (`:8002`)
* `IDEA2-AEGIS_Monitor/src/App.jsx` - Main Unified Routing and View Resolver
* `IDEA2-AEGIS_CCTV-Operator/detection-engine/` - Python Face Recognition & Camera Capture Engine
* `shared/db-schema/` - Central Schema Specification สำหรับตาราง `camera_assignment`
* `IDEA2-AEGIS_Monitor/server/cli/manage_users.py` - CLI provisioning (SSH path) สร้าง `CCTV-Operator` + มอบหมายกล้อง
* `IDEA2-AEGIS_Monitor/server/db/store.js` - `provisionOperator()` + exported `USERNAME_RE`/`BCRYPT_COST` (แหล่งความจริงของเส้นทางเว็บ)
* `IDEA2-AEGIS_Monitor/server/routes/api.js` - `POST /operators` (SOC-only) + `GET /operators/available-cameras`
* `IDEA2-AEGIS_Monitor/src/views/Nodes.jsx` - ฟอร์ม "Add operator" + `TempPasswordModal` (แสดงรหัสครั้งเดียว + ปุ่ม copy)
* `IDEA2-AEGIS_Monitor/server/routes/internal.js` - `POST /internal/{detections,clips,alerts}` (Detection Engine ingest)
* `IDEA2-AEGIS_Monitor/server/middleware/requireDetectionEngineKey.js` - ด่าน API key (timing-safe, fail-secure, Thai-commented)
* `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/monitor_client.py` - HTTP client (fail-soft) ยิงเข้า `/internal`
* `.../detection-engine/aegis_engine/{engine,nas_sync,alert_manager}.py` - สาม seams ที่เรียก monitor_client
* `gateway/nginx.conf` - `location /monitor/internal/ { return 404; }` (บล็อกจากภายนอก · dev stack)
* `HUB-AEGIS_Entry/nginx.conf` - `location ~* ^/monitor/internal(/|$) { return 404; }`
  (production · case-insensitive) + `rewrite ^/monitor/?(.*)$ /$1 break;` ตัด prefix ให้ Express
  ที่ mount ทุกอย่างที่ root + `proxy_set_header Host $http_host` (คงพอร์ตไว้เพื่อ CSRF Origin check)

---

## 🔗 เอกสารที่เกี่ยวข้อง
* [[00 - 🗺️ AEGIS System Overview]]
* [[01 - 🚪 HUB-AEGIS Entry]]
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
* [[concepts/Identity_Decoupling]]
