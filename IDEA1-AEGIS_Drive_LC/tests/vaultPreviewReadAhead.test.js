// tests/vaultPreviewReadAhead.test.js — AEGIS Drive (IDEA1) · LFT-V2-E3.3
//
// ⚠️ What this file pins is throughput, not correctness of bytes — that was
//    settled by E3.1/E3.2 and those suites still run as regressions.
//
//    Production evidence after PR #56 (real START_LIVE.mp4):
//      plaintext 1,206,241,622 B, duration ≈ 120 s → ≈ 10 MB/s required
//      one bounded 16 MiB Range response = HTTP 206, correct, first frame OK
//      one ~16 MiB ciphertext chunk took ≈ 5–8 s to arrive
//      Drive container NET ≈ 4 MB/s while CPU sat at 0–8 %
//    A 16 MiB plaintext chunk is only ~1.5–2 s of this video, so a pipeline that
//    starts chunk N+1 only once the browser asks for it can never keep up, no
//    matter how the bytes themselves are handled. The defect is the *shape* of
//    the pipeline: strictly demand-driven and strictly serial.
//
// ⚠️ Every ceiling asserted here is a function of chunk size and memory budget
//    only. No test allocates a large file, and the 1.1 GiB / 5 GiB / 32 GiB
//    cases are exercised as logical sizes precisely so that "bounded" means
//    bounded, not "small enough that nobody noticed".
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createVaultV2Envelope, encryptVaultChunk, planVaultChunks, GCM_TAG_BYTES,
} from '../src/lib/vaultChunkCrypto.js'
import {
  planPreviewResponse, createPreviewStream, readPlainChunk, PREVIEW_FAILURE,
} from '../src/lib/vaultPreviewResponder.js'
import { createPreviewWorkerState } from '../src/lib/vaultPreviewWorkerState.js'
import {
  previewChunkWindow, prefetchIndexesAfter, withinReadAheadWindow,
  MAX_PREVIEW_PLAINTEXT_CACHE_BYTES, MAX_PREVIEW_PREFETCH_SLOTS,
} from '../src/lib/vaultPreviewReadAhead.js'
import { PREVIEW_RANGE_WINDOW_BYTES } from '../src/lib/vaultPreviewRange.js'
import { PREVIEW_FAILURE_REASON } from '../src/lib/vaultPreviewErrors.js'
import { createPreviewDiagnostics, mbPerSecond } from '../src/lib/vaultPreviewDiagnostics.js'

const MIB = 1024 * 1024
const GIB = 1024 * MIB
const TOKEN = 'a'.repeat(32)
const BASE = '/drive/'
const settle = async (turns = 8) => { for (let i = 0; i < turns; i += 1) await Promise.resolve() }

/**
 * A session with a real chunk *shape* and no real bytes.
 * ⚠️ plainSize is a logical number here on purpose: a 32 GiB file must be
 *    describable without a 32 GiB allocation, or the bound being tested would
 *    be untestable by construction.
 */
const logicalSession = (plaintextChunkSize, plainSize) => ({
  dek: {},
  contentType: 'video/mp4',
  plainSize,
  blob: {
    id: 'b'.repeat(48),
    contentIdB64: 'Y29udGVudA==',
    chunkSize: plaintextChunkSize + GCM_TAG_BYTES,
    chunkCount: Math.ceil(plainSize / plaintextChunkSize),
  },
})

/** A loader whose every chunk can be released one at a time. */
function gatedLoader(byteLength = 8) {
  const started = []
  const gates = new Map()
  const load = (index) => new Promise((resolve, reject) => {
    started.push(index)
    // ⚠️ Reports byteLength without allocating it: the cache accounts for the
    //    size it is told, which is exactly the arithmetic under test.
    gates.set(index, {
      resolve: () => resolve({ byteLength }),
      reject: (err) => reject(err),
    })
  })
  return {
    load,
    started: () => [...started],
    release: (index) => gates.get(index)?.resolve(),
    fail: (index, err) => gates.get(index)?.reject(err),
    releaseAll: () => { for (const gate of gates.values()) gate.resolve() },
  }
}

// ══ GOAL 1 · session-owned read-ahead on the real 16 MiB profile ════════════

