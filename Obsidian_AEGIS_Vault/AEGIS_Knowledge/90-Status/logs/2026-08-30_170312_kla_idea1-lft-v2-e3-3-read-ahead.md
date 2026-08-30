---
title: Task Receipt — IDEA1 LFT-V2-E3.3 high-throughput encrypted video read-ahead
date: 2026-08-30T17:03:12+07:00
owner: kla
area: idea1
branch: fix/idea1-lft-v2-e3-3-read-ahead
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 LFT-V2-E3.3 high-throughput encrypted video read-ahead

Follow-up to merged PR #56 (receipt
`2026-08-30_032946_kla_idea1-lft-v2-e3-2-cancel-and-claim.md`, and PR #55's
receipt `2026-08-30_013241_kla_idea1-lft-v2-e3-1-preview-reliability.md` —
neither modified here). Base `main` =
`543fb082eb717bf583ab415df2282da8f36b6c18`.

## Problem this task addresses

E3.2 made the preview correct. It did not make it watchable. Production
evidence on the real `START_LIVE.mp4`:

| Quantity | Observed |
|---|---|
| Plaintext size / duration | 1,206,241,622 B / ~120 s |
| Required media rate | ~10 MB/s (~80 Mbps before overhead) |
| Virtual Range response | exactly 16 MiB (`bytes 83886080-100663295/1206241622`) |
| One ~16 MiB ciphertext chunk | 5–8 s |
| Drive container NET during playback | 8.82 → 8.99 GB in ~42 s (≈ 4 MB/s) |
| Drive container CPU / RSS | 0–8 % / 25–47 MiB |

`RANGE_SEMANTICS = WORKING`, `FIRST_FRAME = WORKING`,
`PLAYBACK_THROUGHPUT = FAIL`. A 16 MiB plaintext chunk is only ~1.5–2 s of this
video, so a pipeline that starts chunk N+1 only after the browser asks for it is
structurally too slow regardless of how fast any single step runs. The 0–8 % CPU
confirms nothing was compute-bound: the pipe was never kept full. The defect was
the *shape* of the pipeline — demand-driven and serial — not the bytes.

## What changed

- **Bounded proactive read-ahead, session-owned.** When foreground playback
  requests chunk N, the worker prioritises N and immediately begins loading
  N+1…N+k concurrently. `k` is derived from a byte budget, never hard-coded:
  `cacheSlots = floor(MAX_PREVIEW_PLAINTEXT_CACHE_BYTES / plaintextChunkSize)`,
  capped at 4. 16 MiB profile → 4 slots (current + 3 ahead); 32 MiB → 2
  (current + 1); 64 MiB → 1 (no plaintext read-ahead). Retained plaintext stays
  at the unchanged **64 MiB** ceiling in every case. A chunk larger than the
  whole budget is served but never retained.
- **The three budgets are now separate.** Retained plaintext bytes, cache entry
  count and maximum in-flight ciphertext loads were previously the single
  `maxPlaintextChunks` number, which is why the read-ahead window could not
  widen without the memory ceiling widening with it. The Service Worker no
  longer passes a fixed chunk count at all; the window is computed per session
  from that blob's real plaintext chunk size.
- **Real concurrency with a reserved foreground slot.** Speculative loads are
  capped at `cacheSlots - 1`, and a foreground load may take one reserved slot
  when speculative work is what is holding capacity. A seek therefore starts
  immediately instead of queueing behind speculation, while purely foreground
  demand still respects the ordinary `maxInFlight` ceiling.
- **Prefetch Promise reuse.** A Range request for a chunk already being read
  ahead joins the existing session-owned Promise — no second ciphertext GET. A
  prefetch still sitting in the queue is promoted to foreground priority rather
  than duplicated.
- **Seek reprioritisation.** Jumping from chunk 10 to chunk 50 makes 50
  foreground at once, rebuilds the window as 51/52/53, and discards queued
  11/12/13 before they ever reach the network. Work already in flight is allowed
  to finish — it is bounded, holds no reserved slot, and cancelling it would
  complicate the E3.2 shared-ownership contract.
