// src/lib/filesView.js — FILES-MANAGEMENT-UX-1 · Round 8
//
// กฎการ "จัดวาง" ของหน้า Files ที่ต้องเหมือนกันทุกระดับของลำดับชั้น (ราก, โฟลเดอร์,
// โฟลเดอร์ซ้อน) และเหมือนกันทั้งมุมมองกริดและรายการ:
//
//   1. แบ่งรายการตามตัวตนที่เก็บไว้จริง (`kind`) — โฟลเดอร์กลุ่มหนึ่ง ไฟล์อีกกลุ่มหนึ่ง
//   2. โฟลเดอร์มาก่อนไฟล์เสมอ
//   3. การเรียง/ค้นหา/กรอง ทำงาน "ภายใน" แต่ละกลุ่ม ไม่มีทางทำให้สองกลุ่มปนกัน
//
// ⚠️ ห้ามใช้ชื่อหรือนามสกุลตัดสินกลุ่ม — นั่นคือ heuristic ที่ migration 010 ลบทิ้งไป
//    ไฟล์ชื่อ `README` คือไฟล์ โฟลเดอร์ชื่อ `v2.0` คือโฟลเดอร์ ตัวตนอยู่ที่ `kind` เท่านั้น

/** นามสกุลของภาพที่เบราว์เซอร์แสดงได้อย่างปลอดภัย (ไม่มี svg — svg คือเอกสารที่รันสคริปต์ได้) */
export const PREVIEW_IMAGE_EXTS = Object.freeze(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'])
/** วิดีโอที่เบราว์เซอร์เล่นจากสตรีมได้จริง (mov/mkv ไม่ใช่ — ถ้าใส่ไว้จะได้ปุ่มที่กดแล้วเงียบ) */
export const PREVIEW_VIDEO_EXTS = Object.freeze(['mp4', 'webm'])

/**
 * ชนิดของ preview ที่ไฟล์นี้ได้: 'image' | 'video' | null
 *
 * ⚠️ Private Vault คืน null เสมอ — เซิร์ฟเวอร์เห็นแค่ ciphertext จึงไม่มี thumbnail แบบ
 *    plaintext ให้ และการวาดกล่องรูปทับภาษาภาพ hatch ของ Vault คือการโกหกเรื่องขอบเขต
 *    การเข้ารหัส เส้นทาง preview ของ Vault เป็นคนละเส้นทาง (ถอดรหัสฝั่ง client)
 */
export function previewKindFor(file) {
  if (!file || file.kind === 'folder' || file.vault) return null
  const ext = String(file.ext ?? '').toLowerCase()
  if (PREVIEW_IMAGE_EXTS.includes(ext)) return 'image'
  if (PREVIEW_VIDEO_EXTS.includes(ext)) return 'video'
  return null
}

/** เส้นทาง API ของ preview — client รู้แค่ id ไม่มีวันรู้ storage key */
export function previewPathFor(file) {
  return `/api/files/${encodeURIComponent(file.id)}/preview`
}

export function filterItems(items, { query = '', typeFilter = 'all' } = {}) {
  const needle = query.trim().toLowerCase()
  return items.filter((file) => {
    const matchesQuery = needle === '' || file.name.toLowerCase().includes(needle)
    const matchesType = typeFilter === 'all' || file.type === typeFilter
    return matchesQuery && matchesType
  })
}

/** โหมดเรียงที่จอเสนอ — ทุกโหมดบอก "ทิศทาง" ในตัว ไม่มี "Name" เฉย ๆ ที่ผู้ใช้ต้องเดา */
export const SORT_MODES = Object.freeze([
  'name-asc', 'name-desc', 'uploaded-desc', 'uploaded-asc', 'modified-desc', 'modified-asc', 'size-desc', 'size-asc',
])
export const SORT_LABEL_KEYS = Object.freeze({
  'name-asc': 'sortNameAsc', 'name-desc': 'sortNameDesc',
  'uploaded-desc': 'sortUploadedNewest', 'uploaded-asc': 'sortUploadedOldest',
  'modified-desc': 'sortModifiedNewest', 'modified-asc': 'sortModifiedOldest',
  'size-desc': 'sortSizeLargest', 'size-asc': 'sortSizeSmallest',
})
/** ค่าเดิมสามค่าของจอ (ก่อน Round 9) ยังแปลได้ — ไม่มีโหมดที่ไม่รู้จักหลุดไปเรียงมั่ว */
const LEGACY_SORT = Object.freeze({ name: 'name-asc', size: 'size-desc', modified: 'modified-desc' })
export const DEFAULT_SORT = 'modified-desc'
export function normalizeSortMode(mode) {
  return SORT_MODES.includes(mode) ? mode : (LEGACY_SORT[mode] ?? DEFAULT_SORT)
}

// ชื่อเรียงแบบไม่สนตัวพิมพ์และเข้าใจตัวเลข (file2 < file10) — เหมือนที่ file manager ทำ
const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
/** วันอัปโหลด = files.created_at ที่ API ส่งมาเป็น `created`; แถวเก่าที่ไม่มีค่า (seed) ถอยไปใช้ modified */
const uploadedOf = (f) => (Number.isFinite(f.created) ? f.created : f.modified)
const byId = (a, b) => String(a.id).localeCompare(String(b.id))

/**
 * เรียงอย่างคงที่: คีย์หลักตามโหมด แล้วตัดสินคู่ที่เท่ากันด้วย id เสมอ
 * ⚠️ ลำดับที่ป้อนเข้ามาต้องไม่มีผล — ถ้าสองไฟล์ชื่อเดียวกัน ผลต้องเหมือนกันทุกครั้งที่ refetch
 */
export function sortItems(items, sort) {
  const mode = normalizeSortMode(sort)
  const [field, dir] = mode.split('-')
  const sign = dir === 'asc' ? 1 : -1
  const primary = field === 'name' ? (a, b) => nameCollator.compare(a.name, b.name)
    : field === 'size' ? (a, b) => a.size - b.size
      : field === 'uploaded' ? (a, b) => uploadedOf(a) - uploadedOf(b)
        : (a, b) => a.modified - b.modified
  return [...items].sort((a, b) => (sign * primary(a, b)) || byId(a, b))
}

export function partitionByKind(items) {
  const folders = []
  const files = []
  for (const item of items) (item.kind === 'folder' ? folders : files).push(item)
  return { folders, files }
}

/** สองกลุ่ม เรียงแล้ว — นี่คือสิ่งเดียวที่หน้าจอควรวาด */
export function sectionItems(items, sort) {
  const { folders, files } = partitionByKind(items)
  return { folders: sortItems(folders, sort), files: sortItems(files, sort) }
}
