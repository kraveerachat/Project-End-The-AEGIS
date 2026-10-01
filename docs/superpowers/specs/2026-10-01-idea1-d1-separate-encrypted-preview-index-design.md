# IDEA1 D-1 — Separate Encrypted Preview Index (architecture proposal)

**Status:** AWAITING HUMAN REVIEW. Design only; no implementation approval, implementation plan, server/schema change, writer, flag enablement, or Production action. **Owner:** kla. **Base:** `origin/main` `a54e699594053fc87018720b9f9f25c9c482a6b0` after PR #278 merged. This proposal replaces only the rejected manifest-embedded D-1 storage decision if the Human Owner approves it; the remaining approved Unified Preview security and UX constraints continue to apply.

## 1. Problem statement

Storing preview arrays on every encrypted main-manifest file node makes each ordinary tree mutation re-encode, encrypt, upload, and CAS preview metadata for the entire Vault. At the supported 10,000 **total** nodes, that reaches the existing 16 MiB ciphertext ceiling with no headroom. Thumb/poster is the immediate product need; motion/proxy remain later, separately gated work. A different data boundary must keep originals readable and the main manifest small.

## 2. Evidence from rejected G-THR

PR #278's script-only T-MAN-SIZE gate (`scripts/measure/vault-manifest-size.mjs`) and immutable blocked receipt `2026-10-01_234920_kla_idea1-p2b-t-man-size-gate-blocked.md` measured six cells × 20 runs. At 10k total nodes (9,994 files + root + five folders), three previews/file yielded 14,632,866 canonical plaintext bytes, 16,777,216 padded bytes, and **16,777,232 ciphertext bytes**—exactly `maxCiphertextBytes`, **0% headroom**. No-preview: 3,959,274 plain and 4,194,320 cipher bytes. Chrome decrypt+decode+validate p95 was 371.2 ms; timing was not the rejection reason. There is **no observed end-to-end mutation p95**. Local server measurements used schema-v1 size-matched proxies, not v2 compatibility proof. `G_THR=REJECTED`, P2b Tasks 2–17 were not executed, writer not implemented, `VAULT_MANIFEST_V2_UPGRADE` not enabled, Production not mutated.

## 3. Goals and non-goals

Goals: client-generated, client-encrypted, persisted **ciphertext** thumb/poster derivatives; derivative-first tiles; substantial main-manifest capacity headroom at 10k; bounded writes, memory, audit volume, and recovery; existing original path as universal fallback; old-client-safe rollback before and after index creation. Preserve arbitrary upload and byte-exact download for all file types. No server Vault plaintext, no server-generated Vault plaintext derivative, no persistent decrypted Vault cache.

Non-goals: implementing anything in this task; changing the 16 MiB main-manifest limit; shipping motion/proxy, P3/P4, or new rendering libraries; changing Normal Files; changing V2 chunk size/AAD; eliminating all server-observable request timing or ciphertext-length leakage; repairing the inherited malicious-server rollback/equivocation model without a trusted monotonic witness.

## 4. Existing constraints (current source, not proposed code)

- `vaultTreeManifest.js` reads schema 1/2 but **writes 1**; v1 has closed top/node key sets, and v2's optional `previews` exists only for readers. `vaultTreeSync.js` refuses writes to v2 heads before publish/CAS. `server/routes/vaultTree.js` still accepts only schema 1 revisions. No v2 writer or preview-index route exists.
- `vaultTreeLimits.js` caps 10k nodes, 16 MiB decoded, and 16 MiB + 16 B ciphertext; main revisions use padded power-of-two buckets, random manifest DEK wrapped by TRK, AES-GCM, and manifest-specific AAD.
- V2 blobs already use per-blob random DEK wrapped by KEK, encrypted `{name,type,plainSize}` metadata, per-chunk AES-GCM with `contentId/index/count` AAD, owner-scoped routes, and `Cache-Control: no-store`. Small blobs use one chunk; the 8 MiB V2 **chunk configuration is not a minimum object size**.
- Current `vaultTreeStore.casHead` atomically advances the **main** head and promotes listed blobs `UNREFERENCED → TREE_MANAGED`; it is not a second-index CAS. `listOrphanBlobs` currently enumerates every unattached V2 blob and may offer it as a user file. A separate index therefore requires new lifecycle and recovery controls; it cannot safely reuse current endpoints unchanged.
- `VAULT_DESTRUCTIVE_PURGE_ENABLED=false` remains false. No new purge authority is implied.

