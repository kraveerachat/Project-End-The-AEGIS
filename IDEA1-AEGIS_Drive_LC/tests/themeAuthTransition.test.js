// ── The six theme transitions, driven through the real App ──────────────────────
//
// These are the manual acceptance cases, automated. They mount the actual App with
// the actual Login screen and read the theme back off <html> exactly where the
// browser reads it, because every earlier version of this bug lived in the gap
// between "React state says dark" and "the document is dark".
//
// The regression this file exists for: an explicit theme choice on the Login screen
// was thrown away the moment authentication succeeded, because onAuthed overwrote it
// with the account's stored (stale) users.ui_theme.
//
//   Login DARK → sign in → LIGHT dashboard   ← the defect
//   Login DARK → sign in → DARK  dashboard   ← required, and users.ui_theme = dark
//
// Precedence under test (the single model — see resolveAuthenticatedTheme):
//   1. a theme the user explicitly picked on the Login screen this session
//   2. same-account one-shot logout continuity
//   3. the authenticated account preference
//   4. the persisted shell hint
//   5. light
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'
import { backend, resetBackend } from './fixtures/themeTransitionBackend.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => normalizePath(path.join(rootDir, 'tests/fixtures', name))
const SHELL_KEY = 'aegis_shell_theme'
const t = makeT('th') // Thai-first, like the app's default — labels come from strings.js

let vite
let App
let themeLib

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
        // Network and polling are not what these tests are about; the shell, the
        // Login screen and the theme pipeline are all real.
        { find: './lib/hooks.js', replacement: fixture('mockHooks.js') },
        { find: '../lib/hooks.js', replacement: fixture('mockHooks.js') },
        { find: './lib/auth.js', replacement: fixture('stubAuth.js') },
        { find: '../lib/auth.js', replacement: fixture('stubAuth.js') },
        { find: './lib/api.js', replacement: fixture('stubApi.js') },
        { find: '../lib/api.js', replacement: fixture('stubApi.js') },
        // Lazy destination screens are stubs — theme lives on <html>, not in them.
        ...['Dashboard', 'Files', 'Vault', 'Shares', 'FileHistory', 'Storage', 'Audit', 'Access', 'Settings']
          .map((screen) => ({
            find: `./screens/${screen}.jsx`,
            replacement: fixture('appShellStubs.jsx'),
          })),
      ],
    },
  })
  App = (await vite.ssrLoadModule('/src/App.jsx')).default
  themeLib = await vite.ssrLoadModule('/src/lib/theme.js')
})

after(async () => {
  await vite?.close()
})

beforeEach(() => {
  resetBackend()
})

function installDom({ prefersDark = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const previous = new Map()
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage, // theme.js reads globalThis.localStorage
    MutationObserver: dom.window.MutationObserver,
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback }
      observe(target) { this.callback?.([{ isIntersecting: true, target }]) }
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  }
  dom.window.matchMedia = (query) => ({
    matches: prefersDark && query.includes('dark'),
    addEventListener() {},
    removeEventListener() {},
  })
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

/**
 * Load the app the way a browser does: shell hint first (theme-bootstrap.js paints
 * <html> before React exists), then React mounts on top of an already-themed page.
 */
