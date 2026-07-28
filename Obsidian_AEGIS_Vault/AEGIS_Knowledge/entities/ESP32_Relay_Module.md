---
title: ESP32 Relay Module
tags: [aegis, entity, hardware, esp32, relay, lockdown]
type: entity
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# ⚡ ESP32 & Relay Module (Physical Breaker)

> **Role**: Control device for physical network line connection/cutoff (Uplink Breaker) when cyber threats occur or heartbeat signals go silent.

---

## 🛠️ Hardware & Circuit Details (BOM Details)

| Item | Specifications | Procurement Status |
| :--- | :--- | :--- |
| **ESP32 WROOM-32** | DevKit 38-pin, USB-C, WiFi+Bluetooth | ✅ Purchased (135 THB) |
| **5V 2-Channel Relay Module** | JQC3F-05VDC-C (Channel 1 Cut Uplink) | ✅ Purchased (35 THB) |
| **10mm LED Module (Red/Green)** | Green=Connected (NC), Red=Cut (NO) | ✅ Purchased (30 THB) |
| **Breadboard & Wires** | 40-pin Jumper Wires + Solderless Breadboard | ✅ Purchased |

---

## 🔗 Related Notes
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
* [[concepts/Dead_Mans_Switch]]
* [[concepts/Contain_Before_Notify]]
