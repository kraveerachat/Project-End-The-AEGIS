// tests/workspaceMarqueeApp.test.js — AEGIS Drive (IDEA1) · PR220-R1 · App-level Files marquee
//
// Human Acceptance on the first PR220 candidate: Vault TREE starts a marquee from the
// wide blank side space, Files does not behave the same. The earlier SHARED-FILES-SURFACE
// test mounted FilesSections inside a synthetic wrapper, so it never saw the real App
// hierarchy:
//
//   App → main → [data-testid=app-page-content] → .workspace-pane-content → Files → FilesSections
//
// This suite mounts the real authenticated App shell with the real Files screen and
// the real lib/hooks.js (only auth + transport are stubbed), then gives the App surface
// a wide QHD box and the file tiles a centered box.
//
// ⚠️ jsdom has no layout engine. Geometry is modelled explicitly:
//    - the App surface spans the whole main pane;
//    - anything inside the centered `.workspace-pane-content` column occupies the
//      centered 1440px measure (that is what its padding-inline does in a browser);
//    - an absolutely positioned marquee rectangle is drawn relative to its CSS
//      containing block = its nearest positioned ancestor (Tailwind `relative`/
//      `absolute`/`fixed`/`sticky`, or an inline position/transform).
//    The rectangle's on-screen position is computed from that containing block, so a
//    rectangle mounted inside a positioned Files wrapper lands in the wrong place
//    exactly as it does in the browser.
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { resetBackend } from './fixtures/themeTransitionBackend.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => normalizePath(path.join(rootDir, 'tests/fixtures', name))

let vite
let App

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: {
      alias: [
        { find: './lib/auth.js', replacement: fixture('stubAuth.js') },
        { find: '../lib/auth.js', replacement: fixture('stubAuth.js') },
        { find: './lib/api.js', replacement: fixture('workspaceShellApi.js') },
        { find: '../lib/api.js', replacement: fixture('workspaceShellApi.js') },
        // the REAL lib/hooks.js imports its transport as './api.js'
        { find: './api.js', replacement: fixture('workspaceShellApi.js') },
        // Files stays REAL. The other screens are irrelevant to this surface.
        ...['Dashboard', 'Vault', 'Shares', 'FileHistory', 'Storage', 'Audit', 'Access']
          .map((screen) => ({ find: `./screens/${screen}.jsx`, replacement: fixture('appShellStubs.jsx') })),
      ],
    },
  })
  App = (await vite.ssrLoadModule('/src/App.jsx')).default
})

after(async () => vite?.close())

const NOW = Date.UTC(2026, 8, 20, 9, 0, 0)
const FILES = [
  { id: 'd1', name: 'Projects', kind: 'folder', type: 'Folder', ext: '', size: 0, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, parentId: null },
  { id: 'doc1', name: 'report.pdf', kind: 'file', type: 'PDF', ext: 'pdf', size: 1024, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, parentId: null },
]

beforeEach(() => {
  globalThis.__AEGIS_WORKSPACE_FILES__ = FILES
})

/* ── browser geometry model ──────────────────────────────────────────────── */
// A QHD authenticated shell: sidebar 240px, top bar 64px, main pane 2320×1376.
const SURFACE = { x: 240, y: 64, w: 2320, h: 1376 }
// .workspace-pane-content: padding-inline = max(2rem, (100% - 1440px) / 2 + 2rem)
const GUTTER = Math.max(32, (SURFACE.w - 1440) / 2 + 32)
const COLUMN = { x: SURFACE.x + GUTTER, y: 240, w: SURFACE.w - 2 * GUTTER, h: 900 }
const TILES = {
  d1: { x: COLUMN.x, y: 420, w: 220, h: 60 },
  doc1: { x: COLUMN.x, y: 560, w: 220, h: 180 },
}

const box = (r) => ({ left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h, width: r.w, height: r.h, x: r.x, y: r.y })

function installGeometry(W) {
  const zero = { x: 0, y: 0, w: 0, h: 0 }
  W.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const id = this.getAttribute?.('data-file-id')
    if (id && TILES[id] && this.hasAttribute('data-file-kind')) return box(TILES[id])
    if (this.matches?.('[data-testid="app-page-content"]')) return box(SURFACE)
    if (this.classList?.contains('workspace-pane-content')) {
      // the padded wrapper itself spans the pane; its padding is the gutter
      return box({ x: SURFACE.x, y: COLUMN.y - 20, w: SURFACE.w, h: COLUMN.h + 40 })
    }
    if (this.parentElement?.closest?.('.workspace-pane-content')) return box(COLUMN)
    return box(zero)
  }
}

