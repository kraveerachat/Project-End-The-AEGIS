---
title: Cyber-Physical Defense
tags: [aegis, concept, security, cyber-physical]
type: concept
created: 2026-07-20
updated: 2026-07-20
sources: ["[[raw/AEGIS_Project_Knowledge_v7]]"]
---

# 🛡️ Cyber-Physical Defense Concept

> **Core Concept**: A unified security system that simultaneously defends both cyber (Software/Network) and physical (Physical World) dimensions, focusing on **Edge Computing** that continues working even when external internet is disconnected.

---

## 🎯 Design Philosophy

1. **Edge-Centric (No Cloud Dependency)**: All data is stored and processed locally on the organization's Local NAS, preventing data privacy issues and unauthorized AI model training.
2. **Physical Level Response**: If the system detects a severe software breach or Root Compromise, it immediately triggers physical network disconnection (**Physical Isolation / Air-Gap**).
3. **Tripartite Collaboration**:
   - **[[entities/Beelink_Mini_S_NAS|NAS Server]]**: Central command brain and primary data store.
   - **[[03 - 📹 IDEA2 AEGIS Monitor|AI CCTV (IDEA 2)]]**: Detects physical threats (faces/unauthorized intruders).
   - **[[04 - 🔒 IDEA3 AEGIS Lockdown|Lockdown Breaker (IDEA 3)]]**: Cuts network circuits upon attack detection.

---

## 🔗 Related Notes
* [[concepts/Contain_Before_Notify]]
* [[concepts/Dead_Mans_Switch]]
* [[concepts/OWASP_Security_Defense]]
