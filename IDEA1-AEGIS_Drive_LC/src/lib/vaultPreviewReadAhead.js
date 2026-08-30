// src/lib/vaultPreviewReadAhead.js — AEGIS Drive (IDEA1) · นโยบายอ่านล่วงหน้าของ preview (LFT-V2-E3.3)
//
// ⚠️ ทำไมต้องมีไฟล์นี้ — หลักฐานจากระบบจริงหลัง PR #56:
//    Range semantics ถูกแล้ว เฟรมแรกขึ้นแล้ว แต่ภาพยังกระตุกตั้งแต่ต้น เพราะเส้นทางเดิม
//    เป็น **demand-driven ล้วน ๆ**: เบราว์เซอร์ขอช่วงหนึ่ง → worker ดึง ciphertext หนึ่งก้อน
//    → ถอดรหัส → ส่งไบต์ → *แล้วค่อย* รอให้เบราว์เซอร์ขอช่วงถัดไป
//
//    ไฟล์จริง START_LIVE.mp4: plaintext 1,206,241,622 ไบต์ ยาว ~120 วินาที
//    → ต้องป้อนสื่อเฉลี่ย ~10 MB/s
//    ก้อน plaintext 16 MiB จึงเป็นภาพแค่ ~1.5–2 วินาที แต่ใช้เวลาดึงจริง ~5–8 วินาที
//    การรอให้ผู้เล่นขอก้อนถัดไปก่อนจึงเริ่มทำงาน = สายเกินไปเสมอ ไม่ว่าเครือข่ายจะเร็วแค่ไหน
//
// ⚠️ สิ่งที่ไฟล์นี้ตัดสินคือ "หน้าต่างงาน" ไม่ใช่ "ขนาดไฟล์":
//    ทุกเพดานในที่นี้เป็นฟังก์ชันของ **ขนาดก้อนกับงบหน่วยความจำ** เท่านั้น
//    ไฟล์ 1.1 GiB / 5 GiB / 32 GiB ได้หน้าต่างเท่ากันเป๊ะ งานรวมเป็น O(หน้าต่าง)
//    ไม่ใช่ O(ขนาดไฟล์) — มีชุดทดสอบตรึงข้อนี้ไว้ตรง ๆ
import { GCM_TAG_BYTES } from './vaultChunkCrypto.js'

/** เพดาน plaintext ที่ยอมให้ค้างในหน่วยความจำของ worker พร้อมกันได้มากที่สุด */
export const MAX_PREVIEW_PLAINTEXT_CACHE_BYTES = 64 * 1024 * 1024

/**
 * เพดานจำนวนก้อนของหน้าต่าง — ไม่ใช่ "จำนวนก้อนที่สมมติไว้ตายตัว"
 *
 * ⚠️ งบไบต์คือกติกาหลัก ตัวเลขนี้เป็นเพียงตัวครอบด้านบนเพื่อไม่ให้ profile ที่มีก้อนเล็กมาก
 *    (เช่นชุดทดสอบที่ใช้ก้อน 1 KiB) แตกเป็นคำขอขนานหลายสิบใบพร้อมกัน ซึ่งเป็นการรุมเซิร์ฟเวอร์
 *    โดยไม่ได้ทำให้ผู้เล่นได้ภาพเร็วขึ้นเลย
 */
export const MAX_PREVIEW_PREFETCH_SLOTS = 4

const positiveInt = (value, fallback) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * หน้าต่างงานหนึ่งชุดสำหรับ blob ที่มีขนาดก้อนเท่านี้
 *
 * @param {{ plaintextChunkSize: number, maxPlaintextBytes?: number, maxSlots?: number }} options
 * @returns {{ cacheSlots: number, prefetchAhead: number, maxInFlight: number,
 *             maxSpeculativeInFlight: number, plaintextCeilingBytes: number,
 *             ciphertextCeilingBytes: number }}
 */
