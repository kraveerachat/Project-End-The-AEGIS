# IDEA1 Unified Preview — P2b Manifest v2 Writer + Encrypted Thumbnail/Poster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Private Vault tiles approach Normal Files perceived responsiveness by persisting small, **client-generated and client-encrypted** thumbnail/poster derivatives as ordinary V2 blobs referenced from an encrypted manifest v2 — behind a default-OFF, server-served writer flag that may only be enabled after T-MAN-SIZE passes Human-approved thresholds and P2a is accepted in Production.

**Architecture:** Derivatives reuse the existing V2 upload session, random per-blob DEK wrapped by the KEK, per-chunk AAD, and owner-scoped routes — no new crypto, AAD layout, or server table (§8.1, §9). The manifest records `contentId` + `sourceBlobRef` per derivative (§8.2); readers verify `contentId` before decrypting. New uploads generate thumb/poster from the local plaintext `File`; legacy files are backfilled lazily from bytes the existing tile path already decrypted. Upload success never depends on derivative success.

**Tech Stack:** WebCrypto AES-GCM, V2 chunked upload client, OffscreenCanvas / `createImageBitmap` / `<video>` (capability-detected), Express, PostgreSQL, `node:test`, jsdom.

**Spec:** §7, §8, §9, §10 (thumb/poster), §11, §12, §14, §20–§31, §34, §35, §36 (T-MAN-SIZE, T-MAN-V2, T-DER-*, T-BACKFILL, T-CORRUPT, T-LOCK, T-NEUTRAL, T-AUDIT-VOL, T-CHUNK-RULES), §37 H4–H6, H14, H15, §38.

**Depends on:** P2a merged; P2a **deployed and accepted** before the flag is enabled. **Branch:** `feat/idea1-preview-p2b-encrypted-thumb-poster` from `origin/main`.

## Global Constraints

```
SERVER_VAULT_PLAINTEXT=FORBIDDEN
SERVER_GENERATED_VAULT_PLAINTEXT_DERIVATIVES=FORBIDDEN
PERSISTENT_DECRYPTED_VAULT_CACHE=FORBIDDEN
PERSISTED_VAULT_CIPHERTEXT_DERIVATIVES=ALLOWED
DERIVATIVE_PADDING=NONE                       (D-2)
VAULT_V2_MIN_PLAINTEXT_CHUNK=8 MiB            (D-3; derivative uploads use exactly the minimum)
AUDIT_SEMANTICS=UNCHANGED                     (D-4)
VAULT_CIPHERTEXT_HTTP_CACHE=OFF               (D-5)
WRITER_FLAG_DEFAULT=OFF
AUTOMATIC_BACKFILL=THUMB_AND_POSTER_ONLY, NO_EXTRA_ORIGINAL_FETCH   (D-8)
```

- Master plan §3 block applies verbatim. `PRE_TREE_ROLLBACK=FORBIDDEN`, `VAULT_DESTRUCTIVE_PURGE_ENABLED=false`.
- No new dependency (thumb/poster use native canvas/`<video>`).

## ⛔ PRE-IMPLEMENTATION / PRE-ENABLE GATE (G-MAN → G-THR)

Task 1 (measurement) runs **before any writer implementation task**. After Task 1 the executor **STOPS** and hands the evidence table to the Human Owner.

- If the Human Owner approves thresholds and every cell passes → continue with Task 2.
- If any cell fails or the Human Owner declines → `P2B_WRITER_ENABLE=BLOCKED`; do not execute Tasks 2–17; open a new architecture task for a separate encrypted preview index (D-1).

