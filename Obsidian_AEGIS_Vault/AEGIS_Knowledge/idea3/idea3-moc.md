---
title: IDEA3 AEGIS Lockdown MOC
tags: [aegis, idea3, moc]
type: moc
created: 2026-08-13
updated: 2026-09-16
owner: music
edit_policy: owner-writable
---

# 🔒 IDEA3 — AEGIS Lockdown

## Start here

Read [[idea3/idea3-status]] for the owner-maintained Lockdown state. Its
newest section is Music's approve-only K3/K7 pre-mutation owner package
(2026-09-16). Owner-run read-only evidence explained why the running HUB's
config-hash differs from the current base Compose: the base pinned the HUB's
`aegis_internal` address on 2026-09-12, and Phase 2A adds only the IDEA3
network. Music proposes accepting the current base HUB semantics for the next
HUB recreate. K3 is not proven clear, so Kla is asked to confirm in writing that
the IDEA1 window is closed. Before that, PR #139 merged at `8cf917bf` with Kla's
APPROVED review, so the K1/K3/K7 decisions are accepted. Nothing in Production
changed, and Stage B is not allowed.
Next is the D4 Core-local RESTORE repository implementation, merged as PR #138
at `3fd8d4d1`. It is COMPLETE and LOCAL VERIFIED and was never run live. Web,
Telegram, and automatic RESTORE remain unavailable. PR #137 merged at
`7a805963` with an empty-body Kla approval that decided nothing. A later section
records the owner-run P2-E1 read-only Production evidence
(2026-09-15): the live HUB NGINX artifact differs from the reviewed Git
artifact (K1 FAIL / live drift), the `172.31.243.0/29` live collision recheck
passed (K4), the running HUB was created from one Compose file (K7 BLOCKED),
and K8/K9/K10 remain BLOCKED. Nothing in Production changed. PR #133
merged the Phase 3 Core-only repository package at `2742be27`; Phase 3 runtime
remains incomplete. PR #135 merged the Phase 4 Protocol v1 repository package
at `f0a87ee1`: independent per-device keys, durable
sequence/replay storage, trusted-time gates, TLS-only MQTT and exact ACL
contracts, Python/firmware golden-vector parity, compile-verified ESP32 code,
and repository-safe negative controls are locally verified. This is not live
evidence: no Production service, broker, AP, certificate, key, board, relay,
CUT, or RESTORE was changed. PR #132's container remains the sole Production
Web owner. Phase 2/3 runtime, live/hardware values, D4 recovery authority, and
explicit rollout authorization remain blocking. `PHASE4_LIVE_ALLOWED = NO` and
`PRODUCTION_MUTATION_AUTHORIZED = NO`.

## Owned source and canonical notes

Owner: **Music**. The owned code area is `IDEA3-AEGIS_Lockdown/`; the canonical operational note is [[idea3/idea3-status]].

## Current state and open work

The Headless Python Core, authenticated MQTT command lifecycle, correlated ACK/STATUS firmware contract, dry-run safeguards, and automated regressions are established on `main`. Project-sequence PR5 preserves the firmware contract `GPIO27 LOW = LOCKDOWN/CUT` and `GPIO27 HIGH = NORMAL/RESTORE`; external ULN2003 inversion plus pull-down/pull-up biasing produced the required relay behavior. RJ45 continuity, powered EN/reset, reconnect-without-auto-restore, explicit recovery, and real Ethernet traffic interruption/recovery were observed by the owner. Total-control-power-loss fail-secure behavior remains unproven, the breadboard prototype requires deployment-grade mechanical stabilization, and final relay-cycle Twingate auto-recovery is not claimed. PR10 server-hosted Web and Arch Linux Core deployment, PR11 live cross-IDEA and authorized E2E, and PR12 final acceptance remain open. PR12's Backup / Restore recovery tooling (`aegis_soc/backup_restore.py` plus the `aegisctl backup-create`/`backup-verify`/`backup-restore` commands) is implemented and locally verified against fixture data roots; it has never run against the Server or Core, so `FINAL_PR12_BACKUP_RESTORE = PENDING` and every other PR12 item is not started; the Windows standalone (PR8) is historical and not the final deployment target. `PRODUCTION_DEPLOYED = NO`; `IDEA3_PRODUCTION_COMPLETE = NO`. See [[idea3/idea3-status]] for the exact evidence boundary.

## Shared dependencies

The device is [[entities/ESP32_Relay_Module]]. Its operating model depends on [[concepts/Dead_Mans_Switch]], [[concepts/Contain_Before_Notify]], [[concepts/Cyber-Physical_Defense]], the shared [[core/integration-points]], and the real network state in [[infrastructure/infrastructure-moc]].

## Recent task receipts

```query
path:"90-Status/logs" [owner:music]
```

## Finish an area task

Update the Music-owned current state only with demonstrated evidence, add one immutable receipt, and submit infrastructure or shared-contract changes for integration review.
