// tests/vaultTreeManifestCrypto.test.js — AEGIS Drive (IDEA1) · PR #157 Task 1.5 · encrypted manifest revisions
//
// canonical → pad → AES-GCM ภายใต้ Manifest DEK ใหม่ (ห่อด้วย TRK) และทางกลับที่ fail closed ทุกจุด
import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptManifestRevision, decryptManifestRevision, ManifestCryptoError } from '../src/lib/vaultTreeManifestCrypto.js'
import { generateTrkBytes, wrapTrkSlots, unwrapTrkSlots, rewrapTrkSlots } from '../src/lib/vaultTreeKeys.js'
import { generateManifestDekBytes, wrapManifestDek } from '../src/lib/vaultTreeKeys.js'
import { createGenesisManifest, validateManifest } from '../src/lib/vaultTreeManifest.js'
import { canonicalEncode, canonicalDecode, padToBucket, CanonicalError } from '../src/lib/vaultTreeCanonical.js'
import { manifestCiphertextAad } from '../src/lib/vaultTreeAad.js'
import { treeLimitsFrom, PADDING_BUCKETS, VAULT_TREE_CLIENT_LIMITS } from '../src/lib/vaultTreeLimits.js'
import { v1GoldenManifest } from './helpers/vaultManifestV1GoldenFixture.mjs'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { b64ToBytes, bytesToB64 } from '../src/lib/vaultCrypto.js'

const subtle = globalThis.crypto.subtle
const ID = (n) => String(n).padStart(22, 'A')
const NOW = 1_700_000_000_000
const LIMITS = treeLimitsFrom({ maxNodes: 2_000, maxDepth: 32, maxNameBytes: 120 })
const TRK_CTX = { ownerScopeId: ID(1), treeId: ID(900), protocolVersion: 1, keyEnvelopeVersion: 1 }
const ctxFor = (m) => ({ treeId: m.treeId, revisionId: m.revisionId, baseRevisionId: m.baseRevisionId, generation: m.generation, manifestSchemaVersion: m.schemaVersion })

async function fakeKek(seed = 7) { return subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']) }
async function trkFor(kek) { return (await unwrapTrkSlots(kek, await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX), TRK_CTX)).trk }

function bigManifest(n = 1_000, generation = 2) {
  const m = createGenesisManifest({ treeId: ID(900), rootNodeId: ID(0), revisionId: ID(901), now: NOW })
  m.generation = generation; m.baseRevisionId = generation === 1 ? null : ID(902)
  for (let k = 1; k < n; k++) {
    m.nodes.set(ID(k), { nodeId: ID(k), kind: 'file', parentNodeId: ID(0), name: `file-${k}-ไฟล์`, createdAtClient: NOW, modifiedAtClient: NOW, lifecycle: { state: 'active' }, blobRef: { formatVersion: 2, id: 'b' + k }, mediaType: 'image/png', plainSize: k })
  }
  return m
}
const flip = (b64, i = 5) => { const u = b64ToBytes(b64); u[i] ^= 1; return bytesToB64(u) }
const deep = (m) => ({ ...m, nodes: new Map([...m.nodes].map(([k, v]) => [k, structuredClone(v)])) })

test('MC-1 round trip equals the input for genesis and a 1 000-node manifest', async () => {
  const trk = await trkFor(await fakeKek())
  for (const m of [createGenesisManifest({ treeId: ID(900), rootNodeId: ID(0), revisionId: ID(901), now: NOW }), bigManifest(1_000)]) {
    const env = await encryptManifestRevision(trk, deep(m), ctxFor(m), LIMITS)
    assert.ok(env.ciphertext instanceof Uint8Array)
    assert.equal(typeof env.ivB64, 'string'); assert.equal(typeof env.wrappedManifestDekB64, 'string'); assert.equal(typeof env.wrapIvB64, 'string')
    const back = await decryptManifestRevision(trk, env, ctxFor(m), LIMITS)
    assert.deepEqual([...back.nodes.keys()].sort(), [...m.nodes.keys()].sort())
    assert.deepEqual(back.nodes.get(ID(0)), m.nodes.get(ID(0)))
    assert.equal(back.generation, m.generation); assert.equal(back.treeId, m.treeId)
  }
})