async function loadApp({ shell = null, prefersDark = false } = {}) {
  const env = installDom({ prefersDark })
  if (shell) globalThis.localStorage.setItem(SHELL_KEY, shell)

  // src/theme-bootstrap.js, inlined — it runs once per page load, which is exactly
  // what a remount in this file represents.
  const booted = themeLib.readShellTheme()
  themeLib.applyThemeToDocument(booted, { prefersDark: booted === 'system' && prefersDark })

  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))
  await act(async () => root.render(React.createElement(App)))
  await act(async () => { await settle() })

  return {
    get theme() { return document.documentElement.dataset.theme },
    get interfaceStyle() { return document.documentElement.dataset.uiStyle },
    get authenticatedShell() { return document.querySelector('.authenticated-shell') },
    get shellHint() { return globalThis.localStorage.getItem(SHELL_KEY) },
    get onLoginScreen() { return Boolean(document.getElementById('login-username')) },
    click: async (element) => {
      assert.ok(element, 'element to click must exist')
      await act(async () => { element.click(); await settle() })
    },
    button: (label) => document.querySelector(`button[aria-label="${label}"]`),
    byText: (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text),
    async signIn() {
      // The stub backend accepts anything — these only have to be non-empty so the
      // real Login screen enables its submit button.
      typeInto(document.getElementById('login-username'), 'admin')
      typeInto(document.getElementById('login-password'), 'not-a-real-password')
      await this.click(this.byText(t('signIn')));
      // Login runs a short staged animation before onAuthed; reduced motion is on,
      // so this only has to outlast a handful of zero-length timers.
      await act(async () => { await settle() })
    },
    async signOut() {
      await this.click(this.button('Veerachat J.'))
      await this.click(this.byText(t('signOut')))
    },
    async cleanup() {
      await act(async () => root.unmount())
      env.restore()
    },
  }
}

function typeInto(input, value) {
  assert.ok(input, 'input must exist')
  const setter = Object.getOwnPropertyDescriptor(globalThis.window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }))
}

// ── TEST 1 · Light Login → Light Dashboard (already passing — must stay passing) ──
test('light login carries into a light dashboard', async () => {
  const app = await loadApp()
  try {
    assert.equal(app.onLoginScreen, true)
    assert.equal(app.theme, 'light')
    assert.equal(app.interfaceStyle, undefined, 'Login must not receive an authenticated style marker')

    await app.signIn()

    assert.equal(app.onLoginScreen, false)
    assert.equal(app.theme, 'light')
    assert.equal(app.interfaceStyle, 'classic')
    assert.ok(app.authenticatedShell)
    assert.equal(backend().account.theme, 'light')
    assert.deepEqual(backend().patches, [], 'an unchanged theme must not write to the account')
  } finally {
    await app.cleanup()
  }
})