const positionedClass = /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/
function containingBlockOf(el) {
  let node = el.parentElement
  while (node) {
    const cls = typeof node.className === 'string' ? node.className : ''
    const pos = node.style?.position
    if (positionedClass.test(cls) || (pos && pos !== 'static') || node.style?.transform) return node
    node = node.parentElement
  }
  return document.documentElement
}
/** where a browser paints the marquee rectangle, in viewport coordinates */
function paintedRect(rectEl) {
  const cb = containingBlockOf(rectEl).getBoundingClientRect()
  return {
    left: cb.left + parseFloat(rectEl.style.left),
    top: cb.top + parseFloat(rectEl.style.top),
    width: parseFloat(rectEl.style.width),
    height: parseFloat(rectEl.style.height),
  }
}

/* ── authenticated App on the real Files screen ──────────────────────────── */
function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/files',
    pretendToBeVisual: true,
  })
  const previous = new Map()
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.Element.prototype.scrollIntoView = () => {}
  // jsdom has no Web Animations API; the shell's scroll-reveal only needs a handle
  dom.window.Element.prototype.animate = () => ({ cancel() {}, finish() {}, finished: Promise.resolve(), onfinish: null })
  dom.window.IntersectionObserver = globals.IntersectionObserver
  dom.window.ResizeObserver = globals.ResizeObserver
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

async function mountFilesApp({ role = 'Admin' } = {}) {
  resetBackend({ account: { language: 'en' }, user: { role }, restoreSession: true })
  const env = installDom()
  const W = env.dom.window
  installGeometry(W)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  await act(async () => { root.render(React.createElement(App)); await settle() })
  const deadline = Date.now() + 4_000
  while (!document.querySelector('[data-file-id="doc1"][data-file-kind]') && Date.now() < deadline) {
    await act(async () => { await settle() })
  }
  if (!document.querySelector('[data-file-id="doc1"][data-file-kind]')) {
    const snapshot = document.body.textContent.slice(0, 600)
    await act(async () => root.unmount())
    env.restore()
    assert.fail(`the real Files grid did not render inside the App shell: ${snapshot}`)
  }

  const pointer = (node, type, init = {}) => act(async () => {
    const ev = new W.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
    Object.defineProperty(ev, 'pointerId', { value: 1 })
    Object.defineProperty(ev, 'pointerType', { value: init.pointerType ?? 'mouse' })
    node.dispatchEvent(ev)
  })
  const key = (k) => act(async () => { W.dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true })) })
  const surface = () => document.querySelector('[data-testid="app-page-content"]')
  // the padded Files wrapper — a real click in the side gutter lands on this element
  const gutterTarget = () => surface().querySelector(':scope > .workspace-pane-content:not(.dashboard-page-header)')
  const rect = () => document.querySelector('[data-marquee-rect]')
  const selected = () => [...document.querySelectorAll('[data-file-kind] [role="checkbox"][aria-checked="true"]')]
    .map((cb) => cb.closest('[data-file-kind]').getAttribute('data-file-id')).sort()
  return {
    W, pointer, key, surface, gutterTarget, rect, selected,
    async unmount() { await act(async () => root.unmount()); env.restore() },
  }
}

function assertPaintedAt(rectEl, expected, message) {
  assert.ok(rectEl, `${message}: rectangle exists`)
  const painted = paintedRect(rectEl)
  for (const k of ['left', 'top', 'width', 'height']) {
    assert.ok(Math.abs(painted[k] - expected[k]) < 0.5, `${message}: painted ${k} ${painted[k]} ≠ expected ${expected[k]}`)
  }
}

/* ── APP-MARQUEE-1..4: real App hierarchy, real geometry ─────────────────── */

test('APP-MARQUEE-0 the real App hierarchy wraps Files in the full-pane surface and centered column', async () => {
  const app = await mountFilesApp()
  try {
    const main = document.querySelector('main')
    assert.ok(main.contains(app.surface()), 'main → app-page-content')
    assert.ok(app.surface().hasAttribute('data-workspace-marquee-surface'), 'the App surface is the workspace marquee surface')
    assert.ok(app.gutterTarget(), 'app-page-content → .workspace-pane-content')
    assert.ok(app.gutterTarget().querySelector('[data-file-id="doc1"][data-file-kind]'), '.workspace-pane-content → Files → tiles')
  } finally { await app.unmount() }
})

