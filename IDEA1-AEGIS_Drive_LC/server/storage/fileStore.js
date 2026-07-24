// server/storage/fileStore.js — AEGIS Drive (IDEA1) · Storage Layer ของ Edge Data Lake
//
// นี่คือชั้น "HDFS concept" ของสถาปัตยกรรมสามชั้น — filesystem ธรรมดาบน Docker
// named volume (production: bind ไปที่ HDD ของ NAS) ไม่ใช้ Hadoop/Hive เพราะ
// Beelink 8GB รับไม่ไหว และไม่จำเป็น: สิ่งที่ต้องการคือ "ไฟล์ดิบอยู่คนละที่กับ metadata"
//
//   Storage Layer (ที่นี่)      = bytes ของไฟล์ล้วน ๆ
//   Metadata Layer (Postgres)  = users / password_hash / ชื่อไฟล์ / ขนาด / เจ้าของ / sha256
//   Application Layer          = Express + React build
//
// ⚠️ ห้ามมีรหัสผ่าน/ความลับใด ๆ ตกลงมาชั้นนี้เด็ดขาด — bcrypt hash ทุกตัวอยู่ Metadata
//    Layer เท่านั้น ชั้นนี้ถูกออกแบบให้ "ขโมยดิสก์ไปทั้งลูกก็ยังไม่ได้รหัสผ่านใคร"
// ⚠️ ชื่อไฟล์ที่เก็บบนดิสก์เป็นชื่อสุ่มทึบ (opaque) ไม่ใช่ชื่อจริงที่ผู้ใช้ตั้ง — ชื่อจริง
//    อยู่ในคอลัมน์ `name` ของ Metadata Layer ทำให้ (1) คนที่เห็นแค่ดิสก์อ่านไม่ออกว่า
//    ไฟล์ไหนคืออะไร (2) ชื่อจากผู้ใช้ไม่มีวันกลายเป็น path บนดิสก์ = ตัด path traversal
//    ตั้งแต่ต้นทาง ไม่ต้องพึ่ง sanitize ที่อาจพลาด
import multer from 'multer'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

// จุด mount ของ named volume `drive_storage` (ดู docker-compose.yml)
// dev บนเครื่องตัวเอง (ไม่มี /datalake) ตั้ง STORAGE_ROOT ชี้ที่ไหนก็ได้
export const STORAGE_ROOT = path.resolve(process.env.STORAGE_ROOT || '/datalake')

// โฟลเดอร์ย่อยเดียวที่ endpoint อัปโหลดเขียนได้ — ทุก key ใน DB ขึ้นต้นด้วยตัวนี้เสมอ
const UPLOAD_DIR = 'uploads'

const MAX_UPLOAD_BYTES = 1_073_741_824 // 1 GiB — ตรงกับเพดานฝั่ง UI (Uploads.jsx)

/**
 * เตรียม Storage Layer ให้พร้อมก่อนเปิดพอร์ต — เรียกครั้งเดียวตอนบูต
 * ล้มเหลว = ต้องรู้ทันทีตอน start ไม่ใช่ตอนผู้ใช้กดอัปโหลดแล้วได้ 500 เงียบ ๆ
 * @returns {Promise<{ root: string, writable: boolean }>}
 */
export async function initStorage() {
  await fsp.mkdir(path.join(STORAGE_ROOT, UPLOAD_DIR), { recursive: true })
  // เขียนจริงหนึ่งครั้งเพื่อพิสูจน์สิทธิ์ (named volume ที่ mount มาใหม่มักเป็นของ root
  // ขณะที่คอนเทนเนอร์รันด้วย user 'node' — ปัญหานี้ต้องโผล่ตอนบูต ไม่ใช่ตอน runtime)
  const probe = path.join(STORAGE_ROOT, UPLOAD_DIR, `.write-probe-${randomUUID()}`)
  await fsp.writeFile(probe, 'ok')
  await fsp.unlink(probe)
  return { root: STORAGE_ROOT, writable: true }
}

/**
 * แปลง key ที่เก็บใน DB (`files.path`) → absolute path จริงบนดิสก์
 * ⚠️ ด่าน path traversal: ผลลัพธ์ต้องอยู่ใต้ STORAGE_ROOT เสมอ ไม่งั้นคืน null
 *    ต่อให้ค่าใน DB ถูกแก้ให้เป็น '../../etc/passwd' ก็ออกนอกกรอบไม่ได้
 * @param {string} key เช่น 'uploads/2f1c….bin'
 * @returns {string | null}
 */
