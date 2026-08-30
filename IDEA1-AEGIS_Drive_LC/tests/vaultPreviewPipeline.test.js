// tests/vaultPreviewPipeline.test.js — AEGIS Drive (IDEA1) · LFT-V2-E3.3
//
// These tests pin the throughput scheduler at its observable boundary. The
// network/decrypt operation is the only test double: queue ordering, sharing,
// eviction, cancellation and failure retention are the real worker-state code.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPreviewWorkerState,
  MAX_PREVIEW_CACHED_CHUNKS,
  MAX_PREVIEW_CONCURRENT_LOADS,
  MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
} from '../src/lib/vaultPreviewWorkerState.js'
import { PREVIEW_FAILURE_REASON } from '../src/lib/vaultPreviewErrors.js'

const TOKEN = 'a'.repeat(32)
const MIB = 1024 * 1024
const session = (id = 'blob-a', chunkCount = 64) => ({
  dek: {},
  blob: { id, chunkCount },
  plainSize: chunkCount * 16 * MIB,
  contentType: 'video/mp4',
})

const settle = async (turns = 12) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
  await new Promise((resolve) => setImmediate(resolve))
}

function heldLoader() {
  const started = []
  const releases = new Map()
  let active = 0
  let maxActive = 0
  const load = (index, { signal } = {}) => new Promise((resolve, reject) => {
    started.push(index)
    active += 1
    maxActive = Math.max(maxActive, active)
    let settled = false
    const finish = (fn) => {
      if (settled) return
      settled = true
      active -= 1
      fn()
    }
    releases.set(index, () => finish(() => resolve(new Uint8Array([index & 0xff]))))
    const abort = () => finish(() => reject(signal.reason ?? new DOMException('aborted', 'AbortError')))
    if (signal?.aborted) abort()
    else signal?.addEventListener?.('abort', abort, { once: true })
  })
  return {
    load,
    started: () => [...started],
    maxActive: () => maxActive,
    release: (index) => releases.get(index)?.(),
  }
}

test('demand N starts immediately and only N+1/N+2 are scheduled ahead', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, session())
  const held = heldLoader()

  const demanded = state.readChunk(TOKEN, 5, held.load, { prefetchIndexes: [6, 7] })
  await settle()
  assert.deepEqual(held.started(), [5, 6], 'demand occupies the first slot and one bounded prefetch uses the second')

  held.release(5)
  await demanded
  await settle()
  assert.deepEqual(held.started(), [5, 6, 7], 'N+2 starts only when one of the two slots is free')
  assert.equal(held.started().includes(8), false, 'the scheduler never walks the rest of the file')

  held.release(6)
  held.release(7)
  state.closeAll()
})

test('ciphertext fetch/decrypt concurrency never exceeds two', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, session())
  const held = heldLoader()

  const demanded = state.readChunk(TOKEN, 0, held.load, { prefetchIndexes: [1, 2] })
  await settle()
  assert.equal(held.maxActive(), 2)
  held.release(0)
  await demanded
  await settle()
  assert.equal(held.maxActive(), 2)
  held.release(1)
  held.release(2)
  state.closeAll()
})

test('three 16 MiB chunks fit while the 64 MiB byte ceiling stays authoritative', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, session())
  const sixteen = async () => ({ byteLength: 16 * MIB })

  await state.readChunk(TOKEN, 0, sixteen)
  await state.readChunk(TOKEN, 1, sixteen)
  await state.readChunk(TOKEN, 2, sixteen)
  assert.equal(state.cacheSize(), 3)
  assert.equal(state.cacheBytes(), 48 * MIB)

  await state.readChunk(TOKEN, 3, sixteen)
  assert.equal(state.cacheSize(), 3, 'the entry ceiling evicts one old chunk')
  assert.equal(state.cacheBytes(), 48 * MIB)
  assert.equal(MAX_PREVIEW_CACHED_CHUNKS, 3)
  assert.equal(MAX_PREVIEW_CONCURRENT_LOADS, 2)
  assert.equal(MAX_PREVIEW_PLAINTEXT_CACHE_BYTES, 64 * MIB)
})

test('three 32 MiB chunks are reduced to two by the byte ceiling', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, session())
  const thirtyTwo = async () => ({ byteLength: 32 * MIB })

  await state.readChunk(TOKEN, 0, thirtyTwo)
  await state.readChunk(TOKEN, 1, thirtyTwo)
  await state.readChunk(TOKEN, 2, thirtyTwo)
  assert.equal(state.cacheSize(), 2)
  assert.equal(state.cacheBytes(), 64 * MIB)
  assert.deepEqual(state.cachedChunkIndexes(TOKEN), [1, 2])
})

