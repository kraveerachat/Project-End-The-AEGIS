// tests/vaultTreeDownloadProgress.test.js — AEGIS Drive (IDEA1) · Private Vault large-download UX (TREE_V1)
//
// Screen wiring for the TREE_V1 V2 download (the real ordering + crypto is pinned with real modules in
// vaultDownloadPickerFirst.test.js):
//   TD-1 treeDownloadEntry requests the Save picker synchronously — no metadata decrypt before it —
//        then authenticates metadata, then opens the writable, then streams
//   TD-2 a metadata envelope that fails authentication opens no writable and starts no download
//   TD-3 the tile menu Download reaches the picker inside the same synchronous click turn
//   TD-4 after the picker, a truthful progress panel shows real bytes/percent from onProgress and
//        disappears on success; a second click while busy is announced, not silently dropped
//   TD-5 a failure mid-stream shows the failed stage; Cancel aborts the destination (no close)
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, settle, click, unlock } from './helpers/vaultScreenHarness.js'

const t = makeT('en')
const MiB = 1024 * 1024

let env
let dom
let kek
let screen

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom } = env)
  kek = await (await env.load('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
  screen = await env.load('/src/screens/VaultTreeScreen.jsx')
})
after(async () => {
  await env?.stop()
  delete globalThis.__VAULT_BACKEND__
  delete globalThis.showSaveFilePicker
})

const doc = () => dom.window.document
const q = (sel) => doc().querySelector(sel)
const qa = (sel) => [...doc().querySelectorAll(sel)]
const menuItem = (action) => qa('[role="menuitem"]').find((el) => el.getAttribute('data-action') === action)
const tileMenuButton = (nodeId) => qa('[data-vault-tile-menu]').find((b) => b.getAttribute('data-vault-tile-menu') === nodeId)
const fileTiles = () => qa('[data-testid="vault-file-tile"]')
const panel = () => q('[data-vault-transfer="download"]')
const noticeText = () => q('[data-testid="vault-tree-notice"]')?.textContent ?? ''

let backend
let fakeTree

