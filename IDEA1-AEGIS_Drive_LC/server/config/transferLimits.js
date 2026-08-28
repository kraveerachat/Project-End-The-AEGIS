// server/config/transferLimits.js — AEGIS Drive (IDEA1) · เพดานของการโอนไฟล์ใหญ่ (LFT-V2)
//
// ⚠️ ไฟล์นี้มีอยู่เพราะ "เพดานที่ hard-code ไว้ในโค้ด" คือรากของปัญหาเดิม:
//    MAX_UPLOAD_BYTES = 1 GiB ใน fileStore.js เป็นทั้งเพดานของ "หนึ่งคำขอ HTTP" และ
//    เพดานของ "ไฟล์หนึ่งไฟล์" ในเวลาเดียวกัน — สองอย่างนี้ไม่ควรเป็นค่าเดียวกันเลย
//    V2 แยกมันออกจากกัน: ขนาดของหนึ่งคำขอ = chunk (มีขอบเขตเสมอ), ส่วนขนาดของไฟล์
//    เชิงตรรกะถูกจำกัดด้วย "ความจุ/โควตา/การตั้งค่า deployment" ไม่ใช่ด้วย RAM ของ
//    เบราว์เซอร์หรือด้วยคำขอเดียว
//
// ⚠️ ทุกค่าปรับได้จาก environment โดยไม่ต้องแก้โค้ด และ "ค่าที่ผิดรูปแบบทำให้บูตไม่ขึ้น"
//    โดยเจตนา (แบบเดียวกับ config/trustedProxy.js) — การ clamp ค่าที่ตั้งผิดเงียบ ๆ
//    ทำให้ deployment รันด้วยเพดานที่ไม่มีใครระบุไว้ในไฟล์ไหนเลย
//
// ⚠️ ห้ามอ้างว่า "ไม่จำกัดขนาดไฟล์" ที่ใดทั้งสิ้น — ข้อความที่ถูกต้องคือ ไฟล์ถูกส่งเป็น
//    chunk ที่มีขอบเขต และเพดานเชิงตรรกะมาจากความจุ/โควตา/การตั้งค่า

const MIB = 1_048_576
const GIB = 1_073_741_824

/** ช่วงที่ยอมรับของขนาด chunk — 8–64 MiB (นอกช่วงนี้ = ตั้งค่าผิด ไม่ใช่ค่าที่ต้องเดาให้) */
export const MIN_CHUNK_SIZE_BYTES = 8 * MIB
export const MAX_CHUNK_SIZE_BYTES = 64 * MIB

/** ค่าเริ่มต้นที่แนะนำ — ใหญ่พอให้ throughput ดี เล็กพอให้ retry หนึ่ง chunk ไม่แพง */
export const DEFAULT_CHUNK_SIZE_BYTES = 16 * MIB

// เพดานไฟล์เชิงตรรกะเริ่มต้น — "ค่าที่ปลอดภัยกับฮาร์ดแวร์ชุดปัจจุบัน" ไม่ใช่ค่าตายตัวของ
// สถาปัตยกรรม ตรงกับขนาดสูงสุดในตารางทดสอบการยอมรับ (5 GiB) และยังห่างจากความจุของ
// volume ปัจจุบันมาก ปรับด้วย MAX_LOGICAL_FILE_BYTES เมื่อฮาร์ดแวร์เปลี่ยน
const DEFAULT_MAX_LOGICAL_FILE_BYTES = 5 * GIB

// อายุของ upload session ที่ยังไม่ commit — หมดอายุแล้วถือว่าถูกทิ้ง เก็บกวาดได้
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000

// ── กฎพื้นที่ว่าง (บันทึกไว้ให้ผู้ตรวจอ่านตรงนี้จุดเดียว) ──────────────────────
// เซิร์ฟเวอร์รับ session ใหม่ก็ต่อเมื่อ:
//
//     freeBytes - logicalSize >= reserveBytes
//     reserveBytes = max(STORAGE_FREE_RESERVE_BYTES, totalBytes * STORAGE_FREE_RESERVE_FRACTION)
//
// เหตุผลที่ต้องมี "ส่วนสำรอง" ไม่ใช่แค่ freeBytes >= logicalSize:
//   1. filesystem ที่เต็ม 100% ทำให้ Postgres, audit log และ session store เขียนไม่ได้
//      ไปด้วย — การอัปโหลดไฟล์เดียวไม่ควรมีสิทธิ์ทำให้ทั้งระบบหยุดให้บริการ
//   2. ระหว่างอัปโหลด ยังมีไบต์อื่นเกิดขึ้นพร้อมกันได้ (เวอร์ชันเก่าที่ยังไม่ถูกลบ,
//      avatar, ciphertext ของ Vault, WAL ของ Postgres)
//   3. commit ใช้ rename บน volume เดียวกัน จึง "ไม่" ต้องการพื้นที่เพิ่มอีกเท่าตัว —
//      ส่วนสำรองจึงคุ้มครองข้อ 1–2 ไม่ใช่ค่าเผื่อการคัดลอก
const DEFAULT_FREE_RESERVE_BYTES = 2 * GIB
const DEFAULT_FREE_RESERVE_FRACTION = 0.05

