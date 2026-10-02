// tests/previewIndexReader.test.js — AEGIS Drive (IDEA1) · D-1 PR-B Task B.7 · read-only encrypted preview-index reader
//
// head → encrypted root → only the needed shards → validated, source-bound entries. Every failure returns null
// (the caller keeps the original path). Uses the TEST-ONLY fake transport/fixture.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createPreviewIndexReader } from '../src/lib/vaultPreviewIndexReader.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'
import { encodeShard, encodeRoot } from '../src/lib/vaultPreviewIndexCodec.js'
import { sealIndexObject } from '../src/lib/vaultPreviewIndexObject.js'
import { INDEX_SHARD_MARKER, INDEX_ROOT_MARKER, PREVIEW_INDEX_LIMITS } from '../src/lib/vaultPreviewIndexConstants.js'
import { buildIndex, TREE_ID, newKek, fileNode } from './helpers/previewIndexFixture.mjs'
import { installStorageGuards } from './helpers/vaultTreeFixtures.mjs'

const reader = (fx, o = {}) => createPreviewIndexReader({ kek: fx.kek, api: fx.api, fetchBytes: fx.t.fetchBytes, ...o })

test('PIRD-1 absent / disabled index → ABSENT, no further requests; lookups null', async () => {
  const fx = await buildIndex({ files: 2 })
  fx.api.getPreviewIndexHead = async () => { fx.calls.head++; return null }
  const r = reader(fx)
  assert.deepEqual(await r.load(fx.mainHead), { status: 'ABSENT' })
  assert.equal(fx.calls.head, 1); assert.equal(fx.calls.envelopes, 0); assert.equal(fx.chunkGets().length, 0)
  assert.equal(await r.lookup(fx.nodes.get(fx.fileIds[0]), 'thumb'), null)
})

test('PIRD-2 valid index: root fetched once; lookups resolve only covering shards, coalesced; entry returned', async () => {
  const fx = await buildIndex({ files: 12, kinds: ['thumb', 'poster'] })
  const r = reader(fx)
  assert.deepEqual(await r.load(fx.mainHead), { status: 'READY' })
  assert.equal(fx.chunkGets().length, 1, 'root only')
  const targets = fx.fileIds.slice(0, 6)
  const got = await Promise.all([...targets, ...targets].map((id) => r.lookup(fx.nodes.get(id), 'thumb')))
  for (const [i, e] of got.entries()) {
    const id = [...targets, ...targets][i]
    assert.equal(e.kind, 'thumb'); assert.deepEqual(e.blobRef, fx.derivs.get(`${id}:thumb`).blobRef)
    assert.deepEqual(e.sourceBlobRef, fx.nodes.get(id).blobRef)
  }
  const prefixes = new Set(fx.shards.filter((s) => true).map((s) => s.prefix))
  const shardGets = fx.chunkGets().length - 1
  assert.ok(shardGets <= targets.length && shardGets <= prefixes.size, `shard fetches ${shardGets}`)
  const again = fx.chunkGets().length
  await r.lookup(fx.nodes.get(targets[0]), 'poster')
  assert.equal(fx.chunkGets().length, again, 'cached shard reused')
  assert.equal(new Set(fx.calls.envelopeIds).size, fx.calls.envelopeIds.length, 'no envelope fetched twice')
})

test('PIRD-3 stale source, non-file, trashed, unknown kind/profile, missing node → null (original path)', async () => {
  const fx = await buildIndex({ files: 3 })
  const r = reader(fx)
  await r.load(fx.mainHead)
  const [a, b, c] = fx.fileIds
  const node = fx.nodes.get(a)
  assert.ok(await r.lookup(node, 'thumb'))
  assert.equal(await r.lookup({ ...node, blobRef: { formatVersion: 2, id: 'e'.repeat(48) } }, 'thumb'), null, 'replaced file → stale entry rejected')
  assert.equal(await r.lookup({ ...node, kind: 'folder', blobRef: undefined }, 'thumb'), null)
  assert.equal(await r.lookup(node, 'motion'), null)
  assert.equal(await r.lookup(node, 'poster'), null, 'kind not in shard')
  fx.nodes.set(b, { ...fx.nodes.get(b), lifecycle: { state: 'trashed', trashedAtClient: 2, trashedFromParentNodeId: 'R'.repeat(22) } })
  assert.equal(await r.lookup(fx.nodes.get(b), 'thumb'), null, 'trashed node never shows an indexed preview')
  assert.equal(await r.lookup(fileNode('Z'.repeat(22), 'f'.repeat(48)), 'thumb'), null, 'node not in the main manifest')
  assert.ok(await r.lookup(fx.nodes.get(c), 'thumb'))
})

