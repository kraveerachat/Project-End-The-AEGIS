// tests/filesRound10.test.js — FILES-MANAGEMENT-UX-1 · Round 10 (final browser corrections)
//
//   A. การ์ด GIF ตอนไม่ชี้ต้องแสดง "ภาพจริงแบบนิ่ง" — Tranche B: poster derivative จากเซิร์ฟเวอร์ (media-info)
//      ไม่ใช่ไอคอนทั่วไป ไม่ใช่ GIF ที่เคลื่อนไหวซ่อนอยู่หลัง overlay และไม่ดึงต้นฉบับ (/preview) เข้ากริดเลย
//   B. ลากรายการที่เลือกไปวางบน breadcrumb "Files" (ราก) ขณะอยู่ในโฟลเดอร์ = ย้ายกลับราก
//      ผ่านเส้นทาง Move เดิม (moveItems(ids, null)) แล้วพาไปที่ราก
//
// ⚠️ jsdom ไม่มี IntersectionObserver / DataTransfer และไม่ดึงทรัพยากรของ <img>/<video> — ทดสอบด้วยการ stub
//    fetch (media-info batch) แล้วนับ "คำขอไหนถูกยิง" และ "DOM ที่ผู้ใช้เห็น"; ไม่มี observer = scheduler ถือว่าไทล์มองเห็น
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
const image = (over = {}) => fileItem({ id: 'img1', name: 'photo.jpg', type: 'Image', ext: 'jpg', sha256: 'b'.repeat(64), ...over })
const noop = () => {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── jsdom + browser primitive stubs ───────────────────────────────────────── */
const SHA_A = 'a'.repeat(64)
const infoFor = (id, mode) => {
  if (mode === 'failed') return { id, status: 'GENERATION_FAILED', reason: 'DECODE_FAILED', poster: { state: 'GENERATION_FAILED', url: null }, motion: { state: 'GENERATION_FAILED', url: null } }
  const animated = mode === 'animated'
  return {
    id, sourceVersion: SHA_A, profile: 'v1', family: animated ? 'gif' : 'png', animated, status: 'READY',
    poster: { state: 'READY', url: `/api/files/${id}/poster?v=${SHA_A}&p=v1`, mime: 'image/webp' },
    motion: animated ? { state: 'READY', url: `/api/files/${id}/motion-preview?v=${SHA_A}&p=v1` } : { state: 'UNSUPPORTED', reason: 'NOT_ANIMATED', url: null },
  }
}
function installDom({ reducedMotion = false, media = 'animated' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  w.matchMedia = (q) => ({ matches: reducedMotion && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} })
  const stats = { fetched: [], media }
  const previous = new Map()
  const globals = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url, opts = {}) => {
      const u = String(url)
      stats.fetched.push(u)
      if (u.endsWith('/api/files/media-info/batch')) {
        const items = {}
        for (const id of JSON.parse(opts.body).ids) items[id] = infoFor(id, stats.media)
        return { ok: true, status: 200, json: async () => ({ items }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    },
  }
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  // jsdom ไม่ implement play/pause — บันทึกการเรียก
  const proto = w.HTMLMediaElement.prototype
  proto.play = function () { stats.plays = (stats.plays ?? 0) + 1; return Promise.resolve() }
  proto.pause = function () { stats.pauses = (stats.pauses ?? 0) + 1 }
  return {
    dom, stats,
    restore() {
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
const previewImg = () => document.querySelector('img[src*="/preview"], video[src*="/preview"]')
const posterImg = () => document.querySelector('img[src*="/poster?"]')
const motionVideo = () => document.querySelector('video[src*="/motion-preview?"]')
const fire = (node, type) => act(async () => { node.dispatchEvent(new node.ownerDocument.defaultView.Event(type, { bubbles: false })); await sleep(5) })
/** โหลด poster ให้เสร็จ (jsdom ไม่ดึงภาพจริง) */
const loadPoster = async () => { const p = posterImg(); assert.ok(p, 'poster <img> from media-info'); await fire(p, 'load') }
const gif = (over = {}) => fileItem({ id: 'g1', name: 'loop.gif', type: 'Image', ext: 'gif', sha256: SHA_A, ...over })
const hover = (m) => async () => { const c = document.querySelector('[data-file-kind]'); await m.mouse(c, 'mouseover'); await m.mouse(c, 'mouseenter') }
const leave = (m) => async () => { const c = document.querySelector('[data-file-kind]'); await m.mouse(c, 'mouseout'); await m.mouse(c, 'mouseleave') }

/* ══ CORRECTION A — GIF static poster ══════════════════════════════════════ */

test('R10-GIF-1 · idle GIF shows a real static poster (server derivative), not the generic icon', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    await loadPoster()
    assert.equal(thumb().getAttribute('data-thumb'), 'poster')
    assert.equal(thumb().getAttribute('data-poster'), 'shown')
    assert.notEqual(thumb().getAttribute('data-motion'), 'playing')
    assert.equal(posterImg().getAttribute('src'), `/api/files/g1/poster?v=${SHA_A}&p=v1`)
    assert.ok(m.stats.fetched.some((u) => u.endsWith('/api/files/media-info/batch')), 'poster URL มาจาก media-info ของไฟล์นี้')
    assert.ok(!m.stats.fetched.some((u) => u.includes('/preview')), 'ไม่ดึงต้นฉบับเข้ากริด')
  } finally { await m.unmount() }
})

test('R10-GIF-2 · the idle thumbnail is never the live animated GIF <img>', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    await loadPoster()
    assert.equal(previewImg(), null, 'idle ต้องไม่มี <img src=…/preview> ที่เคลื่อนไหว')
    assert.equal(document.querySelectorAll('img').length, 1, 'มีภาพเดียวคือ poster — ไม่มี GIF ซ่อนอยู่หลัง overlay')
    assert.ok(!document.querySelector('img').getAttribute('src').endsWith('.gif'))
  } finally { await m.unmount() }
})

test('R10-GIF-3 · hover plays the motion proxy (not the original GIF); R10-GIF-4 · leave restores the static poster', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    await loadPoster()
    const v = motionVideo()
    assert.ok(v, 'ไทล์ที่มองเห็นและเคลื่อนไหวได้ prefetch proxy (ทึบ) ไว้')
    await fire(v, 'canplaythrough')
    await hover(m)()
    assert.equal(previewImg(), null, 'ชี้แล้วก็ยังไม่มีต้นฉบับ')
    assert.equal(thumb().getAttribute('data-thumb'), 'motion')
    assert.equal(thumb().getAttribute('data-motion'), 'playing')
    assert.equal(m.stats.plays, 1)
    const poster = posterImg()
    await leave(m)()
    assert.equal(thumb().getAttribute('data-thumb'), 'poster')
    assert.equal(thumb().getAttribute('data-motion'), 'ready')
    assert.equal(m.stats.pauses, 1)
    assert.equal(posterImg(), poster, 'poster เดิม ไม่ถูกถอด/สร้างใหม่ทุกครั้งที่ชี้/ออก')
  } finally { await m.unmount() }
})

