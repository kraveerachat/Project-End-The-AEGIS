// server/config/vaultTransferLimits.js — AEGIS Drive (IDEA1) · เพดานของ Private Vault V2 (LFT-V2-B)
//
// ⚠️ ทำไมต้องแยกจาก config/transferLimits.js ทั้งที่หน้าตาคล้ายกัน:
//    Normal Files ส่ง "ไบต์ของไฟล์" ส่วน Vault ส่ง "ciphertext" ซึ่งใหญ่กว่า plaintext
//    เสมอด้วย GCM tag 16 ไบต์ต่อหนึ่ง chunk เพดานสองชุดนี้จึงนับคนละหน่วยกัน และการ
//    ใช้ค่าเดียวกันจะทำให้ "ไฟล์ 5 GiB" ของสองเส้นทางหมายถึงคนละขนาดจริงบนดิสก์
//
// ⚠️ MAX_VAULT_CIPHERTEXT_BYTES (64 MiB) ของ V1 ยังอยู่ใน storage/vaultStore.js และ
//    **ยังบังคับกับเส้นทาง V1 เท่านั้น** ไฟล์นี้ไม่ยกเลิกค่านั้นและไม่แตะมันเลย —
//    V1 เป็น whole-file โดยนิยาม เพดานของมันคือความจริงของสถาปัตยกรรมนั้น ไม่ใช่บั๊ก
//
// ⚠️ ค่าที่ผิดรูปแบบทำให้บูตไม่ขึ้นโดยเจตนา (แบบแผนเดียวกับ transferLimits.js) —
//    การ clamp เงียบ ๆ ทำให้ deployment รันด้วยเพดานที่ไม่มีใครระบุไว้ที่ไหนเลย
import { TRANSFER_LIMITS, reserveBytesFor } from './transferLimits.js'

const MIB = 1_048_576
const GIB = 1_073_741_824

/** ขนาด GCM authentication tag — บวกเข้ากับ "ทุก chunk" ไม่ใช่ครั้งเดียวต่อไฟล์ */
export const GCM_TAG_BYTES = 16

/** ช่วงที่ยอมรับของขนาด plaintext ต่อหนึ่ง chunk — 8–64 MiB ตามข้อกำหนด LFT-V2-B */
export const MIN_VAULT_PLAINTEXT_CHUNK_BYTES = 8 * MIB
export const MAX_VAULT_PLAINTEXT_CHUNK_BYTES = 64 * MIB

/** ค่าเริ่มต้นที่แนะนำ — ใหญ่พอให้ throughput ดี เล็กพอให้ encrypt+retry หนึ่งก้อนไม่แพง
 *  ⚠️ ค่านี้ยังเป็น "เพดานหน่วยความจำของแท็บ" ด้วย: เบราว์เซอร์ถือ plaintext หนึ่งก้อน
 *     + ciphertext หนึ่งก้อนพร้อมกันสูงสุด ≈ 2 × ค่านี้ ระหว่างเข้ารหัส */
export const DEFAULT_VAULT_PLAINTEXT_CHUNK_BYTES = 16 * MIB

/**
 * เพดานสูงสุดที่ตั้งได้ของ Vault V2 — ตรงกับ Normal Files โดยเจตนา (LFT-V2-E)
 * ⚠️ นับเป็น plaintext เหมือน MAX_VAULT_LOGICAL_FILE_BYTES ส่วน ciphertext จริงบนดิสก์
 *    จะใหญ่กว่านี้ด้วย GCM tag 16 ไบต์ต่อ chunk — ที่ 32 GiB / chunk 32 MiB คือ 1,024
 *    chunk = 16 KiB ซึ่งเล็กมากแต่ต้องนับให้ถูกตอนตรวจพื้นที่ว่างอยู่ดี
 * ⚠️ ไม่ใช่ค่าเริ่มต้น — deployment ต้องตั้ง MAX_VAULT_LOGICAL_FILE_BYTES เองจึงจะได้
 */
export const MAX_SUPPORTED_VAULT_LOGICAL_FILE_BYTES = 32 * GIB // 34,359,738,368

// เพดาน "ขนาด plaintext เชิงตรรกะ" ของไฟล์หนึ่งไฟล์ใน Vault — ตรงกับเพดานของ Normal
// Files โดยเจตนา (ผู้ใช้ไม่ควรต้องจำสองตัวเลข) แต่ปรับแยกกันได้เมื่อฮาร์ดแวร์เปลี่ยน
const DEFAULT_MAX_VAULT_LOGICAL_BYTES = 5 * GIB

const DEFAULT_VAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_VAULT_COMMIT_LEASE_MS = 15 * 60 * 1000

function readInteger(env, name, fallback, { min, max }) {
  const raw = String(env[name] ?? '').trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer number of bytes`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is not a safe integer`)
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return value
}

