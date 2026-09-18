// tests/filesRound10.test.js — FILES-MANAGEMENT-UX-1 · Round 10 (final browser corrections)
//
//   A. การ์ด GIF ตอนไม่ชี้ต้องแสดง "ภาพจริงแบบนิ่ง" (poster ที่ถอดเฟรมแรกในเบราว์เซอร์)
//      ไม่ใช่ไอคอนทั่วไป และไม่ใช่ GIF ที่เคลื่อนไหวซ่อนอยู่หลัง overlay
//   B. ลากรายการที่เลือกไปวางบน breadcrumb "Files" (ราก) ขณะอยู่ในโฟลเดอร์ = ย้ายกลับราก
//      ผ่านเส้นทาง Move เดิม (moveItems(ids, null)) แล้วพาไปที่ราก
//
// ⚠️ jsdom ไม่มี createImageBitmap / canvas จริง / DataTransfer — ทดสอบด้วยการ stub
//    primitive ของเบราว์เซอร์อย่างซื่อสัตย์: เรานับ "การสร้าง/คืน object URL", "การ
//    fetch ทรัพยากรไหน", และ "DOM ที่ผู้ใช้เห็น" — ไม่ได้ทดสอบว่าเบราว์เซอร์ถอดรหัส GIF ถูก
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
const AEGIS_ITEMS_TYPE = 'application/x-aegis-items'

let vite
let files

before(async () => {
  vite = await createServer({
    configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent',
    plugins: [reactPlugin()], server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] },
  })
  files = await vite.ssrLoadModule('/src/screens/Files.jsx')
})
after(async () => { await vite?.close() })

/* ── fixtures ─────────────────────────────────────────────────────────────── */
const NOW = 1_800_000_000_000
const fileItem = (over = {}) => ({
  id: 'f1', name: 'report.pdf', kind: 'file', type: 'PDF', ext: 'pdf',
  size: 1024, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, parentId: null, ...over,
})
const folderItem = (over = {}) => ({
  id: 'd1', name: '01', kind: 'folder', type: 'Folder', ext: '',
  size: 0, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, parentId: null, ...over,
})
const image = (over = {}) => fileItem({ id: 'img1', name: 'photo.jpg', type: 'Image', ext: 'jpg', ...over })
const gif = (over = {}) => fileItem({ id: 'g1', name: 'loop.gif', type: 'Image', ext: 'gif', ...over })
const noop = () => {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── jsdom + browser primitive stubs ───────────────────────────────────────── */
function installDom({ reducedMotion = false, bitmap = 'ok' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  w.matchMedia = (q) => ({ matches: reducedMotion && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} })
  const stats = { fetched: [], created: 0, revoked: 0, bitmaps: 0, closed: 0 }
  // canvas: jsdom ไม่มี backend — ให้ 2D context ปลอมที่วาดได้ และ toBlob ที่คืน blob จริง
  w.HTMLCanvasElement.prototype.getContext = function () { return { drawImage() {} } }
  w.HTMLCanvasElement.prototype.toBlob = function (cb, type) { cb(new w.Blob(['poster'], { type: type || 'image/png' })) }
  const previous = new Map()
  const globals = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    createImageBitmap: async () => {
      stats.bitmaps += 1
      if (bitmap === 'fail') throw new Error('decode failed')
      return { width: 640, height: 320, close() { stats.closed += 1 } }
    },
    fetch: async (url) => {
      stats.fetched.push(String(url))
      return { ok: true, status: 200, blob: async () => new w.Blob(['gif-bytes'], { type: 'image/gif' }), json: async () => ({}) }
    },
  }
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  // object URLs: นับการสร้าง/คืน (Node มี URL.createObjectURL จริง แต่เราต้องนับให้ได้)
  const origCreate = URL.createObjectURL
  const origRevoke = URL.revokeObjectURL
  URL.createObjectURL = () => { stats.created += 1; return `blob:poster-${stats.created}` }
  URL.revokeObjectURL = () => { stats.revoked += 1 }
  return {
    dom, stats,
    restore() {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
      w.close()
    },
  }
}

