---
title: Linux User Accounts & Privileges
tags: [aegis, infrastructure, server, linux, accounts, rbac, least-privilege]
type: infrastructure
status: ✅ account separation and reboot persistence verified · 🔧 privilege review remains
created: 2026-08-06
updated: 2026-08-15
owner: kla
edit_policy: owner-writable
---

# 👥 บัญชีผู้ใช้บน `aegis-system`

> หลักการ: **บัญชีรายบุคคล ไม่ใช้บัญชีร่วม** เพื่อให้มี accountability และถอนสิทธิ์เป็นรายคนได้
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

## ✅ DONE / VERIFIED

- บัญชี Linux แยกตามสมาชิกทีมถูกใช้งานบน host จริง
- Global password login ถูกปิดแล้ว; การบริหารระบบใช้ SSH key ตาม [[infrastructure/server/SSH-Hardening-Status]]
- Controlled host reboot ไม่ทำให้บัญชีที่ใช้ validation สูญหาย และ key-based administration กลับมาใช้งานได้
- ไม่มี password, private key, token หรือ hash ถูกบันทึกใน vault

## สถานะรายบัญชี

| Username | Owner / role | Current evidence |
| :--- | :--- | :--- |
| `admin-main` | Kla · infrastructure administration | key login และสิทธิ์ดูแลระบบมีหลักฐานเดิม; administration กลับมาหลัง reboot |
| `pubpup2006p` | Pub · application development | account มีอยู่; หลักฐานชุดนี้ไม่แสดงผล key/login หลัง reboot แบบแยกรายบัญชี |
| `krayukantk` | Music · application development | key รายบุคคลเคยผ่าน; หลักฐานเดิมยืนยันว่าไม่มี sudo |

> Historical note: ก่อนปิด password authentication ทั้งสามบัญชีเคยผ่าน password login
> และ `pubpup2006p` เคยค้างขั้น key onboarding ข้อความนั้นเป็น baseline เก่า
> ไม่ใช่ Current State ของ SSH daemon หลัง readiness pass

## 🔧 PENDING — Least-privilege review

- ตรวจ `groups` และ `sudo -l` ของแต่ละบัญชีด้วยหลักฐานล่าสุด
- ถือ membership ในกลุ่ม `docker` เป็นสิทธิ์เทียบเท่า root และให้เฉพาะผู้ที่จำเป็น
- อย่ายกระดับสมาชิกเป็น full sudo เพียงเพื่อแก้ปัญหาการ deploy

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/SSH-Hardening-Status]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[entities/Team_Roles_and_Responsibilities]]
* [[90-Status/Open-Items-Backlog]]
