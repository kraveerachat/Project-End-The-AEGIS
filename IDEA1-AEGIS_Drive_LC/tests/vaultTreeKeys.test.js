// tests/vaultTreeKeys.test.js — AEGIS Drive (IDEA1) · PR #157 Task 1.2 · TRK slots and Manifest DEK wrapping
//
// ⚠️ รันโมดูลตัวจริงด้วย WebCrypto ของ Node — ไม่มี mock ของการเข้ารหัส
//    สิ่งที่พิสูจน์: KEK ห่อ "TRK เท่านั้น", TRK ห่อ "Manifest DEK เท่านั้น", สองช่องอิสระ,
//    ช่องเสียหนึ่ง = degraded, เสียสอง/ไม่ตรงกัน = fail closed, หมุน passphrase แล้ว revision เก่ายังถอดได้
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  TRK_BYTES, generateTrkBytes, importTrk, wrapTrkSlots, unwrapTrkSlots, rewrapTrkSlots, repairTrkSlot,
  generateManifestDekBytes, wrapManifestDek, unwrapManifestDek, TreeKeyError,
} from '../src/lib/vaultTreeKeys.js'
import { b64ToBytes, bytesToB64 } from '../src/lib/vaultCrypto.js'

const subtle = globalThis.crypto.subtle
async function fakeKek(seed = 7) {
  return subtle.importKey('raw', new Uint8Array(32).fill(seed), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}
const TRK_CTX = { ownerScopeId: 'AAAAAAAAAAAAAAAAAAAAAA', treeId: 'dHJlZS1pZC10ZXN0LTAwMQ', protocolVersion: 1, keyEnvelopeVersion: 1 }
const DEK_CTX = { treeId: 'dHJlZS1pZC10ZXN0LTAwMQ', revisionId: 'cmV2LWlkLXRlc3QtMDAwMD', baseRevisionId: null, generation: 1, manifestSchemaVersion: 1 }

const flipByte = (b64, i = 0) => { const u = b64ToBytes(b64); u[i] ^= 0x01; return bytesToB64(u) }

/** พิสูจน์ว่า CryptoKey สองตัวคือกุญแจเดียวกันโดยไม่ export: ห่อ DEK ทดสอบด้วยตัวหนึ่ง แกะด้วยอีกตัว */
async function sameKey(a, b) {
  const dek = generateManifestDekBytes()
  const wrapped = await wrapManifestDek(a, dek, DEK_CTX)
  try { await unwrapManifestDek(b, wrapped, DEK_CTX); return true } catch { return false }
}

test('TK-1 TRK bytes are 32 random bytes; importTrk yields a non-extractable AES-GCM key', async () => {
  const a = generateTrkBytes(), b = generateTrkBytes()
  assert.equal(TRK_BYTES, 32); assert.equal(a.length, 32)
  assert.notDeepEqual([...a], [...b])
  const key = await importTrk(new Uint8Array(a))
  assert.equal(key.extractable, false); assert.equal(key.algorithm.name, 'AES-GCM')
  await assert.rejects(subtle.exportKey('raw', key))
})

test('TK-2 both slots decrypt to the same TRK; wrap IVs and ciphertexts differ', async () => {
  const kek = await fakeKek()
  const slots = await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX)
  assert.notEqual(slots.primary.wrapIvB64, slots.recovery.wrapIvB64)
  assert.notEqual(slots.primary.wrappedTrkB64, slots.recovery.wrappedTrkB64)
  const { trk, status, badSlot } = await unwrapTrkSlots(kek, slots, TRK_CTX)
  assert.equal(status, 'HEALTHY'); assert.equal(badSlot, null)
  // each slot alone yields the same key as the pair
  const p = await unwrapTrkSlots(kek, { primary: slots.primary, recovery: { wrappedTrkB64: flipByte(slots.recovery.wrappedTrkB64), wrapIvB64: slots.recovery.wrapIvB64 } }, TRK_CTX)
  assert.equal(await sameKey(trk, p.trk), true)
})

