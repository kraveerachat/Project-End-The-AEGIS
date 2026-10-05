// tests/filesBulkZip.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 12
//
// Normal Files screen with the real Files component (jsdom + Vite SSR), real api.js / streaming source,
// and a stubbed `fetch` returning streamed Responses with Content-Length:
//   • 1–3 files keep one anchor per file (fire-and-forget, no picker) — unchanged
//   • default off (PR-1): 4 files still click anchors
//   • 4+ files: showSaveFilePicker is called synchronously within the click, exactly once, no dialog
//   • folders are skipped with a notice; a second click while archiving announces busy; Cancel aborts
//   • no File System Access: ≤ 64 MiB → one Blob ZIP anchor; above it → per-file anchors + notice
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React, { act } from 'react'
import { JSDOM } from 'jsdom'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockHooksPath = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))
const t = makeT('en')
const MiB = 1024 * 1024

let vite
let Files
before(async () => {
  vite = await createServer({
    configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent', plugins: [reactPlugin()],
    server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })
  ;({ Files } = await vite.ssrLoadModule('/src/screens/Files.jsx'))
})
after(async () => { await vite?.close() })

const NOW = 1_800_000_000_000
const fileRow = (i, size = 3 + i) => ({
  id: `f${i}`, name: `file${i}.bin`, kind: 'file', type: 'Binary', ext: 'bin', size,
  modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true,
})
const folderRow = (i) => ({ id: `d${i}`, name: `dir${i}`, kind: 'folder', type: 'Folder', ext: '', size: 0, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true })
const bytesOf = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 1) b[i] = (i + seed) & 0xff; return b }

async function mountFiles(rows, { fsa = true, holdBody = null, props = {} } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  const log = { downloads: [], anchors: [], pickers: [], writables: [], objectUrls: [] }
  const fetchStub = async (url) => {
    const u = String(url)
    const m = u.match(/api\/files\/([^/]+)\/download$/)
    if (m) {
      const row = rows.find((r) => r.id === decodeURIComponent(m[1]))
      log.downloads.push(row.id)
      const bytes = bytesOf(row.size, row.id.length)
      const stream = new ReadableStream({
        async start(c) {
          if (holdBody?.id === row.id) await holdBody.promise
          if (bytes.length) c.enqueue(bytes)
          c.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'Content-Length': String(row.size) } })
    }
    if (u.includes('media-info')) return new Response(JSON.stringify({ items: {} }), { status: 200 })
    return new Response('{}', { status: 200 })
  }
  const globals = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: fetchStub,
    __AEGIS_API_FIXTURES__: { '/api/files': { loading: false, error: null, data: { files: rows, ancestors: [] } } },
  }
  if (fsa) {
    globals.showSaveFilePicker = (opts) => {
      log.pickers.push(opts)
      const wr = { bytes: 0, closed: false, aborted: false }
      log.writables.push(wr)
      return Promise.resolve({
        createWritable: async () => ({
          async write(b) { wr.bytes += b.length },
          async close() { wr.closed = true },
          async abort() { wr.aborted = true },
        }),
      })
    }
  }
  const previous = new Map()
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  if (!fsa && Object.hasOwn(globalThis, 'showSaveFilePicker')) {
    previous.set('showSaveFilePicker', Object.getOwnPropertyDescriptor(globalThis, 'showSaveFilePicker'))
    delete globalThis.showSaveFilePicker
  }
  const restoreUrl = { c: URL.createObjectURL, r: URL.revokeObjectURL }
  URL.createObjectURL = (blob) => { log.objectUrls.push(blob); return `blob:files/${log.objectUrls.length}` }
  URL.revokeObjectURL = () => {}
  w.document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]')
    if (a && a.hasAttribute('download')) { log.anchors.push({ href: a.getAttribute('href'), download: a.download }); e.preventDefault() }
  }, true)
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(w.document.getElementById('root'))
  let rootUnmounted = false
  await act(async () => root.render(React.createElement(Files, { t, lang: 'en', go() {}, ...props })))
  const settle = async (n = 6) => { for (let i = 0; i < n; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)) }) }
  await settle()
  const q = (s) => w.document.querySelector(s)
  const click = async (el) => { await act(async () => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }))); await settle() }
  const select = async (ids) => { for (const id of ids) await click(q(`[data-file-id="${id}"] [data-file-card-control="checkbox"]`)) }
  const bulkButton = () => [...q('[data-testid="files-selection-bar"]').querySelectorAll('button')].find((b) => b.textContent.trim() === t('download'))
  return {
    w, log, q, click, select, settle, bulkButton,
    notice: () => q('[data-testid="files-bulk-notice"]')?.textContent ?? '',
    panel: () => q('[data-vault-transfer="download"]'),
    /** unmount the screen only (globals stay installed so in-flight work can still be observed) */
    async unmountRoot() {
      if (rootUnmounted) return
      rootUnmounted = true
      await act(async () => root.unmount())
    },
    async unmount() {
      if (!rootUnmounted) await act(async () => root.unmount())
      rootUnmounted = true
      URL.createObjectURL = restoreUrl.c
      URL.revokeObjectURL = restoreUrl.r
      for (const [key, d] of previous) { if (d === undefined) delete globalThis[key]; else Object.defineProperty(globalThis, key, d) }
      w.close()
    },
  }
}

