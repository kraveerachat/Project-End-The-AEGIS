// tests/filesInteractionPolish.test.js — FILES-MANAGEMENT-UX-1 · Round 9
//
// สามสิ่งที่ Human Owner ขอหลังยอมรับ Round 8 บน Production:
//   A. ลากกรอบเลือก (marquee) บนพื้นที่ว่างของกริด — เหมือน Google Drive / file manager
//   B. สื่อที่เคลื่อนไหว (GIF / วิดีโอ) ต้อง "นิ่ง" ตอนหน้าอยู่เฉย ๆ และขยับเฉพาะตอนชี้
//   C. เมนูเรียงที่บอกทิศทางชัดเจน + เรียงตามวันอัปโหลด (created_at จริงจากฐานข้อมูล)
//
// ⚠️ การทดสอบที่นี่ต้องแตะ DOM จริง (jsdom): marquee เป็นเรื่องของเรขาคณิตกับลำดับเหตุการณ์
//    การทดสอบแค่ helper จะพิสูจน์ไม่ได้ว่า "กดบนการ์ดแล้วไม่เริ่มลากกรอบ" หรือ "ปล่อยเมาส์
//    แล้ว listener บน window ถูกถอดจริง"
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { LANGS, STRINGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')

let vite
let files
let view

before(async () => {
  vite = await createServer({
    configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent',
    plugins: [reactPlugin()], server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] },
  })
  files = await vite.ssrLoadModule('/src/screens/Files.jsx')
  view = await vite.ssrLoadModule('/src/lib/filesView.js')
})
after(async () => { await vite?.close() })

/* ── fixtures ─────────────────────────────────────────────────────────────── */
const NOW = 1_800_000_000_000
const fileItem = (over = {}) => ({
  id: 'f1', name: 'report.pdf', kind: 'file', type: 'PDF', ext: 'pdf',
  size: 1024, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, ...over,
})
const folderItem = (over = {}) => ({
  id: 'd1', name: '01', kind: 'folder', type: 'Folder', ext: '',
  size: 0, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, ...over,
})
const image = (over = {}) => fileItem({ id: 'img1', name: 'photo.jpg', type: 'Image', ext: 'jpg', ...over })
const gif = (over = {}) => fileItem({ id: 'g1', name: 'loop.gif', type: 'Image', ext: 'gif', ...over })
const clip = (over = {}) => fileItem({ id: 'v1', name: 'clip.mp4', type: 'Video', ext: 'mp4', ...over })
const noop = () => {}

/* ── jsdom ────────────────────────────────────────────────────────────────── */
function installDom({ reducedMotion = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = new Map()
  const w = dom.window
  // ⚠️ jsdom ไม่มี matchMedia — useReducedMotion() ต้องการมัน
  w.matchMedia = (q) => ({ matches: reducedMotion && q.includes('prefers-reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} })
  const globals = { window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true }
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
      w.close()
    },
  }
}

async function mountRoot(opts) {
  const env = installDom(opts)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  const W = env.dom.window
  const render = (el) => act(async () => { root.render(el) })
  /** pointer events: jsdom ไม่มี PointerEvent — ใช้ MouseEvent ชื่อ pointer* ซึ่ง React รับได้ */
  const pointer = (node, type, init = {}) => act(async () => {
    const ev = new W.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
    Object.defineProperty(ev, 'pointerId', { value: init.pointerId ?? 1 })
    Object.defineProperty(ev, 'pointerType', { value: 'mouse' })
    node.dispatchEvent(ev)
  })
  const mouse = (node, type, init = {}) => act(async () => { node.dispatchEvent(new W.MouseEvent(type, { bubbles: true, cancelable: true, ...init })) })
  const key = (k, init = {}) => act(async () => { W.dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true, ...init })) })
  const plain = (node, type) => act(async () => { node.dispatchEvent(new W.Event(type, { bubbles: false })) })
  return { env, W, root, render, pointer, mouse, key, plain, unmount: async () => { await act(async () => root.unmount()); env.restore() } }
}

