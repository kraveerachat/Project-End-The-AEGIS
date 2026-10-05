// tests/vaultTreeBulkZip.test.js — AEGIS Drive (IDEA1) · multi-file streaming ZIP, Task 11b
//
// VaultTreeScreen with the feature switched on (harness option `bulkZipEnabled`, PR-1 keeps it off by default):
//   • 1–3 files keep the #334 per-file path (one picker per file)
//   • 4+ V2 files open the plaintext-export confirmation (D-3) with no picker and no fetch on open
//   • the dialog hold (SC-2) blocks a second dialog / tile download, never Confirm; Cancel/Escape/lock release it
//   • Confirm reaches showSaveFilePicker synchronously, exactly once; a stale Confirm after lock is a no-op
//   • the plan is an immutable snapshot of copies (I-4); V1 in 4+ is refused (D-1); missing blobs are
//     unavailable before the threshold (M-5); folders are skipped with a notice
//   • the transfer panel shows archive stages; Cancel stops the archive; finalizing has no Cancel
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE, serverBlob, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, settle, click, pressKey, type, unlock, lockVault } from './helpers/vaultScreenHarness.js'
import {
  createDownloadStreamWorkerState, handleDownloadStreamFetch, handleDownloadStreamMessage,
} from '../src/lib/downloadStreamWorkerState.js'

const t = makeT('en')

let env
let dom
let kek
let modules

