import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSections, viewOrderOf } from '../src/nav.js'
import { messages, normalizeLanguage, languageTag, translate } from '../src/lib/i18n.js'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const menu = [
  { id: 'live', group: 'navObservation' },
  { id: 'archive', group: 'navObservation' },
  { id: 'settings', group: 'navPrefs' },
]
test('Thai menu labels update without changing server menu IDs', () => {
  assert.deepEqual(buildSections(menu, 'th').flatMap(s => s.items.map(i => i.label)),
    ['ภาพสด', 'วิดีโอย้อนหลัง', 'การตั้งค่า'])
  assert.deepEqual(viewOrderOf(menu), ['live', 'archive', 'settings'])
})
test('Chinese menu does not invent SOC-only permissions', () => {
  const sections = buildSections(menu, 'zh')
  assert.equal(sections[0].label, '观察')
  assert.deepEqual(sections.flatMap(s => s.items.map(i => i.id)), viewOrderOf(menu))
  assert.equal(sections[1].items[0].label, '设置')
})

test('unsupported preferences are bounded to the three supported languages', () => {
  for (const value of [null, '', 'xx', '__proto__', '<script>']) assert.equal(normalizeLanguage(value), 'th')
  assert.equal(languageTag('zh'), 'zh-CN')
  assert.equal(languageTag('en'), 'en')
})

test('all catalog entries preserve literal identity/number placeholders in both translations', () => {
  const placeholders = text => [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map(m => m[1]).sort()
  for (const [key, translations] of Object.entries(messages)) {
    assert.equal(translations.length, 2, key)
    for (const text of translations) {
      assert.ok(text.trim(), key)
      assert.deepEqual(placeholders(text), placeholders(key), key)
    }
  }
  const name = 'CAM-02 {count} <b>Admin</b> $&'
  assert.equal(translate('en', 'Authorized — {names}', { names: name }), 'Authorized — ' + name)
  assert.equal(translate('zh', 'Authorized — {names}', { names: name }), '已获授权 — ' + name)
  assert.equal(translate('th', 'mr-tk-01'), 'mr-tk-01')
})

test('literal display translation calls cannot silently fall back to English', () => {
  const root = resolve(import.meta.dirname, '../src')
  const files = ['views', 'components'].flatMap(dir => readdirSync(resolve(root, dir))
    .filter(file => file.endsWith('.jsx')).map(file => resolve(root, dir, file)))
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // Settings/Login retain their existing namespaced dictionaries.
    const names = file.endsWith('Settings.jsx') ? 'uiT' : 't'
    for (const match of source.matchAll(/\b(t|uiT)\((['"])([^\n]*?)\2/g)) {
      if (match[1] !== names) continue
      const key = match[3]
      if (key.includes('\\')) continue // Escaped apostrophe is checked in catalog tests.
      assert.ok(Object.hasOwn(messages, key) || key === 'L', file + ': ' + key)
    }
  }
})
