// tests/uploadRecoveryLifecycle.test.js — FILES-UPLOAD-RECOVERY-1
//
// สิ่งที่ตรึงไว้ที่นี่คือ "ความต่างระหว่างหน้าเว็บถูกทำลาย กับ ผู้ใช้กดยกเลิก"
//
//   unmount / reload → abort request ในเครื่องเท่านั้น เซสชันฝั่งเซิร์ฟเวอร์ต้องอยู่ต่อ
//                      และบันทึกกู้คืนต้องอยู่ต่อ
//   Cancel           → abort + ลบเซสชันฝั่งเซิร์ฟเวอร์ + ลบบันทึกกู้คืน
//
// ⚠️ ถ้าสองอย่างนี้ถูกทำให้เหมือนกันเมื่อไร ผู้ใช้จะเสียงานอัปโหลด 2 GB เพราะเผลอกด F5
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')

let vite
let UploadDrawer
let recovery

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
  recovery = await vite.ssrLoadModule('/src/lib/uploadRecovery.js')
})

after(async () => {
  await vite?.close()
})

/* ── ตัวช่วย ──────────────────────────────────────────────────────────────── */

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
  }
}

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
    /** จำลอง "หน้าเว็บถูกทำลาย" ให้ใกล้ของจริงที่สุดเท่าที่ทดสอบได้ */
    async unmount() {
      await act(async () => root.unmount())
    },
    restore: env.restore,
    async cleanup() {
      try { await act(async () => root.unmount()) } catch { /* อาจ unmount ไปแล้ว */ }
      env.restore()
    },
  }
}

const SESSION = { uploadId: 'a'.repeat(48), chunkSize: 4 * 1024 * 1024, chunkCount: 4, received: [0, 1], missing: [2, 3], receivedBytes: 8 * 1024 * 1024 }

/** งานอัปโหลดที่ค้างกลางทาง และประกาศ checkpoint เหมือน transport จริง */
function pendingUpload({ session = SESSION } = {}) {
  const calls = []
  let settle
  const run = (options) => {
    calls.push(options)
    options.onStage?.('uploading')
    options.onCheckpoint?.(Object.freeze({
      reason: 'created', uploadId: session.uploadId, sha256: 'b'.repeat(64),
      chunkSize: session.chunkSize, chunkCount: session.chunkCount, receivedBytes: session.receivedBytes,
    }))
    options.onProgress?.({
      transferredBytes: session.receivedBytes, totalBytes: options.file.size,
      percent: 25, chunkIndex: 2, chunkCount: session.chunkCount,
    })
    return new Promise((resolve) => {
      settle = resolve
      options.signal?.addEventListener('abort', () => resolve({ ok: false, stage: 'cancelled', reason: 'cancelled', upload: null, sha256: null }), { once: true })
    })
  }
  return { run, calls, finish: (result) => settle?.(result) }
}

const fileIn = (dom, name = 'clip.mp4', size = 16 * 1024 * 1024) => {
  const file = new dom.window.File(['x'.repeat(8)], name, { type: 'video/mp4' })
  Object.defineProperty(file, 'size', { value: size })
  Object.defineProperty(file, 'lastModified', { value: 1_700_000_000_000 })
  return file
}

const recoveryRow = (over = {}) => ({
  version: recovery.RECOVERY_VERSION,
  uploadId: SESSION.uploadId,
  name: 'clip.mp4',
  size: 16 * 1024 * 1024,
  lastModified: 1_700_000_000_000,
  sha256: 'b'.repeat(64),
  chunkSize: SESSION.chunkSize,
  chunkCount: SESSION.chunkCount,
  receivedBytes: SESSION.receivedBytes,
  stage: 'uploading',
  createdAt: 1000,
  updatedAt: 2000,
  ...over,
})

const storageWith = (rows) => fakeStorage({
  [recovery.RECOVERY_STORAGE_KEY]: JSON.stringify({ version: recovery.RECOVERY_VERSION, records: rows }),
})

/* ══ ส่วนที่ 1 · unmount ไม่ใช่การยกเลิก ══════════════════════════════════ */

