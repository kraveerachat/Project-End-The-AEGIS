import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { backend, resetBackend } from './fixtures/themeTransitionBackend.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => normalizePath(path.join(rootDir, 'tests/fixtures', name))

let vite
let App

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: {
      alias: [
        { find: './lib/hooks.js', replacement: fixture('mockHooks.js') },
        { find: '../lib/hooks.js', replacement: fixture('mockHooks.js') },
        { find: './lib/auth.js', replacement: fixture('stubAuth.js') },
        { find: '../lib/auth.js', replacement: fixture('stubAuth.js') },
        { find: './lib/api.js', replacement: fixture('stubApi.js') },
        { find: '../lib/api.js', replacement: fixture('stubApi.js') },
        ...['Dashboard', 'Files', 'Vault', 'Shares', 'FileHistory', 'Storage', 'Audit', 'Access']
          .map((screen) => ({ find: `./screens/${screen}.jsx`, replacement: fixture('appShellStubs.jsx') })),
      ],
    },
  })
  App = (await vite.ssrLoadModule('/src/App.jsx')).default
})

after(async () => vite?.close())
beforeEach(() => resetBackend({ account: { language: 'en' } }))

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/settings',
    pretendToBeVisual: true,
  })
  const previous = new Map()
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    MutationObserver: dom.window.MutationObserver,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.Element.prototype.scrollIntoView = () => {}
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  return {
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
      dom.window.close()
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const buttonByText = (text) => [...document.querySelectorAll('button')]
  .find((button) => button.textContent.trim() === text)
const radioByLabel = (text) => [...document.querySelectorAll('button[role="radio"]')]
  .find((button) => button.querySelector('.text-ink')?.textContent.trim() === text)

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await act(async () => { await settle() })
  }
  assert.ok(predicate(), 'authenticated Settings did not become ready before timeout')
}

async function loadAuthenticatedSettings() {
  const env = installDom()
  backend().restoreSession = true
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  await act(async () => { root.render(React.createElement(App)); await settle() })
  await waitFor(() => radioByLabel('Neo'))
  return {
    click: async (element) => {
      assert.ok(element, 'element to click must exist')
      await act(async () => { element.click(); await settle() })
    },
    key: async (key) => {
      await act(async () => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
        await settle()
      })
    },
    async cleanup() {
      await act(async () => root.unmount())
      env.restore()
    },
  }
}

test('style selection confirms accessibly and cancel or Escape never mutates the live shell', async () => {
  const app = await loadAuthenticatedSettings()
  try {
    assert.equal(document.documentElement.dataset.uiStyle, 'classic')
    await app.click(radioByLabel('Neo'))

    const dialog = document.querySelector('[role="dialog"]')
    assert.ok(dialog)
    assert.ok(dialog.matches('.ui-modal[data-material="shell-glass"]'))
    assert.equal(dialog.getAttribute('aria-labelledby'), 'interface-style-confirm-title')
    assert.equal(document.documentElement.dataset.uiStyle, 'classic')
    assert.deepEqual(backend().events, [])

    await app.key('Escape')
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.equal(document.documentElement.dataset.uiStyle, 'classic')

    await app.click(radioByLabel('Neo'))
    await app.click(buttonByText('Cancel'))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.deepEqual(backend().events, [])
  } finally {
    await app.cleanup()
  }
})

test('successful style save happens before logout and returns to the unchanged Login screen', async () => {
  const app = await loadAuthenticatedSettings()
  try {
    await app.click(radioByLabel('Neo'))
    await app.click(buttonByText('Save style and sign out'))

    assert.deepEqual(backend().events, ['preferences:neo', 'logout'])
    assert.deepEqual(backend().patches, [{
      theme: 'light',
      language: 'en',
      density: 'comfortable',
      interfaceStyle: 'neo',
    }])
    assert.ok(document.getElementById('login-username'), 'successful save returns to the existing Login screen')
    assert.equal(document.documentElement.dataset.uiStyle, undefined)
    assert.equal(backend().account.interfaceStyle, 'neo')
  } finally {
    await app.cleanup()
  }
})

test('failed style save keeps the session and Classic shell and never calls logout', async () => {
  resetBackend({ account: { language: 'en' }, preferenceSaveOk: false })
  const app = await loadAuthenticatedSettings()
  try {
    await app.click(radioByLabel('Neo'))
    await app.click(buttonByText('Save style and sign out'))

    assert.deepEqual(backend().events, ['preferences:neo'])
    assert.equal(backend().account.interfaceStyle, 'classic')
    assert.equal(document.documentElement.dataset.uiStyle, 'classic')
    assert.equal(document.getElementById('login-username'), null)
    assert.ok(document.querySelector('[role="alert"]'))
    assert.ok(document.querySelector('[role="dialog"]'), 'failure stays in context so the user can cancel or retry')
  } finally {
    await app.cleanup()
  }
})
