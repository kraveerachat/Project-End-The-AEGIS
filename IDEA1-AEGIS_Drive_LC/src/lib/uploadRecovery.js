// src/lib/uploadRecovery.js — AEGIS Drive (IDEA1) · บันทึกกู้คืนการอัปโหลดข้าม reload
//
// ⚠️ ปัญหาที่โมดูลนี้มีไว้แก้ (ยืนยันแล้วบน Production):
//    ผู้ใช้กด refresh หนัก ๆ ระหว่างอัปโหลดไฟล์ 2 GB → SPA ถูกทำลาย → คิวหายทั้งชุด
//    และ request ฝั่ง client ถูก abort ทั้งที่ **เซสชันฝั่งเซิร์ฟเวอร์ยังอยู่ครบ** พร้อม
//    chunk ที่รับไปแล้ว สิ่งเดียวที่ขาดคือ "แท็บใหม่ไม่รู้ว่า uploadId คืออะไร"
//    โมดูลนี้จึงจดไว้แค่สิ่งเดียวนั้น — ชื่อของงานที่ค้างอยู่ฝั่งเซิร์ฟเวอร์
//
// ⚠️ ทำไมเก็บแค่ metadata:
//    การเก็บ Blob/ArrayBuffer ของไฟล์ลง storage คือการทำสำเนาไฟล์ทั้งก้อนในเครื่อง
//    ผู้ใช้ — ไฟล์ 2 GB จะกลายเป็น 4 GB ทันที และโควตาของเบราว์เซอร์จะระเบิดก่อนถึง
//    ไฟล์ที่สอง สิ่งที่เก็บที่นี่ต้องเป็น O(metadata) ตลอดไป ไม่ใช่ O(ขนาดไฟล์)
//    `saveRecord()` จึงกรองด้วย allowlist เสมอ ไม่ใช่ "ลบ field ที่รู้จักว่าแย่" ออก
//
// ⚠️ ทำไม localStorage ไม่ใช่ IndexedDB:
//    ทั้งโปรเจกต์ยังไม่มีการใช้ IndexedDB เลยแม้แต่ที่เดียว ส่วน state ที่ต้องอยู่ข้าม
//    session ใช้ localStorage ทั้งหมด (theme.js, vaultPreviewWorkerState.js, App.jsx)
//    บันทึกที่นี่เล็กและมีจำนวนจำกัด การเพิ่มชั้นเก็บข้อมูลแบบ async ทั้งระบบเพื่อของ
//    ขนาดไม่กี่ร้อยไบต์คือความซับซ้อนที่ไม่มีใครได้ประโยชน์ `storage` ถูกฉีดเข้ามาได้
//    เพื่อให้ทดสอบได้และเพื่อให้เปลี่ยน backend ทีหลังโดยผู้เรียกไม่ต้องรู้เรื่อง
//
// ⚠️ สิ่งที่โมดูลนี้ **ไม่** ทำ: มันไม่กู้ตัวไฟล์ File object กลับมา เบราว์เซอร์ไม่ให้
//    ทำแบบนั้นกับไฟล์ที่มาจาก <input type=file> และการแกล้งทำเป็นว่าทำได้จะจบลงที่
//    แถบความคืบหน้าที่ขยับเองโดยไม่มีไบต์ใดวิ่งจริง ผู้ใช้ต้องเลือกไฟล์ต้นทางเดิม
//    กลับมาเอง แล้วเราพิสูจน์ตัวตนของมันก่อนต่อเข้าเซสชันเดิม

/** ฐานของคีย์ใน storage — คีย์จริงมีบัญชีผู้ใช้ต่อท้ายเสมอ (ดู recoveryStorageKey) */
export const RECOVERY_STORAGE_KEY = 'aegis.drive.uploads.recovery.v1'

/** ความยาวสูงสุดของส่วน "บัญชี" ในคีย์ — id ที่ยาวผิดปกติต้องไม่ทำให้คีย์โตไม่จำกัด */
const SCOPE_SEGMENT_MAX = 32

/**
 * FNV-1a 32-bit — ใช้ทำให้ id ที่ยาวเกินเพดานยังแยกจากกันได้หลังถูกตัด
 * ⚠️ ไม่ใช่ของลับและไม่ได้มีไว้กันการปลอม มันแค่กันการ "ยุบมาชนกัน" ของสองบัญชีที่
 *    ขึ้นต้นเหมือนกัน การป้องกันจริงอยู่ที่เซิร์ฟเวอร์ซึ่งผูกทุกเซสชันกับ req.user.id
 */
