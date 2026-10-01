import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import React, { act, useState } from 'react'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'

test('R4 username placeholders describe an account name, not a required name format', () => {
  assert.equal(makeT('en')('usernamePlaceholder'), 'Your username')
  assert.equal(makeT('th')('usernamePlaceholder'), 'ชื่อผู้ใช้ของคุณ')
  assert.equal(makeT('zh')('usernamePlaceholder'), '请输入用户名')
})

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
    submit: () => act(async () => {
      document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 10))
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
    assert.equal(Boolean(field.querySelector('[data-field-trace]')), false, 'Human-rejected linear trace must not return')
    assert.ok(document.querySelector('.login-dot-field[aria-hidden="true"]'))
    assert.ok(document.querySelector('.login-ambient-beam[aria-hidden="true"]'))
    assert.equal(Boolean(document.querySelector('.login-energy-line')), false, 'no travelling energy line across authentication')
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
    await app.click([...document.querySelectorAll('[role="radio"]')].find((button) => button.textContent === 'EN'))
    assert.equal(document.querySelector('h2').textContent, 'Sign in')
    await app.click([...document.querySelectorAll('[role="radio"]')].find((button) => button.textContent === 'TH'))
    assert.equal(document.querySelector('h2').textContent, 'เข้าสู่ระบบ')
    await app.click(document.querySelector('button[aria-label="แสดงรหัสผ่าน"]'))
    assert.equal(document.getElementById('login-password').type, 'text')
    assert.equal(document.getElementById('login-username').value, 'operator')
  } finally {
    await app.cleanup()
  }
})

test('R3 light/dark field tokens and reduced-motion fallback are scoped to login', () => {
  const css = readFileSync(path.join(rootDir, 'src/index.css'), 'utf8')
  assert.match(css, /\.login-shell\s*\{[^}]*--login-haze:/s)
  assert.match(css, /:root\[data-theme="dark"\] \.login-shell\s*\{[^}]*--login-haze:/s)
  assert.match(css, /\.login-field-aura\s*\{/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.login-mark-backlight,[^}]*animation: none !important/s)
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.login-mark\s*\{[^}]*width: 68px/s)
})

test('final polish reduced-motion reveal keeps every login group visible and credentials immediately usable', async () => {
  const app = await mountLogin()
  try {
    await app.render()
    for (const name of ['mark', 'wordmark', 'tagline', 'title', 'subtitle', 'username', 'password', 'remember', 'submit', 'layers', 'controls']) {
      const group = document.querySelector(`[data-login-motion="${name}"]`)
      assert.ok(group, `${name} has its own restrained reveal group`)
      assert.notEqual(group.style.opacity, '0', `${name} is not gated behind motion`)
    }
    assert.equal(document.getElementById('login-username').disabled, false)
    assert.equal(document.getElementById('login-password').disabled, false)
    await app.input('login-username', 'immediate-input')
    await app.input('login-password', 'test-only-password')
    assert.equal(document.querySelector('button[type="submit"]').disabled, false)
  } finally { await app.cleanup() }
})

for (const [status, data, expectedLayer, expectedCopy] of [
  [401, {}, 'fail', 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง'],
  [403, { code: 'CSRF_ORIGIN_MISMATCH' }, 'unavailable', 'โหลดหน้าใหม่'],
]) {
  test(`R3 native submit preserves auth payload and truthful ${status} feedback`, async () => {
    const originalFetch = globalThis.fetch
    const requests = []
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options })
      return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
    }
    const app = await mountLogin()
    try {
      await app.render()
      await app.input('login-username', 'operator')
      await app.input('login-password', 'test-only-password')
      await app.click(document.querySelector('[role="switch"]'))
      await app.submit()
      assert.equal(requests.length, 1)
      assert.match(requests[0].url, /\/api\/login$/)
      assert.equal(requests[0].options.method, 'POST')
      assert.equal(requests[0].options.credentials, 'include')
      assert.deepEqual(JSON.parse(requests[0].options.body), {
        username: 'operator', password: 'test-only-password', remember: true,
      })
      assert.equal(document.querySelectorAll(`[data-layer-status="${expectedLayer}"]`).length, 1)
      assert.equal(document.querySelectorAll('[data-layer-status="ok"]').length, 0)
      assert.match(document.querySelector('[role="alert"]').textContent, new RegExp(expectedCopy))
    } finally {
      await app.cleanup()
      globalThis.fetch = originalFetch
    }
  })
}
