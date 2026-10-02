// tests/previewIndexMerge.test.js — AEGIS Drive (IDEA1) · D-1 PR-C Task C.6 · pure merge / rebase / split / prune
//
// Pure functions only: no transport, no crypto envelope, no storage. A seeded RNG drives the property tests so a
// failure reproduces exactly (seed printed in the assertion message).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { applyUpserts, planSplit, rebaseRoot, DROP_REASON } from '../src/lib/vaultPreviewIndexMerge.js'
import { routingBits, prefixOf } from '../src/lib/vaultPreviewIndexRouting.js'
import { encodeShard } from '../src/lib/vaultPreviewIndexCodec.js'

const TREE = 'T'.repeat(22)
const hex48 = () => randomBytes(24).toString('hex')
const cid = () => randomBytes(16).toString('base64')
const id22 = () => randomBytes(16).toString('base64url')
const ref = (id = hex48()) => ({ formatVersion: 2, id })
const fileNode = (nodeId, blobRef, o = {}) => ({ nodeId, kind: 'file', blobRef, lifecycle: { state: 'active' }, ...o })
const entry = (kind, sourceBlobRef, o = {}) => ({
  kind, profile: 'vp1', blobRef: ref(), contentId: cid(), sourceBlobRef, mime: 'image/jpeg',
  width: 320, height: 240, plainSize: 4_000, createdAtClient: 1_700_000_000_000, ...o,
})
const prefixFor = async (nodeId, bits = 6) => prefixOf(await routingBits(nodeId), bits)
const emptyShard = (prefix) => ({ schemaVersion: 1, treeId: TREE, prefix, entries: new Map() })
/** n node ids that all route under `prefix` (6 bits) */
async function idsUnder(prefix, n) {
  const out = []
  while (out.length < n) { const id = id22(); if ((await prefixFor(id, prefix.length)) === prefix) out.push(id) }
  return out
}
const manifestOf = (nodes) => { const m = new Map(nodes.map((x) => [x.nodeId, x])); return (id) => m.get(id) ?? null }
const desc = (prefix) => ({ prefix, blobRef: ref(), contentId: cid() })

test('PIM-1 disjoint upserts from two writers on the same shard both survive (B re-applies onto A\'s committed shard)', async () => {
  const [n1, n2] = await idsUnder('010101', 2)
  const nodes = [fileNode(n1, ref()), fileNode(n2, ref())]
  const cur = manifestOf(nodes)
  const base = emptyShard('010101')
  const a = applyUpserts({ shard: base, upserts: [{ nodeId: n1, entry: entry('thumb', nodes[0].blobRef) }], currentNodeOf: cur })
  const bOnBase = applyUpserts({ shard: base, upserts: [{ nodeId: n2, entry: entry('thumb', nodes[1].blobRef) }], currentNodeOf: cur })
  assert.equal(bOnBase.applied.length, 1)
  // A commits first; B's rebase must re-apply its upserts onto A's shard
  const bRebased = applyUpserts({ shard: a.shard, upserts: bOnBase.applied, currentNodeOf: cur })
  assert.deepEqual([...bRebased.shard.entries.keys()].sort(), [n1, n2].sort())
  await encodeShard(bRebased.shard)
})

test('PIM-2 an existing valid entry wins (EXISTING_VALID) — no churn; the input shard is never mutated', async () => {
  const [n1] = await idsUnder('000000', 1)
  const node = fileNode(n1, ref())
  const existing = entry('thumb', node.blobRef, { createdAtClient: 1 })
  const shard = { ...emptyShard('000000'), entries: new Map([[n1, [existing]]]) }
  const snapshot = JSON.stringify([...shard.entries])
  const r = applyUpserts({ shard, upserts: [{ nodeId: n1, entry: entry('thumb', node.blobRef, { createdAtClient: 9_999_999_999_999 }) }], currentNodeOf: manifestOf([node]) })
  assert.deepEqual(r.applied, [])
  assert.deepEqual(r.dropped.map((d) => d.reason), [DROP_REASON.EXISTING_VALID])
  assert.equal(r.shard.entries.get(n1)[0].blobRef.id, existing.blobRef.id, 'the newer timestamp did not win')
  assert.equal(JSON.stringify([...shard.entries]), snapshot)
})

test('PIM-3 an existing stale entry (source no longer current) is replaced', async () => {
  const [n1] = await idsUnder('111111', 1)
  const oldSource = ref(), node = fileNode(n1, ref())
  const shard = { ...emptyShard('111111'), entries: new Map([[n1, [entry('thumb', oldSource), entry('poster', oldSource)]]]) }
  const incoming = entry('thumb', node.blobRef)
  const r = applyUpserts({ shard, upserts: [{ nodeId: n1, entry: incoming }], currentNodeOf: manifestOf([node]) })
  assert.equal(r.pruned, 2)
  assert.deepEqual(r.shard.entries.get(n1).map((e) => e.blobRef.id), [incoming.blobRef.id])
})

