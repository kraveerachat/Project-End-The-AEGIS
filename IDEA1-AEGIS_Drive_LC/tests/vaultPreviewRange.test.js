// tests/vaultPreviewRange.test.js — AEGIS Drive (IDEA1) · การแมปช่วงไบต์ของ preview (LFT-V2-E3)
//
// ⚠️ ความผิดพลาดที่ชุดนี้มีไว้จับคือชนิดที่ **ไม่มี error ให้เห็น**: คำนวณ offset พลาด
//    หนึ่งไบต์แล้ววิดีโอยังเล่นได้ แต่ภาพเพี้ยนหรือ seek ไปผิดตำแหน่ง ทุกเคสจึงระบุ
//    ตัวเลขที่คาดหวังไว้ตรง ๆ แทนที่จะเทียบกับผลลัพธ์ของฟังก์ชันเดียวกัน
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseRangeHeader, planChunkReads, planWholeFileReads,
  plaintextChunkSizeFor, previewTokenFromPath,
  buildPreviewHeaders, contentRangeValue, PREVIEW_PATH_SEGMENT,
} from '../src/lib/vaultPreviewRange.js'
import { GCM_TAG_BYTES } from '../src/lib/vaultChunkCrypto.js'

const MIB = 1024 * 1024
const PCS = 32 * MIB                       // plaintext ต่อก้อน
const blobWith = (chunkSize, chunkCount) => ({ chunkSize, chunkCount })

test('ขนาด plaintext ต่อก้อน = chunkSize ของ ciphertext ลบ GCM tag', () => {
  assert.equal(plaintextChunkSizeFor(blobWith(PCS + GCM_TAG_BYTES, 4)), PCS)
  assert.equal(plaintextChunkSizeFor(blobWith(8 * MIB + 16, 1)), 8 * MIB)
})

// ── การตีความ Range ────────────────────────────────────────────────────────
test('ไม่มี Range = ส่งทั้งไฟล์ ไม่ใช่ 416', () => {
  assert.deepEqual(parseRangeHeader(null, 1000), { kind: 'none' })
  assert.deepEqual(parseRangeHeader('', 1000), { kind: 'none' })
  assert.deepEqual(parseRangeHeader('   ', 1000), { kind: 'none' })
})

test('หน่วยที่ไม่รู้จักหรือหลายช่วง = ปฏิบัติเหมือนไม่มี Range (ถูกต้องตามสเปก)', () => {
  assert.deepEqual(parseRangeHeader('items=0-10', 1000), { kind: 'none' })
  assert.deepEqual(parseRangeHeader('bytes=0-10,20-30', 1000), { kind: 'none' })
  assert.deepEqual(parseRangeHeader('bytes=abc-def', 1000), { kind: 'none' })
})

test('bytes=X-Y ตีความตรงตัว และปลาย Y ถูกหนีบไว้ที่ไบต์สุดท้ายของไฟล์', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-99', 1000), { kind: 'range', start: 0, end: 99 })
  assert.deepEqual(parseRangeHeader('bytes=500-499999', 1000), { kind: 'range', start: 500, end: 999 })
  assert.deepEqual(parseRangeHeader('bytes=999-999', 1000), { kind: 'range', start: 999, end: 999 })
})

test('bytes=X- คือ "จากตรงนี้ถึงท้ายไฟล์" — คำขอที่ผู้เล่นวิดีโอใช้บ่อยที่สุด', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-', 1000), { kind: 'range', start: 0, end: 999 })
  assert.deepEqual(parseRangeHeader('bytes=750-', 1000), { kind: 'range', start: 750, end: 999 })
})

test('bytes=-N คือ N ไบต์สุดท้าย — MP4 ที่ moov อยู่ท้ายไฟล์พึ่งคำขอนี้', () => {
  assert.deepEqual(parseRangeHeader('bytes=-100', 1000), { kind: 'range', start: 900, end: 999 })
  // ขอมากกว่าที่มี = ได้ทั้งไฟล์ ไม่ใช่ error
  assert.deepEqual(parseRangeHeader('bytes=-5000', 1000), { kind: 'range', start: 0, end: 999 })
  assert.deepEqual(parseRangeHeader('bytes=-0', 1000), { kind: 'unsatisfiable' })
})

