import test from 'node:test'
import assert from 'node:assert/strict'

import { createPreviewDiagnostics } from '../src/lib/vaultPreviewDiagnostics.js'

test('diagnostics are disabled by default and emit only allowlisted operational metrics', () => {
  const disabled = []
  createPreviewDiagnostics({ emit: (entry) => disabled.push(entry) }).record('range', { requestNumber: 1 })
  assert.deepEqual(disabled, [])

  const emitted = []
  const diagnostics = createPreviewDiagnostics({ enabled: true, emit: (entry) => emitted.push(entry) })
  diagnostics.record('range', {
    requestNumber: 7,
    requestStart: 0,
    requestEnd: 99,
    responseStart: 0,
    responseEnd: 99,
    chunkIndexes: [0, 1],
    cacheHits: 1,
    cacheMisses: 2,
    fetchDurationMs: 4,
    decryptDurationMs: 3,
    responseDurationMs: 9,
    rehydrationCount: 1,
    failureCategory: 'network',
    token: 'secret-token',
    dek: 'secret-key',
    filename: 'private.mp4',
    plaintext: 'private bytes',
    authorization: 'Bearer secret',
  })

  assert.equal(emitted.length, 1)
  const serialised = JSON.stringify(emitted[0])
  for (const secret of ['secret-token', 'secret-key', 'private.mp4', 'private bytes', 'Bearer secret']) {
    assert.equal(serialised.includes(secret), false)
  }
  assert.deepEqual(emitted[0].chunkIndexes, [0, 1])
  assert.equal(emitted[0].requestNumber, 7)
})

/* ── D-1 PR-D Task F.5 · privacy-safe preview-index counters ─────────────────────────────────────────────────── */
import { randomBytes } from 'node:crypto'
import { createPreviewIndexCounters, PREVIEW_INDEX_COUNTER_NAMES, PREVIEW_INDEX_TIMING_NAMES } from '../src/lib/vaultPreviewDiagnostics.js'
import { createPreviewIndexWriter } from '../src/lib/vaultPreviewIndexWriter.js'
import { createPreviewIndexTiles } from '../src/lib/vaultPreviewIndexTiles.js'
import { createDerivativeBackfill } from '../src/lib/vaultDerivativeBackfill.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'
import { routingBits, prefixOf } from '../src/lib/vaultPreviewIndexRouting.js'
import * as treeApi from '../src/lib/vaultTreeApi.js'
import { fakeJpeg, fileNode, newKek, id22, TREE_ID } from './helpers/previewIndexFixture.mjs'
import { createWriterFakeServer } from './helpers/previewIndexWriterFakeServer.mjs'

const ID22_RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/
const HEX48 = /[0-9a-f]{48}/

test('PID-1 counters accept allow-listed names only; anything else collapses into one "unlisted" count', () => {
  const c = createPreviewIndexCounters()
  c.count('writer.committed'); c.count('writer.committed'); c.count('derivative.HIT')
  c.count(`writer.dropped.${id22()}`); c.count('secret.jpg'); c.count({ toString: () => 'x' })
  const s = c.snapshot()
  assert.equal(s.counters['writer.committed'], 2)
  assert.equal(s.counters['derivative.HIT'], 1)
  assert.equal(s.counters.unlisted, 3)
  assert.deepEqual(Object.keys(s.counters).sort(), ['derivative.HIT', 'unlisted', 'writer.committed'])
})

test('PID-2 timings aggregate as { count, totalMs, maxMs } for allow-listed names; non-finite values ignored', () => {
  const c = createPreviewIndexCounters()
  c.timing('root.fetchMs', 12.4); c.timing('root.fetchMs', 30.6); c.timing('root.fetchMs', NaN); c.timing('nope', 5)
  assert.deepEqual(c.snapshot().timings, { 'root.fetchMs': { count: 2, totalMs: 43, maxMs: 31 } })
})

