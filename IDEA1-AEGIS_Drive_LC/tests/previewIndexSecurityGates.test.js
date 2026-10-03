// tests/previewIndexSecurityGates.test.js — AEGIS Drive (IDEA1) · D-1 PR-E Task H.1 · consolidated security gates (memory mode)
//
// Server gates come from tests/helpers/previewIndexSecurityGateSpec.mjs (the same spec runs on PostgreSQL 15 in
// tests/previewIndexSecurityGatesPostgres.test.js). The client gates below re-prove the reader/derivative/lock/privacy
// invariants against the real codec and V2 envelopes, and SG-MAP-1 pins every per-task test this gate cites so a renamed
// or deleted proof breaks the gate instead of silently disappearing.
import test, { before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import * as H from './helpers/previewIndexUploadHarness.mjs'
import { definePreviewIndexSecurityGateSpec, APPROVED_BUDGET_BYTES } from './helpers/previewIndexSecurityGateSpec.mjs'
import { createPreviewIndexReader } from '../src/lib/vaultPreviewIndexReader.js'
import { readDerivative } from '../src/lib/vaultDerivativeRead.js'
import { createUnlockedVaultState, PURGE_REASONS } from '../src/lib/vaultUnlockedState.js'
import { encodeRoot, encodeShard } from '../src/lib/vaultPreviewIndexCodec.js'
import { sealIndexObject, sealDerivative } from '../src/lib/vaultPreviewIndexObject.js'
import { routingBits, prefixOf } from '../src/lib/vaultPreviewIndexRouting.js'
import { INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, PREVIEW_INDEX_LIMITS } from '../src/lib/vaultPreviewIndexConstants.js'
import { createPreviewIndexFakeTransport } from './helpers/previewIndexFakeTransport.mjs'
import { buildIndex, TREE_ID, newKek, fakeJpeg, id22 } from './helpers/previewIndexFixture.mjs'

const { cfg, MiB } = H

before(() => H.setup({ off: cfg.off(), read: cfg.read(), write: cfg.write(APPROVED_BUDGET_BYTES), small: cfg.write(MiB) }))
after(() => H.teardown())
beforeEach(() => H.reset())

definePreviewIndexSecurityGateSpec({ test, H })

// ── client gates ──────────────────────────────────────────────────────────────────────────────────────────────────
const reader = (fx, o = {}) => createPreviewIndexReader({ kek: fx.kek, api: fx.api, fetchBytes: fx.t.fetchBytes, ...o })
const headerDecoder = async () => ({ width: 320, height: 240, close() {} })
const flip = (bytes) => { const c = new Uint8Array(bytes); c[c.length - 3] ^= 1; return c }
async function sealedEntry({ bytes = fakeJpeg(), mime = 'image/jpeg', kek = null } = {}) {
  const t = createPreviewIndexFakeTransport()
  kek ??= await newKek()
  const d = await sealDerivative({ kek, bytes, mime, transport: t })
  const entry = { kind: 'thumb', profile: 'vp1', blobRef: d.blobRef, contentId: d.contentId, sourceBlobRef: { formatVersion: 2, id: 'd'.repeat(48) }, mime, width: 320, height: 240, plainSize: bytes.length, createdAtClient: 1 }
  t.reset()
  return { t, kek, entry, envelopeOf: async (ref) => t.envelopeOf(ref.id) }
}
const readEntry = (s, o = {}) => readDerivative({ kek: s.kek, entry: s.entry, envelopeOf: s.envelopeOf, fetchBytes: s.t.fetchBytes, decodeImage: headerDecoder, ...o })
/** two file nodes whose entries live in different shards */
async function twoShardNodes(fx) {
  const byPrefix = new Map()
  for (const id of fx.fileIds) byPrefix.set(prefixOf(await routingBits(id), PREVIEW_INDEX_LIMITS.initialPrefixBits), id)
  const [a, b] = [...byPrefix.values()]
  return [a, b]
}

test('SG-CID-1 content-id mismatch (B.6/B.8): root, shard and derivative are each refused before any chunk is fetched', async () => {
  const fx = await buildIndex({ files: 3 })
  const h = await fx.api.getPreviewIndexHead()
  fx.setHead({ ...h, rootContentIdB64: Buffer.alloc(16, 9).toString('base64') })
  assert.equal((await reader(fx).load(fx.mainHead)).status, 'FAILED', 'root')
  assert.equal(fx.chunkGets().length, 0, 'root refused before fetch')
  fx.setHead(h)
  const node = fx.nodes.get(fx.fileIds[0])
  for (const s of fx.shards) fx.t.patchEnvelope(s.blobRef.id, { contentIdB64: Buffer.alloc(16, 3).toString('base64') })
  const r = reader(fx)
  assert.equal((await r.load(fx.mainHead)).status, 'READY')
  const before = fx.chunkGets().length
  assert.equal(await r.lookup(node, 'thumb'), null, 'shard with a mismatched content id serves nothing')
  assert.equal(fx.chunkGets().length, before, 'shard refused before fetch')
  const d = await sealedEntry()
  assert.deepEqual(await readEntry(d, { entry: { ...d.entry, contentId: Buffer.alloc(16, 5).toString('base64') } }), { ok: false, reason: 'CONTENT_ID_MISMATCH' })
  assert.equal(d.t.requests.length, 0, 'derivative refused before fetch')
})

test('SG-SRC-1 source binding (B.7/B.9/E.2): a replaced file (new blobRef) never receives the old derivative', async () => {
  const fx = await buildIndex({ files: 2 })
  const r = reader(fx)
  await r.load(fx.mainHead)
  const node = fx.nodes.get(fx.fileIds[0])
  assert.ok(await r.lookup(node, 'thumb'), 'current source is served')
  const replaced = { ...node, blobRef: { formatVersion: 2, id: randomBytes(24).toString('hex') } }
  fx.nodes.set(node.nodeId, replaced)
  assert.equal(await r.lookup(replaced, 'thumb'), null, 'replaced source → original path')
  assert.equal(await r.lookup(node, 'thumb'), null, 'a stale node object cannot resurrect the old entry')
})

test('SG-STALE-1 / SG-REPLAY-1 stale root (B.7): an older generation is refused within one page session; a replayed older valid head after a fresh unlock is an ACCEPTED, documented limitation', async () => {
  const fx = await buildIndex({ files: 2, generation: 4 })
  const h = await fx.api.getPreviewIndexHead()
  const r = reader(fx)
  assert.equal((await r.load(fx.mainHead)).status, 'READY')
  fx.setHead({ ...h, indexGeneration: 3 })
  assert.deepEqual(await r.load(fx.mainHead), { status: 'FAILED', reason: 'GENERATION_REGRESSED' })
  // MALICIOUS_SERVER_VALID_HEAD_REPLAY=ACCEPTED_INHERITED: a fresh reader has no memory of generation 4.
  fx.setHead(h)
  assert.equal((await reader(fx).load(fx.mainHead)).status, 'READY', 'documented: no durable anti-rollback claim')
})

test('SG-COR-1..3 corrupt root / shard / derivative (B.6/B.8): each fails closed for its own scope only; plaintext never surfaces', async () => {
  const fx = await buildIndex({ files: 24 })
  fx.t.tamperNextChunk(flip)
  const broken = reader(fx)
  assert.equal((await broken.load(fx.mainHead)).status, 'FAILED', 'corrupt root')
  assert.equal(await broken.lookup(fx.nodes.get(fx.fileIds[0]), 'thumb'), null)
  const [a, b] = await twoShardNodes(fx)
  assert.ok(a && b && a !== b, 'fixture spans two shards')
  const r = reader(fx)
  assert.equal((await r.load(fx.mainHead)).status, 'READY')
  fx.t.tamperNextChunk(flip)
  assert.equal(await r.lookup(fx.nodes.get(a), 'thumb'), null, 'corrupt shard → its node falls back')
  assert.ok(await r.lookup(fx.nodes.get(b), 'thumb'), 'other shard unaffected')
  const d = await sealedEntry()
  d.t.tamperNextChunk(flip)
  const res = await readEntry(d)
  assert.deepEqual(res, { ok: false, reason: 'INTEGRITY' })
  assert.equal('bytes' in res, false)
})

test('SG-VER-1/2 unknown version (B.4/B.5): root or shard with schemaVersion ≠ 1 fails secure', async () => {
  const fx = await buildIndex({ files: 1 })
  const kek = fx.kek
  const rootPlain = new TextEncoder().encode(`{"createdAtClient":1,"indexGeneration":2,"schemaVersion":2,"shards":[],"treeId":"${TREE_ID}"}`)
  const root = await sealIndexObject({ kek, marker: INDEX_ROOT_MARKER, plaintext: rootPlain, buckets: PREVIEW_INDEX_LIMITS.rootPaddingBuckets, transport: fx.t })
  fx.setHead({ treeId: TREE_ID, indexGeneration: 2, rootBlobRef: root.blobRef, rootContentIdB64: root.contentId })
  assert.equal((await reader(fx).load(fx.mainHead)).status, 'FAILED', 'unknown root version')
  const badShard = new TextEncoder().encode(`{"entries":[],"prefix":"111111","schemaVersion":2,"treeId":"${TREE_ID}"}`)
  const s = await sealIndexObject({ kek, marker: INDEX_SHARD_MARKER, plaintext: badShard, buckets: PREVIEW_INDEX_LIMITS.shardPaddingBuckets, transport: fx.t })
  const shards = [...fx.shards, { prefix: '111111', blobRef: s.blobRef, contentId: s.contentId }].sort((x, y) => (x.prefix < y.prefix ? -1 : 1))
  if (new Set(shards.map((x) => x.prefix)).size !== shards.length) return // 1/64 prefix collision with the random file
  const root3 = await sealIndexObject({ kek, marker: INDEX_ROOT_MARKER, plaintext: encodeRoot({ schemaVersion: 1, treeId: TREE_ID, indexGeneration: 3, createdAtClient: 1, shards }), buckets: PREVIEW_INDEX_LIMITS.rootPaddingBuckets, transport: fx.t })
  fx.setHead({ treeId: TREE_ID, indexGeneration: 3, rootBlobRef: root3.blobRef, rootContentIdB64: root3.contentId })
  const r = reader(fx)
  assert.equal((await r.load(fx.mainHead)).status, 'READY')
  assert.equal(await r.shardForPrefixForTests('111111'), null, 'unknown shard version → no entries')
})

test('SG-KEY-1 wrong key (B.6/B.8): another account\'s key yields INTEGRITY / FAILED and zero plaintext', async () => {
  const fx = await buildIndex({ files: 2 })
  assert.equal((await reader(fx, { kek: await newKek() }).load(fx.mainHead)).status, 'FAILED')
  const d = await sealedEntry()
  const res = await readEntry(d, { kek: await newKek() })
  assert.deepEqual(res, { ok: false, reason: 'INTEGRITY' })
})

test('SG-HTML-1 HTML/SVG/XML non-execution (B.8): active content labelled image/* is refused as SIGNATURE', async () => {
  const te = new TextEncoder()
  for (const body of ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', '<!doctype html><script>alert(1)</script>', '<?xml version="1.0"?><x/>']) {
    for (const mime of ['image/jpeg', 'image/webp']) {
      const d = await sealedEntry({ bytes: te.encode(body), mime })
      assert.deepEqual(await readEntry(d), { ok: false, reason: 'SIGNATURE' }, `${mime} ${body.slice(0, 12)}`)
    }
  }
})

test('SG-LOCK-1 lock / logout / pagehide (F.4): every purge reason clears the reader with no further request; pagehide is wired to PAGE_HIDE', async () => {
  for (const reason of Object.values(PURGE_REASONS)) {
    const fx = await buildIndex({ files: 3 })
    const us = createUnlockedVaultState({ revokeObjectUrl: () => {}, closeAllPreviewSessions: () => {} })
    const r = reader(fx, { unlockedState: us })
    assert.equal((await r.load(fx.mainHead)).status, 'READY', reason)
    us.purge(reason)
    const n = fx.t.requests.length
    assert.equal(await r.lookup(fx.nodes.get(fx.fileIds[0]), 'thumb'), null, reason)
    assert.equal(fx.t.requests.length, n, `${reason}: no request after purge`)
    assert.equal(r.stats().status, 'CLEARED', reason)
  }
  const vault = fs.readFileSync(new URL('../src/screens/Vault.jsx', import.meta.url), 'utf8')
  assert.match(vault, /addEventListener\('pagehide', onPageHide\)/)
  assert.match(vault, /PURGE_REASONS\.PAGE_HIDE/)
})

// ── source scans over every D-1 module ──────────────────────────────────────────────────────────────────────────
const D1_MODULES = [
  'src/lib/vaultPreviewIndexCodec.js', 'src/lib/vaultPreviewIndexConstants.js', 'src/lib/vaultPreviewIndexMerge.js', 'src/lib/vaultPreviewIndexObject.js',
  'src/lib/vaultPreviewIndexOrphans.js', 'src/lib/vaultPreviewIndexReader.js', 'src/lib/vaultPreviewIndexRouting.js', 'src/lib/vaultPreviewIndexTileLane.js',
  'src/lib/vaultPreviewIndexTiles.js', 'src/lib/vaultPreviewIndexWriter.js', 'src/lib/vaultDerivativeBackfill.js', 'src/lib/vaultDerivativeGenerate.js',
  'src/lib/vaultDerivativeRead.js', 'server/routes/vaultPreviewIndex.js', 'server/db/vaultPreviewIndexStore.js',
]
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
const sources = () => D1_MODULES.map((p) => [p, stripComments(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))])