/**
 * อ่านเพดานของ Vault V2 ทั้งชุดจาก environment
 * @param {Record<string, string|undefined>} [env]
 */
export function vaultTransferLimitsFromEnv(env = process.env) {
  const plaintextChunkBytes = readInteger(
    env, 'VAULT_CHUNK_PLAINTEXT_BYTES', DEFAULT_VAULT_PLAINTEXT_CHUNK_BYTES,
    { min: MIN_VAULT_PLAINTEXT_CHUNK_BYTES, max: MAX_VAULT_PLAINTEXT_CHUNK_BYTES },
  )
  const maxLogicalFileBytes = readInteger(
    env, 'MAX_VAULT_LOGICAL_FILE_BYTES', DEFAULT_MAX_VAULT_LOGICAL_BYTES,
    { min: 0, max: MAX_SUPPORTED_VAULT_LOGICAL_FILE_BYTES },
  )
  const sessionTtlMs = readInteger(env, 'VAULT_UPLOAD_SESSION_TTL_MS', DEFAULT_VAULT_SESSION_TTL_MS, {
    min: 60_000, max: 30 * 24 * 60 * 60 * 1000,
  })
  const commitLeaseMs = readInteger(env, 'VAULT_COMMIT_LEASE_MS', DEFAULT_VAULT_COMMIT_LEASE_MS, {
    min: 60_000, max: 24 * 60 * 60 * 1000,
  })

  return Object.freeze({
    plaintextChunkBytes,
    // ขนาด ciphertext ของ chunk ที่ "เต็มก้อน" — ค่านี้คือหน่วยที่เซิร์ฟเวอร์ใช้จริง
    // ทั้งการตรวจขนาดและการคำนวณตำแหน่งเขียน (index × ciphertextChunkBytes)
    ciphertextChunkBytes: plaintextChunkBytes + GCM_TAG_BYTES,
    maxLogicalFileBytes,
    sessionTtlMs,
    commitLeaseMs,
  })
}

/**
 * จำนวน chunk ของไฟล์ขนาด plaintext นี้
 * ⚠️ ไฟล์ว่าง (0 ไบต์) ยังต้องมี "หนึ่ง chunk" เสมอ ไม่ใช่ศูนย์ chunk — ต่างจาก
 *    Normal Files ที่ไฟล์ว่างมี 0 chunk ได้ เพราะที่นั่นไม่มีอะไรต้องพิสูจน์ความถูกต้อง
 *    ส่วนที่นี่ chunk คือ "ข้อความ AEAD หนึ่งข้อความ" ไฟล์ว่างที่ไม่มี chunk เลยจะไม่มี
 *    tag ให้ตรวจ = ไฟล์ที่ผู้โจมตีสร้างขึ้นเองได้โดยไม่ต้องมีกุญแจ
 */
export function vaultChunkCountFor(plainSize, plaintextChunkBytes) {
  const size = Number(plainSize)
  if (size <= 0) return 1
  return Math.ceil(size / Number(plaintextChunkBytes))
}

/**
 * ขนาด ciphertext ที่ chunk ลำดับนี้ "ต้องมีเป๊ะ ๆ"
 * ⚠️ คำนวณจาก ciphertextSize ที่บันทึกไว้ตอนเปิด session เท่านั้น — ไม่ใช่จากค่าที่
 *    client แจ้งมาในคำขอนี้ ค่าที่ client แจ้งใช้ "ปฏิเสธเร็ว" เท่านั้น
 */
export function expectedVaultChunkSize(index, ciphertextSize, ciphertextChunkSize) {
  const start = index * ciphertextChunkSize
  return Math.min(ciphertextChunkSize, ciphertextSize - start)
}

/**
 * ขนาด ciphertext ที่คาดหวังของไฟล์ที่มี plaintext ขนาดนี้ — ใช้ตอนตรวจพื้นที่ว่าง
 * ⚠️ overhead ไม่ใช่ 16 ไบต์ต่อไฟล์ แต่ 16 ไบต์ต่อ chunk ไฟล์ 5 GiB ที่ chunk ละ
 *    16 MiB มี 320 chunk = 5,120 ไบต์ ซึ่งเล็กแต่ต้องนับให้ถูกอยู่ดี
 */
export function expectedVaultCiphertextSize(plainSize, plaintextChunkBytes) {
  const size = Math.max(0, Number(plainSize))
  return size + vaultChunkCountFor(size, plaintextChunkBytes) * GCM_TAG_BYTES
}

/** ส่วนสำรองของ filesystem — ใช้กฎเดียวกับ Normal Files โดยเจตนา (ดู transferLimits.js) */
export function vaultReserveBytesFor(totalBytes) {
  return reserveBytesFor(totalBytes, TRANSFER_LIMITS)
}

/** เพดานทั้งชุดของโปรเซสนี้ — อ่านครั้งเดียวตอน module load */
export const VAULT_TRANSFER_LIMITS = vaultTransferLimitsFromEnv()
