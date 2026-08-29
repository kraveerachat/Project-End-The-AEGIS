// tests/vaultPreviewCancellation.test.js — AEGIS Drive (IDEA1) · LFT-V2-E3.2
//
// ⚠️ What this file pins is the difference between "the browser changed its
//    mind" and "something is wrong". After PR #55 reached production, the real
//    ~1.1 GB MP4 streamed correctly — HTTP 206 virtual ranges, HTTP 200 Vault
//    ciphertext chunks, first frame rendered — and the UI still announced
//    "Video data could not be retrieved from the server", because Chromium
//    cancels superseded media Range responses as a matter of routine and every
//    such cancellation was being classified as CHUNK_FETCH_FAILED.
//
//    Three properties are inseparable and all three are asserted here:
//      1. a canceled/superseded response reports nothing at all;
//      2. a genuine network fault still reports chunk-fetch-failed;
//      3. an integrity failure is still fatal, cancellation or not.
//
// ⚠️ These tests wire createPreviewStream to createPreviewWorkerState exactly
//    the way src/vaultPreviewServiceWorker.js does, because the ownership bug
//    being fixed lives precisely at that seam: a chunk load shared by two Range
//    responses must not carry the AbortSignal of either one of them.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createVaultV2Envelope, encryptVaultChunk, planVaultChunks, GCM_TAG_BYTES,
} from '../src/lib/vaultChunkCrypto.js'
import {
  planPreviewResponse, createPreviewStream, readPlainChunk, PREVIEW_FAILURE,
} from '../src/lib/vaultPreviewResponder.js'
import { createPreviewWorkerState } from '../src/lib/vaultPreviewWorkerState.js'
import { PREVIEW_FAILURE_REASON } from '../src/lib/vaultPreviewErrors.js'

const subtle = globalThis.crypto.subtle
const CHUNK = 1024
const BASE = '/drive/'
const TOKEN = 'a'.repeat(32)
const MIB = 1024 * 1024
const GIB = 1024 * MIB

const sourceBytes = (n) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + 7) & 0xff
  return b
}

/**
 * One real V2 blob plus a controllable "server" for its ciphertext.
 * Real AES-GCM throughout: what is proven is the behaviour of the shipped
 * crypto path, not the behaviour of a stub.
 */
async function makeVaultBlob({ plainSize = CHUNK * 4 + 100, id = 'b'.repeat(48) } = {}) {
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

  const session = {
    dek: envelope.dek,
    contentType: 'video/mp4',
    plainSize,
    blob: {
      id, contentIdB64: envelope.contentIdB64, chunkSize: plan.chunkSize, chunkCount: plan.chunkCount,
    },
  }
  return { session, plain, stored }
}

/**
 * A ciphertext server whose responses can be held open, released, failed, or
 * left to observe an AbortSignal — the four shapes a real Range response takes.
 */
function server(fixture, { hold = false, aborts = true } = {}) {
  const started = []
  const gates = new Map()
  let failWith = null

  const fetchImpl = (url, init = {}) => {
    const index = Number(String(url).split('/').pop())
    started.push(index)
    const entry = fixture.stored.get(index)
    const respond = () => {
      if (failWith === 'http') return { ok: false, status: 502, headers: { get: () => null } }
      if (failWith === 'network') throw new TypeError('Failed to fetch')
      if (!entry) return { ok: false, status: 404, headers: { get: () => null } }
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h === 'X-Vault-Chunk-IV' ? entry.ivB64 : null) },
        arrayBuffer: async () => entry.ciphertext.buffer.slice(
          entry.ciphertext.byteOffset,
          entry.ciphertext.byteOffset + entry.ciphertext.byteLength,
        ),
      }
    }
    if (!hold) return Promise.resolve().then(respond)

    return new Promise((resolve, reject) => {
      gates.set(index, () => { try { resolve(respond()) } catch (err) { reject(err) } })
      // A real fetch rejects with its signal's reason when aborted.
      const abortNow = () => reject(init.signal.reason ?? new DOMException('aborted', 'AbortError'))
      if (aborts && init.signal) {
        if (init.signal.aborted) abortNow()
        else init.signal.addEventListener?.('abort', abortNow)
      }
    })
  }

  return {
    fetchImpl,
    started: () => [...started],
    release: (index) => gates.get(index)?.(),
    fail: (mode) => { failWith = mode },
  }
}

