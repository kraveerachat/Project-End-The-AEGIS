import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import {
  SHELL_THEME_KEY,
  applyThemeToDocument,
  readShellTheme,
  readStoredShellTheme,
  resolveAuthenticatedTheme,
  resolveTheme,
  writeShellTheme,
} from '../src/lib/theme.js'

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    snapshot: () => Object.fromEntries(values),
  }
}

test('fresh browser defaults to light even when the OS prefers dark', () => {
  assert.equal(readShellTheme(memoryStorage()), 'light')
  assert.equal(resolveTheme(readShellTheme(memoryStorage()), true), 'light')
})

test('logout continuity can restore an anonymous dark shell from the theme-only hint', () => {
  const storage = memoryStorage()
  writeShellTheme('dark', storage)
  assert.equal(readShellTheme(storage), 'dark')
  assert.deepEqual(storage.snapshot(), { [SHELL_THEME_KEY]: 'dark' })
})

test('an authenticated account preference overrides and replaces an older shell hint', () => {
  const storage = memoryStorage({ [SHELL_THEME_KEY]: 'dark' })
  writeShellTheme('light', storage)
  assert.equal(readShellTheme(storage), 'light')
})

test('"never chosen" is a distinct state from "chose light"', () => {
  // readShellTheme() collapses both to light because something must be rendered.
  // The precedence model cannot: a stored light is a decision the user made and
  // may need to survive login, while an absent hint must defer to the account.
  assert.equal(readStoredShellTheme(memoryStorage()), null)
  assert.equal(readStoredShellTheme(memoryStorage({ [SHELL_THEME_KEY]: 'light' })), 'light')
  assert.equal(readStoredShellTheme(memoryStorage({ [SHELL_THEME_KEY]: 'purple' })), null)
  assert.equal(readStoredShellTheme({ getItem() { throw new Error('denied') } }), null)
})

// ── The authentication transition contract ───────────────────────────────────────
// One precedence model, stated once, so Login.jsx / App.jsx / Settings.jsx cannot
// each invent their own:
//   explicit login-screen choice > same-account logout continuity
//   > account preference > persisted shell hint > light

test('same-account logout continuity beats a stale account preference once', () => {
  assert.deepEqual(
    resolveAuthenticatedTheme({
      selection: null,
      logoutTheme: 'dark',
      accountTheme: 'light',
      shellTheme: 'dark',
    }),
    { theme: 'dark', source: 'logout-continuity', persistToAccount: true },
  )
})

test('an explicit Login selection beats logout continuity', () => {
  assert.deepEqual(
    resolveAuthenticatedTheme({
      selection: 'light',
      logoutTheme: 'dark',
      accountTheme: 'dark',
      shellTheme: 'dark',
    }),
    { theme: 'light', source: 'login-selection', persistToAccount: true },
  )
})

test('a theme picked on the login screen wins and is pushed to the account', () => {
  // The regression case: users.ui_theme still says light, the user just clicked dark.
  assert.deepEqual(
    resolveAuthenticatedTheme({ selection: 'dark', accountTheme: 'light', shellTheme: 'dark' }),
    { theme: 'dark', source: 'login-selection', persistToAccount: true },
  )
})

test('re-picking the theme the account already stores does not write to the account', () => {
  assert.deepEqual(
    resolveAuthenticatedTheme({ selection: 'dark', accountTheme: 'dark', shellTheme: 'dark' }),
    { theme: 'dark', source: 'login-selection', persistToAccount: false },
  )
})

test('with no explicit choice the account preference decides and nothing is overwritten', () => {
  // Account switching: a dark hint left behind by the previous session must not
  // rewrite this account's stored light preference when the user touched nothing.
  assert.deepEqual(
    resolveAuthenticatedTheme({ selection: null, accountTheme: 'light', shellTheme: 'dark' }),
    { theme: 'light', source: 'account', persistToAccount: false },
  )
  assert.deepEqual(
    resolveAuthenticatedTheme({ selection: null, accountTheme: 'system', shellTheme: null }),
    { theme: 'system', source: 'account', persistToAccount: false },
  )
})

test('an account with no usable preference keeps the visible theme and converges to it', () => {
  assert.deepEqual(
    resolveAuthenticatedTheme({ selection: null, accountTheme: undefined, shellTheme: 'dark' }),
    { theme: 'dark', source: 'shell', persistToAccount: true },
  )
})

test('nothing anywhere resolves to light, never to the OS preference', () => {
  assert.deepEqual(
    resolveAuthenticatedTheme(),
    { theme: 'light', source: 'default', persistToAccount: false },
  )
  assert.equal(resolveAuthenticatedTheme({ selection: 'purple', accountTheme: 'teal' }).theme, 'light')
})

test('system mode follows OS changes only when system was explicitly selected', () => {
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('light', true), 'light')
})

test('invalid or inaccessible storage fails safely to light', () => {
  assert.equal(readShellTheme(memoryStorage({ [SHELL_THEME_KEY]: 'purple' })), 'light')
  assert.equal(readShellTheme({ getItem() { throw new Error('denied') } }), 'light')
})

test('theme application updates the root before React and the page loads an external bootstrap', async () => {
  const classes = new Set()
  const root = {
    dataset: {}, style: {},
    classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name) } },
  }
  assert.equal(applyThemeToDocument('dark', { root, prefersDark: false }), 'dark')
  assert.equal(root.dataset.theme, 'dark')
  assert.equal(classes.has('dark'), true)
  assert.equal(root.style.colorScheme, 'dark')

  const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /<script type="module" src="\/src\/theme-bootstrap\.js"><\/script>/)
  assert.doesNotMatch(html, /<script>\s*[^<]*localStorage/)
})
