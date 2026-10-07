import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React, { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadUi() {
  const vite = await createServer({
    configFile: false,
    root: rootDir,
    cacheDir: path.join(rootDir, 'node_modules/.vite-neo-select-test'),
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  })
  const ui = await vite.ssrLoadModule('/src/components/ui.jsx')
  return { vite, ui }
}

function withDom(theme, fn) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })
  const prev = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT, MO: globalThis.MutationObserver, raf: globalThis.requestAnimationFrame, Event: globalThis.Event }
  if (theme) {
    dom.window.document.documentElement.dataset.uiStyle = 'neo'
    dom.window.document.documentElement.dataset.theme = theme
  }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.MutationObserver = dom.window.MutationObserver
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window)
  globalThis.Event = dom.window.Event
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  return fn(dom).finally(() => {
    globalThis.window = prev.window
    globalThis.document = prev.document
    globalThis.MutationObserver = prev.MO
    globalThis.requestAnimationFrame = prev.raf
    globalThis.Event = prev.Event
    globalThis.IS_REACT_ACT_ENVIRONMENT = prev.act
    dom.window.close()
  })
}

const key = (el, k, win) => el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }))

test('NEO-SELECT-1 outside Neo Dark the native <select> renders unchanged (SSR, Light, Classic)', async () => {
  const { vite, ui } = await loadUi()
  try {
    const html = renderToStaticMarkup(React.createElement(ui.PillSelect, { 'aria-label': 'sort', defaultValue: 'b', onChange() {} },
      React.createElement('option', { value: 'a' }, 'A'), React.createElement('option', { value: 'b' }, 'B')))
    assert.match(html, /^<select[^>]*aria-label="sort"/)
    assert.doesNotMatch(html, /role="combobox"/)
    await withDom('light', async (dom) => {
      const root = createRoot(dom.window.document.getElementById('root'))
      await act(async () => root.render(React.createElement(ui.PillSelect, { 'aria-label': 'x' }, React.createElement('option', { value: 'a' }, 'A'))))
      assert.equal(dom.window.document.querySelector('[role="combobox"]'), null, 'Light keeps the native select')
      assert.ok(dom.window.document.querySelector('select[aria-label="x"]'))
      await act(async () => root.unmount())
    })
  } finally { await vite.close() }
})

test('NEO-SELECT-2 in Neo Dark: combobox + rounded listbox; keyboard, change contract, Escape, disabled', async () => {
  const { vite, ui } = await loadUi()
  try {
    await withDom('dark', async (dom) => {
      const doc = dom.window.document
      const changes = []
      function Harness() {
        const [value, setValue] = useState('name-asc')
        return React.createElement(ui.PillSelect, {
          'aria-label': 'จัดเรียงตาม',
          'data-testid': 'sort',
          value,
          onChange: (event) => { changes.push(event.target.value); setValue(event.target.value) },
        },
        React.createElement('option', { value: 'name-asc' }, 'ชื่อ: A → Z'),
        React.createElement('option', { value: 'name-desc' }, 'ชื่อ: Z → A'),
        React.createElement('option', { value: 'locked', disabled: true }, 'ล็อก'),
        React.createElement('option', { value: 'size-desc' }, 'ขนาด: ใหญ่สุดก่อน'))
      }
      const root = createRoot(doc.getElementById('root'))
      await act(async () => root.render(React.createElement(Harness)))

      const trigger = doc.querySelector('[role="combobox"]')
      const native = doc.querySelector('select[data-testid="sort"]')
      assert.ok(trigger, 'trigger rendered')
      assert.ok(native, 'native select kept as the value / form / test source')
      assert.equal(native.getAttribute('aria-hidden'), 'true')
      assert.equal(trigger.getAttribute('aria-label'), 'จัดเรียงตาม')
      assert.match(trigger.textContent, /ชื่อ: A → Z/)
      assert.equal(trigger.getAttribute('aria-expanded'), 'false')

      // Enter opens; options mirror the <option> children in order.
      await act(async () => key(trigger, 'Enter', dom.window))
      assert.equal(trigger.getAttribute('aria-expanded'), 'true')
      const listbox = doc.querySelector('[role="listbox"]')
      assert.ok(listbox && listbox.classList.contains('neo-select-panel'))
      const opts = [...listbox.querySelectorAll('[role="option"]')]
      assert.deepEqual(opts.map((o) => o.textContent), ['ชื่อ: A → Z', 'ชื่อ: Z → A', 'ล็อก', 'ขนาด: ใหญ่สุดก่อน'])
      assert.equal(opts[0].getAttribute('aria-selected'), 'true')
      assert.equal(opts[2].getAttribute('aria-disabled'), 'true')

      // ArrowDown twice skips the disabled option; Enter chooses through onChange.
      await act(async () => key(trigger, 'ArrowDown', dom.window))
      await act(async () => key(trigger, 'ArrowDown', dom.window))
      assert.match(trigger.getAttribute('aria-activedescendant'), /opt-3$/)
      await act(async () => key(trigger, 'Enter', dom.window))
      assert.deepEqual(changes, ['size-desc'], 'onChange receives a real change event with the option value')
      assert.equal(native.value, 'size-desc')
      assert.match(trigger.textContent, /ขนาด: ใหญ่สุดก่อน/)
      assert.equal(doc.querySelector('[role="listbox"]'), null, 'closes after choosing')

      // Escape closes without changing the value.
      await act(async () => key(trigger, 'ArrowDown', dom.window))
      assert.ok(doc.querySelector('[role="listbox"]'))
      await act(async () => key(trigger, 'Escape', dom.window))
      assert.equal(doc.querySelector('[role="listbox"]'), null)
      assert.deepEqual(changes, ['size-desc'])

      // Mouse: click trigger, click an option.
      await act(async () => trigger.click())
      await act(async () => doc.querySelectorAll('[role="option"]')[1].click())
      assert.deepEqual(changes, ['size-desc', 'name-desc'])
      await act(async () => root.unmount())
    })

    await withDom('dark', async (dom) => {
      const doc = dom.window.document
      const root = createRoot(doc.getElementById('root'))
      await act(async () => root.render(React.createElement(ui.PillSelect, { 'aria-label': 'off', disabled: true, onChange() {} },
        React.createElement('option', { value: 'a' }, 'A'))))
      const trigger = doc.querySelector('[role="combobox"]')
      assert.equal(trigger.disabled, true)
      await act(async () => key(trigger, 'Enter', dom.window))
      assert.equal(doc.querySelector('[role="listbox"]'), null, 'disabled never opens')
      await act(async () => root.unmount())
    })
  } finally { await vite.close() }
})

test('NEO-SELECT-3 every select in the app goes through PillSelect; list styling is Dark-scoped and rounded', () => {
  const src = path.join(rootDir, 'src')
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.jsx$/.test(e.name) ? [path.join(d, e.name)] : [])
  const rawSelects = walk(src).filter((f) => /<select\b/.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(rawSelects.map((f) => path.relative(src, f).replace(/\\/g, '/')).sort(), ['components/NeoSelect.jsx', 'components/ui.jsx'])
  const css = fs.readFileSync(path.join(src, 'neoOverlays.css'), 'utf8')
  assert.match(css, /\.neo-select-panel \{[\s\S]*?border-radius: 14px;[\s\S]*?z-index: var\(--z-tooltip\)|\.neo-select-panel \{[\s\S]*?z-index: var\(--z-tooltip\);[\s\S]*?border-radius: 14px;/)
  assert.match(css, /\.neo-select-trigger:focus-visible,[\s\S]*?border-radius: 999px;/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.neo-select-panel/)
})
