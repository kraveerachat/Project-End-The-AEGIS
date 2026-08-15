---
title: Twingate ZTNA Setup (aegissut)
tags: [aegis, infrastructure, remote-access, twingate, ztna, zero-trust, security]
type: infrastructure
status: ✅ production Connector runtime, Admin Console and Remote SSH verified
created: 2026-08-06
updated: 2026-08-16
owner: kla
edit_policy: owner-writable
---

# ☁️ Twingate ZTNA — Production Remote SSH

> ช่องทาง Remote Access ที่ใช้งานจริง; OpenVPN ถูกยกเลิก → [[infrastructure/remote-access/OpenVPN-Deprecated]]
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

## ✅ DONE / VERIFIED

| รายการ | Current state |
| :--- | :--- |
| Remote Network | `Homelab Network` ตาม Admin Console; historical vault label `aegissut` ต้อง reconcile โดยไม่เปลี่ยน Connector |
| Connector | `aegis-connector-02` ตรงกับ Docker `twingate-aegis-connector-02` |
| Resource | `AEGIS-Beelink-SSH` → `192.168.10.10:22/TCP` |
| Access model | outbound-only Connector; ไม่ต้องเปิด inbound port ผ่าน Double NAT |
| Remote SSH | เคยทดสอบจากเครือข่ายภายนอกผ่าน Mobile Hotspot สำเร็จ |
| Host reboot recovery | Connector กลับมาและ Remote SSH ใช้งานได้หลัง controlled reboot |
| UFW path | ✅ allow `TCP/22` on `docker0` from `172.17.0.0/16` |
| Restart policy | ✅ `twingate-aegis-connector-02 = unless-stopped`; `AutoRemove=false` |
| Runtime identity | container ID prefix / Console hostname `5db5be7e1d28`; private IP `172.17.0.2` |
| Admin Console | ✅ Connected; Controller Connected; Relay Connected; STUN Available; Time Offset `0s` |
| Version | ✅ `1.90.0` · Up to date |
| Functional path | ✅ Remote client → Connector → Beelink SSH → correct Linux identity → sudo |

Resource-level path ชี้ตรงไปยัง Beelink VLAN 10 และไม่ให้สิทธิ์ทั้ง VLAN 30
ส่วน VLAN 30 เป็น direct on-site management path แยกต่างหากตาม
[[infrastructure/network/VLAN-IP-Plan]]

## ⚠️ Token and secret handling

- Connector token/service key ต้องอยู่นอก repository และ Obsidian
- Access/Refresh tokens are SET in the running container; values are not displayed or recorded.
- Token creation/rotation timestamp is **NOT EXPOSED / NOT VERIFIED** from the collected evidence.
- Current Connector is healthy, connected and up to date; no token rotation or re-provision is required.
- ไม่มีการบันทึก token/service key จริงใน vault หรือ repository
- หากต้อง audit ซ้ำ ให้ยืนยัน Connector Healthy และ Remote SSH โดยไม่แสดงค่า token

## ✅ VERIFIED — Reboot behavior and runtime policy

ผลหลัง reboot ยืนยันว่า Connector กลับมาและ remote path ใช้งานได้จริง
โดย container `twingate-aegis-connector-02` ใช้ restart policy
`unless-stopped` และ `AutoRemove=false`

Phase B Admin Console evidence matches Docker runtime by both hostname/container-ID
prefix and private IP. Public IP was intentionally omitted for privacy minimization.

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[infrastructure/server/SSH-Hardening-Status]]
* [[infrastructure/network/VLAN-IP-Plan]]
* [[infrastructure/remote-access/OpenVPN-Deprecated]]
* [[90-Status/Open-Items-Backlog]]
