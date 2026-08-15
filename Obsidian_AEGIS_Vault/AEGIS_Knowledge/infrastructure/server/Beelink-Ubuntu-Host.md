---
title: Beelink Ubuntu Host (aegis-system)
tags: [aegis, infrastructure, server, ubuntu, beelink, docker, host, production-readiness]
type: infrastructure
status: ✅ SERVER / INFRASTRUCTURE PRODUCTION READINESS — CLOSED / PASS
created: 2026-08-06
updated: 2026-08-16
owner: kla
edit_policy: owner-writable
---

# 💻 Beelink Ubuntu Host — `aegis-system`

> Core Server ของ AEGIS · สเปกฮาร์ดแวร์ดูที่ [[entities/Beelink_Mini_S_NAS]] และ [[infrastructure/network/Hardware-Inventory]]
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

> [!success] Current state — 2026-08-15
> **SERVER / INFRASTRUCTURE PRODUCTION READINESS = CLOSED / PASS**
> สถานะนี้ปิดเฉพาะ baseline, security, remote access, network reachability,
> persistence, backup/restore และ host reboot readiness ตามหลักฐานในรอบนี้
> ไม่ได้แปลว่าเฟส Formal Deployment หรือ Web Functional Testing เสร็จแล้ว

---

## ✅ DONE — Baseline ที่ติดตั้งและตั้งค่าจริง

| รายการ | Current state |
| :--- | :--- |
| Ubuntu Server | ใช้งานแบบ headless บน Beelink |
| Hostname | `aegis-system` |
| Server IP | Static `192.168.10.10/24` บน VLAN 10 Server Zone |
| Network path | Beelink ต่อ Access VLAN 10; Management client อยู่ VLAN 30 และ routing ผ่าน MikroTik |
| Linux accounts | แยกบัญชีรายบุคคลตาม [[infrastructure/server/Linux-User-Accounts]] |
| SSH authentication | ใช้ key authentication; `PasswordAuthentication no`; `PermitRootLogin no` |
| SSH boot activation | `ssh.socket` ถูกเปิดใช้งานและผ่านการตรวจหลัง reboot |
| Remote administration | Twingate Remote SSH ผ่าน Resource ที่จำกัดถึง Beelink TCP 22 |
| Host firewall | UFW `enabled/active`, logging `low`, default deny incoming/routed และ allow outgoing; SSH allow rules จำกัดตาม Docker/Twingate และ Management VLAN |
| Container runtime | Docker runtime และ production workload มีอยู่บนเครื่องจริง |
| Secret handling | production secrets อยู่ใน runtime environment; ไม่บันทึกค่าจริงใน repository หรือ vault |

> Historical baseline ก่อนรอบนี้เคยมี `PasswordAuthentication yes` ชั่วคราวและ
> production stack ยังไม่อยู่บน Beelink สถานะดังกล่าวถูกแทนที่ด้วยผลทดสอบล่าสุดแล้ว
> ดูรายละเอียดการเปลี่ยนผ่านที่ [[infrastructure/server/SSH-Hardening-Status]]

---

## ✅ VERIFIED — Backup, persistence และ recovery

หลักฐานชุดนี้บันทึกเฉพาะผลที่ทำและทดสอบจริงจากบทสนทนา ไม่เพิ่ม command output ที่ไม่ได้แสดงไว้ชัดเจน

| Validation | Result |
| :--- | :--- |
| Backup checkpoints | ✅ สร้าง checkpoint สำหรับการทดสอบ recovery แล้ว |
| SHA256 verification | ✅ ใช้ตรวจความสมบูรณ์ของ backup artifact แล้ว |
| True Restore Test | ✅ restore จาก backup และตรวจผลหลัง restore ผ่าน |
| Windows off-host backup | ✅ มีสำเนานอก Beelink บน Windows และนำมาใช้ใน validation |
| AEGIS Drive restart persistence | ✅ บริการกลับมาและ state ที่ทดสอบยังอยู่ |
| AEGIS Monitor restart persistence | ✅ บริการกลับมาและ state ที่ทดสอบยังอยู่ |
| HUB / NGINX restart and routing | ✅ gateway กลับมาและ route ที่ใช้ validation เข้าถึงได้ |
| PostgreSQL restart and reconnect | ✅ PostgreSQL กลับมาและ application reconnect ได้ |
| Docker production stack recovery | ✅ workload ที่ใช้ทดสอบกลับมาหลัง controlled host reboot |
| Twingate recovery | ✅ Connector และ Remote SSH path กลับมาหลัง reboot |
| Linux account persistence | ✅ account state คงอยู่หลัง reboot; การ login หลัง reboot แยกรายบัญชีครบทุกคนยังไม่ยืนยัน |

