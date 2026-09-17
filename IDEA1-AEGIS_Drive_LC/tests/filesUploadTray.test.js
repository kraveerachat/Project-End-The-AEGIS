// tests/filesUploadTray.test.js — FILES-UPLOAD-UX-1
//
// ตรึงสัญญาของ UX อัปโหลดใหม่: ลิ้นชัก "เริ่มงาน" กับถาดสถานะมุมขวาล่าง "เฝ้างาน"
// แยกหน้าที่กันชัดเจน และตัวเลขทุกตัวบนถาดต้องมาจากไบต์ที่วัดได้จริงเท่านั้น
//
// ⚠️ ข้อที่สำคัญที่สุดในไฟล์นี้: **ปิดถาด ≠ ยกเลิกงาน** ผู้ใช้ต้องไม่เสียงานอัปโหลด
//    เพียงเพราะกดปิดพื้นผิวหนึ่งบนจอ
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')

let vite
let UploadDrawer
let UploadStatusTray
let uploadTraySummary

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
  ;({ UploadDrawer } = await vite.ssrLoadModule('/src/components/UploadDrawer.jsx'))
  ;({ UploadStatusTray, uploadTraySummary } = await vite.ssrLoadModule('/src/components/UploadStatusTray.jsx'))
})

after(async () => {
  await vite?.close()
})

/* ── ตัวช่วย ──────────────────────────────────────────────────────────────── */

const item = (over = {}) => ({
  id: 'i1', name: 'clip.mp4', size: 49_700_000, stage: 'uploading', progress: 15.3,
  transferredBytes: 7_600_000, chunkIndex: 0, chunkCount: 6, session: null, rate: null, ...over,
})

/** อัตราที่ "มีหลักฐานพอแล้ว" — ตัวเลขชุดเดียวกับที่ transferRate.js จะคืนจริง */
const measuredRate = { bytesPerSecond: 61_234_567, etaSeconds: 12, stalled: false }

const trayMarkup = (props = {}) => renderToStaticMarkup(React.createElement(UploadStatusTray, {
  t, queue: [item()], collapsed: false,
  onToggleCollapse() {}, onHide() {}, onCancel() {}, onRetry() {}, onDismiss() {},
  ...props,
}))

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = new Map()
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    FormData: dom.window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  return {
    dom,
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
      dom.window.close()
    },
  }
}

