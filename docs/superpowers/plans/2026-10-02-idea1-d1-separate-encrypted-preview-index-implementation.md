# IDEA1 D-1 — Separate Encrypted Preview Index — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:executing-plans` to implement this plan task by task, in order. Steps use checkbox (`- [ ]`) syntax. Do **not** start any task until the Human Owner has merged this plan **and** separately authorized implementation. Every ⛔ marker is a hard stop that only a written Human decision can lift.

**Plan status:** IN PROGRESS — PR-A through PR-D are merged; PR-E G.1–G.3 and H.1–H.3 are complete (2026-10-03); I.1–I.3 are not started. `PRODUCTION_MUTATION_AUTHORIZED=NO`; Production writer enablement is blocked pending later gates.

**Revision 2 (2026-10-02, PR #280 review `APPROVE_WITH_REQUIRED_CHANGES`):** (1) server-enforced per-owner preview-index retained-storage budget (A.1, A.3, new C.7, new E.4, F.2, G.1–G.3, H.1, Stage 3); (2) Stage 1 requires PR-A **and** PR-B merged — no Production deployment between them; (3) client-declared superseded refs are advisory only and never deletion authority. Existing P3–P5 plans are stale for D-1. Task count 44 → 46.

**Revision 3 (2026-10-03, Human decision `D1_G2_PLAN_REVISION_OPTION_B_APPROVED`, PR #310 reviewed head `ab54092aacab1bde0122cd7a770176c813c0a086`):** G.2 required authority is PostgreSQL 1k/5k/10k × variants 2/3 (server/storage), Chrome 1k/5k/10k × 2/3 (browser), and exact Memory 1k × 2/3 (local parity/correctness): 14 required cells. Memory 5k/2, 5k/3, 10k/2, 10k/3 are `NOT_APPLICABLE_BY_HUMAN_APPROVED_PLAN_REVISION`, with their earlier `NOT_MEASURED` history preserved. The G.1 harness remains capable of the original full matrix; this changes G.2 gate applicability only. Evidence limitations in G.2 are accepted for this gate, not erased. No PREVIEW_INDEX_LIMIT, retained-byte budget, G.3/H/I, Production deployment, writer enablement, or merge is approved.

**HG-G decision (2026-10-03, Human `HG_G_APPROVED`, PR #310 reviewed head `89da7f84d7279871f6e10df5df3e6b78594e5ef8`):** Authorizes G.3 only, with the exact KEEP values and 8 GiB/owner retained budget recorded below. This supersedes Revision 3's *then-current* pending-approval state, not its G.2 evidence or exclusions. H/I, Production deployment, writer enablement and PR merge remain unauthorized.

**Goal:** Ship client-generated, client-encrypted thumb/poster derivatives for the Private Vault, referenced from a **separate owner-scoped, sharded, encrypted preview index** that is invisible to the main manifest, so tiles can render from small verified derivatives while the main manifest stays schema v1 with **zero** added bytes.

**Architecture:** One optional server-side index head per `(owner, treeId)` points at an encrypted **root catalog** (an ordinary V2 blob). The root maps opaque hash-prefix shards to encrypted **shard** blobs; each shard maps opaque `nodeId` → validated `vp1` thumb/poster entries pointing at encrypted **derivative** blobs. Every object reuses the existing V2 envelope (random DEK wrapped by KEK, AES-256-GCM, chunk AAD) unchanged. The server stores only opaque ids, lengths, lifecycle and CAS metadata. Index CAS is independent from main-head CAS; the reader's `sourceBlobRef` check against the **current** decrypted main node is the consistency bridge. The original file path stays the universal fallback.

**Tech stack:** Node 24, Express, PostgreSQL 15, `node:test`, jsdom, WebCrypto AES-GCM, existing V2 chunked upload/download clients, Chrome for browser evidence.

**Approved design:** `docs/superpowers/specs/2026-10-01-idea1-d1-separate-encrypted-preview-index-design.md` (PR #279, merged at `fff78feb7f7296a742794a31dffeb35a134a7660`). Section references below (`§n`) point at that spec.

**Base:** `origin/main` `fff78feb7f7296a742794a31dffeb35a134a7660`. Every implementation PR branches from the then-current `origin/main` (or a stacked dependency branch, declared per `AGENTS.md` §4).

---

## 0. Binding conditions (from the Human decision on PR #279)

These are inputs, not choices. A task that would violate any line is out of scope; stop and escalate.

```text
MAIN_MANIFEST_LINKAGE=NONE                    main manifest gets no preview/index field
MAIN_MANIFEST_SCHEMA_WRITE=1                  D-1 never writes a v2 main manifest
VAULT_MANIFEST_V2_UPGRADE=OFF_AND_UNUSED      not read, not set, not required by D-1
P2B_TASKS_2_TO_17=REJECTED                    never executed, never revived (no setNodePreviews, no attach-with-previews)
INDEX_SCOPE=OWNER + TREE_ID                   server resolves by authenticated owner and the main head's opaque treeId
CRYPTO=EXISTING_V2_ENVELOPE_UNCHANGED         no new AEAD, AAD layout, KDF or key hierarchy
SERVER_VAULT_PLAINTEXT=FORBIDDEN
SERVER_GENERATED_VAULT_DERIVATIVES=FORBIDDEN
PERSISTENT_DECRYPTED_VAULT_CACHE=FORBIDDEN    page memory only; no Cache API / IndexedDB / OPFS / localStorage
ORIGINALS=AUTHORITATIVE                       missing/corrupt/stale/unknown index or derivative => original path
DERIVATIVE_FAILURE_FAILS_ORIGINAL=NEVER
WRITER_CAPABILITY=VAULT_PREVIEW_INDEX_WRITE   env VAULT_PREVIEW_INDEX_WRITE_ENABLED, default false, server-served and server-enforced
IDX_SIZE_BEFORE_WRITER_ENABLE=MANDATORY       real 1k/5k/10k, Node + Chrome + PostgreSQL
SHARD_LIMITS=HG_G_APPROVED_KEEP               64 initial prefixes / 192 KiB decoded / 128 live; 256 KiB padding bucket remains provisional
INITIAL_DESTRUCTIVE_GC=FORBIDDEN              no DELETE, purge or physical removal of any index/derivative blob in D-1
VAULT_DESTRUCTIVE_PURGE_ENABLED=false         unchanged
PREVIEW_INDEX_STORAGE_BUDGET=SERVER_ENFORCED  per owner; counts committed INDEX_STAGED + INDEX_MANAGED ciphertext (root, shard, derivative)
BUDGET_SCOPE=PER_OWNER                        ordinary user files never count and are never blocked by it
BUDGET_VALUE=8589934592_B_PER_OWNER          HG-G approved 2026-10-03; runtime env still required; writer stays OFF
BUDGET_EXCEEDED=FAIL_CLOSED_FOR_PREVIEW_ONLY  reject new preview-index persistence; never touch main manifest, original upload, download, or existing index objects
SUPERSEDED_REF=ADVISORY_ONLY                  client-declared supersededBlobIds are bookkeeping/measurement rows
SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO       no current or future D-1 code may delete or purge a blob because it was declared superseded
STAGE_1_BUILD=PR_A_MERGED + PR_B_MERGED       no Production deployment between PR-A and PR-B
EXISTING_P3_P5_PLANS=STALE_FOR_D1_ARCHITECTURE  not executed; re-planned only after D1_THUMB_POSTER=CLOSED
REQUEST_PATTERN_LEAKAGE=ACCEPTED_DOCUMENTED   never claim zero additional leakage
MALICIOUS_SERVER_VALID_HEAD_REPLAY=ACCEPTED_INHERITED   never claim durable anti-rollback
WRITE_KINDS=thumb,poster (profile vp1)        no motion/proxy writer in D-1
```

Naming note: the Human handoff suggested the capability concept `VAULT_PREVIEW_INDEX_WRITE`. Repository convention for every Vault feature switch is an `_ENABLED` environment variable read by `server/config/vaultTreeLimits.js` and served as a camel-case flag through `GET /api/vault/tree/state` (`flags: { ...cfg.flags }`). The capability therefore ships as env `VAULT_PREVIEW_INDEX_WRITE_ENABLED` → flag `previewIndexWriteEnabled`. The concept name is unchanged.

## 1. Current source truth this plan is built on (verified at `fff78feb`)

| Fact | Where | Consequence for D-1 |
|---|---|---|
| Main manifest reads schema 1/2, writes 1; server `POST /revisions` accepts only `manifestSchemaVersion === 1` | `src/lib/vaultTreeManifest.js:22-23`, `server/routes/vaultTree.js:166` | D-1 touches neither. Pinned by regression tests (Task A.6, H.1). |
| Server flags are a fail-closed chain parsed once in `vaultTreeConfigFromEnv`; boot probes `TREE_TABLES` when schema flag is on; `/state` spreads `cfg.flags` to the client | `server/config/vaultTreeLimits.js`, `server/routes/vaultTree.js:122-137`, `server/app.js:41-44` | New flags join the same chain and are served automatically. Existing exact-shape config tests (CF-1) must be extended, not weakened. |
| `vault_tree_blob_state.lifecycle` CHECK allows only `UNREFERENCED, TREE_MANAGED, PURGE_PENDING, PURGED`; `/tree/blobs` maps a missing row to `UNREFERENCED` | `server/db/migrations/011_vault_tree_v1.sql:212-223`, `server/routes/vaultTree.js:370-386` | Index/derivative blobs must carry their own lifecycle **from commit time** or old clients/servers would list them as recoverable orphans. Migration 012 widens the CHECK with `INDEX_STAGED`, `INDEX_MANAGED`. |
| Client `listOrphanBlobs` offers every `UNREFERENCED` blob not referenced by the manifest, including empty-name and undecryptable ones | `src/lib/vaultTreeUpload.js:83-111`, `src/components/vault/VaultRecoveryPanel.jsx:63` | Server lifecycle keeps index blobs out of the `UNREFERENCED` list for **old** clients; new clients add authenticated reserved-metadata classification (Phase D). |
| Main `casHead` promotes attached blobs only from `UNREFERENCED`; anything else → `TREE_BLOB_STATE_CONFLICT` | `server/db/vaultTreeStore.js:284-360` | An old or malicious client cannot attach an `INDEX_*` blob as a user file. Pinned by test (Task D.3). |
| V2 upload family is one factory with modes `legacy`/`tree`; `tree` commit writes lifecycle `UNREFERENCED` inside the blob transaction via `withinCommit` | `server/routes/vaultUploads.js:132-560` | Add mode `previewIndex` that writes `INDEX_STAGED` in the same transaction; mounted under a write-gated router. |
| `GET /api/vault` returns **every** V1+V2 envelope of the owner on every unlock; the tree screen keys it by `formatVersion:id` | `server/routes/api.js:1682-1717`, `src/screens/VaultTreeScreen.jsx:632-636` | Retained index/derivative blobs (no GC in D-1) would grow every unlock response without bound. The new server must exclude `INDEX_*` blobs from `GET /api/vault` and `GET /tree/blobs`, and serve their envelopes through a bounded owner-scoped batch route. |
| V2 chunk read `GET /api/vault/blobs/:id/chunks/:index` is owner-scoped, `no-store`, and audits `VAULT_V2_READ` on chunk 0 | `server/routes/api.js:1863-1910` | Root/shard/derivative bytes reuse it unchanged; audit volume rises per derivative read and must be measured (IDX-AUDIT), never silently deduplicated. |
| `createVaultV2Envelope` encrypts `{name,type,plainSize}`; `uploadVaultFileChunked` takes a `File`, `plaintextChunkBytes` and `routeBase` | `src/lib/vaultChunkCrypto.js:198`, `src/lib/vaultChunkedUpload.js:111-125` | Index objects and derivatives upload as `File([bytes], '', { type: marker-or-mime })` through a new `routeBase`; no crypto change. |
| `downloadVaultV2({ kek, blob, sink })` decrypts meta with AAD then each chunk | `src/lib/vaultChunkedDownload.js:95` | Reused for root/shard/derivative reads with a bounded buffered sink. |
| Canonical JSON encoder/strict parser and power-of-two padding exist but are manifest-specific at the key-schema layer | `src/lib/vaultTreeCanonical.js` | Export the generic encode/parse halves (no byte change, golden fixtures pin it); the index codec supplies its own closed key schema. |
| `validatePreview` (v2 entry shape + `vp1` bounds) exists but is private | `src/lib/vaultTreeManifest.js:100-122`, `src/lib/vaultPreviewProfiles.js` | Export it unchanged as `validatePreviewEntry`; shard entries reuse it. |
| Thumb scheduler `load(key)` already returns `{ width, height, bytes, mime? }` encoded poster bytes (≤ 512 px) produced from bytes the tile path already decrypted | `src/screens/VaultTreeScreen.jsx:707-772`, `src/lib/vaultImageThumb.js:149` | Lazy backfill consumes exactly these bytes → `NO_EXTRA_ORIGINAL_FETCH` by construction. Derivative-first wraps `load` without changing the scheduler. |
| `createUnlockedVaultState` exposes `registerAbort/ObjectUrl/Key/Buffer/Disposer`; purge reasons include `MANUAL_LOCK, AUTO_LOCK, LOGOUT, SESSION_INVALIDATED, UNMOUNT, NAVIGATION, PAGE_HIDE` | `src/lib/vaultUnlockedState.js` | Every new cache/queue/controller registers here; no new lifecycle mechanism. |
| Drive runtime image copies only `server/` + `dist/`; server code cannot import `src/` | Dockerfile / prior P1 finding | Server never imports the client codec; server validation is opaque-only. |
| Production stage config is applied with per-SHA compose overlays under `IDEA1-AEGIS_Drive_LC/deploy/production/<task>/` and migrations by a superuser with `psql -v ON_ERROR_STOP=1` | `deploy/production/pr187/*.yml`, `011_vault_tree_v1.sql` header | D-1 Production stages follow the same Human-run mechanism from separate `deploy/` branches. |

No preview-index head, route, table, codec, writer, capability, or orphan classification exists in the repository today.

## 2. Conventions used by every task

All commands run from `IDEA1-AEGIS_Drive_LC/` in Git Bash unless stated. `$SCRATCH` is the executor's session scratchpad (never committed).

```bash
T='node --test --test-concurrency=1'                      # unit/integration (memory store)
# PostgreSQL (disposable, drive_app non-superuser; never Production):
#   AEGIS_PGTEST_PORT=55750 sh scripts/pg-integration-env.sh up > "$SCRATCH/pg.env"; chmod 600 "$SCRATCH/pg.env"
PGRUN() { ( set -a; . "$SCRATCH/pg.env"; set +a; node --test --test-concurrency=1 "$@" ); }
# One fresh database per PG test file (shared-DB carry-over is not a regression signal).
# Full suite (bounded; ~40 min; known ~100 pre-existing failures — diff names against the baseline):
FULL() { timeout --kill-after=30 5400 node --test --test-concurrency=1 "tests/**/*.test.js"; }
```

- **TDD loop per task:** write RED tests → run RED command and confirm the **named** failures (not a syntax/import error unrelated to the behavior) → minimal GREEN → GREEN command → affected regression command → commit.
- **Commits:** one focused conventional commit per task (`feat(idea1):`, `test(idea1):`, `fix(idea1):`, `docs(idea1):`), exact paths staged, `git diff --cached --check` clean. Never `git add .`.
- **dist:** may be built to verify, then restored (`git checkout -- dist`) before staging; never committed in a PR.
- **Source-shape tests:** `tests/vaultFilesUx.test.js` (MEDIA-05) and `tests/filesVaultPresentation.test.js` (MEDIA-HIGHRES-1) pin `VaultTreeScreen.jsx` text; run them whenever that screen changes.
- **Numbers:** every limit introduced is labelled `PROVISIONAL` in code comments and tests until Task G.3 records Human approval. No measured value is claimed before it is measured.
- **Maturity labels:** `PLANNED → IMPLEMENTED → VERIFIED (local) → DEPLOYED → ACCEPTED → CLOSED`. A task only ever reaches `VERIFIED`; deployment and acceptance are Human-gated stages (Phase J).

## 3. File map

| Action | Path (under `IDEA1-AEGIS_Drive_LC/` unless rooted) | Responsibility | Phase/PR |
|---|---|---|---|
| Create | `server/db/migrations/012_vault_preview_index_v1.sql` | additive tables + widened blob lifecycle CHECK + grants | A / PR-A |
| Modify | `server/db/schema.sql` | same DDL for new databases | A / PR-A |
| Modify | `server/config/vaultTreeLimits.js` | three new chained flags, provisional server limits, `PREVIEW_INDEX_TABLES`, `verifyPreviewIndexSchema` | A / PR-A |
| Modify | `server/index.js` | boot probe for preview-index schema | A / PR-A |
| Modify | `server/db/vaultTreeSchemaProbe.js` | probe new tables + lifecycle CHECK values | A / PR-A |
| Create | `server/db/vaultPreviewIndexStore.js` | owner-scoped head read, envelope/blob listing, retained-bytes accounting (A); CAS + budget enforcement (C) — memory + PG | A, C |
| Modify | `server/db/vaultTreeStore.js` | `BLOB_LIFECYCLES` += `INDEX_STAGED`, `INDEX_MANAGED`; `RECOVERABLE_BLOB_LIFECYCLES` | A / PR-A |
| Create | `server/routes/vaultPreviewIndex.js` | read gates, `GET /head`, `GET /envelopes`, `GET /blobs`; later `POST /head`, uploads router | A, C |
| Modify | `server/routes/api.js` | mount preview-index routers before `/vault/tree`; exclude `INDEX_*` from `GET /api/vault` | A / PR-A |
| Modify | `server/routes/vaultTree.js` | exclude `INDEX_*` from `GET /tree/blobs` | A / PR-A |
| Modify | `server/routes/vaultUploads.js` | factory mode `previewIndex` (commit → `INDEX_STAGED`; per-owner retained-storage budget at create + commit, C.7) | C / PR-C |
| Modify | `src/lib/vaultTreeApi.js` | `getPreviewIndexHead`, `getPreviewIndexEnvelopes`, `listPreviewIndexBlobs`, `casPreviewIndexHead` | A, C |
| Modify | `src/lib/vaultTreeCanonical.js` | export generic `canonicalEncodeValue` / `canonicalParseStrict` (no byte change) | B / PR-B |
| Modify | `src/lib/vaultTreeManifest.js` | export existing `validatePreview` as `validatePreviewEntry` (no behavior change) | B / PR-B |
| Create | `src/lib/vaultPreviewIndexConstants.js` | schema version, reserved markers, write kinds, `PREVIEW_INDEX_LIMITS` (PROVISIONAL), route bases | B / PR-B |
| Create | `src/lib/vaultPreviewIndexRouting.js` | nodeId → routing bits, prefix resolution, prefix-free validation | B / PR-B |
| Create | `src/lib/vaultPreviewIndexCodec.js` | encode/decode/validate root and shard | B / PR-B |
| Create | `src/lib/vaultPreviewIndexObject.js` | seal (pad + V2 upload) / open (contentId pre-check, marker, decrypt, unpad) | B / PR-B |
| Create | `src/lib/vaultPreviewIndexReader.js` | head → root → lazy shards; bindings; page-memory caches | B / PR-B |
| Create | `src/lib/vaultDerivativeRead.js` | verified derivative fetch/decrypt/signature/bounds | B / PR-B |
| Modify | `src/screens/VaultTreeScreen.jsx` | derivative-first `load` wrapper (B); writer/backfill wiring (E/F) | B, E, F |
| Create | `src/lib/vaultPreviewIndexMerge.js` | pure merge/rebase/split/prune | C / PR-C |
| Create | `src/lib/vaultPreviewIndexOrphans.js` | authenticated blob classification; read-only reachability report | D / PR-C |
| Modify | `src/lib/vaultTreeUpload.js`, `src/components/vault/VaultRecoveryPanel.jsx` | never offer reserved blobs; fail-closed empty-name recovery | D / PR-C |
| Create | `src/lib/vaultPreviewIndexWriter.js` | capability-gated queue: derivative upload → merge → seal → CAS → bounded retry | E / PR-D |
| Create | `src/lib/vaultDerivativeGenerate.js` | thumb/poster from local `File` | F / PR-D |
| Create | `src/lib/vaultDerivativeBackfill.js` | bounded lazy backfill from already-decrypted tile bytes | F / PR-D |
| Modify | `src/lib/vaultPreviewDiagnostics.js` | privacy-safe D-1 counters | F / PR-D |
| Create | `scripts/measure/vault-preview-index-size.mjs` | IDX-SIZE harness (codec-only in B; full matrix in G) | B, G |
| Create | `scripts/measure/vault-preview-index-audit-volume.mjs` | IDX-AUDIT volume harness | H / PR-E |
| Create | tests listed per task | | all |
| Modify (root, cross-scope) | `.env.example` | document the three flags, all default off | A / PR-A |
| Create (root, cross-scope) | `docs/superpowers/plans/2026-10-02-idea1-d1-separate-encrypted-preview-index-implementation.md` | this plan | plan PR |

No file under `gateway/`, `postgres/`, `shared/`, `HUB-AEGIS_Entry/`, IDEA2 or IDEA3 is expected to change. `postgres/init/01-run-app-init.sh` bind-mounts the IDEA1 `schema.sql`; it is not edited.

## 4. Interfaces (binding signatures; bodies are implementation detail)

### 4.1 Server

```js
// server/config/vaultTreeLimits.js — additions
//   VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE  requires VAULT_TREE_SCHEMA_AVAILABLE                (boot probes PREVIEW_INDEX_TABLES)
//   VAULT_PREVIEW_INDEX_READ_ENABLED      requires VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE and VAULT_MEDIA_PREVIEW_ENABLED
//   VAULT_PREVIEW_INDEX_WRITE_ENABLED     requires VAULT_PREVIEW_INDEX_READ_ENABLED          (= capability VAULT_PREVIEW_INDEX_WRITE)
flags.previewIndexSchemaAvailable: boolean   // default false
flags.previewIndexReadEnabled: boolean       // default false
flags.previewIndexWriteEnabled: boolean      // default false — never defaulted on anywhere
limits.maxPreviewIndexAttachPerCas: number   // env VAULT_PREVIEW_INDEX_MAX_ATTACH_PER_CAS, default 64, range 1..256 — PROVISIONAL
limits.maxPreviewIndexSupersededPerCas: number // env VAULT_PREVIEW_INDEX_MAX_SUPERSEDED_PER_CAS, default 64, 0..256 — PROVISIONAL
limits.maxPreviewIndexEnvelopeBatch: number  // env VAULT_PREVIEW_INDEX_MAX_ENVELOPE_BATCH, default 32, 1..128 — PROVISIONAL
limits.maxPreviewIndexRetainedBytesPerOwner: number | null
  // env VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER, integer bytes, range 1 MiB..64 GiB — PROVISIONAL / TO_BE_MEASURED.
  // No approved default exists: unset → null. VAULT_PREVIEW_INDEX_WRITE_ENABLED=true with null → boot throws (fail-closed).
  // HG-G approves the value; Task G.3 records it. Counted bytes = SUM(vault_v2_blobs.ciphertext_size) of the owner's
  // V2 blobs whose vault_tree_blob_state.lifecycle ∈ ('INDEX_STAGED','INDEX_MANAGED').
export const PREVIEW_INDEX_TABLES: readonly ['vault_preview_index_heads','vault_preview_index_generations','vault_preview_index_blob_refs']
export async function verifyPreviewIndexSchema(config, probe: () => Promise<{ missing: string[], lifecycleValuesOk: boolean }>)

// server/db/vaultTreeStore.js — additions
export const BLOB_LIFECYCLES  // ['UNREFERENCED','TREE_MANAGED','PURGE_PENDING','PURGED','INDEX_STAGED','INDEX_MANAGED']
export const RECOVERABLE_BLOB_LIFECYCLES  // ['UNREFERENCED']
export const PREVIEW_INDEX_LIFECYCLES     // ['INDEX_STAGED','INDEX_MANAGED']

// server/db/vaultPreviewIndexStore.js
export const INDEX_STORE_CODE  // { NOT_FOUND, TREE_STATE_CONFLICT, PREVIEW_INDEX_CONFLICT, PREVIEW_INDEX_IDEMPOTENCY_MISMATCH,
                               //   PREVIEW_INDEX_BLOB_STATE_CONFLICT, PREVIEW_INDEX_ROOT_MISMATCH, PREVIEW_INDEX_TREE_MISMATCH }
export async function getIndexHead(userId)
  : Promise<{ treeId, indexGeneration, rootBlobId, rootContentIdB64, updatedAt } | null>
export async function listIndexEnvelopes(userId, ids: string[])          // only owner blobs whose lifecycle ∈ PREVIEW_INDEX_LIFECYCLES
  : Promise<Array<PublicVaultV2Blob>>                                    // same shape as publicVaultV2Blob
export async function listIndexBlobs(userId, { after: string|null, limit: number })   // opaque ids + lifecycle + createdAt, paginated
  : Promise<{ blobs: Array<{ id, lifecycle, createdAt }>, next: string|null }>
export async function excludeIndexBlobIds(userId): Promise<Set<string>>  // V2 ids with lifecycle ∈ PREVIEW_INDEX_LIFECYCLES (inventory filter)
export async function getRetainedIndexBytes(userId, { client = null } = {}): Promise<number>
  // SUM of committed ciphertext of the owner's INDEX_STAGED + INDEX_MANAGED blobs; user files excluded by construction
export async function assertIndexBudgetWithinCommit(client, userId, { addBytes, maxBytes })
  : Promise<void>   // Phase C; called inside the previewIndex commit transaction AFTER locking the owner's vault_tree_state row
                    // FOR UPDATE; throws IndexBudgetExceeded (→ transaction rollback) when retained + addBytes > maxBytes
export async function casIndexHead(userId, {                              // Phase C
  expectedGeneration,        // 0 = "no head yet"
  expectedRootBlobId,        // null iff expectedGeneration === 0
  rootBlobId, rootContentIdB64,
  attachBlobIds,             // must include rootBlobId; every id lifecycle INDEX_STAGED and owned
  supersededBlobIds,         // SUPERSEDED_REF=ADVISORY_ONLY: client-declared, recorded as role='SUPERSEDED' rows for
                             // bookkeeping/measurement only; changes no lifecycle; is NEVER deletion or purge authority
                             // (no D-1 code reads these rows to mutate or delete anything); each must be INDEX_MANAGED
  idempotencyKey, requestDigest,
}): Promise<{ ok: true, replay: boolean, indexGeneration, rootBlobId }
          | { ok: false, code, current?: { indexGeneration, rootBlobId } | null }>
export async function __resetPreviewIndexForTests()

// server/routes/vaultPreviewIndex.js  (mounted: '/vault/tree/preview-index/uploads' then '/vault/tree/preview-index', both before '/vault/tree/uploads')
export const PREVIEW_INDEX_ERROR  // { PREVIEW_INDEX_DISABLED, PREVIEW_INDEX_WRITE_DISABLED, PREVIEW_INDEX_NOT_FOUND,
                                  //   PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED (507 on preview-index upload create/commit only),
                                  //   PREVIEW_INDEX_CONFLICT, PREVIEW_INDEX_IDEMPOTENCY_MISMATCH, PREVIEW_INDEX_BLOB_STATE_CONFLICT,
                                  //   PREVIEW_INDEX_ROOT_MISMATCH, TREE_STATE_CONFLICT, INVALID_INPUT }
export function requirePreviewIndexRead(req, res, next)   // 503 PREVIEW_INDEX_DISABLED unless schema+read flags
export function requirePreviewIndexWrite(req, res, next)  // 503 PREVIEW_INDEX_WRITE_DISABLED unless write flag
GET  /api/vault/tree/preview-index/head
     200 { treeId, indexGeneration, rootBlobRef: { formatVersion: 2, id }, rootContentIdB64 } | 404 PREVIEW_INDEX_NOT_FOUND
GET  /api/vault/tree/preview-index/envelopes?ids=<id>,<id>…   (≤ maxPreviewIndexEnvelopeBatch)  200 { blobs: [...] }
GET  /api/vault/tree/preview-index/blobs?after=<id>&limit=<n≤500>   200 { blobs: [{ id, lifecycle, createdAt }], next }
POST /api/vault/tree/preview-index/head      (Phase C; write-gated; audited VAULT_PREVIEW_INDEX_CAS)
     body { expectedGeneration, expectedRootBlobId, rootBlobId, rootContentIdB64, attachBlobIds, supersededBlobIds, idempotencyKey }
     200 { indexGeneration, rootBlobId } | 409 { code, currentGeneration, currentRootBlobId }
/api/vault/tree/preview-index/uploads/*      (Phase C; write-gated) — the V2 upload family, mode 'previewIndex'
// every response: Cache-Control: no-store; every 4xx/5xx: { error, code } with no echoed client values except opaque ids
```

### 4.2 Client

```js
// src/lib/vaultTreeApi.js — additions (transport only; no retry, cache or storage)
export async function getPreviewIndexHead(opts)         // → head | null   (404 PREVIEW_INDEX_NOT_FOUND and 503 PREVIEW_INDEX_DISABLED → null)
export async function getPreviewIndexEnvelopes(ids, opts) // → Array<V2 envelope>
export async function listPreviewIndexBlobs({ after, limit }, opts)
export async function casPreviewIndexHead(body, opts)   // TreeApiError on 409 carries data.currentGeneration/currentRootBlobId

// src/lib/vaultPreviewIndexConstants.js
export const PREVIEW_INDEX_SCHEMA_VERSION = 1
export const PREVIEW_INDEX_SCHEMA_VERSIONS_READ = Object.freeze([1])
export const INDEX_ROOT_MARKER  = 'application/vnd.aegis.vault-preview-index-root.v1'   // only ever inside encrypted V2 meta
export const INDEX_SHARD_MARKER = 'application/vnd.aegis.vault-preview-index-shard.v1'
export const D1_WRITE_KINDS = Object.freeze(['thumb', 'poster'])
export const D1_WRITE_PROFILE = 'vp1'
export const PREVIEW_INDEX_UPLOAD_ROUTE_BASE = '/api/vault/tree/preview-index/uploads'
export const PREVIEW_INDEX_LIMITS = Object.freeze({     // (KiB = 1024, MiB = 1024 * KiB) EVERY value PROVISIONAL / TO_BE_MEASURED until Task G.3
  initialPrefixBits: 6,            // 64 routing prefixes (spec §7 target)
  maxPrefixBits: 7,                // one split level → ≤ 128 live shards
  maxShards: 128,
  maxShardDecodedBytes: 192 * 1024,
  shardPaddingBuckets: [16 KiB, 32 KiB, 64 KiB, 128 KiB, 256 KiB],
  maxRootDecodedBytes: 16 * 1024 - 5,
  rootPaddingBuckets: [4 KiB, 8 KiB, 16 KiB],
  maxEntriesPerCas: 16, casMaxAttempts: 5, writeQueueMax: 64,
  backfillMaxPerSession: 50, backfillConcurrency: 1,
  derivativeLaneConcurrency: 6, ciphertextLruBytes: 32 MiB, maxLiveDecodedShards: 16,
  generationBudgetMs: 10_000,
})

// src/lib/vaultPreviewIndexRouting.js
export async function routingBits(nodeId: string): Promise<Uint8Array>   // SHA-256(UTF-8('AEGIS-VPI-ROUTE-v1:' + nodeId)), MSB-first
export function prefixOf(bits: Uint8Array, length: number): string      // '0'/'1' string
export function assertPrefixFree(prefixes: string[], { minBits, maxBits }): void   // throws IndexCodecError('BAD_PREFIX_SET')
export function resolveShardDescriptor(root, bits): ShardDescriptor | null          // descriptor whose prefix is a prefix of bits

// src/lib/vaultPreviewIndexCodec.js
export class IndexCodecError extends Error { code }   // UNKNOWN_VERSION | UNKNOWN_KEY | BAD_FIELD | BAD_PREFIX_SET | TREE_MISMATCH
                                                       // | GENERATION_MISMATCH | PREFIX_MISMATCH | LIMIT | DUPLICATE
export function encodeRoot(root): Uint8Array            // root = { schemaVersion, treeId, indexGeneration, createdAtClient, shards: [{ prefix, blobRef:{formatVersion:2,id}, contentId }] }
export function decodeRoot(bytes, { treeId, indexGeneration }): Root    // binds tree + generation; UNKNOWN_VERSION fails secure
export function encodeShard(shard): Uint8Array          // shard = { schemaVersion, treeId, prefix, entries: Map<nodeId, PreviewEntry[]> }
export function decodeShard(bytes, { treeId, prefix }): Shard          // binds tree + prefix; each nodeId must route under prefix
// PreviewEntry = the existing v2 preview entry shape, validated by validatePreviewEntry (vaultTreeManifest.js)

// src/lib/vaultPreviewIndexObject.js
export async function sealIndexObject({ kek, marker, plaintext, buckets, upload = uploadVaultFileChunked, signal })
  : Promise<{ blobRef: { formatVersion: 2, id }, contentId: string, paddedBytes: number, cipherBytes: number }>
export async function sealDerivative({ kek, bytes, mime, upload = uploadVaultFileChunked, signal })
  : Promise<{ blobRef: { formatVersion: 2, id }, contentId: string, plainSize: number }>
export async function openIndexObject({ kek, envelope, expected: { blobRef, contentId }, marker, maxPaddedBytes, fetchBytes, signal })
  : Promise<{ ok: true, plaintext: Uint8Array } | { ok: false, reason: 'MISSING'|'CONTENT_ID_MISMATCH'|'MARKER_MISMATCH'|'INTEGRITY'|'BOUNDS'|'ABORTED' }>

// src/lib/vaultPreviewIndexReader.js
export function createPreviewIndexReader({ kek, api, fetchBytes, unlockedState, limits = PREVIEW_INDEX_LIMITS, diagnostics })
  : { load(mainHead): Promise<{ status: 'ABSENT'|'DISABLED'|'READY'|'FAILED', reason? }>,
      lookup(node, kind, { signal }): Promise<PreviewEntry | null>,   // null for every failure mode
      snapshot(): { head, root },                                     // writer use only; never serialized
      clear(): void }

// src/lib/vaultDerivativeRead.js
export async function readDerivative({ kek, entry, envelopeOf, fetchBytes, signal, lru })
  : Promise<{ ok: true, bytes: Uint8Array, mime, width, height } | { ok: false, reason: 'MISSING'|'CONTENT_ID_MISMATCH'|'META_MISMATCH'|'INTEGRITY'|'SIGNATURE'|'BOUNDS'|'ABORTED' }>

// src/lib/vaultPreviewIndexMerge.js  (pure; no I/O)
export function applyUpserts({ shard, upserts, currentNodeOf }): { shard, applied: Upsert[], dropped: Array<{ upsert, reason: 'NODE_MISSING'|'STALE_SOURCE'|'EXISTING_VALID'|'BAD_KIND' }>, pruned: number }
export function planSplit(shard, { maxShardDecodedBytes, maxPrefixBits, encode }): { shards: Shard[] } | { overflow: true }
export function rebaseRoot({ latestRoot, changedShards: Shard[], treeId, nextGeneration, maxShards }): Root | { overflow: true }

// src/lib/vaultPreviewIndexOrphans.js
export const BLOB_CLASS = Object.freeze({ USER: 'USER', INDEX_ROOT: 'INDEX_ROOT', INDEX_SHARD: 'INDEX_SHARD', DERIVATIVE: 'DERIVATIVE', UNNAMED_USER: 'UNNAMED_USER', UNDECRYPTABLE: 'UNDECRYPTABLE' })
export function classifyDecryptedMeta(meta | null): BLOB_CLASS[keyof BLOB_CLASS]
export async function reachabilityReport({ reader, api, signal }): Promise<{ reachable: number, stagedUnreachable: number, managedUnreachable: number, generationsRetained: number }>   // counts only; read-only

// src/lib/vaultPreviewIndexWriter.js
export function createPreviewIndexWriter({ kek, api, reader, getMainHead, upload, unlockedState, writeAllowed: () => boolean, limits, diagnostics })
  : { offer(job: { nodeId, kind: 'thumb'|'poster', sourceBlobRef, bytes, mime, width, height }): 'QUEUED'|'DISABLED'|'REJECTED'|'FULL'|'BUDGET_EXHAUSTED',
      flush(): Promise<{ committed: number, dropped: number, failed: number, budgetExhausted: boolean }>,
      dispose(): void, stats(): object }
  // writeAllowed() false → offer() returns 'DISABLED' and performs NO network request
  // any PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED response latches a per-session circuit breaker: queue cleared, every later
  // offer() → 'BUDGET_EXHAUSTED' with NO network request until the next unlocked session; never throws to callers

// src/lib/vaultDerivativeGenerate.js
export async function generateThumbFromFile(file, { signal, env, budgetMs }): Promise<{ bytes, mime, width, height } | null>
export async function generatePosterFromFile(file, { signal, env, budgetMs }): Promise<{ bytes, mime, width, height } | null>

// src/lib/vaultDerivativeBackfill.js
export function createDerivativeBackfill({ writer, reader, limits, isDeferred: () => boolean, unlockedState })
  : { offerTileResult(node, kind, tileResult: { bytes, mime, width, height }): 'OFFERED'|'SKIPPED', clear(): void, stats(): object }
```

### 4.3 Data shapes (canonical, closed key sets)

```text
root  = { createdAtClient:int, indexGeneration:int≥1, schemaVersion:1, shards:[ { blobRef:{formatVersion:2,id:<48-hex>}, contentId:<24-char b64>, prefix:<'0'|'1'>{6..7} } ] (sorted by prefix, prefix-free, ≤ maxShards), treeId:<22-char id> }
shard = { entries:[ [ nodeId:<22-char id>, [ PreviewEntry (≤ 4, unique kind) ] ] ] (sorted unique nodeId; every nodeId routes under prefix), prefix, schemaVersion:1, treeId }
V2 meta of root/shard = { name:'', type: INDEX_ROOT_MARKER | INDEX_SHARD_MARKER, plainSize: paddedBytes }
V2 meta of derivative = { name:'', type: 'image/webp' | 'image/jpeg', plainSize }
```

The writer only ever creates `thumb`/`poster` entries with profile `vp1`. The reader validates every entry structurally with `validatePreviewEntry`; an unknown profile is ignored after structural validation; motion/proxy entries (never written by D-1) are ignored by the D-1 tile path.

---

## PHASE A — Baseline / compatibility foundation (PR-A)

Target deployment: `COMPATIBILITY_READER_ONLY`, `WRITER=OFF` — **only together with Phase B**. PR-A is reviewed and merged on its own, but it is **never deployed to Production alone**: Stage 1 requires PR-A **and** PR-B merged (§0 `STAGE_1_BUILD`). Nothing in Phase A can create an index.

### Task A.0 — Baseline capture

- **Depends on:** Human authorization to start implementation; refreshed `origin/main`.
- **Files:** none committed. Evidence in `$SCRATCH` and the PR body.
- [ ] **Step 1:** `git fetch origin`; worktree + branch `feat/idea1-preview-d1-a-compat-read` from `origin/main`; record base SHA; `npm ci`.
- [ ] **Step 2:** `FULL > "$SCRATCH/d1-baseline-full.txt" 2>&1`; extract failing test names to `$SCRATCH/d1-baseline-failures.txt`.
- [ ] **Step 3:** PG baseline: `PGRUN tests/vaultTreePostgres.test.js`, `PGRUN tests/vaultV2Postgres.test.js`, `PGRUN tests/vaultPostgres.test.js` (one fresh DB each) → record counts.
- [ ] **Step 4:** Record `node --version`, OS, Chrome version.
- **Acceptance:** baseline counts and failing-name list exist; every later "no regression" claim diffs **names** against this list.

### Task A.1 — Chained preview-index flags and provisional server limits

- **Depends on:** A.0.
- **Files:** Modify `server/config/vaultTreeLimits.js`; extend `tests/vaultTreeConfig.test.js`.
- **Interface:** §4.1 config additions.
- [ ] **RED:** (a) all three flags default `false` with an empty env; (b) each flag accepts only literal `'true'`/`'false'`, anything else throws; (c) chain: `VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true` without `VAULT_TREE_SCHEMA_AVAILABLE` throws; `READ` without `SCHEMA` or without `VAULT_MEDIA_PREVIEW_ENABLED` throws; `WRITE` without `READ` throws; (d) new limits default to 64/64/32 and reject out-of-range values; (e) storage budget: unset → `maxPreviewIndexRetainedBytesPerOwner === null`; a value below 1 MiB, above 64 GiB, or non-integer throws; `WRITE=true` with the budget unset throws at boot (fail-closed: the writer can never run unbudgeted); `WRITE=false` with the budget unset boots; (f) CF-1 default snapshot extended with the new flags/limits — every pre-existing key/value unchanged; (g) `vaultTreeConfigFromEnv` output is deep-frozen.
- [ ] **RED verify:** `$T tests/vaultTreeConfig.test.js` → new cases fail on missing keys.
- [ ] **GREEN:** add flags to `flags` and `chain`, limits via `readInteger`, export `PREVIEW_INDEX_TABLES` and `verifyPreviewIndexSchema` (mirrors `verifyTreeSchema`; also throws when `lifecycleValuesOk` is false).
- [ ] **GREEN verify:** `$T tests/vaultTreeConfig.test.js tests/vaultTreeApi.test.js tests/vaultTreeFence.test.js`.
- [ ] **Commit:** `feat(idea1): add default-off chained preview-index flags`.
- **Acceptance:** with no env change, `/state` flags gain three `false` values and nothing else changes.

### Task A.2 — Migration 012 (additive tables, widened lifecycle CHECK)

- **Depends on:** A.1.
- **Files:** Create `server/db/migrations/012_vault_preview_index_v1.sql`; modify `server/db/schema.sql`; create `tests/previewIndexMigration.test.js` (static SQL assertions run in memory mode; PG assertions gated by `TEST_DATABASE_URL`/`AEGIS_PGTEST_SUPER_URL`).
- **DDL contract:**
  - `vault_preview_index_heads(user_id BIGINT PK → users ON DELETE CASCADE, tree_id TEXT NOT NULL, index_generation BIGINT NOT NULL CHECK ≥ 1, root_blob_id TEXT NOT NULL, root_content_id_b64 TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.
  - `vault_preview_index_generations(user_id, index_generation, tree_id, base_generation BIGINT NOT NULL CHECK ≥ 0, root_blob_id, root_content_id_b64, idempotency_key TEXT NOT NULL, request_digest CHAR(64) NOT NULL, committed_at, superseded_at NULL, PK(user_id, index_generation), UNIQUE(user_id, idempotency_key))` + trigger: identity columns immutable; only `superseded_at` may change NULL → value once; `DELETE` forbidden unless the owner row is gone (cascade), mirroring `vault_tree_revisions_guard`.
  - `vault_preview_index_blob_refs(user_id, index_generation, blob_id TEXT, role TEXT CHECK (role IN ('ATTACHED','SUPERSEDED')), PK(user_id, index_generation, blob_id, role))` — no kind, prefix, node, MIME or name column.
  - Widen the lifecycle CHECK: drop the existing column CHECK on `vault_tree_blob_state.lifecycle` **by its actual name discovered from `pg_constraint`** inside a `DO` block (do not hard-code a guess), then `ADD CONSTRAINT vault_tree_blob_state_lifecycle_check CHECK (lifecycle IN ('UNREFERENCED','TREE_MANAGED','PURGE_PENDING','PURGED','INDEX_STAGED','INDEX_MANAGED'))`. No row is rewritten.
  - DML grants to `drive_app` guarded on role existence; no sequence; `BEGIN … COMMIT`; re-run is a no-op. Header comment states what the server learns (opaque ids, generations, sizes, timing) and that no column can hold a name/path/MIME/node/kind.
- [ ] **RED:** static: file exists, contains no `DROP TABLE`, `DELETE FROM`, `TRUNCATE`, `ALTER TABLE vault_v2`, `ALTER TABLE vault_blobs`, `ALTER TABLE vault_tree_revisions`; `schema.sql` contains the same three tables and six-value CHECK. PG (super URL): apply 011 then 012 twice → success; `drive_app` can `SELECT/INSERT/UPDATE` new tables but cannot `ALTER`/`DROP`; inserting lifecycle `INDEX_MANAGED` succeeds and `'BOGUS'` fails; existing rows unchanged byte-for-byte (checksum of `vault_tree_blob_state` before/after); generation trigger rejects identity update and delete.
- [ ] **RED verify:** `$T tests/previewIndexMigration.test.js` (static fails); `PGRUN tests/previewIndexMigration.test.js` (PG fails).
- [ ] **GREEN:** write 012 and mirror into `schema.sql`.
- [ ] **GREEN verify:** both commands above; `PGRUN tests/vaultTreePostgres.test.js` unchanged vs A.0.
- [ ] **Commit:** `feat(idea1): add additive preview-index migration`.
- **Acceptance:** purely additive except the CHECK widening; no existing value becomes invalid; down-migration intentionally absent (documented in header: rollback keeps tables, old server ignores them).

### Task A.3 — Store: lifecycle constants, head read, inventory exclusion helpers

- **Depends on:** A.2.
- **Files:** Modify `server/db/vaultTreeStore.js`; create `server/db/vaultPreviewIndexStore.js`; create `tests/previewIndexStore.test.js` + `tests/helpers/previewIndexStoreSpec.mjs` (same spec runs memory and PG, like `vaultTreeStoreSpec.mjs`).
- **Interface:** §4.1 store (read/accounting half only: `getIndexHead`, `listIndexEnvelopes`, `listIndexBlobs`, `excludeIndexBlobIds`, `getRetainedIndexBytes`, `__resetPreviewIndexForTests`). Enforcement (`assertIndexBudgetWithinCommit`) is Task C.7.
- [ ] **RED:** `BLOB_LIFECYCLES` has six values with the original four first and unchanged; `upsertBlobState` accepts `INDEX_STAGED`; `getIndexHead` → `null` for a fresh owner and for another owner's row; seeded head round-trips; `listIndexEnvelopes` returns only the caller's `INDEX_*` blobs (a user blob id or another owner's id is silently absent); `listIndexBlobs` paginates stably with `limit ≤ 500`; `excludeIndexBlobIds` returns exactly the caller's `INDEX_*` ids; `getRetainedIndexBytes` = exact sum of `ciphertext_size` over the caller's `INDEX_STAGED` + `INDEX_MANAGED` V2 blobs, 0 for a fresh owner, ignores `UNREFERENCED`/`TREE_MANAGED` user blobs and every other owner's blobs; every function requires `userId`.
- [ ] **RED verify:** `$T tests/previewIndexStore.test.js`; `PGRUN tests/previewIndexStore.test.js`.
- [ ] **GREEN:** implement; test-only seed helper `__seedIndexHeadForTests` (never routed).
- [ ] **GREEN verify:** above + `$T tests/vaultTreeStore.test.js`.
- [ ] **Commit:** `feat(idea1): add owner-scoped preview-index read store`.

### Task A.4 — Read-only routes, inventory exclusion, mounting

- **Depends on:** A.3.
- **Files:** Create `server/routes/vaultPreviewIndex.js`; modify `server/routes/api.js` (mount + `GET /api/vault` exclusion), `server/routes/vaultTree.js` (`/blobs` exclusion), `server/index.js` + `server/db/vaultTreeSchemaProbe.js` (boot probe); create `tests/previewIndexApi.test.js`; extend `tests/vaultTreeSourceScan.test.js`.
- [ ] **RED (route):** flags off → `GET /head` 503 `PREVIEW_INDEX_DISABLED` (after auth; unauthenticated → 401); tree protocol off → existing 503 `TREE_PROTOCOL_DISABLED`; owner not `TREE_V1` → 409 `TREE_STATE_CONFLICT`; no index → 404 `PREVIEW_INDEX_NOT_FOUND`; seeded head whose `treeId` ≠ main head `treeId` → 404; seeded valid head → 200 exact shape; another owner's head → 404 (never 403); `envelopes` rejects > batch limit and malformed ids with 400 without echoing input; `blobs` paginates; every response `Cache-Control: no-store`; no `POST`/`PUT`/`DELETE` route exists under `/preview-index` in this PR (405/404).
- [ ] **RED (inventory):** with a seeded `INDEX_MANAGED` V2 blob, `GET /api/vault` and `GET /api/vault/tree/blobs` omit it; with no `INDEX_*` rows both responses are byte-identical to the A.0 fixtures; `?lifecycle=UNREFERENCED` never returns `INDEX_*`.
- [ ] **RED (boot):** `VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true` with a DB lacking 012 → boot throws naming the missing table; with 012 → boots.
- [ ] **RED (scan):** `vaultPreviewIndex.js` imports nothing from `src/` (SRV-NOIMPORT-1 extended).
- [ ] **RED verify:** `$T tests/previewIndexApi.test.js tests/vaultTreeSourceScan.test.js tests/vaultApi.test.js`; `PGRUN tests/previewIndexApi.test.js`.
- [ ] **GREEN:** router with `requireAuth, requireTreeProtocol, requirePreviewIndexRead`; mount `'/vault/tree/preview-index'` before `'/vault/tree/uploads'`; inventory filter via `excludeIndexBlobIds` applied to V2 entries only (V1 untouched).
- [ ] **GREEN verify:** above + `$T tests/vaultTreeApi.test.js tests/vaultV2Api.test.js tests/vaultTreeUploadsApi.test.js tests/vaultInventory.test.js`.
- [ ] **Commit:** `feat(idea1): serve the optional preview-index head read-only`.

### Task A.5 — Client API wrappers (read)

- **Depends on:** A.4.
- **Files:** Modify `src/lib/vaultTreeApi.js`; extend `tests/vaultTreeApiClient.test.js`.
- [ ] **RED:** `getPreviewIndexHead` → `null` on 404 `PREVIEW_INDEX_NOT_FOUND` and on 503 `PREVIEW_INDEX_DISABLED`; returns the body on 200; throws `TreeApiError` on 409/500/network; `getPreviewIndexEnvelopes([])` makes **no** request; ids are URL-encoded and batched by the caller only; no storage access (`installStorageGuards`).
- [ ] **RED verify / GREEN verify:** `$T tests/vaultTreeApiClient.test.js`.
- [ ] **Commit:** `feat(idea1): add preview-index read API client`.

### Task A.6 — Compatibility regression and PR-A closeout

- **Depends on:** A.1–A.5.
- **Files:** Modify `.env.example` (document three flags commented, defaults off, with "apply migration 012 first"); create `tests/previewIndexCompatA.test.js`.
- [ ] **RED:** (a) with all D-1 flags off, every existing tree route response shape is unchanged (snapshot vs A.0 fixtures); (b) main `POST /revisions` still rejects `manifestSchemaVersion: 2`; (c) client `MANIFEST_SCHEMA_VERSION_WRITE === 1`; (d) no client module references `VAULT_MANIFEST_V2_UPGRADE`, `setNodePreviews` or `manifestV2Upgrade` (source scan over `src/` and `server/`); (e) main `casHead` with an `INDEX_MANAGED` blob in `attachBlobIds` → 409 `TREE_BLOB_STATE_CONFLICT`.
- [ ] **Verify:** `$T tests/previewIndexCompatA.test.js`; full regression `FULL > "$SCRATCH/d1-a-full.txt"` → diff failing names vs A.0 (0 new); PG suites from A.0 + `PGRUN tests/previewIndexMigration.test.js tests/previewIndexStore.test.js tests/previewIndexApi.test.js`; `npm run build && git checkout -- dist`.
- [ ] **Commit:** `test(idea1): pin preview-index compatibility boundary`.
- **PR-A closeout:** canonical status update, one final receipt, PR body declaring `.env.example` and `docs/superpowers/**` (if touched) as cross-scope with `integration-review: yes`. Stop for Human review/merge (**HG-A**). Merging PR-A authorizes **no** deployment: PR-A is not deployed to Production until PR-B is also merged (Stage 1).

---

## PHASE B — Index data model / crypto / reader (PR-B)

No writer. With no index in any environment, every lookup returns `null` and tiles use the existing path.

### Task B.1 — Export generic canonical helpers and the preview-entry validator

- **Depends on:** PR-A merged.
- **Files:** Modify `src/lib/vaultTreeCanonical.js`, `src/lib/vaultTreeManifest.js`; extend `tests/vaultTreeCanonical.test.js`, `tests/vaultTreeManifestV2.test.js`.
- [ ] **RED:** `canonicalEncodeValue(value, { maxJsonDepth, maxDecodedBytes })` and `canonicalParseStrict(bytes, { maxJsonDepth, maxDecodedBytes })` exist; `canonicalEncode(manifest)` bytes for the v1 golden fixture (`tests/helpers/vaultManifestV1GoldenFixture.mjs`) and v2 fixtures are unchanged; strict parser still rejects duplicate keys, whitespace, unsafe numbers, `__proto__`; `validatePreviewEntry` is exported and behaves exactly as the former private `validatePreview` on the existing v2 test vectors.
- [ ] **RED verify / GREEN verify:** `$T tests/vaultTreeCanonical.test.js tests/vaultTreeManifestV2.test.js tests/vaultTreeManifest.test.js tests/vaultTreeManifestProperty.test.js`.
- [ ] **Commit:** `refactor(idea1): expose generic canonical codec and preview entry validator`.

### Task B.2 — Constants and provisional limits

- **Depends on:** B.1.
- **Files:** Create `src/lib/vaultPreviewIndexConstants.js`, `tests/previewIndexConstants.test.js`.
- [ ] **RED:** values as §4.2; frozen; markers never equal any MIME in `src/lib/preview/formats.js`; `D1_WRITE_KINDS` is exactly `thumb,poster`; every limit key appears in a `PROVISIONAL_KEYS` list the test asserts is complete (so G.3 must touch the test to approve a value).
- [ ] **Verify:** `$T tests/previewIndexConstants.test.js`. **Commit:** `feat(idea1): add provisional preview-index constants`.

### Task B.3 — Shard routing

- **Depends on:** B.2.
- **Files:** Create `src/lib/vaultPreviewIndexRouting.js`, `tests/previewIndexRouting.test.js`.
- [ ] **RED:** `routingBits` is deterministic, 32 bytes, domain-separated (differs from plain SHA-256 of the id); `prefixOf(bits, 6)` matches known vectors; `assertPrefixFree` rejects duplicates, nested prefixes (`'010101'` with `'0101010'`), lengths outside `[6,7]`, non-binary chars, unsorted input; `resolveShardDescriptor` returns the unique covering descriptor or `null` for an uncovered (sparse) prefix; uniformity sanity: 10,000 random 22-char ids over 64 prefixes → max bucket ≤ 2× mean (statistical bound documented as a sanity check, not a capacity claim).
- [ ] **Verify:** `$T tests/previewIndexRouting.test.js`. **Commit:** `feat(idea1): route preview-index entries by hashed node id`.

### Task B.4 — Root codec

- **Depends on:** B.3.
- **Files:** Create `src/lib/vaultPreviewIndexCodec.js` (root half), `tests/previewIndexCodec.test.js`.
- [ ] **RED:** round-trip; canonical bytes stable (golden vector committed in the test); `decodeRoot` with `schemaVersion: 2` → `UNKNOWN_VERSION`; unknown key at any level → `UNKNOWN_KEY`; `treeId` ≠ expected → `TREE_MISMATCH`; `indexGeneration` ≠ head → `GENERATION_MISMATCH`; shard descriptors unsorted/nested/duplicate → `BAD_PREFIX_SET`; > `maxShards` → `LIMIT`; encoded > `maxRootDecodedBytes` → `LIMIT` (encoder refuses to produce it); `blobRef.formatVersion !== 2` or bad contentId → `BAD_FIELD`.
- [ ] **Verify:** `$T tests/previewIndexCodec.test.js`. **Commit:** `feat(idea1): encode and validate the preview-index root catalog`.

### Task B.5 — Shard codec

- **Depends on:** B.4.
- **Files:** Extend `src/lib/vaultPreviewIndexCodec.js`, `tests/previewIndexCodec.test.js`.
- [ ] **RED:** round-trip with `Map` entries (encoder sorts by nodeId); duplicate nodeId → `DUPLICATE`; duplicate kind within a node → `DUPLICATE`; a nodeId that does not route under `prefix` → `PREFIX_MISMATCH`; `treeId`/`prefix` binding mismatch → `TREE_MISMATCH`/`PREFIX_MISMATCH`; each entry validated by `validatePreviewEntry` (bad mime, out-of-bounds dims, `sourceBlobRef` malformed → `BAD_FIELD`); unknown profile `vp9` decodes and is retained structurally; > `maxShardDecodedBytes` → `LIMIT` on encode; unknown schema → `UNKNOWN_VERSION`.
- [ ] **Verify:** `$T tests/previewIndexCodec.test.js`. **Commit:** `feat(idea1): encode and validate preview-index shards`.

### Task B.6 — Index object seal/open over the unchanged V2 envelope

- **Depends on:** B.5.
- **Files:** Create `src/lib/vaultPreviewIndexObject.js`, `tests/previewIndexObject.test.js` (uses `tests/helpers/vaultTreeFakeServer.mjs` extended with a preview-index upload route that behaves like the tree upload family).
- [ ] **RED:** `sealIndexObject` pads to the smallest bucket, uploads exactly one chunk (`plaintextChunkBytes` = server min), via `PREVIEW_INDEX_UPLOAD_ROUTE_BASE`; captured create body has only the strict `CREATE_KEYS`; no request body/header/URL contains the plaintext, the marker string, a nodeId, or a prefix (byte-substring scan); decrypted meta is `{ name: '', type: marker, plainSize }`; two seals of identical plaintext produce different `wrappedDekB64`/`contentIdB64`. `openIndexObject`: envelope `contentIdB64` ≠ expected → `CONTENT_ID_MISMATCH` with **zero** decrypt calls (spy) and zero chunk fetches; wrong KEK → `INTEGRITY`, no plaintext returned; tampered chunk → `INTEGRITY`; marker mismatch (shard opened as root, or user file) → `MARKER_MISMATCH`; padded size > `maxPaddedBytes` → `BOUNDS` before fetch; abort → `ABORTED`; padding corruption → `INTEGRITY`. `sealDerivative` meta is `{ name:'', type:mime, plainSize }` and rejects mimes outside `image/webp|image/jpeg`.
- [ ] **Verify:** `$T tests/previewIndexObject.test.js tests/vaultChunkCrypto.test.js tests/vaultChunkedUploadClient.test.js tests/vaultChunkedDownloadClient.test.js`. **Commit:** `feat(idea1): seal and open preview-index objects as V2 blobs`.

### Task B.7 — Reader (head → root → lazy shards)

- **Depends on:** B.6.
- **Files:** Create `src/lib/vaultPreviewIndexReader.js`, `tests/previewIndexReader.test.js`.
- [ ] **RED:** head `null` → `ABSENT`, zero further requests; flag-off 503 → `DISABLED`; head `treeId` ≠ main head `treeId` → `FAILED`, lookups `null`; root fetched once, envelope fetched through `getPreviewIndexEnvelopes` (batched ≤ limit); lookups for 60 visible nodes fetch only the distinct covering shards, coalesced (concurrent lookups for the same prefix share one fetch); decoded-shard cache ≤ `maxLiveDecodedShards` (LRU), ciphertext LRU ≤ `ciphertextLruBytes`; `lookup` returns `null` when: node trashed/purge-pending (`effectiveState`), node not a file, `entry.sourceBlobRef` ≠ current `node.blobRef` (stale), kind not in `D1_WRITE_KINDS`, unknown profile, root/shard corrupt (each `openIndexObject` failure reason), shard `UNKNOWN_VERSION`; a corrupt shard does not poison other shards; a second `load` with a newer head generation replaces caches; an older generation than the last seen in this page session → `FAILED` (in-memory continuity check only; no durable anti-rollback claim); `clear()` empties every cache and aborts in-flight fetches; reader registers its disposer and controllers on `unlockedState`; purge mid-fetch → no continuation writes to caches; no storage API touched.
- [ ] **Verify:** `$T tests/previewIndexReader.test.js`. **Commit:** `feat(idea1): read the encrypted preview index lazily with source binding`.

### Task B.8 — Verified derivative read

- **Depends on:** B.7.
- **Files:** Create `src/lib/vaultDerivativeRead.js`, `tests/vaultDerivativeRead.test.js`.
- [ ] **RED:** contentId mismatch → `CONTENT_ID_MISMATCH` before any decrypt (spy); meta `name !== ''` or `type !== entry.mime` → `META_MISMATCH`; tampered chunk → `INTEGRITY`; decrypted bytes whose magic is not JPEG/WebP (including SVG/HTML/XML bodies) → `SIGNATURE`; `plainSize`/dims > `vp1` bounds → `BOUNDS`; happy path performs exactly one envelope lookup and one chunk GET, and **no** request for the original blob; abort → `ABORTED`; partial plaintext never returned.
- [ ] **Verify:** `$T tests/vaultDerivativeRead.test.js`. **Commit:** `feat(idea1): verify encrypted preview derivatives before use`.

### Task B.9 — Derivative-first tiles behind the read flag

- **Depends on:** B.8.
- **Files:** Modify `src/screens/VaultTreeScreen.jsx`; create `tests/previewIndexTiles.test.js` (jsdom harness `tests/helpers/vaultScreenHarness.js`).
- [ ] **RED:** `treeState.flags.previewIndexReadEnabled` false → zero preview-index requests and the scheduler `load` path is byte-identical in behavior (request log equals baseline); flag true + no index → one `GET /preview-index/head`, then the existing path; flag true + valid index entry → tile renders from the derivative, **no** original chunk GET and no preview-session open for that node; each derivative failure reason → existing original path, Download/Open still available; derivative object URLs are registered on `unlockedState`; lane concurrency for derivative reads ≤ `derivativeLaneConcurrency` and does not reduce the original lane (`maxConcurrentJobs` stays 4).
- [ ] **Verify:** `$T tests/previewIndexTiles.test.js tests/vaultTreeScreen.test.js tests/vaultThumbScheduler.test.js tests/vaultFilesUx.test.js tests/filesVaultPresentation.test.js tests/vaultMediaPreview.test.js tests/vaultPreviewCancellation.test.js`.
- [ ] **Commit:** `feat(idea1): render Vault tiles from verified index derivatives first`.

### Task B.10 — IDX-SIZE codec-only probe (non-gating early signal)

- **Depends on:** B.5, B.6.
- **Files:** Create `scripts/measure/vault-preview-index-size.mjs` (mode `--mode codec`).
- [ ] **Step 1:** generate synthetic indexes for 994/4,994/9,994 files (total nodes 1k/5k/10k including root + 5 folders, matching PR #278 fixtures) with random 22-char nodeIds, variants `2` (thumb+poster) and `3` (thumb+poster+third-entry stress shape using a structurally valid unknown-profile entry so no motion writer is implied); real encoder, real padding, real V2 seal (Node WebCrypto, in-memory upload stub).
- [ ] **Step 2:** output JSON: per variant canonical/padded/cipher bytes for root and every shard, largest/average shard, live shard count with the provisional split rule, simulated split count, main-manifest bytes (unchanged fixture, proves 0 delta), ≥ 20 runs encode/encrypt/decrypt/decode p50/p95.
- [ ] **Step 3:** `node scripts/measure/vault-preview-index-size.mjs --mode codec --nodes 1000,5000,10000 --variants 2,3 --runs 20 --out "$SCRATCH/idx-size-codec.json"` (exclusive-create output).
- [ ] **Commit:** `test(idea1): add preview-index size probe (codec mode)`.
- **Acceptance:** numbers are recorded in the PR body labelled `CODEC_ONLY_PRELIMINARY` — **not** the IDX-SIZE gate. If the 10k/2-entry largest shard already exceeds the provisional 192 KiB cap or live shards exceed 128, stop and report to the Human Owner before Phase C (limits are provisional; re-planning shard parameters is a Human decision).
- **PR-B closeout:** regression (`FULL` name diff vs A.0), canonical status, receipt, Draft → Human review (**HG-B**). After PR-A **and** PR-B are merged, `origin/main` is the Stage 1 candidate build (Phase J); no earlier Production deployment exists.

---

## PHASE C — Owner-scoped index CAS (PR-C)

All write routes are gated by `VAULT_PREVIEW_INDEX_WRITE_ENABLED` (default false) on the server. Deployed with the flag off, no index can be created.

### Task C.1 — CAS store (memory + PostgreSQL)

- **Depends on:** PR-B merged (or stacked on PR-B branch, declared).
- **Files:** Extend `server/db/vaultPreviewIndexStore.js`, `tests/helpers/previewIndexStoreSpec.mjs`, `tests/previewIndexStore.test.js`.
- **Transaction (PG), in order:** lock owner's `vault_tree_state` row `FOR UPDATE`; require `TREE_V1` and an existing main head (else `TREE_STATE_CONFLICT`); idempotency lookup by `(user_id, idempotency_key)` → same `request_digest` ⇒ `{ ok:true, replay:true, … }`, different ⇒ `PREVIEW_INDEX_IDEMPOTENCY_MISMATCH`; lock index head `FOR UPDATE`; `expectedGeneration`/`expectedRootBlobId` must equal current (`0`/`null` ⇔ no head) else `PREVIEW_INDEX_CONFLICT` + current; `rootBlobId ∈ attachBlobIds`; every attach id is the caller's V2 blob with lifecycle `INDEX_STAGED` (`FOR UPDATE`) else `PREVIEW_INDEX_BLOB_STATE_CONFLICT` and full rollback; root blob `content_id_b64 === rootContentIdB64` else `PREVIEW_INDEX_ROOT_MISMATCH`; every superseded id is the caller's `INDEX_MANAGED` blob else `PREVIEW_INDEX_BLOB_STATE_CONFLICT`; head `tree_id` := main head `tree_id`; insert generation row (`index_generation = expected + 1`), `ATTACHED`/`SUPERSEDED` ref rows, set prior generation `superseded_at`; promote attach `INDEX_STAGED → INDEX_MANAGED`; upsert head. **No row or blob is ever deleted.** Superseded ids are `SUPERSEDED_REF=ADVISORY_ONLY`: the CAS writes a `role='SUPERSEDED'` ref row and nothing else — no lifecycle transition, no purge candidate, no retention timer, and they do not reduce the retained-storage budget (a superseded blob is still counted because it still exists).
- [ ] **RED:** every branch above, in both modes, via the shared spec; first creation (0/null); declaring ids in `supersededBlobIds` leaves their lifecycle `INDEX_MANAGED`, their V2 rows and ciphertext files present, no `vault_tree_purge_candidates` row, and `getRetainedIndexBytes` unchanged; replay returns identical result and changes nothing; cross-owner blob in attach → blob-state conflict (no existence leak); a user `UNREFERENCED`/`TREE_MANAGED` blob in attach → conflict; root not in attach → `INVALID` (route-level) / store conflict; memory critical section has no `await`.
- [ ] **RED verify / GREEN verify:** `$T tests/previewIndexStore.test.js`; `PGRUN tests/previewIndexStore.test.js`.
- [ ] **Commit:** `feat(idea1): add atomic owner-scoped preview-index CAS store`.

### Task C.2 — PostgreSQL concurrency proof

- **Depends on:** C.1.
- **Files:** Create `tests/previewIndexCasPostgres.test.js` (PG only; skipped with explicit reason when `TEST_DATABASE_URL` unset — the evidence run must show 0 skips).
- [ ] **RED:** two concurrent CAS on the same expected generation → exactly one success, the other `PREVIEW_INDEX_CONFLICT` with current = winner; 20 parallel attempts → generations strictly sequential, no gaps, one row per generation; concurrent main `casHead` and index CAS for the same owner both succeed when each is individually valid (independent heads, serialized by the owner lock, no deadlock within a 5 s statement timeout); lost-response simulation: commit then drop the response, resend identical body/key → replay success; resend with same key different body → mismatch; a blob promoted by one CAS cannot be attached again by a concurrent CAS.
- [ ] **Verify:** `PGRUN tests/previewIndexCasPostgres.test.js`. **Commit:** `test(idea1): prove preview-index CAS serialization on PostgreSQL`.

### Task C.3 — CAS route

- **Depends on:** C.2.
- **Files:** Extend `server/routes/vaultPreviewIndex.js`, `tests/previewIndexApi.test.js`.
- [ ] **RED:** write flag off → 503 `PREVIEW_INDEX_WRITE_DISABLED` even with a valid body (and no store call — spy); strict keys (unknown key → 400, no echo); id/key/contentId syntax; `attachBlobIds.length > maxPreviewIndexAttachPerCas` → 400; `supersededBlobIds.length >` limit → 400; `requestDigest` computed server-side as SHA-256 of the canonical JSON of the validated body with sorted id arrays; 409 bodies carry `currentGeneration`/`currentRootBlobId` only; audit `VAULT_PREVIEW_INDEX_CAS` once per non-replay success, `DENIED` on failure, target hash of the root id, no other fields; CSRF required (existing `/api` chain); cross-owner → 404/409 without existence leak.
- [ ] **Verify:** `$T tests/previewIndexApi.test.js`; `PGRUN tests/previewIndexApi.test.js`. **Commit:** `feat(idea1): expose write-gated preview-index CAS`.

### Task C.4 — Preview-index upload family (`INDEX_STAGED` at commit)

- **Depends on:** C.3.
- **Files:** Modify `server/routes/vaultUploads.js` (mode `previewIndex`), extend `server/routes/vaultPreviewIndex.js` (export `vaultPreviewIndexUploadsRouter`), `server/routes/api.js` (mount `'/vault/tree/preview-index/uploads'` first); create `tests/previewIndexUploads.test.js`.
- [ ] **RED:** write flag off → every mutating upload call 503 (limits/status/cancel remain safe reads); owner not `TREE_V1` → 409; strict create body (`CREATE_KEYS` only); commit writes `INDEX_STAGED` **in the same transaction** as the blob row (fault-injected failure leaves neither — reuse `__failNextBlobStateUpsertForTests`); commit response adds `lifecycle: 'INDEX_STAGED'`; the blob is absent from `GET /api/vault`, from `/tree/blobs?lifecycle=UNREFERENCED`, and present in `/preview-index/envelopes`; chunk size/concurrency/retry limits identical to the `tree` family (TU-SAME snapshot); existing `legacy`/`tree` modes byte-identical.
- [ ] **Verify:** `$T tests/previewIndexUploads.test.js tests/vaultTreeUploadsApi.test.js tests/vaultV2Api.test.js tests/uploadRecoveryLifecycle.test.js`; `PGRUN tests/previewIndexUploads.test.js`. **Commit:** `feat(idea1): stage preview-index uploads outside the recoverable orphan set`.

### Task C.5 — Client CAS wrapper

- **Depends on:** C.4.
- **Files:** Extend `src/lib/vaultTreeApi.js`, `tests/vaultTreeApiClient.test.js`.
- [ ] **RED:** body passes through exactly; 409 → `TreeApiError` with `code` and `data.currentGeneration`; network failure surfaces as `TRANSPORT`-class error (caller decides replay). **Commit:** `feat(idea1): add preview-index CAS client`.

### Task C.6 — Pure merge, rebase, split, prune

- **Depends on:** B.5 (pure; may run in parallel with C.1–C.5).
- **Files:** Create `src/lib/vaultPreviewIndexMerge.js`, `tests/previewIndexMerge.test.js` (+ property test with seeded RNG).
- [ ] **RED:** disjoint upserts from two writers on the same shard both survive rebase; disjoint shards both survive root rebase; same node/kind: existing entry whose `sourceBlobRef` equals the current node `blobRef` wins (`EXISTING_VALID`, ours dropped — no churn); existing stale entry is replaced; upsert for a node missing from the current main manifest → `NODE_MISSING`; upsert whose `sourceBlobRef` ≠ current → `STALE_SOURCE`; non-D-1 kind → `BAD_KIND`; prune removes entries of nodes absent from the main manifest or with mismatched source (trashed nodes are **kept** for restore); `planSplit` splits at `maxShardDecodedBytes` into `prefix+'0'`/`prefix+'1'` with every entry routed correctly; at `maxPrefixBits` → `{ overflow: true }` (caller skips, never truncates); `rebaseRoot` when the other writer split a prefix we changed → our upserts re-applied to the correct child shard; > `maxShards` → `{ overflow: true }`; timestamps never decide a winner.
- [ ] **Verify:** `$T tests/previewIndexMerge.test.js`. **Commit:** `feat(idea1): merge preview-index changes without last-writer-wins`.

### Task C.7 — Server-enforced per-owner retained-storage budget (circuit breaker)

- **Depends on:** C.4 (upload family), A.1 (budget config), A.3 (`getRetainedIndexBytes`).
- **Owner/PR:** PR-C.
- **Files:** Modify `server/routes/vaultUploads.js` (mode `previewIndex` only), `server/db/vaultPreviewIndexStore.js` (`assertIndexBudgetWithinCommit`, memory + PG); create `tests/previewIndexStorageBudget.test.js` (memory + PG) and `tests/previewIndexStorageBudgetPostgres.test.js` (PG concurrency; explicit skip reason when `TEST_DATABASE_URL` unset, evidence run must show 0 skips).
- **Enforcement points (both server-side; the client is never trusted for this):**
  1. **Create (early reject, advisory):** `POST /preview-index/uploads` → if `getRetainedIndexBytes(owner) + declared ciphertextSize > maxPreviewIndexRetainedBytesPerOwner` → 507 `PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED` before any byte is staged.
  2. **Commit (authoritative):** inside the existing `finishVaultV2Commit` transaction via `withinCommit` for mode `previewIndex`: lock the owner's `vault_tree_state` row `FOR UPDATE` (the same serialization point as main and index CAS), compute retained bytes, and if `retained + session.ciphertextSize > max` throw `IndexBudgetExceeded` → the whole transaction rolls back (no blob row, no lifecycle row). The route then answers 507 `PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED` and discards **only the uncommitted staged upload** through the existing cancel/abort path (the same cleanup a cancelled upload already gets) — no committed blob, index object, or user file is touched. Otherwise write `INDEX_STAGED` in the same transaction as today.
  - Counted: every committed `INDEX_STAGED` and `INDEX_MANAGED` V2 blob of the owner (root, shard, derivative, including ones that lost CAS and superseded ones). Not counted: `UNREFERENCED`/`TREE_MANAGED` user blobs, V1 blobs, uncommitted upload sessions (bounded by the existing session TTL cleanup).
  - Boundary rule: `retained + new ≤ max` succeeds; `> max` is rejected.
  - Legacy `legacy` and `tree` upload families never consult the budget.
- [ ] **RED (memory + PG via shared spec):**
  - below budget: commit succeeds, lifecycle `INDEX_STAGED`, retained bytes grow by the blob's ciphertext size;
  - exactly at boundary: a blob that makes `retained + new == max` succeeds;
  - next blob exceeding: `retained + new == max + 1` → 507 at create (declared size) and, when forced past create (budget lowered between create and commit), 507 at commit with no blob row, no lifecycle row, staged bytes discarded;
  - another owner: owner B at budget does not affect owner A, and vice versa;
  - user files unaffected: with owner's preview budget exhausted, `/api/vault/tree/uploads` (original upload) and main `POST /head` attach still succeed; `GET /api/vault/blobs/:id/chunks/:i` downloads still succeed;
  - no deletion: after rejection, every previously committed `INDEX_*` blob, its V2 row, and its ciphertext file still exist; request/SQL log shows no `DELETE` against blob, lifecycle, generation, ref, or V2 tables and no purge-candidate insert;
  - main manifest untouched: no revision/head change caused by a rejection;
  - CAS-loss growth bounded: repeated "upload root/shard then lose CAS" loops stop at the budget (every lost-CAS blob stays counted);
  - write flag off: create still 503 `PREVIEW_INDEX_WRITE_DISABLED` (flag check precedes budget check).
- [ ] **RED (PG concurrency):** owner at `max − S` with 10 parallel commits of size `S` → exactly one succeeds, nine get 507, final retained bytes `≤ max`; mixed parallel commits from two owners each respect only their own budget; parallel index CAS + preview commit for one owner do not deadlock (5 s statement timeout).
- [ ] **RED verify:** `$T tests/previewIndexStorageBudget.test.js`; `PGRUN tests/previewIndexStorageBudget.test.js tests/previewIndexStorageBudgetPostgres.test.js` → fail on missing enforcement.
- [ ] **GREEN:** implement both enforcement points; error body `{ error, code }` only (no byte counts echoed beyond the code, to avoid turning the route into a usage oracle for anything but the owner's own preview data).
- [ ] **GREEN verify:** above + `$T tests/previewIndexUploads.test.js tests/vaultTreeUploadsApi.test.js tests/vaultV2Api.test.js`.
- [ ] **Commit:** `feat(idea1): enforce a per-owner preview-index storage budget`.
- **Acceptance:** persistent preview-index storage per owner is bounded by a server-enforced value without any deletion; budget exhaustion can only stop new preview persistence.

---

## PHASE D — Lifecycle / orphan classification (PR-C, continued)

`INITIAL_DESTRUCTIVE_GC=FORBIDDEN`. Nothing in this phase deletes, purges, or schedules deletion.

### Task D.1 — Authenticated blob classification

- **Depends on:** B.2.
- **Files:** Create `src/lib/vaultPreviewIndexOrphans.js` (classification half), `tests/previewIndexOrphans.test.js`.
- [ ] **RED:** `classifyDecryptedMeta`: `{name:'', type:INDEX_ROOT_MARKER}` → `INDEX_ROOT`; shard marker → `INDEX_SHARD`; `{name:'', type:'image/jpeg'|'image/webp'}` → `DERIVATIVE`; `{name:'', type:<anything else>}` → `UNNAMED_USER`; non-empty name with a marker type → `USER` (a user file is never hidden because of its type); `null` (undecryptable) → `UNDECRYPTABLE`; classification ignores every server-supplied field.
- [ ] **Commit:** `feat(idea1): classify reserved preview blobs from authenticated metadata`.

### Task D.2 — Recovery UI never offers reserved blobs; empty-name recovery fails closed

- **Depends on:** D.1, C.4.
- **Files:** Modify `src/lib/vaultTreeUpload.js` (`listOrphanBlobs`), `src/components/vault/VaultRecoveryPanel.jsx`; extend `tests/vaultTreeRecoveryUi.test.js`, `tests/vaultUploadRecovery.test.js`.
- [ ] **RED:** `UNREFERENCED` blobs classified `INDEX_ROOT|INDEX_SHARD|DERIVATIVE` are excluded and counted in a `reservedHidden` number (no ids/names surfaced); `UNNAMED_USER` is listed but its Recover action requires a non-empty user-entered name (no default from meta); `UNDECRYPTABLE` stays listed as today but cannot be recovered without an explicit name; a server row with lifecycle `INDEX_*` is never requested (filter stays `UNREFERENCED`); nothing is deleted and no DELETE request is ever issued (request log).
- [ ] **Verify:** `$T tests/vaultTreeRecoveryUi.test.js tests/vaultUploadRecovery.test.js tests/uploadRecovery.test.js tests/vaultTreeUploadClient.test.js`. **Commit:** `fix(idea1): keep preview-index blobs out of Vault recovery`.

### Task D.3 — Server-side lifecycle guards pinned

- **Depends on:** C.4.
- **Files:** Create `tests/previewIndexLifecycleGuards.test.js` (memory + PG).
- [ ] **RED-first characterization (expected GREEN once C.4 lands):** main `casHead` attach of `INDEX_STAGED`/`INDEX_MANAGED` → `TREE_BLOB_STATE_CONFLICT`; legacy `DELETE /api/vault/blobs/:id` remains fenced (426) for `TREE_V1` owners; `VAULT_DESTRUCTIVE_PURGE_ENABLED` default false and `purgeBlobIds` still `TREE_PURGE_NOT_SUPPORTED`; no route in `vaultPreviewIndex.js` handles `DELETE`; no store function in `vaultPreviewIndexStore.js` issues `DELETE` against blob, generation, ref, or V2 tables (source scan of SQL strings); `SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO`: no server or client module reads `role = 'SUPERSEDED'` rows (or `supersededBlobIds`) to drive any lifecycle change, purge candidate, deletion, or storage-file removal (source scan over `server/` and `src/` — the only allowed readers are the read-only reachability report and measurement scripts); a CAS declaring every prior shard/root as superseded leaves all of them present and `INDEX_MANAGED`; falsifiability shown once by a local, uncommitted mutation (record in PR body).
- [ ] **Verify:** `$T tests/previewIndexLifecycleGuards.test.js`; `PGRUN tests/previewIndexLifecycleGuards.test.js`. **Commit:** `test(idea1): pin non-destructive preview-index lifecycle`.

### Task D.4 — Read-only reachability report and retention policy

- **Depends on:** D.1, B.7.
- **Files:** Extend `src/lib/vaultPreviewIndexOrphans.js`, `tests/previewIndexOrphans.test.js`.
- [ ] **RED:** reachable set = current root + its shards + their derivatives; report counts `stagedUnreachable` (upload succeeded, CAS lost/failed) and `managedUnreachable` (superseded generations' blobs) using `listPreviewIndexBlobs` pagination; retained generations counted from server generations (no client deletion); report contains counts only (no ids/names) and never issues a mutating request; runs only on explicit diagnostics invocation, never on unlock.
- **Retention policy (documented in module header, enforced by D.3 and C.7):** every generation and every `INDEX_*` blob is retained in D-1. Growth is bounded **only** by the server-enforced per-owner retained-storage budget (C.7); when it is reached, new preview persistence stops and tiles use originals. Client-declared superseded refs are advisory bookkeeping and never deletion authority. Any physical deletion requires a separate future architecture + plan + Human gate **HG-GC** that **independently** proves reachability and retention safety (it may not rely on client-declared superseded refs as authority) with recovery and rollback evidence. HG-GC is outside D-1.
- [ ] **Commit:** `feat(idea1): report preview-index reachability without deleting anything`.
- **PR-C closeout:** PG evidence (C.2 and C.7 concurrency with 0 skips), regression name diff, canonical status, receipt; integration review required (DB/CAS/storage budget) (**HG-C**).

---

## PHASE E — Writer capability, default OFF (PR-D)

### Task E.1 — Capability plumbing and inert-when-off writer shell

- **Depends on:** PR-C merged.
- **Files:** Create `src/lib/vaultPreviewIndexWriter.js` (shell), `tests/previewIndexWriterOff.test.js`.
- [ ] **RED:** `writeAllowed` derives **only** from `treeState.flags.previewIndexWriteEnabled === true` (never from local storage, query string, role, or build constant); when false, `offer()` returns `'DISABLED'`, enqueues nothing, and performs zero network calls; `flush()` resolves `{committed:0}` with zero calls; changing the flag requires a fresh `/state` (no client toggle); no reference to `VAULT_MANIFEST_V2_UPGRADE`.
- [ ] **Commit:** `feat(idea1): add default-off preview-index writer capability`.

### Task E.2 — Writer core

- **Depends on:** E.1, C.5, C.6, B.6, B.7.
- **Files:** Extend `src/lib/vaultPreviewIndexWriter.js`; create `tests/previewIndexWriter.test.js`.
- **Algorithm per batch (≤ `maxEntriesPerCas`):** validate each job against `vp1` bounds and `D1_WRITE_KINDS` → `sealDerivative` each → read latest head/root (reader snapshot refreshed) and latest main head (`getMainHead`) → load affected shards → `applyUpserts` (+prune) → `planSplit` → `sealIndexObject` changed shards → `rebaseRoot` → seal root → `casPreviewIndexHead` with new idempotency key → on 409: refetch and repeat from "read latest" up to `casMaxAttempts`; on transport loss: resend the **identical** body and key once, then refetch head and compare root id; attach list = new derivatives + new shards + root (≤ server limit, else split batch); superseded list = replaced shard/root ids.
- [ ] **RED:** happy path from empty index (generation 0 → 1); disjoint concurrent writers both land after rebase; same node/kind race keeps one valid entry; stale source dropped and its derivative left `INDEX_STAGED` (classified, not deleted); main manifest changes the node's `blobRef` between derivative upload and CAS → entry dropped; overflow → job skipped with counter, never truncation; conflict exhaustion → fail soft, counters, no exception to callers; lock/purge mid-batch → no further requests, no CAS after purge (mutation token check); every request body scanned for plaintext names/MIME/nodeIds/prefixes (none outside ciphertext); total requests per single-job batch recorded for IDX-SIZE.
- [ ] **Verify:** `$T tests/previewIndexWriter.test.js tests/previewIndexMerge.test.js`. **Commit:** `feat(idea1): write thumb and poster entries through the independent index CAS`.

### Task E.3 — Writer-OFF negative control (end-to-end)

- **Depends on:** E.2, F.2, F.3 (run after Phase F wiring; listed here because it is the Phase E acceptance proof).
- **Files:** Extend `tests/previewIndexWriterOff.test.js` (jsdom screen harness + fake server with request log).
- [ ] **RED/GREEN:** with server flags `READ=true, WRITE=false`: upload 5 images + 2 videos, browse, open tiles, rename, move, trash, restore, lock, unlock → request log contains **zero** calls to `/preview-index/uploads*` and `POST /preview-index/head`, zero derivative/root/shard blobs created, upload results identical in shape to baseline; same with `READ=false`; server-side: a direct `POST /preview-index/head` or upload create with `WRITE=false` → 503 (from C.3/C.4).
- [ ] **Commit:** `test(idea1): prove the preview-index writer is inert when disabled`.

### Task E.4 — Writer fail-soft on storage-budget exhaustion

- **Depends on:** E.2, C.7, C.5. **Owner/PR:** PR-D.
- **Files:** Extend `src/lib/vaultPreviewIndexWriter.js`, `src/lib/vaultDerivativeBackfill.js` (once F.3 exists; otherwise its test lands with F.3), `src/lib/vaultPreviewDiagnostics.js`; create `tests/previewIndexWriterBudget.test.js`.
- [ ] **RED:** fake server answers 507 `PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED` at derivative create, at shard/root create, and at commit (three cases): the batch ends with `flush()` → `{ budgetExhausted: true }`, no exception reaches the caller; the circuit breaker latches for the unlocked session — subsequent `offer()` returns `'BUDGET_EXHAUSTED'` and issues **zero** requests; queued jobs are cleared; backfill stops offering; no CAS is attempted with a partial attach list; no DELETE/cancel of any committed blob is issued (request log); tiles keep rendering via existing index entries or the original path; diagnostics record reason `BUDGET_EXHAUSTED` as a counter only (no ids, sizes, names); a new unlocked session starts with the breaker reset but the server still decides (first request again 507 → latch again, one request only).
- [ ] **Verify:** `$T tests/previewIndexWriterBudget.test.js tests/previewIndexWriter.test.js`. **Commit:** `feat(idea1): stop preview writes fail-soft when the storage budget is exhausted`.

---

## PHASE F — Thumb / poster generation (PR-D)

### Task F.1 — Generation from the local File

- **Depends on:** B.2.
- **Files:** Create `src/lib/vaultDerivativeGenerate.js`, `tests/vaultDerivativeGenerate.test.js`.
- [ ] **RED (injected decode/encode doubles; jsdom has no canvas):** images: decode via `createImageBitmap` respecting existing admission/pixel limits (`imageNormalMaxDecodedPixels`), long edge ≤ 512, bytes ≤ 256 KiB (one lower-quality retry then `null`), WebP when the env can encode it else JPEG; videos: local object URL from the `File`, seek via existing `vaultVideoDom` helpers, URL revoked in `finally`; budget `generationBudgetMs` → `null` + abort; unsupported/undecodable/SVG/HTML → `null` (never throws); never reads from the network.
- [ ] **Verify:** `$T tests/vaultDerivativeGenerate.test.js tests/vaultImageThumb.test.js tests/vaultVideoDom.test.js`. **Commit:** `feat(idea1): generate Vault thumbs and posters from the local file`.

### Task F.2 — Upload flow: original first, derivative after success

- **Depends on:** F.1, E.2.
- **Files:** Modify `src/screens/VaultTreeScreen.jsx` (`runVaultUpload` post-reconcile hook only; `uploadTreeFile` unchanged); create `tests/previewIndexUploadFlow.test.js`.
- [ ] **RED:** writer ON: derivative generation starts only after `uploadTreeFile` returned `ok` **and** `reconcileVaultAfterUpload` resolved; `res` returned to the drawer is identical to today (same object shape, same timing contract — derivative work is queued, not awaited); generation/upload/CAS failure never changes the upload result or announcement; with the owner's preview budget exhausted (server 507 on every preview-index create) the original upload still completes, attaches, reconciles and announces success exactly as today; `attach-conflict`/cancel/pause → no derivative work; writer OFF → no generation at all (no decode cost); bounded: at most `backfillConcurrency` generation jobs, paused while `activeUploadsRef.current > 0`.
- [ ] **Verify:** `$T tests/previewIndexUploadFlow.test.js tests/vaultTreeUploadClient.test.js tests/vaultTreeScreen.test.js tests/vaultFilesUx.test.js tests/filesVaultPresentation.test.js`. **Commit:** `feat(idea1): queue encrypted previews after a successful Vault upload`.

### Task F.3 — Lazy backfill from already-decrypted tile bytes

- **Depends on:** E.2, B.9.
- **Files:** Create `src/lib/vaultDerivativeBackfill.js`, `tests/previewIndexBackfill.test.js`; modify `src/screens/VaultTreeScreen.jsx` (offer the existing `load` result).
- [ ] **RED:** a tile rendered via the original path with no index entry offers its `{bytes,width,height,mime}` exactly once per `(nodeId, kind, sourceBlobRef)` per session; module never calls `fetchChunk`, `downloadVaultV2`, `openPreviewSession`, or `apiFetchBytes` (spy) — `NO_EXTRA_ORIGINAL_FETCH`; ≤ `backfillMaxPerSession` per unlocked session; ≤ 1 concurrent; deferred while an interactive upload, download, or modal playback is active; bytes outside `vp1` bounds or wrong signature → skipped (no re-encode); writer OFF → `'SKIPPED'`; failure retries only in a later unlocked session.
- [ ] **Commit:** `feat(idea1): backfill thumbs and posters from bytes the tile already decrypted`.

### Task F.4 — Lock / logout / pagehide cleanup

- **Depends on:** F.2, F.3, B.7.
- **Files:** Extend `tests/vaultUnlockedState.test.js`; create `tests/previewIndexLock.test.js`.
- [ ] **RED:** for each purge reason (`MANUAL_LOCK, AUTO_LOCK, LOGOUT, SESSION_INVALIDATED, UNMOUNT, NAVIGATION, PAGE_HIDE`) during: index head fetch, shard fetch, derivative read, generation, derivative upload, CAS: every controller aborts, reader caches/LRU cleared, decoded shard buffers released, writer queue and backfill queue cleared, every derivative object URL revoked, no CAS issued after purge, uncommitted uploads never committed, the screen reaches locked state even if one disposer throws; `installStorageGuards` sees zero storage reads/writes; source scan (`vaultTreeSourceScan`) forbids `localStorage|sessionStorage|indexedDB|caches|navigator.storage|console.` in all new D-1 client modules.
- [ ] **Verify:** `$T tests/previewIndexLock.test.js tests/vaultUnlockedState.test.js tests/vaultStorageAbsence.test.js tests/vaultTreeSourceScan.test.js`. **Commit:** `feat(idea1): release all preview-index work and plaintext on Vault lock`.

### Task F.5 — Privacy-safe diagnostics

- **Depends on:** F.3.
- **Files:** Modify `src/lib/vaultPreviewDiagnostics.js`; extend `tests/vaultPreviewDiagnostics.test.js`.
- [ ] **RED:** counters: index head status, root/shard fetch and decode ms, derivative hit/miss/each failure reason, writer committed/dropped(reason)/failed, CAS attempts/conflicts, backfill offered/skipped; serialized snapshot matches none of: names, nodeIds (22-char id regex), blob ids (48-hex regex), contentIds, prefixes, MIME of user files.
- [ ] **Commit:** `feat(idea1): add privacy-safe preview-index diagnostics`.
- **PR-D closeout:** E.3 negative control evidence, regression name diff, canonical status, receipt (**HG-D**). Writer remains **OFF** in every environment.

---

## PHASE G — IDX-SIZE / capacity gate (PR-E) ⛔ HARD STOP

### Task G.1 — Full IDX-SIZE matrix harness

- **Depends on:** PR-D merged (real writer path exists).
- **Files:** Extend `scripts/measure/vault-preview-index-size.mjs` (modes `codec`, `e2e`, `--server memory|pg`, `--browser <Chrome path>`).
- **Harness capability:** total nodes 1k/5k/10k (994/4,994/9,994 files + 6 folders/root) × variants `2` (thumb+poster) and `3` (stress shape) × ≥ 20 runs. Local disposable server only (memory store and PG via `pg-integration-env.sh`); exclusive-create outputs; never a Production endpoint or credential. Revision 3 narrows the **G.2 required cells**, not this harness capability.
- **Metrics (every cell filled, units explicit):**

| Group | Metric |
|---|---|
| Main manifest | canonical bytes, bucket, cipher bytes, headroom vs 16,777,232 B — must equal the no-index fixture (0 delta) |
| Root | canonical / padded / cipher bytes |
| Shards | canonical / padded / cipher bytes: largest, average, p95; live shard count; split count during incremental build |
| Storage | total encrypted index bytes (current generation); **superseded index bytes retained per entry written** (no GC in D-1); `GET /api/vault` inventory bytes with and without the `INDEX_*` exclusion |
| Retained-budget inputs | per owner: retained `INDEX_STAGED` + `INDEX_MANAGED` bytes (`getRetainedIndexBytes`) after (a) a full initial build of 2/3 entries per file, (b) one full lazy backfill, (c) N simulated sessions of steady-state churn (re-uploads/replacements at a stated rate), (d) injected CAS-loss loops; growth curve retained-bytes vs entries written; bytes at which budget enforcement triggers for candidate budgets; C.7 commit-time budget check p50/p95 on PG at 1k/5k/10k |
| Requests | requests for a cold visible tile set of 60 (head + root + envelope batches + distinct shards + derivatives) |
| Time (Node, Chrome) | encode / encrypt / decrypt / decode p50/p95 for root and largest shard |
| Server (memory, PG) | index CAS p50/p95; upload of shard/root/derivative p50/p95 |
| End-to-end | single-entry and full-batch mutation (generate stub → seal derivative → read latest → merge → seal shard+root → upload → CAS) p50/p95 — the first real end-to-end mutation p95 for D-1 |
| Audit | audit rows per cold 60-tile view and per batch write (feeds H.3) |

- [ ] **Commit:** `test(idea1): measure preview-index capacity end to end`.

### Task G.2 — Run the matrix and STOP

- [ ] Required authority after written Human decision `D1_G2_PLAN_REVISION_OPTION_B_APPROVED`: PostgreSQL 1k/5k/10k × variants 2/3 is the high-scale server/storage authority; Chrome 1k/5k/10k × variants 2/3 is the high-scale browser authority; the exact, unmodified Memory backend 1k × variants 2/3 is the local parity/correctness authority. Each required cell uses ≥20 runs where specified in G.1. PostgreSQL runs require `pg-integration-env.sh up` and explicit local confirmation; every run uses exclusive-create scratch output, never a Production endpoint or credential.
- [ ] Memory 5k/2, 5k/3, 10k/2 and 10k/3 are **not required gate cells**. Record each exactly as `NOT_APPLICABLE_BY_HUMAN_APPROVED_PLAN_REVISION`, cite this Human approval, retain the earlier `NOT_MEASURED` history, and never represent an excluded cell as measured. Do not replace the exact Memory backend with an optimized test backend.
- [ ] Fill the PR and canonical evidence tables with measured numbers only. Every one of the 14 required environment cells must have applicable values, explicit units, run counts/method, and 0 B main-manifest delta. Preserve raw hashes and provenance; disclose every failed/missing required value. Every threshold below is a **non-binding proposal**:

| Proposed criterion (NOT APPROVED) | Rationale |
|---|---|
| Main manifest delta = 0 B at 1k/5k/10k | binding condition, not a threshold |
| 10k/2-entry largest shard decoded ≤ provisional cap; live shards ≤ provisional cap | validates or replaces §7 targets |
| Cold 60-tile request count and p95 latency on LAN within a Human-chosen budget | spec §19 |
| Superseded bytes per written entry within a Human-chosen storage budget, given GC is forbidden | retained storage grows until the per-owner budget stops it |
| `maxPreviewIndexRetainedBytesPerOwner` = a Human-chosen value derived from the retained-budget inputs (e.g. full 10k build + backfill + stated churn headroom) — **value deliberately not proposed here** | REQUIRED CHANGE 1: server-enforced bound without GC; HG-G must approve an explicit number |
| End-to-end mutation p95 within a Human-chosen budget | spec §19 / G-THR lesson |

- [ ] Disclose accepted G.2 limitations: timing raw files retain aggregate p50/p95, not all samples; raw JSON lacks embedded Git SHA and deterministic seed (preserve hashes and exact provenance; future tooling should record both); server latencies are **LOCAL LOOPBACK**, not LAN (live LAN timing belongs to later Production Stage acceptance); Memory raw JSON's PostgreSQL-lock phrase is a hard-coded label error and must not be rewritten; Memory inventory `attempts=2` remains visible; each cold view uses a fresh reader while server/database caches remain warm across repeated runs; Chrome display rounding is cosmetic. Record that Claude #2 verified measurement paths against the reviewed head and the Chrome measurement code was byte-identical to its first committed version. These limitations do not authorize invented measurements or changed raw files.
- [ ] **⛔ STOP.** Only after all 14 required cells validate, report exactly: `IDX_SIZE_EVIDENCE=READY`, `LIMITS=AWAITING_HUMAN_APPROVAL`, `WRITER_ENABLE=BLOCKED_PENDING_HUMAN`. Otherwise report `IDX_SIZE_EVIDENCE=NOT_READY` and each missing required cell. Do not change any limit, retained-byte budget, flag, overlay, or Production setting; no G.3/H/I or writer enablement. HG-G still requires a separate Human decision on limits and the explicit retained-byte budget.

### Task G.3 — Codify approved limits (only after written Human approval)

- **Depends on:** **HG-G** written approval naming each approved value.
- **Files:** `src/lib/vaultPreviewIndexConstants.js`, `server/config/vaultTreeLimits.js`, `tests/previewIndexConstants.test.js`, `tests/vaultTreeConfig.test.js`.
- [x] **RED/GREEN:** focused tests first failed on missing approval records, then passed after approved values moved from `PROVISIONAL_KEYS` to `APPROVED_KEYS` with approval date/source. The approved `maxPreviewIndexRetainedBytesPerOwner` is recorded without creating a runtime default; the Stage 3 checklist requires the exact approved env value and boot still throws when `WRITE=true` lacks a budget.
- **HG-G written decision (2026-10-03):** `HG_G_APPROVED`, PR #310 reviewed head `89da7f84d7279871f6e10df5df3e6b78594e5ef8`. Approved KEEP client values: `initialPrefixBits=6`, `maxPrefixBits=7`, `maxShards=128`, `maxShardDecodedBytes=196608`, `maxRootDecodedBytes=16379`, `maxEntriesPerCas=16`, `ciphertextLruBytes=33554432`. Approved KEEP server values: `maxPreviewIndexAttachPerCas=64`, `maxPreviewIndexEnvelopeBatch=32`. Per-owner retained budget: **8,589,934,592 B (8 GiB)**. These values are approval decisions based on G.2 plus Human-supplied Production capacity evidence, not a new measurement.
- **KEEP_UNMEASURED, unchanged and not measured:** `casMaxAttempts=5`, `writeQueueMax=64`, `backfillMaxPerSession=50`, `derivativeLaneConcurrency=6`, `maxLiveDecodedShards=16`, `generationBudgetMs=10000`, `maxPreviewIndexSupersededPerCas=64`. Padding buckets and `backfillConcurrency` have no explicit HG-G approval disposition and remain provisional; `maxJsonDepth` remains structural. Variant 3 is a deferred future stress profile and does not drive current D-1 limits. G.2 server latency was local loopback, not LAN SLA; live latency thresholds defer to Stage 4.
- **Capacity guard:** Human-supplied Production snapshot: available 31,215,161,344 B; datalake `du` 30,458,823,520 B; users 3, TREE_V1 owners 2; V2 ciphertext 3,916,387,459 B; index staged/managed 0 B each; D-1 head/generation/blob-ref rows 0 each. At 2 writer-eligible owners, maximum approved preview-index exposure is 17,179,869,184 B. **Before allowing more than 2 TREE_V1 writer-eligible owners, repeat Production filesystem-capacity review.** This is a planning guard, not a claim that Production was touched in G.3.
- **No overlay in PR-E (Human scope decision, 2026-10-03):** G.3 codifies the approved budget (`HG_G_RETAINED_BUDGET_APPROVAL`, test `PI-BUDGET-3`) and the Stage 3 checklist below requires the exact value. An earlier budget-prep overlay under `deploy/production/d1/` was removed from PR-E; every Production overlay, including the Stage 3 one, belongs to its Phase J deploy branch/PR.
- [x] **Commit:** `feat(idea1): adopt Human-approved preview-index limits` (`7c51dced`).

---

## PHASE H — Security / failure gates (PR-E)

### Task H.1 — Consolidated security gate suite

- **Depends on:** PR-D merged.
- **Files:** Create `tests/previewIndexSecurityGates.test.js` (one `describe` per invariant, each referencing the task that implements it).

| Invariant | Required test outcome |
|---|---|
| `UNKNOWN_VERSION => FAIL_SECURE` | root/shard `schemaVersion` ≠ 1 → reader `FAILED`/`null`; nothing rendered; original path used; writer refuses to write on top (no CAS) |
| `CROSS_OWNER => DENY` | B's head/envelopes/blobs/CAS/uploads/chunks for A's ids → 404/409 without existence leak; A's attach of B's blob → conflict |
| `WRONG_KEY => NO_PLAINTEXT` | KEK of another account → `INTEGRITY`, zero plaintext bytes returned |
| `CORRUPT_ROOT => FALLBACK` | bit flip in root chunk → all lookups `null`, tiles via original |
| `CORRUPT_SHARD => FALLBACK` | flip in one shard → only that shard's nodes fall back |
| `CORRUPT_DERIVATIVE => FALLBACK` | flip in derivative → that tile falls back; Download unaffected |
| `CONTENT_ID_MISMATCH => REJECT` | root, shard, derivative each → rejected before decrypt (spy) |
| `STALE_SOURCE_BINDING => REJECT` | replaced file (new `blobRef`) never shows the old derivative |
| `LOCK / LOGOUT / PAGEHIDE => RELEASE_PREVIEW_PLAINTEXT` | F.4 assertions re-run per reason |
| no HTML/SVG execution | SVG/HTML/XML bytes with image MIME → `SIGNATURE`; no `innerHTML`, `srcdoc`, `<object>`, `<embed>` in D-1 modules (source scan) |
| no plaintext persistence | storage guards + source scan (F.4) |
| no secret logging | no `console.*` in D-1 modules; diagnostics regex scan (F.5) |
| no new server-side MIME/name leakage | every captured request body/URL/header across upload, CAS, envelopes, reads contains no plaintext name, MIME of user file, nodeId, prefix, or kind |
| main manifest untouched | after a full writer run, every main revision published is schema 1 and byte-equal in structure to the no-index path (no preview fields) |
| `STORAGE_BUDGET_EXCEEDED => FAIL_CLOSED_FOR_PREVIEW_ONLY` | C.7 + E.4 + F.2 re-run: preview persistence rejected server-side; original upload/download, main manifest and existing index objects unaffected; nothing deleted |
| `SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO` | D.3 scan + C.1 test re-run: declared superseded blobs stay present and counted |
| old valid-head replay | test **documents** the accepted limitation: a server replaying an older valid head is accepted after a fresh unlock; within one page session an older generation is rejected; no durable anti-rollback claim |

- [x] **Negative controls:** (done 2026-10-03: CONTENT_ID, owner check, source binding, CAS expectation, plus write gate and budget — each break → named gate FAIL → restore → PASS → clean source tree) for CONTENT_ID, owner check, source binding, and CAS expectation: temporarily break the invariant in a local uncommitted edit, observe the named test fail, restore, observe pass, prove clean tree (`git status --short` empty). Record in PR body. Never against Production.
- [x] **Commit:** `test(idea1): consolidate preview-index security gates` (`7db1e36c`; files: `tests/helpers/previewIndexSecurityGateSpec.mjs` shared memory/PostgreSQL server spec, `tests/previewIndexSecurityGates.test.js`, `tests/previewIndexSecurityGatesPostgres.test.js`).

### Task H.2 — Account neutrality (ADMIN / EXISTING_USER / NEWLY_CREATED_USER)

- **Depends on:** H.1.
- **Files:** Extend `tests/previewAccountNeutrality.test.js` (uses `tests/helpers/accountClasses.mjs`).
- [x] **RED:** (done; `tests/previewAccountNeutrality.test.js` boots its own app and cannot share the preview-index harness, so it gains the AN-4 D-1 source scan while the behaviour runs in `tests/previewIndexAccountNeutrality.test.js` + `tests/previewIndexAccountNeutralityPostgres.test.js` via `tests/helpers/previewIndexNeutralitySpec.mjs`) identical index create/read/write behavior for all three classes; Admin has no override on another owner's index; identical bytes uploaded by two classes yield distinct blob ids and contentIds (no dedup); memory and `PGRUN`.
- [x] **Commit:** `test(idea1): prove preview-index isolation across account classes` (`21a992f4`).

### Task H.3 — Audit volume measurement

- **Depends on:** G.1.
- **Files:** Create `scripts/measure/vault-preview-index-audit-volume.mjs`.
- [x] Simulated unlock + 60-tile cold view + one backfill batch against a local server → audit rows by action (`VAULT_V2_READ`, `VAULT_V2_COMMIT`, `VAULT_PREVIEW_INDEX_CAS`); compare with the no-index baseline; audit rows contain no secret/plaintext fields. Measurement only; **no** deduplication or semantic change. Record in PR body for the Human audit budget decision.
- [x] **Commit:** `test(idea1): measure preview-index audit volume` (`60539bc7`; probe guards `tests/previewIndexAuditVolumeProbe.test.js`; evidence recorded in PR #310).

---

## PHASE I — Browser / old client / rollback (PR-E)

### Task I.1 — Old client after index creation

- **Depends on:** PR-D merged.
- **Files:** Create `tests/previewIndexOldClientCompat.test.js`. Requires `D1_BASELINE_ROOT` = a linked worktree of the exact pre-D-1 baseline SHA (A.0 base) with `node_modules` junctioned (remove the junction after the run). Without it the test skips with an explicit reason; the evidence run must report 0 skips.
- [ ] **RED/GREEN:** new server (memory + PG) with an index created by the new writer; old client modules imported from `D1_BASELINE_ROOT` perform: unlock, load head/browse, rename, move, upload (tree family), download (byte-exact), trash, restore, recovery listing; assertions: all succeed; recovery lists **no** index/derivative blob; main revisions remain schema 1; old-client writes that replace a file make the new reader reject the stale entry (source binding).
- [ ] **Commit:** `test(idea1): prove baseline clients keep working after index creation`.

### Task I.2 — Rollback matrix

- **Depends on:** I.1.
- **Files:** Create `tests/previewIndexRollback.test.js` (old server code from `D1_BASELINE_ROOT`, PG with migration 012 applied).

| Case | Setup | Must prove |
|---|---|---|
| A | new reader/server → baseline server+client, **before** any index exists | baseline boots on migrated DB (7-table probe passes; new tables ignored); all baseline flows pass |
| B | new reader/server → baseline, **after** index exists | baseline boots; `/tree/blobs?lifecycle=UNREFERENCED` excludes `INDEX_*` (lifecycle filter); main `casHead` refuses `INDEX_*`; `GET /api/vault` includes index envelopes (**documented degraded payload**, size recorded) and the baseline UI ignores them; no data loss |
| C | writer-capable build with WRITE off → compatibility build (PR-B level) | identical behavior; zero index writes before and after |
| D | writer-capable build after index creation → compatibility reader | existing index read-only and used for tiles; no writes; originals intact |
| E | writer disabled in place (env `WRITE=false`, restart) | `/state` flag false; writer inert; existing index still read (READ on) or ignored (READ off); originals intact |
| A′ | Stage 1 build (PR-A + PR-B) → previous accepted P1 runtime image, migration 012 retained | P1 image boots on the migrated DB; all P1 flows pass; no index exists to ignore |

Baseline servers have no preview-index upload family or CAS route, so no index object can be created while rolled back; the storage budget is therefore not needed there.

- [ ] **Never** a down-migration; no table, row, or blob is deleted in any case.
- [ ] **Commit:** `test(idea1): prove preview-index rollback without down-migration`.

### Task I.3 — Chrome browser evidence

- **Depends on:** I.2.
- **Files:** none committed beyond an optional harness page under `scripts/measure/` if needed; screenshots/logs in `$SCRATCH` only.
- [ ] Local stack (built `dist`, disposable PG): writer ON locally only; record derivative-first tile render, cold/warm request counts, fallback on injected corruption, lock mid-backfill, pagehide, memory peak vs the existing 256 MiB ceiling, Object URL count ≤ 256, no extra original GET during backfill (DevTools network log). Restore `dist`.
- **PR-E closeout:** evidence tables, receipt, Draft → independent review (**HG-H**). `IDX_SIZE` result and `LIMITS` decision recorded as Human-pending if G.3 has not happened.

---

## PHASE J — Production rollout (Human-controlled; no agent mutation)

Every stage below runs from its own `deploy/idea1-preview-d1-stage<N>` branch and PR containing only the per-SHA compose overlay(s) under `IDEA1-AEGIS_Drive_LC/deploy/production/d1/` and the Human runbook evidence. An agent may prepare the overlay and checklist; **only the Human Owner** applies migrations, restarts services, or changes flags.

### Stage 1 — Compatibility / read-only (writer OFF)

- **Build (binding):** `STAGE_1_BUILD = PR_A_MERGED + PR_B_MERGED` — an exact `origin/main` SHA that contains **both** PR-A and PR-B. PR-A alone is never deployed; there is no Production deployment between PR-A and PR-B. **DB:** `psql -v ON_ERROR_STOP=1 -f 012_vault_preview_index_v1.sql` as the migration superuser, after a verified backup.
- **Overlay:** `VAULT_PREVIEW_INDEX_SCHEMA_AVAILABLE=true`, `VAULT_PREVIEW_INDEX_READ_ENABLED=true`, `VAULT_PREVIEW_INDEX_WRITE_ENABLED=false`, `VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER` unset (allowed only because WRITE is false), all existing Vault flags unchanged (including `VAULT_MEDIA_PREVIEW_ENABLED=true`, required by the READ chain), `VAULT_DESTRUCTIVE_PURGE_ENABLED=false`.
- **Consistency:** with SCHEMA=true and READ=true, `GET /api/vault/tree/preview-index/head` reaches the store and returns **404 `PREVIEW_INDEX_NOT_FOUND`** when no index exists (503 `PREVIEW_INDEX_DISABLED` would mean READ is off — a Stage 1 configuration failure, not acceptance). The client reader treats 404 as `ABSENT` and tiles use the original path.
- **Gates:** **HG-S1** authorization → server acceptance (`/healthz`; `/state` flags show `previewIndexSchemaAvailable=true, previewIndexReadEnabled=true, previewIndexWriteEnabled=false`; `GET /preview-index/head` → **404** for every test account; preview-index write routes → 503) → browser acceptance (ADMIN / EXISTING_USER / NEWLY_CREATED_USER, LAN and Remote where applicable: unlock, browse, tiles via original path after one `head` 404, upload, download, rename, move, trash/restore, lock) → rollback proof (Case A′: redeploy the **previous accepted P1 runtime image** with migration 012 retained; flows pass; redeploy Stage 1).
- **Rollback target:** previous accepted P1 runtime image; migration 012 retained; no down-migration.

### Stage 2 — Writer-capable build, writer still OFF

- **Build:** `origin/main` containing PR-C, PR-D, PR-E. Overlay identical to Stage 1 with `WRITE=false` (budget may remain unset while WRITE is false).
- **Gates:** **HG-S2** → negative-control proof in Production (request/audit log shows zero `/preview-index/uploads*` and `POST /preview-index/head`; zero `INDEX_*` rows: `SELECT count(*) FROM vault_tree_blob_state WHERE lifecycle IN ('INDEX_STAGED','INDEX_MANAGED')` = 0 and `vault_preview_index_heads` empty) → security gate review accepted (H.1 evidence) → capacity gate accepted (G.2 + G.3) → browser acceptance as Stage 1 → rollback proof (Case C).

### Stage 3 — Enable writer (Human authorization required)

- **Preconditions:** `IDX_SIZE_GATE=PASS` with approved limits **and an explicitly approved retained-storage budget** (HG-G, codified by G.3), `SECURITY_GATES=PASS` (HG-H), Stage 2 accepted, rollback Cases B/D/E rehearsed on a non-Production replica. The Stage 3 overlay sets `VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER` to the approved value together with `WRITE=true` (boot refuses WRITE without it).
- **Approved budget checklist:** the Stage 3 deployment overlay must set `VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: "8589934592"` (8 GiB/owner, HG-G 2026-10-03) together with `WRITE=true`; that overlay is created only in the Stage 3 deploy branch/PR after its Human gates. Before >2 TREE_V1 writer-eligible owners, repeat Production filesystem-capacity review. Variant 3 remains future stress only; local loopback timing is not a LAN SLA and Stage 4 owns live latency acceptance.
- **Action:** **HG-S3** — the Human Owner alone sets `VAULT_PREVIEW_INDEX_WRITE_ENABLED=true` via a new overlay and restarts Drive.

### Stage 4 — Human functional acceptance

- **Accounts:** ADMIN, EXISTING_USER, NEWLY_CREATED_USER. **Paths:** LAN; Remote where applicable (recorded separately).
- **Validate:** new upload creates thumb/poster after the original completes; second unlock renders tiles from derivatives; original fallback on a Human-chosen safe corruption case in a **disposable test account only** (no Production negative control without separate authorization); rename/move keep previews; download byte-exact; lock/unlock releases and restores; replaced file never shows a stale preview; no data loss (original counts and checksums before/after); audit volume within the approved budget; rollback via Stage 3 → `WRITE=false` (Case E) executed and re-enabled only with Human approval.
- **Gate:** **HG-S4** functional acceptance recorded in the canonical status and the stage receipt.

## PHASE K — D-1 closeout and return to roadmap

`D1_THUMB_POSTER=CLOSED` only when **every** line is true, each with evidence bound to SHA and environment:

```text
IMPLEMENTED=YES                    PR-A..PR-E merged
LOCALLY_VERIFIED=YES               full-suite name diff 0 new, PG suites, Chrome evidence
INDEPENDENT_REVIEW=PASS            per PR, plus security review of H.1 (TEST PASS ≠ SECURITY REVIEW PASS)
COMPATIBILITY_DEPLOYED=YES         Stage 1 accepted
WRITER_CAPABILITY_DEPLOYED_OFF=YES Stage 2 accepted with zero-write negative control
IDX_SIZE_GATE=PASS                 G.2 evidence + G.3 Human-approved limits and retained-storage budget
SECURITY_GATES=PASS                H.1–H.3 accepted
HUMAN_WRITER_ENABLE=APPROVED       HG-S3
PRODUCTION_WRITER_ENABLED=YES      Stage 3 executed by the Human Owner
HUMAN_FUNCTIONAL_ACCEPTED=YES      HG-S4
ROLLBACK_VERIFIED=YES              Cases A–E local; A, C, E in Production
FINAL_RECEIPT=YES                  one receipt per task/PR; final D-1 closeout receipt
MERGED=YES
```

`EXISTING_P3_P5_PLANS=STALE_FOR_D1_ARCHITECTURE`: the existing P3, P4 and P5 plans assume manifest-embedded previews and must not be executed. No P3/P4/P5 runtime work belongs to D-1. After `D1_THUMB_POSTER=CLOSED`: `NEXT=P3_MOTION` — first re-plan P3 against the D-1 index; then reconcile/re-plan P4 (video proxy); then reconcile/re-plan P5 (PDF/Office); each re-plan is its own Human-reviewed task → full Unified Preview acceptance → `UNIFIED_PREVIEW_WORKSTREAM=CLOSED`.

## 5. Recommended implementation PR split

| PR | Changes | Does NOT change | Independently deployable | Production deploy required | Rollback target | Human gate | Receipt boundary |
|---|---|---|---|---|---|---|---|
| **PR-A** compat/storage/read-only API (A.0–A.6) | migration 012, schema.sql, flags (incl. budget config, fail-closed when WRITE without budget), read/accounting store (`getRetainedIndexBytes`), `GET head/envelopes/blobs`, inventory exclusion, client read wrappers, `.env.example` docs | main manifest, main CAS, upload families, any UI, any write path, budget enforcement | Reviewable/mergeable alone; **not deployable alone** | No — never deployed before PR-B is merged | n/a (not deployed alone) | HG-A merge | one receipt at PR-A closeout |
| **PR-B** codec + reader (B.1–B.10) | canonical/validator exports, constants, routing, codec, object seal/open, reader, derivative read, derivative-first tiles behind READ flag, codec size probe | server, DB, any write path | Together with PR-A only | **Yes — Stage 1 = PR-A + PR-B** (migration 012, SCHEMA=true, READ=true, WRITE=false, PURGE=false) | previous accepted P1 runtime image, migration 012 retained | HG-B merge; HG-S1 deploy | one receipt |
| **PR-C** CAS + lifecycle + orphan safety + storage budget (C.1–C.7, D.1–D.4) | CAS store/route (advisory superseded refs), `previewIndex` upload mode, **server-enforced per-owner retained-storage budget**, client CAS, merge library, classification, recovery hardening, lifecycle pins, reachability report | writer, generation, UI tiles, flag defaults, budget value | Yes (all writes 503 with WRITE off) | Rides in Stage 2 | Stage 1 build; WRITE stays off | HG-C merge (integration review: DB/CAS/storage budget) | one receipt |
| **PR-D** writer OFF + thumb/poster (E.1–E.4, F.1–F.5) | writer, budget-exhaustion circuit breaker (fail-soft), generation, upload-flow hook, backfill, lock cleanup, diagnostics | server, DB, flag defaults | Yes (inert while WRITE off) | Rides in Stage 2 | PR-C build or `WRITE=false` | HG-D merge | one receipt |
| **PR-E** evidence + enablement prep (G.1–G.3, H.1–H.3, I.1–I.3) | measurement harnesses (incl. retained-budget inputs), security/neutrality/compat/rollback suites, approved-limit and approved-budget codification after HG-G | product behavior (except G.3 values after approval) | Yes (tests/scripts; G.3 values) | Rides in Stage 2 | PR-D build | HG-G limits + budget; HG-H security; then HG-S2/S3/S4 via deploy branches | one receipt |

Stacking: PR-B may stack on PR-A; PR-C on PR-B; each must be rebased by merge (never rebase/force-push) onto `origin/main` after its dependency merges, per `AGENTS.md` §4.

## 6. Human gates (summary)

| Gate | Decides | Blocks |
|---|---|---|
| HG-0 | approve/merge this plan; separately authorize implementation | every task |
| HG-A / HG-B / HG-C / HG-D | review + merge each PR (HG-C needs integration review: DB/CAS/lifecycle/storage budget); merging PR-A authorizes no deployment | the next dependent PR |
| HG-S1 | Stage 1 migration + compatibility **reader** deploy of PR-A + PR-B (never PR-A alone) | Stage 2 |
| HG-G | accept/reject measured IDX-SIZE limits, latency/audit budgets, and an **explicit `maxPreviewIndexRetainedBytesPerOwner` value** | G.3, Stage 3 |
| HG-H | security gate review (independent of test pass) | Stage 3 |
| HG-S2 | Stage 2 writer-capable deploy with WRITE off | Stage 3 |
| HG-S3 | enable `VAULT_PREVIEW_INDEX_WRITE_ENABLED` in Production | Stage 4 |
| HG-S4 | functional acceptance | D-1 closeout |
| HG-ROLLBACK | any Production rollback/flag-off action | — |
| HG-GC (future, outside D-1) | any physical deletion of index/derivative blobs; requires a separate architecture + plan that independently proves reachability/retention safety; client-declared superseded refs are never sufficient authority | — (forbidden in D-1) |

Writer enablement (HG-S3) is impossible before HG-G **and** HG-H: Stage 3 preconditions list both, and the boot check refuses `WRITE=true` without the approved budget value that only G.3 (after HG-G) records.

## 7. Risks surfaced by source inspection (for Human awareness)

1. **Inventory growth.** `GET /api/vault` returns every envelope on unlock; retained index/derivative blobs would grow it without bound. Mitigated by server-side `INDEX_*` exclusion (A.4) and the envelope batch route. After a rollback to a baseline server (Case B) the exclusion disappears and the payload grows by the retained index size — measured in G.1, documented in I.2.
2. **Retained copy-on-write storage.** Every index write rewrites a whole shard and the root; with destructive GC forbidden, superseded shard bytes (and lost-CAS staged blobs) accumulate. Measurement alone does not bound this, so D-1 adds a **server-enforced per-owner retained-storage budget** (C.7) counting every committed `INDEX_STAGED` + `INDEX_MANAGED` byte; at the budget, new preview persistence is rejected fail-closed and tiles fall back to originals (E.4). Batching (`maxEntriesPerCas`) slows growth. HG-G approved 8,589,934,592 B/owner for the current 2 TREE_V1 owner capacity boundary; review filesystem capacity again before >2 writer-eligible owners. Client-declared superseded refs are advisory only (`SUPERSEDED_REF_IS_DELETION_AUTHORITY=NO`) and do not reduce the counted bytes.
3. **Budget check cost.** The commit-time budget check sums retained bytes under the owner lock; its PG cost at 10k-scale retained blobs is measured in G.1. If too slow, a maintained per-owner counter is a later design change requiring its own review (not assumed here).
4. **Lifecycle CHECK widening** is the only non-`CREATE` DDL; it widens a constraint and rewrites no row. Baseline servers tolerate the new values (they filter by `UNREFERENCED` and attach only from `UNREFERENCED`), proven in I.2.
5. **Audit volume.** Each derivative/shard read adds a `VAULT_V2_READ` row (chunk 0). Measured in H.3; no semantic change.
6. **Request-pattern leakage** (accepted): head/envelope/shard/derivative request co-occurrence and CAS attach lists reveal index activity and likely relationships between opaque ids.

## 8. Self-review (writing-plans checklist)

1. **Spec coverage:** §7 → B.3/C.6; §8 → A.2/A.3/B.4/B.5; §9 → B.6/B.8/H.1; §10 → B.7–B.9; §11 → E.2/F.2/C.6; §12 → C.1–C.3/C.6/E.2; §13 → F.3; §14 → C.4/D.1–D.4; §15 → B.7/F.4; §16 → A.6/I.1/I.2; §17 → B.10/G.1–G.3; §18 → H.1–H.3; §19 gates → A–I tasks (IDX-SIZE G, IDX-CRYPTO B.6/B.8/H.1, IDX-OWNER A.4/C.3/H.2, IDX-CAS C.1/C.2/C.6/E.2, IDX-ORPHAN C.4/D.*, IDX-TILE B.9/F.3/I.3, IDX-LOCK F.4, IDX-COMPAT A.6/I.1/I.2, IDX-AUDIT H.3, IDX-ACCEPT J); §20 → J; §21–§22 → §0 and §6. No spec requirement without a task.
2. **Step granularity:** every runtime task is one module or one integration seam with its own RED/GREEN/commit.
3. **Interface consistency:** names in §4 are the only names used in tasks (`getIndexHead`, `casIndexHead`, `PREVIEW_INDEX_LIFECYCLES`, `previewIndexWriteEnabled`, `openIndexObject`, `validatePreviewEntry`, …); error codes are defined once in §4.
4. **Review focus:** DB/CAS (HG-C), security (HG-H), capacity (HG-G) and every Production action (HG-S*) have named gates.
5. **Proportionality:** five PRs, each independently reviewable; PR-A + PR-B deploy together as Stage 1; measurement starts early (B.10) to avoid building a writer on a failing shape.
6. **Every Human condition mapped:** 1–2 → A.6/H.1; 3 → A.3/C.1; 4 → B.6; 5–7 → B.6/H.1/F.1 (client-only generation); 8 → F.4; 9–11 → B.7–B.9/F.2/H.1/E.4; 12 → A.1/E.1/E.3; 13–14 → G.1–G.3; 15–17 → D.3/D.4/C.7/HG-GC; 18–19 → §7, H.1; 20 → out of scope (future project); 21 → A.6 scan; 22 → A.6 scan, §0.
7. **Destructive/Production steps gated:** only Phase J touches Production, each stage by HG-S*; no task deletes data; migration 012 is applied only by the Human in Stage 1.
8. **No implicit writer enable:** flag defaults false in code and tests; only HG-S3 sets it; E.3 proves inertness; G.2 stops; boot refuses WRITE without an approved budget.
9. **No main-manifest preview arrays:** A.6/H.1 assert schema-1 writes and no preview fields; `setNodePreviews`/attach-with-previews forbidden by scan.
10. **No `VAULT_MANIFEST_V2_UPGRADE` dependency:** never read or set; A.6 scan.

**Review-revision checks (PR #280 review, 2026-10-02):**

| # | Check | Result |
|---|---|---|
| R1 | Persistent preview-index storage is bounded without destructive GC | PASS — C.7 server-enforced per-owner budget over committed `INDEX_STAGED` + `INDEX_MANAGED` ciphertext at upload create (advisory) and commit (authoritative, under owner lock); lost-CAS and superseded blobs stay counted; no deletion path exists (D.3) |
| R2 | Stage 1 cannot occur before PR-A + PR-B | PASS — §0 `STAGE_1_BUILD`, Phase A header, A.6/B closeouts, §5 table (PR-A "not deployable alone"), Stage 1 build rule, HG-S1 |
| R3 | READ=true / WRITE=false Stage 1 acceptance is consistent | PASS — Stage 1 overlay SCHEMA=true, READ=true (with existing `VAULT_MEDIA_PREVIEW_ENABLED=true` satisfying the chain), WRITE=false, PURGE=false; acceptance expects `GET head` 404 and treats 503 as misconfiguration |
| R4 | Client-declared superseded refs never authorize deletion | PASS — §0, §4.1 CAS contract, C.1 store note + test, D.3 source scan, D.4 retention, §6 HG-GC, §7 risk 2, H.1 row |
| R5 | Budget exhaustion never affects original file success | PASS — C.7 (tree upload, main attach, chunk download unaffected), E.4 (writer fail-soft, latched breaker), F.2 (original upload success under exhausted budget), H.1 row |
| R6 | PostgreSQL concurrent commits cannot exceed the approved cap | PASS — C.7 commit check runs in the commit transaction after `vault_tree_state … FOR UPDATE`; PG test: 10 parallel commits at `max − S` → exactly one succeeds, final ≤ max |
| R7 | No writer enable before HG-G and HG-H | PASS — Stage 3 preconditions; §6 note; boot refuses WRITE without the HG-G budget recorded by G.3 |
| R8 | No `VAULT_MANIFEST_V2_UPGRADE` dependency | PASS — §0, A.6 scan |
| R9 | No main-manifest preview arrays | PASS — §0, A.6, H.1 |
| R10 | P3–P5 remain blocked pending re-plan | PASS — §0 `EXISTING_P3_P5_PLANS=STALE_FOR_D1_ARCHITECTURE`; Phase K sequence P3 re-plan → P4 reconcile → P5 reconcile; no P3–P5 task in this plan |

Task count: 46 (A 7, B 10, C 7, D 4, E 4, F 5, G 3, H 3, I 3 + Phase J stages and Phase K criteria, which are gates, not code tasks). Revision added C.7 (server budget enforcement, PR-C) and E.4 (writer fail-soft on budget exhaustion, PR-D); budget config/accounting foundations extend A.1/A.3 (PR-A); budget measurement and approval extend G.1–G.3 (PR-E, HG-G).
