// tests/protectedTrashLockedUi.test.js — AEGIS Drive (IDEA1)
// The locked Protected Trash screen: an unlock dialog over the real Trash
// shell, replacing the full-page hatch panel that read as a separate
// placeholder screen.
//
// The security property under test is stronger than "the metadata is covered".
// While locked, the screen never requests /api/trash at all, so there is no
// protected metadata in the document for a blur to hide — the shell behind the
// dialog is geometry, not data with CSS over it. These tests assert both
// halves: nothing is requested, and nothing is rendered.
//
// The server-side boundary (423 until a correct current-account password opens
// the step-up window, rate limiting, expiry) is covered by protectedTrash.test.js
// and is untouched here; this file covers what the client does in front of it.
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { STRINGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const apiStubPath = normalizePath(path.join(rootDir, 'tests/fixtures/trashLockedApi.js'))

let dom
let createRoot
let vite
let Trash
let trashBackend

// Real deleted-file metadata. If any of this reaches the DOM, or the route that
// carries it is requested, while the screen is locked, the test fails.
const SECRET_ITEMS = [
  {
    id: 'f1',
    name: 'Q3-severance-list.xlsx',
    type: 'doc',
    ext: 'xlsx',
    size: 184320,
    sha256Prefix: 'a1b2c3d4e5f6',
    deletedAt: '2026-08-30T04:00:00.000Z',
    purgeAt: '2026-09-29T04:00:00.000Z',
    versionCount: 2,
  },
]

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))

  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    resolve: { alias: [{ find: '../lib/api.js', replacement: apiStubPath }] },
  })
  ;({ Trash } = await vite.ssrLoadModule('/src/screens/Trash.jsx'))
  ;({ trashBackend } = await vite.ssrLoadModule('/tests/fixtures/trashLockedApi.js'))
})

after(async () => {
  await vite?.close()
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
  dom?.window.close()
})

beforeEach(() => {
  trashBackend.reset({ items: SECRET_ITEMS })
})

/* ── harness ──────────────────────────────────────────────────────── */

async function mountTrash(lang = 'en') {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(Trash, { t: makeT(lang) })))
  // Let the mount-time /api/trash/status promise settle.
  await act(async () => { await Promise.resolve() })

  const doc = dom.window.document
  return {
    host,
    doc,
    /** The dialog, wherever the portal put it. */
    dialog: () => doc.querySelector('[role="dialog"]'),
    passwordInput: () => doc.querySelector('#trash-password'),
    /** Everything the user can see, dialog and page shell together. */
    text: () => doc.body.textContent,
    /** The inert page shell behind the dialog. */
    shell: () => host.querySelector('[data-trash-shell]'),
    /** The status banner. It is present in both states, and inert only while
        the dialog is open, so the page never jumps when Escape closes it. */
    banner: () => host.querySelector('[role="status"]'),
    async type(value) {
      const input = doc.querySelector('#trash-password')
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(input, value)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
    },
    async submit() {
      const form = doc.querySelector('#trash-password').closest('form')
      await act(async () => {
        form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
      })
      await act(async () => { await Promise.resolve() })
    },
    async pressKey(key, init = {}) {
      await act(async () => {
        dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, ...init }))
      })
    },
    async unmount() { await act(async () => root.unmount()); host.remove() },
  }
}

/** Every fragment of protected metadata that must never appear while locked. */
function assertNoProtectedMetadata(screen, when) {
  const text = screen.text()
  for (const fragment of ['Q3-severance-list', 'a1b2c3d4e5f6', '180 KB', '2026-08-30', '2026-09-29']) {
    assert.ok(!text.includes(fragment), `${when}: "${fragment}" must not be rendered`)
  }
  assert.equal(
    trashBackend.metadataRequests(), 0,
    `${when}: /api/trash must not be requested at all — there must be no metadata in the client to hide`,
  )
}

/* ── the locked screen ────────────────────────────────────────────── */