## 5. Architecture alternatives

**A — one encrypted whole-Vault index.** An owner/tree-scoped opaque head points to one V2 ciphertext object containing all preview entries. Zero main-manifest bytes and simple lookup, but 10k entries recreate a multi-MiB monolith, every thumbnail update rewrites it, and its own limit/headroom will become the next G-THR failure.

**B — sharded encrypted index (recommended).** One owner/tree-scoped opaque index head points to an encrypted V2 root catalog. The catalog maps fixed opaque hash-prefix buckets to encrypted V2 shard blobs; each shard holds bounded preview entries. Main manifest has **no index pointer**. Tiles fetch only needed shards, and an update replaces one shard plus the small root through an independent CAS.

**C — per-node or per-folder encrypted sidecars.** Each file/folder has its own encrypted metadata blob and lookup. Writes are small, but 10k files imply thousands of objects, costly tile fetches, index discovery/GC complexity, and potentially visible folder association. Per-folder groupings also make moves/renames more complex.

## 6. Trade-off table

| Criterion | A: single | B: sharded | C: sidecars |
|---|---|---|---|
| Capacity / write amplification | O(N) index, O(N) bytes per preview update | O(N) total, bounded shard + root per update | O(N) objects, O(1) object per update |
| Tile requests / offline | 1 large fetch, poor cold start | 1 small root + lazy visible shards; memory cache helps | Up to one fetch per visible file; poor cold/offline |
| CAS / concurrent writers | One hot head; frequent conflicts | One head with shard-aware rebase; conflict still possible | Many heads or discovery CAS; complex orphaning |
| Crypto reuse | V2 blobs, one encrypted body | V2 blobs for root/shards/derivatives | V2 blobs, many small objects |
| GC / recovery | Simple but large generations | Explicit root reachability, retention and tagged orphans | Highest object-count/reachability burden |
| Rollback / migration | Old client ignores separate head | Old client ignores separate head | Old client ignores, but residual sidecars proliferate |
| Complexity / report value | Lowest code complexity, repeats scaling defect | Medium; measurable bounded-capacity architecture | Highest; harder to demonstrate predictable 10k UX |

Increasing `maxCiphertextBytes` is not the default: it moves the limit but preserves O(N) preview metadata in every main mutation. A per-folder shard was considered and rejected as the primary partition because server-visible grouping/access can correlate with folder structure.

## 7. Recommended design and boundaries

Choose **B**, an independent, owner-scoped, encrypted preview-index head. Main tree schema **remains v1 for D-1 writes**; no preview linkage is added to its top-level or nodes. The server resolves an optional index head by authenticated owner plus the existing opaque `treeId` from the main tree. A 404/no index is normal and means original-derived tiles. The index is non-authoritative, disposable acceleration data: a valid main manifest and originals are sufficient for all core operations.

Use one encrypted root catalog and initially **64 logical shard prefixes** selected by a client-computed hash of the opaque 16-byte `nodeId` (not filename, parent, or MIME). If a shard exceeds the proposed 192 KiB unpadded cap, split it by another hash bit; root catalog records the split. Hard cap: **128 live shards**, ≤192 KiB decoded payload per shard and ≤256 KiB padded ciphertext payload + 16 B GCM tag per shard. At a pathological skew/limit breach, skip that derivative/index update and retain original access; never silently relax bounds. The exact prefix function, padding, limits, and split/rebase behavior require measured tests and Human approval before implementation. The hash is routing, not a secret or authorization primitive; node IDs exist only inside encrypted client state.

## 8. Data model

