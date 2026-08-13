---
title: Cyber-Physical Defense
tags: [aegis, concept, security, cyber-physical]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
owner: music
edit_policy: owner-writable
---

# 🛡️ Cyber-Physical Defense Concept

> **Core Concept**: A unified security system that simultaneously defends both cyber (Software/Network) and physical (Physical World) dimensions, focusing on **Edge Computing** that continues working even when external internet is disconnected.

---

## 🎯 Design Philosophy

1. **Edge-Centric (No Cloud Dependency)**: All data is stored and processed locally on the organization's Local NAS, preventing data privacy issues and unauthorized AI model training.
2. **Physical Level Response**: If the system detects a severe software breach or Root Compromise, it immediately triggers physical network disconnection (**Physical Isolation / Air-Gap**).
3. **Tripartite Collaboration**:
   - **[[entities/Beelink_Mini_S_NAS|NAS Server]]**: Central command brain and primary data store.
   - **[[idea2/idea2-status|AI CCTV (IDEA 2)]]**: Detects physical threats (faces/unauthorized intruders).
   - **[[idea3/idea3-status|Lockdown Breaker (IDEA 3)]]**: Cuts network circuits upon attack detection.

---

---

## Where each half is actually enforced

| Dimension | Enforcement point | Note |
|---|---|---|
| **Cyber** | Server-side RBAC, CSRF, per-app Postgres roles with `CONNECT` isolation | [[core/security-architecture]] · [[concepts/Identity_Decoupling]] · [[concepts/Schema_Ownership_Map]] |
| **Physical (sensing)** | Detection Engine on VLAN 20 — capture, detect, alert; holds no DB credential | [[entities/Detection_Engine_Service]] |
| **Physical (actuation)** | ESP32 relay cuts the WAN uplink on heartbeat loss | [[entities/ESP32_Relay_Module]] · [[concepts/Dead_Mans_Switch]] |
| **Network boundary** | VLAN 10/20/30 segmentation between the two dimensions | [[concepts/VLAN_Segmentation_and_Port_Mapping]] · [[concepts/ZTNA_Twingate_vs_OpenVPN]] |

The claim "detects physical threats" is currently **sensing-only** — the recognition model is absent, so every detection resolves to `Unknown`. See [[entities/Detection_Engine_Service]] and [[summaries/08_Outstanding_Items_Consolidated]].

---

## 🔗 Related Notes
* [[START_HERE]]
* [[concepts/Contain_Before_Notify]]
* [[concepts/Dead_Mans_Switch]]
* [[concepts/OWASP_Security_Defense]]
* [[concepts/VLAN_Segmentation_and_Port_Mapping]]
* [[entities/Detection_Engine_Service]]
