// tests/bulkZipVault.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 8
//
// Vault V2 source (spec §11) at module level with REAL WebCrypto and real AAD; only the network leg
// (fetchBytes) and the File System Access handle are fakes.
//   pre-flight  authenticates EVERY envelope before createWritable, from memory only; validates the
//               authenticated plainSize strictly (no coercion) and against the manifest; keeps no key;
//               returns a NEW frozen effective plan whose sizes are the authenticated ones (SC-4).
//   open/pump   no network in open; pump streams through downloadVaultV2 with the SAME frozen blob
//               copy, so every chunk is AEAD-verified before it reaches the ZIP sink.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { runBulkZip, createVaultV2EntrySource } from '../src/lib/bulkZipDownload.js'
import { planBulkDownload, zipLayout } from '../src/lib/bulkDownloadPlan.js'
import { createZipStreamWriter } from '../src/lib/zipStreamWriter.js'
import { authenticateVaultV2Entry, downloadVaultV2 } from '../src/lib/vaultChunkedDownload.js'
import {
  createVaultV2Envelope, encryptVaultChunk, planVaultChunks, plaintextRangeFor, metadataAad, newContentId,
} from '../src/lib/vaultChunkCrypto.js'

const subtle = globalThis.crypto.subtle
const KiB = 1024
const MiB = 1024 * KiB
const kekOf = (seed = 7) => subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
const sha = (b) => createHash('sha256').update(b).digest('hex')
const b64 = (bytes) => Buffer.from(bytes).toString('base64')

function fillPattern(out, offset, seed) {
  for (let i = 0; i < out.length; i += 1) out[i] = ((offset + i) * 31 + seed * 17) & 0xff
  return out
}

/** A V2 blob as the server stores it; ciphertext is produced per chunk request. */
async function lazyV2(kek, plainSize, { seed = 1, chunk = 4 * KiB, id } = {}) {
  const plan = planVaultChunks(plainSize, chunk)
  const env = await createVaultV2Envelope(kek, { name: 'ignored-envelope-name', type: '', size: plainSize, chunkCount: plan.chunkCount })
  const blob = {
    id: id ?? `B${seed}`.padEnd(22, 'x'), formatVersion: 2, size: plan.ciphertextSize, createdAt: 1,
    contentIdB64: env.contentIdB64, chunkSize: plan.chunkSize, chunkCount: plan.chunkCount,
    wrappedDekB64: env.wrappedDekB64, wrapIvB64: env.wrapIvB64, metaIvB64: env.metaIvB64, metaB64: env.metaB64,
  }
  const plainChunk = (i) => {
    const r = plaintextRangeFor(i, plainSize, plan.plaintextChunkBytes)
    return fillPattern(new Uint8Array(r.end - r.start), r.start, seed)
  }
  const plaintext = () => {
    const out = new Uint8Array(plainSize)
    for (let i = 0; i < plan.chunkCount; i += 1) out.set(plainChunk(i), plaintextRangeFor(i, plainSize, plan.plaintextChunkBytes).start)
    return out
  }
  const cipherChunk = (i) => encryptVaultChunk(env.dek, { contentId: env.contentId, chunkIndex: i, chunkCount: plan.chunkCount, plaintext: plainChunk(i) })
  return { blob, plan, plaintext, cipherChunk, chunkPlain: plan.plaintextChunkBytes }
}

/** A real envelope whose encrypted metadata carries exactly `plainSize` (any JSON type). */
async function envelopeWithPlainSize(kek, plainSize, id = 'S'.padEnd(22, 's')) {
  const contentId = newContentId()
  const dekRaw = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const dek = await subtle.importKey('raw', dekRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const metaIv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const metaCipher = await subtle.encrypt({ name: 'AES-GCM', iv: metaIv, additionalData: metadataAad(contentId, 1) }, dek,
    new TextEncoder().encode(JSON.stringify({ name: 'x', type: '', plainSize })))
  const wrapIv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, kek, dekRaw)
  return {
    id, formatVersion: 2, size: 3 + 16, chunkSize: 4 * KiB + 16, chunkCount: 1, contentIdB64: b64(contentId),
    wrappedDekB64: b64(new Uint8Array(wrapped)), wrapIvB64: b64(wrapIv), metaIvB64: b64(metaIv), metaB64: b64(new Uint8Array(metaCipher)),
  }
}

