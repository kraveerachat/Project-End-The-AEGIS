// tests/vaultDownloadPickerFirst.test.js — AEGIS Drive (IDEA1) · Private Vault large-download UX
//
// Pins the click → Save picker → metadata authentication → createWritable → chunk stream order of
// prepareVaultV2Download + downloadVaultV2 with the REAL modules (real WebCrypto, real AAD, real
// sinks). Only the network leg and the File System Access handle are fakes.
//
// What this suite proves:
//   PF-1  the picker is requested synchronously — before any await, any crypto, any chunk fetch
//   PF-2  the picker request does not depend on the file size (1 KiB and 1.1 GiB alike)
//   PF-3  metadata is authenticated after the picker but before createWritable and any content byte
//   PF-4  chunks are fetched strictly one at a time and each is written before the next is requested
//   PF-5  onProgress is monotonic (bytesWritten, percent) and ends at 100 / plainSize
//   PF-6  a 1.1 GiB logical file streams through a filesystem sink with O(chunk) plaintext held
//   PF-7  a failure after the picker aborts the destination and never closes it
//   PF-8  cancelling the picker fetches nothing, creates no writable, and is not an error
//   PF-9  a lock while the picker is open (or mid-transfer) aborts safely
//   PF-11 byte-exact reconstruction through the picker path
//   PF-12 source guard: no whole-file buffering primitive may enter downloadVaultV2
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  prepareVaultV2Download, downloadVaultV2, VAULT_DOWNLOAD_TIMING, MAX_BUFFERED_PLAINTEXT_BYTES,
} from '../src/lib/vaultChunkedDownload.js'
import {
  createVaultV2Envelope, encryptVaultChunk, planVaultChunks, plaintextRangeFor, GCM_TAG_BYTES,
} from '../src/lib/vaultChunkCrypto.js'

const subtle = globalThis.crypto.subtle
const KiB = 1024
const MiB = 1024 * KiB
const GiB = 1024 * MiB

const kekOf = (seed = 7) => subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])

function fillPattern(out, offset, seed = 1) {
  for (let i = 0; i < out.length; i += 1) out[i] = ((offset + i) * 31 + seed * 17) & 0xff
  return out
}

/**
 * A V2 blob "as the server stores it", with ciphertext produced lazily per chunk request so a
 * 1+ GiB logical file never exists in this test process either.
 */
async function lazyV2(kek, plainSize, { plaintextChunkBytes = 4 * KiB, name = 'big.bin', id = 'b2'.repeat(24) } = {}) {
  const plan = planVaultChunks(plainSize, plaintextChunkBytes)
  const env = await createVaultV2Envelope(kek, { name, type: 'application/octet-stream', size: plainSize, chunkCount: plan.chunkCount })
  const blob = {
    id, formatVersion: 2, size: plan.ciphertextSize, createdAt: 1_756_000_000_000,
    contentIdB64: env.contentIdB64, chunkSize: plan.chunkSize, chunkCount: plan.chunkCount,
    wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64,
  }
  const plainChunk = (i) => {
    const r = plaintextRangeFor(i, plainSize, plan.plaintextChunkBytes)
    return fillPattern(new Uint8Array(r.end - r.start), r.start)
  }
  const cipherChunk = (i) => encryptVaultChunk(env.dek, {
    contentId: env.contentId, chunkIndex: i, chunkCount: plan.chunkCount, plaintext: plainChunk(i),
  })
  return { blob, plan, plainChunk, cipherChunk }
}