test('TRASH-LOCK-UI-1 the locked screen never requests trash metadata', async () => {
  const screen = await mountTrash()
  try {
    assert.ok(trashBackend.paths().includes('/api/trash/status'), 'the screen asks whether the step-up window is open')
    assertNoProtectedMetadata(screen, 'while locked')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-LOCK-UI-2 an unlock dialog opens over the Trash shell, not a replacement page', async () => {
  const screen = await mountTrash()
  try {
    const dialog = screen.dialog()
    assert.ok(dialog, 'a real dialog must be rendered')
    assert.equal(dialog.getAttribute('aria-modal'), 'true')
    assert.equal(
      dialog.getAttribute('aria-labelledby'), 'trash-unlock-title',
      'the dialog must be named by its own heading',
    )
    assert.ok(dialog.textContent.includes(STRINGS.en.trashLockedTitle))
    assert.ok(screen.passwordInput(), 'the dialog must carry the current-password field')
    assert.equal(screen.passwordInput().type, 'password')

    // The Trash shell is still the page behind it — retention header, search,
    // sort — rather than a full-page replacement panel.
    const shell = screen.shell()
    assert.ok(shell, 'the page shell must still be rendered behind the dialog')
    for (const copy of [STRINGS.en.trashRetention, STRINGS.en.trashSearch, STRINGS.en.trashSortDeleted]) {
      assert.ok(shell.textContent.includes(copy), `the shell must keep its "${copy}" structure`)
    }
  } finally {
    await screen.unmount()
  }
})

test('TRASH-LOCK-UI-3 the shell behind the dialog is inert and holds no data', async () => {
  const screen = await mountTrash()
  try {
    const shell = screen.shell()
    assert.ok(shell.hasAttribute('inert'), 'the shell must be inert while the screen is locked')
    assert.equal(shell.getAttribute('aria-hidden'), 'true', 'the shell must be out of the accessibility tree')

    // Nothing inside it can be reached by keyboard or pointer.
    for (const control of shell.querySelectorAll('input, select, button')) {
      const unreachable = control.disabled === true || control.getAttribute('tabindex') === '-1'
      assert.ok(unreachable, `"${control.tagName}" inside the inert shell must not be operable`)
    }
    assertNoProtectedMetadata(screen, 'in the shell')
  } finally {
    await screen.unmount()
  }
})

/* ── failing step-up ──────────────────────────────────────────────── */

test('TRASH-LOCK-UI-4 a wrong password keeps the dialog open and reveals nothing', async () => {
  trashBackend.unlockResult = { ok: false, status: 401, data: null, errorKind: 'unauthorized' }
  const screen = await mountTrash()
  try {
    await screen.type('wrong-password')
    await screen.submit()

    assert.ok(screen.dialog(), 'the dialog stays open after a failed step-up')
    assert.ok(screen.text().includes(STRINGS.en.trashUnlockFailed), 'the real failure is shown')
    assertNoProtectedMetadata(screen, 'after a failed unlock')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-LOCK-UI-5 a rate-limited step-up shows the rate-limit state, not a generic failure', async () => {
  trashBackend.unlockResult = { ok: false, status: 429, data: null, errorKind: 'server' }
  const screen = await mountTrash()
  try {
    await screen.type('wrong-password')
    await screen.submit()

    assert.ok(screen.text().includes(STRINGS.en.trashRateLimited), 'the rate-limited state is distinct')
    assert.ok(!screen.text().includes(STRINGS.en.trashUnlockFailed))
    assertNoProtectedMetadata(screen, 'after a rate-limited unlock')
  } finally {
    await screen.unmount()
  }
})

/* ── successful step-up ───────────────────────────────────────────── */

test('TRASH-LOCK-UI-6 a correct password closes the dialog and loads the real items in place', async () => {
  const screen = await mountTrash()
  try {
    await screen.type('correct-password')
    await screen.submit()

    assert.equal(screen.dialog(), null, 'the dialog closes on success')
    assert.equal(screen.host.querySelector('[data-trash-shell]'), null, 'the placeholder shell is gone once unlocked')
    assert.equal(trashBackend.metadataRequests(), 1, 'metadata is requested exactly once, after the unlock')
    assert.ok(screen.text().includes('Q3-severance-list.xlsx'), 'the real items render on the same page')
    assert.ok(screen.text().includes(STRINGS.en.trashUnlocked), 'the unlock is confirmed to the user')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-LOCK-UI-7 the password is never persisted to browser storage', async () => {
  const screen = await mountTrash()
  try {
    await screen.type('correct-password')
    await screen.submit()

    const stores = [dom.window.localStorage, dom.window.sessionStorage]
    for (const store of stores) {
      for (let i = 0; i < store.length; i += 1) {
        assert.ok(
          !String(store.getItem(store.key(i))).includes('correct-password'),
          'the step-up password must never reach browser storage',
        )
      }
    }
    assert.equal(screen.passwordInput(), null, 'the field is gone once the dialog closes')
  } finally {
    await screen.unmount()
  }
})

/* ── keyboard ─────────────────────────────────────────────────────── */

test('TRASH-LOCK-UI-8 Escape closes the dialog, leaves the page locked, and offers a way back in', async () => {
  const screen = await mountTrash()
  try {
    await screen.pressKey('Escape')

    assert.equal(screen.dialog(), null, 'Escape closes the dialog')
    assert.ok(screen.shell().hasAttribute('inert'), 'the page stays visibly and actually locked')
    assert.ok(
      screen.text().includes(STRINGS.en.trashLockedBadge),
      'the page states that it is locked rather than looking merely empty',
    )
    assertNoProtectedMetadata(screen, 'after Escape')

    // The reopen control is the one live thing on the page: Escape must not
    // strand a keyboard user on a screen where nothing can be operated.
    const reopen = [...screen.host.querySelectorAll('button')].find(
      (b) => b.textContent.includes(STRINGS.en.trashLockedReopen) && !b.closest('[inert]'),
    )
    assert.ok(reopen, 'a reachable control must reopen the unlock dialog')

    await act(async () => reopen.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
    assert.ok(screen.dialog(), 'the dialog reopens')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-LOCK-UI-9 focus starts in the password field and Tab stays inside the dialog', async () => {
  const screen = await mountTrash()
  try {
    assert.equal(
      screen.doc.activeElement, screen.passwordInput(),
      'initial focus belongs to the password field, not the close button',
    )

    const stops = [...screen.dialog().querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    assert.ok(stops.length >= 2, 'the dialog has more than one tab stop to cycle between')

    // Forward from the last stop wraps to the first.
    await act(async () => stops[stops.length - 1].focus())
    await screen.pressKey('Tab')
    assert.equal(screen.doc.activeElement, stops[0], 'Tab wraps to the first control instead of leaving the dialog')

    // Backward from the first stop wraps to the last.
    await act(async () => stops[0].focus())
    await screen.pressKey('Tab', { shiftKey: true })
    assert.equal(screen.doc.activeElement, stops[stops.length - 1], 'Shift+Tab wraps to the last control')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-LOCK-UI-11 the locked banner is always present, and inert only while the dialog is open', async () => {
  const screen = await mountTrash()
  try {
    // Present with the dialog open: the user can see WHAT is locked behind it,
    // and the page does not resize when the dialog closes.
    const openBanner = screen.banner()
    assert.ok(openBanner, 'the banner is rendered while the dialog is open')
    assert.ok(openBanner.textContent.includes(STRINGS.en.trashLockedBadge))
    assert.ok(openBanner.hasAttribute('inert'), 'while the dialog is open the banner is inert too')
    assert.equal(
      openBanner.getAttribute('aria-hidden'), 'true',
      'so no focusable control sits outside the dialog',
    )

    await screen.pressKey('Escape')
    const closedBanner = screen.banner()
    assert.ok(closedBanner, 'the banner survives the dialog closing — no layout jump')
    assert.equal(closedBanner.hasAttribute('inert'), false, 'and becomes operable again')
    assertNoProtectedMetadata(screen, 'with the banner shown')
  } finally {
    await screen.unmount()
  }
})

/* ── localisation ─────────────────────────────────────────────────── */

test('TRASH-LOCK-UI-10 the locked state is fully translated', () => {
  for (const key of ['trashLockedBadge', 'trashLockedPlaceholder', 'trashLockedReopen', 'trashLockedTitle', 'trashLockedBody']) {
    for (const lang of ['en', 'th', 'zh']) {
      const value = STRINGS[lang][key]
      assert.ok(typeof value === 'string' && value.trim().length > 0, `[${lang}] ${key} is missing`)
    }
    for (const lang of ['th', 'zh']) {
      assert.notEqual(STRINGS[lang][key], STRINGS.en[key], `[${lang}] ${key} must be translated`)
    }
  }
})
