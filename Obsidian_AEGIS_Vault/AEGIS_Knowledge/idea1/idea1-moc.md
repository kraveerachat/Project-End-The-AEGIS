---
title: IDEA1 AEGIS Drive LC MOC
tags: [aegis, idea1, moc]
type: moc
created: 2026-08-13
updated: 2026-08-21
owner: kla
edit_policy: owner-writable
---

# 💾 IDEA1 — AEGIS Drive LC

## Start here

Read [[idea1/idea1-status]] for the current, owner-maintained Drive state, then [[summaries/04_IDEA1_Drive_Build_Out]] for historical implementation context.

## Owned source and canonical notes

Owner: **Kla**. The owned code area is `IDEA1-AEGIS_Drive_LC/`; the canonical operational note is [[idea1/idea1-status]].

## Current state and open work

Drive provides the secure NAS, Data Lake, Private Vault, shares, audit, and file-versioning surface. Open gaps and verified limitations are tracked in [[idea1/idea1-status]] and [[summaries/08_Outstanding_Items_Consolidated]].

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
