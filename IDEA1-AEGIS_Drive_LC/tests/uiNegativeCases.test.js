import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockHooksPath = normalizePath(path.join(root, 'tests/fixtures/mockHooks.js'))

async function renderScreen(modulePath, exportName, props, apiFixtures) {
  globalThis.__AEGIS_API_FIXTURES__ = apiFixtures
  const vite = await createServer({
    configFile: false,
    root,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })

  try {
    const module = await vite.ssrLoadModule(modulePath)
    const html = renderToStaticMarkup(React.createElement(module[exportName], props))
    return new JSDOM(html).window.document
  } finally {
    delete globalThis.__AEGIS_API_FIXTURES__
    await vite.close()
  }
}

test('Shares file picker surfaces /api/files failure instead of claiming there are no files', async () => {
  const t = makeT('en')
  const document = await renderScreen('/src/screens/Shares.jsx', 'Shares', {
    t,
    placeholderMode: false,
  }, {
    '/api/shares': { loading: false, data: { shares: [] }, error: null },
    '/api/files': { loading: false, data: null, error: 'server' },
  })

  const pickerField = document.querySelector('label[for="share-file"]')?.parentElement?.parentElement
  assert.ok(pickerField, 'share file Field must remain mounted')
  assert.ok(
    pickerField.querySelector('[role="alert"]'),
    `file picker must surface a load-failed notice; rendered ${pickerField.outerHTML}`,
  )
  assert.match(pickerField.textContent, /Could not load this screen/)
  assert.doesNotMatch(pickerField.textContent, /No files yet/)
})

test('Shares keeps a failed revoke visible as a generic localized error', async () => {
  const t = makeT('en')
  const apiFixtures = {
    '/api/shares': {
      loading: false,
      data: {
        shares: [{
          id: 's-owner', fileId: 'f-owner', fileName: 'owner-visible.txt', createdBy: 'Current User',
          authType: 'none', scope: 'any', scopeCidrs: [], hits: 0, revoked: false,
          expiresAt: Date.UTC(2026, 7, 8, 9, 0, 0), hasPassword: false, redeemable: true,
        }],
      },
      error: null,
    },
    '/api/files': { loading: false, data: { files: [] }, error: null },
  }
  globalThis.__AEGIS_API_FIXTURES__ = apiFixtures

  const vite = await createServer({
    configFile: false,
    root,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/drive/shares',
    pretendToBeVisual: true,
  })
  const previous = new Map()
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' })
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { Shares } = await vite.ssrLoadModule('/src/screens/Shares.jsx')
  const { createRoot } = await import('react-dom/client')
  const reactRoot = createRoot(document.getElementById('root'))
  try {
    await act(async () => reactRoot.render(React.createElement(Shares, { t, placeholderMode: false })))
    const revoke = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Revoke')
    assert.ok(revoke, 'owner share row must expose revoke')
    await act(async () => revoke.click())

    const confirm = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === 'Revoke permanently')
    assert.ok(confirm, 'confirmation must remain two-step')
    await act(async () => confirm.click())

    assert.deepEqual(calls, [{ url: '/api/shares/s-owner', method: 'DELETE' }])
    const alert = document.querySelector('[role="alert"]')
    assert.ok(alert, 'failed revoke must remain visible instead of silently collapsing the row')
    assert.match(alert.textContent, /The action failed/)
    assert.doesNotMatch(document.body.textContent, /belongs to|another user|expired|already revoked/i)
  } finally {
    await act(async () => reactRoot.unmount())
    globalThis.fetch = previousFetch
    delete globalThis.__AEGIS_API_FIXTURES__
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) delete globalThis[key]
      else Object.defineProperty(globalThis, key, descriptor)
    }
    dom.window.close()
    await vite.close()
  }
})

test('Dashboard on a wired fetch failure shows an error without Not connected KPI labels', async () => {
  const t = makeT('en')
  const document = await renderScreen('/src/screens/Dashboard.jsx', 'Dashboard', {
    t,
    lang: 'en',
    health: {
      loading: false,
      data: { ok: true, db: 'postgres' },
      error: null,
      retry() {},
    },
  }, {
    '/api/dashboard': { loading: false, data: null, error: 'server' },
    '/api/storage': {
      loading: false,
      data: { usage: {}, capacityBytes: { totalBytes: 0, usedBytes: 0, freeBytes: 0 } },
      error: null,
    },
  })

  assert.ok(document.querySelector('[role="alert"]'), 'genuine Dashboard failure must show the error box')
  assert.match(document.body.textContent, /Could not load this screen/)
  assert.doesNotMatch(document.body.textContent, /Not connected/)
})
