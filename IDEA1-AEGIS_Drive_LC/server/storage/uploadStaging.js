// server/storage/uploadStaging.js — AEGIS Drive (IDEA1) · พื้นที่พักของการอัปโหลดแบบ chunk
//
// ที่นี่คือ "ชั้นเก็บไฟล์" ของ V2 — คู่กับ metadata ของ session ที่อยู่ใน db/store.js
// ไบต์ที่ยังอัปโหลดไม่ครบอยู่ใต้ STORAGE_ROOT/.staging/uploads/<opaque-id>/ และ
// **ไม่มีทางโผล่ใน GET /api/files** เพราะไม่มีแถวใน `files` ชี้มาที่นี่เลยจนกว่าจะ commit
//
// ⚠️ ชื่อโฟลเดอร์เป็น id ทึบ (สุ่ม 192 บิต) ไม่ใช่ชื่อไฟล์ของผู้ใช้ — เหตุผลเดียวกับ
//    uploads/<uuid>.bin ใน fileStore.js: ชื่อจากผู้ใช้ต้องไม่มีวันกลายเป็น path บนดิสก์
//    (ตัด path traversal ที่ต้นทาง) และคนที่เห็นแค่ดิสก์ต้องอ่านไม่ออกว่าไฟล์ไหนคืออะไร
//
// ⚠️ ทั้ง session ใช้ไฟล์เดียว: `part` — แต่ละ chunk ถูกเขียน "ตามตำแหน่ง" ที่
//    index * chunkSize ด้วย positional write ไม่ใช่ไฟล์ย่อยไฟล์ละ chunk แล้วมาต่อกันตอน
//    commit เหตุผล:
//      1. commit กลายเป็น rename (metadata operation) ไม่ใช่การคัดลอกกิกะไบต์ —
//         ไม่ต้องมีพื้นที่ว่างเป็นสองเท่าของไฟล์ และไม่ต้องอ่าน/เขียนซ้ำอีกรอบ
//      2. ไม่มีชื่อ chunk บนดิสก์ให้ต้องออกแบบให้ทึบ — ตำแหน่งคือดัชนี
//      3. chunk ที่ส่งซ้ำเขียนทับตำแหน่งเดิมพอดี = idempotent โดยโครงสร้าง
//    ราคาที่จ่ายคือไฟล์ sparse ระหว่างทาง ซึ่ง ext4 รองรับอยู่แล้ว
//
// ⚠️ "สถานะว่า chunk ไหนมาถึงแล้ว" อยู่ในฐานข้อมูล ไม่ใช่ในชื่อไฟล์บนดิสก์ — เพราะ
//    ไฟล์ sparse บอกไม่ได้ว่าช่วงไหนถูกเขียนจริง และสถานะต้องอยู่รอด restart
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { STORAGE_ROOT, storageConfig } from './fileStore.js'

// ⚠️ ขึ้นต้นด้วยจุด และอยู่คนละโฟลเดอร์กับ uploads/ + versions/ โดยเจตนา — ทำให้
//    "ไบต์ที่ยังไม่สมบูรณ์" แยกจาก "ไบต์ที่เผยแพร่แล้ว" อย่างมองเห็นได้จากบนดิสก์
const STAGING_DIR = path.join('.staging', 'uploads')

/** id ทึบของ session — 24 ไบต์สุ่ม (ไม่ใช่ลำดับที่เดาต่อได้ และไม่ผูกกับชื่อไฟล์) */
export const newUploadId = () => randomBytes(24).toString('hex')

/** id ที่ยอมรับได้เท่านั้น — ทุกเส้นทางตรวจก่อนแตะ filesystem (ตัด traversal ที่ต้นทาง) */
export const isValidUploadId = (value) => typeof value === 'string' && /^[0-9a-f]{48}$/.test(value)

const stagingRoot = () => path.join(STORAGE_ROOT, STAGING_DIR)
const sessionDir = (uploadId) => path.join(stagingRoot(), uploadId)
const partPath = (uploadId) => path.join(sessionDir(uploadId), 'part')