test('a distant demand preempts and aborts stale prefetch instead of waiting for it', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, session())
  const held = heldLoader()

  const oldDemand = state.readChunk(TOKEN, 5, held.load, { prefetchIndexes: [6, 7] })
  await settle()
  assert.deepEqual(held.started(), [5, 6])

  const seek = state.readChunk(TOKEN, 50, held.load, { prefetchIndexes: [51, 52] })
  await settle()
  assert.deepEqual(held.started(), [5, 6, 50], 'chunk 50 starts while old demand 5 is still in flight')
  assert.equal(held.started().includes(7), false, 'queued stale prefetch never starts ahead of the seek')

  held.release(50)
  assert.equal((await seek)[0], 50)
  held.release(5)
  await oldDemand
  await settle()
  held.release(51)
  held.release(52)
  state.closeAll()
})

test('an adjacent chunk required by the current Range is promoted ahead of queued prefetch', async () => {
  const state = createPreviewWorkerState({ maxConcurrentLoads: 1 })
  state.open(TOKEN, session())
  const held = heldLoader()

  const first = state.readChunk(TOKEN, 0, held.load, { prefetchIndexes: [1, 2] })
  await settle()
  assert.deepEqual(held.started(), [0])
  const adjacent = state.readChunk(TOKEN, 1, held.load, { prefetchIndexes: [2, 3] })
  held.release(0)
  await first
  await settle()
  assert.deepEqual(held.started(), [0, 1], 'demanded boundary chunk is promoted before speculative chunk 2')
  held.release(1)
  await adjacent
  await settle()
  held.release(2)
  held.release(3)
  state.closeAll()
})

test('look-ahead stops at blob.chunkCount and never wraps beyond EOF', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, session('short', 6))
  const seen = []
  const load = async (index) => { seen.push(index); return new Uint8Array([index]) }

  await state.readChunk(TOKEN, 5, load, { prefetchIndexes: [6, 7] })
  await settle()
  assert.deepEqual(seen, [5])
})

test('a demanded chunk already prefetched is reused without a second ciphertext fetch', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, session())
  const calls = []
  const load = async (index) => { calls.push(index); return new Uint8Array([index]) }

  await state.readChunk(TOKEN, 0, load, { prefetchIndexes: [1, 2] })
  await settle()
  assert.equal(calls.filter((index) => index === 1).length, 1)
  assert.equal((await state.readChunk(TOKEN, 1, load, { prefetchIndexes: [2, 3] }))[0], 1)
  assert.equal(calls.filter((index) => index === 1).length, 1, 'demand consumes prefetched plaintext')
})

test('scheduler diagnostics expose queue/load/prefetch metrics without session identifiers', async () => {
  const diagnostics = []
  const cacheEvents = []
  const state = createPreviewWorkerState({
    onDiagnostic: (event, fields) => diagnostics.push({ event, ...fields }),
    onCacheEvent: (kind) => cacheEvents.push(kind),
  })
  state.open(TOKEN, session())
  const load = async (index) => new Uint8Array([index])

  await state.readChunk(TOKEN, 10, load, { prefetchIndexes: [11, 12] })
  await settle()
  await state.readChunk(TOKEN, 11, load, { prefetchIndexes: [12, 13] })
  await settle()

  const starts = diagnostics.filter((entry) => entry.event === 'load-start')
  assert.ok(starts.some((entry) => entry.demandChunkIndex === 10))
  assert.ok(starts.some((entry) => entry.prefetchedChunkIndex === 11))
  assert.ok(starts.every((entry) => entry.activeLoadCount <= 2))
  assert.ok(starts.every((entry) => Number.isFinite(entry.queueWaitDurationMs)))
  assert.ok(cacheEvents.includes('prefetch-miss'))
  assert.ok(cacheEvents.includes('prefetch-hit'))
  const serialised = JSON.stringify(diagnostics)
  assert.equal(serialised.includes(TOKEN), false)
  assert.equal(serialised.includes('blob-a'), false)
})

test('prefetch transport failure is fail-soft, then a demanded retry reports a real failure', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, session())
  let attempts = 0
  const load = async (index) => {
    if (index === 1) {
      attempts += 1
      throw Object.assign(new Error('network unavailable'), {
        previewFailure: PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED,
      })
    }
    return new Uint8Array([index])
  }

  assert.equal((await state.readChunk(TOKEN, 0, load, { prefetchIndexes: [1] }))[0], 0)
  await settle()
  assert.equal(attempts, 1, 'failed prefetch was attempted without rejecting the demanded chunk')

  await assert.rejects(
    state.readChunk(TOKEN, 1, load),
    (err) => err.previewFailure === PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED,
  )
  assert.equal(attempts, 2, 'transport failure is not cached; demand performs a real retry')
})