test('MC-2 wrong TRK, tampered ciphertext or IV → throws; no partial manifest is ever returned', async () => {
  const kek = await fakeKek(); const trk = await trkFor(kek); const other = await trkFor(await fakeKek(9))
  const m = bigManifest(50)
  const env = await encryptManifestRevision(trk, deep(m), ctxFor(m), LIMITS)
  const fails = (code) => (e) => e instanceof ManifestCryptoError && e.code === code
  await assert.rejects(decryptManifestRevision(other, env, ctxFor(m), LIMITS), fails('MANIFEST_DEK_UNRECOVERABLE'))
  const badCt = { ...env, ciphertext: new Uint8Array(env.ciphertext) }; badCt.ciphertext[100] ^= 1
  await assert.rejects(decryptManifestRevision(trk, badCt, ctxFor(m), LIMITS), fails('MANIFEST_UNAUTHENTIC'))
  await assert.rejects(decryptManifestRevision(trk, { ...env, ivB64: flip(env.ivB64) }, ctxFor(m), LIMITS), fails('MANIFEST_UNAUTHENTIC'))
  // schema/graph failure after successful decryption is also fail-closed (a manifest that decrypts but is invalid)
  const bad = bigManifest(5); bad.nodes.get(ID(2)).parentNodeId = ID(2)
  const badEnv = await encryptManifestRevision(trk, deep(bad), ctxFor(bad), LIMITS, { skipValidation: true })
  await assert.rejects(decryptManifestRevision(trk, badEnv, ctxFor(bad), LIMITS), (e) => e.code === 'MANIFEST_INVALID' && e.cause?.name === 'ManifestError' && e.cause.code === 'PARENT_NOT_FOLDER')
})

test('MC-3 AAD substitution across tree/generation/revision/base/schema/padded length fails', async () => {
  const trk = await trkFor(await fakeKek())
  const m = bigManifest(20, 3)
  const ctx = ctxFor(m)
  const env = await encryptManifestRevision(trk, deep(m), ctx, LIMITS)
  const rejectsWith = async (c) => assert.rejects(decryptManifestRevision(trk, env, c, LIMITS), (e) => e instanceof ManifestCryptoError)
  await rejectsWith({ ...ctx, treeId: ID(777) })
  await rejectsWith({ ...ctx, generation: 4 })
  await rejectsWith({ ...ctx, revisionId: ID(778) })
  await rejectsWith({ ...ctx, baseRevisionId: ID(779) })
  await rejectsWith({ ...ctx, manifestSchemaVersion: 2 })
  // padded length is part of the ciphertext AAD: shrinking or growing the ciphertext bucket fails authentication
  const shorter = { ...env, ciphertext: env.ciphertext.subarray(0, env.ciphertext.length - 4096) }
  await assert.rejects(decryptManifestRevision(trk, shorter, ctx, LIMITS), (e) => e instanceof ManifestCryptoError)
  await decryptManifestRevision(trk, env, ctx, LIMITS)
})

test('MC-4 IV freshness: 500 encryptions of one manifest → 500 distinct IVs and wrap IVs and wrapped DEKs', async () => {
  const trk = await trkFor(await fakeKek())
  const m = bigManifest(3)
  const ivs = new Set(), wraps = new Set(), deks = new Set()
  for (let i = 0; i < 500; i++) {
    const env = await encryptManifestRevision(trk, deep(m), ctxFor(m), LIMITS)
    ivs.add(env.ivB64); wraps.add(env.wrapIvB64); deks.add(env.wrappedManifestDekB64)
  }
  assert.equal(ivs.size, 500); assert.equal(wraps.size, 500); assert.equal(deks.size, 500)
})

test('MC-5 ciphertext length = padded bucket + 16; equal buckets give equal lengths', async () => {
  const trk = await trkFor(await fakeKek())
  const a = bigManifest(10), b = bigManifest(12)
  const ea = await encryptManifestRevision(trk, deep(a), ctxFor(a), LIMITS)
  const eb = await encryptManifestRevision(trk, deep(b), ctxFor(b), LIMITS)
  assert.equal(ea.ciphertext.length, ea.paddedLength + 16)
  assert.ok(PADDING_BUCKETS.includes(ea.paddedLength))
  assert.equal(ea.ciphertext.length, eb.ciphertext.length)
  assert.equal(ea.paddedLength, eb.paddedLength)
})

