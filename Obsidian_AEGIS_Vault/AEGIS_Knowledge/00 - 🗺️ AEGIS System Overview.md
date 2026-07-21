---
title: AEGIS System Overview
tags: [aegis, architecture, overview, monorepo, verified-code]
type: architecture-doc
created: 2026-07-20
updated: 2026-07-21
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🗺️ AEGIS System Architecture Overview

> **Autonomous Edge-Guard Infrastructure System** — ระบบรักษาความปลอดภัยไซเบอร์และกายภาพแบบครบวงจร ออกแบบและพัฒนาด้วยสถาปัตยกรรม Monorepo รองรับภาษาไทยเป็นหลัก (Thai-First UI) ภายใต้ดีไซน์แบบ Cyber-Physical Precision Light

---

## 🏗️ โครงสร้างสถาปัตยกรรมระบบจริงใน Codebase (Monorepo Diagram)

```mermaid
flowchart TD
    User([👤 User Browser])

    subgraph DockerGateway [Docker NGINX Gateway :80]
        NGINX["🌐 NGINX Gateway (gateway/)<br/><i>http://localhost:80</i>"]
    end

    subgraph Frontends [Vite Frontend Dev Servers]
        HUB_UI["🚪 HUB-AEGIS_Entry<br/>(:5173 / Standalone Dev)"]
        DRIVE_UI["💾 AEGIS Drive UI<br/>(:5174 / Standalone Dev)"]
        MONITOR_UI["📹 AEGIS Monitor UI<br/>(:5176 / Standalone Dev)"]
    end

    subgraph Backends [Express Application API Servers]
        HUB_API["⚙️ HUB API (:3001)<br/><i>Auth & Single Gateway</i>"]
        DRIVE_API["⚙️ Drive API (:3002)<br/><i>Secure Data Lake & Vault</i>"]
        MONITOR_API["⚙️ Monitor API (:3003)<br/><i>Unified SOC & Operator View</i>"]
    end

    subgraph IsolatedDBs [PostgreSQL Container (Volume Persisted)]
        DB_DRIVE[("Database: aegis_drive<br/>(users, files, shares)")]
        DB_MONITOR[("Database: aegis_monitor<br/>(users, camera_assignment)")]
    end

    User -->|Local Dev| Frontends
    User -->|Production Docker| NGINX
    NGINX --> HUB_UI
    NGINX --> DRIVE_UI
    NGINX --> MONITOR_UI

    HUB_UI <--> HUB_API
    DRIVE_UI <--> DRIVE_API
    MONITOR_UI <--> MONITOR_API

    DRIVE_API <--> DB_DRIVE
    MONITOR_API <--> DB_MONITOR
```
```

---

## 📌 สรุปสถานะซอร์สโค้ดในโปรเจกต์ (Codebase Implementation Catalog)

| โมดูล | สถานะโค้ด | พอร์ต & ไดเรกทอรี | Link เอกสารละเอียด |
| :--- | :--- | :--- | :--- |
| **HUB-AEGIS_Entry** | ✅ Built & Implemented | Port `:8000` (`HUB-AEGIS_Entry/`) | [[01 - 🚪 HUB-AEGIS Entry]] |
| **IDEA1-AEGIS_Drive_LC** | ✅ Built & Implemented | UI `:5174` / API `:8001` (`IDEA1-AEGIS_Drive_LC/`) | [[02 - 💾 IDEA1 AEGIS Drive LC]] |
| **IDEA2-AEGIS_Monitor** | ✅ Built & Implemented | UI `:5176` / API `:8002` (`IDEA2-AEGIS_Monitor/`) | [[03 - 📹 IDEA2 AEGIS Monitor]] |
| **IDEA3-AEGIS_Lockdown** | 🟢 Code Written | Firmware & Sim (`IDEA3-AEGIS_Lockdown/`) | [[04 - 🔒 IDEA3 AEGIS Lockdown]] |
| **Security Architecture** | 🛡️ Verified in Code | Per-App Identity, OWASP Hardening | [[05 - 🛡️ Security Architecture]] |

---

> **2026-07-21**: Closed-registration account provisioning is now real (not
> demo stubs) in both IDEA1 and IDEA2 — Day-0 admin bootstrap, Admin/CLI
> temp-password issuance, and a Force Password Reset gate enforced on every
> endpoint. No new service/port; see [[02 - 💾 IDEA1 AEGIS Drive LC]],
> [[03 - 📹 IDEA2 AEGIS Monitor]], and [[05 - 🛡️ Security Architecture]].

---

## 🔗 เอกสารที่เกี่ยวข้อง
* [[01 - 🚪 HUB-AEGIS Entry]]
* [[02 - 💾 IDEA1 AEGIS Drive LC]]
* [[03 - 📹 IDEA2 AEGIS Monitor]]
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
* [[05 - 🛡️ Security Architecture]]
