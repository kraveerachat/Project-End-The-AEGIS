// Private Vault tile overflow menu (Issue B) and delete (Issue C).
//
// The interaction language is borrowed from the Files screen — a MoreHorizontal
// control top-right, a dropdown of real buttons, danger styling for Delete —
// but the *actions* are not: the server sees only ciphertext, so Rename, Move,
// Secure Share and SHA verification are not offered here.
//
// The locked-mode policy under test is: deletion IS allowed while locked, with
// a stronger confirmation that shows only the opaque blob id and the ciphertext
// size. Rationale is recorded in src/screens/Vault.jsx — a vault whose key is
// lost is unrecoverable by design, and disabling locked deletion would leave
// such a user with blobs that can neither be opened nor removed, forever.
import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import React from 'react'

import { makeT } from '../src/lib/strings.js'
import { makeVaultBackend, serverBlob, CORRECT_PASSPHRASE } from './fixtures/vaultScreenBackend.js'
import {
  startVaultScreenEnv, settle, click, pressKey, byText,
  tileMenuButtons, tileIds, unlock, lockVault, uploadFile,
} from './helpers/vaultScreenHarness.js'

const t = makeT('en')
const PLAINTEXT = 'DSC09870.gif'

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
  backend.state['/api/vault'].data = {
    configured: true,
    blobs: [serverBlob({ id: 'blob-a', name: PLAINTEXT, plainSize: 2048, size: 2096 })],
  }
})

const doc = () => dom.window.document
const html = () => doc().body.textContent
const menuButton = (id = 'blob-a') => doc().querySelector(`[data-vault-tile-menu="${id}"]`)
const menu = () => doc().querySelector('[role="menu"]')
const menuItems = () => [...doc().querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim())
const menuItem = (label) => [...doc().querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim() === label)
const dialog = () => doc().querySelector('[role="dialog"]')

/** Only accept the DELETE for `id`; everything else is a 204 no-op. */
function acceptDelete(id, response = { ok: true, status: 204, data: null, errorKind: null }) {
  backend.respond = async ({ path, method }) => {
    if (method === 'DELETE' && path === `/api/vault/blobs/${id}`) return response
    return { ok: true, status: 204, data: null, errorKind: null }
  }
}

async function openUnlockedMenu(h) {
  await h.render(React.createElement(Vault, { t }))
  await unlock(dom, t, CORRECT_PASSPHRASE)
  await click(dom, menuButton())
  return menuButton()
}

/* ── the menu ─────────────────────────────────────────────────────── */

test('every tile carries a keyboard-reachable MoreHorizontal control', async () => {
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    const buttons = tileMenuButtons(dom)
    assert.equal(buttons.length, 1, 'one overflow control per tile')

    const btn = buttons[0]
    assert.equal(btn.tagName, 'BUTTON', 'a real button, not a div with a click handler')
    assert.equal(btn.getAttribute('tabindex'), null, 'never removed from the tab order')
    assert.equal(btn.disabled, false)
    assert.equal(btn.getAttribute('aria-haspopup'), 'menu')
    assert.equal(btn.getAttribute('aria-expanded'), 'false')

    btn.focus()
    assert.equal(doc().activeElement, btn, 'the control can take focus')
  } finally {
    await h.unmount()
  }
})

test('the menu opens on click and reports its expanded state', async () => {
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    assert.equal(menu(), null, 'closed by default')

    await click(dom, menuButton())
    assert.ok(menu(), 'the dropdown opened')
    assert.equal(menuButton().getAttribute('aria-expanded'), 'true')
    assert.equal(menu().getAttribute('aria-label'), t('moreActions'))
  } finally {
    await h.unmount()
  }
})

test('the menu opens from a plain click with no hover event at all', async () => {
  // Touch devices never produce mouseenter. The control must not depend on it.
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    const btn = menuButton()
    assert.equal(btn.getAttribute('data-visible'), 'false', 'no hover has happened')
    assert.ok(
      btn.className.includes('tile-hover-control'),
      'visibility is delegated to CSS that keeps the control visible on coarse pointers',
    )

    await click(dom, btn)
    assert.ok(menu(), 'a touch-style click alone opens the menu')
  } finally {
    await h.unmount()
  }
})

test('a click away closes the menu, and a click inside it does not', async () => {
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await click(dom, menuButton())
    assert.ok(menu(), 'open')

    await click(dom, menu())
    assert.ok(menu(), 'clicking the dropdown itself keeps it open')

    await click(dom, doc().body)
    assert.equal(menu(), null, 'a click outside closes it')
  } finally {
    await h.unmount()
  }
})

