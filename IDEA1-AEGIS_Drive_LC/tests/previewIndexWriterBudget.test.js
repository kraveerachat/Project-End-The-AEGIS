// tests/previewIndexWriterBudget.test.js — D-1 PR-D · Task E.4 · writer fail-soft on storage-budget exhaustion
//
// The server (PR-C, C.7) answers 507 PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED on preview-index upload create/commit once
// the owner's retained INDEX_STAGED + INDEX_MANAGED ciphertext would exceed the budget. The writer must stop preview
// persistence for the unlocked session without throwing, without a partial CAS and without deleting anything.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createPreviewIndexWriter, WRITER_OFFER } from '../src/lib/vaultPreviewIndexWriter.js'
import { createPreviewIndexReader } from '../src/lib/vaultPreviewIndexReader.js'
import { PREVIEW_INDEX_LIMITS } from '../src/lib/vaultPreviewIndexConstants.js'
import * as treeApi from '../src/lib/vaultTreeApi.js'
import { fakeJpeg, fileNode, newKek, id22, TREE_ID } from './helpers/previewIndexFixture.mjs'
import { createWriterFakeServer, PI } from './helpers/previewIndexWriterFakeServer.mjs'

const ROOT = 'R'.repeat(22)
const hex48 = () => randomBytes(24).toString('hex')
function mainHead(count) {
  const nodes = new Map([[ROOT, { nodeId: ROOT, kind: 'folder', parentNodeId: null, name: '', createdAtClient: 1, modifiedAtClient: 1, lifecycle: { state: 'active' } }]])
  for (let i = 0; i < count; i++) { const id = id22(); nodes.set(id, fileNode(id, hex48())) }
  return { treeId: TREE_ID, generation: 1, index: { nodes, rootNodeId: ROOT, limits: { maxDepth: 64 } }, files: () => [...nodes.values()].filter((n) => n.kind === 'file') }
}
const jobFor = (n, kind = 'thumb') => ({ nodeId: n.nodeId, kind, sourceBlobRef: { ...n.blobRef }, bytes: fakeJpeg(320, 240), mime: 'image/jpeg', width: 320, height: 240 })

function setup({ server, head, kek, maxEntriesPerCas = 1 }) {
  const names = []
  let notified = 0
  const w = createPreviewIndexWriter({
    kek, transport: server.transport, getMainHead: async () => head, writeAllowed: () => true, autoFlush: false,
    limits: Object.freeze({ ...PREVIEW_INDEX_LIMITS, maxEntriesPerCas }),
    diagnostics: { count: (n) => names.push(n) }, onBudgetExhausted: () => { notified++ },
  })
  return { w, names, notified: () => notified }
}

const mutating = (server) => server.log.filter((r) => r.method !== 'GET').length + server.t.requests.filter((r) => r.transport === 'upload').length

for (const [label, arm] of [
  ['derivative create', (s) => { s.hooks.budgetAtCreate = (n) => n === 1 }],
  ['shard create', (s) => { s.hooks.budgetAtCreate = (n) => n === 2 }],
  ['root create', (s) => { s.hooks.budgetAtCreate = (n) => n === 3 }],
  ['commit', (s) => { s.hooks.budgetAtCommit = (n) => n === 1 }],
]) {
  test(`PIWB-1 507 at ${label}: batch ends budgetExhausted, breaker latches, queue cleared, no CAS, nothing deleted`, async () => {
    const kek = await newKek()
    const server = createWriterFakeServer()
    arm(server)
    const head = mainHead(3)
    const { w, names, notified } = setup({ server, head, kek })
    for (const n of head.files()) assert.equal(w.offer(jobFor(n)), WRITER_OFFER.QUEUED)
    let r
    await assert.doesNotReject(async () => { r = await w.flush() })
    assert.equal(r.budgetExhausted, true)
    assert.equal(r.committed, 0)
    assert.equal(w.stats().queued, 0, 'queued jobs cleared')
    assert.equal(w.stats().budgetExhausted, true)
    assert.equal(notified(), 1, 'listeners (backfill) told once')
    assert.equal(server.casPosts().length, 0, 'no CAS with a partial attach list')
    assert.equal(server.log.filter((x) => x.method === 'DELETE').length, 0, 'no DELETE/cancel of anything')
    assert.equal(server.t.requests.filter((x) => x.method === 'DELETE').length, 0)
    const before = server.log.length + server.t.requests.length
    for (const n of head.files()) assert.equal(w.offer(jobFor(n, 'poster')), WRITER_OFFER.BUDGET_EXHAUSTED)
    assert.deepEqual(await w.flush(), { committed: 0, dropped: 0, failed: 0, budgetExhausted: true })
    assert.equal(server.log.length + server.t.requests.length, before, 'zero requests after the breaker latched')
    assert.ok(names.includes('writer.BUDGET_EXHAUSTED'))
    for (const name of names) assert.match(name, /^[a-z]+(\.[A-Za-z_]+)+$/, 'counter names only — no ids, sizes or names')
  })
}