Task 17 re-runs the same measurement with the real writer code before the flag can be enabled (G-ENABLE).

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Create | `scripts/measure/vault-manifest-size.mjs` | T-MAN-SIZE harness (Node WebCrypto + local Drive server) |
| Create | `server/config/vaultPreviewFeatures.js` | `VAULT_MANIFEST_V2_WRITE` env flag (default `false`) |
| Modify | `server/routes/vaultTree.js` | revisions accept `manifestSchemaVersion` 2 **only when the flag is on**; `GET /state` returns `features.manifestV2Write` |
| Modify | `src/lib/vaultTreeManifest.js` | `MANIFEST_SCHEMA_VERSION_WRITE` becomes dynamic via `writerSchemaVersion({ flag, headVersion })` |
| Modify | `src/lib/vaultTreeSync.js` | write v2 when head is v2 (always) or when flag on (upgrade); P2A-W refusal removed for P2b builds |
| Modify | `src/lib/vaultTreeOps.js`, `src/lib/vaultTreeRebase.js` | `setNodePreviews` intent; `attachBlob` accepts `previews`/`contentFormat` |
| Create | `src/lib/vaultDerivativeUpload.js` | encrypt + upload one derivative as a V2 blob |
| Create | `src/lib/vaultDerivativeRead.js` | verified fetch/decrypt of a derivative; ciphertext LRU |
| Create | `src/lib/vaultDerivativeGenerate.js` | thumb/poster generation from a local `File` |
| Create | `src/lib/vaultDerivativeBackfill.js` | bounded lazy backfill queue |
| Modify | `src/lib/vaultTreeUpload.js`, `src/components/VaultUploadDrawer.jsx` | generate → upload → single attach |
| Modify | `src/lib/vaultImageThumb.js`, `src/lib/vaultVideoPreview.js` | `returnBytes` for image thumbs (video already has it) |
| Modify | `src/screens/VaultTreeScreen.jsx`, `src/lib/vaultThumbScheduler.js` | derivative-first tile lane (6 concurrent), fallback to existing lane |
| Modify | `src/components/vault/VaultRecoveryPanel.jsx`, `src/lib/vaultUploadRecovery.js` | hide derivative orphans |
| Modify | `src/lib/vaultUnlockedState.js` | register derivative LRU/backfill/generation disposers |
| Modify | `src/lib/vaultPreviewDiagnostics.js` | §34 counters |
| Modify | `src/lib/vaultTreeLimits.js` + `tests/vaultTreeLimits.test.js` | derivative lane/LRU/backfill bounds (provisional, measured) |
| Create | tests per task | |

## Interfaces

```ts
// server/config/vaultPreviewFeatures.js
export function vaultPreviewFeaturesFrom(env): Readonly<{ manifestV2Write: boolean }>   // 'true' only enables

// src/lib/vaultTreeManifest.js
export function writerSchemaVersion(o: { flag: boolean, headVersion: 1 | 2 }): 1 | 2
  // headVersion 2 → 2 (preserve entries, rollback-target semantics); headVersion 1 → flag ? 2 : 1

// src/lib/vaultTreeOps.js
setNodePreviews: (o: { nodeId: string, expectedSourceBlobRef: BlobRef, contentFormat?: string,
                       upsert?: Preview[], remove?: Kind[], operationId?: string }) => Intent
// rebase: node missing/trashed → drop; node.blobRef ≠ expectedSourceBlobRef → drop; same-kind conflict → last writer wins

// src/lib/vaultDerivativeUpload.js
export async function uploadDerivative(o: { kek: CryptoKey, bytes: Uint8Array, mime: string, signal?: AbortSignal,
                                            api?: object }): Promise<{ blobRef: { formatVersion: 2, id: string },
                                            contentId: string, plainSize: number }>
  // V2 session, chunkSize = MIN_VAULT_PLAINTEXT_CHUNK_BYTES + GCM_TAG_BYTES, meta { name: '', type: mime, plainSize }

// src/lib/vaultDerivativeRead.js
export function createDerivativeReader(o: { kek: CryptoKey, envelopeOf: (blobRef) => Envelope | null,
                                            fetchChunk: Function, lruBytes: number, createObjectUrl, registerObjectUrl })
  : { read(preview: Preview, o?: { signal }): Promise<{ ok: true, url: string } | { ok: false, reason: 'MISSING'|'CONTENT_ID_MISMATCH'|'INTEGRITY'|'DECODE'|'BOUNDS'|'ABORTED' }>,
      clear(): void }

// src/lib/vaultDerivativeGenerate.js
export async function generateThumb(file: File, o: { profile, env, signal, budgetMs: 10_000 }): Promise<{ bytes, mime, width, height } | null>
export async function generatePoster(file: File, o: { profile, env, signal, budgetMs: 10_000 }): Promise<{ bytes, mime, width, height, durationMs } | null>

// src/lib/vaultDerivativeBackfill.js
export function createBackfillQueue(o: { maxConcurrent: 1, maxPerSession: 50, isDeferred: () => boolean,
                                         canWrite: () => boolean, upload: typeof uploadDerivative, submitIntent })
  : { offer(nodeId, kind, bytes, meta): void, clear(): void, stats(): object }
```

