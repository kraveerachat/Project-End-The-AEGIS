// src/lib/vaultTreeKeys.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · TRK and Manifest DEK
//
// ลำดับชั้นกุญแจของ tree (ตายตัว — ดู design §10):
//
//   Vault KEK (Argon2id, มีอยู่แล้ว, ไม่แตะ)
//     └─ ห่อ TRK (Tree Root Key, 256 บิตสุ่มครั้งเดียวตอน genesis) — สองช่องอิสระ primary/recovery
//          └─ ห่อ Manifest DEK (สุ่มใหม่ทุก revision)
//
// ⚠️ KEK ห่อ "TRK เท่านั้น" และ TRK ห่อ "Manifest DEK เท่านั้น" — ไม่มีเส้นทาง KEK → Manifest DEK
//    ในไฟล์นี้ (tests TK-13 สแกนซอร์สยืนยัน) เหตุผล: หมุน passphrase = ห่อ TRK ใหม่สองช่อง
//    revision เก่าทุกตัวยังถอดได้ผ่าน TRK เดิม ไม่ต้องเข้ารหัส manifest ใหม่แม้แต่ไบต์เดียว
//
// ⚠️ ไบต์ TRK/DEK แบบ plaintext มีชีวิตแค่ชั่วครู่ในฟังก์ชันเหล่านี้ แล้วถูกเติมศูนย์ (best effort —
//    ไม่ใช่คำสัญญาว่าหน่วยความจำกายภาพถูกล้าง) หลัง import เป็น CryptoKey ที่ export ไม่ได้
//
// ⚠️ ช่อง recovery คือ "สำเนากันเสีย" ไม่ใช่ escrow และไม่ใช่ trust principal ที่สอง: ทั้งสองช่อง
//    ห่อด้วย KEK เดียวกัน ต่างกันแค่ IV และ slot ใน AAD

import { bytesToB64, b64ToBytes, KEY_BYTES } from './vaultCrypto.js'
import { trkWrapAad, manifestDekWrapAad, TRK_SLOTS } from './vaultTreeAad.js'

const subtle = globalThis.crypto.subtle
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))

export const TRK_BYTES = KEY_BYTES // 32
export const MANIFEST_DEK_BYTES = KEY_BYTES
const IV_BYTES = 12
const IV_B64_LEN = 16

export class TreeKeyError extends Error {
  /** @param {'TRK_UNRECOVERABLE'|'TRK_SLOT_DISAGREEMENT'|'MANIFEST_DEK_UNRECOVERABLE'|'NOT_DEGRADED'|'BAD_INPUT'} code */
  constructor(code, message = code) {
    super(message)
    this.name = 'TreeKeyError'
    this.code = code
  }
}

function assertKeyBytes(bytes, what) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== KEY_BYTES) throw new TreeKeyError('BAD_INPUT', `${what} must be ${KEY_BYTES} bytes`)
}

/** import raw 32 ไบต์ → CryptoKey AES-GCM non-extractable แล้วเติมศูนย์ต้นฉบับ (best effort) */
async function importAesKeyAndZero(rawBytes) {
  try {
    return await subtle.importKey('raw', rawBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  } finally {
    rawBytes.fill(0)
  }
}

async function aeadEncrypt(key, plaintext, aad) {
  const iv = randomBytes(IV_BYTES)
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext)
  return { ivB64: bytesToB64(iv), dataB64: bytesToB64(new Uint8Array(ct)) }
}

/** ถอด → Uint8Array; ทุกความล้มเหลว (กุญแจผิด/ถูกแก้/AAD ผิด) หน้าตาเหมือนกัน = null */
async function aeadDecryptOrNull(key, ivB64, dataB64, aad) {
  try {
    if (typeof ivB64 !== 'string' || ivB64.length !== IV_B64_LEN || typeof dataB64 !== 'string') return null
    const plain = await subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB64), additionalData: aad }, key, b64ToBytes(dataB64))
    return new Uint8Array(plain)
  } catch {
    return null
  }
}

// ── TRK ─────────────────────────────────────────────────────────────────────

/** TRK ใหม่ — 32 ไบต์จาก CSPRNG ล้วน สร้างครั้งเดียวตอน genesis */
export function generateTrkBytes() {
  return randomBytes(TRK_BYTES)
}

