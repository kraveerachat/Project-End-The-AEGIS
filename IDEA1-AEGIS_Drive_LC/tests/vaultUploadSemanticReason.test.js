import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { buildTree, ID, NOW } from './helpers/vaultTreeTrees.mjs'
import { intents, applyIntent, OpError } from '../src/lib/vaultTreeOps.js'
import { treeLimitsFrom } from '../src/lib/vaultTreeLimits.js'
import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = ID(0)
const EXISTING = ID(1, 'F')
const LIMITS = treeLimitsFrom({ maxNodes: 20, maxDepth: 4, maxNameBytes: 120, maxRecentOperationIds: 10 })
const options = (nodeId = ID(10, 'N')) => ({ now: NOW + 1, newNodeId: () => nodeId, limits: LIMITS })
const manifest = () => buildTree([[EXISTING, 'file', ROOT, 'example.jpg']])
const attach = (name, blobId) => intents.attachBlob({
  parentNodeId: ROOT,
  name,
  mediaType: 'image/jpeg',
  plainSize: 42,
  blobRef: { formatVersion: 2, id: blobId },
})

let vite
let UploadStatusRow

before(async () => {
  vite = await createServer({
    configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent',
    plugins: [reactPlugin()], server: { middlewareMode: true }, optimizeDeps: { noDiscovery: true, include: [] },
  })
  ;({ UploadStatusRow } = await vite.ssrLoadModule('/src/components/UploadStatusTray.jsx'))
})

after(async () => { await vite?.close() })

function collisionCode(name, blobId) {
  try {
    applyIntent(manifest(), attach(name, blobId), options())
    return null
  } catch (error) {
    assert.ok(error instanceof OpError)
    return error.code
  }
}

test('VUSR-1 attach preserves semantic COLLISION for exact and case-folded names; a different name succeeds without overwrite or implicit rename', () => {
  assert.equal(collisionCode('example.jpg', 'exact-collision'), 'COLLISION')
  assert.equal(collisionCode('EXAMPLE.JPG', 'casefold-collision'), 'COLLISION')

  const beforeManifest = manifest()
  const result = applyIntent(beforeManifest, attach('different.jpg', 'different-blob'), options())
  assert.equal(beforeManifest.nodes.get(EXISTING).name, 'example.jpg', 'existing item remains untouched')
  assert.equal(result.manifest.nodes.get(EXISTING).name, 'example.jpg', 'existing item is not overwritten')
  assert.equal(result.manifest.nodes.get(ID(10, 'N')).name, 'different.jpg', 'successful name is not implicitly renamed')
})

test('VUSR-2 failed Vault upload renders the localized actionable COLLISION reason', async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
  const previous = new Map()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  try {
    const root = createRoot(document.getElementById('root'))
    await act(async () => {
      root.render(React.createElement(UploadStatusRow, {
        t: makeT('th'),
        entry: { id: 'u1', name: 'example.jpg', size: 42, stage: 'failed', reason: 'COLLISION', progress: null, chunkCount: 0, transferredBytes: 0, file: null },
        onCancel() {}, onRetry() {}, onDismiss() {}, onRecover() {}, onDiscard() {},
      }))
    })
    assert.match(document.body.textContent, /มีไฟล์ชื่อนี้อยู่แล้ว/)
    await act(async () => root.unmount())
  } finally {
    dom.window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