**Server-visible proposed state (not present today):** one optional `(owner_user_id, tree_id)` index head: `indexGeneration`, opaque `rootBlobId`, root `contentId`, prior root reference, CAS/idempotency metadata. Head GET/CAS are authenticated, owner-scoped, state-gated, no-store, and reject cross-owner as 404. The server stores only opaque identifiers, encrypted blobs, lengths, and transaction metadata; no node ID, path, filename, MIME, `kind`, or shard prefix column. Main manifest holds **none** of these fields.

**Encrypted root catalog (V2 blob):** closed, versioned keys `{schemaVersion, treeId, indexGeneration, shards:[{prefix, blobRef, contentId}], createdAtClient}`; shard list capped at 128, strictly sorted/unique; optional tombstone or predecessor metadata only if needed for recovery. Its encrypted V2 metadata uses a reserved blank name and reserved index type; that type remains encrypted. The owner/tree/generation inside the authenticated plaintext must match the requested head. Root must be small (target ≤16 KiB padded; measured gate).

**Encrypted shard (V2 blob):** closed, versioned keys `{schemaVersion, treeId, prefix, entries}`. Key by random opaque `nodeId` already present in the decrypted main manifest. Each node has at most one `vp1` thumb and one `vp1` poster initially (the current v2 reader permits four kinds, but D-1 does not write motion/proxy). Entry reuses the existing validated preview shape: `{kind, profile, blobRef:{formatVersion:2,id}, contentId, sourceBlobRef:{formatVersion:1|2,id}, mime, width, height, plainSize, createdAtClient}`; no duration for thumb/poster. Unknown index/shard schema version fails secure for that index, leaving original access. Unknown profile is ignored only after structural validation. All counts, lengths, shape, MIME/signature, and profile bounds are enforced client-side before rendering. No plaintext catalog, shard, derivative, or key is persisted to browser storage.

**Physical blobs:** root, shard, and derivative each use an ordinary immutable V2 blob envelope/chunks. Future server lifecycle adds explicit `INDEX_MANAGED`/derivative references or equivalent new owner-scoped reference tracking; main `attachBlobIds` cannot prove reachability from this separate head. A blob is not user-file recoverable merely because its lifecycle is `UNREFERENCED`.

## 9. Crypto model

Reuse the current KEK → random per-V2-blob DEK → AES-256-GCM V2 envelope and chunk AAD **unchanged** for root, shards, and derivatives. Client encrypts all index payloads and derivative plaintext; server never decrypts. Encrypted metadata `{name:'', type:<reserved index marker or derivative MIME>, plainSize}` follows the existing envelope shape. Reserved marker/classification is authenticated inside the encrypted metadata and checked by the client recovery path, not trusted from a server label.

Root holds each shard's expected `contentId`; shard holds each derivative's expected `contentId`. Compare expected IDs to V2 envelopes **before decrypt**; V2 AAD authenticates the content ID and chunk position/count. Root plaintext binds `treeId`/generation; shard plaintext binds `treeId`/prefix. Every entry binds `sourceBlobRef` to the **current** decrypted main-node `blobRef`, and its `nodeId` must exist under that owner/tree. A stale or cross-node derivative is ignored. Server owner checks and distinct per-owner KEKs deny cross-owner reads; wrong key yields no plaintext. Existing V2 AAD does **not** bind the original source, so authenticated entry comparison is mandatory. Current main v1 does not authenticate an original V2 `contentId` in its `blobRef`; this design does not claim to repair whole-original substitution by a malicious server.

AEAD prevents ciphertext alteration, not replay of an older valid catalog by a malicious server controlling both head and blobs. Client checks generation/tree and continuity when it has a prior in-memory head, but durable anti-rollback across fresh sessions would require a separately trusted monotonic witness. This inherits the current tree trust boundary and is an explicit security review/Human decision, not a claim of complete replay resistance.

## 10. Read path