async function mount(props) {
  const env = installDom()
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  let current = props
  const render = async (next = current) => {
    current = next
    await act(async () => {
      root.render(React.createElement(UploadDrawer, current))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
  await render(props)
  return {
    dom: env.dom,
    document,
    render,
    click: async (node) => {
      await act(async () => {
        node.dispatchEvent(new env.dom.window.MouseEvent('click', { bubbles: true }))
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
    },
    async cleanup() {
      await act(async () => root.unmount())
      env.restore()
    },
  }
}

/** งานอัปโหลดที่ "ค้างอยู่กลางทาง" จนกว่าเราจะสั่งให้จบ — ใช้ทดสอบสถานะกำลังทำงานจริง */
function pendingUpload() {
  const calls = []
  let settle
  const run = (options) => {
    calls.push(options)
    options.onStage?.('uploading')
    options.onProgress?.({ transferredBytes: 1024, totalBytes: options.file.size, percent: 1, chunkIndex: 0, chunkCount: 4 })
    return new Promise((resolve) => {
      settle = resolve
      options.signal?.addEventListener('abort', () => resolve({ ok: false, stage: 'cancelled', reason: 'cancelled', upload: null, sha256: null }), { once: true })
    })
  }
  return { run, calls, finish: (result) => settle?.(result) }
}

const cancelledResult = { ok: false, stage: 'cancelled', reason: 'cancelled', upload: null, sha256: null }

const fileIn = (dom, name = 'clip.mp4', size = 1024) => {
  const file = new dom.window.File(['x'.repeat(8)], name, { type: 'video/mp4' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

/* ── 1 · เลือกไฟล์แล้วลิ้นชักใหญ่ต้องปิดตัวเอง ─────────────────────────────── */

test('TEST 1 · selecting a file enqueues it and closes the large upload drawer', async () => {
  const upload = pendingUpload()
  let closed = 0
  const base = {
    t, open: true, onOpen() {}, onClose() { closed += 1 }, destination: '/Files',
    runUpload: upload.run, loadLimits: async () => null,
  }
  const view = await mount(base)
  try {
    await view.render({ ...base, initialFiles: [fileIn(view.dom)], requestId: 1 })
    assert.equal(upload.calls.length, 1, 'ไฟล์ต้องถูกส่งเข้าเครื่องอัปโหลดจริง')
    assert.ok(closed >= 1, 'ลิ้นชักใหญ่ต้องปิดตัวเองหลังส่งไฟล์เข้าคิว')
  } finally {
    upload.finish(cancelledResult)
    await view.cleanup()
  }
})

/* ── 2 · ถาดมุมขวาล่างต้องโผล่เองหลังเข้าคิว ───────────────────────────────── */

test('TEST 2 · the bottom-right upload status tray becomes visible after enqueue', async () => {
  const upload = pendingUpload()
  const base = { t, open: false, onOpen() {}, onClose() {}, runUpload: upload.run, loadLimits: async () => null }
  const view = await mount({ ...base, initialFiles: [], requestId: 0 })
  try {
    await view.render({ ...base, initialFiles: [fileIn(view.dom)], requestId: 2 })
    const tray = view.document.querySelector('[data-upload-tray]')
    assert.ok(tray, 'ถาดสถานะต้องปรากฏเองเมื่อมีงานใหม่')
    assert.match(tray.textContent, /clip\.mp4/)
  } finally {
    upload.finish(cancelledResult)
    await view.cleanup()
  }
})

/* ── 3 + 19 · ปิดถาด ≠ ยกเลิก ─────────────────────────────────────────────── */

test('TEST 3 + 19 · hiding the tray is presentation-only and never aborts the transfer', async () => {
  const upload = pendingUpload()
  const cancelled = []
  const base = {
    t, open: false, onOpen() {}, onClose() {},
    runUpload: upload.run, loadLimits: async () => null,
    cancelSession: async (id) => { cancelled.push(id); return true },
  }
  const view = await mount({ ...base, initialFiles: [], requestId: 0 })
  try {
    await view.render({ ...base, initialFiles: [fileIn(view.dom)], requestId: 3 })
    const hide = view.document.querySelector('[data-upload-tray-hide]')
    assert.ok(hide, 'ถาดต้องมีปุ่มซ่อนที่แยกจากปุ่มยกเลิก')
    await view.click(hide)

    assert.equal(view.document.querySelector('[data-upload-tray]'), null, 'ถาดต้องถูกซ่อน')
    assert.equal(upload.calls[0].signal.aborted, false, 'การซ่อนถาดต้องไม่ abort การโอน')
    assert.deepEqual(cancelled, [], 'การซ่อนถาดต้องไม่ยกเลิก session ฝั่งเซิร์ฟเวอร์')
  } finally {
    upload.finish(cancelledResult)
    await view.cleanup()
  }
})

/* ── 4 · ตัวเปิดถาดกลับมา ─────────────────────────────────────────────────── */

test('TEST 4 · a compact launcher restores the tray while work remains', async () => {
  const upload = pendingUpload()
  const base = { t, open: false, onOpen() {}, onClose() {}, runUpload: upload.run, loadLimits: async () => null }
  const view = await mount({ ...base, initialFiles: [], requestId: 0 })
  try {
    await view.render({ ...base, initialFiles: [fileIn(view.dom)], requestId: 4 })
    await view.click(view.document.querySelector('[data-upload-tray-hide]'))
    const launcher = view.document.querySelector('[data-upload-tray-launcher]')
    assert.ok(launcher, 'งานที่ยังเดินอยู่ต้องทิ้งตัวเปิดถาดไว้ให้กดกลับได้')
    await view.click(launcher)
    assert.ok(view.document.querySelector('[data-upload-tray]'), 'กดตัวเปิดแล้วถาดต้องกลับมา')
  } finally {
    upload.finish(cancelledResult)
    await view.cleanup()
  }
})

/* ── 5 · ย่อถาดแล้วคิวต้องอยู่ครบ ──────────────────────────────────────────── */

test('TEST 5 · collapsing the tray preserves the queue and the running upload', async () => {
  const upload = pendingUpload()
  const base = { t, open: false, onOpen() {}, onClose() {}, runUpload: upload.run, loadLimits: async () => null }
  const view = await mount({ ...base, initialFiles: [], requestId: 0 })
  try {
    await view.render({ ...base, initialFiles: [fileIn(view.dom)], requestId: 5 })
    const toggle = view.document.querySelector('[data-upload-tray-collapse]')
    assert.equal(toggle.getAttribute('aria-expanded'), 'true')
    await view.click(toggle)

    const tray = view.document.querySelector('[data-upload-tray]')
    assert.ok(tray, 'ย่อแล้วถาดยังต้องอยู่')
    assert.equal(tray.querySelector('[data-upload-tray-collapse]').getAttribute('aria-expanded'), 'false')
    assert.equal(tray.querySelectorAll('[data-upload-row]').length, 0, 'แถวถูกย่อเก็บ')
    assert.match(tray.textContent, /Uploading 1 item/i, 'สรุปแบบย่อยังบอกความจริงเดิม')
    assert.equal(upload.calls[0].signal.aborted, false, 'การย่อต้องไม่แตะการโอน')
  } finally {
    upload.finish(cancelledResult)
    await view.cleanup()
  }
})

/* ── 6 · งานใหม่ต้องเปิด/คลี่ถาดเอง ────────────────────────────────────────── */

test('TEST 6 · new upload activity reopens and expands a hidden or collapsed tray', async () => {
  const upload = pendingUpload()
  const base = { t, open: false, onOpen() {}, onClose() {}, runUpload: upload.run, loadLimits: async () => null }
  const view = await mount({ ...base, initialFiles: [], requestId: 0 })
  try {
    await view.render({ ...base, initialFiles: [fileIn(view.dom, 'first.mp4')], requestId: 6 })
    await view.click(view.document.querySelector('[data-upload-tray-collapse]'))
    await view.click(view.document.querySelector('[data-upload-tray-hide]'))
    assert.equal(view.document.querySelector('[data-upload-tray]'), null)

    await view.render({ ...base, initialFiles: [fileIn(view.dom, 'second.mp4')], requestId: 7 })
    const tray = view.document.querySelector('[data-upload-tray]')
    assert.ok(tray, 'งานใหม่ต้องเปิดถาดเอง')
    assert.equal(tray.querySelector('[data-upload-tray-collapse]').getAttribute('aria-expanded'), 'true', 'และต้องคลี่กลับมา')
    assert.match(tray.textContent, /second\.mp4/)
  } finally {
    upload.finish(cancelledResult)
    await view.cleanup()
  }
})

/* ── 7 · ความคืบหน้าจากไบต์ที่วัดได้ ───────────────────────────────────────── */

test('TEST 7 · an uploading row renders measured bytes, not an invented percentage', () => {
  const html = trayMarkup()
  assert.match(html, /aria-valuenow="15\.3"/)
  assert.match(html, /7\.2 MB of 47\.4 MB/)
  assert.match(html, /role="progressbar"/)
})

/* ── 8 · ความเร็ว/ETA มาจากตัวประมาณกลางเท่านั้น ──────────────────────────── */

test('TEST 8 · rate and ETA come from the shared estimator and only once evidence exists', () => {
  const withEvidence = trayMarkup({ queue: [item({ rate: measuredRate })] })
  assert.match(withEvidence, /58\.4 MB\/s · about 12s remaining/)

  const noEvidence = trayMarkup({ queue: [item({ rate: null })] })
  assert.doesNotMatch(noEvidence, /MB\/s/, 'ยังไม่มีหลักฐาน = ห้ามแต่งตัวเลขความเร็ว')
  assert.doesNotMatch(noEvidence, /remaining/)

  const stalled = trayMarkup({ queue: [item({ rate: { bytesPerSecond: null, etaSeconds: null, stalled: true } })] })
  assert.match(stalled, /Waiting for the network/)
  assert.doesNotMatch(stalled, /MB\/s/)
})

/* ── 9–11 · ทุกสถานะที่ไม่ใช่การส่งจริง ต้องไม่มีความเร็วค้าง ─────────────── */

test('TEST 9 · preparing and hashing never show a network speed or ETA', () => {
  for (const stage of ['waiting', 'preparing', 'hashing', 'processing']) {
    const html = trayMarkup({ queue: [item({ stage, rate: measuredRate })] })
    assert.doesNotMatch(html, /MB\/s/, `${stage} ต้องไม่โชว์ความเร็วเครือข่าย`)
    assert.doesNotMatch(html, /remaining/, `${stage} ต้องไม่โชว์ ETA`)
  }
})

test('TEST 10 · the finalizing stage drops the stale upload speed and ETA', () => {
  const html = trayMarkup({ queue: [item({ stage: 'committing', rate: measuredRate })] })
  assert.match(html, /Finalis|Finaliz|COMMITTING/i)
  assert.doesNotMatch(html, /MB\/s/)
  assert.doesNotMatch(html, /remaining/)
})

test('TEST 11 · paused, failed, and cancelled rows never keep a stale speed', () => {
  for (const stage of ['paused', 'failed', 'cancelled']) {
    const html = trayMarkup({ queue: [item({ stage, rate: measuredRate })] })
    assert.doesNotMatch(html, /MB\/s/, `${stage} ต้องไม่โชว์ความเร็วค้าง`)
    assert.doesNotMatch(html, /remaining/, `${stage} ต้องไม่โชว์ ETA ค้าง`)
  }
})

/* ── 12 · สถานะสำเร็จ ─────────────────────────────────────────────────────── */

test('TEST 12 · a completed item renders a truthful terminal success state', () => {
  const html = trayMarkup({ queue: [item({ stage: 'complete', progress: 100, rate: measuredRate })] })
  assert.match(html, /Complete/i)
  assert.match(html, /aria-valuenow="100"/)
  assert.doesNotMatch(html, /MB\/s/)
})

/* ── 13 · สรุปหัวถาดจากคิวจริง ────────────────────────────────────────────── */

test('TEST 13 · the tray header summary is derived from the real queue', () => {
  assert.deepEqual(uploadTraySummary([{ stage: 'uploading' }]), { key: 'uploadTrayUploadingOne', vars: { n: 1 } })
  assert.deepEqual(uploadTraySummary([{ stage: 'uploading' }, { stage: 'uploading' }]), { key: 'uploadTrayUploading', vars: { n: 2 } })
  // ⚠️ FILES-UPLOAD-RECOVERY-1 แยก "กำลังตรวจไฟล์" ออกจาก "กำลังอัปโหลด" — ไฟล์ที่ยัง
  //    แฮชอยู่ไม่มีไบต์ใดออกจากเครื่อง การนับรวมทำให้หัวถาดพูดเกินจริงตั้งแต่วินาทีแรก
  assert.deepEqual(uploadTraySummary([{ stage: 'uploading' }, { stage: 'hashing' }]), { key: 'uploadTrayMixed', vars: { n: 1, checking: 1 } })
  assert.deepEqual(uploadTraySummary([{ stage: 'hashing' }, { stage: 'hashing' }]), { key: 'uploadTrayChecking', vars: { n: 2 } })
  // ยังมีงานที่ต้องจัดการ = ห้ามพูดว่า "เสร็จแล้ว"
  assert.deepEqual(uploadTraySummary([{ stage: 'complete' }, { stage: 'failed' }]), { key: 'uploadTrayAttentionOne', vars: { n: 1 } })
  assert.deepEqual(uploadTraySummary([{ stage: 'complete' }, { stage: 'paused' }]), { key: 'uploadTrayAttentionOne', vars: { n: 1 } })
  assert.deepEqual(uploadTraySummary([{ stage: 'complete' }]), { key: 'uploadTrayCompleteOne', vars: { n: 1 } })
  assert.deepEqual(uploadTraySummary([{ stage: 'complete' }, { stage: 'complete' }, { stage: 'complete' }]), { key: 'uploadTrayComplete', vars: { n: 3 } })
  // งานที่กำลังเดินสำคัญกว่าทุกอย่าง
  assert.deepEqual(uploadTraySummary([{ stage: 'uploading' }, { stage: 'failed' }]), { key: 'uploadTrayUploadingOne', vars: { n: 1 } })

  const html = trayMarkup({ queue: [item({ id: 'a' }), item({ id: 'b', name: 'doc.pdf' })] })
  assert.match(html, /Uploading 2 items/i)
  assert.match(html, /clip\.mp4/)
  assert.match(html, /doc\.pdf/)
})

/* ── 14 · ไฟล์เกินเพดานของ deployment ─────────────────────────────────────── */

test('TEST 14 · a configured-size rejection never reaches the transport, stays truthful, and is non-retryable', async () => {
  const upload = pendingUpload()
  const base = {
    t, open: true, onOpen() {}, onClose() {},
    runUpload: upload.run, loadLimits: async () => ({ maxLogicalFileBytes: 1_000 }),
  }
  const view = await mount({ ...base, initialFiles: [], requestId: 0 })
  try {
    // 1. Select file larger than maxLogicalFileBytes
    await view.render({ ...base, initialFiles: [fileIn(view.dom, 'huge.mp4', 11_000_000_000)], requestId: 14 })
    // 2. Initial transport call count remains 0
    assert.equal(upload.calls.length, 0, 'ไฟล์ที่เกินเพดานต้องไม่ถูกส่งขึ้นไปเลย')
    // 3. Tray displays truthful tooLarge rejection
    const tray = view.document.querySelector('[data-upload-tray]')
    assert.ok(tray, 'การปฏิเสธต้องปรากฏบนถาด ไม่ใช่ติดอยู่ในลิ้นชักที่ปิดไปแล้ว')
    assert.match(tray.textContent, /huge\.mp4/)
    // ⚠️ ถ้อยคำเดิมของการปฏิเสธต้องไม่ถูกเขียนใหม่ — เพดานยังเป็นของ deployment เหมือนเดิม
    assert.match(tray.textContent, /Larger than the upload limit this system is configured for/i)
    const row = tray.querySelector('[data-upload-row]')
    assert.equal(row.getAttribute('data-upload-reason'), 'tooLarge')
    assert.equal(row.getAttribute('data-upload-stage'), 'failed')

    // 4. A tooLarge item MUST NOT expose a Retry action while the configured deployment limit still rejects it
    const retryBtn = row.querySelector('[data-upload-retry]')
    assert.equal(Boolean(retryBtn), false, 'รายการที่ถูกปฏิเสธเพราะเกินเพดานต้องไม่มีปุ่ม Retry ให้กดส่งซ้ำ')

    // 5. No user interaction available from that rejected row can cause runUpload() to be invoked
    // 6. Dismiss remains available
    const dismissBtn = row.querySelector('[data-upload-dismiss]')
    assert.ok(dismissBtn, 'ปุ่ม Dismiss ต้องยังคงมีอยู่เพื่อให้ผู้ใช้ลบรายการออกได้')
    await view.click(dismissBtn)
    assert.equal(upload.calls.length, 0, 'ไม่มีการกระทำใดจากแถวที่ถูกปฏิเสธที่สามารถเรียก runUpload ได้')
  } finally {
    upload.finish(cancelledResult)
    await view.cleanup()
  }
})

test('TEST 14b · defensive guard: programmatic or UI retry of an oversized item aborts and never calls transport', async () => {
  const upload = pendingUpload()
  const base = {
    t, open: false, onClose() {},
    runUpload: upload.run,
    loadLimits: async () => ({ maxLogicalFileBytes: 10_000_000_000 }),
  }
  // จำลองรายการที่ล้มเหลวด้วยเหตุผลอื่น (เช่น network) แต่ขนาดไฟล์จริงเกินเพดาน 10 GB
  const view = await mount({
    ...base,
    initialQueue: [item({
      id: 'oversize-seed',
      name: 'oversize.mp4',
      size: 11_000_000_000,
      stage: 'failed',
      reason: 'network',
      file: { name: 'oversize.mp4', size: 11_000_000_000 },
    })],
  })
  try {
    const row = view.document.querySelector('[data-upload-row="oversize-seed"]')
    assert.ok(row, 'ต้องพบแถวในถาด')
    const retryBtn = row.querySelector('[data-upload-retry]')
    assert.ok(retryBtn, 'แถวที่มี reason เป็น network เริ่มต้นมีปุ่ม retry')

    // กด retry — ยามป้องกันใน UploadDrawer.retry() ต้องดักจับเพดานและไม่ส่งต่อ
    await view.click(retryBtn)

    // Transport calls ต้องเป็น 0
    assert.equal(upload.calls.length, 0, 'ยามป้องกันต้องระงับการส่งไฟล์เกินเพดาน ไม่มีการเรียก runUpload')

    // สถานะต้องถูกปรับกลับเป็น failed / tooLarge
    assert.equal(row.getAttribute('data-upload-stage'), 'failed')
    assert.equal(row.getAttribute('data-upload-reason'), 'tooLarge')

    // และปุ่ม retry ต้องหายไปหลังถูกปรับเป็น tooLarge
    const retryBtnAfter = row.querySelector('[data-upload-retry]')
    assert.equal(Boolean(retryBtnAfter), false, 'ปุ่ม retry ต้องหายไปหลังตรวจพบว่าเกินเพดาน')
  } finally {
    upload.finish(cancelledResult)
    await view.cleanup()
  }
})

test('TEST 14c · failed rows with genuine retryable reasons retain Retry, while tooLarge is excluded', () => {
  const retryableHtml = trayMarkup({
    queue: [item({ stage: 'failed', reason: 'network', file: { name: 'clip.mp4', size: 1024 } })],
  })
  assert.match(retryableHtml, /data-upload-retry/, 'งานที่ล้มเหลวด้วยเหตุผลเครือข่ายต้องยังมีปุ่ม Retry')

  const tooLargeHtml = trayMarkup({
    queue: [item({ stage: 'failed', reason: 'tooLarge', file: { name: 'huge.mp4', size: 11_000_000_000 } })],
  })
  assert.doesNotMatch(tooLargeHtml, /data-upload-retry/, 'งานที่ล้มเหลวเพราะเกินเพดานต้องไม่มีปุ่ม Retry')
  assert.match(tooLargeHtml, /data-upload-dismiss/, 'ปุ่ม Dismiss ต้องยังอยู่')
})

/* ── 15 + 16 · ยกเลิกยังทำงานเหมือนเดิมทุกประการ ──────────────────────────── */

test('TEST 15 + 16 · cancel still aborts the intended transfer and releases the server session', async () => {
  const cancelled = []
  const calls = []
  let settle
  const runUpload = (options) => {
    calls.push(options)
    options.onStage?.('uploading')
    return new Promise((resolve) => {
      settle = resolve
      options.signal?.addEventListener('abort', () => resolve(cancelledResult), { once: true })
    })
  }
  const view = await mount({
    t, open: false, onOpen() {}, onClose() {},
    runUpload, loadLimits: async () => null,
    cancelSession: async (id) => { cancelled.push(id); return true },
    initialQueue: [item({ id: 'seed', stage: 'uploading', session: { uploadId: 'up-7' } })],
  })
  try {
    const rows = [...view.document.querySelectorAll('[data-upload-row]')]
    assert.equal(rows.length, 1)
    const cancelBtn = rows[0].querySelector('[data-upload-cancel]')
    assert.ok(cancelBtn, 'งานที่กำลังเดินต้องมีปุ่มยกเลิก')
    await view.click(cancelBtn)
    assert.deepEqual(cancelled, ['up-7'], 'ต้องคืน session ฝั่งเซิร์ฟเวอร์ด้วย')
    assert.equal(view.document.querySelector('[data-upload-row]').getAttribute('data-upload-stage'), 'cancelled')
  } finally {
    settle?.(cancelledResult)
    void calls
    await view.cleanup()
  }
})

/* ── 17 · Resume ต้องทำต่อจาก session เดิม ไม่ใช่เริ่มไฟล์ใหม่ ─────────────── */

test('TEST 17 · resume continues from the server session instead of restarting the file', async () => {
  const calls = []
  const runUpload = (options) => {
    calls.push(options)
    options.onStage?.('uploading')
    return new Promise(() => {})
  }
  // ⚠️ คิวเป็นของคอมโพเนนต์ ไม่ใช่ของ prop — seed ได้ตอน mount เท่านั้น ซึ่งเป็นสิ่งที่
  //    ทำให้การ re-render ของหน้า Files ไม่มีวันรีเซ็ตงานที่กำลังส่งอยู่
  const view = await mount({
    t, open: false, onClose() {}, runUpload, loadLimits: async () => null,
    initialQueue: [item({
      id: 'seed', name: 'resume.mp4', size: 4096, stage: 'paused', reason: 'network',
      file: { name: 'resume.mp4', size: 4096 },
      session: { uploadId: 'up-9', chunkSize: 1024, chunkCount: 4, received: [0, 1], missing: [2, 3], receivedBytes: 2048 },
      sha256: 'a'.repeat(64), transferredBytes: 2048,
    })],
  })
  try {
    const resumeBtn = view.document.querySelector('[data-upload-retry]')
    assert.ok(resumeBtn, 'งานที่หยุดชั่วคราวและยังมี session ต้องกดทำต่อได้')
    assert.match(resumeBtn.textContent, /Resume/i)
    await view.click(resumeBtn)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].upload?.uploadId, 'up-9', 'ต้องส่ง session เดิมกลับเข้าไป')
    assert.equal(calls[0].sha256, 'a'.repeat(64), 'ต้องไม่แฮชไฟล์ใหม่ทั้งก้อน')
  } finally {
    await view.cleanup()
  }
})

/* ── 18 · ปิดลิ้นชักใหญ่ต้องไม่ทำลายคิว ───────────────────────────────────── */

test('TEST 18 · closing the large drawer does not destroy the queue or the running upload', async () => {
  const upload = pendingUpload()
  const base = { t, onOpen() {}, onClose() {}, runUpload: upload.run, loadLimits: async () => null }
  const view = await mount({ ...base, open: true, initialFiles: [], requestId: 0 })
  try {
    const file = fileIn(view.dom)
    await view.render({ ...base, open: true, initialFiles: [file], requestId: 18 })
    assert.equal(upload.calls.length, 1)
    await view.render({ ...base, open: false, initialFiles: [file], requestId: 18 })

    assert.equal(view.document.querySelector('[role="dialog"]'), null, 'ลิ้นชักใหญ่ปิดแล้ว')
    const tray = view.document.querySelector('[data-upload-tray]')
    assert.ok(tray, 'คิวยังอยู่บนถาด')
    assert.match(tray.textContent, /clip\.mp4/)
    assert.equal(upload.calls.length, 1, 'ต้องไม่เริ่มงานซ้ำ')
    assert.equal(upload.calls[0].signal.aborted, false, 'ต้องไม่ abort งานที่กำลังเดิน')
  } finally {
    upload.finish(cancelledResult)
    await view.cleanup()
  }
})

/* ── 20 · จุดเข้าอัปโหลดเดิมของหน้า Files ต้องยังใช้ได้ ────────────────────── */

test('TEST 20 · Files keeps the upload entry points and mounts the queue owner unconditionally', async () => {
  const fs = await import('node:fs/promises')
  const source = await fs.readFile(new URL('../src/screens/Files.jsx', import.meta.url), 'utf8')
  assert.match(source, /<UploadDrawer/, 'Files ต้อง mount เจ้าของคิวไว้เสมอ')
  assert.doesNotMatch(source, /\{uploadOpen && \s*<UploadDrawer/, 'ห้าม unmount เจ้าของคิวตามสถานะการเปิดลิ้นชัก')
  assert.match(source, /onClick=\{handleUpload\}/, 'ปุ่ม Upload บนแถบเครื่องมือต้องยังเปิดลิ้นชักได้')
  assert.match(source, /setDropRequest\(\{ files: \[\.\.\.dropped\], id: Date\.now\(\) \}\)/, 'การลากวางต้องยังส่งไฟล์เข้าคิวเหมือนเดิม')
  // ลากวางบนหน้า Files = ผู้ใช้เลือกไฟล์ไปแล้ว ไม่ต้องเด้งลิ้นชัก "เลือกไฟล์" ขึ้นมาแล้วปิดทิ้งทันที
  assert.doesNotMatch(source, /setDropRequest\([^\n]*\n\s*setUploadOpen\(true\)/, 'การลากวางต้องไม่เด้งลิ้นชักใหญ่ขึ้นมาแล้วปิดทิ้ง')
})

/* ── การเข้าถึง ───────────────────────────────────────────────────────────── */

test('accessibility · tray controls carry real names, values, and expanded state', () => {
  const html = trayMarkup({ queue: [item({ rate: measuredRate })] })
  assert.match(html, /aria-label="Hide upload status"/)
  assert.match(html, /aria-label="Collapse upload status"/)
  assert.match(html, /aria-expanded="true"/)
  assert.match(html, /aria-valuemin="0"/)
  assert.match(html, /aria-valuemax="100"/)
  assert.match(html, /aria-valuenow="15\.3"/)
  // ตัวเลขไบต์เปลี่ยนทุกเสี้ยววินาที — ห้ามยิงเข้า screen reader ทุกครั้ง
  assert.doesNotMatch(html, /aria-live="assertive"/)

  const collapsed = trayMarkup({ collapsed: true })
  assert.match(collapsed, /aria-label="Expand upload status"/)
  assert.match(collapsed, /aria-expanded="false"/)
})

test('accessibility · the tray is the single upload status surface, not a duplicate toast', () => {
  const html = trayMarkup({ queue: [item({ stage: 'complete', progress: 100 })] })
  assert.doesNotMatch(html, /upload-success-toast/)
  assert.equal(html.match(/role="status"/g)?.length ?? 0, 1, 'ต้องมีพื้นผิวประกาศสถานะเดียว')
})
