---
title: Contain Before Notify
tags: [aegis, concept, security, incident-response, nist]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🛑 Contain Before Notify (NIST SP 800-61 Alignment)

> **แนวคิดหลัก**: การเปลี่ยนลำดับขั้นตอนตอบสนองเหตุการณ์ความมั่นคงปลอดภัย (Incident Response Workflow) โดยเลือก **ควบคุมความเสียหายและจำกัดการแพร่กระจาย (Containment) ก่อนส่งการแจ้งเตือน (Notification)** เปรียบเสมือน "ดับไฟก่อนโทรแจ้งญาติ"

---

## 💡 เหตุผลทางเทคนิค (The Paradox Solved)

หากเกิดการโจมตีประเภท DDoS บน NAS สายสัญญาณ WAN จะถูกจราจรหนาแน่นจนเต็ม Bandwidth หากระบบเลือกระดับขั้นตอนแบบเดิม (ส่ง Telegram ก่อนแล้วค่อยสั่งตัดวงจร) คำสั่ง Telegram จะติด Timeout ทำให้ระบบค้างและไม่เคยสั่งตัดวงจรจริง

```mermaid
sequenceDiagram
    participant Threat as Suricata / Attack Detect
    participant Core as System Core
    participant ESP32 as ESP32 Relay
    participant Telegram as Telegram Bot

    Threat->>Core: Detect Cyber Attack / DDoS
    rect rgb(230, 240, 255)
        note right of Core: 1. CONTAIN FIRST (Local MQTT)
        Core->>ESP32: Send HMAC Command (Cut Uplink)
        ESP32-->>Core: ACK (Uplink Cut Success)
    end
    rect rgb(255, 240, 230)
        note right of Core: 2. ASYNC NOTIFY (Short Timeout)
        Core->>Telegram: Async Alert (Timeout 3s, skip if failed)
    end
```

---

## 🔗 ความสัมพันธ์กับโน้ตอื่น
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
* [[concepts/Dead_Mans_Switch]]
* [[concepts/Cyber-Physical_Defense]]