/** เตรียมพื้นที่พัก — เรียกครั้งเดียวตอนบูต คู่กับ initStorage() */
export async function initUploadStaging() {
  await fsp.mkdir(stagingRoot(), { recursive: true })
  return { root: stagingRoot() }
}

/** สร้างโฟลเดอร์ของ session ใหม่ + ไฟล์ part ว่าง (ยังไม่จองพื้นที่จริง) */
export async function createStagedPart(uploadId) {
  if (!isValidUploadId(uploadId)) throw new Error('invalid upload id')
  await fsp.mkdir(sessionDir(uploadId), { recursive: true })
  const handle = await fsp.open(partPath(uploadId), 'a')
  await handle.close()
  return partPath(uploadId)
}

/**
 * เขียนไบต์ของ chunk หนึ่งก้อนจาก request stream ลงตำแหน่งของมันโดยตรง
 *
 * ⚠️ RAM ที่ใช้เป็น O(ขนาด buffer ของ stream) ไม่ใช่ O(ขนาด chunk) และไม่ใช่ O(ขนาดไฟล์) —
 *    ไบต์ไหลจาก socket ลง fd โดยไม่มีจุดใดสะสมทั้งก้อนไว้ในหน่วยความจำ
 * ⚠️ ตัดทันทีเมื่อไบต์เกินที่ประกาศไว้ ไม่รอให้จบ request — ผู้เรียกที่โกหกขนาด
 *    ต้องไม่มีทางเขียนทับ chunk ถัดไปหรือกินพื้นที่เกินที่จองไว้
 * @returns {Promise<{ bytesWritten: number, sha256: string }>}
 */
export async function writeStagedChunk(uploadId, { index, offset, expectedBytes, source }) {
  if (!isValidUploadId(uploadId)) throw new Error('invalid upload id')

  const hash = createHash('sha256')
  let bytesSeen = 0

  // นับ + แฮชระหว่างไบต์ไหลผ่าน แล้วส่งต่อทันที — ไม่มีการสะสมทั้ง chunk ไว้ที่ใดเลย
  const meter = new Transform({
    transform(piece, _encoding, callback) {
      bytesSeen += piece.length
      if (bytesSeen > expectedBytes) {
        callback(Object.assign(new Error('chunk longer than declared'), { code: 'CHUNK_TOO_LONG' }))
        return
      }
      hash.update(piece)
      callback(null, piece)
    },
  })

  // flags 'r+' + start = positional write: เขียนทับช่วง [offset, offset+expectedBytes)
  // ของไฟล์ part เดิม ไม่ต่อท้าย และไม่ตัดไฟล์ทิ้ง (ซึ่ง 'w' จะทำ)
  const sink = fs.createWriteStream(partPath(uploadId), { flags: 'r+', start: offset })
  await pipeline(source, meter, sink)

  if (bytesSeen !== expectedBytes) {
    const err = new Error('chunk shorter than declared')
    err.code = 'CHUNK_LENGTH_MISMATCH'
    err.bytesWritten = bytesSeen
    throw err
  }
  return { bytesWritten: bytesSeen, sha256: hash.digest('hex'), index }
}

/** ขนาดจริงของไฟล์ part บนดิสก์ — แหล่งความจริงที่ commit ใช้เทียบกับ logical size */
export async function stagedPartSize(uploadId) {
  if (!isValidUploadId(uploadId)) return null
  try {
    const st = await fsp.stat(partPath(uploadId))
    return st.size
  } catch {
    return null
  }
}

/** sha256 ของไบต์ที่ประกอบเสร็จแล้ว — อ่านแบบ stream (ไฟล์ใหญ่ไม่กิน RAM) */
export function stagedPartSha256(uploadId) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = fs.createReadStream(partPath(uploadId))
    rs.on('error', reject)
    rs.on('data', (chunk) => hash.update(chunk))
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * เผยแพร่ไบต์ที่ครบแล้วเข้าสู่ Storage Layer ปกติ — rename บน volume เดียวกัน
 * ⚠️ rename เป็น atomic บน POSIX: ไม่มีช่วงเวลาที่ key ปลายทางมีอยู่แต่ไบต์ยังไม่ครบ
 *    key ที่คืนออกไปมีความหมายเดียวกับ keyForUploaded() ของเส้นทางเดิมทุกประการ
 * @returns {Promise<string>} storage key (relative ต่อ STORAGE_ROOT)
 */
