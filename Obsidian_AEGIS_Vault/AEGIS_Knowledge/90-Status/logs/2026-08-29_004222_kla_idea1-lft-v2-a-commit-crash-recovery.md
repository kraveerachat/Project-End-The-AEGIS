---
title: Task Receipt — LFT-V2-A commit crash recovery follow-up
date: 2026-08-29T00:42:22+07:00
owner: kla
area: idea1
branch: fix/idea1-lft-v2-a-commit-crash-recovery
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — LFT-V2-A commit crash recovery follow-up

> New receipt, not an append. PR #43 is **merged**, so its receipt
> `2026-08-28_194028_kla_idea1-large-file-transfer-v2-foundation.md` is frozen and
> was not touched by this task. This is a separate follow-up task with its own
> Pull Request and its own single receipt.

## Why this follow-up exists

PR #43 merged as commit `5145770abd19af389e447cd018bcff942e24d294`, carrying
Stage-A of LFT-V2-A. The crash-recovery work had been written and verified on the
same branch as commit `a16a9623b536740d90faf020ae5f179b17910b6b`, but that commit
was **never part of the merge**: the parent of `a16a962` is `13d408e`, which is
the branch tip PR #43 actually merged. The fix was authored after the merge commit
was formed, so it was left behind rather than rejected or superseded.

Merged `main` therefore ships the resumable upload protocol **with both defects
below still open**. This branch cherry-picks `a16a962` onto current `main` and
nothing else.

## What changed

- **A commit whose process dies is now recoverable instead of stranded forever.**
  Merged `main` takes a commit claim by setting `upload_sessions.status =
  'committing'`, a status that expiry cleanup and the user's cancel button are
  both told never to touch. That is correct while a commit is running and wrong
  the moment the process owning it dies: the user cannot commit (status is not
  `open`), cannot cancel, and cleanup will not reclaim it. There was no lease and
  no recovery worker, so the row stayed `committing` permanently.
- **A crashed same-name upload can no longer destroy the user's existing file.**
  Merged `main` calls `moveToVersions()` — a `rename` out of `uploads/` — *before*
  the metadata write. A crash inside that window leaves `files.path` pointing at a
  key that no longer exists: the existing file returns `404` from
  `GET /api/files/:id/download` and the new upload is not committed either. The V2
  commit path no longer moves those bytes at all.
- **Observable outcome:** after a hard process kill mid-commit, a restarted server
  converges every affected session to `open`, `committed` or `aborted` on its own,
  and an existing same-name file stays downloadable throughout.

### How the fix works

**Durable commit intent.** The final storage key is chosen and written to
`upload_sessions.commit_storage_key` in the same statement that takes the claim,
before any filesystem action. Merged `main` generated that key inside
`publishStagedPart()` where it lived only in a local variable, so a process dying
after the rename left bytes nothing could ever identify. `commit_started_at`
starts the lease; `committed_file_id` records which `files` row the session
produced.

**One transaction.** `finishUploadCommit()` writes the `files` row,
`committed_file_id` and `status='committed'` together, so a row still marked
`committing` means the metadata was definitely not written. The "crashed after
metadata, before status" case is removed by construction rather than handled by
recovery code; recovery still checks for it defensively, because a wrong decision
on that branch would publish a duplicate file.

**A lease, not a new status.** `recoverStaleCommits()` selects
`status='committing' AND commit_started_at < now() - lease` with
`FOR UPDATE SKIP LOCKED`, one row per transaction. No `recovering` status was
introduced on purpose — it would recreate the same stuck-state problem one level
up, whereas a row lock is released automatically when a dying worker's connection
drops.

**Same-name versioning.** The `file_versions` row references the previous file's
key **in place**, inside the same transaction that repoints `files.path`. Nothing
is renamed, so the window ceases to exist rather than narrowing.

## Invariants proven on this branch

| Invariant | Result |
| --- | --- |
| `STALE_COMMIT_RECOVERY` | PASS |
| `COMMIT_LEASE` | PASS |
| `DURABLE_COMMIT_INTENT` | PASS |
| `CRASH_AFTER_CLAIM` | PASS |
| `CRASH_AFTER_VERIFY` | PASS |
| `CRASH_AFTER_PUBLISH` | PASS |
| `CRASH_AFTER_METADATA` | PASS |
| `NO_DUPLICATE_FILE_ROW` | PASS |
| `NO_ORPHAN_FINAL_BYTES` | PASS |
| `NO_METADATA_TO_MISSING_BYTES` | PASS |
| `RECOVERY_IDEMPOTENT` | PASS |
| `RECOVERY_RACE_SAFE` | PASS |
| `SAME_NAME_VERSION_CRASH_SAFE` | PASS |
| `POSTGRES_15` | PASS (15.18) |
| `MIGRATION_IDEMPOTENT` | PASS |
| `APP_ROLE_BOUNDARY` | PASS |