function fnv1a32(input) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/**
 * คีย์ของ storage สำหรับ "บัญชีนี้เท่านั้น"
 *
 * ⚠️ นี่คือหัวใจของการแก้ข้อบกพร่องข้อที่ 1: เบราว์เซอร์หนึ่งเครื่องถูกใช้หลายบัญชีได้
 *    เสมอ และบันทึกกู้คืนมีทั้งชื่อไฟล์ ขนาด และ SHA-256 ของงานที่ยังไม่เสร็จอยู่ในนั้น
 *    เซิร์ฟเวอร์ปฏิเสธเซสชันข้ามบัญชีอย่างถูกต้องด้วย 404 อยู่แล้ว แต่ 404 นั้นมาถึง
 *    *หลังจาก* จอวาดชื่อไฟล์ของคนก่อนหน้าไปแล้ว การแยกที่ชั้น storage จึงต้องมาก่อน
 *
 * ⚠️ ห้ามต่อสตริงดิบ: id ที่มี `.`, `/`, ช่องว่าง หรือยาวผิดปกติ ทำให้คีย์กำกวมหรือ
 *    โตไม่จำกัด — encode ก่อน แล้วตัดที่เพดานพร้อมแฮชกันการชนกัน
 *
 * @param {string|number|null|undefined} scope id ของผู้ใช้ที่ล็อกอินอยู่
 * @returns {string|null} null = ยังไม่รู้ว่าเป็นใคร จึงยังไม่มีคีย์ให้เขียน
 */
export function recoveryStorageKey(scope, baseKey = RECOVERY_STORAGE_KEY) {
  if (scope === null || scope === undefined || scope === '') return null
  const raw = String(scope)
  if (!raw) return null
  const encoded = encodeURIComponent(raw)
  const segment = encoded.length <= SCOPE_SEGMENT_MAX
    ? encoded
    : `${encoded.slice(0, SCOPE_SEGMENT_MAX)}~${fnv1a32(raw)}`
  return `${baseKey}.${segment}`
}

/** เวอร์ชันของรูปทรงบันทึก — บันทึกที่คนละเวอร์ชันถูกทิ้ง ไม่ใช่เดาความหมายเอา */
export const RECOVERY_VERSION = 1

/**
 * ⚠️ allowlist ไม่ใช่ blocklist โดยเจตนา
 *    การเขียนเป็น "ลบ field ที่ไม่ดีออก" แปลว่าวันที่มีใครเพิ่ม field ใหม่เข้า checkpoint
 *    มันจะไหลลง storage เงียบ ๆ การเขียนแบบนี้แปลว่า field ใหม่ต้องถูกเพิ่มที่นี่ก่อน
 *    เสมอ ซึ่งเป็นจุดเดียวที่มีคนอ่านคำเตือนเรื่องขนาดข้างบน
 */
export const RECOVERY_FIELDS = Object.freeze([
  'version',
  'uploadId',
  'name',
  'size',
  'lastModified',
  'sha256',
  'chunkSize',
  'chunkCount',
  'receivedBytes',
  'stage',
  'createdAt',
  'updatedAt',
])

/** เพดานจำนวนบันทึก — เก็บอันที่ขยับล่าสุดไว้ก่อน ร้านนี้ต้องไม่โตไม่จำกัด */
export const MAX_RECOVERY_RECORDS = 50

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/** ตัวเลขที่ยอมรับได้เท่านั้น — สตริงยาว ๆ ที่แอบมาในช่องตัวเลขถูกตัดทิ้งตรงนี้ */
const numberOrNull = (value) => (isFiniteNumber(value) ? value : null)

/** สตริงที่มีเพดานความยาว — ชื่อไฟล์ยาวผิดปกติต้องไม่ทำให้ร้านบวม */
const shortString = (value, max = 260) => (typeof value === 'string' ? value.slice(0, max) : null)

/**
 * แปลง checkpoint จาก transport + ไฟล์ที่ผู้ใช้เลือก ให้เป็นบันทึกที่เก็บได้จริง
 *
 * ⚠️ ทุก field ผ่าน allowlist และผ่านตัวแปลงชนิดของตัวเอง — ต่อให้ผู้เรียกยัด Blob,
 *    Uint8Array, CSRF token หรือ FileSystemHandle เข้ามา มันก็ออกไปไม่ถึง storage
 *
 * @param {object} checkpoint สแนปช็อตจาก uploadFileResumable (ดู onCheckpoint)
 * @param {{ name?: string, size?: number, lastModified?: number }} file
 * @param {{ stage?: string, createdAt?: number, updatedAt?: number }} [extra]
 */
