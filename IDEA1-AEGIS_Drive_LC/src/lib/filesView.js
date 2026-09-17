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

export function sortItems(items, sort) {
  return [...items].sort((a, b) =>
    sort === 'name' ? a.name.localeCompare(b.name) : sort === 'size' ? b.size - a.size : b.modified - a.modified,
  )
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