### Controlled Host Reboot

| รายการ | ผล |
| :--- | :--- |
| Pre-reboot checkpoint | ✅ backup/checksum และ service state ถูกตรวจไว้ก่อน reboot |
| Kernel transition | ✅ `7.0.0-27-generic` → `7.0.0-29-generic` |
| Controlled reboot | ✅ host กลับมาและผ่าน post-reboot verification |
| SSH recovery | ✅ `ssh.socket` ทำงานหลัง boot และ key-based administration กลับมา |
| Network recovery | ✅ static IP `192.168.10.10/24` และ management paths กลับมา |
| Service recovery | ✅ Twingate, Docker workload, PostgreSQL, Drive, Monitor และ HUB/NGINX กลับมาตามขอบเขต validation |

### ✅ VERIFIED — UFW production state

| Control | Verified state |
| :--- | :--- |
| UFW service | `enabled` และ `active` |
| Logging | `low` |
| Default incoming | `deny` |
| Default outgoing | `allow` |
| Default routed | `deny` |
| Twingate SSH path | allow `TCP/22` on `docker0` from `172.17.0.0/16` |
| Management VLAN SSH | allow `TCP/22` from `192.168.30.0/24` |

### ✅ VERIFIED — Docker restart policy

| Container | Restart policy |
| :--- | :--- |
| `aegis-prod-postgres-1` | `unless-stopped` |
| `aegis-prod-drive-1` | `unless-stopped` |
| `aegis-prod-monitor-1` | `unless-stopped` |
| `aegis-prod-hub-1` | `unless-stopped` |
| `twingate-aegis-connector-02` | `unless-stopped`; `AutoRemove=false` |

### ✅ VERIFIED — Server-side post-reboot application health

| Server-side check | Result |
| :--- | :--- |
| `/healthz` | HTTP `200`; `aegis-entry` reports `ok:true` |
| `/drive/healthz` | HTTP `200`; `aegis-drive` reports `ok:true`, `db=postgres` |
| `/monitor/healthz` | HTTP `200`; `aegis-monitor` reports `ok:true`, `db=postgres` |

> ผลชุดนี้เป็น **server-side post-reboot evidence** แยกจากภาพและ Browser
> validation ของ VLAN 30 ด้านล่าง

ไม่มีการบันทึกค่า password, private key, token, `.env` value หรือ bcrypt hash ในหลักฐานนี้

---

## ✅ VERIFIED — On-site VLAN 30 validation

การทดสอบล่าสุดทำจาก Linux laptop ของเพื่อนในสถานที่จริง:

| จุดทดสอบ | ผล |
| :--- | :--- |
| Client address | `192.168.30.99/24` บน VLAN 30 Management Zone |
| VLAN 30 gateway | `192.168.30.1` reachable — `4/4`, `0%` packet loss |
| Beelink from VLAN 30 | `192.168.10.10` reachable — `4/4`, `0%` packet loss |
| HTTPS | การเชื่อมต่อไปถึง production server |
| TLS warning | self-signed certificate warning เป็นผลที่คาดหมายในระยะนี้ |
| Drive page | ✅ เปิดได้ตามการยืนยันของผู้ใช้หน้างาน |
| Monitor page | ✅ เปิดได้ตามการยืนยันของผู้ใช้หน้างาน |

> [!note] Evidence boundary
> ผล Browser ของ Drive และ Monitor เป็น **on-site / user-confirmed evidence**
> ไม่ใช่ automated web functional test และ screenshot ชุดนี้ไม่ได้แสดง output ของ
> `curl /healthz` เป็น JSON อย่างชัดเจน จึงไม่อ้างผล JSON ดังกล่าว

รายละเอียด routing/IP อยู่ที่ [[infrastructure/network/VLAN-IP-Plan]]

---

## Deployment Context Used During Infrastructure Validation

Server ปัจจุบันมี **PostgreSQL, AEGIS Drive, AEGIS Monitor และ HUB / NGINX**
workload เหล่านี้ถูกใช้เป็นตัวแทนภาระงานจริงระหว่างทดสอบ health, persistence,
backup/restore และ host reboot recovery เท่านั้น