test('PIM-4 incoming NODE_MISSING / STALE_SOURCE / BAD_KIND / BAD_ENTRY are dropped, never applied', async () => {
  const [n1, n2, folder] = await idsUnder('001100', 3)
  const node = fileNode(n1, ref())
  const cur = manifestOf([node, { nodeId: folder, kind: 'folder' }])
  const cases = [
    [{ nodeId: n2, entry: entry('thumb', ref()) }, DROP_REASON.NODE_MISSING],
    [{ nodeId: folder, entry: entry('thumb', ref()) }, DROP_REASON.NODE_MISSING],
    [{ nodeId: n1, entry: entry('thumb', ref()) }, DROP_REASON.STALE_SOURCE],
    [{ nodeId: n1, entry: entry('motion', node.blobRef, { durationMs: 1000, mime: 'video/mp4' }) }, DROP_REASON.BAD_KIND],
    [{ nodeId: n1, entry: entry('thumb', node.blobRef, { profile: 'vp2' }) }, DROP_REASON.BAD_KIND],
    [{ nodeId: n1, entry: entry('thumb', node.blobRef, { mime: 'image/svg+xml' }) }, DROP_REASON.BAD_ENTRY],
    [{ nodeId: n1, entry: entry('thumb', node.blobRef, { width: 99_999 }) }, DROP_REASON.BAD_ENTRY],
  ]
  for (const [upsert, reason] of cases) {
    const r = applyUpserts({ shard: emptyShard('001100'), upserts: [upsert], currentNodeOf: cur })
    assert.deepEqual(r.applied, [], reason)
    assert.deepEqual(r.dropped.map((d) => d.reason), [reason])
    assert.equal(r.shard.entries.size, 0, reason)
  }
})

test('PIM-5 prune drops entries of absent nodes and mismatched sources; trashed / purge-pending nodes are kept', async () => {
  const [gone, moved, trashed, pending, fine] = await idsUnder('101010', 5)
  const nodes = [
    fileNode(moved, ref()), fileNode(trashed, ref(), { lifecycle: { state: 'trashed' } }),
    fileNode(pending, ref(), { lifecycle: { state: 'purge-pending' } }), fileNode(fine, ref()),
  ]
  const cur = manifestOf(nodes)
  const byId = Object.fromEntries(nodes.map((x) => [x.nodeId, x]))
  const shard = { ...emptyShard('101010'), entries: new Map([
    [gone, [entry('thumb', ref())]], [moved, [entry('thumb', ref())]],
    [trashed, [entry('thumb', byId[trashed].blobRef)]], [pending, [entry('poster', byId[pending].blobRef)]], [fine, [entry('thumb', byId[fine].blobRef)]],
  ]) }
  const r = applyUpserts({ shard, upserts: [], currentNodeOf: cur })
  assert.equal(r.pruned, 2)
  assert.deepEqual([...r.shard.entries.keys()].sort(), [trashed, pending, fine].sort())
})

test('PIM-6 timestamps never choose a winner: the first valid upsert for a node/kind wins whatever createdAtClient says', async () => {
  const [n1] = await idsUnder('011011', 1)
  const node = fileNode(n1, ref())
  for (const [first, second] of [[1, 2], [2, 1]]) {
    const a = entry('thumb', node.blobRef, { createdAtClient: first }), b = entry('thumb', node.blobRef, { createdAtClient: second })
    const r = applyUpserts({ shard: emptyShard('011011'), upserts: [{ nodeId: n1, entry: a }, { nodeId: n1, entry: b }], currentNodeOf: manifestOf([node]) })
    assert.equal(r.shard.entries.get(n1)[0].blobRef.id, a.blobRef.id)
    assert.deepEqual(r.dropped.map((d) => d.reason), [DROP_REASON.EXISTING_VALID])
  }
})

async function fullShard(prefix, n) {
  const ids = await idsUnder(prefix, n)
  const nodes = ids.map((id) => fileNode(id, ref()))
  const shard = { ...emptyShard(prefix), entries: new Map(nodes.map((x) => [x.nodeId, [entry('poster', x.blobRef), entry('thumb', x.blobRef)]])) }
  return { shard, nodes }
}