export function resolveKey(key) {
  if (typeof key !== 'string' || key.length === 0) return null
  if (key.includes('\0')) return null
  const abs = path.resolve(STORAGE_ROOT, key.replace(/^[/\\]+/, ''))
  const root = STORAGE_ROOT.endsWith(path.sep) ? STORAGE_ROOT : STORAGE_ROOT + path.sep
  if (abs !== STORAGE_ROOT && !abs.startsWith(root)) return null
  return abs
}

// ── multer — เขียนลงดิสก์แบบ stream (ไม่โหลดทั้งไฟล์เข้า RAM) ────────────────
// ⚠️ memoryStorage จะทำให้ไฟล์ 1GB กิน RAM 1GB บนเครื่องที่มี 8GB ทั้งเครื่อง
//    diskStorage เขียนผ่านเป็น stream — RAM คงที่ไม่ว่าไฟล์ใหญ่แค่ไหน
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.join(STORAGE_ROOT, UPLOAD_DIR))
  },
  filename: (req, file, cb) => {
    // ชื่อบนดิสก์ = UUID ล้วน ไม่มีเศษของชื่อที่ผู้ใช้ส่งมาปนเลยแม้แต่นามสกุล
    // (นามสกุลจากผู้ใช้เป็นทางเข้าของ null-byte/สองนามสกุล — ไม่ต้องเอามาเสี่ยง
    //  ชนิดไฟล์ถูกอนุมานจากคอลัมน์ `name` ใน Metadata Layer ตอนอ่านอยู่แล้ว)
    cb(null, `${randomUUID()}.bin`)
  },
})

export const uploadMiddleware = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,       // หนึ่ง request หนึ่งไฟล์ — ไม่เปิดช่องอัปโหลดชุดใหญ่โดยไม่ตั้งใจ
    fields: 8,
  },
}).single('file')

/** key ที่ควรบันทึกลง DB สำหรับไฟล์ที่ multer เพิ่งเขียน (relative ต่อ STORAGE_ROOT) */
export function keyForUploaded(multerFile) {
  return `${UPLOAD_DIR}/${path.basename(multerFile.filename)}`
}

/**
 * sha256 ของไฟล์บนดิสก์ — อ่านแบบ stream (ไฟล์ใหญ่ไม่กิน RAM)
 * ⚠️ ค่านี้คำนวณ "ฝั่งเซิร์ฟเวอร์จาก bytes จริงที่เขียนลงดิสก์" เท่านั้น — ไม่เคยเชื่อ
 *    ค่าที่ client ส่งมา (client hash เอาไว้ "เทียบ" ได้ แต่ไม่ใช่แหล่งความจริง)
 * @param {string} absPath
 * @returns {Promise<string>} hex
 */
export function sha256OfFile(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const rs = fs.createReadStream(absPath)
    rs.on('error', reject)
    rs.on('data', (chunk) => hash.update(chunk))
    rs.on('end', () => resolve(hash.digest('hex')))
  })
}

/** ขนาดจริงของไฟล์บนดิสก์ (bytes) — แหล่งความจริงของคอลัมน์ size_bytes */
export async function sizeOfFile(absPath) {
  const st = await fsp.stat(absPath)
  return st.size
}

/** ลบ bytes ออกจาก Storage Layer — เงียบถ้าไม่มีไฟล์ (metadata อาจถูกลบไปก่อนแล้ว) */
export async function removeKey(key) {
  const abs = resolveKey(key)
  if (!abs) return false
  try {
    await fsp.unlink(abs)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

/** ไฟล์นี้มี bytes อยู่จริงบน Storage Layer ไหม (แถวเก่า/โฟลเดอร์จะไม่มี) */
export async function keyExists(key) {
  const abs = resolveKey(key)
  if (!abs) return false
  try {
    const st = await fsp.stat(abs)
    return st.isFile()
  } catch {
    return false
  }
}

/** เปิด read stream ของไฟล์ — ใช้โดย endpoint ดาวน์โหลด (ไม่อ่านทั้งไฟล์เข้า RAM) */
export function openReadStream(key) {
  const abs = resolveKey(key)
  if (!abs) return null
  return fs.createReadStream(abs)
}

/** ลบไฟล์ที่ multer เขียนไปแล้วแต่ transaction ฝั่ง metadata ล้มเหลว — กันไฟล์กำพร้า */
export async function discardUploaded(multerFile) {
  if (!multerFile?.path) return
  try {
    await fsp.unlink(multerFile.path)
  } catch {
    /* ไฟล์อาจถูกลบไปแล้ว — ไม่ใช่เรื่องต้อง throw ซ้ำทับ error เดิม */
  }
}

export const storageConfig = Object.freeze({ STORAGE_ROOT, UPLOAD_DIR, MAX_UPLOAD_BYTES })
