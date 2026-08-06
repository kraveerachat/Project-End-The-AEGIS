---
title: Progress Log — 6 สิงหาคม 2026
tags: [aegis, infrastructure, status, progress-log, 2026-08-06]
type: status
status: 📌 snapshot ณ 2026-08-06
created: 2026-08-06
updated: 2026-08-06
---

# 📋 Progress Log — สรุปงาน Infrastructure 15 ขั้นตอน

> **Snapshot ณ วันที่ 6 สิงหาคม 2026** — บันทึกสิ่งที่ทำจริงบนฮาร์ดแวร์
> กลับไปหน้าศูนย์รวม: [[00-MOC/AEGIS-Infrastructure-MOC]]

| Marker | ความหมาย |
| :--- | :--- |
| ✅ | ทำจริง **+ มีหลักฐานการทดสอบ** |
| 🔧 | ทำแล้ว **ยังไม่ทดสอบ / ทดสอบไม่ครบ** |
| ⏳ | ยังไม่ได้ทำ |
| 📋 | เป็นแค่ Design ในเล่ม |

---

## 🧾 ตารางสรุป 15 ขั้นตอน

| ขั้น | สิ่งที่ทำ | สถานะ |
| :--- | :--- | :--- |
| **1** | **กำหนดสถาปัตยกรรม** — แยก Core Server / Edge AI / Cyber-Physical Control, วาง Defense in Depth, ออกแบบ Management path ที่ยังใช้ได้ขณะเกิด Incident | ✅ |
| **2** | **จัดเตรียมอุปกรณ์** — Beelink Mini S (N5095 / RAM 8GB / SSD 128GB / HDD 1TB), MikroTik hEX lite RB750r2, TP-Link TL-SG105E, Admin Laptop, Detection Laptop → [[10-Network/Hardware-Inventory]] | ✅ · ESP32/Relay (IDEA3) ⏳ **ยังต้องตรวจสถานะ** |
| **3** | **ติดตั้ง Ubuntu Server บน Beelink** — hostname `aegis-system`, Headless, เชื่อม LAN → [[20-Server/Beelink-Ubuntu-Host]] | ✅ |
| **4** | **ตั้ง IP Host** — Beelink = `192.168.10.10` บน VLAN 10 Server Zone | ✅ |
| **5** | **ตั้ง MikroTik เป็น Edge Router** — แยกวงบ้านออกจากวง AEGIS, สร้าง VLAN Interface 10/20/30, ตั้ง Gateway แต่ละวง, ทำ Inter-VLAN Routing, จัดลำดับ Firewall Rule ให้ LAN-to-LAN อยู่**เหนือ** Drop Rule → [[10-Network/MikroTik-Config]] | ✅ · ⏳ ยังไม่ Export Config Backup / ยังไม่ Review Rule ครบก่อน Production |
| **6** | **ตั้ง Managed Switch** — VLAN 10/20/30, Port1 Trunk Tagged, Port2 Access VLAN10 (Beelink), Port3 Access VLAN20 (Detection Laptop), Port4 Native/ช่าง, Port5 Access VLAN30 (Admin Laptop), PVID ตรงกันทุกพอร์ต → [[10-Network/Switch-VLAN-Config]] | ✅ |
| **7** | **ทดสอบ VLAN + Routing** — Ping VLAN30→VLAN10 สำเร็จ **0% packet loss**, Latency **0.5–0.8 ms**, SSH ภายในเครือข่ายผ่าน | ✅ **มีหลักฐาน** |
| **8** | **เตรียม Beelink เป็น Server Host** — Ubuntu Server + SSH Service + Docker environment | ✅ · ⏳ ต้องตรวจว่า Docker production stack ปัจจุบันเป็น version ล่าสุดหรือยัง |
| **9** | **สร้างบัญชีสมาชิกทีม** — `admin-main`, `pubpup2006p`, `krayukantk` แยกบัญชีรายบุคคล ไม่ใช้บัญชีร่วม เพื่อ Accountability + ถอนสิทธิ์รายคนได้ → [[20-Server/Linux-User-Accounts]] | ✅ |
| **10** | **กำหนดสิทธิ์ผู้ดูแล** — จัดกลุ่มสิทธิ์ดูแลระบบตามบทบาท | 🔧 · ⏳ ควรทบทวน sudo scope ว่าทุกคนจำเป็นต้องมี sudo เต็มหรือไม่ |
| **11** | **ทดสอบ SSH ภายใน** — ทุกบัญชีเข้าได้ด้วย password login, Server reachable | ✅ |
| **12** | **ติดตั้ง Twingate Connector** — Docker Connector บน Beelink, Remote Network ชื่อ `aegissut`, สถานะ **Online / Healthy** *(หมายเหตุ: Connector รันบน Docker Bridge network)* → [[30-RemoteAccess/Twingate-Setup]] | ✅ |
| **13** | **สร้าง Twingate Resource / Access Policy** — Resource `AEGIS-Beelink-SSH` ชี้ที่ `192.168.10.10`, อนุญาต **TCP 22 เท่านั้น** (UDP/ICMP ปิด), ผูกกับ Group `Admin`, เพิ่มสมาชิกเข้ากลุ่มแล้ว | ✅ |
| **14** | **ทดสอบ Remote Access จากภายนอก** — ผ่าน Mobile Hotspot, Windows เห็น Interface `Twingate`, **`TcpTestSucceeded: True`**, SSH เข้า Beelink จากนอกเครือข่ายสำเร็จ | ✅ **มีหลักฐาน** |
| **15** | **SSH Hardening** — สร้าง SSH Key (ed25519), ใส่ Public Key ใน `authorized_keys`, `admin-main` ทดสอบเข้าโดยไม่ถาม password ผ่านแล้ว → [[20-Server/SSH-Hardening-Status]] | 🔧 **ยังไม่ปิดงาน** ⚠️ |

