---
title: Linux User Accounts & Privileges
tags: [aegis, infrastructure, server, linux, accounts, rbac, least-privilege]
type: infrastructure
status: ✅ บัญชีครบ+ทดสอบ login แล้ว · 🔧 sudo scope ยังไม่ทบทวน
created: 2026-08-06
updated: 2026-08-06
---

# 👥 บัญชีผู้ใช้บน `aegis-system`

> หลักการ: **บัญชีรายบุคคล ไม่ใช้บัญชีร่วม** เพื่อให้ตรวจสอบย้อนหลังได้ว่าใครทำอะไร (Accountability) และถอนสิทธิ์รายคนได้โดยไม่กระทบคนอื่น
> กลับไปหน้าศูนย์รวม: [[00-MOC/AEGIS-Infrastructure-MOC]]

---

## ✅ บัญชีที่สร้างจริง

| Username | เจ้าของ | บทบาท | Password login | SSH Key | สถานะรวม |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `admin-main` | กล้า (B6703370) | ผู้ดูแล infra / network / security | ✅ ทดสอบผ่าน | 🔧 ใส่แล้ว + login ไม่ถาม password ผ่านแล้ว | 🔧 |
| `pubpup2006p` | ปั๊บ (B6702861) | สมาชิกทีมพัฒนา | ✅ ทดสอบผ่าน | ⏳ **ยังต้องสร้าง Key บนเครื่องตัวเอง** | ⏳ |
| `krayukantk` | มิวสิค (B6701635) | สมาชิกทีมพัฒนา | ✅ ทดสอบผ่าน | ⏳ **ยังต้องสร้าง Key บนเครื่องตัวเอง** | ⏳ |

> ทีมและบทบาทเต็ม ดูที่ [[entities/Team_Roles_and_Responsibilities]]
> รายละเอียดเรื่อง Key ทั้งหมดอยู่ที่ [[20-Server/SSH-Hardening-Status]]

---

## 🧪 หลักฐานการทดสอบ

* ✅ ทั้ง 3 บัญชี SSH เข้า `192.168.10.10` ด้วย **password login** ได้จริงจากภายในเครือข่าย
* ✅ Server ตอบสนอง (reachable) จากวง VLAN 30
* 🔧 `admin-main` ทดสอบเข้าโดย **ไม่ถูกถาม password** สำเร็จแล้ว (Key-based) — แต่ยังไม่ปิด Password Auth จึงยังไม่ถือว่าปิดงาน

---

## 🔧 สิทธิ์ผู้ดูแล (sudo)

**สถานะ: 🔧 ทำแล้วรอทบทวน**

* จัดกลุ่มสิทธิ์ดูแลระบบตามบทบาทแล้ว
* ⏳ **ยังไม่ได้ทบทวน sudo scope** ว่าทุกคนจำเป็นต้องมี `sudo` เต็มหรือไม่

> ⚠️ ตามหลัก **Least Privilege** ควรพิจารณาว่า:
> * สมาชิกที่ทำงานฝั่งแอปพลิเคชันจำเป็นต้องมี full `sudo` บน Host หรือแค่สิทธิ์ในกลุ่ม `docker` / คำสั่งเฉพาะ
> * ถ้าให้ full `sudo` ทุกคน = สิทธิ์บน Host เท่ากันหมด ทำให้การแยกบัญชีเสีย benefit ด้าน containment ไปครึ่งหนึ่ง (ยังเหลือประโยชน์ด้าน audit trail)
> * การอยู่ในกลุ่ม `docker` เทียบเท่า root ในทางปฏิบัติ — ต้องนับรวมตอนทบทวน

---

## 🚫 ข้อกำหนดเรื่องความลับ

* ห้ามบันทึกรหัสผ่านจริงของบัญชีใดลงในวอลต์นี้ ใช้ placeholder `<PASSWORD>` เท่านั้น
* ห้ามเก็บ Private Key ในวอลต์หรือใน repo

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[00-MOC/AEGIS-Infrastructure-MOC]]
* [[20-Server/SSH-Hardening-Status]] · [[20-Server/Beelink-Ubuntu-Host]]
* [[entities/Team_Roles_and_Responsibilities]]
* [[05 - 🛡️ Security Architecture]]
* [[90-Status/Open-Items-Backlog]]
