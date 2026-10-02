// tests/previewIndexWriterOff.test.js — D-1 PR-D · Task E.1 (+ E.3 negative control)
//
// The preview-index writer capability is served by the server (/api/vault/tree/state flags.previewIndexWriteEnabled,
// env VAULT_PREVIEW_INDEX_WRITE_ENABLED, default false). When it is not exactly `true` the writer is inert: offer()
// answers 'DISABLED', nothing is queued, and not a single request leaves the client.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPreviewIndexWriter, previewIndexWriteAllowed, WRITER_OFFER } from '../src/lib/vaultPreviewIndexWriter.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'
import { fakeJpeg, newKek, id22 } from './helpers/previewIndexFixture.mjs'

const src = readFileSync(new URL('../src/lib/vaultPreviewIndexWriter.js', import.meta.url), 'utf8')

function spyEverything() {
  const calls = []
  const rec = (name) => async (...args) => { calls.push(name); throw new Error(`unexpected ${name}(${args.length})`) }
  const api = { getPreviewIndexHead: rec('getPreviewIndexHead'), getPreviewIndexEnvelopes: rec('getPreviewIndexEnvelopes'), casPreviewIndexHead: rec('casPreviewIndexHead') }
  const transport = { fetchJson: rec('fetchJson'), sendUpload: rec('sendUpload'), fetchBytes: rec('fetchBytes') }
  const reader = { load: rec('reader.load'), snapshot: () => { calls.push('reader.snapshot'); return { head: null, root: null } }, shardOf: rec('reader.shardOf'), clear() {} }
  return { calls, api, transport, reader, upload: rec('upload'), getMainHead: rec('getMainHead') }
}

const job = () => ({ nodeId: id22(), kind: 'thumb', sourceBlobRef: { formatVersion: 2, id: 'a'.repeat(48) }, bytes: fakeJpeg(320, 240), mime: 'image/jpeg', width: 320, height: 240 })

test('PIW-OFF-1 writeAllowed derives only from treeState.flags.previewIndexWriteEnabled === true', () => {
  assert.equal(previewIndexWriteAllowed({ flags: { previewIndexWriteEnabled: true } }), true)
  for (const v of [false, 'true', 1, null, undefined, {}, [true]]) assert.equal(previewIndexWriteAllowed({ flags: { previewIndexWriteEnabled: v } }), false, String(v))
  assert.equal(previewIndexWriteAllowed({ flags: {} }), false)
  assert.equal(previewIndexWriteAllowed(null), false)
  assert.equal(previewIndexWriteAllowed(undefined), false)
  // a read flag, the media flag, or a role never implies the writer
  assert.equal(previewIndexWriteAllowed({ flags: { previewIndexReadEnabled: true, mediaPreviewEnabled: true }, role: 'admin' }), false)
})

test('PIW-OFF-2 writer OFF: offer() → DISABLED, nothing queued, zero network calls; flush() → zeros with zero calls', async () => {
  const s = spyEverything()
  const unlockedState = createUnlockedVaultState({ closeAllPreviewSessions: () => {} })
  const w = createPreviewIndexWriter({ kek: await newKek(), api: s.api, transport: s.transport, reader: s.reader, getMainHead: s.getMainHead, upload: s.upload, unlockedState, writeAllowed: () => false })
  for (let i = 0; i < 5; i++) assert.equal(w.offer(job()), WRITER_OFFER.DISABLED)
  assert.equal(w.stats().queued, 0)
  const r = await w.flush()
  assert.deepEqual(r, { committed: 0, dropped: 0, failed: 0, budgetExhausted: false })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(s.calls, [], 'no request, no reader use, no main-head read')
})