ส่วนนี้ไม่ใช่ขั้นตอน deployment, rebuild หรือ application feature acceptance และ
**ไม่ใช่หลักฐานว่า Formal Deployment เสร็จสมบูรณ์**

---

## ✅ COMPLETED — Phase B Formal Current Production Audit

> **Checkpoint 1 (STEP 1–5) = COMPLETED**
>
> **Checkpoint 2 (STEP 6–9 + final documentation) = COMPLETED**
>
> **Phase B audit execution = COMPLETED**
>
> **Phase C = NOT STARTED / WAITING FOR HUMAN FINAL REVIEW**

| Audit step | State | Current finding |
| :--- | :--- | :--- |
| 1. Git / Source | ✅ COMPLETED | Beelink `main` clean; local `origin/main` ตรง HEAD; GitHub drift 6 commits เป็น documentation-only |
| 2. Compose vs Source | ✅ COMPLETED | production Compose อยู่ `/opt/aegis/runtime`, runtime-only และไม่ตรง Git-tracked Compose |
| 3. Image / Build provenance | ✅ COMPLETED | Drive/HUB moderate provenance; PostgreSQL upstream identified; Monitor healthy แต่มี image/rollback gap |
| 4. Network / Macvlan | ✅ COMPLETED | bridge + Macvlan runtime verified; Drive `.11`, Monitor `.12`; `aegis_internal Internal=false` |
| 5. Volume / Persistence | ✅ COMPLETED | PostgreSQL/Drive named volumes, Monitor RO clips, HUB runtime mounts verified; anonymous volume owner unknown |
| 6. PostgreSQL | ✅ PASS | PostgreSQL 15.19; expected DBs/roles present; cross-DB CONNECT isolation and scoped DML/default ACLs verified |
| 7. Application Account / RBAC | ✅ PASS | Drive `admin` and Monitor `soc` match production state; demo/operator fixtures remain Web-test readiness gaps |
| 8. Runtime Files Outside Repository | ✅ PASS | Compose/NGINX/Postgres-script/TLS baselined; `.env` and TLS key audited metadata-only; backups protected |
| 9. SSH + Twingate side checks | ✅ PASS | key-only SSH + sudo functional for `pubpup2006p`/`krayukantk`; Connector Console/runtime identity matched and healthy |

Checkpoint 1 ไม่ได้แก้ production: ไม่มี Git mutation, deploy/rebuild/restart,
Compose/`.env`, Docker network/volume, database/account, VLAN/UFW/Twingate หรือ SSH change

Current safety boundaries remain:

- ห้ามใช้ `docker compose down` ในลักษณะที่ทำลาย state
- ห้ามลบ Docker volumes หรือ PostgreSQL databases
- ห้าม recreate/rebuild Monitor จนกว่าจะมี rollback plan
- ห้ามลบ anonymous volume ที่ยังไม่ทราบ owner/purpose
- ต้องผ่าน human final review และ Source Freeze/Alignment แยกก่อนเปลี่ยนของจริง
- แยก application feature testing ออกจาก infrastructure readiness ที่ปิดแล้ว

ดู safety boundary ที่ [[infrastructure/deployment/Docker-Stack-Plan]]

---

## ⚠️ OPEN FINDINGS / NOT IN SCOPE

- **Twingate token timestamp:** token values ตั้งค่าและ Connector ใช้งานได้ แต่ creation/rotation date ไม่แสดง/ไม่ยืนยัน; ไม่ต้อง rotate ใน Phase B
- **Monitor rollback artifact:** runtime healthy แต่ running image object resolve ใน local store ไม่ได้; ห้าม recreate ก่อน rollback plan
- **Application test identities:** Drive `user`, Monitor `operator`/`operator2` และ camera fixtures ยังไม่มีใน production; เป็น Web-test readiness gap
- **Formal Deployment procedures, rebuild และ Web Functional Testing:** ยังไม่เริ่มและไม่อยู่ในขอบเขต Phase B documentation
- **VLAN 30 screenshot:** ไม่ใช้เป็นหลักฐาน `/healthz` JSON; JSON/HTTP evidence ด้านบนมาจาก server-side test แยกต่างหาก

---

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/server/Linux-User-Accounts]] · [[infrastructure/server/SSH-Hardening-Status]]
* [[infrastructure/remote-access/Twingate-Setup]]
* [[infrastructure/network/VLAN-IP-Plan]]
* [[infrastructure/deployment/Docker-Stack-Plan]]
* [[90-Status/Open-Items-Backlog]]