/** Builds a real plan (planBulkDownload) over nodes/blobs plus a network leg serving the sources. */
function vaultFixture(sources, { names, manifest = {}, events = [], tamperChunk = null, fsa = true } = {}) {
  const nodes = sources.map((s, i) => ({
    nodeId: `n${i}`, kind: 'file', name: names?.[i] ?? `v${i}.bin`,
    plainSize: Object.hasOwn(manifest, i) ? manifest[i] : s.plaintext ? s.plan.chunkCount && s.plaintext().length : undefined,
    blobRef: { formatVersion: 2, id: s.blob.id },
  }))
  const index = new Map(sources.map((s) => [`2:${s.blob.id}`, s.blob]))
  const plan = planBulkDownload({
    source: 'vault', items: nodes, resolve: (n) => index.get(`2:${n.blobRef.id}`) ?? null, fsa, enabled: true, now: new Date(2026, 9, 5),
  })
  const byId = new Map(sources.map((s) => [s.blob.id, s]))
  let inFlight = 0
  const stats = { maxInFlight: 0, fetches: 0 }
  const fetchBytes = async (path, opts = {}) => {
    const parts = path.split('/')
    const id = parts[4]
    const ci = Number(parts[6])
    events.push(`fetch:${id}:${ci}`)
    stats.fetches += 1
    inFlight += 1
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight)
    try {
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      const { ivB64, ciphertext } = await byId.get(id).cipherChunk(ci)
      const bytes = new Uint8Array(ciphertext)
      if (tamperChunk && tamperChunk.id === id && tamperChunk.index === ci) bytes[0] ^= 0xff
      return { ok: true, status: 200, bytes, headers: { get: (h) => (h === 'X-Vault-Chunk-IV' ? ivB64 : null) }, errorKind: null }
    } finally {
      inFlight -= 1
    }
  }
  return { plan, nodes, fetchBytes, stats, events }
}

function fsaHarness(events, { closeHook = null } = {}) {
  const written = []
  let count = 0
  let maxHeld = 0
  const writable = {
    async write(bytes) {
      events.push(`write:${bytes.length}`)
      maxHeld = Math.max(maxHeld, bytes.length)
      written.push({ pos: count, bytes: bytes.slice() })
      count += bytes.length
    },
    async close() { events.push('close'); await closeHook?.() },
    async abort() { events.push('abort') },
  }
  const scope = {
    showSaveFilePicker() {
      events.push('picker')
      return Promise.resolve({ async createWritable() { events.push('createWritable'); return writable } })
    },
  }
  const output = () => { const o = new Uint8Array(count); for (const w of written) o.set(w.bytes, w.pos); return o }
  return { scope, output, maxHeld: () => maxHeld, count: () => count }
}

function vaultSource({ kek, fetchBytes, events, authenticate = authenticateVaultV2Entry, isPurged = () => false, counters = null }) {
  return createVaultV2EntrySource({
    kek, isPurged,
    authenticate: async (args) => {
      events.push(`auth:${args.blob.id}`)
      counters?.authBlobs.push(args.blob)
      return authenticate(args)
    },
    download: (args) => {
      counters?.downloadBlobs.push(args.blob)
      return downloadVaultV2({ ...args, fetchBytes })
    },
  })
}

/** Walks classic local entries (no ZIP64 at these sizes) and returns each payload. */
function payloads(out, sizes) {
  const res = []
  let p = 0
  for (const s of sizes) {
    assert.deepEqual([...out.subarray(p, p + 4)], [0x50, 0x4b, 3, 4])
    const n = out[p + 26] | (out[p + 27] << 8)
    const start = p + 30 + n
    res.push(out.subarray(start, start + s))
    const dv = new DataView(out.buffer, out.byteOffset + start + s, 16)
    res.at(-1).crc = dv.getUint32(4, true)
    p = start + s + 16
  }
  return res
}

/* ── pre-flight ordering ─────────────────────────────────────────── */

