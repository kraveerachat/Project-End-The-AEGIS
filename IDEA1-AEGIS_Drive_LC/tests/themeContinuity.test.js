import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

import {
  SHELL_THEME_KEY,
  applyThemeToDocument,
  readShellTheme,
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