After main-head decrypt/validation, optionally GET the index head. Missing/disabled/unsupported/corrupt index changes **only preview acceleration**. Fetch/decrypt the small root, validate its version/tree/generation and shard refs, then fetch only shards for visible tile node IDs (coalesced by prefix; bounded concurrency). Resolve `{nodeId, sourceBlobRef, kind, profile}`, fetch derivative V2 envelope/chunk, compare content ID, decrypt, verify decoded MIME/signature/dimensions/size, create a registered object URL, render. A corrupt/missing shard, derivative, AEAD failure, stale binding, or unknown profile falls back to the existing original-decrypt tile path; Download/open-original remain available. Never render partial or unverified preview bytes. Active-only main lifecycle gates tile use; trashed/deleted nodes never display indexed previews. No HTML/SVG/XML execution is introduced.

## 11. Write/update path

Original upload and main-tree attach complete first under existing semantics. Only then, if a separately approved writer capability is on, generate thumb/poster from the local `File` already held or from already-decrypted original bytes. Upload derivative V2 blob, read current index head/root/shard, create an updated shard and root, then CAS the separate index head with exact expected generation/root ID and idempotency key. **Derivative failure never changes original upload success**; failure is visible only as missing acceleration/diagnostic counter. Do not write v2 main manifests or use the blocked P2b `setNodePreviews` operation.

Rename/move: index keyed by node ID, so no synchronous index rewrite. Replace content: current main `blobRef` changes; old entry becomes immediately unusable by source comparison; optionally queue a new derivative. Delete/trash: main lifecycle suppresses display; cleanup is asynchronous and never blocks deletion/restore. Restore: reuse only if source is unchanged and entry still valid, else original fallback. Main CAS conflict: original upload follows existing rebase/attach result; derivative work starts only after successful final source attachment and aborts if source changed. Index CAS conflict: refetch, decrypt, revalidate source against latest main, merge disjoint node/kind changes, retry with a bounded count; same node/kind winner selected by fresh source/profile rather than timestamps alone. Stale preview write is dropped, never force-overwrites. Index failure cannot roll back a committed original.

## 12. Concurrency / CAS model

One owner/tree index head serializes catalog generation; shard copy-on-write bounds payload but not CAS contention. The future server transaction must atomically check `(expectedGeneration, expectedRootBlobId)`, install new root, promote new root/shard/derivative blobs to an index-managed lifecycle, and record replaced refs for deferred GC. Idempotency replay returns the original result; mismatched replay fails. A lost response is resolved by refetching head before retrying. Max attempts and per-session write queue are bounded; conflict exhaustion fails soft. Root catalog rebase must preserve unrelated shard changes and be tested with two clients, including concurrent split and same-node replacement. No blind last-write-wins over a changed original. Main and index CAS are intentionally independent; the reader's source-binding check is the consistency bridge.

## 13. Backfill

Legacy files acquire thumb/poster lazily only when an existing user-visible tile flow has **already fetched/decrypted** the original, or during a new upload from its local `File`. Automatic backfill must not introduce another original GET (`NO_EXTRA_ORIGINAL_FETCH`). Use the existing tile result/bytes, not a second fetch. Proposed initial bounds carried from the earlier spec: one backfill job at a time, ≤50 files/unlocked session, one attempt per `(node,kind,sourceBlobRef)`/session, pause behind interactive transfer, cancel on visibility loss/lock/unmount. Failures retry in a later unlocked session only; no tight loop. No automatic motion/proxy transcode or whole-original fetch on unlock. Bounds are provisional until browser/memory/audit measurement.

## 14. Recovery and orphan handling

Derivative uploaded but index CAS fails: it remains encrypted and unattached; preserve for retention-based cleanup, never offer as an ordinary file. Index root/shard uploaded but CAS fails: same. Index references a missing/corrupt derivative: fail soft, mark missing for this session, optional one bounded regeneration. Replaced source: reject old entry immediately; later copy-on-write cleanup removes it. Old index generations remain for a measured rollback/reader grace period and in-flight reads; GC performs owner-scoped reachability from current and retained roots, never from server guesses about plaintext relationships. No physical deletion until explicit retention, reference, recovery, and flag gates pass. `VAULT_DESTRUCTIVE_PURGE_ENABLED=false` is unchanged. Existing orphan UI (`vaultTreeUpload.listOrphanBlobs`) currently lacks safe index/derivative classification; future implementation must add authenticated reserved-metadata classification and fail-closed recovery for unknown/empty-name blobs **before** writer enablement. A stuck/failed GC may retain ciphertext; it must not delete originals or expose derivative bytes as a recovered file.

