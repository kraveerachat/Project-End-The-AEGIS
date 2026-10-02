---
title: Task Receipt — IDEA1 D-1 PR-C CAS, upload lifecycle, storage budget and orphan safety
date: 2026-10-02T15:57:24+07:00
owner: kla
area: idea1
branch: feat/idea1-preview-d1-c-cas-lifecycle
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 D-1 PR-C CAS, upload lifecycle, storage budget and orphan safety

## What changed

- Implemented plan Phase C (C.1–C.7) and Phase D (D.1–D.4) only, on a branch from post-PR-B `origin/main` `4a8cc3c95e2f4147fbab9c505079c0377a271d99` (PR #285 verified MERGED first).
- C.1 owner-scoped index CAS (memory + PostgreSQL): owner `vault_tree_state` FOR UPDATE → TREE_V1 + main head → idempotent replay / key-reuse mismatch → index head lock → expected generation/root → attach = caller's INDEX_STAGED V2 blobs → root contentId → superseded = caller's INDEX_MANAGED only → generation row, ATTACHED/SUPERSEDED refs, prior `superseded_at`, INDEX_STAGED → INDEX_MANAGED, head upsert. No deletion. `SUPERSEDED_REF=ADVISORY_ONLY`, `SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO`.
- C.3 write-gated `POST /api/vault/tree/preview-index/head` (503 with WRITE off before any store call, strict body, server-computed digest, 409 exposes only currentGeneration/currentRootBlobId, privacy-safe audit). C.4 `previewIndex` upload family: INDEX_STAGED written in the blob commit transaction; legacy/tree families unchanged. C.5 transport-only `casPreviewIndexHead`. C.6 pure merge/rebase/split/prune. C.7 per-owner retained-storage budget (advisory at create, authoritative inside the commit transaction under the owner lock; `retained + new <= max` allowed, otherwise 507 `PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED`; preview persistence only).
- D.1 authenticated classification; D.2 recovery never offers reserved blobs, unnamed/undecryptable recover only under a user-entered non-empty name; D.3 lifecycle guards pinned with falsifiability; D.4 read-only reachability report (counts only, never automatic). Retention: KEEP EVERYTHING; growth bounded only by the C.7 budget.
- Independent whole-branch review: 0 Critical / 0 Important; Minor fixes applied (507 cleanup never 500, invalid CAS body audited DENIED, cancel-only DELETE pinned, frozen-head comment). `WRITER_IMPLEMENTED=NO`, `WRITER_ENABLED=NO`, `PRODUCTION_DB_CHANGED=NO`, `PRODUCTION_MUTATION_PERFORMED=NO`.

- Post-PR-#297 reconciliation: `origin/main` `9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f` (preview-index tables: `drive_app` SELECT/INSERT/UPDATE only, no DELETE/TRUNCATE) merged normally, no conflict, no PR-C code change required.
- Post-Stage-1 reconciliation: `origin/main` `bef58a47d9304725cfe000741e0331a0091c4ae6` (PR #294 merged; Stage 1 accepted in Production with STAGE1_ACCEPTED=YES, 0 index rows, writer OFF) merged normally; single conflict in `idea1-status.md` resolved by preserving Stage 1 package and live acceptance evidence; no PR-C code changes required.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/server/db/vaultPreviewIndexStore.js` — index CAS, generation/ref listings, budget enforcement (`assertIndexBudgetWithinCommit`, `stageIndexBlobWithinBudget`).
- `IDEA1-AEGIS_Drive_LC/server/db/vaultTreeStore.js` — memory-only synchronous row accessor for the CAS/budget critical sections.
- `IDEA1-AEGIS_Drive_LC/server/db/vaultV2Store.js` — memory-only synchronous V2 blob accessor.
- `IDEA1-AEGIS_Drive_LC/server/routes/vaultPreviewIndex.js` — write-gated CAS route, preview-index uploads router with injected budget.
- `IDEA1-AEGIS_Drive_LC/server/routes/vaultUploads.js` — factory mode `previewIndex` (write gate, INDEX_STAGED commit, budget at create/commit, 507 cleanup).
- `IDEA1-AEGIS_Drive_LC/server/routes/api.js` — mount preview-index uploads before the read router.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeApi.js` — `casPreviewIndexHead`.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexMerge.js` — pure merge/rebase/split/prune.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexOrphans.js` — classification, reachability report, retention policy.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexReader.js` — read-only `shardOf` for the report.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeUpload.js` — reserved-blob filtering, `listOrphanBlobsDetailed`, NAME_REQUIRED.
- `IDEA1-AEGIS_Drive_LC/src/components/vault/VaultRecoveryPanel.jsx` — explicit-name recovery, no invented names.
- `IDEA1-AEGIS_Drive_LC/tests/helpers/previewIndexCasSpec.mjs`, `tests/helpers/previewIndexStoreSpec.mjs`, `tests/helpers/previewIndexUploadHarness.mjs` — shared memory/PG specs and harness.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexStore.test.js`, `tests/previewIndexStorePostgres.test.js`, `tests/previewIndexCasPostgres.test.js`, `tests/previewIndexApi.test.js`, `tests/previewIndexApiClient.test.js`, `tests/previewIndexUploads.test.js`, `tests/previewIndexMerge.test.js`, `tests/previewIndexStorageBudget.test.js`, `tests/previewIndexStorageBudgetPostgres.test.js`, `tests/previewIndexOrphans.test.js`, `tests/previewIndexLifecycleGuards.test.js`, `tests/vaultTreeRecoveryUi.test.js`, `tests/vaultTreeSourceScan.test.js` — C/D tests and updated PR-A route/scan pins.

## Verification evidence

- `node --test --test-concurrency=1 --test-reporter=tap "tests/**/*.test.js"` (bounded `timeout --kill-after=30 5400`, no DATABASE_URL) at `78358050` — fail: 2,721 tests / 2,431 pass / 100 fail / 190 skip. Failing names re-run at base `4a8cc3c9` on the same 14 files: 100 fail; exact name diff NEW_IN_BRANCH=0, ONLY_IN_BASE=0 (`NEW_DETERMINISTIC_FAILURES=0`). Legacy failures (vaultV2ScreenUi, vaultMediaPreview, vaultTileActions, vaultStateSync, publicShareStageB*, i18n, neo, dashboard) are not fixed and `FULL_SUITE_PASS` is not claimed.
- PostgreSQL 15 disposable (`scripts/pg-integration-env.sh`, `drive_app`, one DB per file) at final head — pass, 0 skips: previewIndexStorePostgres 15/15, previewIndexCasPostgres 6/6, previewIndexStorageBudgetPostgres 3/3, previewIndexMigration 9/9, vaultV2Postgres 17/17, `PI_UPLOAD_PG=1` previewIndexUploads 7/7, previewIndexStorageBudget 10/10, previewIndexLifecycleGuards 6/6. vaultTreePostgres 34/35 once: `PG-MG-2` genesis-race flake, reproduced on base 3/10 (pre-existing).
- Concurrency: same-generation CAS → 1 winner; 20 writers → generations 1..20, no gaps; main + index CAS → no deadlock (5 s timeouts); lost response → replay; key reuse + different body → rejected; owner at max − S, 10 parallel commits → 1×201, 9×507, retained = max. Falsifiability: removing the CAS row locks fails 4/6 CAS tests; removing the budget owner lock fails PIB-PG-1/2; making superseded ids PURGE_PENDING fails LG-4/5/6 and PI-CAS-4 (local, uncommitted, restored).
- Focused memory suites at final head — pass: store 16, API 17, client 6, uploads 7, merge 12 (seeded property), budget 10, orphans 6, lifecycle 6, recovery UI 13, source scan 4, vaultTreeUploadsApi/vaultV2Api/uploadRecoveryLifecycle/vaultTreeUploadClient/vaultUploadRecovery/uploadRecovery regressions 0 fail.
- `npm run build` — pass (2,760 modules); tracked `dist` restored. `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs` — pass 59/59. `git diff --check 4a8cc3c9...HEAD` — pass. Changed-path and added-line secret scan — 0 sensitive paths, 0 secret-pattern matches.

- Post-PR-#297 PostgreSQL re-verification (disposable, role script narrowing applied) — pass, 0 skips: previewIndexMigration 13/13, previewIndexStorePostgres 15/15, previewIndexCasPostgres 6/6, previewIndexStorageBudgetPostgres 3/3, vaultV2Postgres 17/17, `PI_UPLOAD_PG=1` previewIndexUploads 7/7, previewIndexStorageBudget 10/10, previewIndexLifecycleGuards 6/6. Memory C/D + upload/recovery regressions 149 pass / 0 fail / 7 PG-gated skip. Scratch compromised-role probe (not committed): `drive_app` DELETE on heads/generations/refs → `permission denied`; head row intact; CAS continues normally (stuck-index path closed). Governance 59/59 pass.
- Post-Stage-1 re-verification (disposable PostgreSQL 15 `scripts/pg-integration-env.sh` on port 55433) — pass, 0 skips: previewIndexMigration 13/13, previewIndexStorePostgres 15/15, previewIndexCasPostgres 6/6, previewIndexStorageBudgetPostgres 3/3, `PI_UPLOAD_PG=1` previewIndexUploads 7/7, previewIndexStorageBudget 10/10, previewIndexLifecycleGuards 6/6, vaultV2Postgres 17/17. Memory C/D + upload/recovery regressions: 97/97 pass on focused memory suites, 77/77 pass on upload/recovery suites. Privilege contract verified: `drive_app` on preview-index tables retains SELECT=true, INSERT=true, UPDATE=true, DELETE=false, TRUNCATE=false. Governance 59/59 pass; `validate-vault` pass (2 warnings); `git diff --check` pass; secret scan pass (0 matches).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — Stage 1 recorded as deployed, accepted and merged; PR-C current task, session register, evidence and limitations retained.

## Shared surfaces touched

- `None` — every path is inside the IDEA1 code/test/canonical-note boundary or this receipt. Integration review is still requested (`integration-review: yes`) because the PR changes DB transactions, the CAS, upload/storage lifecycle and storage-budget enforcement.

## Integration requests

- Kla (IDEA1 owner + integration reviewer): review CAS transaction order, the shared owner-row lock (main CAS / index CAS / budget commit), and 507 budget semantics at HG-C before merge. No migration, flag change or rollout is requested; WRITE stays OFF and the budget value stays PROVISIONAL until HG-G.

## Known limitations

- Upload sessions are not bound to the family that opened them: the owner's own client can commit a preview-index session through the tree family (becomes an UNREFERENCED user file, hidden only by client classification) or vice versa (budget still enforced). No budget bypass, no cross-owner effect; binding needs a schema change, deferred.
- The uncommitted-upload cancel under `/preview-index/uploads` stays available with WRITE off (plan C.4 safe read); it refuses committed sessions.
- `reservedHidden` is computed but not shown in the recovery UI; the reachability report counts derivatives of an unverifiable shard as unreachable (diagnostics only); `rebaseRoot` throws on caller-bug inputs (duplicate base prefixes).
- Full suite ran at `78358050`; the final Minor-fix commit was verified by focused memory and PostgreSQL reruns, not a second full run. No browser, IDX-SIZE (Phase G), security gate (Phase H), rollback (Phase I) or Production evidence is claimed.
