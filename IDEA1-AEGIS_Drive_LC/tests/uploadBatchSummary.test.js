// tests/uploadBatchSummary.test.js — FILES-UPLOAD-RECOVERY-1
//
// ช่องว่างที่ Production พบ: คิวหลายไฟล์บอก ETA รายไฟล์ได้ แต่ไม่มีภาพรวมของทั้งชุด
// ผู้ใช้ที่ลากไฟล์ 2 GB มาสี่ไฟล์จึงตอบคำถามเดียวที่เขาอยากรู้ไม่ได้ — "อีกนานแค่ไหน"
//
// ⚠️ กติกาที่ห้ามละเมิดแม้จะทำให้หัวถาดดูว่างเปล่า:
//    - อัตรารวม = ผลรวมของอัตราที่ "วัดได้จริง" ของรายการที่กำลังส่งอยู่เท่านั้น
//    - รายการที่หยุดนิ่งไม่สมทบความเร็วเก่าของตัวเองเข้ามา
//    - ยังไม่มีไบต์วิ่ง (Checking/Hashing/Finalizing) = ไม่มีความเร็ว ไม่มี ETA
//    - ไม่รู้ขนาดรวม = ไม่มี ETA (แสดงความเร็วได้ แต่ห้ามเดาเวลา)
//    - ETA นี้คือ "เวลาโอนที่เหลือ" ไม่ใช่ "เวลาจนงานเสร็จ" เพราะ commit ไม่ได้ถูกวัด
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')

let vite
let tray

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  tray = await vite.ssrLoadModule('/src/components/UploadStatusTray.jsx')
})

after(async () => {
  await vite?.close()
})

const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024

/** รายการที่กำลังส่งจริง พร้อมอัตราที่วัดได้ */
const uploading = (over = {}) => ({
  id: 'u1', name: 'a.mp4', stage: 'uploading', size: 2 * GB, transferredBytes: 1 * GB,
  progress: 50, chunkCount: 128, rate: { bytesPerSecond: 5 * MB, etaSeconds: 204, stalled: false }, ...over,
})

const markup = (queue, props = {}) => renderToStaticMarkup(React.createElement(tray.UploadStatusTray, {
  t, queue, collapsed: false,
  onToggleCollapse() {}, onHide() {}, onCancel() {}, onRetry() {}, onDismiss() {}, onRecover() {},
  ...props,
}))

/* ══ อัตรารวมและ ETA รวม ══════════════════════════════════════════════════ */

test('BATCH 1 · the aggregate rate is the sum of the measured active rates', () => {
  const summary = tray.uploadTrayAggregate([
    uploading({ id: 'a', rate: { bytesPerSecond: 5 * MB, etaSeconds: 10, stalled: false } }),
    uploading({ id: 'b', rate: { bytesPerSecond: 3 * MB, etaSeconds: 10, stalled: false } }),
  ])
  assert.equal(summary.bytesPerSecond, 8 * MB)
})

test('BATCH 2 · aggregate remaining bytes sum only what is still to be transferred', () => {
  const summary = tray.uploadTrayAggregate([
    uploading({ id: 'a', size: 2 * GB, transferredBytes: 1.5 * GB }),
    uploading({ id: 'b', size: 1 * GB, transferredBytes: 0.25 * GB }),
  ])
  assert.equal(summary.remainingBytes, 0.5 * GB + 0.75 * GB)
})

