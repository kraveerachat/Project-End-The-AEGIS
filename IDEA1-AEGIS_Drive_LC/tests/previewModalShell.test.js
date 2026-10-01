// tests/previewModalShell.test.js — AEGIS Drive (IDEA1) · Unified Preview P0 · shared preview modal shell (spec §2, §19)
//
// One modal shell for Files and the Vault: name + meta, a truthful state, and a Download action
// that no preview outcome can remove. Loading can never spin forever.
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
let shellModule
let files

before(async () => {
  vite = await createServer({
    configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent',
    plugins: [reactPlugin()], server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] },
  })
  shellModule = await vite.ssrLoadModule('/src/components/preview/PreviewModalShell.jsx').catch((e) => ({ loadError: e }))
  files = await vite.ssrLoadModule('/src/screens/Files.jsx')
})
after(async () => { await vite?.close() })

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  w.matchMedia = (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })
  const previous = new Map()
  const globals = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
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
      w.close()
    },
  }
}

async function mount() {
  const env = installDom()
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  return {
    render: (el) => act(async () => { root.render(el) }),
    unmount: async () => { await act(async () => root.unmount()); env.restore() },
  }
}

const Shell = (props) => React.createElement(shellModule.PreviewModalShell, {
  t, open: true, title: 'report.pdf', meta: { typeLabel: 'PDF', size: 2048 }, onClose() {}, onDownload() {}, ...props,
}, props.children ?? null)
const dialog = () => document.querySelector('[role="dialog"]')
const downloadButton = () => document.querySelector('[role="dialog"] [data-preview-download]')

test('MS-1 the shell module exists', () => {
  assert.equal(shellModule.loadError, undefined, String(shellModule.loadError?.message ?? ''))
  assert.equal(typeof shellModule.PreviewModalShell, 'function')
})

test('MS-2 every state shows name, meta, and an enabled Download; non-ready states explain themselves', async () => {
  for (const status of ['loading', 'ready', 'failed', 'unsupported', 'too-large']) {
    const m = await mount()
    let downloads = 0
    try {
      await m.render(Shell({ status, onDownload: () => { downloads += 1 } }))
      assert.equal(Boolean(dialog()), true, status)
      assert.equal(dialog().textContent.includes('report.pdf'), true, `${status}: name`)
      assert.equal(dialog().textContent.includes('PDF'), true, `${status}: type label`)
      assert.equal(Boolean(downloadButton()), true, `${status}: Download present`)
      assert.equal(downloadButton().disabled, false, `${status}: Download enabled`)
      await act(async () => downloadButton().click())
      assert.equal(downloads, 1, `${status}: Download fires`)
      const body = document.querySelector('[data-preview-shell]')
      assert.equal(body.getAttribute('data-preview-state'), status)
      if (status === 'loading') assert.equal(Boolean(body.querySelector('[role="status"]')), true)
      if (status === 'failed') assert.equal(Boolean(body.querySelector('[role="alert"]')), true)
      if (status === 'unsupported') assert.equal(body.textContent.includes(t('previewUnsupported')), true)
      if (status === 'too-large') assert.equal(body.textContent.includes(t('previewTooLarge')), true)
    } finally { await m.unmount() }
  }
})

test('MS-3 loading never spins forever: it turns into a failure after the timeout', async () => {
  const m = await mount()
  try {
    await m.render(Shell({ status: 'loading', loadingTimeoutMs: 20 }))
    assert.equal(document.querySelector('[data-preview-shell]').getAttribute('data-preview-state'), 'loading')
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    assert.equal(document.querySelector('[data-preview-shell]').getAttribute('data-preview-state'), 'failed')
    assert.equal(Boolean(document.querySelector('[data-preview-shell] [role="alert"]')), true)
    assert.equal(Boolean(downloadButton()), true)
  } finally { await m.unmount() }
})

test('MS-3b close and reopen of the same title starts a fresh loading episode', async () => {
  const m = await mount()
  const state = () => document.querySelector('[data-preview-shell]')?.getAttribute('data-preview-state')
  try {
    await m.render(Shell({ status: 'loading', loadingTimeoutMs: 20 }))
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    assert.equal(state(), 'failed')
    await m.render(Shell({ status: 'loading', loadingTimeoutMs: 20, open: false }))
    await m.render(Shell({ status: 'loading', loadingTimeoutMs: 20 }))
    assert.equal(state(), 'loading', 'a reopened preview is loading, not the previous failure')
    await act(async () => { await new Promise((r) => setTimeout(r, 60)) })
    assert.equal(state(), 'failed', 'the fail-safe still fires for the new episode')
  } finally { await m.unmount() }
})

const NOW = 1_800_000_000_000
const fileItem = (over = {}) => ({ id: 'f1', name: 'report.pdf', kind: 'file', type: 'PDF', ext: 'pdf', size: 1024, modified: NOW, created: NOW, uploader: 'user', vault: false, verified: true, ...over })

test('MS-4 Files preview renders inside the shared shell and keeps its data contract', async () => {
  const m = await mount()
  try {
    await m.render(React.createElement(files.FilePreviewModal, { t, file: fileItem({ id: 'i1', name: 'photo.JPG', type: 'Image', ext: 'jpg' }), onClose() {}, onDownload() {} }))
    assert.equal(Boolean(document.querySelector('[data-preview-shell]')), true)
    const box = document.querySelector('[data-file-preview-kind]')
    assert.equal(box.getAttribute('data-file-preview-kind'), 'image')
    assert.equal(box.getAttribute('data-file-preview-phase'), 'loading')
    assert.equal(Boolean(document.querySelector('[role="dialog"] img')), true)
    assert.equal(Boolean(downloadButton()), true)
  } finally { await m.unmount() }
})

test('MS-5 a Files type without a provider shows the stable fallback, never an empty frame', async () => {
  const m = await mount()
  try {
    await m.render(React.createElement(files.FilePreviewModal, { t, file: fileItem(), onClose() {}, onDownload() {} }))
    const shell = document.querySelector('[data-preview-shell]')
    assert.equal(shell.getAttribute('data-preview-state'), 'unsupported')
    assert.equal(shell.textContent.includes(t('previewUnsupported')), true)
    assert.equal(Boolean(downloadButton()), true)
  } finally { await m.unmount() }
})
