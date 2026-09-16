// server/db/legacyKindClassifier.js — AEGIS Drive (IDEA1) · จำแนกแถวเก่าก่อนย้ายสคีมา
//
// ⚠️ ทำไมไฟล์นี้ต้องมี และทำไมมันห้ามใช้ชื่อไฟล์เป็นหลักฐาน:
//    ระบบเดิมตัดสินว่าอะไรคือ "โฟลเดอร์" จาก **ชื่อ** — ชื่อที่ไม่มีจุด = โฟลเดอร์
//    (ดู typeExtFromName ตัวเก่าใน store.js) นั่นแปลว่าไฟล์ชื่อ `README` ถูกแสดงเป็น
//    โฟลเดอร์มาตลอด และการเปลี่ยนชื่อ `report.pdf` เป็น `report` จะแปลงไฟล์เป็นโฟลเดอร์
//    เงียบ ๆ ทั้งที่ไบต์ยังเป็น PDF อยู่ งานนี้กำลังลบ heuristic นั้นทิ้ง — การเอามัน
//    มา backfill คอลัมน์ `kind` ก็คือการเขียนบั๊กเดิมลงฐานข้อมูลอย่างถาวร
//
// ⚠️ หลักฐานที่ใช้ได้จริงคือ **ธรรมเนียมการสร้างแถว** ซึ่งคงทนและไม่ขึ้นกับชื่อเลย
//    (ยืนยันจากทุกจุดที่ INSERT ลงตาราง files — มีสามจุดเท่านั้น):
//
//      โฟลเดอร์  pgCreateFolder()   → path '/datalake/<name>', size_bytes 0,
//                                     ไม่ได้ใส่คอลัมน์ sha256 เลย จึงเป็น NULL เสมอ
//      ไฟล์      pgRecordUpload()   → path 'uploads/<uuid>.bin' + sha256 ที่เซิร์ฟเวอร์วัดเอง
//                V2 commit          → path 'uploads/<uuid>.bin' + sha256 เช่นกัน
//
//    storage key ของไฟล์เป็น UUID ทึบเสมอ (fileStore.js: `${UPLOAD_DIR}/${randomUUID()}.bin`)
//    มันจึงไม่เคยมีรูปร่างเหมือน path ของโฟลเดอร์ และไม่เคยขึ้นกับชื่อที่ผู้ใช้ตั้ง
//
// ⚠️ อะไรที่ไม่เข้าทั้งสองแบบ = AMBIGUOUS และต้อง **หยุด** ไม่ใช่เดาให้
//    การเดาผิดหนึ่งแถวแปลว่าไฟล์จริงกลายเป็นโฟลเดอร์ถาวร หรือโฟลเดอร์ที่มีลูกกลายเป็น
//    ไฟล์ที่ดาวน์โหลดไม่ได้ — ทั้งสองอย่างแก้ทีหลังยากกว่าการหยุดถามเจ้าของตอนนี้มาก

/** คำนำหน้าของ storage key ที่ทุกการอัปโหลดใช้ (ตรงกับ UPLOAD_DIR ใน fileStore.js) */
export const UPLOAD_KEY_PREFIX = 'uploads/'

export const KIND_FILE = 'file'
export const KIND_FOLDER = 'folder'
export const KIND_AMBIGUOUS = 'ambiguous'

const isUploadKey = (value) => typeof value === 'string' && value.startsWith(UPLOAD_KEY_PREFIX)
const hasChecksum = (value) => typeof value === 'string' && value.length > 0

/**
 * จำแนกหนึ่งแถวจากหลักฐานการสร้าง — ไม่แตะชื่อไฟล์เลยแม้แต่ครั้งเดียว
 *
 * @param {{ path?: string|null, size_bytes?: number|string|null, sha256?: string|null }} row
 * @returns {'file'|'folder'|'ambiguous'}
 */
export function classifyLegacyRow(row = {}) {
  const storageKey = row.path
  const sizeBytes = Number(row.size_bytes ?? 0)
  const sha = row.sha256 ?? null

  // ไฟล์: อยู่ใต้ storage key ของการอัปโหลด และมี checksum ที่เซิร์ฟเวอร์วัดเอง
  // (ไฟล์ 0 ไบต์ก็เข้าเงื่อนไขนี้ — chunkedUpload แฮชสตริงว่างเสมอ sha จึงไม่เคยเป็น NULL)
  if (isUploadKey(storageKey) && hasChecksum(sha)) return KIND_FILE

  // โฟลเดอร์: มี path ตามธรรมเนียม pgCreateFolder ('/datalake/<name>') ไม่มีขนาด ไม่มี checksum
  // ⚠️ ต้องเป็น "หลักฐานเชิงบวก" ไม่ใช่แค่ไม่เข้าเงื่อนไขไฟล์ — แถวที่ path หายไปเลย
  //    ไม่ได้พิสูจน์ว่าเป็นโฟลเดอร์ มันพิสูจน์ว่าเราไม่รู้ ซึ่งต้องจบที่ ambiguous
  const hasPath = typeof storageKey === 'string' && storageKey.length > 0
  if (hasPath && !isUploadKey(storageKey) && sizeBytes === 0 && !hasChecksum(sha)) return KIND_FOLDER

  return KIND_AMBIGUOUS
}