test('MC-LIMIT-1 oversized ciphertext is rejected before any decrypt attempt', async () => {
  const trk = await trkFor(await fakeKek())
  const m = bigManifest(3)
  const env = await encryptManifestRevision(trk, deep(m), ctxFor(m), LIMITS)
  const tiny = treeLimitsFrom({ maxCiphertextBytes: 1024 })
  let unwrapCalls = 0
  const spyTrk = new Proxy(trk, { get(t, p) { if (p === 'algorithm') unwrapCalls++; return Reflect.get(t, p) } })
  await assert.rejects(decryptManifestRevision(spyTrk, env, ctxFor(m), tiny), (e) => e.code === 'LIMIT_CIPHERTEXT_BYTES')
  assert.equal(unwrapCalls, 0)
  await assert.rejects(encryptManifestRevision(trk, deep(bigManifest(400)), ctxFor(m), treeLimitsFrom({ maxDecodedBytes: 4096 })), (e) => e.code === 'LIMIT_DECODED_BYTES')
})

test('MC-6 passphrase rotation end to end: only the TRK slots change; every retained revision stays byte-identical and decryptable', async () => {
  const kek1 = await fakeKek(1), kek2 = await fakeKek(2)
  const slots1 = await wrapTrkSlots(kek1, generateTrkBytes(), TRK_CTX)
  const trk1 = (await unwrapTrkSlots(kek1, slots1, TRK_CTX)).trk
  const revisions = []
  for (let g = 1; g <= 3; g++) {
    const m = bigManifest(20 + g, g)
    m.revisionId = ID(910 + g); m.baseRevisionId = g === 1 ? null : ID(910 + g - 1)
    const env = await encryptManifestRevision(trk1, deep(m), ctxFor(m), LIMITS)
    revisions.push({ ctx: ctxFor(m), env, snapshot: JSON.stringify({ ...env, ciphertext: bytesToB64(env.ciphertext) }) })
  }
  const slots2 = await rewrapTrkSlots(kek1, kek2, slots1, TRK_CTX)
  const trk2 = (await unwrapTrkSlots(kek2, slots2, TRK_CTX)).trk
  for (const r of revisions) {
    assert.equal(JSON.stringify({ ...r.env, ciphertext: bytesToB64(r.env.ciphertext) }), r.snapshot) // untouched
    const back = await decryptManifestRevision(trk2, r.env, r.ctx, LIMITS)
    assert.equal(back.generation, r.ctx.generation)
  }
  assert.notEqual(slots2.primary.wrappedTrkB64, slots1.primary.wrappedTrkB64)
})

test('MC-7 degraded key envelope still decrypts; two bad slots decrypt nothing', async () => {
  const kek = await fakeKek()
  const slots = await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX)
  const trk = (await unwrapTrkSlots(kek, slots, TRK_CTX)).trk
  const m = bigManifest(8)
  const env = await encryptManifestRevision(trk, deep(m), ctxFor(m), LIMITS)
  const degraded = await unwrapTrkSlots(kek, { ...slots, primary: { ...slots.primary, wrappedTrkB64: flip(slots.primary.wrappedTrkB64) } }, TRK_CTX)
  assert.equal(degraded.status, 'DEGRADED')
  await decryptManifestRevision(degraded.trk, env, ctxFor(m), LIMITS)
  await assert.rejects(unwrapTrkSlots(kek, { primary: { ...slots.primary, wrappedTrkB64: flip(slots.primary.wrappedTrkB64) }, recovery: { ...slots.recovery, wrappedTrkB64: flip(slots.recovery.wrappedTrkB64) } }, TRK_CTX), (e) => e.code === 'TRK_UNRECOVERABLE')
})

