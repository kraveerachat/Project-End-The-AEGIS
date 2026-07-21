---
title: Beelink Mini S NAS
tags: [aegis, entity, hardware, nas, serve]
type: entity
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 💻 Beelink Mini S (System Core NAS Server)

> **บทบาท**: หัวใจและสมองสั่งการหลักของระบบ AEGIS ทำหน้าที่เป็นคลังข้อมูล 3 เลเยอร์ (Edge Data Lake) และรันคาร์ดินัลเซิร์ฟเวอร์ย่อยผ่าน Docker Containers

---

## 📋 ข้อมูลสเปกอุปกรณ์ (Hardware Specifications)

* **CPU**: Intel Celeron N5095 (x86-64 Architecture)
* **RAM**: 8GB DDR4
* **Storage**: 128GB SSD (System/Containers) + 1TB HDD (Data Lake Storage)
* **OS**: Ubuntu Server 24.04 LTS
* **IP Address**: `192.168.10.10` (VLAN 10 Server Zone)

---

## 🛠️ เหตุผลทางสถาปัตยกรรมที่เลือก x86-64
ทีมงานเลือกใช้ Beelink Mini S (x86-64) แทน ARM (เช่น Raspberry Pi 5) เนื่องจากสามารถรัน Docker Containers หลายตัวพร้อมกันได้อย่างมีเสถียรภาพสูง ปราศจากปัญหาความร้อนสะสม และรองรับภาระงานหนักแบบ 24/7 ได้ดียิ่งกว่า

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[modules/02_IDEA1_AEGIS_Drive_LC]]
* [[concepts/Three_Layer_Data_Lake]]
* [[concepts/VLAN_Segmentation_and_Port_Mapping]]