before(async () => {
  env = await startVaultScreenEnv({ bulkZipEnabled: true })
  ;({ dom } = env)
  kek = await (await env.load('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
  modules = {
    sync: await env.load('/src/lib/vaultTreeSync.js'),
    api: await env.load('/src/lib/vaultTreeApi.js'),
    ops: await env.load('/src/lib/vaultTreeOps.js'),
  }
})
after(async () => {
  await env?.stop()
  delete globalThis.__VAULT_BACKEND__
  delete globalThis.showSaveFilePicker
})

const doc = () => dom.window.document
const q = (sel) => doc().querySelector(sel)
const qa = (sel) => [...doc().querySelectorAll(sel)]
const notice = () => q('[data-testid="vault-tree-notice"]')?.textContent ?? ''
const panel = () => q('[data-vault-transfer="download"]')
const dialogOpen = () => qa('[data-testid="vault-zip-export"]').length
const button = (label) => qa('button').find((b) => b.textContent.trim() === label)

let backend
let fakeTree

beforeEach(() => {
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

const idOf = (name) => `I${name.replace(/\W/g, '')}`.padEnd(22, 'q').slice(0, 22)

/**
 * Seeds the tree as "another device" before mount: V2 files (4 bytes each, which is exactly what the
 * fixture download writes per chunk), optional V1 files, folders, and blobs missing from the inventory.
 */
async function seed({ files = [], v1 = [], folders = [], missingBlob = [] }) {
  const all = [...files, ...v1, ...missingBlob]
  fakeTree = await createFakeTreeServer({
    kek, blobs: all.map((n) => ({ formatVersion: v1.includes(n) ? 1 : 2, id: idOf(n) })),
  })
  backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
  backend.streamingSink = true
  backend.downloadEvents = []
  wireBridge()
  globalThis.__VAULT_BACKEND__ = backend
  backend.state['/api/vault'] = {
    loading: false,
    data: {
      configured: true,
      blobs: [
        ...files.map((n) => serverBlobV2({ id: idOf(n), name: 'env', type: 'application/octet-stream', plainSize: 4, chunkCount: 1, size: 20 })),
        ...v1.map((n) => serverBlob({ id: idOf(n), name: 'env', type: 'application/octet-stream', plainSize: 4, size: 32 })),
      ],
    },
    error: null,
  }
  const s2 = modules.sync.createTreeSession({ kek, api: modules.api })
  const head = await s2.loadHead()
  const rootId = head.manifest.rootNodeId
  for (const f of folders) await s2.commit(modules.ops.intents.createFolder({ parentNodeId: rootId, name: f }))
  for (const n of all) {
    await s2.commit(modules.ops.intents.attachBlob({
      parentNodeId: rootId, name: n, mediaType: 'application/octet-stream', plainSize: 4,
      blobRef: { formatVersion: v1.includes(n) ? 1 : 2, id: idOf(n) },
    }))
  }
}

async function mount() {
  const h = env.mount()
  await h.render(React.createElement((await env.load('/src/screens/Vault.jsx')).Vault, { t }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  await tick(5)
  return h
}

const fileTile = (name) => qa('[data-testid="vault-file-tile"]').find((el) => el.textContent.includes(name))
const folderTile = (name) => qa('[data-testid="vault-folder-tile"]').find((el) => el.textContent.includes(name))
async function selectAll(names, folderNames = []) {
  for (const n of names) {
    const tile = fileTile(n)
    assert.ok(tile, `${n} rendered`)
    await click(dom, tile.querySelector('[data-testid="vault-tree-tile-checkbox"]'))
  }
  for (const f of folderNames) await click(dom, folderTile(f).querySelector('[data-testid="vault-tree-tile-checkbox"]'))
}
const bulkDownload = () => click(dom, q('[data-testid="vault-tree-bulk-download"]'))

/** A File System Access fake that logs pickers/writables; `holdPicker` keeps the picker promise pending. */
function installPicker({ holdPicker = false, closeError = null, writeError = null } = {}) {
  const log = { pickers: [], writables: [] }
  let releasePicker
  globalThis.showSaveFilePicker = (opts) => {
    log.pickers.push(opts)
    const w = { bytes: 0, closed: false, aborted: false }
    log.writables.push(w)
    const handle = {
      createWritable: async () => ({
        async write(b) { if (writeError) throw writeError; w.bytes += b.length },
        async close() { if (closeError) throw closeError; w.closed = true },
        async abort() { w.aborted = true },
      }),
    }
    if (holdPicker) return new Promise((r) => { releasePicker = () => r(handle) })
    return Promise.resolve(handle)
  }
  return { log, release: () => releasePicker?.() }
}

const FIVE = ['a.bin', 'b.bin', 'c.bin', 'd.bin', 'e.bin']

/* ── per-file path and the threshold ─────────────────────────────── */

test('VZS-1 1–3 files keep the #334 per-file path (one picker per file, no dialog)', async () => {
  await seed({ files: FIVE })
  const { log } = installPicker()
  const h = await mount()
  try {
    await selectAll(FIVE.slice(0, 3))
    await bulkDownload()
    await tick(8)
    assert.equal(dialogOpen(), 0)
    assert.deepEqual(log.pickers.map((p) => p.suggestedName), ['a.bin', 'b.bin', 'c.bin'])
    assert.ok(log.pickers.every((p) => !p.types), 'per-file pickers are the single-file ones')
  } finally { await h.unmount() }
})

test('VZS-2 D-3: 4+ files open the plaintext-export confirmation; no picker and no fetch on open', async () => {
  await seed({ files: FIVE })
  const { log } = installPicker()
  const h = await mount()
  try {
    await selectAll(FIVE)
    const before = backend.requests.length
    await bulkDownload()
    assert.equal(dialogOpen(), 1)
    assert.equal(log.pickers.length, 0)
    assert.deepEqual(backend.downloadEvents, [])
    assert.ok(!backend.requests.slice(before).some((r) => String(r.path).includes('/chunks/')))
    const { fmtBytes } = await env.load('/src/lib/format.js')
    assert.ok(doc().body.textContent.includes(t('vaultZipExportBody', { count: 5, size: fmtBytes(20) })), 'count and total size shown')
    await click(dom, button(t('cancel')))
  } finally { await h.unmount() }
})

/* ── dialog hold (SC-2) and Confirm ──────────────────────────────── */

test('VZS-3 the dialog hold blocks a second dialog and a tile download, but never Confirm; Confirm opens one picker synchronously', async () => {
  await seed({ files: FIVE })
  const { log } = installPicker()
  const h = await mount()
  try {
    await selectAll(FIVE)
    await bulkDownload()
    assert.equal(dialogOpen(), 1)
    await bulkDownload()
    assert.equal(dialogOpen(), 1, 'no second dialog')
    assert.ok(notice().includes(t('vaultTreeDownloadBusy')))
    // tile menu Download while the dialog is open
    await click(dom, fileTile('a.bin').querySelector('[data-vault-tile-menu]'))
    const dl = qa('[role="menuitem"]').find((b) => b.textContent.trim() === t('vaultTreeMenuDownload'))
    assert.ok(dl, 'the tile menu offers Download')
    await click(dom, dl)
    assert.ok(notice().includes(t('vaultTreeDownloadBusy')), 'the tile download announces busy')
    assert.equal(log.pickers.length, 0, 'no picker while the dialog holds')

    const confirm = q('[data-testid="vault-zip-export-confirm"]')
    let syncPickers = -1
    await act(async () => {
      confirm.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      syncPickers = log.pickers.length
    })
    assert.equal(syncPickers, 1, 'Confirm reached showSaveFilePicker inside the click')
    await tick(10)
    assert.equal(log.pickers.length, 1, 'exactly one picker for N = 5')
    assert.equal(log.pickers[0].types[0].accept['application/zip'][0], '.zip')
    assert.match(log.pickers[0].suggestedName, /^AEGIS-Vault-export-\d{8}-\d{6}\.zip$/)
    assert.equal(log.writables[0].closed, true, 'archive closed after every entry')
    assert.equal(log.writables[0].aborted, false)
    assert.deepEqual(backend.downloadEvents.filter((e) => e === 'auth').length, 5, 'pre-flight authenticated every entry')
    assert.equal(backend.downloadEvents.filter((e) => e === 'download').length, 5)
    assert.equal(panel(), null, 'the panel clears after success')
    assert.equal(dialogOpen(), 0)
  } finally { await h.unmount() }
})

test('VZS-4 Cancel and Escape release the hold; a later Download opens the dialog again', async () => {
  await seed({ files: FIVE })
  installPicker()
  const h = await mount()
  try {
    await selectAll(FIVE)
    await bulkDownload()
    await click(dom, button(t('cancel')))
    assert.equal(dialogOpen(), 0)
    await bulkDownload()
    assert.equal(dialogOpen(), 1, 'Cancel released the hold')
    await pressKey(dom, 'Escape')
    assert.equal(dialogOpen(), 0)
    await bulkDownload()
    assert.equal(dialogOpen(), 1, 'Escape released the hold')
    await click(dom, button(t('cancel')))
  } finally { await h.unmount() }
})

test('VZS-5 lock closes the dialog and releases the hold; a stale Confirm after lock is a no-op', async () => {
  await seed({ files: FIVE })
  const { log } = installPicker()
  const h = await mount()
  try {
    await selectAll(FIVE)
    await bulkDownload()
    const confirm = q('[data-testid="vault-zip-export-confirm"]')
    const reactKey = Object.keys(confirm).find((k) => k.startsWith('__reactProps'))
    const staleOnClick = confirm[reactKey].onClick
    await lockVault(dom, t)
    await tick(3)
    assert.equal(dialogOpen(), 0, 'the lock closed the dialog')
    await act(async () => { staleOnClick() })
    await tick(3)
    assert.equal(log.pickers.length, 0, 'stale Confirm opened no picker')
    assert.deepEqual(backend.downloadEvents, [], 'stale Confirm fetched nothing')
  } finally { await h.unmount() }
})

test('VZS-6 runBulkZip is single-flight: a second Download during the archive announces busy and opens no picker', async () => {
  await seed({ files: FIVE })
  const picker = installPicker({ holdPicker: true })
  const h = await mount()
  try {
    await selectAll(FIVE)
    await bulkDownload()
    await click(dom, q('[data-testid="vault-zip-export-confirm"]'))
    assert.equal(picker.log.pickers.length, 1)
    await bulkDownload()
    assert.equal(dialogOpen(), 0, 'no dialog while transferring')
    assert.ok(notice().includes(t('vaultTreeDownloadBusy')))
    assert.equal(picker.log.pickers.length, 1)
    picker.release()
    await tick(10)
    assert.equal(picker.log.writables[0].closed, true)
  } finally { await h.unmount() }
})

/* ── snapshot and copies (I-4) ───────────────────────────────────── */

test('VZS-7 the confirmed plan is the snapshot taken when the dialog opened; live data stays mutable; rename still works', async () => {
  await seed({ files: FIVE })
  const { log } = installPicker()
  const h = await mount()
  try {
    await selectAll(FIVE.slice(0, 4))
    await bulkDownload()
    // change the selection while the dialog is open (the checkbox sits outside the modal)
    await act(async () => fileTile('e.bin').querySelector('[data-testid="vault-tree-tile-checkbox"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    await settle()
    await click(dom, q('[data-testid="vault-zip-export-confirm"]'))
    await tick(10)
    assert.equal(backend.downloadEvents.filter((e) => e === 'download').length, 4, 'the snapshot of 4 was saved, not the live 5')
    assert.equal(log.writables[0].closed, true)
    const inventory = backend.state['/api/vault'].data.blobs
    assert.ok(inventory.every((b) => Object.isExtensible(b)), 'blob records were not frozen')
    // a normal rename of a planned node still works
    await click(dom, fileTile('a.bin').querySelector('[data-vault-tile-menu]'))
    await click(dom, qa('[role="menuitem"]').find((b) => b.textContent.trim() === t('vaultTreeMenuRename')))
    const input = q('[data-testid="vault-dialog-name-input"]')
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    await act(async () => { setter.call(input, ''); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })) })
    await type(dom, input, 'renamed.bin')
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(6)
    assert.ok(fileTile('renamed.bin'), 'rename of a planned node succeeded')
  } finally { await h.unmount() }
})

/* ── refusals and counts ─────────────────────────────────────────── */

test('VZS-8 D-1: V1 in a 4+ selection is refused before the dialog', async () => {
  await seed({ files: FIVE.slice(0, 3), v1: ['old.bin'] })
  const { log } = installPicker()
  const h = await mount()
  try {
    await selectAll([...FIVE.slice(0, 3), 'old.bin'])
    await bulkDownload()
    assert.equal(dialogOpen(), 0)
    assert.ok(notice().includes(t('zipV1NotSupported')))
    assert.equal(log.pickers.length, 0)
  } finally { await h.unmount() }
})

test('VZS-9 M-5: a node whose blob is missing from the inventory is unavailable before the threshold', async () => {
  await seed({ files: FIVE.slice(0, 3), missingBlob: ['gone.bin'] })
  const { log } = installPicker()
  const h = await mount()
  try {
    await selectAll([...FIVE.slice(0, 3), 'gone.bin'])
    await bulkDownload()
    await tick(8)
    assert.equal(dialogOpen(), 0, '3 available files stay on the per-file path')
    assert.equal(log.pickers.length, 3)
    assert.ok(notice().includes(t('zipUnavailable', { n: 1 })))
  } finally { await h.unmount() }
})

test('VZS-10 folders are skipped with a notice: 4 files + folder → dialog; 2 files + folder → per-file', async () => {
  await seed({ files: FIVE.slice(0, 4), folders: ['Docs'] })
  const { log } = installPicker()
  const h = await mount()
  try {
    await selectAll(FIVE.slice(0, 4), ['Docs'])
    await bulkDownload()
    assert.equal(dialogOpen(), 1)
    assert.ok(notice().includes(t('zipFoldersSkipped', { n: 1 })))
    await click(dom, button(t('cancel')))
    // deselect two files → 2 files + 1 folder
    for (const n of ['c.bin', 'd.bin']) await click(dom, fileTile(n).querySelector('[data-testid="vault-tree-tile-checkbox"]'))
    await bulkDownload()
    await tick(8)
    assert.equal(dialogOpen(), 0)
    assert.equal(log.pickers.length, 2)
    assert.ok(notice().includes(t('zipFoldersSkipped', { n: 1 })))
  } finally { await h.unmount() }
})

/* ── panel ───────────────────────────────────────────────────────── */

test('VZS-11 panel: "File i of N: name"; Cancel aborts with no later entry; finalizing hides Cancel', async () => {
  await seed({ files: FIVE })
  const { log } = installPicker()
  let releaseSecond
  backend.downloadImpl = async ({ sink, signal, blob }) => {
    backend.downloadEvents.push(`dl:${blob.id}`)
    if (blob.id === idOf('b.bin')) {
      await new Promise((r) => { releaseSecond = r; signal?.addEventListener('abort', r) })
      if (signal?.aborted) return { ok: false, reason: 'cancelled' }
    }
    await sink.write(new Uint8Array([1, 2, 3, 4]))
    await sink.close()
    return { ok: true, bytesWritten: 4 }
  }
  const h = await mount()
  try {
    await selectAll(FIVE)
    await bulkDownload()
    await click(dom, q('[data-testid="vault-zip-export-confirm"]'))
    await tick(6)
    assert.equal(panel()?.getAttribute('data-vault-transfer-stage'), 'archiving')
    assert.ok(panel().textContent.includes(t('zipArchiving', { index: 2, count: 5, name: 'b.bin' })))
    await click(dom, button(t('vaultXferCancel')))
    await tick(6)
    assert.equal(log.writables[0].aborted, true)
    assert.equal(log.writables[0].closed, false)
    assert.ok(!backend.downloadEvents.includes(`dl:${idOf('c.bin')}`), 'no later entry')
    assert.equal(panel(), null, 'cancel is not shown as a failure')
    assert.equal(typeof releaseSecond, 'function', 'entry 2 was in flight when Cancel was pressed')
  } finally { await h.unmount() }
})

test('VZS-12 finalizing hides Cancel; localDiskFull and finalizeFailed render on the panel', async () => {
  await seed({ files: FIVE.slice(0, 4) })
  let releaseClose
  const holdClose = new Promise((r) => { releaseClose = r })
  const log = { closes: 0 }
  globalThis.showSaveFilePicker = () => Promise.resolve({
    createWritable: async () => ({
      async write() {}, async abort() {},
      async close() { log.closes += 1; await holdClose; throw Object.assign(new Error('q'), { name: 'QuotaExceededError' }) },
    }),
  })
  const h = await mount()
  try {
    await selectAll(FIVE.slice(0, 4))
    await bulkDownload()
    await click(dom, q('[data-testid="vault-zip-export-confirm"]'))
    await tick(8)
    assert.equal(panel()?.getAttribute('data-vault-transfer-stage'), 'finalizing')
    assert.equal(button(t('vaultXferCancel')), undefined, 'no Cancel while close() is pending')
    releaseClose()
    await tick(6)
    assert.equal(panel()?.getAttribute('data-vault-transfer-stage'), 'failed')
    assert.ok(panel().textContent.includes(t('xferReasonLocalDiskFull')))
    await click(dom, button(t('vaultXferDismiss')))
  } finally { await h.unmount() }
  await seed({ files: FIVE.slice(0, 4) })
  installPicker({ closeError: new Error('io') })
  const h2 = await mount()
  try {
    await selectAll(FIVE.slice(0, 4))
    await bulkDownload()
    await click(dom, q('[data-testid="vault-zip-export-confirm"]'))
    await tick(8)
    assert.ok(panel().textContent.includes(t('xferReasonFinalizeFailed')))
  } finally { await h2.unmount() }
})

test('VZS-13 single-file entry points stay per-file even with 4+ selected', async () => {
  await seed({ files: FIVE })
  const { log } = installPicker()
  const h = await mount()
  try {
    await selectAll(FIVE)
    await click(dom, fileTile('c.bin').querySelector('[data-vault-tile-menu]'))
    await click(dom, qa('[role="menuitem"]').find((b) => b.textContent.trim() === t('vaultTreeMenuDownload')))
    await tick(6)
    assert.equal(dialogOpen(), 0)
    assert.deepEqual(log.pickers.map((p) => p.suggestedName), ['c.bin'])
  } finally { await h.unmount() }
})

/* ── no FSA, but the existing /drive/ Service Worker can stream (Brave on Windows) ── */

/**
 * Installs a service-worker container whose controller is wired to the REAL worker-side download state
 * (and answers vault-preview-close-all the way the real worker does), plus a MutationObserver that plays
 * the browser's navigation of the hidden iframe. Returns the captured response bodies.
 */
function installWorkerStream() {
  const state = createDownloadStreamWorkerState()
  const sw = { state, frames: [], bodies: [] }
  const controller = {
    postMessage(msg, ports = []) {
      const reply = (p) => ports[0]?.postMessage(p)
      if (handleDownloadStreamMessage(state, msg, ports, reply)) return
      if (msg?.type === 'vault-preview-close-all') { state.closeAll({ source: 'vault' }); reply({ ok: true }); return }
      reply({ ok: false })
    },
  }
  const nav = dom.window.navigator
  Object.defineProperty(nav, 'serviceWorker', {
    configurable: true,
    value: { controller, async register() { return { active: controller } }, addEventListener() {}, removeEventListener() {} },
  })
  globalThis.isSecureContext = true
  const observer = new dom.window.MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (n.tagName !== 'IFRAME') continue
        const src = n.getAttribute('src')
        sw.frames.push({ src, hidden: n.hidden })
        const scopePath = /^(.*\/)__aegis-download\/[0-9a-f]{32}$/.exec(src)?.[1] ?? '/'
        const res = handleDownloadStreamFetch(state, new Request(new URL(src, 'http://localhost/').href), { origin: 'http://localhost', scopePath })
        sw.bodies.push(res.arrayBuffer().then((b) => new Uint8Array(b), (e) => e))
      }
    }
  })
  observer.observe(doc().body, { childList: true, subtree: true })
  sw.uninstall = () => {
    observer.disconnect()
    delete nav.serviceWorker
    delete globalThis.isSecureContext
  }
  return sw
}

const eocdCount = (bytes) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(dv.getUint32(bytes.length - 22, true), 0x06054b50, 'EOCD signature')
  return dv.getUint16(bytes.length - 22 + 10, true)
}

