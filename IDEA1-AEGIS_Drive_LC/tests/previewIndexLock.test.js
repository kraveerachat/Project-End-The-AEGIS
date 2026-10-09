// tests/previewIndexLock.test.js — D-1 PR-D · Task F.4 · lock / logout / pagehide cleanup
//
// For every purge reason, while work is in flight at each D-1 stage (index head fetch, shard fetch, derivative read,
// generation, derivative upload, CAS): every controller aborts, reader caches/LRU are cleared, writer/backfill/upload
// queues are emptied, object URLs are revoked, no CAS is applied after the purge, an uncommitted upload is never
// committed, purge completes even when another disposer throws, and browser storage is never touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createUnlockedVaultState, PURGE_REASONS } from '../src/lib/vaultUnlockedState.js'
import { createPreviewIndexTiles } from '../src/lib/vaultPreviewIndexTiles.js'
import { createPreviewIndexWriter } from '../src/lib/vaultPreviewIndexWriter.js'
import { createDerivativeBackfill } from '../src/lib/vaultDerivativeBackfill.js'
import { createUploadDerivativeQueue } from '../src/lib/vaultDerivativeGenerate.js'
import * as treeApi from '../src/lib/vaultTreeApi.js'
import { fakeJpeg, fileNode, newKek, id22, TREE_ID } from './helpers/previewIndexFixture.mjs'
import { createWriterFakeServer, PI } from './helpers/previewIndexWriterFakeServer.mjs'
import { installStorageGuards } from './helpers/vaultTreeFixtures.mjs'

const ROOT = 'R'.repeat(22)
const hex48 = () => randomBytes(24).toString('hex')
const flushMicro = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }
const job = (n, kind = 'thumb') => ({ nodeId: n.nodeId, kind, sourceBlobRef: { ...n.blobRef }, bytes: fakeJpeg(320, 240), mime: 'image/jpeg', width: 320, height: 240 })
const decodeImage = async () => ({ width: 320, height: 240, close() {} })

/** one gate: the first matching request (or step) waits until the test releases it */
function makeGate() {
  const g = { armed: null, reached: null, release: null, signal: null, seen: [] }
  g.arm = (match) => {
    g.armed = match
    const reached = new Promise((r) => { g.reached = r })
    const released = new Promise((r) => { g.release = r })
    g.wait = async (key, signal) => { g.seen.push(key); if (g.armed && g.armed(key)) { g.armed = null; g.signal = signal ?? null; g.reached(); await released } }
    // a gate that is never reached fails the test fast instead of hanging the file
    return Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error(`gate never reached; saw: ${g.seen.join(' | ')}`)), 5000).unref?.())])
  }
  g.wait = async (key) => { g.seen.push(key) }
  return g
}

async function world() {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const nodes = new Map([[ROOT, { nodeId: ROOT, kind: 'folder', parentNodeId: null, name: '', createdAtClient: 1, modifiedAtClient: 1, lifecycle: { state: 'active' } }]])
  const add = () => { const id = id22(); nodes.set(id, fileNode(id, hex48())); return nodes.get(id) }
  const indexed = add(), fresh = add(), other = add()
  const head = { treeId: TREE_ID, generation: 1, index: { nodes, rootNodeId: ROOT, limits: { maxDepth: 64 } } }
  // a previous session already wrote one thumb, so reads have a real root, shard and derivative
  const prior = createPreviewIndexWriter({ kek, transport: server.transport, getMainHead: async () => head, writeAllowed: () => true, autoFlush: false })
  prior.offer(job(indexed)); await prior.flush()
  assert.equal(server.state.head.indexGeneration, 1)

  const gate = makeGate()
  const transport = {
    fetchJson: async (p, o = {}) => { await gate.wait(`json ${o.method ?? 'GET'} ${p}`, o.signal); return server.transport.fetchJson(p, o) },
    sendUpload: async (p, o = {}) => { await gate.wait(`put ${p}`, o.signal); return server.transport.sendUpload(p, o) },
    fetchBytes: async (p, o = {}) => { await gate.wait(`bytes ${p}`, o.signal); return server.transport.fetchBytes(p, o) },
  }
  const revoked = []
  const unlockedState = createUnlockedVaultState({ revokeObjectUrl: (u) => revoked.push(u), closeAllPreviewSessions: () => {} })
  const api = {
    getPreviewIndexHead: (o) => treeApi.getPreviewIndexHead({ ...(o ?? {}), fetchJson: transport.fetchJson }),
    getPreviewIndexEnvelopes: (ids, o) => treeApi.getPreviewIndexEnvelopes(ids, { ...(o ?? {}), fetchJson: transport.fetchJson }),
  }
  const tiles = createPreviewIndexTiles({ kek, unlockedState, api, fetchBytes: transport.fetchBytes, decodeImage })
  const writer = createPreviewIndexWriter({ kek, transport, getMainHead: async () => head, unlockedState, writeAllowed: () => true, autoFlush: false })
  const backfill = createDerivativeBackfill({ writer, unlockedState, isDeferred: () => true, retryMs: 5 })
  const created = []
  const queue = createUploadDerivativeQueue({
    writer, unlockedState,
    generateThumb: async (f, o) => { await gate.wait('generate', o.signal); return { bytes: fakeJpeg(), mime: 'image/jpeg', width: 320, height: 240 } },
    generatePoster: async (f, o) => { const u = `blob:local/${created.length}`; created.push(u); o.registerObjectUrl(u); await gate.wait('generate', o.signal); return null },
  })
  return { kek, server, head, indexed, fresh, other, gate, unlockedState, tiles, writer, backfill, queue, revoked, created }
}

