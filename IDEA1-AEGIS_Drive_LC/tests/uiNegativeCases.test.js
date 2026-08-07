import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React from 'react'
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