test('R10-GIF-5 · reduced motion keeps the static poster and never mounts the animation on hover', async () => {
  const m = await mountRoot({ reducedMotion: true })
  try {
    await m.render(tile(gif()))
    await loadPoster()
    assert.equal(thumb().getAttribute('data-thumb'), 'poster')
    await hover(m)()
    assert.equal(previewImg(), null)
    assert.equal(motionVideo(), null, 'reduced motion: ไม่ prefetch proxy ด้วยซ้ำ')
    assert.ok(posterImg())
    assert.equal(thumb().getAttribute('data-motion'), 'none')
    assert.equal(m.stats.plays ?? 0, 0)
  } finally { await m.unmount() }
})

test('R10-GIF-6 · a change of content identity (sha) requests a new poster; a rename keeps the old one', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    await loadPoster()
    const first = posterImg().getAttribute('src')
    const batches = () => m.stats.fetched.filter((u) => u.endsWith('/media-info/batch')).length
    const n = batches()
    await m.render(tile(gif({ name: 'other.gif', modified: NOW + 1 })))
    assert.equal(posterImg().getAttribute('src'), first, 'เปลี่ยนชื่อ = ตัวตนเดิม = poster เดิม')
    assert.equal(batches(), n)
    await m.render(tile(gif({ id: 'g2', name: 'other.gif', sha256: 'c'.repeat(64) })))
    assert.notEqual(thumb().getAttribute('data-poster'), 'shown', 'เนื้อหาใหม่ = poster เก่าถูกทิ้ง (ไอคอน/กำลังโหลด) จนกว่า derivative ใหม่จะโหลดเสร็จ')
    await loadPoster()
    assert.notEqual(posterImg().getAttribute('src'), first)
    assert.equal(batches(), n + 1)
  } finally { await m.unmount() }
})

test('R10-GIF-7 · a GIF the server cannot decode falls back to the truthful icon, with no broken-image element', async () => {
  const m = await mountRoot({ media: 'failed' })
  try {
    await m.render(tile(gif()))
    assert.equal(thumb().getAttribute('data-thumb'), 'icon')
    assert.equal(thumb().getAttribute('data-info'), 'failed')
    assert.ok(thumb().querySelector('svg'))
    assert.ok(thumb().textContent.includes('GIF'), 'ป้าย GIF บอกความจริง')
    assert.equal(document.querySelector('img'), null, 'ห้ามมี <img> ที่พังค้างอยู่')
    // ชี้แล้วก็ไม่ดึงต้นฉบับมาเล่น — การล้มเหลวของ derivative ไม่ใช่ใบอนุญาตให้ดึง GIF จริงเข้ากริด
    await hover(m)()
    assert.equal(previewImg(), null)
    assert.equal(motionVideo(), null)
  } finally { await m.unmount() }
})