test('PIM-7 planSplit splits at the provisional shard limit into prefix+0 / prefix+1 with every entry routed correctly', async () => {
  const { shard } = await fullShard('110011', 40)
  const whole = (await encodeShard(shard)).length
  const r = await planSplit(shard, { maxShardDecodedBytes: Math.ceil(whole * 0.8), maxPrefixBits: 7 })
  assert.equal(r.overflow, undefined)
  assert.ok(r.shards.length === 2)
  assert.deepEqual(r.shards.map((s) => s.prefix), ['1100110', '1100111'])
  const seen = []
  for (const s of r.shards) {
    await encodeShard(s) // the codec itself re-checks that every nodeId routes under the child prefix
    for (const id of s.entries.keys()) { assert.equal(await prefixFor(id, 7), s.prefix); seen.push(id) }
  }
  assert.deepEqual(seen.sort(), [...shard.entries.keys()].sort(), 'nothing lost, nothing duplicated')
  const small = await planSplit(shard, { maxShardDecodedBytes: whole, maxPrefixBits: 7 })
  assert.deepEqual(small.shards.map((s) => s.prefix), ['110011'], 'no split at exactly the limit')
})

test('PIM-8 split overflow at maxPrefixBits is fail-soft { overflow: true } and never truncates', async () => {
  const { shard } = await fullShard('000111', 20)
  const before = JSON.stringify([...shard.entries])
  assert.deepEqual(await planSplit(shard, { maxShardDecodedBytes: 64, maxPrefixBits: 7 }), { overflow: true })
  const deeper = { ...shard, prefix: '0001110' }
  for (const k of [...deeper.entries.keys()]) if ((await prefixFor(k, 7)) !== '0001110') deeper.entries = new Map([...deeper.entries].filter(([id]) => id !== k))
  assert.deepEqual(await planSplit(deeper, { maxShardDecodedBytes: 64, maxPrefixBits: 7 }), { overflow: true })
  assert.equal(JSON.stringify([...shard.entries]), before)
})

test('PIM-9 rebaseRoot: disjoint shards compose; a concurrently changed or split shard → reapply (never overwrite); maxShards overflow', () => {
  const a = desc('000000'), b = desc('000001'), c = desc('111111')
  const latestRoot = { schemaVersion: 1, treeId: TREE, indexGeneration: 4, createdAtClient: 1, shards: [a, b, c] }
  const mine = desc('000001')
  const ok = rebaseRoot({ latestRoot, changes: [{ basePrefix: '000001', baseBlobId: b.blobRef.id, replacement: [mine] }], treeId: TREE, nextGeneration: 5, createdAtClient: 7 })
  assert.deepEqual(ok.root.shards.map((d) => [d.prefix, d.blobRef.id]), [['000000', a.blobRef.id], ['000001', mine.blobRef.id], ['111111', c.blobRef.id]])
  assert.equal(ok.root.indexGeneration, 5)
  const fresh = rebaseRoot({ latestRoot, changes: [{ basePrefix: '010101', baseBlobId: null, replacement: [desc('010101')] }], treeId: TREE, nextGeneration: 5, createdAtClient: 7 })
  assert.deepEqual(fresh.root.shards.map((d) => d.prefix), ['000000', '000001', '010101', '111111'])
  // another writer replaced the shard we based on → reapply that prefix
  assert.deepEqual(rebaseRoot({ latestRoot, changes: [{ basePrefix: '000001', baseBlobId: hex48(), replacement: [mine] }], treeId: TREE, nextGeneration: 5, createdAtClient: 7 }), { reapply: ['000001'] })
  // another writer split the shard we based on → reapply its children
  const split = { ...latestRoot, shards: [a, desc('0000010'), desc('0000011'), c] }
  assert.deepEqual(rebaseRoot({ latestRoot: split, changes: [{ basePrefix: '000001', baseBlobId: b.blobRef.id, replacement: [mine] }], treeId: TREE, nextGeneration: 5, createdAtClient: 7 }), { reapply: ['0000010', '0000011'] })
  // another writer created a shard in the region we thought was empty → reapply
  assert.deepEqual(rebaseRoot({ latestRoot, changes: [{ basePrefix: '000000', baseBlobId: null, replacement: [desc('000000')] }], treeId: TREE, nextGeneration: 5, createdAtClient: 7 }), { reapply: ['000000'] })
  // our own split replaces one descriptor with two
  const ours = rebaseRoot({ latestRoot, changes: [{ basePrefix: '111111', baseBlobId: c.blobRef.id, replacement: [desc('1111110'), desc('1111111')] }], treeId: TREE, nextGeneration: 5, createdAtClient: 7 })
  assert.deepEqual(ours.root.shards.map((d) => d.prefix), ['000000', '000001', '1111110', '1111111'])
  assert.deepEqual(rebaseRoot({ latestRoot, changes: [{ basePrefix: '111111', baseBlobId: c.blobRef.id, replacement: [desc('1111110'), desc('1111111')] }], treeId: TREE, nextGeneration: 5, createdAtClient: 7, maxShards: 3 }), { overflow: true })
})