const rows6 = () => [0, 1, 2, 3, 4, 5].map((i) => fileRow(i))

test('FZ-1 1–3 files: one anchor per file, no picker (unchanged)', async () => {
  const m = await mountFiles(rows6(), { props: { bulkZipEnabled: true } })
  try {
    await m.select(['f0', 'f1', 'f2'])
    await m.click(m.bulkButton())
    assert.deepEqual(m.log.anchors.map((a) => a.download), ['file0.bin', 'file1.bin', 'file2.bin'])
    assert.ok(m.log.anchors.every((a) => a.href.endsWith('/download')))
    assert.equal(m.log.pickers.length, 0)
  } finally { await m.unmount() }
})

test('FZ-2 default on (accepted): with no prop, 4 files save as one ZIP through one picker', async () => {
  const m = await mountFiles(rows6())
  try {
    await m.select(['f0', 'f1', 'f2', 'f3'])
    await m.click(m.bulkButton())
    await m.settle(10)
    assert.equal(m.log.pickers.length, 1)
    assert.equal(m.log.anchors.length, 0)
    assert.equal(m.log.writables[0].closed, true)
  } finally { await m.unmount() }
})

test('FZ-3 4+ files: the picker is called synchronously within the click, once, no dialog; the archive completes', async () => {
  const rows = rows6()
  const m = await mountFiles(rows, { props: { bulkZipEnabled: true } })
  try {
    await m.select(['f0', 'f1', 'f2', 'f3', 'f4'])
    const btn = m.bulkButton()
    let syncPickers = -1
    await act(async () => {
      btn.dispatchEvent(new m.w.MouseEvent('click', { bubbles: true, cancelable: true }))
      syncPickers = m.log.pickers.length
    })
    assert.equal(syncPickers, 1, 'picker inside the click')
    assert.equal(m.q('[role="dialog"]'), null, 'Normal Files get no confirmation dialog')
    await m.settle(12)
    assert.equal(m.log.pickers.length, 1)
    assert.match(m.log.pickers[0].suggestedName, /^AEGIS-Files-\d{8}-\d{6}\.zip$/)
    assert.deepEqual(m.log.downloads, ['f0', 'f1', 'f2', 'f3', 'f4'])
    assert.equal(m.log.writables[0].closed, true)
    assert.equal(m.log.anchors.length, 0)
    assert.equal(m.panel(), null, 'the panel clears after success')
    for (const r of rows) assert.ok(Object.isExtensible(r), 'listing rows are not frozen')
  } finally { await m.unmount() }
})

test('FZ-4 the panel shows archiving then finalizing; a second click while archiving announces busy', async () => {
  let release
  const holdBody = { id: 'f2', promise: new Promise((r) => { release = r }) }
  const m = await mountFiles(rows6(), { props: { bulkZipEnabled: true }, holdBody })
  try {
    await m.select(['f0', 'f1', 'f2', 'f3'])
    await m.click(m.bulkButton())
    await m.settle(6)
    assert.equal(m.panel()?.getAttribute('data-vault-transfer-stage'), 'archiving')
    assert.ok(m.panel().textContent.includes(t('zipArchiving', { index: 3, count: 4, name: 'file2.bin' })))
    await m.click(m.bulkButton())
    assert.ok(m.notice().includes(t('filesDownloadBusy')))
    assert.equal(m.log.pickers.length, 1)
    release()
    await m.settle(12)
    assert.equal(m.log.writables[0].closed, true)
  } finally { await m.unmount() }
})

test('FZ-5 Cancel aborts the archive; no later file is fetched', async () => {
  let release
  const holdBody = { id: 'f1', promise: new Promise((r) => { release = r }) }
  const m = await mountFiles(rows6(), { props: { bulkZipEnabled: true }, holdBody })
  try {
    await m.select(['f0', 'f1', 'f2', 'f3'])
    await m.click(m.bulkButton())
    await m.settle(6)
    await m.click([...m.panel().querySelectorAll('button')].find((b) => b.textContent.trim() === t('vaultXferCancel')))
    release()
    await m.settle(8)
    assert.equal(m.log.writables[0].aborted, true)
    assert.equal(m.log.writables[0].closed, false)
    assert.ok(!m.log.downloads.includes('f2'))
    assert.equal(m.panel(), null)
  } finally { await m.unmount() }
})

