---
title: IDEA3 AEGIS Lockdown MOC
tags: [aegis, idea3, moc]
type: moc
created: 2026-08-13
updated: 2026-09-23
owner: music
edit_policy: owner-writable
---

# 🔒 IDEA3 — AEGIS Lockdown

## Start here

Read [[idea3/idea3-status]] for the owner-maintained Lockdown state. Its
newest section is the IDEA3 PR11 Post-Containment Reconciliation +
Live-Readiness Contract (2026-09-23), a documentation-only reconciliation
after PR #181 (dynamic IPv4 software containment, merged
`21d7b7824e6edf1950a7bd914f5d780366fd13c7`) and PR #182 (its receipt
recovery, merged on `main`). It confirms `SOFTWARE_IP_BLOCKING =
SOURCE_IMPLEMENTED` and `SOFTWARE_IP_UNBLOCK = SOURCE_IMPLEMENTED` (no longer
`OPEN_NEEDS_IMPLEMENTATION`), still not host-verified
(`HOST_VERIFIED = NO`), and defines the exact host-verification contract
required before `SOFTWARE_BLOCK_IP`/`SOFTWARE_UNBLOCK =
IMPLEMENTED_AND_HOST_VERIFIED`. Zero live mutation performed.
The section before it is the IDEA3 Final Project — PR11 MVP Scope Freeze
(2026-09-22). Following the merge of PR #178 (`7f30b9ca` / `3b91fc40`), IDEA3 Final
Project scope is formally frozen as **Security Orchestrator + Physical Containment MVP**.
The core flow connects attack detection, incident logging, source-IP extraction,
dynamic software IP blocking for HIGH severity, authenticated Protocol v1
containment and ESP32 physical network CUT for CRITICAL severity, and authorized
administrator recovery. PR11 exit criteria and PR12 A1–A7 final acceptance scenarios
are defined in `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-22-idea3-pr11-mvp-scope-freeze.md`.
Live cross-IDEA integrations remain open, IDEA2 narrowed preservation is
pending owner decision (`IDEA2_NARROWED_PRESERVATION = OWNER_DECISION_PENDING`),
and post-production hardening items are deferred
(`POST_PRODUCTION_HARDENING = DEFER_FUTURE_WORK`).
`PR11_MVP_COMPLETE = NO` and `PR12_FINAL_ACCEPTANCE = OPEN`.
The section before that is the PR11 Phase 4 L1 disk-threshold owner decision
reconciliation (2026-09-22, PR #178 merged), which set canonical disk threshold to
90% and resolved the PR #174 conflict for repository purposes while keeping live
L1 blocked on disk usage (96%), IDEA2 §10, and required authorizations.
The section before that is the official post-repair read-only baseline acceptance
(2026-09-21), and earlier sections document the Phase 4 harness and Phase 2 runtime
closeout.

## Owned source and canonical notes

Owner: **Music**. The owned code area is `IDEA3-AEGIS_Lockdown/`; the canonical operational note is [[idea3/idea3-status]].

## Current state and open work

The Headless Python Core, authenticated MQTT command lifecycle, correlated ACK/STATUS firmware contract, dry-run safeguards, and automated regressions are established on `main`. Project-sequence PR5 preserves the firmware contract `GPIO27 LOW = LOCKDOWN/CUT` and `GPIO27 HIGH = NORMAL/RESTORE`; external ULN2003 inversion plus pull-down/pull-up biasing produced the required relay behavior. RJ45 continuity, powered EN/reset, reconnect-without-auto-restore, explicit recovery, and real Ethernet traffic interruption/recovery were observed by the owner. Total-control-power-loss fail-secure behavior remains unproven, the breadboard prototype requires deployment-grade mechanical stabilization, and final relay-cycle Twingate auto-recovery is not claimed.

PR #178 is merged on `main` (`PR178_MERGED = YES`). IDEA3 scope is formally frozen as a Security Orchestrator + Physical Containment MVP (`PR11_MVP_SCOPE = SECURITY_ORCHESTRATOR_PHYSICAL_CONTAINMENT`, `SCOPE_FREEZE_OWNER_APPROVED = YES`). PR #181 closed the dynamic nftables software IP blocking gap on the Arch Core (source implementation merged `21d7b7824e6edf1950a7bd914f5d780366fd13c7`; receipt recovered by PR #182): `SOFTWARE_IP_BLOCKING = SOURCE_IMPLEMENTED`, `SOFTWARE_IP_UNBLOCK = SOURCE_IMPLEMENTED`, still `HOST_VERIFIED = NO`. All Phase 4 handlers L1..L9 are registered and merged (`L2_L9_REPOSITORY_HANDLERS = ALREADY_CLOSED`, `L2_L9_LIVE_EXECUTION = OPEN_NEEDS_EVIDENCE`). PR10 server-hosted Web and Arch Linux Core deployment, PR11 live cross-IDEA and authorized E2E (`PR11_MVP_COMPLETE = NO`), and PR12 final acceptance (`PR12_FINAL_ACCEPTANCE = OPEN`) remain open. Extended production hardening and full DR certification are deferred (`POST_PRODUCTION_HARDENING = DEFER_FUTURE_WORK`). `PRODUCTION_DEPLOYED = NO`; `IDEA3_PRODUCTION_COMPLETE = NO`. See [[idea3/idea3-status]] for the exact evidence boundary and the host-verification contract.

## Shared dependencies

The device is [[entities/ESP32_Relay_Module]]. Its operating model depends on [[concepts/Dead_Mans_Switch]], [[concepts/Contain_Before_Notify]], [[concepts/Cyber-Physical_Defense]], the shared [[core/integration-points]], and the real network state in [[infrastructure/infrastructure-moc]].

## Recent task receipts

```query
path:"90-Status/logs" [owner:music]
```

## Finish an area task

Update the Music-owned current state only with demonstrated evidence, add one immutable receipt, and submit infrastructure or shared-contract changes for integration review.