// ── Unified Preview P2a: v1 bytes frozen, v2 canonical form, AAD binds the schema version ─────

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/vaultManifestV1Golden.json', import.meta.url), 'utf8'))
const CID = 'AAECAwQFBgcICQoLDA0ODw=='
const preview = (kind, src, over = {}) => ({
  kind, profile: 'vp1', blobRef: { formatVersion: 2, id: `d-${kind}-${src.id}` }, contentId: CID, sourceBlobRef: { ...src },
  mime: kind === 'motion' || kind === 'proxy' ? 'video/mp4' : 'image/webp', width: 480, height: 270, plainSize: 40_000, createdAtClient: NOW,
  ...(kind === 'motion' || kind === 'proxy' ? { durationMs: 6000 } : {}), ...over,
})
function v2Manifest(n = 50, kinds = ['thumb', 'poster', 'motion']) {
  const m = bigManifest(n)
  m.schemaVersion = 2
  for (const node of m.nodes.values()) {
    if (node.kind !== 'file') continue
    node.contentFormat = 'mp4'
    node.previews = kinds.map((k) => preview(k, node.blobRef))
  }
  return m
}
/** the same manifest built with every object's keys inserted in reverse order */
const reverseKeys = (v) => {
  if (v instanceof Map) return new Map([...v].reverse().map(([k, x]) => [k, reverseKeys(x)]))
  if (Array.isArray(v)) return v.map(reverseKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
  return v
}

test('MC-V1-GOLDEN v1 canonical bytes equal the vector frozen at origin/main 07633c93, and decode back', () => {
  const golden = new Uint8Array(Buffer.from(GOLDEN.canonicalB64, 'base64'))
  assert.equal(golden.length, GOLDEN.byteLength)
  assert.equal(createHash('sha256').update(golden).digest('hex'), GOLDEN.sha256Hex)
  const bytes = canonicalEncode(v1GoldenManifest())
  assert.equal(bytes.length, golden.length)
  assert.equal(Buffer.compare(Buffer.from(bytes), Buffer.from(golden)), 0, 'v1 canonical encoding changed — existing revisions would no longer match')
  assert.equal(Buffer.compare(Buffer.from(canonicalEncode(reverseKeys(v1GoldenManifest()))), Buffer.from(golden)), 0, 'key insertion order must not matter')
  const back = canonicalDecode(golden)
  assert.equal(back.schemaVersion, 1)
  assert.equal(validateManifest(back).ok, true)
  assert.deepEqual(back, v1GoldenManifest())
  assert.equal(Buffer.compare(Buffer.from(canonicalEncode(back)), Buffer.from(golden)), 0)
})

test('MC-V2-1 v2 canonical round trip deep-equals the input; encoding ignores key insertion order', () => {
  const m = v2Manifest(40, ['thumb', 'poster', 'motion', 'proxy'])
  validateManifest(m, LIMITS)
  const bytes = canonicalEncode(m, LIMITS)
  const back = canonicalDecode(bytes, LIMITS)
  const sorted = { ...m, nodes: new Map([...m.nodes].sort(([a], [b]) => (a < b ? -1 : 1))) }
  assert.deepEqual(back, sorted)
  assert.equal(validateManifest(back, LIMITS).ok, true)
  assert.equal(Buffer.compare(Buffer.from(canonicalEncode(reverseKeys(m), LIMITS)), Buffer.from(bytes)), 0)
  assert.equal(Buffer.compare(Buffer.from(canonicalEncode(back, LIMITS)), Buffer.from(bytes)), 0)
})

test('MC-V2-2 canonical decoder: v2 keys are UNKNOWN_KEY under schema 1; unknown keys inside a preview are rejected', () => {
  const v1WithPreviews = { ...v2Manifest(3), schemaVersion: 1 }
  assert.throws(() => canonicalDecode(canonicalEncode(v1WithPreviews, LIMITS), LIMITS), (e) => e instanceof CanonicalError && e.code === 'UNKNOWN_KEY')
  const v2 = v2Manifest(3); [...v2.nodes.values()][1].previews[0].secret = 'x'
  assert.throws(() => canonicalDecode(canonicalEncode(v2, LIMITS), LIMITS), (e) => e instanceof CanonicalError && e.code === 'UNKNOWN_KEY')
  const v2b = v2Manifest(3); [...v2b.nodes.values()][1].previews[0].sourceBlobRef.extra = 1
  assert.throws(() => canonicalDecode(canonicalEncode(v2b, LIMITS), LIMITS), (e) => e instanceof CanonicalError && e.code === 'UNKNOWN_KEY')
  const v2c = v2Manifest(3); [...v2c.nodes.values()][1].previews = [42]
  assert.throws(() => canonicalDecode(canonicalEncode(v2c, LIMITS), LIMITS), (e) => e instanceof CanonicalError && e.code === 'BAD_TYPE')
})

test('MC-V2-3 a 10 000-node v2 manifest with 3 previews per file stays within maxDecodedBytes or fails with the size error (never truncates)', () => {
  const m = v2Manifest(10_000)
  let bytes
  try { bytes = canonicalEncode(m) } catch (e) {
    assert.ok(e instanceof CanonicalError && e.code === 'LIMIT_DECODED_BYTES', `unexpected ${e?.code}`)
    return
  }
  assert.ok(bytes.length <= VAULT_TREE_CLIENT_LIMITS.maxDecodedBytes)
  const back = canonicalDecode(bytes)
  assert.equal(back.nodes.size, 10_000)
  assert.equal(validateManifest(back).ok, true)
})

test('MC-V2-4 encrypt/decrypt with manifestSchemaVersion 2 round-trips; v1 context cannot open a v2 revision', async () => {
  const trk = await trkFor(await fakeKek())
  const m = v2Manifest(30)
  const ctx = ctxFor(m)
  assert.equal(ctx.manifestSchemaVersion, 2)
  const env = await encryptManifestRevision(trk, deep(m), ctx, LIMITS)
  const back = await decryptManifestRevision(trk, env, ctx, LIMITS)
  assert.equal(back.schemaVersion, 2)
  assert.deepEqual(back.nodes.get(ID(5)).previews, m.nodes.get(ID(5)).previews)
  await assert.rejects(decryptManifestRevision(trk, env, { ...ctx, manifestSchemaVersion: 1 }, LIMITS), (e) => e instanceof ManifestCryptoError)
  await assert.rejects(decryptManifestRevision(trk, env, { ...ctx, manifestSchemaVersion: 3 }, LIMITS), (e) => e instanceof ManifestCryptoError)
})

test('MC-V2-5 the plaintext schemaVersion must equal the revision schema version (no v1 body under a v2 AAD, or vice versa)', async () => {
  const trk = await trkFor(await fakeKek())
  const v1 = bigManifest(5)
  await assert.rejects(encryptManifestRevision(trk, deep(v1), { ...ctxFor(v1), manifestSchemaVersion: 2 }, LIMITS), (e) => e instanceof ManifestCryptoError && e.code === 'BAD_INPUT')
  await assert.rejects(encryptManifestRevision(trk, deep(v1), { ...ctxFor(v1), manifestSchemaVersion: 2 }, LIMITS, { skipValidation: true }), (e) => e instanceof ManifestCryptoError && e.code === 'BAD_INPUT', 'binding is not skippable')
  // hand-built ciphertext (bypassing encryptManifestRevision): a v1 body authenticated under a v2 AAD
  const ctx2 = { ...ctxFor(v1), manifestSchemaVersion: 2 }
  const { padded, paddedLength } = padToBucket(canonicalEncode(v1, LIMITS), PADDING_BUCKETS.filter((b) => b <= LIMITS.maxDecodedBytes))
  const dekBytes = generateManifestDekBytes()
  const dek = await subtle.importKey('raw', dekBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const wrapped = await wrapManifestDek(trk, dekBytes, ctx2)
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: manifestCiphertextAad({ ...ctx2, paddedPlaintextLength: paddedLength }) }, dek, padded))
  const smuggled = { ciphertext, ivB64: bytesToB64(iv), ...wrapped }
  await assert.rejects(decryptManifestRevision(trk, smuggled, ctx2, LIMITS), (e) => e instanceof ManifestCryptoError && e.code === 'MANIFEST_INVALID')
  const v2 = v2Manifest(5)
  await assert.rejects(encryptManifestRevision(trk, deep(v2), { ...ctxFor(v2), manifestSchemaVersion: 1 }, LIMITS), (e) => e instanceof ManifestCryptoError && e.code === 'BAD_INPUT')
})
