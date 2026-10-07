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
      assert.match(html, /<span class="positioned-navigation__cradle" aria-hidden="true"><span class="positioned-navigation__shoulder" data-side="start"><\/span><span class="positioned-navigation__shoulder" data-side="end"><\/span><\/span>/)
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

test('NEO-NAV-3 top = suspended tab that drops DOWN; bottom = round pod that rises UP', () => {
  const top = css.slice(css.indexOf('TOP: suspended tabs'), css.indexOf('BOTTOM: raised pod'))
  const bottom = css.slice(css.indexOf('BOTTOM: raised pod'))
  // Top: one centred column per cell; the tab is the cell's glass extended below the rail.
  assert.match(css, /\.positioned-navigation__item \{[\s\S]*?flex-direction: column;/)
  assert.match(top, /--nav-tab-drop: 18px;/)
  assert.match(top, /\.positioned-navigation--top \.positioned-navigation__cradle \{[\s\S]*?width: calc\(var\(--nav-cradle-w, 46px\) \+ 4px\);[\s\S]*?border-radius: 15px 15px 20px 20px/)
  assert.match(top, /\[data-tab-phase="down"\] \.positioned-navigation__item\.is-active \{\s*transform: translateY\(var\(--nav-tab-shift\)\);/)
  assert.match(top, /\[data-tab-phase="up"\] \.positioned-navigation__cradle \{\s*clip-path: inset\(-12px -12px var\(--nav-tab-drop\)/)
  assert.match(top, /\.positioned-navigation__shoulder\[data-side="start"\] \{[\s\S]*?radial-gradient\(circle at 0 100%/)
  assert.doesNotMatch(top, /border-radius: 50%/, 'no circular pod on the top rail')
  assert.match(top, /:has\(\.is-active:focus-visible\) \.positioned-navigation__cradle/)
  assert.match(top, /\.positioned-navigation__item:focus-visible:not\(\.is-active\) \{[\s\S]*?box-shadow: 0 0 0 2px/)
  // Bottom keeps the round raised pod.
  assert.match(bottom, /--nav-lift: -25px;/)
  assert.match(bottom, /\.positioned-navigation__cradle \{[\s\S]*?border-radius: 50%;/)
  assert.match(bottom, /\.is-active \.positioned-navigation__pod \{[\s\S]*?transform: translateY\(var\(--nav-lift\)\);/)
  // Shared: rounded rail, reduced motion, no overshoot.
  assert.match(css, /\.positioned-navigation__items \{[\s\S]*?border-radius: 999px;/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?positioned-navigation__cradle[\s\S]*?transition-duration: 0\.01ms !important;/)
  assert.doesNotMatch(css, /cubic-bezier\([^)]*-|\b(?:bounce|elastic)\b/, 'no overshoot easing')
})

test('NEO-NAV-4 the top tab retracts before it moves, and switches directly under reduced motion', () => {
  const jsx = read('src/components/PositionedNavigation.jsx')
  assert.match(jsx, /position === 'top' && !reduce && list\.dataset\.cradle === 'ready'/)
  assert.match(jsx, /list\.dataset\.tabPhase = 'up'/)
  assert.match(jsx, /if \(list\.dataset\.tabPhase === 'up'\) return/)
  assert.match(jsx, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/)
})
