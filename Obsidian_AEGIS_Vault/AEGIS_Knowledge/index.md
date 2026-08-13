---
title: AEGIS LLM Wiki Catalog Index
tags: [aegis, wiki, index, catalog]
type: catalog
created: 2026-07-20
updated: 2026-08-13
owner: kla
edit_policy: owner-only
---

# 📚 AEGIS System LLM Wiki Catalog

> 🧭 **New here — human or agent? Read [[START_HERE]] first.** It carries the orientation, the agent reading protocol, and the project knowledge network diagram. This file is the flat A–Z catalog; `START_HERE` is the guided entry point.

> Master Index catalog of all structured knowledge pages maintained by the LLM Agent based on `AEGIS_System_Design.docx` and `AEGIS_Project_Knowledge.md`. Use this index to locate entity, concept, and architecture pages across the vault.

---

## 🗺️ System Architecture & Dashboard
* [[START_HERE]] — ⭐ **Entry point** — orientation, agent reading protocol, knowledge-network diagram, full ToC
* [[core/core-moc]] — Shared contracts, integration queue, verification, and the four workstream dashboards
* [[core/system-overview]] — Monorepo architecture overview, Data Flow Diagram, and component comparison table
* [[AEGIS_Knowledge_Network.canvas]] — Interactive 2D canvas mapping every note and its relationships (45 nodes / 40 labelled edges, 7 colour-coded groups). Replaced the 5-node `AEGIS_Architecture_Canvas.canvas` on 2026-08-06

---

## 📦 Owned workstreams
* [[core/hub-aegis-entry]] — Static app picker with no login/backend of its own (served at `/` via gateway)
* [[idea1/idea1-moc]] → [[idea1/idea1-status]] — Kla-owned Secure NAS & Edge Data Lake workstream
* [[idea2/idea2-moc]] → [[idea2/idea2-status]] — Pub-owned Monitor, CCTV Operator and Detection Engine workstream
* [[idea3/idea3-moc]] → [[idea3/idea3-status]] — Music-owned Lockdown workstream; design/report state until hardware proof
* [[infrastructure/infrastructure-moc]] — Kla-owned operational network, server, remote-access and deployment truth
* [[core/security-architecture]] — Server-Side Enforcement & Identity Decoupling security architecture
* [[core/system-context]] — Preserved detailed architecture content embedded by [[core/system-overview]]
* [[core/integration-points]] — Cross-module contracts reviewed by the integration owner
* [[core/agent-operating-rules]] — **[NEW 2026-08-06]** The 4 core principles, the mandatory post-prompt sync procedure, the repo-doc → vault map, and the vault-scope fix for the scattered graph
* [[core/design-system-ui-language]] — **[NEW 2026-08-06]** Product register, Precision Light / Modern Elevated lineage, measured contrast rules, and the documented `DESIGN.md`-vs-shipped drift

---

## 📊 Work Summaries by Category (`summaries/`)
* [[summaries/00_Work_Summary_Index]] — How the category digests below relate to `[[log]]` and to each other
* [[summaries/01_UI_Design_and_Theming]] — Login "Split Vault Card" system, cross-app theming, Impeccable-driven shell unification
* [[summaries/02_Security_Auth_and_Identity]] — Provisioning/RBAC, CSRF, SQL-level identity decoupling, Private Vault crypto, ownership checks
* [[summaries/03_Infrastructure_Networking_and_Gateway]] — NGINX gateway routing, DNS resolver fix, Docker/Compose topology
* [[summaries/04_IDEA1_Drive_Build_Out]] — Storage Layer, Global Search, Share links, the 7-phase mock-data removal pass
* [[summaries/05_IDEA2_Monitor_and_Detection_Engine]] — Mock-vs-real audit, real pipeline + live video, clip playback, Telegram routing, i18n
* [[summaries/06_Wiki_Admin_and_Housekeeping]] — Vault audits, English translation pass, GitHub publishing, Claude Code tuning
* [[summaries/07_Ethics_and_Compliance]] — HREC-SUT Participant Information Sheet + Consent Form for IDEA2
* [[summaries/08_Outstanding_Items_Consolidated]] — Every 🔴/🟠/🟡 flag across all sessions, gathered into one open-items list

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
* [[concepts/Schema_Ownership_Map]] — **[NEW 2026-08-06]** Which module owns which table, in which database — the bridge between Identity Decoupling and the Data Lake
* [[concepts/Terminal_Verification_Protocol]] — **[NEW 2026-08-06]** The `curl`-based server-side proof suite (`docs/auth-test.md`) and the verification discipline established across sessions
* [[concepts/Client_Render_State_Verification]] — **[NEW 2026-08-07]** **Reachable ≠ wired**: a green `/healthz` does not mean there is data behind it. The client-side counterpart to the `curl` suite — a jsdom render harness that proves what the screen actually shows, in both directions

---

## 🛠️ Hardware, Service & Team Entities (`entities/`)
* [[entities/Beelink_Mini_S_NAS]] — Main NAS Server specifications and architecture (Intel N5095 x86-64)
* [[entities/Detection_Engine_Service]] — **[NEW 2026-08-06]** Headless Python sensor service on the Laptop (VLAN 20) — capture → detect → NAS off-load → `/internal/*`; holds no DB credential; ⚠️ recognition model still absent
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
* [[90-Status/integration-queue]] — Reviewed cross-module requests waiting for integration
* [[90-Status/logs/_template]] — Required template for one immutable receipt per completed task
* [[log.md]] — Frozen legacy processing history; do not append new work