test('PID-3 every allow-listed counter/timing name is privacy-safe by shape', () => {
  assert.ok(PREVIEW_INDEX_COUNTER_NAMES.length > 40)
  for (const name of [...PREVIEW_INDEX_COUNTER_NAMES, ...PREVIEW_INDEX_TIMING_NAMES]) {
    assert.match(name, /^[a-z]+(\.[A-Za-z_]+)+$/, name)
    assert.doesNotMatch(name, ID22_RUN, name)
    assert.doesNotMatch(name, HEX48, name)
    assert.doesNotMatch(name, /image\/|video\/|[01]{6}/, name)
  }
  for (const required of ['head.READY', 'head.ABSENT', 'head.FAILED', 'derivative.HIT', 'derivative.MISS', 'derivative.INTEGRITY', 'writer.committed', 'writer.dropped.STALE_SOURCE', 'writer.failed.CONFLICT_EXHAUSTED', 'writer.BUDGET_EXHAUSTED', 'cas.attempt', 'cas.conflict', 'backfill.offered', 'backfill.skipped.SEEN']) {
    assert.ok(PREVIEW_INDEX_COUNTER_NAMES.includes(required), required)
  }
  for (const required of ['root.fetchMs', 'root.decodeMs', 'shard.fetchMs', 'shard.decodeMs']) assert.ok(PREVIEW_INDEX_TIMING_NAMES.includes(required), required)
})

test('PID-4 end to end (writer + tiles + backfill): the serialized snapshot carries no name, id, contentId, prefix or MIME', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const ROOT = 'R'.repeat(22)
  const nodes = new Map([[ROOT, { nodeId: ROOT, kind: 'folder', parentNodeId: null, name: '', createdAtClient: 1, modifiedAtClient: 1, lifecycle: { state: 'active' } }]])
  const files = Array.from({ length: 4 }, () => { const id = id22(); const n = fileNode(id, randomBytes(24).toString('hex')); nodes.set(id, n); return n })
  const head = { treeId: TREE_ID, generation: 1, index: { nodes, rootNodeId: ROOT, limits: { maxDepth: 64 } } }
  const unlockedState = createUnlockedVaultState({ closeAllPreviewSessions: () => {} })
  const c = createPreviewIndexCounters({ unlockedState })
  const writer = createPreviewIndexWriter({ kek, transport: server.transport, getMainHead: async () => head, writeAllowed: () => true, autoFlush: false, diagnostics: c, unlockedState })
  const backfill = createDerivativeBackfill({ writer, diagnostics: c, unlockedState })
  writer.offer({ nodeId: files[0].nodeId, kind: 'thumb', sourceBlobRef: files[0].blobRef, bytes: fakeJpeg(), mime: 'image/jpeg', width: 320, height: 240 })
  await writer.flush()
  backfill.offerTileResult(files[1], 'thumb', { bytes: fakeJpeg(), width: 320, height: 240 })
  backfill.offerTileResult(files[1], 'thumb', { bytes: fakeJpeg(), width: 320, height: 240 })
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0))
  await writer.flush()
  const api = {
    getPreviewIndexHead: (o) => treeApi.getPreviewIndexHead({ ...(o ?? {}), fetchJson: server.transport.fetchJson }),
    getPreviewIndexEnvelopes: (ids, o) => treeApi.getPreviewIndexEnvelopes(ids, { ...(o ?? {}), fetchJson: server.transport.fetchJson }),
  }
  const tiles = createPreviewIndexTiles({ kek, api, fetchBytes: server.transport.fetchBytes, diagnostics: c, unlockedState, decodeImage: async () => ({ width: 320, height: 240, close() {} }) })
  await tiles.load(head)
  assert.ok(await tiles.tryTile(files[0], 'image'))
  assert.equal(await tiles.tryTile(files[2], 'image'), null)
  assert.ok(await tiles.tryTile(files[1], 'image'), 'shard now cached; the next chunk GET is the derivative')
  server.t.tamperNextChunk((b) => { b[b.length - 1] ^= 1; return b })
  assert.equal(await tiles.tryTile(files[1], 'image'), null)
  const s = c.snapshot()
  for (const k of ['head.READY', 'derivative.HIT', 'derivative.MISS', 'writer.committed', 'cas.attempt', 'backfill.offered', 'backfill.skipped.SEEN']) assert.ok(s.counters[k] >= 1, k)
  assert.ok(s.counters['derivative.INTEGRITY'] >= 1)
  assert.ok(s.timings['root.fetchMs']?.count >= 1 && s.timings['shard.decodeMs']?.count >= 1)
  const json = JSON.stringify(s)
  assert.doesNotMatch(json, ID22_RUN)
  assert.doesNotMatch(json, HEX48)
  assert.doesNotMatch(json, /secret\.jpg|image\/|video\/|==/)
  for (const n of files) assert.equal(json.includes(prefixOf(await routingBits(n.nodeId), 6)), false)
  unlockedState.purge('MANUAL_LOCK')
  assert.deepEqual(c.snapshot(), { counters: {}, timings: {} }, 'counters are unlocked-session memory and die with the purge')
})