async function mountRoot(opts) {
  const env = installDom(opts)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  const W = env.dom.window
  const render = (el) => act(async () => { root.render(el); await sleep(25) })
  const mouse = (node, type, init = {}) => act(async () => { node.dispatchEvent(new W.MouseEvent(type, { bubbles: true, cancelable: true, ...init })); await sleep(5) })
  /** drag events with a fake DataTransfer — jsdom ไม่มี DataTransfer */
  const drag = (node, type, dt) => act(async () => {
    const ev = new W.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', { value: dt })
    node.dispatchEvent(ev)
    await sleep(5)
  })
  return { env, W, root, render, mouse, drag, stats: env.stats, unmount: async () => { await act(async () => root.unmount()); env.restore() } }
}

/** DataTransfer จำลอง: ภายใน (รายการ AEGIS) หรือภายนอก (ไฟล์จาก OS) */
function internalTransfer() {
  const store = {}
  return { types: [AEGIS_ITEMS_TYPE], setData(k, v) { store[k] = v; if (!this.types.includes(k)) this.types.push(k) }, getData(k) { return store[k] ?? '' }, effectAllowed: '', dropEffect: '' }
}
const externalTransfer = () => ({ types: ['Files'], files: [], setData() {}, getData() { return '' }, effectAllowed: '', dropEffect: '' })

function tile(file) {
  return React.createElement(files.FileTile, {
    t, file, now: NOW, selected: false, anySelected: false,
    onSelect: noop, onOpen: noop, onMenuAction: noop, tileRef: noop, dragActive: false,
  })
}
const thumb = () => document.querySelector('[data-thumb]')
const previewImg = () => document.querySelector('img[src$="/preview"]')
const posterImg = () => document.querySelector('img[src^="blob:poster-"]')
const hover = (m) => async () => { const c = document.querySelector('[data-file-kind]'); await m.mouse(c, 'mouseover'); await m.mouse(c, 'mouseenter') }
const leave = (m) => async () => { const c = document.querySelector('[data-file-kind]'); await m.mouse(c, 'mouseout'); await m.mouse(c, 'mouseleave') }

/* ══ CORRECTION A — GIF static poster ══════════════════════════════════════ */

test('R10-GIF-1 · idle GIF shows a real static poster derived in the browser, not the generic icon', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    assert.equal(thumb().getAttribute('data-thumb'), 'gif-poster')
    assert.equal(thumb().getAttribute('data-motion'), 'idle')
    const p = posterImg()
    assert.ok(p, 'ต้องมี <img> ที่ชี้ไป object URL ของ poster')
    assert.equal(m.stats.bitmaps, 1, 'ถอดบิตแมปนิ่งหนึ่งครั้ง')
    assert.equal(m.stats.created, 1)
    assert.equal(m.stats.closed, 1, 'ImageBitmap ต้องถูก close หลังวาดลง canvas')
    assert.ok(m.stats.fetched.some((u) => u.endsWith('/api/files/g1/preview')), 'poster มาจากทรัพยากร preview จริงของไฟล์นี้')
    assert.ok(!thumb().querySelector('svg'), 'ไม่ใช่ไอคอน')
  } finally { await m.unmount() }
})

test('R10-GIF-2 · the idle thumbnail is never the live animated GIF <img>', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    assert.equal(previewImg(), null, 'idle ต้องไม่มี <img src=…/preview> ที่เคลื่อนไหว')
    assert.equal(document.querySelectorAll('img').length, 1, 'มีภาพเดียวคือ poster — ไม่มี GIF ซ่อนอยู่หลัง overlay')
  } finally { await m.unmount() }
})

