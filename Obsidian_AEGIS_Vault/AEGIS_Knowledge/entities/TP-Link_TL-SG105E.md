---
title: TP-Link TL-SG105E Managed Switch
tags: [aegis, entity, network, switch, tplink, vlan, port-mapping]
type: entity
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🔌 TP-Link TL-SG105E (5-Port Easy Smart Managed Switch)

> **บทบาท**: สวิตช์จัดการได้ระดับ Layer 2 ทำหน้าที่แบ่งและล็อกพอร์ตสัญญาณตามมาตรฐาน 802.1Q VLAN ป้องกันการรั่วไหลของสัญญาณข้ามวงเครือข่าย

---

## 📋 แผนผังพอร์ตการใช้งาน (5-Port Full Mapping)

| พอร์ต | ประเภท (Type) | PVID | VLAN ที่ผูก | อุปกรณ์ที่ต่อ |
| :--- | :--- | :--- | :--- | :--- |
| **Port 1** | Trunk (Tagged) | 1 | 10, 20, 30 | รับท่อรวมจาก MikroTik (ether2) |
| **Port 2** | Access (Untagged) | 10 | VLAN 10 (Server) | Beelink Mini S (NAS Server) |
| **Port 3** | Access (Untagged) | 20 | VLAN 20 (Detector) | Laptop (Webcam + Detection Engine) |
| **Port 4** | Access (Untagged) | 1 | Native (VLAN 1) | พอร์ตช่างเทคนิคชั่วคราว (สวิตช์ IP `192.168.30.2`) |
| **Port 5** | Access (Untagged) | 30 | VLAN 30 (Mgmt) | Laptop Admin (สายหลักคงเหลือเมื่อตัด Uplink) |

---

## 🔒 ฟีเจอร์ความปลอดภัยของสวิตช์
* **Not Member Isolation**: พอร์ต 2, 3, 5 ถูกถอดสิทธิ์ออกจาก VLAN 1 (Native) เพื่อป้องกันสัญญาณจากวงโรงงานเดิมรั่วเข้ามา
* **Web Management Protection**: สวิตช์ IP `192.168.30.2` สามารถเข้าถึงหน้าตั้งค่าได้เฉพาะเมื่อต่อสายตรงที่พอร์ต 4 (Port ช่าง) เท่านั้น

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[concepts/VLAN_Segmentation_and_Port_Mapping]]
* [[entities/MikroTik_hEX_lite]]
* [[entities/Beelink_Mini_S_NAS]]