test('SG-HTML-2 / SG-DIAG-1 / SG-PERSIST-1 source scans (B.8/F.4/F.5): no HTML sinks, no console logging, no browser persistence in D-1 modules', () => {
  for (const [p, src] of sources()) {
    assert.doesNotMatch(src, /\binnerHTML\b|\bouterHTML\b|\bsrcdoc\b|<object\b|<embed\b|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write/, `${p}: HTML sink`)
    assert.doesNotMatch(src, /\bconsole\.(log|info|warn|error|debug|trace|dir)\b/, `${p}: console`)
    assert.doesNotMatch(src, /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\.|navigator\.storage|getDirectory\(/, `${p}: browser persistence`)
  }
})

test('SG-LEAK-1 no server-visible plaintext (E.2/B.6): sealing a shard and a derivative sends no name, nodeId, user MIME, prefix or marker', async () => {
  const kek = await newKek()
  const t = createPreviewIndexFakeTransport()
  const nodeId = id22(), name = `holiday-${randomBytes(4).toString('hex')}.jpg`
  const bits = await routingBits(nodeId), prefix = prefixOf(bits, PREVIEW_INDEX_LIMITS.initialPrefixBits)
  const bytes = fakeJpeg()
  const d = await sealDerivative({ kek, bytes, mime: 'image/jpeg', transport: t })
  const entry = { kind: 'thumb', profile: 'vp1', blobRef: d.blobRef, contentId: d.contentId, sourceBlobRef: { formatVersion: 2, id: 'a'.repeat(48) }, mime: 'image/jpeg', width: 320, height: 240, plainSize: bytes.length, createdAtClient: 1 }
  const plaintext = await encodeShard({ schemaVersion: 1, treeId: TREE_ID, prefix, entries: new Map([[nodeId, [entry]]]) })
  await sealIndexObject({ kek, marker: INDEX_SHARD_MARKER, plaintext, buckets: PREVIEW_INDEX_LIMITS.shardPaddingBuckets, transport: t })
  assert.ok(t.requests.length >= 4)
  const wire = t.requests.map((q) => `${q.method} ${q.path} ${JSON.stringify(q.headers)} ${Buffer.from(q.body).toString('latin1')}`).join('\n')
  for (const secret of [nodeId, name, 'image/jpeg', INDEX_SHARD_MARKER, `"prefix":"${prefix}"`, '"kind":"thumb"', TREE_ID]) {
    assert.equal(wire.includes(secret), false, `wire leaks ${secret.slice(0, 24)}`)
  }
})

// ── coverage map ─────────────────────────────────────────────────────────────────────────────────────────────────
const CITED = {
  'tests/previewIndexCompatA.test.js': ['PI-COMPAT-1', 'PI-COMPAT-2', 'PI-COMPAT-4'],
  'tests/previewIndexUploads.test.js': ['PIU-1', 'PIU-7'],
  'tests/previewIndexApi.test.js': ['PI-API-5', 'PI-CAS-API-1', 'PI-CAS-API-6'],
  'tests/previewIndexStorageBudget.test.js': ['PIB-1', 'PIB-2', 'PIB-3', 'PIB-4', 'PIB-5', 'PIB-6', 'PIB-7', 'PIB-8', 'PIB-9', 'PIB-10'],
  'tests/previewIndexStorageBudgetPostgres.test.js': ['PIB-PG-1', 'PIB-PG-2', 'PIB-PG-3'],
  'tests/previewIndexWriterOff.test.js': ['PIW-OFF-1', 'PIW-OFF-5', 'PIW-OFF-E3'],
  'tests/helpers/previewIndexCasSpec.mjs': ['PI-CAS-3', 'PI-CAS-4', 'PI-CAS-6', 'PI-CAS-7', 'PI-CAS-8'],
  'tests/previewIndexCasPostgres.test.js': ['PI-PG-CAS-1', 'PI-PG-CAS-2', 'PI-PG-CAS-4', 'PI-PG-CAS-5'],
  'tests/previewIndexLifecycleGuards.test.js': ['LG-1', 'LG-5', 'LG-6'],
  'tests/previewIndexObject.test.js': ['PIO-3', 'PIO-4', 'PIO-7'],
  'tests/vaultDerivativeRead.test.js': ['PIDR-2', 'PIDR-4', 'PIDR-5'],
  'tests/previewIndexReader.test.js': ['PIRD-3', 'PIRD-4', 'PIRD-5', 'PIRD-6', 'PIRD-8', 'PIRD-9', 'PIRD-10'],
  'tests/previewIndexTiles.test.js': ['PIT-4', 'PIT-5', 'PIT-7'],
  'tests/previewIndexWriter.test.js': ['PIW-5', 'PIW-8', 'PIW-9', 'PIW-10', 'PIW-11', 'PIW-17'],
  'tests/previewIndexMerge.test.js': ['PIM-1', 'PIM-3', 'PIM-9'],
  'tests/previewIndexWriterBudget.test.js': ['PIWB-2', 'PIWB-3', 'PIWB-4'],
  'tests/previewIndexUploadFlow.test.js': ['PUF-5', 'PUF-SCREEN-2'],
  'tests/previewIndexLock.test.js': ['PIL-2'],
  'tests/vaultPreviewDiagnostics.test.js': ['PID-1', 'PID-2', 'PID-3', 'PID-4'],
}

test('SG-MAP-1 coverage map: every per-task test cited by this gate still exists under its id', () => {
  for (const [file, ids] of Object.entries(CITED)) {
    const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    for (const id of ids) assert.match(src, new RegExp(`test\\('${id.replace(/-/g, '\\-')} `), `${file} lost ${id}`)
  }
})