export function previewChunkWindow({
  plaintextChunkSize,
  maxPlaintextBytes = MAX_PREVIEW_PLAINTEXT_CACHE_BYTES,
  maxSlots = MAX_PREVIEW_PREFETCH_SLOTS,
} = {}) {
  const chunkSize = positiveInt(plaintextChunkSize, MAX_PREVIEW_PLAINTEXT_CACHE_BYTES)
  const byteBudget = positiveInt(maxPlaintextBytes, MAX_PREVIEW_PLAINTEXT_CACHE_BYTES)
  const slotCap = positiveInt(maxSlots, MAX_PREVIEW_PREFETCH_SLOTS)

  // ★ นี่คือสูตรทั้งหมด: จำนวนก้อนที่ถือไว้ได้ = งบไบต์ ÷ ขนาดก้อน
  //   16 MiB → 4 ก้อน (ปัจจุบัน + 3)   32 MiB → 2 ก้อน (ปัจจุบัน + 1)   64 MiB → 1 ก้อน (ไม่อ่านล่วงหน้า)
  // ⚠️ ก้อนที่ใหญ่กว่างบทั้งก้อนยังต้อง "อ่านได้" จึงคืนอย่างน้อยหนึ่งช่อง — ตัวแคชเป็นคนทิ้ง
  //    ก้อนที่เกินเพดานไบต์ทีหลัง (ดู vaultPreviewWorkerState.js) แทนที่จะปฏิเสธการเล่นทั้งไฟล์
  const cacheSlots = Math.max(1, Math.min(slotCap, Math.floor(byteBudget / chunkSize)))
  // ⚠️ งานเก็งล่วงหน้ายึดช่องได้ไม่ครบทุกช่อง — ต้องเหลือที่ให้ก้อนที่ผู้เล่นขอจริงเสมอ
  const maxSpeculativeInFlight = Math.max(0, cacheSlots - 1)
  // ★ ช่องสำรองหนึ่งช่องสำหรับ foreground ตอน seek
  //
  //   ตอนกระโดดจากก้อน 10 ไป 50 ช่องทั้งหมดอาจถูกยึดไว้แล้วโดย "ก้อน 10 ที่ยังดึงอยู่ +
  //   งานเก็ง 11/12/13 ที่เริ่มไปแล้ว" งานที่เริ่มไปแล้วปล่อยให้จบได้ (สัญญาการเป็นเจ้าของ
  //   ร่วมจาก E3.2 ทำให้การยกเลิกมันซับซ้อนเกินคุ้ม) แต่ก้อน 50 ต้องเริ่ม **ทันที** ไม่ใช่
  //   รออีกหนึ่งรอบการดึงเต็ม ๆ (~5–8 วินาทีในระบบจริง) ช่องนี้จึงเปิดให้เฉพาะ foreground
  //   และเฉพาะตอนที่งานเก็งเป็นตัวยึดช่องอยู่จริงเท่านั้น
  const maxTotalInFlight = maxSpeculativeInFlight > 0 ? cacheSlots + 1 : cacheSlots

  return {
    cacheSlots,
    // ก้อนปัจจุบันกินหนึ่งช่องเสมอ ที่เหลือคือระยะอ่านล่วงหน้า
    prefetchAhead: cacheSlots - 1,
    maxInFlight: cacheSlots,
    maxSpeculativeInFlight,
    maxTotalInFlight,
    plaintextCeilingBytes: cacheSlots * chunkSize,
    // ciphertext ที่ลอยอยู่ระหว่างทางก็ต้องมีเพดาน ไม่ใช่บอกแต่เพดานของ plaintext
    // ⚠️ นับจาก maxTotalInFlight ไม่ใช่ cacheSlots — ช่องสำรองก็กิน arrayBuffer จริงหนึ่งก้อน
    ciphertextCeilingBytes: maxTotalInFlight * (chunkSize + GCM_TAG_BYTES),
  }
}

/**
 * ดัชนีก้อนที่ควรอ่านล่วงหน้าถัดจาก foreground
 *
 * ⚠️ ต่อเนื่องไปข้างหน้าเท่านั้น: การเล่นวิดีโอเดินหน้าทางเดียว การเดาถอยหลังคือการใช้
 *    ช่องที่มีจำกัดไปกับก้อนที่ผู้เล่นเพิ่งผ่านมาแล้ว
 */
export function prefetchIndexesAfter(foregroundIndex, { prefetchAhead, chunkCount }) {
  const from = Math.floor(Number(foregroundIndex))
  const ahead = Math.max(0, Math.floor(Number(prefetchAhead)) || 0)
  const total = Math.floor(Number(chunkCount))
  const indexes = []
  for (let i = 1; i <= ahead; i += 1) {
    const next = from + i
    if (Number.isFinite(total) && total > 0 && next >= total) break
    indexes.push(next)
  }
  return indexes
}

/**
 * ก้อนนี้ยังอยู่ในหน้าต่างที่ foreground ปัจจุบันสนใจไหม
 * ⚠️ ใช้ตอน seek: กระโดดจากก้อน 10 ไป 50 แล้ว งานเก็งของ 11/12/13 ที่ยัง "รออยู่ในคิว"
 *    ต้องถูกทิ้ง ไม่ใช่ปล่อยให้มันได้ช่องก่อนก้อน 50
 */
export function withinReadAheadWindow(index, foregroundIndex, prefetchAhead) {
  const i = Math.floor(Number(index))
  const head = Math.floor(Number(foregroundIndex))
  const ahead = Math.max(0, Math.floor(Number(prefetchAhead)) || 0)
  return i >= head && i <= head + ahead
}
