---
title: Open Items Backlog (Infrastructure)
tags: [aegis, infrastructure, status, backlog, todo, priority]
type: status
status: 🔧 living-document
created: 2026-08-06
updated: 2026-08-11
owner: kla
edit_policy: owner-writable
---

# 📌 Open Items Backlog — คิวงานถัดไป

> เรียงตามลำดับความสำคัญ **P1 → P2 → P3**
> ⚠️ ทุกข้อในโน้ตนี้คือ **"ยังไม่ทำ"** ห้ามนำไปเขียนในเล่มว่าทำแล้ว
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

---

## 🔴 P1 — ต้องทำก่อนถือว่าระบบปลอดภัยพอจะ deploy

| # | งาน | ทำไมเป็น P1 | โน้ต | สถานะ |
| :-- | :--- | :--- | :--- | :--- |
| P1-1 | **ปิดงาน SSH Hardening** — `pubpup2006p` สร้าง/ทดสอบ key; strict no-fallback/ล้าง key เก่า; แล้วจึงปิด Password Auth | `PermitRootLogin no`, `PubkeyAuthentication yes`, key ของ `admin-main`/`krayukantk` ผ่านแล้ว; Password Auth ยังเปิด | [[infrastructure/server/SSH-Hardening-Status]] | 🔧 **root/pubkey done · รอคนที่ 3 + password off** |
| P1-2 | **ปิด UFW Production Rules ให้ครบสอง path** | Twingate SSH path ผ่านแล้ว; ต้องทดสอบ session ใหม่จาก VLAN 30 โดยคง Twingate/admin session สำหรับ rollback | [[infrastructure/server/Beelink-Ubuntu-Host]] · [[infrastructure/remote-access/Twingate-Setup]] | 🔧 **Twingate ✅ · VLAN 30 ⏳** |
| P1-3 | **Rotate Twingate Connector Token** | Token เคยปรากฏบนหน้าจอ → ต้องถือว่ารั่วแล้ว | [[infrastructure/remote-access/Twingate-Setup]] | ⏳ |
| P1-4 | ตั้ง **Restart Policy / Health Check** ให้ Twingate Connector | ถ้า container ตายแล้วไม่ restart = ล็อกทั้งทีมออกจาก Server | [[infrastructure/remote-access/Twingate-Setup]] | ⏳ |
| P1-5 | ตรวจ **Twingate Group Membership** ไม่ให้กว้างเกิน | ใครอยู่ในกลุ่ม `Admin` = เข้า SSH ได้ | [[infrastructure/remote-access/Twingate-Setup]] | ⏳ |
| P1-6 | ยืนยันว่า **OpenVPN service ถูก disable** ไม่ให้รันค้าง | service ที่ค้างโดยไม่มีใครดูแล = attack surface ที่ไม่จำเป็น | [[infrastructure/remote-access/OpenVPN-Deprecated]] | ⏳ |
| P1-7 | **Rotate credential ของ `drive_app` / `monitor_app` ก่อน Production deploy** | ค่า DB application-role เป็น production secret; ต้องเปลี่ยนพร้อมอัปเดต secret source ของแต่ละ service และทดสอบ SQL-level isolation ซ้ำ | [[core/security-architecture]] · [[concepts/Schema_Ownership_Map]] | ⏳ |

---

## 🟠 P2 — ต้องทำก่อน / ระหว่าง Deploy

| # | งาน | รายละเอียด | โน้ต | สถานะ |
| :-- | :--- | :--- | :--- | :--- |
| P2-1 | **Backup Config** | MikroTik export (`/export` + `.backup`), Switch config, Ubuntu config (`/etc`, netplan, `sshd_config`, compose) | [[infrastructure/network/MikroTik-Config]] · [[infrastructure/network/Switch-VLAN-Config]] | ⏳ |
| P2-2 | **Review Firewall Rule ครบชุด** ก่อน Production | ตอนทดสอบ routing มีการผ่อน rule ชั่วคราว ยังไม่ได้ไล่ตรวจว่าเหลืออะไรเปิดกว้าง | [[infrastructure/network/MikroTik-Config]] | ⏳ |
| P2-3 | **Audit Docker / Repo / Secrets version ล่าสุดก่อน Deploy** | กันการ deploy ของเก่า / `.env` ที่ไม่ตรงกับโค้ดปัจจุบัน | [[infrastructure/deployment/Docker-Stack-Plan]] | ⏳ |
| P2-4 | **ตัดสินใจ Macvlan vs Bridge + Reverse Proxy** | Twingate Connector อยู่บน bridge อาจมองไม่เห็น container บน macvlan | [[infrastructure/deployment/Docker-Stack-Plan]] | ⏳ **ยังไม่ตัดสินใจ** |
| P2-5 | **Deploy Gateway + Drive + Monitor + PostgreSQL + Storage ลง Beelink** | ปัจจุบันบน Beelink มีแค่ Twingate Connector | [[infrastructure/deployment/Docker-Stack-Plan]] | ⏳ |
| P2-6 | **ทดสอบ Persistence / Health Check / Restart / Recovery** | ต้องพิสูจน์ว่า `docker compose restart` / reboot เครื่องแล้วข้อมูลและบริการกลับมาครบ | [[infrastructure/deployment/Docker-Stack-Plan]] | ⏳ |
| P2-7 | ทบทวน **sudo scope** ของแต่ละบัญชี | Least Privilege — และการอยู่ในกลุ่ม `docker` เทียบเท่า root | [[infrastructure/server/Linux-User-Accounts]] | ⏳ |