---

### Task 0: Baseline

- [ ] Worktree + `npm ci`; `npm test` → `$SCRATCH/p2b-baseline-failures.txt`.

### Task 1: T-MAN-SIZE measurement (PRE-IMPLEMENTATION GATE)

**Files:** Create `scripts/measure/vault-manifest-size.mjs`; evidence in scratchpad and in the PR body (not committed as a limits change).

Method:

- Generate synthetic manifests with the P2a encoder at **1,000 / 5,000 / 10,000** file nodes (realistic names 20–60 UTF-8 bytes, depth ≤ 6), in two variants: **no previews** and **3 preview entries per file** (thumb + poster + motion shapes).
- Metrics per variant (≥ 20 runs, report p50/p95): plaintext canonical bytes, padded bucket, ciphertext bytes, `canonicalEncode` ms, `encryptManifestRevision` ms, `decryptManifestRevision` + `canonicalDecode` + `validateManifest` ms (Node, and Chromium via a static harness page served from `vite preview` if available — record which).
- Upload + head CAS ms against a local Drive server (memory store and PostgreSQL via `scripts/pg-integration-env.sh`). Because the server does not accept v2 before Task 2, upload a **v1** revision padded to the **same ciphertext size** as the v2 variant: server upload/CAS cost depends only on byte size and row writes, not on the (opaque) schema version. State this substitution in the evidence.
- Optional Human-run: same upload/CAS over the Remote path (download and upload directions recorded separately; `REMOTE_EQUALS_LAN=NO`).

Evidence table template (fill every cell):

| Nodes | Variant | Plain B | Bucket B | Cipher B | Encode p50/p95 | Encrypt p50/p95 | Decrypt+decode+validate p50/p95 | Upload p50/p95 (LAN) | CAS p50/p95 | Δ vs no-previews |
|---|---|---|---|---|---|---|---|---|---|---|
| 1k | none | | | | | | | | | — |
| 1k | 3 previews | | | | | | | | | |
| 5k | none | | | | | | | | | — |
| 5k | 3 previews | | | | | | | | | |
| 10k | none | | | | | | | | | — |
| 10k | 3 previews | | | | | | | | | |

Threshold proposal (explicitly **NOT APPROVED** — for the Human Owner to accept, change, or reject; the executor must not treat these as pass criteria):

| Metric | Suggested criterion (non-binding) |
|---|---|
| Per-mutation total (encode+encrypt+upload+CAS) on LAN, 10k + previews | p95 ≤ 2× the 10k no-previews p95, and ≤ 3 s absolute |
| Unlock decode+validate, 10k + previews, Chromium | p95 ≤ 1.5 s |
| Ciphertext, 10k + previews | fits `maxCiphertextBytes` (16 MiB + 16) with ≥ 25 % headroom |

