---
title: Task Receipt — IDEA1 D-1 PR-A Preview-Index Compatibility and Read-Only API
date: 2026-10-02T03:10:27+07:00
owner: kla
area: idea1
branch: feat/idea1-preview-d1-a-compat-read
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 D-1 PR-A Preview-Index Compatibility and Read-Only API

## What changed

- D-1 plan Phase A (Tasks A.0–A.6) implemented and locally verified on PR #283. Base `origin/main` `2dc596d1e0bd46319647da75fd34bdd02a7b5f91`; final implementation/evidence checkpoint `7083ef43`. Maturity: IMPLEMENTED + LOCALLY VERIFIED; not deployed, not accepted.
- Default-OFF flag chain added to the existing fail-closed chain: `VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE` (requires `VAULT_TREE_SCHEMA_AVAILABLE`) → `VAULT_PREVIEW_INDEX_READ_ENABLED` (requires schema flag and `VAULT_MEDIA_PREVIEW_ENABLED`) → `VAULT_PREVIEW_INDEX_WRITE_ENABLED`. Provisional limits (attach 64, superseded 64, envelope batch 32). Retained-storage budget `VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER` has no approved value: unset → `null`; `WRITE=true` without it fails at boot; PROVISIONAL / TO_BE_MEASURED / Human approval at HG-G.
- Migration `012_vault_preview_index_v1.sql` (+ same DDL in `schema.sql`): `vault_preview_index_heads`, `vault_preview_index_generations` (immutable identity; `superseded_at` set once; undeletable except by owner cascade), `vault_preview_index_blob_refs` (immutable; `SUPERSEDED` rows are advisory only, never deletion authority); `vault_tree_blob_state.lifecycle` CHECK widened with `INDEX_STAGED`/`INDEX_MANAGED` by definition-matched constraint replacement. No row rewritten, no destructive SQL, no down-migration; drive_app gets SELECT/INSERT/UPDATE on the migration path.
- Read/accounting store `vaultPreviewIndexStore.js`: `getIndexHead`, `listIndexEnvelopes`, `listIndexBlobs`, `excludeIndexBlobIds`, `getRetainedIndexBytes` (INDEX_STAGED + INDEX_MANAGED ciphertext only, per owner). `BLOB_LIFECYCLES` gains the two values; `RECOVERABLE_BLOB_LIFECYCLES=['UNREFERENCED']`.
- GET-only routes `/api/vault/tree/preview-index/{head,envelopes,blobs}` behind auth + tree protocol + schema/READ gates, TREE_V1 only, owner-scoped (other owners absent/404), no-store, strict input without echo; 404 `PREVIEW_INDEX_NOT_FOUND` means "no index". `INDEX_*` blobs excluded from `GET /api/vault` and `GET /api/vault/tree/blobs`. Boot probe verifies migration-012 tables and widened lifecycle CHECK. Client read wrappers `getPreviewIndexHead` (404/503-disabled → null), `getPreviewIndexEnvelopes`, `listPreviewIndexBlobs`.
- Not included (by scope): codec, reader, CAS, preview upload mode, writer, derivative generation, budget enforcement, Phase B. No flag enabled anywhere. **PR-A must not be deployed to Production alone; Stage 1 requires PR-A + PR-B.**

## Source files changed