---

## 🟡 P3 — งานต่อยอด / ปิดเล่ม

| # | งาน | รายละเอียด | โน้ต | สถานะ |
| :-- | :--- | :--- | :--- | :--- |
| P3-1 | **เชื่อม IDEA2 Detection Engine** | ต้อง **กำหนด IP ของ Detection Laptop (VLAN 20) ก่อน** เป็นเงื่อนไขนำ | [[infrastructure/network/VLAN-IP-Plan]] · [[idea2/idea2-status]] | ⏳ |
| P3-2 | **IDEA3 — MQTT / ESP32 / Relay / Heartbeat** | สถานะปัจจุบันคือ **"เขียนโค้ดแล้วยังไม่ทดสอบ"** ต้องตรวจว่ามีฮาร์ดแวร์จริงหรือยัง แล้วจอง `192.168.10.13` ให้ Broker | [[idea3/idea3-status]] · [[concepts/Dead_Mans_Switch]] | ⏳ |
| P3-3 | **HTTPS / TLS** ที่ gateway | ตอนนี้ยังเป็น HTTP ล้วน | [[infrastructure/deployment/Docker-Stack-Plan]] | ⏳ |
| P3-4 | **Monitoring** ของ Host และ container | uptime / disk / container health | [[infrastructure/server/Beelink-Ubuntu-Host]] | ⏳ |
| P3-5 | **Backup / Restore Test** | backup ที่ไม่เคยทดสอบ restore = ยังไม่มี backup | — | ⏳ |
| P3-6 | **Incident Runbook** | รวมถึง Recovery note กรณี Twingate Connector ล่ม | [[infrastructure/remote-access/Twingate-Setup]] · [[concepts/Contain_Before_Notify]] | ⏳ |
| P3-7 | **อัปเดตเล่มรายงาน §2.3.4 + §3.5.6 + ตาราง Layered Auth** ให้ตรงของจริง | เล่มยังเขียน OpenVPN + Twingate คู่ขนาน และหลักการ "ต้องผ่าน VLAN 30 ก่อน" | [[90-Status/Document-Conflicts]] | ⏳ |
| P3-8 | **เขียนโน้ตเดิมในวอลต์ใหม่ให้ตรงของจริง** | [[concepts/ZTNA_Twingate_vs_OpenVPN]] และ [[entities/MikroTik_hEX_lite]] ตอนนี้แค่แปะ banner เตือน ยังไม่ได้เขียนใหม่ | [[90-Status/Document-Conflicts]] | ⏳ |

---

## 🧭 ลำดับที่แนะนำให้ทำต่อ

```mermaid
flowchart LR
    A["P1-2 ทดสอบ VLAN 30 direct path<br/>Twingate path ผ่านแล้ว"] --> B["P1-3 Rotate Token<br/>+ ยืนยัน Connector Healthy"]
    B --> C["P1-1 pubpup2006p key<br/>+ cleanup/strict tests"]
    C --> H["P1-1 ปิด Password Auth<br/>+ ทดสอบ session ใหม่"]
    H --> J["P1-7 Rotate DB app-role passwords"]
    J --> D["P2-4 ตัดสินใจ Macvlan/Bridge"]
    D --> E["P2-3 Audit version"]
    E --> F["P2-5 Deploy stack"]
    F --> G["P2-6 ทดสอบ Recovery"]
    G --> K["P3 · IDEA2/IDEA3 + TLS + เล่ม"]
```

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[90-Status/Progress-Log-2026-08-06]] · [[90-Status/Document-Conflicts]]
