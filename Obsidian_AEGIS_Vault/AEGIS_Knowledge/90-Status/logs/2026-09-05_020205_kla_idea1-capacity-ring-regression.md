---
title: Task Receipt — IDEA1 capacity-ring false-positive regression
date: 2026-09-05T02:02:05+07:00
owner: kla
area: idea1
branch: fix/idea1-capacity-ring-regression
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 capacity-ring false-positive regression

## What changed

- Scoped `CAPACITY-RING-5` to the Capacity component contract by checking for its `data-capacity-ring` segment marker instead of rejecting every SVG `<circle>` rendered elsewhere on the Storage page.
- Confirmed the production Capacity component already exits before rendering ring segments when capacity has no readable denominator; no production, RAID, capacity-math, API, backup, database, deployment, or infrastructure source changed.
- Preserved the assertions that the Capacity card remains visible, the unreadable-capacity state is shown, and no fabricated `0.0%` is rendered.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/tests/storageCapacityRingUi.test.js` — replace the page-wide SVG-circle assertion with the CapacityRing-specific segment marker assertion.

## Verification evidence

- Pre-fix `node --test tests/storageCapacityRingUi.test.js` — **FAIL: 6/7** at `CAPACITY-RING-5`; the page-wide `<circle>` selector matched an unrelated rendered SVG icon.
- `node --test tests/storageCapacityRingUi.test.js` — **PASS: 7/7**, including `CAPACITY-RING-5`.
- `node --test tests/storageBackupUi.test.js` — **PASS: 9/9**; RAID behavior from PR #75 remains covered.
- `npm test` — **PASS: 966 total, 899 passed, 67 skipped, 0 failed**. PostgreSQL-only tests skipped because `TEST_DATABASE_URL` was absent.
- `npm run build` — **PASS**; Vite transformed 2,680 modules and retained the existing warning for a minified chunk larger than 500 kB.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs` — **PASS: 43/43**.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — **PASS with 2 existing owner-review warnings** for `AEGIS_Architecture_Canvas.canvas` and `AEGIS_Knowledge_Network.canvas`.
- `git diff --check` — **PASS**: no source whitespace errors.

## Canonical notes updated

- `None` — this is a regression-test selector correction; it does not change durable production behavior or the current IDEA1 capability status.

## Shared surfaces touched

- `None` — task stayed inside IDEA1 test and receipt paths.

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- PostgreSQL-backed tests remain unexecuted without `TEST_DATABASE_URL`; 67 such tests were skipped by the full suite.
- This task does not constitute a production deployment or production acceptance test.
- The existing Vite chunk-size warning remains; bundle splitting is outside this regression-test task.
- Vault validation still reports two owner-data canvas warnings; it reports no validation error.
