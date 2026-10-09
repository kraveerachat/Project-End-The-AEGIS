import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const item = (id, name, type = 'File') => ({
  id, name, type, ext: name.split('.').at(-1), size: 24, versionCount: 1,
  sha256Prefix: 'abcdef123456', deletedAt: '2026-10-03T08:00:00.000Z', purgeAt: '2026-11-02T08:00:00.000Z',
})
let dom, vite, createRoot, Trash
const t = makeT('en')

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  dom.window.matchMedia = () => ({
    matches: false, addEventListener() {}, removeEventListener() {},
  })
  ;({ createRoot } = await import('react-dom/client'))
  vite = await createServer({
    configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent',
    plugins: [reactPlugin()], server: { middlewareMode: true },
  })
  ;({ Trash } = await vite.ssrLoadModule('/src/screens/Trash.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
  dom?.window.close()
})

const json = (status, data) => ({ ok: status < 400, status, json: async () => data })
async function mount(rows = [item('1', 'one.png'), item('2', 'two.txt'), item('3', 'archive.pdf')]) {
  const calls = []
  let current = rows
  globalThis.fetch = dom.window.fetch = async (url, options = {}) => {
    const path = String(url)
    const method = options.method ?? 'GET'
    calls.push({ path, method })
    if (path === '/api/trash/status') return json(200, { unlocked: true })
    if (path === '/api/trash/lock' && method === 'POST') return json(204, null)
    if (path === '/api/trash' && method === 'GET') return json(200, { items: current })
    if (path.endsWith('/restore') && method === 'POST') {
      current = current.filter((row) => !path.includes(`/${row.id}/`))
      return json(200, { file: {} })
    }
    if (/\/api\/trash\/[^/]+$/.test(path) && method === 'DELETE') {
      current = current.filter((row) => !path.endsWith(`/${row.id}`))
      return json(200, { ok: true })
    }
    return json(404, { error: 'unexpected request' })
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(Trash, { t, lang: 'en', user: 'demo' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const click = async (element) => act(async () => element.click())
  const select = (id) => host.querySelector(`[data-trash-select="${id}"]`)
  return {
    host, calls, click, select,
    pane: () => host.querySelector('[data-trash-preview-pane]'),
    async unmount() { await act(async () => root.unmount()); host.remove() },
  }
}

test('TRASH-PREVIEW-1/2/3/4/5 left-click selects, replaces, closes; image and unsupported fallback', async () => {
  const ui = await mount()
  try {
    assert.equal(ui.pane(), null)
    await ui.click(ui.select('1'))
    assert.equal(ui.pane().getAttribute('data-trash-preview-id'), '1')
    assert.match(ui.pane().textContent, /one\.png/)
    assert.match(ui.pane().querySelector('img')?.getAttribute('src') ?? '', /\/api\/trash\/1\/preview/)
    assert.equal(ui.select('1').getAttribute('aria-pressed'), 'true')
    await ui.click(ui.select('2'))
    assert.equal(ui.pane().getAttribute('data-trash-preview-id'), '2')
    assert.match(ui.pane().textContent, /two\.txt/)
    await ui.click(ui.select('3'))
    assert.equal(ui.pane().getAttribute('data-trash-preview-id'), '3')
    assert.equal(ui.pane().querySelector('img, video, audio'), null)
    assert.ok(ui.pane().querySelector('[data-trash-preview-fallback]'))
    await ui.click(ui.pane().querySelector('[data-trash-preview-close]'))
    assert.equal(ui.pane(), null)
    assert.equal(ui.select('3').getAttribute('aria-pressed'), 'false')
  } finally { await ui.unmount() }
})

test('TRASH-PREVIEW-6 selection and preview issue no Restore or delete mutation', async () => {
  const ui = await mount()
  try {
    await ui.click(ui.select('1'))
    await ui.click(ui.select('2'))
    assert.equal(ui.calls.some(({ method }) => method === 'POST' || method === 'DELETE'), false)
  } finally { await ui.unmount() }
})

test('TRASH-PREVIEW-7/8 existing Restore and permanent-delete controls keep their flows', async () => {
  const ui = await mount()
  try {
    const row = ui.select('1').closest('[data-trash-row]')
    await ui.click(row.querySelector('[data-trash-restore]'))
    assert.equal(ui.pane(), null)
    assert.equal(ui.calls.some(({ path }) => path.endsWith('/restore')), false)
    const restoreConfirm = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t('trashRestore') && b.closest('[role="dialog"]'))
    assert.ok(restoreConfirm)
    await ui.click(restoreConfirm)
    assert.equal(ui.calls.filter(({ path }) => path.endsWith('/restore')).length, 1)
    const deleteRow = ui.select('2').closest('[data-trash-row]')
    await ui.click(deleteRow.querySelector('[data-trash-delete]'))
    assert.equal(ui.calls.some(({ method }) => method === 'DELETE'), false)
    assert.ok(document.querySelector('[role="dialog"]'))
  } finally { await ui.unmount() }
})

test('TRASH-PREVIEW-9 keyboard selection and Escape close preserve focus', async () => {
  const ui = await mount()
  try {
    const button = ui.select('1')
    assert.equal(button.tagName, 'BUTTON')
    assert.ok(button.tabIndex >= 0)
    button.focus()
    // Native button semantics supply Enter/Space activation in the browser;
    // jsdom does not synthesize that default click from a keydown.
    await ui.click(button)
    assert.equal(ui.pane()?.getAttribute('data-trash-preview-id'), '1')
    assert.equal(button.getAttribute('aria-pressed'), 'true')
    await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(ui.pane(), null)
    assert.equal(document.activeElement, button)
  } finally { await ui.unmount() }
})

test('TRASH-PREVIEW-RESPONSIVE narrow viewport uses the existing accessible modal', async () => {
  dom.window.matchMedia = () => ({
    matches: true, addEventListener() {}, removeEventListener() {},
  })
  const ui = await mount()
  try {
    await ui.click(ui.select('1'))
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    assert.ok(dialog)
    assert.match(dialog.textContent, /one\.png/)
    assert.equal(ui.host.querySelector('aside'), null)
    await ui.click(dialog.querySelector('button[aria-label="Close"]'))
    assert.equal(document.querySelector('[role="dialog"][aria-modal="true"]'), null)
    assert.equal(ui.select('1').getAttribute('aria-pressed'), 'false')
  } finally {
    await ui.unmount()
    dom.window.matchMedia = () => ({
      matches: false, addEventListener() {}, removeEventListener() {},
    })
  }
})

test('TRASH-PREVIEW-PRIVACY locking Trash clears the selected metadata and preview', async () => {
  const ui = await mount()
  try {
    await ui.click(ui.select('1'))
    assert.ok(ui.pane())
    const lock = [...ui.host.querySelectorAll('button')].find((button) => button.textContent.includes(t('trashLock')))
    await ui.click(lock)
    assert.equal(ui.pane(), null)
    assert.equal(ui.host.textContent.includes('one.png'), false)
    assert.equal(ui.calls.filter(({ path }) => path === '/api/trash/lock').length, 1)
  } finally { await ui.unmount() }
})
