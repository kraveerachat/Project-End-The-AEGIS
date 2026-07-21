---
title: Security Architecture
tags: [aegis, security, owasp, rbac, authentication]
type: architecture-doc
created: 2026-07-20
updated: 2026-07-21
---

# 🛡️ AEGIS Security & Identity Architecture

> **แนวคิดหลัก**: **Server-Side Enforcement & Per-App Identity** — เบราว์เซอร์ไม่มีสิทธิ์ตัดสินใจเกี่ยวกับ Identity หรือ Role และแต่ละแอปพลิเคชันไม่วางใจ Session ของกันและกัน (Zero Trust Policy)

---

## 🛡️ สรุปมาตรการความปลอดภัยตามมาตรฐาน OWASP

```mermaid
graph TD
    subgraph SecurityShield [AEGIS Defense Mechanisms]
        A[OWASP A01: Broken Access Control] -->|Fix| A_Fix["Server-side requireRole Check<br/>No Role accepted from client"]
        B[OWASP A07: Auth Failures] -->|Fix| B_Fix["Bcrypt Timing Neutralization<br/>Account & IP Exponential Lockout"]
        C[Session Fixation & Hijacking] -->|Fix| C_Fix["HttpOnly + SameSite=Strict Cookies<br/>Regenerate Session ID on Login"]
        D[Cross-Site Request Forgery] -->|Fix| D_Fix["CSRF Synchronizer Tokens<br/>No localStorage / document.cookie"]
        E[Information Disclosure] -->|Fix| E_Fix["Server-side Menu Filtering<br/>Unauthorized DOM elements never generated"]
        F[Closed Registration Provisioning] -->|Fix| F_Fix["Server-generated temp passwords only<br/>Force Password Reset gate on every endpoint"]
        G[Bootstrap Credential Leakage] -->|Fix| G_Fix["Day-0 admin seeded from a bcrypt HASH env var<br/>never a raw password (IDEA1 bootstrapAdmin.js)"]
    end
```

---

## 📋 เปรียบเทียบสิทธิ์ผู้ใช้ในแต่ละแอปพลิเคชัน (Identity Partitioning)

```mermaid
erDiagram
    AEGIS_DRIVE_DB {
        string role_admin "Admin"
        string role_user "DataLake-User"
    }

    AEGIS_MONITOR_DB {
        string role_soc "SOC-Responder"
        string role_operator "CCTV-Operator"
    }

    CAMERA_ASSIGNMENT {
        int user_id FK
        int camera_id FK
    }

    AEGIS_MONITOR_DB ||--o{ CAMERA_ASSIGNMENT : "manages access for CCTV-Operator"
```

1. **ไม่ใช้ localStorage / sessionStorage**: เก็บ Cookie ในรูปแบบ `HttpOnly`, `SameSite=Strict`, `Secure` เพื่อป้องกันสคริปต์ XSS ดึงสิทธิ์ไปใช้
2. **Timing Attack Protection**: ใช้การเปรียบเทียบรหัสผ่าน bcrypt แบบสม่ำเสมอเท่ากัน แม้พิมพ์ Username ผิด
3. **Menu Filtering**: ส่วนติดต่อผู้ใช้ (UI Elements) ของสิทธิ์ที่ไม่ได้รับอนุญาต จะถูกกรองออกตั้งแต่ฝั่ง Server ไม่หลงเหลือ Element ใน HTML DOM
4. **Closed Registration Provisioning (2026-07-21, IDEA1 + IDEA2)**: ไม่มี self-signup ทั้งระบบ — บัญชีใหม่เกิดจาก Admin (`POST /api/users`, IDEA1) หรือ SSH CLI (`server/cli/manage_users.py`, IDEA2) เท่านั้น รหัสผ่านเริ่มต้นถูกสุ่มฝั่งเซิร์ฟเวอร์/CLI เสมอ (client ไม่มีทางกำหนดเอง) และบัญชีใหม่ทุกใบติด `must_reset_password = TRUE` — `requireRole.js` ของทั้งสองแอปบล็อกทุก endpoint ยกเว้น `/me`, `/logout`, `/password/reset` จนกว่าจะรีเซ็ตสำเร็จ
5. **Bootstrap Credential Hygiene (IDEA1)**: `ADMIN_BOOTSTRAP_PASSWORD_HASH` ที่ container เห็นต้องเป็น bcrypt hash ที่คำนวณไว้แล้ว (`scripts/hash_password.py`, ใช้ `getpass` ไม่ echo/log) ไม่ใช่รหัสดิบ — `bootstrapAdmin.js` ตรวจรูปแบบ bcrypt ก่อนบูต ถ้าไม่ตรงจะปฏิเสธการบูตทันที (fail loud แทนเก็บรหัสดิบเงียบ ๆ)

---

## 🔗 เอกสารที่เกี่ยวข้อง
* [[00 - 🗺️ AEGIS System Overview]]
* [[01 - 🚪 HUB-AEGIS Entry]]
* [[02 - 💾 IDEA1 AEGIS Drive LC]]
* [[03 - 📹 IDEA2 AEGIS Monitor]]
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
