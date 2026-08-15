---
title: Open Items Backlog (Infrastructure)
tags: [aegis, infrastructure, status, backlog, todo, priority]
type: status
status: 🔧 living-document
created: 2026-08-06
updated: 2026-08-15
owner: kla
edit_policy: owner-writable
---

# 📌 Open Items Backlog — Infrastructure

> รายการ DONE ด้านล่างถูกเก็บเพื่อป้องกันการเปิดงานเดิมซ้ำ
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

## ✅ CLOSED / PASS — Server infrastructure readiness

| Item | Current state | Canonical evidence |
| :--- | :--- | :--- |
| Ubuntu/hostname/static IP baseline | ✅ CLOSED | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| SSH key baseline, password disabled, root disabled, `ssh.socket` reboot activation | ✅ CLOSED | [[infrastructure/server/SSH-Hardening-Status]] |
| VLAN 30 direct on-site validation | ✅ CLOSED — `.30.99` to gateway and Beelink, `4/4`, `0%` loss | [[infrastructure/network/VLAN-IP-Plan]] |
| Backup checkpoint, SHA256, true restore, Windows off-host copy | ✅ CLOSED | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| Drive/Monitor/HUB-NGINX/PostgreSQL restart persistence | ✅ CLOSED | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| Controlled host reboot and kernel transition | ✅ CLOSED — `7.0.0-27` → `7.0.0-29` | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| Twingate/Docker/account recovery after reboot | ✅ CLOSED | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| UFW production rules | ✅ CLOSED — active; defaults and both SSH source rules verified | [[infrastructure/server/Beelink-Ubuntu-Host]] |
| Docker/Twingate restart policies | ✅ CLOSED — five containers use `unless-stopped`; Twingate `AutoRemove=false` | [[infrastructure/deployment/Docker-Stack-Plan]] |
| Server-side post-reboot health | ✅ CLOSED — entry/Drive/Monitor HTTP 200 with application health | [[infrastructure/server/Beelink-Ubuntu-Host]] |

## 🔴 P1 — Security housekeeping still requiring direct evidence

| Item | Why still open |
| :--- | :--- |
| Independently re-verify historical Twingate token-rotation record when required | Previously recorded as completed, not independently re-verified in this documentation pass; ห้ามเก็บ token ใน vault/repo |
| Review Twingate Admin group membership | ต้องยืนยัน least privilege ด้วย current console evidence |
| Verify post-reboot SSH login per account | account persistence ผ่าน แต่ยังไม่มีหลักฐานครบทุกบัญชี |
| Review Linux sudo/docker groups | account separation ผ่าน แต่ privilege membership ยังต้องตรวจครบ |
| Verify OpenVPN service remains disabled | deprecated design ต้องไม่เหลือ unnecessary service |

## 🟠 P2 — AEGIS Formal Deployment & Web Functional Testing

ก่อนทำเฟสนี้ต้องเริ่มจาก Current Production Audit:

- ตรวจ Git commit/source, runtime configuration, containers/images, network และ volumes
- ห้ามทำลาย state ด้วย `docker compose down`
- ห้ามลบ Docker volumes หรือ PostgreSQL databases
- ห้าม redeploy จากศูนย์ก่อน checkpoint และ rollback plan
- ทดสอบ application features แยกจาก infrastructure readiness

รายละเอียด safety boundary: [[infrastructure/deployment/Docker-Stack-Plan]]

## 🟡 P3 — Project follow-up

- ยืนยัน IP และ integration ของ Detection Laptop บน VLAN 20
- ทำ Formal TLS/certificate plan; self-signed warning ยัง expected ใน validation stage
- ทำ monitoring/alerting และ incident runbook โดยไม่แก้สถานะ infrastructure pass ย้อนหลัง
- reconcile รายงาน/diagram เก่าที่อ้างว่า Beelink ว่างหรือ stack ยังไม่อยู่บน host

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[infrastructure/remote-access/Twingate-Setup]]
* [[summaries/08_Outstanding_Items_Consolidated]]
