// tests/previewIndexCodec.test.js — AEGIS Drive (IDEA1) · D-1 PR-B Tasks B.4/B.5 · root catalog + shard codecs
//
// Closed schemas; every failure is an IndexCodecError that disables acceleration only (callers fall back to originals).
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { encodeRoot, decodeRoot, encodeShard, decodeShard, IndexCodecError } from '../src/lib/vaultPreviewIndexCodec.js'
import { routingBits, prefixOf } from '../src/lib/vaultPreviewIndexRouting.js'

const te = new TextEncoder(), td = new TextDecoder()
const TREE = 'T'.repeat(22)
const CID = 'AAECAwQFBgcICQoLDA0ODw=='
const hex48 = (c = 'a') => c.repeat(48)
const id22 = () => randomBytes(16).toString('base64url')
const code = (c) => (e) => e instanceof IndexCodecError && e.code === c

const root = (o = {}) => ({
  schemaVersion: 1, treeId: TREE, indexGeneration: 3, createdAtClient: 1_700_000_000_000,
  shards: [{ prefix: '000000', blobRef: { formatVersion: 2, id: hex48('a') }, contentId: CID }, { prefix: '1010001', blobRef: { formatVersion: 2, id: hex48('b') }, contentId: CID }],
  ...o,
})
const entry = (o = {}) => ({
  kind: 'thumb', profile: 'vp1', blobRef: { formatVersion: 2, id: hex48('c') }, contentId: CID,
  sourceBlobRef: { formatVersion: 2, id: hex48('d') }, mime: 'image/webp', width: 512, height: 384, plainSize: 40_000,
  createdAtClient: 1_700_000_000_000, ...o,
})
async function idsUnder(prefix, n) {
  const out = []
  while (out.length < n) { const id = id22(); if (prefixOf(await routingBits(id), prefix.length) === prefix) out.push(id) }
  return out
}
const mutateJson = (bytes, fn) => { const o = JSON.parse(td.decode(bytes)); fn(o); return te.encode(JSON.stringify(o)) }

// ── root (B.4) ───────────────────────────────────────────────────────────────

test('PICD-R1 root round-trips with canonical bytes (golden vector) and binds tree + generation', () => {
  const bytes = encodeRoot(root())
  assert.equal(td.decode(bytes), `{"createdAtClient":1700000000000,"indexGeneration":3,"schemaVersion":1,"shards":[{"blobRef":{"formatVersion":2,"id":"${hex48('a')}"},"contentId":"${CID}","prefix":"000000"},{"blobRef":{"formatVersion":2,"id":"${hex48('b')}"},"contentId":"${CID}","prefix":"1010001"}],"treeId":"${TREE}"}`)
  assert.deepEqual(decodeRoot(bytes, { treeId: TREE, indexGeneration: 3 }), root())
  assert.throws(() => decodeRoot(bytes, { treeId: 'U'.repeat(22), indexGeneration: 3 }), code('TREE_MISMATCH'))
  assert.throws(() => decodeRoot(bytes, { treeId: TREE, indexGeneration: 4 }), code('GENERATION_MISMATCH'))
  assert.deepEqual(decodeRoot(encodeRoot(root({ shards: [] })), { treeId: TREE, indexGeneration: 3 }).shards, [])
})

test('PICD-R2 root fails secure: unknown version, unknown keys, bad fields, prefix set, limits, syntax', () => {
  const good = encodeRoot(root())
  const ctx = { treeId: TREE, indexGeneration: 3 }
  assert.throws(() => decodeRoot(mutateJson(good, (o) => { o.schemaVersion = 2; o.future = true }), ctx), code('UNKNOWN_VERSION'))
  assert.throws(() => decodeRoot(mutateJson(good, (o) => { o.extra = 1 }), ctx), code('UNKNOWN_KEY'))
  assert.throws(() => decodeRoot(mutateJson(good, (o) => { o.shards[0].x = 1 }), ctx), code('UNKNOWN_KEY'))
  assert.throws(() => decodeRoot(mutateJson(good, (o) => { o.shards[0].blobRef.formatVersion = 1 }), ctx), code('BAD_FIELD'))
  assert.throws(() => decodeRoot(mutateJson(good, (o) => { o.shards[0].blobRef.id = 'nothex' }), ctx), code('BAD_FIELD'))
  assert.throws(() => decodeRoot(mutateJson(good, (o) => { o.shards[0].contentId = 'bad' }), ctx), code('BAD_FIELD'))
  assert.throws(() => decodeRoot(mutateJson(good, (o) => { o.shards[1].prefix = '0000001' }), ctx), code('BAD_PREFIX_SET'))
  assert.throws(() => decodeRoot(mutateJson(good, (o) => { o.shards.reverse() }), ctx), code('BAD_PREFIX_SET'))
  assert.throws(() => decodeRoot(mutateJson(good, (o) => { o.indexGeneration = 0 }), { treeId: TREE, indexGeneration: 0 }), code('BAD_FIELD'))
  assert.throws(() => decodeRoot(te.encode('{"a":1,"a":2}'), ctx), code('DUPLICATE'))
  assert.throws(() => decodeRoot(te.encode('{ }'), ctx), code('BAD_SYNTAX'))
  assert.throws(() => decodeRoot(te.encode('[]'), ctx), code('BAD_SYNTAX'))
  const many = Array.from({ length: 129 }, (_, i) => ({ prefix: i.toString(2).padStart(8, '0').slice(0, 7), blobRef: { formatVersion: 2, id: hex48() }, contentId: CID }))
  assert.throws(() => encodeRoot(root({ shards: many })), (e) => e instanceof IndexCodecError)
  const desc = (n) => Array.from({ length: n }, (_, i) => ({ prefix: i.toString(2).padStart(7, '0'), blobRef: { formatVersion: 2, id: hex48() }, contentId: CID }))
  assert.equal(decodeRoot(encodeRoot(root({ shards: desc(64) })), ctx).shards.length, 64, 'the initial 64-shard target fits')
  // ⚠️ PROVISIONAL-LIMIT FINDING (reported to the Human Owner, not changed here): with maxRootDecodedBytes = 16 KiB − 5,
  //    a root holding the provisional maxShards = 128 descriptors is ~18.8 KB and does NOT fit (≈110 do). Encoding fails
  //    with LIMIT, which the writer (PR-D) must treat as fail-soft. HG-G must reconcile the two provisional values.
  assert.throws(() => encodeRoot(root({ shards: desc(128) })), code('LIMIT'))
  assert.throws(() => decodeRoot(new Uint8Array(20_000).fill(0x20), ctx), code('LIMIT'))
})

