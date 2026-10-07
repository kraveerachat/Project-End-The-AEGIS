import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8')
const css = read('src/neoNavigation.css')

const NAV = [
  { id: 'dashboard', icon: 'gauge', labelKey: 'navDashboard' },
  { id: 'files', icon: 'folder', labelKey: 'navFiles' },
  { id: 'audit', icon: 'scroll', labelKey: 'navAudit' },
]

test('NEO-NAV-1 markup keeps the route contract and adds only presentation hooks', async () => {
  const vite = await createServer({
    configFile: false,
    root: rootDir,
    cacheDir: path.join(rootDir, 'node_modules/.vite-neo-nav-test'),
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  })
  try {
    const { PositionedNavigation } = await vite.ssrLoadModule('/src/components/PositionedNavigation.jsx')
    const t = (key) => `T:${key}`
    for (const position of ['top', 'bottom']) {
      const html = renderToStaticMarkup(React.createElement(PositionedNavigation, { t, nav: NAV, screen: 'files', go() {}, position }))
      assert.match(html, new RegExp(`class="positioned-navigation positioned-navigation--${position} hidden lg:flex"`))
      // Server-filtered routes plus the appended Settings entry, in order.
      const labels = [...html.matchAll(/aria-label="(T:nav[A-Za-z]+)"/g)].map((m) => m[1])
      assert.deepEqual(labels, ['T:navDashboard', 'T:navFiles', 'T:navAudit', 'T:navSettings'])
      assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1)
      assert.match(html, /aria-current="page" class="positioned-navigation__item is-active"/)
      assert.match(html, /<span class="positioned-navigation__cradle" aria-hidden="true"><\/span>/)
      assert.equal((html.match(/class="positioned-navigation__pod"/g) ?? []).length, 4)
      assert.match(html, /<span class="positioned-navigation__label">T:navFiles<\/span>/)
    }
  } finally {
    await vite.close()
  }
})

test('NEO-NAV-2 every Neo navigation rule is Dark-scoped; Light keeps the index.css bar', () => {
  const selectors = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}@;]+(?=\{)/g)
    .map((s) => s.trim())
    .filter((s) => s && !/^(?:\(|from|to|\d)/.test(s) && !s.startsWith('media'))
  assert.ok(selectors.length > 20)
  for (const selector of selectors) {
    for (const part of selector.split(/,(?![^(]*\))/)) {
      assert.match(part.trim(), /^:root\[data-ui-style="neo"\]\[data-theme="dark"\]/, `unscoped: ${part.trim()}`)
    }
  }
  const index = read('src/index.css')
  assert.match(index, /\.positioned-navigation__item\.is-active \{ color: #fff; background: linear-gradient\(110deg, #126ded, #504be6 64%, #9656bf\); \}/)
  assert.match(index, /\.positioned-navigation__cradle \{ display: none; \}/)
  assert.match(read('src/main.jsx'), /import '\.\/neoNavigation\.css'/)
})

test('NEO-NAV-3 direction, motion and focus: top hangs down, bottom rises, reduced motion collapses', () => {
  assert.match(css, /\.positioned-navigation--top \{[\s\S]*?--nav-lift: 18px;/)
  assert.match(css, /\.positioned-navigation--bottom \{[\s\S]*?--nav-lift: -24px;/)
  assert.match(css, /\.is-active \.positioned-navigation__pod \{[\s\S]*?transform: translateY\(var\(--nav-lift\)\);/)
  assert.match(css, /\[data-cradle="ready"\] \.positioned-navigation__cradle \{\s*transition: transform var\(--nav-glide\)/)
  assert.match(css, /\.positioned-navigation__items \{[\s\S]*?border-radius: 999px;/)
  assert.match(css, /\.positioned-navigation__item:focus-visible:not\(\.is-active\) \{[\s\S]*?box-shadow: 0 0 0 2px/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?positioned-navigation__cradle[\s\S]*?transition-duration: 0\.01ms !important;/)
  assert.doesNotMatch(css, /cubic-bezier\([^)]*-|\b(?:bounce|elastic)\b/, 'no overshoot easing')
})
