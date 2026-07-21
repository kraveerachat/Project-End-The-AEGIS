---
title: MikroTik hEX lite (RB750r2)
tags: [aegis, entity, network, router, mikrotik, vlan, vpn]
type: entity
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🌐 MikroTik hEX lite (RB750r2 Edge Router)

> **บทบาท**: กำแพงกั้นชดเชย (Isolation Gateway) ระหว่างเครือข่ายอินเทอร์เน็ตบ้านกับระบบ AEGIS ทำหน้าที่เป็น Layer 3 Gateway, Inter-VLAN Router, NAT/Firewall, และ OpenVPN Server

---

## 📋 ข้อมูลการตั้งค่าและพอร์ต (Configuration Details)

* **Model**: MikroTik hEX lite (RB750r2)
* **ether1 (WAN)**: เชื่อมต่อสาย LAN 1 เส้นจากเราเตอร์ WiFi บ้าน (ISP) ทำ NAT/Firewall กั้นสัญญาณ
* **ether2 (Trunk Port)**: ส่งท่อรวม 802.1Q VLAN (VLAN 10, 20, 30) ต่อไปยังพอร์ต 1 ของสวิตช์ TP-Link
* **Inter-VLAN Routing**:
  * Gateway VLAN 10 (Server): `192.168.10.1`
  * Gateway VLAN 20 (Detector): `192.168.20.1`
  * Gateway VLAN 30 (Management): `192.168.30.1`
* **OpenVPN Server**: แจก IP พูล `192.168.30.100–200` สำหรับแอดมินรีโมทผ่านคอมพิวเตอร์เข้าสู่ Management Zone

---

## 🛠️ เหตุผลทางสถาปัตยกรรม
เราเตอร์บ้านของ ISP ไม่สามารถทำ VLAN (802.1Q) ได้อย่างมีประสิทธิภาพ และไม่ควรแก้ไขการตั้งค่าเดิมเพราะจะกระทบเครือข่ายทั้งบ้าน ทีมงานจึงเพิ่ม MikroTik เป็นด่านกั้นการแพร่กระจายของ Broadcast/Rogue DHCP และทำหน้าที่เป็นตัวแยก Layer 3 OSI Model อย่างสมบูรณ์

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[concepts/VLAN_Segmentation_and_Port_Mapping]]
* [[entities/TP-Link_TL-SG105E]]
* [[concepts/ZTNA_Twingate_vs_OpenVPN]]
