---
title: VLAN & IP Plan (ของจริง)
tags: [aegis, infrastructure, network, vlan, ip-plan, subnet, onsite-validation]
type: infrastructure
status: ✅ VLAN 10/30 routing and onsite production reachability verified
created: 2026-08-06
updated: 2026-09-29
owner: kla
edit_policy: owner-writable
---

# 🌐 VLAN & IP Plan — ผังจริงที่ใช้งานอยู่

> ผังนี้คือของจริงบนอุปกรณ์ ส่วน design ในเล่มอยู่ที่ [[concepts/VLAN_Segmentation_and_Port_Mapping]]
> กลับไปหน้าศูนย์รวม: [[infrastructure/infrastructure-moc]]

## VLAN / subnet baseline

| VLAN | Zone | Subnet | Gateway | Current state |
| :--- | :--- | :--- | :--- | :--- |
| 10 | Server Zone | `192.168.10.0/24` | `192.168.10.1` | ✅ Beelink และ production workload ใช้งานจริง |
| 20 | Detector Zone | `192.168.20.0/24` | `192.168.20.1` | 🔧 network baseline มีอยู่; Detection Laptop IP ยังต้องยืนยันแยก |
| 30 | Management Zone | `192.168.30.0/24` | `192.168.30.1` | ✅ on-site routing/port 443 pass; ⚠️ LAN DNS gap for `aegis.internal` |
| 1 | Native / Technician | — | — | ✅ ใช้จัดการ switch ตามเดิม |

Gateway ของ VLAN 10/20/30 ทำงานบน [[infrastructure/network/MikroTik-Config|MikroTik RB750r2]]
ผ่าน trunk ไป [[infrastructure/network/Switch-VLAN-Config|TL-SG105E]]

## Current addresses used in evidence