/** ส่วนแรกของ path — พอให้เจ้าของเห็นรูปร่าง แต่ไม่ใช่ตำแหน่งไบต์จริงทั้งเส้น */
function pathPrefixOf(value) {
  if (typeof value !== 'string' || value === '') return ''
  const trimmed = value.startsWith('/') ? value.slice(1) : value
  return `${trimmed.split('/')[0]}/`
}

/**
 * รายงานอ่านอย่างเดียวสำหรับตรวจก่อนย้ายสคีมา
 *
 * ⚠️ ห้ามคืน checksum ดิบหรือ storage key เต็ม — รายงานนี้มีไว้ให้เจ้าของตัดสินใจ
 *    ไม่ใช่ช่องทางคัดลอกข้อมูลระบุตำแหน่งไบต์ออกจากฐานข้อมูล ชื่อไฟล์ถูกคืนเพราะ
 *    เจ้าของต้องใช้ระบุแถว แต่ไม่มีการอ่านเนื้อไฟล์ใด ๆ ทั้งสิ้น
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: object[] }>,
 *           sampleLimit?: number }} options
 */
export async function legacyKindPreflight({ query, sampleLimit = 50 } = {}) {
  const { rows } = await query(
    `SELECT id, name, path, size_bytes, sha256, uploaded_by
       FROM files
      WHERE vault = false AND deleted_at IS NULL
      ORDER BY id`,
  )

  let provenFiles = 0
  let provenFolders = 0
  const ambiguousSamples = []
  // ⚠️ migration 010 ยังสร้าง unique index ของ "ชื่อต่อโฟลเดอร์ต่อเจ้าของ" (ไม่สนตัวพิมพ์)
  //    แต่ createFolder เดิมไม่เคยบังคับความไม่ซ้ำเลย ข้อมูลเก่าจึงมีโฟลเดอร์ชื่อซ้ำได้จริง
  //    ก่อนย้ายสคีมาทุกแถวยังอยู่ที่ราก (parent_id = NULL) การนับจึงทำต่อเจ้าของ+ชื่อ
  //    ถ้าไม่รายงานล่วงหน้า เจ้าของจะรู้ตัวตอน migration ล้มกลางคันเท่านั้น
  const nameGroups = new Map()

  for (const row of rows) {
    const key = `${row.uploaded_by ?? 'null'}\u0000${String(row.name ?? '').toLowerCase()}`
    nameGroups.set(key, (nameGroups.get(key) ?? 0) + 1)

    const verdict = classifyLegacyRow(row)
    if (verdict === KIND_FILE) provenFiles += 1
    else if (verdict === KIND_FOLDER) provenFolders += 1
    else if (ambiguousSamples.length < sampleLimit) {
      ambiguousSamples.push({
        id: row.id,
        name: row.name,
        sizeBytes: Number(row.size_bytes ?? 0),
        hasSha: hasChecksum(row.sha256 ?? null),
        pathPrefix: pathPrefixOf(row.path),
      })
    }
  }

  const ambiguousRows = rows.length - provenFiles - provenFolders

  const duplicateSamples = []
  for (const [key, count] of nameGroups) {
    if (count < 2) continue
    const [ownerId, name] = key.split('\u0000')
    if (duplicateSamples.length < sampleLimit) duplicateSamples.push({ ownerId, name, count })
  }

  return {
    totalRows: rows.length,
    provenFiles,
    provenFolders,
    ambiguousRows,
    ambiguousSamples,
    duplicateActiveNameGroups: duplicateSamples.length,
    duplicateSamples,
    // ⚠️ ประตูของ Phase 1: ไม่ใช่คำแนะนำ แต่เป็นเงื่อนไขที่การย้ายสคีมาต้องเคารพ
    safeToBackfill: ambiguousRows === 0,
    // ⚠️ การย้ายสคีมาต้องผ่าน **ทั้งสองข้อ**: จำแนกชนิดได้ครบ และไม่มีชื่อซ้ำที่จะทำให้
    //    unique index สร้างไม่ผ่าน การแก้ชื่อซ้ำเป็นการตัดสินใจของเจ้าของข้อมูล
    //    โมดูลนี้จึง **ไม่เปลี่ยนชื่อหรือลบอะไรให้เองเด็ดขาด** — มันรายงานอย่างเดียว
    safeToMigrate: ambiguousRows === 0 && duplicateSamples.length === 0,
  }
}