- [ ] **Step 1:** Implement harness (script only; no product change). `node scripts/measure/vault-manifest-size.mjs --nodes 1000,5000,10000 --variants none,previews --runs 20 --out "$SCRATCH/t-man-size.json"`.
- [ ] **Step 2:** Fill the evidence table.
- [ ] **Step 3 — commit:** `test(idea1): add manifest v2 size and cost measurement harness` (script only).
- [ ] **Step 4 — ⛔ STOP.** Report `T_MAN_SIZE_EVIDENCE=READY`, `THRESHOLDS=AWAITING_HUMAN_APPROVAL`. Resume only on written Human approval. On failure: `P2B_WRITER_ENABLE=BLOCKED`.

### Task 2: Server flag for v2 revision acceptance

**Files:** Create `server/config/vaultPreviewFeatures.js`; modify `server/routes/vaultTree.js`; extend `tests/vaultTreeApi.test.js`.

- [ ] **Step 1 — RED:** flag unset → `manifestSchemaVersion: 2` publish still 400 (existing case); flag `true` → 2 accepted, 3 rejected, 1 accepted; `GET /api/vault/tree/state` includes `features: { manifestV2Write: <bool> }`; values other than the literal `'true'` keep it off; cross-owner and auth behaviour unchanged.
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN:** memory + `bash scripts/pg-integration-env.sh node --test --test-concurrency=1 tests/vaultTreeApi.test.js tests/vaultTreePostgres.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): gate manifest v2 revision acceptance behind a default-off flag`.

### Task 3: Writer schema selection (rollback-target semantics)

**Files:** `src/lib/vaultTreeManifest.js`, `src/lib/vaultTreeSync.js`, `tests/vaultTreeSync.test.js`.

- [ ] **Step 1 — RED:** `writerSchemaVersion` truth table; flag off + v1 head → publishes v1 (unchanged); flag off + v2 head → publishes v2 preserving every preview entry (P2A-W refusal no longer applies in this build); flag on + v1 head → first mutation publishes v2 with no previews; AAD ctx version always equals plaintext `schemaVersion`.
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultTreeRebase.test.js tests/vaultTreeManifestV2.test.js tests/vaultTreeManifestCrypto.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): select manifest writer version from flag and head`.

### Task 4: `setNodePreviews` operation and `attachBlob` previews

**Files:** `src/lib/vaultTreeOps.js`, `src/lib/vaultTreeRebase.js`, `tests/vaultTreeOps.test.js`, `tests/vaultTreeRebase.test.js`, `tests/vaultTreeOpsProperty.test.js`.

- [ ] **Step 1 — RED:** upsert/remove semantics; idempotent `operationId`; rebase drops intent when node trashed/missing or `blobRef` changed; concurrent same-kind upsert → last writer wins; `attachBlob` with initial previews validates via P2a rules; ops refused on a v1 manifest when writer version is 1 (flag off, v1 head).
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add setNodePreviews tree operation`.

### Task 5: Encrypted derivative upload (random DEK, current chunk rules)

**Files:** Create `src/lib/vaultDerivativeUpload.js`, `tests/vaultDerivativeUpload.test.js`.

