---
title: Dead Man's Switch (Heartbeat Watchdog)
tags: [aegis, concept, security, hardware, esp32, fail-secure]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# ⏱️ Dead Man's Switch & Fail-Secure Mechanism

> **Core Concept**: Inverting the logic from "send a cutoff command on attack" to requiring the [[entities/Beelink_Mini_S_NAS|NAS Server]] to **continuously send signed HMAC Heartbeat signals**. If the signal goes silent, the [[entities/ESP32_Relay_Module|ESP32]] device immediately cuts the WAN Uplink line (Fail-Secure).

---

## 🧩 Legacy Problem vs Inverted Logic

* **Legacy Problem (Single Point of Trust)**: If an attacker gains Root privileges on the NAS, they can stop the service or MQTT broker (`systemctl stop mosquitto`), preventing any cutoff command from reaching the ESP32.
* **Solution (Dead Man's Switch)**: ESP32 sets a Watchdog Timer (~60–120 seconds). If it fails to receive a valid HMAC Heartbeat from the NAS within the deadline, the ESP32 assumes the server is compromised and physically cuts the Uplink line immediately.

```mermaid
flowchart TD
    NAS["Beelink NAS Server"] -->|Every N seconds: Signed HMAC Heartbeat| ESP32["ESP32 Controller"]
    
    alt Signal Received Normally
        ESP32 -->|Reset Timer| NormalState["Relay Status: NC (Connected)"]
    else Heartbeat Lost / Service Stopped
        ESP32 -->|Timer Expired| CutState["Relay Status: NO (CUT UPLINK)"]
    end
```

---

## ⚡ Considerations & Trade-offs
* **Security over Availability**: Accepts temporary unnecessary cable disconnections (e.g., during NAS reboot) in exchange for guaranteeing that an attacker cannot maintain persistent remote connections on a compromised machine.
* **WAN vs LAN Scope**: The circuit cutoff affects **WAN Uplink only**. The **Management VLAN (VLAN 30)** and **Local LAN** continue operating normally.

---

## 🔗 Related Notes
* [[04 - 🔒 IDEA3 AEGIS Lockdown]]
* [[entities/ESP32_Relay_Module]]
* [[concepts/Contain_Before_Notify]]
