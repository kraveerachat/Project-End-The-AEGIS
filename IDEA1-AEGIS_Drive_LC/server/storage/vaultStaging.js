// server/storage/vaultStaging.js — AEGIS Drive (IDEA1) · พื้นที่พักของ Private Vault V2
//
// ⚠️ ทุกไบต์ที่ผ่านไฟล์นี้เป็น ciphertext ที่ client เข้ารหัสมาแล้ว — เซิร์ฟเวอร์
//    เขียน/อ่าน/แฮช/ย้าย/ลบได้ แต่ตีความไม่ได้และไม่มีทางถอดได้ กุญแจไม่เคยมาถึงเครื่องนี้
//    (ข้อห้ามชุดเดียวกับ storage/vaultStore.js: ห้าม decrypt / derive key / รับ passphrase
//     / สร้าง thumbnail / เดา MIME / index เนื้อหา — ทั้งหมดต้องการ plaintext)
//
// ⚠️ แยกจาก .staging/uploads/ ของ Normal Files โดยเจตนา ไม่ใช่เพื่อความเป็นระเบียบ:
//    สองเส้นทางมีนโยบายเก็บกวาด เพดาน และ "ความหมายของไบต์" คนละอย่าง การใช้โฟลเดอร์
//    ร่วมกันแปลว่างานเก็บกวาดของฝั่งหนึ่งเดินไปเจอไบต์ของอีกฝั่งได้ ซึ่งไม่ควรเกิดขึ้นเลย
//
// ⚠️ ทั้ง session ใช้ไฟล์เดียว: `part` — chunk แต่ละก้อนถูกเขียน "ตามตำแหน่ง" ที่
//    index × ciphertextChunkSize ด้วย positional write เหตุผลเดียวกับ uploadStaging.js
//    (commit = rename ไม่ใช่การคัดลอกกิกะไบต์; ส่งซ้ำ = เขียนทับตำแหน่งเดิมพอดี)
//    ⚠️ ทำได้เพราะ chunk ที่ไม่ใช่ก้อนสุดท้าย "มีขนาด ciphertext เท่ากันเป๊ะทุกก้อน"
//       (plaintext เต็มก้อน + GCM tag 16 ไบต์) ตำแหน่งจึงคำนวณล่วงหน้าได้จริง
//
// ⚠️ ชื่อโฟลเดอร์เป็น id ทึบสุ่ม 192 บิต ไม่มีเศษของชื่อไฟล์ผู้ใช้ปนอยู่เลย — และใน
//    เส้นทาง Vault เซิร์ฟเวอร์ไม่รู้ชื่อไฟล์อยู่แล้วโดยโครงสร้าง (ไม่ใช่โดยนโยบาย)
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { STORAGE_ROOT } from './fileStore.js'
import { vaultStorageConfig } from './vaultStore.js'

const STAGING_DIR = path.join('.staging', 'vault')

/** id ทึบของ session — 24 ไบต์สุ่ม (hex 48 ตัว) รูปแบบเดียวกับ Normal Files */
export function newVaultUploadId() {
  return randomBytes(24).toString('hex')
}

export function isValidVaultUploadId(id) {
  return typeof id === 'string' && /^[0-9a-f]{48}$/.test(id)
}

const stagingRoot = () => path.join(STORAGE_ROOT, STAGING_DIR)
const sessionDir = (uploadId) => path.join(stagingRoot(), uploadId)
const partPath = (uploadId) => path.join(sessionDir(uploadId), 'part')

/** เตรียมพื้นที่พัก — เรียกครั้งเดียวตอนบูต คู่กับ initVaultStorage() */
export async function initVaultStaging() {
  await fsp.mkdir(stagingRoot(), { recursive: true })
  return { root: stagingRoot() }
}

/** สร้างโฟลเดอร์ของ session ใหม่ + ไฟล์ part ว่าง */
export async function createStagedVaultPart(uploadId) {
  if (!isValidVaultUploadId(uploadId)) throw new Error('invalid vault upload id')
  await fsp.mkdir(sessionDir(uploadId), { recursive: true })
  const handle = await fsp.open(partPath(uploadId), 'a')
  await handle.close()
  return partPath(uploadId)
}

