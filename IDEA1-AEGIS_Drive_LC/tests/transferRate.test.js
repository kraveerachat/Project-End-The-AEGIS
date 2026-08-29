// tests/transferRate.test.js — AEGIS Drive (IDEA1) · ความเร็วและเวลาที่เหลือ (LFT-V2-E)
//
// ⚠️ สิ่งที่ชุดนี้มีไว้ป้องกันคือ "แถบที่ขยับเองตอนไม่มีอะไรวิ่ง" — ความผิดพลาดชนิดนั้น
//    ไม่ทำให้เทสต์ทั่วไปแดง แต่ทำลายความน่าเชื่อถือของทุกตัวเลขบนหน้าจอพร้อมกัน
//    ทุกเคสจึงป้อน "เวลา" เข้าไปเอง ไม่มีการรอเวลาจริงและไม่มีความคลุมเครือ
//
// ⚠️ เคสที่สำคัญที่สุดสองข้อ:
//    1. เวลาเดินแต่ไบต์ไม่เดิน → ต้องไม่มีความเร็ว ไม่มี ETA และต้องบอกว่าหยุดนิ่ง
//    2. resume ที่เริ่มจากไบต์จำนวนมาก → ต้องไม่คำนวณความเร็วจากไบต์ของเซสชันก่อน
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createRateEstimator, etaParts,
  DEFAULT_STALL_MS, DEFAULT_MIN_SAMPLES,
} from '../src/lib/transferRate.js'
import { fmtRate } from '../src/lib/format.js'

const MB = 1_000_000

/** เดินตัวอย่างจริงชุดหนึ่ง: ก้าวละ 1 MB ทุก 500 ms เริ่มจาก baseline ที่กำหนด */
function walk(est, { from = 0, step = MB, everyMs = 500, steps = 3, totalBytes = null, startAt = 0 }) {
  let out = est.sample(from, startAt, { totalBytes }) // ตัวอย่างแรก = จุดอ้างอิงเสมอ
  for (let i = 1; i <= steps; i += 1) {
    out = est.sample(from + step * i, startAt + everyMs * i, { totalBytes })
  }
  return out
}

test('ยังไม่มีตัวอย่าง = ไม่มีความเร็วและไม่มี ETA (ไม่ใช่ศูนย์)', () => {
  const est = createRateEstimator()
  const first = est.sample(0, 0, { totalBytes: 10 * MB })

  assert.equal(first.bytesPerSecond, null, 'ความเร็วต้องเป็น null ไม่ใช่ 0')
  assert.equal(first.etaSeconds, null)
  assert.equal(first.stalled, false)
})

test('ตัวอย่างเดียวหลังจุดอ้างอิงยังไม่พอที่จะอ้างความเร็ว', () => {
  const est = createRateEstimator()
  est.sample(0, 0, { totalBytes: 10 * MB })
  const second = est.sample(MB, 500, { totalBytes: 10 * MB })

  assert.equal(second.bytesPerSecond, null, `ต้องรออย่างน้อย ${DEFAULT_MIN_SAMPLES} ตัวอย่างจริง`)
  assert.equal(second.etaSeconds, null)
})

test('ความคืบหน้าจริงให้ความเร็วจริง และ ETA = ไบต์ที่เหลือ ÷ ความเร็ว', () => {
  const est = createRateEstimator()
  // 3 MB ใน 1.5 วินาที = 2 MB/s · เหลือ 7 MB จาก 10 MB → 3.5 วินาที
  const out = walk(est, { steps: 3, totalBytes: 10 * MB })

  assert.equal(out.bytesPerSecond, 2 * MB)
  assert.equal(out.stalled, false)
  assert.ok(Math.abs(out.etaSeconds - 3.5) < 1e-9, `ETA ได้ ${out.etaSeconds}`)
})

test('ผลลัพธ์เหมือนเดิมทุกครั้งเมื่อป้อนเวลาชุดเดิม (deterministic)', () => {
  const run = () => walk(createRateEstimator(), { steps: 5, totalBytes: 20 * MB })
  const a = run()
  const b = run()

  assert.deepEqual(a, b)
})

test('เวลาเดินแต่ไบต์ไม่เดิน = หยุดนิ่ง ไม่ใช่ความเร็วเดิมค้างไว้', () => {
  const est = createRateEstimator()
  const moving = walk(est, { steps: 3, totalBytes: 10 * MB })
  assert.ok(moving.bytesPerSecond > 0, 'ต้องมีความเร็วก่อนจึงจะพิสูจน์ได้ว่ามันหายไป')

  // ไบต์เท่าเดิมเป๊ะ เวลาเดินต่อจนครบเกณฑ์หยุดนิ่ง
  const stalled = est.sample(3 * MB, 1500 + DEFAULT_STALL_MS, { totalBytes: 10 * MB })

  assert.equal(stalled.stalled, true)
  assert.equal(stalled.bytesPerSecond, null, 'ห้ามรายงานความเร็วเก่าตอนที่ไม่มีไบต์วิ่ง')
  assert.equal(stalled.etaSeconds, null, 'ETA ที่นับถอยหลังตอนหยุดนิ่งคือคำโกหก')
})

