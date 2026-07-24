---
title: ZTNA Twingate vs OpenVPN Remote Access
tags: [aegis, concept, security, ztna, vpn, remote-access]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🌐 ZTNA Twingate vs OpenVPN Dual Remote Access

> **หลักการสำคัญ (จากรายงานหลัก Section 2.3.4 & 3.5.6)**: การออกแบบช่องทางเข้าถึงระยะไกล 2 เส้นทางคู่ขนาน ยึดหลัก **Out-of-band Management** และ **Least Privilege** โดยแบ่งตามระดับความเสี่ยงของอุปกรณ์ปลายทาง

---

## 📊 เปรียบเทียบ 2 เส้นทางเข้าถึงระยะไกล

```mermaid
graph TD
    subgraph RemoteClients [Remote Clients]
        AdminPC["Laptop Admin (Arch Linux)<br/><i>High-Trust Computer</i>"]
        MobileUser["Mobile / Phone<br/><i>Low-Trust / High-Risk Device</i>"]
    end

    subgraph AccessGateways [Remote Gateways]
        OpenVPN["Door 0-A: OpenVPN Server<br/>(on MikroTik hEX lite)"]
        Twingate["Door 0-B: Twingate ZTNA Connector<br/>(Outbound-Only Container)"]
    end

    subgraph AEGISVLANs [AEGIS Internal Network]
        MgmtZone["VLAN 30 Management Zone<br/>(Full L3 Access + SSH)"]
        DriveApp["VLAN 10 Server Zone<br/>(NAS App Port 443 Only)"]
    end

    AdminPC -->|OpenVPN Tunnel| OpenVPN --> MgmtZone
    MobileUser -->|Scoped Policy| Twingate --> DriveApp

    classDef vpnStyle fill:#1e3a8a,stroke:#3b82f6,color:#fff;
    classDef ztnaStyle fill:#065f46,stroke:#10b981,color:#fff;
    class OpenVPN vpnStyle;
    class Twingate ztnaStyle;
```

---

## 🔑 เปรียบเทียบฟังก์ชันเชิงลึก

| คุณลักษณะ | เส้นทางที่ 1: OpenVPN (ด่าน 0-A) | เส้นทางที่ 2: Twingate ZTNA (ด่าน 0-B) |
| :--- | :--- | :--- |
| **อุปกรณ์เป้าหมาย** | คอมพิวเตอร์ / Admin PC | โทรศัพท์มือถือ / อุปกรณ์พกพา |
| **ระดับสิทธิ์ที่ได้รับ** | Broad Network Access (เสมือนต่อพอร์ต 5 หน้างาน) | Scoped Access (ล็อกราย IP:Port เฉพาะแอป) |
| **การเชื่อมต่อ** | รับ IP จากพูล `192.168.30.100–200` (VLAN 30) | Outbound-Only Connector (ไม่ต้องเปิดพอร์ต Inbound) |
| **ความสามารถ** | SSH Terminal เข้า Beelink, บริหารจัดการระบบเชิงลึก | เข้าใช้งานเฉพาะหน้าเว็บ AEGIS Drive พอร์ต 443 |
| **ความปลอดภัย** | ป้องกันด้วย ใบรับรองและรหัสผ่าน | ป้องกันปัญหาหากมือถือสูญหายหรือติดมัลแวร์ ไม่เห็นอุปกรณ์อื่นใน LAN |

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[concepts/VLAN_Segmentation_and_Port_Mapping]]
* [[entities/MikroTik_hEX_lite]]
* [[02 - 💾 IDEA1 AEGIS Drive LC]]