Crash simulation does not rely on in-process `try`/`catch`. Each test drives a
real session to a phase over HTTP, then writes the exact state a dead process
leaves — the same row values `claimUploadSessionForCommit()` writes, and for the
publish phase the same `rename` — and then invokes recovery as a freshly booted
process would. The original request's catch block never runs.

## Source files changed

Delta measured as `git diff 5145770..HEAD`; it contains this follow-up and
nothing else.

- `IDEA1-AEGIS_Drive_LC/server/storage/commitRecovery.js` — **new.** The recovery
  worker and its scheduler; converges each stale session to OPEN/COMMITTED/ABORTED
  from what is actually on disk and in the tables.
- `IDEA1-AEGIS_Drive_LC/server/db/connection.js` — adds `withTransaction()`, which
  checks out one client. The existing `query()` takes an arbitrary pooled
  connection per call, so `BEGIN`/`COMMIT` through it would not be a transaction.
- `IDEA1-AEGIS_Drive_LC/server/db/store.js` — the claim persists commit intent;
  `releaseUploadSessionClaim()`; `finishUploadCommit()` as a single transaction
  whose version row keeps the old key in place; `withStaleCommitLease()` using
  `FOR UPDATE SKIP LOCKED`.
- `IDEA1-AEGIS_Drive_LC/server/storage/uploadStaging.js` — `newFinalStorageKey()`
  split from `publishStagedPartTo()` so the key exists before the rename;
  `finalKeyExists()`; shared path-containment resolver.
- `IDEA1-AEGIS_Drive_LC/server/routes/uploads.js` — commit persists intent before
  publishing and finishes through the single transaction.
- `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` — the three commit-intent columns,
  the FK and `upload_sessions_commit_idx` for new databases.
- `IDEA1-AEGIS_Drive_LC/server/db/migrations/003_upload_sessions.sql` — the same,
  as idempotent `ALTER … ADD COLUMN IF NOT EXISTS` for databases already on
  Stage-A.
- `IDEA1-AEGIS_Drive_LC/server/config/transferLimits.js` — `UPLOAD_COMMIT_LEASE_MS`
  (default 15 minutes, minimum 1 minute).
- `IDEA1-AEGIS_Drive_LC/server/index.js` — recovery at boot and on an interval,
  scheduled before cleanup.
- `IDEA1-AEGIS_Drive_LC/tests/commitCrashRecoveryPostgres.test.js` — **new.** 12
  crash-recovery tests (11 from the verified commit, plus the version-key consumer
  test added on this branch).
- `IDEA1-AEGIS_Drive_LC/tests/resumableUploadPostgres.test.js` — adds the Stage-A →
  crash-safe migration upgrade test.