/**
 * Build one Range response exactly as the Service Worker does: a per-request
 * stream over a session-owned, shared chunk cache.
 */
function rangeResponse(fixture, state, srv, rangeHeader) {
  const failures = []
  const plan = planPreviewResponse(fixture.session, { rangeHeader })
  const stream = createPreviewStream(fixture.session, plan.plan, {
    fetchImpl: srv.fetchImpl,
    base: BASE,
    onFailure: (reason) => failures.push(reason),
    readChunk: (session, index, options) => state.readChunk(TOKEN, index,
      (loadIndex, load = {}) => readPlainChunk(session, loadIndex, {
        ...options, signal: load.signal ?? null,
      })),
  })
  return { plan, stream, reader: stream.getReader(), failures }
}

const settle = async (turns = 8) => { for (let i = 0; i < turns; i += 1) await Promise.resolve() }

// ── 1 · a canceled Range is silent ──────────────────────────────────────────
test('browser cancelling a Range while its chunk fetch is in flight reports no failure', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = server(fx, { hold: true })

  const a = rangeResponse(fx, state, srv, 'bytes=0-99')
  const read = a.reader.read()
  await settle()
  assert.deepEqual(srv.started(), [0], 'the chunk fetch must actually be in flight')

  // Chromium supersedes this response mid-flight.
  await a.reader.cancel()
  srv.release(0)
  await settle()
  await read.catch(() => {})

  assert.deepEqual(a.failures, [],
    'a superseded media response must not announce chunk-fetch-failed or any other failure')
  state.closeAll()
})

test('cancelling a Range whose own fetch honours the request signal is still silent', async () => {
  // The unshared path: readPlainChunk directly, so the request's AbortSignal
  // does reach fetch and the load rejects with a real AbortError. That abort is
  // attributable to this response's own cancellation, so it stays benign.
  const fx = await makeVaultBlob()
  const srv = server(fx, { hold: true })
  const failures = []
  const plan = planPreviewResponse(fx.session, { rangeHeader: 'bytes=0-99' })
  const stream = createPreviewStream(fx.session, plan.plan, {
    fetchImpl: srv.fetchImpl, base: BASE, onFailure: (reason) => failures.push(reason),
  })
  const reader = stream.getReader()
  const read = reader.read()
  await settle()
  await reader.cancel()
  await settle()
  await read.catch(() => {})

  assert.deepEqual(failures, [], 'AbortError from this request own cancellation is benign')
})

// ── 2 · a genuine fault still reports ───────────────────────────────────────
test('a real HTTP failure still emits chunk-fetch-failed', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = server(fx)
  srv.fail('http')

  const a = rangeResponse(fx, state, srv, 'bytes=0-99')
  await assert.rejects(a.reader.read())
  assert.deepEqual(a.failures, [PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED])
  state.closeAll()
})

test('a real network failure on a live response still emits chunk-fetch-failed', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = server(fx)
  srv.fail('network')

  const a = rangeResponse(fx, state, srv, 'bytes=0-99')
  await assert.rejects(a.reader.read())
  assert.deepEqual(a.failures, [PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED],
    'suppressing cancellation must not suppress a transport fault on a live range')
  state.closeAll()
})

test('a bare AbortError that this response did not cause is reported, not swallowed', async () => {
  const fx = await makeVaultBlob()
  const failures = []
  const plan = planPreviewResponse(fx.session, { rangeHeader: 'bytes=0-99' })
  const stream = createPreviewStream(fx.session, plan.plan, {
    base: BASE,
    onFailure: (reason) => failures.push(reason),
    readChunk: async () => { throw new DOMException('aborted elsewhere', 'AbortError') },
  })
  await assert.rejects(stream.getReader().read())
  assert.deepEqual(failures, [PREVIEW_FAILURE_REASON.CHUNK_FETCH_FAILED])
})

// ── 3 · integrity stays fatal ───────────────────────────────────────────────
test('integrity failure stays fatal and is never reclassified as cancellation', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const tampered = { ...fx, stored: new Map(fx.stored) }
  const victim = tampered.stored.get(0)
  const bytes = new Uint8Array(victim.ciphertext)
  bytes[0] ^= 0xff
  tampered.stored.set(0, { ...victim, ciphertext: bytes })
  const srv = server(tampered)

  const a = rangeResponse(tampered, state, srv, 'bytes=0-99')
  await assert.rejects(a.reader.read())
  assert.deepEqual(a.failures, [PREVIEW_FAILURE.INTEGRITY])
  assert.equal(state.cacheSize(), 0, 'unauthenticated plaintext is never cached')
  state.closeAll()
})

