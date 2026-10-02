// tests/previewIndexWriter.test.js — D-1 PR-D · Task E.2 · writer core
//
// derivative upload → read latest head/root + main head → merge (applyUpserts/planSplit) → seal shards + root →
// independent index CAS → bounded retry. Real codec, real V2 envelopes, real client CAS wrapper; the server is the
// in-memory fake that mirrors the PR-C contract (tests/helpers/previewIndexWriterFakeServer.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { createPreviewIndexWriter, WRITER_OFFER, validateDerivativeJob } from '../src/lib/vaultPreviewIndexWriter.js'
import { createPreviewIndexReader } from '../src/lib/vaultPreviewIndexReader.js'
import { readDerivative } from '../src/lib/vaultDerivativeRead.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'
import { routingBits, prefixOf } from '../src/lib/vaultPreviewIndexRouting.js'
import { PREVIEW_INDEX_LIMITS, INDEX_ROOT_MARKER, INDEX_SHARD_MARKER } from '../src/lib/vaultPreviewIndexConstants.js'
import * as treeApi from '../src/lib/vaultTreeApi.js'
import { fakeJpeg, fakeWebp, fileNode, newKek, id22, TREE_ID } from './helpers/previewIndexFixture.mjs'
import { createWriterFakeServer, PI } from './helpers/previewIndexWriterFakeServer.mjs'

const hex48 = () => randomBytes(24).toString('hex')
const ROOT = 'R'.repeat(22)

function mainHead(count = 0) {
  const nodes = new Map([[ROOT, { nodeId: ROOT, kind: 'folder', parentNodeId: null, name: '', createdAtClient: 1, modifiedAtClient: 1, lifecycle: { state: 'active' } }]])
  const head = { treeId: TREE_ID, generation: 1, index: { nodes, rootNodeId: ROOT, limits: { maxDepth: 64 } } }
  head.add = (nodeId = id22()) => { nodes.set(nodeId, fileNode(nodeId, hex48())); return nodes.get(nodeId) }
  for (let i = 0; i < count; i++) head.add()
  head.files = () => [...nodes.values()].filter((n) => n.kind === 'file')
  return head
}

const jobFor = (node, kind = 'thumb', o = {}) => {
  const bytes = o.webp ? fakeWebp(o.w ?? 320, o.h ?? 240) : fakeJpeg(o.w ?? 320, o.h ?? 240)
  return { nodeId: node.nodeId, kind, sourceBlobRef: { ...node.blobRef }, bytes, mime: o.webp ? 'image/webp' : 'image/jpeg', width: o.w ?? 320, height: o.h ?? 240 }
}

function boundApi(server) {
  const o = (x) => ({ ...(x ?? {}), fetchJson: server.transport.fetchJson })
  return {
    getPreviewIndexHead: (x) => treeApi.getPreviewIndexHead(o(x)),
    getPreviewIndexEnvelopes: (ids, x) => treeApi.getPreviewIndexEnvelopes(ids, o(x)),
    casPreviewIndexHead: (body, x) => treeApi.casPreviewIndexHead(body, o(x)),
  }
}

async function makeWriter({ server, head, kek, unlockedState = null, limits = PREVIEW_INDEX_LIMITS, diagnostics = null }) {
  return createPreviewIndexWriter({
    kek, transport: server.transport, getMainHead: async () => head, unlockedState, limits, diagnostics,
    writeAllowed: () => true, autoFlush: false,
  })
}

/** a fresh reader (as a later page session would build) */
async function readBack({ server, head, kek }) {
  const reader = createPreviewIndexReader({ kek, api: boundApi(server), fetchBytes: server.transport.fetchBytes })
  const st = await reader.load(head)
  return { reader, st }
}

const decodeImage = async (blob) => {
  const b = new Uint8Array(await blob.arrayBuffer())
  if (b[0] === 0xff) return { width: (b[9] << 8) | b[10], height: (b[7] << 8) | b[8], close() {} }
  return { width: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1, height: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1, close() {} }
}

/** node ids whose routing prefixes (initialPrefixBits) are equal (same=true) or different */
async function nodeIdsWithPrefix(same) {
  const a = id22()
  const pa = prefixOf(await routingBits(a), PREVIEW_INDEX_LIMITS.initialPrefixBits)
  for (;;) {
    const b = id22()
    const pb = prefixOf(await routingBits(b), PREVIEW_INDEX_LIMITS.initialPrefixBits)
    if ((pa === pb) === same) return [a, b]
  }
}