test('LIFECYCLE 1 · an active upload writes its recovery record as soon as the server session exists', async () => {
  const upload = pendingUpload()
  const storage = fakeStorage()
  const base = {
    t, open: false, onClose() {}, runUpload: upload.run, loadLimits: async () => null,
    recoveryStorage: storage,
  }
  const view = await mount({ ...base, initialFiles: [], requestId: 0 })
  try {
    await view.render({ ...base, initialFiles: [fileIn(view.dom)], requestId: 1 })
    const rows = recovery.createRecoveryStore({ storage }).list()
    assert.equal(rows.length, 1, 'เซสชันที่มีอยู่จริงต้องถูกจดไว้ทันที ไม่ใช่ตอนจบงาน')
    assert.equal(rows[0].uploadId, SESSION.uploadId)
    assert.equal(rows[0].sha256, 'b'.repeat(64))
  } finally {
    upload.finish({ ok: false, stage: 'cancelled', reason: 'cancelled', upload: null, sha256: null })
    await view.cleanup()
  }
})

test('LIFECYCLE 2 · unmount aborts only the local request: no server cancel, record preserved', async () => {
  const upload = pendingUpload()
  const storage = fakeStorage()
  const cancelled = []
  const base = {
    t, open: false, onClose() {}, runUpload: upload.run, loadLimits: async () => null,
    recoveryStorage: storage,
    cancelSession: async (id) => { cancelled.push(id); return true },
  }
  const view = await mount({ ...base, initialFiles: [], requestId: 0 })
  try {
    await view.render({ ...base, initialFiles: [fileIn(view.dom)], requestId: 2 })
    assert.equal(recovery.createRecoveryStore({ storage }).list().length, 1)

    await view.unmount()

    assert.equal(upload.calls[0].signal.aborted, true, 'request ในเครื่องต้องถูกหยุด')
    assert.deepEqual(cancelled, [], 'หน้าเว็บถูกทำลาย ≠ ผู้ใช้กดยกเลิก — ห้ามลบเซสชันฝั่งเซิร์ฟเวอร์')
    assert.equal(recovery.createRecoveryStore({ storage }).list().length, 1, 'บันทึกกู้คืนต้องรอดข้าม reload')
  } finally {
    view.restore()
  }
})

test('LIFECYCLE 3 · explicit Cancel releases the server session and clears the recovery record', async () => {
  const upload = pendingUpload()
  const storage = fakeStorage()
  const cancelled = []
  const view = await mount({
    t, open: false, onClose() {}, runUpload: upload.run, loadLimits: async () => null,
    recoveryStorage: storage,
    cancelSession: async (id) => { cancelled.push(id); return true },
    initialFiles: [], requestId: 0,
  })
  try {
    await view.render({
      t, open: false, onClose() {}, runUpload: upload.run, loadLimits: async () => null,
      recoveryStorage: storage,
      cancelSession: async (id) => { cancelled.push(id); return true },
      initialFiles: [fileIn(view.dom)], requestId: 3,
    })
    assert.equal(recovery.createRecoveryStore({ storage }).list().length, 1)

    await view.click(view.document.querySelector('[data-upload-cancel]'))

    assert.deepEqual(cancelled, [SESSION.uploadId], 'การกดยกเลิกต้องคืนพื้นที่พักฝั่งเซิร์ฟเวอร์')
    assert.equal(recovery.createRecoveryStore({ storage }).list().length, 0, 'ยกเลิกแล้วต้องไม่เหลือบันทึกให้กู้')
  } finally {
    await view.cleanup()
  }
})

test('LIFECYCLE 4 · a completed upload clears its recovery record', async () => {
  const storage = fakeStorage()
  const runUpload = async (options) => {
    options.onStage?.('uploading')
    options.onCheckpoint?.(Object.freeze({
      reason: 'created', uploadId: SESSION.uploadId, sha256: 'b'.repeat(64),
      chunkSize: SESSION.chunkSize, chunkCount: SESSION.chunkCount, receivedBytes: 0,
    }))
    return { ok: true, stage: 'complete', sha256: 'b'.repeat(64), upload: SESSION, file: { id: 'f1' } }
  }
  const base = { t, open: false, onClose() {}, runUpload, loadLimits: async () => null, recoveryStorage: storage }
  const view = await mount({ ...base, initialFiles: [], requestId: 0 })
  try {
    await view.render({ ...base, initialFiles: [fileIn(view.dom)], requestId: 4 })
    assert.equal(recovery.createRecoveryStore({ storage }).list().length, 0, 'งานที่ commit สำเร็จไม่มีอะไรให้กู้')
    assert.equal(view.document.querySelector('[data-upload-row]').getAttribute('data-upload-stage'), 'complete')
  } finally {
    await view.cleanup()
  }
})

