// Private Vault inline preview and the File details / Encrypted item details
// dialogs.
//
// The product ask is "a Google-Drive-like preview", and the interesting part is
// what makes that legitimate in a zero-knowledge vault. The server holds only
// ciphertext and must never learn otherwise, so there is no preview endpoint, no
// server-side thumbnail, and no transcode. The pipeline the tests pin down is:
//
//   GET /api/vault/blobs/:id  →  ciphertext
//     →  decryptFileContent(kek, entry.blob, ciphertext)   ← browser only
//     →  a temporary object URL
//     →  <img> / <video controls>
//
// Two properties matter more than the pixels, and neither is visible on screen:
//
//  1. Only the allowlisted raster image and video types are ever rendered. TXT,
//     PDF, DOCX, archives, SVG, and unknown application/* stay download-only,
//     because rendering them needs an iframe/object/embed or our own parser —
//     which is exactly the "vault interprets its own contents" hazard.
//  2. Every object URL is revoked. An un-revoked object URL is decrypted
//     plaintext the tab is still holding, reachable by anyone who can read the
//     URL, so the revoke is a confidentiality property, not tidiness. It must
//     happen on close, on manual lock, on the 10-minute idle auto-lock, on
//     unmount, and when one preview replaces another.
//
// The suite stubs vaultCrypto with the deterministic fake envelope from
// tests/fixtures/vaultScreenBackend.js — real Argon2id and AES-256-GCM are
// covered by tests/vaultCrypto.test.js. What is under test here is the screen's
// policy and its plaintext lifetime, not the cipher.
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import React, { act } from 'react'

import { makeT } from '../src/lib/strings.js'
import { previewKindFor, PREVIEW_IMAGE_TYPES, PREVIEW_VIDEO_TYPES } from '../src/lib/vaultPreview.js'
import { makeVaultBackend, serverBlob, CORRECT_PASSPHRASE } from './fixtures/vaultScreenBackend.js'
import {
  startVaultScreenEnv, settle, click, byText, byTextContaining,
  tileIds, unlock, lockVault, uploadFile,
} from './helpers/vaultScreenHarness.js'

const t = makeT('en')
// Kept in step with IDLE_LOCK_MS in src/screens/Vault.jsx on purpose: the test
// intercepts that exact delay, so a change to the product's idle window has to
// be a deliberate edit here too rather than a silently unarmed timer.
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

const doc = () => dom.window.document
const html = () => doc().body.textContent
const menuButton = (id) => doc().querySelector(`[data-vault-tile-menu="${id}"]`)
const menuItems = () => [...doc().querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim())
const menuItem = (label) => [...doc().querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === label)
const dialog = () => doc().querySelector('[role="dialog"]')
const stage = () => doc().querySelector('[data-vault-preview-stage]')

/** Seed one blob and return the id the tile will carry. */
function seed({ id = 'blob-a', name, type, plainSize = 2048, size = 2096 }) {
  backend.state['/api/vault'].data = {
    configured: true,
    blobs: [serverBlob({ id, name, type, plainSize, size })],
  }
  return id
}

