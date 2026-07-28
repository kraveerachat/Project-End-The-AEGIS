---
title: MikroTik hEX lite (RB750r2)
tags: [aegis, entity, network, router, mikrotik, vlan, vpn]
type: entity
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🌐 MikroTik hEX lite (RB750r2 Edge Router)

> **Role**: Isolation Gateway compensating between home ISP internet and the AEGIS system. Functions as Layer 3 Gateway, Inter-VLAN Router, NAT/Firewall, and OpenVPN Server.

---

## 📋 Configuration & Port Details

* **Model**: MikroTik hEX lite (RB750r2)
* **ether1 (WAN)**: Connects 1 LAN cable from home ISP WiFi router, applying NAT/Firewall isolation.
* **ether2 (Trunk Port)**: Carries 802.1Q VLAN trunk (VLAN 10, 20, 30) connected to Port 1 of the TP-Link switch.
* **Inter-VLAN Routing**:
  * Gateway VLAN 10 (Server): `192.168.10.1`
  * Gateway VLAN 20 (Detector): `192.168.20.1`
  * Gateway VLAN 30 (Management): `192.168.30.1`
* **OpenVPN Server**: Assigns IP pool `192.168.30.100–200` for remote computer administration into Management Zone.

---

## 🛠️ Architectural Rationale
The home ISP router cannot handle 802.1Q VLANs effectively and should not be modified to avoid affecting the entire home network. The team added MikroTik as a firewall boundary against Broadcast/Rogue DHCP leakage and to achieve full Layer 3 OSI separation.

---

## 🔗 Related Notes
* [[concepts/VLAN_Segmentation_and_Port_Mapping]]
* [[entities/TP-Link_TL-SG105E]]
* [[concepts/ZTNA_Twingate_vs_OpenVPN]]