test('PIW-1 happy path from an empty index: generation 0 → 1, entries readable through a fresh reader', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(3)
  const [a, b, c] = head.files()
  const w = await makeWriter({ server, head, kek })
  assert.equal(w.offer(jobFor(a, 'thumb')), WRITER_OFFER.QUEUED)
  assert.equal(w.offer(jobFor(b, 'thumb', { webp: true })), WRITER_OFFER.QUEUED)
  assert.equal(w.offer(jobFor(c, 'poster')), WRITER_OFFER.QUEUED)
  const r = await w.flush()
  assert.deepEqual(r, { committed: 3, dropped: 0, failed: 0, budgetExhausted: false })
  assert.equal(server.state.head.indexGeneration, 1)
  assert.equal(server.casPosts().length, 1)
  const body = server.casPosts()[0].body
  assert.equal(body.expectedGeneration, 0)
  assert.equal(body.expectedRootBlobId, null)
  assert.deepEqual(body.supersededBlobIds, [])
  assert.ok(body.attachBlobIds.includes(body.rootBlobId))
  assert.ok(/^[A-Za-z0-9_-]{22}$/.test(body.idempotencyKey))
  for (const id of body.attachBlobIds) assert.equal(server.lifecycle.get(id), 'INDEX_MANAGED')

  const { reader, st } = await readBack({ server, head, kek })
  assert.equal(st.status, 'READY')
  for (const [node, kind, mime] of [[a, 'thumb', 'image/jpeg'], [b, 'thumb', 'image/webp'], [c, 'poster', 'image/jpeg']]) {
    const entry = await reader.lookup(node, kind)
    assert.ok(entry, `${kind} entry present`)
    assert.equal(entry.profile, 'vp1')
    assert.equal(entry.mime, mime)
    assert.deepEqual(entry.sourceBlobRef, node.blobRef)
    const d = await readDerivative({ kek, entry, envelopeOf: reader.envelopeOf, fetchBytes: server.transport.fetchBytes, decodeImage })
    assert.equal(d.ok, true, d.reason)
  }
  assert.equal(w.stats().committed, 3)
})

test('PIW-2 a second batch builds on the first (generation 2, prior shard/root declared superseded, prior entries kept)', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(2)
  const [a, b] = head.files()
  const w = await makeWriter({ server, head, kek })
  w.offer(jobFor(a)); await w.flush()
  const firstRoot = server.state.head.rootBlobRef.id
  w.offer(jobFor(b, 'poster')); await w.flush()
  assert.equal(server.state.head.indexGeneration, 2)
  const body = server.casPosts()[1].body
  assert.equal(body.expectedGeneration, 1)
  assert.equal(body.expectedRootBlobId, firstRoot)
  assert.ok(body.supersededBlobIds.includes(firstRoot), 'old root is advisory-superseded')
  assert.equal(server.lifecycle.get(firstRoot), 'INDEX_MANAGED', 'superseded refs never change lifecycle')
  const { reader } = await readBack({ server, head, kek })
  assert.ok(await reader.lookup(a, 'thumb'))
  assert.ok(await reader.lookup(b, 'poster'))
})

for (const same of [true, false]) {
  test(`PIW-3 disjoint concurrent writers both land after rebase (${same ? 'same shard' : 'different shards'})`, async () => {
    const kek = await newKek()
    const server = createWriterFakeServer()
    const head = mainHead(0)
    const [ida, idb] = await nodeIdsWithPrefix(same)
    const a = head.add(ida), b = head.add(idb)
    const wa = await makeWriter({ server, head, kek })
    const wb = await makeWriter({ server, head, kek })
    let fired = false
    server.hooks.beforeCas = async () => {
      if (fired) return
      fired = true
      wb.offer(jobFor(b, 'thumb'))
      const rb = await wb.flush()
      assert.equal(rb.committed, 1)
    }
    wa.offer(jobFor(a, 'thumb'))
    const ra = await wa.flush()
    assert.deepEqual(ra, { committed: 1, dropped: 0, failed: 0, budgetExhausted: false })
    assert.equal(server.state.head.indexGeneration, 2)
    assert.ok(wa.stats().casConflicts >= 1)
    const { reader } = await readBack({ server, head, kek })
    assert.ok(await reader.lookup(a, 'thumb'), 'writer A entry')
    assert.ok(await reader.lookup(b, 'thumb'), 'writer B entry survives A’s rebase (no last-writer-wins)')
  })
}

