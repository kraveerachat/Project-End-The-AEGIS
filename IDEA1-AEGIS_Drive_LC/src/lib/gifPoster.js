// src/lib/gifPoster.js — FILES-MANAGEMENT-UX-1 · Round 10 · poster นิ่งของ GIF ในเบราว์เซอร์
//
// ⚠️ ทำไมต้องมี: <img src=".gif"> เล่นเองทันทีที่โหลด ไม่มี attribute ใดหยุดมันได้ และ
//    stack นี้ไม่มีตัวสกัดเฟรมฝั่งเซิร์ฟเวอร์ (ไม่เพิ่ม Sharp/FFmpeg เพื่อการนี้) เบราว์เซอร์
//    เองถอด "บิตแมปนิ่ง" ให้ได้ผ่าน createImageBitmap(blob) — สำหรับภาพเคลื่อนไหวจะได้
//    เฟรมแรกเป็นบิตแมปที่ไม่มีวันขยับ วาดลง canvas ที่ย่อให้พอดีกับกล่อง thumbnail แล้ว
//    เก็บเป็น object URL ขนาดเล็ก ที่แสดงตอน idle คือภาพจริงของไฟล์ แต่นิ่ง
//
// ⚠️ ขอบเขต: ทำเฉพาะไฟล์ที่ผ่าน allowlist preview ของเซิร์ฟเวอร์อยู่แล้ว (เจ้าของเท่านั้น,
//    Vault ไม่เคยมาถึงตรงนี้), มีเพดานขนาดไฟล์, poster ถูกย่อก่อนเก็บ, และผู้เรียกต้อง
//    revoke() เมื่อไทล์เปลี่ยนไฟล์หรือ unmount — ไม่มีการถือ blob ทั้งก้อนไว้ข้ามตัวตนไฟล์

/** GIF ที่ใหญ่กว่านี้ไม่ถอด poster (ตอบเป็น "ถอดไม่ได้" ให้ผู้เรียกถอยไปไอคอน) — เพดานแบนด์วิดท์ตอน idle */
export const GIF_POSTER_MAX_BYTES = 20 * 1024 * 1024
/** กล่องที่ poster ถูกย่อให้พอดี (พอสำหรับการ์ด 210px บนจอ 2x) */
export const GIF_POSTER_BOX = Object.freeze({ width: 480, height: 240 })

/** เบราว์เซอร์นี้ถอด poster ได้ไหม — ถ้าไม่ได้ ผู้เรียกใช้ไอคอนแทนอย่างซื่อสัตย์ */
export function gifPosterSupported(g = globalThis) {
  return typeof g.createImageBitmap === 'function'
    && typeof g.fetch === 'function'
    && typeof g.URL?.createObjectURL === 'function'
    && typeof g.document?.createElement === 'function'
}

/**
 * ถอดเฟรมนิ่งของ GIF จากเส้นทาง preview แล้วคืน object URL ของ poster ที่ย่อแล้ว
 *
 * @param {string} url            เส้นทาง preview (same-origin, ส่ง cookie ของ session)
 * @param {{ size?: number, signal?: AbortSignal, box?: {width:number,height:number} }} [options]
 * @returns {Promise<{ url: string, width: number, height: number, revoke: () => void } | null>}
 *   null = ถอดไม่ได้ (ใหญ่เกิน / ไม่รองรับ / ถอดรหัสล้มเหลว) — ไม่ใช่ error ที่ต้องโยนต่อ
 */
export async function createGifPoster(url, { size = 0, signal, box = GIF_POSTER_BOX } = {}) {
  const g = globalThis
  if (!gifPosterSupported(g)) return null
  if (Number.isFinite(size) && size > GIF_POSTER_MAX_BYTES) return null
  let bitmap = null
  let canvas = null
  try {
    const res = await g.fetch(url, { credentials: 'include', signal })
    if (!res?.ok) return null
    const blob = await res.blob()
    if (signal?.aborted) return null
    // ⚠️ createImageBitmap ของภาพเคลื่อนไหวคืน "เฟรมแรก" เป็นบิตแมปนิ่ง — นี่คือหัวใจของงานนี้
    bitmap = await g.createImageBitmap(blob)
    if (signal?.aborted) return null
    const scale = Math.min(1, box.width / bitmap.width, box.height / bitmap.height)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    canvas = g.document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, width, height)
    const posterBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!posterBlob || signal?.aborted) return null
    const objectUrl = g.URL.createObjectURL(posterBlob)
    return { url: objectUrl, width, height, revoke: () => g.URL.revokeObjectURL(objectUrl) }
  } catch {
    return null
  } finally {
    // ปล่อยทรัพยากรหนักทันที: บิตแมปเต็มขนาดและ canvas ไม่ต้องอยู่ต่อหลังได้ poster แล้ว
    try { bitmap?.close?.() } catch { /* ปิดซ้ำได้ */ }
    if (canvas) { canvas.width = 0; canvas.height = 0 }
  }
}