async function openMenu(h, id = 'blob-a') {
  await h.render(React.createElement(Vault, { t }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  await click(dom, menuButton(id))
}

/* ── the policy itself, without a browser ─────────────────────────── */

test('the preview allowlist names each renderable type explicitly', () => {
  for (const mime of PREVIEW_IMAGE_TYPES) assert.equal(previewKindFor(mime), 'image', mime)
  for (const mime of PREVIEW_VIDEO_TYPES) assert.equal(previewKindFor(mime), 'video', mime)

  // Everything the product decision keeps out, including the near-misses.
  const refused = [
    'text/plain', 'text/html', 'text/csv',
    'image/svg+xml', 'image/bmp', 'image/tiff',
    'application/pdf', 'application/zip', 'application/octet-stream',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/x-msdownload', 'video/quicktime', 'audio/mpeg',
    '', null, undefined, 'nonsense',
  ]
  for (const mime of refused) assert.equal(previewKindFor(mime), null, String(mime))
})

test('a MIME type is matched on its type alone, case and parameters aside', () => {
  assert.equal(previewKindFor('IMAGE/PNG'), 'image')
  assert.equal(previewKindFor(' video/mp4 '), 'video')
  assert.equal(previewKindFor('image/jpeg; charset=binary'), 'image')
  // A parameter cannot smuggle a refused type past the allowlist.
  assert.equal(previewKindFor('image/svg+xml; charset=utf-8'), null)
})

/* ── which entries offer Preview ──────────────────────────────────── */

test('an image entry offers Preview, File details, Download and Delete in that order', async () => {
  seed({ name: 'holiday.png', type: 'image/png' })
  const h = env.mount()
  try {
    await openMenu(h)
    assert.deepEqual(menuItems(), [t('preview'), t('fileDetails'), t('download'), t('delete')])
  } finally {
    await h.unmount()
  }
})

test('a video entry offers the same four actions', async () => {
  seed({ name: 'clip.mp4', type: 'video/mp4' })
  const h = env.mount()
  try {
    await openMenu(h)
    assert.deepEqual(menuItems(), [t('preview'), t('fileDetails'), t('download'), t('delete')])
  } finally {
    await h.unmount()
  }
})

for (const [label, type, name] of [
  ['a text file', 'text/plain', 'notes.txt'],
  ['a PDF', 'application/pdf', 'contract.pdf'],
  ['an archive', 'application/zip', 'backup.zip'],
  ['an unknown binary', 'application/octet-stream', 'firmware.bin'],
  ['an SVG', 'image/svg+xml', 'logo.svg'],
]) {
  test(`${label} is download-only: no Preview command exists`, async () => {
    seed({ name, type })
    const h = env.mount()
    try {
      await openMenu(h)
      assert.deepEqual(menuItems(), [t('fileDetails'), t('download'), t('delete')])
      assert.equal(menuItem(t('preview')), undefined, 'AEGIS does not render this type inline')

      // And the tile itself must not become a hidden download or a dead button.
      const tile = menuButton('blob-a').closest('div.relative')
      assert.equal(
        [...tile.querySelectorAll('button')].filter((b) => b.getAttribute('aria-label')?.startsWith(t('preview'))).length,
        0,
        'the thumbnail is not a preview affordance for a type that cannot be previewed',
      )
    } finally {
      await h.unmount()
    }
  })
}

test(`an unsupported file still downloads through the real decrypt path`, async () => {
  seed({ name: 'notes.txt', type: 'text/plain' })
  const before = env.objectUrls.length
  const h = env.mount()
  try {
    await openMenu(h)
    await click(dom, menuItem(t('download')))
    await settle()

    assert.ok(
      backend.requests.some((r) => r.method === 'GET_BYTES' && r.path === '/api/vault/blobs/blob-a'),
      'the ciphertext was fetched and decrypted in the browser like any other file',
    )
    assert.ok(env.objectUrls.length > before, 'the browser was handed decrypted bytes to save')
    assert.equal(stage(), null, 'and nothing was rendered inline')
  } finally {
    await h.unmount()
  }
})

/* ── image preview ────────────────────────────────────────────────── */

test('Preview fetches ciphertext, decrypts in the browser, and renders from a local object URL', async () => {
  seed({ name: 'holiday.png', type: 'image/png' })
  const h = env.mount()
  try {
    await openMenu(h)
    await click(dom, menuItem(t('preview')))
    await settle()

    const bytesRequests = backend.requests.filter((r) => r.method === 'GET_BYTES')
    assert.deepEqual(bytesRequests.map((r) => r.path), ['/api/vault/blobs/blob-a'],
      'the existing encrypted download route is reused — there is no preview endpoint')
    assert.equal(
      backend.requests.some((r) => /thumb|preview|render/i.test(r.path)), false,
      'no server-side thumbnail or transcode was ever requested',
    )

    const img = doc().querySelector('[data-vault-preview-stage] img')
    assert.ok(img, 'a raster image is rendered with <img>')
    assert.match(img.getAttribute('src'), /^blob:/, 'from a local object URL, never a server URL')
    assert.equal(img.getAttribute('alt'), 'holiday.png', 'the unlocked vault may name the file')
    assert.equal(doc().querySelector('iframe, object, embed'), null,
      'decrypted content is never handed to a document-embedding element')

    assert.match(dialog().textContent, /holiday\.png/)
  } finally {
    await h.unmount()
  }
})

test('closing the preview revokes the object URL', async () => {
  seed({ name: 'holiday.png', type: 'image/png' })
  const h = env.mount()
  const urls = env.trackObjectUrls()
  try {
    await openMenu(h)
    await click(dom, menuItem(t('preview')))
    await settle()
    const url = doc().querySelector('[data-vault-preview-stage] img').getAttribute('src')
    assert.equal(env.revokedUrls.includes(url), false, 'still live while it is on screen')

    await click(dom, byText(dom, 'button', t('close')))
    assert.equal(stage(), null, 'the preview closed')
    assert.ok(env.revokedUrls.includes(url), 'and the decrypted bytes were released')
    assert.deepEqual(urls.live(), [], 'nothing decrypted is left reachable')
  } finally {
    await h.unmount()
  }
})

test('locking while a preview is open closes it and revokes the object URL', async () => {
  seed({ name: 'holiday.png', type: 'image/png' })
  const h = env.mount()
  const urls = env.trackObjectUrls()
  try {
    await openMenu(h)
    await click(dom, menuItem(t('preview')))
    await settle()
    const url = doc().querySelector('[data-vault-preview-stage] img').getAttribute('src')
    assert.match(html(), /holiday\.png/)

    await lockVault(dom, t)

    assert.equal(stage(), null, 'the preview closed with the key')
    assert.equal(dialog(), null, 'no dialog outlived the lock')
    assert.ok(env.revokedUrls.includes(url), 'the object URL was revoked')
    assert.deepEqual(urls.live(), [], 'no decrypted bytes survive a lock')
    assert.doesNotMatch(doc().body.innerHTML, /holiday\.png/, 'and no plaintext filename survives either')
    assert.deepEqual(tileIds(dom), ['blob-a'], 'the blob is still listed, as opaque ciphertext')
  } finally {
    await h.unmount()
  }
})

test('the 10-minute idle auto-lock cleans up an open preview exactly like a manual lock', async () => {
  seed({ name: 'holiday.png', type: 'image/png' })

  // Intercept only the 10-minute delay and leave every other timer running, so
  // the auto-lock path under test is the screen's real one — the same `lock()`
  // the Lock button calls, not a re-implementation.
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const idleTimers = []
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === IDLE_LOCK_MS) {
      const handle = { fn, args, cancelled: false }
      idleTimers.push(handle)
      return handle
    }
    return realSetTimeout(fn, ms, ...args)
  }
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === 'object' && 'cancelled' in handle) {
      handle.cancelled = true
      return
    }
    return realClearTimeout(handle)
  }

  const h = env.mount()
  const urls = env.trackObjectUrls()
  let url
  try {
    await openMenu(h)
    await click(dom, menuItem(t('preview')))
    await settle()
    url = doc().querySelector('[data-vault-preview-stage] img').getAttribute('src')
    assert.match(html(), /holiday\.png/)

    const armed = idleTimers.filter((timer) => !timer.cancelled)
    assert.equal(armed.length, 1, 'exactly one idle auto-lock timer is armed while unlocked')
    await act(async () => { armed[0].fn(...armed[0].args) })
    await settle()
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }

  try {
    assert.match(html(), new RegExp(t('vaultAutoLocked')), 'the vault re-locked itself')
    assert.equal(stage(), null, 'the preview is gone')
    assert.equal(dialog(), null, 'no dialog outlived the auto-lock')
    assert.ok(env.revokedUrls.includes(url), 'and its object URL was revoked')
    assert.deepEqual(urls.live(), [], 'walking away from the desk leaks no plaintext')
    assert.doesNotMatch(doc().body.innerHTML, /holiday\.png/)
    assert.deepEqual(tileIds(dom), ['blob-a'], 'the blob is still listed as ciphertext')
  } finally {
    await h.unmount()
  }
})

