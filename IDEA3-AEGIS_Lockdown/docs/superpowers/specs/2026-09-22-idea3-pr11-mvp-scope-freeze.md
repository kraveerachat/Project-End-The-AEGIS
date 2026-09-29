# IDEA3 PR11 — MVP Scope Freeze & Final Project Boundary Specification

Date: 2026-09-22
Owner: Music (Kla / Pub reviewing)
Task: Freeze IDEA3 Final Project MVP scope following PR #178 merge
Branch: `docs/idea3-pr11-mvp-scope-freeze`
Base: `origin/main` (`3b91fc40cc173f9a2e820d5510374432687bedfd`)
Status: OWNER_APPROVED — BINDING SCOPE FREEZE
Mode: DOCUMENTATION / SCOPE RECONCILIATION ONLY
Production Mutation: NO
Live L-Stage Execution: NO
Package Installation: NO
Sudo Operations: NO
IDEA1/IDEA2 Mutation: NO
ESP32 Operation: NO
CUT/RESTORE Operation: NO
Dynamic Firewall Implementation: NO (documented gap; deferred to separate implementation PR)

---

## 1. Executive Summary & Purpose

Following the merge of PR #178 (`7f30b9ca` / `3b91fc40`), this document formally and permanently freezes the scope of IDEA3 (AEGIS Lockdown) for its Final Project course deliverable.

**Core Definition**:
> **IDEA3 is a SECURITY ORCHESTRATOR + PHYSICAL CONTAINMENT MVP.**
> The project is **NOT** required to become a full-scale enterprise/production Security Operations Center (SOC).

The purpose of this scope freeze is to prevent indefinite feature creep, establish unambiguous exit criteria for PR11, define the exact scenarios required for PR12 Final System Acceptance, and protect the team from attempting out-of-scope enterprise hardening that is non-essential for a proven, end-to-end cyber-physical security demonstration.

---

## 2. Owner-Approved Final Project Core Flow

The system lifecycle and demonstration path for the final project follows this exact sequential flow:

```text
NORMAL
  │
  ▼
Detect Suspicious / Security Event
  │
  ▼
Identify Source IP / Target Device / Event Type / Timestamp
  │
  ▼
Record Security Incident
  │
  ▼
Determine Severity Classification
  │
  ├── [Severity = HIGH]
  │     │
  │     ▼
  │   Software Containment (Dynamic Source-IP Blocking)
  │     │
  │     ▼
  │   Audit Log Containment Action
  │     │
  │     ▼
  │   Administrator Recovery / Unblock
  │     │
  │     ▼
  │   Return to NORMAL
  │
  └── [Severity = CRITICAL]
        │
        ▼
      Software Containment + Authenticated Hardware Containment Decision
        │
        ▼
      Issue Authenticated Protocol v1 CUT Command to ESP32
        │
        ▼
      ESP32 Relay Actuation (Physical Network Interruption)
        │
        ▼
      Log Action, Result & State Change
        │
        ▼
      Authorized Administrator Physical Recovery (RESTORE)
        │
        ▼
      Return to NORMAL
```

---

## 3. Binding MVP Classification

All system functions, tasks, and historical aspirations are categorized under six binding classifications:
- `MVP_MUST`: Mandatory for PR11/PR12 completion.
- `MVP_SUPPORTING`: Enablers or safety mechanisms that support the MVP without defining its primary criteria.
- `DEFER_FUTURE_WORK`: Legitimate enterprise features explicitly excluded from course project acceptance.
- `ALREADY_CLOSED`: Previously completed, merged, and verified deliverables.
- `OPEN_NEEDS_IMPLEMENTATION`: Code or configuration gap requiring a dedicated implementation PR.
- `OPEN_NEEDS_EVIDENCE`: Implementation exists in repository, but live host/hardware evidence is open.

