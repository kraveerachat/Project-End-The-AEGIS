---
title: AEGIS System Overview
tags: [aegis, architecture, overview, monorepo, verified-code]
type: architecture-doc
created: 2026-07-20
updated: 2026-07-25
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🗺️ AEGIS System Architecture Overview

> **Autonomous Edge-Guard Infrastructure System** — ระบบรักษาความปลอดภัยไซเบอร์และกายภาพแบบครบวงจร ออกแบบและพัฒนาด้วยสถาปัตยกรรม Monorepo รองรับภาษาไทยเป็นหลัก (Thai-First UI) ภายใต้ดีไซน์แบบ Cyber-Physical Precision (Dual-Theme Light & Dark Mode, Volumetric Aura Glow, Framer Motion Unfold Physics และ Tailwind CSS v4 `@variant dark`)

---

## 🏗️ โครงสร้างสถาปัตยกรรมระบบจริงใน Codebase (Monorepo Diagram)

```mermaid
flowchart TD
    User([👤 User Browser])

    subgraph DockerGateway [Docker NGINX Gateway :80]
        NGINX["🌐 NGINX Gateway (gateway/)<br/><i>http://localhost:80</i><br/>runtime DNS re-resolve<br/>(resolver 127.0.0.11)"]
    end

    subgraph Frontends [Vite Frontend Dev Servers]
        HUB_UI["🚪 HUB-AEGIS_Entry<br/>(:5173 / Standalone Dev)<br/><b>static app picker — no API</b>"]
        DRIVE_UI["💾 AEGIS Drive UI<br/>(:5174 / Standalone Dev)"]
        MONITOR_UI["📹 AEGIS Monitor UI<br/>(:5176 / Standalone Dev)"]
    end

    subgraph Backends [Express Application API Servers]
        DRIVE_API["⚙️ Drive API (:8001)<br/><i>Secure Data Lake & Vault</i><br/>DRIVE_SESSION_SECRET"]
        MONITOR_API["⚙️ Monitor API (:8002)<br/><i>Unified SOC & Operator View</i><br/>MONITOR_SESSION_SECRET"]
    end

    subgraph MetaLayer ["Metadata Layer — PostgreSQL Container (Volume Persisted)"]
        DB_DRIVE[("Database: aegis_drive<br/>role: drive_app — CONNECT here only<br/>(users, files, shares, audit_log)")]
        DB_MONITOR[("Database: aegis_monitor<br/>role: monitor_app — CONNECT here only<br/>(users, cameras, camera_assignment)")]
    end

    subgraph StoreLayer ["Storage Layer — Docker named volume"]
        VOL_DRIVE[("drive_storage → /datalake<br/>raw file bytes only<br/>NO passwords, NO hashes")]
    end

    subgraph EdgeNode ["Detection Engine — Laptop (VLAN 20)"]
        DE["🎥 Python pipeline<br/>segment_recorder · nas_sync · alert_manager<br/><b>no Postgres credential</b>"]
    end

    User -->|Local Dev| Frontends
    User -->|Production Docker| NGINX
    NGINX --> HUB_UI
    NGINX --> DRIVE_UI
    NGINX --> MONITOR_UI

    HUB_UI -->|"window.location.href<br/>(hand-off, no token passed)"| DRIVE_UI
    HUB_UI -->|"window.location.href"| MONITOR_UI
    DRIVE_UI <--> DRIVE_API
    MONITOR_UI <--> MONITOR_API

    DRIVE_API <--> DB_DRIVE
    MONITOR_API <--> DB_MONITOR
    DRIVE_API <-->|"upload / download bytes"| VOL_DRIVE

    DE -->|"POST /internal/{detections,clips,alerts}<br/>X-Detection-Engine-Key · gateway 404s this path externally"| MONITOR_API
```

