// src/lib/vaultUploadRecovery.js — AEGIS Drive (IDEA1) · กู้คืนการอัปโหลด Private Vault ข้าม hard refresh
//
// ปัญหาเดียวกับ Files (uploadRecovery.js): refresh ระหว่างอัปโหลด = แท็บใหม่ไม่รู้ uploadId ทั้งที่เซิร์ฟเวอร์
// ยังถือ chunk ที่รับแล้วไว้ครบ แต่ Vault มีข้อจำกัดที่ Files ไม่มี จึง "ห้ามลอกของ Files มาตรง ๆ":
//
//   1. resume ในหน่วยความจำถือ DEK แบบ non-extractable — ห้าม serialize DEK/KEK เด็ดขาด
//      แท็บใหม่จึง "สร้าง DEK ขึ้นใหม่" จากซองที่ห่อแล้ว (wrappedDek) ที่เซิร์ฟเวอร์เก็บไว้ตั้งแต่เปิด session
//      ด้วย KEK ของการปลดล็อกครั้งใหม่ — ไม่มีกุญแจใดเคยลง storage
//   2. ชื่อไฟล์/MIME/path/SHA-256 ของ plaintext คือ metadata ที่ถอดแล้ว — ห้ามลง storage
//      ชื่อที่ถาดแสดงหลัง refresh มาจากการถอด metaB64 (ซองของเซิร์ฟเวอร์) ด้วย DEK ที่สร้างใหม่เท่านั้น
//   3. การพิสูจน์ว่า "ไฟล์ที่เลือกกลับมาคือไฟล์เดิม" ใช้ลายนิ้วมือของเนื้อไฟล์ที่ **ปิดผนึกด้วย DEK**
//      (AES-GCM, IV สุ่ม, AAD ผูก uploadId) — storage เห็นแค่ ciphertext ที่ถอดไม่ได้หากไม่มี KEK
//
// ⚠️ บันทึกที่เก็บจริงผ่าน allowlist ของ VAULT_RECOVERY_FIELDS เสมอ (createRecoveryStore ของ Files ตัวเดียวกัน
//    คนละคีย์ คนละ allowlist) — ไม่มี name, sha256, parentNodeId หรือ field อื่นหลุดลงไปได้โดยโครงสร้าง
import { apiFetch } from './api.js'
import { bytesToB64, b64ToBytes } from './vaultCrypto.js'
import {
  GCM_TAG_BYTES, planVaultChunks, plaintextRangeFor, unwrapVaultV2Dek, decryptVaultV2MetaWithDek,
} from './vaultChunkCrypto.js'
import { createRecoveryStore } from './uploadRecovery.js'
import { TREE_UPLOAD_ROUTE_BASE } from './vaultTreeUpload.js'

/** คีย์ฐานของ Vault — แยกจาก Files ('aegis.drive.uploads.recovery.v1') โดยเจตนา */
export const VAULT_RECOVERY_STORAGE_KEY = 'aegis.vault.tree.uploads.recovery.v1'

/**
 * ⚠️ allowlist ทั้งหมดของสิ่งที่ลงเครื่องได้ — ทุกตัวเป็นตัวเลข/ตัวระบุทึบ/ciphertext
 *    size/lastModified เป็นคำใบ้ตัวตนเบื้องต้นเท่านั้น (เซิร์ฟเวอร์รู้ขนาด ciphertext อยู่แล้ว)
 */
export const VAULT_RECOVERY_FIELDS = Object.freeze([
  'version',
  'uploadId',
  'size',
  'lastModified',
  'chunkSize',
  'chunkCount',
  'sealIvB64',
  'sealB64',
  'stage',
  'createdAt',
  'updatedAt',
])

/** จำนวน chunk สูงสุดที่ลายนิ้วมืออ่าน — ไฟล์ที่มี chunk ไม่เกินนี้ถูกอ่านครบทุกไบต์ */
export const IDENTITY_SAMPLE_CHUNKS = 8

const SEAL_AAD_PREFIX = 'AEGIS-VLT2-RCV|'
const SEAL_VERSION = 1
const te = new TextEncoder()
const td = new TextDecoder()
const subtle = () => globalThis.crypto.subtle

export function createVaultRecoveryStore({ storage, scope = null, now } = {}) {
  return createRecoveryStore({
    ...(storage === undefined ? {} : { storage }),
    scope,
    ...(now ? { now } : {}),
    baseKey: VAULT_RECOVERY_STORAGE_KEY,
    fields: VAULT_RECOVERY_FIELDS,
  })
}