## 15. Lock / cache lifecycle

Ciphertext root/shard/derivative LRU: page memory only, proposed combined ≤32 MiB; no Cache API, IndexedDB, OPFS, localStorage, or disk persistence. Decrypted catalog/shards stay only in unlocked session memory; cap live decoded shard set and evict least-recently-used, wiping byte buffers where practical. Existing preview memory ceiling 256 MiB and 256 Object URLs still apply; a new derivative lane should be bounded (provisional ≤6) and must not starve original/download lanes. On tile release/modal close revoke local URLs; on lock, auto-lock, logout, session invalidation, unmount, or `pagehide`, abort fetch/generation/upload, clear queues/caches, revoke **all** preview URLs, release decoded buffers and key references, close workers/SW tokens. Guard every post-await continuation against a purged session. Plaintext lifetime is limited to the unlocked page and active render; JavaScript GC is not a guaranteed secure erase, so no stronger memory-erasure claim is made.

## 16. Rollback and old-client compatibility

**A — reader/server compatibility deployment:** introduce optional index routes/storage and read-only client support with writer OFF; no index created, no main schema change. Rollback to the current v1 writer is safe. **B — writer capability:** code ships disabled; negative controls prove no writes. **C — Human-enabled writer:** after capacity/security/browser gates, begin best-effort index creation; main manifests remain v1. If disabled later, new writes stop, existing encrypted index is ignored/read-only, originals remain. An old client ignores the optional endpoint/data and continues v1 main-tree operations; its writes can make entries stale, but source binding rejects them. Do not require v1→v2 upgrade, set `VAULT_MANIFEST_V2_UPGRADE`, or create a one-way v2 manifest for D-1. Server rollback after index creation requires additive storage to remain untouched and old server to ignore it; **no destructive down-migration**. Before writer enablement, test rollback of new reader/server to the exact old-client/server baseline with and without an existing index. If a future independent feature has already written a v2 main head, the existing P2a read-only boundary still applies; D-1 does not downgrade it.

## 17. Quantitative capacity model (estimate, not new benchmark)

PR #278 measured preview-array deltas of 1,061,592 / 5,333,592 / 10,673,592 B at 1k/5k/10k for three previews/file, ≈356 B per preview after array/node overhead. For a **conservative planning** estimate use **400 B/index entry including amortized node key and structure**; exact canonical form/padding must be benchmarked before implementation. Counts use 994/4,994/9,994 files (total nodes include six folders/root). Two entries/file are immediate thumb/poster; three is the rejected-case stress envelope, **not** a P3 writer authorization.

| Total nodes | Main no-preview plain/cipher (measured) | Added main bytes / increase / bucket | Main ciphertext headroom vs 16,777,232 B | Index entries (2 / 3 per file) | Estimated unpadded index entry bytes (2 / 3) |
|---|---:|---|---:|---:|---:|
| 1k | 395,391 / 524,304 B | **0 / 0% / unchanged** | 96.875% | 1,988 / 2,982 | 795,200 / 1,192,800 B |
| 5k | 1,979,329 / 2,097,168 B | **0 / 0% / unchanged** | 87.5% | 9,988 / 14,982 | 3,995,200 / 5,992,800 B |
| 10k | 3,959,274 / 4,194,320 B | **0 / 0% / unchanged** | 75% | 19,988 / 29,982 | 7,995,200 / 11,992,800 B |

Main **no-link** model is exact for the unchanged PR #278 fixture; no proposed main field can trigger a new bucket. The server-side owner/tree lookup is the linkage. A single constant-size head ID in main would add perhaps tens of bytes but requires changing frozen v1 schema and still makes old writers incompatible; shard refs in main scale with shards and are rejected. The no-link design leaves 12,582,912 B ciphertext headroom at 10k in the measured fixture; future name growth still needs existing limits and separate measurement.

