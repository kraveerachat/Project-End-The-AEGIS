---
title: Beelink Mini S NAS
tags: [aegis, entity, hardware, nas, server]
type: entity
created: 2026-07-20
updated: 2026-08-06
status: ✅ Host ใช้งานจริง · ⏳ ยังไม่ deploy application stack
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 💻 Beelink Mini S (System Core NAS Server)

> ## ⚠️ Reality Check (2026-08-06)
>
> * ✅ สเปกและ IP `192.168.10.10` ตรงกับของจริง · hostname จริงคือ **`aegis-system`** · Headless
> * ✅ SSH Service + Docker environment พร้อมใช้งาน
> * ⏳ **ยังไม่มี Docker application stack (Gateway/Drive/Monitor/PostgreSQL) รันบนเครื่องนี้** — ตอนนี้มีเพียง **Twingate Connector** container
> * ⏳ **HDD 1TB ยังไม่ถูก mount/ใช้เป็น Data Lake จริง**
> * ⏳ **สถานะ UFW ยังไม่ยืนยัน** (เคยปิดชั่วคราวตอนทดสอบ routing)
>
> 👉 สถานะจริงและงานค้างทั้งหมด: [[20-Server/Beelink-Ubuntu-Host]]

> **Role**: The heart and central command brain of the AEGIS system. Acts as a 3-Layer Edge Data Lake and runs sub-servers via Docker Containers.

---

## 📋 Hardware Specifications

* **CPU**: Intel Celeron N5095 (x86-64 Architecture)
* **RAM**: 8GB DDR4
* **Storage**: 128GB SSD (System/Containers) + 1TB HDD (Data Lake Storage)
* **OS**: Ubuntu Server 24.04 LTS
* **IP Address**: `192.168.10.10` (VLAN 10 Server Zone)

---

## 🛠️ Architectural Rationale for Selecting x86-64
The team selected the Beelink Mini S (x86-64) over ARM boards (such as Raspberry Pi 5) due to its superior stability when running multiple Docker containers simultaneously, lack of thermal throttling issues, and better support for 24/7 heavy workloads.

---

## 🔗 Related Notes
* [[02 - 💾 IDEA1 AEGIS Drive LC]]
* [[concepts/Three_Layer_Data_Lake]]
* [[concepts/VLAN_Segmentation_and_Port_Mapping]]
