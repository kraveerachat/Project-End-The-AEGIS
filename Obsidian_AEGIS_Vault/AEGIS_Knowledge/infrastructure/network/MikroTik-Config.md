---
title: MikroTik Edge Router Config (RB750r2)
tags: [aegis, infrastructure, network, mikrotik, router, firewall, routeros]
type: infrastructure
status: ✅ ทำงานจริง+ทดสอบ Routing แล้ว · ⏳ ยังไม่ backup config
created: 2026-08-06
updated: 2026-09-30
owner: kla
edit_policy: owner-writable
---

# 🌐 MikroTik Edge Router — สิ่งที่ตั้งค่าจริง

> อุปกรณ์: **MikroTik hEX lite RB750r2** (revision r3, RouterOS 7.18.2 stable) ([[entities/MikroTik_hEX_lite]])
> บทบาท: **Edge Router / Inter-VLAN Router / Firewall boundary** ระหว่างวงบ้านกับวง AEGIS
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

---

## ✅ สิ่งที่ทำจริงแล้ว

| งาน | รายละเอียด | สถานะ |
| :--- | :--- | :--- |
| แยกวงบ้านออกจากวง AEGIS | `ether1` = WAN รับสายจาก Router บ้าน, ทำ NAT/Firewall กั้น (100 Mbps Full Duplex) | ✅ ตรวจจริง 2026-09-30 |
| สร้าง VLAN Interface | VLAN 10 / 20 / 30 / 40 บน `ether2` (Trunk 802.1Q, 100 Mbps Full Duplex) | ✅ ตรวจจริง 2026-09-30 |
| ตั้ง Gateway แต่ละวง | `192.168.10.1` · `192.168.20.1` · `192.168.30.1` · `192.168.40.1` | ✅ ตรวจจริง 2026-09-30 |
| DHCP Server | แจก IP บน VLAN 10, VLAN 20, VLAN 30, VLAN 40 | ✅ ตรวจจริง 2026-09-30 |
| Inter-VLAN Routing | Routing ข้ามวงทำงานได้ | ✅ ทดสอบแล้ว (ping VLAN30→VLAN10 loss 0%, 0.5–0.8 ms) |
| จัดลำดับ Firewall Rule | ย้าย rule **LAN-to-LAN ขึ้นเหนือ Drop Rule** จึงยอมให้ข้ามวงได้ | ✅ |
| Interface Lists | `WAN=ether1`, `LAN=bridge,VLAN30-Mgmt,VLAN10-Server` (VLAN 20 และ 40 อยู่นอก LAN list) | ✅ ตรวจจริง 2026-09-30 |
| DNS Relay | `allow-remote-requests=yes` (static: `router.lan`; `aegis.internal` ยังไม่ได้ใส่ ดู PR #257) | ✅ ตรวจจริง 2026-09-30 |

> 💡 **บทเรียน**: บน RouterOS ลำดับของ Firewall Rule สำคัญกว่าตัวเนื้อ rule — rule ที่ถูกต้องแต่ถูกวางใต้ `drop` จะไม่มีผลเลย ตอนแรก Inter-VLAN ping ไม่ผ่านเพราะสาเหตุนี้

---

## 🌍 โครงสร้าง WAN (Double NAT)

```
Internet (ISP)
   └── Router บ้านเพื่อน   ← ⚠️ ทีมไม่มีสิทธิ์ Admin → Port Forward ไม่ได้
          └── MikroTik ether1 (WAN, 100M Full)   ← NAT ชั้นที่ 2
                 └── ether2 Trunk (100M Full) → TL-SG105E → VLAN 10/20/30/40
```

> ผลตามมา: **ทำ Inbound Port Forwarding ไม่ได้เลย** → เป็นเหตุผลหลักที่ทิ้ง OpenVPN แล้วเปลี่ยนไปใช้ ZTNA
> ดู [[infrastructure/remote-access/Twingate-Setup]] และ [[infrastructure/remote-access/OpenVPN-Deprecated]]

---

## ⏳ สิ่งที่ยังไม่ได้ทำ

| งาน | ทำไมสำคัญ | สถานะ |
| :--- | :--- | :--- |
| **Export Config Backup** (`/export` + `.backup`) | ถ้าอุปกรณ์พังหรือ reset ตอนนี้ = ต้องตั้งใหม่ทั้งหมดจากศูนย์ | ⏳ **ยังไม่ทำ** (Step 2 ในแผน remediation) |
| **Review Firewall Rule ครบชุดก่อน Production** | ตอนทดสอบ routing มีการผ่อน rule ชั่วคราว ยังไม่ได้ไล่ตรวจว่าเหลืออะไรเปิดกว้างไว้ | ⏳ **ยังไม่ทำ** |
| ตรวจว่ามี Service ที่ไม่จำเป็นเปิดอยู่ (`/ip service`) | ลด attack surface บนตัว Router | ⏳ |
| ตั้งรหัสผ่าน/จำกัดการเข้าถึง Winbox/API ให้เฉพาะ VLAN 30 | Out-of-band management | ⏳ ยังไม่ยืนยัน |

> ⚠️ **ห้ามเขียนในเล่มว่า Firewall ผ่านการ review แล้ว** — ยังไม่มีหลักฐาน

---

## 🚦 เพดาน Inter-VLAN 100 Mbps (ตรวจจริง 2026-09-30)

* Inter-VLAN routing เป็นแบบ router-on-a-stick ผ่าน `ether2` พอร์ตเดียว และพอร์ตของ RB750r2 เป็น **10/100** → traffic ข้ามวงทั้งหมดถูกจำกัดที่ 100 Mbps
* หลักฐานตรวจอุปกรณ์จริง (2026-09-30):
  * RB750r2 `ether2` monitor rate=100Mbps full-duplex=yes status=link-ok
  * TL-SG105E Port 1 trunk = 100MF
  * Beelink `enp1s0` = 1000Mb/s Full
  * Admin Laptop = 1 Gbps Full
  * PR #216 U2/D1 single ≈ dual ≈ 10.7–11.1 MB/s
  * สถานะ: `P1_ROUTER_TRUNK_100MBPS_CEILING=PROVEN_LIVE`
* ออกแบบการแก้ (ยังไม่ทำ, รอ Human review): เปลี่ยนเป็น Router RouterOS แบบ Gigabit โดย import config เดิม — `docs/superpowers/specs/2026-09-30-aegis-gigabit-intervlan-remediation-design.md` · แผน: `docs/superpowers/plans/2026-09-30-aegis-gigabit-intervlan-remediation.md` (Step 1 Preflight สำเร็จแล้ว; Step 2 Export Backup เป็นขั้นตอนถัดไป)
* แผนนี้ต้องทำ **Export Config Backup** (รายการ ⏳ ข้างบน) เป็นขั้นแรกก่อนแตะอุปกรณ์ใด ๆ

---

## 🔐 หมายเหตุด้านความปลอดภัย

* ⚠️ **OpenVPN Server บน MikroTik**: [[entities/MikroTik_hEX_lite]] (โน้ตฉบับออกแบบ) ยังระบุว่า Router ทำหน้าที่ OpenVPN Server แจก pool `192.168.30.100–200` — **ของจริงเลิกใช้แล้ว** ดู [[infrastructure/remote-access/OpenVPN-Deprecated]]
* ห้ามใส่รหัสผ่าน/คีย์จริงลงโน้ตนี้ ใช้ placeholder เช่น `<ROUTER_ADMIN_PASSWORD>` เท่านั้น

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/network/VLAN-IP-Plan]] · [[infrastructure/network/Switch-VLAN-Config]] · [[infrastructure/network/Hardware-Inventory]]
* [[infrastructure/remote-access/Twingate-Setup]] · [[infrastructure/remote-access/OpenVPN-Deprecated]]
* [[90-Status/Open-Items-Backlog]] · [[90-Status/Document-Conflicts]]
