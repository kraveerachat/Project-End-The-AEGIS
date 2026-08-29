// src/lib/transferRate.js — AEGIS Drive (IDEA1) · ตัวประมาณความเร็วและเวลาที่เหลือ (LFT-V2-E)
//
// ⚠️ กติกาข้อเดียวที่สำคัญที่สุดของไฟล์นี้: **ตัวเลขทุกตัวมาจากไบต์จริงเท่านั้น**
//    ไม่มี timer ที่เดินเอง ไม่มีการ "เติม" ความคืบหน้าให้ดูสวย ไม่มีค่าเริ่มต้นที่แต่งขึ้น
//    แถบที่ขยับตอนเน็ตหยุดคือแถบที่โกหก และผู้ใช้จะเลิกเชื่อตัวเลขทุกตัวบนจอทันที
//    ที่จับได้ครั้งแรก — เราจึงยอม "ไม่แสดงอะไรเลย" ดีกว่าแสดงค่าที่เดาขึ้นมา
//
// ⚠️ ทำไมเป็น rolling window ไม่ใช่ค่าเฉลี่ยตั้งแต่เริ่ม:
//    ค่าเฉลี่ยสะสมทำให้ ETA "จำ" ช่วงที่เน็ตช้าไปตลอดกาล ผู้ใช้ที่เน็ตกลับมาเร็วแล้วจะ
//    ยังเห็นเวลาที่เหลือยาวเกินจริงอีกหลายนาที หน้าต่างเลื่อนสะท้อน "ตอนนี้" ซึ่งเป็น
//    สิ่งเดียวที่ ETA ควรพยากรณ์จาก
//
// ⚠️ ทำไมต้องมี baseline ตอน resume:
//    การ resume เริ่มจาก transferredBytes ที่ไม่ใช่ศูนย์ (ก้อนที่ส่งไปแล้วในเซสชันก่อน)
//    ถ้านับไบต์ก้อนนั้นเป็น "ไบต์ที่เพิ่งวิ่งผ่านสาย" ตัวอย่างแรกจะได้ความเร็วระดับ GB/s
//    ที่เป็นไปไม่ได้ — ตัวอย่างแรกของทุกเซสชันจึงเป็น "จุดอ้างอิง" เท่านั้น ไม่ใช่การวัด
//
// ใช้ร่วมกันได้ทั้ง Vault (Vault.jsx) และ Normal Files (UploadDrawer/Uploads) — โมดูลนี้
// ไม่รู้จัก React ไม่รู้จัก DOM และไม่เรียก performance.now() เอง ผู้เรียกส่งเวลาเข้ามา
// เสมอ เพื่อให้ชุดทดสอบตรึงพฤติกรรมได้แบบ deterministic

import { fmtRate } from './format.js'

/** ความยาวหน้าต่างที่ใช้คำนวณความเร็ว — สั้นเกินไปตัวเลขกระโดด ยาวเกินไปตอบสนองช้า */
export const DEFAULT_WINDOW_MS = 5_000

/** ไม่มีไบต์เพิ่มนานเท่านี้ = บอกผู้ใช้ตรง ๆ ว่ากำลังรอ ไม่ใช่ปล่อยให้ ETA นับถอยหลังลวง */
export const DEFAULT_STALL_MS = 4_000

/** ต้องมีอย่างน้อยเท่านี้ "ตัวอย่างที่มีไบต์เพิ่มจริง" ก่อนกล้าแสดงความเร็ว */
export const DEFAULT_MIN_SAMPLES = 3

/** และหน้าต่างต้องกว้างอย่างน้อยเท่านี้ — ไบต์ 3 ก้อนใน 20 ms ไม่ใช่หลักฐานของอะไรเลย */
export const DEFAULT_MIN_ELAPSED_MS = 750

/**
 * สร้างตัวประมาณหนึ่งตัวต่อ "หนึ่งการโอน" — สร้างใหม่ทุกครั้งที่เริ่มหรือ resume
 *
 * @param {{ windowMs?: number, stallMs?: number,
 *           minSamples?: number, minElapsedMs?: number }} [options]
 */