test('Escape closes the menu', async () => {
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await click(dom, menuButton())
    assert.ok(menu())

    await pressKey(dom, 'Escape')
    assert.equal(menu(), null)
  } finally {
    await h.unmount()
  }
})

test('the menu button toggles rather than stacking a second dropdown', async () => {
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await click(dom, menuButton())
    assert.equal(doc().querySelectorAll('[role="menu"]').length, 1)
    await click(dom, menuButton())
    assert.equal(menu(), null, 'a second click closes it')
  } finally {
    await h.unmount()
  }
})

test('the menu layer sits above the tile ciphertext hatch', async () => {
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    const container = menuButton().parentElement
    assert.equal(container.style.zIndex, '2', 'the control container is lifted above the hatch veil')

    const hatch = doc().querySelector('.hatch')
    assert.ok(hatch, 'the locked tile still renders its hatch veil')
    assert.equal(hatch.style.zIndex, '', 'the hatch itself claims no stacking level')
    assert.ok(hatch.className.includes('pointer-events-none'), 'and never swallows the click')

    await click(dom, menuButton())
    assert.equal(menu().style.zIndex, 'var(--z-dropdown)', 'the dropdown uses the shared dropdown layer')
  } finally {
    await h.unmount()
  }
})

/* ── unlocked actions ─────────────────────────────────────────────── */

test('the unlocked menu offers exactly Download and Delete', async () => {
  const h = env.mount()
  try {
    await openUnlockedMenu(h)
    assert.deepEqual(menuItems(), [t('download'), t('delete')])

    // Actions the Vault cannot truthfully perform must not be borrowed from Files.
    for (const absent of [t('rename'), t('move'), t('createSecureShare'), t('verifySha'), t('viewMetadata'), t('viewHistory')]) {
      assert.equal(menuItem(absent), undefined, `"${absent}" is not a Vault action`)
    }
  } finally {
    await h.unmount()
  }
})

test('Delete is styled as the dangerous action', async () => {
  const h = env.mount()
  try {
    await openUnlockedMenu(h)
    assert.equal(menuItem(t('delete')).style.color, 'var(--danger)')
    assert.notEqual(menuItem(t('download')).style.color, 'var(--danger)')
  } finally {
    await h.unmount()
  }
})

test('Download still works from the menu while unlocked', async () => {
  const before = env.objectUrls.length
  const h = env.mount()
  try {
    await openUnlockedMenu(h)
    await click(dom, menuItem(t('download')))
    await settle()

    assert.ok(
      backend.requests.some((r) => r.method === 'GET_BYTES' && r.path === '/api/vault/blobs/blob-a'),
      'the ciphertext was fetched for client-side decryption',
    )
    assert.ok(env.objectUrls.length > before, 'a decrypted blob URL was handed to the browser')
    assert.equal(menu(), null, 'the menu closes after the action runs')
  } finally {
    await h.unmount()
  }
})

test('opening the menu never triggers Download by itself', async () => {
  const h = env.mount()
  try {
    await openUnlockedMenu(h)
    assert.equal(
      backend.requests.filter((r) => r.method === 'GET_BYTES').length, 0,
      'no ciphertext was fetched merely by opening the menu',
    )
    assert.equal(dialog(), null, 'and no confirmation opened either')
  } finally {
    await h.unmount()
  }
})

/* ── unlocked delete ──────────────────────────────────────────────── */

test('Delete opens a confirmation naming the decrypted file, and Cancel keeps the blob', async () => {
  acceptDelete('blob-a')
  const h = env.mount()
  try {
    await openUnlockedMenu(h)
    await click(dom, menuItem(t('delete')))

    const modal = dialog()
    assert.ok(modal, 'deletion always goes through a confirmation, never window.confirm')
    assert.match(modal.textContent, /DSC09870\.gif/, 'the unlocked vault can name the file honestly')
    assert.match(modal.textContent, new RegExp(t('vaultDeleteBody').slice(0, 40)))
    assert.ok(byText(dom, 'button', t('vaultDeleteConfirm')), 'the destructive action is spelled out')

    await click(dom, byText(dom, 'button', t('cancel')))
    assert.equal(dialog(), null, 'the confirmation closed')
    assert.deepEqual(tileIds(dom), ['blob-a'], 'cancelling keeps the blob')
    assert.equal(
      backend.requests.filter((r) => r.method === 'DELETE').length, 0,
      'and sends no DELETE at all',
    )
  } finally {
    await h.unmount()
  }
})