const STAGES = {
  'index head fetch': async (w) => { const reached = w.gate.arm((k) => k === `json GET ${PI}/head`); const done = w.tiles.load(w.head); await reached; return { done } },
  'shard fetch': async (w) => {
    await w.tiles.load(w.head)
    const shardIds = new Set(w.server.generations[0].attach.slice(1, -1))
    const reached = w.gate.arm((k) => k.startsWith('bytes ') && [...shardIds].some((id) => k.includes(id)))
    const done = w.tiles.tryTile(w.indexed, 'image'); await reached; return { done }
  },
  'derivative read': async (w) => {
    await w.tiles.load(w.head)
    const derivId = w.server.generations[0].attach[0]
    const reached = w.gate.arm((k) => k === `bytes /api/vault/blobs/${derivId}/chunks/0`)
    const done = w.tiles.tryTile(w.indexed, 'image'); await reached; return { done }
  },
  generation: async (w) => {
    w.queue.afterUpload({ file: new File([new Uint8Array(4)], 'v.mp4', { type: 'video/mp4' }), nodeId: w.other.nodeId, sourceBlobRef: w.other.blobRef, kind: 'poster' })
    const reached = w.gate.arm((k) => k === 'generate')
    w.queue.afterUpload({ file: new File([new Uint8Array(4)], 'a.jpg', { type: 'image/jpeg' }), nodeId: w.fresh.nodeId, sourceBlobRef: w.fresh.blobRef, kind: 'thumb' })
    await reached; return { done: null }
  },
  'derivative upload': async (w) => {
    w.writer.offer(job(w.fresh)); w.writer.offer(job(w.other))
    const reached = w.gate.arm((k) => k.startsWith(`put ${PI}/uploads/`))
    const done = w.writer.flush(); await reached; return { done }
  },
  CAS: async (w) => {
    w.writer.offer(job(w.fresh))
    const reached = w.gate.arm((k) => k === `json POST ${PI}/head`)
    const done = w.writer.flush(); await reached; return { done }
  },
}

for (const reason of Object.values(PURGE_REASONS)) {
  for (const [stage, start] of Object.entries(STAGES)) {
    test(`PIL-1 ${reason} during ${stage}: everything aborts, clears and stays cleared`, async () => {
      const guards = installStorageGuards(globalThis)
      const w = await world()
      w.backfill.offerTileResult(w.other, 'thumb', { bytes: fakeJpeg(), width: 320, height: 240 }) // held (deferred)
      const generationBefore = w.server.state.head.indexGeneration
      const { done: inflight } = await start(w) // the work is now parked mid-flight at this stage
      const commitsBefore = w.server.log.filter((r) => /\/commit$/.test(r.path)).length
      const report = w.unlockedState.purge(reason)
      assert.equal(w.gate.signal?.aborted ?? true, true, 'the in-flight request/step was aborted')
      assert.ok(report.abortedFetches >= 1)
      const s = w.tiles.stats()
      assert.deepEqual({ shards: s.shards, envelopes: s.envelopes, ciphertextBytes: s.ciphertextBytes, inflight: s.inflight }, { shards: 0, envelopes: 0, ciphertextBytes: 0, inflight: 0 })
      assert.equal(w.writer.stats().queued, 0)
      assert.equal(w.backfill.stats().pending, 0)
      assert.equal(w.queue.stats().pending, 0)
      for (const u of w.created) assert.ok(w.revoked.includes(u), 'every generation object URL revoked')
      const logAtPurge = w.server.log.length
      w.gate.release?.()
      await inflight?.catch?.(() => {})
      await flushMicro()
      assert.ok(w.server.log.length <= logAtPurge + 1, 'at most the request that was already on the wire')
      assert.equal(w.server.state.head.indexGeneration, generationBefore, 'no CAS applied after purge')
      assert.equal(w.server.log.filter((r) => /\/commit$/.test(r.path)).length, commitsBefore, 'an uncommitted upload is never committed')
      assert.equal(w.writer.offer(job(w.fresh, 'poster')), 'DISABLED')
      assert.equal(w.backfill.offerTileResult(w.fresh, 'poster', { bytes: fakeJpeg(), width: 320, height: 240 }), 'SKIPPED')
      assert.equal(await w.tiles.tryTile(w.indexed, 'image'), null)
      assert.deepEqual(guards, { reads: 0, writes: 0 }, 'no browser storage touched')
    })
  }
}

test('PIL-2 the purge reaches locked state even when one disposer throws', async () => {
  const w = await world()
  w.unlockedState.registerDisposer(() => { throw new Error('a broken disposer') })
  w.writer.offer(job(w.fresh))
  w.backfill.offerTileResult(w.other, 'thumb', { bytes: fakeJpeg(), width: 320, height: 240 })
  await w.tiles.load(w.head)
  const report = w.unlockedState.purge('MANUAL_LOCK')
  assert.equal(w.unlockedState.isPurged(), true)
  assert.ok(report.disposers >= 4, 'the other disposers still ran')
  assert.equal(w.writer.stats().queued, 0)
  assert.equal(w.backfill.stats().pending, 0)
  assert.equal(w.tiles.stats().status, 'CLEARED')
})
