**AEGIS — Project Knowledge Base v7 (for AI Agent)**

> **v7 Update:** The network section has been properly inserted into `AEGIS_System_Design.docx` at **Section 2.3** (not 4.4 as mentioned in v6 — 2.3 is under "2. Overall Architecture" before IDEA 1). It contains 5 subsections (2.3.1 VLAN/Subnet, 2.3.2 Port Mapping, 2.3.3 IP+Docker Macvlan, 2.3.4 Remote Access Strategy with 2 paths, 2.3.5 Device IP Table). Added new Remote Access method: Computer via OpenVPN → VLAN30, Mobile via separate Twingate ZTNA (decision made not to include Offline Validation test results and Open Items table in the main content — keep them for the appendix with real photos later). ⚠️ **Remaining bug in the document:** At the end of §2.3.4 there is still leftover old text (repeated sentence about Terminal Account) that must be deleted before final submission.

> **v6 Update:** Added real network section + corrected devices/VLAN to match actual implementation. Previous v5 still described conceptual-level info (hEX RB750Gr3, TL-SG108E, VLAN without numbers), which did not match what was actually built.

> **How to use this document:** This file summarizes the entire AEGIS project from `AEGIS_System_Design.docx` (latest version), combined with real development status that occurred outside the report (hardware purchased, software written, prototype UI). It allows the AI Agent to read it once and fully understand the context, architecture, design rationale, and current status.

> Every time you provide consultation or assistance, treat the content in this file as the primary source of truth.

> **v2 additions from v1:** Real hardware/software status for IDEA 3, electricity measurement methodology, list of items needing fixes in the document.

> **v3 additions from v2:** IDEA 2 architecture in 2 parts (Detection Engine + Monitoring Web App).

> **v4 change (Identity Decoupling):** IDEA 1 and IDEA 2 now completely separate their user account systems from each other.

> **v5 additions from v4:** Detailed Screen & Feature Mapping for both IDEAS (IDEA 1 Section 3.6 = 9 screens in 3 groups; IDEA 2 Section 4.6 = Aggregate/Scoped View with separate tables) + added Camera diagnostics (self-diagnostics) in Operator side + ✅ Fixed internal contradictions in the document regarding ownership of `camera_assignment` (all sections now consistently state it belongs to IDEA 2).

---

## 0. AI Role (Role)

You are a **Senior Consultant in Network Architecture, Cybersecurity, and Edge IoT**.  
**Duties:** Provide analytical consultation, recommend strategies, verify document consistency, and perform **threat modeling** for the AEGIS team.

Consultation principles:
- Always prioritize the team's core expertise = **Network + Security**; Big Data and AI are "supporting tools" (secondary), not the main metrics.
- Tailor responses to the responsibilities of the team member asking (see Section 2).
- Emphasize "thinking ahead for failure" (Failure Analysis) as this earns points.
- Values tied to hardware that have not been physically tested should be stated as "approximate/adjustable" until real measurements are taken (e.g., Heartbeat Timeout, electricity consumption).
- **Clearly separate status:** "Code written/designed" ≠ "Tested and passed" — never claim anything has been tested successfully until real runtime results confirm it.
- Separate content levels: Architecture/concepts → main report; Lab-level details (specific brands purchased, prices, improvised wiring) → separate BOM/appendix. Do not mix them.

---

## 1. Project Overview

**Project Name:** Cyber-Physical Security System Based on Edge Data Center and IoT Devices  
(Edge-Centric Cyber-Physical Security System with Integrated IoT and Local Data Center)

**Abbreviation/Code:** AEGIS = Autonomous Edge-Guard Infrastructure System for Cyber-Physical Security

**Short Definition:** A server room security system that operates in both **Physical** and **Cyber** dimensions simultaneously under the "Cyber-Physical Defense" concept. It uses **Edge Computing** instead of Cloud, so it continues working even if external internet is cut.

**Core of the System:** The NAS Server serves as both the central data hub and the command brain.  
AI Cameras (IDEA 2) and ESP32 physical circuit breaker (IDEA 3) are **Supporting Components** that feed data in and receive commands from the NAS → All three parts form a single **Ecosystem**.

**Positioning (Very Important):**  
The hero of the system is **Network Architecture + Security**.  
Big Data (Data Lake) and AI (Facial Recognition) are supporting tools from the courses studied, **not the primary metrics**.

**Current Overall Status (Summary — details in Section 10):**
- **IDEA 1 (NAS):** Hardware (Beelink) has not arrived yet — currently in Phase 1 (simulated with Docker).
- **IDEA 2 (AI CCTV):** Hardware (Laptop+Webcam) is ready, but code development has not started (UI/UX design completed).
- **IDEA 3 (Lockdown):** **Main hardware already purchased** + **Software code written but not yet physically tested** (plans to test all safety scenarios — see Sections 7.6–7.8). This IDEA is the most advanced in preparation.

---

## 2. Academic Context and Team

**Course:** 1101911 Digital Technology Project 1 · Semester 1, Academic Year 2569 (2026)  
Digital Technology Program, Faculty of Digital Science and Arts · Suranaree University of Technology  
**Advisor:** Asst. Prof. Dr. Songyut Pimpan

**Team Members (3 people):**

| Student ID | Name | Nickname | Responsibilities |
|---|---|---|---|
| B6701635 | Mr. Kittiphat Chanthasila | Music | **Member 1 (Network – Infrastructure):** NAS (Beelink), HDFS/HIVE Concept, NGINX Layered Auth, Edge Router/Managed Switch/VLAN, Docker, UFW, Storage Mount/Redundancy |
| B6702861 | Mr. Naruebet Saengprathum | Pub | **Member 2 (Network – IoT & Data Flow):** ESP32, MQTT Broker, Relay (cut uplink only), Heartbeat/Watchdog, Data Pipeline from AI CCTV → NAS |
| B6703370 | Mr. Weerachat Jinaparivataporn | Kla | **Main Coordinator + Cross-system Security Architecture** (owner of main document, oversees IDEA 1 & IDEA 2, checks consistency across ideas, hands-on owner of IDEA 3) |

> Note: The original document lists Member 3 (Security – Blue Team: Suricata, WAF, HMAC, Incident Response, Threat Modeling, Telegram) as a required team role — cover this role comprehensively in analyses.

**Knowledge Base (Referenced Courses):**
- **Big Data Technology:** Data Lake 3-layer concept → IDEA 1
- **Cybersecurity:** Defense in Depth, IDS, Incident Response, Network Segmentation, Fail-Secure/Dead Man's Switch → IDEA 1, 3
- **AI for Data Analysis (Elective):** Facial Recognition → IDEA 2

---

## 3. Background, Problems, and Objectives

### 3.1 Background and Importance
Large amounts of personal/organizational data are stored on external Clouds (Google Drive, iCloud, etc.) — convenient but risky, as accepting Terms of Service often grants providers rights to process/analyze/train AI on the data. The team recognized the importance of having a **Local NAS Server** fully owned by the user. However, self-hosted servers come with security responsibilities. AEGIS therefore integrates enterprise-grade security into the NAS.