export function recoveryRecordFrom(checkpoint = {}, file = {}, extra = {}) {
  return {
    version: RECOVERY_VERSION,
    uploadId: shortString(checkpoint.uploadId, 96),
    name: shortString(file.name ?? checkpoint.name),
    size: numberOrNull(file.size ?? checkpoint.size),
    // ⚠️ คำแนะนำเท่านั้น ไม่ใช่หลักฐาน: บางระบบไฟล์/บางเบราว์เซอร์รายงานค่านี้ต่างกัน
    //    หลังคัดลอกไฟล์ SHA-256 คือสิ่งเดียวที่ตัดสินตัวตนจริง ๆ (ดู verifyRecoveryIdentity)
    lastModified: numberOrNull(file.lastModified),
    sha256: shortString(checkpoint.sha256, 64),
    chunkSize: numberOrNull(checkpoint.chunkSize),
    chunkCount: numberOrNull(checkpoint.chunkCount),
    receivedBytes: numberOrNull(checkpoint.receivedBytes) ?? 0,
    stage: shortString(extra.stage, 24),
    createdAt: numberOrNull(extra.createdAt),
    updatedAt: numberOrNull(extra.updatedAt),
  }
}

/** เหลือเฉพาะ field ที่อยู่ใน allowlist — ด่านสุดท้ายก่อนเขียนลง storage */
function sanitize(record, fields = RECOVERY_FIELDS) {
  const clean = {}
  for (const key of fields) {
    if (record[key] !== undefined) clean[key] = record[key]
  }
  return clean
}

/**
 * ร้านเก็บบันทึกกู้คืน
 *
 * ⚠️ ทุกการเข้าถึง storage ถูกห่อด้วย try/catch: โหมดส่วนตัว โควตาเต็ม และ policy ของ
 *    องค์กรทำให้ localStorage โยน error ได้ทั้งตอนอ่านและตอนเขียน การอัปโหลดต้องไม่พัง
 *    เพราะการ "จดกันลืม" ล้มเหลว — อย่างแย่ที่สุดคือกู้ไม่ได้ ไม่ใช่ส่งไฟล์ไม่ได้
 *
 * ⚠️ `scope` คือ id ของบัญชีที่ล็อกอินอยู่ ไม่ใช่ชื่อผู้ใช้และไม่ใช่ token — ไม่มีอะไร
 *    ที่เป็นความลับถูกเก็บลงเครื่อง ถ้ายังไม่รู้ว่าเป็นใคร (scope ว่าง) ร้านจะกลายเป็น
 *    no-op ทั้งการอ่านและการเขียน: ไม่อ่านของใคร และไม่ทิ้งบันทึกที่ไม่มีเจ้าของไว้
 *
 * ⚠️ `baseKey` + `fields` มีไว้ให้ Private Vault ใช้ร้านเดียวกันนี้กับ allowlist ของตัวเอง
 *    (vaultUploadRecovery.js) โดยไม่มีวันเห็นหรือเขียนทับบันทึกของ Files — ค่าเริ่มต้น
 *    คือพฤติกรรมเดิมของ Files ทุกไบต์
 *
 * @param {{ storage?: Storage, scope?: string|number|null, now?: () => number,
 *           baseKey?: string, fields?: readonly string[] }} [options]
 */