/** Network leg: one request per chunk; records order and concurrency. */
function serveLazy(src, events, { tamper = -1 } = {}) {
  let inFlight = 0
  const stats = { maxInFlight: 0, requests: 0 }
  const fetchBytes = async (path, opts = {}) => {
    const index = Number(path.slice(path.lastIndexOf('/') + 1))
    events.push(`fetch:${index}`)
    stats.requests += 1
    inFlight += 1
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight)
    try {
      await new Promise((r) => { setTimeout(r, 0) }) // give parallelism a chance to show up if it existed
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      const c = await src.cipherChunk(index)
      const bytes = c.ciphertext
      if (index === tamper) bytes[3] ^= 0x01
      return { ok: true, status: 200, bytes, headers: { get: (h) => (h === 'X-Vault-Chunk-IV' ? c.ivB64 : null) } }
    } finally {
      inFlight -= 1
    }
  }
  return { fetchBytes, stats }
}

/** Fake File System Access scope: records picker/createWritable/write/close/abort in one event log. */
function fakeScope(events, { pickerError = null, keep = false, onWrite = null } = {}) {
  const writable = {
    held: 0, maxHeld: 0, total: 0, closed: false, aborted: false, parts: [],
    async write(bytes) {
      events.push(`write:${bytes.length}`)
      this.held = bytes.length // a disk sink retains nothing after the write resolves
      this.maxHeld = Math.max(this.maxHeld, this.held)
      this.total += bytes.length
      if (keep) this.parts.push(bytes.slice())
      onWrite?.(bytes)
      this.held = 0
    },
    async close() { events.push('close'); this.closed = true },
    async abort() { events.push('abort'); this.aborted = true },
  }
  const scope = {
    pickerCalls: [],
    showSaveFilePicker(opts) {
      events.push('picker')
      scope.pickerCalls.push(opts)
      if (pickerError) return Promise.reject(pickerError)
      return Promise.resolve({ createWritable: async () => { events.push('createWritable'); return writable } })
    },
  }
  return { scope, writable }
}

test('PF-1 the Save picker is requested synchronously — before any await, crypto, or fetch', async () => {
  const kek = await kekOf()
  const src = await lazyV2(kek, 10 * KiB)
  const events = []
  const { scope } = fakeScope(events)
  const p = prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'report.pdf', plainSize: 10 * KiB, scope })
  // nothing has been awaited yet: the call is still inside the click's synchronous turn
  assert.deepEqual(events, ['picker'], 'picker requested inside the same synchronous turn as the click')
  assert.equal(scope.pickerCalls[0].suggestedName, 'report.pdf', 'suggestedName comes from the caller (manifest)')
  const prepared = await p
  assert.equal(prepared.ok, true)
})

test('PF-2 picker timing is independent of file size (1 KiB vs 1.1 GiB)', async () => {
  const kek = await kekOf()
  for (const plainSize of [1 * KiB, Math.round(1.1 * GiB)]) {
    // envelope only — the picker is cancelled, so no chunk of the large file is ever produced
    const src = await lazyV2(kek, plainSize, { plaintextChunkBytes: 16 * MiB })
    const events = []
    const { scope } = fakeScope(events, { pickerError: Object.assign(new Error('x'), { name: 'AbortError' }) })
    const p = prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'f', plainSize, scope })
    assert.deepEqual(events, ['picker'], `picker requested synchronously at ${plainSize} bytes`)
    assert.deepEqual(await p, { ok: false, reason: 'cancelled' })
  }
})