/** วาง "เรขาคณิต" ให้ canvas และไทล์: jsdom ไม่มี layout จึงต้อง stub getBoundingClientRect */
function layout(rects) {
  for (const [selector, r] of Object.entries(rects)) {
    const el = document.querySelector(selector)
    assert.ok(el, `layout: ${selector}`)
    el.getBoundingClientRect = () => ({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h, x: r.x, y: r.y })
  }
}

function sections({ folders = [], files: plain = [], selectedIds = new Set(), onSelectionChange = noop, onOpen = noop, onDragStartItem = noop, ...rest } = {}) {
  return React.createElement(files.FilesSections, {
    t, now: NOW, view: 'grid', folders, files: plain, selectedIds, draggingIds: [],
    onSelect: noop, onOpen, onMenuAction: noop, onDragStartItem, onDropItems: noop, tileRef: () => noop,
    onSelectionChange, ...rest,
  })
}

/** ไทล์ที่ถูกเลือกในกริด = checkbox aria-checked="true" */
const checkedIds = () => [...document.querySelectorAll('[data-file-kind] [role="checkbox"][aria-checked="true"]')]
  .map((cb) => cb.closest('[data-file-kind]').getAttribute('data-file-id'))

/** สภาพแวดล้อม marquee มาตรฐาน: โฟลเดอร์ 1 ใบ + ไฟล์ 3 ใบ วางเป็นตาราง */
async function marqueeScene(m, extra = {}) {
  const items = { folders: [folderItem()], files: [image(), fileItem({ id: 'f2', name: 'b.pdf' }), fileItem({ id: 'f3', name: 'c.pdf' })] }
  let selected = new Set(extra.initial ?? [])
  const history = []
  const rerender = () => m.render(sections({
    ...items, selectedIds: selected,
    onSelectionChange: (next) => { selected = new Set(next); history.push([...next]); rerender() },
    onOpen: extra.onOpen, onDragStartItem: extra.onDragStartItem,
  }))
  await rerender()
  layout({
    '[data-marquee-canvas]': { x: 0, y: 0, w: 1000, h: 800 },
    '[data-file-id="d1"]': { x: 20, y: 20, w: 180, h: 48 },
    '[data-file-id="img1"]': { x: 20, y: 120, w: 200, h: 180 },
    '[data-file-id="f2"]': { x: 260, y: 120, w: 200, h: 180 },
    '[data-file-id="f3"]': { x: 500, y: 120, w: 200, h: 180 },
  })
  return { get selected() { return selected }, history, canvas: () => document.querySelector('[data-marquee-canvas]'), rect: () => document.querySelector('[data-marquee-rect]') }
}

/* ══ R9-A marquee ══════════════════════════════════════════════════════════ */

test('R9-MARQUEE-1 · primary pointer down on blank canvas + drag past the threshold creates a marquee', async () => {
  const m = await mountRoot()
  try {
    const s = await marqueeScene(m)
    await m.pointer(s.canvas(), 'pointerdown', { clientX: 400, clientY: 400 })
    assert.equal(s.rect(), null, 'ยังไม่ขยับ = ยังไม่มีกรอบ')
    await m.pointer(window, 'pointermove', { clientX: 402, clientY: 401 })
    assert.equal(s.rect(), null, 'ขยับต่ำกว่า threshold ต้องยังไม่เป็น marquee (คลิกธรรมดา)')
    await m.pointer(window, 'pointermove', { clientX: 300, clientY: 250 })
    const r = s.rect()
    assert.ok(r, 'ลากเกิน threshold → มีกรอบ')
    assert.equal(r.style.left, '300px'); assert.equal(r.style.top, '250px')
    assert.equal(r.style.width, '100px'); assert.equal(r.style.height, '150px')
    assert.equal(r.getAttribute('aria-hidden'), 'true')
    assert.equal(s.canvas().style.userSelect, 'none', 'ห้ามเกิด text-selection ระหว่างลาก')
    await m.pointer(window, 'pointerup', { clientX: 300, clientY: 250 })
    assert.equal(s.rect(), null)
  } finally { await m.unmount() }
})

