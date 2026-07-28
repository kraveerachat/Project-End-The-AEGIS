---
title: TP-Link TL-SG105E Managed Switch
tags: [aegis, entity, network, switch, tplink, vlan, port-mapping]
type: entity
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🔌 TP-Link TL-SG105E (5-Port Easy Smart Managed Switch)

> **Role**: Layer 2 Managed Switch responsible for segmenting and locking port traffic based on 802.1Q VLAN standards, preventing cross-VLAN network leakage.

---

## 📋 Port Mapping Layout (5-Port Full Mapping)

| Port | Type | PVID | Bound VLAN | Connected Device |
| :--- | :--- | :--- | :--- | :--- |
| **Port 1** | Trunk (Tagged) | 1 | 10, 20, 30 | Trunk connection from MikroTik (ether2) |
| **Port 2** | Access (Untagged) | 10 | VLAN 10 (Server) | Beelink Mini S (NAS Server) |
| **Port 3** | Access (Untagged) | 20 | VLAN 20 (Detector) | Laptop (Webcam + Detection Engine) |
| **Port 4** | Access (Untagged) | 1 | Native (VLAN 1) | Temporary Technician Port (Switch IP `192.168.30.2`) |
| **Port 5** | Access (Untagged) | 30 | VLAN 30 (Mgmt) | Admin Laptop (Main lifeline remaining when Uplink cut) |

---

## 🔒 Switch Security Features
* **Not Member Isolation**: Ports 2, 3, and 5 are removed from VLAN 1 (Native) membership to prevent default factory VLAN traffic leakage.
* **Web Management Protection**: Switch IP `192.168.30.2` web interface is accessible only when directly wired to Port 4 (Technician Port).

---

## 🔗 Related Notes
* [[concepts/VLAN_Segmentation_and_Port_Mapping]]
* [[entities/MikroTik_hEX_lite]]
* [[entities/Beelink_Mini_S_NAS]]