test('PF-3 metadata is authenticated after the picker but before createWritable and any content byte', async () => {
  const kek = await kekOf()
  const src = await lazyV2(kek, 9 * KiB)
  const events = []
  const marks = []
  const { scope } = fakeScope(events)
  const onTiming = (name) => { marks.push(name); events.push(name) }
  const prepared = await prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'f', plainSize: 9 * KiB, scope, onTiming })
  assert.equal(prepared.ok, true)
  const { fetchBytes } = serveLazy(src, events)
  const res = await downloadVaultV2({ dek: prepared.dek, blob: src.blob, sink: prepared.sink, fetchBytes, onTiming })
  assert.equal(res.ok, true)
  const at = (e) => events.indexOf(e)
  assert.ok(at('picker') < at(VAULT_DOWNLOAD_TIMING.META_AUTH_DONE), 'picker first')
  assert.ok(at(VAULT_DOWNLOAD_TIMING.META_AUTH_DONE) < at('createWritable'), 'metadata authenticated before the destination is opened')
  assert.ok(at('createWritable') < at('fetch:0'), 'no content requested before the destination exists')
  assert.deepEqual(marks, [
    VAULT_DOWNLOAD_TIMING.PICKER_REQUEST, VAULT_DOWNLOAD_TIMING.PICKER_RETURN, VAULT_DOWNLOAD_TIMING.META_AUTH_DONE,
    VAULT_DOWNLOAD_TIMING.FIRST_CHUNK_REQUEST, VAULT_DOWNLOAD_TIMING.FIRST_PLAINTEXT_WRITE, VAULT_DOWNLOAD_TIMING.COMPLETE,
  ], 'every timing point is reported once, in order')
})

test('PF-3b a swapped/forged metadata envelope or wrong key never opens the destination', async () => {
  const kek = await kekOf()
  const a = await lazyV2(kek, 4 * KiB, { name: 'a' })
  const b = await lazyV2(kek, 4 * KiB, { name: 'b' })
  for (const [label, blob, key] of [
    ['swapped meta', { ...a.blob, metaB64: b.blob.metaB64, metaIvB64: b.blob.metaIvB64 }, kek],
    ['wrong key', a.blob, await kekOf(9)],
  ]) {
    const events = []
    const { scope } = fakeScope(events)
    const prepared = await prepareVaultV2Download({ kek: key, blob, suggestedName: 'f', plainSize: 4 * KiB, scope })
    assert.deepEqual(prepared, { ok: false, reason: 'wrong-key' }, label)
    assert.deepEqual(events, ['picker'], `${label}: no createWritable, no write, no fetch`)
  }
})

test('PF-4 + PF-5 sequential one-at-a-time chunks, write-before-next-fetch, monotonic progress', async () => {
  const kek = await kekOf()
  const plainSize = 10 * 4 * KiB + 123
  const src = await lazyV2(kek, plainSize)
  const events = []
  const { scope } = fakeScope(events)
  const prepared = await prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'f', plainSize, scope })
  const { fetchBytes, stats } = serveLazy(src, events)
  const progress = []
  const res = await downloadVaultV2({ dek: prepared.dek, blob: src.blob, sink: prepared.sink, fetchBytes, onProgress: (p) => progress.push(p) })
  assert.equal(res.ok, true)
  assert.equal(stats.maxInFlight, 1, 'never more than one chunk request in flight')
  const io = events.filter((e) => e.startsWith('fetch:') || e.startsWith('write:'))
  // fetch/write strictly alternate: whole-file buffering would put every fetch before every write
  assert.deepEqual(io.map((e) => e.split(':')[0]), Array.from({ length: src.plan.chunkCount }, () => ['fetch', 'write']).flat())
  assert.equal(progress.length, src.plan.chunkCount)
  for (let i = 1; i < progress.length; i += 1) {
    assert.ok(progress[i].bytesWritten > progress[i - 1].bytesWritten, 'bytesWritten strictly increases')
    assert.ok(progress[i].percent >= progress[i - 1].percent, 'percent never goes backwards')
  }
  const last = progress.at(-1)
  assert.equal(last.bytesWritten, plainSize)
  assert.equal(last.totalBytes, plainSize)
  assert.equal(last.percent, 100)
  assert.equal(last.chunkIndex, src.plan.chunkCount - 1)
  assert.equal(last.chunkCount, src.plan.chunkCount)
})

