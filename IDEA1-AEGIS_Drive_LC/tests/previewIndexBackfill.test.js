// tests/previewIndexBackfill.test.js — D-1 PR-D · Task F.3 (+ E.4 backfill stop) · lazy backfill from tile bytes
//
// A tile that rendered through the ORIGINAL path (no index entry) already holds encoded thumb/poster bytes produced
// from plaintext this page decrypted for display. Backfill hands exactly those bytes to the writer — it never fetches,
// decrypts or re-encodes anything itself (NO_EXTRA_ORIGINAL_FETCH by construction), at most once per
// (node, kind, source) per unlocked session, ≤ backfillMaxPerSession, one at a time, and only when nothing interactive
// is running.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { createDerivativeBackfill } from '../src/lib/vaultDerivativeBackfill.js'
import { createPreviewIndexWriter } from '../src/lib/vaultPreviewIndexWriter.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'
import { PREVIEW_INDEX_LIMITS } from '../src/lib/vaultPreviewIndexConstants.js'
import { fakeJpeg, fakeWebp, fileNode, newKek, id22, TREE_ID } from './helpers/previewIndexFixture.mjs'
import { createWriterFakeServer, PI } from './helpers/previewIndexWriterFakeServer.mjs'

const hex48 = () => randomBytes(24).toString('hex')
const node = () => fileNode(id22(), hex48())
const tile = (o = {}) => ({ bytes: o.bytes ?? fakeJpeg(o.w ?? 320, o.h ?? 240), width: o.w ?? 320, height: o.h ?? 240, ...(o.mime ? { mime: o.mime } : {}) })
const flushMicro = async (n = 15) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }

function stubWriter() {
  const offers = []
  const w = {
    offers, enabled: true, budgetExhausted: false, inflight: 0, peak: 0, gate: null,
    offer(job) { offers.push({ ...job, bytes: new Uint8Array(job.bytes) }); return w.budgetExhausted ? 'BUDGET_EXHAUSTED' : 'QUEUED' },
    async flush() { w.inflight++; w.peak = Math.max(w.peak, w.inflight); try { if (w.gate) await w.gate } finally { w.inflight-- } return { committed: 1, dropped: 0, failed: 0, budgetExhausted: w.budgetExhausted } },
    stats() { return { enabled: w.enabled && !w.budgetExhausted, budgetExhausted: w.budgetExhausted, serverDisabled: false } },
  }
  return w
}

test('PIB-1 offers once per (nodeId, kind, sourceBlobRef) per session; a new source is a new offer', async () => {
  const writer = stubWriter()
  const b = createDerivativeBackfill({ writer })
  const n = node()
  assert.equal(b.offerTileResult(n, 'thumb', tile()), 'OFFERED')
  assert.equal(b.offerTileResult(n, 'thumb', tile()), 'SKIPPED')
  assert.equal(b.offerTileResult(n, 'poster', tile()), 'OFFERED')
  const replaced = { ...n, blobRef: { formatVersion: 2, id: hex48() } }
  assert.equal(b.offerTileResult(replaced, 'thumb', tile()), 'OFFERED')
  await flushMicro()
  assert.deepEqual(writer.offers.map((o) => [o.nodeId, o.kind, o.sourceBlobRef.id]), [[n.nodeId, 'thumb', n.blobRef.id], [n.nodeId, 'poster', n.blobRef.id], [n.nodeId, 'thumb', replaced.blobRef.id]])
})

test('PIB-2 bytes are copied synchronously (the scheduler may release its buffer right after)', async () => {
  const writer = stubWriter()
  const b = createDerivativeBackfill({ writer })
  const t = tile()
  const expected = new Uint8Array(t.bytes)
  b.offerTileResult(node(), 'thumb', t)
  t.bytes.fill(0)
  await flushMicro()
  assert.deepEqual(writer.offers[0].bytes, expected)
})

test('PIB-3 ≤ backfillMaxPerSession offers per unlocked session; ≤ 1 concurrent', async () => {
  const writer = stubWriter()
  let release
  writer.gate = new Promise((r) => { release = r })
  const b = createDerivativeBackfill({ writer, limits: Object.freeze({ ...PREVIEW_INDEX_LIMITS, backfillMaxPerSession: 3 }) })
  const results = Array.from({ length: 5 }, () => b.offerTileResult(node(), 'thumb', tile()))
  assert.deepEqual(results, ['OFFERED', 'OFFERED', 'OFFERED', 'SKIPPED', 'SKIPPED'])
  await flushMicro()
  assert.equal(writer.offers.length, 1, 'next job waits for the writer to finish the current one')
  release()
  await flushMicro()
  assert.equal(writer.offers.length, 3)
  assert.equal(writer.peak, 1)
})

