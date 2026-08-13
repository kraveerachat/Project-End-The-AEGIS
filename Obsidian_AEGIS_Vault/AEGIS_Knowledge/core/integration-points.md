---
title: AEGIS Integration Points
tags: [aegis, architecture, integration, shared]
type: architecture-doc
created: 2026-08-13
updated: 2026-08-13
owner: kla
edit_policy: owner-only
---

# 🔗 AEGIS Integration Points

> [!info] Shared integration surface
> Owner: **Kla**. IDEA owners request changes through their task receipt and Pull Request instead of editing this page concurrently.

| Producer | Contract / boundary | Consumer | Canonical detail |
|---|---|---|---|
| HUB | Route prefixes `/drive/` and `/monitor/`; no independent identity | IDEA1 and IDEA2 web apps | [[core/hub-aegis-entry]] |
| Detection Engine | Authenticated `/internal/*` ingest; no PostgreSQL credential | IDEA2 Monitor API | [[entities/Detection_Engine_Service]] |
| IDEA1 Drive | Storage/NAS capability without sharing application identity | Authorized project workflows | [[idea1/idea1-status]] |
| IDEA3 Lockdown | Signed MQTT command to physical relay; fail-safe behavior | Network uplink boundary | [[idea3/idea3-status]] |
| Infrastructure | VLAN, server, remote access, deployment evidence | All modules | [[infrastructure/infrastructure-moc]] |

Cross-module changes must name the affected surface in `Shared surfaces touched` and `Integration requests` in the task receipt.