test('16 MiB profile: foreground N and read-ahead N+1..N+3 all start concurrently', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const window = state.windowFor(TOKEN)
  assert.equal(window.cacheSlots, 4, '64 MiB budget / 16 MiB chunk = 4 retained chunks')
  assert.equal(window.prefetchAhead, 3, 'current chunk plus three ahead')

  const srv = gatedLoader()
  const prefetched = state.readAhead(TOKEN, 5, srv.load, { chunkCount: 256 })
  const foreground = state.readChunk(TOKEN, 5, srv.load)
  await settle()

  assert.deepEqual(prefetched, [6, 7, 8], 'read-ahead follows the foreground chunk')
  assert.deepEqual(srv.started().sort((a, b) => a - b), [5, 6, 7, 8],
    'all four loads are in flight together — this is the serial pipeline being removed')
  assert.equal(state.inFlightCount(TOKEN), 4)
  assert.equal(state.speculativeInFlightCount(TOKEN), 3)

  srv.releaseAll()
  await foreground
  state.closeAll()
})

test('read-ahead is sequential and forward-only, and stops at the last chunk', () => {
  assert.deepEqual(prefetchIndexesAfter(5, { prefetchAhead: 3, chunkCount: 256 }), [6, 7, 8])
  assert.deepEqual(prefetchIndexesAfter(253, { prefetchAhead: 3, chunkCount: 256 }), [254, 255],
    'read-ahead never runs off the end of the file')
  assert.deepEqual(prefetchIndexesAfter(255, { prefetchAhead: 3, chunkCount: 256 }), [])
  assert.deepEqual(prefetchIndexesAfter(5, { prefetchAhead: 0, chunkCount: 256 }), [])
  assert.equal(withinReadAheadWindow(8, 5, 3), true)
  assert.equal(withinReadAheadWindow(9, 5, 3), false)
  assert.equal(withinReadAheadWindow(4, 5, 3), false, 'chunks already played are not read ahead')
})

// ══ GOAL 1/6 · the ceilings are a function of chunk size, never of file size ══

test('retained plaintext never exceeds 64 MiB on any chunk profile', () => {
  const profiles = [1, 4, 8, 16, 24, 32, 48, 64].map((mib) => mib * MIB)
  for (const chunkSize of profiles) {
    const w = previewChunkWindow({ plaintextChunkSize: chunkSize })
    assert.ok(w.plaintextCeilingBytes <= MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
      `${chunkSize / MIB} MiB chunks retain ${w.plaintextCeilingBytes} B`)
    assert.ok(w.cacheSlots >= 1 && w.cacheSlots <= MAX_PREVIEW_PREFETCH_SLOTS)
    assert.equal(w.prefetchAhead, w.cacheSlots - 1)
  }

  // A chunk larger than the whole budget still has to be readable: one slot,
  // no read-ahead. The cache refuses to retain it (asserted separately below).
  const huge = previewChunkWindow({ plaintextChunkSize: 128 * MIB })
  assert.equal(huge.cacheSlots, 1)
  assert.equal(huge.prefetchAhead, 0)
})

test('the byte budget, not a hard-coded four, decides the window', () => {
  assert.deepEqual(
    (({ cacheSlots, prefetchAhead }) => ({ cacheSlots, prefetchAhead }))(
      previewChunkWindow({ plaintextChunkSize: 16 * MIB }),
    ),
    { cacheSlots: 4, prefetchAhead: 3 },
  )
  assert.deepEqual(
    (({ cacheSlots, prefetchAhead }) => ({ cacheSlots, prefetchAhead }))(
      previewChunkWindow({ plaintextChunkSize: 32 * MIB }),
    ),
    { cacheSlots: 2, prefetchAhead: 1 },
  )
  assert.deepEqual(
    (({ cacheSlots, prefetchAhead }) => ({ cacheSlots, prefetchAhead }))(
      previewChunkWindow({ plaintextChunkSize: 64 * MIB }),
    ),
    { cacheSlots: 1, prefetchAhead: 0 },
  )
  // 4 MiB chunks would allow 16 by pure arithmetic; the slot cap keeps the
  // request fan-out sane without weakening the byte budget.
  assert.equal(previewChunkWindow({ plaintextChunkSize: 4 * MIB }).cacheSlots,
    MAX_PREVIEW_PREFETCH_SLOTS)
})

test('32 MiB profile retains only two plaintext chunks and reads one chunk ahead', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(32 * MIB, 5 * GIB))
  assert.deepEqual(state.windowFor(TOKEN).cacheSlots, 2)

  const srv = gatedLoader(32 * MIB)
  const prefetched = state.readAhead(TOKEN, 0, srv.load, { chunkCount: 160 })
  assert.deepEqual(prefetched, [1], '32 MiB chunks leave room for exactly one chunk ahead')

  const foreground = state.readChunk(TOKEN, 0, srv.load)
  srv.releaseAll()
  await foreground
  await settle()
  for (const index of [2, 3, 4]) {
    const pending = state.readChunk(TOKEN, index, srv.load)
    srv.releaseAll()
    await pending
  }
  await settle()

  assert.ok(state.cachedChunkIndexes(TOKEN).length <= 2, 'never more than two retained')
  assert.ok(state.cacheBytes() <= MAX_PREVIEW_PLAINTEXT_CACHE_BYTES)
  state.closeAll()
})

