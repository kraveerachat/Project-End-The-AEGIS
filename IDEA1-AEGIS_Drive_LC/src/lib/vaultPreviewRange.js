// src/lib/vaultPreviewRange.js — AEGIS Drive (IDEA1) · แผนที่จาก "ช่วงไบต์ที่ผู้เล่นขอ"
// ไปเป็น "ก้อน ciphertext ที่ต้องดึงจริง" (LFT-V2-E3)
//
// ⚠️ ทำไมตรรกะนี้ถึงอยู่ในโมดูลของตัวเอง แทนที่จะอยู่ใน Service Worker:
//    Service Worker ทดสอบตรง ๆ ใน node:test ไม่ได้ (ไม่มี FetchEvent ไม่มี registration)
//    ถ้าตรรกะการแมปช่วงไบต์อยู่ในนั้น มันจะกลายเป็นโค้ดที่ "ไม่มีใครทดสอบ" ทั้งที่เป็น
//    จุดที่ผิดพลาดแล้วเงียบที่สุด — คำนวณ offset พลาดหนึ่งไบต์ = วิดีโอเล่นได้แต่ภาพเพี้ยน
//    หรือ seek แล้วกระโดดผิดที่ โดยไม่มี error ให้เห็นเลย ที่นี่จึงเป็นเลขคณิตล้วน ๆ
//    ไม่มี I/O ไม่มีกุญแจ ไม่มี DOM และมีชุดทดสอบตรึงทุกขอบเขต
//
// ⚠️ หน่วยที่ต้องไม่สับสน (สาเหตุของบั๊กประเภทนี้เกือบทั้งหมด):
//      blob.chunkSize        = ขนาด **ciphertext** ของก้อนที่เต็ม (รวม GCM tag แล้ว)
//      plaintextChunkSize    = blob.chunkSize − GCM_TAG_BYTES
//    ผู้เล่นวิดีโอขอช่วงไบต์ในหน่วย **plaintext** เสมอ ส่วนเซิร์ฟเวอร์รู้จักแต่ ciphertext
//    การแปลงเกิดที่นี่จุดเดียว
import { GCM_TAG_BYTES } from './vaultChunkCrypto.js'

/** ส่วนของ path ที่ Service Worker ดักไว้ — ไม่ใช่ endpoint จริงบนเซิร์ฟเวอร์ */
export const PREVIEW_PATH_SEGMENT = '__vault_preview'

/**
 * ขนาด plaintext ต่อหนึ่งก้อนของ blob นี้
 * ⚠️ ใช้สูตรเดียวกับ vaultChunkedDownload.js เป๊ะ ๆ — ถ้าสองที่คำนวณต่างกันแม้ไบต์เดียว
 *    การถอดจะผ่าน (tag ถูก) แต่ไฟล์ที่ประกอบได้จะเพี้ยน ซึ่งจับได้ยากกว่าการถอดไม่ผ่านมาก
 */
export function plaintextChunkSizeFor(blob) {
  return Number(blob.chunkSize) - GCM_TAG_BYTES
}

/**
 * ดึง token ออกจาก path เสมือน — คืน null เมื่อไม่ใช่คำขอของ preview
 * ⚠️ ต้องเป็น segment สุดท้ายและมีเพียงหนึ่งชั้นเท่านั้น: การยอมรับ path ที่ลึกกว่านี้
 *    เปิดช่องให้ URL ที่ผู้อื่นแต่งขึ้นชี้เข้ามาในขอบเขตของ worker โดยไม่ตั้งใจ
 */
export function previewTokenFromPath(pathname) {
  const marker = `/${PREVIEW_PATH_SEGMENT}/`
  const at = String(pathname ?? '').indexOf(marker)
  if (at < 0) return null
  const rest = pathname.slice(at + marker.length)
  if (!rest || rest.includes('/')) return null
  return /^[0-9a-f]{32,64}$/.test(rest) ? rest : null
}

/**
 * ตีความหัวข้อ Range หนึ่งบรรทัด
 *
 * ⚠️ รองรับ "ช่วงเดียว" เท่านั้นโดยเจตนา คำขอหลายช่วง (multipart/byteranges) ถูกตอบเป็น
 *    การส่งทั้งไฟล์แบบสตรีมแทน ซึ่ง **ถูกต้องตามสเปก** และปลอดภัยกว่าการประกอบ
 *    multipart เองผิด ๆ เบราว์เซอร์ไม่เคยขอหลายช่วงกับ <video> อยู่แล้ว
 *
 * @param {string|null} header ค่าดิบของ header 'Range'
 * @param {number} totalBytes ขนาด plaintext ทั้งไฟล์
 * @returns {{ kind: 'none' }
 *          | { kind: 'range', start: number, end: number }
 *          | { kind: 'unsatisfiable' }}
 */