/** import ไบต์ TRK เป็น CryptoKey ที่ export ไม่ได้ และเติมศูนย์ต้นฉบับ */
export async function importTrk(trkBytes) {
  assertKeyBytes(trkBytes, 'TRK')
  return importAesKeyAndZero(trkBytes)
}

/**
 * ห่อ TRK ด้วย KEK เป็นสองช่องอิสระ (IV คนละตัว, AAD ระบุ slot) แล้วเติมศูนย์ไบต์ TRK
 * @returns {Promise<{primary:{wrappedTrkB64:string,wrapIvB64:string}, recovery:{wrappedTrkB64:string,wrapIvB64:string}}>}
 */
export async function wrapTrkSlots(kek, trkBytes, ctx) {
  assertKeyBytes(trkBytes, 'TRK')
  try {
    const out = {}
    for (const slot of TRK_SLOTS) {
      const { ivB64, dataB64 } = await aeadEncrypt(kek, trkBytes, trkWrapAad({ ...ctx, slot }))
      out[slot] = { wrappedTrkB64: dataB64, wrapIvB64: ivB64 }
    }
    return out
  } finally {
    trkBytes.fill(0)
  }
}

/**
 * แกะทั้งสองช่องเสมอ (ไม่ short-circuit) แล้วตัดสิน:
 *   - สองช่องผ่านและไบต์เท่ากัน → HEALTHY
 *   - ผ่านช่องเดียว → DEGRADED (บอกช่องที่เสีย) — ผู้เรียกต้องบล็อกการแก้ไขจนกว่าจะซ่อม
 *   - ไม่ผ่านทั้งคู่ → TRK_UNRECOVERABLE; ผ่านทั้งคู่แต่ไม่เท่ากัน → TRK_SLOT_DISAGREEMENT (fail closed)
 * เปรียบเทียบไบต์แบบความยาวคงที่ (XOR สะสม) — ไม่หยุดที่ไบต์แรกที่ต่าง
 * @returns {Promise<{trk:CryptoKey, status:'HEALTHY'|'DEGRADED', badSlot:null|'primary'|'recovery', envelope:object}>} envelope = ซองเดิม (ให้ repairTrkSlot ใช้)
 */
export async function unwrapTrkSlots(kek, envelope, ctx) {
  const results = {}
  for (const slot of TRK_SLOTS) {
    const s = envelope?.[slot]
    results[slot] = s ? await aeadDecryptOrNull(kek, s.wrapIvB64, s.wrappedTrkB64, trkWrapAad({ ...ctx, slot })) : null
  }
  const p = results.primary, r = results.recovery
  const valid = (b) => b instanceof Uint8Array && b.length === TRK_BYTES
  try {
    if (valid(p) && valid(r)) {
      let diff = 0
      for (let i = 0; i < TRK_BYTES; i++) diff |= p[i] ^ r[i]
      if (diff !== 0) throw new TreeKeyError('TRK_SLOT_DISAGREEMENT')
      return { trk: await importAesKeyAndZero(p), status: 'HEALTHY', badSlot: null, envelope }
    }
    if (valid(p)) return { trk: await importAesKeyAndZero(p), status: 'DEGRADED', badSlot: 'recovery', envelope }
    if (valid(r)) return { trk: await importAesKeyAndZero(r), status: 'DEGRADED', badSlot: 'primary', envelope }
    throw new TreeKeyError('TRK_UNRECOVERABLE')
  } finally {
    if (p) p.fill(0)
    if (r) r.fill(0)
  }
}

/**
 * แกะช่องภายใต้ KEK และคืนไบต์ TRK ที่พิสูจน์แล้ว — ใช้ภายในเท่านั้น (rewrap/repair)
 * ไม่ export: ผู้เรียกภายนอกได้แค่ CryptoKey ที่ export ไม่ได้
 */
async function unwrapTrkBytes(kek, envelope, ctx) {
  const tries = []
  for (const slot of TRK_SLOTS) {
    const s = envelope?.[slot]
    tries.push(s ? await aeadDecryptOrNull(kek, s.wrapIvB64, s.wrappedTrkB64, trkWrapAad({ ...ctx, slot })) : null)
  }
  const valid = tries.filter((b) => b instanceof Uint8Array && b.length === TRK_BYTES)
  if (valid.length === 0) throw new TreeKeyError('TRK_UNRECOVERABLE')
  if (valid.length === 2) {
    let diff = 0
    for (let i = 0; i < TRK_BYTES; i++) diff |= valid[0][i] ^ valid[1][i]
    if (diff !== 0) { valid.forEach((b) => b.fill(0)); throw new TreeKeyError('TRK_SLOT_DISAGREEMENT') }
    valid[1].fill(0)
  }
  return valid[0]
}

