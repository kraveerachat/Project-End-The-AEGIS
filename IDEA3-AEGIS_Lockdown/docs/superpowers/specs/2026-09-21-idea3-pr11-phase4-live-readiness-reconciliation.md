# IDEA3 PR11 Phase 4 — Live Readiness / Blocker Reconciliation

Date: 2026-09-21
Owner: Music (Kla reviewing)
Task: AEGIS IDEA3 — PR11 Phase 4 Live Readiness / Blocker Reconciliation
Branch: `docs/idea3-pr11-phase4-live-readiness`
Expected Base: `3662faa38433877bbcec82b7743d61ecfa399986` (Merge PR #167)
Current HEAD: `3662faa38433877bbcec82b7743d61ecfa399986`
Mode: REPOSITORY-ONLY — NO LIVE EXECUTION
Production Mutation: STRICTLY FORBIDDEN / NONE OBSERVED

> [!IMPORTANT]
> **Repository reconciliation only.** This document establishes the exact current
> Phase 4 live-readiness truth after PR #167 merged on `origin/main`. It executes
> no stage, modifies no host service, generates no credentials, accesses no live
> Core or broker, actuates no relay, and contacts no live package manager.
> `PHASE4_RUNTIME_COMPLETE = NO` and `PHASE4_LIVE_READINESS = NOT READY`.

---

## 1. Executive Summary & Core Answers

### 1.1 Which repository prerequisites are fully closed?
1. **L1..L9 Stage Handlers Registered**: All 9 Phase 4 stage handlers (`L1`, `L2`,
   `L3`, `L4`, `L5`, `L6a`, `L6b`, `L7`, `L8`, `L9`) are implemented, reviewed,
   merged on `origin/main`, and registered. `p4_stage_handler_status` reports
   `REGISTERED` for every stage.
2. **Phase 4 Harness Framework**: G-15 capture (`p4-l0-capture.sh`), compare
   (`p4-compare.sh`), stage gating (`p4-stage-gate.sh`), shared constants
   (`p4-lib.sh`), and the synthetic unregistered-handler guard test fixture
   (`AEGIS_P4_HANDLER_DIR`) are merged and tested.
3. **Phase 2 Runtime Dependency**: `PHASE2_RUNTIME_COMPLETE = YES` (closed in PR #148;
   T3 wrong-CA and T4 revoked-certificate gates passed on live owner evidence).
4. **Phase 3 Repository Preparation**: Merged via PR #149 (`42b13625`); systemd 261
   compatibility correction, `LoadCredential=` config for `k_c2d`, `k_d2c`,
   `mqtt-core.pass`, `admin.pin`, and `systemd_credentials.py` are complete.
5. **D4 Core-Local RESTORE Repository Implementation**: Merged via PR #138 (`3fd8d4d1`);
   CLI, cryptographic format verification, audit fail-closed logic, and test suite
   are complete (`D4_REPOSITORY_IMPLEMENTATION = COMPLETE`, `D4_LOCAL_VERIFICATION = PASS`).
6. **Repository Verification Suite**: Full IDEA3 `pytest` suite passes with
   **1705 passed, 6 skipped** (including 725 Phase 4 tests). Shell scripts pass `bash -n`.

### 1.2 Which live prerequisites remain open?
1. **Phase 3 Live Runtime Completion**: `PHASE3_RUNTIME_COMPLETE = NO`. PR #149 was
   repository preparation only; Core service is not installed or started, secrets
   in `/etc/aegis-idea3/credentials/` are not provisioned, and live G12/G13 delivery
   is unproven.
2. **Phase 4 Live Execution**: `L0` through `L9` have **NOT RUN** on any live host.
   `L1..L9 live = NOT RUN`. All handlers are implemented against a fixture backend;
   selecting live mode fails closed.
3. **Stage Authorizations**: Every live stage requires an explicit same-day
   authorization record (`AEGIS_P4_AUTHORIZATION_V1`). Currently, A-L0 through A-L9
   are **NOT AUTHORIZED**.
4. **Fresh K3 Confirmation**: Every mutating stage requires a fresh, same-day,
   window-specific non-overlap confirmation (`AEGIS_P4_K3_CONFIRMATION_V1`) from Kla
   (`kraveerachat`). Currently, no active K3 confirmation exists.
5. **D4 Live Verification**: `D4_LIVE_VERIFIED = NO`. Core-local RESTORE has never
   been executed or verified on a live host.
6. **Physical ESP32 Availability & Connection**: Physical presence, USB serial connection
   (`/dev/ttyUSB0` or similar), and power status on Core host are unverified for Phase 4.
7. **Post-Phase-4 Operational Gates**: Plaintext 1883 retirement, CUT/RESTORE physical
   relay actuation, CRL automated renewal scheduling, resource quotas, and K12 reboot
   persistence are post-Phase-4 gates and remain open.

### 1.3 Which evidence is stale and requires fresh owner-run proof?
1. **Host Disk Headroom**: Prior owner evidence (2026-09-17) recorded 53G/59G used (~94%
   usage, 3.8G free); L1 design noted ~97% usage. Under OD-L1-07, L1 requires >= 5% free
   headroom. Current live headroom is classified as `STALE_NEEDS_FRESH_PROOF`
   (`NEEDS_FRESH_L0_OR_OWNER_READ_ONLY_PROOF`). Old readings cannot be called current.
2. **IDEA2 §10 Preservation**: Last proven evidence (2026-09-17) recorded
   `PROCESS_ACTIVE != TUNNEL_HEALTHY != IDEA2_RUNTIME_HEALTHY` (`aegis-detection-tunnel.service`
   flapping with NRestarts > 1450; Detection Engine heartbeat failing).
   `IDEA2_S10_PRESERVATION = BLOCKED_BY_LAST_PROVEN_EVIDENCE`. Actual current live state
   is unmeasured and classified as `NEEDS_FRESH_OWNER_RUN_EVIDENCE`.
3. **Host Baseline Configuration**: Network interfaces (`enp62s0`), routing, iptables/nftables
   ruleset, and listening sockets (1883 active, 8883 absent) were characterized on 2026-09-17.
   Requires a fresh read-only L0 baseline capture before any mutation.
4. **K12 Reboot Persistence**: Unproven since PR10 (`K12 = NOT_PROVEN`).

### 1.4 Which items require explicit owner/integration decisions?
1. **FIND-L9-01 Disposition**: `firmware/src/main.cpp` implements heartbeat replay
   via a 20-slot `msg_id` ring, while Protocol v1 design §6.1 specifies strictly
   increasing `issued_at`. Classified as `OWNER_DECISION_REQUIRED`. The owner must
   decide whether to amend firmware (requiring an L8 rebuild/reflash) or accept the
   20-slot ring in design.
2. **Disk Headroom Remediation**: Owner decision and action to clean up host disk space
   to guarantee >= 5% free headroom before Stage L1.
3. **Owner-Supplied Runtime Values (OV-01..OV-17)**: Real values for AP SSID, PSK,
   AP subnet, Core AP IP, DHCP pool, broker TLS hostname/SAN, ESP32 device ID/MAC,
   serial port path, Mosquitto passwords, admin PIN, HMAC keys `K_C2D`/`K_D2C`,
   `restore.credential`, and trusted upstream NTP server.
4. **Stage Authorizations & Reviews**:
   - A-L0 issuance by Music (read-only);
   - A-L1 issuance by Music with D6 notice to Pub;
   - Fresh K3 confirmation by Kla for L1 window;
   - A-L2 issuance with integration review by Kla;
   - A-L8 issuance with pre-verified recovery authorization.

### 1.5 What exact blockers prevent the first live stage?
- **To run read-only Stage L0**:
  1. A-L0 same-day authorization from Music does not exist (`A-L0 = NOT_AUTHORIZED`).
  2. Owner read-only session initiation on the physical Core host is pending.
- **To run Stage L1 (first mutating stage)**:
  1. Fresh L0 baseline bundle has not been captured and reviewed.
  2. **IDEA2 §10 Preservation Blocker**: Last proven evidence is unhealthy (`IDEA2_S10_PRESERVATION = BLOCKED_BY_LAST_PROVEN_EVIDENCE`).
     If the fresh L0 capture shows the tunnel flapping, `p4-compare.sh` will fail closed
     (`PRESERVATION_S10=FAIL`, `COMPARE_RESULT=FAIL`).
  3. **Disk Headroom Blocker**: Prior evidence shows ~94–97% root disk usage. If free space
     is < 5%, Stage L1 fails closed (`OD-L1-07`).
  4. Same-day A-L1 authorization is missing (`A-L1 = NOT_AUTHORIZED`).
  5. Same-day K3 non-overlap confirmation from Kla is missing (`FRESH_K3_REQUIRED = YES`).
  6. D6 co-residence notice to Pub is missing.
  7. Production mutation authorization is not granted.

### 1.6 What is the correct safe sequence from current state to A-L0 and then A-L1?
```text
REPOSITORY READY
  ↓
BLOCKER RESOLUTION (disk cleanup plan, IDEA2 health investigation, owner value staging)
  ↓
SAME-DAY READ-ONLY PRECHECK (host connectivity, time sync, read-only access)
  ↓
A-L0 AUTHORIZATION (Music issues same-day read-only A-L0)
  ↓
FRESH L0 CAPTURE (owner runs p4-l0-capture.sh -> BEFORE_L0_BUNDLE)
  ↓
REVIEW L0 BUNDLE (verify disk headroom >= 5%, inspect IDEA2 tunnel status & baseline)
  ↓
FRESH K3 CONFIRMATION (Kla verifies no IDEA1 overlap -> issues same-day K3 for L1)
  ↓
A-L1 AUTHORIZATION (Music issues same-day A-L1 with d6_notice=pub, integration_review=kla)
  ↓
LIVE L1 EXECUTION (owner runs p4-stage-gate.sh --stage L1 --mode live --authorization A-L1 --k3 K3)
  ↓
PRESERVATION VERIFICATION (capture AFTER_L1_BUNDLE, run p4-compare.sh BEFORE_L0 AFTER_L1 -> PASS)
  ↓
ONLY THEN CONSIDER L2 (review L1 evidence, verify rollback state, prepare L2 prerequisites)
```

---

## 2. Critical Reconciliation Details

### A. All L1-L9 Handlers
Direct verification against current `origin/main` (`3662faa3`):
```bash
$ bash -c 'cd IDEA3-AEGIS_Lockdown/deploy/pr11-phase4 && source ./p4-lib.sh && for s in L1 L2 L3 L4 L5 L6a L6b L7 L8 L9; do echo "$s: $(p4_stage_handler_status $s)"; done'
L1: REGISTERED
L2: REGISTERED
L3: REGISTERED
L4: REGISTERED
L5: REGISTERED
L6a: REGISTERED
L6b: REGISTERED
L7: REGISTERED
L8: REGISTERED
L9: REGISTERED
```
Every stage handler directory `stages/L1` through `stages/L9` contains valid `apply.sh`,
`verify.sh`, `rollback.sh`, `allow-keys.txt`, and `allow-listeners.txt`.
All stage handlers fail closed if executed with `--mode live` on unapproved backends.

### B. Stale Canonical Status Reconciliation
Canonical `idea3-status.md` contains historical task records written at earlier checkpoints.
These records must be preserved as historical context, but their claims are superseded as follows:
- **PR #166 Merge State**: Section for Stage L9 (line 6044) recorded `PR = #166 (Draft)`
  and `L9_PR_MERGED = NO`.
  *Superseded by*: PR #166 merged into `origin/main` at commit `b4670eb31a30e1e71075c8e6421134e5d9fae8e5`.
- **Historical L1 Handler Status**: Section for Stage L9 (line 6056) recorded
  `L1_HANDLER = NOT REGISTERED`.
  *Superseded by*: PR #167 implemented and registered the Stage L1 handler.
- **PR #167 Merge State**: Section for Stage L1 (line 6222) recorded `PR = #167 (Draft)`.
  *Superseded by*: PR #167 merged into `origin/main` at commit `3662faa38433877bbcec82b7743d61ecfa399986`.
- **Handler Registration Matrix**: Superseded from `L2..L9 REGISTERED` to `L1..L9 REGISTERED`.
- **Test Counts**:
  - Full IDEA3 suite: 1705 passed, 6 skipped.
  - Phase 4 test suite: 725 passed.
  - Phase 4 harness: 161 passed.
  - Stage L1 focused suite: 28 passed.

### C. Phase 3 Reconciled
- `PHASE3_REPOSITORY_PR = MERGED` (PR #149 merged at `42b13625`).
- `PHASE3_RUNTIME_COMPLETE = NO`.
Merging PR #149 prepared the systemd unit and credentials reader in the repository.
It did not install the service, did not start the service, and did not provision secrets
on the live Core host. Live G12/G13 credential delivery remains unproven.

### D. D4 Core-Local RESTORE
- `D4_REPOSITORY_IMPLEMENTATION = COMPLETE` (merged via PR #138).
- `D4_LOCAL_VERIFICATION = PASS` (`test_local_restore.py`).
- `D4_LIVE_VERIFIED = NO`.
Core-local RESTORE has never run live. Web, Telegram, and automatic RESTORE are unavailable.
Under OD-L7-08, a pre-provisioned, cryptographically valid `restore.credential` is required
before Stage L7 can start the Core service. RESTORE actuation is strictly forbidden during Phase 4.

### E. IDEA2 §10 Preservation
- Last authoritative evidence (2026-09-17) proved:
  `PROCESS_ACTIVE != TUNNEL_HEALTHY != IDEA2_RUNTIME_HEALTHY`.
  The tunnel unit was flapping (`NRestarts > 1450`) and Detection Engine heartbeat failed.
- Status: `IDEA2_S10_PRESERVATION = BLOCKED_BY_LAST_PROVEN_EVIDENCE`.
- `LAST_PROVEN = unhealthy/blocking`.
- `CURRENT_LIVE_STATE = NEEDS_FRESH_OWNER_RUN_EVIDENCE`.
- In `p4-compare.sh`, `IDEA2_NARROWED_CRITERION = NOT_ACCEPTED`. A baseline unhealthy tunnel
  yields `PRESERVATION_S10 = FAIL` and `COMPARE_RESULT = FAIL`.
- No agent is authorized to diagnose, repair, touch, or modify IDEA2 files or services.

### F. K3 Non-Overlap Governance
- Script `p4-stage-gate.sh` enforces:
  - Magic header `AEGIS_P4_K3_CONFIRMATION_V1`;
  - Confirmed by `kraveerachat`;
  - Same calendar day in `Asia/Bangkok`;
  - Exact matching stage name;
  - `idea1_window_overlap = NONE`.
- Prior K3 confirmations were single-window and are expired.
- Status: `FRESH_K3_REQUIRED = YES` for every mutating stage (`L1`..`L9`).

### G. Disk Headroom
- `KNOWN_PRIOR_MEASUREMENT`: Root filesystem was ~94–97% used (53G/59G, 3.8G available).
- Requirement: OD-L1-07 requires >= 5% free headroom (usage < 95%) before package installation.
- Current live status: `NEEDS_FRESH_L0_OR_OWNER_READ_ONLY_PROOF`.
- Calling the old reading "current" is forbidden. Live L1 will fail closed if headroom < 5%.

### H. FIND-L9-01 (Firmware Replay Window)
- Description: `firmware/src/main.cpp` `handleHeartbeat` implements a 20-slot `msg_id` ring
  for replay rejection, while Protocol v1 design §6.1 specifies strictly increasing `issued_at`.
- Status: `FIND-L9-01 = OWNER_DECISION_REQUIRED`.
- Effect:
  - If owner decides to update firmware to enforce strictly increasing `issued_at`, this requires
    a firmware build change and re-flash plan, which blocks live Stage L8 and live Stage L9.
  - If owner decides to accept the 20-slot `msg_id` ring as equivalent, firmware remains untouched,
    and the issue blocks only final L9 acceptance reconciliation.
  - Repository authority does not decide this; the decision is reserved for the functional owner.

### I. Live Authorization Matrix
Every stage requires a dedicated same-day authorization record (`AEGIS_P4_AUTHORIZATION_V1`)
issued by `music` with exact matching stage and valid reference.
- Stage L0: Read-only preflight. Does NOT require K3.
- Stage L1: Mutating. Requires fresh K3 + `d6_notice=pub`.
- Stage L2: Mutating. Requires fresh K3 + `integration_review=kla`.
- Stages L3–L6b: Mutating. Require fresh K3.
- Stage L7: Mutating. Requires fresh K3 + `d6_notice=pub`.
- Stage L8: Mutating. Requires fresh K3 + `recovery_authorization=<valid-ref>`.
- Stage L9: Mutating. Requires fresh K3.
- Current status: **ALL STAGES (A-L0..A-L9) = NOT AUTHORIZED**.

---

## 3. Durable Phase 4 Readiness Matrix

| Item | Category | Current State | Last Proven Evidence | Evidence Date / Commit | Fresh Proof Required | Owner | Blocks Which Stage | Next Safe Action |
|---|---|---|---|---|---|---|---|---|
| **L1 Handler** | Repository Implementation | `CLOSED_REPOSITORY` | `p4_stage_handler_status L1` = `REGISTERED`; 28 passed in focused suite | 2026-09-21 (`3662faa3`, PR #167) | NO | music | None | Handler closed |
| **L2 Handler** | Repository Implementation | `CLOSED_REPOSITORY` | `p4_stage_handler_status L2` = `REGISTERED` | 2026-09-20 (PR #159) | NO | music | None | Handler closed |
| **L3 Handler** | Repository Implementation | `CLOSED_REPOSITORY` | `p4_stage_handler_status L3` = `REGISTERED` | 2026-09-20 (PR #160) | NO | music | None | Handler closed |
| **L4 Handler** | Repository Implementation | `CLOSED_REPOSITORY` | `p4_stage_handler_status L4` = `REGISTERED` | 2026-09-20 (PR #161) | NO | music | None | Handler closed |
| **L5 Handler** | Repository Implementation | `CLOSED_REPOSITORY` | `p4_stage_handler_status L5` = `REGISTERED` | 2026-09-20 (PR #162) | NO | music | None | Handler closed |
| **L6a Handler** | Repository Implementation | `CLOSED_REPOSITORY` | `p4_stage_handler_status L6a` = `REGISTERED` | 2026-09-20 (PR #163) | NO | music | None | Handler closed |
| **L6b Handler** | Repository Implementation | `CLOSED_REPOSITORY` | `p4_stage_handler_status L6b` = `REGISTERED` | 2026-09-20 (PR #164) | NO | music | None | Handler closed |
| **L7 Handler** | Repository Implementation | `CLOSED_REPOSITORY` | `p4_stage_handler_status L7` = `REGISTERED` | 2026-09-21 (PR #165) | NO | music | None | Handler closed |
| **L8 Handler** | Repository Implementation | `CLOSED_REPOSITORY` | `p4_stage_handler_status L8` = `REGISTERED` | 2026-09-21 (`b4670eb3`, PR #166) | NO | music | None | Handler closed |
| **L9 Handler** | Repository Implementation | `CLOSED_REPOSITORY` | `p4_stage_handler_status L9` = `REGISTERED`; 154 passed in focused suite | 2026-09-21 (`b4670eb3`, PR #166) | NO | music | None | Handler closed |
| **Phase 2 Runtime** | Runtime Prerequisite | `CLOSED_REPOSITORY` | `PHASE2_RUNTIME_COMPLETE = YES`; T3/T4 live pass | 2026-09-17 (PR #148) | NO | music | None | Preserve Phase 2 PKI & CRL |
| **Phase 3 Repo PR** | Repository Implementation | `CLOSED_REPOSITORY` | PR #149 merged (`42b13625`); systemd 261 & credentials support | 2026-09-18 (PR #149) | NO | music | None | Code merged on main |
| **Phase 3 Live Runtime** | Runtime Prerequisite | `OPEN` | `PHASE3_RUNTIME_COMPLETE = NO`; Core service uninstalled; G12/G13 unproven | 2026-09-18 (PR #149) | YES | music | Post-L7 / Phase 3 closeout | Handled via Stage L7 execution |
| **D4 Repo Implementation** | Recovery Architecture | `CLOSED_REPOSITORY` | PR #138 merged (`3fd8d4d1`); D4 CLI implemented | 2026-09-16 (PR #138) | NO | music | None | Code merged on main |
| **D4 Local Verification** | Verification | `CLOSED_REPOSITORY` | `test_local_restore.py` PASS; audit fail-closed verified | 2026-09-16 (PR #138) | NO | music | None | Maintained in pytest |
| **D4 Live Verification** | Recovery Architecture | `MERGED_BUT_LIVE_UNPROVEN` | `D4_LIVE_VERIFIED = NO`; never executed live | 2026-09-16 (PR #138) | YES | music | Post-Phase-4 recovery gate | Await post-deployment verification |
| **K3 Non-Overlap** | Governance / Safety | `OPEN` | Prior K3 confirmations expired | 2026-09-17 | YES | kla | Live L1..L9 (all mutating stages) | Kla issues same-day K3 for each window |
| **IDEA2 §10 Preservation** | Cross-IDEA Safety | `BLOCKED` | `IDEA2_TUNNEL_HEALTHY = NO` (NRestarts > 1450); `COMPARE_RESULT=FAIL` | 2026-09-17 (PR #152) | YES | pub | Live L1..L9 compare gate | Fresh owner evidence / IDEA2 repair |
| **Disk Headroom** | Host Resource | `STALE_NEEDS_FRESH_PROOF` | ~94–97% root filesystem usage (53G/59G used); L1 requires >= 5% free | 2026-09-17 / 2026-09-21 | YES | music / kla | Live L1 (fails closed if < 5%) | Fresh L0 capture; host cleanup |
| **Phase 4 Owner Values** | Configuration / Secrets | `OWNER_DECISION_REQUIRED` | Templates contain `<AEGIS_...>` placeholders | 2026-09-17 (Spec) | YES | music / kla | Live L2..L8 | Owner generates values out-of-band |
| **A-L0 Authorization** | Authorization | `NOT_AUTHORIZED` | No A-L0 record exists | Current (2026-09-21) | YES | music | Live L0 capture | Music issues same-day A-L0 |
| **A-L1..A-L9 Auth** | Authorization | `NOT_AUTHORIZED` | No A-L1..A-L9 records exist | Current (2026-09-21) | YES | music | Live L1..L9 | Issue separately on execution day |
| **Live L0 Baseline** | Live Baseline | `OPEN` | `p4-l0-capture.sh` tested in harness; never run live | Current (2026-09-21) | YES | music | Live L1 | Run after A-L0 is issued |
| **Live L1..L9 Execution** | Live Execution | `BLOCKED` | `L1..L9 live = NOT RUN`; live backend fails closed | Current (2026-09-21) | YES | music | Phase 4 live closeout | Sequential execution after gates pass |
| **FIND-L9-01** | Protocol / Firmware | `OWNER_DECISION_REQUIRED` | Firmware 20-slot ring vs strictly increasing `issued_at` in §6.1 | 2026-09-21 (PR #166) | NO | music | Live L8/L9 or L9 acceptance | Owner decides firmware fix vs design accept |
| **ESP32 Hardware Proof** | Physical Hardware | `OPEN` | Lab fail-secure proven (PR5); live serial connection unproven | 2026-09-11 (PR5) | YES | music | Live L8, L9 | Owner confirms serial & power on Core |
| **L8 Recovery Requirement** | Recovery Architecture | `OWNER_DECISION_REQUIRED` | Recovery auth required in A-L8; backup binary needed | 2026-09-21 (PR #166) | YES | music | Live L8 | Prepare backup image & physical jumper |
| **K12 Reboot Persistence** | Host Persistence | `MERGED_BUT_LIVE_UNPROVEN` | `K12 = NOT_PROVEN` throughout PR10/P1/P2/P3 | 2026-09-12 | YES | kla / music | Post-Phase-4 acceptance gate | Scheduled after full live deployment |
| **Plaintext 1883 Removal** | Broker Hardening | `NOT_APPLICABLE_YET` | Plaintext 1883 intentionally retained in Phase 4 | 2026-09-19 (PR #159) | NO | music / kla | Post-Phase-4 gate | Strictly forbidden in Phase 4 |
| **CUT Actuation** | Physical Safety | `NOT_APPLICABLE_YET` | Lab proven in PR5; forbidden in Phase 4 | 2026-09-11 (PR5) | YES | music | Post-Phase-4 live gate | Strictly forbidden in Phase 4 |
| **RESTORE Actuation** | Physical Safety | `NOT_APPLICABLE_YET` | Local proven in PR #138; forbidden in Phase 4 | 2026-09-16 (PR #138) | YES | music | Post-Phase-4 live gate | Strictly forbidden in Phase 4 |
| **CRL Renewal Scheduling** | PKI Lifecycle | `OPEN` | CRL generation proven; automated timer absent | 2026-09-17 (PR #148) | YES | music / kla | Post-Phase-4 operational gate | Deploy systemd timer post-deployment |
| **Resource Quotas** | Service Quotas | `OPEN` | Quotas unconfigured (`QUOTAS = none`) | 2026-09-18 (PR #149) | YES | music | Post-Phase-4 operational gate | Characterize under load; add limits |

---

## 4. Safe Execution Order (Future Runbook — DO NOT EXECUTE)

> [!WARNING]
> This runbook is a reference execution specification only.
> **DO NOT EXECUTE.**
> Each step is conditionally gated on the successful, verified completion of all prior steps.

```mermaid
flowchart TD
    subgraph RepoReady["1. Repository Readiness"]
        RR1["All L1..L9 Handlers REGISTERED on origin/main"]
        RR2["Pytest 1705 Passed, Bash -n PASS"]
        RR3["Reconciliation Spec & Status Merged"]
        RR1 --> RR2 --> RR3
    end

    subgraph BlockerRes["2. Blocker Resolution"]
        BR1["Inspect Disk Headroom: Clean if Free < 5%"]
        BR2["IDEA2 Tunnel Investigation: Restore Health or Agreed Criterion"]
        BR3["Owner Values: Stage OV-01..OV-17 Out-of-Band"]
        BR4["FIND-L9-01 Owner Decision Recorded"]
        BR1 --> BR2 --> BR3 --> BR4
    end

    subgraph PrecheckL0["3. Read-Only Precheck & L0"]
        P1["Verify Host Connectivity & Time Sync"]
        P2["Music Issues Same-Day A-L0 (Read-Only)"]
        P3["Run p4-l0-capture.sh -> BEFORE_L0_BUNDLE"]
        P4["Review L0: Confirm Headroom >= 5% & §10 Baseline"]
        P1 --> P2 --> P3 --> P4
    end

    subgraph GateL1["4. Stage L1 Execution"]
        GL1["Kla Issues Same-Day K3 (idea1_window_overlap=NONE)"]
        GL2["Music Issues Same-Day A-L1 (d6_notice=pub)"]
        GL3["Execute p4-stage-gate.sh --stage L1 --mode live"]
        GL4["Capture AFTER_L1_BUNDLE"]
        GL5["Run p4-compare.sh BEFORE_L0 AFTER_L1 -> PASS"]
        GL1 --> GL2 --> GL3 --> GL4 --> GL5
    end

    subgraph NextStages["5. Subsequent Staged Progression"]
        S2["Consider L2 (Broker TLS Isolation)"]
        S3["Progress sequentially L3 -> L4 -> L5 -> L6a -> L6b -> L7"]
        S4["L8 Provision/Flash (Requires Hardware Proof & Recovery Auth)"]
        S5["L9 Auth Without Actuation (No COMMAND/CUT/RESTORE)"]
        S2 --> S3 --> S4 --> S5
    end

    subgraph PostP4["6. Post-Phase-4 Separate Gates (NOT Phase 4)"]
        PP1["Plaintext 1883 Retirement"]
        PP2["D4 Live RESTORE & CUT Actuation Validation"]
        PP3["K12 Reboot Persistence Check"]
        PP4["Automated CRL Timer & Resource Quotas"]
        PP1 --- PP2 --- PP3 --- PP4
    end

    RepoReady --> BlockerRes --> PrecheckL0 --> GateL1 --> NextStages --> PostP4
```

### Step 1: Repository Readiness (CURRENT STATE — CLOSED)
- `L1..L9` stage handlers verified registered on `origin/main` (`3662faa3`).
- 1705 IDEA3 tests pass (including 725 Phase 4 tests).
- Reconciliation documented and PR opened.

### Step 2: Blocker Resolution (Human Owner Action Required)
1. **Disk Headroom**: Owner inspects host root partition. If free space is < 5%, perform
   package cache cleaning or unneeded file removal until free space >= 5%.
2. **IDEA2 §10 Health**: IDEA2 owner (Pub) investigates `aegis-detection-tunnel.service`
   flapping and Detection Engine heartbeat failure. Tunnel must be healthy OR a written,
   IDEA2-owner-accepted criterion must be established.
3. **Owner Values Staged**: Music prepares stage input files (`ov-*.txt`) containing real
   SSID, PSK, subnets, passwords, and keys, storing them locally with `chmod 0600`.
4. **FIND-L9-01 Decision**: Music records decision regarding whether firmware is to be updated
   before L8 or the 20-slot ring is accepted in design.

### Step 3: Same-Day Read-Only Precheck & L0 Capture
1. **Time & Connectivity**: Confirm Core host is reachable and time synchronization is healthy.
2. **Issue A-L0**: Music generates same-day `AEGIS_P4_AUTHORIZATION_V1` record:
   ```text
   AEGIS_P4_AUTHORIZATION_V1
   stage=L0
   date=YYYY-MM-DD
   authorizer=music
   scope=read-only baseline preflight capture
   reference=PR11-L0-PREFLIGHT
   ```
3. **Execute L0**: Owner runs:
   ```bash
   bash deploy/pr11-phase4/p4-l0-capture.sh /var/tmp/p4-evidence/before-L0
   ```
4. **Review L0**:
   - Inspect `disk.usage_percent` (must be < 95%).
   - Inspect `idea2.tunnel.active_state` and restart counts.
   - Inspect network listeners (1883 active, 8883 absent).
   - If disk usage >= 95% or §10 check fails, **STOP IMMEDIATELY**.

### Step 4: Fresh K3 & Stage L1 Execution
1. **Issue Fresh K3**: Kla verifies no overlapping IDEA1 production mutation and issues:
   ```text
   AEGIS_P4_K3_CONFIRMATION_V1
   stage=L1
   date=YYYY-MM-DD
   confirmed_by=kraveerachat
   idea1_window_overlap=NONE
   reference=K3-PHASE4-L1
   ```
2. **Issue A-L1**: Music issues same-day authorization:
   ```text
   AEGIS_P4_AUTHORIZATION_V1
   stage=L1
   date=YYYY-MM-DD
   authorizer=music
   scope=package installation chrony
   reference=PR11-L1-CHRONY
   d6_notice=pub
   integration_review=kla
   ```
3. **Execute L1**: Owner runs:
   ```bash
   bash deploy/pr11-phase4/p4-stage-gate.sh --stage L1 --mode live --authorization /path/to/A-L1.txt --k3 /path/to/K3-L1.txt
   ```
4. **Capture & Compare**:
   ```bash
   bash deploy/pr11-phase4/p4-l0-capture.sh /var/tmp/p4-evidence/after-L1
   bash deploy/pr11-phase4/p4-compare.sh /var/tmp/p4-evidence/before-L0 /var/tmp/p4-evidence/after-L1
   ```
   Verify `COMPARE_RESULT=PASS`. Confirm chrony is installed, disabled, inactive, and 0 listeners added.

### Step 5: Sequential Staged Progression (L2 through L9)
Each subsequent stage follows the identical discipline:
- Never pre-authorize;
- Require new same-day authorization from Music;
- Require new same-day K3 from Kla (`idea1_window_overlap=NONE`);
- Run stage gate;
- Capture post-stage bundle and run `p4-compare.sh` against the immediate prior bundle;
- Verify preservation and specific stage success.

**Specific Stage Requirements**:
- **Stage L2 (Broker TLS Isolation)**: Requires `integration_review=kla`. Retains 1883.
- **Stage L3 (AP Radio Enablement)**: Configures NetworkManager Wi-Fi AP.
- **Stage L4 (AP Addressing & DHCP)**: Binds IPv4 and dnsmasq DHCP to AP interface only.
- **Stage L5 (Core-Local NTP)**: Activates chrony bound to AP subnet; verifies time sync.
- **Stage L6a (Isolated PKI Validation)**: Tests broker cert/key against isolated broker before touching host broker.
- **Stage L6b (Broker TLS Activation)**: Enables `listener 8883` on host Mosquitto; verifies coexistence with 1883.
- **Stage L7 (Core Service Startup)**: Requires `d6_notice=pub`. Provisions credentials via `LoadCredential=`, starts `aegis-idea3-core.service`. Requires valid `restore.credential` (OD-L7-08).
- **Stage L8 (ESP32 Flash)**: Requires physical device serial connection (`/dev/ttyUSB0`), power check, and explicit `recovery_authorization=<valid-ref>` with backup binary.
- **Stage L9 (Authentication Without Actuation)**: Requires running Core and ESP32. Proves HMAC-SHA256 authenticated STATUS and HEARTBEAT frames. **Strictly forbids COMMAND, CUT, or RESTORE**. Resolves FIND-L9-01 disposition.

### Step 6: Post-Phase-4 Operational Gates (Separate From Phase 4)
The following are **NOT** Phase 4 stages and must never be conflated with Phase 4:
- **L10**: Does NOT exist. Phase 4 terminates at L9.
- **Plaintext 1883 Retirement**: Separate migration task after all subscribers use TLS.
- **Live CUT Actuation**: Separate emergency cut-down authorization.
- **Live RESTORE Actuation**: Separate recovery authorization (D4 live verification).
- **K12 Reboot Persistence**: Separate planned host reboot and post-boot verification.
- **Automated CRL Renewal**: Separate operational timer deployment.
- **Resource Quotas**: Characterize under load and add cgroup limits.
