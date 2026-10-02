// tests/previewIndexUploadFlow.test.js — D-1 PR-D · Task F.2 · upload flow: original first, derivative after success
//
// Part 1 (unit): the post-upload derivative queue — bounded (≤ backfillConcurrency generation jobs), paused while an
// upload is active, never throws, skips everything once the writer is budget-exhausted, and is torn down on purge.
// Part 2 (jsdom screen): with the writer ON the drawer's upload result/announcement is unchanged and derivative work is
// queued (not awaited) only after uploadTreeFile returned ok AND reconcile resolved; a budget-exhausted server never
// affects the original upload; with the writer OFF nothing is generated at all.
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createUploadDerivativeQueue } from '../src/lib/vaultDerivativeGenerate.js'
import { createUnlockedVaultState } from '../src/lib/vaultUnlockedState.js'
import { fakeJpeg, id22 } from './helpers/previewIndexFixture.mjs'
import { makeT } from '../src/lib/strings.js'
import { CORRECT_PASSPHRASE } from './fixtures/vaultScreenBackend.js'
import { makeVaultTreeBackend } from './fixtures/vaultTreeBackend.js'
import { createFakeTreeServer } from './helpers/vaultTreeFakeServer.mjs'
import { startVaultScreenEnv, settle, unlock } from './helpers/vaultScreenHarness.js'

const src = { formatVersion: 2, id: 'a'.repeat(48) }
const file = (name = 'a.jpg', type = 'image/jpeg') => new File([fakeJpeg()], name, { type })
const result = () => ({ bytes: fakeJpeg(320, 240), mime: 'image/jpeg', width: 320, height: 240 })
const flushMicro = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)) }

function fakeWriter() {
  const offers = []
  return { offers, budget: false, offer(job) { offers.push({ ...job, bytes: new Uint8Array(job.bytes) }); return 'QUEUED' }, stats() { return { budgetExhausted: this.budget, serverDisabled: false } } }
}

test('PUF-1 generation runs per upload, offers the writer the exact job; image → thumb, video → poster', async () => {
  const writer = fakeWriter()
  const gens = []
  const q = createUploadDerivativeQueue({
    writer,
    generateThumb: async (f) => { gens.push(['thumb', f.name]); return result() },
    generatePoster: async (f) => { gens.push(['poster', f.name]); return result() },
  })
  const nodeA = id22(), nodeB = id22()
  assert.equal(q.afterUpload({ file: file('a.jpg'), nodeId: nodeA, sourceBlobRef: src, kind: 'thumb' }), 'QUEUED')
  assert.equal(q.afterUpload({ file: file('b.mp4', 'video/mp4'), nodeId: nodeB, sourceBlobRef: src, kind: 'poster' }), 'QUEUED')
  await flushMicro()
  assert.deepEqual(gens, [['thumb', 'a.jpg'], ['poster', 'b.mp4']])
  assert.deepEqual(writer.offers.map((o) => [o.nodeId, o.kind, o.mime, o.width, o.height]), [[nodeA, 'thumb', 'image/jpeg', 320, 240], [nodeB, 'poster', 'image/jpeg', 320, 240]])
  assert.deepEqual(writer.offers[0].sourceBlobRef, src)
})

test('PUF-2 bounded: at most backfillConcurrency (1) generation job at a time', async () => {
  let live = 0, peak = 0
  const gates = []
  const q = createUploadDerivativeQueue({
    writer: fakeWriter(),
    generateThumb: () => new Promise((resolve) => { live++; peak = Math.max(peak, live); gates.push(() => { live--; resolve(result()) }) }),
  })
  for (let i = 0; i < 4; i++) q.afterUpload({ file: file(), nodeId: id22(), sourceBlobRef: src, kind: 'thumb' })
  for (let i = 0; i < 4; i++) { await flushMicro(); gates.shift()?.() }
  await flushMicro()
  assert.equal(peak, 1)
})

test('PUF-3 paused while an upload is active; resume() continues; never throws on generation failure', async () => {
  let deferred = true
  const writer = fakeWriter()
  let calls = 0
  const q = createUploadDerivativeQueue({ writer, isDeferred: () => deferred, retryMs: 5, generateThumb: async () => { calls++; if (calls === 1) throw new Error('boom'); return calls === 2 ? null : result() } })
  for (let i = 0; i < 3; i++) q.afterUpload({ file: file(), nodeId: id22(), sourceBlobRef: src, kind: 'thumb' })
  await flushMicro()
  assert.equal(calls, 0, 'no decode while an upload is active')
  deferred = false
  q.resume()
  await flushMicro(20)
  assert.equal(calls, 3)
  assert.equal(writer.offers.length, 1, 'throw and null produce no offer')
  q.clear()
})

