import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPreviewWorkerState, MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
} from '../src/lib/vaultPreviewWorkerState.js'

const session = (id = 'blob-a') => ({ dek: {}, blob: { id }, plainSize: 10, contentType: 'video/mp4' })

test('same plaintext chunk is reused and a third chunk deterministically evicts the LRU entry', async () => {
  const state = createPreviewWorkerState({ maxPlaintextChunks: 2 })
  state.open('a'.repeat(32), session())
  let loads = 0
  const load = async (index) => { loads += 1; return new Uint8Array([index]) }

  assert.equal((await state.readChunk('a'.repeat(32), 0, load))[0], 0)
  assert.equal((await state.readChunk('a'.repeat(32), 0, load))[0], 0)
  assert.equal(loads, 1, 'nearby requests reuse the decrypted chunk')
  await state.readChunk('a'.repeat(32), 1, load)
  await state.readChunk('a'.repeat(32), 0, load) // chunk 1 is now LRU
  await state.readChunk('a'.repeat(32), 2, load)
  assert.deepEqual(state.cachedChunkIndexes('a'.repeat(32)), [0, 2])
  await state.readChunk('a'.repeat(32), 1, load)
  assert.equal(loads, 4, 'evicted chunk is decrypted again only when requested again')
  assert.equal(state.cacheSize(), 2)
})

test('cache is token-isolated and close/replacement/close-all remove plaintext', async () => {
  const state = createPreviewWorkerState({ maxPlaintextChunks: 2 })
  const a = 'a'.repeat(32)
  const b = 'b'.repeat(32)
  state.open(a, session('blob-a'))
  state.open(b, session('blob-b'))
  await state.readChunk(a, 0, async () => new Uint8Array([1]))
  await state.readChunk(b, 0, async () => new Uint8Array([2]))
  assert.equal(state.cacheSize(), 2)
  assert.equal((await state.readChunk(b, 0, async () => new Uint8Array([9])))[0], 2)

  state.close(a)
  assert.deepEqual(state.cachedChunkIndexes(a), [])
  state.open(b, session('blob-b-replaced'))
  assert.deepEqual(state.cachedChunkIndexes(b), [], 'session replacement clears old plaintext')
  state.closeAll()
  assert.equal(state.cacheSize(), 0)
  assert.equal(state.sessionCount(), 0)
})

test('failed integrity/decrypt work is never cached', async () => {
  const state = createPreviewWorkerState({ maxPlaintextChunks: 2 })
  const token = 'a'.repeat(32)
  state.open(token, session())
  let attempts = 0
  const failing = async () => { attempts += 1; throw new Error('integrity') }
  await assert.rejects(state.readChunk(token, 0, failing), /integrity/)
  await assert.rejects(state.readChunk(token, 0, failing), /integrity/)
  assert.equal(attempts, 2)
  assert.equal(state.cacheSize(), 0)
})

test('worker restart starts with no session, key, or plaintext cache', async () => {
  const first = createPreviewWorkerState({ maxPlaintextChunks: 2 })
  const token = 'a'.repeat(32)
  first.open(token, session())
  await first.readChunk(token, 0, async () => new Uint8Array([1]))
  const restarted = createPreviewWorkerState({ maxPlaintextChunks: 2 })
  assert.equal(restarted.get(token), null)
  assert.equal(restarted.cacheSize(), 0)
})

test('plaintext cache has both a two-entry ceiling and a hard byte ceiling', async () => {
  const state = createPreviewWorkerState({ maxPlaintextChunks: 2, maxPlaintextBytes: 4 })
  const token = 'a'.repeat(32)
  state.open(token, session())
  await state.readChunk(token, 0, async () => new Uint8Array(3))
  await state.readChunk(token, 1, async () => new Uint8Array(3))
  assert.ok(state.cacheSize() <= 2)
  assert.ok(state.cacheBytes() <= 4)
  assert.equal(MAX_PREVIEW_PLAINTEXT_CACHE_BYTES, 64 * 1024 * 1024)
})

test('locking while a chunk decrypt is in flight prevents that plaintext from being delivered or cached', async () => {
  const state = createPreviewWorkerState()
  const token = 'a'.repeat(32)
  state.open(token, session())
  let release
  const pending = state.readChunk(token, 0, () => new Promise((resolve) => { release = resolve }))
  await Promise.resolve()
  state.closeAll()
  release(new Uint8Array([1, 2, 3]))
  await assert.rejects(pending, /session closed/)
  assert.equal(state.cacheSize(), 0)
})

test('opening or closing another token does not invalidate an active token read', async () => {
  const state = createPreviewWorkerState()
  const a = 'a'.repeat(32)
  const b = 'b'.repeat(32)
  state.open(a, session('blob-a'))
  state.open(b, session('blob-b'))
  let release
  const pending = state.readChunk(a, 0, () => new Promise((resolve) => { release = resolve }))
  await Promise.resolve()
  state.open(b, session('blob-b-replaced'))
  state.close(b)
  release(new Uint8Array([7]))
  assert.equal((await pending)[0], 7)
})

test('two different missing tokens can recover concurrently without invalidating each other', async () => {
  const state = createPreviewWorkerState()
  const a = 'a'.repeat(32)
  const b = 'b'.repeat(32)
  let releaseA
  let releaseB
  const pendingA = state.getOrRecover(a, () => new Promise((resolve) => { releaseA = resolve }))
  const pendingB = state.getOrRecover(b, () => new Promise((resolve) => { releaseB = resolve }))
  releaseA({ token: a, session: session('blob-a') })
  assert.equal((await pendingA).ok, true)
  releaseB({ token: b, session: session('blob-b') })
  assert.equal((await pendingB).ok, true)
})

test('at most two plaintext decrypt loads run concurrently', async () => {
  const state = createPreviewWorkerState({ maxPlaintextChunks: 2 })
  const token = 'a'.repeat(32)
  state.open(token, session())
  const releases = []
  let started = 0
  const load = () => new Promise((resolve) => {
    started += 1
    releases.push(() => resolve(new Uint8Array([started])))
  })
  const pending = [0, 1, 2].map((index) => state.readChunk(token, index, load))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(started, 2)
  releases.shift()()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, 3)
  while (releases.length) releases.shift()()
  await Promise.all(pending)
})

test('missing session rehydrates once, rejects a mismatched token, and denies recovery after lock', async () => {
  const token = 'a'.repeat(32)
  const state = createPreviewWorkerState({ maxPlaintextChunks: 2 })
  let calls = 0
  const recovered = await state.getOrRecover(token, async (requested) => {
    calls += 1
    return { token: requested, session: session() }
  })
  assert.equal(recovered.ok, true)
  assert.equal(recovered.rehydrated, true)
  assert.equal(calls, 1)

  const invalid = createPreviewWorkerState()
  const denied = await invalid.getOrRecover(token, async () => ({ token: 'b'.repeat(32), session: session('other') }))
  assert.deepEqual(denied, { ok: false, reason: 'worker-session-rehydrate-failed' })
  assert.equal(invalid.get(token), null, 'one token cannot install another preview session')

  const duringLock = createPreviewWorkerState()
  let release
  const pending = duringLock.getOrRecover(token, () => new Promise((resolve) => { release = resolve }))
  duringLock.closeAll()
  release({ token, session: session() })
  assert.deepEqual(await pending, { ok: false, reason: 'worker-session-lost' })
  assert.equal(duringLock.get(token), null)
})
