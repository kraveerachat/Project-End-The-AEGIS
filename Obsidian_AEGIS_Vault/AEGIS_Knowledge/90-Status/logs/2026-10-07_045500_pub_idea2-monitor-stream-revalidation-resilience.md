---
title: Task Receipt — IDEA2 Monitor stream revalidation resilience
date: 2026-10-07T04:55:00+07:00
owner: pub
area: idea2
branch: fix/idea2-monitor-stream-revalidation-resilience
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Monitor stream revalidation resilience

## What changed

- Production CAM-01 generation 127 showed a strict Operator Live stream closing shortly after a successful producer DB renewal while the demand lease still had about 29 seconds remaining.
- Read-only evidence cleared the Detection Engine process, VideoCatcher watchdog path, persistent producer boot latency, physical heartbeat freshness, HUB restart, and HUB proxy timeout as the immediate cause of that event.
- Monitor strict stream revalidation now distinguishes bounded transient post-renew Engine synchronization failures from authority failures.
- A transient Engine boot probe or refresh-control failure may retry once, but every retry first revalidates the live session/access state and performs a fresh producer DB renewal before minting new authority.
- Session/access/association revocation, producer-renewal denial, Engine boot change, stale-generation/4xx Engine rejection, explicit client close, and exhausted retries remain fail-closed.
- A short abort-aware retry window prevents a client close racing with transient Engine synchronization failure from causing a late renewal or demand resurrection.
- Revalidation diagnostics now report only low-cardinality phase/outcome information and do not log raw session bindings, demand-owner identifiers, grants, Engine API secrets, registry-sensitive context, or SQL.
- This task changes repository/source behavior only. Production Monitor deployment and live acceptance remain separately gated.

## Source files changed

- `IDEA2-AEGIS_Monitor/server/auth/producerDemandGrant.js` — classify retryable Engine synchronization failures without weakening authority rejection.
- `IDEA2-AEGIS_Monitor/server/routes/api.js` — bounded post-renew retry, fresh session/access/DB authority on retry, fail-closed boundaries, safe diagnostics, and client-close race hardening.
- `IDEA2-AEGIS_Monitor/tests/physicalCameraStreamRouting.test.mjs` — Production-class RED/GREEN coverage for transient boot/refresh failure, retry exhaustion, Engine boot change, revocation, serialization, and client-close no-resurrection.
- `IDEA2-AEGIS_Monitor/tests/producerDemandGrant.test.mjs` — retry classification coverage for transport failure versus Engine authority/stale-generation rejection.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-07_045500_pub_idea2-monitor-stream-revalidation-resilience.md` — immutable final task receipt.

## Verification evidence

- `node --test tests/physicalCameraStreamRouting.test.mjs tests/producerDemandGrant.test.mjs` — PASS: 59 total, 58 passed, 0 failed, 1 conditional PostgreSQL skip.
- The two new transient post-renew resilience tests against the authorized pre-fix source — FAIL as expected; genuine RED proof PASS.
- `node --test tests/physicalCameraStreamRouting.test.mjs tests/producerDemandGrant.test.mjs tests/producerLifecycle.test.mjs tests/streamLifecycle.test.mjs` — PASS: focused resilience/security suite completed with 0 failures and only the explicit disposable-PostgreSQL skip.
- `npm test` — PASS: 341 total, 232 passed, 0 failed, 109 conditional PostgreSQL skips; skipped database tests are not claimed as executed PASS.
- `npm run build` — PASS.
- `git diff --check` — PASS.
- Exact source review before receipt commit — PASS: Critical 0, Important 0, Minor 0.

## Canonical notes updated

- None — this narrow source-fix PR records its reviewed checkpoint through this immutable receipt; Production acceptance remains pending.

## Shared surfaces touched

- None — implementation, tests, and receipt are IDEA2-owned paths.

## Integration requests

- IDEA2 owner: after exact-head review and merge into the parent feature branch, deploy the reviewed Monitor source only under a separately controlled Production change.
- Re-run CAM-01 7-minute stability, SOC passive attach/release, CAM-02 acceptance, Archive playback/download, and final freeze before declaring Machine A acceptance complete.
- Do not modify Detection Engine, Identity Agent, DB schema, HUB/nginx, Twingate, firewall, SSH/tunnel configuration, IDEA1, or IDEA3 as part of this rollout.

## Known limitations

- The reviewed Monitor fix has not yet been deployed into Production.
- CAM-01 7-minute post-fix soak has not yet been re-run.
- SOC passive release/finalization, CAM-02 acceptance, Archive UI playback/download, browser visual confirmation, and final Production freeze remain pending.
- Conditional PostgreSQL integration tests requiring an explicit disposable test database were skipped and are not claimed as executed PASS.