- [ ] **Step 1 — RED:** with `vaultTreeFakeServer.mjs` capture: two uploads of identical bytes produce different `wrappedDekB64` and `contentIdB64` (random DEK, no dedup); session `chunkSize === 8 MiB + 16` (`MIN_VAULT_PLAINTEXT_CHUNK_BYTES + GCM_TAG_BYTES`) and `chunkCount === 1` for ≤ 256 KiB inputs; decrypted meta is `{ name: '', type: mime, plainSize }`; no request body or header contains the plaintext bytes (byte-substring search) or the mime string outside ciphertext; abort mid-upload never calls commit.
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN:** reuse `vaultChunkedUpload.js` primitives.
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/chunkedUploadClient.test.js tests/vaultTreeUploadClient.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): upload encrypted preview derivatives as V2 blobs`.

### Task 6: Thumb/poster generation from local File

**Files:** Create `src/lib/vaultDerivativeGenerate.js`, `tests/vaultDerivativeGenerate.test.js`; modify `src/lib/vaultTreeLimits.js` (+ test table).

- [ ] **Step 1 — RED:** injected decode/encode doubles (jsdom has no canvas): images use existing lanes (normal ≤ 16 MP; reduced JPEG lane); output long edge ≤ 512, bytes ≤ 256 KiB (retry at lower quality once, then `null`); WebP when `env.webpEncode` else JPEG; videos seek via `vaultVideoPosterSeekSeconds` on a local Object URL that is revoked in `finally`; budget 10 s → `null` + abort; unsupported/undecodable → `null` (no throw).
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultImageThumb.test.js tests/vaultImageReducedDecode.test.js tests/vaultVideoDom.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): generate Vault thumbnails and posters from the local file`.

### Task 7: Upload flow — original first, derivatives best-effort, one attach

**Files:** `src/lib/vaultTreeUpload.js`, `src/components/VaultUploadDrawer.jsx`, `tests/vaultTreeUploadClient.test.js`, create `tests/vaultDerivativeUploadFlow.test.js`.

- [ ] **Step 1 — RED:** (a) happy path: original committed, derivatives uploaded, **one** CAS whose `attachBlobIds` contains original + derivatives and whose manifest node has `previews` + `contentFormat`; (b) generation throws/times out → original attached without previews, upload reported success; (c) derivative upload fails after commit → original attached, derivative blob left UNREFERENCED; (d) flag off and v1 head → no generation at all; (e) batch > 64 media files splits CAS within `maxAttachBlobIdsPerCas` (256); (f) upload result object identical in shape to today.
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultTreeUploadClient.test.js tests/vaultTreeUploadsApi.test.js tests/uploadRecoveryLifecycle.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): attach encrypted thumbnails and posters with Vault uploads`.

### Task 8: Verified derivative read + derivative-first tiles (T-DER-TILE, T-DER-CRYPTO)

**Files:** Create `src/lib/vaultDerivativeRead.js`, `tests/vaultDerivativeRead.test.js`; modify `src/screens/VaultTreeScreen.jsx`, `src/lib/vaultThumbScheduler.js`, `tests/vaultThumbScheduler.test.js`, `tests/vaultTreeScreen.test.js`.

- [ ] **Step 1 — RED:** envelope `contentIdB64` ≠ manifest `contentId` → `CONTENT_ID_MISMATCH` **before** any decrypt call (spy); tampered chunk → `INTEGRITY`; happy path renders from **one** chunk GET with no SW `openSession` and no original chunk request (request spy); ciphertext LRU bounded at configured bytes and page-memory only; derivative lane concurrency 6, original lane stays 4; chunk responses still `Cache-Control: no-store` (server test assertion in `tests/vaultTreeUploadsApi.test.js` or chunk route test); existing AAD vectors unchanged.
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN** + `node --test --test-concurrency=1 tests/vaultPreviewCancellation.test.js tests/vaultPreviewReliability.test.js tests/vaultMediaPreview.test.js`.
- [ ] **Step 5 — commit:** `feat(idea1): render Vault tiles from verified encrypted derivatives`.

### Task 9: Lazy thumb/poster backfill (T-BACKFILL, D-8)

**Files:** Create `src/lib/vaultDerivativeBackfill.js`, `tests/vaultDerivativeBackfill.test.js`; modify `src/lib/vaultImageThumb.js` (`returnBytes`), `src/screens/VaultTreeScreen.jsx`.

- [ ] **Step 1 — RED:** legacy node without previews: first display via existing path → bytes offered → one derivative upload + one `setNodePreviews` → next unlock renders from derivative (T-BACKFILL); backfill module never calls `fetchChunk`/`openSession` itself (spy — no extra original fetch); ≤ 1 concurrent; ≤ 50 per session; deferred while an interactive upload/download/modal playback is active; `canWrite()` false (flag off + v1 head) → nothing uploaded; motion/proxy kinds rejected by `offer` (P3/P4 only, D-8); rebase-dropped intent (file replaced) leaves derivative UNREFERENCED without error.
- [ ] **Step 2 — verify RED.**
- [ ] **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): backfill legacy Vault thumbnails and posters once`.