test('the confirmation focuses Cancel, not the destructive button', async () => {
  const h = env.mount()
  try {
    await openUnlockedMenu(h)
    await click(dom, menuItem(t('delete')))
    assert.equal(doc().activeElement.textContent.trim(), t('cancel'))
  } finally {
    await h.unmount()
  }
})

test('a 204 removes the card immediately, and neither Lock nor Unlock nor a refetch brings it back', async () => {
  acceptDelete('blob-a')
  const h = env.mount()
  try {
    await openUnlockedMenu(h)
    await click(dom, menuItem(t('delete')))
    await click(dom, byText(dom, 'button', t('vaultDeleteConfirm')))

    const deletes = backend.requests.filter((r) => r.method === 'DELETE')
    assert.equal(deletes.length, 1)
    assert.equal(deletes[0].path, '/api/vault/blobs/blob-a', 'the existing endpoint, by blob id only')
    assert.equal(deletes[0].body, undefined, 'no user id is ever sent from the browser')

    assert.equal(dialog(), null, 'the confirmation closed')
    assert.deepEqual(tileIds(dom), [], 'the card disappeared without a refresh')
    assert.doesNotMatch(html(), /DSC09870\.gif/, 'no ghost card')
    assert.ok(backend.requests.some((r) => r.method === 'REFRESH'), 'a background reconcile was requested')

    await lockVault(dom, t)
    assert.deepEqual(tileIds(dom), [], 'the deleted opaque blob is absent while locked')

    // A refetch that still lists the blob — the GET was in flight during the DELETE.
    await h.render(React.createElement(Vault, { t }))
    await settle()
    assert.deepEqual(tileIds(dom), [], 'a stale server refetch does not resurrect it')

    await unlock(dom, t, CORRECT_PASSPHRASE)
    assert.deepEqual(tileIds(dom), [], 'and unlocking does not restore the deleted file')
    assert.doesNotMatch(html(), /DSC09870\.gif/)
  } finally {
    await h.unmount()
  }
})

test('a failed DELETE keeps the card and states the failure instead of faking success', async () => {
  acceptDelete('blob-a', { ok: false, status: 500, data: { error: 'Internal error' }, errorKind: 'server' })
  const h = env.mount()
  try {
    await openUnlockedMenu(h)
    await click(dom, menuItem(t('delete')))
    await click(dom, byText(dom, 'button', t('vaultDeleteConfirm')))

    assert.ok(dialog(), 'the confirmation stays open')
    assert.match(dialog().textContent, new RegExp(t('vaultDeleteFailed').slice(0, 30)), 'the failure is stated')
    assert.equal(dialog().querySelector('[role="alert"]')?.textContent, t('vaultDeleteFailed'))

    await click(dom, byText(dom, 'button', t('cancel')))
    assert.deepEqual(tileIds(dom), ['blob-a'], 'the blob is still listed, because it still exists')
    assert.match(html(), /DSC09870\.gif/)

    await lockVault(dom, t)
    assert.deepEqual(tileIds(dom), ['blob-a'], 'and it is still there while locked')
  } finally {
    await h.unmount()
  }
})

test('a delete confirmation open when the vault locks does not keep the filename on screen', async () => {
  const h = env.mount()
  try {
    await openUnlockedMenu(h)
    await click(dom, menuItem(t('delete')))
    assert.match(dialog().textContent, /DSC09870\.gif/)

    await lockVault(dom, t)
    assert.equal(dialog(), null, 'the dialog closed with the key')
    assert.doesNotMatch(html(), /DSC09870\.gif/, 'no plaintext survived the lock')
  } finally {
    await h.unmount()
  }
})

/* ── locked delete: zero-knowledge confirmation ───────────────────── */

test('the locked menu offers only Delete encrypted item — never a plaintext Download', async () => {
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await click(dom, menuButton())

    assert.deepEqual(menuItems(), [t('vaultDeleteLockedAction')])
    assert.equal(menuItem(t('download')), undefined, 'downloading undecryptable bytes is not offered')
    assert.doesNotMatch(html(), /DSC09870\.gif/, 'the menu leaks no decrypted metadata')
  } finally {
    await h.unmount()
  }
})