test('R9-MARQUEE-2 · the rectangle selects every file card it intersects', async () => {
  const m = await mountRoot()
  try {
    const s = await marqueeScene(m)
    await m.pointer(s.canvas(), 'pointerdown', { clientX: 700, clientY: 400 })
    await m.pointer(window, 'pointermove', { clientX: 250, clientY: 250 }) // ทับ f2, f3 (x 260–700) ไม่ทับ img1 (x 20–220)
    assert.deepEqual([...s.selected].sort(), ['f2', 'f3'])
    await m.pointer(window, 'pointermove', { clientX: 100, clientY: 250 }) // ขยายไปทับ img1 ด้วย
    assert.deepEqual([...s.selected].sort(), ['f2', 'f3', 'img1'])
    await m.pointer(window, 'pointerup', { clientX: 100, clientY: 250 })
    assert.deepEqual(checkedIds().sort(), ['f2', 'f3', 'img1'], 'การ์ดที่ถูกเลือกต้องแสดงสถานะเลือกจริง')
  } finally { await m.unmount() }
})

test('R9-MARQUEE-3 · one rectangle can span the Folders and Files sections', async () => {
  const m = await mountRoot()
  try {
    const s = await marqueeScene(m)
    await m.pointer(s.canvas(), 'pointerdown', { clientX: 10, clientY: 10 })
    await m.pointer(window, 'pointermove', { clientX: 120, clientY: 160 }) // ทับ d1 (y 20–68) และ img1 (y 120–300)
    assert.deepEqual([...s.selected].sort(), ['d1', 'img1'])
    await m.pointer(window, 'pointerup', { clientX: 120, clientY: 160 })
    assert.deepEqual([...s.selected].sort(), ['d1', 'img1'])
    // ลำดับส่วนไม่เปลี่ยน
    const html = document.body.innerHTML
    assert.ok(html.indexOf('data-files-section="folders"') < html.indexOf('data-files-section="files"'))
  } finally { await m.unmount() }
})

test('R9-MARQUEE-4 · pointer down on a card or folder tile never starts a marquee; item drag still works', async () => {
  const m = await mountRoot()
  try {
    const drags = []
    const s = await marqueeScene(m, { onDragStartItem: (ev, f) => drags.push(f.id) })
    for (const id of ['img1', 'd1']) {
      const tile = document.querySelector(`[data-file-id="${id}"]`)
      await m.pointer(tile, 'pointerdown', { clientX: 30, clientY: 30 })
      await m.pointer(window, 'pointermove', { clientX: 600, clientY: 600 })
      assert.equal(s.rect(), null, `${id}: กดบนไทล์ต้องไม่เกิดกรอบ`)
      await m.pointer(window, 'pointerup', { clientX: 600, clientY: 600 })
      assert.equal(s.selected.size, 0, `${id}: และต้องไม่เปลี่ยนการเลือก`)
    }
    // การลากรายการ (HTML5 drag) ยังเดินทางเดิม
    const tile = document.querySelector('[data-file-id="img1"]')
    assert.equal(tile.getAttribute('draggable'), 'true')
    await act(async () => { tile.dispatchEvent(new m.W.Event('dragstart', { bubbles: true })) })
    assert.deepEqual(drags, ['img1'])
  } finally { await m.unmount() }
})

test('R9-MARQUEE-5 · buttons, menus, inputs and checkboxes do not start a marquee; nor does a non-primary button', async () => {
  const m = await mountRoot()
  try {
    const s = await marqueeScene(m)
    const targets = [
      document.querySelector('[data-file-id="img1"] [role="checkbox"]'),
      document.querySelector('[data-file-id="img1"] button[aria-haspopup="menu"]'),
    ]
    for (const el of targets) {
      await m.pointer(el, 'pointerdown', { clientX: 30, clientY: 130 })
      await m.pointer(window, 'pointermove', { clientX: 900, clientY: 700 })
      assert.equal(s.rect(), null)
      await m.pointer(window, 'pointerup', { clientX: 900, clientY: 700 })
    }
    // ปุ่มขวา / กลาง บนพื้นที่ว่างก็ไม่เริ่ม
    for (const button of [1, 2]) {
      await m.pointer(s.canvas(), 'pointerdown', { clientX: 400, clientY: 400, button })
      await m.pointer(window, 'pointermove', { clientX: 100, clientY: 100 })
      assert.equal(s.rect(), null, `button ${button}`)
      await m.pointer(window, 'pointerup', { clientX: 100, clientY: 100, button })
    }
    assert.equal(s.selected.size, 0)
  } finally { await m.unmount() }
})

