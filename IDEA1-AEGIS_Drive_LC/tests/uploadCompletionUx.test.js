import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let vite
let UploadDrawer
let activeUploadCount
let failedUploadCount
let shouldShowQueueLauncher
let dom

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ UploadDrawer, activeUploadCount, failedUploadCount, shouldShowQueueLauncher } = await vite.ssrLoadModule('/src/components/UploadDrawer.jsx'))
})

after(async () => {
  await vite?.close()
})

test('active upload count includes only work that is still progressing', () => {
  const queue = [
    { stage: 'waiting' },
    { stage: 'processing' },
    { stage: 'uploading' },
    { stage: 'complete' },
    { stage: 'failed' },
    { stage: 'cancelled' },
  ]
  assert.equal(activeUploadCount(queue), 3)
  assert.equal(failedUploadCount(queue), 1)
})

test('complete-only history does not leave an active queue launcher', () => {
  const completedHistory = [{ id: 'done-1', name: 'report.pdf', stage: 'complete' }]
  assert.equal(completedHistory.length, 1)
  assert.equal(activeUploadCount(completedHistory), 0)
  assert.equal(shouldShowQueueLauncher(completedHistory), false)
})

test('one active item plus one completed history item reports an active count of one', () => {
  const queue = [{ stage: 'uploading' }, { stage: 'complete' }]
  assert.equal(activeUploadCount(queue), 1)
  assert.equal(shouldShowQueueLauncher(queue), true)
})

test('failed uploads remain an explicit attention state without becoming active work', () => {
  const queue = [{ stage: 'failed' }]
  assert.equal(activeUploadCount(queue), 0)
  assert.equal(failedUploadCount(queue), 1)
  assert.equal(shouldShowQueueLauncher(queue), true)
})

test('waiting, processing, and uploading states keep the launcher visible', () => {
  for (const stage of ['waiting', 'processing', 'uploading']) {
    assert.equal(shouldShowQueueLauncher([{ stage }]), true)
  }
})

test('cancelled-only history does not leave a launcher', () => {
  assert.equal(shouldShowQueueLauncher([{ stage: 'cancelled' }]), false)
})

test('successful upload announces the localized filename exactly once across rerenders', async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, FormData: globalThis.FormData }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.FormData = dom.window.FormData
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  const file = new dom.window.File(['report'], 'report.pdf', { type: 'application/pdf' })
  const props = {
    t: makeT('th'),
    open: false,
    onOpen() {},
    onClose() {},
    initialFiles: [file],
    requestId: 17,
    hashFile: async () => 'abc123',
    uploadFile: async () => ({ ok: true }),
  }
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => {
      root.render(React.createElement(UploadDrawer, props))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await act(async () => {
      root.render(React.createElement(UploadDrawer, props))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const statuses = [...document.querySelectorAll('[role="status"]')]
    assert.equal(statuses.length, 1)
    assert.match(statuses[0].textContent, /report\.pdf/)
    assert.match(statuses[0].textContent, /อัปโหลด.*สำเร็จ/)
    assert.equal(document.body.textContent.includes('คิวอัปโหลด 1'), false)
  } finally {
    await act(async () => root.unmount())
    globalThis.window = previous.window
    globalThis.document = previous.document
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true })
    globalThis.FormData = previous.FormData
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})

test('failed upload never emits a success notification', async () => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = { window: globalThis.window, document: globalThis.document, navigator: globalThis.navigator, FormData: globalThis.FormData }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.FormData = dom.window.FormData
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(document.getElementById('root'))
  try {
    await act(async () => {
      root.render(React.createElement(UploadDrawer, {
        t: makeT('en'), open: false, onOpen() {}, onClose() {},
        initialFiles: [new dom.window.File(['bad'], 'bad.pdf')], requestId: 18,
        hashFile: async () => 'abc123', uploadFile: async () => ({ ok: false }),
      }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.equal(document.querySelectorAll('[role="status"]').length, 0)
    assert.match(document.body.textContent, /needs attention/i)
  } finally {
    await act(async () => root.unmount())
    globalThis.window = previous.window
    globalThis.document = previous.document
    Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true })
    globalThis.FormData = previous.FormData
    delete globalThis.IS_REACT_ACT_ENVIRONMENT
    dom.window.close()
  }
})