test('PF-6 a 1.1 GiB logical file streams to a filesystem sink holding O(chunk) plaintext', { timeout: 300_000 }, async () => {
  const kek = await kekOf()
  const plainSize = Math.round(1.1 * GiB)
  const chunk = 16 * MiB // production chunk size
  const src = await lazyV2(kek, plainSize, { plaintextChunkBytes: chunk })
  assert.ok(plainSize > MAX_BUFFERED_PLAINTEXT_BYTES * 16, 'far beyond any buffered ceiling')
  const events = []
  const { scope, writable } = fakeScope(events)
  const prepared = await prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'big.bin', plainSize, scope })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.sink.kind, 'filesystem')
  const { fetchBytes, stats } = serveLazy(src, [])
  const heapBefore = process.memoryUsage().arrayBuffers
  let heapPeak = heapBefore
  const res = await downloadVaultV2({
    dek: prepared.dek, blob: src.blob, sink: prepared.sink, fetchBytes,
    onProgress: () => { heapPeak = Math.max(heapPeak, process.memoryUsage().arrayBuffers) },
  })
  assert.equal(res.ok, true, res.reason)
  assert.equal(res.bytesWritten, plainSize)
  assert.equal(writable.total, plainSize)
  assert.equal(writable.closed, true)
  assert.ok(writable.maxHeld <= chunk, 'the sink never holds more than one chunk of plaintext')
  assert.equal(stats.maxInFlight, 1)
  // generous bound: a few chunks of transient ciphertext/plaintext, never the 1.1 GiB file
  assert.ok(heapPeak - heapBefore < 8 * chunk, `ArrayBuffer growth ${heapPeak - heapBefore} stays O(chunk)`)
})

test('PF-7 failure after the picker (tampered middle chunk) aborts the destination and never closes it', async () => {
  const kek = await kekOf()
  const src = await lazyV2(kek, 6 * 4 * KiB)
  const events = []
  const { scope, writable } = fakeScope(events)
  const prepared = await prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'f', plainSize: 6 * 4 * KiB, scope })
  const { fetchBytes } = serveLazy(src, events, { tamper: 3 })
  const res = await downloadVaultV2({ dek: prepared.dek, blob: src.blob, sink: prepared.sink, fetchBytes })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'auth-failed')
  assert.equal(writable.aborted, true, 'destination aborted')
  assert.equal(writable.closed, false, 'close() never called — no partial file presented as complete')
  assert.ok(!events.includes('fetch:4'), 'stops at the failing chunk')
})

test('PF-8 cancelling the picker fetches nothing, opens nothing, and is reported as cancelled (not an error)', async () => {
  const kek = await kekOf()
  const src = await lazyV2(kek, 8 * KiB)
  const events = []
  const { scope } = fakeScope(events, { pickerError: Object.assign(new Error('user cancelled'), { name: 'AbortError' }) })
  const res = await prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'f', plainSize: 8 * KiB, scope })
  assert.deepEqual(res, { ok: false, reason: 'cancelled' })
  assert.deepEqual(events, ['picker'])
})

test('PF-8b a picker refusal (e.g. lost user activation) is a picker failure, not a silent success', async () => {
  const kek = await kekOf()
  const src = await lazyV2(kek, 8 * KiB)
  const events = []
  const { scope } = fakeScope(events, { pickerError: Object.assign(new Error('Must be handling a user gesture'), { name: 'SecurityError' }) })
  assert.deepEqual(await prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'f', plainSize: 8 * KiB, scope }), { ok: false, reason: 'picker' })
})

