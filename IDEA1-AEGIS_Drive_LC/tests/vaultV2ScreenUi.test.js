// tests/vaultV2ScreenUi.test.js — AEGIS Drive (IDEA1) · จอ Private Vault กับรูปแบบ V2
//
// สิ่งที่ชุดนี้ตรึงไว้ ไม่ใช่ "พิกเซล" แต่เป็นคำสัญญาสี่ข้อที่ผู้ใช้มองไม่เห็นแต่พึ่งพาอยู่:
//
//   1. ตัวเลขบนแถบความคืบหน้า **มาจากงานจริงเสมอ** — ไบต์ที่ผ่านไปแล้วและดัชนี chunk
//      ที่โมดูลรายงานมา ไม่มี timer ใดขยับแถบเอง แถบที่เดินต่อขณะเน็ตหยุดคือการโกหก
//      ผู้ใช้ว่างานยังคืบหน้า แล้วเขาจะรอต่อแทนที่จะกดทำต่อหรือแก้ปัญหาเครือข่าย
//   2. ความล้มเหลวชั่วคราวหนึ่งก้อน = "หยุดค้างแล้วทำต่อได้" ไม่ใช่ "เริ่มไฟล์ใหม่"
//   3. การล็อกกลางคัน **ยกเลิกงานที่กำลังทำอยู่จริง** — ไม่ปล่อยให้เบื้องหลังเข้ารหัสต่อ
//      หลังจากที่จอบอกผู้ใช้ว่าล็อกแล้ว
//   4. ขณะล็อก การ์ด V2 ไม่มีชื่อไฟล์ ชนิดไฟล์ หรือขนาดจริงหลุดออกมาทาง DOM เลย
//
// โมดูล V2 ตัวจริงถูกพิสูจน์แยกใน vaultChunkCrypto / vaultChunkedUploadClient /
// vaultChunkedDownloadClient — ที่นี่คือ state machine ของจอ ไม่ใช่ตัวเข้ารหัส
//
// ⚠️ ทุกจังหวะของการโอนถูกคุมด้วย "ประตู" ที่เทสต์เปิดเอง ไม่ใช่ด้วยการหน่วงเวลา —
//    เทสต์ที่รอเวลาคือเทสต์ที่จะสั่นแบบสุ่มบนเครื่องที่ช้ากว่า และจะบังบั๊กจริงไว้ข้างหลัง
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { makeVaultBackend, serverBlob, serverBlobV2, CORRECT_PASSPHRASE } from './fixtures/vaultScreenBackend.js'
import {
  startVaultScreenEnv, settle, click, byText,
  tileIds, unlock, lockVault, uploadFile,
} from './helpers/vaultScreenHarness.js'

const t = makeT('en')
const MIB = 1024 * 1024
const BUFFER_LIMIT = 64 * MIB

let env
let dom
let Vault

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom, Vault } = env)
})

after(async () => {
  await env?.stop()
  delete globalThis.__VAULT_BACKEND__
  delete globalThis.showSaveFilePicker
})

let backend
beforeEach(() => {
  backend = makeVaultBackend()
  globalThis.__VAULT_BACKEND__ = backend
  delete globalThis.showSaveFilePicker
})

const doc = () => dom.window.document
const html = () => doc().body.textContent
const panel = () => doc().querySelector('[data-vault-transfer]')
const stageOf = () => panel()?.getAttribute('data-vault-transfer-stage') ?? null
const bytesEl = () => doc().querySelector('[data-vault-transfer-bytes]')
const bar = () => doc().querySelector('[role="progressbar"]')
const menuButton = (id) => doc().querySelector(`[data-vault-tile-menu="${id}"]`)
const menuItem = (label) => [...doc().querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === label)
const dialog = () => doc().querySelector('[role="dialog"]')

async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) await settle()
}

/** ประตูที่เทสต์เปิดเอง — แทนการหน่วงเวลาทุกจุดในไฟล์นี้ */
function gate() {
  let open
  const promise = new Promise((resolve) => { open = resolve })
  return { promise, open }
}

/** เปิดประตูหนึ่งบานแล้วให้ React ประมวลผลผลลัพธ์ที่ตามมาให้จบ */
async function release(g, value) {
  await act(async () => {
    g.open(value)
    await g.promise
  })
  await tick()
}

const seedBlobs = (blobs) => { backend.state['/api/vault'].data = { configured: true, blobs } }