At 64 base shards, 10k mean entry payload is ≈124,925 B/shard (two entries) or ≈187,388 B/shard (three), plus small shard framing. The 192 KiB decoded cap triggers a split before overflow; ≤128 live shards is a proposed hard bound. A V2 shard padded to at most 256 KiB yields ≤262,160 ciphertext B per shard; at 64 shards the **upper bound** is 16,778,240 B total shard ciphertext, at 128 shards 33,556,480 B, plus V2 envelope/root overhead. These are **aggregate index storage bounds, not one-object size or measured transfer totals**; typical two-entry storage should be lower. Root target ≤16 KiB padded (~16,400 cipher B) for ≤128 descriptors, to be verified. The exact number of live shards at 10k is estimated **64 for two entries**, potentially **64–128 for three** after skew-triggered splits; no claim of a measured count. Shard/entry hard limits fail soft instead of enlarging the main manifest or truncating original data. Measure canonical bytes, padding, total ciphertext, object/request count, peak shard, and split frequency with the real proposed encoder on Node and Chrome at 1k/5k/10k before any writer approval.

## 18. Security analysis and residual leakage

Required invariants: `UNKNOWN_VERSION => FAIL_SECURE` for manifest/index decoding (index failure only disables acceleration); `CROSS_OWNER => DENY`; `WRONG_KEY => NO_PLAINTEXT`; `CORRUPT_INDEX/DERIVATIVE => FALLBACK_OR_FAIL_SOFT`; `STALE_SOURCE_BINDING => DERIVATIVE_REJECTED`; `LOCK => ALL_PREVIEW_PLAINTEXT_RELEASED`; no HTML execution or secret logging. Server sees encrypted root/shard/derivative blobs, owner/tree IDs already in the tree protocol, ciphertext sizes, timestamps, request/audit count, index generation, and which opaque blob IDs occur in an index CAS. It does **not** receive plaintext names, MIME, folder path, node IDs, entry kind, preview pixels, or keys. Existing encrypted V2 metadata does not reveal MIME directly; size/timing can support inference, as already true for blobs.

**Residual leakage requiring Human acceptance:** the new optional endpoint reveals that preview indexing is used; co-occurring opaque blob IDs and reads can reveal likely index/derivative relationships and activity patterns beyond the previous exact request sequence. No credible design can claim zero additional request-pattern leakage while serving separate objects. Fixed/padded shard sizes, opaque hash routing, lazy coalesced reads, no plaintext shard prefix in routes, and unchanged audit semantics reduce but do not eliminate it. The security gate must explicitly accept this bounded metadata leakage or reject the design. Audit events must stay owner-scoped and secret-free; rate/volume is measured, not silently deduplicated.

## 19. Future test and evidence gates (not implemented now)

| Gate | Level | Required proof before writer enablement |
|---|---|---|
| IDX-SIZE | UNIT + BROWSER | Real canonical/encrypted 1k/5k/10k, 2 and 3 entries; main remains v1/no-link and 10k headroom; shard/root bounds, split distribution, request counts |
| IDX-CRYPTO | UNIT + INTEGRATION | Wrong key, tamper, unknown version, wrong tree/generation, root/shard/derivative contentId mismatch, stale source, old valid-root replay limitation documented |
| IDX-OWNER | INTEGRATION | Cross-owner head/blob read/write 404; no role/account-age branch; owner-scoped CAS and lifecycle |
| IDX-CAS | INTEGRATION | Two-client disjoint and same-node updates, split conflict, idempotency/lost response, main CAS conflict, stale writer; no original failure |
| IDX-ORPHAN | INTEGRATION | Derivative/root/shard upload without CAS, missing refs, deferred GC/retention, recovery UI never offers reserved objects, purge flag still blocks deletion |
| IDX-TILE | BROWSER | Derivative-first encrypted fetch/verify/render; corrupt/missing fallback; responsiveness, no extra original GET for automatic backfill, memory/cache/URL ceilings |
| IDX-LOCK | UNIT + BROWSER | Lock/auto-lock/logout/pagehide/unmount cancels in-flight work and clears plaintext/URL/key references; no persistent plaintext/cache |
| IDX-COMPAT | INTEGRATION + BROWSER | Old client after index creation can rename/move/upload/download main v1; reader/server rollback before/after writer, disabled writer, no schema-v2 creation |
| IDX-AUDIT | INTEGRATION + PRODUCTION ACCEPTANCE | Exact audit semantics retained; read/write volume bounded against agreed threshold and no secret fields |
| IDX-ACCEPT | PRODUCTION ACCEPTANCE, Human-controlled | Admin/existing/new user, LAN/Remote, 1k/5k/10k scaled fixture or safe representative, rollback and no data loss; no acceptance inferred from local tests |

