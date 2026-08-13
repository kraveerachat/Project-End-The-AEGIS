---
title: IDEA3 AEGIS Lockdown MOC
tags: [aegis, idea3, moc]
type: moc
created: 2026-08-13
updated: 2026-08-13
owner: music
edit_policy: owner-writable
---

# 🔒 IDEA3 — AEGIS Lockdown

## Start here

Read [[idea3/idea3-status]] for the owner-maintained Lockdown state. This workstream remains design/report-level until hardware evidence is attached.

## Owned source and canonical notes

Owner: **Music**. The owned code area is `IDEA3-AEGIS_Lockdown/`; the canonical operational note is [[idea3/idea3-status]].

## Current state and open work

The intended system uses an ESP32 relay and MQTT with HMAC to perform fail-secure network isolation. Implementation and hardware proof remain open; see [[idea3/idea3-status]] for the current maturity boundary.

## Shared dependencies

The device is [[entities/ESP32_Relay_Module]]. Its operating model depends on [[concepts/Dead_Mans_Switch]], [[concepts/Contain_Before_Notify]], [[concepts/Cyber-Physical_Defense]], the shared [[core/integration-points]], and the real network state in [[infrastructure/infrastructure-moc]].

## Recent task receipts

```query
path:"90-Status/logs" [owner:music]
```

## Finish an area task

Update the Music-owned current state only with demonstrated evidence, add one immutable receipt, and submit infrastructure or shared-contract changes for integration review.
