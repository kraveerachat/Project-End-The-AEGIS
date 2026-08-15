---
title: VLAN & IP Plan (ของจริง)
tags: [aegis, infrastructure, network, vlan, ip-plan, subnet, onsite-validation]
type: infrastructure
status: ✅ VLAN 10/30 routing and onsite production reachability verified
created: 2026-08-06
updated: 2026-08-15
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
| 30 | Management Zone | `192.168.30.0/24` | `192.168.30.1` | ✅ on-site validation ผ่าน |
| 1 | Native / Technician | — | — | ✅ ใช้จัดการ switch ตามเดิม |

Gateway ของ VLAN 10/20/30 ทำงานบน [[infrastructure/network/MikroTik-Config|MikroTik RB750r2]]
ผ่าน trunk ไป [[infrastructure/network/Switch-VLAN-Config|TL-SG105E]]

## Current addresses used in evidence

| Address | Owner / role | Current state |
| :--- | :--- | :--- |
| `192.168.10.1` | VLAN 10 gateway | ✅ |
| `192.168.10.10/24` | Beelink `aegis-system` | ✅ static host address |
| `192.168.30.1` | VLAN 30 gateway | ✅ reachable |
| `192.168.30.99/24` | Friend Linux laptop used on-site | ✅ validation client for this test |

> `192.168.30.99` เป็น address ของ client ในรอบ on-site ล่าสุด
> ไม่ได้เปลี่ยนให้เป็น static reservation ถาวรโดยอัตโนมัติ

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

## 📋 Reserved/design addresses

- `192.168.10.11`, `.12`, `.13` ที่เคยอยู่ในเอกสารเป็น design reservation
  และไม่ใช้เป็นหลักฐานระบุตัว container/runtime ในรอบนี้
- ก่อนเปลี่ยน topology ต้อง audit runtime/container/network จริงตาม
  [[infrastructure/deployment/Docker-Stack-Plan]]

## 🔗 โน้ตที่เกี่ยวข้อง

* [[infrastructure/infrastructure-moc]]
* [[infrastructure/network/MikroTik-Config]]
* [[infrastructure/network/Switch-VLAN-Config]]
* [[infrastructure/server/Beelink-Ubuntu-Host]]
* [[infrastructure/remote-access/Twingate-Setup]]
* [[90-Status/Open-Items-Backlog]]
