---
title: Managed Switch VLAN Config (TL-SG105E)
tags: [aegis, infrastructure, network, switch, vlan, pvid, 802.1q]
type: infrastructure
status: ✅ ตั้งค่า+ทดสอบแล้ว · ⏳ ยังไม่ backup config
created: 2026-08-06
updated: 2026-08-06
---

# 🔌 Managed Switch — VLAN / PVID ที่ตั้งจริง

> อุปกรณ์: **TP-Link TL-SG105E** 5 พอร์ต ([[entities/TP-Link_TL-SG105E]])
> บทบาท: **Layer 2 802.1Q Segmentation** — บังคับให้แต่ละพอร์ตอยู่เฉพาะวงของตัวเอง
> กลับไปหน้าศูนย์รวม: [[00-MOC/AEGIS-Infrastructure-MOC]]

---

## ✅ Port Mapping ที่ตั้งค่าจริง

| Port | โหมด | PVID | VLAN | อุปกรณ์ที่ต่อ | สถานะ |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1** | **Trunk — Tagged** | 1 | 10, 20, 30 | ไปยัง MikroTik `ether2` | ✅ |
| **2** | Access — Untagged | **10** | VLAN 10 Server | **Beelink Mini S** (`192.168.10.10`) | ✅ |
| **3** | Access — Untagged | **20** | VLAN 20 Detector | **Detection Laptop** | ✅ (⏳ เครื่องยังไม่กำหนด IP) |
| **4** | Access — Untagged | **1** | Native / ช่าง | พอร์ตช่าง — ใช้เข้าหน้าเว็บจัดการ Switch | ✅ |
| **5** | Access — Untagged | **30** | VLAN 30 Management | **Admin Laptop** | ✅ |

> ✅ **PVID ตั้งตรงกับ VLAN membership ของทุกพอร์ตแล้ว** — จุดนี้สำคัญ เพราะถ้า PVID ไม่ตรง เฟรม untagged จากเครื่องปลายทางจะถูกยัดเข้าวงผิด และ Inter-VLAN Routing จะดูเหมือน "พัง" ทั้งที่ Router ถูกต้อง

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

* [[00-MOC/AEGIS-Infrastructure-MOC]]
* [[10-Network/VLAN-IP-Plan]] · [[10-Network/MikroTik-Config]] · [[10-Network/Hardware-Inventory]]
* [[concepts/VLAN_Segmentation_and_Port_Mapping]] (ฉบับออกแบบในเล่ม)
* [[90-Status/Open-Items-Backlog]]
