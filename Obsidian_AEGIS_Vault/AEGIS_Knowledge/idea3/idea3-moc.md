---
title: IDEA3 AEGIS Lockdown MOC
tags: [aegis, idea3, moc]
type: moc
created: 2026-08-13
updated: 2026-10-07
owner: music
edit_policy: owner-writable
---

# 🔒 IDEA3 — AEGIS Lockdown

> **Current Recovery state (2026-10-07):** `RECOVERY_REPOSITORY_IMPLEMENTED=YES`, `RECOVERY_LIVE_EXECUTED=NO`, `RECOVERY_R2_R8_EXECUTED=NO`. PR #369's RRu successor remains repository-only and has not executed LIVE. Its one-shot authority is now the canonical durable root-owned `RRU-GLOBAL-ATTEMPT-CONSUMED` marker under `/var/lib/aegis-idea3-governance`; `AUTH_DIR` is Authorization/K3 input only. Recovery preserves the existing R1B-failure + R1Bv-PASS predecessor and additionally requires exactly one pinned-main governed RRu LIVE closeout with `RRU_RESULT=PASS`, `RECOVERY_RUNTIME_RELEASE_READY=YES`, and an exact `RRU_RELEASE_ID` binding to the frozen Recovery release. The required sequence is: PR #369 merge → one owner-authorized RRu LIVE attempt → evidence review and separately merged RRu closeout → new exact-main Recovery authority/freeze → Recovery LIVE. `RRU_REPOSITORY_IMPLEMENTED=YES`, `RRU_LIVE_EXECUTED=NO`, `RECOVERY_RUNTIME_RELEASE_READY=NO`; no Recovery marker, Production mutation, or ESP32 action occurred.

