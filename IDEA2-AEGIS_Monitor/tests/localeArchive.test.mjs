import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveMessages } from '../src/lib/localeArchive.js'
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

test('archive and event localization retains camera, window, and route placeholders', () => {
  for (const key of ['{camera} recording · {window}', 'Download {camera} clip · {window}', 'Routed to Telegram ➔ {route}']) {
    assert.ok(archiveMessages[key], `Missing display translation: ${key}`)
    for (const translation of archiveMessages[key]) {
      assert.deepEqual(placeholders(translation), placeholders(key))
    }
  }
})

test('every archive and event message has nonempty Thai and Chinese translations with matching parameters', () => {
  assert.ok(Object.keys(archiveMessages).length > 0)
  for (const [source, translations] of Object.entries(archiveMessages)) {
    assert.equal(translations.length, 2, source)
    for (const translation of translations) {
      assert.equal(typeof translation, 'string', source)
      assert.ok(translation.trim(), source)
      assert.deepEqual(placeholders(translation), placeholders(source), source)
    }
  }
})