// ⚠️ S2 · DEFECT 2 — งานที่ยังแฮชอยู่ก็ต้องวิ่งผ่านสายในอีกสักครู่ทั้งก้อน การนับเฉพาะ
//    ไฟล์ที่กำลังส่งอยู่ทำให้ "ไบต์ที่เหลือของทั้งชุด" ต่ำกว่าความจริงหลายเท่า ผู้ใช้ที่
//    ลากมาสี่ไฟล์เห็นตัวเลขของสองไฟล์แล้วเข้าใจว่าใกล้เสร็จ
test('BATCH 2b · every file that still needs the network counts toward the batch remainder', () => {
  const summary = tray.uploadTrayAggregate([
    uploading({ id: 'a', stage: 'uploading', size: 2 * GB, transferredBytes: 1.5 * GB }),
    uploading({ id: 'b', stage: 'hashing', size: 2 * GB, transferredBytes: 0, rate: null }),
    uploading({ id: 'c', stage: 'waiting', size: 1 * GB, transferredBytes: 0, rate: null }),
    uploading({ id: 'd', stage: 'preparing', size: 1 * GB, transferredBytes: 0, rate: null }),
  ])
  // 0.5 (กำลังส่ง) + 2 + 1 + 1 (ยังไม่เริ่มส่งเลยสักไบต์) = 4.5 GB
  assert.equal(summary.remainingBytes, 4.5 * GB)
  assert.equal(summary.transferableCount, 4)
  assert.equal(summary.bytesPerSecond, 5 * MB, 'อัตรายังมาจากแถวที่ส่งอยู่จริงเท่านั้น')
})

test('BATCH 2c · finalizing and interrupted work is not part of the transfer remainder', () => {
  const summary = tray.uploadTrayAggregate([
    uploading({ id: 'a', size: 2 * GB, transferredBytes: 1 * GB }),
    // commit เป็นงานของเซิร์ฟเวอร์ ไม่มีไบต์วิ่งบนสาย และอัตรานี้พยากรณ์มันไม่ได้
    uploading({ id: 'b', stage: 'committing', size: 4 * GB, transferredBytes: 4 * GB, rate: null }),
    // ค้างจาก reload = ยังไม่มีไฟล์ต้นทางในแท็บนี้ จะยังไม่มีไบต์ใดวิ่งจนกว่าผู้ใช้จะเลือกไฟล์
    uploading({ id: 'c', stage: 'interrupted', size: 8 * GB, transferredBytes: 1 * GB, rate: null }),
  ])
  assert.equal(summary.remainingBytes, 1 * GB)
  assert.equal(summary.transferableCount, 1)
})

test('BATCH 3 · aggregate ETA is remaining bytes over the aggregate measured rate', () => {
  const summary = tray.uploadTrayAggregate([
    uploading({ id: 'a', size: 100 * MB, transferredBytes: 0, rate: { bytesPerSecond: 5 * MB, etaSeconds: 20, stalled: false } }),
    uploading({ id: 'b', size: 100 * MB, transferredBytes: 50 * MB, rate: { bytesPerSecond: 5 * MB, etaSeconds: 10, stalled: false } }),
  ])
  assert.equal(summary.remainingBytes, 150 * MB)
  assert.equal(summary.bytesPerSecond, 10 * MB)
  assert.equal(summary.etaSeconds, 15)
})

test('BATCH 4 · a checking-only batch reports no speed and no ETA', () => {
  const queue = ['hashing', 'hashing', 'preparing', 'waiting'].map((stage, i) => uploading({
    id: `c${i}`, stage, transferredBytes: 0, progress: null, chunkCount: 0, rate: null,
  }))
  const summary = tray.uploadTrayAggregate(queue)
  assert.equal(summary.bytesPerSecond, null)
  assert.equal(summary.etaSeconds, null)
  // ไบต์ที่ "รู้แล้วว่าต้องส่ง" บอกได้ — มันวัดได้จริงจากขนาดไฟล์ ไม่ใช่การพยากรณ์
  assert.equal(summary.remainingBytes, 8 * GB)

  const html = markup(queue)
  assert.doesNotMatch(html, /MB\/s/, 'ยังไม่มีไบต์วิ่งเลย ห้ามมีความเร็ว')
  assert.doesNotMatch(html, /at current rate/i, 'ยังไม่มีอัตราให้อ้างอิง ห้ามมี ETA')
  assert.match(html, /Checking 4 files/i, 'ต้องบอกความจริงว่ากำลังตรวจไฟล์อยู่')
  assert.doesNotMatch(html, /Uploading 4/i, 'ห้ามเรียกการแฮชว่าการอัปโหลด')
  assert.match(html, /8\.0 GB left to transfer/i)
})