test('integrity failure on a response that was also canceled is still announced', async () => {
  const fx = await makeVaultBlob()
  const failures = []
  const plan = planPreviewResponse(fx.session, { rangeHeader: 'bytes=0-99' })
  let release
  const stream = createPreviewStream(fx.session, plan.plan, {
    base: BASE,
    onFailure: (reason) => failures.push(reason),
    readChunk: () => new Promise((_resolve, reject) => {
      release = () => reject(Object.assign(new Error('chunk auth failed'), {
        previewFailure: PREVIEW_FAILURE.INTEGRITY,
      }))
    }),
  })
  const reader = stream.getReader()
  const read = reader.read()
  await settle()
  await reader.cancel()
  release()
  await settle()
  await read.catch(() => {})

  assert.deepEqual(failures, [PREVIEW_FAILURE.INTEGRITY],
    'a chunk that failed authentication is a statement about the stored bytes, not about who canceled')
})

// ── 4 & 5 · shared in-flight chunk ownership ────────────────────────────────
test('two Range responses share one pending chunk and cancelling the first leaves the second valid', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = server(fx, { hold: true })

  const a = rangeResponse(fx, state, srv, 'bytes=0-99')
  const readA = a.reader.read()
  await settle()
  const b = rangeResponse(fx, state, srv, 'bytes=100-199')
  const readB = b.reader.read()
  await settle()
  assert.deepEqual(srv.started(), [0], 'the second range must reuse the in-flight chunk, not refetch it')

  // Chromium cancels the first range while both are waiting on chunk 0.
  await a.reader.cancel()
  srv.release(0)
  await settle()
  await readA.catch(() => {})

  const got = await readB
  assert.equal(got.done, false)
  assert.deepEqual(got.value, fx.plain.subarray(100, 200),
    'cancelling one Range must not destroy the shared chunk another Range is consuming')
  assert.deepEqual(a.failures, [])
  assert.deepEqual(b.failures, [])
  await b.reader.cancel()
  state.closeAll()
})

test('a canceled Range does not poison the shared chunk cache for later ranges', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = server(fx, { hold: true })

  const a = rangeResponse(fx, state, srv, 'bytes=0-99')
  const readA = a.reader.read()
  await settle()
  await a.reader.cancel()
  srv.release(0)
  await settle()
  await readA.catch(() => {})

  assert.deepEqual(state.cachedChunkIndexes(TOKEN), [0],
    'the bounded load that outlived the canceled range stays usable while the session is open')

  const later = rangeResponse(fx, state, srv, 'bytes=10-19')
  const got = await later.reader.read()
  assert.deepEqual(got.value, fx.plain.subarray(10, 20))
  assert.deepEqual(srv.started(), [0], 'the cached chunk is reused rather than refetched')
  assert.deepEqual(later.failures, [])
  await later.reader.cancel()
  state.closeAll()
})

test('the shared load is bound to the session signal, never to one request signal', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const sessionSignal = state.sessionSignal(TOKEN)
  const seen = []
  const srv = {
    fetchImpl: (_url, init) => { seen.push(init.signal); return new Promise(() => {}) },
    started: () => [],
    release: () => {},
    fail: () => {},
  }

  const a = rangeResponse(fx, state, srv, 'bytes=0-99')
  a.reader.read().catch(() => {})
  await settle()
  assert.equal(seen.length, 1)
  assert.equal(seen[0], sessionSignal, 'ownership of an in-flight load belongs to the session')

  await a.reader.cancel()
  await settle()
  assert.equal(sessionSignal.aborted, false,
    'one canceled Range must never abort work the session owns')
  state.closeAll()
})

// ── 6 & 7 · teardown invalidates session-owned work ─────────────────────────
test('closing the preview aborts session-owned in-flight chunk work', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const signal = state.sessionSignal(TOKEN)
  const srv = server(fx, { hold: true })

  const a = rangeResponse(fx, state, srv, 'bytes=0-99')
  const read = a.reader.read()
  await settle()

  state.close(TOKEN)
  assert.equal(signal.aborted, true, 'close must make session-owned loads unusable')
  await assert.rejects(read)
  await settle()
  assert.equal(state.cacheSize(), 0)
  assert.deepEqual(a.failures, [],
    'deliberate teardown is not a network failure and must not be announced as one')
})

