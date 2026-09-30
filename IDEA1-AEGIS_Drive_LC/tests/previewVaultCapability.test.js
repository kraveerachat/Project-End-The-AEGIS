// tests/previewVaultCapability.test.js — AEGIS Drive (IDEA1) · Unified Preview P0 · T-DETECT-2 / Vault capability
//
// The Vault used to decide preview from the browser's File.type captured at upload. That MIME is
// now a hint only: the decision comes from the decrypted content signature (or, before any bytes
// were seen, from the normalised extension with mandatory confirmation before rendering).
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE, serverBlobV2 } from './fixtures/vaultScreenBackend.js'
import { syntheticPng, installStorageGuards } from './helpers/vaultTreeFixtures.mjs'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, settle, click, unlock } from './helpers/vaultScreenHarness.js'
import * as vaultCapability from '../src/lib/preview/vaultCapability.js'

const cap = (name) => (...a) => vaultCapability[name](...a)
const createVaultCapabilityCache = cap('createVaultCapabilityCache')
const vaultNodeCapability = cap('vaultNodeCapability')
const vaultPreviewKind = cap('vaultPreviewKind')
const confirmVaultRender = cap('confirmVaultRender')
const vaultRenderMime = cap('vaultRenderMime')

const JPEG_HEAD = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
const PDF_HEAD = new Uint8Array(Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n', 'latin1'))
const node = (name, mediaType = '', id = 'N1') => ({ nodeId: id.padEnd(22, 'N'), kind: 'file', name, mediaType, plainSize: 1024, blobRef: { formatVersion: 2, id: `blob-${id}` } })

/* ── pure capability rules ─────────────────────────────────────────────── */

test('VC-1 an upper-case camera extension with an empty MIME is previewable (verify before render)', () => {
  const c = vaultNodeCapability(node('Holiday.JPG', ''))
  assert.equal(c.state, 'available')
  assert.equal(c.verify, 'signature')
  assert.equal(vaultPreviewKind(node('Holiday.JPG', '')), 'image')
  assert.equal(vaultPreviewKind(node('Holiday.jpg', 'image/jpeg')), vaultPreviewKind(node('Holiday.JPG', '')))
})

test('VC-2 the client MIME never promotes a file', () => {
  assert.equal(vaultPreviewKind(node('scan.bin', 'image/png')), null)
  assert.equal(vaultPreviewKind(node('photo', 'image/jpeg')), null)
  assert.equal(vaultPreviewKind(node('clip', 'video/mp4')), null)
})

test('VC-3 decrypted leading bytes override the name; the cache keeps derived facts only', () => {
  let changes = 0
  const cache = createVaultCapabilityCache({ onChange: () => { changes += 1 } })
  const n = node('photo.png', 'image/png')
  assert.equal(vaultPreviewKind(n, { cache }), 'image', 'extension-only before bytes')
  cache.record(n, PDF_HEAD)
  assert.equal(vaultPreviewKind(n, { cache }), null, 'PDF bytes behind a .png name are not an image')
  assert.equal(vaultNodeCapability(n, { cache }).family, 'pdf')
  assert.equal(changes, 1)
  const stored = cache.get(n)
  assert.deepEqual(Object.keys(stored).sort(), ['sniff', 'textLike'], 'no plaintext retained')
  const noExt = node('camera-upload', '', 'N2')
  assert.equal(vaultPreviewKind(noExt, { cache }), null)
  cache.record(noExt, JPEG_HEAD)
  assert.equal(vaultPreviewKind(noExt, { cache }), 'image', 'a verified JPEG previews even without an extension')
  assert.equal(vaultNodeCapability(noExt, { cache }).verify, 'none')
})

test('VC-4 a replaced file (new blobRef) does not inherit the old probe; clear() empties the session', () => {
  const cache = createVaultCapabilityCache()
  const n = node('a.png', 'image/png')
  cache.record(n, PDF_HEAD)
  const replaced = { ...n, blobRef: { formatVersion: 2, id: 'blob-new' } }
  assert.equal(vaultPreviewKind(replaced, { cache }), 'image')
  assert.equal(cache.size(), 1)
  cache.clear()
  assert.equal(cache.size(), 0)
  assert.equal(vaultPreviewKind(n, { cache }), 'image')
})

test('VC-4b a sealed cache (after lock) ignores late records from jobs that were still running', () => {
  const cache = createVaultCapabilityCache()
  const n = node('late.png', 'image/png')
  cache.clear({ seal: true })
  assert.equal(cache.record(n, PDF_HEAD), null)
  assert.equal(cache.size(), 0)
  assert.equal(vaultPreviewKind(n, { cache }), 'image', 'nothing learned after the seal')
})

test('VC-5 confirmVaultRender is the render gate and returns the confirmed MIME, never the hint', () => {
  const ok = confirmVaultRender(node('x.png', 'application/octet-stream'), new Uint8Array(syntheticPng()))
  assert.deepEqual(ok, { ok: true, kind: 'image', mime: 'image/png', detected: { format: 'png', basis: 'signature' } })
  const bad = confirmVaultRender(node('x.png', 'image/png'), PDF_HEAD)
  assert.equal(bad.ok, false)
  assert.equal(bad.capability.download, true)
  const random = confirmVaultRender(node('x.png', 'image/png'), new Uint8Array(64).fill(7))
  assert.equal(random.ok, false)
  assert.equal(vaultRenderMime(node('movie.MP4', 'video/quicktime')), 'video/mp4')
  assert.equal(vaultRenderMime(node('notes.txt', 'video/mp4')), null)
})

const vaultTypeLabel = cap('vaultTypeLabel')
const tt = (key, vars) => (key === 'previewTypeUnknown' ? 'Unknown type' : key === 'previewTypeUnverified' ? `${vars.type} (not yet verified)` : key)
const MP4_HEAD = new Uint8Array(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1'), Buffer.alloc(4), Buffer.from('isommp41', 'latin1'), Buffer.alloc(16)]))

test('VC-7 the type label comes from the confirmed signature, never the name or the hint', () => {
  // A. photo.JPG + JPEG bytes → JPEG
  const a = confirmVaultRender(node('photo.JPG', ''), JPEG_HEAD)
  assert.equal(a.ok, true)
  assert.equal(vaultTypeLabel(tt, a.detected), 'JPEG')
  // B. fake.png + PDF bytes → unsupported, labelled PDF (not PNG)
  const b = confirmVaultRender(node('fake.png', 'image/png'), PDF_HEAD)
  assert.equal(b.ok, false)
  assert.equal(vaultTypeLabel(tt, b.detected), 'PDF')
  // C. movie.bin + MP4 bytes → MP4 (not BIN), and previewable as video
  const c = confirmVaultRender(node('movie.bin', ''), MP4_HEAD)
  assert.deepEqual({ ok: c.ok, kind: c.kind }, { ok: true, kind: 'video' })
  assert.equal(vaultTypeLabel(tt, c.detected), 'MP4')
  // D. unknown bytes + misleading extension → stable unknown, never the extension
  const d = confirmVaultRender(node('photo.jpg', 'image/jpeg'), new Uint8Array(64).fill(7))
  assert.equal(d.ok, false)
  assert.equal(vaultTypeLabel(tt, d.detected), 'Unknown type')
})

test('VC-8 before any bytes were seen the label is explicitly unverified; a cached probe makes it confirmed', () => {
  const cache = createVaultCapabilityCache()
  const n = node('clip.MP4', 'video/quicktime')
  const cap0 = vaultCapability.vaultDetectedType(n, { cache })
  assert.equal(vaultTypeLabel(tt, cap0), 'MP4 (not yet verified)')
  cache.record(n, MP4_HEAD)
  assert.equal(vaultTypeLabel(tt, vaultCapability.vaultDetectedType(n, { cache })), 'MP4')
  assert.equal(vaultTypeLabel(tt, vaultCapability.vaultDetectedType(node('README', 'text/plain', 'N3'), { cache })), 'Unknown type')
})

test('VC-6 locked and folders reveal nothing', () => {
  assert.equal(vaultNodeCapability(node('a.jpg'), { locked: true }).state, 'locked')
  assert.equal(vaultPreviewKind({ nodeId: 'D'.repeat(22), kind: 'folder', name: 'pics.jpg' }), null)
})

/* ── screen integration ────────────────────────────────────────────────── */

const t = makeT('en')
let env
let dom
let kek
let backend
let fakeTree

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom } = env)
  const vaultCrypto = await env.load('/src/lib/vaultCrypto.js')
  kek = await vaultCrypto.unlockVault(CORRECT_PASSPHRASE)
})
after(async () => { await env?.stop(); delete globalThis.__VAULT_BACKEND__ })

