# IDEA1 Unified Preview — P2a Manifest v2 Reader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Vault client able to **read** encrypted manifest schema v2 (optional per-file `contentFormat` and `previews`) while continuing to **write only v1**, so that P2b can later enable a v2 writer behind a one-way boundary with a guaranteed rollback target.

**Architecture:** Version-dispatched validation in `vaultTreeManifest.js` / `vaultTreeCanonical.js`: v1 stays byte-for-byte strict; v2 adds two optional, fully validated node keys; any other version fails secure. The sync layer decrypts each revision using that revision's own `manifestSchemaVersion` in the AAD. Writes remain v1. A v2 head encountered by this build is readable but **not mutable** (fail-secure, no data loss) — see Decision P2A-W below.

**Tech Stack:** WebCrypto AES-GCM, pure JS validators, `node:test`, property tests.

**Spec:** §8.2 (schema v2 fields and validation), §8.3 (op defined later — not implemented here), §32, §35 T12, §36 T-MAN-V2, §38.1 P2a, §38.2.

**Depends on:** P0 merged (independent of P1). **Branch:** `feat/idea1-preview-p2a-manifest-v2-reader` from `origin/main`.

## Global Constraints

```
P2A_WRITES_V2=NO
V1_WRITER=ACTIVE
DERIVATIVE_GENERATION=NONE
SERVER_CHANGE=NONE          (POST /api/vault/tree/revisions keeps rejecting manifestSchemaVersion !== 1 — server/routes/vaultTree.js:166)
UI_RENDERS_PREVIEW_ENTRIES=NO
```

- Master plan §3 block applies verbatim.
- The v1 canonical encoding must remain byte-identical (golden vectors) — existing revisions must decrypt unchanged.
- No new storage API; no new network call.

## Decision P2A-W (gap closure, not an architecture change)

The spec requires P2a to read v2 and write only v1, and requires any post-v2 rollback target to read v2. It does not state what a v1-writing build does when asked to mutate a v2 head. Writing v1 would silently drop preview references (regenerable, but leaves derivative blobs as permanently TREE_MANAGED orphans because purge is disabled); writing v2 would violate `P2A_WRITES_V2=NO`. **This plan chooses fail-secure read-only on a v2 head**: browsing, preview, and download work; mutations show "This Vault was updated by a newer version of Drive — reload to make changes" and perform no publish or CAS. The intended rollback target after v2 writes is a P2b build with the writer flag OFF (P2b defines that such a build still writes v2 back when the head is already v2). **Human acknowledgement of P2A-W is requested at the P2a review gate.**

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `src/lib/vaultTreeManifest.js` | `MANIFEST_SCHEMA_VERSION_WRITE = 1`, `MANIFEST_SCHEMA_VERSIONS_READ = [1, 2]`; version-dispatched `validateManifest`; v2 node field validation; `effectivePreviews(node)` |
| Modify | `src/lib/vaultTreeCanonical.js` | v2-aware canonical encode/decode with fixed key order; v1 path unchanged |
| Create | `src/lib/vaultPreviewProfiles.js` | frozen vp1 bounds table used by validation (thumb/poster/motion/proxy limits from spec §10) |
| Modify | `src/lib/vaultTreeSync.js` | per-revision AAD version on read; write path pinned to v1; v2-head mutation refusal |
| Modify | `src/lib/useVaultTree.js`, `src/screens/VaultTreeScreen.jsx` | surface `MANIFEST_NEWER_THAN_WRITER` state; disable mutation actions |
| Modify | `tests/helpers/vaultTreeFakeServer.mjs` | test-only option `acceptManifestSchemaVersions: [1]` (default) / `[1,2]` and ability to seed a v2 revision |
| Modify | `tests/vaultTreeManifest.test.js` | update the existing `schemaVersion = 2 → BAD_SCHEMA` expectation (line ~77) to `schemaVersion = 3 → UNSUPPORTED_SCHEMA_VERSION`; add v2 cases |
| Create | `tests/vaultTreeManifestV2.test.js` | T-MAN-V2 |
| Modify | `tests/vaultTreeManifestProperty.test.js` | v2 generators |
| Modify | `tests/vaultTreeManifestCrypto.test.js` | v1 golden vector + v2 round trip |
| Modify | `tests/vaultTreeSync.test.js`, `tests/vaultTreeScreen.test.js` | reader + refusal |

## Interfaces