/**
 * เขียน ciphertext ของ chunk หนึ่งก้อนจาก request stream ลงตำแหน่งของมันโดยตรง
 *
 * ⚠️ RAM ที่ใช้เป็น O(ขนาด buffer ของ stream) — ไบต์ไหลจาก socket ลง fd โดยไม่มีจุดใด
 *    สะสมทั้งก้อนไว้ในหน่วยความจำ เหมือนเส้นทาง Normal Files ทุกประการ
 * ⚠️ ตัดทันทีเมื่อไบต์เกินที่ประกาศไว้ — ผู้เรียกที่โกหกขนาดต้องไม่มีทางเขียนทับ chunk ถัดไป
 * @returns {Promise<{ bytesWritten: number, sha256: string }>}
 */
export async function writeStagedVaultChunk(uploadId, { index, offset, expectedBytes, source }) {
  if (!isValidVaultUploadId(uploadId)) throw new Error('invalid vault upload id')

  const hash = createHash('sha256')
  let bytesSeen = 0

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

  // 'r+' + start = positional write ทับช่วง [offset, offset+expectedBytes) ของ part เดิม
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

/** ขนาดจริงของไฟล์ part บนดิสก์ — แหล่งความจริงที่ commit ใช้เทียบกับ ciphertext size */
export async function stagedVaultPartSize(uploadId) {
  if (!isValidVaultUploadId(uploadId)) return null
  try {
    const st = await fsp.stat(partPath(uploadId))
    return st.size
  } catch {
    return null
  }
}

/**
 * sha256 ของ "ช่วงหนึ่งช่วง" ในไฟล์ part — commit ใช้ตรวจ chunk ทีละก้อน
 *
 * ⚠️ นี่คือหัวใจของ SERVER_CIPHERTEXT_INTEGRITY: เซิร์ฟเวอร์ไม่มี DEK จึงพิสูจน์
 *    plaintext ไม่ได้เลย สิ่งเดียวที่พิสูจน์ได้คือ "ไบต์ที่นอนอยู่บนดิสก์ตอนนี้ ตรงกับ
 *    ไบต์ที่มันเองแฮชไว้ตอนรับ" ซึ่งจับได้ทั้งการเขียนที่ขาดหาย การเขียนทับที่ค้างครึ่ง
 *    และดิสก์ที่เพี้ยน — แต่ **ไม่ใช่** การพิสูจน์ว่า plaintext ถูกต้อง (ดู CLIENT_AEAD_*)
 * ⚠️ อ่านแบบ stream ทีละบล็อก — RAM เป็น O(ขนาด buffer) ไม่ใช่ O(ขนาด chunk)
 */
export function stagedVaultRangeSha256(uploadId, { offset, length }) {
  return new Promise((resolve, reject) => {
    if (length === 0) { resolve(createHash('sha256').digest('hex')); return }
    const hash = createHash('sha256')
    let seen = 0
    const rs = fs.createReadStream(partPath(uploadId), { start: offset, end: offset + length - 1 })
    rs.on('error', reject)
    rs.on('data', (buf) => { seen += buf.length; hash.update(buf) })
    rs.on('end', () => {
      // ช่วงที่สั้นกว่าที่ขอ = ไฟล์ถูกตัด/เขียนไม่ครบ — ต้องดังที่นี่ ไม่ใช่ปล่อยให้
      // แฮชของ "ครึ่งก้อน" ถูกนำไปเทียบแล้วบังเอิญผ่าน
      if (seen !== length) reject(Object.assign(new Error('staged range short'), { code: 'RANGE_SHORT' }))
      else resolve(hash.digest('hex'))
    })
  })
}

/**
 * เลือก key ปลายทางของ ciphertext — "ก่อน" การแตะดิสก์ใด ๆ เพื่อให้บันทึกลงฐานข้อมูล
 * ได้ก่อน (บทเรียนจาก LFT-V2-A: key ที่มีตัวตนแค่ในตัวแปรของโปรเซสที่ตาย = ของกำพร้าถาวร)
 * ⚠️ ชื่อบนดิสก์เป็น UUID ล้วน ไม่มีชื่อไฟล์ผู้ใช้ปน — ซึ่งเซิร์ฟเวอร์ไม่รู้อยู่แล้ว
 */
export function newFinalVaultKey() {
  return `${vaultStorageConfig.VAULT_DIR}/${randomUUID()}.aegisenc`
}

/** absolute path ถ้า key อยู่ใต้ STORAGE_ROOT จริง — ไม่งั้น null (กัน traversal) */
function resolveInsideRoot(key) {
  if (typeof key !== 'string' || key.length === 0 || key.includes('\0')) return null
  const abs = path.resolve(STORAGE_ROOT, key.replace(/^[/\\]+/, ''))
  const root = STORAGE_ROOT.endsWith(path.sep) ? STORAGE_ROOT : STORAGE_ROOT + path.sep
  return abs.startsWith(root) ? abs : null
}

/** ย้าย ciphertext ที่ครบแล้วไปยัง key ที่บันทึกไว้ล่วงหน้า — rename บน volume เดียวกัน (atomic) */
export async function publishStagedVaultPartTo(uploadId, key) {
  const destination = resolveInsideRoot(key)
  if (!destination) throw new Error('refusing to publish outside STORAGE_ROOT')
  await fsp.rename(partPath(uploadId), destination)
  return key
}

/** ไบต์ของ key นี้มีอยู่จริงไหม — งานกู้คืนใช้ตัดสินว่า rename เกิดไปแล้วหรือยัง */
export async function finalVaultKeyExists(key) {
  const abs = resolveInsideRoot(key)
  if (!abs) return false
  try {
    const st = await fsp.stat(abs)
    return st.isFile()
  } catch {
    return false
  }
}

/**
 * ย้าย ciphertext ที่เผยแพร่ไปแล้ว "กลับ" มาเป็นไฟล์ part — ใช้เมื่อ commit ผ่านด่านตรวจ
 * ครบทุกชั้นแล้วแต่การเขียน metadata ล้มเหลวหลังจากนั้น (เหตุผลเต็มใน uploadStaging.js:
 * ลบไบต์ทิ้งอย่างเดียวจะได้ session ที่ "โกหก" ว่ารับ chunk ครบแล้วทั้งที่ไบต์หายไป)
 * @returns {Promise<boolean>} false = ย้ายกลับไม่ได้ (ผู้เรียกต้องยกเลิก session แทน)
 */
export async function restoreStagedVaultPart(uploadId, key) {
  if (!isValidVaultUploadId(uploadId)) return false
  const from = resolveInsideRoot(key)
  if (!from) return false
  try {
    await fsp.mkdir(sessionDir(uploadId), { recursive: true })
    await fsp.rename(from, partPath(uploadId))
    return true
  } catch {
    return false
  }
}

/** ลบพื้นที่พักของ session นี้ทิ้ง — เงียบถ้าไม่มีอยู่แล้ว */
export async function removeStagedVaultSession(uploadId) {
  if (!isValidVaultUploadId(uploadId)) return false
  try {
    await fsp.rm(sessionDir(uploadId), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * โฟลเดอร์พักที่ "ไม่มีแถว session อ้างถึงอีกแล้ว" — ของกำพร้าจากการล่มกลางคัน
 * ⚠️ รับ id ที่ยังใช้งานอยู่เข้ามาเพื่อ "เว้นไว้" เสมอ และไม่แตะ vault/ เลย
 * @param {Set<string>} liveIds
 */
export async function listOrphanStagedVaultSessions(liveIds) {
  let entries
  try {
    entries = await fsp.readdir(stagingRoot(), { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDirectory() && isValidVaultUploadId(e.name) && !liveIds.has(e.name))
    .map((e) => e.name)
}

export const vaultStagingConfig = Object.freeze({ STAGING_DIR })

/**
 * id ทึบของ blob ที่เผยแพร่แล้ว — 24 ไบต์สุ่ม รูปแบบเดียวกับ uploadId
 * ⚠️ แยกฟังก์ชันจาก newVaultUploadId() แม้จะได้ผลเหมือนกัน เพราะทั้งสองเป็น "id คนละ
 *    ชนิด" ที่อยู่คนละตาราง การใช้ชื่อเดียวกันจะชวนให้เผลอส่ง uploadId ไปเป็น blobId
 */
export function newVaultBlobId() {
  return randomBytes(24).toString('hex')
}

/** blob id ที่รูปแบบถูกต้อง — ใช้แยก id ของ V2 (hex 48) ออกจาก id ของ V1 (ตัวเลขล้วน) */
export function isValidVaultBlobId(id) {
  return typeof id === 'string' && /^[0-9a-f]{48}$/.test(id)
}