/** ดัชนี chunk ที่ลายนิ้วมืออ่าน — ทุกก้อนเมื่อไฟล์เล็ก ไม่งั้นก้อนแรก ก้อนสุดท้าย และกระจายเท่า ๆ กันระหว่างนั้น */
export function identitySampleIndexes(chunkCount, samples = IDENTITY_SAMPLE_CHUNKS) {
  const count = Math.max(1, Math.floor(Number(chunkCount) || 1))
  if (count <= samples) return Array.from({ length: count }, (_, i) => i)
  const out = new Set([0, count - 1])
  for (let k = 1; out.size < samples && k < samples - 1; k += 1) out.add(Math.round((k * (count - 1)) / (samples - 1)))
  return [...out].sort((a, b) => a - b)
}

/**
 * ลายนิ้วมือของเนื้อไฟล์: SHA-256(size ‖ ∀ก้อนตัวอย่าง: index ‖ SHA-256(plaintext ของก้อน))
 * ⚠️ อ่านทีละ slice ที่มีขอบเขต — หน่วยความจำสูงสุด O(ขนาด chunk) ไม่เคยอ่านทั้งไฟล์ในครั้งเดียว
 * ⚠️ ค่านี้เป็นอนุพันธ์ของ plaintext จึงถูกปิดผนึกด้วย DEK ก่อนลง storage เสมอ (sealVaultRecovery)
 */
export async function vaultIdentityFingerprint(file, plaintextChunkBytes, { signal } = {}) {
  const plan = planVaultChunks(file.size, plaintextChunkBytes)
  const parts = []
  const head = new DataView(new ArrayBuffer(8))
  head.setBigUint64(0, BigInt(file.size))
  parts.push(new Uint8Array(head.buffer))
  for (const index of identitySampleIndexes(plan.chunkCount)) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const range = plaintextRangeFor(index, file.size, plan.plaintextChunkBytes)
    const bytes = await file.slice(range.start, range.end).arrayBuffer()
    const digest = new Uint8Array(await subtle().digest('SHA-256', bytes))
    const idx = new DataView(new ArrayBuffer(4))
    idx.setUint32(0, index)
    parts.push(new Uint8Array(idx.buffer), digest)
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const joined = new Uint8Array(total)
  let at = 0
  for (const p of parts) { joined.set(p, at); at += p.length }
  return bytesToB64(new Uint8Array(await subtle().digest('SHA-256', joined)))
}

const sealAad = (uploadId) => te.encode(`${SEAL_AAD_PREFIX}${uploadId}`)

/**
 * สร้างบันทึกกู้คืนที่เก็บได้ — ทุกอย่างที่มาจาก plaintext (ลายนิ้วมือ, โฟลเดอร์ปลายทาง) อยู่ใน sealB64
 * @param {{ dek: CryptoKey, uploadId: string, file: File, plan: object, parentNodeId: string|null }} input
 */
export async function sealVaultRecovery({ dek, uploadId, file, plan, parentNodeId = null, signal } = {}) {
  const fingerprint = await vaultIdentityFingerprint(file, plan.plaintextChunkBytes, { signal })
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const payload = te.encode(JSON.stringify({ v: SEAL_VERSION, fp: fingerprint, parentNodeId: parentNodeId ?? null }))
  const sealed = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: sealAad(uploadId) }, dek, payload)
  return {
    version: 1,
    uploadId,
    size: file.size,
    lastModified: Number.isFinite(file.lastModified) ? file.lastModified : null,
    chunkSize: plan.chunkSize,
    chunkCount: plan.chunkCount,
    sealIvB64: bytesToB64(iv),
    sealB64: bytesToB64(new Uint8Array(sealed)),
    stage: 'uploading',
  }
}

/**
 * ถามสถานะที่เชื่อถือได้ของ session จากเซิร์ฟเวอร์ (เจ้าของเท่านั้น — ไม่ใช่เจ้าของ = 404)
 * @returns {Promise<{ ok: true, upload, envelope } | { ok: false, reason: 'expired'|'network'|'server' }>}
 */
export async function fetchVaultUploadStatus(uploadId, { signal, fetchJson = apiFetch } = {}) {
  const res = await fetchJson(`${TREE_UPLOAD_ROUTE_BASE}/${encodeURIComponent(uploadId)}`, { signal })
  if (res?.ok && res.data?.upload) return { ok: true, upload: res.data.upload, envelope: res.data.envelope ?? null }
  if (res?.status === 404 || res?.status === 410) return { ok: false, reason: 'expired' }
  if (res?.errorKind === 'network' || res?.errorKind === 'timeout') return { ok: false, reason: 'network' }
  return { ok: false, reason: 'server' }
}