```ts
// src/lib/vaultTreeManifest.js
export const MANIFEST_SCHEMA_VERSION_WRITE: 1
export const MANIFEST_SCHEMA_VERSIONS_READ: readonly [1, 2]
export const MANIFEST_SCHEMA_VERSION = MANIFEST_SCHEMA_VERSION_WRITE   // kept for existing importers
export function validateManifest(m, limits?): void
  // v1: exactly today's rules (contentFormat/previews → UNKNOWN_KEY)
  // v2: v1 rules + optional file-node keys contentFormat, previews
  // otherwise: throw ManifestError('UNSUPPORTED_SCHEMA_VERSION')
export function effectivePreviews(node): ReadonlyArray<Preview>
  // entries whose sourceBlobRef equals node.blobRef AND profile is known; others ignored (not errors)

// Preview entry (spec §8.2) — closed key set:
// kind ∈ {thumb,poster,motion,proxy} (unique per node), profile /^vp[1-9][0-9]*$/,
// blobRef {formatVersion:2, id}, contentId (b64 of 16 bytes), sourceBlobRef {formatVersion:1|2, id},
// mime (kind-specific allowlist), width/height positive ints ≤ profile bounds, durationMs (motion/proxy only),
// plainSize positive int ≤ profile bound, createdAtClient safe int ≥ 0. ≤ 4 entries.

// src/lib/vaultTreeSync.js
export class ManifestNewerThanWriterError extends Error { code: 'MANIFEST_NEWER_THAN_WRITER' }
```

---

### Task 0: Baseline

- [ ] Worktree + `npm ci`; `npm test` → `$SCRATCH/p2a-baseline-failures.txt`.
- [ ] Capture v1 golden vector: canonical bytes + ciphertext decrypt of a fixed fake-server manifest (fixed ids, fixed timestamps) into `tests/fixtures/vaultManifestV1Golden.json` (plaintext canonical bytes as base64; no keys) — committed with Task 3.

### Task 1: Version dispatch and fail-secure unknown versions

**Files:** `src/lib/vaultTreeManifest.js`, `tests/vaultTreeManifest.test.js`, `tests/vaultTreeManifestV2.test.js`.

- [ ] **Step 1 — RED:** `schemaVersion: 2` with no new keys validates; `schemaVersion: 3`, `0`, `'2'`, `null` → `UNSUPPORTED_SCHEMA_VERSION`; v1 manifest carrying `previews` → `UNKNOWN_KEY`; update existing line ~77 expectation.
- [ ] **Step 2 — verify RED:** `node --test --test-concurrency=1 tests/vaultTreeManifestV2.test.js tests/vaultTreeManifest.test.js` → v2 rejected with `BAD_SCHEMA`.
- [ ] **Step 3 — GREEN:** constants + dispatch.
- [ ] **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): accept manifest schema v2 on read and fail secure on unknown versions`.

### Task 2: v2 node field validation + `effectivePreviews`

**Files:** `src/lib/vaultPreviewProfiles.js`, `src/lib/vaultTreeManifest.js`, `tests/vaultTreeManifestV2.test.js`, `tests/vaultTreeManifestProperty.test.js`.

- [ ] **Step 1 — RED:** valid v2 node with thumb+poster; each violation throws a distinct code: unknown preview key, duplicate kind, 5 entries, `blobRef.formatVersion: 1`, bad id length, contentId not 16 bytes, mime not allowed for kind, width above vp1 bound, `durationMs` on thumb, folder carrying `previews`/`contentFormat`, `contentFormat` not a known `FormatId` string (≤ 32 bytes). `effectivePreviews` drops an entry whose `sourceBlobRef` ≠ node `blobRef` and an entry with profile `vp9` (unknown) without throwing. Property test: random valid v2 manifests validate; random single-field corruption rejects.
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): validate manifest v2 preview references`.

### Task 3: Canonical encode/decode for v2 (v1 bytes frozen)

**Files:** `src/lib/vaultTreeCanonical.js`, `tests/vaultTreeManifestCrypto.test.js`, `tests/fixtures/vaultManifestV1Golden.json`.

