import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))
let vite
let Login

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: fixture }] },
  })
  Login = (await vite.ssrLoadModule('/src/screens/Login.jsx')).Login
})

after(async () => vite?.close())

async function mountLogin() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/drive/',
    pretendToBeVisual: true,
  })
  const saved = new Map()
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.getElementById('root'))

  function Harness() {
    const [theme, setTheme] = useState('light')
    const [lang, setLang] = useState('th')
    return React.createElement(Login, {
      t: makeT(lang), lang, setLang, theme, resolvedTheme: theme, setTheme,
      onAuthed: () => {},
    })
  }

  return {
    render: () => act(async () => root.render(React.createElement(Harness))),
    click: (element) => act(async () => element.click()),
    input: (id, value) => act(async () => {
      const element = document.getElementById(id)
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      setter.call(element, value)
      element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    }),
    cleanup: async () => {
      await act(async () => root.unmount())
      for (const [key, descriptor] of saved) {
        if (descriptor === undefined) delete globalThis[key]
        else Object.defineProperty(globalThis, key, descriptor)
      }
      dom.window.close()
    },
  }
}

test('R3 security field uses one decorative field and a native sign-in form', async () => {
  const app = await mountLogin()
  try {
    await app.render()
    const field = document.querySelector('[data-security-field]')
    assert.ok(field, 'login surface exposes the coordinated security field')
    assert.equal(field.getAttribute('data-motion'), 'reduced')
    assert.ok(field.querySelector('[data-field-aura][aria-hidden="true"]'))
    assert.ok(field.querySelector('[data-field-trace][aria-hidden="true"]'))
    const form = document.querySelector('form')
    assert.ok(form, 'Enter uses the native form submission path')
    assert.equal(form.querySelector('button[type="submit"]')?.disabled, true)
    assert.equal(document.querySelectorAll('[data-layer-status="ok"]').length, 0,
      'architectural layers are not advertised as independently verified before login')
    assert.equal(document.body.textContent.includes('aegis-drive-admin'), false,
      'production-facing login does not advertise demo credentials')
  } finally {
    await app.cleanup()
  }
})

test('R3 theme and language changes preserve entered credentials and remember choice', async () => {
  const app = await mountLogin()
  try {
    await app.render()
    await app.input('login-username', 'operator')
    await app.input('login-password', 'correct horse battery staple')
    await app.click(document.querySelector('[role="switch"]'))
    await app.click(document.querySelector('button[aria-label="Switch to dark mode"]'))
    await app.click([...document.querySelectorAll('[role="radio"]')].find((button) => button.textContent === 'ZH'))
    assert.equal(document.getElementById('login-username').value, 'operator')
    assert.equal(document.getElementById('login-password').value, 'correct horse battery staple')
    assert.equal(document.querySelector('[role="switch"]').getAttribute('aria-checked'), 'true')
    assert.equal(document.querySelector('h2').textContent, '登录')
  } finally {
    await app.cleanup()
  }
})
