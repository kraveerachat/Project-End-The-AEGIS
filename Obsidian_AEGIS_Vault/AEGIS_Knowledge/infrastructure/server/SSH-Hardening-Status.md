---
title: SSH Hardening Status
tags: [aegis, infrastructure, server, ssh, hardening, security, ed25519]
type: infrastructure
status: ✅ production baseline verified
created: 2026-08-06
updated: 2026-08-15
owner: kla
edit_policy: owner-writable
---

# 🔑 SSH Hardening — Current State

> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

> [!success] Current state
> SSH production baseline ผ่านแล้ว: key authentication ใช้งานจริง,
> `PasswordAuthentication no`, `PermitRootLogin no` และ `ssh.socket`
> กลับมาทำงานหลัง controlled host reboot

## ✅ DONE / VERIFIED

| Control | Current state | Evidence boundary |
| :--- | :--- | :--- |
| `PubkeyAuthentication` | ✅ key-based administration ใช้งานจริง | ผลการเข้าใช้งานและ post-reboot recovery จากบทสนทนา |
| `PasswordAuthentication` | ✅ `no` | สถานะล่าสุดแทนที่ baseline เก่าที่เคยเป็น `yes` |
| `PermitRootLogin` | ✅ `no` | operator-confirmed |
| SSH boot activation | ✅ `ssh.socket` active หลัง reboot | post-reboot verification |
| Remote SSH | ✅ ผ่าน [[infrastructure/remote-access/Twingate-Setup\|Twingate]] | Connector และ SSH path recovered หลัง reboot |
| VLAN 30 administration path | ✅ reachability ผ่าน | Linux laptop `192.168.30.99/24` ถึง Beelink `192.168.10.10` |

### Historical baseline

เมื่อ 2026-08-08 effective configuration ที่บันทึกไว้ยังเป็น:

```text
permitrootlogin prohibit-password
pubkeyauthentication yes
passwordauthentication yes
```

ต่อมา `PermitRootLogin no` ถูก apply เมื่อ 2026-08-11 และรอบ readiness ล่าสุด
ยืนยันว่า `PasswordAuthentication no` แล้ว จึงให้ Current State ด้านบนชนะ baseline เดิม
โดยไม่ลบประวัติการเปลี่ยนผ่าน

## ✅ Account and key boundaries

- หนึ่งคนใช้หนึ่ง Linux account และ key ของตนเองตาม [[infrastructure/server/Linux-User-Accounts]]
- Private key อยู่บนเครื่องเจ้าของเท่านั้น; vault/repository เก็บได้เฉพาะ public key ที่จำเป็น แต่รอบนี้ไม่ได้บันทึก key ใด ๆ
- บัญชีและ key-based administration ที่ใช้ validation ยังคงใช้งานได้หลัง host reboot
- `admin-main` เป็นบัญชีดูแลระบบ; หลักฐานเดิมยืนยันว่า `krayukantk` ไม่มี sudo

## ⚠️ NOT VERIFIED

- หลักฐานชุดนี้ไม่ได้แนบ post-apply output ของ `sshd -T` หรือไฟล์ rules ทั้งฉบับ จึงไม่แต่ง output เพิ่ม
- ไม่ยืนยันจากหลักฐานชุดนี้ว่าทุกบัญชีสมาชิกถูกทดสอบ login หลัง reboot แยกกันครบทุกคน
- การทบทวน sudo/docker group ของทุกบัญชียังเป็นงาน governance แยกจาก SSH baseline

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/Linux-User-Accounts]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[infrastructure/remote-access/Twingate-Setup]]
* [[90-Status/Open-Items-Backlog]]
