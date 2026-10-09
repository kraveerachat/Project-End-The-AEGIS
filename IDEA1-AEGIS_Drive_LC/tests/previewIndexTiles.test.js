// tests/previewIndexTiles.test.js — AEGIS Drive (IDEA1) · D-1 PR-B Task B.9 · derivative-first Vault tiles
//
// PIT-1..5 exercise the tile helper with the real reader/derivative code over the TEST-ONLY fake transport.
// PIT-6 pins the VaultTreeScreen wiring (gated by previewIndexReadEnabled, derivative tried before the original path,
// Download/Open untouched). Browser rendering evidence belongs to Phase I (I.3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createPreviewIndexTiles, previewIndexKindFor } from '../src/lib/vaultPreviewIndexTiles.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'
import { buildIndex } from './helpers/previewIndexFixture.mjs'

const tiles = (fx, o = {}) => createPreviewIndexTiles({ kek: fx.kek, api: fx.api, fetchBytes: fx.t.fetchBytes, decodeImage: async () => ({ width: 320, height: 240, close() {} }), ...o })
const originalGets = (fx) => fx.chunkGets().filter((p) => [...fx.nodes.values()].some((n) => n.blobRef && p.includes(n.blobRef.id)))

test('PIT-1 kind mapping: image → thumb, video → poster, anything else → none', () => {
  assert.equal(previewIndexKindFor('image'), 'thumb')
  assert.equal(previewIndexKindFor('video'), 'poster')
  for (const k of ['gif', 'audio', 'text', 'pdf', null, undefined]) assert.equal(previewIndexKindFor(k), null)
})

test('PIT-2 no index: exactly one head lookup per load, every tile returns null (original path), no other request', async () => {
  const fx = await buildIndex({ files: 3 })
  fx.api.getPreviewIndexHead = async () => { fx.calls.head++; return null }
  const t = tiles(fx)
  t.load(fx.mainHead)
  for (const id of fx.fileIds) assert.equal(await t.tryTile(fx.nodes.get(id), 'image', { index: fx.mainHead.index }), null)
  assert.equal(fx.calls.head, 1); assert.equal(fx.calls.envelopes, 0); assert.equal(fx.chunkGets().length, 0)
})

test('PIT-3 valid index: tiles come from the verified derivative with zero original-blob fetches', async () => {
  const fx = await buildIndex({ files: 6, kinds: ['thumb', 'poster'] })
  const t = tiles(fx)
  t.load(fx.mainHead)
  for (const id of fx.fileIds) {
    const r = await t.tryTile(fx.nodes.get(id), 'image', { index: fx.mainHead.index })
    assert.deepEqual(r, { width: 320, height: 240, bytes: fx.derivs.get(`${id}:thumb`).bytes, mime: 'image/jpeg' })
    const p = await t.tryTile(fx.nodes.get(id), 'video', { index: fx.mainHead.index })
    assert.deepEqual(p.bytes, fx.derivs.get(`${id}:poster`).bytes)
  }
  assert.deepEqual(originalGets(fx), [], 'ORIGINAL_BLOB_FETCH=0')
  assert.equal(fx.calls.head, 1)
})

test('PIT-4 any derivative failure returns null (original path) and is counted; other tiles unaffected', async () => {
  const fx = await buildIndex({ files: 2 })
  const counts = new Map()
  const t = tiles(fx, { diagnostics: { count: (n) => counts.set(n, (counts.get(n) ?? 0) + 1) } })
  t.load(fx.mainHead)
  const [a, b] = fx.fileIds
  await t.tryTile(fx.nodes.get(b), 'image', { index: fx.mainHead.index }) // warm shards so the next chunk GET is the derivative
  fx.t.tamperNextChunk((bytes) => { const c = new Uint8Array(bytes); c[0] ^= 1; return c })
  assert.equal(await t.tryTile(fx.nodes.get(a), 'image', { index: fx.mainHead.index }), null)
  assert.ok([...counts.keys()].some((k) => k.startsWith('derivative.')), JSON.stringify([...counts]))
  assert.ok(await t.tryTile(fx.nodes.get(b), 'image', { index: fx.mainHead.index }))
  assert.equal(await t.tryTile(fx.nodes.get(a), 'audio', { index: fx.mainHead.index }), null)
})