Negative controls should intentionally corrupt a shard source, owner, contentId, and CAS expectation in isolated fixtures, restore, and prove final green. No Production negative control without separate authorization. Thresholds and a genuine end-to-end mutation p95 gate remain Human decisions, not fabricated measurements.

## 20. Deployment phases and gates

1. **Design approval** (this Draft PR): Human selects/changes architecture, leakage tolerance, bounds, and rollback contract. No implementation plan before approval.
2. **Future plan + compatibility PR:** explicit implementation plan after approval; additive owner-scoped head/CAS/lifecycle storage, no destructive migration, reader only, writer OFF. Tests and controlled deployment; old main v1 writes preserved.
3. **Future writer-capability PR:** client thumb/poster generation and index updates behind separate default-OFF server-served capability; full 1k/5k/10k and security gates, no index writes while OFF.
4. **Human enablement + acceptance:** exact-SHA Production preparation, rollback baseline, Human-controlled enablement, browser and audit acceptance. No motion/proxy enablement implied.

Every phase is independently reviewable and rollback-tested. Existing P2a reader may remain deployed, but D-1 must not enable `VAULT_MANIFEST_V2_UPGRADE` or revive rejected P2b Tasks 2–17.

## 21. Open Human decisions

1. Approve sharded/no-main-link architecture over A/C, or request revision; decide whether a separate owner/tree server head and additive storage are acceptable.
2. Accept or reject the explicit request-pattern / opaque blob-co-occurrence leakage; define acceptable audit-volume and latency budgets on LAN/Remote.
3. Approve initial 64-way routing, 192 KiB decoded shard cap, 128 live-shard cap, 256 KiB padded bucket, root bound, and fail-soft saturation policy **after measurement**; these numbers are provisional design targets.
4. Decide index-generation retention, safe orphan classification, GC authority, and rollback duration; destructive purge remains separately gated.
5. Decide whether D-1 formally supersedes the conditional original manifest-embedded D-1/P2b plan; decide the future independent writer-capability naming and Human enablement gate. No approval is inferred here.
6. Decide whether inherited malicious-server valid-head rollback resistance needs a separate trusted-witness project before preview-index writer rollout.

## 22. Explicit implementation blockers and self-review

**Blocked until Human design approval:** implementation plan, server head/CAS contract, additive DB schema and lifecycle/GC authority, authenticated orphan classification, client encoder/decoder, derivative writer, feature capability, capacity measurements, and Production rollout. Current source has none of the separate-index machinery. The existing P2b plan remains rejected; do not execute Tasks 2–17 or turn on `VAULT_MANIFEST_V2_UPGRADE`.

Self-review against the rejected gate and current code: main linkage is zero bytes; two- and three-preview capacity are separated; P2a read-only v2 behavior and server v1-only revision acceptance are not misrepresented; independent index CAS is not mistaken for `casHead`; V2 encryption/AAD is reused without claiming source binding from AAD; old clients ignore the optional data; original upload precedes preview; corrupt/stale data cannot break original access; lifecycle/GC and orphan recovery are named blockers; replay and request-pattern leakage are explicit residuals; no source, migration, flag, or Production change is part of this design PR. **Result:** proposal ready for Human architecture review, not approved for implementation.