> ⚠️ **Session secret แยกต่อแอป (2026-07-22)**: `drive` และ `monitor` ใช้
> `SESSION_SECRET` คนละดอก (`DRIVE_SESSION_SECRET` / `MONITOR_SESSION_SECRET` ใน
> root `.env`) — secret ที่หลุดจากแอปหนึ่งต้องปลอม cookie ของอีกแอปไม่ได้ ถ้าใช้
> ดอกเดียวกัน คนที่ได้ secret ของ Drive จะ sign เซสชัน Monitor ได้ทันที = ทำลาย
> boundary ที่อุตส่าห์แยก `users` ไว้คนละฐาน (ดู [[concepts/Identity_Decoupling]])
>
> ⚠️ **`drive_storage` mount ให้ `drive` เท่านั้น** — `monitor` และ `gateway`
> ไม่มีสิทธิ์แตะไฟล์ของ IDEA1 แม้แต่ระดับ filesystem
>
> ⚠️ **DB role แยกต่อแอป (2026-07-22)**: แต่ละแอปต่อ Postgres ด้วย role ของตัวเอง
> (`drive_app` / `monitor_app`) ที่ถูก `REVOKE CONNECT` ออกจากฐานของอีกฝั่ง —
> การแยกแค่ database โดยใช้ superuser ร่วมกัน **ยังไม่ใช่การแยกจริง** เพราะโปรเซส
> ของ IDEA1 จะถือ credential ที่อ่าน `password_hash` ของ IDEA2 ได้อยู่ดี ตอนนี้ข้าม
> ฐาน = ถูกปฏิเสธตั้งแต่ **ชั้นเปิด connection** superuser `aegis` เหลือหน้าที่แค่
> init/migrate/ตรวจสอบ ไม่มีบริการที่รันอยู่ใช้มันเลย
> (`postgres/init/02-app-roles.sh` · พิสูจน์ใน `docs/auth-test.md` ข้อ 11)
>
> ⚠️ **Gateway re-resolve DNS ตอน runtime (2026-07-23)**: `proxy_pass` ของ
> `/drive/` และ `/monitor/` ชี้ผ่านตัวแปร (`set $drive_upstream drive:8001;`)
> คู่กับ `resolver 127.0.0.11 valid=10s` — ถ้าเขียนชื่อ host ตรง ๆ nginx จะ
> resolve ครั้งเดียวตอนบูตแล้ว cache IP ไว้ตลอด พอ deploy ทีละ service แล้ว
> container ได้ IP ใหม่จะ **502 ค้างถาวร** จนกว่าจะ restart gateway เอง
> (ทดสอบ A/B แล้ว: config เดิม 502 ตลอด / config ใหม่ 200 ไม่ตกเลย)
> หมายเหตุ: `HUB-AEGIS_Entry/nginx.conf` ฝั่ง production ไม่มีปัญหานี้เพราะ
> proxy_pass ไปที่ IP ตรง ๆ ไม่ผ่าน DNS

---

## 📌 สรุปสถานะซอร์สโค้ดในโปรเจกต์ (Codebase Implementation Catalog)

| โมดูล | สถานะโค้ด | พอร์ต & ไดเรกทอรี | Link เอกสารละเอียด |
| :--- | :--- | :--- | :--- |
| **HUB-AEGIS_Entry** | ✅ Static app picker (ไม่มี backend/login) | เสิร์ฟที่ `/` โดย `gateway` (dev UI `:5173`) | [[01 - 🚪 HUB-AEGIS Entry]] |
| **IDEA1-AEGIS_Drive_LC** | ✅ Built & Implemented | UI `:5174` / API `:8001` (`IDEA1-AEGIS_Drive_LC/`) | [[02 - 💾 IDEA1 AEGIS Drive LC]] |
| **IDEA2-AEGIS_Monitor** | ✅ Built & Implemented | UI `:5176` / API `:8002` (`IDEA2-AEGIS_Monitor/`) | [[03 - 📹 IDEA2 AEGIS Monitor]] |
| **IDEA3-AEGIS_Lockdown** | 🟢 Code Written | Firmware & Sim (`IDEA3-AEGIS_Lockdown/`) | [[04 - 🔒 IDEA3 AEGIS Lockdown]] |
| **Security Architecture** | 🛡️ Verified in Code | Per-App Identity, OWASP Hardening | [[05 - 🛡️ Security Architecture]] |

---