test('BATCH 5 · a mixed checking and uploading batch stays truthful about both', () => {
  const queue = [
    uploading({ id: 'a' }),
    uploading({ id: 'b', stage: 'hashing', transferredBytes: 0, progress: 10, chunkCount: 0, rate: null }),
    uploading({ id: 'c', stage: 'hashing', transferredBytes: 0, progress: 4, chunkCount: 0, rate: null }),
  ]
  const summary = tray.uploadTrayAggregate(queue)
  assert.equal(summary.uploadingCount, 1)
  assert.equal(summary.checkingCount, 2)
  assert.equal(summary.bytesPerSecond, 5 * MB, 'เฉพาะรายการที่ส่งอยู่จริงเท่านั้นที่สมทบอัตรา')
  // ⚠️ S2 · DEFECT 2: ทั้งสามไฟล์ต้องวิ่งผ่านสาย ไบต์ที่เหลือของทั้งชุดจึงเป็น
  //    1 GB (ที่เหลือของไฟล์ที่กำลังส่ง) + 2 + 2 = 5 GB ไม่ใช่ 1 GB
  assert.equal(summary.remainingBytes, 5 * GB)
  assert.equal(summary.etaSeconds, (5 * GB) / (5 * MB))

  const html = markup(queue)
  assert.match(html, /Uploading 1 item · checking 2/i)
  assert.match(html, /5\.0 GB left to transfer/i)
  // ถ้อยคำต้องไม่สัญญาเวลาจนงานเสร็จ — การแฮชและ commit ไม่ได้ถูกวัดด้วยอัตรานี้
  assert.match(html, /at current rate/i)
})

test('BATCH 6 · a stalled upload contributes neither a stale rate nor a false ETA', () => {
  const summary = tray.uploadTrayAggregate([
    uploading({ id: 'a', rate: { bytesPerSecond: 5 * MB, etaSeconds: 10, stalled: false } }),
    uploading({ id: 'b', rate: { bytesPerSecond: null, etaSeconds: null, stalled: true } }),
  ])
  assert.equal(summary.bytesPerSecond, 5 * MB, 'รายการที่หยุดนิ่งสมทบศูนย์ ไม่ใช่ความเร็วก้อนสุดท้าย')
  assert.equal(summary.stalledCount, 1)

  const allStalled = tray.uploadTrayAggregate([
    uploading({ id: 'a', rate: { bytesPerSecond: null, etaSeconds: null, stalled: true } }),
  ])
  assert.equal(allStalled.bytesPerSecond, null)
  assert.equal(allStalled.etaSeconds, null)
  assert.doesNotMatch(markup([uploading({ rate: { bytesPerSecond: null, etaSeconds: null, stalled: true } })]), /MB\/s/)
})

test('BATCH 7 · an unknown total size withholds the ETA but may still show the measured rate', () => {
  // ⚠️ ขนาดรวมไม่รู้ = ETA รายไฟล์ก็ไม่มีอยู่แล้ว (transferRate.js คืน etaSeconds=null)
  //    จึงต้องทดสอบด้วยรายการที่สมจริง ไม่ใช่รายการที่มี ETA ติดมาแบบที่เป็นไปไม่ได้
  const unknown = [
    uploading({ id: 'a', size: null, transferredBytes: 10 * MB, rate: { bytesPerSecond: 5 * MB, etaSeconds: null, stalled: false } }),
    uploading({ id: 'b', size: null, transferredBytes: 10 * MB, rate: { bytesPerSecond: 5 * MB, etaSeconds: null, stalled: false } }),
  ]
  const summary = tray.uploadTrayAggregate(unknown)
  assert.equal(summary.bytesPerSecond, 10 * MB)
  assert.equal(summary.remainingBytes, null)
  assert.equal(summary.etaSeconds, null, 'ไม่รู้ขนาดรวม = พยากรณ์เวลาไม่ได้ ห้ามเดา')

  const html = markup(unknown)
  const batch = html.match(/data-upload-tray-batch=""[^>]*>([^<]*)</)?.[1] ?? ''
  assert.notEqual(batch, '', 'บรรทัดสรุปรวมต้องถูก render จริง')
  assert.match(batch, /10\.0 MB\/s/, 'อัตราที่วัดได้จริงยังบอกได้')
  assert.doesNotMatch(batch, /left to transfer/, 'ไม่รู้ขนาด = บอกไบต์ที่เหลือไม่ได้')
  assert.doesNotMatch(batch, /at current rate/, 'และพยากรณ์เวลาไม่ได้')
})