test('locking the Vault mid-load delivers no late plaintext and announces no network failure', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const signal = state.sessionSignal(TOKEN)
  // The server ignores the abort, so the bytes really do arrive late — the
  // strongest form of this test: the guard must reject them, not merely rely
  // on the fetch dying.
  const srv = server(fx, { hold: true, aborts: false })

  const a = rangeResponse(fx, state, srv, 'bytes=0-99')
  const read = a.reader.read()
  await settle()

  state.closeAll()                        // exactly what Vault lock / auto-lock runs
  assert.equal(signal.aborted, true)
  srv.release(0)                          // plaintext arrives after the lock
  await settle()

  await assert.rejects(read, 'no plaintext may reach a locked Vault')
  assert.equal(state.cacheSize(), 0)
  assert.equal(state.sessionCount(), 0)
  assert.deepEqual(a.failures, [])
})

test('session replacement aborts the replaced session and starts a fresh signal', async () => {
  const fx = await makeVaultBlob()
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const first = state.sessionSignal(TOKEN)
  state.open(TOKEN, fx.session)
  const second = state.sessionSignal(TOKEN)

  assert.equal(first.aborted, true, 'the replaced session owns nothing usable afterwards')
  assert.equal(second.aborted, false)
  assert.notEqual(first, second)
  state.closeAll()
})

// ── 12 · logical large files stay bounded ───────────────────────────────────
test('cancellation and sharing stay bounded for logical 1.1 GiB, 5 GiB and 32 GiB files', async () => {
  // No file of these sizes is allocated anywhere: only the *plan* is exercised,
  // which is the whole point — per-request work must scale with the requested
  // range, never with the total size.
  const PLAIN_CHUNK = 32 * MIB
  for (const size of [Math.floor(1.1 * GIB), 5 * GIB, 32 * GIB]) {
    const logical = {
      dek: {},
      contentType: 'video/mp4',
      plainSize: size,
      blob: {
        id: 'b'.repeat(48),
        contentIdB64: 'Y29udGVudA==',
        chunkSize: PLAIN_CHUNK + GCM_TAG_BYTES,
        chunkCount: Math.ceil(size / PLAIN_CHUNK),
      },
    }
    const state = createPreviewWorkerState()
    state.open(TOKEN, logical)
    const plan = planPreviewResponse(logical, { rangeHeader: 'bytes=0-' })
    assert.equal(plan.plan.length, 1, `logical ${size} B must still plan one chunk near the start`)

    const loads = []
    const stream = createPreviewStream(logical, plan.plan, {
      base: BASE,
      onFailure: () => assert.fail('a canceled bounded range must not report a failure'),
      readChunk: (_s, index) => state.readChunk(TOKEN, index, () => new Promise((resolve) => {
        loads.push(() => resolve(new Uint8Array(8)))
      })),
    })
    const reader = stream.getReader()
    const read = reader.read()
    await settle()
    assert.equal(loads.length, 1, 'one bounded window = one in-flight chunk load')
    await reader.cancel()
    loads[0]()
    await settle()
    await read.catch(() => {})

    assert.ok(state.cacheBytes() <= 64 * MIB, 'the 64 MiB retained ceiling holds')
    assert.ok(state.cacheSize() <= 2, 'at most two plaintext chunks are retained')
    state.closeAll()
  }
})

test('one canceled response never fails the whole preview across a Chromium probe sequence', async () => {
  // The exact production sequence: an open-ended probe, a second range, then
  // the first response canceled. Only the surviving response may speak.
  const fx = await makeVaultBlob({ plainSize: CHUNK * 6 })
  const state = createPreviewWorkerState()
  state.open(TOKEN, fx.session)
  const srv = server(fx)

  const probe = rangeResponse(fx, state, srv, 'bytes=0-')
  await probe.reader.read()
  const play = rangeResponse(fx, state, srv, `bytes=${CHUNK * 2}-${CHUNK * 2 + 99}`)
  const playing = play.reader.read()
  await probe.reader.cancel()

  const got = await playing
  assert.deepEqual(got.value, fx.plain.subarray(CHUNK * 2, CHUNK * 2 + 100))
  assert.deepEqual(probe.failures, [], 'the superseded probe must stay silent')
  assert.deepEqual(play.failures, [], 'the live response must remain healthy')
  await play.reader.cancel()
  state.closeAll()
})
