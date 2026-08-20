import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')
let vite
let UploadDrawer

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
  })
  ;({ UploadDrawer } = await vite.ssrLoadModule('/src/components/UploadDrawer.jsx'))
})

after(async () => {
  await vite?.close()
})

test('Upload Drawer truthfully shows the current destination and keeps recent uploads in Files', () => {
  const html = renderToStaticMarkup(React.createElement(UploadDrawer, {
    t,
    open: true,
    destination: '/Files',
    onClose() {},
    recentFiles: [],
  }))

  assert.match(html, /role="dialog"/)
  assert.match(html, /Upload files/i)
  assert.match(html, /Destination folder/i)
  assert.match(html, /\/Files/)
  assert.match(html, /Recent uploads/i)
  assert.match(html, /No uploads yet/i)
  assert.doesNotMatch(html, /0 Mbps|0 ms|0 °C/)
})

test('closed drawer leaves a non-intrusive queue launcher when work remains', () => {
  const html = renderToStaticMarkup(React.createElement(UploadDrawer, {
    t,
    open: false,
    destination: '/Files',
    onOpen() {},
    onClose() {},
    recentFiles: [],
    initialQueue: [{ id: 'q1', name: 'report.pdf', size: 42, stage: 'waiting', progress: null }],
  }))

  assert.match(html, /Upload queue/i)
  assert.match(html, /1/)
})
