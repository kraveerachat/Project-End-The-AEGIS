---
title: Hardware Inventory (ของจริง)
tags: [aegis, infrastructure, hardware, inventory, network]
type: infrastructure
status: ✅ ครบตามแผน (ยกเว้น IDEA3 ⏳)
created: 2026-08-06
updated: 2026-08-06
---

# 🧰 Hardware Inventory — อุปกรณ์จริงที่ติดตั้งแล้ว

> โน้ตนี้บันทึก **อุปกรณ์ที่มีอยู่จริงและใช้งานจริง** ณ 6 ส.ค. 2026
> ถ้าเอกสาร/เล่มรายงานระบุรุ่นไม่ตรงกับตารางนี้ → **ยึดตารางนี้** และดู [[90-Status/Document-Conflicts]]
>
> กลับไปหน้าศูนย์รวม: [[00-MOC/AEGIS-Infrastructure-MOC]]

---

## 📦 ตารางอุปกรณ์

| # | อุปกรณ์ | รุ่น / สเปกจริง | บทบาทในระบบ | ตำแหน่งเครือข่าย | สถานะ |
| :-- | :--- | :--- | :--- | :--- | :--- |
| 1 | **Beelink Mini S** | Intel Celeron **N5095**, RAM **8 GB**, SSD **128 GB**, HDD **1 TB** | Core Server Host — Ubuntu Server `aegis-system` | VLAN 10 · `192.168.10.10` | ✅ ติดตั้ง+ทดสอบแล้ว |
| 2 | **MikroTik hEX lite** | **RB750r2** | Edge Router / Inter-VLAN Routing / Firewall | ether1 = WAN, ether2 = Trunk | ✅ ตั้งค่า+ทดสอบ Routing แล้ว |
| 3 | **TP-Link Managed Switch** | **TL-SG105E** (5 พอร์ต) | Layer 2 VLAN Segmentation (802.1Q) | Port 1 = Trunk | ✅ ตั้ง VLAN/PVID+ทดสอบแล้ว |
| 4 | **Admin Laptop** | เครื่องของกล้า (ผู้ดูแล infra) | Management workstation + Twingate client | VLAN 30 (Port 5) | ✅ ใช้งานจริง (📋 ยังไม่ fix IP) |
| 5 | **Detection Laptop** | Laptop + Webcam | Edge AI — Detection Engine ของ [[03 - 📹 IDEA2 AEGIS Monitor]] | VLAN 20 (Port 3) | ✅ มีเครื่อง / ⏳ ยังไม่กำหนด IP |
| 6 | **ESP32 + Relay Module** | ตาม [[entities/ESP32_Relay_Module]] | Cyber-Physical Lockdown ของ [[04 - 🔒 IDEA3 AEGIS Lockdown]] | ⏳ ยังไม่เข้าเครือข่าย | ⏳ **ต้องตรวจสถานะจริงว่ามีของ/ต่อได้หรือยัง** |

> ⚠️ แถวที่ 6 ห้ามเขียนในเล่มว่าติดตั้งแล้ว — สถานะปัจจุบันของ IDEA3 คือ **"เขียนโค้ดแล้วยังไม่ทดสอบกับฮาร์ดแวร์"**

---

## 🔍 หมายเหตุการยืนยันรุ่น

* รุ่นที่ยืนยันแล้วคือ **RB750r2** และ **TL-SG105E**
* หากพบเอกสารเก่าเขียน `RB750Gr3` หรือ `TL-SG108E` ให้ถือว่า **ผิด** และแก้ตามตารางนี้
* ตรวจแล้ว 2026-08-06: โน้ตในวอลต์ ([[entities/MikroTik_hEX_lite]], [[entities/TP-Link_TL-SG105E]], [[raw/AEGIS_System_Design_extracted]]) **ระบุรุ่นถูกต้องอยู่แล้ว** — ความขัดแย้งนี้อยู่ในเอกสาร/สไลด์นอกวอลต์ ดูข้อ 1 ใน [[90-Status/Document-Conflicts]]

---

## ⚡ สิ่งที่ยังไม่ได้ทำกับฮาร์ดแวร์

| งาน | สถานะ | อ้างอิง |
| :--- | :--- | :--- |
| Export config backup ของ MikroTik | ⏳ | [[10-Network/MikroTik-Config]] |
| Backup config ของ Switch | ⏳ | [[10-Network/Switch-VLAN-Config]] |
| กำหนด Static / DHCP Reservation ให้ Detection Laptop | ⏳ | [[10-Network/VLAN-IP-Plan]] |
| ตรวจสถานะ ESP32 / Relay | ⏳ | [[04 - 🔒 IDEA3 AEGIS Lockdown]] |

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[00-MOC/AEGIS-Infrastructure-MOC]]
* [[10-Network/VLAN-IP-Plan]]
* [[20-Server/Beelink-Ubuntu-Host]]
* [[entities/Beelink_Mini_S_NAS]] · [[entities/MikroTik_hEX_lite]] · [[entities/TP-Link_TL-SG105E]] · [[entities/ESP32_Relay_Module]]
* [[90-Status/Open-Items-Backlog]]
