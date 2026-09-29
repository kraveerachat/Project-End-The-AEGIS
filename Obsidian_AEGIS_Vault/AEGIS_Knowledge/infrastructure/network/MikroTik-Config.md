---
title: MikroTik Edge Router Config (RB750r2)
tags: [aegis, infrastructure, network, mikrotik, router, firewall, routeros]
type: infrastructure
status: ✅ ทำงานจริง+ทดสอบ Routing แล้ว · ✅ backup config สำเร็จแล้ว (2026-09-30)
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
| แยกวงบ้านออกจากวง AEGIS | `ether1` = WAN รับสายจาก Router บ้าน (DHCP client bound `192.168.1.100/24`, gw `192.168.1.1`, NAT/Firewall, 100 Mbps Full Duplex) | ✅ ตรวจจริง 2026-09-30 |
| สร้าง VLAN Interface | VLAN 10 / 20 / 30 / 40 บน `ether2` (Trunk 802.1Q, 100 Mbps Full Duplex) | ✅ ตรวจจริง 2026-09-30 |
| ตั้ง Gateway แต่ละวง | `192.168.10.1` · `192.168.20.1` · `192.168.30.1` · `192.168.40.1` | ✅ ตรวจจริง 2026-09-30 |
| DHCP Pools & Servers | แจก IP บน VLAN 10 (`dhcp_pool2`), VLAN 20 (`dhcp_pool1`), VLAN 30 (`dhcp_pool3`), VLAN 40 (`dhcp_pool4`) และ `vpn-pool` | ✅ ตรวจจริง 2026-09-30 |
| Inter-VLAN Routing | Routing ข้ามวงทำงานได้ (default route `0.0.0.0/0` via `192.168.1.1%ether1`) | ✅ ทดสอบแล้ว (ping VLAN30→VLAN10 loss 0%, 0.5–0.8 ms) |
| จัดลำดับ Firewall Rule | ย้าย rule **LAN-to-LAN ขึ้นเหนือ Drop Rule** จึงยอมให้ข้ามวงได้; VLAN 40 มี rule เฉพาะ (MQTT ไปยัง 192.168.10.13, NTP, drop อื่น ๆ) | ✅ ตรวจจริง 2026-09-30 |
| Interface Lists | `WAN=ether1`, `LAN=bridge,VLAN30-Mgmt,VLAN10-Server` (VLAN 20 และ 40 อยู่นอก LAN list) | ✅ ตรวจจริง 2026-09-30 |
| DNS Relay | `allow-remote-requests=yes` (static: `router.lan` 88.1; `aegis.internal` ยังไม่ได้ใส่ ดู PR #257) | ✅ ตรวจจริง 2026-09-30 |
| FastTrack | เปิดใช้งาน `hw-offload=yes` | ✅ ตรวจจริง 2026-09-30 |
| **Export Config Backup** | Export `.rsc` (9.6 KiB) และ `.backup` (43.9 KiB) เก็บไว้นอกอุปกรณ์, SHA-256 พร้อมใช้งาน, secret scan 0 hits | ✅ สำเร็จ 2026-09-30 (Step 2 PR #259) |

> 💡 **บทเรียน**: บน RouterOS ลำดับของ Firewall Rule สำคัญกว่าตัวเนื้อ rule — rule ที่ถูกต้องแต่ถูกวางใต้ `drop` จะไม่มีผลเลย ตอนแรก Inter-VLAN ping ไม่ผ่านเพราะสาเหตุนี้

---

## 🌍 โครงสร้าง WAN (Double NAT)

```
Internet (ISP)
   └── Router บ้านเพื่อน   ← ⚠️ ทีมไม่มีสิทธิ์ Admin → Port Forward ไม่ได้
          └── MikroTik ether1 (WAN, 100M Full, DHCP 192.168.1.100)   ← NAT ชั้นที่ 2
                 └── ether2 Trunk (100M Full) → TL-SG105E → VLAN 10/20/30/40
```

> ผลตามมา: **ทำ Inbound Port Forwarding ไม่ได้เลย** → เป็นเหตุผลหลักที่ทิ้ง OpenVPN แล้วเปลี่ยนไปใช้ ZTNA
> ดู [[infrastructure/remote-access/Twingate-Setup]] และ [[infrastructure/remote-access/OpenVPN-Deprecated]]

---

## ⏳ สิ่งที่ยังไม่ได้ทำ / ข้อสังเกตความปลอดภัย

| งาน | ทำไมสำคัญ | สถานะ |
| :--- | :--- | :--- |
| **Security Hardening Management Services** | จากการ export พบว่า telnet, ftp, www, ssh, api, winbox เปิดอยู่โดยไม่มี IP restriction และ `defconf input drop !LAN` ถูก disabled | ⏳ **ต้องทำแยก** (`SECURITY_HARDENING_FOLLOWUP_REQUIRED=YES`, ไม่แก้ใน PR #259 เพื่อรักษา equivalence) |
| **Review Firewall Rule ครบชุดก่อน Production** | Step 2 export ได้ชุด rule ฉบับเต็มมาแล้ว รอ review อย่างเป็นทางการ | ⏳ มี baseline แล้ว (Step 3 PR #259) |
| ตั้งรหัสผ่าน/จำกัดการเข้าถึง Winbox/API ให้เฉพาะ VLAN 30 | Out-of-band management | ⏳ รวมในงาน hardening |

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
* ออกแบบการแก้: เปลี่ยนเป็น Router RouterOS แบบ Gigabit โดย import config เดิม — `docs/superpowers/specs/2026-09-30-aegis-gigabit-intervlan-remediation-design.md` · แผน: `docs/superpowers/plans/2026-09-30-aegis-gigabit-intervlan-remediation.md`
* สถานะแผน:
  * Step 1 (Live Preflight): ✅ EXECUTED
  * Step 2 (Export & Backup): ✅ EXECUTED (`STEP2_RESULT=PASS`)
  * Step 3 (Equivalence Baseline): ✅ EXECUTED (`STEP3_RESULT=PASS`)
  * ขั้นตอนถัดไป: Human Owner review PR #259 design และเลือกรุ่น Gigabit MikroTik สำหรับจัดซื้อ (`HUMAN_OWNER_REVIEW_PR259_DESIGN_AND_SELECT_GIGABIT_MIKROTIK_MODEL`)

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