test('R10-GIF-3 · hover mounts the real animated GIF; R10-GIF-4 · leave removes it and restores the poster', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    await hover(m)()
    assert.ok(previewImg(), 'ชี้แล้วต้องมี GIF จริง')
    assert.equal(thumb().getAttribute('data-thumb'), 'gif')
    assert.equal(thumb().getAttribute('data-motion'), 'playing')
    await leave(m)()
    assert.equal(previewImg(), null, 'ออกแล้ว GIF ที่เคลื่อนไหวต้องหาย')
    assert.ok(posterImg(), 'กลับมาเป็น poster นิ่ง')
    assert.equal(thumb().getAttribute('data-thumb'), 'gif-poster')
    assert.equal(thumb().getAttribute('data-motion'), 'idle')
    assert.equal(m.stats.bitmaps, 1, 'poster ไม่ถูกถอดใหม่ทุกครั้งที่ชี้/ออก')
  } finally { await m.unmount() }
})

test('R10-GIF-5 · reduced motion keeps the static poster and never mounts the animation on hover', async () => {
  const m = await mountRoot({ reducedMotion: true })
  try {
    await m.render(tile(gif()))
    assert.equal(thumb().getAttribute('data-thumb'), 'gif-poster')
    await hover(m)()
    assert.equal(previewImg(), null)
    assert.ok(posterImg())
    assert.equal(thumb().getAttribute('data-motion'), 'idle')
  } finally { await m.unmount() }
})

test('R10-GIF-6 · a change of file identity rebuilds the poster and releases the old one', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    const first = posterImg().getAttribute('src')
    await m.render(tile(gif({ id: 'g2', name: 'other.gif' })))
    const second = posterImg().getAttribute('src')
    assert.notEqual(second, first)
    assert.equal(m.stats.bitmaps, 2)
    assert.equal(m.stats.created, 2)
    assert.equal(m.stats.revoked, 1, 'poster เก่าต้องถูกคืนเมื่อตัวตนเปลี่ยน')
    assert.ok(m.stats.fetched.some((u) => u.endsWith('/api/files/g2/preview')))
    // ตัวตนเดิม re-render → ไม่ถอดซ้ำ
    await m.render(tile(gif({ id: 'g2', name: 'other.gif', modified: NOW + 1 })))
    assert.equal(m.stats.bitmaps, 2)
  } finally { await m.unmount() }
})

test('R10-GIF-7 · a GIF the browser cannot decode falls back to the truthful icon, with no broken-image element', async () => {
  const m = await mountRoot({ bitmap: 'fail' })
  try {
    await m.render(tile(gif()))
    assert.equal(thumb().getAttribute('data-thumb'), 'gif-static')
    assert.ok(thumb().querySelector('svg'))
    assert.equal(document.querySelector('img'), null, 'ห้ามมี <img> ที่พังค้างอยู่')
    assert.equal(m.stats.created, 0)
    // ชี้แล้วยังลอง GIF จริงได้ (การถอด poster ล้มเหลว ≠ ไฟล์เล่นไม่ได้)
    await hover(m)()
    assert.ok(previewImg())
  } finally { await m.unmount() }
})

test('R10-GIF-8 · unmount releases every generated object URL and bitmap', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    await m.render(tile(gif({ id: 'g2', name: 'b.gif' })))
    assert.equal(m.stats.created, 2)
    await act(async () => m.root.unmount())
    assert.equal(m.stats.revoked, m.stats.created, 'สร้างเท่าไหร่ต้องคืนเท่านั้น')
    assert.equal(m.stats.closed, m.stats.bitmaps)
    m.env.restore(); m.unmount = async () => {}
  } finally { await m.unmount() }
})

test('R10-GIF-9 · static formats are untouched: no poster pipeline, plain <img> to the preview route', async () => {
  const m = await mountRoot()
  try {
    for (const f of [image(), image({ id: 'p', name: 'p.png', ext: 'png' }), image({ id: 'w', name: 'w.webp', ext: 'webp' })]) {
      await m.render(tile(f))
      assert.equal(thumb().getAttribute('data-thumb'), 'image', f.name)
      assert.equal(thumb().getAttribute('data-motion'), 'static')
      assert.ok(previewImg(), f.name)
      assert.equal(posterImg(), null)
    }
    assert.equal(m.stats.fetched.length, 0, 'ภาพนิ่งไม่ผ่านการ fetch/ถอดบิตแมป')
    assert.equal(m.stats.bitmaps, 0)
  } finally { await m.unmount() }
})

