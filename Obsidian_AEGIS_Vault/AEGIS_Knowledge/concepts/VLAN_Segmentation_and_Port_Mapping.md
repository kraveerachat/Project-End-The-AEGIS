---
title: VLAN Segmentation & Port Mapping
tags: [aegis, concept, network, vlan, port-mapping, macvlan]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🌐 VLAN Segmentation & Port Mapping Architecture

> **Core Concept**: Layer 2 (802.1Q VLAN) security zone segmentation on [[entities/TP-Link_TL-SG105E|TP-Link TL-SG105E]] Managed Switch combined with [[entities/MikroTik_hEX_lite|MikroTik Router]] and Docker Macvlan on [[entities/Beelink_Mini_S_NAS|Beelink NAS]].

---

## 📊 VLAN & Subnet Allocation Table

| VLAN | Zone Name | Subnet | Gateway | Main Connected Devices |
| :--- | :--- | :--- | :--- | :--- |
| **10** | Server Zone | `192.168.10.0/24` | `192.168.10.1` | Beelink NAS, Docker Services |
| **20** | Detector Zone | `192.168.20.0/24` | `192.168.20.1` | Edge AI Laptop, Detection Engine |
| **30** | Management Zone | `192.168.30.0/24` | `192.168.30.1` | Admin Laptop, OpenVPN Pool (`30.100–200`) |
| **1** | Native/Technician | — | — | Switch Web Interface (`192.168.30.2`) |

---

## 🔌 TL-SG105E Switch Port Mapping

| Port | Type | PVID | Target VLAN | Connected Device |
| :--- | :--- | :--- | :--- | :--- |
| **1** | Trunk (Tagged) | 1 | 10, 20, 30 | Connected to MikroTik Router (ether2) |
| **2** | Access (Untagged) | 10 | Server (10) | Beelink Mini S (NAS Server) |
| **3** | Access (Untagged) | 20 | Detector (20) | Laptop (Webcam + Detection Engine) |
| **4** | Access (Untagged) | 1 | Native (1) | Temporary Technician Port |
| **5** | Access (Untagged) | 30 | Management (30) | Admin Laptop (Main lifeline remaining when Uplink cut) |

---

## 🐳 Docker Macvlan IP Allocation (VLAN 10)

For performance and isolation, each service on Beelink receives a real dedicated IP address in VLAN 10 via Docker Macvlan:
* `192.168.10.10`: Beelink Host OS (Ubuntu Server)
* `192.168.10.11`: [[02 - 💾 IDEA1 AEGIS Drive LC|AEGIS Drive Web App]]
* `192.168.10.12`: [[03 - 📹 IDEA2 AEGIS Monitor|AEGIS Monitor Web App]]
* `192.168.10.13`: Local MQTT Broker

---

## 🔗 Related Notes
* [[entities/MikroTik_hEX_lite]]
* [[entities/TP-Link_TL-SG105E]]
* [[entities/Beelink_Mini_S_NAS]]
