---
title: Linux User Accounts & Privileges
tags: [aegis, infrastructure, server, linux, accounts, rbac, least-privilege]
type: infrastructure
status: ✅ per-account SSH and functional sudo evidence recorded · 🔧 least-privilege/docker audit remains
created: 2026-08-06
updated: 2026-08-16
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
- แชท Security Layer บันทึกว่า key login ของทั้งสามบัญชีเคยผ่านก่อนรอบ cleanup/reboot
- ฝั่ง Server ของ `krayukantk` ตรวจ `authorized_keys`, ลบ duplicate key, เก็บ backup และยืนยัน owner/permission แล้ว
- Kittipat สร้าง ED25519 identity `~/.ssh/id_ed25519_kittipat` บน Arch Linux client; private key คงอยู่บน client และติดตั้งเฉพาะ public key comment `kittipat@aegis` ให้บัญชี `admin-main`
- ขั้นตอนนี้ไม่ได้สร้าง Linux account ชื่อ `kittipat` และไม่ได้สร้างหรือเปลี่ยน Linux password
- ไม่มี password, private key, token หรือ hash ถูกบันทึกใน vault

## สถานะรายบัญชี

| Username | Owner / role | Account | SSH identity / server state | `sudo` | `docker` | Pre-reboot SSH | Post-reboot SSH |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `admin-main` | Kla · infrastructure administration | ✅ exists | ✅ multiple authorized public keys recorded; `kittipat@aegis` ระบุเจ้าของได้และถูกติดตั้งจาก Arch client; ownership/final pruning ของ key อื่นยังไม่ได้ audit ครบ | 🟡 operational use recorded; ยังไม่มี final `id/groups/sudo -l -U` audit | ⚠️ NOT VERIFIED | ✅ VERIFIED — Kittipat เข้า `aegis-system` ด้วย client-side ED25519 key โดย login เป็น `admin-main` | ✅ VERIFIED — กลับเข้าผ่าน Twingate หลัง controlled reboot |
| `pubpup2006p` | Pub · application development | ✅ exists | ✅ sudo-based audit ยืนยัน `authorized_keys` มีอยู่, owner ถูกต้อง, mode `600`, 1 non-comment key | ✅ functional elevation to root ผ่านในการทดสอบ STEP 9; least-privilege review ยังค้าง | ⚠️ NOT VERIFIED | ✅ VERIFIED | ✅ VERIFIED ผ่าน Twingate ใน Phase B STEP 9 |
| `krayukantk` | Music · application development | ✅ exists | ✅ sudo-based audit ยืนยัน `authorized_keys` มีอยู่, owner ถูกต้อง, mode `600`, 2 non-comment keys; duplicate cleanup/backup เดิมยังเก็บไว้ | ✅ functional elevation to root ผ่านในการทดสอบ STEP 9; least-privilege review ยังค้าง | ⚠️ NOT VERIFIED | ✅ VERIFIED — key-only SSH หลัง cleanup เคยผ่าน | ✅ VERIFIED ผ่าน Twingate ใน Phase B STEP 9 |

> [!important] Evidence boundary
> ค่า `sudo` ของ `pubpup2006p` และ `krayukantk` เป็น functional host evidence
> (`sudo` elevation returned `root`) ไม่ใช่ผล policy enumeration จาก `sudo -l -U`.
> จึงยืนยันได้ว่า sudo ใช้งานได้ แต่ยังสรุปไม่ได้ว่า least privilege ผ่าน.

## SSH Identity / Key State