test('PIRD-4 treeId mismatch, unknown root version, corrupt root, older generation → FAILED; lookups null', async () => {
  const fx = await buildIndex({ files: 2, generation: 4 })
  assert.equal((await reader(fx).load({ ...fx.mainHead, treeId: 'U'.repeat(22) })).status, 'FAILED')
  const r = reader(fx)
  assert.equal((await r.load(fx.mainHead)).status, 'READY')
  const h = await fx.api.getPreviewIndexHead()
  fx.setHead({ ...h, indexGeneration: 3 })
  assert.deepEqual(await r.load(fx.mainHead), { status: 'FAILED', reason: 'GENERATION_REGRESSED' }, 'older generation within one page session')
  assert.equal(await r.lookup(fx.nodes.get(fx.fileIds[0]), 'thumb'), null)
  fx.setHead({ ...h, rootContentIdB64: 'AAAAAAAAAAAAAAAAAAAAAA==' })
  assert.equal((await reader(fx).load(fx.mainHead)).status, 'FAILED')
  fx.setHead(h)
  fx.t.tamperNextChunk((bytes) => { const c = new Uint8Array(bytes); c[5] ^= 1; return c })
  assert.equal((await reader(fx).load(fx.mainHead)).status, 'FAILED')
  fx.api.getPreviewIndexHead = async () => { throw Object.assign(new Error('x'), { code: 'TREE_STATE_CONFLICT' }) }
  assert.equal((await reader(fx).load(fx.mainHead)).status, 'FAILED')
})

test('PIRD-5 a corrupt shard falls back only for its own nodes; unknown shard version fails secure', async () => {
  const fx = await buildIndex({ files: 1 })
  const kek = fx.kek
  // second shard with a different prefix + a corrupt one: rebuild root with an extra descriptor pointing at a bad object
  const badPlain = new TextEncoder().encode('{"entries":[],"prefix":"111111","schemaVersion":9,"treeId":"' + TREE_ID + '"}')
  const bad = await sealIndexObject({ kek, marker: INDEX_SHARD_MARKER, plaintext: badPlain, buckets: PREVIEW_INDEX_LIMITS.shardPaddingBuckets, transport: fx.t })
  const shards = [...fx.shards, { prefix: '111111', blobRef: bad.blobRef, contentId: bad.contentId }].sort((x, y) => (x.prefix < y.prefix ? -1 : 1))
  if (new Set(shards.map((s) => s.prefix)).size !== shards.length) return // prefix collision with the random file (1/64): nothing to prove
  const rootPlain = encodeRoot({ schemaVersion: 1, treeId: TREE_ID, indexGeneration: 2, createdAtClient: 1, shards })
  const root = await sealIndexObject({ kek, marker: INDEX_ROOT_MARKER, plaintext: rootPlain, buckets: PREVIEW_INDEX_LIMITS.rootPaddingBuckets, transport: fx.t })
  fx.setHead({ treeId: TREE_ID, indexGeneration: 2, rootBlobRef: root.blobRef, rootContentIdB64: root.contentId })
  const r = reader(fx)
  assert.equal((await r.load(fx.mainHead)).status, 'READY')
  assert.ok(await r.lookup(fx.nodes.get(fx.fileIds[0]), 'thumb'), 'healthy shard still serves')
  const s = await r.shardForPrefixForTests('111111')
  assert.equal(s, null, 'unknown shard schema version → no entries (fail secure)')
})

test('PIRD-6 clear(): aborts in-flight work, empties caches; unlockedState purge triggers it; nothing touches browser storage', async () => {
  const counts = installStorageGuards(globalThis)
  const fx = await buildIndex({ files: 6 })
  const us = createUnlockedVaultState({ revokeObjectUrl: () => {}, closeAllPreviewSessions: () => {} })
  const r = reader(fx, { unlockedState: us })
  await r.load(fx.mainHead)
  let release
  const gate = new Promise((res) => { release = res })
  const realFetch = fx.t.fetchBytes
  fx.t.fetchBytes = async (p, o) => { await gate; return realFetch(p, o) }
  const r2 = reader(fx, { unlockedState: us, fetchBytes: (p, o) => fx.t.fetchBytes(p, o) })
  const loading = r2.load(fx.mainHead)
  us.purge('MANUAL_LOCK')
  release()
  assert.equal((await loading).status, 'FAILED')
  assert.equal(await r.lookup(fx.nodes.get(fx.fileIds[0]), 'thumb'), null, 'purged reader serves nothing')
  assert.deepEqual(r.stats(), { status: 'CLEARED', shards: 0, envelopes: 0, ciphertextBytes: 0, inflight: 0 })
  assert.equal(counts.writes, 0); assert.equal(counts.reads, 0)
  const after = reader(fx, { unlockedState: us })
  assert.equal((await after.load(fx.mainHead)).status, 'FAILED', 'a reader created on a purged session never loads')
})