> **2026-07-25**: **Unified Split Vault Card Design System (หน้า Login รวมสไตล์)** —
> หน้าเข้าสู่ระบบของทั้ง **AEGIS Drive** (`http://localhost/drive/`) และ **AEGIS Monitor** (`http://localhost/monitor/`)
> ถูกยกระดับให้ใช้ดีไซน์ **Split Vault Card** (50/50 Split Panel) เดียวกันตามมาตรฐานระบบ:
> - **Left Brand Panel**: Levitating metallic AEGIS emblem (`AegisMark`), `AEGIS` title, และ gradient tagline `AUTONOMOUS EDGE-GUARD INFRASTRUCTURE SYSTEM` บนพื้นหลัง Cyber-Physical Dark Background (`.gate-bg`, `.gate-halo`)
> - **Right Form Panel**: คอนโทรล `PillInput` (พร้อมปุ่มสลับการมองเห็นรหัสผ่าน), สวิตช์ `Toggle` จดจำเซสชัน, ปุ่มหลัก `SparkleButton` ( hover/particle physics), และ แถบแสดงสถานะความปลอดภัย 4 ชั้น **Defense-in-Depth Readout** (`LAYER 0 · NETWORK` vpn/vlan, `LAYER 1 · APPLICATION` credentials, `LAYER 2 · STORAGE` encrypted at rest, `LAYER 3 · METADATA` postgresql) พร้อมลวดลายทแยง `.hatch-fine` สำหรับสถานะ pending
> - **Header Chrome & i18n**: แถบเลือกภาษา (`TH`, `EN`, `ZH`) ผ่าน `Segmented` control และปุ่มสลับ `ThemeToggle`
> - **Identity Decoupling Preserved**: สถาปัตยกรรมยังคงการแยกฐานข้อมูล `aegis_drive` และ `aegis_monitor`, DB Roles (`drive_app` / `monitor_app`), และ session cookie แยกขาดจากกัน 100%
>
> **2026-07-25**: IDEA2 **Detection Engine ↔ DB wiring** is real — the Python
> engine (Laptop, VLAN 20) persists `detections`/`clips`/`alerts` by POSTing to
> Monitor's new `/internal/*` endpoints (service key `X-Detection-Engine-Key`,
> **no direct Postgres credential** — only Monitor's backend writes its own DB).
> The in-memory demo generators are removed; the web reads real rows. `clips`
> land only after `nas_sync` sha256-verifies the NAS transfer; alerts persist
> regardless of Telegram outcome. **Both** nginx configs now block
> `/monitor/internal/*` (404) as defense-in-depth — the dev gateway with a literal
> prefix, production (`HUB-AEGIS_Entry/nginx.conf`) with a **case-insensitive**
> `location ~* ^/monitor/internal(/|$)` because Express matches paths
> case-insensitively and a literal guard is bypassable via `/monitor/Internal/…`.
> Verified E2E in `docs/auth-test.md` §14; see [[03 - 📹 IDEA2 AEGIS Monitor]].
>
> **2026-07-26**: production HUB routing fixed for **both** apps — `nginx.conf`
> now strips the `/drive` and `/monitor` prefixes (`rewrite … break`) before
> proxying, because both Express apps mount static + `/api` at ROOT. Previously
> every asset came back as `index.html` (blank page) and `POST /{app}/api/login`
> returned 404. `Host`/`X-Forwarded-Host` also moved from `$host` to `$http_host`
> so the CSRF origin check keeps working if the deployment port ever leaves `:443`.
> See [[01 - 🚪 HUB-AEGIS Entry]].
>
> **2026-07-24**: IDEA2 gains an in-web **Add Operator** path (SOC-Responder
> only) — `POST /monitor/api/operators`, guarded by `requireRole` and backed
> by the same `store.provisionOperator()` constants (`USERNAME_RE`,
> `BCRYPT_COST=12`, `must_reset` default TRUE) as the SSH CLI, so web- and
> CLI-made operators land the same shape in `users`/`camera_assignment`. Temp
> password is returned once (never logged) and the new account is Scoped-View
> bound to its camera. No new service/port — same `:8002` API. Verified E2E in
> `docs/auth-test.md` §13; details in [[03 - 📹 IDEA2 AEGIS Monitor]].

---

## 🚧 งานที่ยังเปิดอยู่ (Open / Outstanding — ยังไม่ถือว่าเสร็จ)

รายการที่ **ออกแบบ/ตั้งใจไว้แต่ยังไม่ได้ build จริง** — จงใจแยกออกจากของที่ ✅ ด้านบน
เพื่อไม่ให้ถูกเข้าใจผิดว่าทำเสร็จแล้ว (สถานะ ณ 2026-07-25):

| งาน | สถานะ | หมายเหตุ |
| :--- | :--- | :--- |
| **Snapshots & Recovery (IDEA1)** | 🔴 Open | ออกแบบไว้ (capture-on-write + rollback กัน Ransomware) แต่ยังไม่มีตาราง `snapshots`/โค้ดจริง — `Snapshots.jsx` ยังอ่าน array ในหน่วยความจำ |
| ~~**Vault persistence (IDEA1)**~~ | ✅ **ปิดแล้ว 2026-07-26** | ต่อท่อครบวงจร: **Argon2id → KEK + envelope AES-256-GCM ต่อไฟล์**, ciphertext เก็บเป็น `.aegisenc` บน Storage Layer, metadata ต่อผู้ใช้ใน `vault_meta`/`vault_blobs`, มี setup/unlock/upload/download/lock + idle auto-lock 10 นาที — รอด restart แล้ว (29 เทสต์ผ่าน) ดู [[02 - 💾 IDEA1 AEGIS Drive LC]] |
| **Secure Shares — VLAN/UFW enforcement (IDEA1)** | 🔴 Open | UI แชร์ (`Shares.jsx`) มีอยู่ แต่การบังคับจำกัด VLAN/subnet ผ่าน UFW ระดับ Network Layer **ยังไม่ได้ต่อจริง** — ตอนนี้เป็น design/stub |
| **Report ↔ KB: shared vs separate storage** | 🟠 ต้อง reconcile | KB ยืนยันแล้วว่า Storage เป็นของ IDEA1 **แยก** (monitor ไม่ mount) แต่เอกสาร Design/report ต้นทางบางจุดยังบรรยายว่า NAS เก็บรวมของทุกระบบ — ต้องปรับ report ให้ตรงความจริงของโค้ด (flag ไว้ตั้งแต่ TASK 3, log 2026-07-22) |

> ของที่ **เสร็จจริงและพิสูจน์แล้ว** อยู่ในตาราง Codebase Implementation Catalog ด้านบน
> + `docs/auth-test.md` (§1–14): identity decoupling (บัญชี + DB role), Storage Layer,
> HUB app-picker, Add Operator (CLI+web), Detection Engine → DB wiring

---

## 🔗 เอกสารที่เกี่ยวข้อง
* [[01 - 🚪 HUB-AEGIS Entry]]
* [[02 - 💾 IDEA1 AEGIS Drive LC]]
* [[03 - 📹 IDEA2 AEGIS Monitor]]
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
* [[05 - 🛡️ Security Architecture]]
