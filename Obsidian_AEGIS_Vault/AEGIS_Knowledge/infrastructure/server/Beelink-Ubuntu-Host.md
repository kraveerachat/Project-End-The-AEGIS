---
title: Beelink Ubuntu Host (aegis-system)
tags: [aegis, infrastructure, server, ubuntu, beelink, docker, host]
type: infrastructure
status: ✅ Host พร้อมใช้งาน · ⏳ ยังไม่ deploy production stack
created: 2026-08-06
updated: 2026-08-11
owner: kla
edit_policy: owner-writable
---

# 💻 Beelink Ubuntu Host — `aegis-system`

> Core Server ของทั้งระบบ AEGIS · สเปกฮาร์ดแวร์ดูที่ [[entities/Beelink_Mini_S_NAS]] และ [[infrastructure/network/Hardware-Inventory]]
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

---

## ✅ สถานะปัจจุบัน

| รายการ | ค่า / รายละเอียด | สถานะ |
| :--- | :--- | :--- |
| **Hostname** | `aegis-system` | ✅ |
| **OS** | Ubuntu Server (Headless — ไม่มี GUI) | ✅ ติดตั้งแล้ว ใช้งานจริง |
| **IP** | `192.168.10.10` — VLAN 10 Server Zone | ✅ ping/SSH ผ่าน |
| **การเชื่อมต่อ** | LAN เข้า Port 2 ของ [[infrastructure/network/Switch-VLAN-Config|TL-SG105E]] (Access VLAN 10) | ✅ |
| **SSH Service** | เปิดใช้งาน เข้าได้ทั้งจากภายในและผ่าน [[infrastructure/remote-access/Twingate-Setup\|Twingate]] | ✅ |
| **Effective SSH config** | `PubkeyAuthentication yes`; `PermitRootLogin no`; `PasswordAuthentication yes` ชั่วคราว | 🔧 root/pubkey ผู้ดูแลยืนยันแล้ว; password=`no` รอ `pubpup2006p` |
| **Docker Environment** | ติดตั้งแล้ว และรัน [[infrastructure/remote-access/Twingate-Setup\|Twingate Connector]] เป็น container อยู่จริง | ✅ |
| **Production Stack (Gateway/Drive/Monitor/PostgreSQL)** | **ยังไม่ deploy ลงเครื่องนี้** | ⏳ |

> ⚠️ **จุดที่ต้องระวังตอนเขียนเล่ม**: ข้อความ "Docker stack healthy · `http://localhost/monitor/` HTTP 200" ที่บันทึกไว้ใน [[core/system-overview]] เป็นผลจากการรันบน **เครื่อง dev ของผู้พัฒนา** ไม่ใช่บน Beelink ตัวนี้ → ดูข้อ 7 ใน [[90-Status/Document-Conflicts]]

---

## 🎯 บทบาทที่วางไว้

```mermaid
flowchart TD
    HOST["Beelink · aegis-system<br/>192.168.10.10 · VLAN 10"]

    HOST --> SSH["SSH Service ✅<br/>(ทางเข้าเดียวที่เปิดตอนนี้)"]
    HOST --> TGC["Twingate Connector ✅<br/>Docker bridge · outbound-only"]
    HOST -.-> STACK["Production Stack ⏳<br/>Gateway · Drive · Monitor · PostgreSQL · Storage"]
    HOST -.-> LAKE["Data Lake บน HDD 1TB 📋<br/>ยังไม่ mount/ใช้จริง"]
```

---

## ⏳ งานค้างที่ผูกกับ Host ตัวนี้

| งาน | ความสำคัญ | สถานะ |
| :--- | :--- | :--- |
| **UFW production paths** | P1 | 🔧 Twingate SSH path ✅ ผู้ดูแลยืนยัน · VLAN 30 direct test ⏳; คง working Twingate/admin session ระหว่างทดสอบ |
| ปิดงาน SSH Hardening | P1 | 🔧 `admin-main` + `krayukantk` ใช้ key ได้; `pubpup2006p`, strict tests, key cleanup และ global Password Auth ยังค้าง → [[infrastructure/server/SSH-Hardening-Status]] |
| Audit ว่า Docker / repo / secrets เป็นเวอร์ชันล่าสุดก่อน deploy | P2 | ⏳ |
| Deploy production stack | P2 | ⏳ [[infrastructure/deployment/Docker-Stack-Plan]] |
| ทดสอบ Persistence / Health Check / Restart / Recovery | P2 | ⏳ |
| Backup config ของ Ubuntu (`/etc`, netplan, sshd_config, compose) | P2 | ⏳ |
| ยืนยันว่า OpenVPN service ถูก disable ไม่ให้รันค้าง | P1/P2 | ⏳ [[infrastructure/remote-access/OpenVPN-Deprecated]] |

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/Linux-User-Accounts]] · [[infrastructure/server/SSH-Hardening-Status]]
* [[infrastructure/deployment/Docker-Stack-Plan]]
* [[infrastructure/network/VLAN-IP-Plan]]
* [[entities/Beelink_Mini_S_NAS]]
* [[90-Status/Open-Items-Backlog]]