test('R10-GIF-10 · Vault GIF gets neither poster nor animation', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif({ vault: true })))
    assert.equal(thumb().getAttribute('data-thumb'), 'icon')
    assert.match(thumb().className, /hatch/)
    await hover(m)()
    assert.equal(document.querySelector('img'), null)
    assert.equal(m.stats.fetched.length, 0)
  } finally { await m.unmount() }
})

/* ══ CORRECTION B — drop selected items on the root breadcrumb ═════════════ */

/**
 * จอ Files จริงบน jsdom: ราก = โฟลเดอร์ 01 + ไฟล์ X; ในโฟลเดอร์ 01 = A, B, C, D
 * fetch ถูกแทน: GET ตอบตาม parentId, POST /api/files/move บันทึกคำขอและตอบตามที่ตั้งไว้
 */
async function mountFilesScreen(m, { moveStatus = 200, moveDelayMs = 0 } = {}) {
  const A = image({ id: 'A', name: 'a.jpg', parentId: 'd1' })
  const B = fileItem({ id: 'B', name: 'b.pdf', parentId: 'd1' })
  const C = fileItem({ id: 'C', name: 'c.pdf', parentId: 'd1' })
  const D = fileItem({ id: 'D', name: 'd.pdf', parentId: 'd1' })
  const state = { root: [folderItem(), fileItem({ id: 'X', name: 'x.pdf' })], inFolder: [A, B, C, D], gets: [], moves: [], moveStatus }
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body })
  const W = m.W
  globalThis.fetch = W.fetch = async (url, init = {}) => {
    const u = String(url)
    if (u.includes('/api/files/move') && init.method === 'POST') {
      const body = JSON.parse(init.body)
      state.moves.push(body)
      if (moveDelayMs) await sleep(moveDelayMs)
      if (state.moveStatus !== 200) return json(state.moveStatus, { error: 'refused', code: 'NAME_TAKEN' })
      // ย้ายจริงในชุดข้อมูลจำลอง
      const moved = state.inFolder.filter((f) => body.ids.includes(f.id))
      state.inFolder = state.inFolder.filter((f) => !body.ids.includes(f.id))
      if (body.parentId === null) state.root = [...state.root, ...moved.map((f) => ({ ...f, parentId: null }))]
      return json(200, { moved: moved.length })
    }
    if (/\/api\/files(\?|$)/.test(u) && (!init.method || init.method === 'GET')) {
      const parent = new URL(u, 'http://x').searchParams.get('parentId')
      state.gets.push(parent)
      if (parent === 'd1') return json(200, { files: state.inFolder, ancestors: [{ id: 'd1', name: '01' }] })
      return json(200, { files: state.root, ancestors: [] })
    }
    return json(404, { error: 'unexpected ' + u })
  }
  await m.render(React.createElement(files.Files, { t, lang: 'en', go: noop, userId: '2' }))
  await act(async () => { await sleep(30) })
  const rootCrumb = () => [...document.querySelectorAll('nav[aria-label="' + t('breadcrumb') + '"] button')].find((b) => b.textContent.trim() === t('filesTitle'))
  const tileOf = (id) => document.querySelector(`[data-file-id="${id}"]`)
  const checkbox = (id) => tileOf(id).querySelector('[role="checkbox"]')
  const selectedCount = () => document.querySelectorAll('[data-file-kind] [role="checkbox"][aria-checked="true"]').length
  const enterFolder = async () => { await m.mouse(tileOf('d1'), 'click'); await act(async () => { await sleep(30) }) }
  const atRoot = () => rootCrumb().getAttribute('aria-current') === 'page'
  return { state, rootCrumb, tileOf, checkbox, selectedCount, enterFolder, atRoot }
}