test('PIM-10 re-applying after a concurrent split lands each upsert in the correct child shard', async () => {
  const ids = await idsUnder('100100', 12)
  const nodes = ids.map((id) => fileNode(id, ref()))
  const cur = manifestOf(nodes)
  const children = { '1001000': emptyShard('1001000'), '1001001': emptyShard('1001001') }
  const ups = nodes.map((x) => ({ nodeId: x.nodeId, entry: entry('thumb', x.blobRef) }))
  for (const p of Object.keys(children)) {
    const mineHere = []
    for (const u of ups) if ((await prefixFor(u.nodeId, 7)) === p) mineHere.push(u)
    const r = applyUpserts({ shard: children[p], upserts: mineHere, currentNodeOf: cur })
    assert.equal(r.applied.length, mineHere.length)
    await encodeShard(r.shard)
    children[p] = r.shard
  }
  assert.equal(children['1001000'].entries.size + children['1001001'].entries.size, 12)
})

// ── property test (seeded) ───────────────────────────────────────────────────
function mulberry32(seed) {
  let t = seed >>> 0
  return () => { t = (t + 0x6D2B79F5) >>> 0; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296 }
}

test('PIM-11 property: two writers, random disjoint/overlapping upserts, random timestamps → no lost valid update, no invalid entry, first commit wins per node/kind', async () => {
  const pool = await idsUnder('010010', 30)
  for (const seed of [1, 7, 42, 1337, 9001, 31337]) {
    const rnd = mulberry32(seed)
    const nodes = pool.map((id) => fileNode(id, ref()))
    const cur = manifestOf(nodes.filter(() => rnd() > 0.1)) // ~10% of nodes deleted from the manifest meanwhile
    const pick = () => {
      const out = []
      for (const x of nodes) if (rnd() < 0.4) {
        const stale = rnd() < 0.1
        out.push({ nodeId: x.nodeId, entry: entry(rnd() < 0.5 ? 'thumb' : 'poster', stale ? ref() : x.blobRef, { createdAtClient: Math.floor(rnd() * 1e12) }) })
      }
      return out
    }
    const upA = pick(), upB = pick()
    const base = emptyShard('010010')
    const A = applyUpserts({ shard: base, upserts: upA, currentNodeOf: cur })
    const Bfirst = applyUpserts({ shard: base, upserts: upB, currentNodeOf: cur })
    const B = applyUpserts({ shard: A.shard, upserts: Bfirst.applied, currentNodeOf: cur }) // A won the CAS; B re-applies
    const final = B.shard
    const msg = `seed ${seed}`
    for (const [nodeId, list] of final.entries) {
      const node = cur(nodeId)
      assert.ok(node, `${msg}: entry for a missing node`)
      for (const e of list) assert.deepEqual(e.sourceBlobRef, node.blobRef, `${msg}: stale entry kept`)
      assert.equal(new Set(list.map((e) => e.kind)).size, list.length, `${msg}: duplicate kind`)
    }
    for (const u of A.applied) assert.equal(final.entries.get(u.nodeId).find((e) => e.kind === u.entry.kind).blobRef.id, u.entry.blobRef.id, `${msg}: A's committed update lost`)
    for (const u of Bfirst.applied) {
      const got = final.entries.get(u.nodeId).find((e) => e.kind === u.entry.kind)
      const aHad = A.applied.find((x) => x.nodeId === u.nodeId && x.entry.kind === u.entry.kind)
      assert.equal(got.blobRef.id, (aHad ?? u).entry.blobRef.id, `${msg}: B's disjoint update lost or overwrote A`)
    }
    await encodeShard(final)
  }
})

test('PIM-12 the merge module is pure: no network, storage, upload, CAS or DOM reference', () => {
  const src = fs.readFileSync(new URL('../src/lib/vaultPreviewIndexMerge.js', import.meta.url), 'utf8')
  const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
  assert.doesNotMatch(code, /\b(fetch|apiFetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|caches\.|document\.|window\.|casPreviewIndexHead|uploadVaultFileChunked|sealIndexObject)\b/)
  for (const m of code.matchAll(/from '([^']+)'/g)) assert.match(m[1], /^\.\/vault(TreeManifest|PreviewIndex(Constants|Routing|Codec))\.js$/, m[1])
})
