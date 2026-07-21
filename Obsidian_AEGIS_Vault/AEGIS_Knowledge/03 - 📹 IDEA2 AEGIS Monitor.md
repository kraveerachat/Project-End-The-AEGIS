---
title: IDEA2 AEGIS Monitor
tags: [aegis, monitor, cctv, soc, face-recognition, dual-view]
type: module-doc
created: 2026-07-20
updated: 2026-07-21
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 📹 IDEA2: AEGIS Monitor (Dual-View SOC & CCTV Operator)

> **สถานะโค้ดปัจจุบัน (Code Status)**: ✅ Built & Implemented (Backend Express `:8002` + Single Unified React App `:5176` + Database `aegis_monitor` + Python Detection Engine)  
> **ไฟล์โค้ดหลัก**: `IDEA2-AEGIS_Monitor/server/`, `IDEA2-AEGIS_Monitor/src/`, `IDEA2-AEGIS_CCTV-Operator/detection-engine/`

---

## 📽️ สถาปัตยกรรมระบบที่พัฒนาขึ้นจริง (Verified Architecture)

```mermaid
flowchart TD
    subgraph EdgeEngine [Detection Engine (Laptop Edge Node)]
        CamFeed["CCTV Camera Feeds"] --> FaceRec["Python Face Recognition Engine"]
        FaceRec -->|10-min Clips + Snapshots| MonitorDB[("Database: aegis_monitor<br/>(owns camera_assignment)")]
    end

    subgraph BackendServer [AEGIS Monitor Server :8002]
        SessionAuth["Server Session & Role Resolver"]
        CameraResolver["Camera Access Control<br/>(Server JOIN camera_assignment)"]
    end

    subgraph ClientViews [Unified React App :5176]
        SOCView["🛡️ SOC-Responder View<br/>(Aggregate Overview, All Cameras & System Stream)"]
        OpView["🎥 CCTV-Operator View<br/>(Scoped View, Assigned Cameras Only + Self-Diagnostics)"]
    end

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

1. **Single App, Server-Resolved Dual Views**:
   * รวมการทำงานของศูนย์ควบคุม SOC และ CCTV Operator ไว้ในแอปพลิเคชันเดียว โดยเซิร์ฟเวอร์ฝั่ง Backend `:8002` จะเป็นผู้ระบุบทบาทและกรอง Payload ส่งให้หน้าจอแบบอัตโนมัติ
2. **Server-Side Camera JOIN Enforcement**:
   * ตาราง `camera_assignment` จัดเก็บและเป็นเจ้าของโดยฐานข้อมูล `aegis_monitor`
   * ทุก Request คำสั่งขอกล้องของผู้ใช้บทบาท `CCTV-Operator` จะถูกจับ JOIN กับตาราง `camera_assignment` ฝั่งเซิร์ฟเวอร์ หากส่ง Request ระบุ ID กล้องที่ตนไม่มีสิทธิ์ จะได้รับ `403 Forbidden` ทันที
3. **Scoped View & Hidden Menus**:
   * บทบาท `CCTV-Operator` จะสโคปภาพเห็นเฉพาะกล้องที่ได้รับมอบหมาย เมนู Alerts และ Detection Log ระดับระบบจะถูกซ่อนไว้โดยอัตโนมัติ
4. **Camera Self-Diagnostics**:
   * หน้าจอ Operator แสดงกราฟการตรวจวินิจฉัยสุขภาพกล้อง (Heartbeat, Latency, FPS, Uptime, จำนวนครั้งที่สัญญาณขาด) เพื่อการดูแลรักษาเชิงรุก

---

## 🆕 SSH-only Operator Provisioning CLI (2026-07-21)

`server/cli/manage_users.py` — the **only** supported way to provision real
`CCTV-Operator` accounts. Deliberately not a web endpoint: every write route
a web app exposes is attack surface the edge box doesn't need, and the
in-app "Operators" screen's own `pgAddOperator()` (`server/db/store.js`)
already documents the gap this closes in its own comment — it issues a
random temp password *that is never shown to anyone*, making that account
permanently unusable.

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

---

## 📂 รายการไฟล์ซอร์สโค้ดสำคัญ (Codebase Paths)
* `IDEA2-AEGIS_Monitor/server/index.js` - Express API Server (`:8002`)
* `IDEA2-AEGIS_Monitor/src/App.jsx` - Main Unified Routing and View Resolver
* `IDEA2-AEGIS_CCTV-Operator/detection-engine/` - Python Face Recognition & Camera Capture Engine
* `shared/db-schema/` - Central Schema Specification สำหรับตาราง `camera_assignment`
* `IDEA2-AEGIS_Monitor/server/cli/manage_users.py` - CLI provisioning (SSH-only) สร้าง `CCTV-Operator` + มอบหมายกล้อง

---

## 🔗 เอกสารที่เกี่ยวข้อง
* [[00 - 🗺️ AEGIS System Overview]]
* [[01 - 🚪 HUB-AEGIS Entry]]
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
* [[concepts/Identity_Decoupling]]
