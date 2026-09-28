// tests/trashDestructiveReauthUi.test.js — Trash UI destructive re-auth and search isolation
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
const apiStubPath = normalizePath(path.join(rootDir, 'tests/fixtures/trashDestructiveApi.js'))

let dom
let createRoot
let vite
let Trash
let trashBackend

const SAMPLE_ITEMS = [
  {
    id: 'f1',
    name: 'audit-log-2026.csv',
    type: 'doc',
    ext: 'csv',
    size: 524288000,
    sha256Prefix: 'a1b2c3d4',
    deletedAt: '2026-09-20T04:00:00.000Z',
    purgeAt: '2026-10-20T04:00:00.000Z',
    versionCount: 1,
  },
  {
    id: 'f2',
    name: 'backup-image.iso',
    type: 'raw',
    ext: 'iso',
    size: 1073741824,
    sha256Prefix: 'e5f6a1b2',
    deletedAt: '2026-09-21T04:00:00.000Z',
    purgeAt: '2026-10-21T04:00:00.000Z',
    versionCount: 1,
  },
  {
    id: 'f3',
    name: 'system-report.pdf',
    type: 'doc',
    ext: 'pdf',
    size: 2097152,
    sha256Prefix: 'c3d4e5f6',
    deletedAt: '2026-09-22T04:00:00.000Z',
    purgeAt: '2026-10-22T04:00:00.000Z',
    versionCount: 3,
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
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: [{ find: '../lib/api.js', replacement: apiStubPath }] },
  })
  ;({ Trash } = await vite.ssrLoadModule('/src/screens/Trash.jsx'))
  ;({ trashBackend } = await vite.ssrLoadModule('/tests/fixtures/trashDestructiveApi.js'))
})

after(async () => {
  await vite?.close()
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
  dom?.window.close()
})

beforeEach(() => {
  trashBackend.reset({ items: [...SAMPLE_ITEMS], unlocked: true })
})