test('TK-3 healthy unwrap reports HEALTHY with no bad slot', async () => {
  const kek = await fakeKek()
  const r = await unwrapTrkSlots(kek, await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX), TRK_CTX)
  assert.equal(r.status, 'HEALTHY'); assert.equal(r.badSlot, null); assert.equal(r.trk.extractable, false)
})

test('TK-4 one corrupt slot → DEGRADED naming the bad slot; the key is usable', async () => {
  const kek = await fakeKek()
  const slots = await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX)
  const good = await unwrapTrkSlots(kek, slots, TRK_CTX)
  const badPrimary = await unwrapTrkSlots(kek, { ...slots, primary: { ...slots.primary, wrappedTrkB64: flipByte(slots.primary.wrappedTrkB64, 3) } }, TRK_CTX)
  assert.equal(badPrimary.status, 'DEGRADED'); assert.equal(badPrimary.badSlot, 'primary')
  assert.equal(await sameKey(good.trk, badPrimary.trk), true)
  const badRecovery = await unwrapTrkSlots(kek, { ...slots, recovery: { ...slots.recovery, wrapIvB64: flipByte(slots.recovery.wrapIvB64) } }, TRK_CTX)
  assert.equal(badRecovery.status, 'DEGRADED'); assert.equal(badRecovery.badSlot, 'recovery')
})

test('TK-5 both slots corrupt → TRK_UNRECOVERABLE, no key', async () => {
  const kek = await fakeKek()
  const slots = await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX)
  const both = { primary: { ...slots.primary, wrappedTrkB64: flipByte(slots.primary.wrappedTrkB64) }, recovery: { ...slots.recovery, wrappedTrkB64: flipByte(slots.recovery.wrappedTrkB64) } }
  await assert.rejects(unwrapTrkSlots(kek, both, TRK_CTX), (e) => e instanceof TreeKeyError && e.code === 'TRK_UNRECOVERABLE')
})

test('TK-6 two valid slots holding different TRKs → TRK_SLOT_DISAGREEMENT (fail closed)', async () => {
  const kek = await fakeKek()
  const a = await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX)
  const b = await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX)
  await assert.rejects(unwrapTrkSlots(kek, { primary: a.primary, recovery: b.recovery }, TRK_CTX), (e) => e instanceof TreeKeyError && e.code === 'TRK_SLOT_DISAGREEMENT')
})

test('TK-7 AAD substitution: slot swap or any context change fails both slots', async () => {
  const kek = await fakeKek()
  const slots = await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX)
  const unrecoverable = (e) => e instanceof TreeKeyError && e.code === 'TRK_UNRECOVERABLE'
  await assert.rejects(unwrapTrkSlots(kek, { primary: slots.recovery, recovery: slots.primary }, TRK_CTX), unrecoverable)
  await assert.rejects(unwrapTrkSlots(kek, slots, { ...TRK_CTX, treeId: 'ZGlmZmVyZW50LXRyZWUtMD' }), unrecoverable)
  await assert.rejects(unwrapTrkSlots(kek, slots, { ...TRK_CTX, ownerScopeId: 'BBBBBBBBBBBBBBBBBBBBBB' }), unrecoverable)
  await assert.rejects(unwrapTrkSlots(kek, slots, { ...TRK_CTX, keyEnvelopeVersion: 2 }), unrecoverable)
  await assert.rejects(unwrapTrkSlots(kek, slots, { ...TRK_CTX, protocolVersion: 2 }), unrecoverable)
})

test('TK-8 wrong KEK → TRK_UNRECOVERABLE', async () => {
  const slots = await wrapTrkSlots(await fakeKek(1), generateTrkBytes(), TRK_CTX)
  await assert.rejects(unwrapTrkSlots(await fakeKek(2), slots, TRK_CTX), (e) => e.code === 'TRK_UNRECOVERABLE')
})