test('unmounting the screen with a preview open releases the decrypted bytes', async () => {
  seed({ name: 'holiday.png', type: 'image/png' })
  const h = env.mount()
  const urls = env.trackObjectUrls()
  await openMenu(h)
  await click(dom, menuItem(t('preview')))
  await settle()
  const url = doc().querySelector('[data-vault-preview-stage] img').getAttribute('src')

  await h.unmount()
  assert.ok(env.revokedUrls.includes(url), 'navigating away is not a reason to keep plaintext alive')
  assert.deepEqual(urls.live(), [])
})

test('opening a second preview revokes the first one instead of stacking two', async () => {
  backend.state['/api/vault'].data = {
    configured: true,
    blobs: [
      serverBlob({ id: 'blob-a', name: 'one.png', type: 'image/png' }),
      serverBlob({ id: 'blob-b', name: 'two.png', type: 'image/png' }),
    ],
  }
  const h = env.mount()
  const urls = env.trackObjectUrls()
  try {
    await openMenu(h, 'blob-a')
    await click(dom, menuItem(t('preview')))
    await settle()
    const first = doc().querySelector('[data-vault-preview-stage] img').getAttribute('src')

    await click(dom, byText(dom, 'button', t('close')))
    await click(dom, menuButton('blob-b'))
    await click(dom, menuItem(t('preview')))
    await settle()

    const second = doc().querySelector('[data-vault-preview-stage] img').getAttribute('src')
    assert.notEqual(second, first, 'the second preview got its own URL')
    assert.ok(env.revokedUrls.includes(first), 'the first was released')
    assert.deepEqual(urls.live(), [second], 'exactly one live object URL at a time')
    assert.match(dialog().textContent, /two\.png/)
  } finally {
    await h.unmount()
  }
})