Current checkpoint (2026-10-06): the historical `R1A` attempt executed live exactly once and remains an immutable, consumed FAIL
(`R1A_RESULT=FAIL`, `R1A_RERUN_ALLOWED=NO`): the genuine external detector chain was observed (owner-run read-only forensic readout,
`REAL_DETECTOR_CHAIN_EVIDENCE=PASS`), but the governed stage closed FAIL at the PRE→POST preservation comparator. `R1Du` then deployed
the current release (`R1DU_LIVE=CLOSED_PASS`, deployment only; current deployed release
`ebffab6f8a6d7d98973fac7e89167352d529a87e`). `R1D` ran once and is `R1D_RESULT=FAIL_IMMUTABLE` after its disposition committed
(`R1D_DISPOSITION_COMMITTED=YES`, `R1D_RERUN_ALLOWED=NO`). `R1Dv` ran once and is `R1DV_LIVE=CLOSED_PASS`
(`R1DV_RESULT=PASS`, read-only validation of the committed disposition, not an R1D retry). `R1B` then ran once and is `R1B_RESULT=FAIL_IMMUTABLE` at `windowrecord` (`R1B_LIVE_EXECUTED=YES`, `R1B_ATTEMPT_CONSUMED=YES`,
`R1B_RERUN_ALLOWED=NO`): a GENUINE external event was proven (`R1B_GENUINE_EXTERNAL_EVENT=PROVEN`, the Core created new incident #2) but the
post-observation window record could not be written (sudo authentication expired), so the final capture and verifier were never reached.
`R1Bv` (a read-only successor validation using only the existing R1B evidence; not an R1B retry) then ran once and is `R1BV_LIVE=CLOSED_PASS` (`R1BV_RESULT=PASS`: no new event, no incident or marker mutation, the missing window record never reconstructed; R1B stays `R1B_RESULT=FAIL_IMMUTABLE`). The Recovery predecessor is SATISFIED by the immutable R1B failure plus that unique R1Bv LIVE PASS closeout; Recovery R2–R8 is the next governed work and has NOT run (`RECOVERY_R2_R8_EXECUTED=NO`). The
runtime-only R1I table remains installed. No acceptance claim is promoted: `F1_REAL_DETECTOR_ACCEPTANCE=NOT_PROVEN`,
`R1_VERIFIED=NOT_CLAIMED`, `RECOVERY_R1_R8_PROVEN=NO`. No adjudication may alter `R1A_RESULT=FAIL`, `R1D_RESULT=FAIL_IMMUTABLE` or `R1B_RESULT=FAIL_IMMUTABLE`, or create
`R1A_LIVE=CLOSED_PASS`. Do not rerun R1A, R1D or R1B. See [[idea3/idea3-status]].

A governed pre-live blocker for the successor R1B (the blocker existed because the preserved historical R1A incident was `OPEN`) is resolved in the
repository only by the owner-approved `R1Du` (Core upgrade) and `R1D` (one Core-mediated, atomic historical-incident
disposition) stages. `R1Du` executed once (`R1DU_LIVE=CLOSED_PASS`, deployment only, permanently consumed). `R1D` then ran once: the
disposition COMMITTED (incident #1 `CLOSED`, `R1D_DISPOSITION_COMMITTED=YES`) but the stage is `R1D_RESULT=FAIL_IMMUTABLE`
(never rerun, never rewritten to PASS): its final TrustedClock evidence was unavailable because the verifier snapshot lacked
`trusted_time`. The repository now carries the snapshot repair and the read-only, non-mutating `R1Dv` validation stage (not an R1D
retry). `R1Dv` has since executed once and PASSED (`R1DV_LIVE=CLOSED_PASS`, read-only: no socket, no incident mutation, no disposition; unique closeout receipt recorded). R1B's predecessor Path B was therefore satisfied and R1B has since run once and failed immutably (see the checkpoint above); Recovery R2–R8 was blocked until R1Bv passed; that predecessor is now satisfied but Recovery has not run. See [[idea3/idea3-status]].

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

The Headless Python Core, authenticated MQTT command lifecycle, correlated ACK/STATUS firmware contract, dry-run safeguards, and automated regressions are established on `main`. F1u LIVE deployment passed on 2026-10-05 (an earlier deployment stage: immutable release `912b18005bb2fc80bb4e8d1fe8aa88803ac27314` was then active, Core restarted once, and the unchanged detector was cycled under Option A); R1Du (2026-10-06) later upgraded the Core and `current` release, so the CURRENT deployed release is `ebffab6f8a6d7d98973fac7e89167352d529a87e`. Both prove deployment only. R1D ran once and is `R1D_RESULT=FAIL_IMMUTABLE` with its disposition committed; R1Dv ran once and passed read-only (`R1DV_LIVE=CLOSED_PASS`) but proves neither full R1 nor Recovery. R1B executed once and is `R1B_RESULT=FAIL_IMMUTABLE` (`R1B_LIVE_EXECUTED=YES`; genuine event proven, final verifier not reached; R1Bv has since run live read-only and PASSED, so the Recovery predecessor is satisfied), Recovery R2–R8 has not executed (`RECOVERY_R2_R8_EXECUTED=NO`), and ESP32 was untouched in this sequence (`ESP32_TOUCHED=NO`). Real detector acceptance, R1, Recovery R2–R8, LVR, L8, and L9 remain unproven. Project-sequence PR5 preserves the firmware contract `GPIO27 LOW = LOCKDOWN/CUT` and `GPIO27 HIGH = NORMAL/RESTORE`; external ULN2003 inversion plus pull-down/pull-up biasing produced the required relay behavior. RJ45 continuity, powered EN/reset, reconnect-without-auto-restore, explicit recovery, and real Ethernet traffic interruption/recovery were observed by the owner. Total-control-power-loss fail-secure behavior remains unproven, the breadboard prototype requires deployment-grade mechanical stabilization, and final relay-cycle Twingate auto-recovery is not claimed.

PR #178 is merged on `main` (`PR178_MERGED = YES`). IDEA3 scope is formally frozen as a Security Orchestrator + Physical Containment MVP (`PR11_MVP_SCOPE = SECURITY_ORCHESTRATOR_PHYSICAL_CONTAINMENT`, `SCOPE_FREEZE_OWNER_APPROVED = YES`). PR #181 closed the dynamic nftables software IP blocking gap on the Arch Core (source implementation merged `21d7b7824e6edf1950a7bd914f5d780366fd13c7`; receipt recovered by PR #182): `SOFTWARE_IP_BLOCKING = SOURCE_IMPLEMENTED`, `SOFTWARE_IP_UNBLOCK = SOURCE_IMPLEMENTED`, still `HOST_VERIFIED = NO`. All Phase 4 handlers L1..L9 are registered and merged (`L2_L9_REPOSITORY_HANDLERS = ALREADY_CLOSED`, `L2_L9_LIVE_EXECUTION = OPEN_NEEDS_EVIDENCE`). PR10 server-hosted Web and Arch Linux Core deployment, PR11 live cross-IDEA and authorized E2E (`PR11_MVP_COMPLETE = NO`), and PR12 final acceptance (`PR12_FINAL_ACCEPTANCE = OPEN`) remain open. Extended production hardening and full DR certification are deferred (`POST_PRODUCTION_HARDENING = DEFER_FUTURE_WORK`). `F1U_PRODUCTION_DEPLOYED = YES`; `PRODUCTION_DEPLOYED = YES` for the F1u deployment boundary only; `IDEA3_PRODUCTION_COMPLETE = NO`. See [[idea3/idea3-status]] for the exact evidence boundary and the host-verification contract.

## Shared dependencies

The device is [[entities/ESP32_Relay_Module]]. Its operating model depends on [[concepts/Dead_Mans_Switch]], [[concepts/Contain_Before_Notify]], [[concepts/Cyber-Physical_Defense]], the shared [[core/integration-points]], and the real network state in [[infrastructure/infrastructure-moc]].

## Recent task receipts

```query
path:"90-Status/logs" [owner:music]
```

## Finish an area task

Update the Music-owned current state only with demonstrated evidence, add one immutable receipt, and submit infrastructure or shared-contract changes for integration review.