test('R9-MARQUEE-6 · a plain marquee replaces the previous selection', async () => {
  const m = await mountRoot()
  try {
    const s = await marqueeScene(m, { initial: ['d1'] })
    await m.pointer(s.canvas(), 'pointerdown', { clientX: 700, clientY: 400 })
    await m.pointer(window, 'pointermove', { clientX: 480, clientY: 250 }) // ทับ f3 เท่านั้น
    await m.pointer(window, 'pointerup', { clientX: 480, clientY: 250 })
    assert.deepEqual([...s.selected], ['f3'])
  } finally { await m.unmount() }
})

test('R9-MARQUEE-7 · Ctrl (Windows/Linux) or Cmd (macOS) makes the marquee additive', async () => {
  for (const mod of [{ ctrlKey: true }, { metaKey: true }]) {
    const m = await mountRoot()
    try {
      const s = await marqueeScene(m, { initial: ['d1'] })
      await m.pointer(s.canvas(), 'pointerdown', { clientX: 700, clientY: 400, ...mod })
      await m.pointer(window, 'pointermove', { clientX: 480, clientY: 250 })
      await m.pointer(window, 'pointerup', { clientX: 480, clientY: 250 })
      assert.deepEqual([...s.selected].sort(), ['d1', 'f3'], JSON.stringify(mod))
    } finally { await m.unmount() }
  }
})

test('R9-MARQUEE-8 · Escape cancels an active marquee and restores the pre-drag selection', async () => {
  const m = await mountRoot()
  try {
    const s = await marqueeScene(m, { initial: ['d1'] })
    await m.pointer(s.canvas(), 'pointerdown', { clientX: 700, clientY: 400 })
    await m.pointer(window, 'pointermove', { clientX: 250, clientY: 250 })
    assert.deepEqual([...s.selected].sort(), ['f2', 'f3'])
    assert.ok(s.rect())
    await m.key('Escape')
    assert.equal(s.rect(), null, 'กรอบต้องหาย')
    assert.deepEqual([...s.selected], ['d1'], 'การเลือกก่อนลากต้องกลับมา')
    // การขยับ/ปล่อยหลังยกเลิกต้องไม่ทำอะไรอีก
    await m.pointer(window, 'pointermove', { clientX: 100, clientY: 100 })
    await m.pointer(window, 'pointerup', { clientX: 100, clientY: 100 })
    assert.deepEqual([...s.selected], ['d1'])
    assert.equal(s.rect(), null)
  } finally { await m.unmount() }
})

test('R9-MARQUEE-9 · pointer up clears the rectangle but the selection persists', async () => {
  const m = await mountRoot()
  try {
    const s = await marqueeScene(m)
    await m.pointer(s.canvas(), 'pointerdown', { clientX: 700, clientY: 400 })
    await m.pointer(window, 'pointermove', { clientX: 250, clientY: 250 })
    await m.pointer(window, 'pointerup', { clientX: 250, clientY: 250 })
    assert.equal(s.rect(), null)
    assert.deepEqual([...s.selected].sort(), ['f2', 'f3'])
    assert.deepEqual(checkedIds().sort(), ['f2', 'f3'])
    // ลาก "ศูนย์" (คลิกเฉย ๆ บนพื้นที่ว่าง) ไม่เปลี่ยนการเลือก
    await m.pointer(s.canvas(), 'pointerdown', { clientX: 900, clientY: 700 })
    await m.pointer(window, 'pointerup', { clientX: 900, clientY: 700 })
    assert.deepEqual([...s.selected].sort(), ['f2', 'f3'])
  } finally { await m.unmount() }
})