test('the locked confirmation shows only the opaque id and the ciphertext size', async () => {
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await click(dom, menuButton())
    await click(dom, menuItem(t('vaultDeleteLockedAction')))

    const modal = dialog()
    assert.ok(modal, 'locked deletion still confirms first')
    assert.match(modal.textContent, /blob-a/, 'the opaque blob id identifies the target')
    assert.match(modal.textContent, /2\.0 KB|2 KB|2,096|2\.05 KB/, 'the ciphertext size is shown')
    assert.match(modal.textContent, new RegExp(t('vaultDeleteLockedBody').slice(0, 40)), 'it says why no filename is shown')
    assert.match(modal.textContent, new RegExp(t('vaultOpaqueId')))
    assert.match(modal.textContent, new RegExp(t('vaultCiphertextSize')))

    // ⚠️ The whole point: nothing was decrypted to populate this dialog.
    assert.doesNotMatch(doc().body.innerHTML, /DSC09870/, 'no plaintext filename anywhere in the DOM')
    assert.doesNotMatch(doc().body.innerHTML, /image\/gif/, 'no MIME type either')
    for (const el of doc().querySelectorAll('[title], [aria-label], [alt], [aria-describedby]')) {
      const attrs = ['title', 'aria-label', 'alt'].map((a) => el.getAttribute(a) ?? '').join(' ')
      assert.doesNotMatch(attrs, /DSC09870|\.gif/, 'no accessibility attribute leaks plaintext')
    }
  } finally {
    await h.unmount()
  }
})

test('a locked delete uses the same endpoint and removes the blob', async () => {
  acceptDelete('blob-a')
  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await click(dom, menuButton())
    await click(dom, menuItem(t('vaultDeleteLockedAction')))
    await click(dom, byText(dom, 'button', t('vaultDeleteConfirm')))

    const deletes = backend.requests.filter((r) => r.method === 'DELETE')
    assert.deepEqual(deletes.map((r) => r.path), ['/api/vault/blobs/blob-a'])
    assert.deepEqual(tileIds(dom), [], 'the encrypted item is gone')
    assert.match(html(), new RegExp(t('emptyVault')))

    await unlock(dom, t, CORRECT_PASSPHRASE)
    assert.deepEqual(tileIds(dom), [], 'unlocking does not bring it back')
  } finally {
    await h.unmount()
  }
})

test('an entry whose metadata will not decrypt is deleted through the opaque confirmation', async () => {
  // A corrupted envelope: the vault is unlocked, but this blob has no readable
  // name. The confirmation must not invent one.
  backend.state['/api/vault'].data = {
    configured: true,
    blobs: [{ id: 'blob-x', size: 999, metaB64: 'not-base64-json' }],
  }
  acceptDelete('blob-x')

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    assert.match(html(), new RegExp(t('vaultUnnamed')), 'an unreadable entry says so')

    await click(dom, menuButton('blob-x'))
    await click(dom, menuItem(t('delete')))
    assert.match(dialog().textContent, /blob-x/, 'it is identified by its opaque id')
    assert.match(dialog().textContent, new RegExp(t('vaultOpaqueId')))

    await click(dom, byText(dom, 'button', t('vaultDeleteConfirm')))
    assert.deepEqual(tileIds(dom), [])
  } finally {
    await h.unmount()
  }
})

/* ── the menu after a fresh upload ────────────────────────────────── */

test('a just-uploaded blob gets a working menu before any refetch lands', async () => {
  const A = serverBlob({ id: 'blob-new', name: 'FRESH.gif' })
  backend.state['/api/vault'].data = { configured: true, blobs: [] }
  backend.respond = async ({ path, method }) => {
    if (method === 'POST' && path === '/api/vault/blobs') {
      return { ok: true, status: 201, data: { blob: A }, errorKind: null }
    }
    if (method === 'DELETE' && path === '/api/vault/blobs/blob-new') {
      return { ok: true, status: 204, data: null, errorKind: null }
    }
    return { ok: true, status: 204, data: null, errorKind: null }
  }

  const h = env.mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await unlock(dom, t, CORRECT_PASSPHRASE)
    await uploadFile(dom, { name: 'FRESH.gif' })

    await click(dom, menuButton('blob-new'))
    await click(dom, menuItem(t('delete')))
    assert.match(dialog().textContent, /FRESH\.gif/)
    await click(dom, byText(dom, 'button', t('vaultDeleteConfirm')))

    assert.deepEqual(tileIds(dom), [], 'delete works on a blob the server list has never reported')
    await lockVault(dom, t)
    assert.deepEqual(tileIds(dom), [], 'and it does not reappear as ciphertext')
  } finally {
    await h.unmount()
  }
})