test('PIB-4 deferred while an interactive upload/download/modal playback is active', async () => {
  const writer = stubWriter()
  let busy = true
  const b = createDerivativeBackfill({ writer, isDeferred: () => busy, retryMs: 5 })
  assert.equal(b.offerTileResult(node(), 'thumb', tile()), 'OFFERED')
  await flushMicro()
  assert.equal(writer.offers.length, 0)
  busy = false
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(writer.offers.length, 1)
  b.clear()
})

test('PIB-5 outside vp1 bounds or wrong signature → SKIPPED (never re-encoded); dims come from the bytes', async () => {
  const writer = stubWriter()
  const b = createDerivativeBackfill({ writer })
  assert.equal(b.offerTileResult(node(), 'poster', tile({ w: 640, h: 360 })), 'SKIPPED', 'today’s 640px tile poster exceeds vp1')
  assert.equal(b.offerTileResult(node(), 'thumb', tile({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]) })), 'SKIPPED', 'PNG is not a vp1 derivative MIME')
  assert.equal(b.offerTileResult(node(), 'thumb', tile({ bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>') })), 'SKIPPED')
  assert.equal(b.offerTileResult(node(), 'thumb', tile({ bytes: new Uint8Array([...fakeJpeg(), ...new Uint8Array(256 * 1024)]) })), 'SKIPPED')
  assert.equal(b.offerTileResult(node(), 'thumb', tile({ bytes: fakeJpeg(320, 240), mime: 'image/webp' })), 'SKIPPED', 'declared MIME disagrees with the bytes')
  // a video tile's declared 640×360 is layout metadata, not the encoded size: real dims are read from the bytes
  assert.equal(b.offerTileResult(node(), 'poster', { bytes: fakeJpeg(512, 288), width: 640, height: 360, mime: 'image/jpeg' }), 'OFFERED')
  assert.equal(b.offerTileResult(node(), 'thumb', tile({ bytes: fakeWebp(400, 300), w: 400, h: 300 })), 'OFFERED')
  await flushMicro()
  assert.deepEqual(writer.offers.map((o) => [o.kind, o.mime, o.width, o.height]), [['poster', 'image/jpeg', 512, 288], ['thumb', 'image/webp', 400, 300]])
})

test('PIB-6 writer OFF / missing / non-file node / unknown kind → SKIPPED', async () => {
  const off = stubWriter(); off.enabled = false
  assert.equal(createDerivativeBackfill({ writer: off }).offerTileResult(node(), 'thumb', tile()), 'SKIPPED')
  assert.equal(createDerivativeBackfill({ writer: null }).offerTileResult(node(), 'thumb', tile()), 'SKIPPED')
  const b = createDerivativeBackfill({ writer: stubWriter() })
  assert.equal(b.offerTileResult({ nodeId: id22(), kind: 'folder' }, 'thumb', tile()), 'SKIPPED')
  assert.equal(b.offerTileResult(node(), 'motion', tile()), 'SKIPPED')
  assert.equal(b.offerTileResult(node(), 'thumb', null), 'SKIPPED')
  await flushMicro()
  assert.equal(off.offers.length, 0)
})

test('PIB-7 E.4: once the writer latched its budget breaker, backfill stops offering and drops what it held', async () => {
  const writer = stubWriter()
  let release
  writer.gate = new Promise((r) => { release = r })
  const b = createDerivativeBackfill({ writer })
  for (let i = 0; i < 3; i++) b.offerTileResult(node(), 'thumb', tile())
  await flushMicro()
  writer.budgetExhausted = true
  release()
  await flushMicro()
  assert.equal(writer.offers.length, 1, 'held jobs dropped after exhaustion')
  assert.equal(b.offerTileResult(node(), 'thumb', tile()), 'SKIPPED')
  assert.equal(b.stats().pending, 0)
})

test('PIB-8 a failed job is not retried in the same session (retry only after a fresh unlock)', async () => {
  const writer = stubWriter()
  writer.offer = (job) => { writer.offers.push(job); return 'REJECTED' }
  const b = createDerivativeBackfill({ writer })
  const n = node()
  assert.equal(b.offerTileResult(n, 'thumb', tile()), 'OFFERED')
  await flushMicro()
  assert.equal(b.offerTileResult(n, 'thumb', tile()), 'SKIPPED')
  const fresh = createDerivativeBackfill({ writer: stubWriter() })
  assert.equal(fresh.offerTileResult(n, 'thumb', tile()), 'OFFERED', 'a new unlocked session may try again')
})

test('PIB-9 purge clears held bytes and stops everything', async () => {
  const unlockedState = createUnlockedVaultState({ closeAllPreviewSessions: () => {} })
  const writer = stubWriter()
  const b = createDerivativeBackfill({ writer, unlockedState, isDeferred: () => true, retryMs: 5 })
  const t = tile()
  b.offerTileResult(node(), 'thumb', t)
  unlockedState.purge('PAGE_HIDE')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(writer.offers.length, 0)
  assert.equal(b.stats().pending, 0)
  assert.equal(b.offerTileResult(node(), 'thumb', tile()), 'SKIPPED')
})

test('PIB-10 NO_EXTRA_ORIGINAL_FETCH: the module has no transport/decrypt/session import; end-to-end only preview-index requests', async () => {
  const src = readFileSync(new URL('../src/lib/vaultDerivativeBackfill.js', import.meta.url), 'utf8')
  for (const banned of ["from './api.js'", 'apiFetch', 'apiFetchBytes', 'fetchChunk', 'downloadVaultV2', 'vaultChunkedDownload', 'openPreviewSession', 'vaultPreviewSession', 'decrypt', 'fetch(', 'localStorage', 'sessionStorage', 'indexedDB', 'console.']) {
    assert.equal(src.includes(banned), false, banned)
  }
  const kek = await newKek()
  const server = createWriterFakeServer()
  const ROOT = 'R'.repeat(22)
  const n = node()
  const nodes = new Map([[ROOT, { nodeId: ROOT, kind: 'folder', parentNodeId: null, name: '', createdAtClient: 1, modifiedAtClient: 1, lifecycle: { state: 'active' } }], [n.nodeId, n]])
  const head = { treeId: TREE_ID, generation: 1, index: { nodes, rootNodeId: ROOT, limits: { maxDepth: 64 } } }
  const writer = createPreviewIndexWriter({ kek, transport: server.transport, getMainHead: async () => head, writeAllowed: () => true, autoFlush: false })
  const b = createDerivativeBackfill({ writer })
  assert.equal(b.offerTileResult(n, 'thumb', tile()), 'OFFERED')
  await flushMicro(40)
  await writer.flush()
  assert.equal(server.state.head?.indexGeneration, 1)
  const paths = [...server.log.map((r) => r.path), ...server.t.requests.map((r) => r.path)]
  for (const p of paths) assert.ok(p.startsWith(PI) || /^\/api\/vault\/blobs\/[0-9a-f]{48}\/chunks\/0$/.test(p), p)
  assert.equal(paths.some((p) => p.includes(n.blobRef.id)), false, 'the original blob is never requested')
})

/* ── jsdom screen: the original tile path feeds backfill without one extra original request ──────────────── */
import { after as afterAll } from 'node:test'
import React from 'react'
import { makeT } from '../src/lib/strings.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { CORRECT_PASSPHRASE, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, unlock, settle } from './helpers/vaultScreenHarness.js'

let screenEnv = null
afterAll(async () => { await screenEnv?.stop(); delete globalThis.__VAULT_BACKEND__ })

/** jsdom has no decoder/canvas: minimal globals so the EXISTING original-path thumb code can run */
function installImageGlobals() {
  const saved = { cib: globalThis.createImageBitmap, oc: globalThis.OffscreenCanvas }
  globalThis.createImageBitmap = async () => ({ width: 1024, height: 768, close() {} })
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.w = w; this.h = h }
    getContext() { return { drawImage() {} } }
    async convertToBlob() { const b = fakeWebp(this.w, this.h); return { type: 'image/webp', arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } }
  }
  return () => { globalThis.createImageBitmap = saved.cib; globalThis.OffscreenCanvas = saved.oc }
}

