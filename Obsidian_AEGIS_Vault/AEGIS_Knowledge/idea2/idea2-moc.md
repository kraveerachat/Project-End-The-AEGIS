---
title: IDEA2 AEGIS Monitor MOC
tags: [aegis, idea2, moc]
type: moc
created: 2026-08-13
updated: 2026-08-13
owner: pub
edit_policy: owner-writable
---

# 📹 IDEA2 — AEGIS Monitor

## Start here

Read [[idea2/idea2-status]] for the owner-maintained SOC, Operator, and Detection Engine state, then [[summaries/05_IDEA2_Monitor_and_Detection_Engine]] for implementation history.

## Owned source and canonical notes

Owner: **Pub**. The owned code areas are `IDEA2-AEGIS_Monitor/`, `IDEA2-AEGIS_CCTV-Operator/`, and `AEGIS_Camera/`; the canonical operational note is [[idea2/idea2-status]].

## Current state and open work

The workstream covers the SOC view, scoped CCTV Operator console, live video, clips, alert routing, and the headless [[entities/Detection_Engine_Service]]. Current gaps, including recognition-model and telemetry history work, are tracked in [[idea2/idea2-status]] and [[summaries/08_Outstanding_Items_Consolidated]].

## Shared dependencies

Use [[core/integration-points]] and [[core/security-architecture]] for contracts that cross identity, gateway, database, or deployment boundaries. Consult [[summaries/07_Ethics_and_Compliance]] for the IDEA2 ethics record.

## Recent task receipts

```query
path:"90-Status/logs" [owner:pub]
```

## Finish an area task

Update the Pub-owned current state when a durable fact changes, add one immutable receipt, and submit any shared decision for integration review.