test('PIWB-2 committed index objects survive exhaustion and stay readable (tiles keep using existing entries)', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(2)
  const [a, b] = head.files()
  const { w } = setup({ server, head, kek })
  w.offer(jobFor(a))
  assert.equal((await w.flush()).committed, 1)
  const managed = [...server.lifecycle].filter(([, l]) => l === 'INDEX_MANAGED').map(([id]) => id)
  server.state.budgetBytes = server.retained() // owner now exactly at budget: any new preview byte is rejected
  w.offer(jobFor(b))
  const r = await w.flush()
  assert.equal(r.budgetExhausted, true)
  for (const id of managed) assert.equal(server.lifecycle.get(id), 'INDEX_MANAGED', 'existing index objects untouched')
  const bound = {
    getPreviewIndexHead: (o) => treeApi.getPreviewIndexHead({ ...(o ?? {}), fetchJson: server.transport.fetchJson }),
    getPreviewIndexEnvelopes: (ids, o) => treeApi.getPreviewIndexEnvelopes(ids, { ...(o ?? {}), fetchJson: server.transport.fetchJson }),
  }
  const reader = createPreviewIndexReader({ kek, api: bound, fetchBytes: server.transport.fetchBytes })
  assert.equal((await reader.load(head)).status, 'READY')
  assert.ok(await reader.lookup(a, 'thumb'), 'the committed entry is still served')
  assert.equal(await reader.lookup(b, 'thumb'), null, 'the rejected one falls back to the original path')
})

test('PIWB-3 a new unlocked session resets the breaker, but the server still decides: one mutating request, then latch again', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer({ budgetBytes: 0 })
  const head = mainHead(4)
  const files = head.files()
  const s1 = setup({ server, head, kek })
  s1.w.offer(jobFor(files[0])); s1.w.offer(jobFor(files[1]))
  assert.equal((await s1.w.flush()).budgetExhausted, true)
  const s2 = setup({ server, head, kek }) // a later unlock builds a fresh writer
  const before = mutating(server)
  assert.equal(s2.w.offer(jobFor(files[2])), WRITER_OFFER.QUEUED, 'breaker is per unlocked session')
  assert.equal(s2.w.offer(jobFor(files[3])), WRITER_OFFER.QUEUED)
  assert.equal((await s2.w.flush()).budgetExhausted, true)
  assert.equal(mutating(server) - before, 1, 'exactly one preview-index mutation request (the rejected create)')
  assert.equal(s2.w.offer(jobFor(files[2], 'poster')), WRITER_OFFER.BUDGET_EXHAUSTED)
})

test('PIWB-4 budget exhaustion never reaches the main manifest or original paths (writer issues none of those requests)', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer({ budgetBytes: 0 })
  const head = mainHead(2)
  const { w } = setup({ server, head, kek, maxEntriesPerCas: 16 })
  for (const n of head.files()) w.offer(jobFor(n))
  await w.flush()
  const paths = [...server.log.map((x) => x.path), ...server.t.requests.map((x) => x.path)]
  for (const p of paths) assert.ok(p.startsWith(PI) || /^\/api\/vault\/blobs\/[0-9a-f]{48}\/chunks\/0$/.test(p), `writer touched ${p}`)
  assert.equal(paths.some((p) => p.startsWith('/api/vault/tree/head') || p.startsWith('/api/vault/tree/revisions') || p.startsWith('/api/vault/tree/uploads')), false)
})