- `IDEA1-AEGIS_Drive_LC/.env.example` — documents `UPLOAD_COMMIT_LEASE_MS`.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` —
  replaces the "Known gap: the session stays `committing` forever" paragraph with
  4.5.2 (surviving a crash mid-commit) and 4.5.3 (same-name versioning must not
  move the previous file's bytes).

## Verification evidence

- `npm test` (IDEA1, real PostgreSQL) — **pass: 467 tests, 467 passed, 0 failed, 0 skipped.**
  (466 on merged `main` plus the one regression test added here.)
- Every result here was produced **on this branch**, against a disposable
  PostgreSQL 15.18 container started by
  `sh IDEA1-AEGIS_Drive_LC/scripts/pg-integration-env.sh up` — pass. No previously
  recorded number was carried over.
- `node --test --test-concurrency=1 tests/commitCrashRecoveryPostgres.test.js` —
  **pass: 12/12** (11 cherry-picked + 1 added here).
- `node --test --test-concurrency=1 tests/resumableUploadPostgres.test.js` —
  **pass: 19/19.**
- `node --test --test-concurrency=1 tests/resumableUpload.test.js` — pass: 14/14.
- `node --test --test-concurrency=1 tests/chunkedUploadClient.test.js` — pass: 8/8.
- `node --test --test-concurrency=1 tests/fileVersions.test.js` — pass: 9/9.
- `node --test --test-concurrency=1 tests/filesUnifiedWorkflow.test.js` — pass: 2/2.
- `node --test --test-concurrency=1 tests/filesOwnership.test.js` — pass: 5/5.
- `node --test --test-concurrency=1 tests/vaultApi.test.js` — pass: 17/17.
- `node --test --test-concurrency=1 tests/vaultPostgres.test.js` — pass: 9/9.
- `node --test --test-concurrency=1 tests/vaultCrypto.test.js` — pass: 12/12.
- `node --test --test-concurrency=1 tests/vaultInventory.test.js` — pass: 13/13.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs tests/dockerBootstrap.test.mjs tests/endpointOnboarding.test.mjs`
  — pass: 53/53.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` —
  pass.
- `node scripts/validate-collaboration-policy.mjs --event <pr-event.json> --changed-files <delta>`
  — pass.
- `npm run build` (IDEA1) — pass: built in 16.08s. `dist/` was restored to its
  committed state afterwards, so no build output is in this Pull Request.
- `git diff --check` — pass. Targeted secret scan over the delta — pass.

### Migration from the merged Stage-A schema — measured, not assumed

A database was built from `schema.sql` **as it exists on merged `main`**
(`git show 5145770:IDEA1-AEGIS_Drive_LC/server/db/schema.sql`), seeded, given the
production grant set, and given one pre-existing `upload_sessions` row. Before the
migration, `upload_sessions` had exactly: `chunk_count, chunk_size, created_at,
expected_sha256, expires_at, logical_size, name, status, updated_at, upload_id,
user_id` — none of the commit-intent columns.

The branch's `003_upload_sessions.sql` was then applied **twice**:

- run 1 and run 2 both succeeded; run 2 emitted only `already exists, skipping`
  notices;
- `commit_started_at`, `commit_storage_key`, `committed_file_id` all present;
- `upload_sessions_committed_file_id_fkey` exists **exactly once** after two runs;
- `upload_sessions_commit_idx` present;
- the pre-existing row's fingerprint over the Stage-A columns was **identical
  before and after** (`b6151665976b7489139d4ce52d8ec0a2`);
- the three new columns are `NULL` on that pre-existing row.

### `drive_app` role boundary — measured

`drive_app` attributes read from `pg_roles`: `rolsuper=f`, `rolcreatedb=f`,
`rolcreaterole=f`, `rolinherit=f`, `rolcanlogin=t`.

DML sufficient — `SELECT`, `UPDATE` of `commit_started_at` / `commit_storage_key`,
and `SELECT … FOR UPDATE SKIP LOCKED` on `upload_sessions` all succeeded as
`drive_app`.

DDL denied — every statement below was refused:

```text
ALTER TABLE upload_sessions ADD COLUMN evil text   ERROR: must be owner of table upload_sessions
CREATE TABLE evil_t (id int)                       ERROR: permission denied for schema public
DROP TABLE upload_session_chunks                   ERROR: must be owner of table upload_session_chunks
TRUNCATE upload_sessions                           ERROR: permission denied for table upload_sessions
CREATE INDEX evil_idx ON upload_sessions (status)  ERROR: must be owner of table upload_sessions
```

### Recovery row locking — measured against PostgreSQL

With one stale `committing` row present:

- worker A held it inside an open transaction using `… FOR UPDATE SKIP LOCKED`;
  worker B running the identical query returned `<none>` in **0s** — it skipped
  rather than blocked, so one row has exactly one recoverer and a slow recoverer
  never stalls the pass;
- control, no lock held: the same query claimed the row;
- control, `commit_started_at = now()`: the row was invisible to the lease
  predicate, so a live commit is never recovered out from under itself.

### Commit lease survives a process restart — measured across two processes

Process 1 logged in, uploaded a real chunked file, took the commit claim exactly
as the server does, and then killed itself with `SIGKILL` — no unwind, no
`catch`, no `finally`, no connection close. Process 2 was a **separate `node`
invocation** that knew nothing except what PostgreSQL holds:

```text
1. lease state read by the NEW process : {"status":"committing",
                                          "commit_started_at":"2026-08-28T17:40:29.217Z",
                                          "commit_storage_key":"uploads/3636….bin"}
   default lease (ms)                  : 900000
2. recovery BEFORE lease expiry        : {"reopened":0,"committed":0,"aborted":0,"scanned":0}
   status still                        : committing
3. recovery AFTER lease expiry         : {"reopened":1,"committed":0,"aborted":0,"scanned":1}
   status now                          : open
   commit intent cleared               : true
4. recovery run AGAIN (idempotent)     : {"reopened":0,"committed":0,"aborted":0,"scanned":0}
   status unchanged                    : open
