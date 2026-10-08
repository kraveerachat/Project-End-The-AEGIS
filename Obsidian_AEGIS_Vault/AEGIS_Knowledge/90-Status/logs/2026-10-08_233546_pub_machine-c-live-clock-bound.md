---
title: Task Receipt — Machine C Live signed-clock bound
date: 2026-10-08T23:35:46+07:00
owner: pub
area: idea2
branch: fix/idea2-machine-c-producer-clock-bound
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Machine C Live signed-clock bound

## What changed

- Monitor now accepts a nonce-bound, authenticated Engine Boot clock interval
  wholly within ±1,000 ms, while retaining the 500 ms monotonic probe limit.
  The observed Machine C +559 ms offset is covered by deterministic offline
  tests; this is not real-camera acceptance.
- Attach/refresh Demand Grants use the signed interval's lower endpoint and
  subtract the full 500 ms provisional DB/Monitor bound plus a 150 ms guard.
  This avoids expiry extension from an earlier DB sample when DB and Engine
  clocks move together. Monitor wall-clock discontinuities fail closed.
- The expiry proof is conditional: DB/Monitor absolute offset must remain at
  most 500 ms throughout signed Engine observation through mint, and
  DB/Engine relative divergence must remain at most 100 ms from that signed
  sample through DB lease expiry. These Production premises are **not yet
  validated**; deployment must remain blocked until they are justified.

## Source files changed

- `IDEA2-AEGIS_Monitor/server/auth/producerDemandGrant.js` — signed offset interval, monotonic timing, bounded grant conversion.
- `IDEA2-AEGIS_Monitor/server/db/producerLifecycle.js` — paired wall/monotonic DB-observation timestamps.
- `IDEA2-AEGIS_Monitor/server/routes/api.js` — pass verified Boot evidence to minting.
- `IDEA2-AEGIS_Monitor/tests/fixtures/physicalLinkRouteLoader.mjs` — deterministic paired-clock fixtures.
- `IDEA2-AEGIS_Monitor/tests/physicalCameraStreamRouting.test.mjs` — Machine C-style strict-stream and existing cleanup coverage.
- `IDEA2-AEGIS_Monitor/tests/producerDemandGrant.test.mjs` — RED/GREEN offset, boundary, replay, clock-step, and expiry cases.

## Verification evidence

- `node --test --test-name-pattern "common DB and Engine clock movement" tests/producerDemandGrant.test.mjs` — RED: failed before the full 500 ms DB/Monitor subtraction.
- `node --test tests/producerDemandGrant.test.mjs tests/physicalCameraStreamRouting.test.mjs tests/producerLifecycle.test.mjs tests/machineAAccountSymmetry.test.mjs` — PASS: 83 pass, 1 conditional disposable-PostgreSQL skip, 0 fail.
- `npm test` — PARTIAL: 352 total, 242 pass, 109 conditional skips, 1 fail. The failure is the pre-existing Archive static assertion expecting `recorder.submit_detection(result, frame)` while unchanged Engine source uses `recorder.submit_annotated(annotated)`; neither file is modified here.
- `node --test <the package test file list excluding tests/archiveRecordingContract.test.mjs>` — PASS: 347 total, 238 pass, 109 conditional skips, 0 fail. The excluded Archive test file contains five tests; four passed in the full run.
- `npm run build` — PASS: Vite production build, 2,078 modules transformed; no deployment.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/coreEntryGovernanceR4.test.mjs` — PASS: 61/61.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS with two pre-existing owner-canvas warnings.
- `git diff --check` — PASS.
- Added-content credential/private-key pattern scan — PASS: zero hits; fixture-only test key is non-secret.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — source checkpoint and blocked Production clock-discipline gate.

## Shared surfaces touched

None — the task stayed inside IDEA2-owned Monitor code, tests, and knowledge.

## Integration requests

None — no cross-scope/shared path changed. Human review must still confirm the
stacked PR and the Production clock-discipline evidence before deployment.

## Known limitations

- Production DB/Monitor absolute-offset and DB/Engine 30-second relative-drift
  premises have not been measured or approved; the 100 ms guard is provisional.
- No Production deployment, Machine A/C runtime change, Engine source change,
  real-camera activation, or live Machine C acceptance was performed.
- The conditional real-PostgreSQL route test was not run because this isolated
  worktree has no disposable PostgreSQL connection configured.
- The full Monitor suite retains the unrelated pre-existing Archive static
  assertion failure described above; this task does not change that source.