export function createRecoveryStore({ storage = defaultStorage(), scope = null, now = Date.now, baseKey = RECOVERY_STORAGE_KEY, fields = RECOVERY_FIELDS } = {}) {
  const key = recoveryStorageKey(scope, baseKey)

  const read = () => {
    if (!storage || !key) return []
    let raw = null
    try {
      raw = storage.getItem(key)
    } catch {
      return [] // อ่านไม่ได้ = ไม่มีอะไรให้กู้ ไม่ใช่เหตุให้ทั้งจอพัง
    }
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || parsed.version !== RECOVERY_VERSION || !Array.isArray(parsed.records)) return []
      // บันทึกที่ไม่มี uploadId กู้อะไรไม่ได้อยู่แล้ว ทิ้งตั้งแต่ตอนอ่าน
      return parsed.records.filter((record) => record && typeof record.uploadId === 'string' && record.uploadId)
    } catch {
      return [] // JSON เสีย = เริ่มใหม่เงียบ ๆ ดีกว่าโยน error ใส่หน้าจอผู้ใช้
    }
  }

  const write = (records) => {
    if (!storage || !key) return
    // เก็บอันที่ขยับล่าสุดก่อน แล้วตัดที่เพดาน
    const bounded = [...records]
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, MAX_RECOVERY_RECORDS)
      .map((record) => sanitize(record, fields))
    try {
      storage.setItem(key, JSON.stringify({ version: RECOVERY_VERSION, records: bounded }))
    } catch {
      /* โควตาเต็มหรือถูกปิดกั้น — การอัปโหลดยังเดินต่อได้ตามปกติ */
    }
  }

  return {
    list: read,

    /** เขียนทับบันทึกของ uploadId เดิมเสมอ — หนึ่งเซสชันมีได้บันทึกเดียว */
    save(record) {
      const uploadId = record?.uploadId
      if (typeof uploadId !== 'string' || !uploadId) return
      const at = now()
      const current = read()
      const previous = current.find((row) => row.uploadId === uploadId)
      const next = current.filter((row) => row.uploadId !== uploadId)
      next.push({
        ...record,
        version: RECOVERY_VERSION,
        createdAt: previous?.createdAt ?? record.createdAt ?? at,
        updatedAt: at,
      })
      write(next)
    },

    remove(uploadId) {
      if (!uploadId) return
      const current = read()
      if (!current.some((row) => row.uploadId === uploadId)) return
      write(current.filter((row) => row.uploadId !== uploadId))
    },

    /** ล้างเฉพาะของบัญชีนี้ — ร้านนี้ไม่มีทางแตะคีย์ของบัญชีอื่นได้เลย */
    clear() {
      if (!storage || !key) return
      try {
        storage.removeItem(key)
      } catch {
        /* ปิดกั้นอยู่ — ไม่มีอะไรให้ทำต่อ */
      }
    },
  }
}

/** localStorage ของเบราว์เซอร์เมื่อมีจริง — SSR และชุดทดสอบได้ null แล้วร้านกลายเป็น no-op */
function defaultStorage() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : null
  } catch {
    return null // การ "อ่าน property" ก็โยนได้เมื่อ site data ถูกปิดกั้น
  }
}

/**
 * พิสูจน์ว่าไฟล์ที่ผู้ใช้เลือกกลับมา คือไฟล์เดียวกับที่เซสชันนี้กำลังประกอบอยู่
 *
 * ⚠️ ทำไมต้องพิสูจน์: เซสชันฝั่งเซิร์ฟเวอร์ถือ chunk 0–1 ของไฟล์ A อยู่ ถ้าเรายอมรับ
 *    ไฟล์ B ที่บังเอิญชื่อและขนาดเท่ากัน chunk 2–3 ของ B จะถูกเขียนต่อท้าย A กลายเป็น
 *    ไฟล์ที่ไม่ใช่ทั้ง A และไม่ใช่ทั้ง B commit จะถูกปฏิเสธเพราะ SHA ไม่ตรง (ซึ่งถูกแล้ว)
 *    แต่ผู้ใช้จะเสียเวลาอัปโหลดครึ่งไฟล์ไปฟรี ๆ ก่อนจะรู้ตัว — ตรวจก่อนถูกกว่ามาก
 *
 * ⚠️ ขนาดถูกตรวจก่อนเสมอเพราะมันฟรี ส่วน SHA-256 ต้องอ่านไฟล์ทั้งก้อน (ทีละ slice)
 *    การแฮชไฟล์ 2 GB ที่ขนาดไม่ตรงตั้งแต่แรกคือการเผาเวลาผู้ใช้เปล่า ๆ
 *
 * @param {{ size?: number|null, sha256?: string|null }} record
 * @param {{ size?: number }} file
 * @param {{ hashFile: Function, signal?: AbortSignal, onProgress?: Function }} options
 * @returns {Promise<{ ok: true, sha256: string } | { ok: false, reason: 'size'|'content'|'cancelled'|'unreadable' }>}
 */
export async function verifyRecoveryIdentity(record, file, { hashFile, signal, onProgress } = {}) {
  if (!file) return { ok: false, reason: 'unreadable' }
  if (isFiniteNumber(record?.size) && file.size !== record.size) return { ok: false, reason: 'size' }
  if (typeof hashFile !== 'function') return { ok: false, reason: 'unreadable' }

  let sha256 = null
  try {
    sha256 = await hashFile(file, { signal, onProgress })
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) return { ok: false, reason: 'cancelled' }
    return { ok: false, reason: 'unreadable' }
  }

  if (typeof sha256 !== 'string' || !sha256) return { ok: false, reason: 'unreadable' }
  if (record?.sha256 && sha256 !== record.sha256) return { ok: false, reason: 'content' }
  return { ok: true, sha256 }
}