/* ══ ส่วนที่ 2 · คืนสภาพหลัง reload ═══════════════════════════════════════ */

test('LIFECYCLE 5 · a reload rebuilds the interrupted row and never labels it Uploading', async () => {
  const storage = storageWith([recoveryRow()])
  const view = await mount({
    t, open: false, onClose() {}, loadLimits: async () => null,
    recoveryStorage: storage,
    runUpload: async () => ({ ok: false, stage: 'failed', reason: 'server', upload: null, sha256: null }),
    loadSession: async () => ({ ok: true, upload: { ...SESSION, status: 'open' } }),
  })
  try {
    const row = view.document.querySelector('[data-upload-row]')
    assert.ok(row, 'แถวที่ค้างอยู่ต้องถูกสร้างกลับมาจากบันทึกกู้คืน')
    assert.equal(row.getAttribute('data-upload-stage'), 'interrupted')
    assert.match(row.textContent, /clip\.mp4/)

    const tray = view.document.querySelector('[data-upload-tray]')
    assert.doesNotMatch(tray.textContent, /Uploading/i, 'ไม่มีไบต์ใดกำลังวิ่ง ห้ามบอกว่ากำลังอัปโหลด')
    assert.doesNotMatch(tray.textContent, /MB\/s|remaining/, 'ห้ามมีความเร็ว/ETA ค้างจากเซสชันก่อน')
    assert.ok(row.querySelector('[data-upload-recover]'), 'ต้องมีคำสั่งให้เลือกไฟล์ต้นทางกลับมา')
    // ไบต์ที่เซิร์ฟเวอร์ยืนยันแล้วต้องไม่หายไปจากสายตาผู้ใช้
    assert.match(row.textContent, /8\.0 MB of 16\.0 MB/)
  } finally {
    await view.cleanup()
  }
})

test('LIFECYCLE 6 · an expired server session is reported truthfully and stops offering resume', async () => {
  const storage = storageWith([recoveryRow()])
  const view = await mount({
    t, open: false, onClose() {}, loadLimits: async () => null,
    recoveryStorage: storage,
    runUpload: async () => ({ ok: false, stage: 'failed', reason: 'server', upload: null, sha256: null }),
    loadSession: async () => ({ ok: false, reason: 'expired' }),
  })
  try {
    const row = view.document.querySelector('[data-upload-row]')
    assert.ok(row)
    assert.equal(row.getAttribute('data-upload-stage'), 'failed')
    assert.equal(row.getAttribute('data-upload-reason'), 'expired')
    assert.equal(row.querySelector('[data-upload-recover]'), null, 'เซสชันหมดอายุแล้วไม่มีอะไรให้ทำต่อ')
    assert.equal(recovery.createRecoveryStore({ storage }).list().length, 0, 'บันทึกที่ใช้ไม่ได้แล้วต้องถูกเก็บกวาด')
  } finally {
    await view.cleanup()
  }
})

test('LIFECYCLE 6b · a network failure during reconciliation keeps the record instead of discarding it', async () => {
  const storage = storageWith([recoveryRow()])
  const view = await mount({
    t, open: false, onClose() {}, loadLimits: async () => null,
    recoveryStorage: storage,
    runUpload: async () => ({ ok: false, stage: 'failed', reason: 'server', upload: null, sha256: null }),
    loadSession: async () => ({ ok: false, reason: 'network' }),
  })
  try {
    assert.equal(
      recovery.createRecoveryStore({ storage }).list().length, 1,
      'เน็ตล่มตอนตรวจสถานะ ≠ เซสชันหมดอายุ — ห้ามทิ้งสิทธิ์ resume ของผู้ใช้',
    )
  } finally {
    await view.cleanup()
  }
})