const doc = () => dom.window.document
const q = (sel) => doc().querySelector(sel)
const qa = (sel) => [...doc().querySelectorAll(sel)]
const fileTiles = () => qa('[data-testid="vault-file-tile"]')
const menuItem = (action) => qa('[role="menuitem"]').find((el) => el.getAttribute('data-action') === action)
const tileMenuButton = (nodeId) => qa('[data-vault-tile-menu]').find((b) => b.getAttribute('data-vault-tile-menu') === nodeId)
async function tick(times = 3) { for (let i = 0; i < times; i += 1) await settle() }

const BLOB_ID = 'P0'.padEnd(22, 'P')
let chunkBytes = null

beforeEach(async () => {
  fakeTree = await createFakeTreeServer({ kek, blobs: [{ formatVersion: 2, id: BLOB_ID }] })
  backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true } })
  backend.tree.protocolState = 'TREE_V1'
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
    if (p.startsWith(`/api/vault/blobs/${BLOB_ID}/chunks/`)) return { ok: true, bytes: chunkBytes }
    return innerBytes?.(req)
  }
  backend.uploadImpl = async () => ({ ok: true, stage: 'complete', blob: { id: BLOB_ID, formatVersion: 2 } })
  globalThis.__VAULT_BACKEND__ = backend
})

