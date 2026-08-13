---
title: Linux User Accounts & Privileges
tags: [aegis, infrastructure, server, linux, accounts, rbac, least-privilege]
type: infrastructure
status: ✅ บัญชีครบ+ทดสอบ login แล้ว · 🔧 sudo scope ยังไม่ทบทวน
created: 2026-08-06
updated: 2026-08-08
owner: kla
edit_policy: owner-writable
---

# 👥 บัญชีผู้ใช้บน `aegis-system`

> หลักการ: **บัญชีรายบุคคล ไม่ใช้บัญชีร่วม** เพื่อให้ตรวจสอบย้อนหลังได้ว่าใครทำอะไร (Accountability) และถอนสิทธิ์รายคนได้โดยไม่กระทบคนอื่น
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

---

## ✅ บัญชีที่สร้างจริง

| Username | เจ้าของ | บทบาท | Password login | SSH Key | sudo | สถานะรวม |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `admin-main` | กล้า (B6703370) | ผู้ดูแล infra / network / security | ✅ ทดสอบผ่าน | ✅ ใส่แล้ว + login ไม่ถาม password ผ่านแล้ว | ✅ ใช้ตรวจ effective SSH config ได้ | 🔧 รอปิด global Password Auth |
| `pubpup2006p` | ปั๊บ (B6702861) | สมาชิกทีมพัฒนา | ✅ ทดสอบผ่าน | ⏳ **ยังต้องสร้าง Key บนเครื่องตัวเอง** | ❔ ยังไม่มีหลักฐานล่าสุด | ⏳ |
| `krayukantk` | มิวสิค (B6701635) | สมาชิกทีมพัฒนา | ✅ ทดสอบผ่าน | ✅ สร้าง key บนเครื่องตัวเอง, ติดตั้ง Public Key และ login ด้วย identity นี้สำเร็จ | 🚫 ไม่มีสิทธิ์; `sudo sshd -T` ถูกปฏิเสธ | 🔧 รอ strict no-fallback test + ล้าง key เก่า/ซ้ำ |

> ทีมและบทบาทเต็ม ดูที่ [[entities/Team_Roles_and_Responsibilities]]
> รายละเอียดเรื่อง Key ทั้งหมดอยู่ที่ [[infrastructure/server/SSH-Hardening-Status]]

---

## 🧪 หลักฐานการทดสอบ

* ✅ ทั้ง 3 บัญชี SSH เข้า `192.168.10.10` ด้วย **password login** ได้จริงจากภายในเครือข่าย
* ✅ Server ตอบสนอง (reachable) จากวง VLAN 30
* 🔧 `admin-main` ทดสอบเข้าโดย **ไม่ถูกถาม password** สำเร็จแล้ว (Key-based) — แต่ยังไม่ปิด Password Auth จึงยังไม่ถือว่าปิดงาน
* 🔧 `krayukantk` ทดสอบจาก Windows PowerShell ด้วย key รายบุคคลและ `IdentitiesOnly=yes`: ระบบถาม key passphrase แล้วเข้า `aegis-system` ได้โดยไม่ถาม Ubuntu password; ต้องทำ strict client test ที่ห้าม password fallback และตรวจ `authorized_keys` ก่อนเลื่อนเป็นปิดงาน

> `ssh krayukantk@192.168.10.10` ระบุ **บัญชีปลายทาง** แต่ไม่ได้รับประกันว่า client ใช้ key ใด จึงต้องใช้ `-i <private-key>` + `IdentitiesOnly=yes` ในหลักฐานทดสอบรายบุคคล เพื่อคง Accountability แบบหนึ่งคน/หนึ่งบัญชี/หนึ่ง key

---

## 🔧 สิทธิ์ผู้ดูแล (sudo)

**สถานะ: 🔧 role boundary บางส่วนพิสูจน์แล้ว; ยังต้องตรวจ `pubpup2006p` และ group membership ทั้งชุด**

* ✅ `admin-main` เป็นบัญชี system administration และใช้ `sudo sshd -T` ตรวจ effective config ได้จริง
* ✅ `krayukantk` ไม่มี sudo; ข้อความปฏิเสธจาก sudo เป็นหลักฐานว่า account สมาชิกนี้ไม่สามารถแก้ SSH configuration ระดับ host ได้
* ❔ `pubpup2006p` ยังไม่มีผล `groups`/`sudo -l` ล่าสุด จึงห้ามอนุมานว่ามีหรือไม่มี sudo
* ⏳ ยังต้องตรวจ group membership ของทั้งสามบัญชีและยืนยันว่าไม่มีสิทธิ์เกินบทบาท โดยนับ membership ในกลุ่ม `docker` เป็นสิทธิ์เทียบเท่า root

> ⚠️ ตามหลัก **Least Privilege** ควรพิจารณาว่า:
> * สมาชิกที่ทำงานฝั่งแอปพลิเคชันไม่ควรได้ full `sudo` โดยปริยาย; ถ้าต้องมีคำสั่งเฉพาะให้กำหนดขอบเขตตามงาน
> * ถ้าให้ full `sudo` ทุกคน = สิทธิ์บน Host เท่ากันหมด ทำให้การแยกบัญชีเสีย benefit ด้าน containment ไปครึ่งหนึ่ง (ยังเหลือประโยชน์ด้าน audit trail)
> * การอยู่ในกลุ่ม `docker` เทียบเท่า root ในทางปฏิบัติ — ต้องนับรวมตอนทบทวน

---

## 🚫 ข้อกำหนดเรื่องความลับ

* ห้ามบันทึกรหัสผ่านจริงของบัญชีใดลงในวอลต์นี้ ใช้ placeholder `<PASSWORD>` เท่านั้น
* ห้ามเก็บ Private Key ในวอลต์หรือใน repo

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/SSH-Hardening-Status]] · [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[entities/Team_Roles_and_Responsibilities]]
* [[core/security-architecture]]
* [[90-Status/Open-Items-Backlog]]
