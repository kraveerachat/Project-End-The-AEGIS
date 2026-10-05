// tests/vaultTreeBulkZipDefaultOff.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 11b (PR-1)
//
// The implementation lands with BULK_ZIP_ENABLED = false: with no override, 4+ Vault files keep the
// per-file path exactly as #334 shipped it — no confirmation dialog, one picker per file.
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import React from 'react'

import { makeT } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, settle, click, unlock } from './helpers/vaultScreenHarness.js'

const t = makeT('en')
let env
let dom

before(async () => { env = await startVaultScreenEnv(); ({ dom } = env) })
after(async () => { await env?.stop(); delete globalThis.__VAULT_BACKEND__; delete globalThis.showSaveFilePicker })

test('VZS-OFF-1 default off: 4 Vault files download per file with no dialog', async () => {
  const { BULK_ZIP_ENABLED } = await env.load('/src/lib/bulkDownloadPlan.js')
  assert.equal(BULK_ZIP_ENABLED, false)
  const kek = await (await env.load('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
  const sync = await env.load('/src/lib/vaultTreeSync.js')
  const api = await env.load('/src/lib/vaultTreeApi.js')
  const ops = await env.load('/src/lib/vaultTreeOps.js')
  const names = ['a.bin', 'b.bin', 'c.bin', 'd.bin']
  const idOf = (n) => `O${n.replace(/\W/g, '')}`.padEnd(22, 'o')
  const fakeTree = await createFakeTreeServer({ kek, blobs: names.map((n) => ({ formatVersion: 2, id: idOf(n) })) })
  const backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
  backend.streamingSink = true
  const inner = backend.respond
  backend.respond = async (req) => {
    const p = String(req.path)
    if (p.startsWith('/api/vault/tree/') && !p.startsWith('/api/vault/tree/state') && !p.startsWith('/api/vault/tree/migration')) {
      return fakeTree.fetchJson(p, { method: req.method, body: req.options?.body, signal: req.options?.signal })
    }
    return inner(req)
  }
  backend.respondBytes = async (req) => (String(req.path).startsWith('/api/vault/tree/') ? fakeTree.fetchBytes(String(req.path), {}) : undefined)
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: names.map((n) => serverBlobV2({ id: idOf(n), name: 'env', plainSize: 4, chunkCount: 1, size: 20 })) },
    error: null,
  }
  globalThis.__VAULT_BACKEND__ = backend
  const s2 = sync.createTreeSession({ kek, api })
  const head = await s2.loadHead()
  for (const n of names) {
    await s2.commit(ops.intents.attachBlob({
      parentNodeId: head.manifest.rootNodeId, name: n, mediaType: 'application/octet-stream', plainSize: 4,
      blobRef: { formatVersion: 2, id: idOf(n) },
    }))
  }
  const pickers = []
  globalThis.showSaveFilePicker = (o) => {
    pickers.push(o.suggestedName)
    return Promise.resolve({ createWritable: async () => ({ async write() {}, async close() {}, async abort() {} }) })
  }
  const h = env.mount()
  await h.render(React.createElement((await env.load('/src/screens/Vault.jsx')).Vault, { t }))
  try {
    await unlock(dom, t, CORRECT_PASSPHRASE)
    for (let i = 0; i < 5; i += 1) await settle()
    const doc = dom.window.document
    for (const n of names) {
      const tile = [...doc.querySelectorAll('[data-testid="vault-file-tile"]')].find((el) => el.textContent.includes(n))
      await click(dom, tile.querySelector('[data-testid="vault-tree-tile-checkbox"]'))
    }
    await click(dom, doc.querySelector('[data-testid="vault-tree-bulk-download"]'))
    for (let i = 0; i < 8; i += 1) await settle()
    assert.equal(doc.querySelectorAll('[data-testid="vault-zip-export"]').length, 0, 'no confirmation dialog')
    assert.deepEqual(pickers, names, 'one picker per file, as before')
  } finally {
    await h.unmount()
  }
})
