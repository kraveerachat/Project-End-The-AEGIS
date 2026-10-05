// tests/bulkZipWorkerStream.test.js — AEGIS Drive (IDEA1) · cross-browser streaming ZIP, orchestrator
//
// runBulkZip over the worker-stream transport, end to end: real planBulkDownload, real Files / Vault V2
// sources (real WebCrypto + AAD for the Vault), the same createZipStreamWriter, the real page-side sink,
// a real MessageChannel and the real worker-side ReadableStream whose bytes are read back and parsed as
// a ZIP. Only the network leg and the Service Worker event plumbing are fakes.
//   - no showSaveFilePicker, no whole-archive Blob, no finalizeBufferedZip on this transport
//   - same safety semantics: abort once on failure/cancel/lock, no later entry, done only after close
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'

import { JSDOM } from 'jsdom'

import { runBulkZip, createFilesEntrySource, createVaultV2EntrySource } from '../src/lib/bulkZipDownload.js'
import { planBulkDownload } from '../src/lib/bulkDownloadPlan.js'
import { downloadVaultV2, MAX_BUFFERED_PLAINTEXT_BYTES } from '../src/lib/vaultChunkedDownload.js'
import { createVaultV2Envelope, encryptVaultChunk, planVaultChunks, plaintextRangeFor } from '../src/lib/vaultChunkCrypto.js'
import {
  createDownloadStreamWorkerState, handleDownloadStreamMessage, handleDownloadStreamFetch, DOWNLOAD_STREAM_LIMITS,
} from '../src/lib/downloadStreamWorkerState.js'
import { openWorkerStreamSink } from '../src/lib/downloadStreamSession.js'

const ORIGIN = 'https://drive.test'
const KiB = 1024
const MiB = 1024 * KiB
const NOW = new Date(2026, 9, 5, 1, 2, 3)
const tick = () => new Promise((r) => setImmediate(r))

let dom
let clicks
before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: `${ORIGIN}/drive/` })
  globalThis.document = dom.window.document
  clicks = []
  dom.window.document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]')
    if (a) { clicks.push(a.getAttribute('href')); e.preventDefault() }
  }, true)
})
after(() => { delete globalThis.document; dom.window.close() })

function bytesOf(n, seed = 1) {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i += 1) b[i] = (i * 13 + seed * 7) & 0xff
  return b
}
function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
async function readAll(response) {
  const reader = response.body.getReader()
  const parts = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return concat(parts)
    parts.push(value)
  }
}

/** Minimal classic-ZIP reader: EOCD → central directory → local header → data; checks CRC-32. */
function parseZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const eocd = bytes.length - 22
  assert.equal(dv.getUint32(eocd, true), 0x06054b50, 'EOCD signature')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out = []
  for (let i = 0; i < count; i += 1) {
    assert.equal(dv.getUint32(p, true), 0x02014b50, 'central signature')
    const crc = dv.getUint32(p + 16, true)
    const size = dv.getUint32(p + 24, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const local = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))
    assert.equal(dv.getUint32(local, true), 0x04034b50, 'local signature')
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
    const data = bytes.subarray(start, start + size)
    assert.equal(crc32(data) >>> 0, crc, `CRC of ${name}`)
    out.push({ name, data })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** The worker side plus a destination factory that runBulkZip calls instead of showSaveFilePicker. */
function workerStreamRig({ limits = { ...DOWNLOAD_STREAM_LIMITS, maxMessageBytes: 32 * KiB, windowBytes: 64 * KiB, highWaterBytes: 128 * KiB }, failOpen = false } = {}) {
  const rig = { opens: 0, aborts: 0, closes: 0, bodies: [], state: createDownloadStreamWorkerState({ limits }) }
  const controller = { postMessage: (msg, ports = []) => handleDownloadStreamMessage(rig.state, msg, ports, (p) => ports[0]?.postMessage(p)) }
  rig.createStreamDestination = async (opts) => {
    rig.opens += 1
    rig.lastOpts = opts
    if (failOpen) return { ok: false, reason: 'stream-unavailable' }
    const res = await openWorkerStreamSink({
      ...opts, base: '/drive/', limits, startTimeoutMs: 500, keepaliveMs: 0, frameLingerMs: 0,
      ensureWorker: async () => ({ ok: true, controller }),
      trigger: (url) => {
        const response = handleDownloadStreamFetch(rig.state, new Request(`${ORIGIN}${url}`), { origin: ORIGIN, scopePath: '/drive/' })
        rig.bodies.push(readAll(response).then((b) => ({ ok: true, bytes: b }), (e) => ({ ok: false, error: e })))
        return () => {}
      },
    })
    if (!res.ok) return res
    const sink = res.sink
    return {
      ok: true,
      sink: {
        write: (b) => sink.write(b),
        close: async () => { rig.closes += 1; return sink.close() },
        abort: async () => { rig.aborts += 1; return sink.abort() },
      },
    }
  }
  return rig
}