- `.env.example` — documents the three preview-index flags (all off) and the budget variable with no approved default.
- `IDEA1-AEGIS_Drive_LC/server/config/vaultTreeLimits.js` — flags, chain, provisional limits, budget, `PREVIEW_INDEX_TABLES`, `verifyPreviewIndexSchema`.
- `IDEA1-AEGIS_Drive_LC/server/db/migrations/012_vault_preview_index_v1.sql` — additive migration.
- `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — same DDL for fresh installs.
- `IDEA1-AEGIS_Drive_LC/server/db/vaultPreviewIndexStore.js` — read/accounting store.
- `IDEA1-AEGIS_Drive_LC/server/db/vaultTreeSchemaProbe.js` — `probePreviewIndexSchema`.
- `IDEA1-AEGIS_Drive_LC/server/db/vaultTreeStore.js` — lifecycle constants.
- `IDEA1-AEGIS_Drive_LC/server/index.js` — boot probe call and log line.
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — router mount; `GET /api/vault` INDEX_* exclusion.
- `IDEA1-AEGIS_Drive_LC/server/routes/vaultPreviewIndex.js` — read-only routes and gates.
- `IDEA1-AEGIS_Drive_LC/server/routes/vaultTree.js` — `/tree/blobs` INDEX_* exclusion.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeApi.js` — read wrappers.
- `IDEA1-AEGIS_Drive_LC/tests/helpers/previewIndexStoreSpec.mjs` — shared memory/PG store spec.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexApi.test.js` — route, gate, isolation, inventory-exclusion tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexApiClient.test.js` — client wrapper tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexCompatA.test.js` — compatibility boundary tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexMigration.test.js` — static + PostgreSQL migration and probe tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexStore.test.js` — store spec, memory mode.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexStorePostgres.test.js` — store spec, PostgreSQL.
- `IDEA1-AEGIS_Drive_LC/tests/vaultTreeConfig.test.js` — CF-1/FLAG-CHAIN snapshots extended; PI config/budget/boot tests.
- `IDEA1-AEGIS_Drive_LC/tests/vaultTreePostgres.test.js` — 011 schema-equality slice bounded at the 012 block (012 has its own equality test).
- `IDEA1-AEGIS_Drive_LC/tests/vaultTreeSourceScan.test.js` — SS-PI-1 boundary scan.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — D1-A task/session record; D-1 plan task closed.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-02_031027_kla_idea1-d1-pr-a-compat-read-api.md` — this one final receipt.

## Verification evidence

- `timeout --kill-after=30 5400 node --test --test-concurrency=1 "tests/**/*.test.js"` (IDEA1, memory mode) — FAIL by count with pre-existing failures, no deterministic regression: A.0 baseline at `2dc596d1` (separate detached worktree) 2530 tests / 2268 pass / 100 fail / 0 cancelled / 162 skip; PR-A at `7083ef43` 2575 / 2303 / 101 / 0 / 171. Failing-name diff: 0 baseline names fixed or lost; 1 differing name, `tests/vaultTreeApi.test.js :: OR-4 …` (`EPERM: operation not permitted, open …\vault-tree\….aegisenc`), reproduced as an intermittent failure on the untouched baseline (1 of 6 isolated runs) and on PR-A (1 of 3) — pre-existing Windows environmental flake. +45 tests and +9 skips are the new suites (9 PostgreSQL-gated cases skip in memory mode).
- PostgreSQL 15 via `AEGIS_PGTEST_PORT=55750 sh scripts/pg-integration-env.sh up` (disposable, drive_app non-superuser; schema from this branch): `node --test --test-concurrency=1 tests/vaultTreePostgres.test.js` 35/35 PASS; `tests/vaultV2Postgres.test.js` 17/17 PASS; `tests/vaultPostgres.test.js` 9/9 PASS — identical on baseline and PR-A code (baseline code ran against the 012-migrated template: partial rollback evidence); `tests/previewIndexMigration.test.js` 9/9 PASS (0 skip); `tests/previewIndexStorePostgres.test.js` 5/5 PASS (0 skip).
- `node --test --test-concurrency=1 tests/vaultTreeConfig.test.js tests/previewIndexMigration.test.js tests/previewIndexStore.test.js tests/previewIndexApi.test.js tests/previewIndexApiClient.test.js tests/previewIndexCompatA.test.js tests/vaultTreeSourceScan.test.js` — PASS: 45 pass, 0 fail, 4 PG-gated skips (memory mode).
- RED evidence per task: A.1 8 failing before implementation; A.2 4 static failing with migration removed; A.3 module-not-found; A.4 7 failing before routes/exclusion; A.5 3 failing before wrappers. A.6 tests are characterization tests of the delivered boundary.
- `npm run build` — PASS (existing chunk-size warning only); `dist` restored, not committed.
- `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs` — PASS 49/49; `node scripts/validate-vault.mjs` — PASS with two pre-existing canvas warnings; `git diff --check` — PASS; local collaboration-policy validation — PASS; secret-pattern scan of the branch diff — PASS.
- Environment: Windows 11 Pro 10.0.26200, Node v24.14.0, Chrome 154.0.8037.58 (recorded; no browser test in Phase A).
- Production safety: no Production connection, migration, deployment, flag change or mutation.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — Current Task D1-A with session D1A-S1 evidence; D-1 plan task moved to Closed (PR #280 merged at `2dc596d1`).

## Shared surfaces touched

- `.env.example` — repository-root deployment contract; documents new flags (all off) and the budget variable (no approved default).
- `IDEA1-AEGIS_Drive_LC/server/db/migrations/012_vault_preview_index_v1.sql` — database migration; additive tables plus widened lifecycle CHECK.
- `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — fresh-install schema bind-mounted by `postgres/init/01-run-app-init.sh`.

## Integration requests

- Kla: integration review of migration 012 (lifecycle CHECK replacement, triggers, grants) and `.env.example`, then Human merge of PR #283 (HG-A). Merge authorizes no deployment: Stage 1 (PR-A + PR-B; migration 012 applied by a Human superuser after backup; SCHEMA=true, READ=true, WRITE=false, PURGE=false; acceptance `GET /preview-index/head` → 404) is a separate Human gate after PR-B merges. Rollback target: previous accepted runtime image with migration 012 retained; no down-migration.

## Known limitations

- Read-only foundation: no code in this PR can create an index; budget is measured (`getRetainedIndexBytes`) but enforced only in PR-C.
- Full suite still has the 100 pre-existing baseline failures plus the intermittent OR-4 EPERM flake; no claim of a clean full suite.
- After a rollback to a pre-D-1 server, `GET /api/vault` would again include any INDEX_* envelopes (none exist until a writer ships).
- No browser, Remote-path, Production or Human acceptance evidence; those belong to Stage 1 after PR-B.