test('ช่วงที่ชี้นอกไฟล์ = 416 ไม่ใช่การส่งไบต์ที่ใกล้เคียง', () => {
  assert.deepEqual(parseRangeHeader('bytes=1000-1010', 1000), { kind: 'unsatisfiable' })
  assert.deepEqual(parseRangeHeader('bytes=1500-', 1000), { kind: 'unsatisfiable' })
  assert.deepEqual(parseRangeHeader('bytes=90-10', 1000), { kind: 'unsatisfiable' })
  assert.deepEqual(parseRangeHeader('bytes=0-0', 0), { kind: 'unsatisfiable' }, 'ไฟล์ว่างไม่มีไบต์ให้ชี้')
})

// ── แผนการดึงก้อน — หัวใจของงานนี้ ─────────────────────────────────────────
test('ไบต์แรกสุดของไฟล์ต้องดึงก้อนเดียวเท่านั้น', () => {
  assert.deepEqual(planChunkReads(0, 0, PCS), [{ index: 0, sliceStart: 0, sliceEnd: 1 }])
})

test('ช่วงกลางของก้อนเดียวไม่ลามไปก้อนข้างเคียง', () => {
  const plan = planChunkReads(PCS + 100, PCS + 199, PCS)
  assert.deepEqual(plan, [{ index: 1, sliceStart: 100, sliceEnd: 200 }])
  assert.equal(plan.length, 1, 'ขอ 100 ไบต์กลางก้อน ต้องดึงก้อนเดียว')
})

test('ช่วงที่คร่อมสองก้อน ดึงสองก้อน และรอยต่อไม่ทับกันหรือขาดหาย', () => {
  // 10 ไบต์สุดท้ายของก้อน 0 ต่อด้วย 10 ไบต์แรกของก้อน 1
  const plan = planChunkReads(PCS - 10, PCS + 9, PCS)
  assert.deepEqual(plan, [
    { index: 0, sliceStart: PCS - 10, sliceEnd: PCS },
    { index: 1, sliceStart: 0, sliceEnd: 10 },
  ])
  const bytes = plan.reduce((n, s) => n + (s.sliceEnd - s.sliceStart), 0)
  assert.equal(bytes, 20, 'จำนวนไบต์รวมต้องเท่ากับช่วงที่ขอพอดี — ไม่ขาด ไม่เกิน')
})

test('ไบต์สุดท้ายของไฟล์ดึงเฉพาะก้อนสุดท้าย', () => {
  const plainSize = PCS * 3 + 1234        // สี่ก้อน ก้อนสุดท้ายเป็นเศษ
  const last = plainSize - 1
  assert.deepEqual(planChunkReads(last, last, PCS), [{ index: 3, sliceStart: 1233, sliceEnd: 1234 }])
})

test('ก้อนสุดท้ายทั้งก้อน (ที่เป็นเศษ) ถูกแมปครบพอดี', () => {
  const plainSize = PCS * 3 + 1234
  const plan = planChunkReads(PCS * 3, plainSize - 1, PCS)
  assert.deepEqual(plan, [{ index: 3, sliceStart: 0, sliceEnd: 1234 }])
})

test('ขอบก้อนพอดีเป๊ะ ๆ ไม่หลุดไปก้อนถัดไปโดยไม่จำเป็น', () => {
  // ไบต์สุดท้ายของก้อน 0 เท่านั้น
  assert.deepEqual(planChunkReads(PCS - 1, PCS - 1, PCS), [{ index: 0, sliceStart: PCS - 1, sliceEnd: PCS }])
  // ไบต์แรกของก้อน 1 เท่านั้น
  assert.deepEqual(planChunkReads(PCS, PCS, PCS), [{ index: 1, sliceStart: 0, sliceEnd: 1 }])
  // ก้อน 0 ทั้งก้อน — ต้องไม่ดึงก้อน 1 มาด้วย
  const whole = planChunkReads(0, PCS - 1, PCS)
  assert.equal(whole.length, 1)
  assert.deepEqual(whole[0], { index: 0, sliceStart: 0, sliceEnd: PCS })
})

test('ไฟล์ระดับกิกะไบต์: ขอ 1 MiB กลางไฟล์ 4 GiB ต้องแตะแค่หนึ่งหรือสองก้อน', () => {
  const FOUR_GIB = 4 * 1024 * MIB
  const start = Math.floor(FOUR_GIB / 2)
  const plan = planChunkReads(start, start + MIB - 1, PCS)

  assert.ok(plan.length <= 2, `ต้องดึงไม่เกินสองก้อน แต่ได้ ${plan.length}`)
  const fetched = plan.length * PCS
  assert.ok(fetched < FOUR_GIB / 50,
    'ปริมาณ ciphertext ที่ต้องดึงต้องเล็กกว่าไฟล์อย่างมาก — นั่นคือทั้งหมดของงานนี้')
})

