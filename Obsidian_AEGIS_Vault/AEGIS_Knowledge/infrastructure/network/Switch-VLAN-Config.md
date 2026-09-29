---
title: Managed Switch VLAN Config (TL-SG105E)
tags: [aegis, infrastructure, network, switch, vlan, pvid, 802.1q]
type: infrastructure
status: ✅ ตั้งค่า+ทดสอบแล้ว · ⏳ ยังไม่ backup config
created: 2026-08-06
updated: 2026-09-30
owner: kla
edit_policy: owner-writable
---

# 🔌 Managed Switch — VLAN / PVID ที่ตั้งจริง

> อุปกรณ์: **TP-Link TL-SG105E** 5 พอร์ต (ฮาร์ดแวร์ 5.0, IP `192.168.30.2`) ([[entities/TP-Link_TL-SG105E]])
> บทบาท: **Layer 2 802.1Q Segmentation** — บังคับให้แต่ละพอร์ตอยู่เฉพาะวงของตัวเอง
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

---

## ✅ Port Mapping ที่ตั้งค่าจริง (ตรวจยืนยัน 2026-09-30)

| Port | โหมด | PVID | VLAN Membership | อุปกรณ์ที่ต่อ | สถานะลิงก์จริง (2026-09-30) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **Trunk — Tagged** | 1 | Tagged 10, 20, 30, 40 · Untagged 1 | ไปยัง MikroTik `ether2` | ✅ **100MF** (Full Duplex) |
| **2** | Access — Untagged | **10** | Untagged VLAN 10 Server | **Beelink Mini S** (`192.168.10.10`) | ✅ **1000MF** (1 Gbps Full) |
| **3** | Access — Untagged | **20** | Untagged VLAN 20 IOT-AEGIS | **Detection Laptop** | ⏳ **Link Down** |
| **4** | Access — Untagged | **40** | Untagged VLAN 40 IDEA3 | **Cyber-Physical Lockdown** ([[idea3/idea3-status]]) | ⏳ **Link Down** (รอเชื่อมต่ออุปกรณ์จริง) |
| **5** | Access — Untagged | **30** | Untagged VLAN 30 Management | **Admin Laptop** | ✅ **1000MF** (1 Gbps Full) |

> ⚠️ **ประวัติการปรับปรุง Port 4 (Reconciled 2026-09-30)**: เอกสารเดิมระบุว่า Port 4 เป็น "Native / พอร์ตช่าง VLAN 1" — ข้อมูลดังกล่าวเป็นประวัติเก่าที่ล้าสมัยแล้ว ในการตั้งค่าใช้งานจริงปัจจุบัน Port 4 ถูกกำหนดให้เป็น **Access VLAN 40 (IDEA3)** โดยมี PVID 40 เพื่อรองรับฮาร์ดแวร์ Lockdown Controller ของ IDEA3 ส่วนหน้าเว็บจัดการ Switch นั้นเข้าถึงผ่าน IP `192.168.30.2` บน VLAN 30

> ✅ **PVID ตั้งตรงกับ VLAN membership ของทุกพอร์ตแล้ว**:
> - Port 1: PVID 1
> - Port 2: PVID 10
> - Port 3: PVID 20
> - Port 4: PVID 40
> - Port 5: PVID 30

---

## 🧪 หลักฐานการทดสอบ

| การทดสอบ | ผล | สถานะ |
| :--- | :--- | :--- |
| Ping ข้ามวง VLAN 30 → VLAN 10 | 0% packet loss · 0.5–0.8 ms | ✅ |
| SSH จาก Admin Laptop → Beelink | สำเร็จ | ✅ |
| แยกวงจริง (เครื่องต่างวงไม่เห็นกันโดยตรงถ้าไม่ผ่าน Router) | ผ่านจากผลการทดสอบ routing ข้างต้น | ✅ |

---

## ⏳ สิ่งที่ยังไม่ได้ทำ

| งาน | สถานะ |
| :--- | :--- |
| Backup / Export config ของ Switch | ⏳ (P2 ใน [[90-Status/Open-Items-Backlog]]) |
| ยืนยันว่า Port 2/3/5 ถูกถอดออกจาก VLAN 1 membership แล้วครบ (Not Member) | ⏳ **ยังไม่ยืนยันกับของจริง** — [[entities/TP-Link_TL-SG105E]] ระบุไว้ว่าเป็นข้อออกแบบ |
| เปลี่ยนรหัสผ่าน Web UI จากค่าเริ่มต้น | ⏳ ยังไม่ยืนยัน |

> ⚠️ ห้ามเขียนในเล่มว่า "ทำ Not-Member Isolation ครบแล้ว" จนกว่าจะเปิดหน้า 802.1Q VLAN ของ Switch แล้วเก็บภาพยืนยัน

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/network/VLAN-IP-Plan]] · [[infrastructure/network/MikroTik-Config]] · [[infrastructure/network/Hardware-Inventory]]
* [[concepts/VLAN_Segmentation_and_Port_Mapping]] (ฉบับออกแบบในเล่ม)
* [[90-Status/Open-Items-Backlog]]
