// tests/vaultDerivativeRead.test.js — AEGIS Drive (IDEA1) · D-1 PR-B Task B.8 · verified encrypted derivative read
import test from 'node:test'
import assert from 'node:assert/strict'
import { readDerivative, imageDimensions } from '../src/lib/vaultDerivativeRead.js'
import { sealDerivative } from '../src/lib/vaultPreviewIndexObject.js'
import { createPreviewIndexFakeTransport } from './helpers/previewIndexFakeTransport.mjs'
import { newKek, fakeJpeg, fakeWebp } from './helpers/previewIndexFixture.mjs'

const SOURCE = { formatVersion: 2, id: 'd'.repeat(48) }
async function sealedEntry({ bytes = fakeJpeg(), mime = 'image/jpeg', entryMime = mime, width = 320, height = 240, kek = null } = {}) {
  const t = createPreviewIndexFakeTransport()
  kek ??= await newKek()
  const d = await sealDerivative({ kek, bytes, mime, transport: t })
  const entry = { kind: 'thumb', profile: 'vp1', blobRef: d.blobRef, contentId: d.contentId, sourceBlobRef: SOURCE, mime: entryMime, width, height, plainSize: bytes.length, createdAtClient: 1 }
  t.reset()
  let envelopeLookups = 0
  const envelopeOf = async (ref) => { envelopeLookups++; return t.envelopeOf(ref.id) }
  return { t, kek, entry, bytes, envelopeOf, lookups: () => envelopeLookups }
}
const read = (s, o = {}) => readDerivative({ kek: s.kek, entry: s.entry, envelopeOf: s.envelopeOf, fetchBytes: s.t.fetchBytes, ...o })

test('PIDR-1 happy path (JPEG and WebP): one envelope lookup, one derivative chunk GET, no original fetch, exact bytes', async () => {
  for (const [bytes, mime] of [[fakeJpeg(), 'image/jpeg'], [fakeWebp(), 'image/webp']]) {
    const s = await sealedEntry({ bytes, mime })
    const r = await read(s)
    assert.equal(r.ok, true, mime)
    assert.deepEqual(r.bytes, bytes)
    assert.deepEqual({ mime: r.mime, width: r.width, height: r.height }, { mime, width: 320, height: 240 })
    assert.equal(s.lookups(), 1)
    const gets = s.t.requests.map((q) => `${q.method} ${q.path}`)
    assert.deepEqual(gets, [`GET /api/vault/blobs/${s.entry.blobRef.id}/chunks/0`], 'ORIGINAL_BLOB_FETCH=0: only the derivative chunk')
    assert.equal(gets.some((g) => g.includes(SOURCE.id)), false)
  }
})

test('PIDR-2 contentId mismatch → rejected before any key use or fetch', async () => {
  const s = await sealedEntry()
  const r = await read(s, { entry: { ...s.entry, contentId: 'AAAAAAAAAAAAAAAAAAAAAA==' } })
  assert.deepEqual(r, { ok: false, reason: 'CONTENT_ID_MISMATCH' })
  assert.equal(s.t.requests.length, 0)
})

test('PIDR-3 authenticated metadata must match: empty name, exact MIME, exact plainSize', async () => {
  const s = await sealedEntry({ mime: 'image/jpeg', entryMime: 'image/webp' })
  assert.deepEqual(await read(s), { ok: false, reason: 'META_MISMATCH' })
  const s2 = await sealedEntry()
  assert.deepEqual(await read(s2, { entry: { ...s2.entry, plainSize: s2.entry.plainSize + 1 } }), { ok: false, reason: 'META_MISMATCH' })
})

test('PIDR-4 tampered or truncated ciphertext and wrong key → INTEGRITY, no partial bytes', async () => {
  const s = await sealedEntry()
  s.t.tamperNextChunk((b) => { const c = new Uint8Array(b); c[3] ^= 0x80; return c })
  assert.deepEqual(await read(s), { ok: false, reason: 'INTEGRITY' })
  s.t.tamperNextChunk((b) => b.subarray(0, 10))
  assert.deepEqual(await read(s), { ok: false, reason: 'INTEGRITY' })
  assert.deepEqual(await read(s, { kek: await newKek() }), { ok: false, reason: 'INTEGRITY' })
})

test('PIDR-5 signature: SVG/HTML/XML/PNG bodies labelled image/jpeg or image/webp are rejected (never rendered)', async () => {
  const te = new TextEncoder()
  for (const body of ['<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', '<!doctype html><script>alert(1)</script>', '<?xml version="1.0"?><x/>']) {
    for (const mime of ['image/jpeg', 'image/webp']) {
      const s = await sealedEntry({ bytes: te.encode(body), mime })
      assert.deepEqual(await read(s), { ok: false, reason: 'SIGNATURE' }, `${mime} ${body.slice(0, 10)}`)
    }
  }
  const s = await sealedEntry({ bytes: fakeWebp(), mime: 'image/jpeg' })
  assert.deepEqual(await read(s), { ok: false, reason: 'SIGNATURE' }, 'WebP bytes declared as JPEG')
})

test('PIDR-6 dimensions must equal the entry and stay inside vp1; size bound enforced before fetch', async () => {
  const s = await sealedEntry({ width: 321 })
  assert.deepEqual(await read(s), { ok: false, reason: 'BOUNDS' })
  const big = await sealedEntry({ bytes: fakeJpeg(600, 200), width: 600, height: 200 })
  assert.deepEqual(await read(big), { ok: false, reason: 'BOUNDS' })
  const huge = await sealedEntry()
  huge.t.reset()
  assert.deepEqual(await read(huge, { entry: { ...huge.entry, profile: 'vp1', plainSize: 300 * 1024 } }), { ok: false, reason: 'BOUNDS' })
  assert.equal(huge.t.requests.length, 0)
  assert.deepEqual(await read(huge, { entry: { ...huge.entry, profile: 'vp9' } }), { ok: false, reason: 'BOUNDS' }, 'unknown profile has no bounds → never read')
})

test('PIDR-7 abort and missing envelope', async () => {
  const s = await sealedEntry()
  const c = new AbortController(); c.abort()
  assert.deepEqual(await read(s, { signal: c.signal }), { ok: false, reason: 'ABORTED' })
  assert.deepEqual(await read(s, { envelopeOf: async () => null }), { ok: false, reason: 'MISSING' })
})

test('PIDR-8 imageDimensions parses JPEG SOF and WebP VP8X/VP8/VP8L; garbage → null', () => {
  assert.deepEqual(imageDimensions(fakeJpeg(512, 384), 'image/jpeg'), { width: 512, height: 384 })
  assert.deepEqual(imageDimensions(fakeWebp(500, 7), 'image/webp'), { width: 500, height: 7 })
  const vp8 = new Uint8Array(40); vp8.set([0x52, 0x49, 0x46, 0x46, 32, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, 20, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00])
  assert.deepEqual(imageDimensions(vp8, 'image/webp'), { width: 320, height: 240 })
  const vp8l = new Uint8Array(30); vp8l.set([0x52, 0x49, 0x46, 0x46, 22, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 10, 0, 0, 0, 0x2f])
  const w = 319, h = 239, v = w | (h << 14)
  vp8l.set([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff], 21)
  assert.deepEqual(imageDimensions(vp8l, 'image/webp'), { width: 320, height: 240 })
  assert.equal(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 'image/jpeg'), null)
  assert.equal(imageDimensions(new Uint8Array(10), 'image/webp'), null)
})
