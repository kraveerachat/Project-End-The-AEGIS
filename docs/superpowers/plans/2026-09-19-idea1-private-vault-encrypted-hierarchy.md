# PR157 Private Vault Encrypted Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document is a plan only: nothing in it has been implemented, and no task may start before the gate in "Authorization" below is satisfied.

**Goal:** Give Private Vault real encrypted folders, nested hierarchy, Rename, Move, multi-select, drag/drop, encrypted Trash/Restore, purge-barrier permanent deletion, and client-only image/GIF/video previews, using **Approach B** — one encrypted, versioned, whole-tree manifest that references opaque immutable V1/V2 blobs — without the server ever receiving explicit parent/child relations, folder structure, plaintext names, plaintext content, or plaintext media derivatives.

**Architecture:** The client keeps the existing Argon2id → non-extractable **Vault KEK**. Genesis creates one stable random 256-bit **TRK** stored server-side only as two independently wrapped slots (`primary`, `recovery`) under the KEK. Every manifest revision is encrypted under a **fresh Manifest DEK** wrapped by the TRK — never directly by the KEK. The server adds only additive opaque tables: an owner protocol state (`FLAT` → `MIGRATING_TREE_V1` → `TREE_V1`), a key envelope, a tree head with a monotonic generation, immutable encrypted revisions, tree-aware blob lifecycle (`UNREFERENCED` → `TREE_MANAGED` → `PURGE_PENDING` → `PURGED`), migration lease metadata and a monotonic purge barrier. All hierarchy semantics (graph validation, cycles, sibling collisions, breadcrumbs, effective Trash, semantic rebase) run in unlocked client memory. Tree-aware uploads use a **new versioned endpoint family** that the server accepts only in `TREE_V1`; legacy Add/Delete are fenced from the migration lease onward and forbidden forever after genesis. All media derivatives are ephemeral client products through the existing same-origin Vault preview Service Worker; no server thumbnail, Sharp/FFmpeg derivative, plaintext cache or search index exists.

**Design:** `docs/superpowers/specs/2026-09-19-idea1-private-vault-encrypted-hierarchy-design.md` (design SHA `db657986747c31f19c2fd3afbbd587177b3a3f74`; ChatGPT architecture review PASS; Approach B approved by the Human Owner).

**Tech stack:** React 19 + Vite frontend (`IDEA1-AEGIS_Drive_LC/src`), Express server (`IDEA1-AEGIS_Drive_LC/server`), PostgreSQL 16 with the `drive_app` non-superuser role, WebCrypto AES-GCM / Argon2id via `hash-wasm`, `node:test` suites (`node --test --test-concurrency=1 --test-reporter=tap`), jsdom screen harness (`tests/helpers/vaultScreenHarness.js`), disposable PostgreSQL through `scripts/pg-integration-env.sh`.

```text
MODE=IMPLEMENTATION_PLAN_ONLY
APPROACH=B
PLAN_STATUS=NOT_STARTED
IMPLEMENTATION_STARTED=NO
SERVER_RECEIVES_EXPLICIT_PARENT_CHILD=NO
SERVER_RECEIVES_EXPLICIT_FOLDER_TREE=NO
SERVER_KNOWS_PLAINTEXT_NAMES=NO
SERVER_KNOWS_PLAINTEXT_CONTENT=NO
SERVER_PLAINTEXT_MEDIA_CACHE=NO
TREE_ROOT_KEY_MODEL=STABLE_RANDOM_TRK
KEY_HIERARCHY=VAULT_KEK->TRK->PER_REVISION_MANIFEST_DEK
PROTOCOL_STATES=FLAT|MIGRATING_TREE_V1|TREE_V1
TREE_AWARE_UPLOAD_MODEL=VERSIONED_NEW_ENDPOINTS
TREE_REVISION_CONCURRENCY=GENERATION_CAS
TRAFFIC_ANALYSIS_INFERENCE_ACKNOWLEDGED=YES
EXISTING_V1_V2_CIPHERTEXT_COMPATIBILITY=PRESERVED
PRIVATE_VAULT_TRANSFER_PERF=SEPARATE_PR
DESTRUCTIVE_PURGE_ENABLED_AT_INITIAL_ROLLOUT=NO
```

## Authorization

This plan is executed only after all of the following are true, recorded in the PR #157 body and the IDEA1 canonical status note:

1. ChatGPT review of this implementation plan: PASS (`NEXT_GATE=CHATGPT_REVIEW_PR157_IMPLEMENTATION_PLAN`).
2. Human Owner explicit authorization to begin Phase 0.
3. Security review sign-off on the plan's XSS-limitation statement, CAS, lifecycle cleanup, migration fence, purge barrier and legacy-client fencing sections (design §25 item 4).

Until then `IMPLEMENTATION_STARTED=NO`, `FINAL_RECEIPT_CREATED=NO`, `PR157_READY=NO`, `DO_NOT_MERGE=TRUE`.

## Global Constraints

- Work only on PR #157 branch `feat/idea1-private-vault-encrypted-hierarchy`; the PR stays Draft with `DO_NOT_MERGE=TRUE` through Phase 9; never push to `main`; never rebase/squash/force-push; one final receipt only at Phase 10 closeout.
- Every task is TDD: tests are written and proven RED with the exact command before source changes; the same command proves GREEN; the task's local regression runs before its commit. Commands run from `IDEA1-AEGIS_Drive_LC/` unless a path says otherwise. `node --test --test-concurrency=1 --test-reporter=tap` is the counting form (Node 24 needs `--test-reporter=tap` for reliable counts; `--test-force-exit` is never used on Windows).
- Nothing in Phases 0–9 touches Production, the Production database, `/opt/aegis/runtime/**`, Public Share overlays, or any owner Vault data. Phase 10 is a repository regression and a *hand-off list* of future Production gates; it performs no Production mutation.
- **Transfer performance is excluded.** No task changes `server/config/vaultTransferLimits.js` values, `VAULT_CHUNK_PLAINTEXT_BYTES`, `MAX_VAULT_LOGICAL_FILE_BYTES`, upload concurrency (`DEFAULT_UPLOAD_CONCURRENCY`, `MAX_UPLOAD_CONCURRENCY`), encryption worker structure, chunk planning (`planVaultChunks`), retry counts, or download buffering (`MAX_BUFFERED_PLAINTEXT_BYTES`). The tree-aware upload family *reuses* the V2 internals unchanged (Task 4.1 asserts this with a source-equality test). No throughput benchmark target exists in this plan.
- The V1/V2 file DEK scheme, `vaultCrypto.js` KEK derivation, `ARGON2_DEFAULTS`, `contentChunkAad`, `metadataAad`, `createVaultV2Envelope`, `encryptVaultChunk`, `decryptVaultChunk` are **not modified**. New crypto lives in new modules. Existing V1/V2 ciphertext, per-file wrapped DEKs, `content_id_b64`, chunk rows and storage keys are never rewritten (Task 3.2 and Task 10.1 assert byte-for-byte equality before/after migration).
- All schema changes are additive: new tables, new indexes, new grants. No existing `vault_meta`, `vault_blobs`, `vault_v2_*` column is altered, dropped, relaxed or made nullable. The migration file is idempotent (`IF NOT EXISTS`) and runs under `ON_ERROR_STOP`.
- No plaintext or deterministic hash of a node name, parent ID, path, MIME type, node ID, breadcrumb, selection set, Move destination, thumbnail, poster or content ever appears in a request body, query string, route parameter, header, SQL column, storage key, log line, audit target, error payload, telemetry, receipt or Git. Task 2.4 and Task 4.1 include request-capture assertions (`NO-LEAK-*`) that scan every server-bound byte for the test's plaintext names and node IDs.
- Server-side code never evaluates cycles, sibling collisions, folder membership, breadcrumbs, Move destinations or subtree contents. Any server module that imports `vaultTreeManifest.js`, `vaultTreeOps.js` or `vaultTreeCanonical.js` fails the source-scan test `SRV-NOIMPORT-1`.
- No normal Files media service (`server/media/**`, `server/routes/media.js`, `src/lib/mediaApi.js`, `src/lib/mediaScheduler.js`, `src/components/MediaThumb.jsx`) may receive a Vault blob, Vault storage key or Vault plaintext. Source-scan test `PV-NO-MEDIA-1` forbids importing those modules from any `vault*` module.
- No Cache API, IndexedDB, localStorage, sessionStorage, filesystem, or server cache may hold manifest plaintext, node names, decrypted bytes, thumbnails, posters, TRK, Manifest DEK, KEK, or preview tokens. Storage-absence tests use instrumented jsdom globals (`caches`, `indexedDB`, `localStorage`, `sessionStorage`) that throw on any write and count reads.
- Tracked `IDEA1-AEGIS_Drive_LC/dist/` is never rebuilt in a commit: build to verify, then `git checkout -q -- IDEA1-AEGIS_Drive_LC/dist && git clean -fdXq IDEA1-AEGIS_Drive_LC/dist && git clean -fdq IDEA1-AEGIS_Drive_LC/dist`.
- No large binary fixtures are committed. Media fixtures are generated at test time (synthetic PNG/GIF/MP4 via `tests/helpers/mediaFixtures.mjs` where tools exist, otherwise structurally minimal hand-built byte fixtures produced by `tests/helpers/vaultTreeFixtures.mjs`).
- Limits are not invented. Every numeric limit below is either (a) an already-shipped constant referenced by name, (b) a protocol constant fixed by this plan and justified inline, or (c) marked `MEASURED@G0` — a value selected only at gate G0 from Phase 0 evidence and then frozen in `server/config/vaultTreeLimits.js` / `src/lib/vaultTreeLimits.js`. Unit tests never depend on the frozen defaults: every module takes its limits by injection and the tests pass small explicit limits.
- Feature flags are fail-closed and chained (see "Rollout flags"). Any flag missing or malformed at boot throws (same pattern as `mediaLimits.js`: read once, throw on invalid, deep-freeze).
- Receipts/Obsidian: no final receipt before Phase 10 closeout. Each phase gate records a Session Register row and a checkpoint SHA in `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` (owner `kla`), per `core/development-session-workflow.md`.

## Identities, key hierarchy and protocol constants

| Name | Where it exists | Definition |
|---|---|---|
| Vault KEK | client memory only (existing) | Argon2id-derived non-extractable AES-GCM key from `deriveKek()`; unchanged |
| TRK | client memory only (plaintext bytes transient, imported non-extractable); server holds two wrapped slots | 32 random bytes from `crypto.getRandomValues`, generated once at genesis |
| Manifest DEK | client memory per revision; server holds it wrapped by TRK | fresh 32 random bytes per revision |
| `treeId` | clear server metadata + AAD | 16 random bytes, base64url, generated at genesis |
| `revisionId`, `baseRevisionId` | clear server metadata + AAD | 16 random bytes, base64url, per revision; genesis `baseRevisionId = null` |
| `generation` | clear server metadata + AAD | `BIGINT`, genesis = 1, strictly `+1` per committed revision |
| `nodeId`, `rootNodeId` | inside manifest plaintext only | 16 random bytes, base64url; never in any request |
| Server blob ID | existing (`vault_blobs.id` BIGINT for V1, `vault_v2_blobs.id` TEXT for V2) | referenced as `{ formatVersion, id }`; stored in tree tables as `blob_format_version SMALLINT + blob_id TEXT` |
| `idempotencyKey` | request field + server unique index | 16 random bytes, base64url, per mutation attempt |
| `leaseId` | server-issued | 24 random bytes hex (same shape as `upload_id`) |
| `VAULT_TREE_PROTOCOL_VERSION` | protocol constant | `1` |
| `VAULT_TREE_MANIFEST_SCHEMA_VERSION` | protocol constant | `1` |
| `VAULT_TREE_KEY_ENVELOPE_VERSION` | protocol constant (format), distinct from the per-row CAS counter `envelope_cas_version` | `1` |

AAD labels (fixed byte strings; changing any byte after genesis makes every existing revision undecryptable — the encoder module is the format definition, as `contentChunkAad` is today):

- `AEGIS-Vault-Tree-TRK-Wrap-v1` — fields: `ownerScopeId`, `treeId`, `protocolVersion`, `keyEnvelopeVersion`, `slot` (`primary` | `recovery`). `ownerScopeId` is the owner-scoped opaque Vault identity: 16 random bytes generated at genesis and stored in `vault_tree_key_envelope.owner_scope_id_b64`. It is not the numeric user ID, so the AAD carries no account identifier.
- `AEGIS-Vault-Tree-Manifest-DEK-Wrap-v1` — fields: `treeId`, `revisionId`, `baseRevisionId` (empty when genesis), `generation`, `manifestSchemaVersion`.
- `AEGIS-Vault-Tree-Manifest-Ciphertext-v1` — fields: `treeId`, `revisionId`, `baseRevisionId`, `generation`, `manifestSchemaVersion`, `paddedPlaintextLength`.

Encoding: `u8 layoutVersion (=1)` ‖ `u16 labelLen` ‖ label ‖ for each field in table order: `u8 fieldTag` ‖ `u32 len` ‖ bytes (integers as 8-byte big-endian, strings as UTF-8, absent `baseRevisionId` as `len = 0`). Length-prefixed, tagged, never string-concatenated.

## Rollout flags

All flags are server environment booleans read by `server/config/vaultTreeLimits.js` and surfaced read-only to the client through `GET /api/vault/tree/state` (`flags` block). Each flag is fail-closed (default `false`) and requires every prerequisite flag to be `true`; a `true` flag whose prerequisite is `false` throws at boot (`FLAG-CHAIN-*` tests).

| Plan name | Env variable | Gates | Prerequisite |
|---|---|---|---|
| `TREE_SCHEMA_AVAILABLE` | `VAULT_TREE_SCHEMA_AVAILABLE` | Boot probe of `to_regclass()` for all seven tree tables must succeed when `true`; `false` = tree routes respond `503 TREE_PROTOCOL_DISABLED` and the store never queries tree tables | — |
| `TREE_PROTOCOL_ENABLED` | `VAULT_TREE_PROTOCOL_ENABLED` | state/head/revision/key-envelope/blob-state/tree-upload routes and legacy fencing | `TREE_SCHEMA_AVAILABLE` |
| `GENESIS_MIGRATION_ENABLED` | `VAULT_TREE_GENESIS_MIGRATION_ENABLED` | `migration/begin`, `migration/takeover`, `migration/abandon`, `genesis` | `TREE_PROTOCOL_ENABLED` |
| `TREE_UI_ENABLED` | `VAULT_TREE_UI_ENABLED` | client renders the hierarchy UI; when `false` a `TREE_V1` owner sees the read/export-only tree-aware list (Task 9.3) | `TREE_PROTOCOL_ENABLED` |
| `VAULT_MEDIA_PREVIEW_ENABLED` | `VAULT_MEDIA_PREVIEW_ENABLED` | client-only thumbnails/posters/hover motion; the existing full-file Preview modal for supported types stays available when `false` | `TREE_UI_ENABLED` |
| `DESTRUCTIVE_PURGE_ENABLED` | `VAULT_DESTRUCTIVE_PURGE_ENABLED` | physical deletion executor and `purge/confirm` execution; when `false` the purge barrier still commits, candidates wait in `RETENTION_WAIT`, and the client shows the truthful "physical purge pending operator enablement" state | `TREE_PROTOCOL_ENABLED` |

Earliest Production rollout: `VAULT_DESTRUCTIVE_PURGE_ENABLED=false`. Rollback = set `VAULT_TREE_UI_ENABLED=false` (and, if needed, `VAULT_TREE_PROTOCOL_ENABLED=false`) while every tree table, manifest ciphertext, blob ciphertext and migration state stays intact. No flag combination re-enables legacy `POST /api/vault/blobs`, `DELETE /api/vault/blobs/:id` or `/api/vault/uploads/*` mutation for an owner whose protocol state is not `FLAT` (Task 2.5 `FENCE-*`, Task 9.3 `RO-*`).

## File map

Paths are relative to `IDEA1-AEGIS_Drive_LC/`. "create" files do not exist today; "modify" files are listed with the exact, minimal change. Every interface is defined once here and referenced by name in the tasks.

### Client — crypto and manifest (`src/lib/`)