for (const role of ['Admin', 'DataLake-User']) {
  test(`APP-MARQUEE-1 (${role}) left gutter → drag through tiles selects them and paints the rectangle under the pointer`, async () => {
    const app = await mountFilesApp({ role })
    try {
      const origin = { x: SURFACE.x + 60, y: 400 }                // well left of the centered column
      assert.ok(origin.x < COLUMN.x, 'the pointer starts in the left gutter')
      await app.pointer(app.gutterTarget(), 'pointerdown', { clientX: origin.x, clientY: origin.y })
      await app.pointer(app.W, 'pointermove', { clientX: COLUMN.x + 100, clientY: 700 })
      assert.deepEqual(app.selected(), ['d1', 'doc1'], 'tiles under the marquee are selected')
      assertPaintedAt(app.rect(), { left: origin.x, top: origin.y, width: COLUMN.x + 100 - origin.x, height: 300 }, 'left gutter marquee')
      assert.equal(app.surface().style.userSelect, 'none', 'text selection is suppressed on the whole App surface while dragging')
      await app.pointer(app.W, 'pointerup', { clientX: COLUMN.x + 100, clientY: 700 })
      assert.equal(app.rect(), null, 'the rectangle disappears on release')
      assert.equal(app.surface().style.userSelect, '', 'text selection is restored after release')
    } finally { await app.unmount() }
  })
}

test('APP-MARQUEE-2 right gutter starts a marquee painted under the pointer', async () => {
  const app = await mountFilesApp()
  try {
    const origin = { x: SURFACE.x + SURFACE.w - 60, y: 500 }
    assert.ok(origin.x > COLUMN.x + COLUMN.w, 'the pointer starts in the right gutter')
    await app.pointer(app.gutterTarget(), 'pointerdown', { clientX: origin.x, clientY: origin.y })
    await app.pointer(app.W, 'pointermove', { clientX: origin.x - 40, clientY: origin.y + 30 })
    assertPaintedAt(app.rect(), { left: origin.x - 40, top: origin.y, width: 40, height: 30 }, 'right gutter marquee')
    await app.pointer(app.W, 'pointerup', { clientX: origin.x - 40, clientY: origin.y + 30 })
  } finally { await app.unmount() }
})

test('APP-MARQUEE-3 bottom whitespace of the App surface starts a marquee painted under the pointer', async () => {
  const app = await mountFilesApp()
  try {
    const origin = { x: 1400, y: SURFACE.y + SURFACE.h - 40 }
    await app.pointer(app.surface(), 'pointerdown', { clientX: origin.x, clientY: origin.y })
    await app.pointer(app.W, 'pointermove', { clientX: origin.x + 20, clientY: origin.y - 20 })
    assertPaintedAt(app.rect(), { left: origin.x, top: origin.y - 20, width: 20, height: 20 }, 'bottom whitespace marquee')
    await app.pointer(app.W, 'pointerup', { clientX: origin.x + 20, clientY: origin.y - 20 })
  } finally { await app.unmount() }
})

test('APP-MARQUEE-4 blank click clears; Ctrl marquee is additive; Ctrl blank click preserves; Escape restores', async () => {
  const app = await mountFilesApp()
  try {
    const gutter = app.gutterTarget()
    // select d1 only
    await app.pointer(gutter, 'pointerdown', { clientX: SURFACE.x + 40, clientY: 410 })
    await app.pointer(app.W, 'pointermove', { clientX: COLUMN.x + 10, clientY: 470 })
    await app.pointer(app.W, 'pointerup', { clientX: COLUMN.x + 10, clientY: 470 })
    assert.deepEqual(app.selected(), ['d1'])

    // Ctrl marquee over doc1 only keeps d1
    await app.pointer(gutter, 'pointerdown', { clientX: SURFACE.x + 40, clientY: 600, ctrlKey: true })
    await app.pointer(app.W, 'pointermove', { clientX: COLUMN.x + 10, clientY: 650, ctrlKey: true })
    await app.pointer(app.W, 'pointerup', { clientX: COLUMN.x + 10, clientY: 650, ctrlKey: true })
    assert.deepEqual(app.selected(), ['d1', 'doc1'], 'Ctrl marquee is additive')

    // Ctrl blank click preserves
    await app.pointer(gutter, 'pointerdown', { clientX: SURFACE.x + 40, clientY: 900, ctrlKey: true })
    await app.pointer(app.W, 'pointerup', { clientX: SURFACE.x + 40, clientY: 900, ctrlKey: true })
    assert.deepEqual(app.selected(), ['d1', 'doc1'], 'Ctrl blank click preserves the selection')

    // Escape during an active drag restores the snapshot
    await app.pointer(gutter, 'pointerdown', { clientX: SURFACE.x + 40, clientY: 1000 })
    await app.pointer(app.W, 'pointermove', { clientX: SURFACE.x + 80, clientY: 1040 })
    assert.deepEqual(app.selected(), [], 'a fresh marquee over blank space selects nothing')
    await app.key('Escape')
    assert.deepEqual(app.selected(), ['d1', 'doc1'], 'Escape restores the pre-drag selection')
    assert.equal(app.rect(), null)

    // plain blank click clears
    await app.pointer(gutter, 'pointerdown', { clientX: SURFACE.x + 40, clientY: 900 })
    await app.pointer(app.W, 'pointerup', { clientX: SURFACE.x + 40, clientY: 900 })
    assert.deepEqual(app.selected(), [], 'blank primary click clears')
  } finally { await app.unmount() }
})

