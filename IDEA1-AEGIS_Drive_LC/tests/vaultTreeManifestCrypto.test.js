// tests/vaultTreeManifestCrypto.test.js — AEGIS Drive (IDEA1) · PR #157 Task 1.5 · encrypted manifest revisions
//
// canonical → pad → AES-GCM ภายใต้ Manifest DEK ใหม่ (ห่อด้วย TRK) และทางกลับที่ fail closed ทุกจุด
import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptManifestRevision, decryptManifestRevision, ManifestCryptoError } from '../src/lib/vaultTreeManifestCrypto.js'
import { generateTrkBytes, wrapTrkSlots, unwrapTrkSlots, rewrapTrkSlots } from '../src/lib/vaultTreeKeys.js'
import { createGenesisManifest } from '../src/lib/vaultTreeManifest.js'
import { treeLimitsFrom, PADDING_BUCKETS } from '../src/lib/vaultTreeLimits.js'
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