// ── shard (B.5) ──────────────────────────────────────────────────────────────

test('PICD-S1 shard round-trips (Map entries, sorted canonical bytes) and binds tree + prefix', async () => {
  const [n1, n2] = await idsUnder('101000', 2)
  const entries = new Map([[n2, [entry({ kind: 'poster', mime: 'image/jpeg' }), entry()]], [n1, [entry()]]])
  const bytes = await encodeShard({ schemaVersion: 1, treeId: TREE, prefix: '101000', entries })
  const text = td.decode(bytes)
  assert.ok(text.indexOf([n1, n2].sort()[0]) < text.indexOf([n1, n2].sort()[1]), 'entries sorted by nodeId')
  const back = await decodeShard(bytes, { treeId: TREE, prefix: '101000' })
  assert.ok(back.entries instanceof Map)
  assert.equal(back.entries.size, 2)
  assert.deepEqual(back.entries.get(n1), [entry()])
  assert.deepEqual(back.entries.get(n2).map((e) => e.kind), ['poster', 'thumb'], 'per-node entries in canonical kind order')
  assert.deepEqual(await encodeShard(back), bytes, 'canonical: decode → encode is byte-identical')
  await assert.rejects(decodeShard(bytes, { treeId: 'U'.repeat(22), prefix: '101000' }), code('TREE_MISMATCH'))
  await assert.rejects(decodeShard(bytes, { treeId: TREE, prefix: '101001' }), code('PREFIX_MISMATCH'))
})

test('PICD-S2 shard fails secure: routing, duplicates, entry validation, unknown version/keys, limits', async () => {
  const [inside] = await idsUnder('101000', 1)
  const [outside] = await idsUnder('010101', 1)
  const enc = (entries, o = {}) => encodeShard({ schemaVersion: 1, treeId: TREE, prefix: '101000', entries: new Map(entries), ...o })
  await assert.rejects(enc([[outside, [entry()]]]), code('PREFIX_MISMATCH'))
  await assert.rejects(enc([[inside, [entry(), entry()]]]), code('DUPLICATE'))
  await assert.rejects(enc([[inside, []]]), code('BAD_FIELD'))
  await assert.rejects(enc([[inside, [entry({ mime: 'image/svg+xml' })]]]), code('BAD_FIELD'))
  await assert.rejects(enc([[inside, [entry({ width: 4096 })]]]), code('BAD_FIELD'))
  await assert.rejects(enc([[inside, [entry({ contentId: 'x' })]]]), code('BAD_FIELD'))
  await assert.rejects(enc([[inside, [entry({ sourceBlobRef: { formatVersion: 2 } })]]]), code('BAD_FIELD'))
  await assert.rejects(enc([['bad id', [entry()]]]), code('BAD_FIELD'))
  await assert.rejects(enc([], { prefix: '10100' }), code('BAD_FIELD'))
  await assert.rejects(enc([], { prefix: '10100000' }), code('BAD_FIELD'))
  const good = await enc([[inside, [entry()]]])
  const ctx = { treeId: TREE, prefix: '101000' }
  await assert.rejects(decodeShard(mutateJson(good, (o) => { o.schemaVersion = 7 }), ctx), code('UNKNOWN_VERSION'))
  await assert.rejects(decodeShard(mutateJson(good, (o) => { o.more = 1 }), ctx), code('UNKNOWN_KEY'))
  await assert.rejects(decodeShard(mutateJson(good, (o) => { o.entries.push(o.entries[0]) }), ctx), code('DUPLICATE'))
  await assert.rejects(decodeShard(mutateJson(good, (o) => { o.entries[0][1][0].evil = '<svg>' }), ctx), code('BAD_FIELD'))
  await assert.rejects(decodeShard(mutateJson(good, (o) => { o.entries[0] = [o.entries[0][0]] }), ctx), code('BAD_FIELD'))
  // unknown profile: structurally retained, never bound-checked here (the reader ignores it — B.7)
  const future = await decodeShard(await enc([[inside, [entry({ profile: 'vp9', mime: 'image/svg+xml' })]]]), ctx)
  assert.equal(future.entries.get(inside)[0].profile, 'vp9')
  // size limit (192 KiB provisional) — encoder refuses, decoder refuses
  const ids = await idsUnder('101000', 600)
  await assert.rejects(enc(ids.map((id) => [id, [entry(), entry({ kind: 'poster' }), entry({ kind: 'motion', profile: 'vp9', durationMs: 1 })]])), code('LIMIT'))
  await assert.rejects(decodeShard(new Uint8Array(200 * 1024).fill(0x20), ctx), code('LIMIT'))
})
