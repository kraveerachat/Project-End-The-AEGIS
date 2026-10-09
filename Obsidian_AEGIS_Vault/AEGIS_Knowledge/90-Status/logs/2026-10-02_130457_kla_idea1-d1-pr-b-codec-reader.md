---
title: Task Receipt — IDEA1 D-1 PR-B codec and read-only reader
date: 2026-10-02T13:04:57+07:00
owner: kla
area: idea1
branch: feat/idea1-preview-d1-b-codec-reader
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 D-1 PR-B codec and read-only reader

## What changed

- Implemented plan Phase B, Tasks B.1–B.10: canonical codec/routing, existing V2 encrypted object helpers, bounded read-only index reader, verified image derivative reads, derivative-first Vault tile rendering with original fallback, and a codec-only preliminary size probe. Default-OFF read gate; originals remain authoritative; schema-v1 main manifest has no index linkage.
- PR-A #283 merged at `fa22edd5d5db18e692e7814b895f7af3d3c166dc` before final verification. PR-B was initially stacked on PR-A, then targeted `main`. Latest `origin/main` `fd4df610` merged normally at `0d65b04212f4d48eca905ffbbd0fd3ae415e8827`; its later changes have no IDEA1 path overlap. No writer, CAS, Phase C, Production deployment, or Production mutation.
- Whole-branch independent review found no remaining Critical/Important findings after TDD fixes for transport fallback, load/source races, malformed image handling, derivative lane isolation, stale tiles, and staged admission.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/scripts/measure/vault-preview-index-size.mjs` — codec-only probe and zero main-manifest delta fixture.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultDerivativeRead.js` — authenticated derivative image checks and decode failure fallback.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexCodec.js` — root and shard canonical codec.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexConstants.js` — provisional limits and status constants.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexObject.js` — existing V2 encrypted index object open/seal helpers and fail-soft transport.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexReader.js` — bounded read-only load, epoch/source guards, envelope prefetch, and ciphertext LRU.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexRouting.js` — owner-scoped shard routing.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexTileLane.js` — independent bounded derivative lane and staged admission.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewIndexTiles.js` — derivative-first tile fallback and source recheck.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeCanonical.js` — generic canonical helpers and unsafe-key rejection.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultTreeManifest.js` — preserve schema-v1 compatibility using generic canonical helpers.
- `IDEA1-AEGIS_Drive_LC/src/screens/VaultTreeScreen.jsx` — guarded read-only tile integration; original Download/Open unchanged.
- `IDEA1-AEGIS_Drive_LC/tests/fixtures/previewIndexTilesScreenStub.js` — test-only screen fixture.
- `IDEA1-AEGIS_Drive_LC/tests/helpers/previewIndexFakeTransport.mjs` — test-only encrypted transport fixture.
- `IDEA1-AEGIS_Drive_LC/tests/helpers/previewIndexFixture.mjs` — test-only codec/reader fixture.
- `IDEA1-AEGIS_Drive_LC/tests/helpers/vaultScreenHarness.js` — real jsdom screen harness injection for index tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexCanonical.test.js` — canonical/unsafe-key tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexCodec.test.js` — root/shard codec tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexConstants.test.js` — provisional limit tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexObject.test.js` — V2 object crypto/transport tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexReader.test.js` — read status, races, bounds, and cache tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexRouting.test.js` — shard routing tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexScreen.test.js` — real jsdom READ-off, absent-index, derivative, and original fallback tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexSizeProbe.test.js` — codec probe fixture and manifest delta tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexTileLane.test.js` — independent lane, cancellation, replay, and admission tests.
- `IDEA1-AEGIS_Drive_LC/tests/previewIndexTiles.test.js` — encrypted tile path and failure fallback tests.
- `IDEA1-AEGIS_Drive_LC/tests/vaultDerivativeRead.test.js` — genuine JPEG and malformed-image tests.
- `IDEA1-AEGIS_Drive_LC/tests/vaultTreeScreen.test.js` — READ-off/absent index screen regression tests.

## Verification evidence