test('BATCH 7b · one unknown size in the batch withholds the whole batch remainder and ETA', () => {
  const summary = tray.uploadTrayAggregate([
    uploading({ id: 'a', size: 2 * GB, transferredBytes: 1 * GB }),
    uploading({ id: 'b', stage: 'hashing', size: null, transferredBytes: 0, rate: null }),
  ])
  assert.equal(summary.bytesPerSecond, 5 * MB)
  assert.equal(summary.remainingBytes, null, 'รวมไม่ครบ = ตัวเลขรวมไม่มีความหมาย')
  assert.equal(summary.etaSeconds, null)
})

test('BATCH 8 · completed, failed and cancelled rows never pollute the active aggregate', () => {
  const summary = tray.uploadTrayAggregate([
    uploading({ id: 'a' }),
    uploading({ id: 'b', stage: 'complete', transferredBytes: 2 * GB, progress: 100, rate: { bytesPerSecond: 9 * MB, etaSeconds: 1, stalled: false } }),
    uploading({ id: 'c', stage: 'failed', rate: { bytesPerSecond: 9 * MB, etaSeconds: 1, stalled: false } }),
    uploading({ id: 'd', stage: 'cancelled', rate: { bytesPerSecond: 9 * MB, etaSeconds: 1, stalled: false } }),
    uploading({ id: 'e', stage: 'interrupted', transferredBytes: 1 * GB, rate: null }),
  ])
  assert.equal(summary.uploadingCount, 1)
  assert.equal(summary.bytesPerSecond, 5 * MB)
  assert.equal(summary.remainingBytes, 1 * GB)
})

test('BATCH 9 · the aggregate line renders measured totals in the tray header', () => {
  const html = markup([
    uploading({ id: 'a', size: 4 * GB, transferredBytes: 1 * GB, rate: { bytesPerSecond: 3 * MB, etaSeconds: 1, stalled: false } }),
    uploading({ id: 'b', size: 4 * GB, transferredBytes: 1 * GB, rate: { bytesPerSecond: 2 * MB, etaSeconds: 1, stalled: false } }),
  ])
  assert.match(html, /Uploading 2 items/i)
  assert.match(html, /6\.0 GB left to transfer/)
  assert.match(html, /5\.0 MB\/s/)
  // 6 GiB ÷ 5 MiB/s = 1228.8 วินาที และ etaParts ปัดขึ้นเป็นนาทีเสมอ → 21 ไม่ใช่ 20
  assert.match(html, /about 21 min at current rate/i)
  // ต้องไม่ถูกเรียกว่าเวลาจนงานเสร็จ — การแฮชและ commit ไม่ได้อยู่ในอัตราที่วัด
  assert.doesNotMatch(html, /until (done|complete|finished)/i)
})

test('BATCH 10 · a single uploading item needs no aggregate line duplicating its own row', () => {
  const html = markup([uploading({ id: 'a' })])
  assert.equal((html.match(/MB\/s/g) ?? []).length, 1, 'ไฟล์เดียวไม่ต้องมีสรุปรวมที่พูดซ้ำกับแถวของตัวเอง')
})

/* ══ ไม่ทำลายสัญญาเดิม ════════════════════════════════════════════════════ */

test('BATCH 11 · the header still refuses to claim completion while work needs attention', () => {
  assert.deepEqual(
    tray.uploadTraySummary([{ stage: 'complete' }, { stage: 'failed' }]),
    { key: 'uploadTrayAttentionOne', vars: { n: 1 } },
  )
  assert.deepEqual(
    tray.uploadTraySummary([{ stage: 'complete' }, { stage: 'interrupted' }]),
    { key: 'uploadTrayAttentionOne', vars: { n: 1 } },
  )
})

test('BATCH 12 · an interrupted row counts as attention, not as active transfer', () => {
  assert.equal(tray.activeUploadCount([{ stage: 'interrupted' }]), 0)
  assert.equal(tray.attentionUploadCount([{ stage: 'interrupted' }]), 1)
  assert.equal(tray.shouldShowQueueLauncher([{ stage: 'interrupted' }]), true)
})
