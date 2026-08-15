---
title: AEGIS Core and Integration MOC
tags: [aegis, core, shared, integration, moc]
type: moc
created: 2026-08-13
updated: 2026-08-13
owner: kla
edit_policy: owner-only
---

# AEGIS Core and Integration MOC

## Purpose

Use this dashboard for system-wide contracts, integration decisions, and changes that cross an area boundary. It is the shared counterpart to the four area dashboards.

## Owner and write boundary

Kla owns Core and shared integration. Area owners keep their own canonical status notes current; cross-area requests are recorded for integration rather than silently changing another area’s operational truth.

## Canonical contracts

- [[core/system-overview]] and [[core/system-context]] — system topology and preserved architecture detail.
- [[core/hub-aegis-entry]], [[core/security-architecture]], and [[core/integration-points]] — entry, security, and reviewed interfaces.
- [[core/agent-operating-rules]] and [[core/design-system-ui-language]] — operating and design rules.
- [[.schema.md]] — vault ownership, receipt, and navigation rules.

## Integration queue

Use [[90-Status/integration-queue]] to track a reviewed shared decision, rollout, or rollback. The area dashboards are [[idea1/idea1-moc]], [[idea2/idea2-moc]], [[idea3/idea3-moc]], and [[infrastructure/infrastructure-moc]].

## Shared verification

Verify the affected area first, then run the applicable shared contract, deployment, gateway, database, identity, or network proof. Record the real result and any limitation in the task receipt.

## Finish a shared task

Follow [[.schema.md]], create one immutable receipt from [[90-Status/logs/_template]], and place any owner decision or integration review in [[90-Status/integration-queue]].
