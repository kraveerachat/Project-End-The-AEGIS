---
title: AEGIS Infrastructure MOC
tags: [aegis, moc, infrastructure, network, status]
type: moc
status: 🔧 living-document
created: 2026-08-06
updated: 2026-08-11
---

# 🗺️ AEGIS Infrastructure — Map of Content

> ศูนย์รวมลิงก์และสถานะจริงของงาน **Infrastructure / Network / Remote Access** ของโปรเจกต์ AEGIS
> ณ วันที่ **8 สิงหาคม 2026**
>
> โน้ตชุดนี้บันทึก **สิ่งที่ทำจริงบนฮาร์ดแวร์** แยกจากชุดโน้ตเดิม (`concepts/`, `entities/`) ที่บันทึก **สิ่งที่ออกแบบไว้ในเล่มรายงาน**
> เมื่อสองฝั่งไม่ตรงกัน ให้ยึดโน้ตชุดนี้เป็นความจริง และดูรายการที่ขัดกันได้ที่ [[90-Status/Document-Conflicts]]

---

## 🚦 ความหมายของ Status Marker

| Marker | ความหมาย |
| :--- | :--- |
| ✅ | ทำจริงแล้ว **และมีหลักฐานการทดสอบ** |
| 🔧 | ทำแล้ว แต่ **ยังไม่ทดสอบ / ทดสอบไม่ครบทุกเคส** |
| ⏳ | ยังไม่ได้ทำ |
| 📋 | เป็นแค่ Design ในเล่มรายงาน ยังไม่แตะของจริง |

> ⚠️ **กติกาเหล็ก**: ห้ามเลื่อน 🔧 → ✅ ถ้าไม่มีบรรทัดหลักฐานทดสอบกำกับ

---

## 📌 บริบทโปรเจกต์

* **ชื่อเต็ม**: AEGIS — Autonomous Edge-Guard Infrastructure System for Cyber-Physical Security
* **รายวิชา**: 1101911 มหาวิทยาลัยเทคโนโลยีสุรนารี
* **อาจารย์ที่ปรึกษา**: ผศ. ดร.ทรงยุทธ เพิ่มผล
* **ทีม 3 คน**: กล้า (B6703370 — infra/network/security), มิวสิค (B6701635), ปั๊บ (B6702861) → [[entities/Team_Roles_and_Responsibilities]]
* **3 IDEA**:
  * IDEA1 **AEGIS Drive** — Edge Data Lake / NAS → [[02 - 💾 IDEA1 AEGIS Drive LC]]
  * IDEA2 **AEGIS Monitor** — AI CCTV → [[03 - 📹 IDEA2 AEGIS Monitor]]
  * IDEA3 **Cyber-Physical Lockdown** — ESP32 + Relay + MQTT → [[04 - 🔒 IDEA3 AEGIS Lockdown]]

---

## 🧭 สถานะภาพรวม (Infrastructure Layer)

| ชั้นงาน | สถานะ | โน้ตหลัก |
| :--- | :--- | :--- |
| สถาปัตยกรรมเครือข่าย & Defense in Depth | ✅ | [[10-Network/VLAN-IP-Plan]] |
| ฮาร์ดแวร์ครบตามแผน (ยกเว้น IDEA3) | ✅ / ⏳ ESP32 | [[10-Network/Hardware-Inventory]] |
| Edge Router (MikroTik) + Inter-VLAN Routing | ✅ (⏳ ยังไม่ backup config) | [[10-Network/MikroTik-Config]] |
| Managed Switch VLAN + PVID | ✅ | [[10-Network/Switch-VLAN-Config]] |
| Ubuntu Server Host พร้อมใช้งาน | ✅ | [[20-Server/Beelink-Ubuntu-Host]] |
| บัญชีผู้ใช้รายบุคคล | ✅ (🔧 sudo scope) | [[20-Server/Linux-User-Accounts]] |
| SSH Key Authentication | 🔧 `admin-main` + `krayukantk` ใช้ key ได้ · `pubpup2006p`/strict tests/global Password Auth ยังค้าง | [[20-Server/SSH-Hardening-Status]] |
| Remote Access ผ่าน Twingate ZTNA | ✅ | [[30-RemoteAccess/Twingate-Setup]] |
| OpenVPN | ❌ **เลิกใช้ (Deprecated)** | [[30-RemoteAccess/OpenVPN-Deprecated]] |
| UFW Production Rules | 🔧 Twingate path ✅ · VLAN 30 direct test ⏳ | [[90-Status/Open-Items-Backlog]] |
| Docker Production Stack บน Beelink | ⏳ ยังไม่ deploy | [[40-Deployment/Docker-Stack-Plan]] |
| IDEA3 MQTT / ESP32 / Relay | ⏳ เขียนแล้วยังไม่ทดสอบ | [[04 - 🔒 IDEA3 AEGIS Lockdown]] |

