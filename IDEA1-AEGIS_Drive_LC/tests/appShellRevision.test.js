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
let DashboardQuickActions
let AegisMark
let themeAssetsFor

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })
  ;({ TopBar } = await vite.ssrLoadModule('/src/components/TopBar.jsx'))
  ;({ GlobalSearch } = await vite.ssrLoadModule('/src/components/GlobalSearch.jsx'))
  ;({ Dashboard } = await vite.ssrLoadModule('/src/screens/Dashboard.jsx'))
  ;({ DashboardQuickActions } = await vite.ssrLoadModule('/src/components/DashboardQuickActions.jsx'))
  ;({ AegisMark, themeAssetsFor } = await vite.ssrLoadModule('/src/components/AegisMark.jsx'))
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
  dom.window.Element.prototype.scrollIntoView = () => {}
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
    resolvedTheme: 'dark',
    onThemeChange: (value) => calls.push(`theme:${value}`),
    openMobileNav() {},
  }))
  try {
    assert.equal(view.document.querySelector('[aria-label="Notifications"]'), null)
    const themeButton = view.document.querySelector('button[aria-label="Switch to light mode"]')
    assert.ok(themeButton, 'authenticated header must expose the theme switch')
    await act(async () => themeButton.click())
    const avatarButton = view.document.querySelector('button[aria-label="Veerachat J."]')
    assert.ok(avatarButton)
    for (const label of ['Profile', 'Settings', 'Sign out']) {
      await act(async () => avatarButton.click())
      const button = [...view.document.querySelectorAll('button')].find((node) => node.textContent.trim() === label)
      assert.ok(button, `${label} must be available in the profile menu`)
      await act(async () => button.click())
    }
    assert.deepEqual(calls, ['theme:light', 'profile', 'settings', 'signout'])
  } finally {
    await view.cleanup()
  }
})

test('theme assets always use contrasting logo ink and the matching Welcome background', () => {
  assert.equal(typeof themeAssetsFor, 'function', 'theme asset mapping must be a shared runtime contract')
  if (typeof themeAssetsFor !== 'function') return
  assert.deepEqual(themeAssetsFor('light'), {
    logo: 'assets/logo/aegis-mark-dark-ink.png',
    welcome: 'assets/BG_AEGIS01.png',
  })
  assert.deepEqual(themeAssetsFor('dark'), {
    logo: 'assets/logo/aegis-mark-light-ink.png',
    welcome: 'assets/BG_AEGIS02.png',
  })
})

test('AEGIS mark renders the contrasting asset from the resolved App theme', async () => {
  const darkView = await render(React.createElement(AegisMark, { theme: 'dark' }))
  try {
    assert.match(darkView.document.querySelector('img')?.src ?? '', /aegis-mark-light-ink\.png$/)
  } finally {
    await darkView.cleanup()
  }

  const lightView = await render(React.createElement(AegisMark, { theme: 'light' }))
  try {
    assert.match(lightView.document.querySelector('img')?.src ?? '', /aegis-mark-dark-ink\.png$/)
  } finally {
    await lightView.cleanup()
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

test('File History search stays file-scoped instead of showing unrelated people or navigation', async () => {
  const view = await render(React.createElement(GlobalSearch, {
    t,
    screen: 'versions',
    go() {},
    nav: [{ id: 'vault', icon: 'vault', labelKey: 'vaultTitle' }],
    files: [{ id: 'f1', name: 'report.pdf', type: 'PDF', size: 42, modified: Date.now() }],
    people: [{ id: 'u1', name: 'Veerachat', username: 'admin', role: 'Admin' }],
  }))
  try {
    const input = view.document.querySelector('input')
    await act(async () => input.focus())
    assert.match(view.document.body.textContent, /report\.pdf/)
    assert.doesNotMatch(view.document.body.textContent, /Private Vault/)
    assert.doesNotMatch(view.document.body.textContent, /Veerachat/)
  } finally {
    await view.cleanup()
  }
})

test('Dashboard keeps Data Lake Health and Server Telemetry without a full-width quick-action rail', async () => {
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
  const view = await render(React.createElement(Dashboard, {
    t,
    lang: 'en',
    health: { loading: false, error: null, data: { ok: true, db: 'postgres', layers: {} }, retry() {} },
  }))
  try {
    assert.match(view.document.body.textContent, /Data Lake Health/)
    assert.match(view.document.body.textContent, /Server Telemetry/)
    assert.equal(view.document.querySelector('.quick-action-rail'), null)
  } finally {
    delete globalThis.__AEGIS_API_FIXTURES__
    await view.cleanup()
  }
})

test('compact Dashboard header actions preserve Upload, Share, and Vault navigation', async () => {
  const destinations = []
  const view = await render(React.createElement(DashboardQuickActions, {
    t,
    go: (destination, params) => destinations.push({ destination, params }),
  }))
  try {
    for (const label of ['Upload file', 'Create share link', 'Open Private Vault']) {
      const button = view.document.querySelector(`button[aria-label="${label}"]`)
      assert.ok(button, `${label} compact action must be visible`)
      await act(async () => button.click())
    }
    assert.deepEqual(destinations, [
      { destination: 'files', params: { uploadOpen: true } },
      { destination: 'shares', params: undefined },
      { destination: 'vault', params: undefined },
    ])
  } finally {
    await view.cleanup()
  }
})
