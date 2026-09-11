---
title: IDEA1 AEGIS Drive LC MOC
tags: [aegis, idea1, moc]
type: moc
created: 2026-08-13
updated: 2026-09-11
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
- Production **Git checkout** `2806373bb300728a0babb953a63f98bcd714ffef` through PR #80 — no longer the source basis of the running Drive application, which is built from PR #92 head `64807e963359c6a85bc5d9ded7b6ff1b05226694` — plus PR #81's Backup Target classifier merge milestone `07ad78efdf1561f2a49a1ecc81440359b766b3bd`; the live repository head must be resolved from Git;
- the current 10-screen PASS/PARTIAL matrix;
- Private Vault tested scope **PASS / CLOSED**, including direct-VLAN ~1.1 GB encrypted-video sustained playback + seek/resume acceptance;
- SECURITY-2 Vault auto-lock **PASS / CLOSED** after PR #80 + migration 008 + measured 1-minute Production acceptance;
- local Twingate connector runtime telemetry **PASS / CLOSED** after PR #79, while control-plane telemetry remains **NOT MEASURED**;
- Administrator Encryption-at-Rest truthfulness and Network Zones **PASS / CLOSED**;
- RAID telemetry-ready UI versus real RAID1 **DEFERRED / FUTURE HARDWARE**;
- the connected Host Backup Agent, safely mounted/registered shared HGST target, and the `PrivateDevices` classifier source/PR gate **CLOSED via PR #81**, with Production `DIFFERENT_DEVICE` acceptance now **PASS / CLOSED**;
- STORAGE-AUTO-1 persistence PASS; current accepted policy selects `hgst-usb-1` while keeping schedule disabled and `enabled=false`;
- Backup Job manual E2E, repository integrity and isolated restore **PASS / CLOSED** for the accepted removable-media scope;
- real 20–30 GB / Production 32 GiB transfer scale **NOT TESTED / NOT ACCEPTED**;
- PR #92 UI regression fixes are merged (`d4b8e921...`) and **accepted in
  Production**, deployed from PR head `64807e963...` (identical tree, different
  commit): Settings Account avatar Remove, Files responsive tile/menu and
  Private Vault responsive menu are all **PASS / CLOSED**;
- Settings Account/Profile/Avatar and the parent Settings page are **PASS / CLOSED** from the existing owner-observed Production acceptance sequence; the conservative re-test item is retired;
- the final Dashboard temperature, Storage local-connector fact, and Secure Share scope-clarity source changes are locally verified on `feat/idea1-final-core-ui-telemetry-share-backup`, but remain **PENDING Production deployment and owner visual acceptance**;
- remaining open/future work: STORAGE-AUTO-2 real scheduler-triggered Production execution, real RAID1 future hardware, Public Share S5.5 connector isolation plus later Internet acceptance, and unmeasured 20–30 GB / Production 32 GiB transfer scale.

Current Backup checkpoint: classifier source commit `a68de6f145d7e0f6935f2a2a0609ca4be432cdff` resolves local devices through mountinfo `major:minor` → `/sys/dev/block` while preserving `PrivateDevices=true` and fail-closed `UNKNOWN`. Source tests pass 9/9 focused and 52/52 full. PR #81 merged the classifier; the reviewed classifier was then deployed to the live Production host-agent copy, `PrivateDevices=yes` was preserved, and `hgst-usb-1 → DIFFERENT_DEVICE` was accepted. Two manual backups and two isolated restore verifications completed successfully; final Storage UI is Healthy/Ready with integrity PASS and restore PASS. Therefore **Backup Target + manual Backup Job E2E = PASS / CLOSED for the accepted removable-media scope**. `STORAGE-AUTO-2` automatic scheduled execution remains **OPEN / UNPROVEN** until an explicitly approved scheduler-triggered Production run is observed; real RAID1 remains **DEFERRED / FUTURE HARDWARE**.

The current HGST 1 TB and Lexar 32 GB devices are existing/shared equipment: never erase, format, repartition, resize, move or delete their existing data. Only new AEGIS files inside the HGST `AEGIS_BACKUP` directory are allowed; Lexar remains disconnected/unused.

Open gaps and verified limitations remain canonical in [[idea1/idea1-status]] and the shared [[summaries/08_Outstanding_Items_Consolidated]].

### Remaining IDEA1 work after Storage & Backup closure

- The final Dashboard/Storage/Secure Share source pass still needs controlled Production deployment and owner visual acceptance; existing Production closure is not evidence for the changed layout.
- `STORAGE-AUTO-2` automatic scheduled execution is **OPEN / UNPROVEN**; current schedule remains disabled, and it closes only after an explicitly approved scheduler-triggered Production run is observed.
- Real RAID1 is **DEFERRED / FUTURE HARDWARE** and requires a dedicated erasable disk pair plus explicit authorization.
- Public Share S5.4 infrastructure is **ACCEPTED**: Drive State B, the hardened
  Gateway, and dedicated edge/upstream networks are active without a host port
  or Internet route. S5.5-A preflight, the owner-approved S5.5-B design,
  S5.5-C repository preparation (cloudflared image pin, contract tests, and
  `docker-compose.s5-5.yml`), S5.5-D repository firewall tooling (`s5-5-firewall.sh`,
  allowlist artifact, firewall contract tests), and S5.5-E lifecycle tooling and
  security regressions (`s5-5-runtime-check.sh`, `rollback-s5-5.sh`, systemd units,
  drift timer, and security test suite) are **CLOSED / PASS** (S5.5-D and S5.5-E
  repository implementation only); phases S5.5-F through S5.5-H remain not
  started and require separate owner approval. No Production deployment occurred:
  egress network and connector remain absent on Production, the Production
  firewall remains unchanged, and Production systemd is unchanged. Public DNS/TLS,
  external acceptance, and UI activation are not implemented. Public Internet Share
  therefore remains **NOT IMPLEMENTED / NOT EXTERNALLY ACCEPTED**. Use
  [[idea1/idea1-status]] for current task state,
  [[idea1/idea1-public-share-architecture]] for the contract,
  [[90-Status/logs/2026-09-11_042000_kla_public-share-s5-4-gateway-networks]]
  for immutable S5.4 evidence, and
  `gateway/public-share/production/README.md` for the Production runbook.
- Twingate control-plane telemetry remains **NOT MEASURED**.
- Real 20–30 GB transfer acceptance and Production 32 GiB enablement remain **NOT TESTED / NOT ACCEPTED**.

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