test('VZ-1 every envelope is authenticated before createWritable, with no network during pre-flight; bytes round-trip', async () => {
  const kek = await kekOf()
  const sources = await Promise.all([9 * KiB, 1, 12 * KiB, 5 * KiB].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  const events = []
  const fx = vaultFixture(sources, { events })
  const h = fsaHarness(events)
  const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events }), scope: h.scope, busyRef: { current: false } })
  assert.equal(res.status, 'done')
  const iWritable = events.indexOf('createWritable')
  const auths = events.map((e, i) => [e, i]).filter(([e]) => e.startsWith('auth:'))
  assert.equal(auths.length, 4)
  for (const [, i] of auths) assert.ok(i < iWritable)
  assert.ok(!events.slice(0, iWritable).some((e) => e.startsWith('fetch:')), 'no fetch during pre-flight')
  const got = payloads(h.output(), sources.map((s) => s.plaintext().length))
  got.forEach((g, i) => assert.equal(sha(g), sha(sources[i].plaintext())))
  assert.equal(fx.stats.maxInFlight, 1)
  // strict fetch/write alternation: each fetched chunk is written before the next fetch
  const seq = events.filter((e) => e.startsWith('fetch:') || e.startsWith('write:'))
  for (let i = 0; i < seq.length - 1; i += 1) {
    if (seq[i].startsWith('fetch:')) assert.ok(seq[i + 1].startsWith('write:'), `fetch ${seq[i]} followed by a write`)
  }
  assert.ok(h.maxHeld() <= sources[0].chunkPlain, 'memory proxy: no write larger than one plaintext chunk')
})

test('VZ-2 a bad envelope on entry 3: wrong-key, no createWritable, zero chunk fetches', async () => {
  const kek = await kekOf()
  const sources = await Promise.all([1, 2, 3, 4].map((n, i) => lazyV2(kek, n * KiB, { seed: i + 1 })))
  const meta = Buffer.from(sources[2].blob.metaB64, 'base64')
  meta[1] ^= 0x55
  sources[2].blob.metaB64 = b64(meta)
  const events = []
  const fx = vaultFixture(sources, { events })
  const h = fsaHarness(events)
  const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events }), scope: h.scope, busyRef: { current: false } })
  assert.deepEqual(res, { status: 'failed', reason: 'wrong-key', failedEntry: { index: 2, name: 'v2.bin' } })
  assert.ok(!events.includes('createWritable'))
  assert.equal(fx.stats.fetches, 0)
})

/* ── strict authenticated size (Fix B) ───────────────────────────── */

test('VZ-3 non-integer / unsafe / negative authenticated plainSize → integrity before createWritable (no coercion)', async () => {
  const kek = await kekOf()
  const sources = await Promise.all([1, 2, 3, 4].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  for (const bad of [undefined, null, '123', '-1', 1.5, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const events = []
    const fx = vaultFixture(sources, { events, manifest: { 0: undefined, 1: undefined, 2: undefined, 3: undefined } })
    const h = fsaHarness(events)
    const authenticate = async ({ blob }) => (blob.id === sources[1].blob.id ? { ok: true, plainSize: bad } : authenticateVaultV2Entry({ kek, blob }))
    const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events, authenticate }), scope: h.scope, busyRef: { current: false } })
    assert.equal(res.status, 'failed', String(bad))
    assert.equal(res.reason, 'integrity', String(bad))
    assert.equal(res.failedEntry.index, 1)
    assert.ok(!events.includes('createWritable'), String(bad))
    assert.equal(fx.stats.fetches, 0, String(bad))
  }
})

test('VZ-4 real crypto: metadata plainSize "123" (a string) is rejected end-to-end as integrity', async () => {
  const kek = await kekOf()
  const good = await Promise.all([1, 2, 3].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  const strBlob = await envelopeWithPlainSize(kek, '123')
  const sources = [...good, { blob: strBlob, plan: { chunkCount: 1 }, cipherChunk: () => { throw new Error('never fetched') } }]
  const events = []
  const fx = vaultFixture(sources, { events, manifest: { 3: undefined } })
  const h = fsaHarness(events)
  const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events }), scope: h.scope, busyRef: { current: false } })
  assert.equal(res.reason, 'integrity')
  assert.equal(res.failedEntry.index, 3)
  assert.ok(!events.includes('createWritable'))
})

/* ── effective size (Fix C/D) ────────────────────────────────────── */

