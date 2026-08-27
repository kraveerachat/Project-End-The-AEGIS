// Regression cover for the production Private Vault state bug:
//
//   unlock -> upload a file -> the file appears -> click Lock immediately ->
//   the screen renders "Empty Vault" -> unlock again -> the file is still
//   missing -> refresh the page -> the file comes back.
//
// The encrypted blob was never lost. Locked mode read `vaultApi.data.blobs`,
// the result of the *previous* GET, while a successful upload only ever touched
// the decrypted `entries`. `vaultApi.retry()` cannot fix this: a user can click
// Lock before an asynchronous refetch resolves, and does.
//
// Every test below therefore locks WITHOUT letting a refetch land first.
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { makeVaultBackend, serverBlob, CORRECT_PASSPHRASE } from './fixtures/vaultScreenBackend.js'
import {
  startVaultScreenEnv, settle, click, byText, byTextContaining,
  tileIds, uploadFile, unlock, lockVault,
} from './helpers/vaultScreenHarness.js'

const t = makeT('en')

// Mirrors IDLE_LOCK_MS in src/screens/Vault.jsx — the 10-minute idle auto-lock.
const IDLE_LOCK_MS = 10 * 60_000

let env
let dom
let Vault

before(async () => {
  env = await startVaultScreenEnv()
  ;({ dom, Vault } = env)
})

after(async () => {
  await env?.stop()
  delete globalThis.__VAULT_BACKEND__
})

let backend
beforeEach(() => {
  backend = makeVaultBackend()
  globalThis.__VAULT_BACKEND__ = backend
})

const html = () => dom.window.document.body.textContent
const setServerBlobs = (blobs) => { backend.state['/api/vault'].data = { configured: true, blobs } }

/** POST /api/vault/blobs succeeds and returns `blob`; everything else 204s. */
function acceptUpload(blob) {
  backend.respond = async ({ path, method }) => {
    if (method === 'POST' && path === '/api/vault/blobs') {
      return { ok: true, status: 201, data: { blob }, errorKind: null }
    }
    return { ok: true, status: 204, data: null, errorKind: null }
  }
}

/* ── CASE 1 ───────────────────────────────────────────────────────── */

test('CASE 1: lock immediately after upload keeps the new blob as a ciphertext card, and an immediate re-unlock decrypts it', async () => {
  const A = serverBlob({ id: 'blob-a', name: 'DSC09870.gif', size: 2096 })
  setServerBlobs([])
  acceptUpload(A)

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    assert.ok(byText(dom, 'button', t('lockVault')), 'the vault is unlocked')

    await uploadFile(dom, { name: 'DSC09870.gif' })
    assert.match(html(), /DSC09870\.gif/, 'the new file appears immediately while unlocked')
    assert.deepEqual(tileIds(dom), ['blob-a'])

    // ★ The exact production sequence: Lock now, before any GET has landed.
    //   `backend.state` is still the pre-upload response.
    assert.deepEqual(backend.state['/api/vault'].data.blobs, [], 'no refetch result has arrived yet')
    await lockVault(dom, t)

    assert.deepEqual(tileIds(dom), ['blob-a'], 'the newly uploaded blob is still on screen')
    assert.doesNotMatch(html(), /DSC09870\.gif/, 'but its plaintext filename is gone')
    assert.match(html(), /blob-a\.aegisenc/, 'it renders as an opaque ciphertext card')
    assert.doesNotMatch(html(), new RegExp(t('emptyVault')), 'the vault is not reported as empty')

    // ★ And an immediate correct unlock decrypts that same blob — no reload.
    await unlock(dom, t, CORRECT_PASSPHRASE)
    assert.match(html(), /DSC09870\.gif/, 'the plaintext filename returns without a remount')
    assert.deepEqual(tileIds(dom), ['blob-a'])
  } finally {
    await h.unmount()
  }
})

/* ── CASE 2 ───────────────────────────────────────────────────────── */

test('CASE 2: a pre-existing blob plus a new upload reconcile to exactly two cards after the server refetch', async () => {
  const B = serverBlob({ id: 'blob-b', name: 'ARCHIVE.zip', size: 4096 })
  const A = serverBlob({ id: 'blob-a', name: 'DSC09870.gif', size: 2096 })
  setServerBlobs([B])
  acceptUpload(A)

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    assert.deepEqual(tileIds(dom), ['blob-b'])

    await uploadFile(dom, { name: 'DSC09870.gif' })
    assert.deepEqual(tileIds(dom), ['blob-a', 'blob-b'], 'both files are present, newest first')

    // The background reconcile lands: the server now reports A and B.
    assert.ok(
      backend.requests.some((r) => r.method === 'REFRESH'),
      'a successful upload triggers a background reconcile',
    )
    setServerBlobs([A, B])
    await h.render(React.createElement(Vault, { t }))
    await settle()

    assert.deepEqual(tileIds(dom), ['blob-a', 'blob-b'], 'exactly two cards, not three')
    assert.equal(html().match(/DSC09870\.gif/g)?.length, 1, 'the uploaded file is named once')

    await lockVault(dom, t)
    assert.deepEqual(tileIds(dom), ['blob-a', 'blob-b'], 'and locking still shows exactly two')
  } finally {
    await h.unmount()
  }
})

/* ── CASE 3 ───────────────────────────────────────────────────────── */