- [ ] **Step 1 — RED:** v1 golden: `canonicalEncode(v1Fixture)` equals golden bytes; v2 round trip `canonicalDecode(canonicalEncode(m))` deep-equals `m`; encoding is independent of object key insertion order; a 10k-node v2 manifest with 3 previews each stays ≤ `maxDecodedBytes` or fails with the existing size error (no truncation); `encryptManifestRevision`/`decryptManifestRevision` with `manifestSchemaVersion: 2` in ctx round-trip; decrypting v2 ciphertext with ctx version 1 fails (AAD binds version).
- [ ] **Step 2 — verify RED:** v2 keys rejected by canonical decoder.
- [ ] **Step 3 — GREEN:** add v2 key sets and deterministic ordering; do not touch v1 code path.
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultTreeManifestCrypto.test.js tests/vaultTreeAad.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): canonically encode manifest v2 while freezing v1 bytes`.

### Task 4: Sync reader uses per-revision schema version

**Files:** `src/lib/vaultTreeSync.js`, `tests/helpers/vaultTreeFakeServer.mjs`, `tests/vaultTreeSync.test.js`.

- [ ] **Step 1 — RED:** fake server seeded with a v2 HEAD revision (encrypted with ctx version 2) → client opens Vault, lists nodes, `node.previews` present in the in-memory manifest; a v1 head keeps working; a revision advertising `manifestSchemaVersion: 3` → `UNSUPPORTED_SCHEMA_VERSION` surfaced as a locked-safe error state (no partial render, no write).
- [ ] **Step 2 — verify RED:** decrypt fails because ctx uses the constant 1.
- [ ] **Step 3 — GREEN:** every read path builds ctx from the revision/head metadata (`manifestSchemaVersion`), never from the constant; unknown → throw before decrypt.
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultTreeSync.test.js tests/vaultTreeApiClient.test.js tests/vaultTreeMigration.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): decrypt Vault manifest revisions with their own schema version`.

### Task 5: v1-only writer and v2-head mutation refusal (Decision P2A-W)

**Files:** `src/lib/vaultTreeSync.js`, `src/lib/useVaultTree.js`, `src/screens/VaultTreeScreen.jsx`, `tests/vaultTreeSync.test.js`, `tests/vaultTreeScreen.test.js`.

- [ ] **Step 1 — RED:**
  - v1 head + rename → publish body `manifestSchemaVersion: 1`, decrypted plaintext `schemaVersion: 1`.
  - v2 head + rename/move/upload-attach/trash → `ManifestNewerThanWriterError`; spies prove **zero** `publishRevision` and **zero** `casHead` calls; UI shows the reload message; Preview and Download still enabled; Upload button disabled with the same message.
  - Rebase path: a v1 local intent whose rebase target becomes a v2 head → refused, intent discarded with the same message (no v1 overwrite of v2).
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultTreeRebase.test.js tests/vaultTreeOps.test.js tests/vaultTreeUploadClient.test.js tests/vaultTreeScreen.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): keep v1 writer and refuse mutating a newer manifest`.

### Task 6: Server unchanged proof

**Files:** none (assertion only) — `tests/vaultTreeApi.test.js` existing case `{ manifestSchemaVersion: 2 } → 400` must stay green.

- [ ] `node --test --test-concurrency=1 tests/vaultTreeApi.test.js tests/vaultTreeUploadsApi.test.js`; PG: `bash scripts/pg-integration-env.sh node --test --test-concurrency=1 tests/vaultTreePostgres.test.js`.
- [ ] `git diff --name-status origin/main...HEAD -- server` → empty. No commit.

### Task 7: Regression, no-plaintext, governance

- [ ] `npm test` vs baseline.
- [ ] Vault regression: `node --test --test-concurrency=1 tests/vaultTree*.test.js tests/vaultUnlockedState.test.js tests/vaultMediaPreview.test.js tests/vaultPreviewSession.test.js tests/arbitraryTransferRegression.test.js tests/previewAccountNeutrality.test.js`.
- [ ] Storage scans (existing SA-1/SA-SW-1) green; source scan: no `localStorage|sessionStorage|indexedDB|caches.open` in modified files.
- [ ] `npm run build && git checkout -- dist`; `git diff --check`; policy validation; receipt; push.

## Rollback boundary

Fully reversible: P2a writes nothing new. Reverting restores v1-only reading, which is safe because no v2 manifest can exist until P2b's writer is enabled.

## Human review gate (G-P2a-ACCEPT)

1. Human acknowledges Decision P2A-W.
2. P2a deployed to Production by the Human Owner.
3. Human verifies on ADMIN, EXISTING_USER, NEWLY_CREATED_USER: Vault unlocks, browse/rename/upload/download unchanged (v1 heads), no console errors.
4. Human records `P2A_ACCEPTED=YES` — prerequisite for enabling the P2b writer flag.