test('ช่วงที่กลับด้าน (end < start) ให้แผนว่าง ไม่ใช่ลูปไม่รู้จบ', () => {
  assert.deepEqual(planChunkReads(500, 499, PCS), [])
})

test('ขนาดก้อนที่ไม่ถูกต้องทำให้ล้มทันที ไม่ใช่คำนวณเงียบ ๆ ผิด ๆ', () => {
  assert.throws(() => planChunkReads(0, 10, 0), /invalid plaintext chunk size/)
  assert.throws(() => planChunkReads(0, 10, -1), /invalid plaintext chunk size/)
  assert.throws(() => planChunkReads(0, 10, Number.NaN), /invalid plaintext chunk size/)
})

test('แผนของทั้งไฟล์ครอบคลุมทุกไบต์พอดีหนึ่งครั้ง', () => {
  const plainSize = PCS * 2 + 777
  const plan = planWholeFileReads(plainSize, PCS)

  assert.deepEqual(plan.map((s) => s.index), [0, 1, 2])
  const bytes = plan.reduce((n, s) => n + (s.sliceEnd - s.sliceStart), 0)
  assert.equal(bytes, plainSize, 'รวมทุกก้อนต้องได้ขนาดไฟล์เป๊ะ')
  assert.deepEqual(planWholeFileReads(0, PCS), [], 'ไฟล์ว่างไม่มีอะไรให้ดึง')
})

// ── path เสมือน ────────────────────────────────────────────────────────────
test('ดึง token จาก path เสมือนได้ และปฏิเสธรูปแบบที่ไม่ใช่', () => {
  const token = 'a'.repeat(32)
  assert.equal(previewTokenFromPath(`/drive/${PREVIEW_PATH_SEGMENT}/${token}`), token)
  assert.equal(previewTokenFromPath(`/${PREVIEW_PATH_SEGMENT}/${token}`), token)

  assert.equal(previewTokenFromPath('/drive/api/vault/blobs/x/chunks/0'), null,
    'คำขอปกติต้องไม่ถูกดักโดยเด็ดขาด')
  assert.equal(previewTokenFromPath('/drive/'), null)
  assert.equal(previewTokenFromPath(`/drive/${PREVIEW_PATH_SEGMENT}/`), null)
  assert.equal(previewTokenFromPath(`/drive/${PREVIEW_PATH_SEGMENT}/${token}/extra`), null,
    'path ที่ลึกกว่าหนึ่งชั้นต้องไม่ผ่าน')
  assert.equal(previewTokenFromPath(`/drive/${PREVIEW_PATH_SEGMENT}/not-hex-token`), null)
  assert.equal(previewTokenFromPath(`/drive/${PREVIEW_PATH_SEGMENT}/abc`), null, 'สั้นเกินไป')
  assert.equal(previewTokenFromPath(null), null)
})

// ── header ─────────────────────────────────────────────────────────────────
test('header ของสื่อครบและ no-store เสมอ', () => {
  const h = buildPreviewHeaders({
    contentType: 'video/mp4', contentLength: 1024, contentRange: contentRangeValue(0, 1023, 4096),
  })
  assert.equal(h['Content-Type'], 'video/mp4')
  assert.equal(h['Content-Length'], '1024')
  assert.equal(h['Accept-Ranges'], 'bytes')
  assert.equal(h['Content-Range'], 'bytes 0-1023/4096')
  assert.equal(h['Cache-Control'], 'no-store', 'plaintext ของห้องนิรภัยต้องไม่ถูก cache ที่ใดเลย')
})

test('ไม่มีชนิดไฟล์ = octet-stream ไม่ใช่ค่าว่างที่ผู้เล่นตีความเอง', () => {
  const h = buildPreviewHeaders({ contentType: '', contentLength: 10 })
  assert.equal(h['Content-Type'], 'application/octet-stream')
  assert.equal(h['Content-Range'], undefined, 'คำตอบที่ไม่ใช่ 206 ต้องไม่มี Content-Range')
})