test('PIW-OFF-3 writeAllowed is evaluated on every offer (no cached enablement) and the writer has no client toggle', async () => {
  const s = spyEverything()
  let allowed = false
  const w = createPreviewIndexWriter({ kek: await newKek(), api: s.api, transport: s.transport, reader: s.reader, getMainHead: s.getMainHead, upload: s.upload, writeAllowed: () => allowed, autoFlush: false })
  assert.equal(w.offer(job()), WRITER_OFFER.DISABLED)
  allowed = true
  assert.equal(w.offer(job()), WRITER_OFFER.QUEUED, 'only the injected server-served predicate decides')
  allowed = false
  assert.deepEqual(await w.flush(), { committed: 0, dropped: 0, failed: 0, budgetExhausted: false }, 'a flag turned off before flush sends nothing')
  assert.deepEqual(s.calls, [])
  assert.deepEqual(Object.keys(w).sort(), ['dispose', 'flush', 'offer', 'stats'], 'no enable/disable/setFlag method exists')
})

test('PIW-OFF-4 missing or throwing writeAllowed fails closed', async () => {
  const s = spyEverything()
  const kek = await newKek()
  const a = createPreviewIndexWriter({ kek, api: s.api, transport: s.transport, reader: s.reader, getMainHead: s.getMainHead, upload: s.upload })
  assert.equal(a.offer(job()), WRITER_OFFER.DISABLED)
  const b = createPreviewIndexWriter({ kek, api: s.api, transport: s.transport, reader: s.reader, getMainHead: s.getMainHead, upload: s.upload, writeAllowed: () => { throw new Error('x') } })
  assert.equal(b.offer(job()), WRITER_OFFER.DISABLED)
  assert.deepEqual(s.calls, [])
})

test('PIW-OFF-5 source: capability never comes from storage, URL, build constants or the manifest-v2 upgrade flag', () => {
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'location', 'URLSearchParams', 'import.meta.env', 'process.env', 'VAULT_MANIFEST_V2_UPGRADE', 'manifestV2Upgrade', 'console.']) {
    assert.equal(src.includes(banned), false, banned)
  }
})

/* ── E.3 · writer-OFF negative control, end to end through the real Vault screen (jsdom) ─────────────────────────
   Scenario: unlock → upload 5 images + 2 videos (OS drop → real upload path) → tiles render through the original path →
   open a folder and come back → rename (menu dialog) → move (bulk dialog) → trash → restore (trash view) → lock → unlock.
   WRITE=false (READ on, and READ off): ZERO preview-index mutation requests, zero derivative/root/shard uploads, zero
   generation. WRITE=true runs the same scenario as a positive control, proving the request log would catch a writer. */
import React, { act } from 'react'
import { after as afterAll } from 'node:test'
import { makeT } from '../src/lib/strings.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { CORRECT_PASSPHRASE, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, settle, click, type, unlock } from './helpers/vaultScreenHarness.js'
import { fakeWebp } from './helpers/previewIndexFixture.mjs'

const PI = '/api/vault/tree/preview-index'
let screenEnv = null
afterAll(async () => { await screenEnv?.stop(); delete globalThis.__VAULT_BACKEND__ })

function installImageGlobals() {
  const saved = { cib: globalThis.createImageBitmap, oc: globalThis.OffscreenCanvas }
  globalThis.createImageBitmap = async () => ({ width: 1024, height: 768, close() {} })
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.w = w; this.h = h }
    getContext() { return { drawImage() {} } }
    async convertToBlob() { const b = fakeWebp(this.w, this.h); return { type: 'image/webp', arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } }
  }
  return () => { globalThis.createImageBitmap = saved.cib; globalThis.OffscreenCanvas = saved.oc }
}

