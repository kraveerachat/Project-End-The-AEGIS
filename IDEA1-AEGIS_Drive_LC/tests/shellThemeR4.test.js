import test from 'node:test'
import assert from 'node:assert/strict'
import { readStoredShellTheme, readShellTheme, resolveAuthenticatedTheme, SHELL_THEME_KEY } from '../src/lib/theme.js'

function storage(entries = {}) {
  const values = new Map(Object.entries(entries))
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  }
}

test('R4 fresh shell defaults light without inventing a selection', () => {
  const store = storage()
  assert.equal(readShellTheme(store), 'light')
  assert.equal(readStoredShellTheme(store), null)
})

test('R4 valid legacy selection migrates once only when canonical is absent', () => {
  const store = storage({ aegis_theme: 'dark' })
  assert.equal(readShellTheme(store), 'dark')
  assert.equal(store.getItem(SHELL_THEME_KEY), 'dark')
  store.setItem('aegis_theme', 'light')
  assert.equal(readShellTheme(store), 'dark')
})

test('R4 canonical selection wins over conflicting legacy selection', () => {
  const store = storage({ aegis_theme: 'dark', aegis_shell_theme: 'light' })
  assert.equal(readShellTheme(store), 'light')
  assert.equal(store.getItem(SHELL_THEME_KEY), 'light')
})

test('R4 legacy system selection remains system after migration', () => {
  const store = storage({ aegis_theme: 'system' })
  assert.equal(readShellTheme(store), 'system')
  assert.equal(store.getItem(SHELL_THEME_KEY), 'system')
})

test('R4 selected shell appearance survives Drive authentication over stale account appearance', () => {
  assert.deepEqual(resolveAuthenticatedTheme({ shellTheme: 'dark', accountTheme: 'light' }), {
    theme: 'dark', source: 'shell', persistToAccount: true,
  })
})
