// src/lib/vaultTreeManifestCrypto.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · revision crypto
//
// หนึ่ง revision = canonical(manifest) → pad(bucket) → AES-GCM-256 ภายใต้ Manifest DEK ที่สุ่มใหม่
// ห่อด้วย TRK (ไม่ใช่ KEK) พร้อม AAD ผูก tree/revision/base/generation/schema/paddedLength
//
// ทางกลับ (decryptManifestRevision) fail closed ทุกขั้น และไม่คืน manifest บางส่วนเด็ดขาด:
//   ขนาด ciphertext → แกะ DEK → ถอด (GCM พิสูจน์ทั้งก้อน) → ถอด padding → parse เข้มงวด → validateManifest
// ⚠️ ไม่มี cache, ไม่มี storage, ไม่มี log ของ plaintext ในไฟล์นี้

import { generateManifestDekBytes, wrapManifestDek, unwrapManifestDek, TreeKeyError } from './vaultTreeKeys.js'
import { manifestCiphertextAad } from './vaultTreeAad.js'
import { canonicalEncode, canonicalDecode, padToBucket, stripPadding, CanonicalError } from './vaultTreeCanonical.js'
import { validateManifest, ManifestError } from './vaultTreeManifest.js'
import { bytesToB64, b64ToBytes } from './vaultCrypto.js'
import { VAULT_TREE_CLIENT_LIMITS, PADDING_BUCKETS } from './vaultTreeLimits.js'

const subtle = globalThis.crypto.subtle
const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n))
const IV_BYTES = 12
const GCM_TAG_BYTES = 16

export class ManifestCryptoError extends Error {
  /** @param {'LIMIT_CIPHERTEXT_BYTES'|'LIMIT_DECODED_BYTES'|'MANIFEST_DEK_UNRECOVERABLE'|'MANIFEST_UNAUTHENTIC'|'MANIFEST_INVALID'|'BAD_INPUT'} code */
  constructor(code, message = code, cause = undefined) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ManifestCryptoError'
    this.code = code
  }
}

/**
 * เข้ารหัส manifest เป็น revision ใหม่ (validate ก่อนเสมอ เว้นแต่เทสต์สั่งข้ามเพื่อสร้าง ciphertext เสีย)
 * @returns {Promise<{ciphertext:Uint8Array, ivB64:string, wrappedManifestDekB64:string, wrapIvB64:string, paddedLength:number}>}
 */
export async function encryptManifestRevision(trk, manifest, ctx, limits = VAULT_TREE_CLIENT_LIMITS, { skipValidation = false } = {}) {
  if (!skipValidation) {
    try { validateManifest(manifest, limits) } catch (e) { throw new ManifestCryptoError('MANIFEST_INVALID', e.message, e) }
  }
  let bytes
  try { bytes = canonicalEncode(manifest, limits) } catch (e) {
    throw new ManifestCryptoError(e instanceof CanonicalError && e.code === 'LIMIT_DECODED_BYTES' ? 'LIMIT_DECODED_BYTES' : 'BAD_INPUT', e.message, e)
  }
  let padded, paddedLength
  try { ({ padded, paddedLength } = padToBucket(bytes, PADDING_BUCKETS.filter((b) => b <= limits.maxDecodedBytes))) } catch (e) {
    throw new ManifestCryptoError('LIMIT_DECODED_BYTES', e.message, e)
  }
  const dekBytes = generateManifestDekBytes()
  const dek = await subtle.importKey('raw', dekBytes, { name: 'AES-GCM' }, false, ['encrypt'])
  const wrapped = await wrapManifestDek(trk, dekBytes, ctx) // เติมศูนย์ dekBytes ให้
  const iv = randomBytes(IV_BYTES)
  const aad = manifestCiphertextAad({ ...ctx, paddedPlaintextLength: paddedLength })
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, dek, padded))
  padded.fill(0); bytes.fill(0)
  return { ciphertext, ivB64: bytesToB64(iv), wrappedManifestDekB64: wrapped.wrappedManifestDekB64, wrapIvB64: wrapped.wrapIvB64, paddedLength }
}

/**
 * ถอด revision → manifest ที่ผ่าน validateManifest แล้วเท่านั้น
 * ลำดับ: ขนาด → DEK → GCM → padding → parse → validate; ล้มที่ไหนก็ไม่มีผลลัพธ์
 */
export async function decryptManifestRevision(trk, envelope, ctx, limits = VAULT_TREE_CLIENT_LIMITS) {
  const ct = envelope?.ciphertext
  if (!(ct instanceof Uint8Array)) throw new ManifestCryptoError('BAD_INPUT', 'ciphertext must be a Uint8Array')
  if (ct.length > limits.maxCiphertextBytes || ct.length < GCM_TAG_BYTES) throw new ManifestCryptoError('LIMIT_CIPHERTEXT_BYTES')
  const paddedLength = ct.length - GCM_TAG_BYTES
  let dek
  try { dek = await unwrapManifestDek(trk, envelope, ctx) } catch (e) {
    throw new ManifestCryptoError('MANIFEST_DEK_UNRECOVERABLE', e instanceof TreeKeyError ? e.message : 'unwrap failed', e)
  }
  let padded
  try {
    const aad = manifestCiphertextAad({ ...ctx, paddedPlaintextLength: paddedLength })
    if (typeof envelope.ivB64 !== 'string' || envelope.ivB64.length !== 16) throw new Error('bad iv')
    padded = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(envelope.ivB64), additionalData: aad }, dek, ct))
  } catch {
    throw new ManifestCryptoError('MANIFEST_UNAUTHENTIC')
  }
  let manifest
  try {
    const bytes = stripPadding(padded)
    manifest = canonicalDecode(bytes, limits)
  } catch (e) {
    padded.fill(0)
    throw new ManifestCryptoError(e instanceof CanonicalError && e.code === 'LIMIT_DECODED_BYTES' ? 'LIMIT_DECODED_BYTES' : 'MANIFEST_INVALID', e.message, e)
  }
  padded.fill(0)
  try { validateManifest(manifest, limits) } catch (e) {
    throw new ManifestCryptoError('MANIFEST_INVALID', e instanceof ManifestError ? e.message : 'invalid', e)
  }
  return manifest
}
