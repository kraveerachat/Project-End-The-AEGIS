---
title: ESP32 Relay Module
tags: [aegis, entity, hardware, esp32, relay, lockdown]
type: entity
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# ⚡ ESP32 & Relay Module (Physical Breaker)

> **บทบาท**: อุปกรณ์ควบคุมการตัด/ต่อวงจรสายสัญญาณเครือข่ายระดับกายภาพ (Uplink Breaker) เมื่อเกิดภัยคุกคามไซเบอร์หรือสัญญาณ Heartbeat เงียบหายไป

---

## 🛠️ รายการฮาร์ดแวร์และวงจร (BOM Details)

| รายการอุปกรณ์ | รายละเอียดสเปก | สถานะจัดซื้อ |
| :--- | :--- | :--- |
| **ESP32 WROOM-32** | DevKit 38-pin, USB-C, WiFi+Bluetooth | ✅ Purchased (135 THB) |
| **5V 2-Channel Relay Module** | JQC3F-05VDC-C (Channel 1 Cut Uplink) | ✅ Purchased (35 THB) |
| **10mm LED Module (Red/Green)** | Green=Connected (NC), Red=Cut (NO) | ✅ Purchased (30 THB) |
| **Breadboard & Wires** | 40-pin Jumper Wires + Solderless Breadboard | ✅ Purchased |

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[modules/04_IDEA3_AEGIS_Lockdown]]
* [[concepts/Dead_Mans_Switch]]
* [[concepts/Contain_Before_Notify]]
