// tests/vaultTreeBulkDownloadCancel.test.js — AEGIS Drive (IDEA1) · PR #334 Codex blocker 2
//
// TREE_V1 bulk download (selection bar): Cancel during the current file ends the WHOLE batch.
//   BULK-CANCEL-1 the current file's destination is aborted, never closed
//   BULK-CANCEL-2 the batch terminates: no Save picker, no metadata authentication, no chunk
//                 fetch/decrypt for any later selected file
//   BULK-CANCEL-3 the screen leaves the busy state (a new Download is accepted afterwards)
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, settle, click, unlock } from './helpers/vaultScreenHarness.js'

const t = makeT('en')

let env
let dom
let kek

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom } = env)
  kek = await (await env.load('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
})
after(async () => {
  await env?.stop()
  delete globalThis.__VAULT_BACKEND__
  delete globalThis.showSaveFilePicker
})

const doc = () => dom.window.document
const q = (sel) => doc().querySelector(sel)
const qa = (sel) => [...doc().querySelectorAll(sel)]
const fileTiles = () => qa('[data-testid="vault-file-tile"]')
const panel = () => q('[data-vault-transfer="download"]')

let backend
let fakeTree

beforeEach(() => {
  backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
  globalThis.__VAULT_BACKEND__ = backend
  delete globalThis.showSaveFilePicker
})

function wireBridge() {
  const inner = backend.respond
  backend.respond = async (req) => {
    const p = String(req.path)
    if (p.startsWith('/api/vault/tree/') && !p.startsWith('/api/vault/tree/state') && !p.startsWith('/api/vault/tree/migration')) {
      return fakeTree.fetchJson(p, { method: req.method, body: req.options?.body, signal: req.options?.signal })
    }
    return inner(req)
  }
  const innerBytes = backend.respondBytes
  backend.respondBytes = async (req) => {
    const p = String(req.path)
    if (p.startsWith('/api/vault/tree/')) return fakeTree.fetchBytes(p, { signal: req.options?.signal })
    return innerBytes?.(req)
  }
}

async function tick(times = 3) {
  for (let i = 0; i < times; i += 1) await settle()
}

test('BULK-CANCEL-1..3 Cancel during a multi-file download aborts the current file and stops the batch', async () => {
  const names = ['a.bin', 'b.bin', 'c.bin']
  const ids = Object.fromEntries(names.map((n, i) => [n, `B${i}`.padEnd(22, 'B')]))
  fakeTree = await createFakeTreeServer({ kek, blobs: names.map((n) => ({ formatVersion: 2, id: ids[n] })) })
  wireBridge()
  backend.uploadImpl = async ({ file }) => ({ ok: true, stage: 'complete', blob: { id: ids[file.name], formatVersion: 2 } })
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: names.map((n) => serverBlobV2({ id: ids[n], name: n, type: 'application/octet-stream', plainSize: 64, chunkCount: 4, size: 128 })) },
    error: null,
  }
  backend.streamingSink = true

  const pickerCalls = []
  const writables = []
  globalThis.showSaveFilePicker = (opts) => {
    pickerCalls.push(opts.suggestedName)
    const w = { closed: false, aborted: false }
    writables.push(w)
    return Promise.resolve({
      createWritable: async () => ({
        async write() {},
        async close() { w.closed = true },
        async abort() { w.aborted = true },
      }),
    })
  }
  let chunkWork = 0
  backend.downloadImpl = async ({ sink, signal }) => {
    chunkWork += 1 // stands in for the per-chunk fetch/decrypt/write loop of downloadVaultV2
    await new Promise((r) => { signal?.addEventListener('abort', r) })
    await sink.abort()
    return { ok: false, reason: 'cancelled' }
  }

  const h = env.mount()
  await h.render(React.createElement((await env.load('/src/screens/Vault.jsx')).Vault, { t }))
  try {
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await tick(6)
    const dropEv = new dom.window.Event('drop', { bubbles: true })
    Object.defineProperty(dropEv, 'dataTransfer', {
      value: { types: ['Files'], files: names.map((n) => new dom.window.File(['x'], n, { type: 'application/octet-stream' })) },
    })
    await act(async () => q('[data-testid="vault-tree-screen"]').dispatchEvent(dropEv))
    await tick(6)
    for (const n of names) {
      const tile = fileTiles().find((el) => el.textContent.includes(n))
      assert.ok(tile, `${n} attached`)
      await click(dom, tile.querySelector('[data-testid="vault-tree-tile-checkbox"]'))
    }
    backend.downloadEvents = []
    await click(dom, q('[data-testid="vault-tree-bulk-download"]'))
    await tick(4)
    assert.equal(pickerCalls.length, 1, 'first file picker opened')
    assert.equal(panel()?.getAttribute('data-vault-transfer-stage'), 'downloading')

    await click(dom, qa('button').find((b) => b.textContent.trim() === t('vaultXferCancel')))
    await tick(8)

    assert.equal(writables[0].aborted, true, 'BULK-CANCEL-1 current destination aborted')
    assert.equal(writables[0].closed, false, 'BULK-CANCEL-1 current destination never closed')
    assert.equal(pickerCalls.length, 1, `BULK-CANCEL-2 no picker for a later file (saw ${pickerCalls.join(', ')})`)
    assert.equal(chunkWork, 1, 'BULK-CANCEL-2 no fetch/decrypt for a later file')
    assert.deepEqual(
      backend.downloadEvents.filter((e) => e === 'meta-auth' || e === 'download'),
      ['meta-auth', 'download'],
      'BULK-CANCEL-2 no metadata authentication or transfer for a later file',
    )
    assert.equal(panel(), null, 'cancel is not shown as a failure')

    // BULK-CANCEL-3: the batch released the busy state — a new Download starts a picker
    await click(dom, q('[data-testid="vault-tree-bulk-download"]'))
    await tick(4)
    assert.equal(pickerCalls.length, 2, 'BULK-CANCEL-3 a new download is accepted after the cancelled batch')
    await click(dom, qa('button').find((b) => b.textContent.trim() === t('vaultXferCancel')))
    await tick(8)
  } finally {
    await h.unmount()
  }
})