| File | Purpose | Public interface | Tests |
|---|---|---|---|
| `src/lib/vaultTreeAad.js` (create) | Versioned, tagged, length-prefixed AAD encoders — the format definition for all three tree layers. | `TRK_WRAP_LABEL`, `MANIFEST_DEK_WRAP_LABEL`, `MANIFEST_CIPHERTEXT_LABEL`; `trkWrapAad({ ownerScopeId, treeId, protocolVersion, keyEnvelopeVersion, slot })`, `manifestDekWrapAad({ treeId, revisionId, baseRevisionId, generation, manifestSchemaVersion })`, `manifestCiphertextAad({ ...same, paddedPlaintextLength })` → `Uint8Array`; `AAD_LAYOUT_VERSION = 1` | `tests/vaultTreeAad.test.js` |
| `src/lib/vaultTreeKeys.js` (create) | TRK lifecycle and Manifest DEK wrapping. Plaintext TRK bytes exist only inside these functions and are zero-filled best-effort after import. | `generateTrkBytes()` → `Uint8Array(32)`; `importTrk(bytes)` → non-extractable `CryptoKey`; `wrapTrkSlots(kek, trkBytes, ctx)` → `{ primary: { wrappedTrkB64, wrapIvB64 }, recovery: {...} }`; `unwrapTrkSlots(kek, envelope, ctx)` → `{ trk: CryptoKey, status: 'HEALTHY' \| 'DEGRADED', badSlot: null \| 'primary' \| 'recovery' }` or throws `TreeKeyError('TRK_UNRECOVERABLE' \| 'TRK_SLOT_DISAGREEMENT')`; `rewrapTrkSlots(oldKek, newKek, envelope, ctx)` → new slots (unwraps, validates, rewraps; never returns raw bytes); `repairTrkSlot(kek, trkKeyBytesFromValidatedUnwrap, ctx, slot)`; `generateManifestDekBytes()`; `wrapManifestDek(trk, dekBytes, ctx)` → `{ wrappedManifestDekB64, wrapIvB64 }`; `unwrapManifestDek(trk, wrapped, ctx)` → `CryptoKey` | `tests/vaultTreeKeys.test.js` |
| `src/lib/vaultTreeCanonical.js` (create) | Canonical deterministic serialization + padding. Not `JSON.stringify` ordering: an explicit canonicalizer (sorted keys by UTF-16 code units, no whitespace, integers only, strings NFC-preserved as given, `\u` escapes for control chars) and a strict parser that rejects duplicate keys, non-integer numbers, unknown top-level keys, trailing bytes and depth beyond the injected bound. | `canonicalEncode(manifest, limits)` → `Uint8Array`; `canonicalDecode(bytes, limits)` → manifest object; `padToBucket(bytes, buckets)` → `{ padded: Uint8Array, paddedLength }` (bucket table injected; PKCS#7-style length trailer + zero fill, authenticated because the whole padded buffer is GCM plaintext); `stripPadding(padded)`; `CanonicalError` codes `DUPLICATE_KEY`, `BAD_NUMBER`, `DEPTH`, `TRAILING`, `UNKNOWN_KEY`, `LIMIT_DECODED_BYTES` | `tests/vaultTreeCanonical.test.js` |
| `src/lib/vaultTreeManifest.js` (create) | Schema + graph validation, name collision key, effective lifecycle and derived views. Pure functions; no I/O; no crypto. | `MANIFEST_SCHEMA_VERSION = 1`; `createGenesisManifest({ treeId, rootNodeId, now })`; `validateManifest(manifest, limits)` → `{ ok: true, index }` or throws `ManifestError(code)`; `collisionKey(name)` → NFC + Unicode default case folding (pinned table module `src/lib/unicodeCaseFold.js`, generated from a pinned `CaseFolding.txt` version recorded in the module header); `effectiveState(index, nodeId)` → `'active' \| 'trashed' \| 'purge-pending'`; `ancestorsOf(index, nodeId)`; `childrenOf(index, parentNodeId, { view: 'active' \| 'trash' })`; `breadcrumbsFor(index, nodeId)`; `isDescendant(index, nodeId, ancestorId)`; `activeSiblingCollision(index, parentNodeId, name, exceptNodeId)` | `tests/vaultTreeManifest.test.js`, `tests/vaultTreeManifestProperty.test.js` |
| `src/lib/vaultTreeManifestCrypto.js` (create) | One-call revision encryption/decryption composing canonical → pad → AES-GCM under a fresh Manifest DEK wrapped by TRK. | `encryptManifestRevision(trk, manifest, ctx, limits)` → `{ ciphertext: Uint8Array, ivB64, wrappedManifestDekB64, wrapIvB64, paddedLength }`; `decryptManifestRevision(trk, envelope, ctx, limits)` → validated manifest (fails closed on any tag/schema/graph/bounds failure; no partial output) | `tests/vaultTreeManifestCrypto.test.js` |
| `src/lib/vaultTreeLimits.js` (create, Task 0.3) | Frozen client defaults selected at G0 plus test-injectable shape. | `VAULT_TREE_CLIENT_LIMITS` (deep-frozen), `treeLimitsFrom(overrides)` | `tests/vaultTreeLimits.test.js` |

### Client — protocol, state and commands (`src/lib/`)

| File | Purpose | Public interface | Tests |
|---|---|---|---|
| `src/lib/vaultTreeApi.js` (create) | Thin fetch wrappers for the tree endpoint family; every function takes `{ fetchJson = apiFetch, fetchBytes = apiFetchBytes, signal }`. Serializes only opaque fields. | `getTreeState()`, `getTreeHead()`, `getRevisionCiphertext(revisionId)`, `publishRevision(meta)`, `putRevisionCiphertext(revisionId, bytes)`, `casHead(body)`, `casKeyEnvelope(body)`, `listTreeBlobs()`, `beginMigration()`, `takeoverMigration()`, `abandonMigration(body)`, `commitGenesis(body)`, `confirmPurge(body)`; `TreeApiError` with server `code` | `tests/vaultTreeApiClient.test.js` |
| `src/lib/vaultTreeOps.js` (create) | Semantic intents applied to a manifest copy with full revalidation. | `intents`: `createFolder({ parentNodeId, name })`, `rename({ nodeId, name })`, `move({ nodeIds, destinationNodeId })`, `trash({ nodeIds })`, `restore({ nodeId, destinationNodeId? })`, `attachBlob({ parentNodeId, name, mediaType, plainSize, blobRef })`, `purgeIntent({ nodeIds })`; `applyIntent(manifest, intent, { now, newNodeId, limits })` → `{ manifest, changedNodeIds, attachBlobRefs, purgeBlobRefs }` or throws `OpError(code)`; `normalizeSelectionRoots(index, nodeIds)`; `OpError` codes `ROOT_IMMUTABLE`, `NOT_FOUND`, `NOT_FOLDER`, `CYCLE`, `COLLISION`, `EFFECTIVELY_TRASHED`, `AMBIGUOUS_SELECTION`, `NAME_INVALID`, `LIMIT_NODES`, `LIMIT_DEPTH`, `LIMIT_NAME_BYTES` | `tests/vaultTreeOps.test.js`, `tests/vaultTreeOpsProperty.test.js` |
| `src/lib/vaultTreeRebase.js` (create) | Bounded semantic rebase of one intent onto a newer head. | `rebaseIntent(intent, { baseIndex, headIndex })` → `{ kind: 'AUTO', intent }` \| `{ kind: 'CONFLICT', reason }`; conflict reasons `TARGET_DELETED`, `TARGET_RENAMED`, `DESTINATION_DELETED`, `DESTINATION_TRASHED`, `COLLISION`, `CYCLE_AFTER_REBASE`, `PARENT_CHANGED`, `RESTORE_COLLISION` | `tests/vaultTreeRebase.test.js` |
| `src/lib/vaultTreeSync.js` (create) | The mutation protocol: fetch head → decrypt → apply → encrypt → publish → CAS → bounded rebase; response-loss recovery by idempotency key; head cache reconciliation. | `createTreeSession({ trk, api, limits, unlockedState })` → `{ loadHead(), commit(intent, { signal }) → { generation, revisionId, manifest } \| { conflict }, refreshHead(), close() }`; `SyncError` codes `STALE_HEAD`, `REBASE_EXHAUSTED`, `CONFLICT`, `PROTOCOL_DISABLED`, `ABORTED` | `tests/vaultTreeSync.test.js` |
| `src/lib/vaultTreeMigration.js` (create) | Genesis migration client: lease, frozen inventory decrypt, collision resolution model, TRK genesis, genesis manifest, atomic commit, resume/takeover. | `planMigration({ kek, inventory, limits })` → `{ entries, collisions }` (no network); `resolveCollisions(plan, decisions)`; `runGenesis({ kek, api, plan, unlockedState, signal })` → `{ treeId, generation: 1 }`; `MigrationError` codes `ENVELOPE_UNDECRYPTABLE`, `COLLISION_UNRESOLVED`, `LEASE_STALE`, `INVENTORY_MISMATCH`, `BOUNDS` | `tests/vaultTreeMigration.test.js` |
| `src/lib/vaultTreeUpload.js` (create) | Tree-aware upload: calls the existing `uploadVaultFileChunked` internals with `routeBase = '/api/vault/tree/uploads'`, returns the `UNREFERENCED` blob reference, then hands the attach intent to `vaultTreeSync`. Orphan recovery listing. | `uploadTreeFile({ kek, file, parentNodeId, session, ... })`; `listOrphanBlobs({ kek, api, index })` → decrypted-envelope entries not referenced by the manifest; `recoverOrphan({ session, blobRef, parentNodeId, name })` | `tests/vaultTreeUploadClient.test.js` |
| `src/lib/vaultChunkedUpload.js` (modify) | Add one optional `routeBase` parameter (default `'/api/vault/uploads'`) threaded to the existing URL builders. No chunk-size, concurrency, retry or planning change; `tests/vaultTreeUploadClient.test.js` `TU-SAME-1` asserts the module's exported constants and `planVaultChunks` output are unchanged against a frozen snapshot. | unchanged exports + `routeBase` option | existing `tests/vaultChunkedUploadClient.test.js` stays green |
| `src/lib/vaultUnlockedState.js` (create) | The one idempotent unlocked-state registry and `purgeUnlockedVaultState(reason)`. | `createUnlockedVaultState()` → `{ registerAbort(controller), registerObjectUrl(url), registerPreviewToken(token), registerKey(ref), registerBuffer(ref), registerDisposer(fn), invalidateMutations(), purge(reason) → PurgeReport, isPurged() }`; `PURGE_REASONS = { MANUAL_LOCK, AUTO_LOCK, LOGOUT, SESSION_INVALIDATED, UNMOUNT, NAVIGATION, PAGE_HIDE }`; `PurgeReport = { reason, abortedFetches, revokedUrls, closedTokens, droppedKeys, droppedBuffers, disposers, alreadyPurged }` | `tests/vaultUnlockedState.test.js` |
| `src/lib/useVaultTree.js` (create) | React reducer/hook holding the unlocked tree view: current folder, view (`active` \| `trash`), selection set, drag state, pending intent, conflict, degraded-key state; reconciles selection/navigation on every new head. | `useVaultTree({ session, unlockedState, limits })` → `{ view, current, breadcrumbs, children, selection, select(nodeId, { additive }), clear(), open(nodeId), up(), run(intent), conflict, resolveConflict(choice), capabilities(selection) }`; pure reducer exported as `vaultTreeReducer` | `tests/vaultTreeReducer.test.js` |

### Client — media previews (`src/lib/`, `src/`)

| File | Purpose | Public interface | Tests |
|---|---|---|---|
| `src/lib/vaultThumbScheduler.js` (create) | Bounded client-only derivative scheduler: viewport-driven, cancellable, caps concurrency, input bytes, decoded pixels, retained Object URLs and estimated memory; releases on scroll-out, hide, lock, selection change. Independent from `mediaScheduler.js`. | `createVaultThumbScheduler({ limits, unlockedState, decode })` → `{ observe(el, entry), unobserve(el), release(nodeId), releaseAll(), stats() }` | `tests/vaultThumbScheduler.test.js` |
| `src/lib/vaultImageThumb.js` (create) | Small image: bounded decrypt (V1 whole-file under existing 64 MiB V1 ceiling only if under the injected image byte limit; V2 chunk-stream), `createImageBitmap` with decoded-pixel guard (dimensions read from the header before decode; reject over-limit), scaled poster to `OffscreenCanvas`/`canvas` → Blob → Object URL registered in `unlockedState`. | `renderImagePoster({ kek, entry, limits, signal, unlockedState })` → `{ url, width, height, bytes }` or `{ unsupported: reason }` | `tests/vaultImageThumb.test.js` |
| `src/lib/vaultGifPreview.js` (create) | GIF: static first-frame poster (bounded decode budget); hover/touch playback only when ciphertext ≤ limit and estimated memory ≤ ceiling; larger GIF → poster/download-only with truthful reason. | `renderGifPoster(...)`; `openGifMotion(...)` → `{ url } \| { unsupported: 'GIF_TOO_LARGE' \| 'MEMORY_CEILING' }` | `tests/vaultGifPreview.test.js` |
| `src/lib/vaultVideoPreview.js` (create) | V2 video: opens the existing preview session (`openPreviewSession`) and derives a bounded first-frame poster from a muted `<video preload="metadata">` seek through the Service Worker virtual URL; hover/touch muted motion and full Preview/seek reuse the same session. V1/unsupported → truthful fallback. | `openVideoPoster({ entry, session, limits, unlockedState })`, `openVideoMotion(...)`, `videoPreviewCapability(entry)` → `'RANGE_V2' \| 'V1_DOWNLOAD_ONLY' \| 'UNSUPPORTED'` | `tests/vaultVideoPreview.test.js` |
| `src/lib/vaultPreviewSession.js` (modify) | Add `unlockedState` registration: `openPreviewSession` registers its token; `closeAllPreviewSessions` is invoked by `purge()`. No protocol change to the worker messages. | unchanged + optional `unlockedState` param | existing `tests/vaultPreviewSession.test.js` stays green + `tests/vaultUnlockedState.test.js` |
| `src/vaultPreviewServiceWorker.js` (unchanged) | Already Cache-API-free and `no-store`. `tests/vaultStorageAbsence.test.js` `SA-SW-1` source-scans it for `caches.`/`indexedDB`/`localStorage` and fails on any occurrence. | — | `tests/vaultStorageAbsence.test.js` |

### Client — UI (`src/components/vault/`, `src/screens/`)

| File | Purpose | Public interface | Tests |
|---|---|---|---|
| `src/components/vault/VaultBreadcrumbs.jsx` (create) | Breadcrumb bar from `breadcrumbsFor`; keyboard navigable; root label from strings. | `<VaultBreadcrumbs t crumbs onNavigate />` | `tests/vaultTreeUi.test.js` |
| `src/components/vault/VaultFolderTile.jsx` (create), `src/components/vault/VaultFileTile.jsx` (create) | Visually distinct Folder/File cards using Files-page interaction language (select checkbox, Ctrl/Cmd-click, open, drag source/drop target) but fed only by manifest state. File tile hosts the client-only poster slot. Locked state renders the existing opaque veil (`{id}.aegisenc` + ciphertext size) only. | `<VaultFolderTile ... />`, `<VaultFileTile ... />` | `tests/vaultTreeUi.test.js` |
| `src/components/vault/VaultTileMenu.jsx` (create) | Three-dot menus: File = Preview (when supported), Download, Rename, Move, Details, Move to Trash; Folder = Open, Rename, Move, Details, Move to Trash; Trash view = Restore, Permanent Delete. Replaces the inline `VaultTileMenu` in `Vault.jsx` when `TREE_UI_ENABLED`. | `<VaultTileMenu t kind view capabilities onAction />` | `tests/vaultTreeUi.test.js` |
| `src/components/vault/VaultDialogs.jsx` (create) | New Folder, Rename, Move (folder picker from manifest), Details, Trash confirm, Restore destination chooser, Permanent Delete strong confirm (typed acknowledgement + fresh-unlock requirement state), Conflict resolution. | one export per dialog | `tests/vaultTreeDialogs.test.js` |
| `src/components/vault/VaultMigrationDialog.jsx` (create) | Genesis migration flow: explain, lease, decrypt progress, collision resolution list (explicit rename per entry — never automatic), commit, resume/takeover states, abandoned-attempt state. | `<VaultMigrationDialog ... />` | `tests/vaultTreeMigrationUi.test.js` |
| `src/components/vault/VaultRecoveryPanel.jsx` (create) | Degraded key state (one slot bad → repair CTA), orphan blobs ("Recover to Vault"), unrecoverable state (fail-closed copy). | `<VaultRecoveryPanel ... />` | `tests/vaultTreeRecoveryUi.test.js` |
| `src/screens/Vault.jsx` (modify) | When `flags.treeUiEnabled && protocolState === 'TREE_V1'` render the tree screen (`VaultTreeScreen`); when `MIGRATING_TREE_V1` render the migration dialog; when `FLAT` and `genesisMigrationEnabled` offer migration; otherwise the existing flat screen unchanged. `lock()` becomes `unlockedState.purge(reason)` + existing state resets. Existing legacy handlers untouched for `FLAT`. | existing `Vault` export | existing `tests/vaultV2ScreenUi.test.js`, `tests/vaultTileActions.test.js`, `tests/vaultAutoLock*.test.js` stay green; `tests/vaultTreeScreen.test.js` |
| `src/screens/VaultTreeScreen.jsx` (create) | The unlocked hierarchy screen composed from the components above; internal drag/drop and bulk actions route through the single `run(intent)` path. | `<VaultTreeScreen ... />` | `tests/vaultTreeScreen.test.js` |
| `src/lib/strings.js` (modify) | New `vaultTree*` keys (en/th) for every new state and error; no plaintext names are interpolated into any string that could be logged. | | `tests/vaultTreeUi.test.js` `STR-1` asserts every referenced key exists in both languages |
| `src/lib/fileDragDrop.js` (reuse, unchanged) | Drag payload helpers are reused for the *in-page* payload only; payload carries node IDs that never leave the page. | — | |

### Server — configuration, storage, database (`server/`)

| File | Purpose | Public interface | Tests |
|---|---|---|---|
| `server/config/vaultTreeLimits.js` (create) | Flags + server limits, read once, throw on invalid, deep-frozen; `VAULT_TREE_*` env names; boot schema probe hook. | `vaultTreeConfigFromEnv(env)` → `{ flags: { schemaAvailable, protocolEnabled, genesisMigrationEnabled, treeUiEnabled, mediaPreviewEnabled, destructivePurgeEnabled }, limits: { maxManifestCiphertextBytes, maxRevisionsPerOwner, migrationLeaseMs, orphanRevisionRetentionMs, orphanBlobRetentionMs, forensicRevisionRetentionMs, purgeRetentionMs, maxAttachBlobIdsPerCas, maxPurgeBlobIdsPerRequest } }`; `VAULT_TREE_CONFIG` | `tests/vaultTreeConfig.test.js` |
| `server/db/migrations/011_vault_tree_v1.sql` (create) | Additive tables/indexes/trigger/grants (see "Schema plan"). | — | `tests/vaultTreePostgres.test.js` |
| `server/db/schema.sql` (modify) | Same tables appended for fresh databases; byte-equivalent DDL to the migration (`PG-SCHEMA-EQ-1`). | — | `tests/vaultTreePostgres.test.js` |
| `server/db/vaultTreeStore.js` (create) | Opaque coordination store with in-memory fallback mirroring `vaultV2Store.js` conventions (every function takes `userId`; other owners' rows return `null`). | `getTreeState(userId)`, `beginMigration(userId, { leaseMs, inventory })`, `takeoverMigration(userId, { leaseMs })`, `abandonMigration(userId, { leaseId })`, `commitGenesis(userId, {...})`, `getHead(userId)`, `getKeyEnvelope(userId)`, `casKeyEnvelope(userId, {...})`, `createRevision(userId, meta)`, `markRevisionPublished(userId, revisionId, { ciphertextSize, sha256 })`, `getRevision(userId, revisionId)`, `casHead(userId, { expectedGeneration, expectedRevisionId, revisionId, attachBlobRefs, purgeBlobRefs, idempotencyKey })`, `listBlobStates(userId)`, `upsertBlobState(userId, ref, lifecycle)`, `listPurgeCandidates(userId, { state })`, `confirmPurge(userId, {...})`, `markPurged(userId, purgeId, refs)`, `listOrphanRevisions(olderThan)`, `listForensicExpired(now)`, `retireRevision(revisionId, state)`, `__resetVaultTreeForTests()` | `tests/vaultTreeStore.test.js` (memory), `tests/vaultTreePostgres.test.js` (real PG) |
| `server/storage/vaultManifestStore.js` (create) | Immutable manifest ciphertext files under `STORAGE_ROOT/vault-tree/<uuid>.aegisenc`; write-once (`wx` flag), sha256 on write, bounded by `maxManifestCiphertextBytes`. | `initVaultManifestStorage()`, `writeManifestCiphertext(stream, { limitBytes })` → `{ storageKey, size, sha256 }`, `openManifestCiphertext(storageKey)`, `deleteManifestCiphertext(storageKey)` | `tests/vaultManifestStore.test.js` |
| `server/storage/vaultTreeMaintenance.js` (create) | Orphan revision GC, forensic-retention expiry deletion, purge executor (flag-gated), scheduled like `vaultUploadCleanup.js`. | `runVaultTreeMaintenance({ now, config })` → `{ orphanRevisionsRemoved, forensicRevisionsRemoved, purgesExecuted }` | `tests/vaultTreeMaintenance.test.js`, `tests/vaultTreePostgres.test.js` |
| `server/routes/vaultTree.js` (create) | The tree endpoint family (see "Route plan") plus `requireVaultProtocolState(...)` middleware factory exported for legacy fencing. | `vaultTreeRouter`, `requireVaultProtocolState({ allow: ['FLAT'] })`, `TREE_ERROR` codes | `tests/vaultTreeApi.test.js` (server), `tests/vaultTreePostgres.test.js` |
| `server/routes/vaultTreeUploads.js` (create) | Tree-aware V2 upload family built from a shared handler factory extracted from `vaultUploads.js`; `mode: 'tree'` commits blobs as `UNREFERENCED` and requires `TREE_V1`. | `vaultTreeUploadsRouter` | `tests/vaultTreeUploadsApi.test.js` |
| `server/routes/vaultUploads.js` (modify) | Extract the six handlers into `createVaultUploadHandlers({ mode })` with `mode: 'legacy'` preserving today's behaviour byte-for-byte; legacy router additionally mounts `requireVaultProtocolState({ allow: ['FLAT'] })`. Existing `tests/vaultV2Api.test.js`, `tests/vaultV2Postgres.test.js` stay green. | unchanged exports | existing suites |
| `server/routes/api.js` (modify) | Mount `vaultTreeRouter` at `/vault/tree` and `vaultTreeUploadsRouter` at `/vault/tree/uploads` (before `/vault/uploads`); add `requireVaultProtocolState({ allow: ['FLAT'] })` to `POST /vault/blobs` and `DELETE /vault/blobs/:id`. `GET /vault`, `GET /vault/blobs/:id`, `GET /vault/blobs/:id/chunks/:index`, `/vault/setup`, `/vault/unlock-attempt` unchanged. | unchanged | existing suites + `tests/vaultTreeFence.test.js` |
| `server/app.js` (modify) | `createApp({ ..., vaultTreeConfig = VAULT_TREE_CONFIG })`; `app.set('vaultTreeConfig', ...)`; `/healthz` gains additive `vaultTree: { schemaAvailable, protocolEnabled, destructivePurgeEnabled }`. | | `tests/vaultTreeConfig.test.js` |
| `server/index.js` (modify) | Boot: schema probe when `schemaAvailable`, `initVaultManifestStorage()`, schedule `runVaultTreeMaintenance` alongside existing vault cleanup timers. | | `tests/vaultTreeConfig.test.js` `BOOT-*` |
| `.env.example` at the repository root (modify; the file that documents `MEDIA_*` today) | Document the six `VAULT_TREE_*`/`VAULT_MEDIA_PREVIEW_ENABLED`/`VAULT_DESTRUCTIVE_PURGE_ENABLED` variables with fail-closed defaults and the retention/lease variables selected at G0. Cross-scope deployment contract path — declared in the PR. | | |

### Tests (owner → file)

`tests/vaultTreeAad.test.js`, `tests/vaultTreeKeys.test.js`, `tests/vaultTreeCanonical.test.js`, `tests/vaultTreeManifest.test.js`, `tests/vaultTreeManifestProperty.test.js`, `tests/vaultTreeManifestCrypto.test.js`, `tests/vaultTreeLimits.test.js`, `tests/vaultTreeConfig.test.js`, `tests/vaultTreeStore.test.js`, `tests/vaultTreePostgres.test.js`, `tests/vaultManifestStore.test.js`, `tests/vaultTreeApi.test.js`, `tests/vaultTreeApiClient.test.js`, `tests/vaultTreeFence.test.js`, `tests/vaultTreeMigration.test.js`, `tests/vaultTreeMigrationUi.test.js`, `tests/vaultTreeUploadsApi.test.js`, `tests/vaultTreeUploadClient.test.js`, `tests/vaultTreeOps.test.js`, `tests/vaultTreeOpsProperty.test.js`, `tests/vaultTreeRebase.test.js`, `tests/vaultTreeSync.test.js`, `tests/vaultUnlockedState.test.js`, `tests/vaultTreeReducer.test.js`, `tests/vaultTreeUi.test.js`, `tests/vaultTreeDialogs.test.js`, `tests/vaultTreeScreen.test.js`, `tests/vaultTreeRecoveryUi.test.js`, `tests/vaultThumbScheduler.test.js`, `tests/vaultImageThumb.test.js`, `tests/vaultGifPreview.test.js`, `tests/vaultVideoPreview.test.js`, `tests/vaultStorageAbsence.test.js`, `tests/vaultTreePurge.test.js`, `tests/vaultTreeMaintenance.test.js`, `tests/vaultTreeMultiClient.test.js`, `tests/vaultTreeCrashPoints.test.js`, `tests/vaultTreeRollback.test.js`, `tests/vaultTreeSourceScan.test.js`; helpers `tests/helpers/vaultTreeFixtures.mjs` (manifest builders, synthetic media bytes, instrumented storage globals), `tests/fixtures/vaultTreeBackend.js` (in-memory tree backend for screen tests, extending `vaultScreenBackend.js`).

## Schema plan (additive; SQL is written only in Task 2.2)

All tables are owner-scoped by `user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE`, granted `SELECT, INSERT, UPDATE, DELETE` to `drive_app` (guarded on role existence, as `004_vault_v2.sql` does), and hold **only opaque identifiers, versions, sizes, IVs, wrapped keys, ciphertext references, states and timestamps**. There is no column that can hold a name, path, parent, MIME, node ID or thumbnail.

| Table | Columns (type · constraint) | Indexes / notes |
|---|---|---|
| `vault_tree_state` | `user_id` PK · `protocol_state TEXT NOT NULL CHECK (protocol_state IN ('FLAT','MIGRATING_TREE_V1','TREE_V1'))` · `min_protocol_version SMALLINT NOT NULL DEFAULT 1` · `head_ever_committed BOOLEAN NOT NULL DEFAULT false` · `tree_mutation_count BIGINT NOT NULL DEFAULT 0` · `migration_lease_id TEXT NULL` · `migration_lease_epoch BIGINT NOT NULL DEFAULT 0` · `migration_lease_expires_at TIMESTAMPTZ NULL` · `frozen_inventory_id TEXT NULL` · `frozen_inventory_digest CHAR(64) NULL` (sha256 over the sorted opaque `formatVersion:blobId` list — opaque IDs only) · `purge_barrier_generation BIGINT NOT NULL DEFAULT 0` · `created_at`, `updated_at` | `CHECK ((protocol_state = 'FLAT') = (migration_lease_id IS NULL AND frozen_inventory_id IS NULL))` for FLAT; `CHECK (protocol_state <> 'TREE_V1' OR head_ever_committed)`. Row is created lazily as `FLAT` on first tree-route access. |
| `vault_tree_frozen_inventory` | `user_id` · `frozen_inventory_id TEXT NOT NULL` · `blob_format_version SMALLINT NOT NULL CHECK (IN (1,2))` · `blob_id TEXT NOT NULL` · PK `(user_id, frozen_inventory_id, blob_format_version, blob_id)` | Exact fenced set for genesis verification and takeover. |
| `vault_tree_key_envelope` | `user_id` PK · `tree_id TEXT NOT NULL` · `owner_scope_id_b64 TEXT NOT NULL` · `key_envelope_version SMALLINT NOT NULL DEFAULT 1` · `envelope_cas_version BIGINT NOT NULL DEFAULT 1` · `primary_wrapped_trk_b64 TEXT NOT NULL` · `primary_wrap_iv_b64 TEXT NOT NULL` · `recovery_wrapped_trk_b64 TEXT NOT NULL` · `recovery_wrap_iv_b64 TEXT NOT NULL` · `created_at`, `updated_at` | `CHECK (primary_wrap_iv_b64 <> recovery_wrap_iv_b64)`. Updated only by `casKeyEnvelope` (`WHERE envelope_cas_version = $expected`). |
| `vault_tree_heads` | `user_id` PK · `tree_id TEXT NOT NULL` · `revision_id TEXT NOT NULL` · `generation BIGINT NOT NULL CHECK (generation >= 1)` · `updated_at` | FK `(revision_id) REFERENCES vault_tree_revisions(revision_id)`; updated only by `casHead` `WHERE generation = $expected AND revision_id = $expectedRevision`. |
| `vault_tree_revisions` | `revision_id TEXT PK` · `user_id` · `tree_id TEXT NOT NULL` · `base_revision_id TEXT NULL` · `generation BIGINT NOT NULL CHECK (>= 1)` · `manifest_schema_version SMALLINT NOT NULL` · `storage_key TEXT UNIQUE NULL` (set on publish) · `ciphertext_size BIGINT NULL CHECK (> 0)` · `ciphertext_sha256 CHAR(64) NULL` · `iv_b64 TEXT NOT NULL` · `wrapped_manifest_dek_b64 TEXT NOT NULL` · `wrap_iv_b64 TEXT NOT NULL` · `state TEXT NOT NULL CHECK (state IN ('CREATED','PUBLISHED','HEAD_COMMITTED','SUPERSEDED','ORPHANED','NON_RECOVERABLE','FORENSIC_DELETED'))` · `idempotency_key TEXT NOT NULL` · `created_at`, `published_at NULL`, `committed_at NULL`, `retired_at NULL` | `UNIQUE (user_id, idempotency_key)`; `UNIQUE (user_id, generation) WHERE state IN ('HEAD_COMMITTED','SUPERSEDED','NON_RECOVERABLE','FORENSIC_DELETED')` (one committed revision per generation); index `(user_id, state, created_at)`. **Immutability trigger** `vault_tree_revisions_immutable` (created by the superuser migration): `BEFORE UPDATE` raises unless only `state`, `storage_key`, `ciphertext_size`, `ciphertext_sha256`, `published_at`, `committed_at`, `retired_at` change and the `state` transition is in the allowed set; `BEFORE DELETE` raises unless `state IN ('ORPHANED','FORENSIC_DELETED')`. |
| `vault_tree_blob_state` | `user_id` · `blob_format_version SMALLINT NOT NULL CHECK (IN (1,2))` · `blob_id TEXT NOT NULL` · `lifecycle TEXT NOT NULL CHECK (IN ('UNREFERENCED','TREE_MANAGED','PURGE_PENDING','PURGED'))` · `attached_generation BIGINT NULL` · `purge_id TEXT NULL` · `created_at`, `updated_at` · PK `(user_id, blob_format_version, blob_id)` | Index `(user_id, lifecycle, created_at)` for orphan retention. No FK to `vault_blobs`/`vault_v2_blobs` (mixed key types); referential consistency is enforced in `casHead`/`commitGenesis` transactions with `SELECT ... FOR UPDATE` on the blob rows. |
| `vault_tree_purge_candidates` | `purge_id TEXT NOT NULL` · `user_id` · `barrier_generation BIGINT NOT NULL` · `blob_format_version SMALLINT NOT NULL` · `blob_id TEXT NOT NULL` · `state TEXT NOT NULL CHECK (IN ('RETENTION_WAIT','CONFIRMABLE','CONFIRMED','PURGED','FAILED'))` · `confirmable_at TIMESTAMPTZ NOT NULL` · `confirmed_idempotency_key TEXT NULL` · `created_at`, `confirmed_at NULL`, `purged_at NULL` · PK `(purge_id, blob_format_version, blob_id)` | Index `(user_id, state, confirmable_at)`; `UNIQUE (user_id, confirmed_idempotency_key)`. |

Concurrency primitives: every CAS runs inside `withTransaction` with `SELECT ... FOR UPDATE` on the `vault_tree_state` row (the owner serialization point) followed by the conditional `UPDATE ... WHERE generation = $expected`, checking `rowCount = 1`; the lease acquisition uses the same row lock plus `expires_at < now()` in the predicate. Maintenance uses `FOR UPDATE SKIP LOCKED` like `withStaleVaultV2CommitLease`. Existing `withAdvisoryLock` is not needed because the state row lock is owner-exact.

Rollback/fail-safe of the schema: the migration is forward-only and additive; a deployment rollback keeps the tables. There is no down-migration and none is planned; `tests/vaultTreePostgres.test.js` `PG-REAPPLY-1` proves re-running the migration is a no-op.

## Route plan

All routes: `requireAuth`, CSRF (mounted under `/api` behind `csrfProtection`), owner scoping in every store call, `Cache-Control: no-store`, JSON bodies ≤ the existing 16 KiB except the raw ciphertext `PUT` which uses `express.raw({ limit: maxManifestCiphertextBytes })`. Every `4xx/5xx` is `{ error, code }` with a code from `TREE_ERROR`; bodies never echo client-supplied strings other than opaque IDs.

| Method · path | State/flag gate | Request (opaque fields only) | Response |
|---|---|---|---|
| `GET /api/vault/tree/state` | protocol | — | `{ protocolState, minProtocolVersion, flags, lease: { held, expiresAt, epoch } \| null, head: { treeId, revisionId, generation } \| null, purgeBarrierGeneration }` |
| `POST /api/vault/tree/migration/begin` | genesis; `FLAT` only | `{}` | `201 { leaseId, epoch, expiresAt, frozenInventoryId, blobs: [{ formatVersion, id }] }` (blobs = the existing `GET /api/vault` envelope list at fence time); `409 TREE_STATE_CONFLICT` if not `FLAT` |
| `POST /api/vault/tree/migration/takeover` | genesis; `MIGRATING_TREE_V1` and lease expired | `{}` | `200 { leaseId, epoch, expiresAt, frozenInventoryId, blobs }`; `409 TREE_LEASE_HELD` while unexpired |
| `POST /api/vault/tree/migration/abandon` | genesis; `MIGRATING_TREE_V1`, `head_ever_committed = false`, `tree_mutation_count = 0`, lease expired or `leaseId` matches | `{ leaseId }` | `200 { protocolState: 'FLAT' }` — the narrowly proven reversion; `409 TREE_ABANDON_FORBIDDEN` otherwise |
| `POST /api/vault/tree/genesis` | genesis; lease valid and epoch matches | `{ leaseId, epoch, frozenInventoryId, treeId, ownerScopeIdB64, keyEnvelope: { primary, recovery }, revision: { revisionId, ivB64, wrappedManifestDekB64, wrapIvB64, manifestSchemaVersion }, idempotencyKey }` after `PUT` of ciphertext for `revisionId` in `CREATED`→`PUBLISHED` state | `201 { treeId, generation: 1, revisionId, protocolState: 'TREE_V1' }`; `409 TREE_LEASE_STALE` / `TREE_INVENTORY_MISMATCH` |
| `GET /api/vault/tree/head` | protocol; `TREE_V1` | — | `{ treeId, revisionId, baseRevisionId, generation, ivB64, wrappedManifestDekB64, wrapIvB64, manifestSchemaVersion, ciphertextSize, keyEnvelope: { ownerScopeIdB64, keyEnvelopeVersion, envelopeCasVersion, primary, recovery } }` |
| `GET /api/vault/tree/revisions/:revisionId` | protocol; owner; `state IN ('PUBLISHED','HEAD_COMMITTED','SUPERSEDED')` and `generation >= purge_barrier_generation` | — | `200 application/octet-stream` ciphertext; `410 TREE_REVISION_NON_RECOVERABLE` below the barrier; `404` otherwise |
| `POST /api/vault/tree/revisions` | protocol; `TREE_V1` or valid genesis lease | `{ revisionId, baseRevisionId, generation, ivB64, wrappedManifestDekB64, wrapIvB64, manifestSchemaVersion, idempotencyKey }` | `201 { revisionId, state: 'CREATED' }`; same idempotency key → `200` existing |
| `PUT /api/vault/tree/revisions/:revisionId/ciphertext` | protocol; owner; `state = 'CREATED'` | raw bytes | `200 { revisionId, state: 'PUBLISHED', ciphertextSize }`; `413 TREE_MANIFEST_TOO_LARGE` |
| `POST /api/vault/tree/head` | protocol; `TREE_V1` | `{ expectedGeneration, expectedRevisionId, revisionId, attachBlobIds: [{ formatVersion, id }], purgeBlobIds: [{ formatVersion, id }], idempotencyKey }` | `200 { generation, revisionId, purgeBarrierGeneration, purgeId \| null }`; `409 TREE_HEAD_CONFLICT { currentGeneration, currentRevisionId }` (candidate revision → `ORPHANED`); `409 TREE_BLOB_STATE_CONFLICT`; repeat with the same idempotency key returns the original outcome |
| `POST /api/vault/tree/key-envelope` | protocol; `TREE_V1` or degraded | `{ expectedEnvelopeCasVersion, primary, recovery }` | `200 { envelopeCasVersion }`; `409 TREE_ENVELOPE_CONFLICT` |
| `GET /api/vault/tree/blobs` | protocol; `MIGRATING_TREE_V1` or `TREE_V1` | — | `{ blobs: [{ ...publicVaultV2Blob / V1 envelope shape, lifecycle }] }` — the tree-aware opaque inventory including `UNREFERENCED` orphans |
| `POST /api/vault/tree/purge/confirm` | protocol; `TREE_V1`; destructive-purge flag for execution | `{ purgeId, expectedGeneration, expectedRevisionId, barrierGeneration, blobIds, idempotencyKey }` | `200 { purged: [...], state: 'PURGED' }`; `423 DESTRUCTIVE_PURGE_DISABLED` (candidates remain `RETENTION_WAIT`/`CONFIRMABLE`); `409 TREE_PURGE_BARRIER_MISMATCH` / `TREE_HEAD_CONFLICT` / `TREE_PURGE_SET_MISMATCH`; `425 TREE_PURGE_RETENTION_PENDING` |
| `GET /api/vault/tree/uploads/limits` · `POST /api/vault/tree/uploads` · `GET /:uploadId` · `PUT /:uploadId/chunks/:index` · `POST /:uploadId/commit` · `DELETE /:uploadId` | protocol; `TREE_V1` only | identical bodies to `/api/vault/uploads/*` (no name/parent/node fields exist there today and none are added) | identical responses; commit additionally returns `lifecycle: 'UNREFERENCED'`; outside `TREE_V1` → `409 TREE_STATE_CONFLICT` |
| Legacy `POST /api/vault/blobs`, `DELETE /api/vault/blobs/:id`, `POST /api/vault/uploads`, `PUT /api/vault/uploads/:id/chunks/:index`, `POST /api/vault/uploads/:id/commit` | `FLAT` only | unchanged | unchanged in `FLAT`; `409 { code: 'TREE_MIGRATION_IN_PROGRESS' }` in `MIGRATING_TREE_V1`; `426 { code: 'UPGRADE_REQUIRED' }` in `TREE_V1` |

Safe reads that stay open in every state: `GET /api/vault`, `GET /api/vault/blobs/:id`, `GET /api/vault/blobs/:id/chunks/:index`, `GET /api/vault/uploads/:uploadId` (status only), `DELETE /api/vault/uploads/:uploadId` (cancelling a never-committed staging session mutates no inventory).

Audit: tree routes record existing-shape audit events with `target` = opaque `revisionId`/`purgeId`/`leaseId` only (`AUD-OPAQUE-1`).

## Limits Register (Phase 0 output; selected at gate G0)

Every row must be completed by Task 0.3 before Phase 1 starts. `MEASURED@G0` is the only permitted deferred-value marker in this document; the self-review scan treats any other placeholder token as a defect. A frozen default may later change only through a new reviewed PR with new evidence — never by editing an env default silently.

| Limit | Measured how (Task) | Selected default | Enforcing test | Config surface |
|---|---|---|---|---|
| Max manifest ciphertext bytes | 0.1: encode+encrypt+upload timing for N = 1k/5k/10k/25k/50k nodes at depth 1–64 in Node and in Chromium/Firefox jsdom-free harness | `MEASURED@G0` | `MC-LIMIT-1`, `TR-413-1` | server `VAULT_TREE_MAX_MANIFEST_CIPHERTEXT_BYTES`; client `VAULT_TREE_CLIENT_LIMITS.maxCiphertextBytes` |
| Max decoded manifest bytes | 0.1 | `MEASURED@G0` | `CN-LIMIT-1` | client only |
| Max nodes | 0.1 (decrypt+validate+render time and heap at N) | `MEASURED@G0` | `MF-LIMIT-NODES` | client only |
| Max depth | 0.1 | `MEASURED@G0` | `MF-LIMIT-DEPTH` | client only |
| Max UTF-8 name bytes | 0.1 (collision-key cost at long names; compare `files` name limits in `010_files_kind_parent.sql`) | `MEASURED@G0` | `MF-LIMIT-NAME` | client only |
| Padding buckets | 0.1 (bucket table that hides node-count deltas ≤ measured typical mutation while bounding overhead) | `MEASURED@G0` | `CN-PAD-*` | protocol constant table in `vaultTreeCanonical.js` (versioned) |
| `recentOperationIds` bound | 0.1 | `MEASURED@G0` | `MF-LIMIT-OPS` | client only |
| Max semantic rebase attempts | 0.1 (two-client contention simulation) | `MEASURED@G0` | `SY-REBASE-BOUND` | client only |
| Migration lease duration | 0.1 (decrypt-all timing for the largest measured inventory ×3 safety) | `MEASURED@G0` | `PG-LEASE-EXPIRY` | `VAULT_TREE_MIGRATION_LEASE_MS` |
| Orphan revision retention | 0.3 decision from CAS-loss frequency in 0.1 contention runs | `MEASURED@G0` | `MT-ORPHAN-REV-1` | `VAULT_TREE_ORPHAN_REVISION_RETENTION_MS` |
| Orphan blob retention (reporting only; no automatic deletion in this PR) | 0.3 | `MEASURED@G0` | `MT-ORPHAN-BLOB-1` | `VAULT_TREE_ORPHAN_BLOB_RETENTION_MS` |
| Forensic revision retention | 0.3 (owner decision with evidence of ciphertext volume) | `MEASURED@G0` | `MT-FORENSIC-1` | `VAULT_TREE_FORENSIC_REVISION_RETENTION_MS` |
| Purge retention/grace | 0.3 | `MEASURED@G0` | `PU-RETENTION-1` | `VAULT_TREE_PURGE_RETENTION_MS` |
| Image input bytes | 0.2 (decode time/heap for JPEG/PNG/WebP at 1–64 MiB) | `MEASURED@G0` | `IT-LIMIT-BYTES` | client only |
| Decoded image pixels | 0.2 | `MEASURED@G0` | `IT-LIMIT-PIXELS` | client only |
| GIF full-play maximum bytes | 0.2 (animated GIF Object URL heap at 1–64 MiB) | `MEASURED@G0` | `GF-LIMIT-PLAY` | client only |
| GIF poster decode budget | 0.2 | `MEASURED@G0` | `GF-LIMIT-POSTER` | client only |
| Simultaneous thumbnail jobs | 0.2 | `MEASURED@G0` | `TS-LIMIT-JOBS` | client only |
| Retained Object URL count | 0.2 | `MEASURED@G0` | `TS-LIMIT-URLS` | client only |
| Estimated preview memory ceiling | 0.2 | `MEASURED@G0` | `TS-LIMIT-MEM` | client only |
| Max `attachBlobIds` per CAS / max purge blob IDs per request | 0.3 | `MEASURED@G0` | `TR-ATTACH-MAX`, `PU-SET-MAX` | `VAULT_TREE_MAX_ATTACH_PER_CAS`, `VAULT_TREE_MAX_PURGE_PER_REQUEST` |

Already-shipped constants reused unchanged: V1 whole-file ceiling `MAX_VAULT_CIPHERTEXT_BYTES` (`server/storage/vaultStore.js`), V2 `VAULT_TRANSFER_LIMITS`, `PREVIEW_RANGE_WINDOW_BYTES`, `MAX_PREVIEW_PLAINTEXT_CACHE_BYTES`, `MAX_PREVIEW_PREFETCH_SLOTS`, `MAX_BUFFERED_PLAINTEXT_BYTES`.

## Phases, tasks and reviewer gates

| Phase | Tasks | Gate | Gate evidence |
|---|---|---|---|
| 0 — disposable measurements / limits | 0.1, 0.2, 0.3 | **G0** | Limits Register complete; owner accepts defaults; measurement scripts retained under `scripts/measure/vault-tree/` (not part of build/tests) |
| 1 — manifest crypto + TRK + canonical serialization | 1.1–1.5 | **G1** | crypto/manifest suites green; AAD vectors frozen; no server code |
| 2 — additive DB schema + opaque state/CAS API | 2.1–2.5 | **G2** | PG suite green on disposable DB; legacy suites green; fence proven |
| 3 — protocol migration fence + genesis migration | 3.1–3.3 | **G3** | lease/genesis races green; V1/V2 ciphertext unchanged proof |
| 4 — tree-aware encrypted blob upload/orphan lifecycle | 4.1–4.3 | **G4** | upload family green; transfer-perf constants unchanged proof |
| 5 — client manifest state + hierarchy commands | 5.1–5.5 | **G5** | ops/rebase/sync/unlocked-state suites green |
| 6 — Vault UI file-management parity | 6.1–6.4 | **G6** | screen suites green; legacy screen suites unchanged; owner UI walkthrough on dev build |
| 7 — client-only media previews | 7.1–7.4 | **G7** | preview + storage-absence suites green |
| 8 — Trash/Restore + purge barrier | 8.1–8.3 | **G8** | purge PG races green; `DESTRUCTIVE_PURGE_ENABLED=false` path proven truthful |
| 9 — multi-device/concurrency/crash qualification | 9.1–9.3 | **G9** | two-client PG suites green; rollback suite green |
| 10 — exact-SHA regression / Production preflight | 10.1, 10.2 | **G10** | full regression on Windows + WSL Linux; policy validators; receipt; PR Ready request |

Each gate: (1) checkpoint commit SHA recorded in the IDEA1 Session Register, (2) PR #157 body "Verification" updated with exact commands and counts, (3) reviewer (Kla) acknowledgement in the PR before the next phase starts. Phases 6 and 7 may be developed in parallel worktrees after G5, but merge order is 6 then 7.

---

## Phase 0 — Disposable measurements and limit selection

Phase 0 writes no product source. Its scripts live in `IDEA1-AEGIS_Drive_LC/scripts/measure/vault-tree/` and are excluded from `npm test` (the test glob is `tests/**/*.test.js`) and from the Vite build. They use the *same* crypto primitives the product will use (WebCrypto AES-GCM, the canonical encoder prototype inlined in the script) so numbers transfer.

### Task 0.1: Manifest size, serialization, crypto and contention measurement

**Files:**
- Create: `scripts/measure/vault-tree/manifest-bench.mjs` (Node 24 WebCrypto)
- Create: `scripts/measure/vault-tree/manifest-bench.html` + `scripts/measure/vault-tree/manifest-bench-browser.js` (opened manually in Chromium and Firefox via `vite preview --outDir` of a disposable build in `os.tmpdir()`; never committed to `dist/`)
- Create: `scripts/measure/vault-tree/contention-sim.mjs` (two simulated clients, random disjoint/overlapping intents, counts CAS losses and rebase depth)
- Create: `docs/superpowers/plans/2026-09-19-idea1-private-vault-encrypted-hierarchy-limits.md` (the **Limits Evidence** note; Task 0.3 fills the "Selected" column)

**Interfaces:** none (disposable). Output is a Markdown table per run: `nodes, depth, nameBytes, encodedBytes, paddedBytes, ciphertextBytes, encodeMs, encryptMs, decryptMs, validateMs, heapDeltaMB, browser, version`.

- [ ] **Step 1: Write the bench** — synthetic manifests at N ∈ {100, 1 000, 5 000, 10 000, 25 000, 50 000}, depth ∈ {1, 8, 32, 64}, name bytes ∈ {16, 64, 255, 1 024}; measure encode/pad/encrypt/decrypt/validate wall time and heap (`process.memoryUsage()` in Node, `performance.measureUserAgentSpecificMemory()` where available in browser, otherwise documented as `NOT MEASURED`).
- [ ] **Step 2: Run in Node** — `node scripts/measure/vault-tree/manifest-bench.mjs --out /tmp/vault-tree-bench-node.md` → table saved; copy into the Limits Evidence note under "Node 24 (Windows)" and "Node 24 (WSL Ubuntu)" (both hosts, per `wsl-linux-verification-setup` memory).
- [ ] **Step 3: Run in browsers** — Chromium and Firefox current stable on the dev machine; record UA strings; record the largest N at which decrypt+validate stays under 1 000 ms and heap delta under 256 MB (recorded facts; the *choice* of threshold is Task 0.3's).
- [ ] **Step 4: Contention** — `node scripts/measure/vault-tree/contention-sim.mjs --clients 2 --ops 2000 --overlap 0.1,0.3,0.6` → CAS-loss rate and rebase depth distribution per overlap.
- [ ] **Step 5: Lease timing** — record decrypt-all time for the largest measured inventory shape from `GET /api/vault` fixtures (V1 + V2 envelopes; `decryptBlobMeta`/`decryptVaultV2Meta` per item) at 100/1 000/10 000 items.
- [ ] **Step 6: PASS evidence** — Limits Evidence note contains every table with host/browser identity and the exact command; no product file changed (`git status --short` shows only `scripts/measure/**` and the evidence note).
- [ ] **Step 7: Commit** → `docs(idea1): measure vault tree manifest limits`

### Task 0.2: Client-only media decode and memory measurement

**Files:**
- Create: `scripts/measure/vault-tree/media-bench.html` + `scripts/measure/vault-tree/media-bench-browser.js`
- Create: `scripts/measure/vault-tree/make-media-fixtures.mjs` (synthetic JPEG/PNG/WebP at 1–64 MiB via `sharp` where available, animated GIF via `sharp`/`gifsicle` if present, MP4 via FFmpeg if present; missing tools → that class recorded `NOT MEASURED`; fixtures in `os.tmpdir()` only)
- Modify: `docs/superpowers/plans/2026-09-19-idea1-private-vault-encrypted-hierarchy-limits.md`

- [ ] **Step 1: Write the bench** — for each fixture: `createImageBitmap` decode time, decoded pixel count, heap delta; scaled poster generation time; animated GIF `<img src=objectURL>` heap at 1/4/16/32/64 MiB; concurrent decode of 1/2/4/8 images; Object URL retention count vs. heap; V2 video poster via `<video preload="metadata">` seek on a synthetic MP4 served through a local `Response` stream (no Service Worker in the bench; the SW path is measured in Task 7.4 evidence).
- [ ] **Step 2: Run** in Chromium and Firefox; record UA, device memory (`navigator.deviceMemory` where available), and the highest byte/pixel class whose heap delta stays below 128 MB and decode below 500 ms (facts only).
- [ ] **Step 3: PASS evidence** — tables in the Limits Evidence note; no product file changed.
- [ ] **Step 4: Commit** → `docs(idea1): measure vault client-only media preview limits`

### Task 0.3: Limits selection and configuration surface (gate G0)

**Files:**
- Modify: `docs/superpowers/plans/2026-09-19-idea1-private-vault-encrypted-hierarchy-limits.md` — "Selected defaults" table
- Modify: this plan — replace every `MEASURED@G0` in the Limits Register with the selected value and a link to the evidence row (the only permitted edit to this plan during execution besides checkbox ticks and the self-review record)
- Create: `src/lib/vaultTreeLimits.js` (frozen client defaults; `treeLimitsFrom(overrides)`), `tests/vaultTreeLimits.test.js`
- Note: the server surface (`server/config/vaultTreeLimits.js`) is created in Task 2.1 from the same table.

- [ ] **Step 1: Write failing test** `tests/vaultTreeLimits.test.js`:
```
LM-1 VAULT_TREE_CLIENT_LIMITS is deep-frozen and every key equals the Limits Register selected value (literal table inside the test — the test is the freeze)
LM-2 treeLimitsFrom({ maxNodes: 5 }) overrides one key and leaves the rest equal to defaults
LM-3 treeLimitsFrom rejects a non-integer, zero, negative, or unknown key with TypeError
LM-4 padding bucket table is strictly increasing, starts at the smallest genesis manifest size measured in 0.1, and the last bucket equals maxDecodedBytes
```
- [ ] **Step 2: RED** `node --test --test-reporter=tap tests/vaultTreeLimits.test.js` → `ERR_MODULE_NOT_FOUND ../src/lib/vaultTreeLimits.js`.
- [ ] **Step 3: Owner decision** — for each Limits Register row write: evidence row → selected default → reasoning (one sentence) in the evidence note; Kla acknowledges in PR #157.
- [ ] **Step 4: Implement** `src/lib/vaultTreeLimits.js` with the selected values.
- [ ] **Step 5: GREEN** → `# tests 4 # pass 4`.
- [ ] **Step 6:** `git diff --check` clean; `node scripts/validate-vault.mjs` (repo root) pass.
- [ ] **Step 7: Commit** → `docs(idea1): select vault tree limits from measured evidence` (includes the `MEASURED@G0` replacements in this plan and `src/lib/vaultTreeLimits.js`).
- [ ] **Gate G0** — Session Register row `PVH-P0`; reviewer acknowledgement before Task 1.1.

---

## Phase 1 — Manifest crypto, TRK and canonical serialization (client, pure)

No server code, no UI. Every module is pure or WebCrypto-only, testable under Node 24's global `crypto.subtle`.

### Task 1.1: Domain-separated AAD encoders

**Files:**
- Create: `src/lib/vaultTreeAad.js`
- Test: `tests/vaultTreeAad.test.js`

**Interfaces:** as in the file map. All three encoders return a fresh `Uint8Array`; inputs are validated (`treeId`/`revisionId` = 22-char base64url, `slot` ∈ {`primary`,`recovery`}, integers are safe non-negative).

- [ ] **Step 1: Write failing tests**
```
TA-1 frozen vectors: for one fixed input set each encoder equals a hex literal stored in the test (the freeze — any byte change fails)
TA-2 layout: byte 0 = 1 (layout version); bytes 1–2 = big-endian label length; label bytes follow; then tag/len/value triples in table order
TA-3 domain separation: the three encoders never produce equal bytes for overlapping fields; primary vs recovery slot differ in exactly the slot field
TA-4 baseRevisionId null encodes as tag + len 0; undefined is rejected (must be explicit null)
TA-5 rejects: non-base64url ids, wrong-length ids, negative generation, generation > 2^53, unknown slot, non-integer paddedPlaintextLength
TA-6 no string concatenation: an id containing the label text does not shift parsing (round-trip decoder in the test parses tags back and matches inputs)
```
- [ ] **Step 2: RED** `node --test --test-reporter=tap tests/vaultTreeAad.test.js` → `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement** — `DataView` writes, big-endian, no template strings.
- [ ] **Step 4: GREEN** → `# tests 6 # pass 6`.
- [ ] **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add vault tree AAD encoders`

### Task 1.2: TRK slots, degraded unlock, rotation and Manifest DEK wrapping

**Files:**
- Create: `src/lib/vaultTreeKeys.js`
- Test: `tests/vaultTreeKeys.test.js`

**Interfaces:** as in the file map. `ctx` = `{ ownerScopeId, treeId, protocolVersion: 1, keyEnvelopeVersion: 1 }` for TRK; `{ treeId, revisionId, baseRevisionId, generation, manifestSchemaVersion }` for Manifest DEK. Wrapping uses AES-GCM with the AAD from Task 1.1; the KEK is the existing `deriveKek()` output (tests derive with the `FAST` Argon2 params used by `tests/vaultV2Postgres.test.js`).

- [ ] **Step 1: Write failing tests**
```
TK-1 generateTrkBytes returns 32 bytes; two calls differ; importTrk returns a non-extractable AES-GCM CryptoKey (exportKey rejects)
TK-2 wrapTrkSlots: primary and recovery decrypt to the same TRK; wrap IVs differ; ciphertexts differ
TK-3 unwrapTrkSlots healthy → status HEALTHY, badSlot null
TK-4 one corrupt slot (flip a byte in primary) → status DEGRADED, badSlot 'primary', trk usable; same for recovery
TK-5 both corrupt → throws TreeKeyError('TRK_UNRECOVERABLE'); no key returned
TK-6 slots decrypt to different TRKs (constructed from two independent wraps) → throws 'TRK_SLOT_DISAGREEMENT' (fail closed even though both authenticate)
TK-7 AAD substitution: primary ciphertext presented as recovery, or another treeId/ownerScopeId/keyEnvelopeVersion → both slots fail → 'TRK_UNRECOVERABLE'
TK-8 wrong KEK → 'TRK_UNRECOVERABLE'
TK-9 rewrapTrkSlots(oldKek, newKek): new slots unwrap under newKek to the same TRK (proved by wrapping a test Manifest DEK under the old-unwrapped TRK and unwrapping under the new one); old slots still unwrap under oldKek; new IVs differ from old
TK-10 repairTrkSlot recreates a corrupt slot from the validated TRK; result is HEALTHY
TK-11 wrapManifestDek/unwrapManifestDek round trip; wrong TRK fails; tamper fails; wrap IV fresh per call (1 000 wraps → 1 000 distinct IVs)
TK-12 Manifest DEK AAD substitution: wrapped under {generation 3} presented as {generation 4}, or other treeId/revisionId/baseRevisionId/schemaVersion → fails
TK-13 direct-KEK guard: unwrapManifestDek(kek, ...) with the KEK instead of the TRK fails (there is no code path wrapping a Manifest DEK under the KEK; the test also source-scans vaultTreeKeys.js for any subtle.wrapKey/encrypt call whose key argument is named kek in the Manifest DEK functions)
TK-14 plaintext TRK bytes passed to importTrk are zero-filled after import (the caller's Uint8Array is all zeros afterwards)
```
- [ ] **Step 2: RED** `node --test --test-reporter=tap tests/vaultTreeKeys.test.js` → `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement.** Unwrap both slots always (no short-circuit), compare decrypted bytes constant-time (`crypto.subtle.timingSafeEqual` is unavailable in browsers — compare via importing both as keys and verifying an AES-GCM test-vector encryption under each; equality of ciphertexts under a fixed IV/plaintext proves key equality without exposing bytes to a non-constant-time comparison).
- [ ] **Step 4: GREEN** → `# tests 14 # pass 14`.
- [ ] **Step 5: Regression** `node --test --test-reporter=tap tests/vaultCrypto.test.js tests/vaultChunkCrypto.test.js tests/vaultTreeAad.test.js tests/vaultTreeKeys.test.js`.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add stable TRK key envelope and manifest DEK wrapping`

### Task 1.3: Canonical serialization, strict parsing and padding

**Files:**
- Create: `src/lib/vaultTreeCanonical.js`
- Test: `tests/vaultTreeCanonical.test.js`

- [ ] **Step 1: Write failing tests**
```
CN-1 canonicalEncode of a manifest with keys inserted in three different orders yields identical bytes (frozen hex vector for a 3-node manifest)
CN-2 nested node maps are encoded as sorted arrays of [nodeId, node] pairs (Map order is never trusted)
CN-3 canonicalDecode rejects duplicate keys at any depth → CanonicalError('DUPLICATE_KEY') (hand-built byte input)
CN-4 rejects non-integer, NaN, Infinity, -0, exponent notation, numbers > 2^53 → 'BAD_NUMBER'
CN-5 rejects depth > limits.maxJsonDepth → 'DEPTH'; rejects trailing bytes → 'TRAILING'; unknown top-level key → 'UNKNOWN_KEY'
CN-6 decoded bytes > limits.maxDecodedBytes → 'LIMIT_DECODED_BYTES' before any parse work (checked on length first)
CN-7 strings are emitted as NFC-preserving UTF-8 with control chars escaped; a name containing U+0000, U+2028, unpaired surrogate is rejected at encode ('BAD_STRING')
CN-8 padToBucket: output length equals the smallest bucket ≥ input length + trailer; stripPadding returns exact original; input larger than the last bucket → 'LIMIT_DECODED_BYTES'
CN-9 padding trailer tamper (change padded length field) → stripPadding throws 'BAD_PADDING'
CN-10 determinism: encode(decode(encode(m))) === encode(m) for 200 random manifests (property)
```
- [ ] **Step 2: RED** → `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement** — hand-written tokenizer/parser (no `JSON.parse` for the protocol path; `JSON.parse` may be used only in tests as an oracle).
- [ ] **Step 4: GREEN** → `# tests 10 # pass 10`.
- [ ] **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add canonical vault tree manifest serialization`

### Task 1.4: Manifest schema, graph validation, collision key, effective lifecycle

**Files:**
- Create: `src/lib/vaultTreeManifest.js`, `src/lib/unicodeCaseFold.js` (generated table: `scripts/measure/vault-tree/gen-casefold.mjs` reads a pinned `CaseFolding.txt` (Unicode version recorded in the module header) and emits the `C + F` mappings; the generator is committed, the source file is not)
- Test: `tests/vaultTreeManifest.test.js`, `tests/vaultTreeManifestProperty.test.js`

- [ ] **Step 1: Write failing tests**
```
MF-1 createGenesisManifest: schemaVersion 1, generation 1, baseRevisionId null, exactly one node = root folder with parentNodeId null, recentOperationIds []
MF-2 validateManifest accepts a 5-node tree and returns an index with parent→children map, depth per node
MF-3 rejects: no root, two roots, root with parent, node whose parent is missing, node whose parent is a file, duplicate nodeId, unreachable node (parent chain not ending at root), self-parent, 3-cycle (each a distinct ManifestError code: NO_ROOT, MULTI_ROOT, ROOT_PARENT, PARENT_MISSING, PARENT_NOT_FOLDER, DUP_NODE, UNREACHABLE, CYCLE)
MF-4 rejects file node without blobRef, folder node with blobRef, blobFormatVersion not 1|2, plainSize negative, mediaType > 255 bytes, invalid timestamps (non-integer or < 0)
MF-5 rejects active sibling collision by collisionKey: 'Report.PDF' vs 'report.pdf', 'ß' vs 'ss' (full case folding), NFD vs NFC composed forms; trashed sibling does NOT collide with an active one
MF-LIMIT-NODES / MF-LIMIT-DEPTH / MF-LIMIT-NAME / MF-LIMIT-OPS: each bound from injected limits is enforced with its own code
MF-6 effectiveState: node trashed → 'trashed'; child of trashed folder with own state active → 'trashed'; child with own state purge-pending under trashed ancestor → 'purge-pending'; restore parent → child active again unless it carries its own trashed state
MF-7 childrenOf(view 'active') excludes effectively trashed nodes; view 'trash' returns only subtree roots whose own state is trashed/purge-pending and whose ancestors are all active (no double listing of descendants)
MF-8 breadcrumbsFor returns [root, ..., node] by walking parents with a visited set; a corrupted index with a cycle throws instead of looping (bounded by maxDepth)
MF-9 lifecycle consistency: trashed node must carry trashedAtClient and trashedFromParentNodeId; active must not; violations rejected (LIFECYCLE_INCONSISTENT)
MF-10 all-fields-untrusted: a decoded object with a prototype key (`__proto__`, `constructor`) is rejected (UNKNOWN_KEY) and never assigned
MP-1 (property) 500 random valid trees pass; every single-field mutation from a generated list (drop root, re-parent to descendant, duplicate name) fails with the expected code
MP-2 (property) effectiveState(node) === any(ancestor or self stored state ∈ {trashed, purge-pending}) for all nodes of 200 random trees with random lifecycle assignments
```
- [ ] **Step 2: RED** → `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement** — index built once per validation; all walks iterative with visited sets; name policy: NFC normalize for storage of display name unchanged, collision key = NFC → full case folding via the generated table.
- [ ] **Step 4: GREEN** → `# tests 16 # pass 16` (MF-1..10, MF-LIMIT-×4, MP-1, MP-2).
- [ ] **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add vault tree manifest validation and lifecycle rules`

### Task 1.5: Revision encryption round trip and gate G1

**Files:**
- Create: `src/lib/vaultTreeManifestCrypto.js`
- Test: `tests/vaultTreeManifestCrypto.test.js`, `tests/vaultTreeSourceScan.test.js` (first entries)

- [ ] **Step 1: Write failing tests**
```
MC-1 encryptManifestRevision → decryptManifestRevision round trip equals input (deep) for genesis and a 1 000-node manifest
MC-2 wrong TRK → throws; tampered ciphertext byte → throws; tampered IV → throws; no partial manifest is returned (assert the function returns nothing before validation succeeds — spy on validateManifest order)
MC-3 AAD substitution: ciphertext of {treeId A, generation 3} decrypted with ctx {treeId B} / {generation 4} / {revisionId other} / {baseRevisionId other} / {schema 2} / {paddedLength other} → throws
MC-4 IV freshness: 500 encryptions of the same manifest → 500 distinct ivB64 and distinct wrapIvB64
MC-5 ciphertext length equals padded bucket + 16 (GCM tag): two manifests whose encoded sizes fall in the same bucket produce equal ciphertext lengths
MC-LIMIT-1 ciphertext over limits.maxCiphertextBytes is rejected before decrypt attempts
MC-6 passphrase rotation end to end: kek1 → TRK slots; commit revisions g1..g3; rewrapTrkSlots(kek1, kek2); every stored revision {ciphertext, iv, wrappedManifestDek, wrapIv} is byte-identical and decrypts under the TRK unwrapped from the new slots
MC-7 degraded path: one corrupt slot → decrypt still works; both corrupt → no revision decryptable (fail closed)
SS-1 (source scan) no file under src/lib/vault* or src/components/vault imports server/**, sharp, ffmpeg, mediaApi.js, mediaScheduler.js, MediaThumb.jsx
SS-2 (source scan) no file under server/** imports src/lib/vaultTreeManifest.js, vaultTreeOps.js, vaultTreeCanonical.js, vaultTreeRebase.js (SRV-NOIMPORT-1)
SS-3 (source scan) no vault* client module contains `localStorage`, `sessionStorage`, `indexedDB`, `caches.open`, `caches.match` outside an explicit "// storage-absence-guard" comment line used by tests
```
- [ ] **Step 2: RED** → `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN** → `# tests 11 # pass 11`.
- [ ] **Step 5: Phase regression** `node --test --test-concurrency=1 --test-reporter=tap tests/vaultTreeAad.test.js tests/vaultTreeKeys.test.js tests/vaultTreeCanonical.test.js tests/vaultTreeManifest.test.js tests/vaultTreeManifestProperty.test.js tests/vaultTreeManifestCrypto.test.js tests/vaultTreeLimits.test.js tests/vaultTreeSourceScan.test.js tests/vaultCrypto.test.js tests/vaultChunkCrypto.test.js` → all pass; record counts.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): encrypt vault tree manifest revisions under TRK-wrapped DEKs`
- [ ] **Gate G1** — Session Register row `PVH-P1`; reviewer confirms: no server file changed, no existing crypto module changed (`git diff --name-status <G0 SHA>...HEAD` lists only new files under `src/lib/vaultTree*`, `src/lib/unicodeCaseFold.js`, `tests/vaultTree*`, `scripts/measure/**`).

---

## Phase 2 — Additive DB schema and opaque state/CAS API (server)

### Task 2.1: Server configuration, flags and boot probe

**Files:**
- Create: `server/config/vaultTreeLimits.js`
- Modify: `server/app.js` (inject `vaultTreeConfig`, `/healthz` block), `server/index.js` (boot probe, storage init, maintenance timer registration only — the maintenance module itself arrives in Task 8.3; until then the timer registers a no-op), repository-root `.env.example`
- Test: `tests/vaultTreeConfig.test.js`

- [ ] **Step 1: Write failing tests**
```
CF-1 defaults with an empty env: all six flags false; limits equal the Limits Register selected server values (literal table in the test)
CF-2 each env variable parses 'true'/'false' only; 'yes', '1', '' (explicit empty) → throw with the variable name
CF-3 limits parse positive integers; out-of-range → throw; result deep-frozen
FLAG-CHAIN-1 protocolEnabled=true with schemaAvailable=false → throw
FLAG-CHAIN-2 genesisMigrationEnabled=true with protocolEnabled=false → throw
FLAG-CHAIN-3 treeUiEnabled=true with protocolEnabled=false → throw
FLAG-CHAIN-4 mediaPreviewEnabled=true with treeUiEnabled=false → throw
FLAG-CHAIN-5 destructivePurgeEnabled=true with protocolEnabled=false → throw
CF-4 createApp() default config = all flags false; GET /api/vault/tree/state → 503 { code: 'TREE_PROTOCOL_DISABLED' }; /healthz includes vaultTree { schemaAvailable:false, protocolEnabled:false, destructivePurgeEnabled:false }
BOOT-1 schemaAvailable=true and probe reports a missing table → boot rejects with the table name (probe is injected: `probeTreeSchema()` returns { missing: [...] })
BOOT-2 schemaAvailable=false → probe never called
```
- [ ] **Step 2: RED** → `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement** following `mediaLimits.js` (`readBoolean`, `readInteger`, `deepFreeze`).
- [ ] **Step 4: GREEN** → `# tests 11 # pass 11`.
- [ ] **Step 5: Regression** `node --test --test-reporter=tap tests/vaultApi.test.js tests/vaultV2Api.test.js tests/mediaCapabilities.test.js` (healthz shape additive).
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add fail-closed vault tree rollout flags`

### Task 2.2: Additive schema migration and opaque tree store

**Files:**
- Create: `server/db/migrations/011_vault_tree_v1.sql`, `server/db/vaultTreeStore.js`
- Modify: `server/db/schema.sql` (append identical DDL)
- Test: `tests/vaultTreeStore.test.js` (memory mode), `tests/vaultTreePostgres.test.js` (real PG; skips with the same honest message as `vaultV2Postgres.test.js` when `TEST_DATABASE_URL` is unset)

**PG procedure** (per `idea1-postgres-verification-procedure` memory): `sh scripts/pg-integration-env.sh up` → one disposable database per test file, migrations applied with `psql -v ON_ERROR_STOP=1` as the migration superuser, app connects as `drive_app`.

- [ ] **Step 1: Write failing store tests (memory + PG share one spec file imported by both)**
```
ST-1 getTreeState creates FLAT lazily; other user → independent row
ST-2 createRevision + markRevisionPublished + casHead genesis path is not allowed in FLAT (returns { ok:false, code:'TREE_STATE_CONFLICT' }) — genesis goes through commitGenesis
ST-3 casHead succeeds when expected matches; generation +1; previous revision → SUPERSEDED; new → HEAD_COMMITTED
ST-4 casHead with stale expectedGeneration → { ok:false, code:'TREE_HEAD_CONFLICT', current }, candidate → ORPHANED, head unchanged
ST-5 casHead idempotency: same idempotencyKey twice → second returns the first outcome without a second head change; different key with same revisionId → conflict (revision already committed)
ST-6 casHead attachBlobRefs: UNREFERENCED → TREE_MANAGED with attached_generation; a ref that is TREE_MANAGED/PURGE_PENDING/PURGED or belongs to another owner → { code:'TREE_BLOB_STATE_CONFLICT' }, whole CAS rolled back (head unchanged, blob states unchanged)
ST-7 casKeyEnvelope with expected cas version; stale → TREE_ENVELOPE_CONFLICT; primary and recovery IVs must differ
ST-8 getRevision refuses other owner (null); refuses state NON_RECOVERABLE (returns { nonRecoverable:true })
ST-9 owner isolation on every function (loop over the store surface with two users)
ST-10 listBlobStates returns only this owner's rows; lifecycle vocabulary enforced
PG-SCHEMA-EQ-1 DDL in 011 equals the appended block in schema.sql (normalised whitespace/comments)
PG-REAPPLY-1 migration applied twice is a no-op (row counts and \d unchanged)
PG-GRANT-1 drive_app can SELECT/INSERT/UPDATE/DELETE every tree table and cannot CREATE TABLE
PG-CHECK-1 every CHECK constraint rejects the listed invalid values (protocol_state, lifecycle, revision state, generation 0, blob_format_version 3, equal IVs)
PG-IMMUTABLE-1 UPDATE vault_tree_revisions SET iv_b64 = ... on a committed revision raises; UPDATE state through an allowed transition succeeds; DELETE of HEAD_COMMITTED raises; DELETE of ORPHANED succeeds
PG-CAS-RACE-1 two connections, same expectedGeneration, concurrent casHead → exactly one wins; loser sees TREE_HEAD_CONFLICT and its revision ORPHANED (repeat 20×)
PG-CAS-RACE-2 two connections race attach of the same UNREFERENCED blob → one wins, other TREE_BLOB_STATE_CONFLICT
PG-ENVELOPE-RACE-1 concurrent casKeyEnvelope → one wins
PG-CASCADE-1 deleting the user cascades every tree row
```
- [ ] **Step 2: RED** `node --test --test-reporter=tap tests/vaultTreeStore.test.js` → `ERR_MODULE_NOT_FOUND`; `TEST_DATABASE_URL=... node --test --test-reporter=tap tests/vaultTreePostgres.test.js` → migration file missing.
- [ ] **Step 3: Implement** SQL exactly per "Schema plan" (comments in the migration state, as `004_vault_v2.sql` does, what the server learns and what no column can hold) and the store with `withTransaction` + `FOR UPDATE` on `vault_tree_state`.
- [ ] **Step 4: GREEN** memory → `# tests 10 # pass 10`; PG → `# tests 19 # pass 19` (ST-1..10 re-run against PG + PG-*).
- [ ] **Step 5: Regression** `TEST_DATABASE_URL=... node --test --test-concurrency=1 --test-reporter=tap tests/vaultPostgres.test.js tests/vaultV2Postgres.test.js tests/vaultTreePostgres.test.js` (fresh database per file).
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add additive vault tree schema and opaque CAS store`

### Task 2.3: Immutable manifest ciphertext storage

**Files:**
- Create: `server/storage/vaultManifestStore.js`
- Test: `tests/vaultManifestStore.test.js`

- [ ] **Step 1: Write failing tests**
```
MS-1 writeManifestCiphertext streams to STORAGE_ROOT/vault-tree/<uuid>.aegisenc with flag 'wx'; returns { storageKey, size, sha256 }; storage key never contains user-supplied text
MS-2 over limitBytes → rejects with TREE_MANIFEST_TOO_LARGE and no file remains
MS-3 openManifestCiphertext returns a readable stream of exactly the bytes; unknown key → null
MS-4 deleteManifestCiphertext is idempotent (ENOENT ignored)
MS-5 initVaultManifestStorage creates the directory; refuses a storage root outside STORAGE_ROOT
```
- [ ] **Step 2: RED**; **Step 3: Implement** mirroring `vaultStore.js` conventions; **Step 4: GREEN** → `# tests 5 # pass 5`; **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add immutable vault manifest ciphertext store`

### Task 2.4: Tree endpoint family (state, head, revisions, head CAS, key envelope, blobs)

**Files:**
- Create: `server/routes/vaultTree.js`
- Modify: `server/routes/api.js` (mount at `/vault/tree`)
- Test: `tests/vaultTreeApi.test.js` (server, memory mode through `createApp`), `tests/vaultTreePostgres.test.js` (adds `PG-API-*`), `tests/helpers/vaultTreeFixtures.mjs`

**Interfaces:** the "Route plan" table. `requireVaultProtocolState({ allow })` is exported here for Task 2.5. Genesis/migration/purge routes are added in Tasks 3.1 and 8.1; this task registers them as `404` until then (no stub responses that could be mistaken for success).

- [ ] **Step 1: Write failing tests**
```
TR-1 unauthenticated → 401 on every route; CSRF enforced on every non-GET (same helper as vaultV2Api.test.js)
TR-2 flags off → 503 TREE_PROTOCOL_DISABLED on every tree route
TR-3 GET state on a fresh owner → FLAT, head null, lease null, flags echoed, purgeBarrierGeneration 0
TR-4 POST revisions validates opaque syntax (22-char base64url ids, 16-char base64 IVs, integer generation ≥ 1, schema version 1) → 400 on each violation; never echoes the offending value
TR-5 PUT ciphertext: raw body stored; state CREATED → PUBLISHED; second PUT → 409; over limit → 413 TREE_MANIFEST_TOO_LARGE
TR-6 (after a fixture genesis inserted directly via the store) POST head CAS success → 200 { generation, revisionId }; GET head reflects it; GET revisions/:id streams bytes with Cache-Control: no-store and application/octet-stream
TR-7 CAS stale → 409 TREE_HEAD_CONFLICT with current pointer; GET revisions/:orphaned → 404
TR-8 idempotent replay returns the original 200 body; replay with mismatched body → 409 TREE_IDEMPOTENCY_MISMATCH
TR-9 attachBlobIds: fixture UNREFERENCED V1 and V2 blobs → TREE_MANAGED after success; a TREE_MANAGED id → 409 TREE_BLOB_STATE_CONFLICT and nothing changes
TR-ATTACH-MAX attachBlobIds longer than the configured maximum → 400
TR-10 key-envelope CAS success/stale; response contains no wrapped material echo other than the new cas version
TR-11 GET blobs returns lifecycle per blob and the same envelope fields as GET /api/vault; storageKey never present
TR-12 owner isolation: user B cannot read A's head/revision/blobs (404 not 403), cannot CAS A's head (409 TREE_STATE_CONFLICT because B is FLAT)
NO-LEAK-1 request/response capture over the whole test run: no body, URL, header or audit row contains any of the fixture plaintext names, node IDs or the string 'parent'
AUD-OPAQUE-1 audit rows for tree operations carry only revisionId/purgeId/leaseId as target
PG-API-1..4 (PG file) the TR-6/7/8/9 sequences against PostgreSQL
```
- [ ] **Step 2: RED** → 404s / `ERR_MODULE_NOT_FOUND`.
- [ ] **Step 3: Implement.** Raw ciphertext route uses `express.raw({ type: 'application/octet-stream', limit })` scoped to that route only (the global 16 KiB JSON limit is unchanged).
- [ ] **Step 4: GREEN** → `# tests 15 # pass 15` (memory); PG adds 4.
- [ ] **Step 5: Regression** `node --test --test-concurrency=1 --test-reporter=tap tests/vaultApi.test.js tests/vaultV2Api.test.js tests/vaultTreeConfig.test.js tests/vaultTreeApi.test.js`.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add opaque vault tree head, revision and key-envelope API`

### Task 2.5: Legacy mutation fencing and gate G2

**Files:**
- Modify: `server/routes/api.js` (`POST /vault/blobs`, `DELETE /vault/blobs/:id` gain `requireVaultProtocolState({ allow: ['FLAT'] })`), `server/routes/vaultUploads.js` (router-level fence on `POST /`, `PUT /:uploadId/chunks/:index`, `POST /:uploadId/commit`; `GET /limits`, `GET /:uploadId`, `DELETE /:uploadId` remain open)
- Test: `tests/vaultTreeFence.test.js`

- [ ] **Step 1: Write failing tests**
```
FENCE-1 FLAT owner: every legacy mutation behaves exactly as before (reuse the vaultV2Api happy-path helper) — byte-identical status/body
FENCE-2 owner row set to MIGRATING_TREE_V1 via the store: POST /vault/blobs, DELETE /vault/blobs/:id, POST /vault/uploads, PUT chunk, POST commit → 409 { code:'TREE_MIGRATION_IN_PROGRESS' }; GET /api/vault, GET blob, GET chunk, GET upload status, DELETE upload session → unchanged success
FENCE-3 owner row TREE_V1 → same mutations → 426 { code:'UPGRADE_REQUIRED' }
FENCE-4 flags off (protocolEnabled=false) → legacy routes are NOT fenced only when the owner row is FLAT or absent; a non-FLAT row with flags off still fences (fail closed: disabling the protocol never reopens flat mutation) — 409/426 as above
FENCE-5 an in-flight legacy upload session created in FLAT cannot commit after the state moves to MIGRATING_TREE_V1 (409) and its staging is cancellable
FENCE-6 no inventory row is created/deleted by any fenced request (store row counts before/after equal)
```
- [ ] **Step 2: RED**; **Step 3: Implement** — the middleware reads the owner row once per request (`getTreeState`) and never creates it for legacy routes (absent row = FLAT).
- [ ] **Step 4: GREEN** → `# tests 6 # pass 6`.
- [ ] **Step 5: Phase regression** `node --test --test-concurrency=1 --test-reporter=tap tests/vaultApi.test.js tests/vaultV2Api.test.js tests/vaultTreeConfig.test.js tests/vaultTreeStore.test.js tests/vaultManifestStore.test.js tests/vaultTreeApi.test.js tests/vaultTreeFence.test.js` and the PG trio with a fresh database.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): fence legacy vault mutation by tree protocol state`
- [ ] **Gate G2** — Session Register row `PVH-P2`; reviewer confirms: `git diff origin/main...HEAD -- server/config/vaultTransferLimits.js src/lib/vaultChunkCrypto.js src/lib/vaultCrypto.js` is empty; migration is additive (`grep -E 'ALTER TABLE (vault_meta|vault_blobs|vault_v2_)' 011_vault_tree_v1.sql` returns nothing).

---

## Phase 3 — Protocol migration fence and genesis migration

### Task 3.1: Migration lease, frozen inventory, takeover, narrow abandonment and atomic genesis (server)

**Files:**
- Modify: `server/db/vaultTreeStore.js` (`beginMigration`, `takeoverMigration`, `abandonMigration`, `commitGenesis`), `server/routes/vaultTree.js` (four routes)
- Test: `tests/vaultTreeApi.test.js` (adds `MG-*`), `tests/vaultTreePostgres.test.js` (adds `PG-MG-*`)

- [ ] **Step 1: Write failing tests**
```
MG-1 begin in FLAT → 201 lease {leaseId, epoch 1, expiresAt = now + migrationLeaseMs, frozenInventoryId, blobs}; state row → MIGRATING_TREE_V1 with frozen_inventory_digest = sha256 of sorted 'v:id' list; vault_tree_frozen_inventory rows = exact V1+V2 inventory at that instant
MG-2 begin when not FLAT → 409 TREE_STATE_CONFLICT; begin when genesisMigrationEnabled=false → 503
MG-3 takeover before expiry → 409 TREE_LEASE_HELD; after expiry (fake clock) → 200 new leaseId, epoch 2, same frozenInventoryId and same blobs (fence unchanged)
MG-4 genesis with stale leaseId or stale epoch → 409 TREE_LEASE_STALE; nothing written (revision remains PUBLISHED-unattached, no head, no envelope, state unchanged)
MG-5 genesis with a frozenInventoryId that does not match → 409 TREE_INVENTORY_MISMATCH
MG-6 genesis success: single transaction writes key envelope, head (generation 1), revision HEAD_COMMITTED, every frozen blob → TREE_MANAGED (attached_generation 1), state TREE_V1, head_ever_committed true, lease cleared; response 201
MG-7 genesis idempotent replay (same idempotencyKey) → 201 same body; different key after TREE_V1 → 409 TREE_STATE_CONFLICT
MG-8 abandon: allowed only in MIGRATING_TREE_V1 with head_ever_committed=false, tree_mutation_count=0 and (lease expired or leaseId matches) → FLAT, frozen inventory rows deleted, lease cleared; otherwise 409 TREE_ABANDON_FORBIDDEN
MG-9 abandon after genesis → 409 (TREE_V1 never reverts); direct store call abandonMigration on TREE_V1 → { ok:false }
MG-10 begin after a completed abandon works again with a new frozenInventoryId (fresh fence)
MG-11 tree-aware routes (POST revisions/PUT ciphertext are allowed for the lease holder only; POST head, key-envelope, tree uploads) → 409 TREE_STATE_CONFLICT during MIGRATING_TREE_V1
PG-MG-1 two connections race begin → one 201, one 409
PG-MG-2 two lease holders (old expired, new taken over) race genesis → only the new epoch commits; old → TREE_LEASE_STALE
PG-MG-3 crash simulation: transaction aborted after envelope insert (injected error) → no partial rows (envelope, head, blob state, state all unchanged)
PG-MG-4 blob added to inventory by a legacy route is impossible during MIGRATING (FENCE) — digest verification at genesis therefore compares the frozen set to itself; a blob deleted directly in SQL (operator action) → genesis TREE_INVENTORY_MISMATCH
```
- [ ] **Step 2: RED**; **Step 3: Implement** (`commitGenesis` = one `withTransaction` with `FOR UPDATE` on the state row and on all frozen blob rows).
- [ ] **Step 4: GREEN** → memory `# tests 11`, PG `+4`.
- [ ] **Step 5: Regression** Phase 2 suites + PG trio.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add vault tree migration lease and atomic genesis`

### Task 3.2: Client genesis migration

**Files:**
- Create: `src/lib/vaultTreeMigration.js`, `src/lib/vaultTreeApi.js` (migration + head/revision/blob functions; remaining functions filled in Tasks 4.3, 5.3, 8.2)
- Test: `tests/vaultTreeMigration.test.js`, `tests/vaultTreeApiClient.test.js` (`TC-*`)

- [ ] **Step 1: Write failing tests**
```
TC-1 every vaultTreeApi function serializes only the documented opaque fields (snapshot of request bodies); passes `signal`; maps { code } errors to TreeApiError
PM-1 planMigration decrypts each V1 (decryptBlobMeta) and V2 (decryptVaultV2Meta) envelope with the KEK and builds one root-level file entry per blob with {name, mediaType, plainSize, blobRef}
PM-2 an envelope that fails to authenticate → MigrationError('ENVELOPE_UNDECRYPTABLE') with the opaque blob id; no plan is produced (never a partial tree)
PM-3 collisions: two entries with equal collisionKey → plan.collisions lists the group; runGenesis refuses until resolveCollisions provided a distinct explicit name for all but one member; the resolver never auto-renames (no '(1)' suffix generator exists — source scan)
PM-4 bounds: entry count > limits.maxNodes or name bytes > limit → MigrationError('BOUNDS') before any network call
PM-5 runGenesis sequence (fetch mock records order): beginMigration → planMigration(frozen blobs from the lease response, not from a fresh GET /api/vault) → generateTrkBytes → wrapTrkSlots → createGenesisManifest + attach all entries → encryptManifestRevision(generation 1, baseRevisionId null) → publishRevision → putRevisionCiphertext → commitGenesis {leaseId, epoch, frozenInventoryId, keyEnvelope, revision, idempotencyKey}
PM-6 resume: state MIGRATING with our lease → skip beginMigration; state MIGRATING with expired lease → takeoverMigration; lease held by another → MigrationError('LEASE_STALE') with retry-after
PM-7 commitGenesis 409 TREE_LEASE_STALE → error surfaced; no retry loop; candidate ciphertext discarded
PM-8 abort signal during decrypt → stops; no publish call; unlockedState.purge invalidates the run (isPurged → runGenesis rejects ABORTED)
PM-9 ciphertext unchanged: the migration never calls any upload/encrypt function for file content (spy on encryptVaultChunk/uploadVaultFileChunked = 0 calls) and never calls DELETE
PM-10 the genesis manifest, decrypted back with the TRK, contains exactly the frozen blob set as root children with the decrypted names; the server-bound bytes contain none of those names (NO-LEAK-2)
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 11 # pass 11`.
- [ ] **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add client genesis migration for private vault trees`

### Task 3.3: Migration UI and gate G3

**Files:**
- Create: `src/components/vault/VaultMigrationDialog.jsx`
- Modify: `src/screens/Vault.jsx` (render the dialog when `protocolState !== 'FLAT'` or when the owner starts migration; behind `genesisMigrationEnabled`), `src/lib/strings.js`
- Test: `tests/vaultTreeMigrationUi.test.js`, `tests/fixtures/vaultTreeBackend.js` (in-memory tree backend used by all screen tests from here on)

- [ ] **Step 1: Write failing tests**
```
MU-1 FLAT + flag on + unlocked → "Upgrade to folders" entry point visible; flag off → absent
MU-2 flow renders explain → lease acquired → decrypt progress (count only, no names in progress text) → collision list with per-entry rename inputs → commit → done; each state has distinct testids
MU-3 collision list shows the colliding display names only while unlocked; Lock during the flow → dialog closes, no names in DOM, backend received no genesis
MU-4 MIGRATING_TREE_V1 on load (another device holds the lease) → truthful "migration in progress on another device" state with expiry time; expired → "Resume migration" button calls takeover
MU-5 genesis failure (TREE_LEASE_STALE) → truthful error state; retry re-runs from state fetch
MU-6 after success the screen transitions to the tree screen placeholder state ('TREE_V1' detected) — full tree screen arrives in Phase 6; until then the dialog shows a "folders UI not enabled" truthful state when treeUiEnabled=false
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 6 # pass 6`.
- [ ] **Step 5: Regression** `node --test --test-concurrency=1 --test-reporter=tap tests/vaultV2ScreenUi.test.js tests/vaultTileActions.test.js tests/vaultAutoLockTimer.test.js tests/vaultAutoLockDuration.test.js tests/vaultStateSync.test.js tests/vaultTreeMigrationUi.test.js`.
- [ ] **Step 6:** build check `npm run build` then restore `dist/` per Global Constraints; `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add private vault genesis migration dialog`
- [ ] **Gate G3** — Session Register row `PVH-P3`; evidence includes a disposable-DB run of the full migration (`PG-MG-*`) and the `PM-9`/`PM-10` ciphertext-unchanged proof.

---

## Phase 4 — Tree-aware encrypted blob upload and orphan lifecycle

### Task 4.1: Tree-aware upload route family from a shared handler factory

**Files:**
- Modify: `server/routes/vaultUploads.js` — extract `createVaultUploadHandlers({ mode })` (`'legacy'` | `'tree'`); the legacy router is built from `mode: 'legacy'` and is behaviourally identical
- Create: `server/routes/vaultTreeUploads.js` (`mode: 'tree'`: gated by `requireVaultProtocolState({ allow: ['TREE_V1'] })`; on commit inserts `vault_tree_blob_state = UNREFERENCED` in the same transaction as `finishVaultV2Commit`)
- Modify: `server/routes/api.js` (mount `/vault/tree/uploads` before `/vault/uploads`)
- Test: `tests/vaultTreeUploadsApi.test.js`

- [ ] **Step 1: Write failing tests**
```
TU-1 outside TREE_V1 (FLAT, MIGRATING) every tree upload mutation → 409 TREE_STATE_CONFLICT; GET limits allowed
TU-2 in TREE_V1: create → chunks → commit flow succeeds with identical request/response shapes to the legacy family (diff of recorded exchanges against the legacy suite fixtures = only the route prefix and the added `lifecycle: 'UNREFERENCED'` field)
TU-3 commit inserts blob state UNREFERENCED atomically with the V2 blob row (injected failure after blob insert → no blob row, no state row)
TU-4 legacy family behaviour unchanged: tests/vaultV2Api.test.js passes byte-for-byte (its recorded exchange fixtures are unchanged) — asserted by running that suite in this task's regression
TU-5 transfer constants unchanged: snapshot test of VAULT_TRANSFER_LIMITS, MIN/MAX/DEFAULT_UPLOAD_CONCURRENCY, CHUNK_ATTEMPTS-equivalent behaviour (retry count observed via a failing chunk mock) equals the frozen snapshot committed in this test
TU-6 no name/parent/node/path field is accepted: a body with extra keys {name, parentId, nodeId, path} → 400 unknown field on create and commit (strict body schema); NO-LEAK-3 capture across the suite
TU-7 cancel (DELETE) of a tree staging session leaves no blob state row; commit-recovery (`recoverStaleVaultCommits`) for a tree-mode session still yields UNREFERENCED (recovery records the mode)
TU-8 owner isolation for tree sessions and blobs
```
- [ ] **Step 2: RED**; **Step 3: Implement** (the extraction is a pure move; `git diff` of `vaultUploads.js` should show handlers wrapped in the factory and no logic edits).
- [ ] **Step 4: GREEN** → `# tests 8 # pass 8`.
- [ ] **Step 5: Regression** `node --test --test-concurrency=1 --test-reporter=tap tests/vaultV2Api.test.js tests/vaultChunkedUploadClient.test.js tests/vaultTreeUploadsApi.test.js tests/vaultTreeFence.test.js` + PG `tests/vaultV2Postgres.test.js`.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add tree-aware private vault upload endpoint family`

### Task 4.2: Attach promotion, orphan inventory and orphan revision GC hooks

**Files:**
- Modify: `server/db/vaultTreeStore.js` (`listOrphanRevisions`, `retireRevision`, orphan blob reporting fields), `server/routes/vaultTree.js` (`GET /blobs` lifecycle filter `?lifecycle=UNREFERENCED`)
- Test: `tests/vaultTreeApi.test.js` (`OR-*`), `tests/vaultTreePostgres.test.js` (`PG-OR-*`)

- [ ] **Step 1: Write failing tests**
```
OR-1 blob committed via tree upload appears in GET /blobs with lifecycle UNREFERENCED; after head CAS with attachBlobIds → TREE_MANAGED with attached_generation = new generation
OR-2 CAS loses (stale) with attachBlobIds → blob stays UNREFERENCED; a later CAS from the rebased head attaches the same id successfully
OR-3 UNREFERENCED blobs are never deleted by any maintenance function in this PR (runVaultTreeMaintenance over an old UNREFERENCED blob → count 0; the retention value only annotates `orphanSince` in GET /blobs)
OR-4 listOrphanRevisions returns ORPHANED revisions older than retention; retireRevision → storage deleted + row deleted (allowed by the immutability trigger only for ORPHANED)
PG-OR-1 concurrent attach + purge-pending transition on the same blob → serialized, one wins
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 4` + PG `1`.
- [ ] **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): promote tree-aware blobs through manifest CAS`

### Task 4.3: Client tree-aware upload, attach and orphan recovery; gate G4

**Files:**
- Create: `src/lib/vaultTreeUpload.js`
- Modify: `src/lib/vaultChunkedUpload.js` (`routeBase` option only), `src/lib/vaultTreeApi.js` (`listTreeBlobs` filter)
- Test: `tests/vaultTreeUploadClient.test.js`

Depends on `vaultTreeSync.createTreeSession` (Task 5.3). To keep phases coherent, this task implements `uploadTreeFile` against the `session.commit(intent)` **interface** defined in the file map and tests it with a stub session; Task 5.3 provides the real implementation and Task 5.5 re-runs this suite unchanged.

- [ ] **Step 1: Write failing tests**
```
TU-SAME-1 vaultChunkedUpload exported constants and planVaultChunks(…) output for 5 sizes equal a frozen snapshot; the default routeBase is '/api/vault/uploads'
TUC-1 uploadTreeFile runs uploadVaultFileChunked with routeBase '/api/vault/tree/uploads' and the unchanged encryption path (spy: same calls as the legacy client test for the same file), then calls session.commit(attachBlob intent with {parentNodeId, name, mediaType, plainSize, blobRef})
TUC-2 commit conflict without auto-rebase → returns { orphan: blobRef, conflict } and does not delete or re-upload
TUC-3 listOrphanBlobs decrypts envelopes of UNREFERENCED blobs not referenced in the manifest index and returns entries with decrypted names for display; recoverOrphan → session.commit(attachBlob) with the chosen folder and name
TUC-4 no request in the whole suite contains the file name, parentNodeId or any nodeId (NO-LEAK-4)
TUC-5 unlockedState.purge during upload → abort propagates (existing transferAbort path) and no commit is attempted
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 6 # pass 6`.
- [ ] **Step 5: Regression** `tests/vaultChunkedUploadClient.test.js`, `tests/vaultChunkedDownloadClient.test.js`.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add client tree-aware upload attach and orphan recovery`
- [ ] **Gate G4** — Session Register row `PVH-P4`; reviewer confirms `TU-5`/`TU-SAME-1` snapshots and that `git diff origin/main...HEAD -- server/config/vaultTransferLimits.js` is empty.

---

## Phase 5 — Client manifest state and hierarchy commands

### Task 5.1: Semantic intents and selection normalization

**Files:**
- Create: `src/lib/vaultTreeOps.js`
- Test: `tests/vaultTreeOps.test.js`, `tests/vaultTreeOpsProperty.test.js`

- [ ] **Step 1: Write failing tests**
```
OP-1 createFolder under root / under folder; collision with active sibling → COLLISION; under a file → NOT_FOLDER; under effectively trashed folder → EFFECTIVELY_TRASHED; name invalid (empty, only whitespace, > limit bytes, contains U+0000) → NAME_INVALID; over maxNodes → LIMIT_NODES; over maxDepth → LIMIT_DEPTH
OP-2 rename: only name + modifiedAtClient change; nodeId/blob fields identical; root → ROOT_IMMUTABLE; collision → COLLISION; same collisionKey different display (case-only rename of itself) allowed
OP-3 move: single and bulk; into self → CYCLE; into descendant → CYCLE; destination missing → NOT_FOUND; destination file → NOT_FOLDER; destination effectively trashed → EFFECTIVELY_TRASHED; collision in destination → COLLISION (whole intent rejected, nothing applied)
OP-4 normalizeSelectionRoots drops descendants of selected ancestors; mixed active/trashed selection → AMBIGUOUS_SELECTION
OP-5 trash: sets state, trashedAtClient, trashedFromParentNodeId on the subtree root only; descendants untouched (O(1) edit proven by changedNodeIds length = 1 per root)
OP-6 restore: to original parent when it exists, is active and has no collision; else requires destinationNodeId; collision at destination → COLLISION; restore re-runs cycle validation
OP-7 attachBlob creates a file node with blobRef; duplicate blobRef in the manifest → BLOB_ALREADY_REFERENCED
OP-8 purgeIntent: computes the complete effective subtree of each root, removes those nodes, returns purgeBlobRefs = every file blob in that subtree (including independently trashed descendants); root → ROOT_IMMUTABLE
OP-9 recentOperationIds: each applyIntent appends a random operation id, bounded to limits.maxRecentOperationIds (oldest dropped)
OPP-1 (property) random sequences of 300 intents over random trees: after each applied intent validateManifest passes; after each rejected intent the manifest is deep-equal to before
OPP-2 (property) for random selections, normalizeSelectionRoots output has no pair (a, b) with isDescendant(b, a)
OPP-3 (property) move into self/descendant is rejected for all nodes of 100 random trees
OPP-4 (property) trash then restore of a subtree root restores exactly the nodes that had no own trashed state
```
- [ ] **Step 2: RED**; **Step 3: Implement** (apply on a structured clone; validate; return); **Step 4: GREEN** → `# tests 13 # pass 13`.
- [ ] **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add vault tree semantic operations`

### Task 5.2: Semantic rebase and conflict classification

**Files:**
- Create: `src/lib/vaultTreeRebase.js`
- Test: `tests/vaultTreeRebase.test.js`

- [ ] **Step 1: Write failing tests**
```
RB-1 disjoint change on head (another node renamed) → AUTO with the same intent
RB-2 rename target renamed on head → CONFLICT TARGET_RENAMED; target trashed → TARGET_DELETED (delete-vs-edit)
RB-3 move destination trashed/purged on head → DESTINATION_DELETED / DESTINATION_TRASHED; destination now a descendant of a moved node → CYCLE_AFTER_REBASE
RB-4 createFolder name now collides on head → COLLISION
RB-5 restore original parent trashed on head → RESTORE_COLLISION when destination collides, else AUTO to explicit destination only if the intent carried one
RB-6 attachBlob parent trashed on head → CONFLICT PARENT_CHANGED (blob remains an orphan for recovery)
RB-7 same intent twice (idempotent op id present in head.recentOperationIds) → { kind:'ALREADY_APPLIED' }
RB-8 rebase never mutates inputs
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 8 # pass 8`; **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add bounded semantic rebase for vault tree intents`

### Task 5.3: Mutation protocol session

**Files:**
- Create: `src/lib/vaultTreeSync.js`
- Modify: `src/lib/vaultTreeApi.js` (head CAS, key envelope)
- Test: `tests/vaultTreeSync.test.js`

- [ ] **Step 1: Write failing tests** (fetch mock backend implementing the route plan with an in-memory head)
```
SY-1 loadHead: GET head → GET revision → unwrap Manifest DEK under TRK → decrypt → validate; degraded key envelope status surfaced as session.keyStatus
SY-2 commit(rename): encrypt fresh revision (generation+1, baseRevisionId = head.revisionId) → publish → put ciphertext → CAS; success updates the in-memory head; discards plaintext of the candidate on failure
SY-3 CAS conflict → refetch head → rebase AUTO → retry; retries bounded by limits.maxRebaseAttempts → SyncError('REBASE_EXHAUSTED') (SY-REBASE-BOUND)
SY-4 CAS conflict → rebase CONFLICT → returns { conflict } without retry; the candidate revision is left ORPHANED on the server (no delete call)
SY-5 response loss: CAS request throws after the server applied it → session re-fetches head; if head.revisionId === candidate.revisionId the commit is reported as success; never re-sends the semantic action
SY-6 idempotency key is fresh per attempt and reused only for the exact same candidate replay
SY-7 attachBlobRefs/purgeBlobRefs from applyIntent are forwarded as opaque attachBlobIds/purgeBlobIds; nothing else from the manifest is in the request (NO-LEAK-5)
SY-8 degraded key (one slot bad) → commit rejected with SyncError('KEY_DEGRADED') until repairKeyEnvelope() succeeds (casKeyEnvelope); after repair commits proceed
SY-9 abort/purge: unlockedState.purge() → in-flight fetch aborted, pending rebase invalidated, session.commit rejects ABORTED, session holds no manifest (session.head === null)
SY-10 protocol disabled mid-session (503) → SyncError('PROTOCOL_DISABLED'); head retained for read/export
SY-11 stale-after-lock: a session created before lock cannot commit after purge even if its promise chain continues (token invalidation)
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 11 # pass 11`; **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add vault tree mutation protocol session`

### Task 5.4: Unlocked-state registry and `purgeUnlockedVaultState(reason)`

**Files:**
- Create: `src/lib/vaultUnlockedState.js`
- Modify: `src/lib/vaultPreviewSession.js` (optional `unlockedState` registration), `src/screens/Vault.jsx` (`lock()` calls `unlockedState.purge(auto ? AUTO_LOCK : MANUAL_LOCK)` first; unmount effect purges with `UNMOUNT`; `pagehide` best-effort with `PAGE_HIDE`), `src/lib/auth.js` (verify at implementation the existing logout/session-end path; add a minimal `onSessionEnded(listener)` if none exists and call it from logout and from the `401`/`PASSWORD_RESET_REQUIRED` handling in `src/lib/api.js`)
- Test: `tests/vaultUnlockedState.test.js`, existing `tests/vaultAutoLockTimer.test.js`, `tests/vaultAutoLockDuration.test.js`, `tests/vaultPreviewCancellation.test.js` stay green

- [ ] **Step 1: Write failing tests**
```
US-1 purge(reason) performs, in order: abort controllers → invalidateMutations → disposers (manifest/name/breadcrumb/selection state droppers) → revoke Object URLs → close preview tokens (closeAllPreviewSessions called once) → drop key refs → drop buffers; returns PurgeReport with counts
US-2 idempotent: second purge returns alreadyPurged=true and performs nothing; registrations after purge are rejected (throw) so no plaintext can be re-attached to a dead state
US-3 every PURGE_REASONS value is accepted; unknown reason throws
US-4 registered buffer refs are zero-filled (Uint8Array.fill(0)) best-effort and dereferenced; the report does not claim physical memory erasure (report field name is `droppedBuffers`, and the module header states the limitation)
US-5 Vault.jsx: manual Lock, auto-lock, unmount each call purge exactly once with the matching reason (spy through the screen harness); logout via auth session-end listener calls purge(LOGOUT); a 401 on any Vault fetch calls purge(SESSION_INVALIDATED)
US-6 after purge no DOM node contains any decrypted name and the locked veil renders (`{id}.aegisenc`)
US-7 storage-absence during and after purge: instrumented localStorage/sessionStorage/indexedDB/caches record zero writes across the whole screen suite
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 7 # pass 7`.
- [ ] **Step 5: Regression** all existing `tests/vault*.test.js` screen/lifecycle suites.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add idempotent purgeUnlockedVaultState lifecycle boundary`

### Task 5.5: Tree view reducer and gate G5

**Files:**
- Create: `src/lib/useVaultTree.js`
- Test: `tests/vaultTreeReducer.test.js`; re-run `tests/vaultTreeUploadClient.test.js` against the real session

- [ ] **Step 1: Write failing tests**
```
VR-1 initial state: current = rootNodeId, view 'active', selection empty
VR-2 open(folder) pushes; up() pops; open(file) is ignored; open(effectively trashed) rejected
VR-3 select with additive (Ctrl/Cmd) toggles; without additive replaces; clear()
VR-4 head refresh removes selected/current nodes → selection reconciled (dropped ids), current falls back to nearest existing ancestor or root; breadcrumbs recomputed
VR-5 capabilities(selection): active single file → preview?, download, rename, move, details, trash; single folder → open, rename, move, details, trash; multi → move, trash, download (files only, sequential) and never rename; trash view → restore, permanentDelete; degraded key → all mutations disabled with reason KEY_DEGRADED
VR-6 run(intent) → session.commit; conflict → state.conflict set; resolveConflict('retry'|'discard'|'chooseDestination')
VR-7 drag state: dragging a selected node drags the normalized selected set; dropping on self/descendant/file is rejected with an announcement and no commit call
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 7 # pass 7`.
- [ ] **Step 5: Phase regression** `node --test --test-concurrency=1 --test-reporter=tap tests/vaultTreeOps.test.js tests/vaultTreeOpsProperty.test.js tests/vaultTreeRebase.test.js tests/vaultTreeSync.test.js tests/vaultUnlockedState.test.js tests/vaultTreeReducer.test.js tests/vaultTreeUploadClient.test.js tests/vaultTreeMigration.test.js` + all existing `tests/vault*.test.js`.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add vault tree view state reducer`
- [ ] **Gate G5** — Session Register row `PVH-P5`.

---

## Phase 6 — Vault UI file-management parity

UI work follows the repository UI skill workflow (`.agents/skills/impeccable/SKILL.md`, `DESIGN.md`, `PRODUCT.md`) and reuses existing `ui.jsx` primitives (`Btn`, `Modal`, `AnchoredMenu`, `Card`, `Chip`) and Files-page interaction language. No Higgsfield generation is authorized by this plan.

### Task 6.1: Tiles, breadcrumbs and menus

**Files:**
- Create: `src/components/vault/VaultBreadcrumbs.jsx`, `src/components/vault/VaultFolderTile.jsx`, `src/components/vault/VaultFileTile.jsx`, `src/components/vault/VaultTileMenu.jsx`
- Modify: `src/lib/strings.js`
- Test: `tests/vaultTreeUi.test.js`

- [ ] **Step 1: Write failing tests**
```
UI-1 folder tile and file tile have distinct roles/testids and icons; folder shows child count from the index (active view) and no size; file shows size/type from manifest node (not from envelope)
UI-2 locked: both tiles render only `${id}.aegisenc` + ciphertext size (folders do not exist while locked because there is no manifest) — the locked list is the opaque inventory
UI-3 breadcrumbs render root → … → current from breadcrumbsFor; clicking a crumb calls onNavigate(nodeId); keyboard Enter/Space work; current crumb has aria-current="page"
UI-4 Ctrl/Cmd-click on a tile calls onSelect(nodeId, { additive:true }); plain click on the checkbox toggles; plain click on the body opens (folder) / previews (file) like Files
UI-5 menu items exactly per contract for file/folder/trash view; Preview absent when previewKindFor(mediaType) is null; disabled items carry the reason (KEY_DEGRADED)
UI-6 no Secure Share / File History / Verify / Public Share / Protected Trash items exist in any Vault menu (assert absence of those labels)
STR-1 every t() key used by the new components exists in en and th
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 7 # pass 7`; **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add private vault folder and file tiles with breadcrumbs`

### Task 6.2: Dialogs — New Folder, Rename, Move, Details, Trash, Restore, Conflict

**Files:**
- Create: `src/components/vault/VaultDialogs.jsx`
- Test: `tests/vaultTreeDialogs.test.js`

- [ ] **Step 1: Write failing tests**
```
DG-1 New Folder validates locally (empty, collision) before enabling submit; submit emits createFolder intent
DG-2 Rename pre-fills the current display name; same name → no intent; collision → inline error, no intent
DG-3 Move dialog folder picker lists active folders only, excludes the moving nodes and their descendants, marks the current parent; submit emits move intent with normalized roots
DG-4 Details shows name, type, plain size, created/modified (client timestamps), blob format version, ciphertext size; no storage key, no node id
DG-5 Trash confirm shows count of top-level selected roots and states that contents move with folders; emits trash intent
DG-6 Restore: original parent available → one-click; otherwise destination chooser (root default); collision → chooser forced
DG-7 Conflict dialog renders the rebase reason copy and offers retry/discard/choose-destination per reason; never offers "overwrite"
DG-8 Permanent Delete dialog exists but is rendered only in the trash view of Task 8.2 (this task asserts the export and its typed-acknowledgement requirement)
DG-9 all dialogs close and drop their local state when unlockedState.purge fires (disposer registered)
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 9 # pass 9`; **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add private vault hierarchy dialogs`

### Task 6.3: Tree screen — navigation, selection, bulk actions, internal drag/drop

**Files:**
- Create: `src/screens/VaultTreeScreen.jsx`
- Modify: `src/screens/Vault.jsx` (route to `VaultTreeScreen` when `treeUiEnabled && protocolState === 'TREE_V1'`; legacy screen for `FLAT`), `src/lib/strings.js`
- Test: `tests/vaultTreeScreen.test.js`

- [ ] **Step 1: Write failing tests**
```
TS-1 unlock in TREE_V1 → loadHead → root children rendered; folder open → children + breadcrumbs update; browser back is not used (in-memory navigation only)
TS-2 New Folder → one CAS request; tile appears; server request bodies contain no name (NO-LEAK-6)
TS-3 Rename / Move via dialog → one CAS each; Move via internal drag/drop of a multi-selection onto a folder → the same run(move) path (spy asserts one code path) and exactly one CAS
TS-4 invalid drop (onto self/descendant/file) → aria-live announcement, zero CAS
TS-5 external OS file drop → upload path (uploadTreeFile), never move
TS-6 bulk: select 3 → Move → one CAS; select mixed folder+its child → normalized (child not double-applied); Trash bulk → one CAS
TS-7 Trash view toggle lists trashed subtree roots; descendants hidden from active view; Restore → back in place
TS-8 conflict: backend returns 409 with a head that trashed the rename target → conflict dialog; discard → no further CAS
TS-9 head refresh (another device) removes the current folder → navigation falls back to root, selection cleared, toast/announcement shown
TS-10 lock (manual/auto) while dialogs open → purge; DOM contains no names; locked veil shows opaque inventory
TS-11 treeUiEnabled=false in TREE_V1 → read/export-only list: decrypted names + Download + Details, no mutation controls (rollback surface for Task 9.3)
TS-12 legacy FLAT screen suites unchanged (vaultV2ScreenUi/vaultTileActions counts identical)
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 12 # pass 12`.
- [ ] **Step 5: Regression** all `tests/vault*.test.js` (screen + lifecycle) and `npm run build` with `dist/` restore.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add private vault hierarchy screen with selection and drag/drop`

### Task 6.4: Details/Download, sequential bulk download, recovery panel; gate G6

**Files:**
- Create: `src/components/vault/VaultRecoveryPanel.jsx`
- Modify: `src/screens/VaultTreeScreen.jsx` (download uses the manifest node name/type; V1 whole-file and V2 chunked download paths unchanged; sequential multi-file download bounded to one at a time)
- Test: `tests/vaultTreeRecoveryUi.test.js`, `tests/vaultTreeScreen.test.js` (`TS-13..15`)

- [ ] **Step 1: Write failing tests**
```
TS-13 Download of a renamed file uses the manifest name and type; envelope metadata still authenticated (decrypt of meta still called) but not used for the filename
TS-14 bulk download of 3 files runs sequentially (one active at a time), skips folders, and stops on lock
TS-15 Details shows manifest fields; opaque id shown only in the locked-state details (existing behaviour)
RP-1 degraded key: panel shows "one key slot corrupt" state with Repair action → casKeyEnvelope; success re-enables mutations
RP-2 both slots bad → fail-closed unlock error copy; no tree rendered; no mutation controls
RP-3 orphan blobs (UNREFERENCED) → "Recover to Vault" list with decrypted names; choose folder → attach intent; success removes it from the list
RP-4 unrecoverable state copy never claims "zero metadata"; the security note text includes the traffic-analysis acknowledgement string (asserted literal)
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 7 # pass 7`.
- [ ] **Step 5: Phase regression** (all vault suites + build/restore).
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add private vault key recovery and orphan recovery panel`
- [ ] **Gate G6** — Session Register row `PVH-P6`; owner walkthrough on a local dev build (`npm run dev` + in-memory store) recorded in the PR: folders, breadcrumbs, rename, move, drag/drop, trash/restore, lock cleanup. No Production.

---

## Phase 7 — Client-only media previews

All work is behind `VAULT_MEDIA_PREVIEW_ENABLED`. The existing full-file Preview modal (`vaultPreview.js`, `openPreviewSession`) stays as is for the FLAT screen and for the tree screen when the flag is off.

### Task 7.1: Bounded thumbnail scheduler and storage-absence harness

**Files:**
- Create: `src/lib/vaultThumbScheduler.js`, `tests/helpers/vaultTreeFixtures.mjs` (instrumented storage globals + synthetic media bytes)
- Test: `tests/vaultThumbScheduler.test.js`, `tests/vaultStorageAbsence.test.js`

- [ ] **Step 1: Write failing tests**
```
TS-LIMIT-JOBS at most limits.maxConcurrentJobs decode jobs run; others queue; scroll-out cancels queued and aborts running (AbortSignal)
TS-LIMIT-URLS retained Object URLs never exceed limits.maxRetainedObjectUrls; LRU release revokes URLs (spy on URL.revokeObjectURL)
TS-LIMIT-MEM estimated memory (sum of decoded pixel bytes + input bytes of live jobs) never exceeds limits.memoryCeilingBytes; over-budget entries wait
TSC-1 visibility loss (document.hidden) → all running jobs aborted, queue paused; resume on visible
TSC-2 releaseAll on unlockedState.purge revokes every URL and aborts every job; stats() shows zeros
TSC-3 integrity failure in decode → entry marked failed, no retry storm (one retry max), URL not created
TSC-4 selection change / navigation → entries outside the current folder released
SA-1 instrumented localStorage/sessionStorage/indexedDB/caches: zero writes during a full scheduler run with 50 entries
SA-SW-1 source scan of src/vaultPreviewServiceWorker.js and src/lib/vaultPreview*.js: no `caches.`, `indexedDB`, `localStorage`, `sessionStorage`
SA-2 every Response constructed for preview carries Cache-Control: no-store (existing behaviour re-asserted)
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 10 # pass 10`; **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add bounded client-only vault thumbnail scheduler`

### Task 7.2: Image thumbnails

**Files:**
- Create: `src/lib/vaultImageThumb.js`
- Test: `tests/vaultImageThumb.test.js`

- [ ] **Step 1: Write failing tests** (jsdom lacks `createImageBitmap`; inject `decode` and header-parsing fixtures; dimension parsing is tested on real PNG/JPEG/WebP/GIF headers from the fixtures helper)
```
IT-1 header dimension parsing for PNG/JPEG/WebP/GIF; unknown → unsupported
IT-LIMIT-BYTES entry.plainSize > limits.imageMaxInputBytes → { unsupported:'IMAGE_TOO_LARGE' } with zero fetches
IT-LIMIT-PIXELS width*height > limits.imageMaxDecodedPixels → unsupported before decode (header read from the first decrypted chunk only for V2; V1 requires whole-file decrypt and is allowed only under the input-bytes limit)
IT-2 V2: decrypts chunks sequentially through decryptVaultChunk with the existing AAD; abort mid-way → no URL
IT-3 poster scaled to limits.posterMaxEdge; Object URL registered in unlockedState; returned bytes ≤ limit
IT-4 tamper (flipped chunk byte) → decrypt throws → unsupported:'INTEGRITY'
IT-5 no plaintext persists: after release, the returned URL is revoked and no reference to the decoded buffer remains in the module (WeakRef probe in test)
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 7 # pass 7`; **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add client-only private vault image thumbnails`

### Task 7.3: GIF poster and bounded hover/touch playback

**Files:**
- Create: `src/lib/vaultGifPreview.js`
- Modify: `src/components/vault/VaultFileTile.jsx` (poster slot + hover/touch handlers reusing the Files-page `MEDIA_HOLD_MS`-style press semantics, implemented locally without importing `Files.jsx`)
- Test: `tests/vaultGifPreview.test.js`, `tests/vaultTreeUi.test.js` (`UI-7..9`)

- [ ] **Step 1: Write failing tests**
```
GF-1 static poster = first frame decode within limits.gifPosterDecodeBudget (injected decoder); over budget → poster unsupported, tile shows icon + truthful "preview unavailable" reason
GF-LIMIT-PLAY plainSize > limits.gifMaxFullPlayBytes → openGifMotion → unsupported:'GIF_TOO_LARGE'; the tile shows poster + "download to view animation"; no whole-file buffering happens (fetch spy = 0)
GF-2 under limit: hover (pointerenter after hold) / touch press → decrypt whole GIF → Object URL → <img> swap; leave/release → URL revoked within one tick
GF-3 memory ceiling reached in scheduler → motion refused with MEMORY_CEILING even under the byte limit
GF-4 lock during playback → URL revoked, img src cleared
UI-7 tile shows poster when ready, icon when unsupported, and a reason tooltip; reduced-motion preference disables hover motion
UI-8 hover motion is muted/no-audio by construction (GIF) and never autoplays without hover/touch
UI-9 flag off → no scheduler observe calls, tiles render icons only
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 8 # pass 8`; **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add bounded client-only GIF poster and hover playback`

### Task 7.4: Video poster, hover motion and fast Preview through the range-decryption session; gate G7

**Files:**
- Create: `src/lib/vaultVideoPreview.js`
- Modify: `src/components/vault/VaultFileTile.jsx`, `src/screens/VaultTreeScreen.jsx` (Preview modal uses the session URL for V2 video with seek)
- Test: `tests/vaultVideoPreview.test.js`, `tests/vaultTreeScreen.test.js` (`TS-16..18`)

- [ ] **Step 1: Write failing tests**
```
VP-1 videoPreviewCapability: V2 + supported container + supportsLargeVideoPreview → RANGE_V2; V1 → V1_DOWNLOAD_ONLY (bounded fallback: full-file preview only if under the existing V1 ceiling and the image/GIF-style byte limit, else download-only); unsupported MIME → UNSUPPORTED
VP-2 openVideoPoster opens one preview session (openPreviewSession spy = 1), sets a muted <video preload="metadata"> to the virtual URL, seeks to the first keyframe time, draws one frame to canvas → poster URL; session closed after poster; plaintext chunk cache in the worker respects the existing MAX_PREVIEW_PLAINTEXT_CACHE_BYTES (no new limits)
VP-3 hover motion: muted playback through a session; leave → closePreviewSession + element removed
VP-4 full Preview: seeking to 3 random positions issues Range requests that map to exactly the needed chunks (planChunkReads spy) — one-chunk-bounded plaintext streaming re-asserted through the existing vaultPreviewResponder tests' helper
VP-5 integrity failure from the worker (PREVIEW_FAILURE) → truthful error state, session closed
VP-6 lock/unmount/navigation → all sessions closed (closeAllPreviewSessions), poster URLs revoked
TS-16 tile poster + hover for V2 video; TS-17 V1 video shows truthful download-only state; TS-18 flag off → no session opened by tiles (modal Preview still works as before)
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 9 # pass 9`.
- [ ] **Step 5: Phase regression** all `tests/vaultPreview*.test.js`, `tests/vaultMediaPreview.test.js`, Phase 6/7 suites, build/restore.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add client-only vault video poster and range preview`
- [ ] **Gate G7** — Session Register row `PVH-P7`; evidence: a manual browser run with a large synthetic V2 video (sparse fixture, as in PR150 Task 16 method) recording peak worker cache bytes ≤ `MAX_PREVIEW_PLAINTEXT_CACHE_BYTES` and DevTools Application → Cache Storage/IndexedDB/Local Storage empty for the app origin.

---

## Phase 8 — Trash/Restore completion and purge barrier (destructive purge feature-flagged OFF)

Logical Trash/Restore semantics shipped in Phase 5/6. Phase 8 adds the monotonic purge barrier, non-recoverability, retention and the flag-gated physical purge.

### Task 8.1: Purge barrier in head CAS, revision retirement, recovery rejection (server)

**Files:**
- Modify: `server/db/vaultTreeStore.js` (`casHead` with `purgeBlobRefs`: barrier = `max(existing, G)`, candidates inserted `RETENTION_WAIT` with `confirmable_at = now + purgeRetentionMs`, pre-G revisions → `NON_RECOVERABLE`; blob states → `PURGE_PENDING`), `server/routes/vaultTree.js` (`purge/confirm`; `GET revisions/:id` → `410` below barrier)
- Test: `tests/vaultTreePurge.test.js`, `tests/vaultTreePostgres.test.js` (`PG-PU-*`)

- [ ] **Step 1: Write failing tests**
```
PU-1 CAS with purgeBlobIds at generation G → response purgeBarrierGeneration = G, purgeId returned; candidates RETENTION_WAIT; blob states PURGE_PENDING; every revision with generation < G → NON_RECOVERABLE (ciphertext file still present)
PU-2 barrier monotonic: a later CAS with a smaller purge set never lowers it; repeated purge CAS → max(existing, G)
PU-3 GET revisions/:id for generation < barrier → 410 TREE_REVISION_NON_RECOVERABLE even while ciphertext exists; head and newer → 200
PU-4 purge/confirm before confirmable_at → 425 TREE_PURGE_RETENTION_PENDING
PU-5 purge/confirm with stale expectedGeneration/expectedRevisionId → 409 TREE_HEAD_CONFLICT; wrong barrierGeneration → 409 TREE_PURGE_BARRIER_MISMATCH; blobIds not equal to the candidate set (missing/extra) → 409 TREE_PURGE_SET_MISMATCH; other owner → 404
PU-6 flag destructivePurgeEnabled=false after retention → 423 DESTRUCTIVE_PURGE_DISABLED; candidates → CONFIRMABLE (not PURGED); nothing deleted (storage spy = 0)
PU-7 flag on (test env only) → physical deletion of V1 row+file and V2 rows+chunks via the existing delete functions; blob state PURGED; candidates PURGED; response lists purged ids; idempotent replay (same idempotency key) → 200 same body with zero additional deletes; replay with new key after PURGED → 200 { purged: [], alreadyPurged: [...] }
PU-8 attach of a PURGE_PENDING or PURGED blob → 409 TREE_BLOB_STATE_CONFLICT
PU-9 interrupted purge (injected failure after the first blob) → partial PURGED rows are consistent (each blob deletion is its own committed step), a retry completes the rest idempotently
PU-SET-MAX blobIds > configured maximum → 400
PG-PU-1 two clients race purge CAS at the same generation → one wins; barrier equals the winner's generation
PG-PU-2 purge confirm raced with a concurrent head CAS → confirm fails TREE_HEAD_CONFLICT, nothing deleted
PG-PU-3 immutability trigger permits HEAD_COMMITTED/SUPERSEDED → NON_RECOVERABLE and NON_RECOVERABLE → FORENSIC_DELETED only
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 10` + PG `3`.
- [ ] **Step 5: Regression** Phase 2–4 server suites + PG trio.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add monotonic vault tree purge barrier`

### Task 8.2: Client permanent-delete protocol and truthful pending state

**Files:**
- Modify: `src/lib/vaultTreeApi.js` (`confirmPurge`), `src/lib/vaultTreeSync.js` (`commit(purgeIntent)` forwards `purgeBlobIds`; `confirmPurge` requires a **fresh unlock token** — the session records `unlockedAt`; confirm is allowed only when the KEK was derived in this unlock and the head was fetched after the purge CAS), `src/components/vault/VaultDialogs.jsx` (Permanent Delete: typed acknowledgement, count of effective subtree files, "cannot be recovered even before bytes are deleted" copy), `src/screens/VaultTreeScreen.jsx` (trash view: Permanent Delete → purge CAS; pending candidates panel shows RETENTION_WAIT countdown / CONFIRMABLE with Confirm / DISABLED truthful copy)
- Test: `tests/vaultTreeScreen.test.js` (`TS-19..23`), `tests/vaultTreeSync.test.js` (`SY-12..14`)

- [ ] **Step 1: Write failing tests**
```
SY-12 commit(purgeIntent) sends purgeBlobIds = exact effective-subtree blob set; response barrier stored; the manifest no longer references those nodes
SY-13 confirmPurge sends { purgeId, expectedGeneration, expectedRevisionId, barrierGeneration, blobIds, idempotencyKey } after a fresh head fetch; head changed since → SyncError('STALE_HEAD') without sending
SY-14 confirmPurge refused when the session's unlock is older than the purge CAS (must re-unlock) — 'FRESH_UNLOCK_REQUIRED'
TS-19 Permanent Delete dialog requires typed acknowledgement; cancel → zero requests
TS-20 confirm → one CAS with purgeBlobIds; trash view no longer lists the subtree; pending panel shows RETENTION_WAIT with confirmable time
TS-21 after retention (fake clock) → Confirm button → 423 DESTRUCTIVE_PURGE_DISABLED → panel shows "physical purge pending operator enablement"; candidates still listed; no synthetic success
TS-22 flag on (test backend) → Confirm → purged list; panel empty
TS-23 lock between purge CAS and confirm → after re-unlock the panel is rebuilt from the server state (no client memory of the pending purge survived)
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 8 # pass 8`; **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `feat(idea1): add private vault permanent delete with purge barrier confirmation`

### Task 8.3: Maintenance — orphan revision GC, forensic retention expiry, purge executor; gate G8

**Files:**
- Create: `server/storage/vaultTreeMaintenance.js`
- Modify: `server/index.js` (replace the no-op timer from Task 2.1)
- Test: `tests/vaultTreeMaintenance.test.js`, `tests/vaultTreePostgres.test.js` (`PG-MT-*`)

- [ ] **Step 1: Write failing tests**
```
MT-ORPHAN-REV-1 ORPHANED revisions older than orphanRevisionRetentionMs → ciphertext deleted, row deleted; newer kept; HEAD_COMMITTED/SUPERSEDED never touched
MT-FORENSIC-1 NON_RECOVERABLE revisions older than forensicRevisionRetentionMs → ciphertext deleted, state FORENSIC_DELETED (row kept for audit); GET → 410 unchanged
MT-ORPHAN-BLOB-1 UNREFERENCED blobs are only counted/annotated; never deleted (assert delete spies = 0)
MT-1 executor: CONFIRMED candidates are physically purged only when destructivePurgeEnabled; disabled → untouched; idempotent across two runs
MT-2 runs are serialized with FOR UPDATE SKIP LOCKED (two concurrent runs → each candidate handled once)
MT-3 every deletion goes through the existing V1/V2 delete functions (no raw unlink outside vaultManifestStore for manifests)
PG-MT-1..2 the above against PostgreSQL with two workers
```
- [ ] **Step 2: RED**; **Step 3: Implement**; **Step 4: GREEN** → `# tests 6` + PG `2`.
- [ ] **Step 5: Phase regression** server suites + PG trio; `.env.example` documents `VAULT_DESTRUCTIVE_PURGE_ENABLED=false` as the required initial value.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `feat(idea1): add vault tree maintenance with flag-gated purge executor`
- [ ] **Gate G8** — Session Register row `PVH-P8`; reviewer confirms `DESTRUCTIVE_PURGE_ENABLED` default is `false` in config, `.env.example` and tests `PU-6`/`TS-21`.

---

## Phase 9 — Multi-device, concurrency, crash and rollback qualification

### Task 9.1: Two-client concurrency suite (real PostgreSQL)

**Files:**
- Create: `tests/vaultTreeMultiClient.test.js` (two `createTreeSession` instances over one `createApp` on PostgreSQL, each with its own login, KEK and unlockedState)

- [ ] **Step 1: Write failing tests**
```
MC2-1 disjoint rename/rename → both succeed via one auto-rebase; final manifest has both names
MC2-2 same-node rename conflict → second sees CONFLICT TARGET_RENAMED; user choice required; no last-writer-wins
MC2-3 move vs. destination trashed → DESTINATION_TRASHED conflict
MC2-4 delete-vs-edit → TARGET_DELETED
MC2-5 create with colliding name across devices → COLLISION conflict on the loser
MC2-6 concurrent genesis attempts (two devices in FLAT) → one lease, one 409; loser resumes as observer and loads the committed head
MC2-7 restore collision (device A creates a same-name active node, device B restores) → RESTORE_COLLISION
MC2-8 repeated conflict retry bound → REBASE_EXHAUSTED after limits.maxRebaseAttempts with a hostile scripted client
MC2-9 stale-after-lock: device A locked (purged) → its old session cannot commit; after re-unlock it loads the newer head
MC2-10 offline reconnect: device B's CAS made while A's fetch mock is offline; A reconnects → rebase, not overwrite (server generation strictly increases by exactly the number of successful CAS calls)
MC2-11 passphrase rotation on device A (casKeyEnvelope) while B holds the tree: B's next head fetch reports the new cas version; B re-unlocks with the new passphrase and decrypts every historical revision (byte-identical ciphertext rows)
```
- [ ] **Step 2: RED** (fails until the harness exists); **Step 3: Implement harness**; **Step 4: GREEN** → `# tests 11 # pass 11` on a fresh disposable database.
- [ ] **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `test(idea1): qualify private vault tree multi-client concurrency`

### Task 9.2: Crash-point suite

**Files:**
- Create: `tests/vaultTreeCrashPoints.test.js` (server injection points via `createApp({ vaultTreeStore: instrumented })` and client fetch failures)

- [ ] **Step 1: Write failing tests**
```
CP-1 client: manifest ciphertext PUT fails → head unchanged; candidate row CREATED is GC-eligible (listOrphanRevisions after retention includes CREATED older than retention)
CP-2 client: CAS request lost after server commit → SY-5 path recovers by head fetch; generation advanced once
CP-3 server: failure between PUT publish and CAS → revision PUBLISHED-unattached → ORPHANED by GC after retention
CP-4 server: transaction failure inside casHead after head UPDATE (injected before commit) → rollback: head, revision state, blob states unchanged
CP-5 tree upload commit succeeds, client crashes before attach → blob UNREFERENCED; re-unlock lists it in orphan recovery
CP-6 genesis lease holder crashes (no genesis) → state MIGRATING; takeover after expiry; legacy mutation still fenced throughout
CP-7 purge CAS succeeds, response lost → client refetch matches barrier/purgeId; confirm proceeds with the exact set
CP-8 physical purge interrupted → retry idempotent (PU-9 through the executor)
CP-9 corrupt current head ciphertext (flipped byte in storage) → fail closed; recovery UI offers the previous revision only if its generation ≥ barrier (410 otherwise)
```
- [ ] **Step 2: RED**; **Step 3: Implement injection hooks (test-only options, no behaviour change when absent)**; **Step 4: GREEN** → `# tests 9 # pass 9`; **Step 5:** `git diff --check`.
- [ ] **Step 6: Commit** → `test(idea1): qualify private vault tree crash recovery points`

### Task 9.3: Rollback qualification; gate G9

**Files:**
- Create: `tests/vaultTreeRollback.test.js`

- [ ] **Step 1: Write failing tests**
```
RO-1 TREE_V1 owner + treeUiEnabled=false → read/export-only screen (TS-11) works: unlock, decrypt head, list names, download; zero mutation controls; zero CAS calls
RO-2 TREE_V1 owner + protocolEnabled=false → tree routes 503; legacy mutations still 426 UPGRADE_REQUIRED (FENCE-4); GET /api/vault + blob download work; nothing deleted
RO-3 MIGRATING owner + genesisMigrationEnabled=false → state preserved, lease preserved, legacy still fenced 409; abandon route 503 (no automatic reversion)
RO-4 re-enabling flags after RO-1/2 → same head, same generation, every revision row and ciphertext file byte-identical (hash before/after)
RO-5 no code path sets protocol_state from TREE_V1 to anything (store source scan: the only UPDATE of protocol_state targets are FLAT→MIGRATING, MIGRATING→TREE_V1, MIGRATING→FLAT under the abandon predicate) — asserted by grepping the SQL strings in vaultTreeStore.js
RO-6 purge barrier never lowered by any store function (source scan for `purge_barrier_generation =` shows only GREATEST(...) assignments)
```
- [ ] **Step 2: RED**; **Step 3: Implement (tests only; any product change here is a defect to fix at its origin task)**; **Step 4: GREEN** → `# tests 6 # pass 6`.
- [ ] **Step 5: Phase regression** — the complete `tests/vault*.test.js` set on memory mode and the PG set (`vaultPostgres`, `vaultV2Postgres`, `vaultTreePostgres`, `vaultTreeMultiClient`, `vaultTreeCrashPoints`) each on a fresh disposable database.
- [ ] **Step 6:** `git diff --check`.
- [ ] **Step 7: Commit** → `test(idea1): qualify private vault tree rollback and fencing`
- [ ] **Gate G9** — Session Register row `PVH-P9`.

---

## Phase 10 — Exact-SHA broad regression and Production preflight hand-off

### Task 10.1: Full repository regression at the candidate SHA

**Files:** none created except evidence in the PR body and the receipt (Task 10.2).

- [ ] **Step 1:** `git fetch origin && git merge origin/main` (reconcile; rerun on any conflict); record `CANDIDATE_SHA`.
- [ ] **Step 2: Windows** — `npm test` (`node --test --test-concurrency=1 "tests/**/*.test.js"` with `--test-reporter=tap`) → record totals; compare with the accepted baseline from the PR150 closeout receipt (`2026-09-19_170000_kla_idea1-files-management-ux.md`); any new failure blocks.
- [ ] **Step 3: WSL Linux** (per `wsl-linux-verification-setup` memory) — same command; PG suites with `scripts/pg-integration-env.sh up`, one database per file; `MEDIA_SKIP` policy as in PR150.
- [ ] **Step 4: Build** — `npm run build` succeeds; restore `dist/` per Global Constraints; `git status --short` clean of `dist/`.
- [ ] **Step 5: Repo-root governance** — `git diff --check`; `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`; `node --test tests/collaborationPolicy.test.mjs tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs`; local `node scripts/validate-collaboration-policy.mjs --event <synthesised event JSON with the final PR body> --changed-files <git diff --name-status origin/main...HEAD>`.
- [ ] **Step 6: Ciphertext-unchanged proof** — on a disposable database seeded via `tests/helpers/seedRealVault.mjs`: hash every `vault_blobs`/`vault_v2_blobs`/`vault_v2_blob_chunks` row and storage file before genesis and after 50 random tree mutations + one passphrase rotation → identical.
- [ ] **Step 7: Leak sweep** — grep the disposable database dump, storage directory listing and server log for every fixture plaintext name and node ID → zero matches.
- [ ] **Step 8: Contradiction searches** (see "Plan self-review record") re-run against the *source tree* at `CANDIDATE_SHA` → zero unintended matches.
- [ ] **Step 9: Commit** (if the merge produced changes) → `chore(idea1): reconcile private vault hierarchy branch with main`

### Task 10.2: Receipt, canonical note, PR Ready request and Production preflight hand-off (future gates; not executed under this plan)

- [ ] **Step 1:** Update `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` (owner `kla`): task state, Session Register rows `PVH-P0..P10`, limits chosen, flags, rollout order, known limitations.
- [ ] **Step 2:** Create exactly one receipt `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/<UTC timestamp>_kla_idea1-private-vault-encrypted-hierarchy.md` from `_template.md`: every changed path, every command/result, shared surfaces (repository-root `.env.example`, `server/db/schema.sql`, `server/db/migrations/011_vault_tree_v1.sql`, `server/app.js`, `server/index.js`, `server/routes/api.js`) with reasons, integration requests (Kla review of schema/migration/flags; deployment migration order), limitations (traffic analysis acknowledged; best-effort memory cleanup; V1 video download-only; passphrase change UI remains a separate task because existing V1/V2 per-file DEKs are wrapped by the KEK and no passphrase-change endpoint exists today — this PR delivers the TRK rewrap primitive and its tests only).
- [ ] **Step 3:** PR #157 body: full template; `integration-review: yes`; verification table; migration/rollout/rollback sections mirroring "Rollout flags"; `DESTRUCTIVE_PURGE_ENABLED=false` stated for initial rollout.
- [ ] **Step 4:** Request Ready transition from the Human Owner only after CI (`collaboration-guardrails`) is green at the final head; the agent never merges.
- [ ] **Step 5: Production preflight list (hand-off; each is a future owner-authorized gate mapping design §22):** (1) deployed image/migration identity + additive schema preflight on a database copy; (2) two-user isolation probe with guessed opaque IDs; (3) DB/object/log plaintext inspection; (4) two real browsers concurrent Rename/Move/Create/Trash/Restore; (5) real TRK rotation + one-slot corruption drill on a disposable Vault; (6) deep hierarchy/casefold/bulk/drag-drop/cycle/stale-client/crash drills; (7) migration fence drill with an old client build; (8) tree-aware upload/orphan drill; (9) purge barrier drill with `DESTRUCTIVE_PURGE_ENABLED=false` then, only after retention/backup acceptance, `true` on a disposable Vault; (10) V1/V2 preview/download unchanged after migration; (11) lock/auto-lock/logout/tab lifecycle inspection (Application panel empty); (12) bounded image/GIF/video preview with a large V2 video; (13) retention/backup/recovery owner evidence; (14) full gates at the exact candidate SHA. Any failure blocks Production mutation.
- [ ] **Gate G10** — `IMPLEMENTATION_STATUS=COMPLETE_PENDING_REVIEW`; `PR157_READY` requested; `DO_NOT_MERGE` lifted only by the Human Owner.

---

## Plan self-review record

- **Design coverage:** §1–§3 → Authorization, Global Constraints; §4 → File map (every referenced module exists in the repository at `db657986`: `vaultCrypto.js`, `vaultChunkCrypto.js`, `vaultChunkedUpload.js`, `vaultChunkedDownload.js`, `vaultInventory.js`, `Vault.jsx`, `vaultPreviewSession.js`, `vaultPreviewServiceWorker.js`, `vault_v2_blobs`, `GET /api/vault`, PR #150 Files hierarchy); §5 → Global Constraints (XSS/traffic-analysis limitation copy in `RP-4`), threat model tests `TK-*`, `MC-*`; §6 → `NO-LEAK-1..6`, `AUD-OPAQUE-1`, `SRV-NOIMPORT-1`, `PV-NO-MEDIA-1`; §7 → Architecture (Approach B locked; no reconsideration); §8 → Identities table, `MF-1`, `MF-8`; §9 → Tasks 1.3, 1.4 (schema, effective lifecycle, canonical serialization, padding, bounds); §10 → Tasks 1.1, 1.2, 1.5 (`TK-13` direct-KEK guard, `MC-6` rotation immutability, `TK-4..6` slot corruption/disagreement); §11 → Schema plan, Route plan, Tasks 2.2, 2.4, 3.1, 4.2; §12 → Tasks 5.2, 5.3, 9.1; §13 → Task 1.4 `MF-3..5`, Task 5.1 `OP-3/4`, `OPP-2/3`; §14 → Tasks 5.1 (create/rename/move/trash/restore/purgeIntent), 4.1–4.3 (add/upload via versioned family), 8.1–8.2 (permanent deletion); §15 → Phase 6 (`UI-6` hides Share/History/Verify/Public Share/Protected Trash); §16 → Phase 7; §17 → Task 5.4; §18 → Phase 3 (`PM-2` no partial tree, `PM-3` no automatic rename, `PM-9/10` no re-encryption/no plaintext); §19 → Task 9.2 (one `CP-*` per table row) + `MG-*`, `OR-2`, `SY-5`, `PU-9`; §20 → `RP-4` copy, Global Constraints; §21 → Test plan mapping below; §22 → Task 10.2 Step 5; §23 → Rollout flags, Task 9.3; §24 → Global Constraints (transfer perf excluded), `TU-5`, `TU-SAME-1`; §25 → Authorization.
- **Task-brief coverage (sections 0–21 of the task):** §3 key model → Task 1.2; §4 state machine → Tasks 2.2/3.1 (`MG-1..11`, `PG-MG-*`); §5 blob protocol → Tasks 4.1–4.3; §6 manifest/CAS → Tasks 1.3–1.5, 2.4, 5.2–5.3; §7 UI features 1–17 → Tasks 6.1 (1,2,3,10), 6.2 (4,5,6), 6.3 (7,8,9), 6.3/8.2 (11), 6.4 (12), 7.2 (13), 7.3 (14), 7.4 (15,16), 5.4 (17); §8 trash/purge → Tasks 1.4 `MF-6/7`, 5.1 `OP-5/6/8`, 8.1–8.3; §9 migration → Phase 3; §10 preview → Phase 7; §11 purge unlocked state → Task 5.4; §12 measurement → Phase 0 + Limits Register; §13 DB/server → Schema plan, Tasks 2.1–2.5; §14 test plan → below; §15 decomposition → 11 phases / 40 tasks with gates G0–G10; §16 flags → Rollout flags + `FLAG-CHAIN-*`, `RO-*`; §17 transfer perf → excluded (Global Constraints).
- **Test plan mapping (task §14):** CRYPTO round trip/wrong key/tamper/AAD substitution/IV freshness/TRK slot recovery/passphrase rotation → `TK-1..14`, `MC-1..7`; MANIFEST schema/bounds/duplicate keys/canonicalization/Unicode/padding/graph invariants/cycles/collision policy → `CN-1..10`, `MF-1..10`, `MF-LIMIT-*`, `MP-1/2`; POSTGRES/API owner isolation/CAS races/idempotency/lease races/state fencing/immutable revisions/crash points/tree-aware upload+orphan attach/purge barrier races → `ST-9`, `TR-12`, `PG-CAS-RACE-*`, `TR-8`, `PG-MG-*`, `FENCE-*`, `PG-IMMUTABLE-1`, `CP-*`, `TU-*`, `OR-*`, `PG-PU-*`; MULTI-CLIENT → `MC2-1..11`; UI → `UI-*`, `DG-*`, `TS-*`; PREVIEW → `IT-*`, `GF-*`, `VP-*`, `TS-LIMIT-*`, `SA-*`; LIFECYCLE → `US-*`, `SY-9/11`, `VP-6`, `TSC-2`; MIGRATION V1/V2/ciphertext unchanged → `PM-1/9/10`, Task 10.1 Step 6; ROLLBACK → `RO-1..6`, `TS-11`.
- **Signature/type consistency:** every module's public interface is defined once in the File map and referenced by name in the tasks; `ctx` shapes for TRK and Manifest DEK are defined in Task 1.2 and reused by 1.5, 3.2, 5.3; `blobRef = { formatVersion, id }` is the single blob reference shape client and server (`attachBlobIds`, `purgeBlobIds`, `vault_tree_blob_state`).
- **Route consistency:** every client `vaultTreeApi.js` function maps to exactly one row in the Route plan; legacy routes listed as fenced match the mutation set in `api.js`/`vaultUploads.js` at `db657986` (`POST /vault/blobs`, `DELETE /vault/blobs/:id`, `POST /vault/uploads`, `PUT .../chunks/:index`, `POST .../commit`).
- **Schema consistency:** every column named in tasks (`purge_barrier_generation`, `envelope_cas_version`, `attached_generation`, `confirmable_at`, `frozen_inventory_digest`, `head_ever_committed`, `tree_mutation_count`) exists in the Schema plan; revision states used by routes/GC (`CREATED`, `PUBLISHED`, `HEAD_COMMITTED`, `SUPERSEDED`, `ORPHANED`, `NON_RECOVERABLE`, `FORENSIC_DELETED`) match the CHECK list and the immutability trigger transitions.
- **Key-hierarchy consistency:** Manifest DEKs are wrapped only by the TRK (`wrapManifestDek(trk, …)`); the KEK wraps only the TRK slots (`wrapTrkSlots(kek, …)`); `TK-13` and `SS-*` enforce it in code; passphrase rotation touches only `vault_tree_key_envelope` (`MC-6`, `MC2-11`).
- **Feature-flag consistency:** six flags, chained (`FLAG-CHAIN-1..5`), surfaced in `GET /tree/state`, checked in routes (`TR-2`, `MG-2`, `PU-6`), client (`UI-9`, `TS-11`, `TS-18`, `MU-1`), rollback (`RO-1..3`); initial Production value of destructive purge is `false` in config default, `.env.example`, Task 8.3 gate and Task 10.2.
- **Rollout/rollback consistency:** rollback disables UI/protocol while preserving data (`RO-4` byte-identical); no path re-enables flat mutation (`FENCE-4`, `RO-2`, `RO-5`); barrier never lowered (`RO-6`, `PU-2`).
- **Placeholder scan:** `grep -nE 'TODO|TBD|FIXME|XXX|\?\?\?|lorem' <plan>` → the only match is this definition line; the only deferred-value token is `MEASURED@G0`, replaced at Task 0.3.
- **Contradiction searches (all must return zero unintended matches; run against this plan now and against the source tree at `CANDIDATE_SHA` in Task 10.1):**
  - direct KEK → Manifest DEK wrapping: `grep -nE 'wrapManifestDek\(\s*kek|Manifest DEK.*(wrapped|directly) by the (password|KEK)' <plan>` → matches only the Architecture sentence stating it is forbidden and `TK-13` (the guard test).
  - legacy Add/Delete allowed in `TREE_V1`: `grep -nE 'TREE_V1.*(allow|permit).*(legacy|flat) (Add|Delete)' <plan>` → 0.
  - `TREE_V1 → FLAT` transition: `grep -nE 'TREE_V1\s*(→|->|to)\s*FLAT' <plan>` → only this definition line (the only reversion in the plan is `MIGRATING_TREE_V1 → FLAT` under the abandon predicate).
  - server `parent_id` for Vault: `grep -nE 'parent_id' <plan>` → only this definition line (the Limits Register cites the Files migration `010_files_kind_parent.sql` for normal-Files name limits, which is not a Vault column).
  - server plaintext name/MIME: `grep -nE '(name|mime|media_type)\s+TEXT' <plan>` → 0 in the Schema plan.
  - server Vault thumbnail: `grep -nE '(sharp|ffmpeg).*vault' -i <plan>` → only this definition line (Task 0.2 uses `sharp`/FFmpeg solely to build disposable test fixtures on the developer machine; no server derivative exists).
  - pre-barrier recovery: `grep -nE 'below the barrier.*(recover|select)' -i <plan>` → only this definition line; every barrier statement in the plan is a rejection (`410 TREE_REVISION_NON_RECOVERABLE`, `NON_RECOVERABLE`).
  - destructive purge enabled at initial rollout: `grep -nE 'DESTRUCTIVE_PURGE_ENABLED\s*=\s*true' <plan>` → 0.
  - upload-performance work mixed into PR157: `grep -nE 'chunk size|parallelism|throughput|concurrency tuning' -i <plan>` → matches only the Global Constraints exclusion statement and this definition line.
- **Decomposition:** 11 phases, 40 tasks (0.1–0.3, 1.1–1.5, 2.1–2.5, 3.1–3.3, 4.1–4.3, 5.1–5.5, 6.1–6.4, 7.1–7.4, 8.1–8.3, 9.1–9.3, 10.1–10.2), 11 reviewer gates. Each task lists exact files, interfaces, RED command, GREEN count, regression command and one commit.
- **Not claimed:** no physical memory zeroization guarantee (`US-4`); no "zero metadata" claim (`RP-4`); traffic-analysis inference acknowledged; passphrase-change UI is out of scope (documented limitation in Task 10.2); orphan blob automatic deletion is out of scope (`OR-3`, `MT-ORPHAN-BLOB-1`).

```text
TASK=PR157_PRIVATE_VAULT_ENCRYPTED_HIERARCHY_IMPLEMENTATION_PLAN
PLAN_PHASES=11
PLAN_TASKS=40
MEASUREMENT_PHASE_PRESENT=YES
TRK_IMPLEMENTATION_COVERED=YES
MIGRATION_FENCE_COVERED=YES
TREE_AWARE_UPLOAD_COVERED=YES
PURGE_BARRIER_COVERED=YES
EFFECTIVE_TRASH_COVERED=YES
CLIENT_ONLY_PREVIEW_COVERED=YES
PURGE_UNLOCKED_STATE_COVERED=YES
TRANSFER_PERF_INCLUDED=NO
IMPLEMENTATION_STARTED=NO
NEXT_GATE=CHATGPT_REVIEW_PR157_IMPLEMENTATION_PLAN
```
