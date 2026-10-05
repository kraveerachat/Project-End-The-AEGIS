// tests/vaultAuthenticateEntry.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 5
//
// spec §9/§11: bulk ZIP pre-flight authenticates every Vault V2 envelope (unwrap DEK + decrypt metadata
// with its AAD) before the archive's createWritable(), from the in-memory blob record only.
// authenticateVaultV2Entry is that half of prepareVaultV2Download, extracted behaviour-preservingly:
//   AUTH-1 returns { ok:true, plainSize } and never a DEK
//   AUTH-2 the authenticated meta.plainSize is returned EXACTLY — no coercion, no default (Fix A)
//   AUTH-3 wrong KEK / tampered metadata → { ok:false, reason:'wrong-key' } (no 'integrity' here, M-2)
//   AUTH-4 no network
//   AUTH-5 exactly one raw AES-GCM key import per call (M-3, counted on crypto.subtle, no ESM spying)
import test from 'node:test'
import assert from 'node:assert/strict'

import { authenticateVaultV2Entry } from '../src/lib/vaultChunkedDownload.js'
import { metadataAad, newContentId, planVaultChunks } from '../src/lib/vaultChunkCrypto.js'

const subtle = globalThis.crypto.subtle
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const kekOf = (seed = 7) => subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])

/** A real V2 envelope whose encrypted metadata is exactly `meta` (so tests can control plainSize's type). */
async function envelopeWithMeta(kek, meta, { chunkCount = 1 } = {}) {
  const contentId = newContentId()
  const dekRaw = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const dek = await subtle.importKey('raw', dekRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const metaIv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const metaCipher = await subtle.encrypt(
    { name: 'AES-GCM', iv: metaIv, additionalData: metadataAad(contentId, chunkCount) }, dek,
    new TextEncoder().encode(JSON.stringify(meta)),
  )
  const wrapIv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const wrapped = await subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, kek, dekRaw)
  const plan = planVaultChunks(typeof meta.plainSize === 'number' ? meta.plainSize : 0, 4096)
  return Object.freeze({
    id: 'b'.repeat(24), formatVersion: 2, size: plan.ciphertextSize, chunkSize: plan.chunkSize, chunkCount,
    contentIdB64: b64(contentId), wrappedDekB64: b64(new Uint8Array(wrapped)), wrapIvB64: b64(wrapIv),
    metaIvB64: b64(metaIv), metaB64: b64(new Uint8Array(metaCipher)),
  })
}

test('AUTH-1 a valid envelope authenticates to { ok:true, plainSize } with no DEK', async () => {
  const kek = await kekOf()
  const blob = await envelopeWithMeta(kek, { name: 'a.bin', type: '', plainSize: 123 })
  const res = await authenticateVaultV2Entry({ kek, blob })
  assert.deepEqual(Object.keys(res).sort(), ['ok', 'plainSize'])
  assert.equal(res.ok, true)
  assert.equal(res.plainSize, 123)
  assert.equal(typeof res.plainSize, 'number')
  assert.equal('dek' in res, false)
})

test('AUTH-2 the authenticated plainSize is preserved exactly: "123" stays a string, missing stays undefined', async () => {
  const kek = await kekOf()
  const str = await authenticateVaultV2Entry({ kek, blob: await envelopeWithMeta(kek, { name: 'a', plainSize: '123' }) })
  assert.equal(str.ok, true)
  assert.equal(str.plainSize, '123')
  assert.equal(typeof str.plainSize, 'string')
  const missing = await authenticateVaultV2Entry({ kek, blob: await envelopeWithMeta(kek, { name: 'a' }) })
  assert.equal(missing.ok, true)
  assert.equal(missing.plainSize, undefined)
  const neg = await authenticateVaultV2Entry({ kek, blob: await envelopeWithMeta(kek, { name: 'a', plainSize: -1 }) })
  assert.equal(neg.plainSize, -1, 'semantic validation belongs to pre-flight, not this helper')
})

test('AUTH-3 wrong KEK or tampered metadata → wrong-key only', async () => {
  const kek = await kekOf()
  const blob = await envelopeWithMeta(kek, { name: 'a', plainSize: 5 })
  assert.deepEqual(await authenticateVaultV2Entry({ kek: await kekOf(9), blob }), { ok: false, reason: 'wrong-key' })
  const meta = Buffer.from(blob.metaB64, 'base64')
  meta[0] ^= 0xff
  assert.deepEqual(await authenticateVaultV2Entry({ kek, blob: { ...blob, metaB64: b64(meta) } }), { ok: false, reason: 'wrong-key' })
  const otherChunks = { ...blob, chunkCount: 2 } // AAD binds chunkCount
  assert.deepEqual(await authenticateVaultV2Entry({ kek, blob: otherChunks }), { ok: false, reason: 'wrong-key' })
})

test('AUTH-4 authentication reads only the in-memory record: zero fetches', async (t) => {
  const kek = await kekOf()
  const blob = await envelopeWithMeta(kek, { name: 'a', plainSize: 1 })
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network expected') })
  assert.equal((await authenticateVaultV2Entry({ kek, blob })).ok, true)
  assert.equal(fetchMock.mock.callCount(), 0)
})

test('AUTH-5 exactly one raw AES-GCM key import per call', async (t) => {
  const kek = await kekOf()
  const blob = await envelopeWithMeta(kek, { name: 'a', plainSize: 1 })
  const imp = t.mock.method(subtle, 'importKey')
  await authenticateVaultV2Entry({ kek, blob })
  const raw = imp.mock.calls.filter((c) => c.arguments[0] === 'raw')
  assert.equal(raw.length, 1)
  const alg = raw[0].arguments[2]
  assert.equal(typeof alg === 'string' ? alg : alg.name, 'AES-GCM')
})
