import assert from 'node:assert/strict'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer, normalizePath } from 'vite'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROTECTED_PATHS = ['/api/dashboard', '/healthz', '/api/files', '/api/users']

let vite
let App
let apiFetchUnderTest

before(async () => {
  const stubPath = normalizePath(path.join(rootDir, 'tests/fixtures/appShellStubs.jsx'))
  const stubbedModules = new Set([
    './components/ui.jsx',
    './components/Sidebar.jsx',
    './components/TopBar.jsx',
    './components/GlobalSearch.jsx',
    './screens/Login.jsx',
    './screens/Dashboard.jsx',
    './screens/Files.jsx',
    './screens/Vault.jsx',
    './screens/Uploads.jsx',
    './screens/Shares.jsx',
    './screens/FileHistory.jsx',
    './screens/Storage.jsx',
    './screens/Audit.jsx',
    './screens/Access.jsx',
    './screens/Settings.jsx',
    '../components/ui.jsx',
    '../components/AegisMark.jsx',
  ])
  const appShellStubs = {
    name: 'app-shell-stubs',
    enforce: 'pre',
    resolveId(source) {
      if (stubbedModules.has(source)) return stubPath
      return null
    },
  }
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [appShellStubs],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    esbuild: { jsx: 'automatic' },
  })
  ;({ default: App } = await vite.ssrLoadModule('/src/App.jsx'))
  ;({ apiFetch: apiFetchUnderTest } = await vite.ssrLoadModule('/src/lib/api.js'))
})

after(async () => {
  await vite?.close()
})

const adminMenu = [
  { id: 'dashboard', icon: 'gauge', labelKey: 'navDashboard', group: 'navGroupWorkspace' },
  { id: 'files', icon: 'folder', labelKey: 'navFiles', group: 'navGroupWorkspace' },
  { id: 'storage', icon: 'harddrive', labelKey: 'navStorage', group: 'navGroupProtection' },
  { id: 'access', icon: 'usercog', labelKey: 'navAccess', group: 'navGroupAdmin' },
]

const sessionPayload = (mustResetPassword) => ({
  user: {
    id: '1',
    username: 'admin',
    displayName: 'Veerachat J.',
    accountName: 'Veerachat J.',
    role: 'Admin',
    mustResetPassword,
  },
  menu: adminMenu,
  csrfToken: 'csrf-password-reset-test',
})

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://localhost/drive/',
    pretendToBeVisual: true,
  })
  const { window } = dom
  window.matchMedia = () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  })
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0)
  window.cancelAnimationFrame = (id) => window.clearTimeout(id)
  window.HTMLElement.prototype.animate = () => ({ cancel() {}, finished: Promise.resolve() })

  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    requestAnimationFrame: window.requestAnimationFrame,
    cancelAnimationFrame: window.cancelAnimationFrame,
    MutationObserver: window.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = new Map()
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    })
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

async function waitFor(check, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)))
  }
  assert.fail(message)
}

function setInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function makeFetch(mustResetPassword, calls) {
  return async (input, init = {}) => {
    const url = new URL(String(input), 'http://localhost')
    const method = init.method ?? 'GET'
    calls.push({ path: url.pathname.replace(/^\/drive/, ''), method, body: init.body })

    if (url.pathname.endsWith('/api/me')) return jsonResponse(sessionPayload(mustResetPassword))
    if (url.pathname.endsWith('/api/password/reset')) return jsonResponse({ ok: true })
    if (url.pathname.endsWith('/healthz')) return jsonResponse({ ok: true, db: 'postgres' })
    if (url.pathname.endsWith('/api/dashboard')) return jsonResponse({ metrics: {}, activity7d: [], recentFiles: [], loginHistory: [], shares: [] })
    if (url.pathname.endsWith('/api/storage')) return jsonResponse({ usage: {}, capacityBytes: { totalBytes: 0, usedBytes: 0, freeBytes: 0 } })
    if (url.pathname.endsWith('/api/files')) return jsonResponse({ files: [] })
    if (url.pathname.endsWith('/api/users')) return jsonResponse({ users: [] })
    return jsonResponse({ error: 'Not found' }, 404)
  }
}