test('R9-MARQUEE-10 · unmounting mid-drag removes every window listener the marquee added', async () => {
  const m = await mountRoot()
  try {
    const counts = {}
    const origAdd = m.W.addEventListener.bind(m.W)
    const origRemove = m.W.removeEventListener.bind(m.W)
    m.W.addEventListener = (type, ...rest) => { counts[type] = (counts[type] ?? 0) + 1; return origAdd(type, ...rest) }
    m.W.removeEventListener = (type, ...rest) => { counts[type] = (counts[type] ?? 0) - 1; return origRemove(type, ...rest) }
    const s = await marqueeScene(m)
    await m.pointer(s.canvas(), 'pointerdown', { clientX: 700, clientY: 400 })
    await m.pointer(window, 'pointermove', { clientX: 250, clientY: 250 })
    assert.ok(s.rect())
    assert.ok((counts.pointermove ?? 0) >= 1 && (counts.pointerup ?? 0) >= 1 && (counts.keydown ?? 0) >= 1, 'ระหว่างลากต้องมี listener บน window')
    await act(async () => m.root.unmount())
    for (const type of ['pointermove', 'pointerup', 'pointercancel', 'keydown']) {
      assert.equal(counts[type] ?? 0, 0, `listener ${type} ต้องถูกถอดครบหลัง unmount (เหลือ ${counts[type]})`)
    }
    m.W.addEventListener = origAdd; m.W.removeEventListener = origRemove
    m.env.restore()
    m.unmount = async () => {}
  } finally { await m.unmount() }
})

/* ══ R9-B motion only on hover ═════════════════════════════════════════════ */

function tile(file) {
  return React.createElement(files.FileTile, {
    t, file, now: NOW, selected: false, anySelected: false,
    onSelect: noop, onOpen: noop, onMenuAction: noop, tileRef: noop, dragActive: false,
  })
}
/** jsdom: HTMLMediaElement.play/pause ไม่ได้ implement — บันทึกการเรียกแทน */
function stubMedia(W) {
  const calls = []
  const proto = W.HTMLMediaElement.prototype
  const orig = { play: proto.play, pause: proto.pause }
  proto.play = function () { calls.push('play'); return Promise.resolve() }
  proto.pause = function () { calls.push('pause') }
  return { calls, restore() { proto.play = orig.play; proto.pause = orig.pause } }
}

test('R9-MOTION-1 · a static image card keeps its plain thumbnail and hover changes nothing about it', async () => {
  const m = await mountRoot()
  try {
    for (const f of [image(), image({ id: 'p', name: 'p.png', ext: 'png' })]) {
      await m.render(tile(f))
      const box = document.querySelector('[data-thumb]')
      assert.equal(box.getAttribute('data-thumb'), 'image')
      assert.equal(box.getAttribute('data-motion'), 'static')
      const before = document.querySelector('img').getAttribute('src')
      await m.mouse(document.querySelector('[data-file-kind]'), 'mouseover')
      await m.mouse(document.querySelector('[data-file-kind]'), 'mouseenter')
      assert.equal(document.querySelector('img').getAttribute('src'), before)
      assert.equal(document.querySelector('[data-thumb]').getAttribute('data-motion'), 'static')
    }
  } finally { await m.unmount() }
})

test('R9-MOTION-2 · a video card is paused, muted and inline at idle — nothing plays by itself', async () => {
  const m = await mountRoot()
  const media = stubMedia(m.W)
  try {
    await m.render(tile(clip()))
    const v = document.querySelector('video')
    assert.ok(v)
    assert.equal(v.hasAttribute('autoplay'), false)
    assert.equal(v.hasAttribute('controls'), false)
    assert.equal(v.muted, true)
    assert.equal(v.hasAttribute('playsinline'), true)
    assert.equal(v.getAttribute('preload'), 'metadata')
    assert.equal(document.querySelector('[data-thumb]').getAttribute('data-motion'), 'idle')
    assert.deepEqual(media.calls, [], 'ตอน mount ต้องไม่สั่ง play')
  } finally { media.restore(); await m.unmount() }
})