test('PIW-4 same node/kind race keeps exactly one valid entry; the loser derivative stays INDEX_STAGED (not deleted)', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(1)
  const [a] = head.files()
  const wa = await makeWriter({ server, head, kek })
  const wb = await makeWriter({ server, head, kek })
  let fired = false
  server.hooks.beforeCas = async () => { if (!fired) { fired = true; wb.offer(jobFor(a, 'thumb', { w: 200, h: 100 })); await wb.flush() } }
  wa.offer(jobFor(a, 'thumb'))
  const ra = await wa.flush()
  assert.equal(ra.committed, 0)
  assert.equal(ra.dropped, 1)
  assert.equal(wa.stats().dropped.EXISTING_VALID, 1)
  const { reader } = await readBack({ server, head, kek })
  const entry = await reader.lookup(a, 'thumb')
  assert.equal(entry.width, 200, 'the entry that won first is kept')
  const staged = [...server.lifecycle].filter(([, l]) => l === 'INDEX_STAGED')
  assert.ok(staged.length >= 1, 'the losing derivative remains as a staged (classified, not deleted) blob')
  assert.equal(server.log.filter((r) => r.method === 'DELETE').length, 0)
})

test('PIW-5 main manifest changes the node blobRef between derivative upload and CAS → entry dropped STALE_SOURCE', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(2)
  const [a, b] = head.files()
  const w = await makeWriter({ server, head, kek })
  w.offer(jobFor(a)); w.offer(jobFor(b))
  let n = 0
  server.hooks.afterCommit = async () => { if (++n === 1) a.blobRef = { formatVersion: 2, id: hex48() } } // a replaced while uploading
  const r = await w.flush()
  assert.equal(r.committed, 1)
  assert.equal(r.dropped, 1)
  assert.equal(w.stats().dropped.STALE_SOURCE, 1)
  const { reader } = await readBack({ server, head, kek })
  assert.equal(await reader.lookup(a, 'thumb'), null)
  assert.ok(await reader.lookup(b, 'thumb'))
  const attached = new Set(server.casPosts()[0].body.attachBlobIds)
  const stagedDeriv = [...server.lifecycle].filter(([id, l]) => l === 'INDEX_STAGED' && !attached.has(id))
  assert.equal(stagedDeriv.length, 1, 'the stale derivative is left INDEX_STAGED, never attached, never deleted')
})

test('PIW-6 a job for a node already stale/missing before upload is dropped without uploading anything', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(1)
  const [a] = head.files()
  const w = await makeWriter({ server, head, kek })
  w.offer({ ...jobFor(a), sourceBlobRef: { formatVersion: 2, id: hex48() } })
  w.offer(jobFor({ nodeId: id22(), blobRef: { formatVersion: 2, id: hex48() } }))
  const r = await w.flush()
  assert.deepEqual(r, { committed: 0, dropped: 2, failed: 0, budgetExhausted: false })
  assert.equal(server.uploadCalls(), 0)
  assert.equal(server.casPosts().length, 0)
  assert.equal(w.stats().dropped.STALE_SOURCE, 1)
  assert.equal(w.stats().dropped.NODE_MISSING, 1)
})

test('PIW-7 shard overflow skips the job (counter), never truncates, never throws, no CAS', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(1)
  const [a] = head.files()
  const limits = Object.freeze({ ...PREVIEW_INDEX_LIMITS, maxShardDecodedBytes: 64, maxPrefixBits: 6 })
  const w = await makeWriter({ server, head, kek, limits })
  w.offer(jobFor(a))
  const r = await w.flush()
  assert.deepEqual(r, { committed: 0, dropped: 1, failed: 0, budgetExhausted: false })
  assert.equal(w.stats().dropped.OVERFLOW, 1)
  assert.equal(server.casPosts().length, 0)
})

test('PIW-8 conflict exhaustion fails soft after casMaxAttempts (counters, no exception)', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(1)
  const [a] = head.files()
  const other = await makeWriter({ server, head, kek })
  const w = await makeWriter({ server, head, kek })
  let inHook = false
  server.hooks.beforeCas = async () => {
    if (inHook) return
    inHook = true
    try { other.offer(jobFor(head.add(), 'thumb')); await other.flush() } finally { inHook = false }
  }
  w.offer(jobFor(a))
  const r = await w.flush()
  assert.equal(r.committed, 0)
  assert.equal(r.failed, 1)
  assert.equal(w.stats().casAttempts, PREVIEW_INDEX_LIMITS.casMaxAttempts)
  assert.equal(w.stats().casConflicts, PREVIEW_INDEX_LIMITS.casMaxAttempts)
  assert.equal(w.stats().failedReasons.CONFLICT_EXHAUSTED, 1)
})