const noPicker = { showSaveFilePicker() { throw new Error('showSaveFilePicker must not be called on worker-stream') } }
const noBuffer = () => { throw new Error('the buffered sink must not be created on worker-stream') }

const rowsOf = (sizes) => sizes.map((size, i) => ({ id: `f${i}`, name: `file${i}.bin`, kind: 'file', type: 'Binary', size }))
const filesPlan = (rows, caps = { fsa: false, workerStream: true }) => planBulkDownload({
  source: 'files', items: rows.map((r) => r.id), resolve: (id) => rows.find((r) => r.id === id) ?? null, enabled: true, now: NOW, ...caps,
})
function filesTransport(rows, { hold = null, fail = null } = {}) {
  const calls = []
  const fetchStream = async (path, { signal } = {}) => {
    const id = path.split('/')[3]
    calls.push(id)
    if (fail === id) return { ok: false, status: 500, errorKind: 'server' }
    if (hold === id) await new Promise((resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    const row = rows.find((r) => r.id === id)
    const bytes = bytesOf(row.size, Number(id.slice(1)) + 1)
    const piece = 10 * KiB
    let at = 0
    return {
      ok: true, status: 200, errorKind: null, headers: new Headers({ 'Content-Length': String(row.size) }),
      body: new ReadableStream({
        pull(c) {
          if (at >= bytes.length) { c.close(); return }
          c.enqueue(bytes.slice(at, at + piece))
          at += piece
        },
      }),
    }
  }
  return { fetchStream, calls }
}

function spyBlobs(t) {
  const created = []
  t.mock.method(URL, 'createObjectURL', (blob) => { created.push(blob); return `blob:test/${created.length}` })
  t.mock.method(URL, 'revokeObjectURL', () => {})
  return created
}

/* ── 14 / 15 / 16: happy path ──────────────────────────────────── */

test('ORCH-WS-1 Files: one valid ZIP streamed through the worker — no picker, no Blob, no anchor', async (t) => {
  const blobs = spyBlobs(t)
  clicks.length = 0
  const rows = rowsOf([5, 0, 300 * KiB, 12])
  const plan = filesPlan(rows)
  assert.equal(plan.transport, 'worker-stream')
  const rig = workerStreamRig()
  const transport = filesTransport(rows)
  const progress = []
  const res = await runBulkZip({
    plan, source: createFilesEntrySource({ fetchStream: transport.fetchStream }), scope: noPicker, busyRef: { current: false },
    createStreamDestination: rig.createStreamDestination, createBufferedSink: noBuffer, onProgress: (p) => progress.push(p),
  })
  assert.deepEqual(res, { status: 'done' })
  assert.equal(rig.opens, 1)
  assert.equal(rig.lastOpts.filename, 'AEGIS-Files-20261005-010203.zip')
  assert.equal(rig.lastOpts.source, 'files')
  assert.equal(rig.lastOpts.totalBytes, plan.layout.total)
  assert.equal(rig.closes, 1)
  assert.equal(rig.aborts, 0)
  assert.equal(blobs.length, 0, 'no whole-archive Blob')
  assert.equal(clicks.length, 0, 'no buffered anchor download')
  const body = await rig.bodies[0]
  assert.equal(body.ok, true)
  assert.equal(body.bytes.length, plan.layout.total)
  const entries = parseZip(body.bytes)
  assert.deepEqual(entries.map((e) => e.name), rows.map((r) => r.name))
  entries.forEach((e, i) => assert.deepEqual(e.data, bytesOf(rows[i].size, i + 1), e.name))
  // progress counts real bytes and 'done' is the final event, after close
  const last = progress.at(-1)
  assert.equal(last.stage, 'done')
  assert.equal(last.transferredBytes, rows.reduce((s, r) => s + r.size, 0))
  assert.ok(progress.slice(0, -1).every((p) => p.stage !== 'done'))
})

/* ── 17: cancel ────────────────────────────────────────────────── */

test('ORCH-WS-2 cancel mid-archive: abort exactly once, stream errored, status cancelled, no later entry', async (t) => {
  spyBlobs(t)
  const rows = rowsOf([20 * KiB, 20 * KiB, 20 * KiB, 20 * KiB])
  const plan = filesPlan(rows)
  const rig = workerStreamRig()
  const transport = filesTransport(rows, { hold: 'f1' })
  const ctrl = new AbortController()
  const run = runBulkZip({
    plan, source: createFilesEntrySource({ fetchStream: transport.fetchStream }), scope: noPicker, busyRef: { current: false },
    signal: ctrl.signal, createStreamDestination: rig.createStreamDestination, createBufferedSink: noBuffer,
  })
  while (!transport.calls.includes('f1')) await tick()
  ctrl.abort()
  const res = await run
  assert.deepEqual(res, { status: 'cancelled' })
  assert.equal(rig.aborts, 1)
  assert.equal(rig.closes, 0)
  assert.deepEqual(transport.calls, ['f0', 'f1'])
  const body = await rig.bodies[0]
  assert.equal(body.ok, false, 'a cancelled download never ends as a clean file')
  assert.equal(rig.state.sessionCount(), 0)
})

/* ── 18: source failure ────────────────────────────────────────── */

test('ORCH-WS-3 a source failure aborts once and requests no later entry', async (t) => {
  spyBlobs(t)
  const rows = rowsOf([1 * KiB, 1 * KiB, 1 * KiB, 1 * KiB])
  const plan = filesPlan(rows)
  const rig = workerStreamRig()
  const transport = filesTransport(rows, { fail: 'f1' })
  const res = await runBulkZip({
    plan, source: createFilesEntrySource({ fetchStream: transport.fetchStream }), scope: noPicker, busyRef: { current: false },
    createStreamDestination: rig.createStreamDestination, createBufferedSink: noBuffer,
  })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'server')
  assert.deepEqual(res.failedEntry, { index: 1, name: 'file1.bin' })
  assert.deepEqual(transport.calls, ['f0', 'f1'])
  assert.equal(rig.aborts, 1)
  assert.equal((await rig.bodies[0]).ok, false)
})

/* ── 19: Vault, real crypto, lock ──────────────────────────────── */

const subtle = globalThis.crypto.subtle
const kekOf = () => subtle.importKey('raw', new Uint8Array(32).fill(7), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
function fillPattern(out, offset, seed) {
  for (let i = 0; i < out.length; i += 1) out[i] = ((offset + i) * 31 + seed * 17) & 0xff
  return out
}
async function lazyV2(kek, plainSize, seed) {
  const plan = planVaultChunks(plainSize, 4 * KiB)
  const env = await createVaultV2Envelope(kek, { name: 'x', type: '', size: plainSize, chunkCount: plan.chunkCount })
  const blob = {
    id: `B${seed}`.padEnd(22, 'x'), formatVersion: 2, size: plan.ciphertextSize, createdAt: 1,
    contentIdB64: env.contentIdB64, chunkSize: plan.chunkSize, chunkCount: plan.chunkCount,
    wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64,
  }
  const plainChunk = (i) => {
    const r = plaintextRangeFor(i, plainSize, plan.plaintextChunkBytes)
    return fillPattern(new Uint8Array(r.end - r.start), r.start, seed)
  }
  return {
    blob, plainSize,
    plaintext: () => fillPattern(new Uint8Array(plainSize), 0, seed),
    cipherChunk: (i) => encryptVaultChunk(env.dek, { contentId: env.contentId, chunkIndex: i, chunkCount: plan.chunkCount, plaintext: plainChunk(i) }),
  }
}
async function vaultRig(sizes, { onFetch = null } = {}) {
  const kek = await kekOf()
  const sources = await Promise.all(sizes.map((s, i) => lazyV2(kek, s, i + 1)))
  const nodes = sources.map((s, i) => ({ nodeId: `n${i}`, kind: 'file', name: `v${i}.bin`, plainSize: s.plainSize, blobRef: { formatVersion: 2, id: s.blob.id } }))
  const index = new Map(sources.map((s) => [s.blob.id, s]))
  const plan = planBulkDownload({ source: 'vault', items: nodes, resolve: (n) => index.get(n.blobRef.id)?.blob ?? null, fsa: false, workerStream: true, enabled: true, now: NOW })
  const fetchBytes = async (path, opts = {}) => {
    const parts = path.split('/')
    const id = parts[4]
    const ci = Number(parts[6])
    await onFetch?.(id, ci, opts)
    if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    const { ivB64, ciphertext } = await index.get(id).cipherChunk(ci)
    return { ok: true, status: 200, bytes: new Uint8Array(ciphertext), headers: { get: (h) => (h === 'X-Vault-Chunk-IV' ? ivB64 : null) }, errorKind: null }
  }
  return { kek, sources, plan, fetchBytes }
}

test('ORCH-WS-4 Vault V2: authenticated plaintext ZIP through the worker, no Blob, no object URL', async (t) => {
  const blobs = spyBlobs(t)
  const v = await vaultRig([10 * KiB, 1, 0, 9 * KiB + 5])
  assert.equal(v.plan.transport, 'worker-stream')
  const rig = workerStreamRig()
  const registered = []
  const res = await runBulkZip({
    plan: v.plan, source: createVaultV2EntrySource({ kek: v.kek, download: (args) => downloadVaultV2({ ...args, fetchBytes: v.fetchBytes }) }),
    scope: noPicker, busyRef: { current: false }, createStreamDestination: rig.createStreamDestination, createBufferedSink: noBuffer,
    registerObjectUrl: (u) => registered.push(u),
  })
  assert.deepEqual(res, { status: 'done' })
  assert.equal(rig.lastOpts.source, 'vault')
  assert.equal(blobs.length, 0)
  assert.deepEqual(registered, [])
  const body = await rig.bodies[0]
  const entries = parseZip(body.bytes)
  entries.forEach((e, i) => assert.deepEqual(e.data, v.sources[i].plaintext(), e.name))
})

test('ORCH-WS-5 Vault lock mid-transfer: cancelled, the stream errors, abort once, no later entry', async (t) => {
  spyBlobs(t)
  let purged = false
  const ctrl = new AbortController()
  const fetched = []
  const v = await vaultRig([12 * KiB, 12 * KiB, 12 * KiB, 12 * KiB], {
    onFetch: (id, ci) => {
      fetched.push(`${id[1]}:${ci}`)
      if (id.startsWith('B2') && ci === 1) { purged = true; ctrl.abort() } // purgeUnlockedVaultState aborts the controller
    },
  })
  const rig = workerStreamRig()
  const res = await runBulkZip({
    plan: v.plan, source: createVaultV2EntrySource({ kek: v.kek, isPurged: () => purged, download: (args) => downloadVaultV2({ ...args, fetchBytes: v.fetchBytes }) }),
    scope: noPicker, busyRef: { current: false }, signal: ctrl.signal, isPurged: () => purged,
    createStreamDestination: rig.createStreamDestination, createBufferedSink: noBuffer,
  })
  assert.deepEqual(res, { status: 'cancelled' })
  assert.equal(rig.aborts, 1)
  assert.equal(rig.closes, 0)
  assert.ok(!fetched.some((f) => f.startsWith('3:') || f.startsWith('4:')), `no later entry: ${fetched}`)
  assert.equal((await rig.bodies[0]).ok, false)
  assert.equal(rig.state.sessionCount(), 0)
})

test('ORCH-WS-6 the worker purging Vault downloads (close-all on lock) fails the archive, never done', async (t) => {
  spyBlobs(t)
  let rigRef = null
  const v = await vaultRig([12 * KiB, 12 * KiB, 12 * KiB, 12 * KiB], {
    onFetch: (id, ci) => { if (id.startsWith('B2') && ci === 0) rigRef.state.closeAll({ source: 'vault' }) },
  })
  const rig = workerStreamRig()
  rigRef = rig
  const res = await runBulkZip({
    plan: v.plan, source: createVaultV2EntrySource({ kek: v.kek, download: (args) => downloadVaultV2({ ...args, fetchBytes: v.fetchBytes }) }),
    scope: noPicker, busyRef: { current: false }, createStreamDestination: rig.createStreamDestination, createBufferedSink: noBuffer,
  })
  assert.equal(res.status, 'failed')
  assert.equal((await rig.bodies[0]).ok, false)
})

test('ORCH-WS-7 Vault pre-flight failure never opens the worker destination', async (t) => {
  spyBlobs(t)
  const v = await vaultRig([1 * KiB, 1 * KiB, 1 * KiB, 1 * KiB])
  const rig = workerStreamRig()
  const wrongKek = await subtle.importKey('raw', new Uint8Array(32).fill(9), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const res = await runBulkZip({
    plan: v.plan, source: createVaultV2EntrySource({ kek: wrongKek }), scope: noPicker, busyRef: { current: false },
    createStreamDestination: rig.createStreamDestination, createBufferedSink: noBuffer,
  })
  assert.equal(res.status, 'failed')
  assert.equal(res.reason, 'wrong-key')
  assert.equal(rig.opens, 0)
})

/* ── destination unavailable at run time ───────────────────────── */

test('ORCH-WS-8 worker unavailable and archive ≤ 64 MiB: falls back to the buffered path (nothing written yet)', async (t) => {
  const blobs = spyBlobs(t)
  t.mock.timers.enable({ apis: ['setTimeout'] }) // finalizeBufferedZip revokes after 10 s
  clicks.length = 0
  const rows = rowsOf([5, 7, 9, 11])
  const plan = filesPlan(rows)
  const rig = workerStreamRig({ failOpen: true })
  const res = await runBulkZip({
    plan, source: createFilesEntrySource({ fetchStream: filesTransport(rows).fetchStream }), scope: noPicker, busyRef: { current: false },
    createStreamDestination: rig.createStreamDestination,
  })
  assert.deepEqual(res, { status: 'done' })
  assert.equal(blobs.length, 1)
  assert.equal(blobs[0].size, plan.layout.total)
  assert.equal(clicks.length, 1)
})

test('ORCH-WS-9 worker unavailable and archive > 64 MiB: stream-unavailable before any entry is opened', async (t) => {
  const blobs = spyBlobs(t)
  const rows = rowsOf([30 * MiB, 30 * MiB, 20 * MiB, 20 * MiB])
  const plan = filesPlan(rows)
  assert.ok(plan.layout.total > MAX_BUFFERED_PLAINTEXT_BYTES)
  const rig = workerStreamRig({ failOpen: true })
  const transport = filesTransport(rows)
  const res = await runBulkZip({
    plan, source: createFilesEntrySource({ fetchStream: transport.fetchStream }), scope: noPicker, busyRef: { current: false },
    createStreamDestination: rig.createStreamDestination, createBufferedSink: noBuffer,
  })
  assert.deepEqual(res, { status: 'failed', reason: 'stream-unavailable' })
  assert.deepEqual(transport.calls, [])
  assert.equal(blobs.length, 0)
})

test('ORCH-WS-10 cancelled while the worker destination opens → cancelled, not failed', async () => {
  const rows = rowsOf([1, 1, 1, 1])
  const plan = filesPlan(rows)
  const ctrl = new AbortController()
  const res = await runBulkZip({
    plan, source: createFilesEntrySource({ fetchStream: filesTransport(rows).fetchStream }), scope: noPicker, busyRef: { current: false },
    signal: ctrl.signal, createBufferedSink: noBuffer,
    createStreamDestination: async () => { ctrl.abort(); return { ok: false, reason: 'cancelled' } },
  })
  assert.deepEqual(res, { status: 'cancelled' })
})

/* ── 20: FSA regression ────────────────────────────────────────── */

test('ORCH-WS-11 FSA transport is unchanged: one picker call, createWritable, never the worker destination', async () => {
  const rows = rowsOf([5, 0, 300, 12])
  const plan = filesPlan(rows, { fsa: true, workerStream: true })
  assert.equal(plan.transport, 'fsa')
  const written = []
  let pickerCalls = 0
  const scope = {
    async showSaveFilePicker(opts) {
      pickerCalls += 1
      assert.equal(opts.suggestedName, 'AEGIS-Files-20261005-010203.zip')
      return { async createWritable() { return { async write(b) { written.push(b.slice()) }, async close() {}, async abort() {} } } }
    },
  }
  let streamOpens = 0
  const res = await runBulkZip({
    plan, source: createFilesEntrySource({ fetchStream: filesTransport(rows).fetchStream }), scope, busyRef: { current: false },
    createStreamDestination: async () => { streamOpens += 1; return { ok: false } }, createBufferedSink: noBuffer,
  })
  assert.deepEqual(res, { status: 'done' })
  assert.equal(pickerCalls, 1)
  assert.equal(streamOpens, 0)
  const entries = parseZip(concat(written))
  entries.forEach((e, i) => assert.deepEqual(e.data, bytesOf(rows[i].size, i + 1)))
})
