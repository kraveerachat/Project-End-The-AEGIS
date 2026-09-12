---
title: IDEA3 AEGIS Lockdown
aliases: ["04 - 🔒 IDEA3 AEGIS Lockdown"]
tags: [aegis, lockdown, hardware, esp32, mqtt, firmware]
type: module-doc
created: 2026-07-20
updated: 2026-09-12
owner: music
edit_policy: owner-writable
---

# 🔒 IDEA3: AEGIS Lockdown

> [!warning] Ownership and evidence boundary
> Owner: **Music**. The Security Center and Headless Core from PR #91 are on shared `main`. Project-sequence PR5 was merged through GitHub PR #117 at `58f19f2051170685757627a6baea90b264a877c4`; its owner-observed lab evidence covers the external fail-secure circuit, powered EN/reset behavior, and Router/Switch real-Ethernet CUT/RESTORE within the stated boundaries. PR9 passed its post-PR5 S7 verification at `e5863fc664e239b78f37dd4ce663bc1186f22744`, S8 recorded its one receipt, and GitHub PR #115 was merged by a human reviewer at `2c21cc3e5843bcd75eb1dd2b7f607a745cce254d`. PR9 `PRODUCTION_LIKE_VERIFIED` is local loopback/dry-run evidence only; `PRODUCTION_DEPLOYED = NO`. PR10 is IN PROGRESS. Its S1 documentation (the read-only real deployment inventory and architecture gate) reached `main` when a human reviewer merged GitHub PR #120 at `93170862cbf5b5a802042d12c84944abd39d9123` before PR10 was complete. That merge is a documentation checkpoint only. The owner accepted the PR10 architecture decisions D1–D8 on 2026-09-12, and the read-only live AEGIS Server inventory passed the same day (`LIVE_SERVER_INVENTORY = PASS`). The IDEA3 owner reported Kla's integration approval of the K1–K12 package for the D3/D5 shared infrastructure on 2026-09-12 (architecture/integration only), so **PR10 S1 is PASS / CLOSED**. PR10 remains IN PROGRESS. A human reviewer merged GitHub PR #122 at `b2f61ebf361a5e22f00d28e7e99dcbf3ce006d95`; it is the immutable S1 closeout. The owner approved the continuation model on 2026-09-12. PR10 S2 — the repository-only, non-Production Server → Core accepted-action boundary — is now IN PROGRESS on `feat/idea3-pr10-s2-server-core-boundary`. No Production change is authorized, and nothing is deployed. Read "PR10 pre-flight evidence reconciliation — 2026-09-11" and the PR10 Current Task below first. Total-control-power-loss behavior, deployment-grade mechanical hardening, final relay-cycle Twingate auto-recovery, live adapters, and production deployment remain open. ACK and protocol-correlated STATUS must never be promoted to direct electrical relay proof.

> **Primary Function**: Automatic disconnection and physical lockdown system triggered upon critical threats (Physical Emergency Lockdown System). Commands ESP32 microcontrollers via secure MQTT + HMAC-SHA256 protocol.

---

## PR10 pre-flight evidence reconciliation — 2026-09-11

> [!important] Current IDEA3 truth — read this section first
> Documentation-only audit on `docs/idea3-pr10-preflight-evidence-reconciliation`
> from `origin/main` `9ea9bbfcf40128f4565bc4ba37ba008a62c4879c`. Every fact here
> was re-checked against Git ancestry, GitHub PR metadata, current source, and
> the immutable receipts. No hardware was re-run and no Production system was
> touched. Later sections of this note remain as dated history.

### Verified Git and GitHub state

```text
CURRENT_MAIN = 9ea9bbfcf40128f4565bc4ba37ba008a62c4879c (merge of GitHub PR #116, IDEA1)
PR9 = GitHub PR #115 MERGED 2026-09-10T21:41:47Z (human merge)
PR9_MERGE_COMMIT = 2c21cc3e5843bcd75eb1dd2b7f607a745cce254d (parents 58f19f20 + 09b91528)
PR9_FINAL_HEAD = 09b9152882da4e7068fb883a4b25372953f2c8bc
PR9_FINAL_EVIDENCE_CHECKPOINT = e5863fc664e239b78f37dd4ce663bc1186f22744 (ancestor of main)
PR5 = GitHub PR #117 MERGED 2026-09-10T19:54:01Z at 58f19f2051170685757627a6baea90b264a877c4
OPEN_IDEA3_GITHUB_PRS_BEFORE_THIS_TASK = NONE
PRODUCTION_LIKE_VERIFIED = YES (PR9; local loopback, lab/headless/dry-run only)
PRODUCTION_DEPLOYED = NO
IDEA3_PRODUCTION_COMPLETE = NO
```

### Evidence truth model — preserved

```text
Requested != Published
Published != ACK
ACK != Executed
Executed != Relay Confirmation
Relay Confirmation != Physical Evidence
```

ACK proves only a nonce-correlated device reply. Command-triggered STATUS with a
matching `command_nonce` is device-reported state, not electrical measurement.
Cable-tester continuity is not traffic proof. An MQTT connection is not ESP32
online evidence. Telegram delivery is none of these. Web containment acceptance
stops at `Containment Accepted` with every command/ACK/execution/physical field
`false`.

### Project-sequence PR1–PR9 evidence matrix