test('TK-9 rewrapTrkSlots: new slots unwrap under the new KEK to the same TRK; old slots still work under the old KEK', async () => {
  const oldKek = await fakeKek(1), newKek = await fakeKek(2)
  const oldSlots = await wrapTrkSlots(oldKek, generateTrkBytes(), TRK_CTX)
  const before = await unwrapTrkSlots(oldKek, oldSlots, TRK_CTX)
  const dek = generateManifestDekBytes()
  const wrappedDek = await wrapManifestDek(before.trk, dek, DEK_CTX)
  const newSlots = await rewrapTrkSlots(oldKek, newKek, oldSlots, TRK_CTX)
  assert.notEqual(newSlots.primary.wrapIvB64, oldSlots.primary.wrapIvB64)
  assert.notEqual(newSlots.recovery.wrapIvB64, oldSlots.recovery.wrapIvB64)
  assert.notEqual(newSlots.primary.wrapIvB64, newSlots.recovery.wrapIvB64)
  const after = await unwrapTrkSlots(newKek, newSlots, TRK_CTX)
  assert.equal(after.status, 'HEALTHY')
  await unwrapManifestDek(after.trk, wrappedDek, DEK_CTX) // historical wrapped DEK still opens
  await assert.rejects(unwrapTrkSlots(oldKek, newSlots, TRK_CTX))
  assert.equal((await unwrapTrkSlots(oldKek, oldSlots, TRK_CTX)).status, 'HEALTHY')
  // rewrap of an unrecoverable envelope refuses (never produces slots from nothing)
  const broken = { primary: { ...oldSlots.primary, wrappedTrkB64: flipByte(oldSlots.primary.wrappedTrkB64) }, recovery: { ...oldSlots.recovery, wrappedTrkB64: flipByte(oldSlots.recovery.wrappedTrkB64) } }
  await assert.rejects(rewrapTrkSlots(oldKek, newKek, broken, TRK_CTX), (e) => e.code === 'TRK_UNRECOVERABLE')
})

test('TK-10 repairTrkSlot recreates a corrupt slot from the validated key; result is HEALTHY', async () => {
  const kek = await fakeKek()
  const slots = await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX)
  const damaged = { ...slots, recovery: { ...slots.recovery, wrappedTrkB64: flipByte(slots.recovery.wrappedTrkB64) } }
  const degraded = await unwrapTrkSlots(kek, damaged, TRK_CTX)
  assert.equal(degraded.status, 'DEGRADED'); assert.equal(degraded.badSlot, 'recovery')
  const repaired = await repairTrkSlot(kek, degraded, TRK_CTX)
  assert.equal(repaired.primary.wrappedTrkB64, slots.primary.wrappedTrkB64) // untouched slot kept byte-for-byte
  assert.notEqual(repaired.recovery.wrappedTrkB64, damaged.recovery.wrappedTrkB64)
  const healthy = await unwrapTrkSlots(kek, repaired, TRK_CTX)
  assert.equal(healthy.status, 'HEALTHY')
  assert.equal(await sameKey(degraded.trk, healthy.trk), true)
  await assert.rejects(repairTrkSlot(kek, { ...degraded, status: 'HEALTHY', badSlot: null }, TRK_CTX), (e) => e.code === 'NOT_DEGRADED')
})