test('R9-MOTION-3 · hovering a video card starts a muted preview; leaving pauses and rewinds it (R9-MOTION-4)', async () => {
  const m = await mountRoot()
  const media = stubMedia(m.W)
  try {
    await m.render(tile(clip()))
    const card = document.querySelector('[data-file-kind]')
    const v = document.querySelector('video')
    v.currentTime = 0
    await m.mouse(card, 'mouseover'); await m.mouse(card, 'mouseenter')
    assert.deepEqual(media.calls, ['play'])
    assert.equal(v.muted, true)
    assert.equal(document.querySelector('[data-thumb]').getAttribute('data-motion'), 'playing')
    v.currentTime = 3.5
    await m.mouse(card, 'mouseout'); await m.mouse(card, 'mouseleave')
    assert.deepEqual(media.calls, ['play', 'pause'])
    assert.equal(v.currentTime, 0, 'ออกจากการ์ดต้องกรอกลับไปเฟรมแรก')
    assert.equal(document.querySelector('[data-thumb]').getAttribute('data-motion'), 'idle')
  } finally { media.restore(); await m.unmount() }
})

test('R9-MOTION-5 · prefers-reduced-motion disables automatic hover playback (video and GIF)', async () => {
  const m = await mountRoot({ reducedMotion: true })
  const media = stubMedia(m.W)
  try {
    await m.render(tile(clip()))
    const card = document.querySelector('[data-file-kind]')
    await m.mouse(card, 'mouseover'); await m.mouse(card, 'mouseenter')
    assert.deepEqual(media.calls, [], 'reduced motion: ห้าม play อัตโนมัติ')
    assert.equal(document.querySelector('[data-thumb]').getAttribute('data-motion'), 'idle')
    await m.render(tile(gif()))
    await m.mouse(document.querySelector('[data-file-kind]'), 'mouseover'); await m.mouse(document.querySelector('[data-file-kind]'), 'mouseenter')
    assert.equal(document.querySelector('img[src$="/preview"]'), null, 'reduced motion: GIF ที่เคลื่อนไหวต้องไม่ถูกโหลดจากการชี้')
    assert.equal(document.querySelector('[data-thumb]').getAttribute('data-thumb'), 'gif-static')
  } finally { media.restore(); await m.unmount() }
})

test('R9-MOTION-6 · a GIF card does not load or animate the animated resource while idle', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    const box = document.querySelector('[data-thumb]')
    assert.equal(box.getAttribute('data-thumb'), 'gif-static')
    assert.equal(box.getAttribute('data-motion'), 'idle')
    assert.equal(document.querySelector('img'), null, 'idle ต้องไม่มี <img> ที่ชี้ไป GIF จริง')
    assert.ok(box.querySelector('svg'), 'ตัวแทนนิ่ง = ไอคอนชนิดไฟล์')
    assert.ok(box.textContent.includes('GIF'), 'บอกให้รู้ว่าเป็น GIF ที่จะเล่นเมื่อชี้')
  } finally { await m.unmount() }
})

test('R9-MOTION-7 · hovering a GIF card mounts the real animated image; leaving returns to the still state (R9-MOTION-8)', async () => {
  const m = await mountRoot()
  try {
    await m.render(tile(gif()))
    const card = document.querySelector('[data-file-kind]')
    await m.mouse(card, 'mouseover'); await m.mouse(card, 'mouseenter')
    const img = document.querySelector('img')
    assert.ok(img, 'ชี้แล้วต้องมีภาพจริง')
    assert.equal(img.getAttribute('src'), '/api/files/g1/preview')
    assert.equal(document.querySelector('[data-thumb]').getAttribute('data-thumb'), 'gif')
    assert.equal(document.querySelector('[data-thumb]').getAttribute('data-motion'), 'playing')
    await m.mouse(card, 'mouseout'); await m.mouse(card, 'mouseleave')
    assert.equal(document.querySelector('img'), null, 'ออกแล้วต้องถอด GIF ที่เคลื่อนไหวออก')
    assert.equal(document.querySelector('[data-thumb]').getAttribute('data-motion'), 'idle')
    assert.match(document.querySelector('[data-thumb]').getAttribute('data-thumb'), /^gif-static$/)
  } finally { await m.unmount() }
})