- **Playback-aware eviction (defect found during implementation).** Plain LRU is
  actively wrong for this workload: playback keeps touching the current chunk,
  so N+1 — fetched but not yet read — becomes the stalest entry and was evicted
  roughly a second before the player needed it. Read-ahead would then re-fetch
  everything it had just fetched while every cache-size assertion still passed.
  Chunks behind the playhead are now evicted first; sessions that never use
  read-ahead keep the original LRU behaviour unchanged.
- **Speculative failure is silent.** A read-ahead chunk that fails announces
  nothing, because nobody asked for it. The same chunk requested as foreground
  still reports integrity and transport faults in full.
- **Throughput diagnostics.** The opt-in allow-list gained
  `ciphertextBytesFetched`, `ciphertextMbPerSecond`, `decryptMbPerSecond`,
  `foregroundChunkIndex`, `prefetchIndexes`, `inFlightLoads`, `prefetchHits`,
  `prefetchMisses`, `discardedSpeculativeChunks`, `retainedPlaintextBytes`.
  Still no KEK, DEK, passphrase, plaintext, filename, decrypted metadata, cookie
  or Authorization header — the record is built field-by-field from the
  allow-list, so an unvetted field has no path out. A zero-duration measurement
  reports `null` rather than `Infinity`.
- Unchanged, deliberately: `PREVIEW_RANGE_WINDOW_BYTES` = 16 MiB (the fix is
  read-ahead and concurrency, not a larger Range response); no whole-file
  buffering; no plaintext server endpoint; encryption untouched; DEK still
  non-extractable and memory-only; no Cache API, IndexedDB, localStorage,
  sessionStorage or disk plaintext; no CSP, nginx, `client_max_body_size`,
  compose, Postgres or IDEA2 change; no UI copy added.

## Memory ceilings, stated as numbers

| Budget | Rule | 16 MiB profile | 32 MiB | 64 MiB |
|---|---|---|---|---|
| Retained plaintext | ≤ 64 MiB, hard | 4 × 16 MiB = 64 MiB | 2 × 32 = 64 MiB | 1 × 64 = 64 MiB |
| Cache entries | `floor(64 MiB / chunk)`, cap 4 | 4 | 2 | 1 |
| Read-ahead depth | `cacheSlots − 1` | 3 | 1 | 0 |
| Speculative in flight | `cacheSlots − 1` | 3 | 1 | 0 |
| Total in flight | `cacheSlots + 1` when read-ahead is possible | 5 | 3 | 1 |
| Transient ciphertext | `totalInFlight × (chunk + 16 B)` | ≈ 80 MiB | ≈ 96 MiB | ≈ 64 MiB |

Every figure is a function of chunk size and memory budget. None depends on
total file size: 1.1 GiB, 5 GiB and 32 GiB files produce an identical window.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewReadAhead.js` — **new**; the whole
  policy as pure arithmetic (`previewChunkWindow`, `prefetchIndexesAfter`,
  `withinReadAheadWindow`) plus `MAX_PREVIEW_PLAINTEXT_CACHE_BYTES` and
  `MAX_PREVIEW_PREFETCH_SLOTS`. No I/O, no keys, so every ceiling is testable.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewWorkerState.js` — three separate
  budgets; per-session window derived from the blob's chunk size; two-class slot
  scheduler with the reserved foreground slot; `prefetch()` and `readAhead()`;
  promotion of a queued prefetch to foreground; discard of stale queued
  speculation; playback-aware eviction; read-ahead teardown on close, lock,
  close-all and session replacement.
