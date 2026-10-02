// tests/previewIndexObject.test.js — AEGIS Drive (IDEA1) · D-1 PR-B Task B.6 · index objects + derivatives over the unchanged V2 envelope
//
// Uses tests/helpers/previewIndexFakeTransport.mjs (TEST HARNESS ONLY — PR-B ships no server write route).
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { sealIndexObject, sealDerivative, openIndexObject } from '../src/lib/vaultPreviewIndexObject.js'
import { INDEX_ROOT_MARKER, INDEX_SHARD_MARKER, PREVIEW_INDEX_LIMITS, PREVIEW_INDEX_UPLOAD_ROUTE_BASE } from '../src/lib/vaultPreviewIndexConstants.js'
import { decryptVaultV2Meta } from '../src/lib/vaultChunkCrypto.js'
import { createPreviewIndexFakeTransport } from './helpers/previewIndexFakeTransport.mjs'

const subtle = globalThis.crypto.subtle
const newKek = () => subtle.importKey('raw', randomBytes(32), 'AES-GCM', false, ['encrypt', 'decrypt'])
const te = new TextEncoder()
const NODE = 'N'.repeat(22)
const secretPlain = () => te.encode(`{"entries":[["${NODE}",[]]],"prefix":"101000","note":"quarterly-board-minutes.pdf"}`)

async function sealed(t, kek, plaintext = secretPlain(), marker = INDEX_SHARD_MARKER) {
  return sealIndexObject({ kek, marker, plaintext, buckets: PREVIEW_INDEX_LIMITS.shardPaddingBuckets, transport: t })
}
const open = (t, kek, s, o = {}) => openIndexObject({
  kek, envelope: t.envelopeOf(s.blobRef.id), expected: { blobRef: s.blobRef, contentId: s.contentId }, marker: INDEX_SHARD_MARKER,
  maxPaddedBytes: PREVIEW_INDEX_LIMITS.shardPaddingBuckets.at(-1), fetchBytes: t.fetchBytes, ...o,
})

test('PIO-1 seal: smallest bucket, one chunk via the preview-index route base, strict create body, nothing secret on the wire', async () => {
  const t = createPreviewIndexFakeTransport(), kek = await newKek()
  const s = await sealed(t, kek)
  assert.equal(s.blobRef.formatVersion, 2)
  assert.equal(s.paddedBytes, 16 * 1024)
  assert.match(s.contentId, /^[A-Za-z0-9+/]{21}[AQgw]==$/)
  const env = t.envelopeOf(s.blobRef.id)
  assert.equal(env.chunkCount, 1)
  assert.equal(s.cipherBytes, env.size)
  assert.equal(env.size, 16 * 1024 + 16)
  const create = t.requests.find((r) => r.method === 'POST' && r.path === PREVIEW_INDEX_UPLOAD_ROUTE_BASE)
  assert.ok(create, 'uploaded through the preview-index route base')
  assert.deepEqual(Object.keys(JSON.parse(new TextDecoder().decode(create.body))).sort(), ['chunkCount', 'chunkSize', 'ciphertextSize', 'contentIdB64', 'formatVersion', 'metaB64', 'metaIvB64', 'wrapIvB64', 'wrappedDekB64'])
  for (const r of t.requests) {
    const hay = Buffer.concat([Buffer.from(r.path), Buffer.from(JSON.stringify(r.headers)), Buffer.from(r.body)]).toString('latin1')
    for (const needle of [INDEX_SHARD_MARKER, NODE, '101000', 'quarterly-board-minutes']) assert.equal(hay.includes(needle), false, `${needle} leaked in ${r.method} ${r.path}`)
  }
  assert.deepEqual(await decryptVaultV2Meta(kek, env), { name: '', type: INDEX_SHARD_MARKER, plainSize: 16 * 1024 })
})

test('PIO-2 random DEK and content id per seal (no dedup); open round-trips the exact plaintext', async () => {
  const t = createPreviewIndexFakeTransport(), kek = await newKek()
  const a = await sealed(t, kek), b = await sealed(t, kek)
  const ea = t.envelopeOf(a.blobRef.id), eb = t.envelopeOf(b.blobRef.id)
  assert.notEqual(ea.wrappedDekB64, eb.wrappedDekB64)
  assert.notEqual(a.contentId, b.contentId)
  const r = await open(t, kek, a)
  assert.equal(r.ok, true)
  assert.deepEqual(r.plaintext, secretPlain())
})