test('integrity failure discovered by prefetch becomes fatal when that chunk is demanded', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, session())
  let attempts = 0
  const loaded = []
  const load = async (index) => {
    loaded.push(index)
    if (index === 1) {
      attempts += 1
      throw Object.assign(new Error('chunk auth failed'), {
        previewFailure: PREVIEW_FAILURE_REASON.INTEGRITY_FAILED,
      })
    }
    return new Uint8Array([index])
  }

  await state.readChunk(TOKEN, 0, load, { prefetchIndexes: [1] })
  await settle()
  assert.equal(attempts, 1)
  await assert.rejects(
    state.readChunk(TOKEN, 1, load, { prefetchIndexes: [2, 3] }),
    (err) => err.previewFailure === PREVIEW_FAILURE_REASON.INTEGRITY_FAILED,
  )
  await settle()
  assert.equal(attempts, 1, 'known unauthenticated ciphertext is never silently retried or cached as plaintext')
  assert.deepEqual(loaded, [0, 1], 'fatal integrity demand does not launch more speculative plaintext work')
  assert.equal(state.cachedChunkIndexes(TOKEN).includes(1), false)
})

test('close, lock and replacement invalidate cached and in-flight prefetch', async () => {
  for (const lifecycle of ['close', 'lock', 'replace']) {
    const state = createPreviewWorkerState()
    state.open(TOKEN, session())
    const held = heldLoader()
    const demand = state.readChunk(TOKEN, 0, held.load, { prefetchIndexes: [1, 2] })
    await settle()
    held.release(0)
    await demand
    await settle()

    if (lifecycle === 'close') state.close(TOKEN)
    else if (lifecycle === 'lock') state.closeAll()
    else state.open(TOKEN, session('replacement'))
    await settle()

    assert.deepEqual(state.cachedChunkIndexes(TOKEN), [], `${lifecycle} removes prefetched plaintext`)
    const oldStarts = held.started().length
    if (lifecycle === 'replace') {
      assert.equal((await state.readChunk(TOKEN, 1, async () => new Uint8Array([9])))[0], 9)
      assert.equal(held.started().length, oldStarts, 'replacement does not reuse the old loader')
    }
    state.closeAll()
  }
})

test('replacement never shares an old in-flight chunk even when the old loader ignores abort', async () => {
  const state = createPreviewWorkerState()
  state.open(TOKEN, session('old'))
  let releaseOld
  const old = state.readChunk(TOKEN, 4, () => new Promise((resolve) => { releaseOld = resolve }))
  await settle()

  state.open(TOKEN, session('new'))
  let newLoads = 0
  const current = state.readChunk(TOKEN, 4, async () => {
    newLoads += 1
    return new Uint8Array([9])
  })
  await settle()
  assert.equal(newLoads, 1, 'new session gets independent work instead of the old session Promise')
  assert.equal((await current)[0], 9)

  releaseOld(new Uint8Array([4]))
  await assert.rejects(old, /session closed/)
  assert.deepEqual(state.cachedChunkIndexes(TOKEN), [4], 'late old plaintext cannot replace the new cache entry')
  state.closeAll()
})

test('a lazy Range response from the replaced session cannot load or cache plaintext', async () => {
  const state = createPreviewWorkerState()
  const oldSession = session('old')
  const newSession = session('new')
  state.open(TOKEN, oldSession)

  let oldLoads = 0
  const pullOldRange = () => state.readChunk(TOKEN, 4, async () => {
    oldLoads += 1
    return new Uint8Array([4])
  }, { expectedSession: oldSession })

  state.open(TOKEN, newSession)
  await assert.rejects(pullOldRange(), /session closed/)
  assert.equal(oldLoads, 0, 'a stale response is rejected before its loader starts')

  let newLoads = 0
  assert.equal((await state.readChunk(TOKEN, 4, async () => {
    newLoads += 1
    return new Uint8Array([22])
  }, { expectedSession: newSession }))[0], 22)
  assert.equal(newLoads, 1)
  assert.deepEqual(state.cachedChunkIndexes(TOKEN), [4])
  state.closeAll()
})

test('1.1 GiB, 5 GiB and 32 GiB fixtures schedule constant work near the requested chunk', async () => {
  const GIB = 1024 * MIB
  for (const bytes of [Math.floor(1.1 * GIB), 5 * GIB, 32 * GIB]) {
    const chunkCount = Math.ceil(bytes / (16 * MIB))
    const state = createPreviewWorkerState()
    state.open(TOKEN, session(`blob-${bytes}`, chunkCount))
    const seen = []
    const load = async (index) => { seen.push(index); return new Uint8Array([index]) }
    await state.readChunk(TOKEN, 5, load, { prefetchIndexes: [6, 7] })
    await settle()
    assert.deepEqual(seen, [5, 6, 7], `logical ${bytes} bytes still schedules only N/N+1/N+2`)
    assert.ok(state.cacheBytes() <= 64 * MIB)
    state.closeAll()
  }
})