test('PIW-9 lost CAS response: identical body + key resent once (replay); second loss → head refetch confirms', async () => {
  for (const drops of [1, 2]) {
    const kek = await newKek()
    const server = createWriterFakeServer()
    const head = mainHead(1)
    const [a] = head.files()
    const w = await makeWriter({ server, head, kek })
    server.hooks.dropCasResponses = drops
    w.offer(jobFor(a))
    const r = await w.flush()
    assert.equal(r.committed, 1, `drops=${drops}`)
    const posts = server.casPosts()
    assert.equal(posts.length, 2, 'exactly one resend')
    assert.deepEqual(posts[1].body, posts[0].body, 'identical body and idempotency key')
    assert.equal(server.state.head.indexGeneration, 1, 'replay changed nothing')
  }
})

test('PIW-10 lock/purge mid-batch: no further request, no CAS after purge, queue cleared', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(3)
  const unlockedState = createUnlockedVaultState({ closeAllPreviewSessions: () => {} })
  const w = await makeWriter({ server, head, kek, unlockedState })
  for (const n of head.files()) w.offer(jobFor(n))
  let atPurge = null
  server.hooks.afterCommit = async () => { if (atPurge === null) { unlockedState.purge('MANUAL_LOCK'); atPurge = server.log.length } }
  const r = await w.flush()
  assert.equal(r.committed, 0)
  assert.equal(server.log.length, atPurge, 'not a single request after purge')
  assert.equal(server.casPosts().length, 0)
  assert.equal(w.stats().queued, 0)
  assert.equal(w.offer(jobFor(head.files()[0])), WRITER_OFFER.DISABLED)
})

test('PIW-11 nothing outside ciphertext: no name, nodeId, MIME, prefix or marker on the wire', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(4)
  const w = await makeWriter({ server, head, kek })
  const files = head.files()
  w.offer(jobFor(files[0], 'thumb')); w.offer(jobFor(files[1], 'poster', { webp: true })); w.offer(jobFor(files[2]))
  await w.flush()
  const wire = server.wire()
  const prefixes = await Promise.all(files.map(async (n) => prefixOf(await routingBits(n.nodeId), 7)))
  const banned = [...files.map((n) => n.nodeId), 'secret.jpg', 'image/jpeg', 'image/webp', INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, '"thumb"', '"poster"', 'vp1', ...prefixes.map((p) => `"${p.slice(0, 6)}"`)]
  for (const s of banned) assert.equal(wire.includes(s), false, `wire leaks ${s}`)
  // source blob ids of the user's files are opaque server ids already known to the server, but the writer must not
  // send them either (the binding lives only inside the encrypted shard)
  for (const n of files) assert.equal(wire.includes(n.blobRef.id), false, 'source blob id leaked')
})

test('PIW-12 total requests for a single-job batch from an empty index (recorded for IDX-SIZE)', async (t) => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(1)
  const w = await makeWriter({ server, head, kek })
  w.offer(jobFor(head.files()[0]))
  await w.flush()
  const json = server.log.length
  const chunkPuts = server.t.requests.filter((r) => r.transport === 'upload').length
  const total = json + chunkPuts
  t.diagnostic(`single-job batch from empty index: ${total} requests (${json} JSON incl. head GET/CAS, ${chunkPuts} chunk PUT)`)
  // derivative + shard + root: 3 × (create + PUT + commit) = 9, + 2 head GETs (pre-filter, then the latest re-read
  // right before merging) + CAS = 12
  assert.equal(total, 12)
})

