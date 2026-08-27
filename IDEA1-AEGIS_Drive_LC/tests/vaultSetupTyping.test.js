// The production report, reproduced against the real Vault screen:
//   login as DataLake-User -> Private Vault -> Set up vault -> click the vault
//   key input -> type. The first character landed, then focus jumped to the
//   ModalClose X and the rest of the passphrase was lost.
//
// This drives the real screen (real Modal, real controlled state) and asserts
// that a whole passphrase reaches the field with focus never leaving it.
import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer, normalizePath } from 'vite'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const t = makeT('en')

let dom
let createRoot
let vite
let Vault

before(async () => {
  // react-dom captures `canUseDOM` at import time; loading it before the jsdom
  // globals exist disables the change-event path and silently drops typing.
  dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/vault': { loading: false, data: { configured: false, blobs: [] }, error: null },
  }
  ;({ createRoot } = await import('react-dom/client'))

  const hooksStub = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))
  const stubHooks = {
    name: 'vault-hooks-stub',
    enforce: 'pre',
    resolveId(source) {
      return source === '../lib/hooks.js' ? hooksStub : null
    },
  }
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [stubHooks],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    esbuild: { jsx: 'automatic' },
  })
  ;({ Vault } = await vite.ssrLoadModule('/src/screens/Vault.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
  delete globalThis.__AEGIS_API_FIXTURES__
  dom?.window.close()
})

function mount() {
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  return {
    async render(element) {
      await act(async () => root.render(element))
    },
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

function focusedDescription() {
  const el = dom.window.document.activeElement
  if (!el || el === dom.window.document.body) return 'body'
  return `${el.tagName.toLowerCase()}#${el.id || '-'}@${el.getAttribute('aria-label') ?? '-'}`
}

async function click(el) {
  await act(async () => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })))
}

async function typeInto(input, text) {
  const nativeSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  const focusTrail = []
  for (const char of text) {
    await act(async () => {
      nativeSetter.call(input, input.value + char)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
    focusTrail.push(focusedDescription())
  }
  return focusTrail
}

function byText(selector, text) {
  return [...dom.window.document.querySelectorAll(selector)].find((el) => el.textContent.includes(text))
}

test('the vault setup passphrase accepts a full passphrase without losing focus', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(Vault, { t }))

    const setupCta = byText('button', t('vaultSetupCta'))
    assert.ok(setupCta, 'the unconfigured vault offers a setup call to action')
    await click(setupCta)

    const doc = dom.window.document
    assert.ok(doc.querySelector('[role="dialog"]'), 'the setup modal opened')

    const key = doc.getElementById('vault-new-key')
    assert.ok(key, 'the vault key field is present')
    assert.equal(
      focusedDescription(),
      'input#vault-new-key@-',
      'opening the setup modal focuses the vault key field, not the close X',
    )

    const passphrase = 'aegis-datalake-vault-2026'
    const trail = await typeInto(key, passphrase)

    assert.equal(key.value, passphrase, 'every typed character reached the controlled field')
    assert.deepEqual(
      [...new Set(trail)],
      ['input#vault-new-key@-'],
      'focus stayed on the vault key field for the whole passphrase',
    )
    assert.ok(
      trail.every((f) => !f.includes('@Close')),
      'the close button never took focus while typing',
    )

    // The confirmation field is an independent controlled input on the same
    // screen; typing there must not bounce focus either.
    const confirm = doc.getElementById('vault-new-key2')
    confirm.focus()
    const confirmTrail = await typeInto(confirm, passphrase)
    assert.equal(confirm.value, passphrase)
    assert.deepEqual([...new Set(confirmTrail)], ['input#vault-new-key2@-'])

    // The acknowledgement checkbox re-renders the screen too.
    const ack = doc.querySelector('input[type="checkbox"]')
    await click(ack)
    assert.equal(focusedDescription(), 'input#vault-new-key2@-', 'a checkbox re-render does not move focus')

    const create = byText('button', t('vaultSetupCreate'))
    assert.ok(create, 'the create action is present')
    assert.equal(create.disabled, false, 'a complete, acknowledged form can be submitted')
  } finally {
    await h.unmount()
  }
})

test('the vault unlock passphrase field takes focus and keeps it while typing', async () => {
  globalThis.__AEGIS_API_FIXTURES__['/api/vault'] = {
    loading: false,
    data: { configured: true, blobs: [], saltB64: 'c2FsdA==', params: {}, verifier: {} },
    error: null,
  }
  const h = mount()
  try {
    await h.render(React.createElement(Vault, { t }))

    const unlockCta = byText('button', t('unlockVault'))
    assert.ok(unlockCta, 'a configured vault offers an unlock call to action')
    await click(unlockCta)

    const key = dom.window.document.getElementById('vault-key')
    assert.ok(key, 'the unlock key field is present')
    assert.equal(focusedDescription(), 'input#vault-key@-', 'unlock focuses the key field, not the close X')

    const trail = await typeInto(key, 'open-sesame-please')
    assert.equal(key.value, 'open-sesame-please')
    assert.deepEqual([...new Set(trail)], ['input#vault-key@-'])
  } finally {
    await h.unmount()
    globalThis.__AEGIS_API_FIXTURES__['/api/vault'] = { loading: false, data: { configured: false, blobs: [] }, error: null }
  }
})

test('closing the setup modal from the close button still works', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await click(byText('button', t('vaultSetupCta')))
    const doc = dom.window.document
    assert.ok(doc.querySelector('[role="dialog"]'))

    await click(doc.querySelector(`[aria-label="${t('close')}"]`))
    assert.equal(doc.querySelector('[role="dialog"]'), null, 'the close button dismissed the modal')
  } finally {
    await h.unmount()
  }
})

test('Escape closes the setup modal after the passphrase has been typed', async () => {
  const h = mount()
  try {
    await h.render(React.createElement(Vault, { t }))
    await click(byText('button', t('vaultSetupCta')))
    const doc = dom.window.document

    // Typing gives the screen a fresh inline onClose identity on every render;
    // Escape must still reach the current one.
    await typeInto(doc.getElementById('vault-new-key'), 'aegis-datalake-vault-2026')

    await act(async () => {
      dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(doc.querySelector('[role="dialog"]'), null, 'Escape dismissed the modal')
  } finally {
    await h.unmount()
  }
})