test('CASE 3: a failed upload leaves no ghost blob and no ghost plaintext entry', async () => {
  setServerBlobs([])
  backend.respond = async ({ path, method }) => {
    if (method === 'POST' && path === '/api/vault/blobs') {
      return { ok: false, status: 500, data: { error: 'Internal error' }, errorKind: 'server' }
    }
    return { ok: true, status: 204, data: null, errorKind: null }
  }

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)

    await uploadFile(dom, { name: 'NEVER-STORED.gif' })

    assert.deepEqual(tileIds(dom), [], 'nothing was added to the decrypted list')
    assert.doesNotMatch(html(), /NEVER-STORED\.gif/, 'no ghost plaintext entry')
    assert.match(html(), new RegExp(t('actionFailed')), 'the failure is stated, not hidden')

    await lockVault(dom, t)
    assert.deepEqual(tileIds(dom), [], 'and no ghost opaque blob survives the lock')
    assert.match(html(), new RegExp(t('emptyVault')), 'an empty vault is honestly empty')

    assert.equal(
      backend.requests.filter((r) => r.method === 'REFRESH').length, 0,
      'a failed upload does not pretend to have something to reconcile',
    )
  } finally {
    await h.unmount()
  }
})

/* ── CASE 4 ───────────────────────────────────────────────────────── */

test('CASE 4: the 10-minute idle auto-lock keeps a newly uploaded blob as a ciphertext card', async () => {
  const A = serverBlob({ id: 'blob-a', name: 'DSC09870.gif', size: 2096 })
  setServerBlobs([])
  acceptUpload(A)

  // The idle lock is a real 10-minute timer. Intercept only that one delay and
  // leave every other timer (shake reset, blob-URL revoke, React's scheduler)
  // running normally, so nothing else about the screen is simulated away.
  const realSetTimeout = globalThis.setTimeout
  const idleTimers = []
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === IDLE_LOCK_MS) {
      const handle = { fn, args, cancelled: false }
      idleTimers.push(handle)
      return handle
    }
    return realSetTimeout(fn, ms, ...args)
  }
  const realClearTimeout = globalThis.clearTimeout
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object' && 'cancelled' in handle) {
      handle.cancelled = true
      return
    }
    return realClearTimeout(handle)
  }

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await uploadFile(dom, { name: 'DSC09870.gif' })
    assert.match(html(), /DSC09870\.gif/, 'the upload is visible before the vault goes idle')

    const armed = idleTimers.filter((timer) => !timer.cancelled)
    assert.equal(armed.length, 1, 'exactly one idle auto-lock timer is armed while unlocked')

    await act(async () => { armed[0].fn(...armed[0].args) })
    await settle()
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }

  try {
    assert.equal(byText(dom, 'button', t('lockVault')), undefined, 'the idle timer locked the vault')
    assert.match(html(), new RegExp(t('vaultAutoLocked')), 'the auto-lock is announced, not silent')
    assert.deepEqual(tileIds(dom), ['blob-a'], 'the newly uploaded blob survives the auto-lock')
    assert.doesNotMatch(html(), /DSC09870\.gif/, 'with no plaintext filename left on screen')
    assert.match(html(), /blob-a\.aegisenc/, 'it renders as an opaque ciphertext card')
  } finally {
    await h.unmount()
  }
})

/* ── supporting guarantees ────────────────────────────────────────── */

test('locking clears the key and every plaintext trace, exactly as before', async () => {
  const B = serverBlob({ id: 'blob-b', name: 'ARCHIVE.zip' })
  setServerBlobs([B])

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    assert.match(html(), /ARCHIVE\.zip/)

    await lockVault(dom, t)
    assert.doesNotMatch(html(), /ARCHIVE\.zip/, 'no plaintext filename survives the lock')
    assert.equal(
      dom.window.document.querySelectorAll('[title]').length >= 0, true,
    )
    for (const el of dom.window.document.querySelectorAll('[title], [aria-label]')) {
      assert.doesNotMatch(
        `${el.getAttribute('title') ?? ''} ${el.getAttribute('aria-label') ?? ''}`,
        /ARCHIVE\.zip/,
        'no accessible attribute leaks the plaintext filename while locked',
      )
    }
  } finally {
    await h.unmount()
  }
})

test('a wrong key leaves the vault locked and the opaque inventory untouched', async () => {
  const B = serverBlob({ id: 'blob-b', name: 'ARCHIVE.zip' })
  setServerBlobs([B])

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, 'not-the-right-key')

    assert.match(html(), new RegExp(t('vaultWrongKey')), 'the wrong-key message is shown')
    assert.doesNotMatch(html(), /ARCHIVE\.zip/, 'nothing was decrypted')
    assert.deepEqual(tileIds(dom), ['blob-b'], 'the opaque card is still listed')
  } finally {
    await h.unmount()
  }
})

test('a stale GET that omits a just-uploaded blob does not remove its card', async () => {
  const A = serverBlob({ id: 'blob-a', name: 'DSC09870.gif' })
  setServerBlobs([])
  acceptUpload(A)

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await uploadFile(dom, { name: 'DSC09870.gif' })

    // A GET that was already in flight when the POST completed comes back empty.
    setServerBlobs([])
    await h.render(React.createElement(Vault, { t }))
    await settle()
    await lockVault(dom, t)

    assert.deepEqual(tileIds(dom), ['blob-a'], 'the successful POST result outranks a stale GET')
  } finally {
    await h.unmount()
  }
})

test('the empty state still renders when the vault genuinely has no blobs', async () => {
  setServerBlobs([])
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    assert.ok(byTextContaining(dom, 'p, h3, h2, div', t('emptyVault')), 'an empty configured vault says so')
    assert.deepEqual(tileIds(dom), [])
  } finally {
    await h.unmount()
  }
})