test('PIW-13 offer() validation: kind, profile bounds, MIME, magic bytes, dimensions, ids, duplicates, queue bound', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(1)
  const [a] = head.files()
  const w = await makeWriter({ server, head, kek, limits: Object.freeze({ ...PREVIEW_INDEX_LIMITS, writeQueueMax: 2 }) })
  const bad = [
    { ...jobFor(a), kind: 'motion' },
    { ...jobFor(a), kind: 'proxy' },
    { ...jobFor(a), mime: 'image/png' },
    { ...jobFor(a), mime: 'image/webp' }, // JPEG bytes declared WebP
    { ...jobFor(a), bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), mime: 'image/jpeg' },
    { ...jobFor(a), width: 321 }, // declared dims ≠ encoded dims
    jobFor(a, 'thumb', { w: 1024, h: 200 }), // > vp1 long edge
    { ...jobFor(a), bytes: new Uint8Array([...fakeJpeg(), ...new Uint8Array(256 * 1024)]) }, // > vp1 plainSize
    { ...jobFor(a), nodeId: 'short' },
    { ...jobFor(a), sourceBlobRef: { formatVersion: 3, id: 'x' } },
    null,
  ]
  for (const j of bad) assert.equal(w.offer(j), WRITER_OFFER.REJECTED, JSON.stringify(j && { kind: j.kind, mime: j.mime, width: j.width }))
  assert.equal(validateDerivativeJob(jobFor(a)).ok, true)
  assert.equal(w.offer(jobFor(a)), WRITER_OFFER.QUEUED)
  assert.equal(w.offer(jobFor(a)), WRITER_OFFER.REJECTED, 'same (node, kind, source) is offered once per session')
  assert.equal(w.offer(jobFor(a, 'poster')), WRITER_OFFER.QUEUED)
  assert.equal(w.offer(jobFor(head.add())), WRITER_OFFER.FULL)
  assert.equal(server.log.length, 0, 'offer() itself never touches the network')
})

test('PIW-14 offered bytes are copied (caller may zero its buffer) and zeroed by the writer after use', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(1)
  const [a] = head.files()
  const w = await makeWriter({ server, head, kek })
  const job = jobFor(a)
  w.offer(job)
  job.bytes.fill(0) // the tile scheduler releases its poster buffer
  const r = await w.flush()
  assert.equal(r.committed, 1)
  const { reader } = await readBack({ server, head, kek })
  const entry = await reader.lookup(a, 'thumb')
  const d = await readDerivative({ kek, entry, envelopeOf: reader.envelopeOf, fetchBytes: server.transport.fetchBytes, decodeImage })
  assert.equal(d.ok, true, 'the derivative holds the original (copied) bytes')
})

test('PIW-15 server answers PREVIEW_INDEX_WRITE_DISABLED → writer stops for the session (fail-soft)', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer({ writeEnabled: false })
  const head = mainHead(2)
  const [a, b] = head.files()
  const w = await makeWriter({ server, head, kek })
  w.offer(jobFor(a))
  const r = await w.flush()
  assert.equal(r.committed, 0)
  assert.equal(r.failed, 1)
  const before = server.log.length
  assert.equal(w.offer(jobFor(b)), WRITER_OFFER.DISABLED)
  assert.deepEqual(await w.flush(), { committed: 0, dropped: 0, failed: 0, budgetExhausted: false })
  assert.equal(server.log.length, before)
})

test('PIW-16 attach list = applied derivatives + new shards + root; superseded = replaced shard + old root only', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(0)
  const [ida, idb] = await nodeIdsWithPrefix(true)
  const a = head.add(ida), b = head.add(idb)
  const w = await makeWriter({ server, head, kek })
  w.offer(jobFor(a)); await w.flush()
  const g1 = server.casPosts()[0].body
  assert.equal(g1.attachBlobIds.length, 3, 'derivative + shard + root')
  w.offer(jobFor(b)); await w.flush()
  const g2 = server.casPosts()[1].body
  assert.equal(g2.attachBlobIds.length, 3)
  const [, oldShard] = g1.attachBlobIds // order: derivatives, shards, root
  assert.deepEqual([...g2.supersededBlobIds].sort(), [g1.rootBlobId, oldShard].sort())
})

test('PIW-17 a transport that THROWS (no HTTP status) on CAS is treated as possible loss: identical resend', async () => {
  const kek = await newKek()
  const server = createWriterFakeServer()
  const head = mainHead(1)
  const [a] = head.files()
  const inner = server.transport.fetchJson
  let thrown = 0
  const transport = { ...server.transport, fetchJson: async (p, o = {}) => {
    const r = await inner(p, o)
    if (p === `${PI}/head` && o.method === 'POST' && thrown++ === 0) throw new TypeError('Failed to fetch') // applied, response lost
    return r
  } }
  const w = createPreviewIndexWriter({ kek, transport, getMainHead: async () => head, writeAllowed: () => true, autoFlush: false })
  w.offer(jobFor(a))
  const r = await w.flush()
  assert.equal(r.committed, 1)
  const posts = server.casPosts()
  assert.equal(posts.length, 2)
  assert.deepEqual(posts[1].body, posts[0].body)
  assert.equal(server.state.head.indexGeneration, 1)
})