export function createRateEstimator({
  windowMs = DEFAULT_WINDOW_MS,
  stallMs = DEFAULT_STALL_MS,
  minSamples = DEFAULT_MIN_SAMPLES,
  minElapsedMs = DEFAULT_MIN_ELAPSED_MS,
} = {}) {
  /** @type {{ t: number, bytes: number }[]} ตัวอย่างในหน้าต่าง เรียงตามเวลาเสมอ */
  let samples = []
  /** ไบต์สูงสุดที่เคยเห็น — ใช้ตรวจ "หยุดนิ่ง" แยกจากไบต์ล่าสุดที่อาจถอยหลัง */
  let peakBytes = 0
  /** เวลาที่ไบต์เพิ่มขึ้นครั้งล่าสุด — ฐานของการตัดสินว่าหยุดนิ่ง */
  let lastAdvanceAt = null
  /** จำนวนตัวอย่างที่ "มีไบต์เพิ่มจริง" ตั้งแต่ตั้งจุดอ้างอิง (ไม่ใช่จำนวนครั้งที่ถูกเรียก) */
  let advances = 0

  const empty = Object.freeze({
    bytesPerSecond: null,
    etaSeconds: null,
    stalled: false,
    transferredBytes: 0,
    totalBytes: null,
  })

  /** ตั้งจุดอ้างอิงใหม่ — ไบต์ที่มีอยู่ ณ วินาทีนี้ "ไม่นับ" ว่าวิ่งผ่านสายในเซสชันนี้ */
  function reset(transferredBytes = 0, nowMs = 0) {
    const bytes = Math.max(0, Number(transferredBytes) || 0)
    samples = [{ t: Number(nowMs) || 0, bytes }]
    peakBytes = bytes
    lastAdvanceAt = Number(nowMs) || 0
    advances = 0
  }

  function trim(nowMs) {
    // เก็บตัวอย่างแรกที่ยังอยู่นอกหน้าต่างไว้หนึ่งตัวเสมอ ไม่งั้นหน้าต่างจะแคบลงเรื่อย ๆ
    // จนเหลือช่วงเวลาสั้นมากแล้วความเร็วจะกระโดดตามสัญญาณรบกวนของ progress event
    let cut = 0
    for (let i = 0; i < samples.length; i += 1) {
      if (nowMs - samples[i].t <= windowMs) break
      cut = i
    }
    if (cut > 0) samples = samples.slice(cut)
  }

  /**
   * บันทึกความคืบหน้าจริงหนึ่งจุด แล้วคืนค่าที่จอแสดงได้ทันที
   *
   * @param {number} transferredBytes ไบต์สะสมที่ "ยืนยันแล้ว + กำลังส่งอยู่จริง"
   * @param {number} nowMs เวลาจาก performance.now() ของผู้เรียก
   * @param {{ totalBytes?: number|null }} [meta]
   * @returns {{ bytesPerSecond: number|null, etaSeconds: number|null, stalled: boolean,
   *             transferredBytes: number, totalBytes: number|null }}
   */
  function sample(transferredBytes, nowMs, { totalBytes = null } = {}) {
    const now = Number(nowMs) || 0
    const bytes = Math.max(0, Number(transferredBytes) || 0)
    const total = Number.isFinite(Number(totalBytes)) && Number(totalBytes) > 0
      ? Number(totalBytes)
      : null

    if (samples.length === 0) {
      // ตัวอย่างแรก = จุดอ้างอิงเท่านั้น ยังไม่มีอะไรให้วัด (นี่คือกติกาของ resume)
      reset(bytes, now)
      return { ...empty, transferredBytes: bytes, totalBytes: total }
    }

    const previous = samples[samples.length - 1]

    if (bytes < peakBytes) {
      // ไบต์ถอยหลังได้จริงเมื่อก้อนที่กำลังส่งล้มเหลวแล้วความคืบหน้าถูกคำนวณใหม่จาก
      // "ก้อนที่เซิร์ฟเวอร์ยืนยันแล้ว" เท่านั้น — นั่นไม่ใช่ความเร็วติดลบ แต่เป็นการเริ่ม
      // วัดรอบใหม่ ตั้งจุดอ้างอิงใหม่แล้วรอตัวอย่างจริงชุดถัดไป
      reset(bytes, now)
      return { ...empty, transferredBytes: bytes, totalBytes: total }
    }

    if (bytes > peakBytes) {
      peakBytes = bytes
      lastAdvanceAt = now
      advances += 1
    }

    // เวลาที่ไม่เดินหน้า (นาฬิกาเดียวกันถูกเรียกซ้ำ) ไม่ใช่ตัวอย่างใหม่ — ทับตัวเดิม
    if (now <= previous.t) samples[samples.length - 1] = { t: previous.t, bytes }
    else samples.push({ t: now, bytes })
    trim(now)

    const stalled = lastAdvanceAt !== null && now - lastAdvanceAt >= stallMs
    if (stalled) {
      // ⚠️ หยุดนิ่ง = ไม่มีความเร็วให้รายงาน และ ETA ที่คำนวณจากความเร็วเก่าคือคำโกหก
      //    ที่นับถอยหลังไปเรื่อย ๆ ทั้งที่ไม่มีไบต์ใดวิ่งเลย
      return { bytesPerSecond: null, etaSeconds: null, stalled: true, transferredBytes: bytes, totalBytes: total }
    }

    const first = samples[0]
    const last = samples[samples.length - 1]
    const elapsedMs = last.t - first.t
    const deltaBytes = last.bytes - first.bytes

    if (advances < minSamples || elapsedMs < minElapsedMs || deltaBytes <= 0) {
      // ยังไม่มีหลักฐานพอ — จอต้องแสดง "กำลังเริ่ม" ไม่ใช่ตัวเลขที่ยังไม่มีความหมาย
      return { bytesPerSecond: null, etaSeconds: null, stalled: false, transferredBytes: bytes, totalBytes: total }
    }

    const bytesPerSecond = (deltaBytes / elapsedMs) * 1000

    let etaSeconds = null
    if (total !== null && bytesPerSecond > 0) {
      const remaining = Math.max(0, total - bytes)
      etaSeconds = remaining / bytesPerSecond
    }

    return { bytesPerSecond, etaSeconds, stalled: false, transferredBytes: bytes, totalBytes: total }
  }

  return { sample, reset }
}

