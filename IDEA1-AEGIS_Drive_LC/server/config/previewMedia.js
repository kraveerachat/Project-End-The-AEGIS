// server/config/previewMedia.js — AEGIS Drive (IDEA1) · allowlist "เดียว" ของชนิดที่ preview ได้
//
// ⚠️ ย้ายมาจาก routes/api.js แบบรักษาพฤติกรรม (Round 8 preview route): ชุดนามสกุลนี้คือขอบเขตของ
//    การอนุญาต ทั้ง GET /api/files/:id/preview และท่อ derivative (probe/poster/motion/routes) ต้อง
//    import จากที่นี่เท่านั้น — ห้ามมี allowlist ชุดที่สองที่ไหนอีก (spec §6, plan Task 4)
// ⚠️ ไม่มี svg (ทำงานสคริปต์ได้), ไม่มี heic/pdf/office — การเพิ่มชนิดคือการตัดสินใจแยกต่างหาก
// ⚠️ MIME มาจากนามสกุลของ "ชื่อในฐานข้อมูล" ไม่ใช่จาก client และไม่ใช่การ sniff ไบต์:
//    ตัว probe (media/probe.js) เป็นผู้ยืนยันภายหลังว่าไบต์ตรงกับตระกูลของนามสกุลจริง

export const PREVIEW_MIME = Object.freeze({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm',
})

export const PREVIEW_EXTENSIONS = Object.freeze(Object.keys(PREVIEW_MIME))

/**
 * นามสกุลตัวสุดท้ายของชื่อ (ตัวพิมพ์เล็ก) — ชื่อที่ไม่มีจุดไม่มีนามสกุล (null)
 * เหมือน `name.toLowerCase().split('.').pop()` ของ route เดิมทุกประการ: 'x.tar.gz' → 'gz'
 * @param {string} name
 * @returns {string|null}
 */
export function previewExtForName(name) {
  const text = String(name ?? '')
  if (!text.includes('.')) return null
  return text.toLowerCase().split('.').pop()
}

/** @param {string} ext */
export function isPreviewableExtension(ext) {
  return typeof ext === 'string' && Object.hasOwn(PREVIEW_MIME, ext.toLowerCase())
}

/**
 * MIME ที่ route preview ประกาศสำหรับชื่อนี้ — null = ไม่รองรับ (route ตอบ 415)
 * @param {string} name
 * @returns {string|null}
 */
export function previewMimeForName(name) {
  const ext = previewExtForName(name)
  return ext !== null && isPreviewableExtension(ext) ? PREVIEW_MIME[ext] : null
}