test('TK-11 Manifest DEK wrap/unwrap round trip; wrong TRK and tamper fail; wrap IV fresh per call', async () => {
  const kek = await fakeKek()
  const { trk } = await unwrapTrkSlots(kek, await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX), TRK_CTX)
  const dek = generateManifestDekBytes(); assert.equal(dek.length, 32)
  const wrapped = await wrapManifestDek(trk, new Uint8Array(dek), DEK_CTX)
  const key = await unwrapManifestDek(trk, wrapped, DEK_CTX)
  assert.equal(key.extractable, false)
  const other = (await unwrapTrkSlots(kek, await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX), TRK_CTX)).trk
  await assert.rejects(unwrapManifestDek(other, wrapped, DEK_CTX), (e) => e.code === 'MANIFEST_DEK_UNRECOVERABLE')
  await assert.rejects(unwrapManifestDek(trk, { ...wrapped, wrappedManifestDekB64: flipByte(wrapped.wrappedManifestDekB64) }, DEK_CTX), (e) => e.code === 'MANIFEST_DEK_UNRECOVERABLE')
  const ivs = new Set()
  for (let i = 0; i < 1_000; i++) ivs.add((await wrapManifestDek(trk, generateManifestDekBytes(), DEK_CTX)).wrapIvB64)
  assert.equal(ivs.size, 1_000)
})

test('TK-12 Manifest DEK AAD substitution across generation/revision/base/tree/schema fails', async () => {
  const kek = await fakeKek()
  const { trk } = await unwrapTrkSlots(kek, await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX), TRK_CTX)
  const ctx = { ...DEK_CTX, baseRevisionId: 'YmFzZS1pZC10ZXN0LTAwMD', generation: 3 }
  const wrapped = await wrapManifestDek(trk, generateManifestDekBytes(), ctx)
  const fails = (e) => e.code === 'MANIFEST_DEK_UNRECOVERABLE'
  await assert.rejects(unwrapManifestDek(trk, wrapped, { ...ctx, generation: 4 }), fails)
  await assert.rejects(unwrapManifestDek(trk, wrapped, { ...ctx, revisionId: 'b3RoZXItcmV2aXNpb24tMD' }), fails)
  await assert.rejects(unwrapManifestDek(trk, wrapped, { ...ctx, baseRevisionId: null }), fails)
  await assert.rejects(unwrapManifestDek(trk, wrapped, { ...ctx, treeId: 'ZGlmZmVyZW50LXRyZWUtMD' }), fails)
  await assert.rejects(unwrapManifestDek(trk, wrapped, { ...ctx, manifestSchemaVersion: 2 }), fails)
  await unwrapManifestDek(trk, wrapped, ctx)
})

test('TK-13 direct-KEK guard: a Manifest DEK is never wrapped or unwrapped by the KEK', async () => {
  const kek = await fakeKek()
  const { trk } = await unwrapTrkSlots(kek, await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX), TRK_CTX)
  const wrapped = await wrapManifestDek(trk, generateManifestDekBytes(), DEK_CTX)
  await assert.rejects(unwrapManifestDek(kek, wrapped, DEK_CTX), (e) => e.code === 'MANIFEST_DEK_UNRECOVERABLE')
  // source scan: the Manifest DEK functions never name a `kek` parameter and the module has no KEK→DEK path
  const src = fs.readFileSync(new URL('../src/lib/vaultTreeKeys.js', import.meta.url), 'utf8')
  const dekSection = src.slice(src.indexOf('export function generateManifestDekBytes'))
  assert.doesNotMatch(dekSection, /\bkek\b/i)
  assert.doesNotMatch(src, /wrapManifestDek\(\s*kek/)
})

test('TK-14 plaintext TRK bytes are zero-filled after import and after wrapping', async () => {
  const kek = await fakeKek()
  const raw = generateTrkBytes()
  const copy = new Uint8Array(raw)
  await importTrk(raw)
  assert.deepEqual([...raw], new Array(32).fill(0))
  await wrapTrkSlots(kek, copy, TRK_CTX)
  assert.deepEqual([...copy], new Array(32).fill(0))
  const dek = generateManifestDekBytes()
  const { trk } = await unwrapTrkSlots(kek, await wrapTrkSlots(kek, generateTrkBytes(), TRK_CTX), TRK_CTX)
  await wrapManifestDek(trk, dek, DEK_CTX)
  assert.deepEqual([...dek], new Array(32).fill(0))
})
