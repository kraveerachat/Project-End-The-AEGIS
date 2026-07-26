// server/storage/vaultStore.js — AEGIS Drive (IDEA1) · Storage Layer ของ Private Vault
//
// ⚠️ ไฟล์ทุกไฟล์ในชั้นนี้เป็น "ciphertext ล้วน" (.aegisenc) — เซิร์ฟเวอร์เขียน/อ่าน/ลบ
//    bytes ได้ แต่ตีความไม่ได้และไม่มีทางถอดได้ กุญแจไม่เคยเดินทางมาถึงเครื่องนี้
//
// ⚠️ ห้ามมีฟังก์ชันใดในไฟล์นี้ทำสิ่งเหล่านี้เด็ดขาด:
//      - decrypt / derive key / รับ passphrase เป็นพารามิเตอร์
//      - สร้าง thumbnail, อ่านหัวไฟล์, เดา MIME, index เนื้อหา
//    ทั้งหมดนี้ต้องการ plaintext ซึ่งชั้นนี้ไม่มีสิทธิ์เห็นตามนิยาม
//
// ⚠️ ชื่อไฟล์บนดิสก์เป็น UUID ทึบ — ชื่อจริงของผู้ใช้ถูกเข้ารหัสอยู่ในคอลัมน์
//    meta_b64 (เข้ารหัสด้วย DEK) เซิร์ฟเวอร์จึงไม่รู้แม้แต่ชื่อไฟล์
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { STORAGE_ROOT, resolveKey } from './fileStore.js'

// โฟลเดอร์แยกจาก uploads/ โดยเจตนา — ทำให้ backup/replication ชี้นโยบายต่างกันได้
// (ciphertext vault สำรองออฟไซต์ได้อย่างปลอดภัยเพราะอ่านไม่ออกอยู่แล้ว)
const VAULT_DIR = 'vault'

// เพดาน ciphertext ต่อไฟล์ — 64 MiB เผื่อ overhead GCM tag (16 ไบต์) จากไฟล์ ~64 MiB
// เลือกเท่านี้เพราะ client ต้องถือทั้งไฟล์ใน RAM ตอนเข้ารหัส (Web Crypto ไม่มี streaming API)
export const MAX_VAULT_CIPHERTEXT_BYTES = 67_108_864

/** เตรียมโฟลเดอร์ vault ให้พร้อมตอนบูต — ล้มเหลวต้องดังตั้งแต่ start ไม่ใช่ตอน runtime */
export async function initVaultStorage() {
  await fsp.mkdir(path.join(STORAGE_ROOT, VAULT_DIR), { recursive: true })
  const probe = path.join(STORAGE_ROOT, VAULT_DIR, `.write-probe-${randomUUID()}`)
  await fsp.writeFile(probe, 'ok')
  await fsp.unlink(probe)
  return { root: path.join(STORAGE_ROOT, VAULT_DIR), writable: true }
}

/**
 * เขียน ciphertext ลงดิสก์เป็น .aegisenc
 * @param {Buffer} ciphertext bytes ที่ client เข้ารหัสมาแล้ว — เซิร์ฟเวอร์ไม่แตะเนื้อใน
 * @returns {Promise<{storageKey:string, bytes:number}>} storageKey relative ต่อ STORAGE_ROOT
 */
export async function writeVaultCiphertext(ciphertext) {
  const storageKey = `${VAULT_DIR}/${randomUUID()}.aegisenc`
  const abs = resolveKey(storageKey)
  if (!abs) throw new Error('vault storage key rejected')
  // wx = ต้องเป็นไฟล์ใหม่เท่านั้น — UUID ชนกันแทบเป็นไปไม่ได้ แต่ถ้าชนต้องล้มเหลว
  // ดังกว่าเขียนทับ ciphertext ของคนอื่นเงียบ ๆ
  await fsp.writeFile(abs, ciphertext, { flag: 'wx' })
  return { storageKey, bytes: ciphertext.length }
}

// ── multer — รับ ciphertext แบบ stream ลง vault/ โดยตรง ─────────────────────
// ⚠️ diskStorage ไม่ใช่ memoryStorage: ciphertext 64MiB ที่ผ่าน memoryStorage จะกิน
//    RAM 64MiB ต่อ request พร้อมกันบนเครื่อง 8GB ที่รันหลาย container
// ⚠️ ชื่อบนดิสก์เป็น UUID ล้วน — originalname ที่ client ส่งมาไม่เคยแตะ path
//    (client ส่งชื่อทึบมาอยู่แล้ว แต่ไม่พึ่ง client เป็นด่านความปลอดภัย)
const vaultDiskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(STORAGE_ROOT, VAULT_DIR)),
  filename: (req, file, cb) => cb(null, `${randomUUID()}.aegisenc`),
})

export const vaultUploadMiddleware = multer({
  storage: vaultDiskStorage,
  limits: {
    fileSize: MAX_VAULT_CIPHERTEXT_BYTES,
    files: 1,
    fields: 8, // iv / wrappedDek / wrapIv / metaIv / meta + เผื่อ
    fieldSize: 16_384, // metaB64 ของชื่อไฟล์ยาว ๆ ยังพอ แต่ไม่เปิดช่องยัดข้อมูลใหญ่
  },
}).single('file')

/** key ที่ควรบันทึกลง DB สำหรับ ciphertext ที่ multer เพิ่งเขียน (relative ต่อ STORAGE_ROOT) */
export function keyForUploadedVaultBlob(multerFile) {
  return `${VAULT_DIR}/${path.basename(multerFile.filename)}`
}

/** เปิด read stream ของ .aegisenc — endpoint ดาวน์โหลดส่งต่อ stream นี้ตรง ๆ ไม่โหลดเข้า RAM */
export function openVaultCiphertext(storageKey) {
  if (typeof storageKey !== 'string' || !storageKey.startsWith(`${VAULT_DIR}/`)) return null
  const abs = resolveKey(storageKey)
  if (!abs) return null
  return fs.createReadStream(abs)
}

/** ขนาด ciphertext บนดิสก์จริง — แหล่งความจริงของ size_bytes (ไม่เชื่อค่าที่ client แจ้ง) */
export async function vaultCiphertextSize(storageKey) {
  const abs = resolveKey(storageKey)
  if (!abs) return null
  try {
    const st = await fsp.stat(abs)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

/** ลบ ciphertext — ใช้ทั้งตอนผู้ใช้ลบไฟล์ และตอน rollback เมื่อ INSERT metadata ล้มเหลว */
export async function removeVaultCiphertext(storageKey) {
  if (typeof storageKey !== 'string' || !storageKey.startsWith(`${VAULT_DIR}/`)) return false
  const abs = resolveKey(storageKey)
  if (!abs) return false
  try {
    await fsp.unlink(abs)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    throw err
  }
}

export const vaultStorageConfig = Object.freeze({ VAULT_DIR, MAX_VAULT_CIPHERTEXT_BYTES })