test('R10-ROOTDROP-1/2/3/4 · inside a folder, dragging a selected item onto "Files" highlights it, moves the whole selection to root and navigates there', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m)
    await s.enterFolder()
    assert.equal(s.atRoot(), false)
    assert.ok(s.tileOf('A') && s.tileOf('D'))
    for (const id of ['A', 'B', 'C']) await m.mouse(s.checkbox(id), 'click')
    assert.equal(s.selectedCount(), 3)

    const dt = internalTransfer()
    await m.drag(s.tileOf('B'), 'dragstart', dt)      // ลาก B ที่อยู่ในชุดที่เลือก → payload = A,B,C
    assert.deepEqual(JSON.parse(dt.getData(AEGIS_ITEMS_TYPE)).sort(), ['A', 'B', 'C'])
    await m.drag(s.rootCrumb(), 'dragover', dt)
    assert.equal(s.rootCrumb().getAttribute('data-drop-target'), 'yes', 'breadcrumb ราก ต้องสว่างเป็นเป้าวาง')
    await m.drag(s.rootCrumb(), 'drop', dt)
    await act(async () => { await sleep(60) })
    assert.equal(s.state.moves.length, 1)
    assert.deepEqual([...s.state.moves[0].ids].sort(), ['A', 'B', 'C'])
    assert.equal(s.state.moves[0].parentId, null, 'ต้องเป็น moveItems(ids, null) — เส้นทางเดิม')
    assert.equal(s.rootCrumb().getAttribute('data-drop-target'), null, 'ไฮไลต์ต้องหายหลังวาง')
    assert.equal(s.atRoot(), true, 'สำเร็จแล้วต้องพาไปที่ราก')
    assert.equal(s.state.gets.at(-1), null, 'ต้องดึงรายการรากใหม่')
    assert.ok(s.tileOf('A') && s.tileOf('B') && s.tileOf('C'), 'ไฟล์ที่ย้ายต้องเห็นที่ราก')
    assert.equal(s.selectedCount(), 0, 'การเลือกถูกล้างตามความหมายเดิมของ Move ที่สำเร็จ')
  } finally { await m.unmount() }
})

test('R10-ROOTDROP-5 · dragging an unselected item moves only that item; the selection is untouched until success', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m, { moveDelayMs: 80 })
    await s.enterFolder()
    await m.mouse(s.checkbox('A'), 'click')
    await m.mouse(s.checkbox('B'), 'click')
    const dt = internalTransfer()
    await m.drag(s.tileOf('D'), 'dragstart', dt)
    assert.deepEqual(JSON.parse(dt.getData(AEGIS_ITEMS_TYPE)), ['D'])
    await m.drag(s.rootCrumb(), 'dragover', dt)
    await m.drag(s.rootCrumb(), 'drop', dt)
    await act(async () => { await sleep(20) })                 // คำขอยังค้าง
    assert.equal(s.selectedCount(), 2, 'ก่อนสำเร็จ A+B ยังถูกเลือกอยู่')
    assert.equal(s.atRoot(), false, 'ก่อนสำเร็จยังอยู่ในโฟลเดอร์')
    await act(async () => { await sleep(120) })
    assert.deepEqual(s.state.moves.map((x) => x.ids), [['D']])
    assert.equal(s.atRoot(), true)
  } finally { await m.unmount() }
})

test('R10-ROOTDROP-6 · an external OS file drag over the breadcrumb never becomes a move', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m)
    await s.enterFolder()
    await m.mouse(s.checkbox('A'), 'click')
    const dt = externalTransfer()
    await m.drag(s.rootCrumb(), 'dragover', dt)
    assert.equal(s.rootCrumb().getAttribute('data-drop-target'), null)
    await m.drag(s.rootCrumb(), 'drop', dt)
    await act(async () => { await sleep(30) })
    assert.equal(s.state.moves.length, 0)
    assert.equal(s.atRoot(), false)
  } finally { await m.unmount() }
})