test('a preview that cannot be decrypted says so instead of showing a broken frame', async () => {
  seed({ name: 'holiday.png', type: 'image/png' })
  backend.respondBytes = async () => ({ ok: false, status: 500, bytes: null, errorKind: 'server' })
  const h = env.mount()
  const urls = env.trackObjectUrls()
  try {
    await openMenu(h)
    await click(dom, menuItem(t('preview')))
    await settle()

    assert.equal(doc().querySelector('[data-vault-preview-stage] img'), null, 'no empty <img> is left behind')
    assert.match(stage().textContent, new RegExp(t('vaultPreviewUnavailable').slice(0, 30)))
    assert.equal(stage().querySelector('[role="alert"]').textContent, t('vaultPreviewUnavailable'))
    assert.deepEqual(urls.created(), [], 'a failed preview creates no object URL at all')
  } finally {
    await h.unmount()
  }
})

/* ── video preview ────────────────────────────────────────────────── */

test('a video preview uses <video controls> from a local object URL and never autoplays', async () => {
  seed({ name: 'clip.mp4', type: 'video/mp4' })
  const h = env.mount()
  try {
    await openMenu(h)
    await click(dom, menuItem(t('preview')))
    await settle()

    assert.deepEqual(
      backend.requests.filter((r) => r.method === 'GET_BYTES').map((r) => r.path),
      ['/api/vault/blobs/blob-a'],
      'the same encrypted download path — decryption is still browser-only',
    )

    const video = doc().querySelector('[data-vault-preview-stage] video')
    assert.ok(video, 'a video is rendered with <video>')
    assert.equal(video.hasAttribute('controls'), true, 'the viewer stays in control of playback')
    assert.equal(video.hasAttribute('autoplay'), false, 'a vault file never starts playing by itself')
    assert.equal(video.hasAttribute('loop'), false)
    assert.match(video.getAttribute('src'), /^blob:/, 'the only source is the local object URL')
    assert.equal(video.querySelector('source'), null, 'no alternate or remote source is offered')
    assert.equal(stage().getAttribute('data-vault-preview-stage'), 'video')
  } finally {
    await h.unmount()
  }
})

test('a video preview states that it is decrypting before the bytes arrive', async () => {
  seed({ name: 'clip.mp4', type: 'video/mp4' })
  let release
  backend.respondBytes = () => new Promise((resolve) => {
    release = () => resolve({ ok: true, status: 200, bytes: new Uint8Array([1, 2, 3]), errorKind: null })
  })
  const h = env.mount()
  try {
    await openMenu(h)
    await click(dom, menuItem(t('preview')))

    // The whole ciphertext has to be fetched and authenticated before a single
    // frame exists — GCM has no per-range mode — so the wait is real and is
    // reported as such rather than hidden behind a still frame.
    assert.match(stage().textContent, new RegExp(t('vaultDecrypting')))
    assert.equal(doc().querySelector('[data-vault-preview-stage] video'), null)

    release()
    await settle()
    assert.ok(doc().querySelector('[data-vault-preview-stage] video'), 'the player appears once the bytes are ready')
  } finally {
    await h.unmount()
  }
})