test('VZ-5 manifest absent: the effective size is the authenticated value, not the provisional estimate', async () => {
  const kek = await kekOf()
  const sources = await Promise.all([3000, 1, 4096, 77].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  // deliberately wrong ciphertext size so estimatedPlainSize() gives a sentinel provisional size
  for (const s of sources) s.blob.size += 1000
  const events = []
  const fx = vaultFixture(sources, { events, manifest: { 0: undefined, 1: undefined, 2: undefined, 3: undefined } })
  assert.notEqual(fx.plan.entries[0].size, 3000, 'provisional size is the estimate sentinel')
  const h = fsaHarness(events)
  const layoutCalls = []
  const adds = []
  const progress = []
  const res = await runBulkZip({
    plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events }), scope: h.scope, busyRef: { current: false },
    computeLayout: (e, o) => { layoutCalls.push(e.map((x) => x.size)); return zipLayout(e, o) },
    createWriter: (o) => { const w = createZipStreamWriter(o); return { ...w, addEntry: (e) => { adds.push(e.size); return w.addEntry(e) } } },
    onProgress: (p) => progress.push(p),
  })
  assert.equal(res.status, 'done')
  assert.deepEqual(layoutCalls, [[3000, 1, 4096, 77]])
  assert.deepEqual(adds, [3000, 1, 4096, 77])
  for (const p of progress.filter((x) => x.stage !== 'preparing')) assert.equal(p.totalBytes, 3000 + 1 + 4096 + 77)
  assert.equal(h.count(), zipLayout(fx.plan.entries.map((e, i) => ({ name: e.name, size: [3000, 1, 4096, 77][i] }))).total)
  assert.ok(Object.isFrozen(fx.plan))
  assert.ok(fx.plan.entries.every((e) => Object.isFrozen(e)))
})

test('VZ-6 manifest present and equal → success; different, "5" or -1 → integrity before createWritable', async () => {
  const kek = await kekOf()
  const sources = await Promise.all([10, 20, 30, 40].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  {
    const events = []
    const fx = vaultFixture(sources, { events, manifest: { 0: 10, 1: 20, 2: 30, 3: 40 } })
    const h = fsaHarness(events)
    assert.equal((await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events }), scope: h.scope, busyRef: { current: false } })).status, 'done')
  }
  for (const bad of [21, '20', -1, 20.5]) {
    const events = []
    const fx = vaultFixture(sources, { events, manifest: { 0: 10, 1: bad, 2: 30, 3: 40 } })
    const h = fsaHarness(events)
    const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events }), scope: h.scope, busyRef: { current: false } })
    assert.equal(res.reason, 'integrity', String(bad))
    assert.equal(res.failedEntry.index, 1)
    assert.ok(!events.includes('createWritable'))
    assert.equal(fx.stats.fetches, 0)
  }
})

test('VZ-7 pre-flight returns a NEW frozen effective plan; originals untouched; the blob object is shared', async () => {
  const kek = await kekOf()
  const sources = await Promise.all([1, 2, 3, 4].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  const fx = vaultFixture(sources)
  const source = createVaultV2EntrySource({ kek })
  const pre = await source.preflight(fx.plan, new AbortController().signal)
  assert.equal(pre.ok, true)
  const eff = pre.effectivePlan
  assert.notEqual(eff, fx.plan)
  assert.ok(Object.isFrozen(eff) && Object.isFrozen(eff.entries))
  eff.entries.forEach((e, i) => {
    assert.ok(Object.isFrozen(e))
    assert.notEqual(e, fx.plan.entries[i])
    assert.equal(e.blob, fx.plan.entries[i].blob, 'same frozen blob copy')
    assert.equal(e.size, i + 1)
    assert.equal(e.name, fx.plan.entries[i].name)
    for (const v of Object.values(e)) assert.ok(!(v instanceof CryptoKey), 'no key retained')
  })
  assert.equal(eff.layout, undefined, 'no stale provisional layout is carried over')
})

test('VZ-8 keys are not retained: exactly 2 × entries raw AES-GCM imports; authenticate and download once each per entry, same blob', async (t) => {
  const kek = await kekOf()
  const sources = await Promise.all([5, 6, 7, 8].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  const events = []
  const fx = vaultFixture(sources, { events })
  const h = fsaHarness(events)
  const counters = { authBlobs: [], downloadBlobs: [] }
  const imp = t.mock.method(subtle, 'importKey')
  const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events, counters }), scope: h.scope, busyRef: { current: false } })
  assert.equal(res.status, 'done')
  const raws = imp.mock.calls.filter((c) => c.arguments[0] === 'raw' && (c.arguments[2]?.name ?? c.arguments[2]) === 'AES-GCM')
  assert.equal(raws.length, 8)
  assert.equal(counters.authBlobs.length, 4)
  assert.equal(counters.downloadBlobs.length, 4)
  counters.authBlobs.forEach((b, i) => {
    assert.equal(b, fx.plan.entries[i].blob)
    assert.equal(counters.downloadBlobs[i], b, 'authenticate and download see the same object')
  })
})