test('64 MiB profile does no plaintext read-ahead at all', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(64 * MIB, 8 * GIB))
  const srv = gatedLoader(64 * MIB)
  assert.deepEqual(state.readAhead(TOKEN, 0, srv.load, { chunkCount: 128 }), [])
  assert.equal(state.windowFor(TOKEN).maxSpeculativeInFlight, 0)
  assert.equal(state.windowFor(TOKEN).maxTotalInFlight, 1,
    'with no speculative work there is nothing for a reserve slot to protect against')
  state.closeAll()
})

test('the 64 MiB retained ceiling holds while a 16 MiB profile streams many chunks', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const srv = gatedLoader(16 * MIB)

  for (let index = 0; index < 12; index += 1) {
    state.readAhead(TOKEN, index, srv.load, { chunkCount: 256 })
    const pending = state.readChunk(TOKEN, index, srv.load)
    srv.releaseAll()
    await pending
    // ⚠️ The byte ceiling is the invariant, and it is enforced synchronously as
    //    each chunk finishes decrypting — never after the fact. Entry *count*
    //    is allowed a moment where a freshly armed read-ahead slot exists but
    //    holds nothing yet, so it is checked once the window has settled.
    assert.ok(state.cacheBytes() <= MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
      `retained ${state.cacheBytes()} B after chunk ${index}`)
    await settle(16)
    assert.ok(state.cachedChunkIndexes(TOKEN).length <= 4,
      `retained ${state.cachedChunkIndexes(TOKEN).length} chunks after chunk ${index}`)
    assert.ok(state.cacheBytes() <= MAX_PREVIEW_PLAINTEXT_CACHE_BYTES)
  }
  assert.equal(state.cacheBytes(), 4 * 16 * MIB, 'the window settles exactly at the budget')
  state.closeAll()
})

test('eviction drops the chunk already played, never the chunk read ahead', async () => {
  // ⚠️ This is the failure mode a cache-size assertion alone cannot see. Playback
  //    touches the current chunk, so under plain LRU the *current* chunk looks
  //    freshest while N+1 — fetched but not yet read — looks stalest and gets
  //    evicted about a second before the player needs it. Read-ahead would then
  //    re-fetch every chunk it had just fetched, and the pipeline would be no
  //    faster than the demand-driven one it replaced.
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const srv = gatedLoader(16 * MIB)

  for (const index of [0, 1, 2, 3]) {
    state.readAhead(TOKEN, index, srv.load, { chunkCount: 256 })
    const pending = state.readChunk(TOKEN, index, srv.load)
    srv.releaseAll()
    await pending
    await settle(16)
    const resident = state.cachedChunkIndexes(TOKEN)
    assert.ok(resident.length <= 4)
    for (const ahead of [index + 1, index + 2, index + 3]) {
      assert.ok(resident.includes(ahead),
        `chunk ${ahead} was read ahead for foreground ${index} and must still be resident`)
    }
    for (const played of resident) {
      assert.ok(played >= index, `chunk ${played} is behind the player and should have been dropped`)
    }
  }
  state.closeAll()
})

test('a single chunk larger than the whole budget is served but never retained', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(128 * MIB, 4 * GIB))
  const value = await state.readChunk(TOKEN, 0, async () => ({ byteLength: 128 * MIB }))
  assert.equal(value.byteLength, 128 * MIB, 'playback is not refused')
  assert.deepEqual(state.cachedChunkIndexes(TOKEN), [], 'but it does not sit in memory afterwards')
  assert.equal(state.cacheBytes(), 0)
  state.closeAll()
})

// ══ GOAL 2/7 · real concurrency, and foreground is never queued behind it ════

test('speculative work is capped below the slot count so foreground always has room', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const srv = gatedLoader()

  state.readAhead(TOKEN, 0, srv.load, { chunkCount: 256 })
  await settle()
  assert.equal(state.speculativeInFlightCount(TOKEN), 3)
  assert.ok(state.speculativeInFlightCount(TOKEN) < state.windowFor(TOKEN).cacheSlots + 1)

  // Nothing foreground has run yet, and three speculative loads hold slots.
  const foreground = state.readChunk(TOKEN, 40, srv.load)
  await settle()
  assert.ok(srv.started().includes(40), 'the foreground chunk starts without waiting')
  srv.releaseAll()
  await foreground
  state.closeAll()
})