test('VZS-WS-1 no FSA + worker-stream: the plaintext warning comes first; Confirm → ONE ZIP through the worker, no picker, no Blob', async (t) => {
  await seed({ files: FIVE })
  backend.streamingSink = false // no File System Access (Brave on Windows)
  const blobs = []
  t.mock.method(URL, 'createObjectURL', (b) => { blobs.push(b); return 'blob:x' })
  const sw = installWorkerStream()
  const h = await mount()
  try {
    await selectAll(FIVE)
    await bulkDownload()
    assert.equal(dialogOpen(), 1, 'the plaintext-export warning is shown first')
    assert.equal(sw.frames.length, 0, 'nothing streams before Confirm')
    assert.deepEqual(backend.downloadEvents, [])
    await click(dom, q('[data-testid="vault-zip-export-confirm"]'))
    for (let i = 0; i < 50 && sw.bodies.length === 0; i += 1) await tick(1)
    assert.equal(sw.frames.length, 1)
    assert.equal(sw.frames[0].hidden, true)
    const body = await sw.bodies[0]
    assert.ok(body instanceof Uint8Array, String(body))
    assert.equal(eocdCount(body), 5)
    assert.equal(blobs.length, 0, 'no whole-archive Blob')
    await tick(4)
    assert.equal(panel(), null, 'done clears the panel')
    assert.equal(sw.state.sessionCount(), 0)
  } finally { await h.unmount(); sw.uninstall() }
})

