---
title: Task Receipt — IDEA2 Monitor steady-state idle watchdog
date: 2026-10-04T08:10:26+07:00
owner: pub
area: idea2
branch: fix/idea2-monitor-steady-idle-watchdog
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Monitor steady-state idle watchdog

## What changed

- Repository-only follow-up to merged PR #328. Owner-provided Production evidence showed cold first-byte handling succeeded, but Monitor closed two established streams after six seconds without data while Operator remained on Live. The owner bounded-rolled-back the Monitor image to `aegis-prod-monitor:idea2-ba-csp-6ddcf184a5a9`; this task did not perform that rollback or any Production action.
- Monitor now retains the 50-second pre-first-byte budget and permits 20 seconds between subsequent upstream data (Engine default 15-second idle contract plus five seconds for transport). Only nonempty body data changes watchdog phase; headers do not.
- Existing authorization, Browser Association, server-owned producer generation, session/assignment revalidation, client-close abort, and one release per acquired demand retain their prior behavior. No recording/Archive, GPU, UI, Engine, Agent, HUB, database, or deployed runtime change is included.

## Source files changed

- `IDEA2-AEGIS_Monitor/server/routes/api.js` — bounded 20-second post-first-byte watchdog with the original 50-second startup timer unchanged.
- `IDEA2-AEGIS_Monitor/tests/fixtures/streamAbortCrashChild.mjs` — two real route-frame deliveries separated by a scaled gap, then a later stall.
- `IDEA2-AEGIS_Monitor/tests/fixtures/streamAbortCrashLoader.mjs` — scale the source steady-state budget for the route regression without waiting real seconds.
- `IDEA2-AEGIS_Monitor/tests/streamLifecycle.test.mjs` — RED/GREEN proof of tolerated inter-frame gap and bounded later stall.
- `IDEA2-AEGIS_Monitor/tests/physicalCameraStreamRouting.test.mjs` — retain the injected strict Operator timer for existing timeout/close/revalidation/release tests.

## Verification evidence

- `npm test` in the new isolated Monitor worktree before edits — baseline PASS: 182 passed, 0 failed, 58 conditional skips.
- `node --test tests/streamLifecycle.test.mjs` after test-only edits, before runtime change — expected RED: 12 passed, 2 failed. The second frame was lost after the old 30 ms scaled idle timeout; the log reported `no data for 30ms` instead of the required 100 ms scaled window.
- `node --test tests/streamLifecycle.test.mjs tests/physicalCameraStreamRouting.test.mjs` after the runtime change — PASS: 49 passed, 0 failed, 1 conditional PostgreSQL skip. The strict route still proves once-only demand release for timeout, close and race paths.
- `node --test tests/streamLifecycle.test.mjs tests/physicalCameraStreamRouting.test.mjs tests/machineAAccountSymmetry.test.mjs tests/liveCamera.test.mjs tests/viewerDemandAvailability.test.mjs tests/localNodeLeaseMaintenance.test.mjs` — PASS: 70 passed, 0 failed, 1 conditional PostgreSQL skip; includes association/SOC and physical-generation boundaries.
- `npm test` — PASS: 184 passed, 0 failed, 58 conditional skips; real PostgreSQL gates require an explicitly disposable test URL and were not run.
- `npm run test:browser` — PASS: 21/21 against local fixture services; no real camera.
- `npm run build` — PASS.
- `node --test tests/streamLifecycle.test.mjs` after the strengthened stall assertion — PASS: 14/14.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs` at repository root — PASS: 59/59.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS with two pre-existing Canvas owner-data warnings.
- `git diff --check` — PASS. Added-content private-key/credential pattern scan — zero hits. Independent read-only code/security review — Critical 0, Important 0, Minor 0; real-hardware behavior remains outside that review.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — records the owner-provided post-PR #328 Production failure/rollback, current source-only correction, and outstanding real-hardware acceptance.

## Shared surfaces touched

None — every changed path is IDEA2-owned source, test, or knowledge.

## Integration requests

- IDEA2 owner: review this narrow PR and separately authorize a Production rollout. After deployment, prove sustained Operator Live with `connected=true`, `demanded=true`, `viewers>=1` and the physical camera LED ON throughout, then final-viewer/logout release; roll back the Monitor image if the live gate fails. These local tests do not establish hardware acceptance.

## Known limitations

- No Production deployment, Machine A runtime mutation, physical-camera access, or sustained real-hardware acceptance occurred in this task.
- The 20-second Monitor steady budget matches the Engine's current default 15-second idle setting plus five seconds. A future Engine idle-setting change requires a paired Monitor budget review.
- Conditional real-PostgreSQL gates were not executed. PR2 recording/archive and PR3 GPU-required inference remain separate, unstarted tasks.