test('a speculative queue cannot starve the foreground chunk', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const srv = gatedLoader()

  // Saturate: foreground 10 running plus the three read-ahead loads it armed.
  state.readAhead(TOKEN, 10, srv.load, { chunkCount: 256 })
  const first = state.readChunk(TOKEN, 10, srv.load)
  await settle()
  assert.equal(state.inFlightCount(TOKEN), 4)

  // More speculative work now has nowhere to go and must queue.
  state.prefetch(TOKEN, [20, 21, 22], srv.load)
  await settle()
  assert.ok(state.queuedCount(TOKEN) >= 3, 'speculative overflow queues rather than piling on')
  assert.ok(!srv.started().includes(20), 'a queued speculative load has not touched the network')

  // The player asks for a chunk while every ordinary slot is taken.
  const urgent = state.readChunk(TOKEN, 99, srv.load)
  await settle()
  assert.ok(srv.started().includes(99),
    'the reserved slot means foreground never waits behind speculative work')
  assert.ok(!srv.started().includes(20), 'and the queued speculative work still has not jumped it')

  srv.releaseAll()
  await Promise.all([first, urgent])
  state.closeAll()
})

test('purely foreground demand still respects the ordinary in-flight ceiling', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const srv = gatedLoader()
  const pending = [0, 1, 2, 3, 4, 5].map((index) => state.readChunk(TOKEN, index, srv.load))
  await settle()
  assert.equal(srv.started().length, 4,
    'the reserve slot opens only when speculative work is the thing holding capacity')
  srv.releaseAll()
  await settle()
  srv.releaseAll()
  await Promise.all(pending.map((p) => p.catch(() => {})))
  state.closeAll()
})

// ══ GOAL 3 · prefetch promise reuse ═════════════════════════════════════════

test('a foreground request joins the existing prefetch Promise instead of loading again', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const srv = gatedLoader()

  state.readAhead(TOKEN, 0, srv.load, { chunkCount: 256 })
  await settle()
  assert.deepEqual(srv.started().sort((a, b) => a - b), [1, 2, 3])

  const joined = state.readChunk(TOKEN, 1, srv.load)
  await settle()
  assert.equal(srv.started().filter((i) => i === 1).length, 1,
    'chunk 1 was loaded exactly once even though two callers wanted it')

  srv.release(1)
  const value = await joined
  assert.equal(value.byteLength, 8, 'the range is served from the shared prefetch result')
  srv.releaseAll()
  state.closeAll()
})

test('a foreground request promotes a still-queued prefetch ahead of other speculative work', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const srv = gatedLoader()

  state.readAhead(TOKEN, 0, srv.load, { chunkCount: 256 })
  const held = state.readChunk(TOKEN, 0, srv.load)
  await settle()
  assert.equal(state.inFlightCount(TOKEN), 4)

  state.prefetch(TOKEN, [30, 31], srv.load)
  await settle()
  assert.ok(!srv.started().includes(30), 'still queued')

  // The player now genuinely wants chunk 30: it must not stay speculative.
  const promoted = state.readChunk(TOKEN, 30, srv.load)
  await settle()
  assert.ok(srv.started().includes(30), 'a queued prefetch that becomes foreground starts at once')
  assert.equal(srv.started().filter((i) => i === 30).length, 1, 'and it is still one load, not two')

  srv.releaseAll()
  await Promise.all([held, promoted])
  state.closeAll()
})

// ══ GOAL 4 · seek reprioritization ══════════════════════════════════════════

test('seeking to a distant chunk reprioritizes immediately and rebuilds the window', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const srv = gatedLoader()

  state.readAhead(TOKEN, 10, srv.load, { chunkCount: 256 })
  const playing = state.readChunk(TOKEN, 10, srv.load)
  await settle()
  assert.deepEqual(srv.started().sort((a, b) => a - b), [10, 11, 12, 13])

  // The user seeks to chunk 50.
  const rearmed = state.readAhead(TOKEN, 50, srv.load, { chunkCount: 256 })
  const seeked = state.readChunk(TOKEN, 50, srv.load)
  await settle()

  assert.deepEqual(rearmed, [51, 52, 53], 'the read-ahead window follows the seek')
  assert.equal(state.foregroundIndex(TOKEN), 50)
  assert.ok(srv.started().includes(50), 'chunk 50 starts immediately, not after 11/12/13 finish')
  assert.ok(!srv.started().includes(51),
    'and the new speculative work waits behind the chunk the user is actually watching')

  srv.releaseAll()
  await Promise.all([playing.catch(() => {}), seeked])
  state.closeAll()
})