### 3.1 MVP_MUST (Mandatory Final Deliverables)
1. **Live IDEA3 Web / Dashboard**: Functional management and monitoring interface.
2. **Live IDEA3 Core**: Headless Python orchestrator running on the Arch Linux Core host.
3. **Event Detection**: Detection of attacks and suspicious network/system activities.
4. **Source IP / Device / Event / Time Identification**: Accurate extraction and attribution of attack metadata.
5. **Incident Logging**: Immutable, correlated recording of security events in the database and audit trail.
6. **Severity / Correlation Engine**: Automated correlation determining threat severity (HIGH vs. CRITICAL).
7. **Dynamic Software IP Block**: Automated host-level firewall containment for offending source IPs.
8. **Dynamic Software IP Unblock / Recovery**: Administrator-driven unblock restoring expected communication.
9. **Bounded IDEA1 Status / Security Visibility**: Ingestion and display of IDEA1 health and security alerts.
10. **Bounded IDEA2 Status / Security Visibility**: Ingestion and display of IDEA2 health and security alerts.
11. **Secure Core ↔ ESP32 Communication**: TLS-protected MQTT transport plus application-layer HMAC-SHA256 authenticated frames.
12. **Stage L1 Prerequisite**: Minimal package prerequisites (`chrony`) needed by the live stack.
13. **Stage L2 Firewall / Isolation**: Baseline host isolation and interface protection.
14. **Stage L3 AP**: Dedicated wireless Access Point infrastructure for ESP32 connectivity.
15. **Stage L4 Addressing / DHCP**: Isolated IP assignment for the ESP32 containment module.
16. **Stage L5 Trusted Time**: Synchronized local chrony NTP runtime ensuring HMAC timestamp validity.
17. **Stage L6a Isolated MQTT/TLS Validation**: Synthetic broker and PKI verification.
18. **Stage L6b Live MQTT/TLS Broker**: Operational TLS 8883 Mosquitto broker on Core.
19. **Stage L7 Core Service**: Supervised systemd installation of `aegis-idea3-core.service`.
20. **Stage L8 ESP32 Provisioning / Flash**: Flashing Protocol v1 firmware and staging per-device secrets.
21. **Stage L9 Authenticated STATUS/HEARTBEAT**: Proven live authentication without actuation.
22. **Authenticated CUT Readiness**: Validated command pipeline capable of issuing an authenticated CUT.
23. **Physical Relay Containment Readiness**: Operational relay circuit capable of physical line disconnection.
24. **Admin Recovery Readiness**: Proven authorization flow for restoring normal network connectivity.
25. **Final E2E Evidence Readiness**: Automated test scripts, capture bundles, and reproducible logs.

> [!IMPORTANT]
> **Stage L9 Transport & Authentication Binding Definition**:
> Mutual TLS (mTLS) is **NOT** claimed or required between the Core broker and the ESP32.
> The binding architecture is: **TLS-protected MQTT transport plus application-layer HMAC-SHA256 authenticated STATUS/HEARTBEAT frames**.
> Furthermore, Stage L9 remains strictly **AUTHENTICATION WITHOUT ACTUATION**. CUT and RESTORE commands are intentionally prohibited from L9 acceptance criteria.

