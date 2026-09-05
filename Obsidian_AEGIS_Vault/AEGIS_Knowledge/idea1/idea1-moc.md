---
title: IDEA1 AEGIS Drive LC MOC
tags: [aegis, idea1, moc]
type: moc
created: 2026-08-13
updated: 2026-09-06
owner: kla
edit_policy: owner-writable
---

# 💾 IDEA1 — AEGIS Drive LC

## Start here

Read [[idea1/IDEA1-Progress-Update-6.1]] first for the reconciled 2026-09-06 handoff, then [[idea1/idea1-status]] for the owner-maintained canonical history, and [[summaries/04_IDEA1_Drive_Build_Out]] for older implementation context.

## Owned source and canonical notes

Owner: **Kla**. The owned code area is `IDEA1-AEGIS_Drive_LC/`; the canonical operational note is [[idea1/idea1-status]].

## Current state and open work

Drive provides the secure NAS, Data Lake, Private Vault, shares, audit, file-versioning, Protected Trash, Storage/Backup status surfaces and the Classic/Neo Dual Interface Style.

For the current operational snapshot, use [[idea1/IDEA1-Progress-Update-6.1]]. It records:
- Production Drive source `2806373bb300728a0babb953a63f98bcd714ffef` through PR #80 and repository `main@07ad78efdf1561f2a49a1ecc81440359b766b3bd` through PR #81;
- the current 10-screen PASS/PARTIAL matrix;
- SECURITY-2 Vault auto-lock **PASS / CLOSED** after PR #80 + migration 008 + measured 1-minute Production acceptance;
- local Twingate connector runtime telemetry **PASS / CLOSED** after PR #79, while control-plane telemetry remains **NOT MEASURED**;
- Administrator Encryption-at-Rest truthfulness and Network Zones **PASS / CLOSED**;
- RAID telemetry-ready UI versus real RAID1 **DEFERRED / FUTURE HARDWARE**;
- the connected Host Backup Agent, safely mounted/registered shared HGST target, and the `PrivateDevices` classifier source/PR gate **CLOSED via PR #81**, with Production deployment / `DIFFERENT_DEVICE` acceptance still pending;
- STORAGE-AUTO-1 persistence PASS with the current safe baseline disabled/no active target;
- Backup Job / integrity / isolated restore still **NOT TESTED**;
- the current Backup Target → Backup Job continuation sequence.

Current Backup Target checkpoint: classifier source commit `a68de6f145d7e0f6935f2a2a0609ca4be432cdff` resolves local devices through mountinfo `major:minor` → `/sys/dev/block` while preserving `PrivateDevices=true` and fail-closed `UNKNOWN`. Source tests pass 9/9 focused and 52/52 full. PR #81 merged the classifier to repository main; overall Backup Target remains **IN PROGRESS** until Production reports `hgst-usb-1 → DIFFERENT_DEVICE`; Backup Job remains **NOT TESTED**, and real RAID1 remains **DEFERRED / FUTURE HARDWARE**.

The current HGST 1 TB and Lexar 32 GB devices are existing/shared equipment: never erase, format, repartition, resize, move or delete their existing data. Only new AEGIS files inside the HGST `AEGIS_BACKUP` directory are allowed; Lexar remains disconnected/unused.

Open gaps and verified limitations remain canonical in [[idea1/idea1-status]] and the shared [[summaries/08_Outstanding_Items_Consolidated]].

## Current functional design baseline

> [!info] Design baseline, not production evidence
> This map describes the current IDEA1 application structure and intended user
> workflows after the frontend information-architecture revision. It does **not**
> change test results, production acceptance, Phase E, or the evidence status of
> any backend/infrastructure source.

The current primary navigation has **10 screens** (the earlier nine-screen map
predated Protected Trash; the reverted Security screen is not part of current navigation):

| Group | Primary screens |
| :--- | :--- |
| Workspace | Dashboard · Files · Private Vault |
| Protection | Secure Shares · File History / Versions · Trash · Storage & Backup |
| Administration | Audit Log · Access Control · Settings |

Key mapping decisions:

- **Upload is a Files workflow**, not a standalone primary screen. Files owns
  exploration, search, sorting/filtering, folder navigation, creation, upload,
  drag-and-drop, queue/status, and recent-upload context.
- **Private Vault is an independent workspace**, with its own setup, unlock/lock,
  recovery, upload, and file-access flow; it is not an embedded Files subsection.
- **File History / Versions** is file-level history and restore, not a claim of
  filesystem snapshots.
- **Protected Trash** is the owner-only 30-day recovery workspace for normal
  Data Lake files. Its metadata is password-gated; Private Vault is unchanged.
- **Secure Shares** remains a separate lifecycle-management workspace; Files may
  link into it without replacing its creation, policy, tracking, revoke, and
  history responsibilities.
- The Dashboard is the operational overview: data-lake status, activity/context,
  common workflow shortcuts, and a separate Server Telemetry UI contract. See
  [[idea1/idea1-status#current functional design baseline]] for boundaries.

## Shared dependencies

Use [[core/integration-points]] and [[core/security-architecture]] for shared contracts. The Drive data model and truthfulness constraints are documented in [[concepts/Three_Layer_Data_Lake]], [[concepts/Mnemonic_Recovery_and_Zero_Knowledge]], and [[concepts/Honest_Telemetry_and_Unavailable_States]].

## Recent task receipts

```query
path:"90-Status/logs" [owner:kla]
```

## Finish an area task

Update the owner-maintained current state when a durable fact changes, add one immutable receipt, and send cross-area decisions through the integration queue.