test('queued speculative work outside the new window is discarded on a seek', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const srv = gatedLoader()

  state.readAhead(TOKEN, 10, srv.load, { chunkCount: 256 })
  const playing = state.readChunk(TOKEN, 10, srv.load)
  await settle()

  // Every slot is busy, so this window's read-ahead can only queue.
  state.readAhead(TOKEN, 50, srv.load, { chunkCount: 256 })
  await settle()
  assert.equal(state.queuedCount(TOKEN), 3, '51/52/53 are queued, not running')
  assert.equal(state.discardedSpeculativeCount(), 0)

  // A second seek makes 51/52/53 irrelevant before they ever reached the network.
  const rearmed = state.readAhead(TOKEN, 90, srv.load, { chunkCount: 256 })
  await settle()
  assert.deepEqual(rearmed, [91, 92, 93])
  assert.equal(state.discardedSpeculativeCount(), 3,
    'stale speculative work is dropped rather than left to delay the live window')
  for (const stale of [51, 52, 53]) {
    assert.ok(!srv.started().includes(stale), `chunk ${stale} never became an HTTP request`)
  }
  assert.deepEqual(state.cachedChunkIndexes(TOKEN).filter((i) => [51, 52, 53].includes(i)), [],
    'a discarded prefetch leaves no cache entry behind')

  srv.releaseAll()
  await playing
  state.closeAll()
})

test('read-ahead started while a chunk is still cached is not re-issued', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const srv = gatedLoader(1024)
  state.readAhead(TOKEN, 0, srv.load, { chunkCount: 256 })
  const first = state.readChunk(TOKEN, 0, srv.load)
  srv.releaseAll()
  await first
  await settle()

  const again = state.readAhead(TOKEN, 0, srv.load, { chunkCount: 256 })
  assert.deepEqual(again, [], 'nothing is re-fetched while the window is already resident')
  state.closeAll()
})

// ══ GOAL 5 · session security and invalidation ══════════════════════════════

test('closing the preview invalidates every foreground and read-ahead load', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const signal = state.sessionSignal(TOKEN)
  const srv = gatedLoader()

  state.readAhead(TOKEN, 0, srv.load, { chunkCount: 256 })
  const foreground = state.readChunk(TOKEN, 0, srv.load)
  state.prefetch(TOKEN, [40, 41], srv.load)
  await settle()

  state.close(TOKEN)
  assert.equal(signal.aborted, true, 'session-owned loads lose their signal')
  srv.releaseAll()                       // bytes arrive after the close
  await assert.rejects(foreground, 'no late plaintext may be delivered')
  await settle()
  assert.deepEqual(state.cachedChunkIndexes(TOKEN), [])
  assert.equal(state.queuedCount(TOKEN), 0, 'queued read-ahead is dropped, not merely ignored')
  assert.equal(state.get(TOKEN), null)
})

test('locking the Vault invalidates every foreground and read-ahead load', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const signal = state.sessionSignal(TOKEN)
  const srv = gatedLoader()

  state.readAhead(TOKEN, 7, srv.load, { chunkCount: 256 })
  const foreground = state.readChunk(TOKEN, 7, srv.load)
  await settle()
  assert.equal(state.inFlightCount(TOKEN), 4)

  state.closeAll()                        // exactly what Vault lock / auto-lock runs
  assert.equal(signal.aborted, true)
  srv.releaseAll()
  await assert.rejects(foreground, 'plaintext must not reach a locked Vault')
  await settle()
  assert.equal(state.cacheSize(), 0)
  assert.equal(state.sessionCount(), 0)
  assert.equal(state.inFlightCount(TOKEN), 0)
  assert.equal(state.queuedCount(TOKEN), 0)
})

test('session replacement leaves no read-ahead work owned by the replaced session', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  const first = state.sessionSignal(TOKEN)
  const srv = gatedLoader()
  state.readAhead(TOKEN, 3, srv.load, { chunkCount: 256 })
  await settle()

  state.open(TOKEN, logicalSession(16 * MIB, 4 * GIB))
  assert.equal(first.aborted, true)
  assert.equal(state.sessionSignal(TOKEN).aborted, false)
  assert.deepEqual(state.cachedChunkIndexes(TOKEN), [], 'no plaintext crosses the replacement')
  assert.equal(state.queuedCount(TOKEN), 0)
  srv.releaseAll()
  state.closeAll()
})

// ══ GOAL 8 · diagnostics stay opt-in and allow-listed ═══════════════════════

