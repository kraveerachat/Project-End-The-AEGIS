---
title: Hardware Inventory (ของจริง)
tags: [aegis, infrastructure, hardware, inventory, network]
type: infrastructure
status: ✅ ครบตามแผน (ยกเว้น IDEA3 ⏳)
created: 2026-08-06
updated: 2026-09-30
owner: kla
edit_policy: owner-writable
---

# 🧰 Hardware Inventory — อุปกรณ์จริงที่ติดตั้งแล้ว

> โน้ตนี้บันทึก **อุปกรณ์ที่มีอยู่จริงและใช้งานจริง** ณ 6 ส.ค. 2026
> ถ้าเอกสาร/เล่มรายงานระบุรุ่นไม่ตรงกับตารางนี้ → **ยึดตารางนี้** และดู [[90-Status/Document-Conflicts]]
>
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

---

## 📦 ตารางอุปกรณ์

| # | อุปกรณ์ | รุ่น / สเปกจริง | บทบาทในระบบ | ตำแหน่งเครือข่าย | สถานะ |
| :-- | :--- | :--- | :--- | :--- | :--- |
| 1 | **Beelink Mini S** | Intel Celeron **N5095**, RAM **8 GB**, SSD **128 GB**, HDD **1 TB** | Core Server Host — Ubuntu Server `aegis-system` | VLAN 10 · `192.168.10.10` (`enp1s0` 1 Gbps Full) | ✅ ติดตั้ง+ทดสอบแล้ว · ลิงก์ 1 Gbps ยืนยันแล้ว |
| 2 | **MikroTik hEX lite** | **RB750r2** (rev r3, RouterOS 7.18.2 stable) | Edge Router / Inter-VLAN Routing / Firewall | ether1 = WAN (100M Full), ether2 = Trunk (100M Full, VLAN 10/20/30/40) | ✅ ยืนยันจากอุปกรณ์จริง (2026-09-30) |
| 3 | **TP-Link Managed Switch** | **TL-SG105E 5.0** (5 พอร์ต, IP `192.168.30.2`) | Layer 2 VLAN Segmentation (802.1Q) | Port 1 Trunk (100MF), Port 2 (1000MF), Port 3 (VLAN20), Port 4 (VLAN40), Port 5 (1000MF) | ✅ ยืนยัน PVID/พอร์ตจริงแล้ว (2026-09-30) |
| 4 | **Admin Laptop** | เครื่องของกล้า (Realtek PCIe GbE 1 Gbps) | Management workstation + Twingate client | VLAN 30 (Port 5, 1000MF) | ✅ ใช้งานจริง (ลิงก์ 1 Gbps ยืนยันแล้ว) |
| 5 | **Detection Laptop** | Laptop + Webcam | Edge AI — Detection Engine ของ [[idea2/idea2-status]] | VLAN 20 (Port 3, PVID 20) | ✅ มีเครื่อง / พอร์ต Link Down |
| 6 | **ESP32 + Relay Module** | ตาม [[entities/ESP32_Relay_Module]] | Cyber-Physical Lockdown ของ [[idea3/idea3-status]] | VLAN 40 (Port 4, PVID 40) | ⏳ สายต่อไปยัง Port 4 (Link Down) / รอยืนยันฮาร์ดแวร์ |

> ⚠️ แถวที่ 6 ห้ามเขียนในเล่มว่าติดตั้งแล้ว — สถานะปัจจุบันของ IDEA3 คือ **"เขียนโค้ดแล้วยังไม่ทดสอบกับฮาร์ดแวร์"**

---

## 🔍 หมายเหตุการยืนยันรุ่นและการจับคู่พอร์ต

* รุ่นที่ยืนยันจริงจากฮาร์ดแวร์คือ **RB750r2** (revision r3, RouterOS 7.18.2) และ **TL-SG105E 5.0**
* หากพบเอกสารเก่าเขียน `RB750Gr3` หรือ `TL-SG108E` ให้ถือว่า **ผิด** และแก้ตามตารางนี้
* **การปรับปรุงความจริงของพอร์ตสวิตช์ (Reconciled 2026-09-30)**: เอกสารเก่าที่ระบุว่า Port 4 เป็น "พอร์ตช่าง / Native VLAN 1" ล้าสมัยแล้ว ผลการตรวจคอนฟิกสวิตช์จริงพบว่า **Port 4 = Access VLAN 40 (IDEA3)** มี PVID 40 และ **Port 5 = Access VLAN 30 (Management)** มี PVID 30 หน้าเว็บจัดการ Switch เข้าถึงผ่าน `192.168.30.2` บน VLAN 30

---

## 🚦 ข้อจำกัดความเร็วพอร์ต (ตรวจจริง 2026-09-30)

