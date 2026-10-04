---
title: Task Receipt — IDEA2 Monitor first-byte watchdog
date: 2026-10-04T07:10:01+07:00
owner: pub
area: idea2
branch: fix/idea2-monitor-first-byte-watchdog
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Monitor first-byte watchdog

## What changed

- Repository-only PR1 fix for the owner-reported Production symptom: Monitor's six-second steady-state watchdog previously closed a cold Live stream before Engine's permitted 45-second first-frame window elapsed.
- The Monitor proxy now allows 50 seconds from post-acquisition/pre-fetch to its first nonempty upstream body data. That covers the Engine default 45-second first-frame window plus five seconds at the proxy/transport boundary. After data begins, the original six-second idle watchdog applies.
- Authorization-before-side-effect, local-node association, server-owned producer generation, periodic session/assignment revalidation, browser-close cancellation, and one demand release in route cleanup are unchanged. No Archive, recording, GPU, UI, Engine, or runtime change was made.

## Source files changed

- `IDEA2-AEGIS_Monitor/server/routes/api.js` — two-phase first-data/steady-state watchdog in the existing stream route.
- `IDEA2-AEGIS_Monitor/tests/fixtures/streamAbortCrashChild.mjs` — delayed/no-first-byte route scenarios.
- `IDEA2-AEGIS_Monitor/tests/fixtures/streamAbortCrashLoader.mjs` — bounded test-scale startup timeout alongside the existing idle timer injection.
- `IDEA2-AEGIS_Monitor/tests/streamLifecycle.test.mjs` — RED/GREEN first-byte and no-byte route regressions; existing post-data stall test retained.
- `IDEA2-AEGIS_Monitor/tests/physicalCameraStreamRouting.test.mjs` — strict Operator first-byte timeout releases its acquired demand once.

## Verification evidence

- `node --test tests/streamLifecycle.test.mjs` in `IDEA2-AEGIS_Monitor` before the route fix — expected RED: 10 passed, 2 failed. The delayed first byte yielded zero bytes because the old 25 ms test-scaled steady timer closed it; the no-byte case also closed at 25 ms instead of the 120 ms startup budget.
- `node --test tests/streamLifecycle.test.mjs` after the fix — PASS: 12/12.
- `node --test tests/streamLifecycle.test.mjs tests/physicalCameraStreamRouting.test.mjs tests/machineAAccountSymmetry.test.mjs tests/liveCamera.test.mjs tests/viewerDemandAvailability.test.mjs tests/localNodeLeaseMaintenance.test.mjs` — PASS: 68, fail 0, one conditional PostgreSQL skip.
- `npm test` in `IDEA2-AEGIS_Monitor` — PASS: 182, fail 0, 58 conditional skips (real PostgreSQL requires an explicitly disposable test URL). The first sandbox-only attempt had `spawnSync python EPERM`; rerun with child-process permission passed.
- `npm run test:browser` in `IDEA2-AEGIS_Monitor` — PASS: 21/21 against the local loopback fixture server.
- `npm run build` in `IDEA2-AEGIS_Monitor` — PASS.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs` — PASS: 59/59.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS with two pre-existing owner-data Canvas warnings.
- `git diff --check` — PASS. Changed-line credential/private-key pattern scan — zero hits.
- Independent read-only code review — Critical 0, Important 0. Its minor strict-route cleanup coverage suggestion was added and passed before finalization.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — current source-only fix, verification, and required post-merge hardware gate.

## Shared surfaces touched

None — all changed paths are IDEA2-owned source, tests, and knowledge.

## Integration requests

- IDEA2 owner: review the PR and arrange a separate approved Production rollout. After merge/deploy, verify Operator Live holds connected=true, demanded=true, viewers>=1 and the physical camera LED ON continuously while Live remains open; verify final-viewer/logout release. Roll back the Monitor image to its prior version if the live gate fails. Do not infer hardware acceptance from these repository tests.

## Known limitations

- No Production deployment, Machine A runtime mutation, camera access, or real-hardware Live acceptance occurred in this task.
- The 50-second Monitor startup budget is aligned to the Engine's current default 45-second first-frame setting. A future deployment that raises the Engine first-frame setting needs an explicit paired Monitor budget review.
- The real-PostgreSQL conditional test gates were not run here. PR2 recording/archive and PR3 GPU-required inference are separate, unstarted tasks.