test('throughput diagnostics are opt-in, allow-listed, and carry no secret material', () => {
  const off = []
  createPreviewDiagnostics({ enabled: false, emit: (r) => off.push(r) })
    .record('read-ahead', { foregroundChunkIndex: 5 })
  assert.deepEqual(off, [], 'diagnostics are silent unless explicitly enabled')

  const seen = []
  const diag = createPreviewDiagnostics({ enabled: true, emit: (r) => seen.push(r) })
  diag.record('read-ahead', {
    foregroundChunkIndex: 5,
    prefetchIndexes: [6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    inFlightLoads: 4,
    prefetchHits: 2,
    prefetchMisses: 1,
    discardedSpeculativeChunks: 3,
    retainedPlaintextBytes: 64 * MIB,
    ciphertextBytesFetched: 16 * MIB,
    ciphertextMbPerSecond: 4.19,
    decryptMbPerSecond: 210.5,
    // Everything below must be dropped: none of it is an operational metric.
    dek: 'KEY', kek: 'KEY', passphrase: 'hunter2', plaintext: 'bytes',
    filename: 'START_LIVE.mp4', cookie: 'sid=1', authorization: 'Bearer x',
  })
  const record = seen[0]
  assert.equal(record.event, 'read-ahead')
  assert.equal(record.foregroundChunkIndex, 5)
  assert.equal(record.inFlightLoads, 4)
  assert.equal(record.retainedPlaintextBytes, 64 * MIB)
  assert.equal(record.ciphertextMbPerSecond, 4.19)
  assert.equal(record.prefetchIndexes.length, 8, 'index arrays stay bounded')
  for (const forbidden of ['dek', 'kek', 'passphrase', 'plaintext', 'filename', 'cookie', 'authorization']) {
    assert.equal(forbidden in record, false, `${forbidden} must never be emitted`)
  }
})

test('throughput is reported in real MB/s and refuses to invent a number', () => {
  assert.equal(mbPerSecond(16 * MIB, 4000), 4.19, '16 MiB in 4 s ≈ the observed production rate')
  assert.equal(mbPerSecond(16 * MIB, 0), null, 'a zero-duration measurement has no rate')
  assert.equal(mbPerSecond(0, 1000), null)
  assert.equal(mbPerSecond(16 * MIB, -1), null)
})

// ══ GOAL 7 (window) · the 16 MiB Range window is unchanged ══════════════════

test('the bounded virtual Range window is still 16 MiB', () => {
  assert.equal(PREVIEW_RANGE_WINDOW_BYTES, 16 * MIB,
    'the fix is read-ahead and concurrency, not a larger Range response')
  const session = logicalSession(16 * MIB, Math.floor(1.1 * GIB))
  const result = planPreviewResponse(session, { rangeHeader: 'bytes=83886080-' })
  assert.equal(result.status, 206)
  assert.equal(Number(result.headers['Content-Length']), 16 * MIB)
  assert.equal(result.headers['Content-Range'], `bytes 83886080-100663295/${session.plainSize}`)
  assert.deepEqual(result.plan.map((step) => step.index), [5],
    'the production Content-Range maps to exactly one 16 MiB chunk')
})

// ══ GOAL 13/14 · bounded for enormous logical files ═════════════════════════

test('1.1 GiB, 5 GiB and 32 GiB logical files stay bounded without allocating them', async () => {
  for (const size of [Math.floor(1.1 * GIB), 5 * GIB, 32 * GIB]) {
    const state = createPreviewWorkerState()
    const session = logicalSession(16 * MIB, size)
    state.open(TOKEN, session)
    const window = state.windowFor(TOKEN)
    assert.equal(window.cacheSlots, 4, `logical ${size} B must not widen the window`)
    assert.equal(window.plaintextCeilingBytes, MAX_PREVIEW_PLAINTEXT_CACHE_BYTES)
    assert.equal(window.ciphertextCeilingBytes, 5 * (16 * MIB + GCM_TAG_BYTES),
      'transient ciphertext is four slots plus the one foreground reserve')

    const srv = gatedLoader(16 * MIB)
    const started = state.readAhead(TOKEN, 0, srv.load, { chunkCount: session.blob.chunkCount })
    const foreground = state.readChunk(TOKEN, 0, srv.load)
    await settle()
    assert.deepEqual(started, [1, 2, 3], 'the same three chunks ahead regardless of file size')
    assert.equal(state.inFlightCount(TOKEN), 4)
    srv.releaseAll()
    await foreground
    assert.ok(state.cacheBytes() <= MAX_PREVIEW_PLAINTEXT_CACHE_BYTES)
    state.closeAll()
  }
})

test('the read-ahead count depends on the memory budget and chunk size, never on file size', () => {
  const sizes = [100 * MIB, Math.floor(1.1 * GIB), 5 * GIB, 32 * GIB, 512 * GIB]
  const reference = previewChunkWindow({ plaintextChunkSize: 16 * MIB })
  for (const size of sizes) {
    const state = createPreviewWorkerState()
    state.open(TOKEN, logicalSession(16 * MIB, size))
    assert.deepEqual(state.windowFor(TOKEN), reference,
      `logical ${size} B produced a different window`)
    state.closeAll()
  }
  // Halving the budget halves the window; the file size never entered the sum.
  assert.equal(previewChunkWindow({
    plaintextChunkSize: 16 * MIB, maxPlaintextBytes: 32 * MIB,
  }).cacheSlots, 2)
})

// ══ GOAL 9 (8/11/12) · real crypto, real streams, E3.2 behaviour intact ═════

const CHUNK = 1024
const sourceBytes = (n) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + 7) & 0xff
  return b
}