- `IDEA1-AEGIS_Drive_LC/src/vaultPreviewServiceWorker.js` — drops the fixed
  `maxPlaintextChunks: 2`; arms read-ahead at the current foreground chunk
  before each foreground read; records the read-ahead diagnostics.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewResponder.js` — emits ciphertext
  bytes and measured fetch/decrypt MB/s per chunk.
- `IDEA1-AEGIS_Drive_LC/src/lib/vaultPreviewDiagnostics.js` — the new
  allow-listed throughput fields, bounded index arrays, and `mbPerSecond()`.
- `IDEA1-AEGIS_Drive_LC/tests/vaultPreviewReadAhead.test.js` — **new**; 32
  regressions covering all fourteen required properties.

## Verification evidence

- `npm test` (full IDEA1 suite) — PASS: 779 discovered, 712 pass, 0 fail, 67 PostgreSQL-gated skips (`TEST_DATABASE_URL` unset; those skips are pre-existing and unrelated).
- `node --test --test-concurrency=1 tests/vaultPreviewReadAhead.test.js` — PASS: 32/32, 0 fail.
- `node --test --test-concurrency=1 tests/vaultPreviewReadAhead.test.js tests/vaultPreviewWorkerState.test.js tests/vaultPreviewCancellation.test.js` — PASS: 61/61, 0 fail (E3.1/E3.2 state and cancellation regressions green).
- `node --test --test-concurrency=1 "tests/vaultPreview*.test.js"` — PASS: every preview suite green.
- `npm run build` — PASS; Vite emitted `dist/vault-preview-sw.js` (12.78 kB) at
  the dist root with its fixed unhashed name. The tracked `dist/index.html` was
  restored to its committed state afterwards, so this branch ships no rebuilt
  bundle.
- Defect found *by* the new tests during implementation: the first eviction
  design retained ≤4 chunks and ≤64 MiB — every size assertion passed — while
  evicting chunk N+1 immediately after reading N, which would have made
  read-ahead re-fetch its own work. `eviction drops the chunk already played,
  never the chunk read ahead` now pins the correct behaviour.
- Security-invariant scan of the preview path — PASS: no `localStorage`,
  `sessionStorage`, `indexedDB`, `caches` or `CacheStorage` in
  `src/lib/vaultPreview*.js` or `src/vaultPreviewServiceWorker.js`;
  `MAX_PREVIEW_PLAINTEXT_CACHE_BYTES` still `64 * 1024 * 1024`;
  `PREVIEW_RANGE_WINDOW_BYTES` still `16 * 1024 * 1024`.
- Server source review (no change made): `GET /api/vault/blobs/:id/chunks/:index`
  in `server/routes/api.js` is stateless per request — ownership lookup, chunk
  row lookup, then `openVaultCiphertextRange(...)` + `stream.pipe(res)` with
  `Content-Length` from the DB row. No mutex, no per-session queue, no
  whole-file read. `openVaultCiphertextRange` is a plain
  `fs.createReadStream(abs, { start, end })`. **No server-side serialization
  bottleneck was found**, so no route, nginx or API contract change was made.
- `git diff --name-status origin/main...HEAD` — every source path is inside
  `IDEA1-AEGIS_Drive_LC/`; no CSP, nginx, docker-compose, Postgres or IDEA2 path
  is touched.

## Required test properties, and where each is pinned

All in `tests/vaultPreviewReadAhead.test.js` unless noted.

1. 16 MiB profile, N + N+1/N+2/N+3 concurrent — *16 MiB profile: foreground N and read-ahead N+1..N+3 all start concurrently*
2. retained plaintext never exceeds 64 MiB — *retained plaintext never exceeds 64 MiB on any chunk profile*, *the 64 MiB retained ceiling holds while a 16 MiB profile streams many chunks*
3. 32 MiB profile retains 2 — *32 MiB profile retains only two plaintext chunks and reads one chunk ahead*
4. foreground joins an existing prefetch Promise — *a foreground request joins the existing prefetch Promise instead of loading again*
5. no duplicate ciphertext GET — *a prefetched chunk is never fetched a second time when the browser asks for it* (real AES-GCM, counting server)
6. seek reprioritises immediately — *seeking to a distant chunk reprioritizes immediately and rebuilds the window*, *queued speculative work outside the new window is discarded on a seek*
7. speculative queue cannot starve foreground — *a speculative queue cannot starve the foreground chunk*
8. E3.2 cancellation still benign — *cancelling a Range while read-ahead is in flight stays benign (E3.2 regression)* plus the whole of `vaultPreviewCancellation.test.js`
9. close preview invalidates read-ahead — *closing the preview invalidates every foreground and read-ahead load*, *closing the preview mid-playback stops read-ahead and delivers no late plaintext*
10. Lock Vault invalidates read-ahead — *locking the Vault invalidates every foreground and read-ahead load*
11. integrity failure fatal — *an integrity failure on the foreground chunk remains fatal*, *a failing read-ahead chunk stays silent while the foreground failure still reports*
12. network error fatal — *a real network error on the foreground chunk remains fatal*, *an HTTP error on the foreground chunk remains fatal*
13. 1.1/5/32 GiB bounded without allocating — *1.1 GiB, 5 GiB and 32 GiB logical files stay bounded without allocating them*
14. count depends on budget/chunk size, not file size — *the read-ahead count depends on the memory budget and chunk size, never on file size*, *the byte budget, not a hard-coded four, decides the window*

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — replaced the
  stale "E3.2 pending acceptance" limitation with the measured throughput
  evidence, added the E3.3 source-fix record, and kept
  `LARGE_V2_VIDEO_PREVIEW = IN_PROGRESS`.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` —
  rewrote invariants 3 and 9 (the two-chunk assumption became the 64 MiB byte
  budget it was always meant to express), added invariants 13–15, added §13.9,
  and refreshed the `LARGE_V2_VIDEO_PREVIEW` table row.

