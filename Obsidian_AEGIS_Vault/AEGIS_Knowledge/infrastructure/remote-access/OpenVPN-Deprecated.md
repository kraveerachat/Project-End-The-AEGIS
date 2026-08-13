---
title: OpenVPN (Deprecated)
tags: [aegis, infrastructure, remote-access, openvpn, deprecated, double-nat]
type: infrastructure
status: ❌ Deprecated — ใช้งานไม่ได้จริง (Double NAT)
created: 2026-08-06
updated: 2026-08-06
owner: kla
edit_policy: owner-writable
---

# 🚫 OpenVPN — ยกเลิกการใช้งาน (Deprecated)

> ⚠️ **ห้ามเขียนในเล่มรายงานว่า OpenVPN ผ่านการทดสอบแล้ว** — ไม่เคยใช้งานได้จริง
> ช่องทาง Remote Access ที่ใช้จริงคือ [[infrastructure/remote-access/Twingate-Setup]]
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

---

## 📌 สถานะ

| รายการ | สถานะ |
| :--- | :--- |
| ออกแบบไว้ในเล่ม (§2.3.4) เป็น "Door 0-A" สำหรับ Admin PC | 📋 มีในเล่ม |
| เคยตั้งค่าจริงบางส่วนบน [[infrastructure/network/MikroTik-Config\|MikroTik]] | 🔧 เคยทำจริง |
| **ใช้งานเชื่อมต่อจากภายนอกได้จริง** | ❌ **ไม่เคยสำเร็จ** |
| Disable service ไม่ให้รันค้าง | ⏳ **ยังไม่ยืนยันว่าทำแล้ว** |

---

## 💥 สาเหตุที่ใช้งานไม่ได้

```
Internet (ISP)
   └── Router บ้านเพื่อน       ← ❌ ไม่มีสิทธิ์ Admin → Port Forward UDP 1194 ไม่ได้
          └── MikroTik ether1  ← OpenVPN Server อยู่ตรงนี้ แต่ไม่มีใครเดินทางมาถึง
```

OpenVPN ต้องการ **Inbound port** ที่เปิดจากอินเทอร์เน็ตเข้ามาถึงตัว Server
แต่ระบบอยู่หลัง **Double NAT** และทีมเข้าถึง Router ตัวหน้าสุดไม่ได้ → **ไม่มีทางเปิด Inbound ได้เลย**

→ ทีมจึงตัดสินใจเปลี่ยนไปใช้ **ZTNA (Twingate)** ที่เชื่อมแบบ **Outbound-only**

---

## 🗂️ แนวทางจัดการต่อ

| แนวทาง | เหตุผล | สถานะ |
| :--- | :--- | :--- |
| **เก็บ Config ไว้ ไม่ลบทิ้ง** | ใช้อ้างอิงในเล่มได้ว่า **เคยลองจริง** ไม่ใช่แค่คิดแล้วไม่ทำ — เป็นหลักฐานของกระบวนการตัดสินใจเชิงวิศวกรรม | ✅ ตกลงแล้ว |
| **Disable Service ไม่ให้รันค้าง** | Service ที่ค้างอยู่โดยไม่มีใครดูแล = attack surface ที่ไม่จำเป็น + สร้างความสับสนว่ายังใช้อยู่ | ⏳ **ยังไม่ยืนยัน — ต้องเข้าไปตรวจของจริง** |

---

## ✍️ วิธีเขียนเรื่องนี้ในเล่มให้ถูกต้อง

**เขียนแบบนี้ ✅**
> "ทีมออกแบบและติดตั้ง OpenVPN Server บน MikroTik ตาม §2.3.4 แต่พบว่าใช้งานจริงไม่ได้เนื่องจากระบบอยู่หลัง Double NAT และไม่มีสิทธิ์บริหาร Router ตัวหน้าสุด จึงไม่สามารถทำ Port Forwarding ได้ ทีมจึงเปลี่ยนสถาปัตยกรรม Remote Access ไปใช้ ZTNA (Twingate) ที่เชื่อมต่อแบบ Outbound-only ซึ่งไม่ต้องเปิด Inbound Port"

**ห้ามเขียนแบบนี้ ❌**
> ~~"ระบบรองรับการเข้าถึงระยะไกล 2 ช่องทางคู่ขนาน คือ OpenVPN สำหรับคอมพิวเตอร์ และ Twingate สำหรับมือถือ"~~ ← ไม่ตรงกับของจริง ดูข้อ 2 ใน [[90-Status/Document-Conflicts]]

---

## ⚠️ โน้ตเดิมในวอลต์ที่ต้องแก้ตาม

* [[concepts/ZTNA_Twingate_vs_OpenVPN]] — ยังบรรยายเป็น "Dual Path" (Door 0-A / Door 0-B) ตามเล่ม
* [[entities/MikroTik_hEX_lite]] — ยังระบุว่า Router ทำหน้าที่ OpenVPN Server แจก pool `192.168.30.100–200`

ทั้งสองโน้ตถูกแปะ banner แจ้งเตือนไว้แล้ว (2026-08-06) แต่ **ยังไม่ถูกเขียนใหม่ทั้งฉบับ** — เป็นงาน P3 ใน [[90-Status/Open-Items-Backlog]]

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/remote-access/Twingate-Setup]]
* [[infrastructure/network/MikroTik-Config]] · [[infrastructure/network/VLAN-IP-Plan]]
* [[90-Status/Document-Conflicts]]