/** One real V2 blob plus a ciphertext server that counts every GET. */
async function makeVaultBlob({ plainSize = CHUNK * 8, id = 'b'.repeat(48) } = {}) {
  const subtle = globalThis.crypto.subtle
  const kek = await subtle.importKey(
    'raw', new Uint8Array(32).fill(5), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'],
  )
  const plain = sourceBytes(plainSize)
  const plan = planVaultChunks(plainSize, CHUNK)
  const envelope = await createVaultV2Envelope(kek, {
    name: 'clip.mp4', type: 'video/mp4', size: plainSize, chunkCount: plan.chunkCount,
  })
  const stored = new Map()
  for (let i = 0; i < plan.chunkCount; i += 1) {
    const slice = plain.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, plainSize))
    const enc = await encryptVaultChunk(envelope.dek, {
      contentId: envelope.contentId, chunkIndex: i, chunkCount: plan.chunkCount, plaintext: slice,
    })
    stored.set(i, { ciphertext: enc.ciphertext, ivB64: enc.ivB64 })
  }
  return {
    plain,
    stored,
    session: {
      dek: envelope.dek,
      contentType: 'video/mp4',
      plainSize,
      blob: {
        id, contentIdB64: envelope.contentIdB64, chunkSize: plan.chunkSize, chunkCount: plan.chunkCount,
      },
    },
  }
}

function countingServer(fixture, { corrupt = null } = {}) {
  const gets = []
  let failWith = null
  const fetchImpl = (url) => {
    const index = Number(String(url).split('/').pop())
    gets.push(index)
    return Promise.resolve().then(() => {
      if (failWith === 'network') throw new TypeError('Failed to fetch')
      if (failWith === 'http') return { ok: false, status: 502, headers: { get: () => null } }
      const entry = fixture.stored.get(index)
      if (!entry) return { ok: false, status: 404, headers: { get: () => null } }
      const bytes = Uint8Array.from(entry.ciphertext)
      if (corrupt === index) bytes[0] ^= 0xff
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h === 'X-Vault-Chunk-IV' ? entry.ivB64 : null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      }
    })
  }
  return { fetchImpl, gets: () => [...gets], countOf: (i) => gets.filter((g) => g === i).length, fail: (m) => { failWith = m } }
}

/** One Range response wired exactly as src/vaultPreviewServiceWorker.js wires it. */
function rangeResponse(fixture, state, srv, rangeHeader) {
  const failures = []
  const plan = planPreviewResponse(fixture.session, { rangeHeader })
  const loaderFor = (options) => (loadIndex, load = {}) => readPlainChunk(fixture.session, loadIndex, {
    ...options, signal: load.signal ?? null,
  })
  const stream = createPreviewStream(fixture.session, plan.plan, {
    fetchImpl: srv.fetchImpl,
    base: BASE,
    onFailure: (reason) => failures.push(reason),
    readChunk: (_session, index, options) => {
      state.readAhead(TOKEN, index, loaderFor(options), {
        chunkCount: fixture.session.blob.chunkCount,
      })
      return state.readChunk(TOKEN, index, loaderFor(options))
    },
  })
  return { plan, stream, reader: stream.getReader(), failures }
}