- `node --test --test-concurrency=1 --test-force-exit 'tests/**/*.test.js'` in PR-B IDEA1 checkout — completed: 2,643 tests; 2,366 pass, 105 fail, 172 skip. Same command in pristine merged-PR-A IDEA1 checkout (`fa22edd5`) — completed: 2,580 tests; 2,302 pass, 106 fail, 172 skip. Exact `^✖` failure-name comparison before each runner summary: **zero PR-B-only names**; sole baseline-only name is known intermittent `vaultTreeApi OR-4` (Windows EPERM). `OR4_SEEN=baseline yes / PR-B no`; `OR4_BASELINE_REPRODUCIBLE=YES`; `NEW_DETERMINISTIC_FAILURES=0`. Raw outputs retained only in ignored local execution ledger, not committed.
- `node --test --test-concurrency=1 --test-force-exit tests/previewIndexCanonical.test.js tests/previewIndexConstants.test.js tests/previewIndexRouting.test.js tests/previewIndexCodec.test.js tests/previewIndexObject.test.js tests/previewIndexReader.test.js tests/vaultDerivativeRead.test.js tests/previewIndexTileLane.test.js tests/previewIndexTiles.test.js tests/previewIndexScreen.test.js tests/previewIndexSizeProbe.test.js tests/vaultTreeCanonical.test.js tests/vaultTreeManifestV2.test.js tests/vaultTreeManifest.test.js tests/vaultTreeManifestProperty.test.js tests/vaultChunkCrypto.test.js tests/vaultChunkedUploadClient.test.js tests/vaultChunkedDownloadClient.test.js tests/vaultTreeScreen.test.js tests/vaultThumbScheduler.test.js tests/vaultFilesUx.test.js tests/filesVaultPresentation.test.js tests/vaultMediaPreview.test.js tests/vaultPreviewCancellation.test.js` — 276 tests; 252 pass, 24 fail, 0 skip. All 24 fail in existing `vaultMediaPreview.test.js`; no failure outside that legacy file. Reviewer independently ran `previewIndexScreen.test.js` + `previewIndexTileLane.test.js`: 7 pass, 0 fail.
- `node scripts/measure/vault-preview-index-size.mjs --mode codec --nodes 1000,5000,10000 --variants 2,3 --runs 20 --out ../.superpowers/sdd/2026-10-02-idea1-d1-separate-encrypted-preview-index-implementation/idx-size-codec-final.json` — pass; `CODEC_ONLY_PRELIMINARY`, not IDX-SIZE gate. At 10k/2, max largest canonical shard 139,845 B versus provisional 196,608 B; max live shards 64 versus provisional 128; provisional boundary not exceeded. At 10k/3, max largest shard 196,547 B and max live shards 68. Main manifest canonical-byte delta 0 at 1k/5k/10k, each with six non-file nodes.
- `npm run build` — pass after latest `main` merge; Vite 2,759 modules and existing >500 KiB chunk warning. Generated tracked `dist/index.html` restored, not part of PR.
- `node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs tests/collaborationPolicy.test.mjs` — pass 59/59 after latest shared-policy merge.
- `node scripts/validate-vault.mjs` — pass before receipt creation; two pre-existing owner-data canvas warnings. `git diff --cached --check` — pass on all reviewed source/status paths before receipt creation. Changed-path and added-line secret scan — 29 paths, zero sensitive-path matches, zero added-secret-pattern matches.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — PR-A merged, PR-B current and locally verified, current main reconciliation, measured codec-only result, failure-name diff, and unverified rollout gates.

## Shared surfaces touched

None — every PR path is inside the IDEA1 code, test, script, canonical-note boundary, or this one receipt.

## Integration requests

None — no cross-scope/shared path changed. Human IDEA1 owner reviews PR #285 and owns any later merge/Production rollout; this receipt grants neither.

## Known limitations

- Browser acceptance (Phase I), PostgreSQL/CAS and retained-storage/IDX-SIZE capacity gates (Phase G), CI result, and Production rollout are not claimed. `VAULT_PREVIEW_INDEX_WRITE_ENABLED` remains OFF. No persistence writer or destructive GC exists here.
- Existing 105 full-suite failures remain; this task does not fix them. OR-4 is a reproducible baseline Windows EPERM flake, not fixed by PR-B.
- Malicious-server replay and request-pattern leakage remain inherited D-1 design limitations. New preview-index absence or failure falls back to originals; no server plaintext or persistent decrypted cache.