### 3.2 Problem Statement — 3 Points
1. **Data Ownership:** Storing on Cloud = loss of full control over data.
2. **Security of Self-Hosting:** General users setting up NAS often lack robust protection → become targets for DDoS/Brute-force.
3. **Software Protection Alone is Insufficient:** Firewall/port blocking may not be enough. If breached at the software layer, physical connection points still exist → must respond at the **physical level**.

### 3.3 Objectives — 5 Items
1. Develop a **Local NAS Server** fully owned and controlled by the user to reduce Cloud dependency.
2. Design/simulate **Defense in Depth** (Layered Authentication + VLAN + separating internal/external networks).
3. Develop an **automatic detection and response mechanism** up to the level of physical disconnection (Air-Gap) without human intervention.
4. **Integrate 3 course sets** (Big Data + Cybersecurity + AI) with Network/Security as the core axis.
5. Develop a **Prototype** that can be realistically demonstrated as a Cyber-Physical Security case study.

### 3.4 Expected Benefits (4 Dimensions)
- **Users:** Have a private, secure, fully controlled data center + multi-layered protection up to the physical level.
- **Real-world Application:** Prototype for small organizations/shops/limited budgets — enterprise-grade security without high costs (this directly links to Sections 7.6 BOM and 7.8 electricity estimates as quantitative evidence supporting "low-cost enterprise security").
  - **Clear Target Group (stated in document):** Small to medium enterprises (SMEs) such as accounting firms, clinics, design studios that handle confidential data (under PDPA) but lack budget for dedicated security teams or enterprise cloud rentals — AEGIS answers with on-premise data storage on affordable hardware + centralized rights management + enterprise-grade prevention-response mechanisms.
- **Education:** Example of integrating Big Data + Cybersecurity + AI into one system.
- **Team:** Practice network design, IoT security systems, and Failure Analysis skills.

---

## 4. Overall System Architecture

### 4.1 Three Communication Channels
- **Internal LAN / VLAN** — Main path for file transfer, clips, and commands.
- **MQTT (Local Broker)** — High-speed command exchange between NAS ↔ ESP32 within LAN (no internet required).
- **Telegram Alerting** — 2-level notifications:
  1. **Direct** → Sent directly to the CCTV-Operator responsible for the affected camera (per `camera_assignment`).
  2. **Central SOC Room** → Aggregates critical events (both AI cameras and cyber threats) for Admin/SOC-Responder overview.

### 4.2 Logical Topology (Implemented Connection Diagram)
```
[ Home WiFi Router (ISP) ]   ← Do not modify home network settings
        │ (1 LAN cable to ether1/WAN)
        ▼
[ Edge Router — MikroTik hEX lite (RB750r2) ]   ← Layer 3 gateway (NAT/Firewall) + OpenVPN Server
        │ (ether2 = Trunk)
        ▼
[ Managed Switch — TP-Link TL-SG105E ]   ← 802.1Q VLAN (Layer 2, 5 ports fully utilized)
        │
        ├── Port2 → VLAN 10 (Server) ──► [ NAS — Beelink Mini S ]  ◄── System Core
        │                        │ Stores 3-layer data + threat detection (Suricata/UFW)
        │                        │ Issues commands via MQTT (HMAC + nonce)
        │                        ▼
        │                  [ ESP32 + Relay ] ──► Cuts/Connects NAS Uplink
        ├── Port3 → VLAN 20 (Detector) ──► [ Laptop: Webcam + Detection Engine, IDEA2 ]
        ├── Port4 → VLAN 1  (Native)   ──► Temporary technician port (unused)
        └── Port5 → VLAN 30 (Mgmt)     ──► [ Admin Laptop / VPN Client ] ← Lifeline when uplink is cut, not affected by Relay
```

**Reason for having both Edge Router (L3) and Managed Switch (L2):**  
The ISP router cannot reliably do VLAN (802.1Q) and must not be modified as it affects the whole house. Therefore, the team added their own devices as an isolation layer. Separating Router (L3) and Switch (L2) reflects correct OSI layer design = **Network scoring point**.  
The Relay is a pure physical mechanism that does not configure anything in the router; it only cuts the NAS Uplink cable and does not affect the home network.

> Details on VLAN/Subnet, Port Mapping, real IPs, Docker Macvlan, VPN scope, and test results → see **Section 4.4** (newly added).

### 4.3 Tech Stack (Devices and Tools — Architectural Level)

| Component | Device / Tool | Role |
|---|---|---|
| NAS Server (Core) | Beelink Mini S — N5095 CPU (x86-64), 8GB RAM, 128GB ROM + 1TB HDD | Central 3-layer data storage + command brain |
| Edge AI Node | Laptop + Webcam | Processes facial recognition/anomaly detection, sends results to NAS |
| Physical Cutoff | ESP32 + Relay Module | Physically cuts/reconnects Uplink circuit (Air-Gap) per MQTT command |
| Intrusion Detection | Suricata (IDS/IPS) + UFW Firewall | Detects anomalous traffic + software-level blocking |
| Secure Transport | MQTT + HMAC SHA-256 + nonce/timestamp | Encrypted commands + Replay Attack prevention |
| Database | PostgreSQL | Stores Metadata + Access/Attack Logs |
| Alerting | Telegram Bot (SOC Room) | Real-time notifications for both physical and cyber threats |
| Access Control | NGINX + VPN + VLAN (on Managed Switch) | Enforces layered login + restricts access to specific zones |
| Edge Router (Gateway) | MikroTik hEX lite (RB750r2) | Isolates AEGIS from home network (NAT/Firewall) + Inter-VLAN Routing + OpenVPN Server |
| Managed Switch | TP-Link TL-SG105E | 802.1Q VLAN separation: Server(10)/Detector(20)/Management(30) — 5 ports fully used |
| Liveness Watchdog | Heartbeat Signal (HMAC) + ESP32 Watchdog Timer | Checks if NAS is still operating normally; signal loss → automatic Fail-Secure Uplink cutoff |

> Note: This table is at the "architecture" level for the main report. Actual purchase list/brands/prices belongs in Section 7.6 (separate BOM appendix — do not mix with this table).

---

### 4.4 Real Network Configuration and Test Results (Network Implementation & Validation) — Added in v6

> Since the test site internet was not ready, the team first installed the "Internal LAN Core" offline. The IP structure supports future WAN connection to ether1 without changing existing settings.

**4.4.1 VLAN / Subnet**

| VLAN | Zone Name | Subnet | Gateway | Status |
|---|---|---|---|---|
| 10 | Server Zone | 192.168.10.0/24 | 192.168.10.1 | In use |
| 20 | Detector Zone (Edge AI/IDEA2) | 192.168.20.0/24 | 192.168.20.1 | In use |
| 30 | Management Zone | 192.168.30.0/24 | 192.168.30.1 | In use |
| 1 | Native/Technician Port | — | — | Switch web interface only (Switch IP 192.168.30.2) |

**4.4.2 Port Mapping on TL-SG105E (Final — 5 ports fully used, no spares)**

