---
title: MikroTik Edge Router Config (RB750r2)
tags: [aegis, infrastructure, network, mikrotik, router, firewall, routeros]
type: infrastructure
status: ✅ ทำงานจริง+ทดสอบ Routing แล้ว · ⏳ ยังไม่ backup config
created: 2026-08-06
updated: 2026-08-06
---

# 🌐 MikroTik Edge Router — สิ่งที่ตั้งค่าจริง

> อุปกรณ์: **MikroTik hEX lite RB750r2** ([[entities/MikroTik_hEX_lite]])
> บทบาท: **Edge Router / Inter-VLAN Router / Firewall boundary** ระหว่างวงบ้านกับวง AEGIS
> กลับไปหน้าศูนย์รวม: [[00-MOC/AEGIS-Infrastructure-MOC]]

---

## ✅ สิ่งที่ทำจริงแล้ว

| งาน | รายละเอียด | สถานะ |
| :--- | :--- | :--- |
| แยกวงบ้านออกจากวง AEGIS | `ether1` = WAN รับสายจาก Router บ้าน, ทำ NAT/Firewall กั้น | ✅ |
| สร้าง VLAN Interface | VLAN 10 / 20 / 30 บน `ether2` (Trunk 802.1Q) | ✅ |
| ตั้ง Gateway แต่ละวง | `192.168.10.1` · `192.168.20.1` · `192.168.30.1` | ✅ |
| Inter-VLAN Routing | Routing ข้ามวงทำงานได้ | ✅ ทดสอบแล้ว (ping VLAN30→VLAN10 loss 0%, 0.5–0.8 ms) |
| จัดลำดับ Firewall Rule | ย้าย rule **LAN-to-LAN ขึ้นเหนือ Drop Rule** จึงยอมให้ข้ามวงได้ | ✅ |

> 💡 **บทเรียน**: บน RouterOS ลำดับของ Firewall Rule สำคัญกว่าตัวเนื้อ rule — rule ที่ถูกต้องแต่ถูกวางใต้ `drop` จะไม่มีผลเลย ตอนแรก Inter-VLAN ping ไม่ผ่านเพราะสาเหตุนี้

---

## 🌍 โครงสร้าง WAN (Double NAT)

```
Internet (ISP)
   └── Router บ้านเพื่อน   ← ⚠️ ทีมไม่มีสิทธิ์ Admin → Port Forward ไม่ได้
          └── MikroTik ether1 (WAN)   ← NAT ชั้นที่ 2
                 └── ether2 Trunk → TL-SG105E → VLAN 10/20/30
```

> ผลตามมา: **ทำ Inbound Port Forwarding ไม่ได้เลย** → เป็นเหตุผลหลักที่ทิ้ง OpenVPN แล้วเปลี่ยนไปใช้ ZTNA
> ดู [[30-RemoteAccess/Twingate-Setup]] และ [[30-RemoteAccess/OpenVPN-Deprecated]]

---

## ⏳ สิ่งที่ยังไม่ได้ทำ

| งาน | ทำไมสำคัญ | สถานะ |
| :--- | :--- | :--- |
| **Export Config Backup** (`/export` + `.backup`) | ถ้าอุปกรณ์พังหรือ reset ตอนนี้ = ต้องตั้งใหม่ทั้งหมดจากศูนย์ | ⏳ **ยังไม่ทำ** (P2) |
| **Review Firewall Rule ครบชุดก่อน Production** | ตอนทดสอบ routing มีการผ่อน rule ชั่วคราว ยังไม่ได้ไล่ตรวจว่าเหลืออะไรเปิดกว้างไว้ | ⏳ **ยังไม่ทำ** |
| ตรวจว่ามี Service ที่ไม่จำเป็นเปิดอยู่ (`/ip service`) | ลด attack surface บนตัว Router | ⏳ |
| ตั้งรหัสผ่าน/จำกัดการเข้าถึง Winbox/API ให้เฉพาะ VLAN 30 | Out-of-band management | ⏳ ยังไม่ยืนยัน |

> ⚠️ **ห้ามเขียนในเล่มว่า Firewall ผ่านการ review แล้ว** — ยังไม่มีหลักฐาน

---

## 🔐 หมายเหตุด้านความปลอดภัย

* ⚠️ **OpenVPN Server บน MikroTik**: [[entities/MikroTik_hEX_lite]] (โน้ตฉบับออกแบบ) ยังระบุว่า Router ทำหน้าที่ OpenVPN Server แจก pool `192.168.30.100–200` — **ของจริงเลิกใช้แล้ว** ดู [[30-RemoteAccess/OpenVPN-Deprecated]]
* ห้ามใส่รหัสผ่าน/คีย์จริงลงโน้ตนี้ ใช้ placeholder เช่น `<ROUTER_ADMIN_PASSWORD>` เท่านั้น

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[00-MOC/AEGIS-Infrastructure-MOC]]
* [[10-Network/VLAN-IP-Plan]] · [[10-Network/Switch-VLAN-Config]] · [[10-Network/Hardware-Inventory]]
* [[30-RemoteAccess/Twingate-Setup]] · [[30-RemoteAccess/OpenVPN-Deprecated]]
* [[90-Status/Open-Items-Backlog]] · [[90-Status/Document-Conflicts]]