export function parseRangeHeader(header, totalBytes) {
  const total = Math.max(0, Number(totalBytes) || 0)
  const raw = String(header ?? '').trim()
  if (!raw) return { kind: 'none' }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw)
  // หน่วยที่ไม่รู้จัก หรือหลายช่วง → ปฏิบัติเหมือนไม่มี Range (ตอบ 200 ทั้งไฟล์)
  if (!match) return { kind: 'none' }

  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return { kind: 'none' }

  // ไฟล์ว่างตอบช่วงใดไม่ได้เลย — ไม่มีไบต์ให้ชี้
  if (total === 0) return { kind: 'unsatisfiable' }

  if (rawStart === '') {
    // 'bytes=-N' = N ไบต์สุดท้าย
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'unsatisfiable' }
    return { kind: 'range', start: Math.max(0, total - suffix), end: total - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= total) return { kind: 'unsatisfiable' }

  // 'bytes=X-' = ตั้งแต่ X ถึงท้ายไฟล์
  const end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1)
  if (!Number.isFinite(end) || end < start) return { kind: 'unsatisfiable' }

  return { kind: 'range', start, end }
}

/**
 * ก้อนที่ "จำเป็นจริง ๆ" สำหรับช่วง [start, end] และช่วงที่ต้องตัดจากแต่ละก้อน
 *
 * ⚠️ นี่คือเหตุผลทั้งหมดของงานนี้: ผู้เล่นที่ขอ 1 MB จากกลางไฟล์ 4 GiB ต้องทำให้เกิด
 *    การดึง ciphertext แค่หนึ่งหรือสองก้อน ไม่ใช่ทั้งไฟล์ ชุดทดสอบตรึงข้อนี้ไว้ตรง ๆ
 *
 * @param {number} start ไบต์แรกที่ต้องการ (นับรวม)
 * @param {number} end ไบต์สุดท้ายที่ต้องการ (นับรวม)
 * @param {number} plaintextChunkSize
 * @returns {{ index: number, sliceStart: number, sliceEnd: number }[]}
 *          sliceEnd เป็นแบบ "ไม่นับรวม" ตามธรรมเนียมของ subarray()
 */
export function planChunkReads(start, end, plaintextChunkSize) {
  const size = Number(plaintextChunkSize)
  if (!Number.isFinite(size) || size <= 0) throw new Error('invalid plaintext chunk size')
  if (end < start) return []

  const first = Math.floor(start / size)
  const last = Math.floor(end / size)
  const plan = []
  for (let index = first; index <= last; index += 1) {
    const chunkStart = index * size
    plan.push({
      index,
      sliceStart: Math.max(start, chunkStart) - chunkStart,
      sliceEnd: Math.min(end, chunkStart + size - 1) - chunkStart + 1,
    })
  }
  return plan
}

/** ทุกก้อนของไฟล์ เรียงตามลำดับ — ใช้กับคำขอที่ไม่มี Range */
export function planWholeFileReads(plainSize, plaintextChunkSize) {
  if (Number(plainSize) <= 0) return []
  return planChunkReads(0, Number(plainSize) - 1, plaintextChunkSize)
}

/**
 * หัวข้อของคำตอบสื่อ — ค่าคงที่ทั้งชุด ไม่ใช่ค่าที่เดาจากคำขอ
 * ⚠️ Cache-Control: no-store ไม่ใช่ของประดับ: plaintext ของห้องนิรภัยต้องไม่ถูกเก็บ
 *    ไว้ที่ใดนอกหน่วยความจำของแท็บนี้ ไม่ว่าจะเป็น HTTP cache หรือ Cache API
 */
export function buildPreviewHeaders({ contentType, contentLength, contentRange = null }) {
  const headers = {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': String(contentLength),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  }
  if (contentRange) headers['Content-Range'] = contentRange
  return headers
}

/** 'bytes 0-1048575/4294967296' */
export function contentRangeValue(start, end, totalBytes) {
  return `bytes ${start}-${end}/${totalBytes}`
}