test('R9-MOTION-9 · Vault items get no motion preview of any kind', async () => {
  const m = await mountRoot()
  const media = stubMedia(m.W)
  try {
    for (const f of [gif({ vault: true }), clip({ vault: true })]) {
      await m.render(tile(f))
      const card = document.querySelector('[data-file-kind]')
      await m.mouse(card, 'mouseover'); await m.mouse(card, 'mouseenter')
      assert.equal(document.querySelector('img'), null, f.name)
      assert.equal(document.querySelector('video'), null, f.name)
      assert.equal(document.querySelector('[data-thumb]').getAttribute('data-thumb'), 'icon')
      assert.match(document.querySelector('[data-thumb]').className, /hatch/)
    }
    assert.deepEqual(media.calls, [])
  } finally { media.restore(); await m.unmount() }
})

test('R9-MOTION-10 · the Preview modal keeps explicit, user-controlled video playback', async () => {
  const m = await mountRoot({ reducedMotion: true })
  try {
    await m.render(React.createElement(files.FilePreviewModal, { t, file: clip(), onClose: noop, onDownload: noop }))
    const v = document.querySelector('[role="dialog"] video')
    assert.ok(v)
    assert.equal(v.hasAttribute('controls'), true, 'modal ยังมี controls ให้ผู้ใช้สั่งเอง')
    assert.equal(v.getAttribute('preload'), 'metadata')
    assert.equal(v.hasAttribute('autoplay'), false)
    assert.equal(v.hasAttribute('muted') || v.muted, false, 'modal ไม่ถูกบังคับ mute เหมือนการ์ด')
  } finally { await m.unmount() }
})

/* ══ R9-C expanded sort ════════════════════════════════════════════════════ */

const SORT_SET = [
  fileItem({ id: 'f-b', name: 'beta.pdf', size: 50, created: NOW - 300, modified: NOW - 10 }),
  fileItem({ id: 'f-a', name: 'alpha.pdf', size: 10, created: NOW - 100, modified: NOW - 30 }),
  fileItem({ id: 'f-c', name: 'Gamma.pdf', size: 90, created: NOW - 200, modified: NOW - 20 }),
  folderItem({ id: 'd-b', name: 'beta', created: NOW - 50, modified: NOW - 5 }),
  folderItem({ id: 'd-a', name: 'alpha', created: NOW - 400, modified: NOW - 40 }),
]
const ids = (arr) => arr.map((x) => x.id)

test('R9-SORT-1/2 · Name A→Z and Z→A are case-insensitive and deterministic', () => {
  const az = view.sectionItems(SORT_SET, 'name-asc')
  assert.deepEqual(ids(az.files), ['f-a', 'f-b', 'f-c'])
  assert.deepEqual(ids(az.folders), ['d-a', 'd-b'])
  const za = view.sectionItems(SORT_SET, 'name-desc')
  assert.deepEqual(ids(za.files), ['f-c', 'f-b', 'f-a'])
  assert.deepEqual(ids(za.folders), ['d-b', 'd-a'])
  // ชื่อซ้ำ → ตัดสินด้วย id เสมอ ไม่ขึ้นกับลำดับที่ป้อน
  const dup = [fileItem({ id: 'x2', name: 'same.pdf' }), fileItem({ id: 'x1', name: 'same.pdf' })]
  assert.deepEqual(ids(view.sortItems(dup, 'name-asc')), ['x1', 'x2'])
  assert.deepEqual(ids(view.sortItems([...dup].reverse(), 'name-asc')), ['x1', 'x2'])
})

test('R9-SORT-3/4 · Uploaded newest/oldest use the durable created timestamp, not modified', () => {
  const newest = view.sectionItems(SORT_SET, 'uploaded-desc')
  assert.deepEqual(ids(newest.files), ['f-a', 'f-c', 'f-b'])
  assert.deepEqual(ids(newest.folders), ['d-b', 'd-a'])
  const oldest = view.sectionItems(SORT_SET, 'uploaded-asc')
  assert.deepEqual(ids(oldest.files), ['f-b', 'f-c', 'f-a'])
  // เท่ากัน → id
  const tie = [fileItem({ id: 't2', created: 5 }), fileItem({ id: 't1', created: 5 })]
  assert.deepEqual(ids(view.sortItems(tie, 'uploaded-desc')), ['t1', 't2'])
})