function readInteger(env, name, fallback, { min, max }) {
  const raw = String(env[name] ?? '').trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer number of bytes`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is not a safe integer`)
  if (value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return value
}

function readFraction(env, name, fallback) {
  const raw = String(env[name] ?? '').trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`${name} must be a fraction in [0, 1)`)
  }
  return value
}

/**
 * อ่านเพดานทั้งชุดจาก environment — โยน error ทันทีเมื่อค่าไม่ถูกต้อง
 * @param {Record<string, string|undefined>} [env]
 * @returns {Readonly<{ chunkSizeBytes: number, maxLogicalFileBytes: number,
 *                      sessionTtlMs: number, freeReserveBytes: number,
 *                      freeReserveFraction: number }>}
 */
export function transferLimitsFromEnv(env = process.env) {
  const chunkSizeBytes = readInteger(env, 'UPLOAD_CHUNK_SIZE_BYTES', DEFAULT_CHUNK_SIZE_BYTES, {
    min: MIN_CHUNK_SIZE_BYTES,
    max: MAX_CHUNK_SIZE_BYTES,
  })
  const maxLogicalFileBytes = readInteger(env, 'MAX_LOGICAL_FILE_BYTES', DEFAULT_MAX_LOGICAL_FILE_BYTES, {
    min: chunkSizeBytes, // ไฟล์ที่เล็กกว่าหนึ่ง chunk ยังต้องอัปโหลดได้เสมอ
    max: Number.MAX_SAFE_INTEGER,
  })
  const sessionTtlMs = readInteger(env, 'UPLOAD_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS, {
    min: 60_000,           // สั้นกว่าหนึ่งนาที = resume ใช้ไม่ได้จริง
    max: 30 * 24 * 60 * 60 * 1000,
  })
  const freeReserveBytes = readInteger(env, 'STORAGE_FREE_RESERVE_BYTES', DEFAULT_FREE_RESERVE_BYTES, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  })
  const freeReserveFraction = readFraction(env, 'STORAGE_FREE_RESERVE_FRACTION', DEFAULT_FREE_RESERVE_FRACTION)

  return Object.freeze({
    chunkSizeBytes,
    maxLogicalFileBytes,
    sessionTtlMs,
    freeReserveBytes,
    freeReserveFraction,
  })
}

/** จำนวน chunk ของไฟล์ขนาดนี้ — ไฟล์ว่าง (0 ไบต์) ยังนับเป็น 0 chunk และ commit ได้ */
export function chunkCountFor(logicalSize, chunkSize) {
  return Math.ceil(Number(logicalSize) / Number(chunkSize))
}

/** ขนาดที่ chunk ลำดับนี้ "ต้องมีเป๊ะ ๆ" — ตัวสุดท้ายคือเศษที่เหลือ */
export function expectedChunkSize(index, logicalSize, chunkSize) {
  const start = index * chunkSize
  return Math.min(chunkSize, logicalSize - start)
}

/**
 * ไบต์ที่ต้องกันไว้ไม่ให้ upload ใดกินจนหมด — max(ค่าคงที่, สัดส่วนของทั้ง filesystem)
 * @param {number} totalBytes ความจุทั้งหมดของ mount (จาก statfs จริง ไม่ใช่ค่าที่ตั้งไว้)
 */
export function reserveBytesFor(totalBytes, limits) {
  const fractional = Math.ceil(Number(totalBytes) * limits.freeReserveFraction)
  return Math.max(limits.freeReserveBytes, Number.isFinite(fractional) ? fractional : 0)
}

/** เพดานทั้งชุดของโปรเซสนี้ — อ่านครั้งเดียวตอน module load เหมือน STORAGE_ROOT */
export const TRANSFER_LIMITS = transferLimitsFromEnv()
