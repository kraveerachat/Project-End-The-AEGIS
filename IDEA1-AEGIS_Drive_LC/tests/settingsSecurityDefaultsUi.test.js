// tests/settingsSecurityDefaultsUi.test.js — the persisted Security defaults form
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let dom
let createRoot
let vite
let SecurityDefaultsCard

before(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  vite = await createServer({ configFile: false, root: rootDir, appType: 'custom', logLevel: 'silent', plugins: [reactPlugin()], server: { middlewareMode: true } })
  ;({ SecurityDefaultsCard } = await vite.ssrLoadModule('/src/components/SettingsPanels.jsx'))
})

after(async () => {
  await vite?.close()
  delete globalThis.IS_REACT_ACT_ENVIRONMENT
  dom?.window.close()
})

test('SECURITY-SETTINGS-UI-1 stages related changes and commits one complete persisted contract', async () => {
  const saved = []
  const host = dom.window.document.createElement('div')
  dom.window.document.body.appendChild(host)
  const root = createRoot(host)
  const value = { vaultAutoLockMinutes: 30, shareDefaults: { expiry: '7d', scope: 'any', requirePassword: false } }
  function PersistedHarness() {
    const [persisted, setPersisted] = React.useState(value)
    return React.createElement(SecurityDefaultsCard, {
      t: makeT('en'), value: persisted, saving: false, error: false,
      onSave: async (next) => { saved.push(next); setPersisted(next); return true },
    })
  }
  await act(async () => root.render(React.createElement(PersistedHarness)))

  const autoLock = host.querySelector('select[aria-label="Lock after idle"]')
  const expiry = host.querySelector('#share-default-expiry')
  const submit = host.querySelector('button[type="submit"]')
  assert.ok(submit.disabled, 'unchanged server values cannot be submitted again')

  await act(async () => {
    autoLock.value = '60'
    autoLock.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    expiry.value = '30d'
    expiry.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  assert.equal(saved.length, 0, 'editing fields does not partially persist the policy')
  assert.equal(submit.disabled, false)

  await act(async () => submit.click())
  assert.deepEqual(saved, [{
    vaultAutoLockMinutes: 60,
    shareDefaults: { expiry: '30d', scope: 'any', requirePassword: false },
  }])
  assert.ok(host.textContent.includes('Security defaults saved.'), 'server prop reconciliation must not erase success feedback')

  await act(async () => root.unmount())
  host.remove()
})