### Task 10: Corrupted derivative fallback and single regeneration (T-CORRUPT)

**Files:** `src/screens/VaultTreeScreen.jsx`, `src/lib/vaultDerivativeBackfill.js`, create `tests/vaultDerivativeCorrupt.test.js`.

- [ ] **Step 1 — RED:** each failure reason (`CONTENT_ID_MISMATCH`, `INTEGRITY`, `DECODE`, `BOUNDS`) → tile falls back to the original-derived path; exactly one regeneration offered per `(nodeId, kind)` per session; a second corruption in the same session does not loop; partial plaintext never rendered; diagnostic counter incremented.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): fall back and regenerate once on corrupted Vault derivatives`.

### Task 11: Derivative orphans hidden from recovery (§26)

**Files:** `src/lib/vaultUploadRecovery.js`, `src/components/vault/VaultRecoveryPanel.jsx`, `tests/uploadRecovery.test.js` (or `tests/vaultTreeUploadClient.test.js` orphan cases).

- [ ] **Step 1 — RED:** UNREFERENCED blob whose decrypted meta is `name: ''` and `type` in `{image/webp,image/jpeg,video/mp4,video/webm}` is excluded from the recovery list; a user file with an empty name but other type is still shown; nothing is deleted.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `fix(idea1): hide preview derivative orphans from Vault recovery`.

### Task 12: Lock/logout cleanup (T-LOCK)

**Files:** `src/lib/vaultUnlockedState.js`, `tests/vaultUnlockedState.test.js`, create `tests/vaultDerivativeLock.test.js`.

- [ ] **Step 1 — RED:** lock during generation / derivative fetch / derivative upload / backfill: all AbortControllers fire, local Object URLs revoked, ciphertext LRU cleared, backfill queue cleared, uncommitted derivative session never committed, view reaches locked state even if one disposer throws; `installStorageGuards` → zero reads/writes; SA-1/SA-SW-1 source scans include the four new modules.
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): release all derivative work and buffers on Vault lock`.

### Task 13: Account isolation and neutrality (T-NEUTRAL, §29)

**Files:** extend `tests/previewAccountNeutrality.test.js`; PG variant.

- [ ] **Step 1 — RED:** for ADMIN, EXISTING_USER, NEWLY_CREATED_USER: derivative upload+attach works identically; another class requesting the derivative chunk id → 404; identical image uploaded by two classes yields distinct blob ids/contentIds (no cross-account dedup); Admin has no override; source scan extended to `src/lib/vaultDerivative*.js`.
- [ ] **Step 2 — verify RED** (derivative cases fail before wiring in test). **Step 3 — GREEN.**
- [ ] **Step 4 — verify GREEN:** memory + `bash scripts/pg-integration-env.sh node --test --test-concurrency=1 tests/previewAccountNeutrality.test.js`.
- [ ] **Step 5 — commit:** `test(idea1): prove derivative isolation across account classes`.

### Task 14: Guardrails for D-3/D-4/D-5 + T-AUDIT-VOL + T-CHUNK-RULES

**Files:** Create `tests/previewGuardrails.test.js`; create `scripts/measure/vault-derivative-audit-volume.mjs`.