test('a Neo account mounts the authenticated shell directly without a Classic frame', async () => {
  resetBackend({ account: { interfaceStyle: 'neo', theme: 'dark', density: 'compact' } })
  const app = await loadApp()
  try {
    assert.equal(app.onLoginScreen, true)
    assert.equal(app.interfaceStyle, undefined)

    const seen = []
    const observer = new globalThis.window.MutationObserver(() => {
      seen.push(document.documentElement.dataset.uiStyle)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui-style'] })

    await app.signIn()
    observer.disconnect()

    assert.equal(app.onLoginScreen, false)
    assert.equal(app.interfaceStyle, 'neo')
    assert.ok(app.authenticatedShell)
    assert.deepEqual(seen.filter(Boolean), ['neo'])
    assert.equal(globalThis.localStorage.getItem('aegis_interface_style'), null)

    await app.signOut()
    assert.equal(app.onLoginScreen, true)
    assert.equal(app.interfaceStyle, undefined)
    assert.equal(app.authenticatedShell, null)
  } finally {
    await app.cleanup()
  }
})

// ── TEST 2 · Light App → Logout → Light Login ────────────────────────────────────
test('signing out of a light app leaves a light login screen', async () => {
  const app = await loadApp()
  try {
    await app.signIn()
    await app.signOut()

    assert.equal(app.onLoginScreen, true)
    assert.equal(app.theme, 'light')
  } finally {
    await app.cleanup()
  }
})

// ── TEST 3 · Authenticated app switched to DARK ──────────────────────────────────
test('switching the authenticated app to dark themes the app and the account', async () => {
  const app = await loadApp()
  try {
    await app.signIn()
    await app.click(app.button('Switch to dark mode'))

    assert.equal(app.theme, 'dark')
    assert.equal(app.shellHint, 'dark')
    assert.equal(backend().account.theme, 'dark', 'Settings/TopBar changes persist to users.ui_theme')
  } finally {
    await app.cleanup()
  }
})

// ── TEST 4 · Dark App → Logout → Dark Login (already passing — must stay passing) ─
test('signing out of a dark app leaves a dark login screen', async () => {
  const app = await loadApp()
  try {
    await app.signIn()
    await app.click(app.button('Switch to dark mode'))
    await app.signOut()

    assert.equal(app.onLoginScreen, true)
    assert.equal(app.theme, 'dark', 'the gate must inherit the theme the app was left in')
    assert.equal(app.shellHint, 'dark')
  } finally {
    await app.cleanup()
  }
})

test('dark app logout continuity returns the same account to a dark app', async () => {
  resetBackend({ account: { theme: 'light' }, persistPreferences: false })
  const app = await loadApp()
  try {
    await app.signIn()
    await app.click(app.button('Switch to dark mode'))
    assert.equal(app.theme, 'dark')
    assert.equal(backend().account.theme, 'light', 'model a stale authoritative account preference')

    await app.signOut()
    assert.equal(app.theme, 'dark')
    await app.signIn()

    assert.equal(app.onLoginScreen, false)
    assert.equal(app.theme, 'dark', 'same-account one-shot continuity must beat stale ui_theme')
  } finally {
    await app.cleanup()
  }
})

test('light app logout continuity returns the same account to a light app', async () => {
  resetBackend({ account: { theme: 'dark' }, persistPreferences: false })
  const app = await loadApp({ shell: 'dark' })
  try {
    await app.signIn()
    await app.click(app.button('Switch to light mode'))
    assert.equal(app.theme, 'light')
    assert.equal(backend().account.theme, 'dark', 'model a stale authoritative account preference')

    await app.signOut()
    assert.equal(app.theme, 'light')
    await app.signIn()

    assert.equal(app.onLoginScreen, false)
    assert.equal(app.theme, 'light', 'same-account one-shot continuity must beat stale ui_theme')
  } finally {
    await app.cleanup()
  }
})

test('a different account does not inherit another user logout continuity', async () => {
  resetBackend({ account: { theme: 'light' }, persistPreferences: false })
  const app = await loadApp()
  try {
    await app.signIn()
    await app.click(app.button('Switch to dark mode'))
    await app.signOut()

    backend().user = {
      id: '2',
      username: 'second-user',
      displayName: 'Second User',
      accountName: 'Second User',
      role: 'DataLake-User',
    }
    backend().account = { theme: 'light', language: 'th', density: 'comfortable' }
    await app.signIn()

    assert.equal(app.theme, 'light', 'the second account must receive its own preference')
    assert.equal(app.shellHint, 'light')
  } finally {
    await app.cleanup()
  }
})

test('an explicit login choice wins over same-account logout continuity', async () => {
  resetBackend({ account: { theme: 'light' }, persistPreferences: false })
  const app = await loadApp()
  try {
    await app.signIn()
    await app.click(app.button('Switch to dark mode'))
    await app.signOut()
    await app.click(app.button('Switch to light mode'))
    await app.signIn()

    assert.equal(app.theme, 'light')
  } finally {
    await app.cleanup()
  }
})

// ── TEST 5 · THE REPORTED FAILURE · Dark Login → Dark Dashboard ──────────────────
test('a dark theme chosen on the login screen survives authentication', async () => {
  // The account still remembers light: this is the stale value that used to win.
  const app = await loadApp({ shell: null })
  try {
    assert.equal(app.theme, 'light')
    await app.click(app.button('Switch to dark mode'))
    assert.equal(app.theme, 'dark', 'the login screen itself must go dark immediately')

    await app.signIn()

    assert.equal(app.onLoginScreen, false)
    assert.equal(app.theme, 'dark', 'the dashboard must not fall back to the stale account theme')
    assert.equal(app.shellHint, 'dark')
    assert.equal(backend().account.theme, 'dark', 'users.ui_theme must converge with the choice')
    assert.deepEqual(
      backend().patches.map((p) => p.theme),
      ['dark'],
      'exactly one preference write — no duplicate or looping updates',
    )
  } finally {
    await app.cleanup()
  }
})

// ── TEST 6 · Reload after the dark transition — proves it was persisted ──────────
test('reloading after a dark login transition stays dark', async () => {
  const first = await loadApp()
  let shellAfterLogin
  try {
    await first.click(first.button('Switch to dark mode'))
    await first.signIn()
    shellAfterLogin = first.shellHint
    assert.equal(first.theme, 'dark')
  } finally {
    await first.cleanup()
  }

  // Same browser, fresh page load, session cookie still valid (restoreSession was
  // set by the login above). Nothing survives here except localStorage and the
  // server's stored preference — React state is gone.
  const reloaded = await loadApp({ shell: shellAfterLogin })
  try {
    assert.equal(reloaded.onLoginScreen, false, 'the existing session must be restored')
    assert.equal(reloaded.theme, 'dark', 'dark was persisted, not merely held in React state')
    assert.equal(backend().account.theme, 'dark')
  } finally {
    await reloaded.cleanup()
  }
})

// ── Additional matrix (§16) ──────────────────────────────────────────────────────

test('a system preference on the account resolves against the OS on both sides of login', async () => {
  resetBackend({ account: { theme: 'system' } })
  const app = await loadApp({ shell: 'system', prefersDark: true })
  try {
    assert.equal(app.theme, 'dark', 'system + OS dark = dark on the login screen')

    await app.signIn()

    assert.equal(app.theme, 'dark')
    assert.equal(app.shellHint, 'system', 'the hint stores the choice, not the resolved value')
    assert.equal(backend().account.theme, 'system')
    assert.deepEqual(backend().patches, [])

    await app.signOut()
    assert.equal(app.onLoginScreen, true)
    assert.equal(app.theme, 'dark')
  } finally {
    await app.cleanup()
  }
})

test('a completely fresh client defaults to light even when the OS prefers dark', async () => {
  const app = await loadApp({ shell: null, prefersDark: true })
  try {
    assert.equal(app.theme, 'light')
    await app.signIn()
    assert.equal(app.theme, 'light')
  } finally {
    await app.cleanup()
  }
})

test('an account preference still wins when the login screen was left untouched', async () => {
  // Account switching: the shell is dark from a previous session, but this user
  // made no choice on this login screen, so their own stored preference decides
  // and is not silently overwritten by the leftover hint.
  resetBackend({ account: { theme: 'light' } })
  const app = await loadApp({ shell: 'dark' })
  try {
    assert.equal(app.theme, 'dark', 'the gate keeps the persisted hint')

    await app.signIn()

    assert.equal(app.theme, 'light', 'the account preference decides when nothing was picked')
    assert.equal(app.shellHint, 'light', 'the hint follows the account so all three agree')
    assert.equal(backend().account.theme, 'light')
    assert.deepEqual(backend().patches, [], 'no write: the account already held this value')
  } finally {
    await app.cleanup()
  }
})

// ── No flash / no race (§12) ─────────────────────────────────────────────────────
test('the dark login transition never paints a light frame', async () => {
  // Not "does it end up dark" — "was it ever light on the way". Every value
  // <html> held between clicking Sign in and the dashboard appearing is recorded,
  // so a transient light frame fails here even though the end state is correct.
  resetBackend({ account: { theme: 'light' } })
  const app = await loadApp()
  try {
    await app.click(app.button('Switch to dark mode'))

    const seen = []
    const observer = new globalThis.window.MutationObserver(() => {
      seen.push(document.documentElement.dataset.theme)
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })

    await app.signIn()
    observer.disconnect()

    assert.equal(app.theme, 'dark')
    assert.deepEqual(
      [...new Set(seen)].filter((value) => value !== 'dark'),
      [],
      `theme flashed through ${seen.join(' → ')} during authentication`,
    )
  } finally {
    await app.cleanup()
  }
})

test('a login-screen choice beats the account preference when accounts are switched', async () => {
  resetBackend({ account: { theme: 'light' } })
  const app = await loadApp({ shell: 'dark' })
  try {
    // Explicitly re-picking dark on this login screen makes it a fresh user choice,
    // not leftover state — so it wins and becomes the account's preference.
    await app.click(app.button('Switch to light mode'))
    await app.click(app.button('Switch to dark mode'))

    await app.signIn()

    assert.equal(app.theme, 'dark')
    assert.equal(backend().account.theme, 'dark')
  } finally {
    await app.cleanup()
  }
})