| ลิงก์ | ความสามารถจริง | ชั้นหลักฐาน (ตรวจจริง 2026-09-30) |
| :--- | :--- | :--- |
| RB750r2 `ether1` (WAN) | **100 Mbps Full Duplex** | ตรวจจริงจากอุปกรณ์: monitor `ether1` rate=100Mbps full-duplex=yes status=link-ok |
| RB750r2 `ether2` (Trunk) ↔ Switch Port 1 | **100 Mbps Full Duplex** (100MF) | ตรวจจริงจากอุปกรณ์ทั้งสองฝั่ง: RB750r2 monitor `ether2` rate=100Mbps full-duplex=yes และ TL-SG105E Port 1 = 100MF |
| Beelink `enp1s0` ↔ Switch Port 2 | **1 Gbps Full Duplex** (1000MF) | ตรวจจริงจากอุปกรณ์ทั้งสองฝั่ง: Beelink ethtool speed=1000Mb/s duplex=Full และ TL-SG105E Port 2 = 1000MF |
| Admin Laptop ↔ Switch Port 5 | **1 Gbps Full Duplex** (1000MF) | ตรวจจริงจากอุปกรณ์: Realtek PCIe GbE LinkSpeed 1 Gbps และ TL-SG105E Port 5 = 1000MF |
| Switch Port 3 (VLAN 20) | Link Down (รองรับ 1 Gbps) | ตรวจจริงจากสวิตช์: Port 3 Link Down (PVID 20) |
| Switch Port 4 (VLAN 40) | Link Down (รองรับ 1 Gbps) | ตรวจจริงจากสวิตช์: Port 4 Link Down (PVID 40) |

ผลคือ traffic ข้าม VLAN (เช่น VLAN 30 → HUB บน VLAN 10) ถูกคอขวดที่ `ether2` / Switch Port 1 ซึ่งเป็น 100 Mbps Full Duplex —
PR #216 วัดเพดานร่วม ~10.7 MB/s (upload) / ~11.1 MB/s (download) ≈ 91–95% ของ TCP goodput บน 100 Mbps
สถานะ: `P1_ROUTER_TRUNK_100MBPS_CEILING=PROVEN_LIVE`
ฮาร์ดแวร์โปรดักชันปัจจุบัน: คงเดิมที่ **RB750r2 + TL-SG105E** (`CURRENT_PRODUCTION_ARCHITECTURE=RB750r2_PLUS_TL-SG105E`)
การเปลี่ยนฮาร์ดแวร์/จัดซื้อ: **ยังไม่อนุมัติ** (`HARDWARE_REPLACEMENT_AUTHORIZED=NO`, `PROCUREMENT_AUTHORIZED=NO`)
แนวทางแก้ระดับ Gigabit: เก็บเป็นเอกสารออกแบบอ้างอิงสำหรับอนาคต (`REPLACEMENT_WORK_STATE=DEFERRED_OPTIONAL_FUTURE_WORK`) ที่ `docs/superpowers/specs/2026-09-30-aegis-gigabit-intervlan-remediation-design.md`
ขั้นตอนถัดไปของโปรเจกต์: นำข้อจำกัดฮาร์ดแวร์ 100 Mbps ที่พิสูจน์แล้วไป reconcile เอกสารใน PR #216 (`RECONCILE_PR216_WITH_LIVE_PROVEN_HARDWARE_PATH_LIMIT`)

> ⚠️ ถ้าเปลี่ยน Router ในอนาคต ให้บันทึกรุ่นใหม่ในตารางด้านบนชัดเจน — `RB750Gr3` ที่ถูกระบุว่า "ผิด" ข้างบนหมายถึงเอกสารเก่า ไม่ใช่ข้อห้ามใช้รุ่นนั้น

---

## ⚡ สิ่งที่ยังไม่ได้ทำกับฮาร์ดแวร์

| งาน | สถานะ | อ้างอิง |
| :--- | :--- | :--- |
| Export config backup ของ MikroTik | ✅ ทำแล้ว (2026-09-30, Step 2 PR #259) | [[infrastructure/network/MikroTik-Config]] |
| Backup config ของ Switch | ⏳ | [[infrastructure/network/Switch-VLAN-Config]] |
| กำหนด Static / DHCP Reservation ให้ Detection Laptop | ⏳ | [[infrastructure/network/VLAN-IP-Plan]] |
| ตรวจสถานะ ESP32 / Relay | ⏳ | [[idea3/idea3-status]] |

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/network/VLAN-IP-Plan]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[entities/Beelink_Mini_S_NAS]] · [[entities/MikroTik_hEX_lite]] · [[entities/TP-Link_TL-SG105E]] · [[entities/ESP32_Relay_Module]]
* [[90-Status/Open-Items-Backlog]]