test('PIRD-7 decoded shard cache is bounded (LRU) by maxLiveDecodedShards', async () => {
  const fx = await buildIndex({ files: 40 })
  const r = reader(fx, { limits: { ...PREVIEW_INDEX_LIMITS, maxLiveDecodedShards: 3 } })
  await r.load(fx.mainHead)
  for (const id of fx.fileIds) await r.lookup(fx.nodes.get(id), 'thumb')
  assert.ok(r.stats().shards <= 3, `live shards ${r.stats().shards}`)
  assert.ok(new Set(fx.shards.map((s) => s.prefix)).size > 3)
  const kek2 = await newKek()
  assert.equal((await createPreviewIndexReader({ kek: kek2, api: fx.api, fetchBytes: fx.t.fetchBytes }).load(fx.mainHead)).status, 'FAILED', 'wrong key: no plaintext, FAILED')
})

test('PIRD-8 an entry with an unknown (future) profile is structurally valid but never returned for rendering', async () => {
  const fx = await buildIndex({ files: 1 })
  const nodeId = fx.fileIds[0]
  const node = fx.nodes.get(nodeId)
  const prefix = fx.shards[0].prefix
  const future = { kind: 'thumb', profile: 'vp9', blobRef: { formatVersion: 2, id: 'c'.repeat(48) }, contentId: 'AAECAwQFBgcICQoLDA0ODw==', sourceBlobRef: node.blobRef, mime: 'image/svg+xml', width: 99999, height: 1, plainSize: 1, createdAtClient: 1 }
  const plain = await encodeShard({ schemaVersion: 1, treeId: TREE_ID, prefix, entries: new Map([[nodeId, [future]]]) })
  const s = await sealIndexObject({ kek: fx.kek, marker: INDEX_SHARD_MARKER, plaintext: plain, buckets: PREVIEW_INDEX_LIMITS.shardPaddingBuckets, transport: fx.t })
  const rootPlain = encodeRoot({ schemaVersion: 1, treeId: TREE_ID, indexGeneration: 9, createdAtClient: 1, shards: [{ prefix, blobRef: s.blobRef, contentId: s.contentId }] })
  const root = await sealIndexObject({ kek: fx.kek, marker: INDEX_ROOT_MARKER, plaintext: rootPlain, buckets: PREVIEW_INDEX_LIMITS.rootPaddingBuckets, transport: fx.t })
  fx.setHead({ treeId: TREE_ID, indexGeneration: 9, rootBlobRef: root.blobRef, rootContentIdB64: root.contentId })
  const r = reader(fx)
  assert.equal((await r.load(fx.mainHead)).status, 'READY')
  assert.equal((await r.shardForPrefixForTests(prefix)).entries.get(nodeId)[0].profile, 'vp9', 'kept structurally')
  assert.equal(await r.lookup(node, 'thumb'), null, 'never rendered')
})

test('PIRD-9 older in-flight load cannot replace a newer generation', async () => {
  const fx = await buildIndex({ files: 1, generation: 1 })
  const first = await fx.api.getPreviewIndexHead()
  const rootPlain = encodeRoot({ schemaVersion: 1, treeId: TREE_ID, indexGeneration: 2, createdAtClient: 2, shards: fx.shards })
  const newer = await sealIndexObject({ kek: fx.kek, marker: INDEX_ROOT_MARKER, plaintext: rootPlain, buckets: PREVIEW_INDEX_LIMITS.rootPaddingBuckets, transport: fx.t })
  const second = { ...first, indexGeneration: 2, rootBlobRef: newer.blobRef, rootContentIdB64: newer.contentId }
  let headCalls = 0
  fx.api.getPreviewIndexHead = async () => (++headCalls === 1 ? first : second)
  let release, entered
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  const realFetch = fx.t.fetchBytes
  const r = reader(fx, { fetchBytes: async (path, opts) => {
    if (path.includes(first.rootBlobRef.id)) { entered(); await gate }
    return realFetch(path, opts)
  } })
  const oldLoad = r.load(fx.mainHead)
  await started
  assert.equal((await r.load(fx.mainHead)).status, 'READY')
  release()
  await oldLoad
  assert.equal(r.snapshot().head.indexGeneration, 2)
})

