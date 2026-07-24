---
title: OWASP Security Defense & Hardening
tags: [aegis, concept, security, owasp, defense-in-depth, rbac]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🛡️ OWASP Security Defense & System Hardening

> **แนวคิดหลัก**: มาตรการป้องกันภัยคุกคามไซเบอร์ตามมาตรฐาน OWASP Top 10 โดยมุ่งเน้นการปฏิบัติตามหลัก **Least Privilege**, **Default Deny**, และ **Server-Side Privilege Validation**

---

## 🛡️ สรุปกลไกป้องกัน OWASP ใน AEGIS System

```mermaid
graph TD
    subgraph Attacks [Attack Vectors]
        A1[OWASP A01: Broken Access Control]
        A7[OWASP A07: Identification & Auth Failures]
        CSRF[Cross-Site Request Forgery]
        InfoDisc[Information Disclosure in DOM]
    end

    subgraph Defense [AEGIS Defense Mechanisms]
        A1_Def["Server-side requireRole Middleware<br/>JOIN camera_assignment on Server"]
        A7_Def["Bcrypt Timing Equalization<br/>Account & IP Exponential Lockout"]
        CSRF_Def["CSRF Synchronizer Tokens<br/>HttpOnly + SameSite=Strict Cookies"]
        InfoDisc_Def["Server-side Menu Filtering<br/>Unauthorized elements not generated"]
    end

    A1 --> A1_Def
    A7 --> A7_Def
    CSRF --> CSRF_Def
    InfoDisc --> InfoDisc_Def
```

---

## 📋 5 มาตรการสำคัญ

1. **Anti-Enumeration & Bcrypt Timing Neutralization**: กรณีใส่ Username ไม่ถูกต้อง ระบบจะทำการเปรียบเทียบรหัสผ่านกับ Dummy Hash เพื่อให้เวลาประมวลผล Bcrypt เท่ากันเสมอกัน ป้องกันการสุ่มวัดเวลาหา User (Timing Attack)
2. **Server-Side Access Control (OWASP A01)**: ไม่อนุญาตให้เบราว์เซอร์หรือสคริปต์ฝั่ง Client ส่งสิทธิ์/Role ขึ้นมาเอง ทุกคำสั่งจะถูกตรวจสอบผ่าน Middleware `requireRole` และทำการ JOIN ตาราง `camera_assignment` บน Server เสมอ
3. **No Storage of Tokens in Web Storage**: ไม่ใช้ `localStorage`, `sessionStorage`, หรือ `document.cookie` ป้องกันสคริปต์ XSS ดึง Session Token ไปใช้
4. **Server-Side Menu Filtering**: เมนูหรือปุ่มกดที่ไม่ตรงกับบทบาท จะถูกกรองออกตั้งแต่ฝั่ง Server ไม่มีการส่งโครงสร้าง HTML ของสิทธิ์ที่สูงกว่าไปซ่อนไว้ที่ฝั่ง Client
5. **Account & IP Lockout**: ป้อนรหัสผิดเกิน 5 ครั้ง บล็อกทันทีทั้งตาม IP และ Username พร้อมระบบ Exponential Backoff

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[05 - 🛡️ Security Architecture]]
* [[concepts/Identity_Decoupling]]
* [[02 - 💾 IDEA1 AEGIS Drive LC]]
* [[03 - 📹 IDEA2 AEGIS Monitor]]