| Port | Type | PVID | VLAN | Device |
|---|---|---|---|---|
| 1 | Trunk (Tagged) | 1 | 10, 20, 30 | Trunk cable to MikroTik (ether2) |
| 2 | Access (Untagged) | 10 | Server | Beelink Mini S (NAS) |
| 3 | Access (Untagged) | 20 | Detector | Laptop (Webcam/USB cam + Detection Engine) |
| 4 | Access (Untagged) | 1 | Native | Temporary technician port (unused) |
| 5 | Access (Untagged) | 30 | Management | Admin Laptop |

> ⚠️ No remaining ports for new wired devices (real cameras/ESP32). If needed in the future, recommend adding an Unmanaged Switch from Port 3 (automatically inherits VLAN 20) instead of buying a new Managed Switch.

**4.4.3 IP Allocation + Docker Networking**

Docker on Beelink uses **Macvlan** mode — each service gets a real separate IP in VLAN 10 (instead of Bridge+Reverse Proxy):

| IP Address | Device/Service | VLAN | Note |
|---|---|---|---|
| 192.168.10.10 | Beelink Host (Ubuntu Server) | 10 | SSH |
| 192.168.10.11 | IDEA1 — AEGIS Drive (Web, Docker Macvlan) | 10 | — |
| 192.168.10.12 | IDEA2 — AEGIS Monitor (Web App, Docker Macvlan) | 10 | Reads from DB only, does not process AI itself |
| 192.168.10.13 | MQTT Broker (for ESP32/IDEA3) | 10 | ⏳ Reserved, final confirmation pending |
| 192.168.20.x | Laptop (Detection Engine) | 20 | ⏳ Static/DHCP not yet finalized |
| 192.168.30.10 | Admin Laptop | 30 | Static via NetworkManager |
| 192.168.30.100–200 | VPN Client Pool (OpenVPN) | 30 | Assigned to remote clients |

**4.4.4 Remote Access — 2 Parallel Paths (v7)**

- **Computer → OpenVPN → VLAN 30:** Receives IP from pool 30.100–200 (equivalent to plugging into Port 5) → SSH to Beelink + access IDEA1/IDEA2 Web Apps via Inter-VLAN Routing — full functionality as if physically present.
- **Mobile → Twingate ZTNA → Scoped Access:** Does not use the same OpenVPN as computers because it would expose the entire LAN (risk if phone is lost/infected — full reason in §3.5.6). Twingate limits visibility to only authorized Web Apps on a per-app basis.
- **Status:** Configured but End-to-End testing pending (waiting for home internet — this status not included in main document, kept in §10 of this file instead).

**4.4.5 Test Results (Offline Validation — Confirmed real, intentionally not in main document)**

| Item | Result |
|---|---|
| Inter-VLAN Routing (30↔10) | Ping successful, 0% packet loss |
| Latency | 0.5–0.8 ms (sub-millisecond) |
| SSH Headless (Laptop→Beelink) | Successful |
| Firewall Rule (MikroTik, chain forward) | LAN→LAN accept placed above drop rule |

> Kept for appendix with real photos later — does not mean testing was not performed.

**4.4.6 Open Items (Still Pending, intentionally not in main document)**

| Topic | Status |
|---|---|
| UFW on Beelink | Temporarily disabled for routing tests — **Must re-enable + set rules** (default deny, allow SSH from 192.168.30.0/24) **before submission** |
| ESP32 (IDEA3) connection method | Undecided: Built-in WiFi vs Ethernet via Unmanaged Switch from Port 3 |
| MQTT Broker IP (.13) | Reserved, waiting for IDEA3 implementation |
| Laptop Detection Engine IP | Should be set to Static (currently default) |
| Real VPN | Waiting for home internet for end-to-end test |

---

## 5. IDEA 1 — AEGIS Drive (Edge Data Lake / NAS Server) · Core

**Role:** Heart of the system · **Knowledge Base:** Big Data + Cybersecurity · **Status:** Hardware not arrived yet — Phase 1  
> **Name in Document:** IDEA 1 section uses "AEGIS Drive" — web app for file management (sometimes called "AEGIS Control Panel") at the Application Layer.

### 5.1 Concept: 3-Layer Data Lake on Edge
NAS is not just file sharing; it simulates a Data Lake divided into 3 isolated layers for layered rights control:
- **Storage Layer (HDFS concept):** Raw files (replay clips, images, documents) on 1TB HDD via Linux FS.
- **Metadata Layer (HIVE concept):** Structured data in PostgreSQL (upload time, file size, camera coordinates, logs) — fast search without disturbing HDD.
- **Application Layer (Google Drive concept):** Web GUI for users to log in, view/upload files.

**Reason for choosing Beelink Mini S (x86):** N5095 CPU (x86-64) + 8GB RAM can stably run multiple Docker/PostgreSQL/NGINX containers simultaneously, better than ARM (Raspberry Pi 5) for 24/7 operation.

### 5.2 Security: Layered Authentication (Defense in Depth)
Must pass VPN + same VLAN first to see ports, with separate logins per layer via NGINX:

| Layer | Layer / Port | Authentication |
|---|---|---|
| 0 | VPN + VLAN (outermost) | Must connect VPN + be in VLAN before seeing ports 80/443, 9870, 10002 |
| 1 | Application Layer — 80/443 | Web login, sees only files user has rights to |
| 2 | Storage Layer (HDFS) — 9870 | NGINX Basic Auth for Admin level |
| 3 | Metadata Layer (HIVE) — 10002 | Database Admin (DBA) level confirmation required for queries |

Additional Network measures: **Network Isolation** (Edge Router separates home network↔AEGIS), **VLAN Segmentation** (separates User/Server/Management), **Redundancy** (RAID 1 / auto-backup to reduce Single Point of Failure).

### 5.3 User Account System for IDEA 1 (Access Control) — AEGIS Drive Only
> **⚠️ Direction Change (v4):** IDEA 1 is no longer the "central RBAC base" for all IDEAS. The NAS owns **only its own AEGIS Drive app user accounts**. Each app manages its own accounts independently for clear responsibility and data boundaries.

IDEA 1 divides users into 2 roles per Least Privilege principle:

| Role | Permissions | Note |
|---|---|---|
| Admin (limited to 3 people) | All services + user management + DBA + sudo | Least Privilege limits number of high-privilege holders |
| DataLake-User | Access Data Lake 3 layers according to file rights | General users |

**Important:** Both roles have **identical file management functions** (upload, download, share). They differ only in that Admin sees additional management menus (Audit Log, Access Control). The default screen is designed from a general user perspective for simplicity like common cloud services.

**New Boundary (v4) — Identity Decoupling:**
- **IDEA 1** owns Admin / DataLake-User accounts (for AEGIS Drive).
- **IDEA 2** owns CCTV-Operator / SOC-Responder accounts + `camera_assignment` table **in IDEA 2's own database** (see Section 6).
- **Only remaining cross-dependency:** Blocking attacker IP via UFW during recovery (Section 7.5) still requires **IDEA 1 Admin** account because UFW runs directly on the NAS hardware — technical limitation of firewall location, not design limitation.