test('PIRD-10 lookup binds to latest node after shard fetch and rejects replaced or trashed source', async () => {
  const fx = await buildIndex({ files: 1 })
  const id = fx.fileIds[0], stale = fx.nodes.get(id)
  const r = reader(fx)
  await r.load(fx.mainHead)
  fx.nodes.set(id, { ...stale, blobRef: { formatVersion: 2, id: 'f'.repeat(48) } })
  assert.equal(await r.lookup(stale, 'thumb'), null, 'caller-held old node cannot authorize a stale derivative')
  fx.nodes.set(id, stale)
  const fx2 = await buildIndex({ files: 1 })
  const id2 = fx2.fileIds[0], node2 = fx2.nodes.get(id2)
  let release, entered
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  const realFetch = fx2.t.fetchBytes
  const r2 = reader(fx2, { fetchBytes: async (path, opts) => {
    if (fx2.shards.some((s) => path.includes(s.blobRef.id))) { entered(); await gate }
    return realFetch(path, opts)
  } })
  await r2.load(fx2.mainHead)
  const pending = r2.lookup(node2, 'thumb')
  await started
  fx2.nodes.set(id2, { ...node2, lifecycle: { state: 'trashed', trashedAtClient: 2, trashedFromParentNodeId: 'R'.repeat(22) } })
  release()
  assert.equal(await pending, null, 'node trashed during fetch cannot render a derivative')
})

test('PIRD-11 disabled reader makes no request and reports DISABLED', async () => {
  const fx = await buildIndex({ files: 1 })
  const r = reader(fx, { readEnabled: false })
  assert.deepEqual(await r.load(fx.mainHead), { status: 'DISABLED' })
  assert.equal(r.stats().status, 'DISABLED')
  assert.equal(fx.calls.head, 0)
})

test('PIRD-12 envelope prefetch is bounded and stops on purge', async () => {
  const fx = await buildIndex({ files: 1 })
  const us = createUnlockedVaultState({ revokeObjectUrl: () => {}, closeAllPreviewSessions: () => {} })
  const r = reader(fx, { unlockedState: us })
  const ids = Array.from({ length: 1100 }, (_, i) => `e-${i}`)
  await r.prefetchEnvelopes(ids)
  assert.ok(r.stats().envelopes <= 1024)
  assert.ok(fx.calls.envelopes <= 32, 'no more than 32 batches')
  const calls = fx.calls.envelopes
  us.purge('MANUAL_LOCK')
  await r.prefetchEnvelopes(ids)
  assert.equal(fx.calls.envelopes, calls)
  assert.equal(r.stats().envelopes, 0)
})

test('PIRD-13 authenticated ciphertext cache reuses shard fetch and obeys byte ceiling', async () => {
  const fx = await buildIndex({ files: 1 })
  const r = reader(fx, { limits: { ...PREVIEW_INDEX_LIMITS, maxLiveDecodedShards: 0 } })
  await r.load(fx.mainHead)
  const prefix = fx.shards[0].prefix
  assert.ok(await r.shardForPrefixForTests(prefix))
  const fetched = fx.chunkGets().length
  assert.ok(await r.shardForPrefixForTests(prefix))
  assert.equal(fx.chunkGets().length, fetched, 'authenticated ciphertext reused after decoded shard eviction')
  assert.ok(await r.shardForPrefixForTests(prefix), 'cached ciphertext remains intact after another authenticated read')
  assert.ok(r.stats().ciphertextBytes <= PREVIEW_INDEX_LIMITS.ciphertextLruBytes)

  const fx2 = await buildIndex({ files: 1 })
  const tiny = reader(fx2, { limits: { ...PREVIEW_INDEX_LIMITS, maxLiveDecodedShards: 0, ciphertextLruBytes: 1 } })
  await tiny.load(fx2.mainHead)
  assert.ok(await tiny.shardForPrefixForTests(fx2.shards[0].prefix))
  const first = fx2.chunkGets().length
  assert.ok(await tiny.shardForPrefixForTests(fx2.shards[0].prefix))
  assert.equal(fx2.chunkGets().length, first + 1, 'oversized ciphertext is not retained')
  assert.equal(tiny.stats().ciphertextBytes, 0)
})
