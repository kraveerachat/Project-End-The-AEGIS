---
title: Task Receipt — IDEA1 D-1 PR-D default-off preview-index writer and thumb/poster
date: 2026-10-02T22:25:20+07:00
owner: kla
area: idea1
branch: feat/idea1-preview-d1-d-writer-thumb-poster
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 D-1 PR-D default-off preview-index writer and thumb/poster

## What changed

- Implemented plan Phase E (E.1–E.4) and Phase F (F.1–F.5) only, on a branch from post-PR-C `origin/main` `98c3e7741984ba28db50c7aa89d9748ca4cd70c3` (PR #295 verified MERGED first). No Phase G/H/I or PR-E work.
- E.1 writer capability derived only from the served `/state` flag `previewIndexWriteEnabled === true` (env `VAULT_PREVIEW_INDEX_WRITE_ENABLED`, default false); with it off `offer()` → `DISABLED` and zero requests. E.2 writer core: pre-filter on the current main manifest → seal thumb/poster derivatives → re-read latest main head + index head/root → `applyUpserts`/`planSplit` → seal shards + root → independent index CAS (attach = applied derivatives + new shards + root; superseded = replaced shards + old root, advisory only) → 409 retry ≤ `casMaxAttempts`, lost-response identical body+key resend once then head compare. E.3 end-to-end writer-OFF negative control through the real Vault screen. E.4 per-unlocked-session storage-budget circuit breaker (507 at derivative/shard/root create or commit → latch, queue cleared, no partial CAS, no DELETE).
- F.1 thumb/poster generation from the local File (header admission before decode, vp1 bounds, WebP when encodable else JPEG, one lower-quality retry, time budget, local object URL revoked). F.2 post-upload queue: starts only after `uploadTreeFile` ok AND reconcile, never awaited, paused while uploads are active. F.3 lazy backfill from original-path tile bytes (no transport/crypto import; once per node/kind/source per session; ≤ 50/session; 1 concurrent; deferred during upload/download/modal). F.4 cleanup for all seven purge reasons. F.5 allow-listed privacy-safe counters/timings, wired into the screen.
- Independent review: 1 finding (lost-response detection when a transport throws instead of resolving status 0). Not reachable through `apiFetch` (it resolves network/abort/timeout as status 0, already covered by PIW-9); hardened anyway (`13e47db9`, PIW-17).
- `WRITER_ENABLED_IN_PRODUCTION=NO`, `MAIN_MANIFEST_SCHEMA_WRITE=1`, `MAIN_MANIFEST_PREVIEW_LINKAGE=NONE`, `DESTRUCTIVE_GC=NONE`, `SUPERSEDED_REF_DELETION_AUTHORITY=NO`, `PRODUCTION_MUTATION_PERFORMED=NO`. No server, DB, migration, Compose, `.env` or flag-default change.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexWriter.js` — new: capability-gated writer, CAS protocol, budget breaker.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultDerivativeGenerate.js` — new: thumb/poster generation from the local File; post-upload queue.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultDerivativeBackfill.js` — new: lazy backfill from tile bytes.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewDiagnostics.js` — allow-listed preview-index counters/timings.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexReader.js` — root/shard fetch/decode timing hooks.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexTiles.js` — head-status and derivative-miss counters.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexObject.js` — seal failure carries the server's opaque error code.
- `IDEA1-AEGIS_Drive_LC/src/screens/VaultTreeScreen.jsx` — writer/queue/backfill/counters wiring; post-reconcile upload hook; tile poster at 512 px only when the writer is on.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexWriterOff.test.js`, `tests/previewIndexWriter.test.js`, `tests/previewIndexWriterBudget.test.js`, `tests/vaultDerivativeGenerate.test.js`, `tests/previewIndexUploadFlow.test.js`, `tests/previewIndexBackfill.test.js`, `tests/previewIndexLock.test.js` — new task tests.
- `IDEA1-AEGIS_Drive_LC/tests/helpers/previewIndexWriterFakeServer.mjs`, `tests/fixtures/derivativeGenerateScreenStub.js`, `tests/helpers/vaultScreenHarness.js` — test harness (writer fake server; jsdom generation seam).
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewDiagnostics.test.js`, `tests/vaultTreeSourceScan.test.js`, `tests/vaultUnlockedState.test.js` — extended (F.5 counters, SS-PI-2 storage/console scan, SS-PI-3 main-manifest isolation, US-D1 purge).
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexLifecycleGuards.test.js` — LG-5 admits the writer as the sole producer of advisory `supersededBlobIds` (declared once, placed once in the CAS body); still forbids any reader.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexTiles.test.js` — PIT-6 wiring pin follows the counters argument.

## Verification evidence

- `node --test --test-concurrency=1 --test-reporter=tap "tests/**/*.test.js"` (bounded `timeout --kill-after=30 5400`, no DATABASE_URL) at `13e47db9` — fail: 2,836 tests / 2,541 pass / 102 fail / 193 skip. Baseline `98c3e774` same command: 2,725 / 2,431 / 101 fail / 193 skip. Name diff: 1 branch-only (`PIT-6`, a source-shape pin of the screen text changed by the counters wiring) — fixed in `ab7238b0` (previewIndexTiles 7/7); 0 base-only. `NEW_DETERMINISTIC_FAILURES=0`; `FULL_SUITE_PASS` not claimed (101 pre-existing failures, e.g. vaultMediaPreview 24, vaultUnlockedState US-5b/US-6, previewIndexOrphans PIO-2 — all identical on base).
- Focused task suites — pass: writer-off 6 (incl. E.3 screen scenario), writer 18, writer budget 7, generate 11, upload flow 8, backfill 11 (incl. screen NO_EXTRA_ORIGINAL_FETCH: identical original reads WRITE on vs off), lock 43 (7 reasons × 6 in-flight stages + throwing disposer), diagnostics 5, source scan 6, unlocked-state US-D1.
- Mutation checks (local, uncommitted): budget latch disabled → 6/7 budget tests fail; reader cache clear removed → 14/43 lock tests fail; backfill disposer removed → 43/43 fail.
- PostgreSQL 15 disposable (`scripts/pg-integration-env.sh`, `drive_app`, port 55750) — pass, 0 skips: previewIndexCasPostgres 6/6, previewIndexStorageBudgetPostgres 3/3, previewIndexStorageBudget 10/10, previewIndexStorePostgres 15/15, `PI_UPLOAD_PG=1` previewIndexUploads 7/7, previewIndexLifecycleGuards 6/6. PR-D changes no server code; these confirm the contract the writer relies on.
- `npm run build` — pass; tracked `dist` restored. `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/coreEntryGovernanceR4.test.mjs` — pass 61/61. `git diff --check origin/main...HEAD` — pass. Changed-path and added-line secret scan — 0 matches.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — new current task D1-D (IMPLEMENTED + VERIFIED_LOCAL, HG-D), session register D1D-S1 and limitations; PR-C block marked merged.

## Shared surfaces touched

- `None` — task stayed inside its selected area (IDEA1 code, tests and canonical note).

## Integration requests

- None — no cross-scope or shared path changed; no server, DB, migration or deployment change. Human Owner review at HG-D; WRITE stays false everywhere and the budget value stays PROVISIONAL until HG-G.

## Known limitations

- With WRITE=true the original-path video tile poster is drawn at 512 px (vp1 edge) instead of 640 so backfill can reuse it; WRITE=false is unchanged.
- The client attach cap (64) mirrors the server default and is not read from the server; a lower server setting would fail the CAS soft (`INVALID_INPUT`).
- An index whose root or shard cannot be verified is not repaired by the writer (fails soft); repair is future work.
- Counters live in page memory only and are not emitted anywhere yet.
- jsdom/Node evidence only (decode/encode/video injected); no Chrome, IDX-SIZE (Phase G), security gate (Phase H), rollback (Phase I) or Production evidence is claimed. Not deployed, not accepted.