async function mountWithFile(name, type, bytes) {
  chunkBytes = bytes
  backend.state['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: [serverBlobV2({ id: BLOB_ID, name: 'envelope', type: 'application/octet-stream', plainSize: bytes.length, size: bytes.length + 16 })] },
    error: null,
  }
  const h = env.mount()
  await h.render(React.createElement((await env.load('/src/screens/Vault.jsx')).Vault, { t }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  await tick(4)
  const dropEv = new dom.window.Event('drop', { bubbles: true })
  Object.defineProperty(dropEv, 'dataTransfer', { value: { types: ['Files'], files: [new dom.window.File(['x'], name, { type })] } })
  await act(async () => q('[data-testid="vault-tree-screen"]').dispatchEvent(dropEv))
  await tick(4)
  const tile = fileTiles().find((el) => el.textContent.includes(name))
  assert.ok(tile, `${name} tile renders`)
  return { h, tile }
}

async function openMenu(tile) {
  await click(dom, tileMenuButton(tile.getAttribute('data-node-id')))
}

test('VC-S1 Holiday.JPG uploaded with an empty browser MIME offers Preview', async () => {
  const { h, tile } = await mountWithFile('Holiday.JPG', '', new Uint8Array(syntheticPng()))
  try {
    await openMenu(tile)
    assert.equal(Boolean(menuItem('preview')), true, 'Preview is offered from the extension (content confirmed on open)')
  } finally { await h.unmount() }
})

test('VC-S2 a .bin file whose browser MIME claims image/png does not offer Preview', async () => {
  const { h, tile } = await mountWithFile('scan.bin', 'image/png', new Uint8Array(syntheticPng()))
  try {
    await openMenu(tile)
    assert.equal(Boolean(menuItem('preview')), false, 'the client MIME never promotes a file')
    assert.equal(Boolean(menuItem('download')), true, 'Download stays available')
  } finally { await h.unmount() }
})

test('VC-S3 PDF bytes behind a .png name never reach an <img>; the modal falls back and Download stays', async () => {
  const guards = installStorageGuards(dom.window)
  const { h, tile } = await mountWithFile('photo.png', 'image/png', new Uint8Array(Buffer.concat([Buffer.from(PDF_HEAD), Buffer.alloc(256, 0x20)])))
  try {
    await openMenu(tile)
    await click(dom, menuItem('preview'))
    await tick(6)
    const modal = q('[data-testid="vault-tree-preview"]')
    assert.equal(Boolean(modal), true, 'the preview modal opened')
    assert.equal(Boolean(modal.querySelector('img, video')), false, 'no renderer receives unconfirmed bytes')
    assert.equal(modal.getAttribute('data-preview-state'), 'unsupported')
    const header = doc().querySelector('[role="dialog"] h2 + p')?.textContent ?? ''
    assert.equal(header.includes('PDF'), true, `detected type is shown (got "${header}")`)
    assert.equal(header.includes('PNG'), false, 'the misleading extension is not presented as the type')
    assert.equal(Boolean(doc().querySelector('[role="dialog"] [data-preview-download]')), true, 'Download stays in the modal')
    assert.equal(guards.writes, 0, 'no storage writes')
  } finally { await h.unmount() }
})

test('VC-S4 genuine PNG bytes render in the modal', async () => {
  const { h, tile } = await mountWithFile('picture.png', 'image/png', new Uint8Array(syntheticPng()))
  try {
    await openMenu(tile)
    await click(dom, menuItem('preview'))
    await tick(6)
    const modal = q('[data-testid="vault-tree-preview"]')
    assert.equal(Boolean(modal.querySelector('img')), true, 'the confirmed image renders')
  } finally { await h.unmount() }
})
