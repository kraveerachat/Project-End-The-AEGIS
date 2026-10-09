import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { makeT } from '../src/lib/strings.js'
import { makeVaultTreeBackend, CORRECT_PASSPHRASE, serverBlobV2 } from './fixtures/vaultTreeBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, unlock, settle } from './helpers/vaultScreenHarness.js'

test('PIT-SCREEN-3 verified derivative renders without original I/O; a miss enters original path', async () => {
  const env = await startVaultScreenEnv({ previewIndexTilesStub: true })
  const t = makeT('en')
  const blobId = 'D1B'.padEnd(22, 'D')
  const fallbackBlobId = 'D1C'.padEnd(22, 'C')
  const kek = await (await env.load('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
  const fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id: blobId }, { formatVersion: 2, id: fallbackBlobId }] })
  const backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true, mediaPreviewEnabled: true, previewIndexReadEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
  backend.state['/api/vault'] = { loading: false, data: { configured: true, blobs: [
    serverBlobV2({ id: blobId, name: 'photo.jpg', type: 'image/jpeg', plainSize: 300 * 1024 * 1024 }),
    serverBlobV2({ id: fallbackBlobId, name: 'fallback.jpg', type: 'image/jpeg', plainSize: 64 }),
  ] }, error: null }
  backend.indexTile = async (node) => node.blobRef.id === blobId
    ? { width: 2, height: 2, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg' } : null
  const inner = backend.respond
  backend.respond = (req) => String(req.path).startsWith('/api/vault/tree/') && !String(req.path).startsWith('/api/vault/tree/state') && !String(req.path).startsWith('/api/vault/tree/migration')
    ? fakeTree.fetchJson(String(req.path), { method: req.method, body: req.options?.body, signal: req.options?.signal }) : inner(req)
  const innerBytes = backend.respondBytes
  backend.respondBytes = (req) => String(req.path).startsWith('/api/vault/tree/')
    ? fakeTree.fetchBytes(String(req.path), { signal: req.options?.signal }) : innerBytes?.(req)
  globalThis.__VAULT_BACKEND__ = backend

  let h
  try {
    const sync = await env.load('/src/lib/vaultTreeSync.js')
    const api = await env.load('/src/lib/vaultTreeApi.js')
    const ops = await env.load('/src/lib/vaultTreeOps.js')
    const seed = sync.createTreeSession({ kek, api })
    const start = await seed.loadHead()
    await seed.commit(ops.intents.attachBlob({ parentNodeId: start.manifest.rootNodeId, name: 'photo.jpg', mediaType: 'image/jpeg', plainSize: 300 * 1024 * 1024, blobRef: { formatVersion: 2, id: blobId } }))
    await seed.commit(ops.intents.attachBlob({ parentNodeId: start.manifest.rootNodeId, name: 'fallback.jpg', mediaType: 'image/jpeg', plainSize: 64, blobRef: { formatVersion: 2, id: fallbackBlobId } }))

    h = env.mount()
    await h.render(React.createElement(env.Vault, { t }))
    await unlock(env.dom, t, CORRECT_PASSPHRASE)
    for (let i = 0; i < 10; i++) await settle()
    assert.ok(env.dom.window.document.querySelector('[data-testid="vault-tree-tile-poster"]'), 'derivative tile is rendered')
    assert.ok(backend.indexLoads >= 1)
    assert.ok(backend.indexAttempts >= 1)
    assert.equal(backend.requests.filter((r) => String(r.path).includes(`/api/vault/blobs/${blobId}/chunks/`)).length, 0, 'original blob never fetched')
    assert.ok(backend.requests.some((r) => String(r.path).includes(`/api/vault/blobs/${fallbackBlobId}/chunks/`)), 'miss uses original blob path')
    assert.equal(backend.requests.filter((r) => String(r.path).includes('/preview-sessions')).length, 0)
  } finally {
    await h?.unmount()
    await env.stop()
    delete globalThis.__VAULT_BACKEND__
  }
})