test('FZ-6 folders are skipped with a notice (4 files + 1 folder → ZIP)', async () => {
  const m = await mountFiles([...rows6(), folderRow(1)], { props: { bulkZipEnabled: true } })
  try {
    await m.select(['f0', 'f1', 'f2', 'f3', 'd1'])
    await m.click(m.bulkButton())
    await m.settle(10)
    assert.equal(m.log.pickers.length, 1)
    assert.ok(m.notice().includes(t('zipFoldersSkipped', { n: 1 })))
    assert.deepEqual(m.log.downloads, ['f0', 'f1', 'f2', 'f3'])
  } finally { await m.unmount() }
})

test('FZ-7 no FSA: ≤ 64 MiB → one Blob ZIP anchor; > 64 MiB → per-file anchors plus the fallback notice', async () => {
  {
    const m = await mountFiles(rows6(), { fsa: false, props: { bulkZipEnabled: true } })
    try {
      await m.select(['f0', 'f1', 'f2', 'f3'])
      await m.click(m.bulkButton())
      await m.settle(10)
      assert.equal(m.log.objectUrls.length, 1)
      assert.equal(m.log.objectUrls[0].type, 'application/zip')
      assert.equal(m.log.anchors.length, 1)
      assert.match(m.log.anchors[0].download, /^AEGIS-Files-.*\.zip$/)
    } finally { await m.unmount() }
  }
  {
    const big = [fileRow(0, 40 * MiB), fileRow(1, 30 * MiB), fileRow(2), fileRow(3)]
    const m = await mountFiles(big, { fsa: false, props: { bulkZipEnabled: true } })
    try {
      await m.select(['f0', 'f1', 'f2', 'f3'])
      await m.click(m.bulkButton())
      assert.equal(m.log.anchors.length, 4)
      assert.ok(m.log.anchors.every((a) => a.href.endsWith('/download')))
      assert.equal(m.log.downloads.length, 0, 'nothing buffered')
      assert.ok(m.notice().includes(t('filesZipLargeFallback')))
    } finally { await m.unmount() }
  }
})

test('FZ-8 the tile menu Download stays per-file even with 4+ selected', async () => {
  const m = await mountFiles(rows6(), { props: { bulkZipEnabled: true } })
  try {
    await m.select(['f0', 'f1', 'f2', 'f3'])
    await m.click(m.q('[data-file-id="f1"] [data-file-card-control="menu"]'))
    const item = [...m.w.document.querySelectorAll('button, [role="menuitem"]')].find((b) => b.textContent.trim() === t('download') && !b.closest('[data-testid="files-selection-bar"]'))
    assert.ok(item, 'menu Download')
    await m.click(item)
    assert.deepEqual(m.log.anchors.map((a) => a.download), ['file1.bin'])
    assert.equal(m.log.pickers.length, 0)
  } finally { await m.unmount() }
})

test('FILES-UNMOUNT-ABORT leaving the Files screen aborts an active ZIP: no later fetch, no close, no success, no late state update', async (t) => {
  const errors = []
  t.mock.method(console, 'error', (...a) => { errors.push(a.map(String).join(' ')) })
  let release
  const holdBody = { id: 'f1', promise: new Promise((r) => { release = r }) }
  const m = await mountFiles(rows6(), { props: { bulkZipEnabled: true }, holdBody })
  try {
    await m.select(['f0', 'f1', 'f2', 'f3'])
    await m.click(m.bulkButton())
    await m.settle(6)
    assert.equal(m.log.pickers.length, 1, 'picker + createWritable succeeded')
    assert.equal(m.panel()?.getAttribute('data-vault-transfer-stage'), 'archiving', 'held mid-entry 2')
    await m.unmountRoot()
    release()
    await m.settle(12)
    assert.equal(m.log.writables[0].aborted, true, 'the destination was aborted')
    assert.equal(m.log.writables[0].closed, false, 'never closed as success')
    assert.ok(!m.log.downloads.includes('f2'), 'no later entry fetched')
    assert.ok(!m.log.downloads.includes('f3'))
    assert.deepEqual(errors.filter((e) => /unmounted|act\(/i.test(e)), [], 'no React update-after-unmount warning')
  } finally { await m.unmount() }
})