async function unlocked(h) {
  await h.render(React.createElement(Vault, { t }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
}

// ─────────────────────────────────────────────────────────────────────────────
// 56 · ตัวเลขบนแถบมาจากงานจริง ไม่มี timer ปลอม
// ─────────────────────────────────────────────────────────────────────────────
test('แถบความคืบหน้าแสดงไบต์และ "ส่วนที่ X จาก N" ตามที่โมดูลรายงานจริง', async () => {
  const FILE_SIZE = 40 * MIB
  const g1 = gate()
  const g2 = gate()
  const g3 = gate()
  backend.uploadImpl = async ({ onStage, onProgress }) => {
    await g1.promise
    onStage('encrypting')
    onProgress({
      phase: 'encrypting', chunkIndex: 1, chunkCount: 3,
      transferredBytes: 16 * MIB, totalBytes: FILE_SIZE, percent: 40,
    })
    await g2.promise
    onStage('uploading')
    onProgress({
      phase: 'uploading', chunkIndex: 2, chunkCount: 3,
      transferredBytes: FILE_SIZE, totalBytes: FILE_SIZE, percent: 100,
    })
    onStage('committing')
    await g3.promise
    return { ok: true, stage: 'complete', blob: serverBlobV2({ id: 'v2-a', name: 'big-clip.mp4', type: 'video/mp4' }) }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    await uploadFile(dom, { name: 'big-clip.mp4', type: 'video/mp4' })

    // ทันทีที่เริ่ม จอต้องบอกว่ากำลังเตรียมการเข้ารหัส — ไม่ใช่ 0% เงียบ ๆ
    assert.equal(stageOf(), 'preparing')
    assert.match(html(), new RegExp(t('vaultXferPreparing')))

    await release(g1)
    assert.equal(stageOf(), 'encrypting')
    assert.match(html(), /Encrypting part 2 of 3/, 'ดัชนีที่ผู้ใช้เห็นเป็นฐาน 1 ของ chunk จริง')
    assert.equal(bytesEl().getAttribute('data-vault-transfer-bytes'), String(16 * MIB))
    assert.equal(bytesEl().getAttribute('data-vault-transfer-total'), String(FILE_SIZE))
    assert.equal(bar().getAttribute('aria-valuenow'), '40')

    // ★ ไม่มี timer ใดขยับแถบ: ปล่อยให้ event loop หมุนหลายรอบแล้วตัวเลขต้องนิ่งสนิท
    await tick(12)
    assert.equal(bytesEl().getAttribute('data-vault-transfer-bytes'), String(16 * MIB),
      'ไบต์ต้องไม่ขยับเองเมื่อไม่มีความคืบหน้าจริง')
    assert.equal(bar().getAttribute('aria-valuenow'), '40')
    assert.equal(stageOf(), 'encrypting')

    await release(g2)
    assert.equal(stageOf(), 'committing')
    assert.match(html(), new RegExp(t('vaultXferCommitting')))
    assert.equal(bytesEl().getAttribute('data-vault-transfer-bytes'), String(FILE_SIZE))

    await release(g3)
    assert.equal(panel(), null, 'แถบต้องหายไปเมื่อสำเร็จ ไม่ค้างอยู่ที่ 100%')
    assert.deepEqual(tileIds(dom), ['v2-a'])
    assert.match(html(), /big-clip\.mp4/)
  } finally {
    await h.unmount()
  }
})

test('แถบดาวน์โหลดนับตามก้อนที่ถอดสำเร็จจริง ไม่ใช่ตามเวลา', async () => {
  seedBlobs([serverBlobV2({
    id: 'v2-dl', name: 'report.pdf', type: 'application/pdf', plainSize: 3 * MIB, size: 3 * MIB + 48, chunkCount: 3,
  })])
  const g1 = gate()
  const g2 = gate()
  backend.downloadImpl = async ({ onProgress, sink }) => {
    onProgress({ chunkIndex: 0, chunkCount: 3, bytesWritten: MIB, totalBytes: 3 * MIB, percent: 33.3 })
    await g1.promise
    onProgress({ chunkIndex: 2, chunkCount: 3, bytesWritten: 3 * MIB, totalBytes: 3 * MIB, percent: 100 })
    await g2.promise
    return { ok: true, chunksRead: 3, bytesWritten: 3 * MIB, result: await sink.close() }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    await click(dom, menuButton('v2-dl'))
    await click(dom, menuItem(t('download')))

    assert.equal(stageOf(), 'downloading')
    assert.match(html(), /Decrypting part 1 of 3/)
    assert.equal(bytesEl().getAttribute('data-vault-transfer-bytes'), String(MIB))

    await tick(10)
    assert.equal(bytesEl().getAttribute('data-vault-transfer-bytes'), String(MIB),
      'ตัวนับของการดาวน์โหลดก็ต้องไม่เดินเอง')

    await release(g1)
    assert.match(html(), /Decrypting part 3 of 3/)
    assert.equal(bytesEl().getAttribute('data-vault-transfer-bytes'), String(3 * MIB))

    await release(g2)
    assert.equal(panel(), null)
  } finally {
    await h.unmount()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 57 · ล้มชั่วคราว = หยุดค้างแล้วทำต่อได้
// ─────────────────────────────────────────────────────────────────────────────
test('ก้อนที่ล้มชั่วคราวทำให้จอเสนอ "ทำต่อ" และการทำต่อส่งเฉพาะสถานะที่ค้างไว้', async () => {
  const resumeState = { upload: { uploadId: 'u-1' }, received: [0, 1] }
  const calls = []
  backend.uploadImpl = async ({ file, resume, onStage, onProgress }) => {
    calls.push({ name: file.name, resume })
    onStage('uploading')
    onProgress({ chunkIndex: 1, chunkCount: 3, transferredBytes: 2 * MIB, totalBytes: 3 * MIB, percent: 66.6 })
    if (calls.length === 1) return { ok: false, stage: 'paused', reason: 'network', resume: resumeState }
    return { ok: true, stage: 'complete', blob: serverBlobV2({ id: 'v2-r', name: 'ledger.zip', type: 'application/zip' }) }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    await uploadFile(dom, { name: 'ledger.zip', type: 'application/zip' })
    await tick()

    assert.equal(stageOf(), 'paused')
    assert.match(html(), new RegExp(t('vaultXferPaused')))
    assert.match(html(), new RegExp(t('vaultXferReasonNetwork')), 'ต้องบอกสาเหตุตามจริง')
    // ★ ตัวเลขที่ค้างไว้ต้องยังอยู่ — ผู้ใช้ต้องเห็นว่าส่งไปแล้วเท่าไร ไม่ใช่กลับเป็นศูนย์
    assert.equal(bytesEl().getAttribute('data-vault-transfer-bytes'), String(2 * MIB))
    assert.equal(tileIds(dom).length, 0, 'ไฟล์ที่ยังไม่สำเร็จต้องไม่โผล่เป็นการ์ด')

    const resumeBtn = byText(dom, 'button', t('vaultXferResume'))
    assert.ok(resumeBtn, 'สถานะหยุดค้างต้องมีปุ่มทำต่อ')
    assert.equal(byText(dom, 'button', t('vaultXferCancel')), undefined, 'ไม่มีอะไรให้ยกเลิกแล้ว')

    await click(dom, resumeBtn)
    await tick()

    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].resume, resumeState, 'การทำต่อต้องส่งสถานะที่เซิร์ฟเวอร์ถืออยู่กลับไป')
    assert.equal(calls[1].name, 'ledger.zip', 'ต้องเป็นไฟล์เดิม ไม่ใช่ให้ผู้ใช้เลือกใหม่')
    assert.equal(panel(), null)
    assert.deepEqual(tileIds(dom), ['v2-r'])
  } finally {
    await h.unmount()
  }
})

test('ความล้มเหลวถาวรบอกสาเหตุ ไม่มีปุ่มทำต่อ และปิดแถบทิ้งได้', async () => {
  backend.uploadImpl = async ({ onStage }) => {
    onStage('uploading')
    return { ok: false, stage: 'failed', reason: 'noSpace', resume: null }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    await uploadFile(dom, { name: 'huge.iso', type: 'application/octet-stream' })
    await tick()

    assert.equal(stageOf(), 'failed')
    assert.match(html(), new RegExp(t('vaultXferFailed')))
    assert.match(html(), new RegExp(t('vaultXferReasonNoSpace')))
    assert.equal(byText(dom, 'button', t('vaultXferResume')), undefined,
      'สิ่งที่ทำต่อไม่ได้ต้องไม่มีปุ่มทำต่อ — ปุ่มที่กดแล้วล้มเสมอแย่กว่าไม่มีปุ่ม')
    assert.equal(tileIds(dom).length, 0)

    await click(dom, byText(dom, 'button', t('vaultXferDismiss')))
    assert.equal(panel(), null)
  } finally {
    await h.unmount()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 58–59 · การล็อกระหว่างการโอน
// ─────────────────────────────────────────────────────────────────────────────
test('กดล็อกระหว่างอัปโหลด: งานถูกยกเลิกจริงผ่าน signal และความคืบหน้าหลังจากนั้นไม่ถูกแสดง', async () => {
  let captured = null
  let lateProgress = null
  backend.uploadImpl = ({ onStage, onProgress, signal }) => new Promise((resolve) => {
    captured = signal
    onStage('encrypting')
    onProgress({ chunkIndex: 0, chunkCount: 4, transferredBytes: MIB, totalBytes: 4 * MIB, percent: 25 })
    lateProgress = onProgress
    signal.addEventListener('abort', () => {
      // โมดูลจริงหยุดวนลูปตรงนี้ — ตัวขับจำลองจึงต้องหยุดเหมือนกัน
      resolve({ ok: false, stage: 'cancelled', reason: 'cancelled', resume: null })
    })
  })

  const h = env.mount()
  try {
    await unlocked(h)
    await uploadFile(dom, { name: 'secret-plan.pdf', type: 'application/pdf' })
    assert.equal(stageOf(), 'encrypting')
    assert.equal(captured.aborted, false)

    await lockVault(dom, t)
    await tick()

    assert.equal(captured.aborted, true, 'การล็อกต้อง abort งานที่กำลังทำอยู่')
    assert.equal(panel(), null, 'แถบสถานะต้องหายไปพร้อมการล็อก ไม่ค้างอยู่ขณะล็อก')
    assert.ok(byText(dom, 'button', t('unlockVault')), 'จอต้องกลับไปสถานะล็อกจริง')
    assert.doesNotMatch(html(), /secret-plan\.pdf/, 'ชื่อไฟล์ที่กำลังอัปโหลดต้องไม่ค้างบนจอขณะล็อก')

    // ★ ความคืบหน้าที่มาถึงหลังการล็อกต้องไม่ปลุกแถบขึ้นมาใหม่
    await act(async () => {
      lateProgress({ chunkIndex: 1, chunkCount: 4, transferredBytes: 2 * MIB, totalBytes: 4 * MIB, percent: 50 })
    })
    await tick()
    assert.equal(panel(), null, 'งานที่ถูกยกเลิกแล้วต้องไม่มีทางวาดแถบกลับมาได้')
  } finally {
    await h.unmount()
  }
})

test('ปุ่มยกเลิกระหว่างโอนหยุดงานโดยไม่ล็อกตู้ และไม่ทิ้ง error ปลอมไว้บนจอ', async () => {
  let captured = null
  backend.uploadImpl = ({ onStage, signal }) => new Promise((resolve) => {
    captured = signal
    onStage('uploading')
    signal.addEventListener('abort', () => resolve({ ok: false, stage: 'cancelled', reason: 'cancelled', resume: null }))
  })

  const h = env.mount()
  try {
    await unlocked(h)
    await uploadFile(dom, { name: 'draft.gif' })

    const cancel = byText(dom, 'button', t('vaultXferCancel'))
    assert.ok(cancel, 'ระหว่างโอนต้องมีปุ่มยกเลิก')
    await click(dom, cancel)
    await tick()

    assert.equal(captured.aborted, true)
    assert.equal(panel(), null)
    assert.ok(byText(dom, 'button', t('lockVault')), 'ตู้ต้องยังเปิดอยู่ — ยกเลิกการโอน ≠ ล็อกตู้')
    assert.doesNotMatch(html(), new RegExp(t('vaultXferFailed')), 'การยกเลิกของผู้ใช้ไม่ใช่ความล้มเหลว')
  } finally {
    await h.unmount()
  }
})

test('ขณะล็อก การ์ด V2 เป็นแค่ ciphertext ทึบ — ไม่มีชื่อไฟล์/ชนิด/ขนาดจริงรั่วทาง DOM', async () => {
  const NAME = 'acquisition-terms-CONFIDENTIAL.pdf'
  seedBlobs([serverBlobV2({
    id: 'v2-locked', name: NAME, type: 'application/pdf',
    plainSize: 9_000_000, size: 9_000_032, chunkCount: 2,
  })])

  const h = env.mount()
  try {
    await unlocked(h)
    assert.ok(html().includes(NAME), 'ปลดล็อกแล้วต้องเห็นชื่อจริง')

    await lockVault(dom, t)
    assert.deepEqual(tileIds(dom), ['v2-locked'], 'การ์ดยังอยู่ — แค่ไม่มีความหมายให้อ่าน')

    // ★ ตรวจทั้งเอกสาร ไม่ใช่แค่ข้อความที่มองเห็น: title / aria-label / alt / data-*
    const markup = doc().body.outerHTML
    for (const leak of [NAME, 'acquisition-terms', 'CONFIDENTIAL', '.pdf', 'application/pdf']) {
      assert.equal(markup.includes(leak), false, `ขณะล็อกต้องไม่มี "${leak}" อยู่ใน DOM เลย`)
    }
    assert.match(html(), /v2-locked\.aegisenc/, 'สิ่งที่แสดงคือ id ทึบ ซึ่งเซิร์ฟเวอร์รู้อยู่แล้ว')

    // และไม่มีคำสั่งใดที่ต้องใช้กุญแจให้กดได้
    await click(dom, menuButton('v2-locked'))
    for (const label of [t('download'), t('preview'), t('delete')]) {
      assert.equal(menuItem(label), undefined, `ขณะล็อกต้องไม่มีคำสั่ง "${label}"`)
    }
  } finally {
    await h.unmount()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 60 · Preview ของไฟล์ V2 ขนาดใหญ่
// ─────────────────────────────────────────────────────────────────────────────
test('ไฟล์ V2 ที่ใหญ่เกินเพดานบอกความจริงแทนที่จะประกอบ plaintext ทั้งก้อนใน RAM', async () => {
  seedBlobs([serverBlobV2({
    id: 'v2-big', name: 'wedding-4k.mp4', type: 'video/mp4',
    plainSize: BUFFER_LIMIT + 1, size: BUFFER_LIMIT + 81, chunkCount: 5,
  })])
  let downloadCalls = 0
  backend.downloadImpl = async () => { downloadCalls += 1; return { ok: true, result: [] } }

  const h = env.mount()
  try {
    await unlocked(h)
    const track = env.trackObjectUrls()
    await click(dom, menuButton('v2-big'))
    await click(dom, menuItem(t('preview')))
    await tick()

    const notice = doc().querySelector('[data-vault-preview-too-large="1"]')
    assert.ok(notice, 'ต้องมีข้อความอธิบายแทนตัวเล่นที่ว่างเปล่า')
    assert.equal(notice.textContent.trim(), t('vaultPreviewTooLarge'))
    assert.equal(downloadCalls, 0, 'ต้องไม่เริ่มดาวน์โหลดเพื่อประกอบวิดีโอทั้งก้อนใน RAM')
    assert.deepEqual(track.created(), [], 'ต้องไม่มี object URL ของ plaintext ถูกสร้างเลย')
    assert.equal(doc().querySelector('video'), null)

    await click(dom, byText(dom, 'button', t('close')))
    assert.equal(dialog(), null)
    assert.deepEqual(track.live(), [])
  } finally {
    await h.unmount()
  }
})

test('ไฟล์ V2 ที่เล็กพอยังดูตัวอย่างได้ตามปกติผ่านเส้นทางที่มีเพดาน', async () => {
  seedBlobs([serverBlobV2({ id: 'v2-small', name: 'logo.gif', type: 'image/gif', plainSize: 2048, size: 2064 })])
  backend.downloadImpl = async ({ sink }) => {
    await sink.write(new Uint8Array([1, 2, 3, 4]))
    return { ok: true, chunksRead: 1, bytesWritten: 4, result: await sink.close() }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    const track = env.trackObjectUrls()
    await click(dom, menuButton('v2-small'))
    await click(dom, menuItem(t('preview')))
    await tick()

    assert.equal(doc().querySelector('[data-vault-preview-too-large="1"]'), null)
    assert.equal(track.created().length, 1, 'ต้องสร้าง object URL หนึ่งใบสำหรับ plaintext ที่ถอดแล้ว')
    assert.ok(doc().querySelector('img'), 'ภาพต้องถูก render จาก object URL ในเครื่อง')

    await click(dom, byText(dom, 'button', t('close')))
    assert.deepEqual(track.live(), [], 'ปิดแล้วต้องปล่อย plaintext คืนทันที')
  } finally {
    await h.unmount()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 61 · เบราว์เซอร์ที่เขียนไฟล์ใหญ่ลงดิสก์ไม่ได้
// ─────────────────────────────────────────────────────────────────────────────
test('ไม่มี File System Access API + ไฟล์ใหญ่ = บอกความจริง ไม่ใช่ปล่อยให้แท็บตาย', async () => {
  seedBlobs([serverBlobV2({
    id: 'v2-nofs', name: 'archive.tar', type: 'application/x-tar',
    plainSize: BUFFER_LIMIT + 1, size: BUFFER_LIMIT + 81, chunkCount: 5,
  })])
  backend.streamingSink = false
  let downloadCalls = 0
  backend.downloadImpl = async () => { downloadCalls += 1; return { ok: true, result: [] } }

  const h = env.mount()
  try {
    await unlocked(h)
    await click(dom, menuButton('v2-nofs'))
    await click(dom, menuItem(t('download')))
    await tick()

    assert.equal(stageOf(), 'unsupported')
    assert.ok(html().includes(t('vaultXferUnsupported')))
    assert.equal(downloadCalls, 0, 'ต้องไม่เริ่มดาวน์โหลดที่รู้อยู่แล้วว่าจะทำให้แท็บตาย')
    assert.equal(bar(), null, 'สถานะนี้ไม่ใช่ความคืบหน้า จึงต้องไม่มีแถบให้เข้าใจผิด')
    assert.equal(byText(dom, 'button', t('vaultXferResume')), undefined,
      'ข้อจำกัดของเบราว์เซอร์ไม่มีทาง "ลองใหม่แล้วสำเร็จ"')
    assert.ok(byText(dom, 'button', t('vaultXferDismiss')), 'แต่ปิดข้อความทิ้งได้')
  } finally {
    await h.unmount()
  }
})

test('มี File System Access API = เขียนลงไฟล์จริงแบบสตรีม ไม่มี object URL ของทั้งไฟล์', async () => {
  seedBlobs([serverBlobV2({
    id: 'v2-fs', name: 'archive.tar', type: 'application/x-tar',
    plainSize: 200 * MIB, size: 200 * MIB + 80, chunkCount: 5,
  })])
  backend.streamingSink = true
  const written = []
  let picked = null
  globalThis.showSaveFilePicker = async (opts) => {
    picked = opts
    return {
      createWritable: async () => ({
        async write(bytes) { written.push(bytes.length) },
        async close() {},
        async abort() {},
      }),
    }
  }
  backend.downloadImpl = async ({ sink }) => {
    for (let i = 0; i < 5; i += 1) await sink.write(new Uint8Array(8))
    await sink.close()
    return { ok: true, chunksRead: 5, bytesWritten: 40, result: null }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    const track = env.trackObjectUrls()
    await click(dom, menuButton('v2-fs'))
    await click(dom, menuItem(t('download')))
    await tick()

    assert.ok(picked, 'ตัวเลือกไฟล์ต้องถูกเปิดจากการกดของผู้ใช้โดยตรง')
    assert.equal(picked.suggestedName, 'archive.tar', 'ชื่อที่เสนอมาจาก metadata ที่ถอดในเบราว์เซอร์')
    assert.deepEqual(written, [8, 8, 8, 8, 8], 'ไบต์ถูกเขียนลงไฟล์ทีละก้อน')
    assert.deepEqual(track.created(), [], 'ต้องไม่มี object URL ของทั้งไฟล์ถูกสร้างเลยในเส้นทางนี้')
    assert.equal(panel(), null)
  } finally {
    await h.unmount()
  }
})

test('ผู้ใช้กดยกเลิกตัวเลือกไฟล์ = เงียบแล้วจบ ไม่ใช่ error บนจอ', async () => {
  seedBlobs([serverBlobV2({
    id: 'v2-cancel', name: 'x.tar', type: 'application/x-tar',
    plainSize: 100 * MIB, size: 100 * MIB + 80, chunkCount: 5,
  })])
  backend.streamingSink = true
  let downloadCalls = 0
  globalThis.showSaveFilePicker = async () => {
    throw Object.assign(new Error('user cancelled'), { name: 'AbortError' })
  }
  backend.downloadImpl = async () => { downloadCalls += 1; return { ok: true, result: [] } }

  const h = env.mount()
  try {
    await unlocked(h)
    await click(dom, menuButton('v2-cancel'))
    await click(dom, menuItem(t('download')))
    await tick()

    assert.equal(panel(), null)
    assert.equal(downloadCalls, 0)
    assert.doesNotMatch(html(), new RegExp(t('vaultXferFailed')))
  } finally {
    await h.unmount()
  }
})

test('การดาวน์โหลดที่ล้มกลางคันไม่ส่งมอบไฟล์ และรายงานสาเหตุตามจริง', async () => {
  seedBlobs([serverBlobV2({ id: 'v2-fail', name: 'x.gif', type: 'image/gif', plainSize: 2048, size: 2064 })])
  backend.downloadImpl = async ({ sink }) => {
    await sink.write(new Uint8Array(8))
    await sink.abort()
    return { ok: false, reason: 'auth-failed', chunksRead: 1, bytesWritten: 8 }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    const track = env.trackObjectUrls()
    await click(dom, menuButton('v2-fail'))
    await click(dom, menuItem(t('download')))
    await tick()

    assert.equal(stageOf(), 'failed')
    assert.match(html(), new RegExp(t('vaultXferReasonAuth')))
    assert.deepEqual(track.created(), [], 'ต้องไม่มีไฟล์ปลายทางที่อ้างว่าสมบูรณ์ถูกส่งมอบ')
  } finally {
    await h.unmount()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 62 · i18n ครบทั้งสามภาษา
// ─────────────────────────────────────────────────────────────────────────────
const XFER_KEYS = [
  'vaultXferPreparing', 'vaultXferEncrypting', 'vaultXferUploading', 'vaultXferCommitting',
  'vaultXferDownloading', 'vaultXferPaused', 'vaultXferFailed', 'vaultXferProgress',
  'vaultXferResume', 'vaultXferCancel', 'vaultXferDismiss',
  'vaultXferReasonNetwork', 'vaultXferReasonServer', 'vaultXferReasonTooLarge',
  'vaultXferReasonNoSpace', 'vaultXferReasonIntegrity', 'vaultXferReasonExpired',
  'vaultXferReasonAuth', 'vaultXferUnsupported', 'vaultPreviewTooLarge',
]

test('ทุกสถานะใหม่มีคำแปลจริงครบทั้ง en / th / zh — ไม่มีคีย์ดิบหรือ placeholder หลุดถึงผู้ใช้', () => {
  const seen = new Map()
  for (const locale of ['en', 'th', 'zh']) {
    const tr = makeT(locale)
    for (const key of XFER_KEYS) {
      const value = tr(key, { index: 1, count: 3, done: '1 MB', total: '3 MB', percent: 33 })
      assert.ok(typeof value === 'string' && value.trim().length > 0, `${locale}.${key} ต้องไม่ว่าง`)
      assert.doesNotMatch(value, /\{[a-zA-Z]+\}/, `${locale}.${key} ต้องไม่เหลือ placeholder`)
      assert.notEqual(value, key, `${locale}.${key} ต้องไม่คืนคีย์ดิบ`)
      const bucket = seen.get(key) ?? new Set()
      bucket.add(value)
      seen.set(key, bucket)
    }
  }
  // ต้องเป็นคำแปลจริง ไม่ใช่ copy ภาษาอังกฤษสามชุด
  for (const key of ['vaultXferResume', 'vaultXferPaused', 'vaultPreviewTooLarge', 'vaultXferUnsupported']) {
    assert.equal(seen.get(key).size, 3, `${key} ต้องมีคำแปลที่ต่างกันจริงทั้งสามภาษา`)
  }
  assert.match(makeT('th')('vaultXferPaused'), /[฀-๿]/)
  assert.match(makeT('zh')('vaultXferPaused'), /[一-鿿]/)
  assert.doesNotMatch(makeT('th')('vaultXferResume'), /[一-鿿]/, 'ไทยต้องไม่มีอักษรจีนปน')
  assert.doesNotMatch(makeT('zh')('vaultXferResume'), /[฀-๿]/, 'จีนต้องไม่มีอักษรไทยปน')
})

test('แถบสถานะ render ด้วยภาษาที่ผู้ใช้เลือกจริง ไม่ใช่ค่าปริยาย', async () => {
  const th = makeT('th')
  const held = gate()
  backend.uploadImpl = async ({ onStage, onProgress }) => {
    onStage('uploading')
    onProgress({ chunkIndex: 0, chunkCount: 2, transferredBytes: MIB, totalBytes: 2 * MIB, percent: 50 })
    await held.promise
    return { ok: false, stage: 'cancelled', reason: 'cancelled', resume: null }
  }

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t: th }))
    await unlock(dom, th, CORRECT_PASSPHRASE)
    await uploadFile(dom, { name: 'a.gif' })

    assert.match(html(), /กำลังอัปโหลดส่วนที่ 1 จาก 2/)
    assert.ok(byText(dom, 'button', th('vaultXferCancel')))
    assert.doesNotMatch(html(), /Uploading part/, 'ต้องไม่มีข้อความอังกฤษปนเมื่อเลือกภาษาไทย')
    await release(held)
  } finally {
    await h.unmount()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 63 · โฟกัสและ modal ต้องไม่ถอยหลัง
// ─────────────────────────────────────────────────────────────────────────────
test('แถบสถานะไม่แย่งโฟกัสและไม่รบกวนพฤติกรรมของ modal ที่มีอยู่', async () => {
  seedBlobs([serverBlobV2({ id: 'v2-focus', name: 'pic.gif', type: 'image/gif', plainSize: 2048, size: 2064 })])
  backend.downloadImpl = async ({ sink }) => {
    await sink.write(new Uint8Array([1, 2, 3, 4]))
    return { ok: true, chunksRead: 1, bytesWritten: 4, result: await sink.close() }
  }
  const held = gate()
  backend.uploadImpl = async ({ onStage, onProgress }) => {
    onStage('uploading')
    onProgress({ chunkIndex: 0, chunkCount: 2, transferredBytes: MIB, totalBytes: 2 * MIB, percent: 50 })
    await held.promise
    return { ok: true, stage: 'complete', blob: serverBlobV2({ id: 'v2-new', name: 'new.gif' }) }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    const before = doc().activeElement
    await uploadFile(dom, { name: 'new.gif' })

    assert.ok(panel(), 'แถบต้องปรากฏ')
    assert.equal(doc().querySelectorAll('[role="dialog"]').length, 0, 'แถบสถานะต้องไม่เป็น modal')
    assert.equal(doc().activeElement, before, 'แถบสถานะต้องไม่ขโมยโฟกัสไปจากที่ผู้ใช้อยู่')
    const live = panel().querySelector('[role="status"]')
    assert.ok(live, 'ความคืบหน้าต้องประกาศผ่าน live region ให้ screen reader ได้ยิน')
    assert.equal(live.getAttribute('aria-live'), 'polite')

    await release(held)
    assert.equal(panel(), null)

    // modal ที่มีอยู่เดิมยังทำงานเหมือนเดิมทุกประการ — เปิดแล้วปิดด้วย Escape
    await click(dom, menuButton('v2-focus'))
    await click(dom, menuItem(t('preview')))
    await tick()
    assert.ok(dialog(), 'preview ยังเปิดเป็น dialog ตามเดิม')
    assert.equal(dialog().getAttribute('aria-modal'), 'true')

    await act(async () => {
      doc().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await tick()
    assert.equal(dialog(), null, 'Escape ยังปิด modal ได้เหมือนเดิม')
  } finally {
    await h.unmount()
  }
})

test('V1 และ V2 อยู่ในรายการเดียวกันและแต่ละใบเดินเส้นทางของตัวเอง', async () => {
  seedBlobs([
    serverBlobV2({ id: 'v2-mix', name: 'new-format.gif', type: 'image/gif', plainSize: 2048, size: 2064 }),
    serverBlob({ id: 'v1-mix', name: 'old-format.gif' }),
  ])
  const v2Downloads = []
  backend.downloadImpl = async ({ blob, sink }) => {
    v2Downloads.push(blob.id)
    await sink.write(new Uint8Array([1, 2, 3, 4]))
    return { ok: true, chunksRead: 1, bytesWritten: 4, result: await sink.close() }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    assert.deepEqual(new Set(tileIds(dom)), new Set(['v2-mix', 'v1-mix']))
    assert.match(html(), /new-format\.gif/)
    assert.match(html(), /old-format\.gif/)

    await click(dom, menuButton('v2-mix'))
    await click(dom, menuItem(t('download')))
    await tick()
    assert.deepEqual(v2Downloads, ['v2-mix'], 'การ์ด V2 ต้องเดินเส้นทางรายก้อน')
    assert.equal(
      backend.requests.some((r) => r.path === '/api/vault/blobs/v2-mix'), false,
      'V2 ต้องไม่ยิงเส้นทางดาวน์โหลดทั้งไฟล์ของ V1',
    )

    await click(dom, menuButton('v1-mix'))
    await click(dom, menuItem(t('download')))
    await tick()
    assert.deepEqual(v2Downloads, ['v2-mix'], 'การ์ด V1 ต้องไม่เดินเส้นทาง V2')
    assert.ok(
      backend.requests.some((r) => r.path === '/api/vault/blobs/v1-mix' && r.method === 'GET_BYTES'),
      'V1 ยังดาวน์โหลดทั้งไฟล์ผ่านเส้นทางเดิมได้',
    )
  } finally {
    await h.unmount()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 62 · ความเร็วจริงและเวลาที่เหลือ (LFT-V2-E)
//
// ⚠️ สิ่งที่ตรึงไว้ตรงนี้คือ "ตัวเลขบนบรรทัดความเร็วมาจากไบต์จริงเท่านั้น" — นาฬิกาถูก
//    ควบคุมโดยเทสต์ ไม่ใช่ปล่อยให้เวลาจริงเดิน เทสต์ที่รอเวลาจะสั่นแบบสุ่มบนเครื่องช้า
// ─────────────────────────────────────────────────────────────────────────────
const rateEl = () => doc().querySelector('[data-vault-transfer-rate]')

/** นาฬิกาที่เทสต์เดินเอง — คืนฟังก์ชันเลื่อนเวลา และฟังก์ชันคืนค่าเดิม */
function fakeClock() {
  const real = globalThis.performance.now
  let ms = 0
  globalThis.performance.now = () => ms
  return {
    advance: (by) => { ms += by },
    restore: () => { globalThis.performance.now = real },
  }
}

test('บรรทัดความเร็วแสดงความเร็วจริงและเวลาที่เหลือจริง ไม่ใช่ค่าที่เดา', async () => {
  const FILE_SIZE = 20_000_000
  const clock = fakeClock()
  const g1 = gate()
  const g2 = gate()

  backend.uploadImpl = async ({ onStage, onProgress }) => {
    await g1.promise
    onStage('uploading')
    // 1 MB ทุก 500 ms = 2 MB/s — สี่ตัวอย่าง ตัวแรกคือจุดอ้างอิง
    for (let i = 0; i <= 3; i += 1) {
      if (i > 0) clock.advance(500)
      onProgress({
        phase: 'uploading', chunkIndex: i, chunkCount: 20,
        transferredBytes: i * 1_000_000, totalBytes: FILE_SIZE,
        percent: (i * 1_000_000 / FILE_SIZE) * 100,
      })
    }
    await g2.promise
    return { ok: true, stage: 'complete', blob: serverBlobV2({ id: 'v2-rate', name: 'clip.mp4', type: 'video/mp4' }) }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    await uploadFile(dom, { name: 'clip.mp4', type: 'video/mp4' })

    // ก่อนมีตัวอย่างจริง: ไม่มีบรรทัดความเร็ว (stage ยังเป็น preparing)
    assert.equal(rateEl(), null, 'ห้ามแสดงความเร็วก่อนที่จะมีไบต์วิ่งจริง')

    await release(g1)

    const el = rateEl()
    assert.ok(el, 'ระหว่างอัปโหลดต้องมีบรรทัดความเร็ว')
    assert.equal(el.getAttribute('data-vault-transfer-rate'), '2000000', '3 MB ใน 1.5 วินาที = 2 MB/s')
    assert.equal(el.getAttribute('data-vault-transfer-stalled'), 'no')
    // เหลือ 17 MB ที่ 2 MB/s = 8.5 วินาที → ปัดขึ้นเป็น 9
    assert.equal(el.getAttribute('data-vault-transfer-eta'), '9')

    // ★ ข้อความที่ผู้ใช้เห็นจริง — ไม่ใช่แค่ attribute ที่เทสต์อ่านได้เท่านั้น
    assert.ok(el.textContent.includes('1.9 MB/s'), 'หน่วยเดียวกับตัวนับไบต์ด้านบน (ฐาน 1024)')
    assert.ok(el.textContent.includes('about 9s remaining'), el.textContent)

    await release(g2)
    assert.equal(panel(), null)
  } finally {
    clock.restore()
    h.unmount()
  }
})

test('ไบต์หยุดนิ่ง = บอกว่ากำลังรอเครือข่าย ไม่ใช่ปล่อย ETA นับถอยหลังลวง', async () => {
  const FILE_SIZE = 20_000_000
  const clock = fakeClock()
  const g1 = gate()
  const g2 = gate()
  const g3 = gate()

  backend.uploadImpl = async ({ onStage, onProgress }) => {
    await g1.promise
    onStage('uploading')
    for (let i = 0; i <= 3; i += 1) {
      if (i > 0) clock.advance(500)
      onProgress({
        phase: 'uploading', chunkIndex: i, chunkCount: 20,
        transferredBytes: i * 1_000_000, totalBytes: FILE_SIZE, percent: 5 * i,
      })
    }
    await g2.promise
    // เน็ตหยุด: เวลาเดินต่อ 5 วินาที แต่ไบต์เท่าเดิมเป๊ะ
    clock.advance(5_000)
    onProgress({
      phase: 'uploading', chunkIndex: 3, chunkCount: 20,
      transferredBytes: 3_000_000, totalBytes: FILE_SIZE, percent: 15,
    })
    await g3.promise
    return { ok: true, stage: 'complete', blob: serverBlobV2({ id: 'v2-stall', name: 'clip.mp4', type: 'video/mp4' }) }
  }

  const h = env.mount()
  try {
    await unlocked(h)
    await uploadFile(dom, { name: 'clip.mp4', type: 'video/mp4' })
    await release(g1)
    assert.equal(rateEl().getAttribute('data-vault-transfer-stalled'), 'no')

    await release(g2)

    const el = rateEl()
    assert.equal(el.getAttribute('data-vault-transfer-stalled'), 'yes')
    assert.equal(el.getAttribute('data-vault-transfer-rate'), '', 'ห้ามค้างความเร็วเก่าไว้ตอนไม่มีไบต์วิ่ง')
    assert.equal(el.getAttribute('data-vault-transfer-eta'), '')
    assert.ok(el.textContent.includes(t('vaultXferStalled')), el.textContent)

    // ไบต์ที่ยืนยันแล้วยังต้องนิ่งสนิท — การหยุดนิ่งไม่ใช่การถอยหลัง
    assert.equal(bytesEl().getAttribute('data-vault-transfer-bytes'), String(3_000_000))

    await release(g3)
  } finally {
    clock.restore()
    h.unmount()
  }
})

test('บรรทัดความเร็วมีคำแปลจริงครบทั้ง en / th / zh — รวมตัวอย่างในข้อกำหนด', async () => {
  const { transferRateLine } = await import('../src/lib/transferRate.js')
  const { makeT: mk } = await import('../src/lib/strings.js')

  const measured = { bytesPerSecond: 61_236_183, etaSeconds: 11.4, stalled: false }

  // ★ ตัวอย่างที่ข้อกำหนดของงานนี้ระบุไว้ตรง ๆ
  assert.equal(transferRateLine(mk('th'), measured), '58.4 MB/s · เหลือประมาณ 12 วินาที')
  assert.equal(transferRateLine(mk('en'), measured), '58.4 MB/s · about 12s remaining')
  assert.equal(transferRateLine(mk('zh'), measured), '58.4 MB/s · 约剩 12 秒')

  for (const lang of ['en', 'th', 'zh']) {
    const tt = mk(lang)
    // ยังวัดไม่ได้ / หยุดนิ่ง / ไม่รู้ขนาดรวม — ทุกกรณีต้องเป็นประโยคจริง ไม่ใช่คีย์ดิบ
    const cases = [
      transferRateLine(tt, { bytesPerSecond: null, etaSeconds: null, stalled: false }),
      transferRateLine(tt, { bytesPerSecond: null, etaSeconds: null, stalled: true }),
      transferRateLine(tt, { bytesPerSecond: 2_000_000, etaSeconds: null, stalled: false }),
    ]
    for (const line of cases) {
      assert.ok(line && line.length > 0, `${lang}: ต้องมีข้อความ`)
      assert.ok(!line.includes('{') && !line.includes('}'), `${lang}: placeholder หลุด — ${line}`)
      assert.ok(!/^vaultXfer/.test(line), `${lang}: คีย์ดิบหลุดถึงผู้ใช้ — ${line}`)
    }
  }

  assert.equal(transferRateLine(mk('en'), null), null, 'ยังไม่มีผลการวัด = ไม่มีบรรทัด')
})