export async function publishStagedPart(uploadId) {
  // ชื่อบนดิสก์ = UUID ล้วน แบบเดียวกับ multer diskStorage ของเส้นทางเดิม —
  // ไม่มีเศษของชื่อที่ผู้ใช้ตั้งปนอยู่เลยแม้แต่นามสกุล
  const name = `${randomUUID()}.bin`
  const key = `${storageConfig.UPLOAD_DIR}/${name}`
  const destination = path.join(STORAGE_ROOT, storageConfig.UPLOAD_DIR, name)
  await fsp.rename(partPath(uploadId), destination)
  return key
}

/**
 * ย้ายไบต์ที่เผยแพร่ไปแล้ว "กลับ" มาเป็นไฟล์ part ของ session — ใช้เมื่อ commit ผ่าน
 * ด่านตรวจครบทุกชั้นแล้ว แต่การเขียน metadata ล้มเหลวหลังจากนั้น
 *
 * ⚠️ ทำไมต้องย้ายกลับ ไม่ใช่แค่ลบทิ้ง: publish คือ rename ที่ย้ายไฟล์ part ออกไปแล้ว
 *    ถ้าลบไบต์ทิ้งอย่างเดียวแล้วปลดสถานะกลับเป็น open จะได้ session ที่ "โกหก" —
 *    แถว chunk ยังบอกว่ารับครบแล้ว (missing: []) แต่ไบต์ไม่มีอยู่จริง ผู้ใช้จึงเห็นว่า
 *    พร้อม commit ตลอดไป แล้วได้ SIZE_MISMATCH ทุกครั้งโดยไม่มีทางแก้
 *    การย้ายกลับทำให้ commit ซ้ำได้จริงโดยไม่ต้องอัปโหลดใหม่ทั้งไฟล์
 * ⚠️ rename บน volume เดียวกันจึง atomic และไม่ใช้พื้นที่เพิ่ม เหมือนขากลับของ publish
 * @returns {Promise<boolean>} false = ย้ายกลับไม่ได้ (ผู้เรียกต้องยกเลิก session แทน)
 */
export async function restoreStagedPart(uploadId, key) {
  if (!isValidUploadId(uploadId)) return false
  const from = path.resolve(STORAGE_ROOT, String(key).replace(/^[/\\]+/, ''))
  const root = STORAGE_ROOT.endsWith(path.sep) ? STORAGE_ROOT : STORAGE_ROOT + path.sep
  if (!from.startsWith(root)) return false
  try {
    await fsp.mkdir(sessionDir(uploadId), { recursive: true })
    await fsp.rename(from, partPath(uploadId))
    return true
  } catch {
    return false
  }
}

/** ลบพื้นที่พักของ session นี้ทิ้ง — เงียบถ้าไม่มีอยู่แล้ว (ยกเลิก/หมดอายุ/commit สำเร็จ) */
export async function removeStagedSession(uploadId) {
  if (!isValidUploadId(uploadId)) return false
  try {
    await fsp.rm(sessionDir(uploadId), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * โฟลเดอร์พักที่ "ไม่มีแถว session อ้างถึงอีกแล้ว" — ของกำพร้าที่เกิดจากการล่มกลางคัน
 * ⚠️ รับ id ที่ยังใช้งานอยู่เข้ามาเพื่อ "เว้นไว้" เสมอ — งานเก็บกวาดต้องไม่มีทางลบ
 *    ไบต์ของ session ที่ยังเปิดอยู่ และไม่แตะ uploads/ หรือ versions/ เลยแม้แต่น้อย
 * @param {Set<string>} liveIds
 */
export async function listOrphanStagedSessions(liveIds) {
  let entries
  try {
    entries = await fsp.readdir(stagingRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidUploadId(entry.name) && !liveIds.has(entry.name))
    .map((entry) => entry.name)
}

export const uploadStagingConfig = Object.freeze({ STAGING_DIR })