test('PF-9 lock while the picker is open opens no destination; lock mid-transfer aborts it', async () => {
  const kek = await kekOf()
  const src = await lazyV2(kek, 5 * 4 * KiB)

  const ctrl1 = new AbortController()
  const events1 = []
  const { scope: s1 } = fakeScope(events1)
  const p = prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'f', plainSize: 5 * 4 * KiB, scope: s1, signal: ctrl1.signal })
  ctrl1.abort() // the Vault locked while the picker was showing
  assert.deepEqual(await p, { ok: false, reason: 'cancelled' })
  assert.ok(!events1.includes('createWritable'), 'no destination opened after the lock')

  const ctrl2 = new AbortController()
  const events2 = []
  const { scope: s2, writable } = fakeScope(events2, { onWrite: () => { if (writable.total >= 2 * 4 * KiB) ctrl2.abort() } })
  const prepared = await prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'f', plainSize: 5 * 4 * KiB, scope: s2, signal: ctrl2.signal })
  const { fetchBytes } = serveLazy(src, events2)
  const res = await downloadVaultV2({ dek: prepared.dek, blob: src.blob, sink: prepared.sink, fetchBytes, signal: ctrl2.signal })
  assert.deepEqual([res.ok, res.reason], [false, 'cancelled'])
  assert.equal(writable.aborted, true)
  assert.equal(writable.closed, false)
  assert.ok(!events2.includes('fetch:2'), 'no further chunk requested after the lock')
})

test('PF-9b no key (vault locked before the click) refuses before the picker', async () => {
  const events = []
  const { scope } = fakeScope(events)
  assert.deepEqual(await prepareVaultV2Download({ kek: null, blob: {}, suggestedName: 'f', plainSize: 1, scope }), { ok: false, reason: 'no-key' })
  assert.deepEqual(events, [])
})

test('PF-10 without File System Access: small files use the bounded buffer, large files are refused before any work', async () => {
  const kek = await kekOf()
  const small = await lazyV2(kek, 3 * KiB + 7)
  const prepared = await prepareVaultV2Download({ kek, blob: small.blob, suggestedName: 'f', plainSize: 3 * KiB + 7, scope: {} })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.sink.kind, 'buffered')
  assert.deepEqual(
    await prepareVaultV2Download({ kek, blob: small.blob, suggestedName: 'f', plainSize: MAX_BUFFERED_PLAINTEXT_BYTES + 1, scope: {} }),
    { ok: false, reason: 'too-large-for-memory' },
  )
})

test('PF-11 byte-exact reconstruction through the picker path (partial last chunk)', async () => {
  const kek = await kekOf()
  const plainSize = 7 * 4 * KiB + 1001
  const src = await lazyV2(kek, plainSize)
  const events = []
  const { scope, writable } = fakeScope(events, { keep: true })
  const prepared = await prepareVaultV2Download({ kek, blob: src.blob, suggestedName: 'f', plainSize, scope })
  const { fetchBytes } = serveLazy(src, [])
  const res = await downloadVaultV2({ dek: prepared.dek, blob: src.blob, sink: prepared.sink, fetchBytes })
  assert.equal(res.ok, true)
  const out = new Uint8Array(writable.total)
  let at = 0
  for (const part of writable.parts) { out.set(part, at); at += part.length }
  assert.deepEqual(out, fillPattern(new Uint8Array(plainSize), 0))
  assert.equal(src.blob.size, plainSize + src.plan.chunkCount * GCM_TAG_BYTES)
})

test('PF-12 source guard: downloadVaultV2 contains no whole-file buffering primitive', () => {
  const src = readFileSync(new URL('../src/lib/vaultChunkedDownload.js', import.meta.url), 'utf8')
  const start = src.indexOf('export async function downloadVaultV2')
  assert.ok(start > 0)
  const body = src.slice(start)
  for (const forbidden of [/\.arrayBuffer\(/, /new Blob\(/, /\.blob\(\)/, /Promise\.all\(/, /\.concat\(/, /chunks\.push\(/, /parts\.push\(/]) {
    assert.doesNotMatch(body, forbidden, `downloadVaultV2 must not use ${forbidden}`)
  }
  // and the picker helper must not await anything before the picker
  const prep = src.slice(src.indexOf('export async function prepareVaultV2Download'), start)
  const firstAwait = prep.indexOf('await ')
  assert.ok(firstAwait > 0 && prep.slice(firstAwait, firstAwait + 40).includes('showSaveFilePicker'), 'first await is the picker')
})
