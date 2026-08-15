---
title: SSH Hardening Status
tags: [aegis, infrastructure, server, ssh, hardening, security, ed25519]
type: infrastructure
status: ✅ production baseline verified
created: 2026-08-06
updated: 2026-08-16
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
- Security Layer chat บันทึกว่า key login ของ `admin-main`, `pubpup2006p` และ `krayukantk` เคยผ่านก่อน reboot/cleanup
- Kittipat สร้าง ED25519 key บน Arch Linux client, เก็บ private key ฝั่ง client และติดตั้ง public key `kittipat@aegis` ให้ `admin-main`; login เป็น `admin-main` สำเร็จโดยไม่ได้สร้าง Linux account `kittipat`
- หลัง cleanup ฝั่ง Server ของ `krayukantk` มี `authorized_keys` ที่ตรวจแล้ว, duplicate key ถูกลบ, backup ถูกเก็บ และ owner/permission ถูกต้อง; key-only SSH หลัง cleanup เคยผ่านก่อน controlled reboot
- เจ้าของโครงการยืนยันภายหลังว่าทั้งสามบัญชีอยู่ใน `sudo`; ข้อความเก่าว่า `krayukantk` ไม่มี sudo จึงเป็น Historical/Outdated แต่ยังไม่ถือเป็น host-verified จนกว่าจะมี `id/groups/sudo -l -U`
- Phase B STEP 9 ยืนยัน `pubpup2006p` และ `krayukantk` เข้า key-only SSH ผ่าน Twingate ได้จริง และ functional `sudo` elevation คืนค่า `root`

### Per-account functional state

| Linux account | Pre-reboot key-only SSH | Post-reboot per-account SSH |
| :--- | :--- | :--- |
| `admin-main` | ✅ VERIFIED | ✅ VERIFIED ผ่าน Twingate |
| `pubpup2006p` | ✅ VERIFIED | ✅ VERIFIED ผ่าน Twingate ใน Phase B STEP 9 |
| `krayukantk` | ✅ VERIFIED รวมรอบหลัง key cleanup | ✅ VERIFIED ผ่าน Twingate ใน Phase B STEP 9 |

## ⚠️ NOT VERIFIED

- หลักฐานชุดนี้ไม่ได้แนบ post-apply output ของ `sshd -T` หรือไฟล์ rules ทั้งฉบับ จึงไม่แต่ง output เพิ่ม
- การทดสอบ functional sudo ไม่ได้แทน policy audit จาก `sudo -l -U`; least-privilege และ `docker` membership ยังต้องทบทวนแยก
- `admin-main` key ownership/pruning และ final policy enumeration ของทุกบัญชียังไม่ครบ
- การทบทวนความจำเป็นของ sudo/docker group ของทุกบัญชียังเป็นงาน governance แยกจาก SSH baseline

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/Linux-User-Accounts]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[infrastructure/remote-access/Twingate-Setup]]
* [[90-Status/Open-Items-Backlog]]
