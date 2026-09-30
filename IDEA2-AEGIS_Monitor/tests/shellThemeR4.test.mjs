import test from 'node:test'
import assert from 'node:assert/strict'
import { readShellTheme, resolveShellTheme, SHELL_THEME_KEY } from '../src/lib/shellTheme.js'

function storage(entries = {}) {
  const data = new Map(Object.entries(entries))
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
}

test('Monitor login fresh shell is light', () => {
  assert.equal(readShellTheme(storage()), 'light')
})

test('Monitor login adopts legacy once and canonical wins thereafter', () => {
  const store = storage({ aegis_theme: 'dark' })
  assert.equal(readShellTheme(store), 'dark')
  assert.equal(store.getItem(SHELL_THEME_KEY), 'dark')
  store.setItem('aegis_theme', 'light')
  assert.equal(readShellTheme(store), 'dark')
})

test('Monitor login resolves system without overwriting canonical selection', () => {
  const store = storage({ aegis_shell_theme: 'system', aegis_theme: 'dark' })
  assert.equal(readShellTheme(store), 'system')
  assert.equal(resolveShellTheme(readShellTheme(store), false), 'light')
  assert.equal(resolveShellTheme(readShellTheme(store), true), 'dark')
  assert.equal(store.getItem(SHELL_THEME_KEY), 'system')
})