test('R10-GIF-8 · unmount stops every media request and leaves no media element behind', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    await loadPoster()
    await m.render(tile(gif({ id: 'g2', name: 'b.gif', sha256: 'c'.repeat(64) })))
    await loadPoster()
    const n = m.stats.fetched.length
    await act(async () => m.root.unmount())
    await sleep(40)
    assert.equal(document.querySelector('img, video'), null)
    assert.equal(m.stats.fetched.length, n, 'หลัง unmount ไม่มีคำขอเพิ่ม')
    m.env.restore(); m.unmount = async () => {}
  } finally { await m.unmount() }
})

test('R10-GIF-9 · static formats also come from the server poster: no browser pipeline, never the preview route', async () => {
  const m = await mountRoot({ media: 'still' })
  try {
    for (const f of [image(), image({ id: 'p', name: 'p.png', ext: 'png' }), image({ id: 'w', name: 'w.webp', ext: 'webp' })]) {
      await m.render(tile(f))
      await loadPoster()
      assert.equal(thumb().getAttribute('data-thumb'), 'poster', f.name)
      assert.equal(thumb().getAttribute('data-motion'), 'none')
      assert.equal(previewImg(), null, f.name)
      assert.equal(motionVideo(), null, 'ภาพนิ่งไม่มี motion proxy')
    }
    assert.ok(!m.stats.fetched.some((u) => u.includes('/preview')))
  } finally { await m.unmount() }
})

test('R10-GIF-10 · Vault GIF gets neither poster nor animation', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif({ vault: true })))
    assert.equal(thumb().getAttribute('data-thumb'), 'icon')
    assert.match(thumb().className, /hatch/)
    await hover(m)()
    assert.equal(document.querySelector('img, video'), null)
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

test('R10-SR1-A · the real ~49.7 MB acceptance GIF: size gates nothing — the tile asks media-info and shows the poster when READY', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif({ size: ACCEPTANCE_GIF_BYTES })))
    await loadPoster()
    assert.equal(thumb().getAttribute('data-thumb'), 'poster', 'ห้ามตกไปเป็นไอคอนเพียงเพราะขนาด 49.7 MB')
    assert.ok(m.stats.fetched.some((u) => u.endsWith('/media-info/batch')))
    assert.ok(!m.stats.fetched.some((u) => u.includes('/preview')), 'ไม่มีการดึงไบต์ต้นฉบับ 49.7 MB เข้าเบราว์เซอร์')
  } finally { await m.unmount() }
})

test('R10-SR1-B · there is no client-side poster ceiling any more: a 200 MB gif still asks the server; the server decides truthfully', async () => {
  await assert.rejects(vite.ssrLoadModule('/src/lib/gifPoster.js'), 'browser GIF poster module removed')
  const m = await mountRoot({ media: 'failed' })
  try {
    await m.render(tile(gif({ id: 'over', name: 'over.gif', size: 200 * 1024 * 1024 })))
    assert.ok(m.stats.fetched.some((u) => u.endsWith('/media-info/batch')), 'ขนาดไม่ใช่เหตุผลที่จะไม่ถาม')
    assert.equal(thumb().getAttribute('data-thumb'), 'icon', 'เซิร์ฟเวอร์ตอบล้มเหลว → ไอคอน + ป้าย GIF')
    await hover(m)()
    assert.equal(previewImg(), null, 'ชี้แล้วก็ไม่ดึงต้นฉบับ 200 MB')
  } finally { await m.unmount() }
})

test('R10-SR1-C · media derivative code is preview-only: no upload/transfer limit references it', async () => {
  const fs = await import('node:fs/promises')
  const read = (rel) => fs.readFile(new URL(`../${rel}`, import.meta.url), 'utf8')
  for (const rel of ['server/config/transferLimits.js', 'server/storage/fileStore.js', 'server/routes/uploads.js', 'src/lib/chunkedUpload.js', 'src/components/UploadDrawer.jsx']) {
    const src = await read(rel)
    assert.doesNotMatch(src, /GIF_POSTER|gifPoster|mediaLimits|MEDIA_|posterMaxBytes/, `${rel} ต้องไม่รู้จักเพดานของ derivative`)
  }
  const { TRANSFER_LIMITS } = await import('../server/config/transferLimits.js')
  assert.ok(TRANSFER_LIMITS.maxLogicalBytes ?? TRANSFER_LIMITS.maxFileBytes ?? Object.values(TRANSFER_LIMITS).some((v) => typeof v === 'number'), 'เพดานอัปโหลดยังมีอยู่ตามเดิม')
})

test('R10-SR1-D · cleanup still holds for the large acceptance case: no element or request survives unmount', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif({ size: ACCEPTANCE_GIF_BYTES })))
    await loadPoster()
    await m.render(tile(gif({ id: 'g2', name: 'b.gif', size: ACCEPTANCE_GIF_BYTES, sha256: 'c'.repeat(64) })))
    await loadPoster()
    const n = m.stats.fetched.length
    await act(async () => m.root.unmount())
    await sleep(40)
    assert.equal(document.querySelector('img, video'), null)
    assert.equal(m.stats.fetched.length, n)
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