test('PIO-3 contentId mismatch is rejected before any decrypt or chunk fetch', async () => {
  const t = createPreviewIndexFakeTransport(), kek = await newKek()
  const s = await sealed(t, kek)
  t.reset()
  let unwraps = 0
  const spyKek = new Proxy({}, { get: () => { unwraps++; return undefined } })
  const r = await open(t, spyKek, { ...s, contentId: 'AAAAAAAAAAAAAAAAAAAAAA==' })
  assert.deepEqual(r, { ok: false, reason: 'CONTENT_ID_MISMATCH' })
  assert.equal(t.requests.length, 0, 'no chunk fetch')
  assert.equal(unwraps, 0, 'no key use')
  const r2 = await open(t, kek, s, { envelope: { ...t.envelopeOf(s.blobRef.id), id: 'f'.repeat(48) } })
  assert.equal(r2.reason, 'CONTENT_ID_MISMATCH', 'envelope for another blob id is rejected too')
  assert.equal((await open(t, kek, s, { envelope: null })).reason, 'MISSING')
})

test('PIO-4 wrong KEK, tampered chunk, bad padding → INTEGRITY with no plaintext', async () => {
  const t = createPreviewIndexFakeTransport(), kek = await newKek()
  const s = await sealed(t, kek)
  const wrong = await open(t, await newKek(), s)
  assert.deepEqual(wrong, { ok: false, reason: 'INTEGRITY' })
  t.tamperNextChunk((b) => { const c = new Uint8Array(b); c[10] ^= 1; return c })
  assert.deepEqual(await open(t, kek, s), { ok: false, reason: 'INTEGRITY' })
  t.tamperNextChunk((b) => b.subarray(0, b.length - 1))
  assert.deepEqual(await open(t, kek, s), { ok: false, reason: 'INTEGRITY' })
})

test('PIO-5 marker binding: a shard opened as root, or a user-file envelope, is rejected', async () => {
  const t = createPreviewIndexFakeTransport(), kek = await newKek()
  const s = await sealed(t, kek)
  assert.deepEqual(await open(t, kek, s, { marker: INDEX_ROOT_MARKER }), { ok: false, reason: 'MARKER_MISMATCH' })
  const d = await sealDerivative({ kek, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]), mime: 'image/jpeg', transport: t })
  const asIndex = await openIndexObject({ kek, envelope: t.envelopeOf(d.blobRef.id), expected: { blobRef: d.blobRef, contentId: d.contentId }, marker: INDEX_SHARD_MARKER, maxPaddedBytes: 300_000, fetchBytes: t.fetchBytes })
  assert.equal(asIndex.reason, 'MARKER_MISMATCH')
})

test('PIO-6 bounds: oversize envelope or multi-chunk rejected before fetch; abort → ABORTED', async () => {
  const t = createPreviewIndexFakeTransport(), kek = await newKek()
  const s = await sealed(t, kek)
  t.reset()
  assert.deepEqual(await open(t, kek, s, { maxPaddedBytes: 4096 }), { ok: false, reason: 'BOUNDS' })
  assert.deepEqual(await open(t, kek, s, { envelope: { ...t.envelopeOf(s.blobRef.id), chunkCount: 2 } }), { ok: false, reason: 'BOUNDS' })
  assert.equal(t.requests.length, 0)
  const ctrl = new AbortController(); ctrl.abort()
  assert.deepEqual(await open(t, kek, s, { signal: ctrl.signal }), { ok: false, reason: 'ABORTED' })
  await assert.rejects(sealIndexObject({ kek, marker: INDEX_SHARD_MARKER, plaintext: new Uint8Array(300 * 1024), buckets: PREVIEW_INDEX_LIMITS.shardPaddingBuckets, transport: t }), /LIMIT|BOUNDS|bucket/i)
  await assert.rejects(sealIndexObject({ kek, marker: 'image/jpeg', plaintext: secretPlain(), buckets: PREVIEW_INDEX_LIMITS.shardPaddingBuckets, transport: t }), /marker/)
})

test('PIO-7 sealDerivative: meta { name: "", type: mime, plainSize }, only image/webp|image/jpeg, never padded', async () => {
  const t = createPreviewIndexFakeTransport(), kek = await newKek()
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9, 9])
  const d = await sealDerivative({ kek, bytes, mime: 'image/webp', transport: t })
  assert.equal(d.plainSize, bytes.length)
  assert.deepEqual(await decryptVaultV2Meta(kek, t.envelopeOf(d.blobRef.id)), { name: '', type: 'image/webp', plainSize: bytes.length })
  assert.equal(t.envelopeOf(d.blobRef.id).size, bytes.length + 16)
  for (const mime of ['image/svg+xml', 'text/html', 'application/xml', 'image/png', '']) {
    await assert.rejects(sealDerivative({ kek, bytes, mime, transport: t }), /mime/i, mime)
  }
})