/* ══ ส่วนที่ 3 · ต่อเซสชันเดิมด้วยไฟล์ต้นทางเดิม ═════════════════════════ */

test('LIFECYCLE 7 · reselecting the correct file resumes the existing session and sends only missing chunks', async () => {
  const storage = storageWith([recoveryRow()])
  const calls = []
  const view = await mount({
    t, open: false, onClose() {}, loadLimits: async () => null,
    recoveryStorage: storage,
    loadSession: async () => ({ ok: true, upload: { ...SESSION, status: 'open' } }),
    hashFile: async () => 'b'.repeat(64),
    runUpload: (options) => { calls.push(options); options.onStage?.('uploading'); return new Promise(() => {}) },
  })
  try {
    const row = view.document.querySelector('[data-upload-row]')
    await view.click(row.querySelector('[data-upload-recover]'))

    const input = view.document.querySelector('[data-upload-recover-input]')
    assert.ok(input, 'ต้องมีช่องเลือกไฟล์สำหรับการกู้คืน')

    const file = fileIn(view.dom)
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => {
      input.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    assert.equal(calls.length, 1, 'ต้องต่อเซสชันเดิม ไม่ใช่เริ่มงานใหม่')
    assert.equal(calls[0].upload?.uploadId, SESSION.uploadId)
    assert.deepEqual(calls[0].upload?.missing, [2, 3], 'ส่งเฉพาะ chunk ที่เซิร์ฟเวอร์บอกว่ายังขาด')
    assert.equal(calls[0].sha256, 'b'.repeat(64), 'ต้องไม่แฮชไฟล์ทั้งก้อนซ้ำใน transport')
  } finally {
    await view.cleanup()
  }
})

test('LIFECYCLE 8 · reselecting a different file is refused and no chunk reaches the old session', async () => {
  const storage = storageWith([recoveryRow()])
  const calls = []
  const view = await mount({
    t, open: false, onClose() {}, loadLimits: async () => null,
    recoveryStorage: storage,
    loadSession: async () => ({ ok: true, upload: { ...SESSION, status: 'open' } }),
    // ชื่อเดียวกัน ขนาดเดียวกัน แต่ไบต์คนละชุด
    hashFile: async () => 'c'.repeat(64),
    runUpload: (options) => { calls.push(options); return new Promise(() => {}) },
  })
  try {
    const row = view.document.querySelector('[data-upload-row]')
    await view.click(row.querySelector('[data-upload-recover]'))

    const input = view.document.querySelector('[data-upload-recover-input]')
    Object.defineProperty(input, 'files', { value: [fileIn(view.dom)], configurable: true })
    await act(async () => {
      input.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    assert.equal(calls.length, 0, 'ไฟล์ที่พิสูจน์ตัวตนไม่ผ่านต้องไม่ถูกส่งเข้าเซสชันเดิมแม้แต่ก้อนเดียว')
    const after = view.document.querySelector('[data-upload-row]')
    assert.equal(after.getAttribute('data-upload-stage'), 'interrupted', 'ยังกู้ได้อยู่ ผู้ใช้แค่เลือกไฟล์ผิด')
    assert.match(after.textContent, /different file|not the same file|does not match/i)
  } finally {
    await view.cleanup()
  }
})

test('LIFECYCLE 9 · a wrong-size file is refused without hashing anything', async () => {
  const storage = storageWith([recoveryRow()])
  const calls = []
  let hashed = 0
  const view = await mount({
    t, open: false, onClose() {}, loadLimits: async () => null,
    recoveryStorage: storage,
    loadSession: async () => ({ ok: true, upload: { ...SESSION, status: 'open' } }),
    hashFile: async () => { hashed += 1; return 'b'.repeat(64) },
    runUpload: (options) => { calls.push(options); return new Promise(() => {}) },
  })
  try {
    const row = view.document.querySelector('[data-upload-row]')
    await view.click(row.querySelector('[data-upload-recover]'))

    const input = view.document.querySelector('[data-upload-recover-input]')
    Object.defineProperty(input, 'files', { value: [fileIn(view.dom, 'clip.mp4', 999)], configurable: true })
    await act(async () => {
      input.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    assert.equal(hashed, 0)
    assert.equal(calls.length, 0)
  } finally {
    await view.cleanup()
  }
})
