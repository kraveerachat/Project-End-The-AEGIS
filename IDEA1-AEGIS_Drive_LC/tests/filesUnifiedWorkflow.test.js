import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockHooksPath = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))
const t = makeT('en')
let vite
let Files
let FileMenu

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })
  ;({ Files, FileMenu } = await vite.ssrLoadModule('/src/screens/Files.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.__AEGIS_API_FIXTURES__
})

test('Files is the unified workspace with search, filter, drop target, and open upload drawer', () => {
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/files': { loading: false, data: { files: [] }, error: null },
  }
  const html = renderToStaticMarkup(React.createElement(Files, {
    t,
    lang: 'en',
    go() {},
    navigationParams: { uploadOpen: true },
  }))

  assert.match(html, /Search files and folders/i)
  assert.match(html, /Filter/i)
  assert.match(html, /Drop files here/i)
  assert.match(html, /role="dialog"/)
  assert.match(html, /Destination folder/i)
  assert.match(html, /\/Files/)
})

test('file action menu exposes cross-navigation to Shares and File history', () => {
  const html = renderToStaticMarkup(React.createElement(FileMenu, { t, onAction() {}, onClose() {} }))

  assert.match(html, /Create secure share/i)
  assert.match(html, /View history/i)
})