> **Note on Application Layer:** It is a "conceptual layer" — not tied to a single web app. The system has multiple apps on this layer — **AEGIS Drive** (IDEA 1, file management) + **AEGIS Monitor** (IDEA 2, monitoring). Both have no separate storage; they read/write via shared Storage + Metadata Layers on NAS (confirming NAS as central data hub) — **but user accounts/rights for each app are completely independent**.

### 5.4 Pre-Hardware Strategy + 3-Phase Roadmap
Separate "Logic" proof from "Hardware" by simulating with Docker first (3 containers: Storage/Metadata/Application) to validate Software Architecture immediately without waiting for hardware. When Beelink arrives, migrate all containers to run on real hardware (Portability).

| Phase | Status | Main Tasks |
|---|---|---|
| Phase 1 | In progress | Docker: Set up 3-layer containers, NGINX Layered Auth, PostgreSQL schema + queries |
| Phase 2 | Next | Migrate to real Beelink + 24-hour stability test |
| Phase 3 | Future | Real VLAN + Edge Router, RAID 1/auto-backup, full VPN Layer 0 |

> **Lesson borrowed by IDEA 3:** This "separate Logic from Hardware" strategy is what IDEA 3 reused (see Section 7.7) — worth noting in the report that the whole team follows the same principle across IDEAS.

### 5.5 User Interface and File-Level Security Features (AEGIS Drive / Application Layer GUI)
"AEGIS Control Panel" web interface where logged-in users manage files. Designed to feel familiar like Google Drive but with security mechanisms public clouds lack. **Scope limited to:** File management + file-level security + identity management (IDEA 1 RBAC) + Audit + storage status — Camera live view/analysis/circuit cutting belongs to IDEA 2/3 (separate apps).

**Main Menus (9 items, shown/hidden by Role):** Dashboard, Files Explorer, Uploads/Recent, Secure Shares, Snapshots & Recovery, Storage & Backup, Audit Log, Access Control, Settings.

**3 Highlight Features (Security Selling Points):**

**5.5.1 VLAN-Aware Secure Share** — File share links locked to network zone. Besides password + expiration, user can define that the link is only accessible from specific VLAN/Subnet (e.g., 192.168.10.0/24). Opening from home network/4G will be dropped by UFW at the Network Layer.
> **Key Point:** UFW here is used for **Data Access Control** (zone-based access) — **different role** from IDEA 3's use of UFW for **blocking attacker IPs (Threat Response)**. Same tool, different purposes, no overlap.

**5.5.2 Zero-Knowledge Private Vault** — Special mode with **AES-256 client-side encryption** in the user's browser before upload. NAS only stores unreadable "ciphertext". **Even Admin cannot read it** without the user's key (Zero-Knowledge).
> **Reason for 2 Modes:** Normal mode uses server-side Encryption-at-Rest (NAS can still do FIM/search/thumbnails). Vault for highest-secrecy files only. Full client-side encryption would prevent NAS from doing FIM/search/receiving clips from IDEA 2, so separate modes align with PDPA.

**5.5.3 Storage & Backup** — Storage Layer screen showing HDD usage by type (Documents/Images/Video/Clips/Vault), RAID 1 status, automatic backup table.
Data durability in 2 layers: **RAID 1** (disk failure protection) + **Snapshots & Recovery** (rollback for Ransomware/mistaken deletion) — covers all system data including clips from IDEA 2.

**5.5.4 Settings & Accessibility** — 5 categories: Appearance, Account, Security & Privacy, Storage & Data, Administration (last category visible only to Admin).  
Supports Light/Dark mode + 3 languages (Thai/English/Chinese). Technical values (IP, Hash, time) are not translated to maintain accuracy — emphasizes ease of use for all SME user groups.

### 5.6 Screen & Feature Mapping for AEGIS Drive (Document Section 3.6) — 9 Screens in 3 Groups
AEGIS Drive GUI divided into 9 screens per RBAC / Least Privilege:

**Group 1 — Files (accessible by both Admin and DataLake-User):**
| Screen | Function |
|---|---|
| Dashboard | Overview: Storage Quota, active shares, login history (Personal Security Status), Recent Activity |
| Files Explorer | Hierarchical file management + folder creation + **Private Vault** (Client-Side Encryption) |
| Uploads / Recent | File upload + real-time Encryption-at-Rest status |
| Secure Shares | Manage share links: password, expiration, **VLAN/Subnet restriction** |

**Group 2 — Data (accessible by both Admin and DataLake-User):**
| Screen | Function |
|---|---|
| Snapshots & Recovery | File recovery (Rollback) against Ransomware |
| Storage & Backup | RAID status, partition breakdown (Documents/Images/Video/Vault), automatic backup table |

**Group 3 — Admin Only:**
| Screen | Function |
|---|---|
| Audit Log | Privacy-Preserving history (file names hashed) showing Action/Timestamp/Result/Source IP for Forensics |
| Access Control | User account management + Role Assignment + Active Sessions |
| Settings | Personal + global system settings (Encryption Key Management, Firewall Zone Definitions) |

---

## 6. IDEA 2 — AEGIS Monitor (AI CCTV & Physical Sensing) · Supporting

**Role:** Physical threat detection sensor · **Knowledge Base:** AI + Big Data · **Status:** Hardware (Laptop+Webcam) ready, code development not started (UI/UX design completed).  
> **Name in Document:** IDEA 2 section uses "AEGIS AI Monitoring" consisting of 2 architectural parts (see 6.4.1): Detection Engine + Monitoring Web App.

### 6.1 Concept: Access Authorization Beyond "Headcount"
Uses Laptop as Edge (AI processing) + Webcam as sensor to monitor server room entrance. Pre-trains faces of authorized personnel:
- Match database = authorized internal person ✅
- No match = outsider → immediate escalated alert 🚨

Focus on **Data Pipeline + Access Control**, not model accuracy (use ready libraries like `face_recognition`, then prove LAN latency and transmission security).

### 6.2 Data Pipeline (Camera to NAS) — 5 Steps

| Step | Process | Details |
|---|---|---|
| 1 | AI Detection | Face detected → if not matched → Telegram alert + Snapshot sent to responsible operator (per IDEA 2 `camera_assignment`) |
| 2 | Segment Record | Laptop records **continuous** video, segments into ~10-minute clips (Interval-based) with flags for outsider periods |
| 3 | Post-Record Sync | After recording, use **rsync / scp** to transfer files to NAS over LAN |
| 4 | Cleanup | Perform **Integrity Check** on NAS → if files complete → delete source on Laptop |
| 5 | Log | Record timestamp, Camera ID, people count in frame, authorization results to central database — no job position/employee ID (PDPA) |

Network-critical steps 3–4: Encrypted rsync/scp + integrity verification; Integrity Check before deletion prevents data loss during sync.

> **Clip Recording Model (must be consistent across report and UI):** **Interval-based** (continuous recording in ~10-min segments then archive) **not** detection-triggered.

### 6.3 Success Metrics
- **100% Local Processing** — All AI on Edge, no Cloud dependency.
- **< 2 seconds Alert Latency** — From detection to Telegram notification.
- **24/7 Physical Monitoring** — Continuous surveillance.