test('ไบต์ไม่ขยับเลยตั้งแต่ต้น = ไม่มีความเร็วปลอมจากเวลาที่ผ่านไป', () => {
  const est = createRateEstimator()
  est.sample(0, 0, { totalBytes: 10 * MB })

  let out = null
  for (let ms = 500; ms <= 10_000; ms += 500) out = est.sample(0, ms, { totalBytes: 10 * MB })

  assert.equal(out.bytesPerSecond, null)
  assert.equal(out.etaSeconds, null)
  assert.equal(out.stalled, true)
})

test('resume ตั้งจุดอ้างอิงใหม่ — ไบต์ของเซสชันก่อนไม่ถูกนับเป็นความเร็ว', () => {
  const est = createRateEstimator()
  // เซสชันก่อนส่งไปแล้ว 500 MB จากไฟล์ 1 GB แล้วเพิ่งส่งต่อได้ 3 MB ใน 1.5 วินาที
  const out = walk(est, { from: 500 * MB, steps: 3, totalBytes: 1_000 * MB })

  assert.equal(out.bytesPerSecond, 2 * MB, 'ต้องเป็น 2 MB/s ไม่ใช่ค่าที่มาจาก 500 MB แรก')
  assert.ok(out.bytesPerSecond < 10 * MB, 'ความเร็วระดับ GB/s = นับไบต์ของเซสชันก่อนเข้ามาแล้ว')
  // เหลือ 497 MB ที่ 2 MB/s ≈ 248.5 วินาที
  assert.ok(Math.abs(out.etaSeconds - 248.5) < 1e-6, `ETA ได้ ${out.etaSeconds}`)
})

test('ไบต์ถอยหลัง (ก้อนที่กำลังส่งล้มเหลว) = เริ่มวัดใหม่ ไม่ใช่ความเร็วติดลบ', () => {
  const est = createRateEstimator()
  walk(est, { steps: 3, totalBytes: 10 * MB })

  // เซิร์ฟเวอร์ยืนยันแค่ 1 MB — ก้อนที่กำลังส่งอยู่ถูกทิ้ง ความคืบหน้าจึงถอยหลัง
  const back = est.sample(MB, 2000, { totalBytes: 10 * MB })

  assert.equal(back.bytesPerSecond, null)
  assert.equal(back.etaSeconds, null)
  assert.equal(back.stalled, false, 'การถอยหลังไม่ใช่การหยุดนิ่ง')
})

test('ไม่รู้ขนาดรวม = มีความเร็วได้ แต่ต้องไม่มี ETA', () => {
  const est = createRateEstimator()
  const out = walk(est, { steps: 3, totalBytes: null })

  assert.equal(out.bytesPerSecond, 2 * MB)
  assert.equal(out.etaSeconds, null)
})

test('หน้าต่างเลื่อนสะท้อน "ตอนนี้" ไม่ใช่ค่าเฉลี่ยตั้งแต่เริ่ม', () => {
  const est = createRateEstimator({ windowMs: 2_000 })
  // ช่วงแรกช้ามาก: 1 MB ใน 4 วินาที
  est.sample(0, 0, { totalBytes: 100 * MB })
  est.sample(MB, 4_000, { totalBytes: 100 * MB })
  // แล้วเน็ตกลับมาเร็ว: 6 MB ใน 3 วินาทีถัดมา
  est.sample(3 * MB, 5_000, { totalBytes: 100 * MB })
  est.sample(5 * MB, 6_000, { totalBytes: 100 * MB })
  const out = est.sample(7 * MB, 7_000, { totalBytes: 100 * MB })

  const cumulativeAverage = (7 * MB) / 7 // = 1 MB/s ถ้าเฉลี่ยตั้งแต่เริ่ม
  assert.ok(out.bytesPerSecond > cumulativeAverage * 1.5,
    `ต้องสะท้อนช่วงล่าสุด ได้ ${out.bytesPerSecond} vs ค่าเฉลี่ยสะสม ${cumulativeAverage}`)
})

test('reset() ล้างประวัติทั้งหมดและตั้งจุดอ้างอิงใหม่', () => {
  const est = createRateEstimator()
  walk(est, { steps: 3, totalBytes: 10 * MB })

  est.reset(3 * MB, 1500)
  const after = est.sample(4 * MB, 2000, { totalBytes: 10 * MB })

  assert.equal(after.bytesPerSecond, null, 'หลัง reset ต้องเริ่มสะสมตัวอย่างใหม่')
})

test('etaParts เลือกหน่วยที่คนอ่านเข้าใจ และปัดขึ้นเสมอ', () => {
  assert.equal(etaParts(null), null)
  assert.equal(etaParts(-1), null)
  assert.equal(etaParts(Infinity), null)

  assert.deepEqual(etaParts(0), { unit: 'seconds', value: 1 }, 'ห้ามแสดง "เหลือ 0 วินาที"')
  assert.deepEqual(etaParts(11.2), { unit: 'seconds', value: 12 })
  assert.deepEqual(etaParts(89), { unit: 'seconds', value: 89 })
  assert.deepEqual(etaParts(90), { unit: 'minutes', value: 2 })
  assert.deepEqual(etaParts(5400), { unit: 'hours', value: 2 })
})

test('fmtRate คืน null เมื่อยังไม่รู้ ไม่ใช่ "0 B/s"', () => {
  assert.equal(fmtRate(null), null)
  assert.equal(fmtRate(undefined), null)
  assert.equal(fmtRate(Number.NaN), null)
  assert.equal(fmtRate(-5), null)

  assert.equal(fmtRate(0), '0 B/s')
  assert.equal(fmtRate(61_236_183), '58.4 MB/s')
})
