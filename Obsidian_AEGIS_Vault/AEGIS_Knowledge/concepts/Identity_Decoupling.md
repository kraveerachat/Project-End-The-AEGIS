---
title: Identity Decoupling
tags: [aegis, concept, security, identity, rbac]
type: concept
created: 2026-07-20
updated: 2026-07-24
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🔑 Identity Decoupling (v4 Architectural Shift)

> **แนวคิดหลัก**: การตัดการพึ่งพาระบบบัญชีผู้ใช้ร่วมกัน (Centralized RBAC) ระหว่างแอปพลิเคชัน โดยแต่ละแอปพลิเคชันจะมี **User Database และ Role Hierarchy ของตัวเองอย่างอิสระ** เพื่อจำกัดขอบเขตความเสียหายหากถูกโจมตี (Blast Radius Reduction)

---

## 📊 การแบ่งขอบเขตบัญชีผู้ใช้ (Identity Boundaries)

```mermaid
graph LR
    subgraph DriveDB [Database: aegis_drive]
        AdminRole["Admin"]
        UserRole["DataLake-User"]
    end

    subgraph MonitorDB [Database: aegis_monitor]
        SOCRole["SOC-Responder"]
        OpRole["CCTV-Operator"]
        CamAssign["camera_assignment Table"]
    end

    HubNote["🚪 HUB — ไม่มี identity เลย<br/>(static app picker, no DB, no session)"]

    HubNote -.->|hand-off เท่านั้น| DriveDB
    HubNote -.->|hand-off เท่านั้น| MonitorDB
    DriveDB -.->|NO SHARED USERS| MonitorDB
```

| แอปพลิเคชัน | สิทธิ์การใช้งาน (Roles) | ขอบเขตข้อมูล (Data Boundary) |
| :--- | :--- | :--- |
| **[[02 - 💾 IDEA1 AEGIS Drive LC|AEGIS Drive (IDEA 1)]]** | `Admin`, `DataLake-User` | จัดการไฟล์และสิทธิ์การเข้าถึงคลังข้อมูล Data Lake 3 Layers |
| **[[03 - 📹 IDEA2 AEGIS Monitor|AEGIS Monitor (IDEA 2)]]** | `SOC-Responder`, `CCTV-Operator` | ดูภาพรวมระบบกล้อง และดูเฉพาะกล้องที่ผูกใน `camera_assignment` |
| **[[01 - 🚪 HUB-AEGIS Entry\|HUB Entry]]** | **ไม่มี role ใด ๆ** | ไม่มีฐานข้อมูล ไม่มีบัญชี ไม่มี session — เป็นแค่ป้ายบอกทาง |

---

## 🚪 ทำไม HUB จึงต้อง "ไม่มี" identity (2026-07-24)

ถ้า HUB ออก session ของตัวเองแล้วให้แอปปลายทางเชื่อถือ นั่นคือการสร้าง **SSO /
Centralized RBAC** กลับเข้ามา — สิ่งที่สถาปัตยกรรมนี้ตั้งใจกำจัดทิ้งตั้งแต่ v4
เพราะบัญชีเดียวถูกยึด = เข้าถึงได้ทุกแอปทันที (Blast Radius กลับมาใหญ่เท่าเดิม)

ช่วงหนึ่ง HUB เคยมีฟอร์มล็อกอินที่แย่กว่านั้นอีก: มัน **ตรวจรหัสผ่านฝั่ง client**
จากอาเรย์ `DEMO_ACCOUNTS` ที่ฝังใน bundle เมื่อไม่มี backend ตอบ (ซึ่งเป็นจริงเสมอ
เพราะไม่เคยมี service `hub` ใน compose) — แจก session ระดับ Admin โดยไม่มีการบังคับ
ฝั่งเซิร์ฟเวอร์เลย ทั้งฟอร์มและโค้ดนั้นถูกลบทิ้งถาวรเมื่อ 2026-07-24

ตอนนี้ HUB ส่งผู้ใช้ต่อด้วย `window.location.href` เปล่า ๆ **ไม่มี token ไม่มี cookie
ไม่มี query param ติดไปด้วย** แอปปลายทางจึงไม่มีอะไรให้ "เชื่อ" นอกจาก session ของ
ตัวเองที่ผู้ใช้ต้องล็อกอินใหม่ — สาม cookie, สาม secret, สองฐานข้อมูล แยกขาดจริง

---

## ⚠️ ข้อยกเว้นเพียงหนึ่งเดียว (Only Cross-Dependency)
กรณีที่เกิดเหตุภัยคุกคามใน IDEA 2/3 แล้วต้องการปลดบล็อกแฮกเกอร์ด้วย UFW Firewall ในขั้นตอน Incident Recovery ผู้ดูแลระบบจะต้องใช้สิทธิ์ **Admin ของ IDEA 1** เนื่องจาก UFW เป็นบริการของระบบปฏิบัติการ Linux บนเครื่อง NAS Hardware

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[02 - 💾 IDEA1 AEGIS Drive LC]]
* [[03 - 📹 IDEA2 AEGIS Monitor]]
* [[concepts/OWASP_Security_Defense]]
