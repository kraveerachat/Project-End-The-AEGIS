---
title: Task Receipt — IDEA1 Unified Preview P2a Manifest v2 Reader
date: 2026-10-01T07:12:58+07:00
owner: kla
area: idea1
branch: feat/idea1-preview-p2a-manifest-v2-reader
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Unified Preview P2a Manifest v2 Reader

## What changed

- Implemented P2a of the approved Unified Preview plan (`docs/superpowers/plans/2026-09-30-idea1-unified-preview-p2a-manifest-v2-reader.md`) from `origin/main` `07633c939ae1edfe5a340e081b0be36af418e78b` (P0 present: PR #270 merged at `e3e02862`). TDD per task (RED → verify RED → GREEN → focused verification). Not deployed; no Production mutation.

```
TASK=IDEA1_UNIFIED_PREVIEW_P2A_MANIFEST_V2_READER
P2A_READS_V1=PASS
P2A_READS_V2=PASS
UNKNOWN_VERSION_FAIL_SECURE=PASS
V1_WRITER_ONLY=PASS
P2A_WRITES_V2=NO
V1_GOLDEN_BYTES=PASS
V2_CANONICAL_ROUNDTRIP=PASS
V2_AAD_VERSION_BINDING=PASS
V2_HEAD_BROWSE=PASS
V2_HEAD_PREVIEW_DOWNLOAD=PASS
V2_HEAD_MUTATION_REFUSAL=PASS
V2_HEAD_PUBLISH_COUNT=0
V2_HEAD_CAS_COUNT=0
SERVER_CHANGE=NO
DERIVATIVE_GENERATION=NONE
NEW_NETWORK_CALL=NO
UI_RENDERS_PREVIEW_ENTRIES=NO
FULL_TEST_SUITE=BASELINE_MATCH (0 new failure names)
PRODUCTION_MUTATION_PERFORMED=NO
P1_STARTED=NO
P2B_STARTED=NO
```

- Version dispatch: `MANIFEST_SCHEMA_VERSION_WRITE = 1`, `MANIFEST_SCHEMA_VERSIONS_READ = [1, 2]` (`MANIFEST_SCHEMA_VERSION` kept as the write version). Any other schema (3, 0, `'2'`, `null`, missing) → `UNSUPPORTED_SCHEMA_VERSION`. v1 manifests carrying `contentFormat`/`previews` → `UNKNOWN_KEY`.
- v2 validation (spec §8.2/§10): optional file-only `contentFormat` (P0 `FormatId` or `''`, ≤ 32 bytes) and `previews` (≤ 4, unique kind, closed key sets, derivative `blobRef.formatVersion === 2`, canonical base64 16-byte `contentId`, `sourceBlobRef` v1|v2, kind MIME allowlist, long/short-edge, size and duration bounds from the new frozen `vp1` table). Unknown profiles are structurally validated but not bound-checked; `effectivePreviews(node)` drops stale-source and unknown-profile entries without throwing. Each violation has its own code.
- Canonical form: decoder picks the v2 key sets only when the decoded `schemaVersion` is 2; the encoder is unchanged, and v1 bytes are frozen by a golden vector captured with the untouched base code (`tests/fixtures/vaultManifestV1Golden.json`, 2409 bytes, sha256 `28def0b2…85f8`).
- Crypto: the plaintext `schemaVersion` must equal `ctx.manifestSchemaVersion` on encrypt (not skippable) and on decrypt; the AAD layout is unchanged.
- Sync: every read builds the AAD from the head's own `manifestSchemaVersion` (no constant fallback); unsupported versions are refused before the ciphertext is requested. Writes stay v1.
- Decision P2A-W: a v2 head is browse/preview/download-only. `commit` throws `ManifestNewerThanWriterError` (`MANIFEST_NEWER_THAN_WRITER`) before apply/publish/CAS on the loaded head, on every attempt, and when a CAS conflict/response-loss refetch reveals a v2 head (the v1 intent is discarded; the v2 head is never overwritten or downgraded). `uploadTreeFile` refuses before any byte is uploaded. The hook/screen disable rename, move, trash, restore, create, orphan recovery and Upload with "This Vault was updated by a newer version of Drive — reload to make changes." (EN/TH/ZH); Preview, Download and Details stay enabled.
- Found during regression and fixed (`3b3d76a4`, pinned `4fb9a8d8`): the new mutation-lock selector returned no lock before a head loads, which showed New Folder when both key slots were damaged (RP-2).

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeManifest.js` — read/write constants, version dispatch, v2 node/preview validation, `effectivePreviews`.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewProfiles.js` — frozen `vp1` bounds table (new).
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeCanonical.js` — v2 key sets in the strict decoder (v1 path unchanged).
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeManifestCrypto.js` — plaintext/AAD schema-version binding.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeSync.js` — per-revision schema version on read, `UNSUPPORTED_SCHEMA_VERSION`, `ManifestNewerThanWriterError`, `writable`/`assertWritable`, v1-only writes.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeUpload.js` — refuse upload before bytes on a non-writable head.
- `IDEA1-AEGIS_Drive_LC/src/lib/useVaultTree.js` — `mutationLock`/`manifestNewer` selectors; planRun/planDrop refusal.
- `IDEA1-AEGIS_Drive_LC/src/components/vault/VaultTileMenu.jsx`, `IDEA1-AEGIS_Drive_LC/src/components/vault/VaultFileTile.jsx`, `IDEA1-AEGIS_Drive_LC/src/components/vault/VaultFolderTile.jsx` — optional `lockReason` for disabled menu items.
- `IDEA1-AEGIS_Drive_LC/src/components/vault/VaultRecoveryPanel.jsx` — orphan recovery disabled under any mutation lock.
- `IDEA1-AEGIS_Drive_LC/src/screens/VaultTreeScreen.jsx` — reload banner, Upload/drop/New Folder disabled on a v2 head, refusal announcements.
- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — `vaultTreeManifestNewer` (EN/TH/ZH).
- Tests (new): `IDEA1-AEGIS_Drive_LC/tests/vaultTreeManifestV2.test.js`, `IDEA1-AEGIS_Drive_LC/tests/fixtures/vaultManifestV1Golden.json`, `IDEA1-AEGIS_Drive_LC/tests/helpers/vaultManifestV1GoldenFixture.mjs`.
- Tests (modified): `IDEA1-AEGIS_Drive_LC/tests/vaultTreeManifest.test.js` (schema 2 → BAD_SCHEMA expectation replaced by 3 → UNSUPPORTED_SCHEMA_VERSION), `IDEA1-AEGIS_Drive_LC/tests/vaultTreeManifestProperty.test.js`, `IDEA1-AEGIS_Drive_LC/tests/vaultTreeManifestCrypto.test.js`, `IDEA1-AEGIS_Drive_LC/tests/helpers/vaultTreeFakeServer.mjs` (`acceptManifestSchemaVersions` default `[1]`, `seedHead`), `IDEA1-AEGIS_Drive_LC/tests/vaultTreeSync.test.js`, `IDEA1-AEGIS_Drive_LC/tests/vaultTreeUploadClient.test.js`, `IDEA1-AEGIS_Drive_LC/tests/vaultTreeReducer.test.js`, `IDEA1-AEGIS_Drive_LC/tests/vaultTreeScreen.test.js`.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — P2a current-task entry; P0 marked merged.

## Verification evidence

- (All commands from `IDEA1-AEGIS_Drive_LC/` unless noted.) Baseline `timeout --kill-after=30 5400 node --test --test-concurrency=1 "tests/**/*.test.js"` on a detached worktree at `07633c93` — 2469 tests, 2207 pass, 100 fail (pre-existing), 162 skipped; names saved before the first RED.
- Task 1–2 `node --test --test-concurrency=1 tests/vaultTreeManifestV2.test.js tests/vaultTreeManifest.test.js tests/vaultTreeManifestProperty.test.js` — RED (missing exports / v2 keys rejected) → pass 22/22.
- Task 3 `node --test --test-concurrency=1 tests/vaultTreeManifestCrypto.test.js tests/vaultTreeAad.test.js` — RED (v2 keys rejected by the canonical decoder, binding missing) → pass 20/20 (golden bytes, v2 round trip, key-order independence, 10k-node v2 size, v2 AAD, v1-ctx-on-v2 fails, body/AAD version mismatch fails).
- Task 4 `node --test --test-concurrency=1 tests/vaultTreeSync.test.js tests/vaultTreeApiClient.test.js tests/vaultTreeMigration.test.js` — RED (schema 3/null decrypted instead of refused) → pass 28/28. Note: v2 heads already decrypted before P2a because the head's version was passed with a `?? 1` fallback; the RED was the fail-secure path.
- Task 5 `node --test --test-concurrency=1 tests/vaultTreeRebase.test.js tests/vaultTreeOps.test.js tests/vaultTreeUploadClient.test.js tests/vaultTreeScreen.test.js tests/vaultTreeReducer.test.js tests/vaultTreeSync.test.js` — RED (no refusal / no banner) → pass 96/96; v2-head API spies: `publishRevision` 0, `casHead` 0.
- Task 6 `node --test --test-concurrency=1 tests/vaultTreeApi.test.js tests/vaultTreeUploadsApi.test.js` — pass 26/26 (`{ manifestSchemaVersion: 2 } → 400` unchanged). `vaultTreeApi` OR-4 is an intermittent Windows `EPERM` flake that also fails at base.
- Task 6 PostgreSQL `sh scripts/pg-integration-env.sh up` (`AEGIS_PGTEST_PORT=55750`, `drive_app`) + `node --test --test-concurrency=1 tests/vaultTreePostgres.test.js` — 35 tests; 34–35 pass per run. `PG-MG-2` (two concurrent `commitGenesis`) is a pre-existing race flake: failed on base 1/5 and on P2a 3/6, passed on both; the test file and server are byte-identical to base. Container, volume and network removed.
- `git diff --name-status origin/main...HEAD -- IDEA1-AEGIS_Drive_LC/server server` — empty.
- Vault regression `node --test --test-concurrency=1 tests/vaultTree*.test.js tests/vaultUnlockedState.test.js tests/vaultMediaPreview.test.js tests/vaultPreviewSession.test.js tests/arbitraryTransferRegression.test.js tests/previewAccountNeutrality.test.js` — 418 tests; one new failure (RP-2) found, fixed in `3b3d76a4`, `tests/vaultTreeRecoveryUi.test.js` + reducer pass 20/20; remaining failures are baseline names.
- `node --test --test-concurrency=1 tests/vaultStorageAbsence.test.js` — pass 5/5; added-line and whole-file scan of modified `src/` files for `localStorage|sessionStorage|indexedDB|caches.open` — 0 hits.
- Final full suite at `4fb9a8d8` `timeout --kill-after=30 5400 node --test --test-concurrency=1 "tests/**/*.test.js"` — 2495 tests, 2233 pass, 100 fail, 0 cancelled, 162 skipped; failing-name diff vs baseline: 0 new, 0 fixed.
- `npm run build` — pass; tracked `dist/` restored (`git checkout -- dist && git clean -fd dist`).
- `git diff --check origin/main...HEAD` — pass.
- Governance commands and results are recorded in the PR body (collaboration policy tests, `node scripts/validate-vault.mjs`, `node scripts/validate-collaboration-policy.mjs`).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — added "Current Task — IDEA1-UNIFIED-PREVIEW-P2A" with the durable reader/writer facts; P0 entry now "Completed — merged at `e3e02862`, G-P0 closed".

## Shared surfaces touched

None

## Integration requests

None

## Known limitations

- Not deployed. G-P2a-ACCEPT (Human deploys P2a and verifies ADMIN / EXISTING_USER / NEWLY_CREATED_USER on v1 heads, then records `P2A_ACCEPTED=YES`) is required before the P2b writer flag.
- No v2 manifest can exist in Production until P2b; the v2-head read-only UI was proven only with test-seeded v2 heads (fake server + jsdom), not in a real browser.
- vp1 proxy reader ceilings (≤ 3,600,000 ms, ≤ 1 GiB) are a P2a choice because D-9 `proxyMaxSeconds` has no value; P4 must stay inside them or use a new profile. `contentFormat` must be a `FormatId` this build knows, so a new `FormatId` needs a reader release before a writer emits it.
- `UI_RENDERS_PREVIEW_ENTRIES=NO`: preview entries are validated and kept in memory only.
- ~100 pre-existing full-suite failures remain; none introduced by P2a.