test('locking mid-decrypt never leaves an object URL behind', async () => {
  seed({ name: 'clip.mp4', type: 'video/mp4' })
  let release
  backend.respondBytes = () => new Promise((resolve) => {
    release = () => resolve({ ok: true, status: 200, bytes: new Uint8Array([1, 2, 3]), errorKind: null })
  })
  const h = env.mount()
  const urls = env.trackObjectUrls()
  try {
    await openMenu(h)
    await click(dom, menuItem(t('preview')))
    assert.match(stage().textContent, new RegExp(t('vaultDecrypting')))

    await lockVault(dom, t)
    release()
    await settle()

    assert.equal(stage(), null, 'the abandoned preview never opened')
    assert.deepEqual(urls.created(), [], 'the abandoned decrypt never even minted a URL')
    assert.deepEqual(urls.live(), [], 'and nothing decrypted is left reachable')
    assert.doesNotMatch(doc().body.innerHTML, /clip\.mp4/)
  } finally {
    await h.unmount()
  }
})

/* ── details ──────────────────────────────────────────────────────── */

test('unlocked File details report the decrypted name, MIME type and both sizes', async () => {
  seed({ name: 'holiday.png', type: 'image/png', plainSize: 2048, size: 2096 })
  const h = env.mount()
  try {
    await openMenu(h)
    await click(dom, menuItem(t('fileDetails')))

    const modal = dialog()
    assert.ok(modal, 'the details dialog opened')
    assert.match(modal.textContent, new RegExp(t('fileDetails')))
    assert.match(modal.textContent, /holiday\.png/, 'the unlocked vault can name the file')
    assert.match(modal.textContent, /image\/png/, 'and state the type it actually recorded')

    // Plaintext size and encrypted storage size are different facts and are
    // labelled as different facts.
    assert.ok(byTextContaining(dom, 'dt', t('vaultPlaintextSize')), 'plaintext size is labelled')
    assert.ok(byTextContaining(dom, 'dt', t('vaultCiphertextSize')), 'ciphertext size is labelled separately')
    assert.match(modal.textContent, /2\.0 KB/, 'plaintext size')
    assert.match(modal.textContent, /2\.0 KB|2\.05 KB/, 'ciphertext size')
    assert.ok(byTextContaining(dom, 'dt', t('uploadedAt')), 'the server-side timestamp is shown')

    // Nothing the application does not actually possess.
    assert.doesNotMatch(modal.textContent, /storage[_ ]?key|\/var\/|\/srv\/|uploads\//i,
      'no filesystem path or server internal is invented')
    assert.equal(backend.requests.filter((r) => r.method === 'GET_BYTES').length, 0,
      'reading metadata does not download the file')
  } finally {
    await h.unmount()
  }
})

test('details for an entry whose envelope will not decrypt claim nothing', async () => {
  backend.state['/api/vault'].data = {
    configured: true,
    blobs: [{ id: 'blob-x', size: 999, createdAt: 1_756_000_000_000, metaB64: 'not-base64-json' }],
  }
  const h = env.mount()
  try {
    await openMenu(h, 'blob-x')
    await click(dom, menuItem(t('fileDetails')))

    const modal = dialog()
    assert.match(modal.textContent, new RegExp(t('vaultUnnamed')), 'an unreadable name says so')
    assert.equal(byTextContaining(dom, 'dt', t('vaultPlaintextSize')), undefined, 'no plaintext size is fabricated')
    assert.match(modal.textContent, /blob-x/, 'the opaque id is still a truthful identifier')
  } finally {
    await h.unmount()
  }
})

test('a details dialog open when the vault locks does not keep the filename on screen', async () => {
  seed({ name: 'holiday.png', type: 'image/png' })
  const h = env.mount()
  try {
    await openMenu(h)
    await click(dom, menuItem(t('fileDetails')))
    assert.match(dialog().textContent, /holiday\.png/)

    await lockVault(dom, t)
    assert.equal(dialog(), null, 'the dialog closed with the key')
    assert.doesNotMatch(doc().body.innerHTML, /holiday\.png|image\/png/, 'no plaintext survived the lock')
  } finally {
    await h.unmount()
  }
})

/* ── the scheme the preview mints must be the scheme the CSP allows ── */