test('VZS-WS-2 locking the Vault mid-transfer errors the worker download; never reported as success', async () => {
  await seed({ files: FIVE })
  backend.streamingSink = false // no File System Access (Brave on Windows)
  const sw = installWorkerStream()
  let reachedSecond = false
  backend.downloadImpl = async ({ sink, signal, blob }) => {
    backend.downloadEvents.push(`dl:${blob.id}`)
    if (blob.id === idOf('b.bin')) {
      reachedSecond = true
      await new Promise((r) => signal?.addEventListener('abort', r))
      return { ok: false, reason: 'cancelled' }
    }
    await sink.write(new Uint8Array([1, 2, 3, 4]))
    await sink.close()
    return { ok: true, bytesWritten: 4 }
  }
  const h = await mount()
  try {
    await selectAll(FIVE)
    await bulkDownload()
    await click(dom, q('[data-testid="vault-zip-export-confirm"]'))
    for (let i = 0; i < 50 && !reachedSecond; i += 1) await tick(1)
    assert.equal(reachedSecond, true)
    await lockVault(dom, t)
    await tick(6)
    const body = await sw.bodies[0]
    assert.ok(body instanceof Error, 'the browser download ends in an error, not a clean file')
    assert.ok(!backend.downloadEvents.includes(`dl:${idOf('c.bin')}`), 'no later entry')
    assert.equal(sw.state.sessionCount(), 0)
  } finally { await h.unmount(); sw.uninstall(); delete backend.downloadImpl }
})