test('PUF-4 skipped (no generation) when the writer is budget-exhausted, missing, or input is incomplete', async () => {
  let calls = 0
  const gen = async () => { calls++; return result() }
  const w = fakeWriter(); w.budget = true
  const q = createUploadDerivativeQueue({ writer: w, generateThumb: gen })
  assert.equal(q.afterUpload({ file: file(), nodeId: id22(), sourceBlobRef: src, kind: 'thumb' }), 'SKIPPED')
  const none = createUploadDerivativeQueue({ writer: null, generateThumb: gen })
  assert.equal(none.afterUpload({ file: file(), nodeId: id22(), sourceBlobRef: src, kind: 'thumb' }), 'SKIPPED')
  const ok = createUploadDerivativeQueue({ writer: fakeWriter(), generateThumb: gen })
  assert.equal(ok.afterUpload({ file: file(), nodeId: null, sourceBlobRef: src, kind: 'thumb' }), 'SKIPPED')
  assert.equal(ok.afterUpload({ file: file(), nodeId: id22(), sourceBlobRef: null, kind: 'thumb' }), 'SKIPPED')
  assert.equal(ok.afterUpload({ file: file(), nodeId: id22(), sourceBlobRef: src, kind: 'motion' }), 'SKIPPED')
  await flushMicro()
  assert.equal(calls, 0)
})

test('PUF-5 purge aborts in-flight generation, drops pending files, offers nothing afterwards', async () => {
  const unlockedState = createUnlockedVaultState({ closeAllPreviewSessions: () => {} })
  const writer = fakeWriter()
  let signal = null
  let resolveGen
  const q = createUploadDerivativeQueue({ writer, unlockedState, generateThumb: (f, o) => { signal = o.signal; return new Promise((r) => { resolveGen = r }) } })
  q.afterUpload({ file: file(), nodeId: id22(), sourceBlobRef: src, kind: 'thumb' })
  q.afterUpload({ file: file(), nodeId: id22(), sourceBlobRef: src, kind: 'thumb' })
  await flushMicro()
  unlockedState.purge('MANUAL_LOCK')
  assert.equal(signal.aborted, true)
  resolveGen(result())
  await flushMicro()
  assert.equal(writer.offers.length, 0)
  assert.equal(q.stats().pending, 0)
  assert.equal(q.afterUpload({ file: file(), nodeId: id22(), sourceBlobRef: src, kind: 'thumb' }), 'SKIPPED')
})

/* ── jsdom screen ─────────────────────────────────────────────────────────── */

const t = makeT('en')
let env, dom, kek, backend, fakeTree
const PI = '/api/vault/tree/preview-index'
const ORIGINALS = ['U1'.padEnd(22, 'U'), 'U2'.padEnd(22, 'V')]

before(async () => {
  env = await startVaultScreenEnv({ derivativeGenerateStub: true })
  ;({ dom } = env)
  kek = await (await env.load('/src/lib/vaultCrypto.js')).unlockVault(CORRECT_PASSPHRASE)
})
after(async () => { await env?.stop(); delete globalThis.__VAULT_BACKEND__ })

function wire({ flags, previewBudgetExhausted = false }) {
  backend = makeVaultTreeBackend({ flags: { treeUiEnabled: true, ...flags } })
  backend.tree.protocolState = 'TREE_V1'
  backend.generated = []
  backend.generate = async (f, kind) => { backend.generated.push([kind, f.name]); return result() }
  backend.previewIndexLog = []
  const inner = backend.respond
  backend.respond = async (req) => {
    const p = String(req.path)
    if (p.startsWith(PI)) {
      backend.previewIndexLog.push(`${req.method} ${p}`)
      if (p === `${PI}/head` && req.method === 'GET') return { ok: false, status: 404, data: { code: 'PREVIEW_INDEX_NOT_FOUND' }, errorKind: 'server' }
      if (p === `${PI}/head` && req.method === 'POST') return { ok: true, status: 200, data: { indexGeneration: 1, rootBlobId: 'x' }, errorKind: null }
      return { ok: true, status: 200, data: { blobs: [] }, errorKind: null }
    }
    if (p.startsWith('/api/vault/tree/') && !p.startsWith('/api/vault/tree/state') && !p.startsWith('/api/vault/tree/migration')) {
      return fakeTree.fetchJson(p, { method: req.method, body: req.options?.body, signal: req.options?.signal })
    }
    return inner(req)
  }
  const innerBytes = backend.respondBytes
  backend.respondBytes = async (req) => (String(req.path).startsWith('/api/vault/tree/') ? fakeTree.fetchBytes(String(req.path), { signal: req.options?.signal }) : innerBytes?.(req))
  let n = 0
  let originals = 0
  backend.uploadImpl = async ({ routeBase }) => {
    if (String(routeBase).startsWith(PI)) {
      backend.previewIndexLog.push(`UPLOAD ${routeBase}`)
      if (previewBudgetExhausted) return { ok: false, stage: 'failed', reason: 'server', resume: null, response: { ok: false, status: 507, data: { code: 'PREVIEW_INDEX_STORAGE_BUDGET_EXCEEDED' } } }
      return { ok: true, stage: 'complete', blob: { id: (++n).toString(16).padStart(48, '0'), formatVersion: 2, contentIdB64: 'A'.repeat(22) + '==', size: 100 }, resume: null }
    }
    return { ok: true, stage: 'complete', blob: { id: ORIGINALS[originals++], formatVersion: 2 }, resume: null }
  }
  globalThis.__VAULT_BACKEND__ = backend
}