// jsdom does not enforce CSP and never fetches an object URL, so every test
// above passes whether or not the browser would actually load the picture.
// That gap is exactly how PR #40 reached production with a working preview
// pipeline and a broken-image icon on screen. This test closes it by reading
// the scheme off the element the screen really rendered and checking it against
// the policy the real middleware really emits — the two halves that have to
// agree, asserted together.
test('the object-URL scheme the preview renders is permitted by the served CSP', async () => {
  const { securityHeaders } = await import('../server/middleware/securityHeaders.js')
  const sourcesFor = (directive) => {
    let policy
    securityHeaders({}, { setHeader: (name, value) => {
      if (String(name).toLowerCase() === 'content-security-policy') policy = value
    } }, () => {})
    const found = policy.split(';')
      .map((part) => part.trim().split(/\s+/).filter(Boolean))
      .find((parts) => parts[0]?.toLowerCase() === directive)
    // A missing directive falls back to default-src, which is how <video> was
    // being blocked before media-src existed at all.
    return found ? found.slice(1) : policy.split(';')
      .map((part) => part.trim().split(/\s+/).filter(Boolean))
      .find((parts) => parts[0]?.toLowerCase() === 'default-src').slice(1)
  }

  backend.state['/api/vault'].data = {
    configured: true,
    blobs: [
      serverBlob({ id: 'blob-a', name: 'holiday.png', type: 'image/png' }),
      serverBlob({ id: 'blob-b', name: 'clip.mp4', type: 'video/mp4' }),
    ],
  }
  const h = env.mount()
  try {
    await openMenu(h, 'blob-a')
    await click(dom, menuItem(t('preview')))
    await settle()
    const imgScheme = new URL(doc().querySelector('[data-vault-preview-stage] img').getAttribute('src')).protocol
    assert.equal(imgScheme, 'blob:', 'the image really is rendered from an object URL')
    assert.ok(sourcesFor('img-src').includes(imgScheme),
      `img-src must permit ${imgScheme} or the browser shows a broken-image icon`)

    await click(dom, byText(dom, 'button', t('close')))
    await click(dom, menuButton('blob-b'))
    await click(dom, menuItem(t('preview')))
    await settle()
    const videoScheme = new URL(doc().querySelector('[data-vault-preview-stage] video').getAttribute('src')).protocol
    assert.equal(videoScheme, 'blob:')
    assert.ok(sourcesFor('media-src').includes(videoScheme),
      `media-src must permit ${videoScheme} or the player never loads`)

    // The same scheme must remain unusable for execution. Display and execute
    // are different grants and this suite depends on them staying different.
    assert.equal(sourcesFor('script-src').includes('blob:'), false,
      'a previewable blob URL must never also be an executable one')
  } finally {
    await h.unmount()
  }
})

/* ── the tile shortcut ────────────────────────────────────────────── */

test('clicking a previewable tile opens Preview without disturbing the overflow menu', async () => {
  seed({ name: 'holiday.png', type: 'image/png' })
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)

    const shortcut = [...doc().querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === `${t('preview')} — holiday.png`)
    assert.ok(shortcut, 'the thumbnail of a previewable file is a real, labelled button')

    await click(dom, shortcut)
    await settle()
    assert.ok(doc().querySelector('[data-vault-preview-stage] img'), 'the preview opened')
    assert.equal(doc().querySelector('[role="menu"]'), null, 'and the overflow menu was never involved')
  } finally {
    await h.unmount()
  }
})

test('a freshly uploaded image is previewable before any refetch lands', async () => {
  const fresh = serverBlob({ id: 'blob-new', name: 'FRESH.png', type: 'image/png' })
  backend.state['/api/vault'].data = { configured: true, blobs: [] }
  backend.respond = async ({ path, method }) => {
    if (method === 'POST' && path === '/api/vault/blobs') {
      return { ok: true, status: 201, data: { blob: fresh }, errorKind: null }
    }
    return { ok: true, status: 204, data: null, errorKind: null }
  }

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await uploadFile(dom, { name: 'FRESH.png', type: 'image/png' })

    await click(dom, menuButton('blob-new'))
    assert.deepEqual(menuItems(), [t('preview'), t('fileDetails'), t('download'), t('delete')],
      'the MIME type recorded at upload time is kept, not re-derived later')
    await click(dom, menuItem(t('preview')))
    await settle()
    assert.ok(doc().querySelector('[data-vault-preview-stage] img'))
  } finally {
    await h.unmount()
  }
})