---

## ⚠️ รายละเอียดขั้น 15 ที่ยังไม่ปิดงาน

1. `pubpup2006p` และ `krayukantk` **ต้องสร้าง Key บนเครื่องตัวเอง** (ไม่ใช่สร้างบน Laptop ของ admin แบบที่เคยทำผิดวิธี — Private Key ต้องไม่เคยออกจากเครื่องเจ้าของ)
2. ต้อง **ลบ Public Key ซ้ำ / ที่สร้างผิดเครื่อง** ออกจาก `authorized_keys`
3. **ยังไม่ปิด `PasswordAuthentication`** — ยัง login ด้วยรหัสผ่านได้อยู่

→ Checklist 8 ขั้นตอนแบบเต็ม (ห้ามข้ามลำดับ) อยู่ที่ [[20-Server/SSH-Hardening-Status]]

---

## 📊 สรุปเชิงตัวเลข

| สถานะ | จำนวนขั้น |
| :--- | :--- |
| ✅ ทำจริง + ทดสอบแล้ว | **12** (ขั้น 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14 — โดยขั้น 2/5/8 มีงานย่อยค้าง ⏳) |
| 🔧 ทำแล้วยังไม่ปิดงาน | **2** (ขั้น 10 sudo scope, ขั้น 15 SSH Hardening) |
| ⏳ งานย่อยที่ค้างอยู่ในขั้นที่ ✅ แล้ว | Export config backup, review firewall rule, ตรวจสถานะ ESP32, audit docker version |

> 🎯 **โดยสรุป: ชั้น Network + Remote Access ใช้งานได้จริงและทดสอบแล้ว ส่วนชั้น Server Hardening + Application Deployment ยังไม่ปิด**

---

## ❌ สิ่งที่ **ยังไม่ได้ทำ** (ห้ามสับสนว่าทำแล้ว)

| รายการ | สถานะจริง |
| :--- | :--- |
| UFW Production Rules | ⏳ **เคยปิดชั่วคราวตอนทดสอบ routing — ต้องตรวจสถานะจริง** |
| `PasswordAuthentication no` | ⏳ ยังไม่ปิด |
| Deploy Docker production stack ลง Beelink | ⏳ ยังไม่ deploy → [[40-Deployment/Docker-Stack-Plan]] |
| IDEA3 MQTT / ESP32 / Relay / Heartbeat | ⏳ **เขียนโค้ดแล้วยังไม่ทดสอบกับฮาร์ดแวร์** → [[04 - 🔒 IDEA3 AEGIS Lockdown]] |
| Rotate Twingate Connector Token | ⏳ ยังไม่ทำ |
| Backup config (MikroTik / Switch / Ubuntu) | ⏳ ยังไม่ทำ |
| กำหนด IP ให้ Detection Laptop | ⏳ ยังไม่ทำ |
| Disable OpenVPN service | ⏳ ยังไม่ยืนยัน → [[30-RemoteAccess/OpenVPN-Deprecated]] |

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[00-MOC/AEGIS-Infrastructure-MOC]]
* [[90-Status/Open-Items-Backlog]] — คิวงานถัดไป P1/P2/P3
* [[90-Status/Document-Conflicts]] — จุดที่เอกสารขัดกับของจริง