test('APP-MARQUEE-5 tiles, controls and touch never start the desktop marquee; listeners are removed on unmount', async () => {
  const app = await mountFilesApp()
  const W = app.W
  const counts = new Map()
  const add = W.addEventListener.bind(W)
  const remove = W.removeEventListener.bind(W)
  W.addEventListener = (type, fn, opts) => { counts.set(type, (counts.get(type) ?? 0) + 1); return add(type, fn, opts) }
  W.removeEventListener = (type, fn, opts) => { counts.set(type, (counts.get(type) ?? 0) - 1); return remove(type, fn, opts) }
  let unmounted = false
  try {
    const tile = document.querySelector('[data-file-id="doc1"][data-file-kind]')
    await app.pointer(tile, 'pointerdown', { clientX: TILES.doc1.x + 10, clientY: TILES.doc1.y + 10 })
    await app.pointer(W, 'pointermove', { clientX: TILES.doc1.x + 80, clientY: TILES.doc1.y + 80 })
    assert.equal(app.rect(), null, 'pointer down on a tile never starts a marquee')
    await app.pointer(W, 'pointerup', {})

    const button = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'List view' || b.getAttribute('aria-pressed') !== null)
    await app.pointer(button, 'pointerdown', { clientX: 10, clientY: 10 })
    await app.pointer(W, 'pointermove', { clientX: 60, clientY: 60 })
    assert.equal(app.rect(), null, 'pointer down on a button never starts a marquee')
    await app.pointer(W, 'pointerup', {})

    await app.pointer(app.gutterTarget(), 'pointerdown', { clientX: SURFACE.x + 40, clientY: 900, pointerType: 'touch' })
    await app.pointer(W, 'pointermove', { clientX: SURFACE.x + 140, clientY: 1000, pointerType: 'touch' })
    assert.equal(app.rect(), null, 'touch never starts the desktop marquee')
    await app.pointer(W, 'pointerup', {})

    await app.pointer(app.gutterTarget(), 'pointerdown', { clientX: SURFACE.x + 40, clientY: 900 })
    await app.pointer(W, 'pointermove', { clientX: SURFACE.x + 140, clientY: 1000 })
    assert.ok(app.rect(), 'an active drag is in progress when the App unmounts')
    await app.unmount()
    unmounted = true
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
      assert.ok((counts.get(type) ?? 0) <= 0, `${type} listener removed on unmount (balance ${counts.get(type)})`)
    }
  } finally {
    if (!unmounted) await app.unmount()
  }
})

/* ── APP-MARQUEE-6: one shared primitive, no duplicate ownership ──────────── */

test('APP-MARQUEE-6 Files and Vault TREE consume one shared workspace marquee primitive owned by App', () => {
  const read = (rel) => {
    const file = path.join(rootDir, rel)
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }
  const app = read('src/App.jsx')
  const files = read('src/screens/Files.jsx')
  const tree = read('src/screens/VaultTreeScreen.jsx')
  const vault = read('src/screens/Vault.jsx')
  const shared = read('src/components/WorkspaceMarquee.jsx')

  assert.match(app, /workspaceSurfaceActive \? WorkspaceMarqueeSurface\b/, 'App renders the one shared surface for every workspace screen')
  assert.match(shared, /data-marquee-rect/, 'the shared surface paints the marquee rectangle')
  assert.match(shared, /useMarqueeSelection\(/, 'the shared surface drives the one marquee hook')
  for (const [name, source] of [['Files', files], ['VaultTreeScreen', tree]]) {
    assert.match(source, /useWorkspaceMarqueeSource|WorkspaceMarqueeSource/, `${name} registers only its selection source`)
    assert.match(source, /WorkspaceMarqueeScope/, `${name} uses the shared scope for standalone mounts`)
    assert.doesNotMatch(source, /useMarqueeSelection/, `${name} no longer owns a marquee hook instance`)
    assert.doesNotMatch(source, /data-marquee-rect|marquee-rect/, `${name} no longer paints its own rectangle`)
    assert.doesNotMatch(source, /registerMarqueePointerDown|marqueeSurfaceRef/, `${name} no longer receives App refs`)
    assert.doesNotMatch(source, /\brole\b\s*===|isAdmin/, `${name} has no role-conditioned interaction`)
  }
  assert.doesNotMatch(app, /registerWorkspaceMarqueePointerDown|workspaceMarqueePointerDownRef/, 'App no longer relays a per-screen pointer handler')
  assert.doesNotMatch(vault, /registerMarqueePointerDown|marqueeSurfaceRef/, 'Vault no longer threads App refs')
})
