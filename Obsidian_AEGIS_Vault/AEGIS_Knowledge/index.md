---
title: AEGIS LLM Wiki Catalog Index
tags: [aegis, wiki, index, catalog]
type: catalog
created: 2026-07-20
updated: 2026-07-27
---

# 📚 AEGIS System LLM Wiki Catalog

> Master Index catalog of all structured knowledge pages maintained by the LLM Agent based on `AEGIS_System_Design.docx` and `AEGIS_Project_Knowledge.md`. Use this index to locate entity, concept, and architecture pages across the vault.

---

## 🗺️ System Architecture & Dashboard
* [[00 - 🗺️ AEGIS System Overview]] — Monorepo architecture overview, Data Flow Diagram, and component comparison table
* [[AEGIS_Architecture_Canvas.canvas]] — Interactive 2D Visual Canvas mapping system interconnections

---

## 📦 Core Modules (numbered top-level notes)
* [[01 - 🚪 HUB-AEGIS Entry]] — Static app picker with no login/backend of its own (served at `/` via gateway)
* [[02 - 💾 IDEA1 AEGIS Drive LC]] — Enterprise Secure NAS & Edge Data Lake file management system (Port `:8001` / `:5174`)
* [[03 - 📹 IDEA2 AEGIS Monitor]] — Dual-View SOC & Scoped CCTV Operator surveillance control center (Port `:8002` / `:5176`) · real heartbeat + proxied live MJPEG · ⚠️ recognition model not yet supplied
* [[04 - 🔒 IDEA3 AEGIS Lockdown]] — Physical network isolation system via ESP32 + Relay (MQTT HMAC)
* [[05 - 🛡️ Security Architecture]] — Server-Side Enforcement & Identity Decoupling security architecture

---

## 🧠 Architectural & Security Concepts (`concepts/`)
* [[concepts/Cyber-Physical_Defense]] — Dual-dimension security defense (Cyber + Physical) on Edge Computing
* [[concepts/Identity_Decoupling]] — Independent user database and RBAC role hierarchy separation per application (v4 Architecture)
* [[concepts/Dead_Mans_Switch]] — Inverted Fail-Secure logic triggering physical cutoff on silent Heartbeat signals
* [[concepts/Contain_Before_Notify]] — Prioritizing physical damage containment prior to notification dispatch (NIST SP 800-61)
* [[concepts/VLAN_Segmentation_and_Port_Mapping]] — Layer 2 VLAN segmentation diagram, Port Mapping, and Docker Macvlan IP layout
* [[concepts/Three_Layer_Data_Lake]] — 3-Layer Data Lake simulation (Storage, Metadata, Application) on NAS
* [[concepts/OWASP_Security_Defense]] — OWASP Top 10 defenses, Bcrypt Timing Equalization, and Anti-CSRF mitigations
* [[concepts/ZTNA_Twingate_vs_OpenVPN]] — Dual remote access architecture (OpenVPN Door 0-A vs Twingate ZTNA Door 0-B)
* [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]] — Zero-Knowledge Private Vault: **Argon2id → KEK + envelope AES-256-GCM per file** · Intentional zero passphrase recovery
* [[concepts/Honest_Telemetry_and_Unavailable_States]] — **[NEW 2026-07-27]** A number on screen must come from a measurement; unmeasurable values say `unavailable` and why. Extracted after the same fabrication pattern was found in both IDEA1 and IDEA2
* [[concepts/Impeccable_UI_Design_Workflow]] — **[NEW 2026-07-28]** Routes incoming UI prompts to the appropriate Impeccable command while preserving AEGIS product-register and accessibility constraints

---

## 🛠️ Hardware & Team Entities (`entities/`)
* [[entities/Beelink_Mini_S_NAS]] — Main NAS Server specifications and architecture (Intel N5095 x86-64)
* [[entities/ESP32_Relay_Module]] — ESP32 board hardware specifications, Relay Module, and LED Status indicators
* [[entities/MikroTik_hEX_lite]] — Edge Router Gateway (RB750r2) details for Inter-VLAN Routing & OpenVPN
* [[entities/TP-Link_TL-SG105E]] — 5-Port Managed Switch details for VLAN 10/20/30 segmentation
* [[entities/Team_Roles_and_Responsibilities]] — 3-member team details (Music, Pub, Kla), responsibilities, and project advisor

---

## 📂 Raw Sources (`raw/`)
* [[raw/AEGIS_System_Design_extracted]] — Complete extracted text from main report `AEGIS_System_Design.docx`
* [[raw/AEGIS_Project_Knowledge_v7]] — Knowledge base source document from `AEGIS_Project_Knowledge.md` (v7)

---

## 📑 Ethics & Compliance (`ethics/`)
* [[ethics/Participant_Information_Sheet_IDEA2]] — Participant Information Sheet (PIS) for IDEA 2 Facial Recognition submitted to HREC-SUT
* [[ethics/Informed_Consent_Form_IDEA2]] — Informed Consent Form for IDEA 2 focusing on 100% Local Edge, Name+RBAC storage, and PDPA retention policy

---

## 🧪 Verification Docs (Located at repository root outside vault)

> ⚠️ These files reside **outside** the vault, so referencing uses absolute file paths.

* `docs/auth-test.md` — Copy-pasteable `curl` test commands verifying auth / RBAC / Scoped View per `camera_assignment` / Storage Layer round-trip / SQL-level Identity Decoupling

---

## ⚙️ Wiki Administration
* [[.schema.md]] — Operational rules and Wiki maintenance standards for LLM Agents
* [[log.md]] — Append-only processing history and operation log
