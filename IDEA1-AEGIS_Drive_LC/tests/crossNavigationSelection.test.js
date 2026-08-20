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
let Shares
let FileHistory

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
  ;({ Shares } = await vite.ssrLoadModule('/src/screens/Shares.jsx'))
  ;({ FileHistory } = await vite.ssrLoadModule('/src/screens/FileHistory.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.__AEGIS_API_FIXTURES__
})

test('Secure Shares prefills the file selected in Files', () => {
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/files': { loading: false, data: { files: [
      { id: 'file-1', name: 'one.pdf', type: 'PDF', vault: false },
      { id: 'file-2', name: 'two.pdf', type: 'PDF', vault: false },
    ] }, error: null },
    '/api/shares': { loading: false, data: { shares: [] }, error: null },
  }
  const html = renderToStaticMarkup(React.createElement(Shares, { t, initialFileId: 'file-2' }))
  assert.match(html, /<option value="file-2" selected="">two\.pdf<\/option>/)
})

test('File History activates the file selected in Files', () => {
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/file-versions': { loading: false, data: { files: [
      { id: 'file-1', name: 'one.pdf', versionCount: 2 },
      { id: 'file-2', name: 'two.pdf', versionCount: 1 },
    ], stats: { versions: 3 } }, error: null },
    '/api/files/file-2/versions': { loading: false, data: { file: { id: 'file-2', name: 'two.pdf' }, versions: [] }, error: null },
  }
  const html = renderToStaticMarkup(React.createElement(FileHistory, { t, lang: 'en', initialFileId: 'file-2' }))
  assert.match(html, /aria-current="true"[^>]*><span[^>]*>two\.pdf/)
})