test('R10-ROOTDROP-7 · at root the "Files" breadcrumb is not an internal drop target', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m)
    assert.equal(s.atRoot(), true)
    await m.mouse(s.checkbox('X'), 'click')
    const dt = internalTransfer()
    await m.drag(s.tileOf('X'), 'dragstart', dt)
    await m.drag(s.rootCrumb(), 'dragover', dt)
    assert.equal(s.rootCrumb().getAttribute('data-drop-target'), null)
    await m.drag(s.rootCrumb(), 'drop', dt)
    await act(async () => { await sleep(30) })
    assert.equal(s.state.moves.length, 0, 'ห้ามยิง ALREADY_THERE ที่ไม่มีความหมาย')
  } finally { await m.unmount() }
})

test('R10-ROOTDROP-8 · drag leave (or drag end) clears the highlight without moving anything', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m)
    await s.enterFolder()
    const dt = internalTransfer()
    await m.drag(s.tileOf('A'), 'dragstart', dt)
    await m.drag(s.rootCrumb(), 'dragover', dt)
    assert.equal(s.rootCrumb().getAttribute('data-drop-target'), 'yes')
    await m.drag(s.rootCrumb(), 'dragleave', dt)
    assert.equal(s.rootCrumb().getAttribute('data-drop-target'), null)
    await m.drag(s.rootCrumb(), 'dragover', dt)
    await m.drag(s.tileOf('A'), 'dragend', dt)
    assert.equal(s.rootCrumb().getAttribute('data-drop-target'), null, 'dragend ยกเลิกไฮไลต์')
    assert.equal(s.state.moves.length, 0)
  } finally { await m.unmount() }
})

test('R10-ROOTDROP-9 · a failed move stays in the current folder and does not refetch root', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m, { moveStatus: 409 })
    await s.enterFolder()
    const getsBefore = s.state.gets.length
    const dt = internalTransfer()
    await m.drag(s.tileOf('A'), 'dragstart', dt)
    await m.drag(s.rootCrumb(), 'dragover', dt)
    await m.drag(s.rootCrumb(), 'drop', dt)
    await act(async () => { await sleep(60) })
    assert.equal(s.state.moves.length, 1)
    assert.equal(s.atRoot(), false, 'ล้มเหลวต้องไม่พาไปราก')
    assert.ok(s.tileOf('A'), 'ยังเห็นรายการของโฟลเดอร์เดิม')
    assert.ok(!s.state.gets.slice(getsBefore).includes(null), 'ต้องไม่ดึงรายการรากหลังล้มเหลว')
    assert.equal(s.rootCrumb().getAttribute('data-drop-target'), null)
  } finally { await m.unmount() }
})

test('R10-ROOTDROP-10 · a plain click on "Files" still navigates to root', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m)
    await s.enterFolder()
    assert.equal(s.atRoot(), false)
    await m.mouse(s.rootCrumb(), 'click')
    await act(async () => { await sleep(30) })
    assert.equal(s.atRoot(), true)
    assert.equal(s.state.moves.length, 0)
  } finally { await m.unmount() }
})

test('R10-ROOTDROP-11 · dropping onto a folder tile still moves into that folder (unchanged)', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m)
    const dt = internalTransfer()
    await m.drag(s.tileOf('X'), 'dragstart', dt)
    await m.drag(s.tileOf('d1'), 'dragover', dt)
    assert.equal(s.tileOf('d1').getAttribute('data-drop-target'), 'yes')
    await m.drag(s.tileOf('d1'), 'drop', dt)
    await act(async () => { await sleep(40) })
    assert.deepEqual(s.state.moves, [{ ids: ['X'], parentId: 'd1' }])
    assert.equal(s.atRoot(), true, 'วางลงโฟลเดอร์ไม่พาไปไหน')
  } finally { await m.unmount() }
})

test('R10-ROOTDROP-12 · the Move dialog "All files" path still moves to root through the same call', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m)
    await s.enterFolder()
    const menuBtn = s.tileOf('A').querySelector('button[aria-haspopup="menu"]')
    await m.mouse(menuBtn, 'click')
    const moveItem = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find((b) => b.textContent.trim() === t('move'))
    await m.mouse(moveItem, 'click')
    const toRoot = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === t('moveToRoot'))
    assert.ok(toRoot, 'กล่อง Move ต้องมี "All files"')
    await m.mouse(toRoot, 'click')
    await act(async () => { await sleep(40) })
    assert.deepEqual(s.state.moves, [{ ids: ['A'], parentId: null }])
    assert.equal(s.atRoot(), false, 'กล่อง Move เดิมไม่เปลี่ยนตำแหน่ง — พฤติกรรมเดิม')
  } finally { await m.unmount() }
})
/* ══ Round 10 · review correction 1 ════════════════════════════════════════ */