test('PIT-5 purge clears everything; later tiles return null without requests', async () => {
  const fx = await buildIndex({ files: 2 })
  const us = createUnlockedVaultState({ revokeObjectUrl: () => {}, closeAllPreviewSessions: () => {} })
  const t = tiles(fx, { unlockedState: us })
  t.load(fx.mainHead)
  assert.ok(await t.tryTile(fx.nodes.get(fx.fileIds[0]), 'image', { index: fx.mainHead.index }))
  us.purge('PAGE_HIDE')
  const before = fx.t.requests.length
  assert.equal(await t.tryTile(fx.nodes.get(fx.fileIds[1]), 'image', { index: fx.mainHead.index }), null)
  assert.equal(fx.t.requests.length, before)
})

test('PIT-7 source replacement during derivative decrypt falls back before publishing bytes', async () => {
  const fx = await buildIndex({ files: 1 })
  const id = fx.fileIds[0], node = fx.nodes.get(id)
  let release, entered
  const gate = new Promise((resolve) => { release = resolve })
  const started = new Promise((resolve) => { entered = resolve })
  const fetch = fx.t.fetchBytes
  const t = tiles(fx, { fetchBytes: async (path, opts) => {
    if (path.includes(fx.derivs.get(`${id}:thumb`).blobRef.id)) { entered(); await gate }
    return fetch(path, opts)
  } })
  await t.load(fx.mainHead)
  const pending = t.tryTile(node, 'image', { index: fx.mainHead.index })
  await started
  fx.nodes.set(id, { ...node, blobRef: { formatVersion: 2, id: 'f'.repeat(48) } })
  release()
  assert.equal(await pending, null)
})

test('PIT-6 VaultTreeScreen wiring: gated by previewIndexReadEnabled, tried before the original path, Download/Open untouched', () => {
  const src = fs.readFileSync(new URL('../src/screens/VaultTreeScreen.jsx', import.meta.url), 'utf8')
  assert.match(src, /import \{ createPreviewIndexTiles \} from '\.\.\/lib\/vaultPreviewIndexTiles\.js'/)
  assert.match(src, /import \{ createDerivativeFirstScheduler \} from '\.\.\/lib\/vaultPreviewIndexTileLane\.js'/)
  assert.match(src, /const previewIndexEnabled = mediaEnabled && treeState\?\.flags\?\.previewIndexReadEnabled === true/)
  assert.match(src, /previewIndexEnabled && unlockedState && kek \? createPreviewIndexTiles\(\{ kek, unlockedState, diagnostics: previewCounters \}\) : null/) // PR-D adds only the counters
  const load = src.indexOf('load: async (key, { signal } = {}) => {')
  const staged = src.indexOf('combined?.take(key)', load)
  const original = src.indexOf("const blob = mediaBlobIndexRef.current.get(refKey(node.blobRef))", load)
  assert.ok(load > 0 && staged > load && original > staged, 'verified derivative result is consumed before original work')
  assert.match(src.slice(staged, original), /if \(fromIndex\) return fromIndex/)
  assert.match(src, /maxConcurrentJobs: PREVIEW_INDEX_LIMITS\.derivativeLaneConcurrency/)
  assert.match(src, /getCurrentSourceBlobId: \(key\) =>/)
  assert.match(src, /scheduler\.reconcileVisible\?\.\(visible\)/)
  assert.match(src, /tryTile: async \(key, \{ signal \}\) => previewTilesRef\.current\?\.tryTile/)
  const download = src.slice(src.indexOf('export async function treeDownloadEntry'), src.indexOf('export async function treeDownloadEntry') + 3000)
  assert.equal(/previewTiles|PreviewIndex/.test(download), false, 'download path does not consult the preview index')
})