async function scenario({ read, write }) {
  screenEnv ??= await startVaultScreenEnv({ derivativeGenerateStub: true })
  const env = screenEnv
  const { dom } = env
  const t = makeT('en')
  const q = (sel) => dom.window.document.querySelector(sel)
  const qa = (sel) => [...dom.window.document.querySelectorAll(sel)]
  const tick = async (n = 3) => { for (let i = 0; i < n; i++) await settle() }
  const kek = await (await env.load('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
  const ids = Array.from({ length: 7 }, (_, i) => `E3${i}`.padEnd(22, 'E'))
  const fakeTree = await createFakeTreeServer({ kek, blobs: ids.map((id) => ({ formatVersion: 2, id })) })
  const backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true, mediaPreviewEnabled: true, previewIndexReadEnabled: read, previewIndexWriteEnabled: write } })
  backend.tree.protocolState = 'TREE_V1'
  const names = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg', 'f.mp4', 'g.mp4']
  backend.state['/api/vault'] = { loading: false, data: { configured: true, blobs: ids.map((id, i) => serverBlobV2({ id, name: names[i], type: i < 5 ? 'image/jpeg' : 'video/mp4', plainSize: 4096 })) }, error: null }
  backend.generated = 0
  backend.generate = async () => { backend.generated++; return { bytes: fakeJpeg(320, 240), mime: 'image/jpeg', width: 320, height: 240 } }
  backend.downloadImpl = async ({ sink }) => { await sink.write(fakeJpeg(1024, 768, 4000)); return { ok: true, chunksRead: 1, bytesWritten: 1, result: await sink.close() } }
  const log = []
  const inner = backend.respond
  backend.respond = async (req) => {
    const p = String(req.path)
    if (p.startsWith(PI)) {
      log.push(`${req.method} ${p}`)
      if (p === `${PI}/head` && req.method === 'GET') return read ? { ok: false, status: 404, data: { code: 'PREVIEW_INDEX_NOT_FOUND' }, errorKind: 'server' } : { ok: false, status: 503, data: { code: 'PREVIEW_INDEX_DISABLED' }, errorKind: 'server' }
      if (p === `${PI}/head` && req.method === 'POST') return { ok: true, status: 200, data: { indexGeneration: 1, rootBlobId: 'x' }, errorKind: null }
      return { ok: true, status: 200, data: { blobs: [] }, errorKind: null }
    }
    if (p.startsWith('/api/vault/tree/') && !p.startsWith('/api/vault/tree/state') && !p.startsWith('/api/vault/tree/migration')) {
      return fakeTree.fetchJson(p, { method: req.method, body: req.options?.body, signal: req.options?.signal })
    }
    return inner(req)
  }
  const innerBytes = backend.respondBytes
  backend.respondBytes = (req) => (String(req.path).startsWith('/api/vault/tree/') ? fakeTree.fetchBytes(String(req.path), { signal: req.options?.signal }) : innerBytes?.(req))
  let originals = 0, previews = 0
  const uploadResults = []
  backend.uploadImpl = async ({ routeBase }) => {
    if (String(routeBase).startsWith(PI)) {
      log.push(`UPLOAD ${routeBase}`)
      return { ok: true, stage: 'complete', blob: { id: (++previews).toString(16).padStart(48, '0'), formatVersion: 2, contentIdB64: 'A'.repeat(22) + '==', size: 100 }, resume: null }
    }
    const r = { ok: true, stage: 'complete', blob: { id: ids[originals++], formatVersion: 2 }, resume: null }
    uploadResults.push(Object.keys(r).sort().join(','))
    return r
  }
  globalThis.__VAULT_BACKEND__ = backend
  const restore = installImageGlobals()
  const h = env.mount()
  try {
    await h.render(React.createElement(env.Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await tick(4)
    // upload 5 images + 2 videos through the screen's OS-drop path
    const grid = q('[data-testid="vault-tree-grid"]') ?? q('[data-testid="vault-tree-screen"]')
    const drop = new dom.window.Event('drop', { bubbles: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: names.map((n, i) => new dom.window.File([fakeJpeg()], n, { type: i < 5 ? 'image/jpeg' : 'video/mp4' })) } })
    await act(async () => grid.dispatchEvent(drop))
    await tick(20)
    const fileTiles = () => qa('[data-testid="vault-file-tile"]')
    const uploaded = fileTiles().length
    // browse: a folder in, and back out
    await click(dom, q('[data-testid="vault-tree-new-folder"]') ?? q('[data-testid="vault-tree-new-folder-empty"]'))
    await type(dom, q('[data-testid="vault-dialog-name-input"]'), 'Album')
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    const folder = () => qa('[data-testid="vault-folder-tile"]').find((el) => el.textContent.includes('Album'))
    await click(dom, folder().querySelector('[data-testid="vault-folder-tile-body"]'))
    await tick(3)
    await click(dom, qa('[data-testid="vault-breadcrumb"] button, nav button').find((b) => b.textContent.trim().length) ?? q('[data-testid="vault-tree-back"]'))
    await tick(3)
    const menuItem = (action) => qa('[role="menuitem"]').find((el) => el.getAttribute('data-action') === action)
    const tileOf = (name) => fileTiles().find((el) => el.textContent.includes(name))
    const menuOf = (el) => qa('[data-vault-tile-menu]').find((b) => b.getAttribute('data-vault-tile-menu') === el.getAttribute('data-node-id'))
    // rename (menu dialog)
    await click(dom, menuOf(tileOf('a.jpg')))
    await click(dom, menuItem('rename'))
    await type(dom, q('[data-testid="vault-dialog-name-input"]'), '2')
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    // move (bulk dialog) into Album
    await click(dom, tileOf('b.jpg').querySelector('[data-testid="vault-tree-tile-checkbox"]'))
    await click(dom, q('[data-testid="vault-tree-bulk-move"]'))
    await click(dom, qa('[data-testid="vault-dialog-move-row"]').find((r) => r.textContent.includes('Album')).querySelector('button'))
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    // trash, then restore from the trash view
    await click(dom, menuOf(tileOf('c.jpg')))
    await click(dom, menuItem('trash'))
    await click(dom, q('[data-testid="vault-dialog-submit"]'))
    await tick(3)
    const view = q('[data-testid="vault-workspace-view"]')
    await act(async () => { view.value = 'trash'; view.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    await tick()
    await click(dom, menuOf(tileOf('c.jpg')))
    await click(dom, menuItem('restore'))
    await tick(3)
    await act(async () => { view.value = 'active'; view.dispatchEvent(new dom.window.Event('change', { bubbles: true })) })
    await tick()
    const restored = Boolean(tileOf('c.jpg'))
    // lock, unlock
    await click(dom, qa('button').find((b) => b.textContent.trim() === t('lockVault')))
    await tick(3)
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await tick(8)
    return {
      uploaded, restored, uploadResults, generated: backend.generated,
      mutations: log.filter((l) => !l.startsWith('GET')),
      previewUploads: log.filter((l) => l.startsWith('UPLOAD')).length,
      treeCas: fakeTree.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head').length,
    }
  } finally {
    await h.unmount()
    restore()
  }
}

test('PIW-OFF-E3 end to end: WRITE=false (READ on and off) → zero preview-index mutation; WRITE=true positive control', async () => {
  const offRead = await scenario({ read: true, write: false })
  const offNoRead = await scenario({ read: false, write: false })
  const on = await scenario({ read: true, write: true })
  for (const [label, r] of [['READ=true WRITE=false', offRead], ['READ=false WRITE=false', offNoRead]]) {
    assert.equal(r.uploaded, 7, `${label}: 5 images + 2 videos uploaded`)
    assert.equal(r.restored, true, `${label}: trash → restore round trip`)
    assert.deepEqual(r.mutations, [], `${label}: no /preview-index/uploads*, no POST /preview-index/head`)
    assert.equal(r.previewUploads, 0, `${label}: zero derivative/root/shard blobs`)
    assert.equal(r.generated, 0, `${label}: zero generation`)
  }
  assert.deepEqual(offRead.uploadResults, offNoRead.uploadResults, 'upload results identical in shape')
  assert.deepEqual(on.uploadResults, offRead.uploadResults, 'the writer never changes the original upload result')
  assert.equal(on.treeCas, offRead.treeCas, 'main-manifest CAS count identical with the writer ON (0 preview bytes in the main manifest)')
  assert.ok(on.generated >= 1 && on.previewUploads >= 1 && on.mutations.includes(`POST ${PI}/head`), 'positive control: the same log catches a writer')
})