| Address | Owner / role | Current state |
| :--- | :--- | :--- |
| `192.168.10.1` | VLAN 10 gateway | ✅ |
| `192.168.10.10/24` | Beelink `aegis-system` | ✅ static host address |
| `192.168.10.11` | AEGIS Drive production Macvlan | ✅ runtime verified in Checkpoint 1 |
| `192.168.10.12` | AEGIS Monitor production Macvlan | ✅ runtime verified in Checkpoint 1 |
| `192.168.30.1` | VLAN 30 gateway | ✅ reachable |
| `192.168.30.99/24` | Friend Linux laptop used on-site | ✅ validation client (historical PR #83) |
| `192.168.30.10/24` | Windows on-site client | ✅ direct-LAN routing/port 443 pass; required local `hosts` mapping for `aegis.internal` (PR #216) |

> `192.168.30.99` และ `192.168.30.10` เป็น client IP ในรอบ on-site
> ไม่ใช่ static reservation ถาวร

## ✅ On-site VLAN 30 validation

| Test | Result | Evidence type |
| :--- | :--- | :--- |
| Linux laptop → `192.168.30.1` | `4/4`, `0%` loss | on-site command result |
| Linux laptop → `192.168.10.10` | `4/4`, `0%` loss | on-site command result |
| HTTPS connection | ถึง production server | on-site network/browser evidence |
| Drive page | เปิดได้ปกติ | **user-confirmed on-site** |
| Monitor page | เปิดได้ปกติ | **user-confirmed on-site** |
| TLS warning | self-signed certificate warning | expected at current stage |

ผลนี้ปิดรายการ “VLAN 30 direct path not yet tested” เดิม
แต่ไม่ใช่ automated web functional acceptance และไม่อ้าง `curl /healthz` JSON
เพราะ screenshot ไม่ได้แสดง response body นั้นชัดเจน

### ⚠️ Direct-LAN transport vs. DNS resolution gap (2026-09-29, PR #216)

การทดสอบจริงจาก Windows test client บน VLAN 30 (`192.168.30.10/24`, gateway `192.168.30.1`) โดยตัดการเชื่อมต่อ Twingate (DISCONNECTED):

| Verification | Result | Observable evidence |
| :--- | :--- | :--- |
| `Test-NetConnection 192.168.10.10 -Port 443` | ✅ PASS | `TcpTestSucceeded=True`, `SourceAddress=192.168.30.10` |
| `curl -k https://192.168.10.10/healthz` | ✅ PASS | HTTP 200 OK, `{"service":"aegis-entry","ok":true,"role":"routing-only"}` |
| `Resolve-DnsName aegis.internal` (before workaround) | ❌ FAIL | `DNS name does not exist` — LAN DNS query ไม่พบ record |
| `ping aegis.internal` (before workaround) | ❌ FAIL | `Ping request could not find host aegis.internal.` |
| Local `hosts` workaround (`192.168.10.10 aegis.internal`) | 🔧 WORKAROUND | client ping และ browser/HTTPS เข้าถึง `https://aegis.internal/healthz` ได้ (PR #216 U2/D1) |

**Architecture Finding:**
Layer 3 routing และ TCP port 443 เข้าถึง Beelink HUB สำเร็จโดยไม่ต้องพึ่งพา Twingate แต่ local LAN DNS ยังไม่มี record `aegis.internal` ชี้ไปที่ `192.168.10.10` ทำให้ client ทั่วไปที่ไม่มี local `hosts` mapping ไม่สามารถ resolve ได้.

สัญญาทางสถาปัตยกรรมเป้าหมาย (Switch Access Port PVID 30 + DHCP Option 6 + Central DNS) ถูกกำหนดไว้ใน `docs/superpowers/specs/2026-09-29-aegis-vlan30-direct-lan-dns-design.md`.

> [!important] Trust Boundary
> `ARBITRARY_UNMANAGED_WINDOWS_ZERO_SETUP=NOT_CLAIMED`: การแก้ DNS ในระดับเน็ตเวิร์กทำให้ resolve ชื่อและ route สำเร็จแบบ zero-touch แต่เครื่อง unmanaged ที่ยังไม่มี Root CA ใน `LocalMachine\Root` ยังคงต้องพบ TLS certificate warning ตามมาตรฐาน PKI ปกติ (ไม่ใช่ความผิดพลาดของระบบเครือข่าย).

## ✅ Docker network runtime — Formal Audit Checkpoint 1

| Network / endpoint | Verified state |
| :--- | :--- |
| `aegis_internal` | bridge `172.18.0.0/16`; gateway `172.18.0.1`; `Internal=false` |
| PostgreSQL bridge IP | `172.18.0.2` runtime-only |
| HUB bridge IP | `172.18.0.3` runtime-only |
| Monitor bridge IP | `172.18.0.4` runtime-only |
| Drive bridge IP | `172.18.0.5` runtime-only |
| `aegis_vlan10_macvlan` | `192.168.10.0/24`; gateway `.1`; parent `enp1s0` |
| Drive / Monitor Macvlan | `192.168.10.11` / `192.168.10.12` |
| Twingate Connector | default bridge `172.17.0.2`; subnet `172.17.0.0/16`; gateway `.1` |

> `172.18.0.x` เป็น dynamic runtime detail และห้าม hard-code เป็น application contract.
> ชื่อ `aegis_internal` ไม่ได้แปลว่า Docker internal-only เพราะ runtime ยืนยัน
> `Internal=false`; เป็น security/design observation ที่ต้อง review ภายหลังโดยไม่แก้
> production network ใน Phase B

## 📋 Reserved/design addresses

- `192.168.10.11` และ `.12` ไม่ใช่เพียง design reservation แล้ว: Checkpoint 1
  ยืนยันว่าเป็น production Macvlan ของ Drive และ Monitor ตามลำดับ
- `192.168.10.13` ยังเป็น design reservation และไม่มี runtime evidence รอบนี้
- ก่อนเปลี่ยน topology ต้อง audit runtime/container/network จริงตาม
  [[infrastructure/deployment/Docker-Stack-Plan]]

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/network/MikroTik-Config]]
* [[infrastructure/network/Switch-VLAN-Config]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[infrastructure/remote-access/Twingate-Setup]]
* [[90-Status/Open-Items-Backlog]]