/**
 * หมุน passphrase: แกะ TRK ภายใต้ KEK เดิม (ต้องพิสูจน์ผ่าน) แล้วห่อใหม่ทั้งสองช่องภายใต้ KEK ใหม่
 * ด้วย IV ใหม่ — manifest revision และ wrapped Manifest DEK ทุกตัวไม่ถูกแตะ
 */
export async function rewrapTrkSlots(oldKek, newKek, envelope, ctx) {
  const trkBytes = await unwrapTrkBytes(oldKek, envelope, ctx)
  return wrapTrkSlots(newKek, trkBytes, ctx) // เติมศูนย์ให้ใน wrapTrkSlots
}

/**
 * ซ่อมช่องที่เสียจากผลของ unwrapTrkSlots ที่เป็น DEGRADED: ห่อช่องนั้นใหม่จาก TRK ที่ผ่านการพิสูจน์แล้ว
 * ช่องที่ดีถูกคงไว้ไบต์ต่อไบต์ (เพื่อให้ CAS ของซองกุญแจเปลี่ยนเฉพาะที่จำเป็น)
 * @param {CryptoKey} kek
 * @param {{trk:CryptoKey,status:string,badSlot:string|null,envelope?:object}} degraded ผลจาก unwrapTrkSlots + ซองเดิม
 */
export async function repairTrkSlot(kek, degraded, ctx) {
  if (!degraded || degraded.status !== 'DEGRADED' || !TRK_SLOTS.includes(degraded.badSlot)) throw new TreeKeyError('NOT_DEGRADED')
  const envelope = degraded.envelope
  if (!envelope) throw new TreeKeyError('BAD_INPUT', 'repair needs the original envelope')
  const goodSlot = degraded.badSlot === 'primary' ? 'recovery' : 'primary'
  // แกะจากช่องที่ดีเท่านั้น — ช่องเสียถูกละเว้นโดยนิยาม
  const trkBytes = await unwrapTrkBytes(kek, { [goodSlot]: envelope[goodSlot] }, ctx)
  try {
    const { ivB64, dataB64 } = await aeadEncrypt(kek, trkBytes, trkWrapAad({ ...ctx, slot: degraded.badSlot }))
    return { ...envelope, [degraded.badSlot]: { wrappedTrkB64: dataB64, wrapIvB64: ivB64 } }
  } finally {
    trkBytes.fill(0)
  }
}

// ── Manifest DEK ─────────────────────────────────────────────────────────────
// ⚠️ ส่วนนี้รู้จักแค่ TRK — ไม่มีพารามิเตอร์หรือเส้นทางใดรับกุญแจจาก passphrase (TK-13)

/** Manifest DEK ใหม่ — 32 ไบต์สุ่ม หนึ่งตัวต่อหนึ่ง revision ไม่เคยใช้ซ้ำ */
export function generateManifestDekBytes() {
  return randomBytes(MANIFEST_DEK_BYTES)
}

/** ห่อ Manifest DEK ด้วย TRK (IV ใหม่, AAD ผูก revision) แล้วเติมศูนย์ไบต์ DEK */
export async function wrapManifestDek(trk, dekBytes, ctx) {
  assertKeyBytes(dekBytes, 'Manifest DEK')
  try {
    const { ivB64, dataB64 } = await aeadEncrypt(trk, dekBytes, manifestDekWrapAad(ctx))
    return { wrappedManifestDekB64: dataB64, wrapIvB64: ivB64 }
  } finally {
    dekBytes.fill(0)
  }
}

/** แกะ Manifest DEK ด้วย TRK → CryptoKey ที่ export ไม่ได้; ทุกความล้มเหลว = MANIFEST_DEK_UNRECOVERABLE */
export async function unwrapManifestDek(trk, wrapped, ctx) {
  const bytes = await aeadDecryptOrNull(trk, wrapped?.wrapIvB64, wrapped?.wrappedManifestDekB64, manifestDekWrapAad(ctx))
  if (!(bytes instanceof Uint8Array) || bytes.length !== MANIFEST_DEK_BYTES) {
    if (bytes) bytes.fill(0)
    throw new TreeKeyError('MANIFEST_DEK_UNRECOVERABLE')
  }
  return importAesKeyAndZero(bytes)
}
