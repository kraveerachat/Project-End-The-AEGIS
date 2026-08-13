---
title: Beelink Mini S NAS
tags: [aegis, entity, hardware, nas, server]
type: entity
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
owner: kla
edit_policy: owner-writable
---

# 💻 Beelink Mini S (System Core NAS Server)

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
* [[idea1/idea1-status]]
* [[concepts/Three_Layer_Data_Lake]]
* [[concepts/VLAN_Segmentation_and_Port_Mapping]]