test('R9-SORT-5/6 · Modified newest/oldest use the modified timestamp', () => {
  assert.deepEqual(ids(view.sectionItems(SORT_SET, 'modified-desc').files), ['f-b', 'f-c', 'f-a'])
  assert.deepEqual(ids(view.sectionItems(SORT_SET, 'modified-asc').files), ['f-a', 'f-c', 'f-b'])
  assert.deepEqual(ids(view.sectionItems(SORT_SET, 'modified-desc').folders), ['d-b', 'd-a'])
})

test('R9-SORT-7/8 · Size largest/smallest; folders (size 0) stay in their own section', () => {
  const big = view.sectionItems(SORT_SET, 'size-desc')
  assert.deepEqual(ids(big.files), ['f-c', 'f-b', 'f-a'])
  assert.deepEqual(ids(big.folders), ['d-a', 'd-b'], 'ขนาดเท่ากัน (0) → เรียงด้วย id อย่างคงที่')
  const small = view.sectionItems(SORT_SET, 'size-asc')
  assert.deepEqual(ids(small.files), ['f-a', 'f-b', 'f-c'])
  assert.ok(!ids(small.files).some((id) => id.startsWith('d-')))
})

test('R9-SORT-9/10 · folders stay above files under every mode and each group sorts independently', () => {
  for (const mode of view.SORT_MODES) {
    const s = view.sectionItems(SORT_SET, mode)
    assert.equal(s.folders.length, 2, mode)
    assert.equal(s.files.length, 3, mode)
    assert.ok(s.folders.every((x) => x.kind === 'folder') && s.files.every((x) => x.kind === 'file'), mode)
  }
  assert.deepEqual([...view.SORT_MODES], ['name-asc', 'name-desc', 'uploaded-desc', 'uploaded-asc', 'modified-desc', 'modified-asc', 'size-desc', 'size-asc'])
  // ค่าเดิมสามค่าของจอยังใช้ได้ (ผู้ใช้ที่มี state เก่า / ผู้เรียกเดิม)
  assert.deepEqual(ids(view.sortItems(SORT_SET.slice(0, 3), 'name')), ['f-a', 'f-b', 'f-c'])
  assert.deepEqual(ids(view.sortItems(SORT_SET.slice(0, 3), 'size')), ['f-c', 'f-b', 'f-a'])
  assert.deepEqual(ids(view.sortItems(SORT_SET.slice(0, 3), 'modified')), ['f-b', 'f-c', 'f-a'])
})

test('R9-SORT-11 · search/filter still yields two grouped, sorted sections', () => {
  const hit = view.filterItems([...SORT_SET, image({ id: 'i', name: 'alpha.jpg' })], { query: 'alpha', typeFilter: 'all' })
  const s = view.sectionItems(hit, 'name-desc')
  assert.deepEqual(ids(s.folders), ['d-a'])
  assert.deepEqual(ids(s.files), ['f-a', 'i']) // Z→A: 'alpha.pdf' มาก่อน 'alpha.jpg'
})

test('R9-SORT-12 · every sort label exists in en/th/zh and the grid exposes all eight options', async () => {
  const keys = view.SORT_MODES.map((mode) => view.SORT_LABEL_KEYS[mode])
  assert.equal(keys.length, 8)
  for (const key of keys) for (const lang of LANGS) {
    assert.equal(typeof STRINGS[lang][key], 'string', `${lang}.${key}`)
    assert.ok(STRINGS[lang][key].length > 0)
  }
  // ป้ายต้องบอกทิศทาง ไม่ใช่แค่ "Name"
  for (const key of keys) assert.notEqual(STRINGS.en[key], 'Name')
  assert.match(STRINGS.en[view.SORT_LABEL_KEYS['uploaded-desc']], /Upload/i)
  assert.match(STRINGS.en[view.SORT_LABEL_KEYS['size-asc']], /Small/i)
})