/* ── AEAD before the sink ────────────────────────────────────────── */

test('VZ-9 a tampered chunk in entry 2: one abort, no close, entry 2 named, entry 3 never fetched', async () => {
  const kek = await kekOf()
  const sources = await Promise.all([9 * KiB, 9 * KiB, 9 * KiB, 9 * KiB].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  const events = []
  const fx = vaultFixture(sources, { events, tamperChunk: { id: sources[1].blob.id, index: 1 } })
  const h = fsaHarness(events)
  const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events }), scope: h.scope, busyRef: { current: false } })
  assert.deepEqual(res, { status: 'failed', reason: 'auth-failed', failedEntry: { index: 1, name: 'v1.bin' } })
  assert.equal(events.filter((e) => e === 'abort').length, 1)
  assert.ok(!events.includes('close'))
  assert.ok(!events.some((e) => e.startsWith(`fetch:${sources[2].blob.id}`)))
  // only entry 2's first chunk (authenticated) reached the sink before the failure
  const e2writes = events.slice(events.indexOf(`fetch:${sources[1].blob.id}:0`))
  assert.ok(!e2writes.slice(e2writes.indexOf(`fetch:${sources[1].blob.id}:1`)).some((e) => e.startsWith('write:') && e !== 'write:0'))
})

/* ── zero-byte V2 entry ──────────────────────────────────────────── */

test('VZ-10 zero-byte V2 entry: its tag-only chunk is fetched and verified; the entry extracts as 0 bytes with CRC 0', async () => {
  const kek = await kekOf()
  const sources = await Promise.all([3, 0, 4, 5].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  assert.equal(sources[1].plan.chunkCount, 1)
  {
    const events = []
    const fx = vaultFixture(sources, { events })
    const h = fsaHarness(events)
    const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events }), scope: h.scope, busyRef: { current: false } })
    assert.equal(res.status, 'done')
    assert.ok(events.includes(`fetch:${sources[1].blob.id}:0`), 'the tag-only chunk is fetched')
    const got = payloads(h.output(), [3, 0, 4, 5])
    assert.equal(got[1].length, 0)
    assert.equal(got[1].crc, 0)
  }
  {
    const events = []
    const fx = vaultFixture(sources, { events, tamperChunk: { id: sources[1].blob.id, index: 0 } })
    const h = fsaHarness(events)
    const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events }), scope: h.scope, busyRef: { current: false } })
    assert.equal(res.reason, 'auth-failed')
    assert.equal(res.failedEntry.index, 1)
    assert.ok(!events.includes('close'))
  }
})

/* ── lock and cancel ─────────────────────────────────────────────── */

