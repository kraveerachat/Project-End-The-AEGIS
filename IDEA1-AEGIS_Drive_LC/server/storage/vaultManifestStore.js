// server/storage/vaultManifestStore.js — AEGIS Drive (IDEA1) · Private Vault encrypted hierarchy · manifest ciphertext files
//
// เก็บ ciphertext ของ manifest revision เป็นไฟล์ทึบ STORAGE_ROOT/vault-tree/<uuid>.aegisenc
//   - write-once: ชื่อไฟล์เป็น uuid สุ่มที่โมดูลนี้เลือกเอง ไม่มี API ใดรับ key มา "เขียนทับ"
//     (เขียนลง .tmp ก่อนด้วย flag wx แล้ว rename — ไม่มีไฟล์ครึ่ง ๆ ที่ใช้ key จริง)
//   - เพดานไบต์ถูกบังคับ "ระหว่างสตรีม" — เกินแล้วตัดทันที ไม่รอให้ไบต์ทั้งหมดลงดิสก์ก่อน
//   - sha256 ของไบต์ที่ "เซิร์ฟเวอร์รับมาจริง" ถูกคืนให้บันทึกในแถว revision (พิสูจน์ว่าไฟล์ที่เก็บ
//     คือไฟล์ที่มาถึง — ไม่ได้พิสูจน์อะไรเกี่ยวกับ plaintext ซึ่งเซิร์ฟเวอร์ไม่มีกุญแจ)
// ⚠️ ไม่มีชื่อ, node, parent หรือข้อมูลใด ๆ จาก client ใน path — key ประกอบจาก uuid เท่านั้น

import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { STORAGE_ROOT, resolveKey } from './fileStore.js'

export const MANIFEST_DIR = 'vault-tree'
const KEY_RE = /^vault-tree\/[0-9a-f-]{36}\.aegisenc$/

export class ManifestStoreError extends Error {
  /** @param {'TREE_MANIFEST_TOO_LARGE'|'BAD_KEY'|'STORAGE_ROOT'} code */
  constructor(code, message = code) { super(message); this.name = 'ManifestStoreError'; this.code = code }
}

/** เตรียมโฟลเดอร์ vault-tree ตอนบูต — ล้มเหลวต้องดังตั้งแต่ start */
export async function initVaultManifestStorage() {
  const root = path.join(STORAGE_ROOT, MANIFEST_DIR)
  if (!root.startsWith(STORAGE_ROOT)) throw new ManifestStoreError('STORAGE_ROOT')
  await fsp.mkdir(root, { recursive: true })
  const probe = path.join(root, `.write-probe-${randomUUID()}`)
  await fsp.writeFile(probe, 'ok')
  await fsp.unlink(probe)
  return { root, writable: true }
}

/**
 * สตรีม ciphertext ลงไฟล์ใหม่ (write-once) พร้อมบังคับเพดานและแฮชระหว่างทาง
 * @param {import('node:stream').Readable} stream
 * @param {{limitBytes:number}} opts
 * @returns {Promise<{storageKey:string, size:number, sha256:string}>}
 */
export async function writeManifestCiphertext(stream, { limitBytes }) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) throw new TypeError('limitBytes required')
  const storageKey = `${MANIFEST_DIR}/${randomUUID()}.aegisenc`
  const abs = resolveKey(storageKey)
  if (!abs) throw new ManifestStoreError('BAD_KEY')
  const tmp = `${abs}.tmp-${randomUUID()}`
  const hash = createHash('sha256')
  let size = 0
  const guard = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length
      if (size > limitBytes) return cb(new ManifestStoreError('TREE_MANIFEST_TOO_LARGE'))
      hash.update(chunk)
      cb(null, chunk)
    },
  })
  try {
    await pipeline(stream, guard, fs.createWriteStream(tmp, { flags: 'wx' }))
    await fsp.rename(tmp, abs)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return { storageKey, size, sha256: hash.digest('hex') }
}

/** read stream ของ ciphertext — null เมื่อ key ไม่ใช่ของโฟลเดอร์นี้หรือไฟล์ไม่มี */
export function openManifestCiphertext(storageKey) {
  if (typeof storageKey !== 'string' || !KEY_RE.test(storageKey)) return null
  const abs = resolveKey(storageKey)
  if (!abs || !fs.existsSync(abs)) return null
  return fs.createReadStream(abs)
}

/** ลบไฟล์ — idempotent (ENOENT = false); key นอกโฟลเดอร์นี้ = BAD_KEY */
export async function deleteManifestCiphertext(storageKey) {
  if (typeof storageKey !== 'string' || !KEY_RE.test(storageKey)) throw new ManifestStoreError('BAD_KEY')
  const abs = resolveKey(storageKey)
  if (!abs) throw new ManifestStoreError('BAD_KEY')
  try { await fsp.unlink(abs); return true } catch (e) { if (e.code === 'ENOENT') return false; throw e }
}