```

Step 3 aged `commit_started_at` by 16 minutes rather than waiting 16 minutes of
wall clock; the lease predicate and the default 15-minute lease were otherwise
unmodified.

### Same-name file preservation — the test is not vacuous

The old ordering was reproduced against the live isolated database and produced
`bytes readable = false` and `GET /download = 404` for the user's existing file.
The committed test asserts the opposite at the same instant: mid-crash, the
original file's bytes are still present and `GET /api/files/:id/download` still
returns them in full.

## Version storage — implementation detail on record

Because the V2 commit never renames the previous file's bytes, **versions created
by the V2 path keep a key under `uploads/`, not `versions/`.** This is an on-disk
detail, not user-visible corruption. It is safe because:

- `file_versions.storage_key` stores the correct key;
- every consumer resolves that stored key through `resolveKey()`, which is
  prefix-agnostic and path-containment checked — no code branches on a `versions/`
  prefix;
- the current file download, the version list, the version download and version
  restore were all driven over HTTP against an `uploads/`-keyed version on this
  branch and all behave correctly;
- restoring such a version works because `restoreFromVersions()` also resolves the
  stored key rather than assuming a directory.

`tests/commitCrashRecoveryPostgres.test.js` pins this with
`V2_VERSION_KEY_RESOLVED_NOT_ASSUMED`, added on this branch: it exercises all four
consumers end-to-end and fails loudly if a V2-created version ever starts with
`versions/` again, so the decision cannot quietly drift.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` —
  replaced the stale "**Known gap:** … the session stays `committing` forever …
  No reaper for stale `committing` sessions exists yet" paragraph with 4.5.2 and
  4.5.3 describing the implemented design, and recorded that the legacy V1
  endpoint still has the same-name window.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records that PR
  #43 merged without the crash-recovery fix, that this follow-up closes both
  defects, and that `LARGE_FILE_TRANSFER_V2` remains `IN_PROGRESS` with production
  still blocked.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` — a
  shared `concepts/` canonical note outside the IDEA1 path prefixes, so it needs
  integration review. The change is confined to the LFT-V2-A commit sections
  (4.5.2, 4.5.3) and the removal of the now-false "Known gap" paragraph; no other
  concept, no other area's facts, and no acceptance matrix result were altered.

## Integration requests

- **Reviewer:** `pubpup2006p-design` (Code Owner), plus Kla as IDEA1 functional
  owner. **Decision required:** accept the replacement of the "Known gap"
  paragraph in the shared `concepts/Large_File_Transfer_V2` note with the
  implemented 4.5.2 / 4.5.3 sections, including the recorded consequence that
  V2-created version bytes live under `uploads/`. **Downstream effect:** none
  outside IDEA1 — no IDEA2/IDEA3 surface, no infrastructure file, no gateway or
  compose change. **Rollout:** none in this Pull Request; production is untouched
  and the migration is not applied. **Rollback:** revert the merge commit; the
  migration is additive (`ADD COLUMN IF NOT EXISTS` on nullable columns plus one
  index and one FK) and a rolled-back application simply stops reading the three
  columns.

## Known limitations

Everything previously recorded stays open and is **not** claimed fixed.

- **`LEGACY_V1_VERSIONING_CRASH_WINDOW = OPEN`.** The legacy
  `POST /api/files/upload` endpoint still calls `moveToVersions()` and still has
  the same-name crash window this task closes for V2. It is unreachable from the
  UI but reachable by any authenticated client. It was **not** changed here:
  doing so would widen an urgent follow-up into the V1 path, and it deserves its
  own separately reviewable change.
- **Recovery is not instantaneous, and no claim is made that it is.** A stranded
  commit becomes actionable at the next boot, or within the recovery interval
  (5 minutes) after the lease (15 minutes) expires. A user can therefore wait up
  to roughly **15–20 minutes** before a crashed session is retryable. This is
  accepted for this follow-up.
- **A crash cannot be distinguished from a genuinely slow commit.** If a real
  commit ever exceeds the lease, recovery may reopen a session whose commit is
  still running; the publish then fails on a missing staged file and no data is
  lost, but the user sees an error. The lease default is set well above the
  expected worst case rather than proven against it.
- **2 GiB / 5 GiB production transfer remains unmeasured.** The largest file moved
  through the protocol in any test is ~16.8 MiB.
- **Browser-refresh automatic resume is still unavailable.**
- **Range download is still unavailable.**
- **Global free-space reservation is still unavailable** — the check stays
  point-in-time at session open.
- **Concurrent same-name upload serialisation is still unresolved.** Crash safety
  and commit-exactly-once are guaranteed *per session*; two different sessions for
  one filename still version in commit order. `finishUploadCommit()` takes
  `FOR UPDATE` on the existing `files` row, which serialises the two transactions
  at the database, but the resulting order is still whichever commits first.
- **Private Vault remains V1 whole-file crypto**, unchanged by this task.
- **PostgreSQL 15.18 only.** The production server's exact minor version was not
  read as part of this task, so "identical behaviour on the production minor
  version" is an inference from the major version, not a measurement.
- **No production acceptance was performed.** No production database, container,
  image, volume or configuration was touched, and the migration was **not**
  applied to production `aegis_drive`. `LARGE_FILE_TRANSFER_V2` remains
  `IN_PROGRESS` and production stays blocked until this follow-up merges.