### 6.4 Monitor Web App — Role-Scoped View (Security Important)
> **⚠️ Direction Change (v4):** IDEA 2 **has its own independent user account and authentication system**, separate from IDEA 1. CCTV-Operator / SOC-Responder roles and `camera_assignment` table are stored in **IDEA 2's own database**.

Roles in IDEA 2:
- **CCTV-Operator:** Views only assigned cameras (per IDEA 2 `camera_assignment`).
- **SOC-Responder:** Views all cameras overview, receives critical alerts.

Single app displays differently per role to enforce UI-level Least Privilege:

- **Aggregate View (SOC-Responder):** Full grid of all cameras + complete menus (Live, Recorded, Alerts, Detection log, Cameras) — suitable for overall situation assessment.
- **Scoped View (CCTV-Operator):** Login immediately directs to assigned camera; Live view limited to single camera per `camera_assignment`; **Alerts and Detection log menus hidden** (SOC-Responder only); remains Live view, Recorded clips, Cameras filtered to assigned ones.

Result: **IDEA 2 RBAC** controls visibility level, reducing Attack Surface per Least Privilege. Both views reference IDEA 2's own account database.  
UI shows **Average Latency (LAN edge → NAS)** to confirm Data Pipeline performance; clip detail page shows **linked alert ID** + **stored on NAS ✓** for Traceability.  
Telegram follows same responsibility: Events from each camera sent to assigned CCTV-Operator; critical events also to central SOC; notifications are **one-way** (app only receives/displays, no control commands back).

**UI/UX Status:** Prototype design completed via 2 prompts (Aggregate View + Scoped View) — navy/teal theme, backend not yet connected.

### 6.4.1 Separation of Work: Detection Engine + Monitoring Web App (2-Part Architecture)
> **Important New Point (added to document Section 4.4.2):** Technically, IDEA 2 **is not a single program** but consists of 2 parts operating on separate networks communicating via **Inter-VLAN Routing** (Detection Engine on VLAN 20, Monitoring Web App on VLAN 10 — see §2.3 details).

**Reason for 2 Parts:** Web browsers can only access cameras on the machine running the browser. Other machines on the network cannot directly open the camera on the Edge Node → must separate processing from display.

**Part 1 — Detection Engine (on Edge Node):**
- Program running on Laptop with attached Webcam.
- Duties: Continuous capture → Face Recognition against personnel database → ~10-min clip segmentation → Create Event on unknown persons.
- Sends results (Snapshot, authorization results, Log) over LAN to NAS + Telegram alerts.
- **Runs in background automatically, no GUI for general users.**

**Part 2 — Monitoring Web App (user viewing interface):**
- Web app runs as **Docker (Macvlan) on NAS (Beelink)** in **VLAN 10** (IP 192.168.10.12) only — **not on Edge Node** — accessible from VLAN 30 (via Inter-VLAN Routing) or within VLAN 10 per user rights.
- **Does not open cameras itself**; pulls images/results/events produced by Detection Engine.
- Multiple users can view the same data simultaneously with role-based visibility (Aggregate/Scoped View per 6.4).

**Advantages:**
- AI processing load on single machine (Edge Node); viewing distributed to multiple users without increasing camera/processing burden.
- **Reduced Attack Surface:** Single endpoint (web app) on the network that everyone accesses, instead of direct camera access from each machine.

> **Relationship with Role-Scoped View (6.4):** Detection Engine is the same backend for all roles; differences in Aggregate vs Scoped View occur in the **Monitoring Web App**, which filters displayed data per **RBAC + `camera_assignment` of IDEA 2 itself** (not IDEA 1).
> **Naming in Some Contexts:** "AEGIS Monitoring (Operator)" = Aggregate view of Monitoring Web App controlling/overviewing IDEA 2; "AEGIS CCTV-Operator View" = Scoped view of Monitoring Web App tied to responsible camera — both are **views of the same Monitoring Web App**, not separate apps.

### 6.4.2 Screen & Feature Mapping for AEGIS Monitor (Document Section 4.6)
AEGIS Monitor is a single web app that displays differently per role. All screens reference identity + `camera_assignment` from **IDEA 2's own account database** and act as **Read-only consumer** of Detection Engine.

**6.4.2.1 Aggregate View (SOC-Responder / All Cameras Overview):**
| Screen | Function | Key Information |
|---|---|---|
| Live canvas | Live view of all cameras + AI auto-focus on anomalies | Camera grid, face bounding boxes (Authorized/Unknown), combined event stream |
| Archival footage | View archived past clips (~10-min segments to NAS) | Thumbnails, clip start time, camera, period summary, timeline with Unknown markers |
| Detection stream | Face recognition log for all events (background to Alerts) | Timestamp, camera, people count, per-person results, name, confidence, NAS sync status; **multiple people in frame shown in separate rows for tailgating detection** |
| Alerts | Aggregated alerts awaiting acknowledgment (review-only) | Severity, type, camera, time, snapshot, Telegram destination, Acknowledge button |
| Nodes & routing | Status of all cameras + responsible operators | Name/zone/resolution/online-offline + assigned operator |

**6.4.2.2 Scoped View (CCTV-Operator / Single Camera):** Detection stream and Alerts menus hidden.
| Screen | Function | Key Information |
|---|---|---|
| Live canvas | Live view of only assigned camera | Live feed, face boxes + authorization results, camera-specific event stream, per-camera stats (Faces/Authorized/Unknown/Avg latency) |
| Archival footage | Past clips for only assigned camera (locked filter) | Same as Aggregate but filtered to assigned camera |
| Camera diagnostics | Health monitoring of assigned camera (**self-diagnostics**) | Operational/Degraded/Offline, latest heartbeat, latency graph, fps, uptime, disconnection count, NAS sync status, Self-check log |
| Settings | Personal preferences | Language (Thai/English/Chinese), Light/Dark, browser notifications, read-only session, Sign out |

**6.4.2.3 Scope Note:** All IDEA 2 screens limited to monitoring — no file management (IDEA 1), no circuit cutting/armed-disarmed control (IDEA 3), no user/camera_assignment management. IDEA 2 Settings is only personal preferences (language/theme/notifications) **not** the full 5-category Settings of IDEA 1.

### 6.5 PDPA & Data Management Ethics (3 Measures)
- **Consent Management:** Prepare consent documents for all personnel whose faces are trained.
- **Data Privacy:** Face database stored only in internal LAN, no upload to public Cloud.
- **Retention Policy:** Clear retention periods for Logs and Snapshots, no longer than necessary.

Detection logs and face recognition results store/display only **name + role (RBAC Role)** from IDEA 2 account database — no job position, department, or employee ID (limits PDPA scope). Identity system and `camera_assignment` belong to IDEA 2 itself, separate from IDEA 1.

### 6.6 Failure Analysis (IDEA 2)

| Scenario | Impact | Mitigation (Resiliency) |
|---|---|---|
| External internet cut | Telegram cannot send | System can still detect + log to NAS within LAN |
| NAS Server down | Cannot record clips to NAS | Laptop keeps Local Cache temporarily until NAS returns |
| Insufficient room lighting | AI accuracy decreases | Use IR camera or Motion Sensor to assist |