/**
 * แปลงวินาทีเป็น "หน่วยที่คนอ่านแล้วเข้าใจทันที" — คืน key ของ i18n ไม่ใช่ข้อความ
 * ⚠️ ปัดขึ้นเสมอ: "เหลือ 0 วินาที" ทั้งที่ยังส่งอยู่คือตัวเลขที่ผิดในสายตาผู้ใช้
 * @param {number|null} seconds
 * @returns {{ unit: 'seconds'|'minutes'|'hours', value: number }|null}
 */
export function etaParts(seconds) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null
  if (seconds < 90) return { unit: 'seconds', value: Math.max(1, Math.ceil(seconds)) }
  if (seconds < 5400) return { unit: 'minutes', value: Math.ceil(seconds / 60) }
  return { unit: 'hours', value: Math.ceil(seconds / 3600) }
}

/**
 * บรรทัดเดียวที่ผู้ใช้อ่าน: "<ความเร็วจริง> · <เวลาที่เหลือ>"
 *
 * ⚠️ อยู่ใน lib ไม่ใช่ในจอ เพราะ Normal Files (UploadDrawer/Uploads) ต้องพูดประโยค
 *    เดียวกันกับ Vault เป๊ะ ๆ — ถ้าคัดลอกตรรกะไปอีกที่ สองจอจะเริ่มโกหกคนละแบบกัน
 * ⚠️ ลำดับการตัดสินใจสำคัญ: "หยุดนิ่ง" มาก่อนเสมอ การโชว์ความเร็วเก่าค้างไว้ตอนที่ไม่มี
 *    ไบต์วิ่งเลยคือคำโกหกที่แนบเนียนที่สุดในหน้าจอแบบนี้
 * ⚠️ คืน null = "ยังไม่มีอะไรจริงให้พูด" ผู้เรียกต้องไม่เติมข้อความเองแทน
 *
 * @param {(key: string, vars?: object) => string} t
 * @param {{ bytesPerSecond: number|null, etaSeconds: number|null, stalled: boolean }|null} rate
 */
export function transferRateLine(t, rate) {
  if (!rate) return null
  if (rate.stalled) return t('vaultXferStalled')

  const speed = fmtRate(rate.bytesPerSecond)
  if (!speed) return t('vaultXferMeasuring')

  const eta = etaParts(rate.etaSeconds)
  if (!eta) return t('vaultXferRateOnly', { rate: speed })

  const etaKey = eta.unit === 'seconds' ? 'vaultXferEtaSeconds'
    : eta.unit === 'minutes' ? 'vaultXferEtaMinutes'
      : 'vaultXferEtaHours'
  return t('vaultXferRateLine', { rate: speed, eta: t(etaKey, { n: eta.value }) })
}