async function renderApp(mustResetPassword) {
  const env = installDom()
  const { createRoot } = await import('react-dom/client')
  const calls = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = makeFetch(mustResetPassword, calls)
  const root = createRoot(document.getElementById('root'))
  await act(async () => root.render(React.createElement(App)))
  return {
    calls,
    async cleanup() {
      await act(async () => root.unmount())
      globalThis.fetch = previousFetch
      env.restore()
    },
  }
}

test('apiFetch preserves PASSWORD_RESET_REQUIRED as a first-class error', async () => {
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({ error: 'PASSWORD_RESET_REQUIRED' }, 403)
  try {
    const result = await apiFetchUnderTest('/api/files')
    assert.equal(result.status, 403)
    assert.equal(result.errorKind, 'password-reset-required')
    assert.equal(result.errorCode, 'PASSWORD_RESET_REQUIRED')
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('reset-required session mounts only the gate, then unlocks protected reads after reset', async () => {
  const app = await renderApp(true)
  try {
    await waitFor(
      () => document.querySelector('form[aria-label="mandatory-password-reset"]'),
      `mandatory reset form did not render; body was ${document.body.textContent}`,
    )
    assert.equal(document.querySelector('aside'), null, 'Sidebar must not mount before password reset')
    assert.deepEqual(
      app.calls.filter((call) => PROTECTED_PATHS.includes(call.path)),
      [],
      'protected endpoints must stay paused while reset is required',
    )

    await act(async () => {
      setInput(document.getElementById('mandatory-current-password'), 'aegis-drive-admin')
      setInput(document.getElementById('mandatory-new-password'), 'aegis-drive-admin-new-2026')
      setInput(document.getElementById('mandatory-confirm-password'), 'aegis-drive-admin-new-2026')
    })
    await waitFor(
      () => !document.querySelector('form[aria-label="mandatory-password-reset"] button[type="submit"]')?.disabled,
      `password reset form did not accept input; form was ${document.querySelector('form[aria-label="mandatory-password-reset"]')?.outerHTML}`,
    )
    await act(async () => {
      document.querySelector('form[aria-label="mandatory-password-reset"]')
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    })

    await waitFor(
      () => app.calls.some((call) => call.path === '/api/password/reset' && call.method === 'POST'),
      'password reset endpoint was not called',
    )
    const resetCall = app.calls.find((call) => call.path === '/api/password/reset')
    assert.deepEqual(JSON.parse(resetCall.body), {
      currentPassword: 'aegis-drive-admin',
      newPassword: 'aegis-drive-admin-new-2026',
    })
    await waitFor(
      () => PROTECTED_PATHS.every((path) => app.calls.some((call) => call.path === path)),
      `normal protected reads did not start after reset; calls were ${JSON.stringify(app.calls)}`,
    )
    assert.equal(document.querySelector('form[aria-label="mandatory-password-reset"]'), null)
    assert.ok(document.querySelector('nav[aria-label="AEGIS Drive_LC"]'), 'normal app shell must render after reset')
  } finally {
    await app.cleanup()
  }
})

test('session without reset requirement enters the normal shell directly', async () => {
  const app = await renderApp(false)
  try {
    await waitFor(
      () => document.querySelector('nav[aria-label="AEGIS Drive_LC"]'),
      `normal shell did not render; body was ${document.body.textContent}`,
    )
    assert.equal(document.querySelector('form[aria-label="mandatory-password-reset"]'), null)
    await waitFor(
      () => PROTECTED_PATHS.every((path) => app.calls.some((call) => call.path === path)),
      `protected reads did not start for a normal session; calls were ${JSON.stringify(app.calls)}`,
    )
  } finally {
    await app.cleanup()
  }
})