async function runScreen({ writeEnabled }) {
  screenEnv ??= await startVaultScreenEnv({ previewIndexTilesStub: true })
  const env = screenEnv
  const t = makeT('en')
  const blobId = 'BF1'.padEnd(22, 'B')
  const kek = await (await env.load('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
  const fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id: blobId }] })
  const backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true, mediaPreviewEnabled: true, previewIndexReadEnabled: true, previewIndexWriteEnabled: writeEnabled } })
  backend.tree.protocolState = 'TREE_V1'
  backend.state['/api/vault'] = { loading: false, data: { configured: true, blobs: [serverBlobV2({ id: blobId, name: 'photo.jpg', type: 'image/jpeg', plainSize: 4096 })] }, error: null }
  backend.indexTile = async () => null // index miss → the existing original path renders the tile
  backend.downloadImpl = async ({ blob, sink }) => {
    backend.requests.push({ path: `/api/vault/blobs/${blob.id}/chunks/0`, method: 'GET_BYTES' })
    await sink.write(fakeJpeg(1024, 768, 4000))
    return { ok: true, chunksRead: 1, bytesWritten: 1, result: await sink.close() }
  }
  backend.previewIndexLog = []
  const inner = backend.respond
  backend.respond = async (req) => {
    const p = String(req.path)
    if (p.startsWith(PI)) {
      backend.previewIndexLog.push(`${req.method} ${p}`)
      if (p === `${PI}/head` && req.method === 'GET') return { ok: false, status: 404, data: { code: 'PREVIEW_INDEX_NOT_FOUND' }, errorKind: 'server' }
      if (p === `${PI}/head` && req.method === 'POST') return { ok: true, status: 200, data: { indexGeneration: 1, rootBlobId: 'x' }, errorKind: null }
      return { ok: true, status: 200, data: { blobs: [] }, errorKind: null }
    }
    if (p.startsWith('/api/vault/tree/') && !p.startsWith('/api/vault/tree/state') && !p.startsWith('/api/vault/tree/migration')) {
      return fakeTree.fetchJson(p, { method: req.method, body: req.options?.body, signal: req.options?.signal })
    }
    return inner(req)
  }
  const innerBytes = backend.respondBytes
  backend.respondBytes = (req) => (String(req.path).startsWith('/api/vault/tree/') ? fakeTree.fetchBytes(String(req.path), { signal: req.options?.signal }) : innerBytes?.(req))
  let n = 0
  backend.uploadImpl = async ({ routeBase }) => {
    backend.previewIndexLog.push(`UPLOAD ${routeBase}`)
    return { ok: true, stage: 'complete', blob: { id: (++n).toString(16).padStart(48, '0'), formatVersion: 2, contentIdB64: 'A'.repeat(22) + '==', size: 100 }, resume: null }
  }
  globalThis.__VAULT_BACKEND__ = backend
  const restore = installImageGlobals()
  let h
  try {
    const sync = await env.load('/src/lib/vaultTreeSync.js')
    const api = await env.load('/src/lib/vaultTreeApi.js')
    const ops = await env.load('/src/lib/vaultTreeOps.js')
    const seed = sync.createTreeSession({ kek, api })
    const start = await seed.loadHead()
    await seed.commit(ops.intents.attachBlob({ parentNodeId: start.manifest.rootNodeId, name: 'photo.jpg', mediaType: 'image/jpeg', plainSize: 4096, blobRef: { formatVersion: 2, id: blobId } }))
    h = env.mount()
    await h.render(React.createElement(env.Vault, { t }))
    await unlock(env.dom, t, CORRECT_PASSPHRASE)
    for (let i = 0; i < 16; i++) await settle()
    return {
      tile: Boolean(env.dom.window.document.querySelector('[data-testid="vault-tree-tile-poster"]')),
      originalReads: backend.requests.filter((r) => String(r.path).includes(`/api/vault/blobs/${blobId}/`)).length,
      previewIndexLog: backend.previewIndexLog,
      sessions: backend.requests.filter((r) => String(r.path).includes('/preview-sessions')).length,
    }
  } finally {
    await h?.unmount()
    restore()
  }
}

test('PIB-SCREEN-1 original-path tile is backfilled with ZERO extra original reads (writer ON vs OFF)', async () => {
  const off = await runScreen({ writeEnabled: false })
  const on = await runScreen({ writeEnabled: true })
  assert.equal(off.tile, true, 'the original path renders the tile (writer OFF)')
  assert.equal(on.tile, true, 'the original path renders the tile (writer ON)')
  assert.ok(off.originalReads >= 1)
  assert.equal(on.originalReads, off.originalReads, 'NO_EXTRA_ORIGINAL_FETCH: identical original I/O')
  assert.equal(on.sessions, off.sessions)
  assert.equal(off.previewIndexLog.filter((l) => !l.startsWith('GET')).length, 0, 'writer OFF: no preview-index mutation')
  assert.ok(on.previewIndexLog.some((l) => l.startsWith(`UPLOAD ${PI}/uploads`)), 'writer ON: the tile bytes were sealed as a derivative')
  assert.ok(on.previewIndexLog.includes(`POST ${PI}/head`), 'writer ON: committed through the index CAS')
})
