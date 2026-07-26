---
title: Identity Decoupling
tags: [aegis, concept, security, identity, rbac]
type: concept
created: 2026-07-20
updated: 2026-07-25
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

## 🛡️ บังคับที่ "สามชั้น" ไม่ใช่แค่ convention (2026-07-22)

Identity Decoupling ไม่ได้อยู่แค่ "ตกลงกันว่าจะแยก" — มันถูกบังคับที่กลไกจริงสามชั้น
ที่ทับซ้อนกัน ต่อให้ชั้นหนึ่งพลาด อีกสองชั้นยังกันอยู่:

1. **ชั้นบัญชี (Account)** — แต่ละแอปมีตาราง `users` + role hierarchy ของตัวเองในคนละ
   ฐานข้อมูล ไม่มี foreign key เชื่อมถึงกัน (ตารางด้านบน) บัญชีของ Monitor ล็อกอินเข้า
   Drive ไม่ได้เพราะเป็นคนละตารางคนละฐาน

2. **ชั้นฐานข้อมูล (Postgres engine — REVOKE CONNECT)** — การแยกแค่ "คนละ database"
   **ยังไม่พอ** ถ้าทั้งสองแอปต่อด้วย superuser ตัวเดียวกัน เพราะโปรเซสของ IDEA1 จะถือ
   credential ที่ `\c aegis_monitor` แล้วอ่าน `password_hash` ของ IDEA2 ได้ทันที ตอนนี้:
   * แต่ละแอปต่อด้วย **DB role ของตัวเอง** — `drive_app` (ต่อได้เฉพาะ `aegis_drive`),
     `monitor_app` (ต่อได้เฉพาะ `aegis_monitor`)
   * **กุญแจคือ `REVOKE CONNECT … FROM PUBLIC`**: PostgreSQL แจก `CONNECT` ของทุก
     database ให้ `PUBLIC` โดยดีฟอลต์ — ถ้า `GRANT` ให้ role ที่ถูกต้องโดย **ไม่ถอนของ
     PUBLIC ก่อน** การแยกจะไม่เกิดขึ้นเลย จุดนี้เคยเป็นช่องโหว่ superuser-sharing ที่ปิดไป
   * ผลคือการยิงข้ามฐานถูกปฏิเสธที่ **ชั้นเปิด connection** ไม่ใช่ชั้น query — SQL injection
     จุดใดจุดหนึ่งใน IDEA1 จึงไปแตะข้อมูล IDEA2 ไม่ได้เลย superuser `aegis` เหลือหน้าที่
     แค่ init/migrate/ตรวจสอบ (`postgres/init/02-app-roles.sh`; พิสูจน์ `docs/auth-test.md` §11)

3. **ชั้นเซสชัน (Session secret)** — `drive` และ `monitor` เซ็น cookie ด้วย
   `SESSION_SECRET` **คนละดอก** (`DRIVE_SESSION_SECRET` / `MONITOR_SESSION_SECRET`) —
   secret ที่หลุดจากแอปหนึ่งปลอม cookie ของอีกแอปไม่ได้ ถ้าใช้ดอกเดียวกัน คนที่ได้ secret
   ของ Drive จะ sign เซสชัน Monitor ได้ทันที = ทำลาย boundary ที่อุตส่าห์แยก `users` ไว้

> เสริม (2026-07-25): Detection Engine (VLAN 20) ก็อยู่ใต้หลักเดียวกัน — มัน **ไม่ถือ
> credential ต่อ Postgres** เลย เขียนข้อมูลผ่าน `/internal` ของ Monitor backend (API key)
> เท่านั้น มีแต่ backend ของแอปที่แตะฐานของตัวเอง (ดู [[03 - 📹 IDEA2 AEGIS Monitor]])

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