- [ ] **Step 1 — RED-first characterization:** assert `MIN_VAULT_PLAINTEXT_CHUNK_BYTES === 8 * MIB` and `DEFAULT_VAULT_PLAINTEXT_CHUNK_BYTES === 32 * MIB` (unchanged); chunk route response `Cache-Control: no-store`; one `VAULT_V2_READ` audit row per chunk-0 read (unchanged semantics); derivative uploads use the minimum. Expected GREEN immediately (guards pin approved decisions); prove falsifiability by temporarily editing a local copy of the constant (not committed).
- [ ] **Step 2:** audit-volume script: simulated unlock + grid of 60 tiles with derivatives → count audit rows; record in PR body (measurement only; no behaviour change).
- [ ] **Step 3 — commit:** `test(idea1): pin chunk, audit, and cache decisions for Vault derivatives`.

### Task 15: Diagnostics (§34)

**Files:** `src/lib/vaultPreviewDiagnostics.js`, `tests/vaultPreviewDiagnostics.test.js`.

- [ ] **Step 1 — RED:** counters for derivative hit/miss/corrupt, cold-fetch/decrypt/decode ms, generation ms per kind, backfill attempts/successes, chunk-0 reads per session; exported snapshot contains no names, node ids, blob ids, or plaintext (regex scan of serialized snapshot).
- [ ] **Step 2 — verify RED.** **Step 3 — GREEN.** **Step 4 — verify GREEN.**
- [ ] **Step 5 — commit:** `feat(idea1): add privacy-safe Vault derivative diagnostics`.

### Task 16: Regression and governance

- [ ] `npm test` vs baseline.
- [ ] Vault regression: `node --test --test-concurrency=1 tests/vault*.test.js tests/arbitraryTransferRegression.test.js tests/previewAccountNeutrality.test.js tests/previewGuardrails.test.js`.
- [ ] Normal Files regression: `node --test --test-concurrency=1 tests/media*.test.js tests/filesMediaTiles.test.js tests/filesPreviewRoute.test.js`.
- [ ] PG: `bash scripts/pg-integration-env.sh node --test --test-concurrency=1 tests/vaultTreePostgres.test.js tests/vaultTreeApi.test.js tests/previewAccountNeutrality.test.js`.
- [ ] `npm run build && git checkout -- dist`; `git diff --check`; policy validation (declare `server/routes/vaultTree.js`, `server/config/vaultPreviewFeatures.js` in PR as owned server paths; any `.env.example` documentation of `VAULT_MANIFEST_V2_WRITE` is a cross-scope path requiring `integration-review: yes`).
- [ ] Receipt; push.

### Task 17: Pre-enable re-measurement (G-ENABLE evidence)

- [ ] Re-run Task 1 harness with the real P2b writer (server flag on in a local instance, true v2 revisions). Compare against the Human-approved thresholds. Report `T_MAN_SIZE_POST_IMPL=PASS|FAIL`. FAIL → flag stays OFF; escalate.

## Rollback boundary

- Merged with flag OFF: fully reversible by revert (no v2 can be written).
- **After the Human enables the flag and any v2 manifest is written: one-way.** Rollback may only go to a build that reads v2 — a P2b build with the flag OFF (preferred; still writes v2 back for v2 heads, preserving entries) or a P2a build (read-only for v2 heads, Decision P2A-W). Never delete blobs, rewrite manifests, or purge.

## Human review gates

1. **G-THR** after Task 1 (threshold approval) — mandatory before Task 2.
2. **G-ENABLE** after Task 17: requires `P2A_ACCEPTED=YES`, `T_MAN_SIZE_POST_IMPL=PASS`, PR merged. The Human Owner alone sets `VAULT_MANIFEST_V2_WRITE=true` in Production.
3. Acceptance on ADMIN, EXISTING_USER, NEWLY_CREATED_USER, LAN and Remote: §37 H4 (tiles near Files responsiveness; warm immediate), H5 (second unlock uses derivatives), H6 (new-upload poster without consuming the original), H14 (lock mid-work), H15 (cross-account 404), H2 (arbitrary Vault upload/download still byte-exact).
