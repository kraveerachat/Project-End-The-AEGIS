import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

import {
  applyAuthenticatedInterfaceStyle,
  clearAuthenticatedInterfaceStyle,
  normalizeInterfaceStyle,
} from '../src/lib/interfaceStyle.js'

test('invalid and missing account styles fail closed to Classic', () => {
  assert.equal(normalizeInterfaceStyle(undefined), 'classic')
  assert.equal(normalizeInterfaceStyle('neo'), 'neo')
  assert.equal(normalizeInterfaceStyle('classic'), 'classic')
  assert.equal(normalizeInterfaceStyle('cyberpunk'), 'classic')
})

test('authenticated style application uses no browser storage hint and is removable for Login', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const { document, localStorage } = dom.window

  assert.equal(document.documentElement.dataset.uiStyle, undefined)
  assert.equal(localStorage.length, 0)

  assert.equal(applyAuthenticatedInterfaceStyle('neo', document), 'neo')
  assert.equal(document.documentElement.dataset.uiStyle, 'neo')
  assert.equal(localStorage.length, 0, 'interface style must not become a pre-authentication hint')

  clearAuthenticatedInterfaceStyle(document)
  assert.equal(document.documentElement.dataset.uiStyle, undefined)
  assert.equal(localStorage.length, 0)
  dom.window.close()
})
