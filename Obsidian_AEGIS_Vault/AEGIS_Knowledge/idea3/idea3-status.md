---
title: IDEA3 AEGIS Lockdown
aliases: ["04 - 🔒 IDEA3 AEGIS Lockdown"]
tags: [aegis, lockdown, hardware, esp32, mqtt, firmware]
type: module-doc
created: 2026-07-20
updated: 2026-09-03
owner: music
edit_policy: owner-writable
---

# 🔒 IDEA3: AEGIS Lockdown

> [!warning] Ownership and evidence boundary
> Owner: **Music**. The Security Center web application is now implemented and locally verified, but live adapters, durable storage, hardware control, and production deployment remain unproven. Do not promote those runtime claims until a Music-owned receipt records concrete integration evidence.

> **Primary Function**: Automatic disconnection and physical lockdown system triggered upon critical threats (Physical Emergency Lockdown System). Commands ESP32 microcontrollers via secure MQTT + HMAC-SHA256 protocol.

---

## ⚡ Hardware & Firmware Architecture

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

## 🛠️ Physical Security Features

* **HMAC-SHA256 Validation**: The ESP32 board rejects any commands lacking valid HMAC signatures.
* **Anti-Replay Attack (Nonce)**: Random nonces prevent command interception and replay attacks.
* **Dead Man's Switch**: If heartbeat communication from the central server drops beyond the threshold, the system automatically triggers fail-secure isolation.

---

## 🖥️ Security Center implementation status (2026-09-03)

The first repository implementation is established under `IDEA3-AEGIS_Lockdown/web/` as an Admin-only React/Vite interface with an Express security boundary. It provides 11 operational pages: Dashboard, Overview, IDEA1 Security, IDEA2 Detection, IDEA3 Lockdown, Alerts, Incidents, Audit, Devices, Recovery, and Settings.

Implemented and locally verified:

- canonical evidence states `HEALTHY`, `DEGRADED`, `FAILED`, `UNKNOWN`, `NOT_CONFIGURED`, and `DISABLED`;
- allowlisted read-only adapters for IDEA1, IDEA2, and IDEA3 runtime data, including malformed/future/stale evidence rejection;
- same-origin Admin session, CSRF enforcement, login throttling, security headers, and fail-closed production configuration;
- event deduplication and same-IP correlation within a bounded time window;
- clearly isolated Demo mode for UI review;
- alert acknowledgement, incident notes, bounded audit export, settings validation, and recovery validation as audited server-side actions;
- desktop/tablet/mobile layouts, light/dark themes, and UI styling derived from IDEA1's design language without modifying IDEA1 source.

Current evidence: `npm test` passes 59/59 tests, `npm run build` succeeds, `npm audit --omit=dev` reports 0 vulnerabilities, browser QA covers all 11 routes with no console warnings/errors, and repository UI detection reports no findings.

Known limitations:

- IDEA1, IDEA2, and IDEA3 live endpoints are not configured or integration-tested in this task;
- operational and audit repositories are in-memory and are not production-durable;
- the browser has no MQTT, relay, isolation, broker-secret, signing-secret, or recovery-execution endpoint; Recovery is dry-run validation only;
- production deployment, gateway routing, persistent database, external identity provider, and real hardware remain deferred.

---

## 🔗 Related Notes
* [[core/system-overview]]
* [[idea2/idea2-status]]
* [[core/security-architecture]]