test('VZ-11 lock during pre-flight / mid-entry / after the last entry, and Cancel: abort, no close, nothing later fetched', async () => {
  const kek = await kekOf()
  const sources = await Promise.all([9 * KiB, 9 * KiB, 9 * KiB, 9 * KiB].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  // during pre-flight
  {
    const events = []
    const fx = vaultFixture(sources, { events })
    const h = fsaHarness(events)
    let purged = false
    const authenticate = async (a) => { const r = await authenticateVaultV2Entry(a); if (a.blob.id === sources[1].blob.id) purged = true; return r }
    const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events, authenticate, isPurged: () => purged }), scope: h.scope, busyRef: { current: false }, isPurged: () => purged })
    assert.equal(res.status, 'cancelled')
    assert.ok(!events.includes('createWritable'))
    assert.equal(fx.stats.fetches, 0)
  }
  // mid-entry (the lock aborts the registered controller)
  {
    const events = []
    const ctrl = new AbortController()
    let purged = false
    const fx = vaultFixture(sources, { events })
    const fetchBytes = async (p, o) => { const r = await fx.fetchBytes(p, o); if (p.includes(sources[1].blob.id) && p.endsWith('/1')) { purged = true; ctrl.abort() } return r }
    const h = fsaHarness(events)
    const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes, events, isPurged: () => purged }), scope: h.scope, busyRef: { current: false }, signal: ctrl.signal, isPurged: () => purged })
    assert.equal(res.status, 'cancelled')
    assert.equal(events.filter((e) => e === 'abort').length, 1)
    assert.ok(!events.includes('close'))
    assert.ok(!events.some((e) => e.startsWith(`fetch:${sources[2].blob.id}`)))
  }
  // after the last entry, before close
  {
    const events = []
    let purged = false
    const fx = vaultFixture(sources, { events })
    const h = fsaHarness(events)
    const createWriter = (o) => { const w = createZipStreamWriter(o); return { ...w, finish: async () => { await w.finish(); purged = true } } }
    const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events, isPurged: () => purged }), scope: h.scope, busyRef: { current: false }, isPurged: () => purged, createWriter })
    assert.equal(res.status, 'cancelled')
    assert.equal(events.filter((e) => e === 'abort').length, 1)
    assert.ok(!events.includes('close'))
  }
  // Cancel: no later entry fetched
  {
    const events = []
    const ctrl = new AbortController()
    const fx = vaultFixture(sources, { events })
    const fetchBytes = async (p, o) => { const r = await fx.fetchBytes(p, o); if (p.includes(sources[0].blob.id) && p.endsWith('/2')) ctrl.abort(); return r }
    const h = fsaHarness(events)
    const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes, events }), scope: h.scope, busyRef: { current: false }, signal: ctrl.signal })
    assert.equal(res.status, 'cancelled')
    assert.ok(!events.some((e) => e.startsWith(`fetch:${sources[1].blob.id}`)))
    assert.ok(!events.includes('close'))
  }
})

test('VZ-12 open() makes no network request and reports the effective size; dispose is a no-op', async () => {
  const kek = await kekOf()
  const src = await lazyV2(kek, 10, { seed: 3 })
  let fetches = 0
  const source = createVaultV2EntrySource({ kek, download: () => { fetches += 1; return { ok: true, bytesWritten: 10 } } })
  const opened = await source.open(Object.freeze({ nodeId: 'n', name: 'x', blob: src.blob, size: 10 }), new AbortController().signal)
  assert.equal(opened.ok, true)
  assert.equal(opened.size, 10)
  assert.equal(fetches, 0)
  opened.dispose('cancelled')
  opened.dispose('cancelled')
})

test('VZ-13 pump requires bytesWritten === effective size', async () => {
  const source = createVaultV2EntrySource({ kek: {}, download: async () => ({ ok: true, bytesWritten: 9 }) })
  const opened = await source.open(Object.freeze({ nodeId: 'n', name: 'x', blob: {}, size: 10 }), undefined)
  assert.deepEqual(await opened.pump({ write() {}, close() {}, abort() {} }, undefined), { ok: false, reason: 'size-mismatch' })
  const failing = createVaultV2EntrySource({ kek: {}, download: async () => ({ ok: false, reason: 'network' }) })
  const o2 = await failing.open(Object.freeze({ nodeId: 'n', name: 'x', blob: {}, size: 10 }), undefined)
  assert.deepEqual(await o2.pump({}, undefined), { ok: false, reason: 'network' })
})

test('VZ-14 buffered path: authenticated sizes over 64 MiB are refused after pre-flight with nothing fetched', async () => {
  const kek = await kekOf()
  const sources = await Promise.all([1, 2, 3, 4].map((n, i) => lazyV2(kek, n, { seed: i + 1 })))
  const events = []
  const fx = vaultFixture(sources, { events, fsa: false, manifest: { 0: undefined, 1: undefined, 2: undefined, 3: undefined } })
  assert.equal(fx.plan.transport, 'buffered')
  const authenticate = async () => ({ ok: true, plainSize: 17 * MiB })
  const res = await runBulkZip({ plan: fx.plan, source: vaultSource({ kek, fetchBytes: fx.fetchBytes, events, authenticate }), busyRef: { current: false } })
  assert.equal(res.reason, 'too-large')
  assert.equal(fx.stats.fetches, 0)
})