/**
 * แท็บใหม่หลังปลดล็อก: สร้าง DEK (non-extractable) จากซองที่ห่อแล้วด้วย KEK ปัจจุบัน ถอดชื่อสำหรับถาด
 * และเปิดผนึกข้อมูลตัวตน — ไม่มีอะไรในนี้ถูกเขียนกลับลง storage
 * @throws {Error} 'recovery-envelope-missing' | 'recovery-geometry' | 'wrong-key' | 'recovery-seal'
 */
export async function openVaultRecovery({ kek, record, status }) {
  const envelope = status?.envelope
  const upload = status?.upload
  if (!envelope?.wrappedDekB64 || !envelope?.wrapIvB64 || !upload?.contentIdB64) throw new Error('recovery-envelope-missing')
  if (upload.uploadId !== record.uploadId || upload.chunkCount !== record.chunkCount || upload.chunkSize !== record.chunkSize) {
    throw new Error('recovery-geometry')
  }
  const dek = await unwrapVaultV2Dek(kek, envelope)
  const meta = await decryptVaultV2MetaWithDek(dek, { ...envelope, contentIdB64: upload.contentIdB64, chunkCount: upload.chunkCount })
  let sealed
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: b64ToBytes(record.sealIvB64), additionalData: sealAad(record.uploadId) },
      dek, b64ToBytes(record.sealB64),
    )
    sealed = JSON.parse(td.decode(new Uint8Array(plain)))
  } catch {
    throw new Error('recovery-seal')
  }
  if (sealed?.v !== SEAL_VERSION || typeof sealed.fp !== 'string') throw new Error('recovery-seal')
  const plainSize = Number.isSafeInteger(meta?.plainSize) ? meta.plainSize : record.size
  return {
    dek,
    name: typeof meta?.name === 'string' ? meta.name : null,
    mediaType: typeof meta?.type === 'string' ? meta.type : '',
    plainSize,
    fingerprint: sealed.fp,
    parentNodeId: typeof sealed.parentNodeId === 'string' ? sealed.parentNodeId : null,
  }
}

/** ไบต์ plaintext ที่เซิร์ฟเวอร์ยืนยันแล้ว — ใช้แสดงความคืบหน้าของแถวที่ถูกขัดจังหวะ */
export function receivedPlainBytes(upload, plainSize) {
  const plainChunk = Number(upload?.chunkSize) - GCM_TAG_BYTES
  if (!Number.isSafeInteger(plainChunk) || plainChunk <= 0) return 0
  let total = 0
  for (const index of upload?.received ?? []) {
    const range = plaintextRangeFor(index, plainSize, plainChunk)
    total += Math.max(0, range.end - range.start)
  }
  return total
}

/**
 * พิสูจน์ว่าไฟล์ที่ผู้ใช้เลือกกลับมาคือไฟล์ต้นทางเดิม — ก่อนส่ง chunk ใดทั้งสิ้น
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'size'|'content'|'unreadable'|'cancelled' }>}
 */
export async function verifyVaultRecoveryFile({ record, opened, file, signal }) {
  if (!file) return { ok: false, reason: 'unreadable' }
  if (file.size !== record.size || file.size !== opened.plainSize) return { ok: false, reason: 'size' }
  const plan = planVaultChunks(file.size, record.chunkSize - GCM_TAG_BYTES)
  if (plan.chunkCount !== record.chunkCount) return { ok: false, reason: 'size' }
  let fingerprint
  try {
    fingerprint = await vaultIdentityFingerprint(file, plan.plaintextChunkBytes, { signal })
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: 'unreadable' }
  }
  return fingerprint === opened.fingerprint ? { ok: true } : { ok: false, reason: 'content' }
}

/**
 * resume state รูปเดียวกับที่ uploadVaultFileChunked คืนมาเองในแท็บเดิม — DEK อยู่ในหน่วยความจำเท่านั้น
 * สถานะ chunk ที่ขาดยังถูกถามจากเซิร์ฟเวอร์อีกรอบโดย transport ก่อนส่งก้อนใด
 */
export function rebuildVaultResume({ opened, status, file }) {
  const upload = status.upload
  return {
    upload: {
      uploadId: upload.uploadId, formatVersion: upload.formatVersion, contentIdB64: upload.contentIdB64,
      ciphertextSize: upload.ciphertextSize, chunkSize: upload.chunkSize, chunkCount: upload.chunkCount,
      status: upload.status, expiresAt: upload.expiresAt, received: [...(upload.received ?? [])], missing: [...(upload.missing ?? [])],
      receivedBytes: upload.receivedBytes ?? 0,
    },
    dek: opened.dek,
    contentId: b64ToBytes(upload.contentIdB64),
    plan: planVaultChunks(file.size, upload.chunkSize - GCM_TAG_BYTES),
  }
}