> 📋 **สรุปงาน 15 ขั้นตอนแบบละเอียดพร้อมหลักฐานการทดสอบ** อยู่ที่ [[90-Status/Progress-Log-2026-08-06]]
>
> 🔴 **ลำดับ Security Layer 0 ปัจจุบัน**: `PermitRootLogin no` + Twingate UFW path ผ่านแล้ว → ทดสอบ VLAN 30 direct path → rotate Connector token + ยืนยัน Healthy → key ของ `pubpup2006p`/cleanup → ปิด Password Auth → rotate DB app-role passwords ก่อน deploy
>
> 🔧 **ข้อสรุปเชิงปฏิบัติเรื่อง remote path**: Twingate ใช้ Resource-level access ตรงไป `192.168.10.10:22`; ไม่ขยายสิทธิ์เป็น VLAN 30 ทั้งวง ส่วน VLAN 30 คงเป็น direct-management path แยกต่างหาก การแก้ถ้อยคำในเล่มและการตัดสิน Macvlan vs Bridge+Reverse Proxy ยังอยู่ใน [[90-Status/Document-Conflicts]].

---

## 🗂️ สารบัญโน้ต

### 10-Network
* [[10-Network/Hardware-Inventory]] — รายการอุปกรณ์จริงและสเปก
* [[10-Network/VLAN-IP-Plan]] — ผัง VLAN / Subnet / IP ทุกตัว
* [[10-Network/MikroTik-Config]] — Edge Router, VLAN Interface, Firewall order
* [[10-Network/Switch-VLAN-Config]] — Port mapping / PVID บน TL-SG105E

### 20-Server
* [[20-Server/Beelink-Ubuntu-Host]] — Ubuntu Server host `aegis-system`
* [[20-Server/Linux-User-Accounts]] — บัญชีรายบุคคลและสิทธิ์
* [[20-Server/SSH-Hardening-Status]] — สถานะ SSH Key + Checklist ก่อนปิด Password Login

### 30-RemoteAccess
* [[30-RemoteAccess/Twingate-Setup]] — ZTNA Connector / Resource / Policy
* [[30-RemoteAccess/OpenVPN-Deprecated]] — เหตุผลที่เลิกใช้และสิ่งที่ต้องระวังตอนเขียนเล่ม

### 40-Deployment
* [[40-Deployment/Docker-Stack-Plan]] — แผน deploy Gateway/Drive/Monitor/PostgreSQL

### 90-Status
* [[90-Status/Progress-Log-2026-08-06]] — สรุปงาน 15 ขั้นตอนที่ทำไปแล้ว
* [[90-Status/Open-Items-Backlog]] — คิวงานถัดไปเรียงตาม P1/P2/P3
* [[90-Status/Document-Conflicts]] — จุดที่เอกสาร/เล่มรายงานขัดกับของจริง

---

## 🖼️ ภาพรวมเส้นทางเครือข่ายจริง

```mermaid
flowchart TD
    ISP([🌍 Internet / ISP])
    HomeRouter["🏠 Router บ้านเพื่อน<br/><i>ไม่มีสิทธิ์ Admin → Port Forward ไม่ได้</i>"]
    MT["🌐 MikroTik hEX lite RB750r2<br/>ether1 = WAN (Double NAT)<br/>ether2 = Trunk 802.1Q"]
    SW["🔌 TP-Link TL-SG105E<br/>VLAN 10 / 20 / 30"]

    BEE["💻 Beelink Mini S — 192.168.10.10<br/>Ubuntu Server 'aegis-system'"]
    DET["🎥 Detection Laptop — VLAN 20<br/>⏳ ยังไม่กำหนด IP"]
    ADM["🧑‍💻 Admin Laptop — VLAN 30"]

    TG["☁️ Twingate Relay<br/><i>Outbound-only จาก Connector</i>"]
    REMOTE["📱 Remote Client<br/>(ทดสอบผ่าน Mobile Hotspot ✅)"]

    ISP --> HomeRouter --> MT --> SW
    SW -->|Port 2 · VLAN 10| BEE
    SW -->|Port 3 · VLAN 20| DET
    SW -->|Port 5 · VLAN 30| ADM

    BEE -.->|Connector เชื่อมออกอย่างเดียว| TG
    REMOTE -->|SSH TCP 22 เท่านั้น| TG
    TG -.->|Resource-level path ถึง 192.168.10.10:22 โดยตรง<br/>✅ ไม่ขยายสิทธิ์เป็นทั้ง VLAN 30| BEE

    classDef ok fill:#065f46,stroke:#10b981,color:#fff;
    classDef warn fill:#78350f,stroke:#f59e0b,color:#fff;
    class BEE,MT,SW ok;
    class DET,HomeRouter warn;
```

> เส้นประจาก Twingate ไปยัง Beelink คือ path ที่ใช้งานจริงและแคบกว่า `/24`; ผู้ดูแลระบบยืนยันว่า UFW สำหรับ path นี้ผ่านแล้ว ส่วน VLAN 30 direct-management path ยังต้องทดสอบและความขัดแย้งกับถ้อยคำเดิมในเล่มติดตามที่ข้อ 3 ใน [[90-Status/Document-Conflicts]].

---

## 🔗 เชื่อมกับโน้ตชุดเดิมในวอลต์

* [[00 - 🗺️ AEGIS System Overview]] — สถาปัตยกรรมซอฟต์แวร์ (Monorepo/Docker)
* [[concepts/VLAN_Segmentation_and_Port_Mapping]] — ผัง VLAN ฉบับออกแบบในเล่ม
* [[concepts/ZTNA_Twingate_vs_OpenVPN]] — การเปรียบเทียบฉบับออกแบบ (⚠️ ยังเขียนแบบ 2 ช่องทางคู่ขนาน)
* [[05 - 🛡️ Security Architecture]] — Defense in Depth ระดับแอปพลิเคชัน