async function tick(times = 3) { for (let i = 0; i < times; i += 1) await settle() }
const announce = () => dom.window.document.querySelector('[data-testid="vault-tree-announce"]')?.textContent ?? ''
const fileTiles = () => [...dom.window.document.querySelectorAll('[data-testid="vault-file-tile"]')]

async function dropUpload(name = 'photo.jpg', type = 'image/jpeg') {
  const grid = dom.window.document.querySelector('[data-testid="vault-tree-grid"]') ?? dom.window.document.querySelector('[data-testid="vault-tree-screen"]')
  const ev = new dom.window.Event('drop', { bubbles: true })
  Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files: [new dom.window.File([fakeJpeg()], name, { type })] } })
  await act(async () => grid.dispatchEvent(ev))
  await tick(8)
}

async function mount() {
  const h = env.mount()
  await h.render(React.createElement((await env.load('/src/screens/Vault.jsx')).Vault, { t }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  await tick(4)
  return h
}

beforeEach(async () => { fakeTree = await createFakeTreeServer({ kek, blobs: ORIGINALS.map((id) => ({ formatVersion: 2, id })) }) })

test('PUF-SCREEN-1 writer ON: original uploads, attaches and announces exactly as today; derivative queued after reconcile', async () => {
  wire({ flags: { mediaPreviewEnabled: true, previewIndexReadEnabled: true, previewIndexWriteEnabled: true } })
  const h = await mount()
  try {
    await dropUpload('photo.jpg')
    assert.ok(fileTiles().some((el) => el.textContent.includes('photo.jpg')), 'the original upload attached')
    assert.ok(announce().length > 0)
    assert.deepEqual(backend.generated, [['thumb', 'photo.jpg']], 'one generation, after the upload completed')
    assert.ok(backend.previewIndexLog.some((l) => l.startsWith(`UPLOAD ${PI}/uploads`)), 'the derivative went to the preview-index upload family')
    assert.ok(backend.previewIndexLog.includes(`POST ${PI}/head`), 'the writer committed through the independent index CAS')
    const treeCas = fakeTree.state.log.filter((l) => l.method === 'POST' && l.path === '/api/vault/tree/head')
    assert.equal(treeCas.length, 1, 'the main manifest saw exactly the one attach CAS — derivative work adds none')
    assert.equal(treeCas[0].body.includes('preview'), false)
  } finally { await h.unmount() }
})

test('PUF-SCREEN-2 preview budget exhausted: the original upload still completes, attaches and announces success', async () => {
  wire({ flags: { mediaPreviewEnabled: true, previewIndexReadEnabled: true, previewIndexWriteEnabled: true }, previewBudgetExhausted: true })
  const h = await mount()
  try {
    await dropUpload('photo.jpg')
    assert.ok(fileTiles().some((el) => el.textContent.includes('photo.jpg')))
    assert.equal(announce().includes(t('vaultTreeUploadFailed')), false, 'no failure announced for a preview-only rejection')
    assert.equal(backend.previewIndexLog.includes(`POST ${PI}/head`), false, 'no CAS after a 507')
    assert.equal(backend.previewIndexLog.filter((l) => l.startsWith('UPLOAD')).length, 1, 'one rejected preview upload, then the breaker holds')
    await dropUpload('second.jpg')
    assert.ok(fileTiles().some((el) => el.textContent.includes('second.jpg')))
    assert.equal(backend.previewIndexLog.filter((l) => l.startsWith('UPLOAD')).length, 1, 'no further preview upload this session')
    assert.equal(backend.generated.length, 1, 'no generation cost once the breaker latched')
  } finally { await h.unmount() }
})

test('PUF-SCREEN-3 writer OFF (READ on): zero generation, zero preview-index mutation', async () => {
  wire({ flags: { mediaPreviewEnabled: true, previewIndexReadEnabled: true, previewIndexWriteEnabled: false } })
  const h = await mount()
  try {
    await dropUpload('photo.jpg')
    assert.ok(fileTiles().some((el) => el.textContent.includes('photo.jpg')))
    assert.deepEqual(backend.generated, [])
    assert.equal(backend.previewIndexLog.filter((l) => !l.startsWith('GET')).length, 0)
  } finally { await h.unmount() }
})
