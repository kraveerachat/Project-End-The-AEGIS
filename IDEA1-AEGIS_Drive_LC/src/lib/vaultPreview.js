// src/lib/vaultPreview.js — which decrypted Vault files may be rendered inline
//
// ⚠️ โมดูลนี้ตัดสินใจเรื่องเดียว: "ชนิดไฟล์นี้ปลอดภัยพอจะ render ในหน้าเว็บไหม"
//    ไม่แตะ KEK/DEK ไม่ถอดรหัส ไม่มี I/O — เป็น policy ล้วน ๆ จึงทดสอบตรง ๆ ได้
//
// ทำไมต้องเป็น "allowlist" ไม่ใช่ prefix match:
//   `type.startsWith('image/')` ดูสมเหตุสมผลจนกระทั่งเจอ image/svg+xml — SVG คือ
//   เอกสาร XML ที่รัน <script> และ <foreignObject> ได้ การเอา SVG ที่ผู้ใช้อัปโหลด
//   มาใส่ <img> ยังพอกันได้ แต่ policy ที่อ่านแล้ว "เดาไม่ออกว่าอะไรผ่าน" คือ policy
//   ที่จะพังตอนมีคนเพิ่ม type ถัดไป รายชื่อจึงถูกเขียนออกมาทีละบรรทัด
//
// ทำไม PDF / TXT / HTML / DOCX ไม่อยู่ในนี้:
//   การแสดงพวกนี้ต้องใช้ <iframe>/<object>/<embed> หรือ parser ของเราเอง ซึ่งเท่ากับ
//   ยอมให้เนื้อไฟล์ของผู้ใช้ถูก "ตีความ" ในต้นทางเดียวกับแอป — ห้องนิรภัยที่ยอม
//   execute เนื้อหาที่มันเก็บไว้เองคือห้องนิรภัยที่เสียจุดประสงค์ ผู้ใช้จึงดาวน์โหลด
//   ไปเปิดด้วยโปรแกรมในเครื่องแทน (เป็นการตัดสินใจเชิงผลิตภัณฑ์ ไม่ใช่ข้อจำกัดชั่วคราว)

/** ภาพนิ่งแบบ raster ที่ <img> ถอดรหัสเป็น bitmap ได้โดยไม่ตีความสคริปต์ */
export const PREVIEW_IMAGE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

/** คอนเทนเนอร์วิดีโอที่ <video> ของเบราว์เซอร์เล่นจาก object URL ได้ */
export const PREVIEW_VIDEO_TYPES = Object.freeze([
  'video/mp4',
  'video/webm',
  'video/ogg',
])

const IMAGE = new Set(PREVIEW_IMAGE_TYPES)
const VIDEO = new Set(PREVIEW_VIDEO_TYPES)

/** 'IMAGE/PNG; charset=binary' → 'image/png' — พารามิเตอร์ไม่ใช่ส่วนหนึ่งของชนิด */
export function normalizeMimeType(type) {
  return String(type ?? '').split(';')[0].trim().toLowerCase()
}

/**
 * ชนิดของ preview ที่รองรับสำหรับ MIME นี้
 * @returns {'image'|'video'|null} null = ไม่ render ในแอป (ดาวน์โหลดอย่างเดียว)
 */
export function previewKindFor(type) {
  const mime = normalizeMimeType(type)
  if (IMAGE.has(mime)) return 'image'
  if (VIDEO.has(mime)) return 'video'
  return null
}

/**
 * เปิด Preview ให้ entry นี้ได้หรือไม่
 * ⚠️ ล็อกอยู่ = ไม่ได้เสมอ ไม่ว่าชนิดไฟล์จะเป็นอะไร — ขณะล็อกเราไม่รู้ชนิดไฟล์ด้วยซ้ำ
 *    (การรู้ว่ารู้ไม่ได้ คือเหตุผลที่ argument `unlocked` มาก่อนการดู MIME)
 */
export function canPreviewEntry(entry, unlocked) {
  if (!unlocked) return false
  return previewKindFor(entry?.type) !== null
}