beforeEach(async () => {
  fakeTree = await createFakeTreeServer({ kek })
  backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
  wireBridge()
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

/** Fake File System Access picker that records order into backend.downloadEvents. */
function installPicker() {
  const writable = { writes: [], closed: false, aborted: false }
  const calls = []
  globalThis.showSaveFilePicker = (opts) => {
    calls.push({ opts, inSyncTurn: syncTurn })
    return Promise.resolve({
      createWritable: async () => ({
        async write(bytes) { writable.writes.push(bytes.length) },
        async close() { writable.closed = true },
        async abort() { writable.aborted = true },
      }),
    })
  }
  return { writable, calls }
}
let syncTurn = false

const LARGE = Math.round(1.1 * 1024 * MiB)

test('TD-1 treeDownloadEntry: picker synchronously, then metadata auth, then writable, then stream', async () => {
  backend.streamingSink = true
  backend.downloadEvents = []
  const { writable, calls } = installPicker()
  const id = 'L1'.padEnd(22, 'L')
  const node = { nodeId: 'N'.repeat(22), kind: 'file', name: 'movie.mkv', plainSize: LARGE, blobRef: { formatVersion: 2, id } }
  const blob = serverBlobV2({ id, name: 'envelope.mkv', type: 'video/x-matroska', plainSize: LARGE, size: LARGE + 71 * 16, chunkCount: 71 })
  backend.downloadImpl = async ({ sink, onProgress }) => {
    await sink.write(new Uint8Array(4))
    onProgress?.({ chunkIndex: 0, chunkCount: 71, bytesWritten: 4, totalBytes: LARGE, percent: 0 })
    await sink.close()
    return { ok: true, chunksRead: 71, bytesWritten: LARGE }
  }
  const timings = []
  const failures = []
  syncTurn = true
  const p = screen.treeDownloadEntry({
    t, lang: 'en', kek, node, blob, onFailed: (c) => failures.push(c), onTiming: (name) => timings.push(name),
  })
  syncTurn = false
  assert.equal(calls.length, 1, 'picker requested before treeDownloadEntry yields')
  assert.equal(calls[0].inSyncTurn, true, 'inside the click turn — nothing awaited before it')
  assert.equal(calls[0].opts.suggestedName, 'movie.mkv', 'suggestedName from the manifest, not the envelope')
  assert.deepEqual(backend.downloadEvents, ['picker-request'], 'no metadata work happened before the picker')
  await p
  assert.deepEqual(failures, [])
  assert.deepEqual(backend.downloadEvents, ['picker-request', 'meta-auth', 'create-writable', 'download'])
  assert.equal(writable.closed, true)
  assert.deepEqual(timings.slice(0, 4), ['DOWNLOAD_CLICK_TS', 'PICKER_REQUEST_TS', 'PICKER_RETURN_TS', 'META_AUTH_DONE_TS'])
})

test('TD-2 metadata that fails authentication opens no writable and starts no download', async () => {
  backend.streamingSink = true
  backend.metaAuthFails = true
  backend.downloadEvents = []
  installPicker()
  const id = 'L2'.padEnd(22, 'L')
  const node = { nodeId: 'O'.repeat(22), kind: 'file', name: 'x.bin', plainSize: 64, blobRef: { formatVersion: 2, id } }
  const failures = []
  await screen.treeDownloadEntry({ t, lang: 'en', kek, node, blob: serverBlobV2({ id, name: 'x', plainSize: 64, size: 80 }), onFailed: (c) => failures.push(c) })
  assert.deepEqual(failures, ['DOWNLOAD'])
  assert.deepEqual(backend.downloadEvents, ['picker-request'])
})

async function mountWithFile(name, plainSize, chunkCount) {
  const id = 'T1'.padEnd(22, 'T')
  fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id }] })
  wireBridge()
  backend.uploadImpl = async () => ({ ok: true, stage: 'complete', blob: { id, formatVersion: 2 } })
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: [serverBlobV2({ id, name: 'envelope', type: 'video/mp4', plainSize, size: plainSize + chunkCount * 16, chunkCount })] },
    error: null,
  }
  const h = env.mount()
  await h.render(React.createElement((await env.load('/src/screens/Vault.jsx')).Vault, { t }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  await tick(6)
  const dropEv = new dom.window.Event('drop', { bubbles: true })
  Object.defineProperty(dropEv, 'dataTransfer', {
    value: { types: ['Files'], files: [new dom.window.File(['x'], name, { type: 'video/mp4' })] },
  })
  await act(async () => q('[data-testid="vault-tree-screen"]').dispatchEvent(dropEv))
  await tick(4)
  const tile = fileTiles().find((el) => el.textContent.includes(name))
  assert.ok(tile, 'file attached')
  return { h, nodeId: tile.getAttribute('data-node-id') }
}

/** Click the tile menu's Download item, recording whether the picker ran inside that click. */
async function clickDownload(nodeId) {
  await click(dom, tileMenuButton(nodeId))
  const item = menuItem('download')
  assert.ok(item, 'Download menu item')
  await act(async () => {
    syncTurn = true
    item.click()
    syncTurn = false
  })
}

test('TD-3 + TD-4 menu Download: picker in the click turn, real progress panel, busy click announced', async () => {
  backend.streamingSink = true
  const { writable, calls } = installPicker()
  let step
  const steps = []
  backend.downloadImpl = async ({ sink, onProgress, signal }) => {
    const total = 4 * 16
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => { step = r; steps.push(i) })
      if (signal?.aborted) { await sink.abort(); return { ok: false, reason: 'cancelled' } }
      await sink.write(new Uint8Array(16))
      onProgress?.({ chunkIndex: i, chunkCount: 4, bytesWritten: (i + 1) * 16, totalBytes: total, percent: ((i + 1) / 4) * 100 })
    }
    await sink.close()
    return { ok: true, chunksRead: 4, bytesWritten: total }
  }
  const { h, nodeId } = await mountWithFile('clip.mp4', 64, 4)
  try {
    await clickDownload(nodeId)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].inSyncTurn, true, 'menu dispatch reaches the picker synchronously (no deferred dispatch)')
    assert.equal(calls[0].opts.suggestedName, 'clip.mp4')
    await tick(3)
    assert.ok(panel(), 'progress panel appears right after the destination is chosen')
    assert.equal(panel().getAttribute('data-vault-transfer-stage'), 'downloading')
    const seen = []
    for (let i = 0; i < 2; i += 1) {
      step()
      await tick(2)
      const bytes = Number(q('[data-vault-transfer-bytes]').getAttribute('data-vault-transfer-bytes'))
      const pct = Number(q('[role="progressbar"]').getAttribute('aria-valuenow'))
      seen.push([bytes, pct])
    }
    assert.deepEqual(seen, [[16, 25], [32, 50]], 'panel numbers come from onProgress — monotonic, real bytes')
    assert.equal(q('[data-vault-transfer-total]').getAttribute('data-vault-transfer-total'), '64')

    // second click while busy: told, not ignored; no second picker
    await clickDownload(nodeId)
    await tick(2)
    assert.equal(calls.length, 1, 'no second picker while a download is active')
    assert.match(noticeText(), new RegExp(t('vaultTreeDownloadBusy').slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))

    step(); await tick(2)
    step(); await tick(4)
    assert.equal(writable.closed, true)
    assert.equal(writable.aborted, false)
    assert.equal(panel(), null, 'panel disappears after authenticated completion')
  } finally {
    await h.unmount()
  }
})

test('TD-5 mid-stream failure shows the failed stage; Cancel aborts the destination without close', async () => {
  backend.streamingSink = true
  const { writable } = installPicker()
  let fail = true
  let release
  backend.downloadImpl = async ({ sink, onProgress, signal }) => {
    await sink.write(new Uint8Array(16))
    onProgress?.({ chunkIndex: 0, chunkCount: 4, bytesWritten: 16, totalBytes: 64, percent: 25 })
    if (fail) { await sink.abort(); return { ok: false, reason: 'auth-failed', chunksRead: 1, bytesWritten: 16 } }
    await new Promise((r) => { release = r; signal?.addEventListener('abort', r) })
    if (signal?.aborted) { await sink.abort(); return { ok: false, reason: 'cancelled' } }
    await sink.close()
    return { ok: true }
  }
  const { h, nodeId } = await mountWithFile('clip2.mp4', 64, 4)
  try {
    await clickDownload(nodeId)
    await tick(4)
    assert.equal(panel()?.getAttribute('data-vault-transfer-stage'), 'failed', 'failure is shown, not hidden')
    assert.equal(writable.closed, false)
    assert.equal(writable.aborted, true)
    await click(dom, qa('button').find((b) => b.textContent.trim() === t('vaultXferDismiss')))
    assert.equal(panel(), null)

    fail = false
    writable.aborted = false
    await clickDownload(nodeId)
    await tick(3)
    assert.equal(panel()?.getAttribute('data-vault-transfer-stage'), 'downloading')
    await click(dom, qa('button').find((b) => b.textContent.trim() === t('vaultXferCancel')))
    await tick(4)
    assert.equal(writable.aborted, true, 'Cancel aborts the destination')
    assert.equal(writable.closed, false, 'never closed as complete')
    assert.equal(panel(), null, 'a user cancel is not reported as a failure')
    release?.()
  } finally {
    await h.unmount()
  }
})