**Important Note — Consistency with IDEA 3:** "NAS down" case does not conflict with IDEA 3 Heartbeat because Heartbeat only cuts **Uplink (WAN)**, not **internal LAN**. Therefore Laptop can still sync to NAS via LAN normally. Both mechanisms are consistent.

---

## 7. IDEA 3 — Cyber-Physical Lockdown · Security Hero (Active Defense)

**Role:** Active Defense (strongest highlight) · **Knowledge Base:** Cybersecurity  
**Status:** 🟢 Most prepared — **Main hardware purchased** + **Software code written but not yet physically tested** (5-scenario test plan pending — see Section 7.7).

### 7.1 Concept: Contain before Notify (NIST SP 800-61 reference)
When NAS is attacked (DDoS/Brute-force), system responds automatically by **limiting damage (Containment) before notification** — like "put out the fire before calling relatives".

**Reason for Order Swap (solved paradox):** Original workflow waited for successful Telegram before cutting. Under DDoS with full bandwidth, Telegram would timeout → system hangs → never cuts. Therefore moved physical cut (via LAN MQTT unaffected by DDoS) to first priority.

**Threat Scope:** Covers worst case = attacker escalates to **Root** on NAS, where normal software defenses would completely fail (see Failure Case #6).

### 7.2 Updated Resilient Workflow
1. Suricata/WAF detects threat.
2. Log to PostgreSQL (local, no external internet).
3. **Send MQTT (HMAC + nonce) to immediately command ESP32 to cut circuit — Contain first** (+ UFW port blocking in parallel).
4. Async Telegram with 3-second timeout (skip if fails, do not block system).
5. ESP32 verifies signature + nonce then **cuts only Uplink** (Management VLAN unaffected) + sends ACK.

### 7.3 Failure Cases (6 Cases) — Use as analysis foundation

| # | Problem | Solution |
|---|---|---|
| 1 | Telegram fails during DDoS | Contain-before-Notify (cut via LAN MQTT first, then async alert) |
| 2 | Cutting single LAN = cuts Admin too | Relay cuts only Uplink; Management VLAN unaffected |
| 3 | ESP32/MQTT Broker down | QoS 1-2 + ACK + ESP32 Watchdog (choose Fail-Secure with justification) |
| 4 | Telegram retry after Uplink cut | Send before cut (short timeout); if missed, log to PostgreSQL for Admin during recovery |
| 5 | HMAC fails to prevent Replay | Add nonce/timestamp to payload before signing; ESP32 rejects old/duplicates |
| 6 | Attacker gains Root and stops MQTT service before cut command (Single Point of Trust) | Dead Man's Switch (Heartbeat) — see 7.4 |

> ✅ **Consistent with document:** Conclusion section (Section 7 "Summary and Development Scope") updated to "thinking ahead for failure...all **6** cases" matching this table.

### 7.4 Deep Dive Failure Case #6: Single Point of Trust + Dead Man's Switch
**Problem:** NAS is both Detector and Commander in one machine = Single Point of Trust. If Root compromised:
- `systemctl stop mosquitto` → cut command never sent.
- Read HMAC key → can forge valid commands (nonce/HMAC in Case #5 becomes useless).

**Solution — Inverted Logic:** Change from "NAS sends cut command" (NAS silent = nothing happens) to "NAS must continuously send Heartbeat (signed HMAC)" (NAS silent = cut immediately). Attacker stopping service now becomes **trigger** for ESP32 to cut Uplink in Fail-Secure manner, consistent with Watchdog Timer + Fail-Secure in Case #3.

**Trade-off (Availability ↔ Security):** Normal NAS reboot/hang will also lose heartbeat → cut network (False Positive). Team accepts this per principle "better to cut unnecessarily temporarily than leave potentially compromised system connected".

**Timeout Value:** Initial ~**60 seconds** (approximate/adjustable) and will be tuned based on real Beelink x86 boot time test, which **may need extension to 90–120 seconds** — **must test real boot to finalize** (Beelink hardware not arrived yet).

**Relationship with 2 Cut Paths:** Heartbeat is backup layer (Passive/Backup Trigger) supplementing normal active command from NAS (Active Trigger in 7.2). Does not replace it → system has both proactive response (when healthy) and safety net (when Core compromised).

### 7.5 Incident Recovery (Closed-Loop)
After incident resolved, Admin recovers via **Management VLAN (Out-of-band)** unaffected by cut → permanently block attacker IP in UFW (via CLI `sudo ufw deny`, not chat command) → send new MQTT (new nonce) to unlock Relay and reconnect Uplink → reopen ports → Log lessons back to PostgreSQL (close Closed-Loop linking to IDEA 1).

---

### 7.6 Real Hardware Status (BOM Status) — Latest Update
> This table is **Lab/Purchasing level detail** — use as report appendix, not in main Architecture chapter.
> **Document Status (5.6):** Written conservatively as "planned to use". Main items already purchased. If updating document, change to "purchased/in process of purchasing" per real status below.

| Item | Real Status | Approx. Price (THB) | Usage Note |
|---|---|---|---|
| ESP32 WROOM-32 DevKit (38 pin, USB-C, WiFi+BT) | ✅ Purchased | 135 | Main controller (Commander/Verifier) |
| 5V 2-Channel Relay Module (JQC3F-05VDC-C) | ✅ Purchased | 35 | Channel 1 primary (cut Uplink); Channel 2 reserved for expansion |
| 2x 10mm LED Module (red+green) | ✅ Purchased | 30 | Status indicators for Uplink: green=normal (NC), red=cut (NO) |
| Solderless Breadboard | ✅ Purchased | 40 | Circuit testing without soldering |
| 40-pin 20cm Male-Female Jumper Wires | ✅ Purchased | Included in kit | Connect ESP32 ↔ Relay ↔ LED on breadboard |
| RJ45 Coupler (Female-Female) x2 | 🔲 In process | ~95–110 each | Optional: Allows quick swap back to normal LAN cable without permanent cut |
| USB 3.0 Power Meter Tester (with cumulative mAh) | 🔲 In process | ~60–150 | For electricity measurement (see 7.8) |
| Short sacrificial LAN cable for testing | 🔲 Not yet purchased | ~20–30 | Use cheap new cable instead of cutting real house cable |

**Total IDEA 3 Budget Estimate:** ~510–640 THB (within original 390–640 THB estimate).

**Decided Circuit Principles:**
- Use 1 of 2 Relay channels for Uplink cut/connect; second reserved for expansion.
- Initial testing with 2-color LEDs instead of real LAN cable (green=connected, red=cut) before moving to real cable cut — reduces risk of damaging cables during development.
- Real LAN cable cut (when ready) will use **dedicated cheap sacrificial cable** — not cut existing house/room cable. RJ45 Coupler provides reversible option.

### 7.7 Software Status — Pre-Hardware Validation (Code written, awaiting real test run)
Team uses same strategy as IDEA 1: "separate Logic from Hardware" — **Wrote** simulation software on laptop to prove security logic without waiting for full hardware.

> ⚠️ **Real Status (Important — do not overclaim):** Code in this set **has been written but not yet physically tested**. The 5-scenario test results below are **"expected outcomes per design"**, not confirmed runtime results — consistent with document (5.5) stating "test results above are planned; not yet actual outcomes". Update this file to "confirmed" only after real successful runs.

Files in `AEGIS_IDEA3_prehardware` set:

| File | Role | Status |
|---|---|---|
| `secure_channel.py` | Security core: Create/verify HMAC-SHA256 signature + nonce + timestamp | Written, awaiting test |
| `esp32_sim.py` | Virtual ESP32: Verify commands, control Relay cut/connect, Heartbeat Watchdog (Dead Man's Switch) | Written, awaiting test |
| `demo_offline.py` | Demonstrates 5 safety scenarios in-process (no broker/hardware needed) | Written, awaiting test |
| `commander_mqtt.py` + `esp32_mqtt.py` | Real MQTT version via Mosquitto broker (Docker) | Written, awaiting hardware test |
| `esp32_firmware.ino` | Real ESP32 firmware (Arduino/mbedTLS) — logic mirrors `esp32_sim.py` 1:1 | Written, awaiting flash after circuit assembly |

**5-Scenario Test Plan (`demo_offline.py`) — Expected Outcomes (not yet run):**
1. Valid Uplink cut command (correct HMAC, new nonce, new ts) → **Expected** ESP32 accepts + sends ACK (`{"ack":"OK"}`) — proves Contain-before-Notify path.
2. Replay Attack (duplicate nonce) → **Expected** rejected (`REPLAY`) — proves Failure Case #5.
3. Tamper Attack (modify `cmd` after signing) → **Expected** rejected (`BAD_HMAC`) — proves Integrity.
4. Expired command (timestamp older than 30s) → **Expected** rejected (`STALE`) — proves time-window replay protection.
5. NAS stops sending Heartbeat (simulated compromise) → **Expected** ESP32 cuts Uplink after timeout — proves Dead Man's Switch (Failure Case #6).

> **Implication for Report:** After successful real tests, this will be evidence that IDEA 3 is not just paper concept but has runnable code proving Failure Cases in Section 7.3 (except Case #2, #4 which require real IDEA 1 hardware for joint testing due to VLAN/PostgreSQL). Suitable as implementation evidence in Chapter 5 **only after real runs**.

### 7.8 Electricity Measurement Methodology and Power Table Creation
**Tool:** USB 3.0 Power Meter Tester (must have cumulative mAh display + Reset button).  
**Connection:** Insert between charger/power bank and USB cable powering ESP32. Condition: Relay must draw power from ESP32's 5V/VIN (no separate adapter) so measurement covers whole board (ESP32 + Relay + LED).

**Table 1 — State Comparison (Snapshot):** Measure 2 states to see Relay power draw increase.

| State | Description | Voltage (V) | Current (mA) | Power (W) |
|---|---|---|---|---|
| Idle | ESP32 waiting for commands/Heartbeat, Relay inactive | To be measured | To be measured | To be measured |
| Relay Active (CUT_UPLINK) | Relay coil energized (switches NO/NC) | To be measured | To be measured | To be measured |

**Table 2 — Continuous Operation (for runtime calculation):**
1. Reset cumulative mAh to 0.
2. Run system continuously for full 1 hour.
3. Record cumulative mAh → power consumption rate (mAh/hour).

| Calculation | Formula |
|---|---|
| Runtime on Power Bank | Runtime = (Power Bank capacity × Efficiency ~0.85) ÷ mAh/hour rate |
| Daily electricity cost (THB) | Energy/day = (mAh/hour rate ÷ 1,000,000) × V × 24 → Wh→kWh → × electricity rate/unit |
| Monthly electricity cost (THB) | Daily cost × 30 |

> **Important Notes (per Principle 0):**
> - V/A/W/mAh values **must be real measurements only** — do not fill in fictional numbers in document.
> - Efficiency ~0.85 is general Power Bank boost converter standard — approximate, not specific to this device.
> - Electricity rate (THB/unit) must reference current PEA/MEA rates before final numbers.
> - Table 2 should be tested at least twice before finalizing.

**Use in Report:** Results of Tables 1–2 go in IDEA 3 section (current document places at 5.6 Procurement + 5.7 Power Methodology) and reference back to Section 3.4 (Benefits — low cost) for quantitative support of "enterprise security at low budget".

> Note on section mapping: This file uses 7.6/7.7/7.8 for grouping all IDEA 3 content, but **in actual report** these are **5.5 (Pre-Hardware + test plan), 5.6 (Procurement/BOM), 5.7 (Power Methodology)** — when referencing with team use report section numbers.

---

## 8. Integration of the 3 Systems (Ecosystem)

3 connection points that make AEGIS a single system, not 3 separate projects:
- **NAS = Hub:** Both clips (IDEA 2) and attack logs (IDEA 3) flow to the same NAS (IDEA 1).
- **Single Telegram SOC Room:** Sees both "stranger" and "cyber attack" in one chat.
- **VLAN = Blood Vessels Binding All Systems:** IDEA 1 separated data layers (VLAN 10) / IDEA 2 separated camera path (VLAN 20) / IDEA 3 reserved Management during cut (VLAN 30) — real details in 4.4.

**Example Scenario (All working together):** Camera (IDEA 2) detects stranger entering server room → sends Snapshot to Telegram + stores clip on NAS **simultaneously**. DDoS targets NAS → Suricata (IDEA 3) detects → logs → commands ESP32 to cut Uplink immediately + sends cyber alert to same Telegram room → Admin sees full physical+cyber picture in one chat → Recovers via unaffected Management VLAN.

---

## 9. Principles and Rules AI Must Always Follow (Key Principles)

1. **Dead Man's Switch = silence triggers cutoff:** Heartbeat missing → cut, not explicit command; closes Root-compromise / Single Point of Trust hole.
2. **WAN vs LAN must be clearly separated:** Heartbeat/Lockdown cuts only **WAN Uplink**; **LAN remains** → IDEA 2 local cache/sync continues working, no conflict.
3. **Scope discipline + Identity Decoupling (v4):** Each IDEA owns its own features **and user account system**. Do not let them bleed across.
   - IDEA 1 (AEGIS Drive) = secure file manager only; accounts = Admin, DataLake-User (of IDEA 1).
   - IDEA 2 (AEGIS Monitor) = 2 parts: **Detection Engine** (on Edge Node, processes camera, no GUI) + **Monitoring Web App** (monitoring display only — no armed/disarmed, no cut button, no file browser); accounts = CCTV-Operator, SOC-Responder + `camera_assignment` **of IDEA 2 itself**.
   - IDEA 3 = automated/physical, no GUI; ARMED/disarmed belongs to IDEA 3 only.
   - **Only cross-dependency:** UFW block IP during recovery uses IDEA 1 Admin (UFW runs on NAS).
4. **AI/Big Data are secondary:** Main rubric scores Network/Security axis — framing is critical for evaluation.
5. **Fixed vs adjustable:** Untested values (e.g., Heartbeat Timeout 60s, electricity rate, Efficiency 0.85) must be written as "approximate/adjustable" until real measurement.
6. **RBAC role ≠ job title:** Detection log stores timestamp, Camera ID, people count in frame, result, matched identity (name), confidence — no job title; role chip on UI = RBAC role, not job position.
7. **Clip recording model = interval-based (~10 minutes)** not detection-triggered — must be consistent across report and UI.
8. **Separate content levels:** Architecture/concepts/principle test results → main report content; purchase details, brands, prices, improvised methods → separate appendix/BOM.
9. **"Written" ≠ "Tested and passed" (Important):** When discussing IDEA 3 software, always state real status = "code written but **not yet physically tested**". 5-scenario results are "expected" not "confirmed" — never claim passed until real run.

---

## 10. Current Status and Next Tasks (Status & TODO)

**Main Documents:** `AEGIS_System_Design.docx` (✅ Network section complete at 2.3 — but ⚠️ still has leftover old text at end of §2.3.4 that must be cleaned), `AEGIS_Project_Knowledge.md` (this file v7), `Claude_Project.md` (⚠️ not yet confirmed updated to match 2.2-2.3, needs check), 2 prompt design files (`AEGIS_Monitor_AggregateView_Revision_Prompt.md`, `AEGIS_Monitor_ScopedView_Prompt.md`).

**Status by IDEA:**

| IDEA | Hardware | Software | Overall Progress |
|---|---|---|---|
| IDEA 1 (NAS) | Arrived — Network (VLAN/Port/IP) configured and tested (4.4) | Phase 1 in progress (Docker Macvlan) | 🟢 Network ready, awaiting Docker services |
| IDEA 2 (AI CCTV) | Ready (Laptop+Webcam) | Code not started (UI/UX done) | 🔴 Not started |
| IDEA 3 (Lockdown) | Main parts purchased, Coupler/Power Meter pending | **Code fully written, awaiting real test runs** | 🟢 Most prepared |

**On the horizon:**
- **Re-enable UFW on Beelink + set rules** (default deny, allow SSH from 192.168.30.0/24) — currently disabled for routing tests only. **Must do before submission** (this status intentionally not in main document).
- **Clean leftover old text at end of §2.3.4** in document (repeated Terminal Account sentence from previous version).
- Update `Claude_Project.md` to match document Sections 2.2–2.3.
- Decide ESP32 connection (IDEA3): Built-in WiFi vs Ethernet via Unmanaged Switch from Port 3.
- Set Static IP for Laptop Detection Engine (VLAN 20).
- Real end-to-end VPN (OpenVPN) test — waiting for home internet.
- **Run real IDEA 3 software tests** (`demo_offline.py` 5 scenarios) — next important task to change "expected" to "confirmed".
- Assemble real IDEA 3 circuit on laptop (ESP32+Relay+LED) with purchased parts, test with ping monitor.
- Measure real electricity per methodology 7.8 once USB Power Meter arrives.
- Test real Beelink x86 boot time to finalize Timeout (60 → possibly 90–120s) — waiting for hardware.
- Build IDEA 2 face recognition on Laptop + Telegram Bot (not started).
- IDEA 1 Docker (Macvlan) — set up real containers per IPs in 4.4.3 (Member 1).
- Fix typos/numbers in document (see Section 11).
- Check report structure per "Security Project" format (Chapters 1–5) of the program.

**Grading Criteria:** 30% progress reports (9 advisor meetings) + 70% project (CLO5 55%, CLO6 15%, S/U ethics).

**Anticipated Committee Questions (Prepare Answers):**
- "If NAS is the brain, who commands cut when brain is compromised?" → Dead Man's Switch (Case #6).
- "How does role chip differ from removed job title?" → Role chip = RBAC role, not job position.
- "Has real boot time been tested (Timeout value)?" → Starting at 60s, will tune per real test (hardware pending).
- "Any real hardware to show?" → IDEA 3 hardware (ESP32/Relay/LED) purchased + code complete; test results after real runs (**do not claim passed if not run yet**).
- "What is system cost and power consumption?" → BOM (7.6) ~510–640 THB + power tables (7.8) when real data available.

---

## 11. Consistency Warnings (Consistency Checklist for AI)

When helping edit documents/slides/UI, check for no contradictions in these points:
- **IDEA 3 software status** must consistently say "code written, awaiting real test run" across .md, document (5.5), and slides — **never claim tested and passed** until real run.
- **Timeout** value must match across report and IDEA 3 deck (60 → 90–120s per real boot).
- **Clip recording model** must be interval-based (~10 minutes) everywhere in report (6.2) and UI.
- **Fields in Detection log / Data Pipeline Step 5** must match: timestamp, Camera ID, people count in frame, result, matched identity, confidence — no job title.
- **Local Cache (IDEA 2) vs Heartbeat (IDEA 3)** must note that only WAN is cut, LAN remains.
- IDEA 2 UI must not include IDEA 1 features (file browser) or IDEA 3 features (lockdown/armed).
- **IDEA 2 as 2 parts (Detection Engine + Monitoring Web App)** must be explained consistently: Web App does not open cameras itself, pulls data from Detection Engine over LAN — do not write as if browser on user machine directly opens Edge Node camera.
- **Naming:** "AEGIS Monitoring/Operator" (Aggregate) and "CCTV-Operator View" (Scoped) are **2 views of the same Monitoring Web App** — do not write as separate programs.
- **⚠️ Identity Decoupling (v4 — Most Important):** IDEA 1 and IDEA 2 user/account systems are **completely separate** — CCTV-Operator/SOC-Responder + `camera_assignment` belong to **IDEA 2**, not IDEA 1 central RBAC (old direction that was changed); only cross-dependency = UFW block IP uses IDEA 1 Admin.
- **✅ camera_assignment ownership contradiction fixed (v5):** All sections now consistently state it belongs to **IDEA 2**.
- **Names:** IDEA 1 = "AEGIS Drive", IDEA 2 = "AEGIS Monitor" — both on Application Layer, share Storage/Metadata Layers, but separate accounts.
- **✅ Real network devices (v6):** Edge Router = **MikroTik hEX lite (RB750r2)**, Managed Switch = **TP-Link TL-SG105E**.
- **✅ Real VLAN numbers (v6):** VLAN 10=Server, 20=Detector (camera/Laptop IDEA2), 30=Management.
- **✅ Monitoring Web App on VLAN 10 not 20 (v6).**
- **✅ Remote Access 2 parallel paths (v7).**
- **⏳ Test results/Open Items intentionally not in main document (v7):** Offline Validation and Open Items table removed from §2.3 by decision. Network has been successfully tested (Ping 0% loss, Latency 0.5-0.8ms, SSH headless) — just not shown in main content.

**Remaining typos/inconsistencies in document (must fix):**
- **Cover page:** "โครงงงาน" (extra ก) should be "โครงงาน".
- **Section 7 (Conclusion):** ✅ Updated to "6 cases" — cleared.

**Caution when adding IDEA 3 info:**
- V/A/W/mAh numbers in power section (document 5.7) must be real measurements only.
- Electricity rate must reference real current PEA/MEA rates.
- BOM details/prices/brands (document 5.6) should be in appendix, not mixed with architectural Tech Stack (4.3).
- **BOM in document (5.6) says "planned to use" but main items already purchased** — update to "purchased/in process" if revising.