- Linux OS account และ SSH key identity เป็นคนละสิ่ง: public key `kittipat@aegis` อนุญาตให้ Kittipat เข้า Linux account `admin-main`; ไม่ได้หมายความว่ามี account `kittipat`
- Private key `~/.ssh/id_ed25519_kittipat` อยู่บน Arch Linux client เท่านั้น ส่วน Server รับเฉพาะ public key ใน `/home/admin-main/.ssh/authorized_keys`
- `krayukantk` เป็น Linux account เดิม การ cleanup รอบนี้ไม่ได้สร้าง account หรือ private key ใหม่ให้เจ้าของ
- AEGIS Drive username `admin` และ AEGIS Monitor username `soc` เป็น application identities ไม่ใช่ Linux accounts และไม่อยู่ในตารางนี้
- การปิด `PasswordAuthentication` หมายถึงปิด remote SSH password authentication ไม่ได้ลบ local UNIX password ที่ Ubuntu อาจใช้ตรวจ `sudo`

## งานที่ทำตามคำสั่งและงานเพิ่มเติมจากแชทหน้างาน

### A. งานที่ทำตามคำสั่งเจ้าของโครงการ

- ใช้บัญชีรายบุคคลแทนบัญชีร่วม และทำ SSH-key onboarding สำหรับสมาชิก
- ทดสอบ key login ของ `admin-main`, `pubpup2006p` และ `krayukantk` ในช่วง Security Layer ก่อน cleanup/reboot
- ปิด global password authentication หลัง key baseline ผ่าน
- ตรวจ account/key state โดยไม่บันทึก private key, password หรือ token

### B. งานที่ทำเพิ่มเติมระหว่างแก้ปัญหาหน้างาน

- ตรวจ `authorized_keys` ของ `krayukantk`, ลบ duplicate key และเก็บ `authorized_keys.bak-20260814`
- ตรวจ owner/permission ฝั่ง Server ของ `krayukantk`; ไม่สร้าง private key ใหม่แทนเจ้าของบัญชี
- สร้าง key pair ของ Kittipat ที่ Arch client, เก็บ private key ฝั่ง client และติดตั้งเฉพาะ `kittipat@aegis` public key ใน `admin-main`
- ยืนยันว่า Kittipat login สำเร็จเป็น `admin-main`; ไม่มีการสร้าง Linux account `kittipat`
- พบว่า `admin-main` มี 3 public-key entries และ `pubpup2006p` มี 1 entry ตามบันทึกในแชท; การตัดสินใจลบ key ของ `admin-main` ยังไม่เกิดขึ้น
- Phase B STEP 9 ยืนยัน key-only SSH ผ่าน Twingate และ functional sudo สำหรับ `pubpup2006p` กับ `krayukantk`; source `172.17.0.2`, destination `192.168.10.10:22`, hostname `aegis-system`

### Historical / outdated

- ข้อความเดิมว่า `krayukantk` ไม่มี `sudo` ไม่ใช่ Current State แล้ว หลังเจ้าของโครงการยืนยันว่าทั้งสามบัญชีอยู่ในกลุ่ม `sudo`; อย่างไรก็ตามยังรอ host audit เพื่อเลื่อนเป็น VERIFIED
- ก่อนปิด password authentication ทั้งสามบัญชีเคยผ่าน password login และ `pubpup2006p` เคยค้างขั้น key onboarding; baseline ดังกล่าวถูกแทนที่ด้วย key-only SSH state ปัจจุบัน

## 🔧 PENDING — Least-privilege and Docker-group audit

- เก็บผล `getent passwd`, `id`, `groups` และ `sudo -l -U` ของทั้งสามบัญชีจาก host จริง โดยไม่แสดง secret
- ตรวจจำนวน key และ mode `700/600` ของทุกบัญชี; แชทปัจจุบันยังไม่มี raw output ของ Final Audit
- ถือ membership ในกลุ่ม `docker` เป็นสิทธิ์เทียบเท่า root และให้เฉพาะผู้ที่จำเป็น
- ทบทวนความจำเป็นของ `sudo` รายบุคคล; membership ที่มีอยู่ไม่เท่ากับ least privilege ผ่าน
- ทบทวนว่าบัญชีใดต้องมี full sudo ต่อไป แม้ functional sudo จะผ่านแล้ว

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/SSH-Hardening-Status]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[entities/Team_Roles_and_Responsibilities]]
* [[90-Status/Open-Items-Backlog]]