### 3.2 ALREADY_CLOSED (Merged & Verified Milestones)
- PR10 S1: Server inventory and shared architecture gate (`93170862`, PR #120, PR #122).
- PR10 S2: Repository Server → Core boundary and accepted action schemas (`d903327e`, PR #123).
- PR11 Phase 0: Repository and live read-only preflights (`PASS`).
- PR11 Phase 1: Architecture decisions K1–K12 and Phase 1 closeout (`90efbc8e`, PR #127, PR #131).
- PR11 Phase 2: Core-to-Server mTLS, reverse proxy routing, and runtime closeout (T3/T4 PASS, `8cf917bf`, PR #139, PR #144, PR #145, PR #146).
- PR11 Phase 3: Core systemd unit corrections and T9 credential integration (`PR #133`, `PR #149`).
- PR11 Phase 4 Protocol v1 Design: Sequence tracking, HMAC-SHA256, replay protection (`f0a87ee1`, PR #135).
- PR11 D4 Core-Local RESTORE: Local recovery CLI and state validation (`3fd8d4d1`, PR #138).
- PR11 Phase 4 T0: Prerequisites reconciliation and stage breakdown (`PR #151`).
- PR11 Phase 4 T1: Stage-gate and comparison harness (`PR #152`).
- PR11 Phase 4 L1 Live Backend: Repository implementation of guarded pacman backend (`7f30b9ca`, PR #178 merged at `3b91fc40`).
- Phase 4 Stage Handlers (L1..L9): All repository stage handlers registered and merged (`L2_L9_REPOSITORY_HANDLERS = ALREADY_CLOSED`).
- Official L0 Baseline: Read-only live host state capture and durable acceptance (`2026-09-21`).

### 3.3 OPEN_NEEDS_IMPLEMENTATION
- Dynamic Software IP Blocking (`SOFTWARE_IP_BLOCKING = OPEN_NEEDS_IMPLEMENTATION`).
- Dynamic Software IP Unblock / Recovery (`SOFTWARE_IP_UNBLOCK = OPEN_NEEDS_IMPLEMENTATION`).

### 3.4 OPEN_NEEDS_EVIDENCE
- IDEA1 Live MVP Integration (`IDEA1_LIVE_MVP_INTEGRATION = OPEN`).
- IDEA2 Live MVP Integration (`IDEA2_LIVE_MVP_INTEGRATION = OPEN`).
- Stage L1 Live Execution Evidence (chrony installation on Arch Linux Core).
- Stages L2 through L9 Live Host and Hardware Evidence (`L2_L9_LIVE_EXECUTION = OPEN_NEEDS_EVIDENCE`).
- Out-of-band Disk Remediation (resolution of 96% disk usage, PR #175).
- Out-of-band IDEA2 §10 Health Restoration (PR #176) or formal owner approval of narrowed preservation.

### 3.5 MVP_SUPPORTING
- PR #147: Automated snapshot and recovery utility (supporting PR12 backup/recovery baseline).
- Synthetic test harnesses and offline fixture environments.
- Read-only preflight and post-flight validation scripts.

### 3.6 DEFER_FUTURE_WORK (Post-Project Enterprise Scope)
The following items are categorized as `DESIGNED_OR_IMPLEMENTED_WHERE_APPLICABLE; NOT_REQUIRED_FOR_FINAL_PROJECT_MVP_ACCEPTANCE`:
1. ESP32 NVS encryption remains optional physical-extraction hardening and is not an MVP blocker. Residual physical extraction risk remains explicitly acknowledged.
2. Automated CRL renewal and lifecycle daemons.
3. Advanced Linux cgroup resource quota and accounting fine-tuning.
4. Enterprise Mosquitto High Availability (HA) clustering.
5. Full retirement of legacy plaintext 1883 is deferred. Phase 4 intentionally preserves the existing legacy listener, while L2/L4 firewall policy must prevent TCP/1883 access from the IDEA3 AP.
6. Repeated stress/endurance life-cycle testing of relay physical contacts.
7. Full enterprise Disaster Recovery (DR) formal certification.
8. K12 cold bare-metal reboot persistence verification of all multi-service containers.
9. Extended edge-case production hardening beyond the defined E2E scenarios.

---

## 4. Software BLOCK_IP Gap Analysis

A clear separation is made between existing capability and the remaining implementation gap:

```text
SOFTWARE_IP_BLOCKING = OPEN_NEEDS_IMPLEMENTATION
SOFTWARE_IP_UNBLOCK  = OPEN_NEEDS_IMPLEMENTATION
```

### Current Repository Status:
- **Available and Verified**:
  - Attack detection pipelines and log scrapers.
  - Offending source-IP extraction and parameter parsing.
  - Incident data structuring and database persistence.
  - Containment policy determination (evaluating HIGH vs. CRITICAL).
  - Static nftables rulesets for AP interface isolation.
  - Legacy UFW-based containment logic (used in older desktop prototypes).
- **Missing / Gap on Arch Linux Headless Core**:
  - The running Arch Linux Core does not use UFW and relies on `nftables`.
  - There is currently no active dynamic nftables rule injection/removal driver in `aegis_soc` capable of adding an offending IP to a drop set and subsequently removing it upon administrator recovery.

### Strict Governance Boundary:
- Software IP blocking must **NOT** be claimed as implemented.
- Software IP blocking must **NOT** be implemented in this scope-freeze PR.
- Implementation of dynamic nftables source blocking and unblocking will occur in a dedicated, isolated implementation PR prior to PR11 exit.

---

## 5. Cross-IDEA MVP Boundaries

IDEA3 acts as a security orchestrator, not a monolithic controller of other project areas.

### 5.1 IDEA1 (AEGIS Drive LC) MVP Boundary
- **Required for MVP**:
  - Read-only health and daemon status visible in IDEA3 dashboard.
  - Security-relevant event/status feed consumed and visible in IDEA3.
  - Honest state representation (`ONLINE`, `DEGRADED`, or `UNKNOWN`).
  - Sufficient event data to correlate Drive security occurrences (e.g., unauthorized access attempts).
- **Explicitly Excluded from MVP**:
  - Remote control of IDEA1 business logic or file-sharing features.
  - Storage administration, volume resizing, or disk quota management.
  - Orchestration of internal Drive file lifecycles or private vault cryptography.
- **Current Truth**: `IDEA1_LIVE_MVP_INTEGRATION = OPEN` until live API communication is demonstrated on the deployed environment.

### 5.2 IDEA2 (AEGIS Monitor / CCTV) MVP Boundary
- **Required for MVP**:
  - Read-only health and detector status visible in IDEA3 dashboard.
  - Security-relevant alert and anomaly feed consumed and visible in IDEA3.
  - Honest state representation (`ONLINE`, `DEGRADED`, or `UNKNOWN`).
  - Ingestion of detection events as candidate incident triggers in IDEA3.
- **Explicitly Excluded from MVP**:
  - Remote control of IDEA2 camera streams, codecs, or PTZ controls.
  - Management of machine learning models or inference weights.
  - Management of operator consoles, monitor accounts, or CCTV retention policies.
- **Current Truth**: `IDEA2_LIVE_MVP_INTEGRATION = OPEN` until live API communication is demonstrated on the deployed environment.

---

## 6. IDEA2 Preservation Governance

### Status:
```text
IDEA2_NARROWED_PRESERVATION = OWNER_DECISION_PENDING
```

The strict Phase 4 §10 rule states that any live stage must halt if IDEA2 is in an unhealthy state. Because the current Core environment exhibits an unhealthy IDEA2 tunnel (`NRestarts > 1450`, port 18002 absent), live stages are currently blocked.

### Proposed Narrowed Preservation Rule (Pending Owner Decision):
An IDEA3 live stage may pass IDEA2 preservation provided it causes **NO NEW DEGRADATION** relative to the immediate pre-stage IDEA2 baseline.

Under this proposed framework:
1. **Pre/Post Evaluation Surfaces**:
   - Detection engine service runtime state (`aegis-detection-engine.service`).
   - Local detector API port accessibility (`127.0.0.1:8077`).
   - Physical management and uplink network addressing / routing.
   - Observation of tunnel restart deltas (confirming no abnormal acceleration).
   - Absolute verification that IDEA3 touched no IDEA2 files, services, or configuration.
2. **Honesty Constraint**:
   - Pre-existing degradation (such as the tunnel connection refusal) must remain explicitly and honestly visible in evidence logs.
   - The stage **MUST FAIL** if IDEA3 causes any measurable new degradation or service disruption to IDEA2.
3. **Authority**:
   - This remains a **PROPOSAL ONLY** until formally approved by Pub (`pubpup2006p-design`) and Kla (`kraveerachat`).

---

## 7. Network Addressing Authority

To eliminate ambiguity and prevent configuration conflicts across stages:
- **Forbidden**: Hardcoding `192.168.40.1`, `192.168.40.0/24`, or any historical VLAN40 addresses as the Phase 4 AP deployment values.
- **Canonical Authority**:
  - `OV-03 = owner-supplied AP subnet and Core AP address`.
  - Live deployment configurations must strictly consume the authoritative owner value provided during live staging.
  - Historical VLAN40 documentation is preserved strictly as architectural context and carries no deployment authority.

---

## 8. PR11 MVP Exit Criteria

The condition `PR11_MVP_COMPLETE = YES` defines the state of **readiness for PR12 final attack acceptance**. PR11 itself is not required to execute the final physical attack demonstration.

### PR11 Exit Checklist:
```text
WEB_LIVE                                = YES
CORE_LIVE                               = YES
IDEA1_MVP_VISIBILITY                    = LIVE_PROVEN
IDEA2_MVP_VISIBILITY                    = LIVE_PROVEN
DETECTION_PIPELINE                      = READY
INCIDENT_LOGGING                        = READY
SOFTWARE_BLOCK_IP                       = IMPLEMENTED_AND_HOST_VERIFIED
SOFTWARE_UNBLOCK                        = IMPLEMENTED_AND_HOST_VERIFIED
ESP32_CONNECTED                         = YES
ESP32_AUTHENTICATED_STATUS_HEARTBEAT    = PASS
HARDWARE_CUT_PATH                       = READY_FOR_PR12
RECOVERY_PATH                           = READY_FOR_PR12
```

When all twelve criteria are met and substantiated with cryptographic or host evidence receipts, PR11 will be closed.

---

## 9. PR12 Final System Acceptance Scenarios

PR12 is preserved as the **FINAL SYSTEM ACCEPTANCE** phase. Final acceptance is achieved when seven live scenarios (A1 through A7) pass under controlled, authorized conditions against project-owned equipment.

### Scenario A1: Normal Baseline
- **Execution**: System operates under nominal conditions for a designated observation window.
- **Pass Criteria**:
  - IDEA3 Web and Core services are healthy and communicating.
  - IDEA1 status is visible (`ONLINE` or honest state).
  - IDEA2 status is visible (`ONLINE` or honest state).
  - ESP32 maintains authenticated TLS + HMAC-SHA256 heartbeat exchange.
  - Relay is in NORMAL state; protected Ethernet path passes traffic without disruption.

### Scenario A2: Recon / Scan Detection
- **Execution**: Execute a controlled, authorized vulnerability or network probe from a test client.
- **Pass Criteria**:
  - Attack detection engine detects the probe event.
  - Offending source IP is correctly parsed and extracted.
  - Event type and precise timestamp are determined.
  - Incident record is created and displayed in IDEA3 Web and system audit logs.

### Scenario A3: Software Containment & Recovery
- **Execution**: Trigger an event classified as severity `HIGH`.
- **Pass Criteria**:
  - Orchestrator triggers dynamic software containment against the offending source IP.
  - Host firewall rule (nftables) is injected and verified active.
  - Offending IP traffic is blocked at the host boundary.
  - Containment action is recorded in audit logs with timestamp and rule ID.
  - Administrator issues an authorized UNBLOCK command.
  - Firewall rule is cleanly removed, connectivity restored, and unblock audit recorded.

### Scenario A4: Critical Physical Containment
- **Execution**: Trigger a controlled security incident classified as severity `CRITICAL`.
- **Pass Criteria**:
  - System reaches an automated containment decision.
  - Core formats and transmits an authenticated Protocol v1 `CUT` command over TLS MQTT.
  - ESP32 verifies HMAC-SHA256 signature, replay window, and timestamp freshness.
  - Relay hardware actuates (GPIO27 LOW, de-energizing or opening the circuit).
  - Physical Ethernet continuity is severed; link drops on protected segment.
  - State change is logged across Core, Web, and audit records.

### Scenario A5: Physical Recovery & Restoration
- **Execution**: Administrator executes the physical recovery procedure via authenticated local CLI / approved local recovery path.
- **Pass Criteria**:
  - Recovery authorization credentials validate successfully.
  - Authenticated Protocol v1 `RESTORE` command is accepted by ESP32.
  - Relay returns to NORMAL state (GPIO27 HIGH, restoring Ethernet continuity).
  - Network link renegotiates; end-to-end IP communication resumes.
  - Full recovery event and actor identity are recorded in the audit trail.

### Scenario A6: Cross-IDEA Visibility
- **Execution**: Cross-module visibility verification during normal and incident states.
- **Pass Criteria**:
  - IDEA1 health and security telemetry reflect accurately in IDEA3.
  - IDEA2 anomaly telemetry reflects accurately in IDEA3.
  - Incident state and containment actions are visible without cross-module service disruption.

### Scenario A7: Final Evidence Package
- **Execution**: Compilation and verification of all deliverable artifacts.
- **Pass Criteria**:
  - Unbroken timestamped logs collected from Core, Web, ESP32, and HUB.
  - Clean photographic / video evidence of physical relay cut and restoration.
  - Complete verification matrix signed off by functional owners.
  - Immutable Obsidian task receipts generated and committed to the vault.
  - Report baseline frozen for academic grading.

---

## 10. Existing PR #147 Integration Relationship

- **Scope Definition**: PR #147 (`feat/idea3-pr11-phase3-restore-backup-support`) contains supporting backup, restore, and snapshot tooling.
- **Governance**:
  - PR #147 is classified as `MVP_SUPPORTING`.
  - PR #147 does **NOT** define the overall scope of PR12 Final Acceptance.
  - PR #147 must **NOT** be modified, rebased, or force-pushed in this task.
  - When the reconciliation window for PR #147 arrives, it will incorporate updates via `git fetch origin && git merge origin/main`.
  - Comprehensive Disaster Recovery certification remains `DEFER_FUTURE_WORK`.

---

## 11. Canonical Truth Record & State Metadata

```text
PR178_MERGED                           = YES
PR11_MVP_SCOPE                         = SECURITY_ORCHESTRATOR_PHYSICAL_CONTAINMENT
SCOPE_FREEZE_OWNER_APPROVED            = YES

PR11_MVP_COMPLETE                      = NO
PR12_FINAL_ACCEPTANCE                  = OPEN

SOFTWARE_IP_BLOCKING                   = OPEN_NEEDS_IMPLEMENTATION
SOFTWARE_IP_UNBLOCK                    = OPEN_NEEDS_IMPLEMENTATION

IDEA1_LIVE_MVP_INTEGRATION             = OPEN
IDEA2_LIVE_MVP_INTEGRATION             = OPEN

IDEA2_NARROWED_PRESERVATION            = OWNER_DECISION_PENDING

POST_PRODUCTION_HARDENING              = DEFER_FUTURE_WORK
PRODUCTION_MUTATION                    = NO
LIVE_STAGE_EXECUTED                    = NO
```