const ACCEPTANCE_GIF_BYTES = 49_700_000 // ไฟล์ GIF จริงที่ Human Owner ใช้ยอมรับบน Production (~49.7 MB)

test('R10-SR1-A · the real ~49.7 MB acceptance GIF is eligible for a static poster and gets one when decode succeeds', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif({ size: ACCEPTANCE_GIF_BYTES })))
    assert.equal(thumb().getAttribute('data-thumb'), 'gif-poster', 'ห้ามตกไปเป็นไอคอนเพียงเพราะขนาด 49.7 MB')
    assert.ok(posterImg())
    assert.equal(m.stats.bitmaps, 1)
    assert.ok(m.stats.fetched.some((u) => u.endsWith('/api/files/g1/preview')))
  } finally { await m.unmount() }
})

test('R10-SR1-B · a GIF above the poster ceiling still falls back truthfully; one exactly at the ceiling is decoded', async () => {
  const { GIF_POSTER_MAX_BYTES } = await vite.ssrLoadModule('/src/lib/gifPoster.js')
  assert.ok(GIF_POSTER_MAX_BYTES >= ACCEPTANCE_GIF_BYTES, `เพดาน poster (${GIF_POSTER_MAX_BYTES}) ต้องครอบไฟล์ยอมรับจริง`)
  const m = await mountRoot()
  try {
    await m.render(tile(gif({ id: 'over', name: 'over.gif', size: GIF_POSTER_MAX_BYTES + 1 })))
    assert.equal(thumb().getAttribute('data-thumb'), 'gif-static', 'เกินเพดาน → ไอคอน + ป้าย GIF')
    assert.equal(m.stats.fetched.length, 0, 'เกินเพดานต้องไม่ดึงทรัพยากรเลย')
    assert.equal(m.stats.bitmaps, 0)
    await hover(m)()
    assert.ok(previewImg(), 'ชี้แล้วยังเล่น GIF จริงได้ — เพดานเป็นเรื่องของ poster ตอน idle เท่านั้น')
    await leave(m)()
    await m.render(tile(gif({ id: 'at', name: 'at.gif', size: GIF_POSTER_MAX_BYTES })))
    assert.equal(thumb().getAttribute('data-thumb'), 'gif-poster')
    assert.equal(m.stats.bitmaps, 1)
  } finally { await m.unmount() }
})

test('R10-SR1-C · the poster ceiling is a preview-only bound: no upload/transfer limit references it', async () => {
  const fs = await import('node:fs/promises')
  const { GIF_POSTER_MAX_BYTES } = await vite.ssrLoadModule('/src/lib/gifPoster.js')
  const read = (rel) => fs.readFile(new URL(`../${rel}`, import.meta.url), 'utf8')
  for (const rel of ['server/config/transferLimits.js', 'server/storage/fileStore.js', 'server/routes/uploads.js', 'src/lib/chunkedUpload.js', 'src/components/UploadDrawer.jsx']) {
    const src = await read(rel)
    assert.doesNotMatch(src, /GIF_POSTER|gifPoster/, `${rel} ต้องไม่รู้จักเพดาน poster`)
  }
  const limits = await read('server/config/transferLimits.js')
  assert.doesNotMatch(limits, new RegExp(String(GIF_POSTER_MAX_BYTES)), 'ตัวเลขเพดาน poster ต้องไม่ปรากฏในเพดานอัปโหลด')
  const { TRANSFER_LIMITS } = await import('../server/config/transferLimits.js')
  assert.ok(TRANSFER_LIMITS.maxLogicalBytes ?? TRANSFER_LIMITS.maxFileBytes ?? Object.values(TRANSFER_LIMITS).some((v) => typeof v === 'number'), 'เพดานอัปโหลดยังมีอยู่ตามเดิม')
})