The repository explicitly labels PR4–PR9. It does **not** label PR1–PR3; the
mapping below follows the owner's task sequence. By merge date, the 11-page
Security Center (GitHub #62, 2026-09-03) predates the Dashboard (#85) and
Overview (#87) deliveries (both 2026-09-06). Counts are the results recorded at
each task's own checkpoint and are not re-run here.

| Project PR | Scope | GitHub PR → merge commit | Receipt | Recorded evidence | State | Limitations kept |
|---|---|---|---|---|---|---|
| PR1 | Dashboard Mission Control + Thai/English/Chinese UI | #85 → `73daa3e5` | `2026-09-06_032258_music_idea3-dashboard-trilingual-consolidation.md` (`partial` at its checkpoint) | Web 98/98 (15 files); affected 50/50; Vite 1,677 modules; browser QA at 4 presets | CLOSED / MERGED | language selector scoped to Dashboard and shell; monitoring only |
| PR2 | Architecture-first Overview UI Pass 01 | #87 → `2e33595a` | `2026-09-06_034354_music_idea3-overview-ui-pass-01-review.md` (`partial` at its checkpoint) | Web 102/102; affected 31/31; `HEALTHY` needs `FRESH` + parseable timestamp; Light/Dark desktop and 390×844 QA | CLOSED / MERGED | Chromium-only QA; Demo `HEALTHY` is fixture data |
| PR3 | Security Center foundation: 11 pages, Admin session, CSRF, login throttling, headers, Live/Demo | #62 → `1b335f09` | `2026-09-03_034620_music_idea3-security-center-11-page.md` | Web 59/59 (12 files); Vite 1,675 modules; npm audit 0; browser QA of all 11 routes | CLOSED / MERGED | in-memory audit at the time (superseded by PR6) |
| PR4 | Headless Core: ARMED/DISARMED, single command owner, ACK nonce, ACK/STATUS lifecycle, Task 2D6 `command_nonce` | #91 → `a8ea876d` | `2026-09-06_202113_music_idea3-headless-core-pr4.md` | Python 62; Ruff; compileall; firmware compile-only; repository 56/56 | CLOSED / MERGED | no hardware action in that PR |
| PR4 follow-up | Fix1A fail-secure application boot + Deadman cable-tester E2E | #98 → `3f07f80c` | `2026-09-08_005140_music_idea3-fail-secure-boot-deadman.md` | Python 63; firmware compile-only; owner-observed Deadman, reconnect, RESTORE | CLOSED / MERGED | its open 1B result is SUPERSEDED by PR5 |
| PR5 | Final hardware closure: external pull-down + ULN2003, powered EN/reset, real Ethernet | #117 → `58f19f20` | `2026-09-11_004410_music_idea3-pr5-final-hardware-closure.md` | owner-observed lab matrix (below); Python 196 passed / 6 skipped; repository 63/63 | CLOSED / MERGED — OWNER LAB EVIDENCE | power loss NOT PROVEN; Twingate relay-cycle auto-recovery NOT CLAIMED; breadboard |
| PR6 | SQLite audit persistence + production auth hardening | #101 → `5f30bc54` | `2026-09-08_111604_music_idea3-production-reliability.md` | Python 63; Web 168/168 (18 files); npm audit 0; firmware compile-only; repository 56/56 | CLOSED / MERGED | runtime event snapshot store remains non-durable |
| PR7 | Cross-IDEA integration boundary (inventory/design + IDEA3-side implementation) | #106 → `188fbc90`; #104 → `c68946cb` | `2026-09-08_153936_music_idea3-pr7-inventory-design.md`; `2026-09-08_191700_music_idea3-pr7-live-security-implementation.md` (`partial`) | Python 80; Web 277 (22 files); npm audit 0; repository 56/56 | CLOSED / MERGED — IMPLEMENTED_UNEXERCISED | no upstream feed or shared `correlation_key`; stub-only adapter tests |
| PR8 | Windows standalone runtime | #107 → `f320bbf5` (head `25fb442d`) | `2026-09-09_022203_music_idea3-pr8-windows-standalone.md` (`partial`) | Linux Python 145, Web 292; Windows `c7cdc2b2` build OK and staging-bundle smoke 25/25; final `25fb442d` extracted-ZIP 25/25 owner-reported | HISTORICAL COMPLETED IMPLEMENTATION — NOT FINAL DEPLOYMENT TARGET | `25fb442d` build log, ZIP digest, and smoke transcript NOT FOUND IN REPOSITORY |
| PR9 | Production runtime preparation: composite Core+Web service | #115 → `2c21cc3e` (head `09b91528`) | `2026-09-11_040839_music_idea3-pr9-production-runtime.md` | at `e5863fc6`: Python 245 passed / 6 skipped; Web 309/309 (24 files); Vite 1,677; npm audit 0; repository 63/63; `PRODUCTION_LIKE_VERIFIED`; negative controls 13/13 | CLOSED / MERGED | `PRODUCTION_DEPLOYED = NO`; systemd not installed; real Telegram delivery NOT VERIFIED |

### Capability inventory on current `main`

| Area | Implementation | Evidence | Maturity | Open / limitation |
|---|---|---|---|---|
| Web / Security Center | `web/` React/Vite client and Express API; 11 operational pages plus Login in `web/src/pages/`; `server/security/auth.js`, `csrf.js`, `rateLimit.js`; isolated Demo provider; liveness separate from `/security/api/readiness`; Audit page with bounded export | PR3, PR1, PR2, PR6, PR9 receipts | LOCAL VERIFIED | not server-hosted (PR10) |
| Core | `aegis_soc/supervisor.py` `issue_command()` is the single command owner; `set_armed()` with `ARMED` default; automatic containment reuses `issue_command()`; RESTORE needs explicit authorization; no shutdown path sends `RESTORE_UPLINK` | PR4 receipt; `tests/test_runtime.py`, `tests/test_controller.py`; PR9 lifecycle tests | LOCAL VERIFIED | final Arch Linux deployment (PR10) |
| MQTT / protocol | `aegis_soc/security.py` HMAC-SHA256 over action, nonce, and timestamp; firmware `mbedtls` HMAC verify, `MAX_COMMAND_AGE_SEC = 30`, single-use nonce; ACK echoes nonce; command STATUS carries `command_nonce`; `aegis/heartbeat` with 60 s Deadman | PR4 receipt; `tests/test_core.py`, `tests/test_firmware_contract.py`; firmware compile-only; owner physical Deadman (PR4 follow-up, PR5) | SOURCE + LOCAL VERIFIED; physical Deadman owner-observed | final-environment broker/ESP32 baseline (PR10) |
| Persistence / production security | SQLite `SCHEMA_VERSION = 2` (v1 PR6 + additive v2 PR7), `PRAGMA journal_mode = WAL`, reopen/restart durability, bounded Admin reads, allowlisted sanitization, HTTP 503 on audit-write failure; production `SESSION_SECRET` policy, bcrypt Admin hash, development login disabled in production | PR6, PR7 receipts; PR9 acceptance `PERSISTED_ACROSS_RESTART` | LOCAL VERIFIED | backup/restore documented only (PR12) |
| Cross-IDEA boundary | `integrationEvents.js` (`ACCESS_DENIED` only, `subject` always `null`); `httpJsonClient.js` GET-only, per-source bearer, redirect rejection, 2.5 s, 256 KiB, `schema_version=1`, 500-event bound; envelope and per-event freshness; `correlate.js` deterministic `correlation_key` within 10 minutes → `CONTAINMENT_CANDIDATE`; Admin + CSRF containment decision, idempotent, 409 on reversal; durable lifecycle audit | PR7 receipts; PR9 negative controls 13/13 | IMPLEMENTED_UNEXERCISED | live feeds and shared key (PR11) |
| Windows standalone | `windows/` packaging, launcher, external `%LOCALAPPDATA%` data root | PR8 receipt; owner-reported `25fb442d` acceptance | HISTORICAL COMPLETED IMPLEMENTATION | NOT FINAL DEPLOYMENT TARGET; not a PR10 target |
| PR9 production runtime | `aegis_soc/production_runtime.py` start/stop/restart/status/doctor; Core-then-Web start, Web-then-Core stop, fail-on-child-exit peer cleanup; strict production config; `runtime/service-status.json` separated fields; `deploy/aegis-idea3.service.example`; acceptance and 13-case negative-control drivers; `docs/operations/production-runtime.md` | PR9 receipt | PRODUCTION_LIKE_VERIFIED (loopback) | single-host composite topology; systemd example not installed |

### Hardware evidence — owner-observed, not re-run

The authoritative matrix is "Project-sequence PR5 Final Hardware Closure" below
and its receipt. Firmware source agrees with the recorded polarity:
`RELAY_IN = 27`, `RELAY_TRIGGER = LOW`, `RELAY_RELEASE = HIGH`.

```text
GPIO27 LOW  = LOCKDOWN / CUT
GPIO27 HIGH = NORMAL / RESTORE
PHYSICAL_LOCKDOWN_PIN2 = PASS
PHYSICAL_RESTORE_PIN2 = PASS
RESET_WINDOW_1B = PASS (powered control circuit only)
RECONNECT_DOES_NOT_AUTO_RESTORE = PASS
EXPLICIT_RESTORE_REQUIRED = PASS
REAL_ETHERNET_RESTORE_BASELINE = PASS
REAL_ETHERNET_CUT = PASS
REAL_ETHERNET_RESTORE_RECOVERY = PASS
SSH_CUT_EFFECT = PASS
SSH_POST_RESTORE_RECONNECT = PASS
TWINGATE_DIRECT_BASELINE = PASS
TWINGATE_CONNECTOR_HEALTH_AFTER_MANUAL_RESTART = PASS
TOTAL_CONTROL_POWER_LOSS_FAIL_SECURE = NOT PROVEN
TWINGATE_FINAL_RELAY_CYCLE_AUTO_RECOVERY = NOT CLAIMED / NOT CONCLUSIVELY VERIFIED
MECHANICAL_BREADBOARD_STABILITY = PROTOTYPE LIMITATION
HARDWARE_RERUN_IN_THIS_RECONCILIATION = NO
```

### Historical and superseded items

| Item | Repository finding | Classification |
|---|---|---|
| Dashboard UI Pass / trilingual UI | original checkpoint `eaa605db` on `origin/feature/aegis-security-ui-redesign` is not an ancestor of `main`; its behaviour reached `main` through #85 (`431124ff`) | HISTORICAL — delivered by PR1; old branch receipts intentionally not copied |
| Overview UI Pass 01 | historical checkpoint `d7f1c57e` is not present in this clone; the #87 receipt records exact source parity with it before merge | HISTORICAL — delivered by PR2 |
| IDEA1-hosted file-backed IDEA3 status bridge (`AEGIS_IDEA3_STATUS_PATH`, `IDEA1-AEGIS_Drive_LC/server/idea3/status.js`) | merged by #60 (`7a7936bf`), reverted on `main` by `5473e552`; absent from `main` | SUPERSEDED / REVERTED |
| "Web Runtime Integration Pass 01", old file-backed IDEA3 runtime adapter, old runtime evidence helper | no commit, branch, file, or receipt in any fetched ref | NOT FOUND IN REPOSITORY — no current functionality gap identified |
| Current runtime integration | `AEGIS_IDEA3_RUNTIME_STATUS_URL` → `web/server/config.js` → `liveProvider.js` HTTP JSON → `normalizeRuntimeStatus()`; PR8/PR9 owners point it at the Core loopback `/v1/core-status` | CURRENT |
| Same-`sourceIp` correlation heuristic (PR3) | removed by PR7; `correlate.js` no longer references `sourceIp` | SUPERSEDED |
| In-memory Web audit (PR3) | replaced by durable SQLite (PR6, schema v2 in PR7) | SUPERSEDED |
| Core-only `deploy/aegis-supervisor.service.example` (PR4) | deleted by PR9; replaced by composite `aegis-idea3.service.example` | SUPERSEDED |
| Legacy `normalizeIdea1Event` / `normalizeIdea2Event` | still exported by `web/server/domain/normalize.js`; unreachable from `liveProvider` | HISTORICAL CODE — cleanup unscheduled |
| 2026-09-08 roadmap numbering (PR8 hardware, PR9 Kali, PR10 Windows, PR11 deployment) and the later PR7-merge roadmap (PR10 hardware closure, PR11 Kali) | hardware closure shipped as project PR5 (#117); Windows as PR8; runtime preparation as PR9 | SUPERSEDED — current PR10–PR12 scope below |

### Stale facts corrected by this reconciliation

- PR9 / GitHub PR #115 described as awaiting human review and not merged → MERGED
  at `2c21cc3e` (top callout, PR5 block, PR9 task, dashboard, remaining work,
  handoff, and the IDEA3 MOC entry statement).
- PR9 Current Task, Session Register, and Handoff relabelled as historical.
- Both older roadmap blocks relabelled SUPERSEDED.
- Security Center (2026-09-04) section: same-IP correlation, SQLite schema v1,
  "final real-hardware closure deferred", and "Current" Overview-pass evidence
  relabelled against later evidence.

### Contradictions outside this note — not edited here

- `AGENTS.md` ownership table and `core/agent-operating-rules.md` still say IDEA3
  implementation is not established, and `START_HERE.md` still describes IDEA3
  as design/report state until hardware proof. These are Kla-owned shared
  surfaces; the PR7 inventory receipt already requested the correction and it
  remains unresolved.
- `IDEA3-AEGIS_Lockdown/README.md`, `PROGRESS.md`, and
  `doc/Content/04_SESSION_HANDOFF.md` still describe PR #115 as awaiting review,
  and the handoff plus the PR6/PR7 specs and plans still carry the superseded
  PR8–PR12 numbering. IDEA3-owned; left for a separate source-document update
  because this task is limited to the canonical Obsidian notes.
- PR1–PR3 labels differ from merge chronology (see the matrix note).
- PR9 implemented a **single-host** composite service: one service account, Core
  and Web under one owner, `AEGIS_BIND_HOST=127.0.0.1`. The PR10 target below
  splits Web (AEGIS Server) from Core (Arch Linux). No split-host or
  Server-to-Core boundary exists in source: NOT IMPLEMENTED.

### PR10 — server-hosted deployment: IN PROGRESS (S1 documentation merged via PR #120; D1–D8 owner-accepted; live server inventory PASS; K1–K12 Kla-approved; S1 PASS / CLOSED; S2 IN PROGRESS)

Target architecture as defined by the owner on 2026-09-11. It has not yet been
designed in a repository spec or plan; the S1 inventory is
`IDEA3-AEGIS_Lockdown/docs/operations/PR10_DEPLOYMENT_INVENTORY.md`:

```text
AEGIS Server : React static build, Express, SQLite, integration adapters, correlation, accepted-action state
Arch Linux   : Python Core, Supervisor, Controller, MQTT command ownership, heartbeat
ESP32        : MQTT client, HMAC, nonce, ACK, STATUS, heartbeat, relay output
Browser      : never owns MQTT actuation
```

```text
SERVER_HOSTED_IDEA3_WEB_DEPLOYMENT = OPEN
ARCH_LINUX_CORE_FINAL_DEPLOYMENT = OPEN
REAL_SYSTEMD_INSTALLATION = OPEN (example only)
SERVER_TO_CORE_DURABLE_ACCEPTED_ACTION_BOUNDARY = OPEN / NOT IMPLEMENTED
REAL_MQTT_FINAL_ENVIRONMENT_BASELINE = OPEN
REAL_ESP32_BROKER_BASELINE = OPEN
REAL_CLIENT_TO_SERVER_IDEA3_ACCESS = OPEN
RESTART_RECOVERY_BASELINE = OPEN (PR9 proved loopback restart only)
```

### PR10 Current Task

Task: IDEA3 PR10 — real Arch Linux Core + server-hosted IDEA3 Web deployment baseline
Branch: `feat/idea3-pr10-real-deployment` (S1 branch; merged through PR #120, receives no further commits)
Owner: `music`
PR: GitHub PR #120 — MERGED by a human reviewer at `93170862cbf5b5a802042d12c84944abd39d9123` (2026-09-11T16:21:40Z) while PR10 was still IN PROGRESS; see "PR10 workflow exception" below
Workflow-recovery branch: `docs/idea3-pr10-postmerge-reconciliation` — GitHub PR #121 (docs-only reconciliation; not S2). Its single receipt, `90-Status/logs/2026-09-11_234455_music_idea3-pr10-postmerge-reconciliation.md`, covers the reconciliation only and is not the PR10 final receipt
S1 closeout branch: `docs/idea3-pr10-d1-d8-architecture-decisions` — GitHub PR #122 (docs-only: D1–D8, the S1 live inventory, the K1–K12 package and its Kla approval, and the S1 closeout receipt; not S2) — MERGED by a human reviewer at `b2f61ebf361a5e22f00d28e7e99dcbf3ce006d95` (2026-09-12). It is immutable and receives no further commits
S2 task branch: `feat/idea3-pr10-s2-server-core-boundary` — the new task and PR for PR10 S2 (repository-only, non-Production). The PR is not yet opened. Its one receipt will be an S2 receipt, not the final PR10 receipt
Current state: IN PROGRESS
Started: 2026-09-11
Base SHA: `895c79ac8ab9b39f322919fabc9facfdc34ba20b` (PR10 start); S2 base `b2f61ebf361a5e22f00d28e7e99dcbf3ce006d95`
Last checkpoint: S1 `ea2414f44445b9c090e0794ea086e098913d5a45` (reviewed S1 pre-closeout head); S2 G1 `32545cebcba8bd8ed9f7a60a930a5e622d8aa717` (design + TDD plan with the topology and configurable-bind clarifications; APPROVED by the owner 2026-09-12); S2 Task 1 `677acbe635f4e79173b97f9c035bbef6195060e1`; S2 Task 2 `3f67cd85440599b3ed63ae138da4b05819efd1ac` (coverage follow-up `94cfb2bfa750244ef6e8546c9f5edb479168e831`); S2 Task 3 `5cae52e392ece0d5c3aee45259c161598e1154ae`; S2 Task 4 `9314342256f27230e5345ce6be87167086dbe162`; S2 Task 5 `9f0f7930f02c5d3b81a4495fa2bc444a3b3ee17d`; S2 Task 6 `ba07feb4295dea6d881a30a7d94c48ef003c1464`; S2 Task 7 `1e4af6976d407cdafe55d9cfb3f17be0fddbbd14`; S2 Task 8 `82a67326facc358f466423e2912ebe055eee9866`; S2 Task 9 `74eb2c99d0c6887ae614a6a75075adcd556e0d56` (C6 worker-test gap fix found by NC5); S2 Task 10 full regression bar PASS at `ed9efc4e285ea5e5cf2246b869570da5e6e06298`
Production mutation allowed: NO (S1, S2)
Hardware testing: NOT RUN

```text
PR120                     = MERGED (93170862cbf5b5a802042d12c84944abd39d9123) — documentation checkpoint only
PR10_STATE                = IN PROGRESS
D1_D8                     = DECIDED / OWNER-ACCEPTED (2026-09-12) — architecture only, not implemented
LIVE_SERVER_INVENTORY     = PASS (2026-09-12, read-only)
KLA_DECISIONS_K1_K12      = APPROVED (2026-09-12)
KLA_INTEGRATION_APPROVAL  = APPROVED (architecture/integration only)
PRODUCTION_CHANGE_AUTHORIZED = NONE
S1                        = PASS / CLOSED (2026-09-12)
OWNER_CONTINUATION_APPROVAL = APPROVED (2026-09-12)
READY_FOR_PR10_S2         = YES
PR10_S2                   = IN PROGRESS (G1 APPROVED 2026-09-12; Task 0 baseline recorded; Task 1 PASS at 677acbe6; Task 2 PASS at 3f67cd85, coverage follow-up 94cfb2bf; Task 3 PASS at 5cae52e3; Task 4 PASS at 93143422; Task 5 PASS at 9f0f7930; Task 6 PASS at ba07feb4; Task 7 PASS at 1e4af697; Task 8 PASS at 82a67326; Task 9 PASS at 74eb2c99 — NC1–NC5 observed, NC2 via NC2B, NC5 after the C6 worker-test gap fix; Task 10 PASS — full regression bar at ed9efc4e)
S2_STARTED                = YES (2026-09-12)
PRODUCTION_DEPLOYED       = NO
IDEA3_PRODUCTION_COMPLETE = NO
PRODUCTION_MUTATION       = NONE
HARDWARE_TESTING          = NOT RUN
FINAL_PR10_RECEIPT        = NONE
```

Goal: a real, evidence-backed deployment baseline with IDEA3 Web on the AEGIS
Server at `/security/` and the Python Core on an Arch Linux host, joined by a
durable, authenticated Server → Core accepted-action boundary. Out of scope for
S1: deployment, systemd, packages, firewall, proxy, Docker, Twingate, broker
configuration, MQTT actuation, firmware, and IDEA1/IDEA2/HUB source. Acceptance
for S1: the owner decides the architecture (D1–D8, done 2026-09-12); the live
server inventory passes (done 2026-09-12); Kla approves the K1–K12 integration
package for the D3/D5 shared infrastructure (done 2026-09-12). All three are
met, so S1 is PASS / CLOSED.

S1 findings (public-safe summary; evidence labels are in the inventory document,
and host-level specifics are deliberately not published):

- The initial S1 attempt had `SERVER_ACCESS = ACCESS_NOT_AVAILABLE`. The
  read-only live AEGIS Server inventory on 2026-09-12 then passed; see "PR10 S1
  live AEGIS Server inventory" below.
- The Arch Core host is a CANDIDATE, NOT READY. It is not yet attached to the
  final AEGIS network segment, its hardening is not at a production baseline, and
  it already hosts an MQTT broker and IDEA2-owned services.
- The current MQTT baseline requires production hardening before PR10
  deployment. Recorded ESP32 sessions used a temporary lab network outside the
  AEGIS VLANs. D1 now selects a dedicated private access point on the Core host
  (decided, not implemented).
- `/security/` reverse-proxy integration requires design and review (D3). The
  current production Web assumes loopback-only access, and Express mounts
  `/security` itself, so a proxy must forward the full path.
- CUT isolates the whole server, including server-hosted remote access. The
  Core, broker, RESTORE authority, and post-publish evidence must remain
  available independently of the relayed server uplink (D2, D4). A durable
  Server → Core boundary is required, and the browser must not own MQTT
  actuation.

### PR10 workflow exception — premature merge of PR #120

PR #120 was merged by a human while it still represented the S1
inventory/architecture checkpoint. The merge records the S1 documentation on
`main` but does not satisfy the PR10 completion gate. PR10 remains IN PROGRESS
and S2 was blocked pending the stated prerequisites. The owner approved the
continuation on 2026-09-12.

Verified facts (GitHub and Git, 2026-09-11):

- PR #120 was marked Ready at 16:21:33Z and merged at 16:21:40Z. The
  collaboration-guardrails run on that Ready transition (`34621524129`) failed:
  "A final Obsidian task receipt is required before Ready/non-Draft review;
  found 0." Before that, the PR's valid Draft run had passed.
- Merge commit `93170862cbf5b5a802042d12c84944abd39d9123` has parents
  `895c79ac` and `54bb6a08`, and its tree is identical to the reviewed head
  `54bb6a08`. The merge brought in only the three public-safe IDEA3 S1 files:
  the inventory, this note, and the IDEA3 MOC.
- No PR10 task receipt exists. None was created, because PR10 has not reached
  its final handoff.

The merge does **not** mean:

- S1 PASS or S1 CLOSED;
- PR10 CLOSED;
- Production deployment;
- S2 authorization.

The merged S1 documentation is correct and public-safe, so it is kept. No
revert, reset, or rewrite of `main` is proposed.

**Continuation model — APPROVED by the owner on 2026-09-12:**

- PR10 remains the project-sequence umbrella for the real deployment baseline.
- The original "one open PR for all PR10 sessions" lifecycle cannot continue,
  because its PR is already merged. That is the only reason a new PR is needed;
  PR10 is not complete.
- Future implementation continues as a new, explicitly named IDEA3 task branch
  and PR beginning with S2. It must reference PR #120, merge commit
  `93170862cbf5b5a802042d12c84944abd39d9123`, the S1 inventory, and this
  reconciliation. It may start only after the S2 prerequisites below are met
  and the owner approves.
- The single final PR10 receipt belongs to the PR that performs the PR10 final
  handoff. It must record PR #120 as a premature human merge of the S1
  documentation checkpoint.
- S2 started on 2026-09-12 as the new task branch
  `feat/idea3-pr10-s2-server-core-boundary`; see "PR10 Session S2" below.

### PR10 architecture decisions D1–D8 — owner-accepted 2026-09-12

The owner accepted this decision set on 2026-09-12. It is architecture only:
nothing here is implemented, installed, configured, deployed, or flashed. The
detailed record is §14 of
`IDEA3-AEGIS_Lockdown/docs/operations/PR10_DEPLOYMENT_INVENTORY.md`.

| ID | Accepted decision |
|---|---|
| D1 | The Core host runs a dedicated private Wi-Fi access point for the ESP32 only. Nothing is forwarded or routed from it; the ESP32 reaches the Core and MQTT directly; the Core provides the ESP32's time source. No new access-point hardware or VLAN. |
| D2 | The MQTT broker runs on the Core host and listens only on the access-point address plus loopback. Separate Core and ESP32 credentials, a per-topic ACL, and no anonymous access. The host firewall blocks MQTT from the wired/uplink side. MQTT uses TLS, and the ESP32 verifies the broker against a pinned private CA. The ESP32 signs ACK and STATUS, and the Core verifies them. |
| D3 | IDEA3 Web runs as a hardened container on a dedicated internal network behind HUB/NGINX at `/security/`, with no direct public host port. NGINX is the single owner of browser-facing security headers and CSP, and parity tests verify the intended IDEA3 policy. |
| D4 | RESTORE during LOCKDOWN is authorized only through an authenticated, audited Core-local CLI (for example `aegisctl restore`), run from the console or approved Management-VLAN SSH, through the Core's single command owner. It is never automatic and requires explicit operator confirmation, reason, and incident context. There is no Telegram or Web recovery authority. |
| D5 | The Core pulls, claims, and reports server dispatch actions through HUB HTTPS 443 on a dedicated machine path under `/security/`. A HUB edge guard restricts that path to the Core host and hides it from normal users, and an mTLS client certificate authenticates the Core. No new published server port. Route ownership needs Kla/infrastructure review before implementation. |
| D6 | The current Arch laptop becomes a dedicated Core appliance: personal desktop use stops; it gets a dedicated service account and production hardening; sleep, suspend, and lid-suspend are disabled; its host firewall denies by default; maintenance happens in controlled windows because Core downtime can trigger a Deadman CUT. Its wired segment is VLAN 20 via switch port 3, and its Wi-Fi is reserved for the D1 access point. IDEA2 may remain only if separately approved, unprivileged, isolated, and kept off the ESP32 AP/control boundary. |
| D7 | One unique `action_id` per accepted incident, with terminal single-shot claims. The claim is an atomic `PENDING_DISPATCH → CORE_CLAIMED` transition, and a claimed action is never re-dispatched automatically. A CUT action expires 120 s after acceptance; the Core re-checks expiry before publishing, and expired actions are never published. No valid ACK or no correlated STATUS gives `OUTCOME_UNKNOWN`, which requires human review. No automatic retry. Device STATUS remains the physical-state evidence source. |
| D8 | Production Web uses a bounded in-memory TTL session store. It keeps the current login, CSRF, and logout semantics and the existing secure cookie policy. The idle timeout is `AEGIS_SESSION_IDLE_MS`, default 30 minutes. The store caps its entries and prunes periodically. No auth session state is persisted to disk, so a container restart invalidates sessions and logs the Admin out. |

The authorized read-only live AEGIS Server inventory is done
(`LIVE_SERVER_INVENTORY = PASS`, 2026-09-12). The last S1 gate was the
Kla/integration-owner decision, and its reconciliation, for the D3/D5 shared
infrastructure. That includes `/security/` ownership in the runtime and Git
HUB configurations, the HUB↔IDEA3 network and subnet, mTLS placement and CA
ownership, and sequencing relative to PR #118 / S5.5.

That decision set was prepared as the K1–K12 review package (see "PR10 S1 Kla
review package K1–K12" below) and accepted for owner review. Kla then approved
it for architecture/integration (reported 2026-09-12), which closed the gate.

Current state:

```text
D1_D8 = DECIDED / OWNER-ACCEPTED
LIVE_SERVER_INVENTORY = PASS
KLA_DECISIONS_K1_K12 = APPROVED
KLA_INTEGRATION_APPROVAL = APPROVED
PRODUCTION_CHANGE_AUTHORIZED = NONE
S1 = PASS / CLOSED
OWNER_CONTINUATION_APPROVAL = APPROVED (2026-09-12)
READY_FOR_PR10_S2 = YES
S2_STARTED = YES (2026-09-12; repository-only, non-Production)
PRODUCTION_MUTATION = NONE
HARDWARE_TESTING = NOT RUN
```

### PR10 S1 live AEGIS Server inventory — 2026-09-12 (read-only) — PASS

This is a public-safe summary; the full record with evidence labels is §2A of
`IDEA3-AEGIS_Lockdown/docs/operations/PR10_DEPLOYMENT_INVENTORY.md`. Evidence
came from unprivileged read-only SSH reads and root-only read-only reads run by
the owner. Nothing was changed on the server, and no hardware was touched.

- **OBSERVED:**
  - The HUB is the single host-published browser entry (80 → HTTPS, 443 TLS).
    `/drive/` and `/monitor/` exist in the active NGINX; **`/security/` does not
    exist**; no mTLS client-certificate route is deployed.
  - The host runtime NGINX configuration matched the HUB container-loaded
    configuration at the observed time, but it still differs from Git
    (`DRIFT_FOUND = YES`).
  - The firewall uses `nf_tables` with `INPUT DROP`, `FORWARD DROP`,
    `OUTPUT ACCEPT`. `AEGIS-PS-EGRESS` is anchored first in `DOCKER-USER`, and
    `AEGIS-PS-INPUT` comes before the UFW input chains.
  - **S5.5 is PARTIALLY PRESENT**: the egress network and `AEGIS-PS-*` chains
    exist, but the connector is not running and no S5.5 runtime file or systemd
    unit was observed. It is neither fully deployed nor fully absent.
  - A candidate IDEA3 /29 did not overlap the observed live Docker IPv4
    subnets. Final allocation belongs to the Kla/integration owner.
  - The last 24 h of HUB logs showed only Docker-gateway and loopback source
    classes.
- **INFERRED / FEASIBLE:**
  - **D3 is FEASIBLE**: a hardened IDEA3 container on a dedicated internal
    network behind the HUB at `/security/`, with no direct public IDEA3 port.
  - **D5 is FEASIBLE WITH CONDITIONS**: Core → HUB HTTPS 443, with D5 mTLS as
    the primary machine authentication.
- **NOT PROVEN:**
  - preservation of the real Core source address at the HUB, so source
    allowlisting remains defense-in-depth only;
  - the Core → HUB path from VLAN 20 (not tested);
  - whether the S5.5 chains persist across a host reboot.
- **PROPOSED:** the D3/D5 components, which are not deployed.

`PRODUCTION_MUTATION = NONE`; `HARDWARE_TESTING = NOT RUN`.

### PR10 S1 Kla review package K1–K12 — APPROVED (architecture/integration only)

On 2026-09-12 the owner accepted the recommended direction of every K-decision
for the D3/D5 shared infrastructure for owner review. The IDEA3 owner then
reported Kla's integration approval of K1–K12 the same day, which closed the S1
gate. **Provenance:** relayed by the IDEA3 owner; no approval comment or review
was on PR #122 at closeout. After closeout, Kla's GitHub account submitted an
APPROVED review of PR #122 (2026-09-12T07:58:33Z, no review text) and merged it
at `b2f61ebf`.

- **Scope:** the approval is **architecture/integration only** and authorizes
  **no Production change**. Every future shared-infrastructure change needs its
  own reviewed, authorized change, and the PR10 Production rollout stays
  **blocked** until then.
- **External dependencies stay separately owned:**
  - K12: Kla + IDEA1 confirmation before any PR10 Production rollout;
  - D6: separate Pub/IDEA2 approval for IDEA2 co-residence.
- `LIVE_SERVER_INVENTORY = PASS`.
- The full package, with implementation conditions and NOT PROVEN items, is
  §15A of `IDEA3-AEGIS_Lockdown/docs/operations/PR10_DEPLOYMENT_INVENTORY.md`.

| K | Subject | Accepted direction (summary) | Status |
|---|---|---|---|
| K1 | HUB NGINX ownership | Kla is the single editor in Git and Production; reconcile the Git↔runtime drift first; `/security/` only after that baseline; IDEA3 supplies the contract, policy, and tests | APPROVED |
| K2 | `/security/` contract | Redirect, full-path proxy, no host port; NGINX owns the headers and CSP; single-hop headers with `Host` preserved; machine path 404 on the browser block; parity tests; enumerate every Helmet header first | APPROVED |
| K3 | Sequencing with PR #118 / S5.5 | S5.5 stable or rolled back first; separate windows and rollbacks; non-Production work continues | APPROVED |
| K4 | IDEA3 subnet | The non-colliding candidate `/29`: HUB `.2` pinned, IDEA3 Web `.3`; Kla allocates and records it | APPROVED |
| K5 | IDEA3 network | `internal: true`, not attachable, HUB and IDEA3 Web only; Music owns the service; Kla owns the network and the HUB's membership | APPROVED |
| K6 | Server firewall | PR10 adds no server firewall or UFW rules; never touches the S5.5 chains; any future rule is a separate Kla change after the S5.5 anchors | APPROVED |
| K7 | HUB network join | Managed Compose recreate of the HUB only; canonical file order updated; validated, announced window; rollback to the previous list | APPROVED |
| K8 | Machine route | HUB 443 only; router allows VLAN 20 → 443; acceptance test from VLAN 20 | APPROVED |
| K9 | mTLS server name | Separate SNI block with a required client certificate; browser block stays `default_server`; verified identity headers only from the HUB | APPROVED |
| K10 | Machine-client CA | Dedicated `clientAuth` CA; Kla holds the key offline; Core key stays on the Core; ~90-day certificates; local CRL plus subject check | APPROVED |
| K11 | Source allowlisting | mTLS primary; allowlist optional and only once real source is proven; never the Docker gateway address | APPROVED |
| K12 | Partial S5.5 state (Kla + IDEA1) | Confirm the intent and reboot persistence in writing before any PR10 rollout; reboot outside both windows | APPROVED |

### PR10 Session Register

| ID | Scope | State | Evidence | Checkpoint | Result | Remaining | Next |
|---|---|---|---|---|---|---|---|
| S1 | Real infrastructure inventory + architecture gate (read-only) | CLOSED | `IDEA3-AEGIS_Lockdown/docs/operations/PR10_DEPLOYMENT_INVENTORY.md` (§2A, §14, §15, §15A); PR #122 checks; `git diff --check`; vault validation; receipt `90-Status/logs/2026-09-12_141734_music_idea3-pr10-s1-architecture-gate.md` | `ea2414f44445b9c090e0794ea086e098913d5a45` (reviewed pre-closeout head; earlier `8250d694`) | PASS — D1–D8 DECIDED / OWNER-ACCEPTED; LIVE SERVER INVENTORY PASS; K1–K12 KLA-APPROVED (architecture/integration only, 2026-09-12); PR #120 remains a merged documentation checkpoint; no Production change authorized | — (S1 closed) | S2 — the owner approved the continuation model on 2026-09-12; new task branch `feat/idea3-pr10-s2-server-core-boundary` |
| S2 | Server → Core durable accepted-action boundary (repository-only: design, TDD plan, source, tests; non-Production) | IN PROGRESS | G1 design spec + TDD plan APPROVED by the owner (2026-09-12); Task 0 regression baseline at `640cebc9`; Task 1 (W1, W2, W3, W14) PASS; Task 2 (W4, W5, W14; W8 and W11 repository/route side) PASS; Task 3 (W6, W7, W9, W10; completes W8 and W11) PASS; Task 4 (W12, W13) PASS, which completes W1–W14 on the Web side; Task 5 (C3, C4, C6; storage for C1, C5, C7) PASS; Task 6 (C2, C7, C8 transport; typed list/claim/report client) PASS; Task 7 completes C1–C10 with worker/supervisor orchestration PASS; Task 8 (shared Web↔Core contract fixture) PASS; Task 9 (negative controls NC1–NC5 observed, no residue; NC2 via NC2B; NC5 after the C6 worker-test gap fix) PASS; Task 10 (full regression bar: Python, Web, Ruff, compileall, Vite, npm audit, PR9 drivers, repository, vault, diff, secret and path checks) PASS at `ed9efc4e` — see "S2 Task 0" to "S2 Task 10" below | `ed9efc4e285ea5e5cf2246b869570da5e6e06298` (Task 10 regression HEAD); Task 9 C6 test `74eb2c99`; Task 8 `82a67326`; Task 7 `1e4af697`; Task 6 `ba07feb4`; Task 5 `9f0f7930`; Task 4 `93143422`; Task 3 `5cae52e3`; Task 2 coverage `94cfb2bf`; Task 2 `3f67cd85`; Task 1 `677acbe6`; G1 `32545ceb` (design + plan with the topology and configurable-bind clarifications — APPROVED by the owner 2026-09-12; earlier G1 checkpoints `6076ef85`, `f1c5c1e1`) | pending | Task 11 of the plan (closeout and Draft PR) | Task 11 (closeout, one S2 receipt, Draft PR; stop before Ready), within the owner-approved final continuation (Tasks 8–11) |

### PR10 Session S2 — Server → Core durable accepted-action boundary

State: IN PROGRESS — G1 checkpoint `32545cebcba8bd8ed9f7a60a930a5e622d8aa717` was APPROVED by the owner on 2026-09-12. The Task 0 regression baseline and Tasks 1–10 are recorded below. Task 7 (`1e4af697`, PASS) completed C1–C10, Task 8 (`82a67326`, PASS) pins the shared Web↔Core contract, and Task 9 (PASS) observed NC1–NC5 with no residue; its NC5 control found and closed a C6 worker-test gap (`74eb2c99`, test-only). Task 10 (PASS) ran the full regression bar at `ed9efc4e`. The owner approved the final continuation (Tasks 8–11); Task 11 remains. The G1 checkpoint is the design + TDD plan, plus two clarifications:

- **Topology:** the machine listener is container-internal, has no host-published port, and is reachable only over the HUB↔IDEA3 internal network.
- **Bind address:** it comes from `AEGIS_IDEA3_DISPATCH_HOST`. Local and test runs default to `127.0.0.1`; loopback is never hard-coded; the Production value is not selected in S2 and is deferred to K4/K5/K7.

Earlier G1 checkpoints: `6076ef85`, `f1c5c1e1`. Source: Task 1 at `677acbe6`, Task 2 at `3f67cd85`, Task 3 at `5cae52e3`, Task 4 at `93143422`, Task 5 at `9f0f7930`, Task 6 at `ba07feb4`, Task 7 at `1e4af697`
Started: 2026-09-12
Branch: `feat/idea3-pr10-s2-server-core-boundary`
Starting SHA: `b2f61ebf361a5e22f00d28e7e99dcbf3ce006d95` (merge of GitHub PR #122)
Production mutation allowed: NO
Evidence class: LOCAL / SIMULATED only

**Continuation references:**

- PR #120 and merge commit `93170862cbf5b5a802042d12c84944abd39d9123`, the
  premature S1 documentation checkpoint;
- the S1 inventory,
  `IDEA3-AEGIS_Lockdown/docs/operations/PR10_DEPLOYMENT_INVENTORY.md`;
- PR #121, the post-merge reconciliation;
- PR #122 (`b2f61ebf`), the S1 closeout.

**Plan:** the owner approved the kickoff definition on 2026-09-12. The work
runs in this order:

1. write the design spec and TDD plan;
2. **G1 owner review — stop;**
3. baseline the regression suites;
4. implement the Web schema v3, minting, machine app, and evidence;
5. implement the Core ledger, client, and worker;
6. add the shared contract fixture;
7. run the negative controls NC1–NC5;
8. run the full regression;
9. canonical closeout with one S2 receipt;
10. open a Draft PR and stop before Ready.

- **Spec:**
  `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-12-idea3-pr10-s2-server-core-boundary-design.md`
- **Plan:**
  `IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-12-idea3-pr10-s2-server-core-boundary.md`

**Why:** `SERVER_TO_CORE_DURABLE_ACCEPTED_ACTION_BOUNDARY = OPEN / NOT
IMPLEMENTED`. Inventory §13.3 defines the boundary constraints for S2, and D7
defines the claim model.

**Scope:** limited to the §13.3 boundary, D7, and the IDEA3 side of D5.

- **Web:**
  - additive schema v3;
  - Admin acceptance mints one `action_id` with a 120 s TTL;
  - atomic single-shot claim;
  - machine identity (pinned HUB peer + verified mTLS headers + expected
    subject);
  - append-only reconciliation;
  - dispatch status display.
- **Core:**
  - durable dispatch ledger;
  - dispatch client;
  - claim → publish only through `issue_command`;
  - reconciliation outbox;
  - credential pause.
- **Default:** both halves are disabled by default.

**Expected changes:** only IDEA3 paths, as listed in the plan: Web server,
tests, dashboard/i18n, Core modules and tests, `.env.example`, the spec and
plan, and the canonical IDEA3 notes.

**Expected evidence:**

- W1–W14, C1–C10, and NC1–NC5;
- the regression suites against the Task 0 baseline;
- the PR9 drivers (`PRODUCTION_LIKE_VERIFIED`, 13/13);
- vault, policy, diff, and secret checks.

**Safety / Do-not-touch:**

- **Production:** no Production deployment or Production database migration.
- **Edge and network:** no live HUB, NGINX, Docker, Compose, or network
  change; no firewall, UFW, or nftables change; no router, VLAN, or Twingate
  change.
- **Credentials:** no real certificate or CA issuance or installation.
- **Hardware:** no firmware flashing; no hardware CUT/RESTORE.
- **Other owners:** no IDEA1, IDEA2, or shared-infrastructure mutation.
- **Access:** no SSH to the server or the Core host.
- **Deferred:** every Production-facing K1–K12 action.

**Dependencies:**

- **Inherited K constraints:** K2 machine-path 404 contract, K4 pinned peer,
  K9 identity headers, K10 subject and credential pause, K11 no allowlist,
  K5 Core pulls.
- **Before any rollout:** K12 (Kla + IDEA1).
- **Separately owned:** D6 (Pub/IDEA2).

#### S2 Task 0 — regression baseline (2026-09-12)

**Measured at:** `640cebc92d96aec8a5d4c39525559e9ab9bdc57d`, the approved G1
head. Its source tree matches `origin/main` `b2f61ebf`; only documentation
differs. No source changed. Evidence class: LOCAL.

**Environment:**

- Arch Linux, kernel 7.2.3-arch1-2, x86_64.
- A task-local venv outside the repository, with Python 3.14.7 and the
  `requirements-dev.txt` pins (pytest 9.1.1, ruff 0.16.3, paho-mqtt 2.1.0).
- Node v24.16.0 and npm 11.13.0; the Web dependencies come from the committed
  lockfile through `npm ci` (264 packages).
- `web/node_modules` and `web/dist` are gitignored, and Python bytecode was
  redirected outside the tree.

| Suite | Command | Exit | Result |
|---|---|---|---|
| Python full | `python -m pytest -p no:cacheprovider -q` | 0 | 245 passed, 6 skipped; matches PR9. All 6 skips are in `tests/test_windows_launcher.py`: "PowerShell 7 is required to execute the bundle staging contract" |
| Ruff | `ruff check --no-cache aegis_soc tests windows deploy detector.py sim_auto_detector.py server_admin.py` | 0 | all checks passed |
| compileall | `python -m compileall -q aegis_soc deploy windows detector.py server_admin.py sim_auto_detector.py tests` | 0 | pass |
| Web full | `npx vitest run` | 0 | 309 passed in 24 files; matches PR9 |
| Web build | `npx vite build` | 0 | 1,677 modules |
| npm audit, PR9 form | `npm audit --omit=dev --offline` | 0 | 0 vulnerabilities |
| npm audit, production deps online | `npm audit --omit=dev` | 0 | 0 vulnerabilities |
| npm audit, full online | `npm audit` | 1 | 2 moderate — PRE-EXISTING, dev-only (see below) |
| PR9 acceptance driver | `python deploy/production-like-acceptance.py --data-root <new disposable path with spaces>` | 0 | `PRODUCTION_LIKE_VERIFIED`, on the rerun (see the harness note) |
| PR9 negative-control driver | `python deploy/production-like-negative-controls.py --data-root <empty disposable path with spaces>` | 0 | 13/13 PASS |
| Repository | `node --test --test-concurrency=1 tests/*.test.mjs` | 0 | 63 passed; matches PR9 |
| Vault, policy, diff | vault validator; policy validator (Draft event); `git diff --check origin/main HEAD` | 0 | pass (2 known canvas warnings) |

**Acceptance-driver details:**

- 2 generations; Web `READY`;
- audit `PERSISTED_ACROSS_RESTART`;
- IDEA1, IDEA2, and MQTT `NOT_CONFIGURED`; ESP32 and physical evidence
  `UNKNOWN`;
- 3 processes per generation, 0 surviving;
- control token `ABSENT`; owner-only permissions; final `STOPPED`;
- `productionMutation = false`.

**Pre-existing finding (not introduced by S2):**

- **Package:** `vitest@3.2.7`, a direct devDependency, via
  `@vitest/mocker@3.2.7`.
- **Advisory:** GHSA-82fw-gwwq-j7x9, moderate — path traversal / arbitrary file
  read via a mocker redirect. It affects versions `>=2.1.0 <4.1.11`.
- **Fix:** vitest 5.0.0, a semver-major upgrade.
- **Impact:** production dependencies are unaffected; `npm audit --omit=dev`
  finds 0.
- **Classification:** pre-existing at the base; dev tooling only.
- **S2 handling:** S2 does not upgrade it, because that is out of scope. The
  S2 audit bar is therefore: 0 production-dependency vulnerabilities and no new
  finding against this baseline.
- **Owner decision (2026-09-12):** accepted as a known dev-only finding. No
  separate upgrade task is opened.

**Harness note (failed run kept):**

- **Failure:** the first acceptance-driver run failed with
  `group/world-accessible paths: .`.
- **Cause:** the harness had pre-created the data root under umask 022, giving
  mode 0755. The driver creates a missing root with mode 0700
  (`validate_data_root`) but does not change an existing one.
- **Classification:** environmental / harness, not a code defect.
- **Rerun:** on a missing path, which the driver created with mode 0700, the
  run passed. No source changed between the runs.

**Residue:**

- 0 runtime processes before and after each driver run.
- No new loopback listeners.
- Disposable roots and bytecode removed.
- `git status --short` clean.

#### S2 Task 1 — Web schema v3 and dispatch domain (2026-09-12)

Checkpoint: `677acbe635f4e79173b97f9c035bbef6195060e1`. Result: PASS
(W1, W2, W3, W14). Evidence class: LOCAL.

**Work performed (test-first):** RED was observed before any source change:

- the new suite could not load, because there was no dispatch module yet;
- the schema and readiness still reported v2;
- the Core accepted a v2 Web and rejected a v3 Web.

GREEN followed with the minimum change.

**Exact changes:**

- **New `web/server/domain/dispatch.js`:** the vocabulary (`CUT_UPLINK`
  only; `PENDING_DISPATCH` / `CORE_CLAIMED` / `EXPIRED`; the seven Core
  evidence stages) and the fixed 120 s TTL.
- **`web/server/repositories/sqliteRepository.js`:**
  - exports `AUDIT_SCHEMA_VERSION = 3`;
  - adds `dispatch_actions` and `dispatch_evidence`, whose CHECK lists are
    built from the domain module;
  - v1 and v2 databases migrate additively; unknown versions still fail
    closed.
- **`web/server/createApp.js`:** readiness requires v3.
- **Cross-component v2 → v3 contract.** This is the same deliberate change,
  applied to files that were not in the plan's Task 1 file list:
  - `aegis_soc/production_runtime.py` (`WEB_AUDIT_SCHEMA_VERSION = 3`);
  - the `tests/test_production_runtime.py` fixtures;
  - the readiness assertion in `deploy/production-like-acceptance.py`.

  Without them the composite runtime would report DEGRADED and the PR9 driver
  would fail.
- **Tests:**
  - new `web/tests/server/dispatchLedger.test.js` (W1 ×3, W2, W14);
  - `sqliteRepository.test.js`: v2 → v3 expectations; the v1 fixtures also
    drop the new tables; W3 for unknown versions 0, 4, and 99;
  - `productionRuntime.test.js`: v3 readiness; W3 for v2 and v4 → 503;
  - `test_production_runtime.py`: v3 fixtures; a stale version (2, 4, or
    none) → DEGRADED.

**Not added yet (by design):** there is no minting, claim, or read API; that
starts in Task 2. W14 uses a SQL fixture until minting exists, and W8 covers
expiry.

| Suite | Result against the Task 0 baseline |
|---|---|
| Vitest | 316/316 in 25 files (+7 tests, +1 file) |
| pytest | 248 passed, 6 skipped (+3 parametrized cases; the same 6 PowerShell 7 skips) |
| Ruff, compileall | clean |
| Vite build | 1,677 modules |
| PR9 acceptance driver | `PRODUCTION_LIKE_VERIFIED`, with the v3 readiness contract |
| PR9 negative controls | 13/13 |
| Repository | 63/63 |
| Vault, policy, diff | pass |

- **Residue:** 0 runtime processes; disposable roots removed.
- **Defects found:** none.
- **Remaining:** Tasks 2–11.
- **Next:** Task 2, on the owner's go-ahead.

#### S2 Task 2 — dispatch action at Admin acceptance (2026-09-12)

Checkpoint: `3f67cd85440599b3ed63ae138da4b05819efd1ac`. Result: PASS
(W4, W5, W14; W8 and W11 for the repository and route side). Evidence class:
LOCAL.

**Work performed (test-first):** RED was observed before each source change.

- 24 dispatch, acceptance, and parity tests failed, because the repository
  functions and the CUT-only guard did not exist and the route minted nothing.
- The 37 configuration tests failed, because there was no dispatch
  configuration yet.

**Behaviour:**

- **Minting:** with dispatch enabled, a newly recorded ACCEPT mints exactly
  one pending `CUT_UPLINK` action. It has a random UUID, and `expires_at` is
  the acceptance time + 120 s. It is written in the same transaction as the
  decision and its audit row, and an injected failure rolls back both.
- **Nothing is minted** for:
  - a rejection;
  - a repeat or a conflict (the existing action is returned instead);
  - Demo Mode;
  - dispatch disabled;
  - an acceptance first recorded while dispatch was disabled (never late).
- **Listing and expiry:** listing expires past-due pending actions once (an
  audited `ACTION_EXPIRED`), then returns the unexpired pending actions,
  oldest first, at most ten. Reading returns the stored state; expiry is
  applied by the list path now, and by the claim path from Task 3.
- **Response:** the acceptance response adds `dispatch` and sets only
  `command_requested`. Publish, ACK, execution, and physical evidence stay
  false.
- **Default:** dispatch is disabled by default, so the PR7/PR9 acceptance
  response is unchanged.

**Configuration (supporting tests):**

- The enable flag accepts only `true` or `false`.
- The internal port must differ from `PORT`.
- The trusted proxy must be one IP address.
- The machine subject must be a lower-case name.
- `AEGIS_IDEA3_DISPATCH_HOST` comes from configuration:
  - one specific IP literal; unspecified and IPv4-mapped forms are rejected;
  - defaults to `127.0.0.1` outside production;
  - in production, an explicit non-loopback value is required.
- The browser listener stays loopback-only.
- `.env.example` gains the keys, empty or `false`.

**Exact changes:**

- **Source:** `web/server/domain/dispatch.js`, `domain/containment.js`,
  `repositories/sqliteRepository.js`, `repositories/memoryRepository.js`,
  `routes/securityRoutes.js`, `config.js`, and `.env.example`.
- **Tests:** `dispatchLedger.test.js`, `containmentAcceptance.test.js`, and
  `config.test.js`.
- **Deliberate change to an existing test:** the parity key list in
  `sqliteRepository.test.js` now includes the two new repository functions.

**Coverage follow-up (`94cfb2bfa750244ef6e8546c9f5edb479168e831`, tests
only).** The owner's Task 2 requirement list was checked against the tests,
and two gaps were closed:

- **Conflict:** an ACCEPT that conflicts with an earlier REJECT mints
  nothing, in both repositories, and the route returns 409.
- **Uniqueness:** every minted action gets its own UUID `action_id`.

The behaviour already existed at `3f67cd85`, so these tests could not be seen
failing against the committed code. Instead, each was shown to detect its
defect with a temporary source mutation, which was never committed:

- **Late minting on a re-recorded decision:** 5 failures — the three new
  conflict tests plus the two existing "never mints late" tests.
- **A fixed, reused `action_id`:** 2 failures. SQLite refused the duplicate
  key; the memory repository produced 1 distinct ID instead of 3.

Each mutation was restored with `git checkout` and verified identical to the
commit, and the tests then passed. After the follow-up:

- Vitest 381/381, with 5 new cases;
- pytest 248 passed, 6 skipped;
- Ruff and compileall clean; Vite 1,677 modules;
- PR9 acceptance `PRODUCTION_LIKE_VERIFIED`; negative controls 13/13;
- repository 63/63;
- vault, policy, and diff pass;
- no interaction-scan match; no source change.

**Still open for Task 3:** W8's claim-410 case and W11's claim side, because
the claim itself is Task 3.

| Suite | Result |
|---|---|
| Vitest | 376/376 in 25 files (+60 against Task 1) |
| pytest | 248 passed, 6 skipped (unchanged) |
| Ruff, compileall | clean |
| Vite build | 1,677 modules |
| PR9 acceptance driver | `PRODUCTION_LIKE_VERIFIED` |
| PR9 negative controls | 13/13 |
| Repository | 63/63 |
| Vault, policy, diff | pass |

- **No Production or hardware interaction:** a scan of the added lines found
  no network, MQTT, subprocess, or hardware call. The only matches were a
  test's SQLite trigger statements on a temporary database.
- **Residue:** 0 runtime processes; disposable roots removed.
- **Defects found:** none.
- **Remaining:** Tasks 3–11.
- **Next:** Task 3, on the owner's go-ahead.

#### S2 Task 3 — machine app, identity, and claim (2026-09-12)

Checkpoint: `5cae52e392ece0d5c3aee45259c161598e1154ae`. Result: PASS
(W6, W7, W9, W10; completes W8's claim-410 case and W11's claim side).
Evidence class: LOCAL.

**Work performed (test-first):** RED was observed before any source change.

- `machineRoutes.test.js` failed to load, because `createMachineApp.js` did
  not exist.
- 11 repository claim tests failed with "`claimDispatchAction` is not a
  function".
- The parity key list failed for the same reason.

The browser-side W10 test is a guard test: it would already have passed
before this change, because the browser app never served machine routes.

**Behaviour:**

- **Separate machine app** (`web/server/createMachineApp.js`):
  - no session, auth, CSRF, static, or Admin route;
  - exact-case `/api/machine/v1` prefix (`/security/api/machine/v1` in
    production);
  - 8 KB strict JSON; `Cache-Control: no-store`; no cookie;
  - it refuses to build unless dispatch is enabled.
- **Identity guard** (`web/server/security/machineIdentity.js`). Every request
  must pass it first:
  - no `Cookie` and no `Origin` header;
  - the socket peer equals the pinned trusted proxy, and forwarded headers are
    ignored;
  - `X-AEGIS-Client-Verify` is exactly `SUCCESS`; a duplicated header is
    refused;
  - the DN has exactly one CN equal to the expected subject; escaped,
    multi-valued, and duplicate CNs are refused.

  A rejection returns 403 and writes no state. An authenticated request
  records machine contact, which Task 4's display will use.
- **Routes** (`web/server/routes/machineRoutes.js`):
  - list the unexpired pending `CUT_UPLINK` actions;
  - claim one with an atomic single-shot `PENDING_DISPATCH → CORE_CLAIMED`,
    in one transaction that expires past-due actions first. It returns 200
    claimed, 404 unknown, 410 expired, 409 already claimed or not
    dispatchable, and 400 for a malformed id or body.

  Listing and claiming re-check the action, so a non-`CUT_UPLINK` row, forced
  in past the schema CHECK, is never listed or claimed.
- **Runtime** (`web/server/runtime.js`, `index.js`): the machine listener
  starts only when dispatch is enabled. It binds the configured
  `AEGIS_IDEA3_DISPATCH_HOST` and `…_PORT` through an injectable `listen()`,
  and shares one repository with the browser app, closed exactly once. With
  dispatch disabled, the PR9 startup is unchanged.

**Files beyond the plan's Task 3 list:** both repositories
(`claimDispatchAction`, because the claim is a repository transaction per spec
§4.6) and `runtime.js`, where server startup actually lives. The parity key
list in `sqliteRepository.test.js` changed deliberately for
`claimDispatchAction`.

**Topology:**

- The listener tests use an injected `listen()` and open no port.
- The loopback trusted peer and bind address are local fixtures, not the
  Production topology. The Production bind, network, and HUB wiring stay
  deferred to K4/K5/K7.

| Suite | Result |
|---|---|
| Vitest | 422/422 in 26 files (+41 against the Task 2 follow-up) |
| pytest | 248 passed, 6 skipped (unchanged) |
| Ruff, compileall | clean |
| Vite build | 1,677 modules |
| PR9 acceptance driver (dispatch disabled) | `PRODUCTION_LIKE_VERIFIED` |
| PR9 negative controls | 13/13 |
| Repository | 63/63 |
| Vault, policy, diff | pass |

- **No Production, hardware, or network interaction:**
  - the added lines contain no MQTT, subprocess, SSH, Twingate, or hardware
    call;
  - the only listener is the runtime's `app.listen` hook, the same call PR9
    made, used by the machine listener only when dispatch is enabled;
  - tests use a fake `listen()` or supertest's local loopback server;
  - two `PRAGMA ignore_check_constraints` statements act on temporary test
    databases.
- **Hygiene:** no injected-defect strings remain in the source.
- **Residue:** 0 runtime processes; disposable roots removed.
- **Defects found:** none.
- **Remaining:** Tasks 4–11.
- **Next:** Task 4, on the owner's explicit approval.

#### S2 Task 4 — evidence ingest and dispatch display (2026-09-12)

Checkpoint: `9314342256f27230e5345ce6be87167086dbe162`. Result: PASS (W12,
W13). With Tasks 1–3, every Web-side case W1–W14 is now covered. Evidence
class: LOCAL.

**Work performed (test-first):** RED was observed before each source change.

- **Server:** 56 failures, because `safeDispatchEvidence`, `dispatchDisplay`,
  and the evidence repository functions did not exist, and the snapshot had
  no overlay (it still read `NOT_REQUESTED`).
- **UI:** 5 of 6 client tests failed, because the new labels and the
  `isAcknowledgedIncident` helper did not exist.
- **The sixth client test, a guard for the demo's `ACKED` state,** failed
  because of a defect in the test itself: the same text appears twice in the
  spotlight. The test was fixed to read each fact row by its label. This guard
  passes both before and after the change.

**Behaviour:**

- **Evidence ingest** (`POST …/dispatch/:actionId/evidence`, machine app,
  identity required). It records one allowlisted Core-reported stage for a
  claimed action.
  - It is append-only and idempotent by `(action_id, sequence)`.
  - It returns 201 recorded, 200 for an identical replay, 409 for a changed
    replay or an unclaimed action, 404 unknown, and 400 outside the allowlist.
  - Only stable codes are stored: `ackCode` `OK` (ACK only), `deviceState`
    (STATUS only), and `reasonCode`, with canonical ISO timestamps and no
    nonce or other field.
- **Display.** The Admin snapshot overlays each incident that has an action
  with a `responseState` and a `dispatch` summary (state, expiry,
  human-review flag, and the containment boundary). Precedence:
  - terminal states first (`OUTCOME_UNKNOWN`, `FAILED`, `EXPIRED_AT_CORE`,
    `EXPIRED`, including a past-due pending action);
  - then `STATUS_CORRELATED` (a LOCKDOWN STATUS only), `ACK_RECEIVED`,
    `PUBLISHED` or `DRY_RUN_ONLY`, and `CORE_CLAIMED`;
  - finally `DISPATCH_PENDING`, or `DISPATCH_UNAVAILABLE` when there has been
    no authenticated machine contact in the last 120 s.
- **No false claims:**
  - `OUTCOME_UNKNOWN` is flagged for human review;
  - no state reads "Contained";
  - evidence is never promoted, so `executed` and `physical_evidence` stay
    false for every combination of evidence (exhaustive test).
- **Contact tracker:** the runtime shares one machine-contact tracker between
  the machine and browser apps.
- **Dashboard:**
  - acknowledgement uses an explicit allowlist (`ACKED`, `ACKNOWLEDGED`,
    `ACK_RECEIVED`, `STATUS_CORRELATED`) instead of a substring match on
    "ACK";
  - when an incident has a dispatch action, acknowledgement follows its ACK
    evidence instead;
  - the new states have Thai, English, and Chinese labels, in key parity.
- **Default:** with dispatch disabled, the snapshot and PR9 behaviour are
  unchanged.

**Refinement — ACCEPTED by the owner (2026-09-12):** spec §4.8 names only
the allowlist. When an incident has a dispatch action, the Dashboard follows
its recorded valid ACK evidence instead. As a result, `OUTCOME_UNKNOWN` after
a real ACK still shows as acknowledged.

- ACK means acknowledgement/receipt only.
- It never implies execution, relay confirmation, physical evidence, or
  successful containment.
- Incidents without a dispatch action keep the fixed-state behaviour.

**Files beyond the plan's Task 4 list:**

- `createApp.js`, `securityRoutes.js`, and `runtime.js` carry the contact
  tracker to the browser app.
- The UI tests are in a new `tests/client/dashboardDispatch.test.jsx` rather
  than `status.test.js`.
- The parity key list changed deliberately for the two evidence functions.

| Suite | Result |
|---|---|
| Vitest | 484/484 in 27 files (+62 against Task 3) |
| pytest | 248 passed, 6 skipped (unchanged) |
| Ruff, compileall | clean |
| Vite build | 1,677 modules |
| PR9 acceptance driver (dispatch disabled) | `PRODUCTION_LIKE_VERIFIED` |
| PR9 negative controls | 13/13 |
| Repository | 63/63 |
| Vault, policy, diff | pass |

- **No Production, hardware, or network interaction:** the added lines
  contain no MQTT, subprocess, SSH, Twingate, network, or hardware call. The
  scan matched only test data (a `MQTT_UNAVAILABLE` reason code and a refused
  `RELAY_EVIDENCE` stage) and the fake `listen()`.
- **Hygiene:** no injected-defect strings remain in the source.
- **Residue:** 0 runtime processes; disposable roots removed.
- **Defects found:** none in the product; one test-construction defect,
  fixed as described above.
- **Remaining:** Tasks 5–11.
- **Next:** Task 5, on the owner's explicit approval.

#### S2 Task 5 — Core dispatch ledger (2026-09-12)

Checkpoint: `9f0f7930f02c5d3b81a4495fa2bc444a3b3ee17d`. Result: PASS (C3,
C4, C6 at the storage level; storage for C1, C5, C7). The owner approved
Batch B (Tasks 5–7) on 2026-09-12. Evidence class: LOCAL.

**Work performed (test-first):** RED was observed before any source change.

- The ledger tests failed to import, because `aegis_soc.dispatch_ledger` did
  not exist.
- The path and child-environment tests failed with "`RuntimePaths` object has
  no attribute `dispatch_db`".

Two more ledger tests were added to the same failing file before the module
existed: a repeated STATUS is recorded once, and a LOCKDOWN STATUS that
arrives before the ACK is still correlated.

**Behaviour:**

- **Separate ledger file:** `<data root>/data/core-dispatch.sqlite3`. The
  hash-chained Core audit database is untouched.
- **Replay guard:** the claim intent is committed before any claim, and a
  replayed action id is refused, including after reopening.
- **Forward-only transitions:** `CLAIM_REQUESTED → CLAIMED → PUBLISHED →
  ACK_RECEIVED → STATUS_CORRELATED`, with terminal `DRY_RUN_ONLY`, `FAILED`,
  `EXPIRED_AT_CORE`, `CLAIM_REJECTED`, and `OUTCOME_UNKNOWN`.
- **Nonce correlation:**
  - the nonce stays Core-local, and ACK and STATUS correlate by nonce only;
    a mismatched nonce is ignored;
  - a non-OK ACK becomes `OUTCOME_UNKNOWN`;
  - a repeated STATUS is recorded once, so periodic device status cannot
    exhaust the server's 1000-sequence limit;
  - a LOCKDOWN STATUS that arrives before the ACK is correlated once the ACK
    arrives.
- **CUT_UPLINK only:** enforced by a code check and a schema CHECK.
- **Outbox:** each reported stage appends one row in the server's evidence
  format (canonical `…sssZ` timestamps and allowlisted detail codes).
  Delivery and rejection dispositions are kept.
- **Recovery and timeouts:** restart recovery and stale-stage timeouts mark
  `OUTCOME_UNKNOWN`, without retry.
- **Threads:** the worker loop and the MQTT callbacks run on different
  threads, so one lock serializes ledger access.
- **Paths:**
  - `RuntimePaths.dispatch_db` is a property derived from the data root, so
    existing constructors and equality tests are unchanged;
  - `AEGIS_CORE_DISPATCH_DB_PATH` is passed in the Core's child environment.

**Exact changes** (all in the plan's Task 5 list):

- new `aegis_soc/dispatch_ledger.py` and `tests/test_dispatch_ledger.py`;
- `aegis_soc/paths.py` and `aegis_soc/production_runtime.py`;
- new tests in `tests/test_paths.py` and `tests/test_production_runtime.py`.

| Suite | Result |
|---|---|
| pytest | 268 passed, 6 skipped (+20: 18 ledger, 1 path, 1 child environment) |
| Ruff, compileall | clean |
| Vitest | 484/484 (unchanged) |
| Vite build | 1,677 modules |
| PR9 acceptance driver | `PRODUCTION_LIKE_VERIFIED` |
| PR9 negative controls | 13/13 |
| Repository | 63/63 |
| Vault, policy, diff | pass |

- **No Production, hardware, or network interaction:**
  - the ledger is local SQLite only, and the tests use temporary paths;
  - no MQTT, network, subprocess, SSH, Twingate, or hardware call was added;
  - the scan matched only a comment, a docstring, and test reason codes.
- **Residue:** no stray database files in the repository; 0 runtime
  processes; disposable roots removed.
- **Remaining:** Tasks 6–11.
- **Next:** Task 6, part of Batch B.

#### S2 Task 6 — Core dispatch client (2026-09-12)

Checkpoint: `ba07feb4295dea6d881a30a7d94c48ef003c1464`. Result: PASS (C2,
C7, C8 at the transport/client level). Evidence class: LOCAL / SIMULATED.

**Preserved continuation work:** the handoff-provided untracked
`aegis_soc/dispatch_client.py` and `tests/test_dispatch_client.py` were inspected
before editing. Their implementation and 30-test suite were valid and complete,
so they were preserved rather than rewritten.

**Behaviour:**

- `DispatchClient` exposes typed `list_pending`, `claim`, and `report` results
  for the approved machine-route contract.
- Action ids are restricted to lower-case UUIDv4 syntax, timestamps use the
  canonical millisecond UTC format, and malformed responses fail as
  `PROTOCOL` without a local side effect.
- The default transport is HTTPS-only `urllib` with a supplied mTLS
  `SSLContext`; missing, relative, or nonexistent CA/certificate/key paths are
  refused before TLS key loading.
- Failures are separated into `NETWORK`, `CREDENTIAL`, `SERVER`, and
  `PROTOCOL`; a definitive report 4xx becomes `REJECTED`, so evidence is not
  retried forever.
- Tests inject a fake transport or patch `urlopen`; no real route, certificate,
  key, Production service, broker, SSH, Twingate, or hardware was contacted.

**Exact changes** (the plan's Task 6 list only):

- new `aegis_soc/dispatch_client.py`;
- new `tests/test_dispatch_client.py`.

| Suite | Result |
|---|---|
| focused dispatch-client pytest | 30/30 |
| full Python pytest | 298 passed, 6 skipped |
| Ruff, compileall | clean |
| Vitest | 484/484 |
| Vite build | 1,677 modules |
| PR9 acceptance driver | `PRODUCTION_LIKE_VERIFIED` |
| PR9 negative controls | 13/13 |
| Repository | 63/63 |
| Vault, policy, diff | pass (two known pre-existing Canvas warnings) |

- **Hygiene:** no certificate, key, database, or log artifact was created in
  the repository; the unrelated local `.agents/skills/obsidian/` and
  `.agents/skills/vibe_coding_obsidian_sync/` paths remained untracked and
  unstaged.
- **Residue:** both disposable PR9 driver roots and redirected bytecode were
  removed; the temporary pinned test environment remains under `/tmp` for the
  next approved task only.
- **Remaining:** Tasks 7–11.
- **Next:** Task 7, the final task in Batch B.

#### S2 Task 7 — Core dispatch worker and supervisor integration (2026-09-12)

Checkpoint: `1e4af6976d407cdafe55d9cfb3f17be0fddbbd14`. Result: PASS; C1–C10
are now covered across Tasks 5–7. Evidence class: LOCAL / SIMULATED.

**Work performed (test-first):** RED was observed before source existed:
`tests/test_dispatch_boundary.py` failed collection because
`aegis_soc.dispatch_worker` did not exist. The first GREEN implementation passed
20 tests; four safety/configuration cases brought the focused suite to 24. An
independent review then found that network/credential failure could return
before local timeout evaluation. Two new tests failed in that exact combination;
timeout evaluation was made network-independent, and the final focused suite
passed 26/26. The reviewer rechecked the fix and reported no remaining finding.

**C1–C10 coverage:**

- **C1/C3:** claim intent is committed before the remote claim; restart turns
  every unresolved action into `OUTCOME_UNKNOWN`; replay never claims or
  publishes again.
- **C2:** the Core skips already-expired actions and rechecks the conservative
  expiry deadline after claim, immediately before publish.
- **C4/C5:** only supervisor-correlated nonces reach the ledger; ACK and STATUS
  remain separate evidence stages; missing ACK/STATUS becomes
  `OUTCOME_UNKNOWN` without retry, including while credentials or the report
  route are unavailable.
- **C6/C9:** only `CUT_UPLINK` reaches the existing
  `AegisSupervisor.issue_command` owner; the worker has no MQTT/controller
  publisher and never passes RESTORE authorization.
- **C7:** outbox evidence is delivered in durable sequence order; network
  failure retains it, identical later delivery is accepted, and definitive 4xx
  rejection is retained and not resent.
- **C8:** missing credential files or TLS/identity failures set
  `PAUSED_CREDENTIAL` before claim/publish. Configuration uses the approved
  `AEGIS_CORE_DISPATCH_*` keys and reloads an mTLS context only when a request
  is attempted.
- **C10:** `AEGIS_CORE_DISPATCH_ENABLED` defaults to disabled, so the supervisor
  constructs no worker and the established PR9 behaviour remains unchanged.

**Exact changes** (the approved Task 7 list only):

- new `aegis_soc/dispatch_worker.py`;
- modified `aegis_soc/supervisor.py` for the optional worker, loop tick, restart
  recovery, correlated callback forwarding, and close;
- new `tests/test_dispatch_boundary.py`.

| Suite | Result |
|---|---|
| focused Task 7 pytest | 26/26 |
| full Python pytest | 324 passed, 6 skipped |
| Ruff, compileall | clean |
| Vitest | 484/484 |
| Vite build | 1,677 modules |
| PR9 acceptance driver | `PRODUCTION_LIKE_VERIFIED`; 2 generations; 0 surviving |
| PR9 negative controls | 13/13 |
| Repository | 63/63 |
| Vault, policy, diff | pass (two known pre-existing Canvas warnings) |

**Driver isolation note:** one intentionally discarded run launched the PR9
acceptance and negative-control process drivers concurrently. Their global
residue checks observed the other driver's loopback processes, so the negative
driver reported 3 failures. No product source was changed for that result. Both
drivers were rerun separately in fresh disposable roots and passed; all roots
were removed and the isolated final runs reported zero surviving processes.

- **Boundaries:** no Twingate, SSH, Production, real MQTT, real certificate/key,
  hardware, IDEA1, IDEA2, shared runtime, firmware, gateway, Compose, or network
  mutation occurred. ACK and protocol-correlated STATUS are not electrical or
  physical proof.
- **Hygiene:** no secret, certificate, key, database, or runtime log was added;
  the unrelated `.agents/skills/obsidian/` and
  `.agents/skills/vibe_coding_obsidian_sync/` paths remained untracked and
  unstaged.
- **Remaining:** Tasks 8, 9, 10, and 11.
- **Next:** STOP FOR OWNER REVIEW. Do not begin Task 8 in this session.

#### S2 Task 8 — shared Web↔Core contract fixture (2026-09-12)

Checkpoint: `82a67326facc358f466423e2912ebe055eee9866`. Result: PASS. The
owner approved the final continuation (Tasks 8–11) on 2026-09-12. Evidence
class: LOCAL / SIMULATED.

**Work performed (test-first):** both contract suites were written before
the fixture existed. RED was then observed for the right reason on each side:

- pytest failed collection with `FileNotFoundError`;
- Vitest failed with `ENOENT`;

both for `tests/fixtures/dispatch-contract.json`.

The first Web RED run failed for a different reason: "The URL must be of
scheme file". Under the jsdom Vitest environment, `import.meta.url` is not a
`file:` URL, so this was a defect in the test itself. It was fixed by
resolving the path from `process.cwd()`, as the other server tests do, and the
Web RED then showed `ENOENT`.

The fixture was then added, and both suites passed without any product-source
change. **No Web/Core contract mismatch was found.**

**What the contract pins**
(`IDEA3-AEGIS_Lockdown/tests/fixtures/dispatch-contract.json`):

- **Actions:** `CUT_UPLINK` only (`RESTORE_UPLINK` never), UUIDv4 action ids,
  the fixed 120 000 ms expiry, and the server states.
- **Evidence format:** canonical millisecond UTC timestamps, the seven
  evidence stages, sequences 1–1000, and the detail allowlist.
- **Machine route:** the paths (`/api/machine/v1`, and
  `/security/api/machine/v1` in production), the response keys, and every
  claim refusal, report outcome, and identity rejection, each with the Core
  result it maps to.
- **Core output:** the exact set of 12 evidence entries the Core emits.
- **Evidence ladder:** no evidence ever implies `executed` or
  `physical_evidence`.

**How both sides consume it:**

- **Core → Web:**
  - The Core test drives the real ledger and worker (fake client, fake
    supervisor, injected clock) through every outcome. Those are: publish,
    dry run, ACK, NORMAL and LOCKDOWN STATUS, a non-OK ACK, the ACK and STATUS
    timeouts, a lost claim response, MQTT unavailable, expiry at the Core,
    and restart.
  - It requires the emitted evidence to equal the contract set exactly, and
    to stay within the allowlist.
  - The Web test requires the server's evidence validator to accept every one
    of those entries.
- **Web → Core:**
  - The Web test requires the machine app to answer with the contract's
    paths, response keys, statuses, and codes, including under the
    production base path.
  - The Core test requires its client to parse the contract's example
    bodies, to use the contract paths, and to map every status and code to
    the contract's Core result.

**Exact changes:**

- new `tests/fixtures/dispatch-contract.json`;
- new `tests/test_dispatch_contract.py`;
- new `web/tests/server/dispatchContract.test.js`.

No product source or configuration changed.

| Suite | Result |
|---|---|
| Contract tests | Web 9/9; Core 7/7 |
| pytest | 331 passed, 6 skipped (+7) |
| Vitest | 493/493 in 28 files (+9, +1 file) |
| Ruff, compileall | clean |
| Vite build | 1,677 modules |
| `git diff --check` | pass |

- **No Production, hardware, or network interaction:** the fixture is test
  data only. Every test uses temporary SQLite files, fakes, and supertest's
  local loopback server.
- **Hygiene:** files were staged by explicit path. The unrelated
  `.agents/skills/obsidian/` and `.agents/skills/vibe_coding_obsidian_sync/`
  paths remain untracked and unstaged.
- **Remaining:** Tasks 9–11.
- **Next:** Task 9 (negative controls NC1–NC5).

#### S2 Task 9 — negative controls NC1–NC5 (2026-09-12)

Checkpoint: `74eb2c99d0c6887ae614a6a75075adcd556e0d56` (test-only C6 gap
fix). Result: PASS. Evidence class: LOCAL / SIMULATED.

**Method.** Each control temporarily broke exactly one invariant, as the
plan's negative-control table defines it:

- **Apply:** a scratch script outside the repository applied the mutation. It
  refused to write unless every anchor occurred exactly once.
- **Observe:** the named tests ran against the mutated source.
- **Restore:** the source was restored immediately with
  `git checkout -- <file>`, and `git diff --quiet` proved there was no
  residue in that file.
- **Rerun:** the same tests were run again on the restored source.

The controls ran one at a time, never concurrently. No injected defect was
committed.

| Control | Mutation (temporary) | Mutated run | Restored run | Verdict |
|---|---|---|---|---|
| NC1 unique dispatch | `dispatch_actions.incident_id` loses `UNIQUE`, and the existing-decision branch of both repositories mints a second action (duplicate guard removed) | 9 W5 tests FAIL: 7 in `dispatchLedger.test.js` (SQLite and memory, including W14/W5 restart) and 2 in `containmentAcceptance.test.js` — e.g. "expected [ …, … ] to have a length of 1 but got 2" | 9/9 PASS | OBSERVED |
| NC2 expiry (plan-exact) | `AND expires_at > ?` and its parameter removed from the claim `UPDATE` | 7/7 W8 PASS | 7/7 PASS | NOT OBSERVED — see below |
| NC2B expiry (gap closure) | NC2, plus the claim's in-transaction `expirePastDueDispatch(now)` sweep removed | SQLite "W8: a past-due action is expired by the claim itself and never claimed" FAILS — `{ status: 'CLAIMED' }` instead of `{ status: 'EXPIRED' }` | 7/7 PASS | OBSERVED |
| NC3 machine identity | the subject comparison removed from the machine identity guard | 6 of 17 W9 FAIL, each "expected 200 to be 403": missing subject, wrong subject, escaped subject, multi-valued RDN, duplicate CN, no CN. The peer, verify, cookie, and Origin cases still pass, as expected | 17/17 PASS | OBSERVED |
| NC4 claim-before-publish | `begin_claim` moved to after `issue_command` | C1 test FAILS: event order `claim`, `issue_command`, `begin_claim` instead of `begin_claim`, `claim`, `issue_command` | 1/1 PASS | OBSERVED |
| NC5 RESTORE rejection (first run) | the worker's `candidate.action == "CUT_UPLINK"` filter removed | 52/52 C6-bearing Core tests PASS (boundary, contract, ledger, and the runtime shutdown test) | 52/52 PASS | NOT OBSERVED — coverage gap, fixed |
| NC5 RESTORE rejection (after the fix) | the same mutation | 3 new C6 cases FAIL with `ValueError: Only CUT_UPLINK can be dispatched`; 52 pass | 55/55 PASS | OBSERVED |

**NC2 finding (no code change).** The claim transaction first expires every
past-due action, using the same `now`, and only then runs the conditional
`UPDATE`. A past-due action is therefore already `EXPIRED` and refused (410)
before the `UPDATE` runs. The `expires_at > ?` clause is a redundant second
guard, so removing it alone cannot change any outcome. NC2B shows that W8
does guard the claim-expiry invariant. The known limitation: the SQL clause
is not independently tested. It is kept as defence in depth.

**NC5 finding (test-only fix, `74eb2c99`).** The approved C6 row requires "a
non-`CUT_UPLINK` pending action is refused" at the worker. No Core worker test
fed one in:

- the Core client only checks that `action` is a string;
- the worker filter is the first guard;
- the ledger's `begin_claim` is the second.

With the filter removed, nothing would be claimed or published: `begin_claim`
raises `ValueError` for any non-`CUT_UPLINK` action. But the tick would raise
instead of skipping the action cleanly, and no test noticed.

The fix adds
`test_c6_a_non_cut_uplink_pending_action_is_refused_without_claim_or_publish`,
parametrized over `RESTORE_UPLINK`, `cut_uplink`, and `""`. Each case is
followed by a valid `CUT_UPLINK`, so the test also proves the valid action is
still claimed and published exactly once. The test passes on the real code
(3/3) and fails under the NC5 mutation.

W11 is on the Web half, so it cannot observe a Core worker mutation. W11
itself was proved in Tasks 2–3 and stays in the regression suite. Task 7's
C1–C10 PASS record stands, with this C6 gap now closed. No product source
changed in Task 9.

**Exact changes:**

- `tests/test_dispatch_boundary.py` — +15 lines, one parametrized test.

**Checks:**

- `tests/test_dispatch_boundary.py`: 29 passed.
- `ruff check`: clean.
- `ruff format --check` flags this file, but the same drift already exists at
  `HEAD` before Task 9 (none of it in the new lines). It is not part of the
  repository's Ruff bar (`ruff check`), and it was left unchanged.
- After all controls:
  - `git status --short` showed only the two unrelated untracked
    `.agents/skills/` paths;
  - `git diff` was empty;
  - `git diff --check` passed.

- **No Production, hardware, or network interaction:** every run used
  temporary SQLite files, fakes, and supertest's local loopback server.
- **Hygiene:** files were staged by explicit path. The unrelated
  `.agents/skills/obsidian/` and `.agents/skills/vibe_coding_obsidian_sync/`
  paths remain untracked and unstaged.
- **Remaining:** Tasks 10–11.
- **Next:** Task 10 (full regression bar).

#### S2 Task 10 — full regression bar (2026-09-12)

Tested HEAD: `ed9efc4e285ea5e5cf2246b869570da5e6e06298` (the Task 9
record). Result: PASS. Evidence class: LOCAL / SIMULATED.

**Order.** The unit suites ran first. The two PR9 drivers then ran one at a
time, never concurrently with each other, after the unit suites had
finished. Dispatch stayed disabled on both halves: no `AEGIS_*` variable was
set in the environment.

| Suite | Command | Exit | Result | Against the Task 0 baseline |
|---|---|---|---|---|
| Python full | `python -m pytest -p no:cacheprovider -q` | 0 | 334 passed, 6 skipped | 245 → 334 (+89) |
| Ruff | `ruff check --no-cache aegis_soc tests windows deploy detector.py sim_auto_detector.py server_admin.py` | 0 | all checks passed | unchanged |
| compileall | `python -m compileall -q aegis_soc deploy windows detector.py server_admin.py sim_auto_detector.py tests` | 0 | pass | unchanged |
| Web full | `npx vitest run` | 0 | 493 passed in 28 files | 309 in 24 → 493 in 28 (+184 tests, +4 files) |
| Web build | `npx vite build` | 0 | 1,677 modules (`dist` is gitignored) | unchanged |
| npm audit, PR9 form | `npm audit --omit=dev --offline` | 0 | 0 vulnerabilities | unchanged |
| npm audit, production deps online | `npm audit --omit=dev` | 0 | 0 vulnerabilities | unchanged |
| npm audit, full online | `npm audit` | 1 | 2 moderate | the same baseline advisory only |
| PR9 acceptance driver | `python deploy/production-like-acceptance.py --data-root <missing disposable path with spaces>` | 0 | `PRODUCTION_LIKE_VERIFIED` on the first run | unchanged |
| PR9 negative-control driver | `python deploy/production-like-negative-controls.py --data-root <missing disposable path with spaces>` | 0 | 13 cases, 0 failed, `PASS` | unchanged |
| Repository | `node --test --test-concurrency=1 tests/*.test.mjs` | 0 | 63 passed, 0 failed (includes the collaboration-policy tests) | unchanged |
| Vault | `node scripts/validate-vault.mjs` | 0 | pass (2 known canvas warnings) | unchanged |
| Diff | `git diff --check origin/main HEAD` | 0 | pass | — |

The Python skips are the same 6 as the baseline: all in
`tests/test_windows_launcher.py`, "PowerShell 7 is required to execute the
bundle staging contract".

**Count changes, explained:**

- **Python +89:** every one is a new S2 Core test, recorded per task in the
  Task 5–9 blocks. The latest are Task 8 (+7, the contract) and Task 9 (+3,
  the C6 worker refusal). No test was removed, and no new skip appeared.
- **Web +184 and +4 files:** the new files are `dispatchLedger.test.js`,
  `machineRoutes.test.js`, `dispatchContract.test.js`, and
  `client/dashboardDispatch.test.jsx`. The changes to existing suites
  (`config`, `containmentAcceptance`, `productionRuntime`, `sqliteRepository`,
  `status`) are the deliberate schema-v3 and dispatch expectations recorded
  in Tasks 1–4.

**npm audit.** The only finding is the known dev-only baseline advisory:
GHSA-82fw-gwwq-j7x9 (moderate), `vitest` via `@vitest/mocker`. Production
dependencies have 0. There is no new finding, and Vitest was not upgraded.

**Acceptance driver details:**

- 2 generations; Web `READY`;
- audit `PERSISTED_ACROSS_RESTART`;
- IDEA1, IDEA2, and MQTT `NOT_CONFIGURED`; ESP32 and physical evidence
  `UNKNOWN`;
- 3 processes per generation, 0 surviving;
- control token `ABSENT`; owner-only permissions; final `STOPPED`;
- `productionMutation = false`.

Each driver created its own data root, which was not pre-created, so the
Task 0 harness failure did not recur.

**Governance and hygiene:**

- **Changed paths (`git diff --name-status origin/main HEAD`):** 44 files, all
  under `IDEA3-AEGIS_Lockdown/` (42) or
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/` (2). None is in IDEA1, IDEA2,
  HUB, NGINX, Docker/Compose, firewall, Twingate, or `.github`. There are no
  key, certificate, SQLite, or `.env` files.
- **Secret scan:** every added line was checked for private-key blocks, cloud,
  GitHub, and Slack token formats, and quoted secret assignments. The only
  hits are the existing test-fixture password `correct-horse-battery-staple`
  (`AEGIS_IDEA3_DEV_PASSWORD` in the Web tests, 15 occurrences already on
  `origin/main`). It is not a credential.
- **Processes:** 0 runtime processes before, between, and after the drivers,
  and no new TCP listeners.
- **Cleanup:** the disposable data roots and the scratch bytecode prefix were
  removed. The gitignored in-repository `__pycache__/` directories (from
  earlier S2 runs) and `.ruff_cache/` were also removed.
- **Tree:** `git status --short` shows only the two unrelated untracked
  `.agents/skills/` paths.
- **Policy validator:** it runs on the final Draft PR body and changed-path
  list in Task 11.

- **No Production, hardware, or network interaction:** no Twingate, SSH, live
  server, real MQTT broker, real certificate or key, or hardware. The online
  `npm audit` queried the public npm advisory registry only.
- **Remaining:** Task 11.
- **Next:** Task 11 (closeout, one S2 receipt, Draft PR; stop before Ready).

### PR11 — live cross-IDEA and authorized E2E: OPEN

```text
LIVE_IDEA1_SERVICE_EVENT_FEED = OPEN
LIVE_IDEA2_SERVICE_EVENT_FEED = OPEN
SHARED_CORRELATION_KEY = OPEN
ADMIN_ACCEPTED_TO_CORE = OPEN
CORE_TO_MQTT_TO_ESP32_E2E = OPEN
AUTHORIZED_KALI_E2E = OPEN
PHYSICAL_CUT_E2E = OPEN
RESTORE_RECOVERY_E2E = OPEN
```

### PR12 — final acceptance: OPEN

```text
REBOOT_ACCEPTANCE = OPEN
BACKUP_RESTORE_ACCEPTANCE = OPEN (documented only)
ROLLBACK_ACCEPTANCE = OPEN (documented only)
FINAL_SECURITY_REGRESSION = OPEN
FINAL_REAL_E2E_RERUN = OPEN
EVIDENCE_FREEZE = OPEN
REPORT_BASELINE = OPEN
PRODUCTION_COMPLETE_DECISION = OPEN
REAL_TELEGRAM_PRODUCTION_DELIVERY = NOT VERIFIED
IDEA3_PRODUCTION_COMPLETE = NO
```

### Pre-flight reconciliation task record — historical

Task: IDEA3 PR10 pre-flight evidence audit and Obsidian reconciliation
Branch: `docs/idea3-pr10-preflight-evidence-reconciliation`
Owner: `music`
PR: GitHub PR #119, merged into `main` at `895c79ac8ab9b39f322919fabc9facfdc34ba20b`
Current state: CLOSED — documentation-only; merged
Started: 2026-09-11
Base SHA: `9ea9bbfcf40128f4565bc4ba37ba008a62c4879c`
Production mutation allowed: NO
Hardware testing: NOT RUN

### Pre-flight Session Register — historical

| ID | Scope | State | Evidence | Checkpoint | Result | Remaining | Next |
|---|---|---|---|---|---|---|---|
| S1 | Git, GitHub, source, and receipt audit; canonical reconciliation | CLOSED | this section; vault validation, collaboration-policy tests, `git diff --check` | documentation-only commit (SHA in the PR) | PASS | — (merged via #119) | PR10 S1 inventory (see PR10 Current Task above) |

### Pre-flight handoff — historical (superseded by the PR10 Current Task)

Next action at that checkpoint: human review of this reconciliation PR. Then, under a separately
authorized task, design the PR10 split-host deployment and the Server-to-Core
durable accepted-action boundary starting from the PR9 composite runtime. Do not
deploy, install systemd, contact a broker, ESP32, relay, or network device,
restore the Windows standalone as the deployment target, or let an agent merge.

---

## Project-sequence PR5 Final Hardware Closure — MERGED (2026-09-11)

```text
PR5 FINAL HARDWARE CLOSURE = MERGED / OWNER LAB EVIDENCE ACCEPTED
PR5 PR #117 MERGE COMMIT = 58f19f2051170685757627a6baea90b264a877c4
PR9_PR115_PR5_GATE = SATISFIED
PR9 #115 = MERGED at 2c21cc3e5843bcd75eb1dd2b7f607a745cce254d (S7 PASS / S8 CLOSED)
TOTAL_CONTROL_POWER_LOSS_FAIL_SECURE = NOT PROVEN
TWINGATE_FINAL_RELAY_CYCLE_AUTO_RECOVERY = NOT CLAIMED / NOT CONCLUSIVELY VERIFIED
MECHANICAL_BREADBOARD_STABILITY = PROTOTYPE LIMITATION
IDEA3_PRODUCTION_COMPLETE = NO
```

This PR records owner-observed evidence; Codex did not flash firmware, reset the
ESP32, publish a hardware command, change network state, or manipulate the
circuit. The firmware semantic contract is unchanged:

```text
GPIO27 LOW  = LOCKDOWN / CUT
GPIO27 HIGH = NORMAL / RESTORE
```

### Accepted final topology and polarity

```text
ESP32 GPIO27
  ├─ 10 kΩ pull-down → GND
  └─ ULN2003 IN1

ULN2003
  + → +5 V
  - → common GND
  OUT1 → Relay IN node

Relay IN node
  ULN2003 OUT1 + 10 kΩ pull-up → +5 V
Relay VCC/DC+ → +5 V
Relay GND/DC- → common GND
trigger jumper → H

Ethernet Pin 2
  TP-Link side Pin 2 → Terminal CH1 → Relay COM → Relay NC
  → Terminal CH2 → Beelink side Pin 2
Relay NO unused
```

ULN2003 OUT1 was continuity-verified against chip pin 16. External inversion
produces the required fail-secure relay semantics:

- GPIO27 LOW → ULN OFF / OUT high-impedance → 10 kΩ pull-up drives Relay IN
  HIGH → high-trigger relay activates → COM-NC opens → Pin 2 CUT.
- GPIO27 HIGH → ULN ON → OUT sinks Relay IN LOW → relay releases → COM-NC
  closes → Pin 2 restored.
- RESTORE/NORMAL LEDs: red power ON, green trigger OFF, network passes.
- CUT/LOCKDOWN LEDs: red power ON, green trigger ON, network blocked.

### Physical RJ45 continuity — PASS

```text
RESTORE: 1 2 3 4 5 6 7 8
CUT:     1 _ 3 4 5 6 7 8
RESTORE: 1 2 3 4 5 6 7 8

PHYSICAL_LOCKDOWN_PIN2=PASS
PHYSICAL_RESTORE_PIN2=PASS
```

This establishes the selected Pin 2 contact behavior only; cable-tester
continuity is not treated as Ethernet traffic proof.

### Powered electrical reset-window 1B — PASS within stated scope

Starting from CUT with Pin 2 absent, Pin 2 remained absent while EN was held,
after release/reboot, and after the ESP32 and broker reconnected. Reconnect did
not auto-restore the uplink. Only an explicit authenticated RESTORE returned
Pins 1–8.

```text
RESET_WINDOW_1B=PASS
RECONNECT_DOES_NOT_AUTO_RESTORE=PASS
EXPLICIT_RESTORE_REQUIRED=PASS
```

The pass applies only while the relay/control circuit remains powered.
Total-control-power-loss fail-secure behavior is **NOT PROVEN**; if relay power
is lost, the relay's mechanical NC path may reconnect.

### Router/Switch real Ethernet E2E — PASS

Accepted baseline topology and addresses:

- MikroTik VLAN 10 gateway: `192.168.10.1`.
- Beelink: `192.168.10.10` on `VLAN10-Server`.
- Laptop: `192.168.30.99`; VLAN 30 gateway: `192.168.30.1`.
- MikroTik ping from `192.168.10.1` to Beelink: 5/5, 0% loss.
- Beelink ARP was reachable on `VLAN10-Server`; direct laptop → Beelink SSH
  succeeded.

During RESTORE, continuous ping and SSH succeeded. During CUT, ping returned
`Destination Host Unreachable`/no replies and the existing SSH session froze.
After RESTORE, ping resumed and a **new** SSH session succeeded; the old severed
SSH session was not used as the recovery criterion.

```text
REAL_ETHERNET_RESTORE_BASELINE=PASS
REAL_ETHERNET_CUT=PASS
REAL_ETHERNET_RESTORE_RECOVERY=PASS
SSH_CUT_EFFECT=PASS
SSH_POST_RESTORE_RECONNECT=PASS
```

### Twingate and prototype limitations

Direct-LAN Beelink reachability, ping to `1.1.1.1`, DNS resolution for
`api.twingate.com`, and HTTPS/TLS passed. After earlier I/O errors, the
connector was manually restarted once and observed progressing Offline →
Authentication → Authentication → Online; a teammate then confirmed
connectivity on the direct-LAN baseline.

```text
TWINGATE_DIRECT_BASELINE=PASS
TWINGATE_CONNECTOR_HEALTH_AFTER_MANUAL_RESTART=PASS
TWINGATE_FINAL_RELAY_CYCLE_AUTO_RECOVERY=NOT CLAIMED / NOT CONCLUSIVELY VERIFIED
```

The final relay CUT → RESTORE automatic Twingate recovery was not conclusively
rerun without restart. Breadboard, ESP32, and jumper movement also caused
intermittent bring-up behavior; the final sequence passed after reseating and
stabilization. Strain relief and a secure PCB/interconnect remain required for
deployment-grade use.

---

## ⚡ Hardware & Firmware Architecture

```mermaid
sequenceDiagram
    autonumber
    actor SOC as SOC Responder / System Rule
    participant Backend as AEGIS Headless Core
    participant Broker as Secure MQTT Broker
    participant ESP32 as ESP32 Microcontroller
    participant Relay as Physical Door Lock / Power Relay

    SOC->>Backend: 1. Trigger Physical Lockdown Command
    Backend->>Backend: 2. Generate Nonce & Calculate HMAC-SHA256 Signature
    Backend->>Broker: 3. Publish HMAC-signed payload to 'aegis/lockdown/cmd'
    Broker->>ESP32: 4. Forward MQTT Payload (Message + Nonce + HMAC)
    ESP32->>ESP32: 5. Verify HMAC Signature & Check Nonce replay attack
    alt Verification Success
        ESP32->>Relay: 6. Drive configured GPIO path (hardware result unverified)
        ESP32-->>Broker: 7. Device-reported nonce-correlated ACK + STATUS
    else Verification Failed / Replay Attack
        ESP32->>ESP32: 8. Ignore Command & Log Security Alert
    end
```

---

## 🛠️ Physical Security Features

* **HMAC-SHA256 Validation**: Firmware source rejects commands whose signature does not match; this branch verifies the contract through tests and compile-only evidence.
* **Anti-Replay Attack (Nonce)**: Firmware source tracks single-use nonces and now echoes command correlation through ACK/command-triggered STATUS.
* **Dead Man's Switch**: The source contract sends heartbeat every 15 seconds and triggers Deadman after 60 seconds without heartbeat. Fresh physical testing observed RJ45 Pin 2 disappear after timeout, remain absent after reconnect, and return only after explicit authenticated RESTORE.

---

## ⚙️ Headless Core / Command & Physical Evidence track

Personal planning label: **IDEA3 PR4**. The Headless Core publication from
`feat/idea3-headless-core-pr4` was merged through
[GitHub PR #91](https://github.com/kraveerachat/Project-End-The-AEGIS/pull/91)
and is part of the current canonical `main` baseline. Historical source
checkpoints remain recorded below for traceability.

### Fix1A application startup and Deadman physical E2E — PASS (2026-09-08)

- Application state now initializes as `LOCKDOWN`; the active-low relay value is preloaded with `RELAY_TRIGGER` before GPIO27 becomes an output, so the application-startup GPIO27 state is LOW.
- Regression `test_firmware_boots_relay_in_fail_secure_state` protects the locked initial state, trigger polarity, absence of a setup-time release, and preload-before-output ordering.
- Physical post-flash boot observation: RJ45 Pin 2 was absent after application startup.
- Source timing contract: heartbeat interval = 15 seconds; Deadman timeout = 60 seconds.
- Explicit RESTORE/NORMAL: `1 2 3 4 5 6 7 8`.
- Deadman timeout: `1 _ 3 4 5 6 7 8`.
- Heartbeat/MQTT reconnect without RESTORE: `1 _ 3 4 5 6 7 8`; reconnect does not auto-RESTORE.
- Explicit authenticated RESTORE after reconnect: `1 2 3 4 5 6 7 8`.

Fresh canonical Task 4 verification on `fix/idea3-fail-secure-boot-deadman-e2e`:

- Fix1A regression — **1 passed**.
- Relay/controller/firmware/runtime focused tests — **44 passed**.
- Full Python suite — **63 passed**.
- Ruff and compileall — **PASS**.
- Project-local dependencies — `pytest 9.1.1`, `ruff 0.16.3`, `paho-mqtt 2.1.0`; `pip check` passes.
- PlatformIO — **compile-only SUCCESS**, RAM 46,588/327,680 bytes (14.2%), Flash 789,325/1,310,720 bytes (60.2%); final `firmware.bin` 795,904 bytes, SHA256 `2b2ebb37c79f8e8751b1f3a8ebec682d3c0825bc77dcbbfb6982ad984e8065a7`.
- Repository policy tests — **56 passed, 0 failed**; their nested Git fixtures required normal `/tmp` process permissions after the sandboxed run returned `EPERM`.
- Vault validation — **PASS** with two pre-existing owner-data canvas warnings; neither canvas changed.
- No firmware upload/flash, ESP32 reset/power-cycle, hardware change, command publication, or production deployment occurred during this canonical PR execution.

> [!warning] Historical pre-PR5 1B observation — SUPERSEDED
> The 2026-09-08 checkpoint observed Pin 2 returning while EN was held and therefore left 1B open. Project-sequence PR5 later accepted a powered external pull-down/inverting-driver topology in which Pin 2 remained absent through EN/reset and reconnect. The historical result remains here for traceability; the current evidence and power-loss boundary are recorded above.

> [!info] Historical PR4 deferral — CLOSED BY PR5 OWNER EVIDENCE
> The 2026-09-08 checkpoint deferred Router/Switch real Ethernet E2E. Project-sequence PR5 now records RESTORE traffic works → CUT traffic fails → RESTORE traffic and a new SSH connection recover. IDEA3 remains not production-complete for the separate open items above.

### Operational mode ownership — CLOSED

- Core owns the operational safety gate `ARMED` / `DISARMED` independently from the `auto_contain` policy.
- Default Core operational mode is `ARMED`.
- `set_armed(armed, origin)` persists the mode and audits the previous/current value plus origin.
- While `DISARMED`, detector events remain observable/auditable but automatic containment cannot publish `CUT_UPLINK`.
- Historical source checkpoint: `e2aa6acd`.

### Command ownership — CLOSED

- `AegisSupervisor.issue_command()` is the public Core command-lifecycle entry point and delegates signing/publication to the existing controller.
- A sent command creates Core-owned pending state containing `action`, `sent_at`, and `nonce`.
- Automatic detector containment uses the same `issue_command()` path rather than a second command implementation.
- Historical source checkpoint: `1ab38dfc`.

### ACK nonce correlation — CLOSED

- Firmware ACK includes the parsed command nonce for valid/rejected command paths where a nonce exists; malformed JSON uses an empty nonce.
- MQTTManager forwards `(ack, detail, nonce)` to Core.
- Missing or mismatched ACK nonce is ignored and audited fail-closed; only the matching pending command can be acknowledged.
- The legacy GUI callback accepts the nonce and duplicate ACK callback binding was removed.
- Historical source checkpoint: `1ab38dfc`.

### ACK versus physical evidence — CLOSED at protocol lifecycle level

```text
Requested != Published != ACK != Executed != Relay Confirmation != Physical Evidence
```

- ACK success alone never proves relay or network isolation.
- CUT expects `LOCKDOWN`; RESTORE expects `NORMAL`; the opposite state cannot confirm the command.
- `ACK → STATUS` and `STATUS → ACK` are both retained without later evidence overwriting earlier evidence.
- ACK timeout and physical-confirmation timeout are separate; physical confirmation waits `8` seconds after ACK.
- A CUT physical timeout degrades runtime when no LOCKDOWN truth exists.
- A RESTORE timeout cannot hide current `LOCKDOWN` physical truth.
- Late matching physical evidence is accepted while the original `physical_timeout_at` history remains recorded.
- Historical source checkpoint: `1ab38dfc`.

### Task 2D6 Physical STATUS correlation — IMPLEMENTED / CLOSED

- Approved design: `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-04-idea3-physical-status-correlation-design.md` (`ad0c3d37`).
- Command-triggered CUT/RESTORE STATUS includes `command_nonce` (`12f207f1`).
- Boot, periodic heartbeat, Deadman, and Secure Boot STATUS remains uncorrelated.
- MQTTManager forwards optional `command_nonce`; the legacy GUI accepts the expanded callback signature.
- Every valid STATUS may update device/uplink physical truth, including uncorrelated fail-secure STATUS.
- Active command evidence changes only when `STATUS.command_nonce` matches the tracked command nonce; confirmation additionally requires the expected physical state.
- Missing/mismatched correlation is ignored for command completion and audited without false confirmation (`cfb6efe2`).

### Historical PR4 verification — 2026-09-06

- Python: `pytest -p no:cacheprovider -q` — **62 passed**; final pre-review rerun completed in 0.38s.
- Ruff: scoped check of `aegis_soc`, detector entry points, and tests — **All checks passed**.
- Python compileall — **PASS**.
- Firmware: `platformio run -d firmware` — **compile-only SUCCESS**, RAM 46,572/327,680 bytes (14.2%), Flash 789,309/1,310,720 bytes (60.2%).
- Repository tests: `node --test --test-concurrency=1 tests/*.test.mjs` — **56 passed, 0 failed**.
- Collaboration policy — **PASS**.
- Vault validation — **PASS** with two pre-existing owner-data canvas warnings; neither canvas is changed by PR #91.
- Secret/path scan — **PASS**; no real `.env`, `secrets.h`, private-key/token signature, recording, or generated firmware output is included.
- GitHub `collaboration-guardrails` — **PASS** on PR #91.
- `git diff --check origin/main...HEAD` — **PASS** after documentation reconciliation.
- No firmware upload, flash, serial write, MQTT connection, command publication, GPIO/relay action, network change, or deployment occurred.

### Follow-up evidence audit — CLOSED

- Filled the previously missing actual PR #91 state and repository/policy/vault/secret/GitHub-check results.
- Corrected the architecture description from encrypted traffic to the implemented HMAC-signed payload and the actual `aegis/lockdown/cmd` topic.
- Relabelled historical standalone hardware tables so they cannot be mistaken for fresh PR4 evidence.
- `MISSING_FROM_OBSIDIAN=NONE` after this reconciliation for the requested PR4 checklist.

### Still open at the historical 2026-09-08 checkpoint

- 1B electrical reset-window mitigation/validation; GPIO27 may be high-impedance before application code runs.
- Task 3 Router/Switch real Ethernet E2E in the final hardware-closure PR.
- Production Web → Core → MQTT live integration remains open; durable Web audit persistence is closed by PR6.
- Full migration of remaining GUI-owned operational state/heartbeat behavior into the Core/API boundary where duplication still exists.

Protocol-correlated STATUS remains device-reported evidence, not direct electrical
measurement of relay contacts. At this historical checkpoint the cable-tester
Deadman path was observed while Router/Switch traffic isolation and reset-window
mitigation were still **NOT_COMPLETED**. The newer PR5 section above supersedes
that old open-state assessment without rewriting its historical evidence.

---

## 🖥️ Security Center implementation status (2026-09-04)

The first repository implementation is established under `IDEA3-AEGIS_Lockdown/web/` as an Admin-only React/Vite interface with an Express security boundary. It provides 11 operational pages: Dashboard, Overview, IDEA1 Security, IDEA2 Detection, IDEA3 Lockdown, Alerts, Incidents, Audit, Devices, Recovery, and Settings.

Implemented and locally verified:

- canonical evidence states `HEALTHY`, `DEGRADED`, `FAILED`, `UNKNOWN`, `NOT_CONFIGURED`, `STALE`, and `DISABLED`;
- allowlisted read-only adapters for IDEA1, IDEA2, and IDEA3 runtime data, including malformed/future/stale evidence rejection;
- same-origin Admin session, CSRF enforcement, login throttling, security headers, and fail-closed production configuration;
- event deduplication and same-IP correlation within a bounded time window (SUPERSEDED: PR7 replaced the same-`sourceIp` heuristic with deterministic `correlation_key` correlation);
- clearly isolated Demo mode for UI review;
- alert acknowledgement, incident notes, bounded audit export, settings validation, and recovery validation as audited server-side actions;
- architecture-first Overview with an explicit environment/provider/persistence boundary, validated evidence flow, per-IDEA integration contracts, a freshness-aware matrix, and visible production-readiness gaps; runtime ACK and requested mode remain distinct from physical relay proof;
- conservative `HEALTHY` evidence gating: evidence must be `FRESH` and include a parseable validation timestamp; missing or malformed timestamps fail closed to `UNKNOWN`;
- desktop/tablet/mobile layouts, light/dark themes, and UI styling derived from IDEA1's design language without modifying IDEA1 source.

Historical Overview-pass evidence (GitHub PR #87): affected client regressions pass 31/31; the full web suite passes 102/102 across 15 files; `npm run build` succeeds with 1,677 modules transformed; repository UI detection returns `[]`; and fresh browser QA at desktop and the 390×844 mobile preset finds no document-level horizontal overflow or console errors in Light or Dark themes. At the narrow preset, the Live comparison table scrolls inside its wrapper (241/609) and the Demo table does the same (241/567) rather than overflowing the page.

Known limitations:

- IDEA1, IDEA2, and IDEA3 live endpoints are not configured or integration-tested in this task;
- operational snapshot state remains runtime-owned, while Web audit records are durable in SQLite (schema version 1 under PR6; additive schema version 2 since PR7);
- the browser has no MQTT, relay, isolation, broker-secret, signing-secret, or recovery-execution endpoint; Recovery is dry-run validation only;
- production deployment, gateway routing, external identity provider, and live cross-IDEA integration remain deferred; final real-hardware closure was later accepted within the PR5 owner-evidence boundary.

---

## PR6 verified closure and PR7 inventory/design baseline — 2026-09-08

### VERIFIED IMPLEMENTATION

- GitHub PR #101 merged PR6 into `main` at
  `5f30bc54f8603195ed9618e755fe3726ea343bb6`; every listed PR6 commit is an
  ancestor of that merge.
- PR6 established durable SQLite schema version 1 audit persistence with WAL,
  reopen/restart durability, bounded Admin reads, allowlisted sanitization, and
  HTTP 503 fail-closed behavior when an audit write cannot be persisted.
- PR6 also established production session-secret and bcrypt policy, disabled
  development login in production, throttled login failures, and durably
  audited authentication and operational-failure events.
- Exactly one PR6 receipt exists:
  `90-Status/logs/2026-09-08_111604_music_idea3-production-reliability.md`.
- Inventory classification totals are `VERIFIED=26`, `STALE_DOC=1`,
  `MISSING_EVIDENCE=0`, and `UNRESOLVED=3`.
- `web/server/providers/liveProvider.js` still presents the Audit Store as
  `In-memory repository` with `MEMORY_ONLY` provenance. This contradicts the
  durable PR6 Web audit implementation and is a PR7 source correction; the
  runtime-owned event snapshot store remains non-durable.

### VERIFIED TEST EVIDENCE

- Fresh verification on the PR7 base: Python **63/63**, Ruff **PASS**,
  compileall **PASS**, Web **168/168 across 18 files**, Web build **PASS** with
  1,677 modules, offline production dependency audit **0 vulnerabilities**,
  repository tests **56/56**, firmware compile-only **PASS**, and vault
  validation **PASS** with two known unchanged owner-data canvas warnings.
- The firmware compile used the checked-in placeholder secrets header in an
  isolated copy. Its output hash is intentionally not compared with the
  historical secret-dependent binary hash.
- Initial failures caused by an unintended PlatformIO Python, old global
  dependencies, missing Node modules, and a missing local firmware header were
  environmental. Clean isolated reruns using pinned project dependencies
  produced the results above.

### HISTORICAL PHYSICAL EVIDENCE

- Fix1A application-start behavior and the Deadman → relay → RJ45 cable-tester
  path remain verified historical evidence. They were not physically rerun for
  PR7 and do not prove the pre-application reset window, router/switch traffic
  isolation, or total-power-loss fail-secure behavior.

### PR7 CONTRACT INVENTORY — DESIGN ONLY

- `IDEA1_CONTRACT=PARTIAL`: `GET /api/audit` exposes bounded current audit data
  only to a human Admin session, omits a stable event ID and explicit severity,
  and does not provide a service-to-service read boundary.
- `IDEA2_CONTRACT=PARTIAL`: Monitor alert/detection routes require human
  session/RBAC; its internal API-key routes are write-only. The Detection
  Engine recent-events route is unauthenticated, sensitive, non-durable, and
  unsuitable as a production feed.
- `IDEA3_ADAPTER_BASE=PARTIAL`: the current Web adapters send no integration
  credential and assume producer schemas that do not match current IDEA1,
  IDEA2, or the Python runtime status file. Fetch success currently substitutes
  for event-time freshness.
- `AEGIS_IDEA1_STATUS_URL`, `AEGIS_IDEA2_STATUS_URL`,
  `AEGIS_IDEA3_RUNTIME_STATUS_URL`, `AEGIS_MAX_EVIDENCE_AGE_MS`, and
  `AEGIS_ADAPTER_TIMEOUT_MS` are all `USED_IN_SOURCE`. Direct environment-key
  wiring assertions do not exist, so none is classified `USED_AND_TESTED`.
- The approved PR7 direction is upstream-owned, versioned, bounded read-only
  event feeds protected by dedicated integration credentials, translated by
  IDEA3-only adapters. Human-session automation, direct database reads, and
  the unauthenticated Detection Engine ring buffer are rejected.
- The normalized event design requires stable source event IDs and event-time
  freshness. Cross-IDEA correlation additionally requires fresh eligible
  IDEA1 + IDEA2 evidence with the same non-null reviewed correlation key inside
  ten minutes. Current upstream source does not supply that common key.
- The lifecycle stops at `Containment Accepted`. All command-request,
  publication, ACK, execution, and physical-evidence fields remain false.
- Design:
  `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-08-idea3-pr7-live-security-integration-design.md`.
- Implementation plan:
  `IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-08-idea3-pr7-live-security-integration.md`.

### OPEN / NOT PROVEN — 2026-09-08 roadmap numbering (SUPERSEDED)

> [!warning] Superseded project numbering
> The PR8–PR12 labels below are the 2026-09-08 plan. Hardware closure later
> shipped as project PR5 (#117), Windows as PR8, and runtime preparation as PR9.
> Current PR10–PR12 scope is in "PR10 pre-flight evidence reconciliation".

```text
IDEA1_IDEA3_LIVE_EVENT_INTEGRATION = OPEN / PR7 (upstream feed absent)
IDEA2_IDEA3_LIVE_EVENT_INTEGRATION = OPEN / PR7 (upstream feed absent)
CROSS_IDEA_EVENT_NORMALIZATION = IMPLEMENTED_UNEXERCISED / PR7
CROSS_IDEA_INCIDENT_CORRELATION = IMPLEMENTED_UNEXERCISED / PR7
CROSS_IDEA_CONTAINMENT_ACCEPTANCE = IMPLEMENTED_UNEXERCISED / PR7
1B_RESET_WINDOW = OPEN / PR8
ROUTER_SWITCH_REAL_ETHERNET_E2E = OPEN / PR8
KALI_E2E = OPEN / PR9
WINDOWS_EXE = OPEN / PR10
PRODUCTION_DEPLOYMENT = OPEN / PR11
FINAL_SYSTEM_ACCEPTANCE = OPEN / PR12
IDEA3_PRODUCTION_COMPLETE = NO
```

No PR7 application source, upstream source, firmware, MQTT behavior, hardware,
network, production data, deployment, or physical system was changed by this
inventory/design baseline.

---

## PR7 IDEA3-side implementation — 2026-09-08

### IMPLEMENTED AND TESTED (IDEA3 source only)

- Canonical cross-IDEA event contract in
  `web/server/domain/integrationEvents.js`. `event_type` is restricted to the
  single reviewed value `ACCESS_DENIED`, so the design-only `CAMERA_TAMPER`
  value is rejected before normalization and can never become
  containment-eligible. `subject` is always emitted as `null`, so raw human
  names and other privacy-sensitive producer free text cannot survive
  normalization; both properties are regression-tested.
- Read-only source adapters in `web/server/providers/` over a shared HTTP
  boundary: GET-only, `Accept: application/json`, per-source bearer credential,
  redirect rejection, non-`http(s)` URL rejection, 2.5 s timeout, 256 KiB
  response limit, `schema_version=1` envelope, and a 500-event bound. Neither the
  credential nor a raw body is ever returned in a result.
- Two new configuration keys, `AEGIS_IDEA1_INTEGRATION_TOKEN` and
  `AEGIS_IDEA2_INTEGRATION_TOKEN`, are per-source and default to absent. The
  five previously documented adapter keys now have direct configuration-wiring
  assertions and are therefore `USED_AND_TESTED`.
- `liveProvider` no longer treats fetch success as evidence freshness. Envelope
  freshness and per-event freshness are evaluated separately, stale/future
  evidence stays observable but containment-ineligible, and a stale envelope
  raises the new `ADAPTER_EVIDENCE_STALE` operational error.
- `liveProvider` audit provenance corrected to `SQLITE_AUDIT_ONLY` with the Audit
  Store reported as a durable SQLite store; the event snapshot store is reported
  honestly as `RUNTIME_ONLY` and is still not persisted.
- Deterministic correlation in `web/server/domain/correlate.js`: eligible
  IDEA1 + IDEA2 evidence sharing one validated non-null `correlation_key` inside
  the ten-minute window, sorted by `occurred_at` then `source:event_id`, with a
  stable hashed incident ID. The only produced state is
  `CONTAINMENT_CANDIDATE`. The former same-`sourceIp` heuristic is removed.
- Containment acceptance boundary: `POST /api/security/incidents/:id/containment`
  under Admin + same-origin + CSRF. It is idempotent for a repeated identical
  decision, returns HTTP 409 on the opposite decision, is denied in Demo Mode,
  and always returns `command_requested`, `command_published`, `acknowledged`,
  `executed`, and `physical_evidence` as `false`. A source-level test asserts the
  route and domain import no controller, MQTT, broker, firmware, or command
  module.
- Additive SQLite schema **version 2** adds `containment_decisions`,
  `integration_lifecycle`, and `correlated_incidents`. Every schema v1 table and
  audit row is preserved and a v1 database is migrated in place on reopen.
- Durable integration lifecycle audit using only `ADAPTER_FAILURE`,
  `ADAPTER_RECOVERED`, `EVENT_REJECTED`, `EVENT_ID_CONFLICT`,
  `INCIDENT_CORRELATED`, `CONTAINMENT_ACCEPTED`, and `CONTAINMENT_REJECTED`.
  Coalescing is durable across restart: one row per active failure period, one
  recovery row per validated recovery, one row per stable conflict, and one row
  per stable correlated incident. Demo Mode writes none of them.
- Python `aegis_soc.runtime.safe_status_projection()` exports a versioned,
  allowlisted runtime projection (`schemaVersion`, `generatedAt`, canonical
  `status`, allowlisted `components`, `modes`, `issues`, `evidenceSource`). Free
  text `detail`, `pid`, paths, addresses, and configuration values are dropped
  rather than sanitized, and a missing or malformed document fails closed to
  `RUNTIME_STATUS_ABSENT`.

### VERIFIED TEST EVIDENCE — 2026-09-08

- Python `pytest -p no:cacheprovider -q` — **80 passed** (63 baseline plus 17 new
  runtime-projection tests).
- `ruff check aegis_soc detector.py sim_auto_detector.py tests --no-cache` —
  **All checks passed**.
- Python `compileall` — **PASS**.
- Web `npm test` — **277 passed across 22 files** (168 on the PR7 base).
- Web `npm run build` — **PASS**.
- `npm audit --omit=dev --offline` — **0 vulnerabilities**.
- Repository `node --test --test-concurrency=1 tests/*.test.mjs` — **56 passed**.
- `git diff --check` — **PASS**.
- Vault validation — **PASS** with the two pre-existing owner-data canvas
  warnings; neither canvas changed.
- No MQTT connection, command publication, ACK, firmware compile or flash, relay
  action, network change, production database access, deployment, or physical
  evidence claim occurred. Every adapter test used an injected fetch stub; no
  real upstream host was contacted.

### NOT PROVEN — LIVE INTEGRATION REMAINS OPEN

- No reviewed IDEA1 or IDEA2 service event feed exists in current source, so the
  adapters were never exercised against a real producer. `IDEA1_SERVICE_EVENT_FEED`
  and `IDEA2_SERVICE_EVENT_FEED` remain `ABSENT` and both live integrations stay
  `OPEN`.
- No reviewed shared cross-IDEA `correlation_key` exists upstream, so no real
  cross-IDEA incident has been produced. Correlation and containment acceptance
  are implemented and unit-tested but unexercised against live evidence.
- The reviewed privacy-safe contract carries no source IP, so live IDEA1/IDEA2
  evidence tables and the live incident view render no `sourceIp`. Demo Mode is
  unaffected. Rebinding those views to the new contract is deliberately not part
  of PR7.
- `web/server/domain/normalize.js` still exports the legacy
  `normalizeIdea1Event` / `normalizeIdea2Event` producer shims. They are no longer
  reachable from `liveProvider` and remain only for their own direct tests.
- Firmware was not compiled for PR7: no firmware path changed, so a compile would
  add no evidence.

---

## PR7 merge reconciliation and PR8 Windows standalone decision — 2026-09-08

### VERIFIED CURRENT GIT STATE

- Project-sequence PR7 is merged through GitHub PR #104. Current `main` and
  `origin/main` both resolve to merge commit
  `c68946cbe917a71349a8234a4bc028fbf4c6967d`.
- The PR7 inventory/design split in GitHub PR #106 and the PR7 implementation
  receipt both remain reachable from `main`. Historical receipts remain
  immutable and are not rewritten to add later merge facts.
- PR7 live-source limitations are unchanged: both upstream service feeds and a
  reviewed shared correlation key remain absent, so correlation and containment
  acceptance remain `IMPLEMENTED_UNEXERCISED` against real producers.

### PR8 CHECKPOINT

```text
PROJECT_SEQUENCE = PR8_WINDOWS_EXE_STANDALONE_RUNTIME
BASE_SHA = c68946cbe917a71349a8234a4bc028fbf4c6967d
BRANCH = feat/idea3-windows-standalone-pr8
ARCHITECTURE = LAUNCHER_EXE_PLUS_BUNDLED_COMPONENTS_ONEDIR
STATUS = LINUX_IMPLEMENTATION_COMPLETE / WINDOWS_ACCEPTANCE_BLOCKED
WINDOWS_BUILD_EVIDENCE = NOT_RUN
WINDOWS_SMOKE_EVIDENCE = NOT_RUN
IDEA3_PRODUCTION_COMPLETE = NO
```

> Superseded by the PR8 implementation section below. Implementation plan Tasks
> 1-10 and 12 are complete on Linux; Task 11 Windows build and clean-machine
> smoke acceptance is BLOCKED pending a real Windows x64 machine.

- The approved package separates an immutable application payload from external
  writable configuration, databases, logs, and runtime state under
  `%LOCALAPPDATA%\AEGIS\IDEA3` by default.
- A PyInstaller one-folder launcher will supervise packaged Python Core and a
  pinned Node runtime, while Express serves the prebuilt React application at
  `/security/` on loopback only.
- Linux-only detector, UFW, voice, audio, and Tk operator surfaces are not
  represented as working Windows components. Missing IDEA1/IDEA2 feeds remain
  `NOT_CONFIGURED` or `UNAVAILABLE`; absent device, relay, and physical evidence
  remain `UNKNOWN`.
- Design:
  `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-08-idea3-pr8-windows-standalone-design.md`.
- Implementation plan:
  `IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-08-idea3-pr8-windows-standalone.md`.

### PROJECT-SEQUENCE ROADMAP AS OF 2026-09-08 — SUPERSEDED

> [!warning] Superseded roadmap
> This roadmap placed hardware closure at PR10. It shipped as project PR5
> (#117) instead. Current PR10–PR12 scope is in "PR10 pre-flight evidence
> reconciliation".

```text
PROJECT PR6 Production Reliability = CLOSED / MERGED
PROJECT PR7 Cross-IDEA Integration Boundary = CLOSED / MERGED
PROJECT PR8 Windows EXE / Standalone Runtime = LINUX IMPLEMENTATION COMPLETE / WINDOWS ACCEPTANCE BLOCKED
PROJECT PR9 Production Runtime / Deployment Preparation = OPEN
PROJECT PR10 Final Hardware Closure = OPEN / WAITING FOR PHYSICAL COMPONENTS
PROJECT PR11 Kali Cross-IDEA Security E2E = OPEN
PROJECT PR12 Final System Acceptance = OPEN

IDEA1_SERVICE_EVENT_FEED = OPEN
IDEA2_SERVICE_EVENT_FEED = OPEN
SHARED_CORRELATION_KEY = OPEN
LIVE_CROSS_IDEA_EXERCISE = OPEN
IDEA3_PRODUCTION_COMPLETE = NO
```

No PR8 application behavior, package, Windows build, deployment, network,
firmware, MQTT publication, relay action, or physical test is claimed at this
checkpoint.

---

## PR8 Windows standalone implementation — 2026-09-09

### IMPLEMENTED AND TESTED (Linux source side only)

- External runtime path contract in `aegis_soc/paths.py`: writable configuration,
  databases, logs, and runtime state resolve outside the installed payload, under
  `%LOCALAPPDATA%\AEGIS\IDEA3` by default with an absolute-path `AEGIS_DATA_DIR`
  override and an `AEGIS_CONFIG_FILE` override for the config file alone.
- Cross-platform single-instance locking in `aegis_soc/platform_lock.py`: IDEA3
  imports on Windows without `fcntl` while Linux locking semantics are preserved.
- Honest Windows capability projection in `aegis_soc/runtime.py`: dry-run, absent
  hardware, and Linux-only capabilities are never promoted to `HEALTHY`;
  `UNKNOWN` / `UNAVAILABLE` / `DEGRADED` stay as reported.
- Production Web runtime in `web/server/runtime.js` and `web/server/createApp.js`:
  `/security` base path, safe health route, hashed-asset caching, SPA/API
  separation, and idempotent HTTP/SQLite shutdown.
- Launcher control and lifecycle in `aegis_soc/windows_launcher.py`: loopback-only
  control API, token-protected stop, Core-then-Web start order, Web-first
  shutdown, and cleanup on partial startup failure.
- Secure configuration provisioning: `write_configuration()` writes the external
  `.env` atomically. The operator password only ever reaches the bcrypt hasher
  (`web/server/passwordHash.js`, stdin-only, cost 12); the session secret is
  generated locally; integration and MQTT values are written blank so an
  unconfigured install fails closed instead of inheriting a bundled credential.
- Evaluator commands `configure`, `status`, `open`, `logs`, `doctor`: `status`
  returns non-zero for any state other than `RUNNING`, `open` reaches a browser
  only after Web health succeeds, and `doctor` validates locally without
  contacting or actuating the broker, device, or relay and without echoing any
  configuration value.
- Deterministic packaging inputs in `windows/`: PyInstaller 6.22.2 and Node
  24.20.0 x64 pinned with SHA-256, a one-folder spec, a fail-fast `build.ps1`
  that refuses a dirty tree or a hash mismatch and scans the payload for secret
  and forbidden artifacts, and `smoke.ps1` clean-machine acceptance.

### VERIFIED TEST EVIDENCE — 2026-09-09 (Arch Linux)

- Python `pytest tests -q` — **145 passed**.
- `ruff check aegis_soc tests windows detector.py sim_auto_detector.py` — **All checks passed**.
- Python `compileall` — **PASS**.
- Web `vitest run` — **292 passed across 24 files**.
- Web production build — **PASS**.
- `npm audit --omit=dev --offline` — **0 vulnerabilities**.
- Repository `node --test tests/*.test.mjs` — **56 passed, 0 failed**.
- Vault validation — **PASS** with the two pre-existing owner-data canvas
  warnings; neither canvas changed.
- `git diff --check` — **PASS**.
- No forbidden or generated path is introduced by this branch; the only
  non-`IDEA3-AEGIS_Lockdown/` path changed is this canonical note.

### WINDOWS ACCEPTANCE — STAGING BUNDLE PASSED AT `c7cdc2b2`; CURRENT SHA NOT VERIFIED

> [!note] Historical record as of 2026-09-09
> This block records only the `c7cdc2b2` staging-bundle evidence. Current PR8
> acceptance state is in "PR8 merge reconciliation — 2026-09-10" below.

```text
WINDOWS_BUILD_VERIFIED_AT_c7cdc2b2 = YES
WINDOWS_STAGING_BUNDLE_SMOKE_AT_c7cdc2b2 = PASS (25 checks, 0 failed)
WINDOWS_EXTRACTED_ZIP_SMOKE_AT_c7cdc2b2 = NO
WINDOWS_BUILD_VERIFIED_FOR_CURRENT_SHA = NO
WINDOWS_SMOKE_VERIFIED_FOR_CURRENT_SHA = NO
PR8_IMPLEMENTATION_PLAN_TASK_11 = ACCEPTANCE PENDING
BLOCKER = the post-main-sync SHA requires a fresh Windows build and extracted-ZIP smoke
```

- Real Windows build at `c7cdc2b2e70e4224a756b53f3e87363b55c9ea58`:
  Python **202 passed**, Web **298 passed across 24 files**, Vite build PASS,
  PyInstaller PASS, production npm install PASS, forbidden-artifact and manifest
  checks PASS, ZIP PASS, and final BUILD OK. Artifact
  `AEGIS-IDEA3-c7cdc2b2e70e.zip`, SHA-256
  `faaeaea5259647dea0292d6cc6db286fea540162c41c8a8d63a8eaa774a93694`.
- Real Windows smoke at that SHA passed **25 checks with 0 failed** against the
  freshly built staging bundle at `windows/out/AEGIS-IDEA3`: configuration,
  Core/Web RUNNING status, Admin login, `Secure; HttpOnly; SameSite=Strict`
  cookie validation, audit read, honest absent-integration/hardware states,
  logout, stop/restart, audit persistence, external durable DB, no surviving
  bundle children, and clean completion.
- This is not extracted-ZIP acceptance. The attempted extraction wrapper had an
  interactive PowerShell `if/elseif` parsing mistake, so `BundlePath` remained
  `windows/out/AEGIS-IDEA3` instead of the extracted ZIP directory.
- Core root cause: generated blank `AEGIS_BROKER_PORT` was parsed with
  `int("")`; its Thai import-time fallback diagnostic then raised
  `UnicodeEncodeError` under `cp1252`. The fix treats blank broker settings as
  explicitly unconfigured, uses a safe default port without import-time output,
  disables MQTT connection startup when unconfigured, fails live mode closed,
  and restores the approved default lab/headless/dry-run launcher profile.
- Smoke root cause: acceptance called unprefixed `/api/...` URLs even though
  production mounts `/security/api/...`; `/security/healthz` also hit the SPA
  fallback rather than the JSON health route. All acceptance URLs now derive
  from one `/security/api` base.
- Secure-cookie audit: `express-session` suppresses a production Secure cookie
  on ordinary HTTP. IDEA3 now recognizes only a proven loopback request as the
  browser-trusted localhost context while retaining `Secure`, `HttpOnly`, and
  `SameSite=Strict`. Smoke validates those attributes, carries the opaque cookie
  explicitly because PowerShell does not implement the browser localhost
  exception, and supplies the required CSRF token on logout.
- `origin/main` advanced to `d32885b36c08c71dc5719109de12ed8ac8f6589e`
  during Windows acceptance and was merged normally with no conflicts. The
  resulting implementation/evidence checkpoint is
  `8214792022a4d29672227f6637e8399a7f1e189c`.
- Fresh Arch verification at that reconciled checkpoint: focused Python **161
  passed, 6 skipped**; focused Web **58 passed**; full Python **196 passed, 6
  Windows-only skipped**; Web **298 passed across 24 files**; Vite build PASS
  with 1,677 modules; Ruff PASS; compileall PASS with cache redirected to
  `/tmp`; production npm audit **0 vulnerabilities**; repository tests **57
  passed**; vault validation PASS with the two unchanged owner-data canvas
  warnings.

The `c7cdc2b2` build and staging-bundle smoke are historical evidence for that
exact SHA only. They do not verify the post-merge SHA and do not substitute for
fresh extracted-ZIP smoke acceptance.

### STILL OPEN

```text
PROJECT PR8 = SEE "PR8 merge reconciliation — 2026-09-10"
IDEA1_SERVICE_EVENT_FEED = OPEN
IDEA2_SERVICE_EVENT_FEED = OPEN
SHARED_CORRELATION_KEY = OPEN
LIVE_CROSS_IDEA_EXERCISE = OPEN
CROSS_IDEA_EVENT_NORMALIZATION = IMPLEMENTED_UNEXERCISED
CROSS_IDEA_INCIDENT_CORRELATION = IMPLEMENTED_UNEXERCISED
CROSS_IDEA_CONTAINMENT_ACCEPTANCE = IMPLEMENTED_UNEXERCISED
IDEA3_PRODUCTION_COMPLETE = NO
```

No MQTT connection or publication, ACK, relay CUT/RESTORE, firmware compile or
flash, network change, production database access, deployment, or physical
evidence occurred during PR8.

---

## PR8 merge reconciliation — 2026-09-10

PR8 source is merged through GitHub PR #107 at
`f320bbf55456450406fe0c5547848fbdce099a96`, and the PR8 head
`25fb442d15cdf2037817c9e63add4d7e96bcd568` is reachable from current `main`.

```text
PR8_FINAL_WINDOWS_ACCEPTANCE_AT_25fb442d = PASS (owner-reported, 2026-09-10)
PR8_FINAL_EXTRACTED_ZIP_SMOKE_AT_25fb442d = PASS, 25/25 checks (owner-reported)
PR8_CANONICAL_DOCUMENTATION = STALE / MISSING THE FINAL EVIDENCE
PR8_RECEIPT = UNCHANGED (historically partial)
```

- The project owner reports that final PR8 Windows acceptance exists for
  `25fb442d`, including the final extracted-ZIP smoke with 25/25 checks passed.
  Earlier statements in this note and in the PR9 records that PR8 extracted-ZIP
  acceptance was absent described missing canonical documentation, not missing
  Windows acceptance.
- The final evidence itself — build result, ZIP digest, and smoke transcript for
  `25fb442d` — is not yet recorded in this note, in `04_SESSION_HANDOFF.md`, or
  in the PR #107 description, which at merge still listed the extracted-ZIP smoke
  as pending. Recording those artifacts here is an owner follow-up. PR9 did not
  rerun or observe Windows acceptance, so this is owner-supplied evidence.
- The 2026-09-09 block above remains the historical `c7cdc2b2` staging-bundle
  record. The immutable PR8 receipt
  `90-Status/logs/2026-09-09_022203_music_idea3-pr8-windows-standalone.md` keeps
  `status: partial` as recorded at its own checkpoint and is not edited.

## Historical Task — PR9 Production Runtime (MERGED)

Task: PR9 Production Runtime / Deployment Preparation
Branch: `feat/idea3-production-runtime-pr9`
Owner: `music`
PR: [#115](https://github.com/kraveerachat/Project-End-The-AEGIS/pull/115) — merged by a human reviewer at `2c21cc3e5843bcd75eb1dd2b7f607a745cce254d` (2026-09-10T21:41:47Z)
Current state: CLOSED / MERGED — S1-S8 CLOSED
Started: 2026-09-10
Base SHA: `50ce6e1638c6bcdb2a378a3cee660050b9cb41d8`
Last implementation checkpoint: `c7a1a7af7bc346b86a96f2f9bcb8a6f9ffce29aa` (Telegram outbound pre-gate)
Final implementation/evidence checkpoint: `e5863fc664e239b78f37dd4ce663bc1186f22744`
(S7 `origin/main` sync; every S7 gate ran at this tree)
Production mutation allowed: NO
PR5 dependency: MERGED at `58f19f2051170685757627a6baea90b264a877c4` — `PR9_PR115_PR5_GATE = SATISFIED`
Final receipt: `90-Status/logs/2026-09-11_040839_music_idea3-pr9-production-runtime.md`

### Goal

Finalize and locally verify the Core+Web production service lifecycle,
configuration, paths, readiness, persistence, authentication, notifications,
and operations boundary after reconciling the merged PR5 hardware evidence.

### Scope

IDEA3-owned server runtime source, tests, service example, operations runbook,
isolated production-like acceptance, and truthful Git/Obsidian reconciliation.

### Out of scope

Production deployment, Kali E2E, MQTT publication, firmware/relay changes,
network changes, live IDEA1/IDEA2 feeds, and new physical acceptance.

### Safety boundaries

Use only disposable local paths, loopback listeners, generated test-only
credentials, and absent/injected dependencies. Do not touch Production or
hardware. Every S7 gate passed before S8 created the one receipt and requested
Ready. An agent never merges PR #115.

### Acceptance criteria

S1-S6 must produce source-backed design, a TDD plan, strict production contracts,
Core+Web lifecycle/readiness evidence, focused negative regressions, a clean
production-like isolated acceptance, an operations runbook, and exact evidence.
S7 must pass completely before S8 creates the final receipt and requests Ready.
Met: S7 PASS at `e5863fc6`; S8 CLOSED with one receipt.

## PR9 Session Register — CLOSED

| ID | Scope | State | Evidence | Checkpoint | Result | Remaining | Next |
|---|---|---|---|---|---|---|---|
| S1 | Runtime inventory/design/plan | CLOSED | Source, tests, Git ancestry, PR5 ref and PR8 evidence audited; source-backed design and TDD plan committed | `6a1cee51a87786a3af1f9849d16c60a0db786f87` | PASS | none | start S2 |
| S2 | Production config/path contract | CLOSED | strict production Web numerics + absolute audit DB path (`b55fcf1f`); server settings, external data root, payload paths, `.env.example` (`de42b990`); config and settings tests green | `de42b990c17ff1da564b0663535b4669942c3737` | PASS | none | S3 |
| S3 | Lifecycle + readiness | CLOSED | `/security/api/readiness` (`b55fcf1f`); composite Core+Web lifecycle, fail-on-child-exit, status model, CLI (`4e789af1`); lifecycle tests green | `4e789af14ff8f73e34a2b747a72d8fc7c02b9cee` | PASS | none | S4 |
| S4 | Persistence/auth/fail-closed regressions | CLOSED | focused MQTT/runtime/controller/core suites 80 passed at `d66b44aa`; adapter/provider/correlation, SQLite/reliability, and config/auth/security Web suites green at `15b5b94a` and inside the full Web 309/309 at `d66b44aa`; committed negative controls 13/13 | `d66b44aad1a4083181617e0cba4cfa12cc285deb` (evidence SHA) | PASS | none | S5 |
| S5 | Production-like isolated acceptance | CLOSED | driver `8d4c76bb`; clean-stop defect fixed `15b5b94a`; driver now measures service states, process residue, and owner-only permissions (`0cf2b007`); reproducible negative-control driver (`d66b44aa`); measured run `PRODUCTION_LIKE_VERIFIED` | `d66b44aad1a4083181617e0cba4cfa12cc285deb` | PASS | none | S6 |
| S6 | Runbook + evidence reconciliation | CLOSED | runbook, composite service example, README (`2b64b565`); reconciliation (`32a62fe1`); truth-model correction and PR8 wording (`0a97248f`); this pre-PR5 closure record; vault, policy, diff, secret and artifact checks | `2b64b565a731f0eb4af6236cb96cebdd14fca048`; `0a97248f9fcb4e5ea3a7f50e1e03eaeed5c08ad1` | PASS | none | stop at PR5 gate |
| S7 | PR5 merge sync + final acceptance | CLOSED | PR #117 merged at `58f19f20`; normal `origin/main` merge `e5863fc6` audited; full Python 245/6 skipped, Web 309/309, Vite, Ruff, compileall, npm audit 0, repository 63/63, vault, policy, diff/secret/artifact scans, `PRODUCTION_LIKE_VERIFIED`, negative controls 13/13 — see "S7 post-PR5 sync and final acceptance" | `e5863fc664e239b78f37dd4ce663bc1186f22744` | PASS | none | S8 |
| S8 | Final closeout / receipt / review | CLOSED | canonical state, handoff section 45, merge-mislabelled headings corrected, one receipt `2026-09-11_040839_music_idea3-pr9-production-runtime.md`; vault/policy/diff/secret/artifact rerun | receipt-bearing closeout commit (SHA in PR #115) | PASS | human review and merge | human reviewer |

S2-S5 source commits were produced by an earlier session on this branch without a
register update. They were re-verified at the current tree before being recorded
here; no evidence below is carried forward from that session.

### Task Status Dashboard

| Area | Status | Evidence / Note |
|---|---|---|
| Design and plan | CLOSED | `6a1cee51` |
| Source implementation | LOCAL VERIFIED | full Python and Web suites at post-sync `e5863fc6` |
| Negative regressions | PASS | focused suites plus the committed negative-control driver, 13/13 at `e5863fc6` |
| Production-like isolated acceptance | PASS — `PRODUCTION_LIKE_VERIFIED` | disposable loopback lab/headless/dry-run only, rerun at `e5863fc6` |
| Telegram outbound pre-gate | LOCAL VERIFIED | `c7a1a7af`; network faked; `REAL_TELEGRAM_API_CALLED = NO` |
| Operations runbook | DOCUMENTED | not exercised on a host |
| systemd installation | NOT RUN | `deploy/aegis-idea3.service.example` is an example |
| Production deployment | NOT RUN | `PRODUCTION_MUTATION_ALLOWED = NO`; `PRODUCTION_DEPLOYED = NO` |
| PR5 gate | SATISFIED | PR #117 merged at `58f19f20` |
| PR5 sync and final acceptance (S7) | CLOSED / PASS | `e5863fc6` |
| Receipt, Ready, review (S8) | CLOSED / PASS | one receipt; PR #115 merged at `2c21cc3e` |

### Git reconciliation

| Commit | Session | Content |
|---|---|---|
| `6a1cee51` | S1 | source-backed design and TDD plan |
| `1e6cec43` | S1 | S1 documentation checkpoint |
| `b55fcf1f` | S2/S3 | strict production Web numerics, absolute audit DB path, readiness route |
| `de42b990` | S2 | `ProductionSettings`: external `AEGIS_DATA_DIR`, explicit payload paths, loopback and distinct ports, `.env.example` keys |
| `4e789af1` | S3 | `ProductionRuntime`, fail-on-child-exit and peer cleanup in the shared launcher, status model, `start/stop/restart/status/doctor` |
| `2b64b565` | S6 | runbook, composite service example replacing the Core-only example, README routing |
| `8d4c76bb` | S5 | isolated acceptance driver and contract tests |
| `15b5b94a` | S5 | fix: truthful clean-stop service status |
| `32a62fe1` | S6 | documentation checkpoint for S2-S6 |
| `0a97248f` | S6 | configured-but-unprobed IDEA1/IDEA2 service status reads `UNKNOWN`; PR8 canonical wording reconciled |
| `0cf2b007` | S5 | acceptance driver measures service states, process-tree residue, final stop, and owner-only permissions |
| `d66b44aa` | S4/S5 | reproducible fail-closed negative-control driver and contract tests |
| `5578e08c` | S6 | pre-PR5 closure documentation checkpoint |
| `97f03921` | S6 | MQTT service-status truth correction |
| `c7a1a7af` | S6 addendum | Telegram outbound-only pre-gate: fail-soft, secret-safe, one alert per observed transition |
| `e5863fc6` | S7 | normal `origin/main` merge after PR #117 (`58f19f20`); three IDEA3 document conflicts reconciled |
| closeout commit | S8 | canonical reconciliation and the one receipt (SHA in PR #115) |

`de42b990` is the plan's Task 2 commit. It was verified in place and is
preserved unchanged. Every commit above is on the first-parent line from
`50ce6e16`; `e5863fc6` is a normal merge, and nothing was rebased or force-pushed.

### File reconciliation

| Path | Change | Before → after |
|---|---|---|
| `IDEA3-AEGIS_Lockdown/aegis_soc/production_runtime.py` | added | no server owner for Core+Web → validated composite owner, status projection, CLI |
| `IDEA3-AEGIS_Lockdown/aegis_soc/windows_launcher.py` | modified | child death left the owner running `DEGRADED` → owner fails, cleans the peer, removes the token, exits 1; duplicate start leaves the running status/token untouched |
| `IDEA3-AEGIS_Lockdown/web/server/config.js` | modified | malformed production numerics silently defaulted; relative audit DB accepted → both rejected at startup in production |
| `IDEA3-AEGIS_Lockdown/web/server/createApp.js` | modified | liveness only → separate schema-v2 readiness (200 `READY` / 503 `DEGRADED`) |
| `IDEA3-AEGIS_Lockdown/.env.example` | modified | relative audit DB default → blank (service derives it); server payload keys documented |
| `IDEA3-AEGIS_Lockdown/deploy/aegis-idea3.service.example` | added | composite hardened unit, `UMask=0077`, `ReadWritePaths=/var/lib/aegis-idea3` |
| `IDEA3-AEGIS_Lockdown/deploy/aegis-supervisor.service.example` | deleted | Core-only unit contradicted the Core+Web topology |
| `IDEA3-AEGIS_Lockdown/deploy/production-like-acceptance.py` | added | isolated two-generation acceptance driver that measures service states, process residue, and owner-only permissions |
| `IDEA3-AEGIS_Lockdown/deploy/production-like-negative-controls.py` | added | 13-case loopback-only fail-closed negative-control driver |
| `IDEA3-AEGIS_Lockdown/tests/test_production_like_negative_controls.py` | added | negative-control contract tests |
| `IDEA3-AEGIS_Lockdown/docs/operations/production-runtime.md` | added | server runbook |
| `IDEA3-AEGIS_Lockdown/README.md` | modified | PR9 operator routing; current PR5-gate/PR9 header |
| `IDEA3-AEGIS_Lockdown/tests/test_production_runtime.py` | added | settings, status, stop, restart, CLI, terminal-status tests |
| `IDEA3-AEGIS_Lockdown/tests/test_production_like_acceptance.py` | added | driver contract tests |
| `IDEA3-AEGIS_Lockdown/tests/test_windows_launcher.py` | modified | child-exit, duplicate-start, no-RESTORE tests |
| `IDEA3-AEGIS_Lockdown/web/tests/server/config.test.js` | modified | strict numeric and audit-path tests |
| `IDEA3-AEGIS_Lockdown/web/tests/server/productionRuntime.test.js` | modified | readiness tests |
| `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-10-idea3-pr9-production-runtime-design.md` | added | design |
| `IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-10-idea3-pr9-production-runtime.md` | added | plan |
| `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md` | modified | PR9 handoff sections 39-43 and 45; inherited PR5 section renumbered 44 |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` | modified | this task record |
| `IDEA3-AEGIS_Lockdown/aegis_soc/comms.py` | modified | synchronous alert that logged exception text → daemon-thread dispatch with fixed secret-safe failure wording |
| `IDEA3-AEGIS_Lockdown/aegis_soc/mqtt_client.py` | modified | alert on every `LOCKDOWN`/`NORMAL` STATUS (missing state defaulted to `NORMAL`) → one alert per observed transition; missing state never notifies; alert failure isolated |
| `IDEA3-AEGIS_Lockdown/tests/test_comms.py` | added | missing-config, daemon-thread, fail-soft/secret-safe tests |
| `IDEA3-AEGIS_Lockdown/tests/test_mqtt_client.py` | modified | transition/suppression and failure-isolation tests |
| `IDEA3-AEGIS_Lockdown/PROGRESS.md` | modified | stale "PR #115 blocked until PR5" header → PR5 merged / gate satisfied |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md` | modified | stale PR5-blocked entry statement → merged gate and PR9 review state |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-11_040839_music_idea3-pr9-production-runtime.md` | added | the one final PR9 receipt |

Configuration contract: production Web requires an absolute audit DB path and
well-formed numerics; the composite service requires an absolute
`AEGIS_DATA_DIR` outside the payload. Schema state: Web audit stays at schema v2;
no schema change or migration was added.

### Maturity by capability

| Capability | Implemented | Automated tests | Local runtime | Documented | Open |
|---|---|---|---|---|---|
| Strict production Web config | yes | yes | yes (acceptance) | yes | — |
| Liveness vs readiness | yes | yes | yes (200 `READY`; unusable DB → Web exits → `FAILED`) | yes | — |
| Composite lifecycle and crash cleanup | yes | yes | yes | yes | systemd install |
| Service status model | yes | yes | yes | yes | MQTT preserves Core evidence: unconfigured `NOT_CONFIGURED`, configured/unprobed `UNKNOWN`, observed disconnect `UNAVAILABLE`, connected `CONNECTED` |
| Backup, restore, upgrade, rollback, secret rotation | procedure only | no | no | yes | host exercise |
| MQTT delivery, ESP32, relay, WAN isolation | unchanged | existing only | no | yes | PR9 claims none; PR5 owner lab evidence merged via #117 (top section) |
| Telegram outbound notification | yes | yes (network faked) | no | yes | real delivery unverified |

### Work performed and defects — this session

- Verified HEAD `8d4c76bb`, the seven commits over `50ce6e16`, and `de42b990`.
- Defect introduced by this task (`4e789af1`), found by the first isolated
  acceptance run: after a clean stop, `runtime/service-status.json` recorded
  `status: STOPPED` but `components: {core: FAILED, web: FAILED}` and
  `audit: DEGRADED`, because the terminal write probed the Web readiness route it
  had just stopped. RED: the new parametrized test failed 2/2 on the probe. Fix
  `15b5b94a`: terminal writes skip the probe, report audit `UNKNOWN`, and map a
  clean stop to `STOPPED` components as the PR8 launcher already did. GREEN, and
  acceptance run 2 recorded the corrected terminal state.

### Tests / Evidence — 2026-09-10

```text
host = Arch Linux; python = 3.14.7 venv (pytest 9.1.1, ruff 0.16.3, paho-mqtt 2.1.0, pip check clean); node = v24.16.0
source_sha = 8d4c76bb (before fix) / 15b5b94a (after fix)

Full Python  pytest -p no:cacheprovider -q        = 218 passed, 6 skipped @8d4c76bb; 220 passed, 6 skipped @15b5b94a
Ruff         ruff check --no-cache aegis_soc tests windows deploy detector.py sim_auto_detector.py server_admin.py = PASS
compileall   aegis_soc deploy detector.py server_admin.py sim_auto_detector.py = PASS (pycache redirected outside the tree)
Full Web     npx vitest run                        = 309 passed across 24 files (Web source unchanged by the fix)
Vite build                                         = PASS, 1677 modules
npm audit --omit=dev --offline                     = 0 vulnerabilities
Repository   node --test --test-concurrency=1 tests/*.test.mjs = 63 passed, 0 failed
Focused lifecycle: production_runtime + windows_launcher + acceptance + paths = 119 passed, 6 skipped
Focused S4 Python: mqtt_client + runtime + controller + core                  = 80 passed
Focused S4 Web: adapters/provider/normalize/correlate/events/containment      = 112 passed (6 files)
Focused S4 Web: sqliteRepository + productionReliability                      = 45 passed (2 files)
Focused S4 Web: config/auth/security/securityRoutes/productionRuntime/passwordHash = 72 passed (6 files)
```

### Truth-model correction — 2026-09-10

`runtime/service-status.json` reported a configured IDEA1/IDEA2 feed as
`UNAVAILABLE` although this status source never contacts the feeds. It now
reports `UNKNOWN`; `UNAVAILABLE` is reserved for a dependency that was checked
and found unavailable, and no network probe was added. The Web snapshot remains
the feed-evidence authority.

- RED: `test_service_snapshot_reports_configured_but_unprobed_feeds_as_unknown`
  failed with `assert 'UNAVAILABLE' == 'UNKNOWN'`; it also asserts that only the
  readiness URL is probed.
- GREEN in `aegis_soc/production_runtime.py`.
- The PR8 records were reconciled: owner-reported final Windows acceptance at
  `25fb442d` (including the extracted-ZIP 25/25 smoke) versus stale canonical
  documentation. See "PR8 merge reconciliation — 2026-09-10".

```text
source_sha = 0a97248f9fcb4e5ea3a7f50e1e03eaeed5c08ad1
Focused lifecycle: production_runtime + windows_launcher + acceptance + paths = 120 passed, 6 skipped
Focused S4 Python: mqtt_client + runtime + controller + core                  = 80 passed
Full Python  = 221 passed, 6 Windows-only skipped
Ruff = PASS; compileall = PASS
Full Web     = 309 passed across 24 files (Web source unchanged)
Vite build   = PASS, 1677 modules; npm audit --omit=dev --offline = 0 vulnerabilities
Repository   = 63 passed, 0 failed
Isolated acceptance run 3 = PRODUCTION_LIKE_VERIFIED; final components STOPPED, audit UNKNOWN
Negative controls run 4 = 10/10 PASS; configured IDEA1/IDEA2 service status = UNKNOWN
Vault validation = PASS (2 known canvas warnings); collaboration policy = PASS
Secret/artifact scan = 0 findings; git diff --check = PASS
```

Loopback listeners and nested Git fixtures were permitted in this session; no
sandbox `EPERM` occurred. The first vault-validation call failed with
`MODULE_NOT_FOUND` because a relative script path resolved from the Web
directory; the absolute-path rerun passed with the two known canvas warnings.

### Pre-PR5 closure — measured acceptance and committed negative controls

- Task 6 gap closed in `0cf2b007`. The driver had reported IDEA1, IDEA2, MQTT,
  and physical evidence as constants, and it inferred cleanup from the Web
  listener alone. It now reads the running `service-status.json` and requires
  audit `READY`, IDEA1/IDEA2/MQTT `NOT_CONFIGURED`, and ESP32/physical evidence
  `UNKNOWN`. It records the service owner's whole process tree by parent link and
  start time, which also covers Core components started in new sessions, and
  requires none of it to survive each stop. It requires a final `STOPPED` status
  with `STOPPED` components and rejects any group/world-accessible path under the
  data root. RED: 5 new contract tests failed before the helpers existed.
- Task 5 gap closed in `d66b44aa`. The session-local harness is now the committed
  `deploy/production-like-negative-controls.py` with contract tests. RED: test
  collection failed because the module did not exist. The first GREEN attempt
  hit two tooling-only problems: the test loaded the module without registering
  it in `sys.modules`, which `dataclasses` requires, and Ruff SIM102. Both were
  fixed without any product change.
- Environment: task-local disposable venv `/tmp/aegis-pr9-venv` (Python 3.14.7;
  pytest 9.1.1, ruff 0.16.3, paho-mqtt 2.1.0, exactly the `requirements-dev.txt`
  pins; `pip check` clean), created from the system interpreter. No global
  Python or PlatformIO installation was modified. Node v24.16.0.

```text
source_sha = d66b44aad1a4083181617e0cba4cfa12cc285deb
Contract: test_production_like_acceptance + test_production_like_negative_controls = 15 passed
Focused lifecycle: production_runtime + windows_launcher + both drivers + paths = 130 passed, 6 skipped
Focused S4 Python: mqtt_client + runtime + controller + core = 80 passed
Full Python  = 231 passed, 6 Windows-only skipped
Ruff = PASS; compileall = PASS
Full Web     = 309 passed across 24 files (includes every focused S4 Web suite; Web source unchanged since 15b5b94a)
Vite build   = PASS, 1677 modules; npm audit --omit=dev --offline = 0 vulnerabilities
Repository   = 63 passed, 0 failed
Acceptance   = PRODUCTION_LIKE_VERIFIED (measured; see below)
Negative controls = 13/13 PASS
```

### Isolated production-like acceptance

`python deploy/production-like-acceptance.py --data-root <empty disposable path containing spaces>`
passed twice (`@8d4c76bb`, `@15b5b94a`): `PRODUCTION_LIKE_VERIFIED`, 2
generations, liveness, readiness `READY` schema v2, Admin login with a generated
test-only bcrypt credential, LIVE snapshot with IDEA1/IDEA2 `NOT_CONFIGURED`,
durable audit write, restart, audit read-back after restart, CSRF logout, clean
stop exit 0, no control token, no temporary files, no Web listener, no surviving
Core/Web process, no secret in logs/runtime, and owner-only 0600 files / 0700
directories. In those runs, process residue and permissions were checked by
hand outside the driver.

At `d66b44aa` the driver measures these properties itself. `python
deploy/production-like-acceptance.py --data-root <empty disposable path
containing spaces>` returned `PRODUCTION_LIKE_VERIFIED` with: 2 generations; Web
`READY`; audit `PERSISTED_ACROSS_RESTART`; measured `idea1`/`idea2`/`mqtt`
`NOT_CONFIGURED` and `esp32`/`physicalEvidence` `UNKNOWN`; 3 owned processes
observed per generation (service owner, Core, Web); 0 surviving; control token
`ABSENT`; owner-only permissions `true`; final status `STOPPED`;
`productionMutation: false`. Admin login and CSRF logout ran in both
generations.

### Negative controls — loopback only

A session-local harness reused the committed driver helpers, a fresh disposable
root per case, and a loopback feed server requiring a generated bearer token.
Run 1: 9/10 — the malformed-feed case failed only because the harness expected
`MALFORMED_RESPONSE`, while `web/server/providers/liveProvider.js` intentionally
reports `ADAPTER_RESPONSE_REJECTED`; the product degraded correctly. Run 2 at
`15b5b94a` after correcting that expectation: **10/10 PASS**. After the
truth-model correction the harness expects configured IDEA1/IDEA2 service
status `UNKNOWN`. Run 3 reported 10/10 FAIL, all caused by the harness residue
matcher: it matched the invoking shell, whose command line named these
processes and whose working directory was the IDEA3 source. Product values were
as expected in every case. The matcher now counts only real `python`/`node`
processes. Run 4, from the same directory: **10/10 PASS**, and an independent
residue scan found nothing.

The committed driver (`d66b44aa`) replaces that harness. `python
deploy/production-like-negative-controls.py --data-root <empty disposable path
containing spaces>` returned **13/13 PASS**. Residue is the recorded process
tree plus a scan for any python/node service, Core, or Web process still running
from the source tree.

| Case | Category | Observed at `d66b44aa` |
|---|---|---|
| positive control: fresh IDEA1 feed | control | snapshot IDEA1 `HEALTHY`; service `idea1: UNKNOWN`; clean stop |
| missing `SESSION_SECRET` | invalid-config | Web rejects policy → service `FAILED`, exit 1 |
| malformed production `PORT` | invalid-config | owner rejects settings → exit 2, no runtime state, no child |
| live Core without broker/HMAC/PIN | invalid-config | Core preflight `FAILED` → service `FAILED`, exit 1 |
| audit DB path unusable | audit-failure | SQLite open fails → service `FAILED`, exit 1 |
| MQTT unavailable (dry-run) | mqtt | service `mqtt: UNAVAILABLE` (Core broker `UNKNOWN`); nothing published |
| IDEA1 unavailable | idea1 | IDEA1 `UNKNOWN`, `ADAPTER_UNAVAILABLE`, 0 incidents |
| IDEA2 unavailable | idea2 | IDEA2 `UNKNOWN`, `ADAPTER_UNAVAILABLE`, 0 incidents |
| IDEA1 stale envelope | stale-evidence | IDEA1 `UNKNOWN`, `ADAPTER_EVIDENCE_STALE`, 0 incidents |
| IDEA2 stale envelope | stale-evidence | IDEA2 `UNKNOWN`, `ADAPTER_EVIDENCE_STALE`, 0 incidents |
| IDEA1 malformed body | malformed-evidence | IDEA1 `UNKNOWN`, `ADAPTER_RESPONSE_REJECTED`, 0 incidents |
| IDEA2 malformed body | malformed-evidence | IDEA2 `UNKNOWN`, `ADAPTER_RESPONSE_REJECTED`, 0 incidents |
| IDEA2 schema rejected | malformed-evidence | IDEA2 `UNKNOWN`, `ADAPTER_RESPONSE_REJECTED`, 0 incidents |

Every case kept `physicalEvidence: UNKNOWN` and ended with no control token,
no surviving process, no Web listener, and no secret in logs/runtime. Every
degraded feed read `UNKNOWN` in both the Web snapshot and the service status.
All disposable roots were deleted after the evidence was captured.

### Known limitations

- `PRODUCTION_LIKE_VERIFIED` is local lab/headless/dry-run evidence only. No
  systemd install, Production host, broker, device, relay, WAN, or live
  IDEA1/IDEA2 producer was used.
- Service-status `idea1`/`idea2` never probes the feeds. Since the truth-model
  correction a configured feed reads `UNKNOWN` there (formerly `UNAVAILABLE`,
  which claimed a check that never happened); blank reads `NOT_CONFIGURED`. The
  Web snapshot remains the feed-evidence authority.
- Service-status `mqtt` does not probe or create another connection. It maps
  only Core evidence: blank configuration → `NOT_CONFIGURED`; configured plus
  Core `UNKNOWN` → `UNKNOWN`; Core `DISCONNECTED` → `UNAVAILABLE`; Core
  `CONNECTED` → `CONNECTED`.
- Both drivers read `/proc` and use POSIX process groups, so they are
  Linux-only; Windows acceptance remains the PR8 `windows/smoke.ps1` path.
- Backup/restore, upgrade/rollback, and secret rotation are documented only.
- PR8 final Windows acceptance at `25fb442d`, including the extracted-ZIP 25/25
  smoke, is owner-reported; what is missing is its canonical documentation (see
  "PR8 merge reconciliation — 2026-09-10"), not the acceptance. PR9 does not
  rerun it.

### Final pre-PR5 MQTT truth correction — 2026-09-10

The service owner previously collapsed every configured non-`CONNECTED` Core
broker state to `UNAVAILABLE`. That overstated configured-but-unprobed dry-run
evidence. The projection now preserves the existing Core truth without adding a
probe or second MQTT connection:

| MQTT configuration / Core broker evidence | Service `mqtt` |
|---|---|
| not configured / `UNKNOWN` | `NOT_CONFIGURED` |
| configured / `UNKNOWN` | `UNKNOWN` |
| configured / `DISCONNECTED` | `UNAVAILABLE` |
| configured / `CONNECTED` | `CONNECTED` |

The four-case regression failed first only for configured + `UNKNOWN`
(`UNAVAILABLE` observed, `UNKNOWN` required), then passed 4/4 after the minimal
mapping change. The 13-case disposable driver was corrected to label and assert
its actual dry-run state: MQTT is configured but deliberately unprobed, Core is
`UNKNOWN`, and service `mqtt` is `UNKNOWN`; it passed 13/13. Core
`DISCONNECTED` → service `UNAVAILABLE` and Core `CONNECTED` → service
`CONNECTED` are verified by the focused projection matrix without contacting a
broker. In every matrix row, `esp32` and `physicalEvidence` remain `UNKNOWN`:
an ACK is not physical evidence, MQTT connection is not ESP32-online evidence,
and MQTT connection is not relay-success evidence.

Fresh pre-PR5 verification at the correction tree: focused runtime/MQTT/Core/
controller/driver contracts 116 passed; full Python 236 passed with 6
Windows-only skips; full Web 309/309 across 24 files; Vite 1,677 modules; Ruff,
compileall, offline npm audit, and repository 63/63 passed. Disposable
acceptance returned `PRODUCTION_LIKE_VERIFIED`; disposable negative controls
passed 13/13 with no surviving process, listener, token, secret leak, or claimed
physical evidence. The final SHA, vault/policy checks, and remote PR/PR5 state
are recorded after the one correction commit is created and pushed.

### S7 post-PR5 sync and final acceptance — 2026-09-11

```text
PR5 = GitHub PR #117 MERGED at 58f19f2051170685757627a6baea90b264a877c4 (head d416d1ecea338e38247510e7b547f63d42447e11)
PR9_PR115_PR5_GATE = SATISFIED
PRE_SYNC_HEAD = c7a1a7af7bc346b86a96f2f9bcb8a6f9ffce29aa
MAIN_SYNC_COMMIT = e5863fc664e239b78f37dd4ce663bc1186f22744
S7 = CLOSED / PASS
S8 = CLOSED / PASS
```

`e5863fc6` merges `origin/main` normally; its parents are `c7a1a7af` and
`58f19f20`. An earlier session created it locally before this S7 run, so it was
audited before use: its tree differs from a plain auto-merge only in the three
conflicted IDEA3-owned documents (`IDEA3-AEGIS_Lockdown/README.md`,
`doc/Content/04_SESSION_HANDOFF.md`, and this note), no conflict marker remains,
and no source, firmware, IDEA1/IDEA2, shared, or receipt path was hand-edited.
The resolution kept PR9 handoff sections 39-43, renumbered the PR5 section to
44, and kept both PR5 hardware truth and PR9 runtime truth here. One merge
defect was corrected in S8: the auto-merge had applied PR5's "Historical ... PR8
snapshot" heading renames onto this live PR9 Session Register and Handoff.

The PR5 hardware matrix at the top of this note is carried forward unchanged.
PR9 adds no physical evidence, and continuity evidence remains distinct from
real Ethernet traffic evidence.

#### Telegram outbound pre-gate — `c7a1a7af`

Audited unchanged on the merged tree:

- `test_uplink_state_transitions_send_one_outbound_notification_each` — an
  observed `LOCKDOWN` transition schedules one alert and an observed `NORMAL`
  transition one restore alert; repeated unchanged state is suppressed.
- `test_missing_telegram_configuration_opens_no_network_request` — a blank
  `AEGIS_TG_TOKEN` or `AEGIS_TG_CHAT` makes no request.
- `test_webhook_delivery_is_deferred_to_a_daemon_thread` and
  `test_webhook_network_failure_is_fail_soft_and_secret_safe` — delivery leaves
  the MQTT callback; failure prints fixed wording without token, chat ID, bot
  URL, or exception detail.
- `test_telegram_failure_does_not_change_status_ack_or_physical_correlation` —
  alert failure does not affect STATUS, ACK, or physical correlation.
- Production starts Core with `--headless`; `TelegramListener` and inbound
  `/cut`/`/restore` are constructed only in GUI mode.

```text
Telegram delivered != publication / ACK / execution / relay confirmation / WAN isolation / physical evidence
REAL_TELEGRAM_API_CALLED = NO
PRODUCTION_TELEGRAM_LISTENER_STARTED = NO
PRODUCTION_REMOTE_CUT_ENABLED = NO
PRODUCTION_REMOTE_RESTORE_ENABLED = NO
REAL_TELEGRAM_PRODUCTION_DELIVERY = NOT VERIFIED
```

#### Post-sync verification at `e5863fc6`

Arch Linux; task-local venv `/tmp/aegis-pr9-venv` (Python 3.14.7,
`requirements-dev.txt` pins); Node v24.16.0. Counts above this section are
historical pre-sync evidence.

```text
Focused runtime/MQTT/Core/controller/Telegram/drivers/paths = 224 passed, 6 Windows-only skipped
Telegram subset (test_comms + test_mqtt_client)             = 8 passed
Full Python  = 245 passed, 6 Windows-only skipped
Full Web     = 309 passed across 24 files
Vite build   = PASS, 1,677 modules
Ruff = PASS; compileall = PASS
npm audit --omit=dev --offline = 0 vulnerabilities
Repository tests = 63 passed, 0 failed
Vault validation = PASS, 2 known owner-data canvas warnings
Collaboration policy (live PR #115 Draft body) = PASS
git diff --check origin/main...HEAD = PASS
Secret scan = 0 findings; artifact scan = 0 findings; 25 changed paths, all IDEA3-owned
Isolated acceptance = PRODUCTION_LIKE_VERIFIED (2 generations, Web READY, audit persisted, IDEA1/IDEA2/MQTT NOT_CONFIGURED, ESP32/physical UNKNOWN, 0 surviving, owner-only, final STOPPED)
Negative controls = 13/13 PASS (configured-but-unprobed MQTT: Core UNKNOWN / service UNKNOWN)
Residue = 0 surviving processes, 0 loopback listeners; disposable roots removed
```

Every MQTT, IDEA1/IDEA2, ESP32, relay, and Telegram boundary was absent,
injected, or faked. No Production host, broker, device, relay, MikroTik,
TP-Link, Twingate, Telegram API, or real upstream feed was contacted.

#### PR8 current truth

```text
PR8_HEAD = 25fb442d15cdf2037817c9e63add4d7e96bcd568
PR8 = MERGED (GitHub PR #107)
FINAL_WINDOWS_ACCEPTANCE = PASS (owner-reported)
FINAL_EXTRACTED_ZIP_SMOKE = PASS / 25 of 25 (owner-reported)
PR8_BUILD_ZIP_DIGEST_AND_TRANSCRIPT = NOT RECORDED IN CANONICAL DOCUMENTATION
PR8_RECEIPT = UNCHANGED (historically partial)
```

#### Open after PR9

```text
PRODUCTION_DEPLOYED = NO
REAL_TELEGRAM_PRODUCTION_DELIVERY = NOT VERIFIED
LIVE_IDEA1_SERVICE_EVENT_FEED = OPEN
LIVE_IDEA2_SERVICE_EVENT_FEED = OPEN
SHARED_CORRELATION_KEY = OPEN
LIVE_CROSS_IDEA_EXERCISE = OPEN
TOTAL_CONTROL_POWER_LOSS_FAIL_SECURE = NOT PROVEN
TWINGATE_FINAL_RELAY_CYCLE_AUTO_RECOVERY = NOT CLAIMED / NOT CONCLUSIVELY VERIFIED
MECHANICAL_BREADBOARD_STABILITY = PROTOTYPE LIMITATION
IDEA3_PRODUCTION_COMPLETE = NO
```

### Planned / Completed / Remaining

- Completed: S1-S6 — design/plan, strict config, composite lifecycle,
  readiness, negative regressions, measured isolated acceptance, reproducible
  13-case negative controls, runbook, truth-model and MQTT corrections,
  Telegram outbound pre-gate. S7 — normal post-PR5 main sync and the full gate
  on the merged tree. S8 — canonical reconciliation and one immutable receipt.
- Remaining for PR9: none — PR #115 was merged by a human reviewer at
  `2c21cc3e`. Production deployment and every item under "Open after PR9" are
  outside PR9; current PR10–PR12 scope is in "PR10 pre-flight evidence
  reconciliation".

## PR9 Handoff — historical (PR #115 merged)

> [!note] Superseded handoff
> PR #115 merged at `2c21cc3e`. The current handoff is in "PR10 pre-flight
> evidence reconciliation".

### Current branch

`feat/idea3-production-runtime-pr9`

### Current HEAD

Final implementation/evidence checkpoint
`e5863fc664e239b78f37dd4ce663bc1186f22744`; the S8 receipt-bearing closeout
commit follows it. PR #115 shows the exact pushed head.

### Current task state

CLOSED / MERGED. S1-S8 CLOSED with one final receipt; merged through GitHub PR #115 at `2c21cc3e`.

### Sessions closed

S1-S8.

### Session currently open

None.

### Verified evidence

See "Post-sync verification at `e5863fc6`" above: Python 245 passed / 6
Windows-only skipped, Web 309/309, Vite, Ruff, compileall, npm audit 0,
repository 63/63, vault, policy, scans, `PRODUCTION_LIKE_VERIFIED`, and
negative controls 13/13.

### Known issues

None blocking review. PR8 final Windows acceptance is owner-reported and its
artifacts are not yet in canonical documentation.

### Exact remaining work

None for PR9. A Production deployment is a separately authorized PR10 task.

### Next command / next action

See the current Handoff in "PR10 pre-flight evidence reconciliation".

### Do not do

Do not let an agent merge PR #115. Do not deploy, install systemd, enable MQTT
actuation or the Telegram listener, flash or reset hardware, manipulate the
relay or network, claim physical evidence, rebase/force-push, or mutate
Production.
---

## Historical Task and Handoff — Project-sequence PR5 pre-merge snapshot

```text
Task: IDEA3 PR5 Final Hardware Closure
Branch: fix/idea3-final-hardware-closure
Owner: music
State: READY FOR REVIEW / OWNER LAB EVIDENCE ACCEPTED
Production mutation allowed: NO
IDEA3_PRODUCTION_COMPLETE = NO
```

### Closed in this task

- External pull-down/ULN2003/high-trigger relay topology documented with the
  firmware polarity unchanged.
- RJ45 Pin 2 CUT/RESTORE continuity accepted.
- Powered EN/reset and reconnect behavior accepted without auto-restore.
- Explicit authenticated RESTORE requirement accepted.
- Real Router/Switch Ethernet ping and SSH CUT/RESTORE accepted.
- Direct-LAN Twingate baseline and connector health after one manual restart
  accepted.

### Remaining after this task

- Human review and merge of the PR5 GitHub PR.
- GitHub PR #115 remains Draft/blocked until that merge; its S7/S8 production
  work must not proceed early.
- Total-control-power-loss fail-secure behavior is not proven.
- Final relay-cycle Twingate automatic recovery without manual restart is not
  conclusively verified.
- Breadboard mechanics require strain relief and secure PCB/interconnect before
  deployment-grade use.
- Production adapters, deployment, and overall IDEA3 production acceptance
  remain open.

### Safety and next action

Do not merge this PR automatically. Do not change firmware polarity, flash or
reset hardware, publish MQTT commands, manipulate the circuit, or unblock PR
#115 before the PR5 GitHub PR is actually merged. The next action is owner and
integration review of the PR5 evidence boundary.

---

## 🔗 Related Notes
* [[core/system-overview]]
* [[idea2/idea2-status]]
* [[core/security-architecture]]
