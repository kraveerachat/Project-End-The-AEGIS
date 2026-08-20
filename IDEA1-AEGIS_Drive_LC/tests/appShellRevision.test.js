import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockHooksPath = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))
const t = makeT('en')

let vite
let TopBar
let GlobalSearch
let Dashboard

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })
  ;({ TopBar } = await vite.ssrLoadModule('/src/components/TopBar.jsx'))
  ;({ GlobalSearch } = await vite.ssrLoadModule('/src/components/GlobalSearch.jsx'))
  ;({ Dashboard } = await vite.ssrLoadModule('/src/screens/Dashboard.jsx'))
})

after(async () => {
  await vite?.close()
})

function installDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/drive/',
    pretendToBeVisual: true,
  })
  const previous = new Map()
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    MutationObserver: dom.window.MutationObserver,
    IntersectionObserver: class {
      observe(target) { this.callback?.([{ isIntersecting: true, target }]) }
      unobserve() {}
      disconnect() {}
      constructor(callback) { this.callback = callback }
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  return {
    dom,
    restore() {
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
      dom.window.close()
    },
  }
}

async function render(element) {
  const env = installDom()
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  await act(async () => root.render(element))
  return {
    document,
    async cleanup() {
      await act(async () => root.unmount())
      env.restore()
    },
  }
}

test('profile menu exposes Profile, Settings, and Sign out while unwired notifications stay absent', async () => {
  const calls = []
  const view = await render(React.createElement(TopBar, {
    t,
    scrolled: false,
    user: { id: '1', username: 'admin', displayName: 'Veerachat J.', role: 'Admin' },
    health: { data: { db: 'postgres', layers: { application: { ok: true, checked: true }, metadata: { ok: true, checked: true } } } },
    onSignOut: () => calls.push('signout'),
    onProfile: () => calls.push('profile'),
    onSettings: () => calls.push('settings'),
    openMobileNav() {},
  }))
  try {
    assert.equal(view.document.querySelector('[aria-label="Notifications"]'), null)
    const avatarButton = view.document.querySelector('button[aria-label="Veerachat J."]')
    assert.ok(avatarButton)
    for (const label of ['Profile', 'Settings', 'Sign out']) {
      await act(async () => avatarButton.click())
      const button = [...view.document.querySelectorAll('button')].find((node) => node.textContent.trim() === label)
      assert.ok(button, `${label} must be available in the profile menu`)
      await act(async () => button.click())
    }
    assert.deepEqual(calls, ['profile', 'settings', 'signout'])
  } finally {
    await view.cleanup()
  }
})

test('global search placeholder explains the active page scope', async () => {
  const view = await render(React.createElement(GlobalSearch, {
    t,
    screen: 'files',
    go() {},
    nav: [],
    files: [],
    people: [],
  }))
  try {
    assert.equal(view.document.querySelector('input')?.placeholder, 'Search files and folders…')
  } finally {
    await view.cleanup()
  }
})

test('Dashboard quick actions route to Uploads, Secure Shares, and Private Vault', async () => {
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/dashboard': {
      loading: false,
      error: null,
      data: { metrics: {}, activity7d: [], recentFiles: [], loginHistory: [], shares: [], securityAlerts: 0 },
    },
    '/api/storage': {
      loading: false,
      error: null,
      data: { usage: {}, capacityBytes: { totalBytes: 0, usedBytes: 0, freeBytes: 0 } },
    },
  }
  const destinations = []
  const view = await render(React.createElement(Dashboard, {
    t,
    lang: 'en',
    go: (destination) => destinations.push(destination),
    health: { loading: false, error: null, data: { ok: true, db: 'postgres', layers: {} }, retry() {} },
  }))
  try {
    for (const label of ['Upload file', 'Create share link', 'Open Private Vault']) {
      const button = [...view.document.querySelectorAll('button')].find((node) => node.textContent.trim() === label)
      assert.ok(button, `${label} quick action must be visible`)
      await act(async () => button.click())
    }
    assert.deepEqual(destinations, ['uploads', 'shares', 'vault'])
  } finally {
    delete globalThis.__AEGIS_API_FIXTURES__
    await view.cleanup()
  }
})