test('R10-SR1-D · object URL / bitmap / canvas cleanup still holds for the large acceptance case', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif({ size: ACCEPTANCE_GIF_BYTES })))
    await m.render(tile(gif({ id: 'g2', name: 'b.gif', size: ACCEPTANCE_GIF_BYTES })))
    assert.equal(m.stats.created, 2)
    assert.equal(m.stats.revoked, 1)
    await act(async () => m.root.unmount())
    assert.equal(m.stats.revoked, m.stats.created)
    assert.equal(m.stats.closed, m.stats.bitmaps)
    m.env.restore(); m.unmount = async () => {}
  } finally { await m.unmount() }
})

test('R10-SR2-A..E · a 409 on root-breadcrumb drop stays in the folder, keeps the selection, clears the highlight and shows a visible mapped error', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m, { moveStatus: 409 })
    await s.enterFolder()
    await m.mouse(s.checkbox('A'), 'click')
    await m.mouse(s.checkbox('B'), 'click')
    const getsBefore = s.state.gets.length
    const dt = internalTransfer()
    await m.drag(s.tileOf('A'), 'dragstart', dt)
    await m.drag(s.rootCrumb(), 'dragover', dt)
    await m.drag(s.rootCrumb(), 'drop', dt)
    await act(async () => { await sleep(60) })
    assert.equal(s.state.moves.length, 1, 'A: มีคำขอ move หนึ่งครั้งที่ถูกปฏิเสธ 409')
    assert.equal(s.atRoot(), false, 'B: ยังอยู่ในโฟลเดอร์เดิม')
    assert.ok(!s.state.gets.slice(getsBefore).includes(null), 'C: ไม่ดึงราก/ไม่นำทาง')
    assert.equal(s.rootCrumb().getAttribute('data-drop-target'), null, 'ไฮไลต์หาย')
    assert.equal(s.selectedCount(), 2, 'รายการที่พยายามย้ายยังถูกเลือกอยู่ — แสดงสถานะตามจริง')
    const alert = [...document.querySelectorAll('[role="alert"]')].find((el) => !el.closest('[role="dialog"]'))
    assert.ok(alert, 'D: ต้องมีข้อความผิดพลาดที่มองเห็นได้นอก modal')
    assert.equal(alert.textContent.trim(), t('nameTaken'), 'E: ข้อความมาจาก errorKeyFor (NAME_TAKEN → nameTaken)')
    assert.equal(document.querySelector('[role="dialog"]'), null, 'ไม่เปิดกล่อง Move เพียงเพื่อโชว์ error')
  } finally { await m.unmount() }
})

test('R10-SR2-F · the next successful move clears the stale drop error', async () => {
  const m = await mountRoot()
  try {
    const s = await mountFilesScreen(m, { moveStatus: 409 })
    await s.enterFolder()
    const dt = internalTransfer()
    await m.drag(s.tileOf('A'), 'dragstart', dt)
    await m.drag(s.rootCrumb(), 'dragover', dt)
    await m.drag(s.rootCrumb(), 'drop', dt)
    await act(async () => { await sleep(60) })
    assert.ok([...document.querySelectorAll('[role="alert"]')].some((el) => !el.closest('[role="dialog"]')))
    // เซิร์ฟเวอร์ยอมรับครั้งถัดไป
    s.state.moveStatus = 200
    const dt2 = internalTransfer()
    await m.drag(s.tileOf('B'), 'dragstart', dt2)
    await m.drag(s.rootCrumb(), 'dragover', dt2)
    await m.drag(s.rootCrumb(), 'drop', dt2)
    await act(async () => { await sleep(80) })
    assert.equal(s.atRoot(), true)
    assert.equal([...document.querySelectorAll('[role="alert"]')].filter((el) => !el.closest('[role="dialog"]')).length, 0, 'สำเร็จแล้ว error เก่าต้องหาย')
  } finally { await m.unmount() }
})