## Shared surfaces touched

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Large_File_Transfer_V2.md` —
  cross-scope transfer architecture note; the E3.3 read-ahead, concurrency and
  memory-ceiling contracts require integration-owner review, as for E3.1/E3.2.

## Integration requests

- Kla integration owner: confirm the shared LFT-V2 concept still states the
  Zero-Knowledge boundary, the non-extractable DEK, the unraised 64 MiB
  retained-plaintext ceiling, the unraised 16 MiB Range window, the absence of
  Cache API/IndexedDB/web storage, Edge/Chrome-on-Windows primary acceptance and
  source-only status. Specifically review two changes of wording: invariant 9
  no longer says "at most two chunks" but "≤64 MiB, chunk count derived from
  it", and invariant 14 records a **transient ciphertext** ceiling of
  `(cacheSlots + 1) × (chunkSize + 16 B)` — about 80 MiB on the production
  16 MiB profile — which is one chunk more than the retained-plaintext ceiling
  and must not be read as a raise of that ceiling. No migration, rollout or
  rollback is required; reverting this PR restores E3.2 behaviour with no data
  or schema effect.

## Known limitations

- `E3_3_PRODUCTION_ACCEPTANCE = NOT RUN`. Nothing on this branch was deployed
  and no real browser ran it. **Playback is not claimed fixed.**
  `LARGE_V2_VIDEO_PREVIEW` stays `IN_PROGRESS` until the existing
  `START_LIVE.mp4` passes on Windows Edge/Chrome: open → first frame → play
  without repeated buffering → seek middle → continue → seek near end →
  continue → close → reopen → play normally.
- Read-ahead removes the *serialization*; it cannot create bandwidth. If the
  real ceiling is a single-connection or link limit rather than pipeline shape,
  four concurrent 16 MiB loads will raise aggregate throughput only as far as
  the link allows. The observed ~4 MB/s at 0–8 % CPU is consistent with a
  serialization limit, but that is an inference from container metrics, not a
  measurement of the link. The new opt-in throughput diagnostics exist to settle
  this on the next production run.
- A speculative load already in flight when the user seeks is allowed to finish.
  That work is bounded and holds no reserved slot, but it is not free: it can
  consume link capacity for a second or two after the seek.
- Transient in-flight ciphertext is bounded at one chunk *more* than the
  retained-plaintext ceiling (≈80 MiB on the 16 MiB profile). Browser-owned
  response buffers still sit outside both numbers, so neither is the whole
  process-memory peak. Both remain independent of total file size.
- Read-ahead is armed from the foreground chunk of whichever Range response
  pulls last. A stale Chromium range that keeps pulling briefly after being
  superseded can re-aim the window for one pull; the churn is bounded to queued
  speculation and self-corrects on the next live pull, but it is real.
- No server-side change was made because source review found no serialization
  bottleneck. That review covered the Express route and the file-range opener;
  it did not profile the deployed nginx/Docker path under concurrent chunk
  requests.
- PostgreSQL-gated tests stayed skipped (`TEST_DATABASE_URL` unset); this change
  has no database or server persistence contract.
- Firefox remains secondary compatibility and Safari/WebKit acceptance remains
  deferred, unchanged from E3.1/E3.2.