async function mountTrash({ lang = 'en', user = { username: 'admin', role: 'admin' }, onStorageMutationCommitted } = {}) {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(React.createElement(Trash, { t: makeT(lang), user, onStorageMutationCommitted })))
  // Settle initial load /api/trash/status and /api/trash
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })

  const doc = dom.window.document
  return {
    host,
    doc,
    dialog: () => doc.querySelector('[role="dialog"]'),
    searchInput: () => host.querySelector('input[type="search"]'),
    searchForm: () => host.querySelector('form[role="search"]'),
    purgePasswordInput: () => doc.querySelector('#trash-purge-password'),
    emptyPasswordInput: () => doc.querySelector('#trash-empty-password'),
    itemsRendered: () => [...host.querySelectorAll('p.truncate')].map((el) => el.textContent.trim()),
    async setSearchQuery(val) {
      const input = host.querySelector('input[type="search"]')
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(input, val)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      })
    },
    async clickDeletePermanently(itemName) {
      const rows = [...host.querySelectorAll('.ui-card')]
      const target = rows.find((r) => r.textContent.includes(itemName))
      if (!target) throw new Error(`Row for ${itemName} not found`)
      const deleteBtn = [...target.querySelectorAll('button')].find((b) =>
        b.textContent.includes(STRINGS.en.trashDeleteForever)
      )
      if (!deleteBtn) throw new Error(`Delete forever button for ${itemName} not found`)
      await act(async () => {
        deleteBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    },
    async clickRestore(itemName) {
      const rows = [...host.querySelectorAll('.ui-card')]
      const target = rows.find((r) => r.textContent.includes(itemName))
      if (!target) throw new Error(`Row for ${itemName} not found`)
      const restoreBtn = [...target.querySelectorAll('button')].find((b) =>
        b.textContent.includes(STRINGS.en.trashRestore)
      )
      if (!restoreBtn) throw new Error(`Restore button for ${itemName} not found`)
      await act(async () => {
        restoreBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    },
    async submitRestore() {
      const dialog = doc.querySelector('[role="dialog"]')
      const submitBtn = [...dialog.querySelectorAll('button')].find((b) =>
        b.textContent.trim() === STRINGS.en.trashRestore && !b.getAttribute('aria-label')
      )
      await act(async () => {
        submitBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
      await act(async () => { await Promise.resolve() })
      await act(async () => { await Promise.resolve() })
    },
    async openEmptyTrash() {
      const emptyBtn = [...host.querySelectorAll('button')].find((b) =>
        b.textContent.includes(STRINGS.en.trashEmpty)
      )
      if (!emptyBtn) throw new Error('Empty trash button not found')
      await act(async () => {
        emptyBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      })
    },
    async submitEmptyTrash(confirmVal, pwd) {
      const confirmInput = doc.querySelector('#trash-empty-confirm')
      const pwdInput = doc.querySelector('#trash-empty-password')
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(confirmInput, confirmVal)
        confirmInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
        setter.call(pwdInput, pwd)
        pwdInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      const form = pwdInput.closest('form')
      await act(async () => {
        if (form) {
          form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
        }
      })
      await act(async () => { await Promise.resolve() })
      await act(async () => { await Promise.resolve() })
    },
    async submitPurgePassword(pwd) {
      const input = doc.querySelector('#trash-purge-password')
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      await act(async () => {
        setter.call(input, pwd)
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
      })
      const form = input.closest('form')
      await act(async () => {
        if (form) {
          form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
        } else {
          const submitBtn = [...doc.querySelectorAll('[role="dialog"] button')].find((b) =>
            b.textContent.includes(STRINGS.en.trashDeleteForever)
          )
          submitBtn?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
        }
      })
      await act(async () => { await Promise.resolve() })
      await act(async () => { await Promise.resolve() })
    },
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

test('TRASH-REAUTH-1 search input has isolated form role and explicit autocomplete off', async () => {
  const screen = await mountTrash()
  try {
    const input = screen.searchInput()
    assert.ok(input, 'search input must be rendered')
    assert.equal(input.getAttribute('name'), 'trashSearch', 'name must be trashSearch')
    assert.equal(input.getAttribute('autoComplete'), 'off', 'autoComplete must be off')
    assert.equal(input.getAttribute('autoCorrect'), 'off', 'autoCorrect must be off')
    assert.equal(input.getAttribute('autoCapitalize'), 'off', 'autoCapitalize must be off')
    assert.equal(input.getAttribute('spellCheck'), 'false', 'spellCheck must be false')

    const form = screen.searchForm()
    assert.ok(form, 'search input must be wrapped in form[role="search"]')
    assert.ok(form.contains(input), 'search input must be inside search form')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-REAUTH-2 purge modal wraps in isolated form with explicit username context', async () => {
  const screen = await mountTrash({ user: { username: 'testadmin', role: 'admin' } })
  try {
    await screen.clickDeletePermanently('audit-log-2026.csv')
    const dialog = screen.dialog()
    assert.ok(dialog, 'purge modal dialog must open')

    const pwdInput = screen.purgePasswordInput()
    assert.ok(pwdInput, 'purge password input exists')
    assert.equal(pwdInput.getAttribute('autoComplete'), 'current-password')
    assert.equal(pwdInput.getAttribute('name'), 'trashPurgePassword')

    const form = pwdInput.closest('form')
    assert.ok(form, 'password input must be inside an explicit <form>')
    assert.ok(dialog.contains(form), 'form must be inside the dialog')

    const usernameInput = form.querySelector('input[autoComplete="username"]')
    assert.ok(usernameInput, 'form must contain explicit autoComplete="username" field')
    assert.equal(usernameInput.getAttribute('name'), 'username')
    assert.equal(usernameInput.value, 'testadmin', 'username field reflects current user username')
    assert.equal(usernameInput.readOnly, true, 'username field is readOnly')
    assert.equal(usernameInput.tabIndex, -1, 'username field is removed from tab stops')
    assert.equal(usernameInput.getAttribute('aria-hidden'), 'true', 'hidden from accessibility tree')
    assert.ok(usernameInput.classList.contains('sr-only'), 'visually hidden with sr-only')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-REAUTH-3 empty trash modal wraps in isolated form with explicit username context', async () => {
  const screen = await mountTrash({ user: { username: 'admin' } })
  try {
    const emptyBtn = [...screen.host.querySelectorAll('button')].find((b) =>
      b.textContent.includes(STRINGS.en.trashEmpty)
    )
    await act(async () => {
      emptyBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    })

    const dialog = screen.dialog()
    assert.ok(dialog, 'empty trash modal dialog must open')

    const pwdInput = screen.emptyPasswordInput()
    assert.ok(pwdInput, 'empty password input exists')
    assert.equal(pwdInput.getAttribute('autoComplete'), 'current-password')
    assert.equal(pwdInput.getAttribute('name'), 'trashEmptyPassword')

    const form = pwdInput.closest('form')
    assert.ok(form, 'password input must be inside an explicit <form>')

    const usernameInput = form.querySelector('input[autoComplete="username"]')
    assert.ok(usernameInput, 'empty trash form must contain explicit autoComplete="username"')
    assert.equal(usernameInput.value, 'admin')

    const confirmInput = screen.doc.querySelector('#trash-empty-confirm')
    assert.equal(confirmInput.getAttribute('autoComplete'), 'off')
    assert.equal(confirmInput.getAttribute('name'), 'trashConfirmText')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-REAUTH-4 permanent deletion removes only targeted item and preserves remaining rows', async () => {
  const screen = await mountTrash()
  try {
    assert.deepEqual(screen.itemsRendered(), ['system-report.pdf', 'backup-image.iso', 'audit-log-2026.csv'])
    assert.equal(screen.searchInput().value, '', 'initial search input is empty')

    await screen.clickDeletePermanently('audit-log-2026.csv')
    assert.ok(screen.dialog(), 'purge dialog open')

    await screen.submitPurgePassword('secret')

    assert.equal(screen.dialog(), null, 'purge dialog closed on success')
    // Crucial check: remaining 2 items must still be rendered!
    assert.deepEqual(screen.itemsRendered(), ['system-report.pdf', 'backup-image.iso'], 'remaining rows preserved')
    // Search query was not corrupted
    assert.equal(screen.searchInput().value, '', 'search input remains empty')
    assert.ok(!screen.host.textContent.includes(STRINGS.en.trashNoMatches), 'no search-mismatch empty state')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-REAUTH-5 pre-existing user search query is preserved across deletion flow', async () => {
  const screen = await mountTrash()
  try {
    // User searches for "report"
    await screen.setSearchQuery('report')
    assert.deepEqual(screen.itemsRendered(), ['system-report.pdf'], 'only matching item visible')

    await screen.clickDeletePermanently('system-report.pdf')
    await screen.submitPurgePassword('secret')

    assert.equal(screen.dialog(), null, 'dialog closed')
    // User search query 'report' is strictly preserved
    assert.equal(screen.searchInput().value, 'report', 'search query preserved')
    // Since only system-report.pdf matched 'report' and was deleted, now empty search state is legitimately shown
    assert.deepEqual(screen.itemsRendered(), [])
    assert.ok(screen.host.textContent.includes(STRINGS.en.trashNoMatches))
  } finally {
    await screen.unmount()
  }
})

test('TRASH-REAUTH-6 failed reauth keeps dialog open, shows error, leaves items and query intact', async () => {
  const screen = await mountTrash()
  try {
    await screen.clickDeletePermanently('audit-log-2026.csv')
    await screen.submitPurgePassword('wrong-password')

    assert.ok(screen.dialog(), 'dialog remains open on failed auth')
    assert.ok(screen.doc.body.textContent.includes(STRINGS.en.trashActionFailed), 'error message displayed')
    // Backend was not purged
    assert.equal(trashBackend.items.length, 3)
    // Underlying items unaffected
    assert.deepEqual(screen.itemsRendered(), ['system-report.pdf', 'backup-image.iso', 'audit-log-2026.csv'])
  } finally {
    await screen.unmount()
  }
})

test('TRASH-STORAGE-REFRESH-1 permanent deletion calls onStorageMutationCommitted on success', async () => {
  let storageRefreshed = 0
  const screen = await mountTrash({
    onStorageMutationCommitted: () => { storageRefreshed++ },
  })
  try {
    await screen.clickDeletePermanently('audit-log-2026.csv')
    await screen.submitPurgePassword('secret')

    assert.equal(screen.dialog(), null, 'dialog closed')
    assert.equal(storageRefreshed, 1, 'onStorageMutationCommitted must be called exactly once')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-STORAGE-REFRESH-2 empty trash calls onStorageMutationCommitted on success', async () => {
  let storageRefreshed = 0
  const screen = await mountTrash({
    onStorageMutationCommitted: () => { storageRefreshed++ },
  })
  try {
    await screen.openEmptyTrash()
    await screen.submitEmptyTrash('DELETE', 'secret')

    assert.equal(screen.emptyPasswordInput(), null, 'empty trash password input must be unmounted')
    assert.equal(storageRefreshed, 1, 'onStorageMutationCommitted must be called exactly once')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-STORAGE-REFRESH-3 failed permanent deletion does NOT call onStorageMutationCommitted', async () => {
  let storageRefreshed = 0
  const screen = await mountTrash({
    onStorageMutationCommitted: () => { storageRefreshed++ },
  })
  try {
    await screen.clickDeletePermanently('audit-log-2026.csv')
    await screen.submitPurgePassword('wrong-password')

    assert.ok(screen.dialog(), 'dialog remains open')
    assert.equal(storageRefreshed, 0, 'onStorageMutationCommitted must not be called on failed auth')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-STORAGE-REFRESH-4 failed empty trash does NOT call onStorageMutationCommitted', async () => {
  let storageRefreshed = 0
  const screen = await mountTrash({
    onStorageMutationCommitted: () => { storageRefreshed++ },
  })
  try {
    await screen.openEmptyTrash()
    await screen.submitEmptyTrash('DELETE', 'wrong-password')

    assert.ok(screen.dialog(), 'dialog remains open')
    assert.equal(storageRefreshed, 0, 'onStorageMutationCommitted must not be called on failed empty trash')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-STORAGE-REFRESH-5 restore does NOT call onStorageMutationCommitted', async () => {
  let storageRefreshed = 0
  const screen = await mountTrash({
    onStorageMutationCommitted: () => { storageRefreshed++ },
  })
  try {
    await screen.clickRestore('audit-log-2026.csv')
    await screen.submitRestore()

    assert.equal(screen.dialog(), null, 'dialog closed')
    assert.deepEqual(screen.itemsRendered(), ['system-report.pdf', 'backup-image.iso'])
    assert.equal(storageRefreshed, 0, 'restore must not call onStorageMutationCommitted')
  } finally {
    await screen.unmount()
  }
})

test('TRASH-STORAGE-REFRESH-6 App.jsx passes dashApi.refresh as onStorageMutationCommitted to Trash', async () => {
  const fs = await import('node:fs/promises')
  const appSrc = await fs.readFile(path.join(rootDir, 'src/App.jsx'), 'utf8')
  assert.match(
    appSrc,
    /trash:\s*<Trash[^>]*onStorageMutationCommitted=\{dashApi\.refresh\}/,
    'App.jsx must bind onStorageMutationCommitted to dashApi.refresh'
  )
})
