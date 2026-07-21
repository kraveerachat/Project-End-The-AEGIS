---
title: IDEA3 AEGIS Lockdown
tags: [aegis, lockdown, hardware, esp32, mqtt, firmware]
type: module-doc
created: 2026-07-20
---

# 🔒 IDEA3: AEGIS Lockdown

> **หน้าที่หลัก**: ระบบตัดการเชื่อมต่อและปิดล็อกกายภาพอัตโนมัติเมื่อเกิดเหตุคุกคามสูง (Physical Emergency Lockdown System) สั่งงานบอร์ด ESP32 ผ่านโปรโตคอลความปลอดภัย MQTT + HMAC-SHA256

---

## ⚡ สถาปัตยกรรมการสั่งงาน Hardware & Firmware

```mermaid
sequenceDiagram
    autonumber
    actor SOC as SOC Responder / System Rule
    participant Backend as AEGIS Monitor Server
    participant Broker as Secure MQTT Broker
    participant ESP32 as ESP32 Microcontroller
    participant Relay as Physical Door Lock / Power Relay

    SOC->>Backend: 1. Trigger Physical Lockdown Command
    Backend->>Backend: 2. Generate Nonce & Calculate HMAC-SHA256 Signature
    Backend->>Broker: 3. Publish Encrypted Signal to topic 'aegis/lockdown'
    Broker->>ESP32: 4. Forward MQTT Payload (Message + Nonce + HMAC)
    ESP32->>ESP32: 5. Verify HMAC Signature & Check Nonce replay attack
    alt Verification Success
        ESP32->>Relay: 6. Trigger Relay (Engage Physical Lock)
        ESP32-->>Broker: 7. Status ACK (Locked)
    else Verification Failed / Replay Attack
        ESP32->>ESP32: 8. Ignore Command & Log Security Alert
    end
```

---

## 🛠️ คุณสมบัติด้านความปลอดภัยทางกายภาพ

* **HMAC-SHA256 Validation**: บอร์ด ESP32 จะไม่ทำตามคำสั่งใดๆ หากลายเซ็น HMAC ไม่ถูกต้อง
* **Anti-Replay Attack (Nonce)**: ใช้ค่า Nonce สุ่มป้องกันคำสั่งดักจับแล้วส่งซ้ำ
* **Dead Man's Switch**: หากขาดการติดต่อจากเซิร์ฟเวอร์หลักเกินเวลาที่กำหนด ระบบจะสลับเข้าสู่โหมดปลอดภัยอัตโนมัติ

---

## 🔗 เอกสารที่เกี่ยวข้อง
* [[00 - 🗺️ AEGIS System Overview]]
* [[03 - 📹 IDEA2 AEGIS Monitor]]
* [[05 - 🛡️ Security Architecture]]
