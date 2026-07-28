---
title: Contain Before Notify
tags: [aegis, concept, security, incident-response, nist]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🛑 Contain Before Notify (NIST SP 800-61 Alignment)

> **Core Concept**: Reordering the Incident Response Workflow to prioritize **Containment before Notification**, analogous to "extinguishing the fire before calling relatives."

---

## 💡 Technical Rationale (The Paradox Solved)

If a DDoS attack occurs on the NAS, the WAN connection becomes saturated with traffic. Under traditional workflows (sending a Telegram alert before triggering isolation), Telegram requests would time out, causing the system to hang and never execute the actual network cutoff.

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

## 🔗 Related Notes
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
* [[concepts/Dead_Mans_Switch]]
* [[concepts/Cyber-Physical_Defense]]