test('a prefetched chunk is never fetched a second time when the browser asks for it', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = countingServer(fx)

  // Chunk 0 plays; read-ahead arms 1, 2, 3 (1 KiB chunks → four slots).
  const first = rangeResponse(fx, state, srv, 'bytes=0-99')
  const got = await first.reader.read()
  assert.deepEqual(got.value, fx.plain.subarray(0, 100))
  await settle(16)
  assert.ok(srv.gets().includes(1), 'read-ahead really issued the next chunk')

  // The player now asks for chunk 1 — this must join, not re-request.
  const next = rangeResponse(fx, state, srv, `bytes=${CHUNK}-${CHUNK + 99}`)
  const second = await next.reader.read()
  assert.deepEqual(second.value, fx.plain.subarray(CHUNK, CHUNK + 100))
  assert.equal(srv.countOf(1), 1, 'exactly one ciphertext GET for a chunk that was read ahead')

  assert.deepEqual(first.failures, [])
  assert.deepEqual(next.failures, [])
  await first.reader.cancel()
  await next.reader.cancel()
  state.closeAll()
})

test('cancelling a Range while read-ahead is in flight stays benign (E3.2 regression)', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = countingServer(fx)

  const a = rangeResponse(fx, state, srv, 'bytes=0-99')
  const read = a.reader.read()
  await settle()
  await a.reader.cancel()                 // Chromium supersedes this response
  await settle(16)
  await read.catch(() => {})

  assert.deepEqual(a.failures, [],
    'a superseded response must stay silent even with speculative work running')

  // The live response still works and still reports nothing.
  const b = rangeResponse(fx, state, srv, `bytes=${CHUNK * 2}-${CHUNK * 2 + 99}`)
  const value = (await b.reader.read()).value
  assert.deepEqual(value, fx.plain.subarray(CHUNK * 2, CHUNK * 2 + 100))
  assert.deepEqual(b.failures, [])
  await b.reader.cancel()
  state.closeAll()
})

test('an integrity failure on the foreground chunk remains fatal', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = countingServer(fx, { corrupt: 2 })

  const res = rangeResponse(fx, state, srv, `bytes=${CHUNK * 2}-${CHUNK * 2 + 99}`)
  await assert.rejects(res.reader.read(), 'no byte of an unauthenticated chunk may be served')
  assert.deepEqual(res.failures, [PREVIEW_FAILURE.INTEGRITY])
  assert.equal(PREVIEW_FAILURE.INTEGRITY, PREVIEW_FAILURE_REASON.INTEGRITY_FAILED)
  assert.deepEqual(state.cachedChunkIndexes(TOKEN).filter((i) => i === 2), [],
    'a chunk that failed authentication is never retained')
  state.closeAll()
})

test('a failing read-ahead chunk stays silent while the foreground failure still reports', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  // Chunk 1 is only ever speculative here; corrupting it must not announce.
  const srv = countingServer(fx, { corrupt: 1 })

  const res = rangeResponse(fx, state, srv, 'bytes=0-99')
  const got = await res.reader.read()
  assert.deepEqual(got.value, fx.plain.subarray(0, 100))
  await settle(16)
  assert.deepEqual(res.failures, [],
    'a speculative chunk nobody asked for must not mark the preview broken')

  // Asked for as foreground, the very same corrupt chunk is fatal.
  const wanted = rangeResponse(fx, state, srv, `bytes=${CHUNK}-${CHUNK + 99}`)
  await assert.rejects(wanted.reader.read())
  assert.deepEqual(wanted.failures, [PREVIEW_FAILURE.INTEGRITY])
  await res.reader.cancel()
  state.closeAll()
})

test('a real network error on the foreground chunk remains fatal', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = countingServer(fx)
  srv.fail('network')

  const res = rangeResponse(fx, state, srv, 'bytes=0-99')
  await assert.rejects(res.reader.read())
  assert.deepEqual(res.failures, [PREVIEW_FAILURE.FETCH],
    'a genuine transport fault is still reported, read-ahead or not')
  state.closeAll()
})

test('an HTTP error on the foreground chunk remains fatal', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = countingServer(fx)
  srv.fail('http')

  const res = rangeResponse(fx, state, srv, 'bytes=0-99')
  await assert.rejects(res.reader.read())
  assert.deepEqual(res.failures, [PREVIEW_FAILURE.FETCH])
  state.closeAll()
})

test('closing the preview mid-playback stops read-ahead and delivers no late plaintext', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = countingServer(fx)

  const res = rangeResponse(fx, state, srv, 'bytes=0-99')
  await res.reader.read()
  await settle(16)
  const before = srv.gets().length
  assert.ok(before > 1, 'read-ahead was active')

  state.close(TOKEN)
  await settle(16)
  assert.equal(state.get(TOKEN), null)
  assert.deepEqual(state.cachedChunkIndexes(TOKEN), [], 'no plaintext survives the close')
  assert.equal(state.queuedCount(TOKEN), 0)
  assert.deepEqual(res.failures, [], 'a deliberate close is not a preview failure')
  await res.reader.cancel()
})
