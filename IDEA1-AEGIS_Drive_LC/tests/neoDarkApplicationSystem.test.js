import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React, { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { useScrollReveal } from '../src/lib/useScrollReveal.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8')
const app = read('src/App.jsx')
const main = read('src/main.jsx')
const layer = read('src/neoDarkApp.css')
const indexCss = read('src/index.css')
const motion = read('src/lib/useNeoPageMotion.js')

test('NEO-DARK-SHELL the approved floating shell is shared by every Neo screen', () => {
  assert.match(app, /const neoShell = interfaceStyle === 'neo'/)
  assert.match(app, /neoDashboard=\{neoShell\}\s+position=\{navigationPosition\}/, 'Sidebar receives the shell for every screen')
  assert.match(app, /neoDashboard=\{neoShell\}\s+collapsed=\{collapsed\}/, 'TopBar receives the shell for every screen')
  assert.match(app, /search=\{neoShell \? \(/, 'Top Bar search is the single search on every Neo screen')
  assert.match(app, /neoShell \? 'neo-page-content min-h-full'/)
  // Shell rules are no longer gated on the Dashboard route.
  assert.doesNotMatch(indexCss, /\.authenticated-shell\[data-screen="dashboard"\] \.app-sidebar-frame/)
  assert.match(indexCss, /\.authenticated-shell\[data-screen\] \.app-sidebar-frame/)
  // The Dashboard-only hatch suppression stays Dashboard-only: Vault uses hatch as ciphertext.
  assert.match(indexCss, /\.authenticated-shell\[data-screen="dashboard"\] \.hatch \{/)
})

test('NEO-DARK-LAYER is Dark + Neo only and never restyles the Dashboard baseline', () => {
  assert.match(main, /import '\.\/neoDarkApp\.css'/)
  const selectors = layer.match(/^[^@/\s{}][^{}]*\{/gm) ?? []
  for (const selector of selectors) {
    if (/^(from|to)\b/.test(selector.trim())) continue
    if (/^\.context-search-input/.test(selector.trim())) continue
    assert.match(selector, /:root\[data-ui-style="neo"\]/, `unscoped selector: ${selector}`)
    if (/\.authenticated-shell[^{]*main/.test(selector)) {
      // Either excludes Dashboard explicitly, or names one other screen.
      assert.match(selector, /:not\(\[data-screen="dashboard"\]\)|\[data-screen="(?!dashboard")[a-z]+"\]/, `page rule must exclude Dashboard: ${selector}`)
    }
  }
  assert.doesNotMatch(layer, /data-theme="light"/, 'this pass does not restyle Light')
})

test('NEO-DARK-GLASS one blur per stack: nested panels and rows are solid', () => {
  assert.match(layer, /main \.ui-card \{[\s\S]*?backdrop-filter: blur\(12px\)/)
  const nested = layer.match(/:is\(\.ui-card \.ui-card, \.ui-card\.neo-row-card, \.neo-inner\) \{[\s\S]*?\}/)?.[0] ?? ''
  assert.match(nested, /backdrop-filter: none/)
  const segmented = layer.match(/\.ui-modal\) \.ui-segmented \{[\s\S]*?\}/)?.[0] ?? ''
  assert.match(segmented, /backdrop-filter: none/, 'segmented controls inside a glass panel do not blur again')
})

test('NEO-DARK-MOTION pointer light writes CSS variables only, and every layer honours reduced motion', () => {
  assert.match(motion, /addEventListener\('pointermove', onMove, \{ passive: true \}\)/)
  assert.match(motion, /requestAnimationFrame\(flush\)/)
  assert.doesNotMatch(motion, /useState/, 'no React state per pointer move')
  assert.match(motion, /setTimeout\(\(\) => tween\?\.progress\(1\), 1200\)/, 'entrance failsafe')
  assert.match(motion, /await import\('gsap'\)/, 'GSAP stays out of the initial bundle')
  assert.match(app, /useNeoPageMotion\(mainRef, activeScreen, Boolean\(session\) && !loadingScreen, neoShell && !neoDashboard && resolvedTheme === 'dark', reduced\)/)
  assert.match(layer, /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none !important/)
})

test('NEO-DARK-TRUTH redesign hooks never fabricate values', () => {
  const audit = read('src/screens/Audit.jsx')
  // Summary counts come from loaded rows and render only after a real read.
  assert.match(audit, /!api\.loading && !fetchError && !placeholderMode && events\.length > 0 && \(/)
  assert.match(audit, /events\.filter\(\(e\) => visible\(e\) && e\.result === option\.value\)\.length/)
  assert.doesNotMatch(audit, /borderLeft:/, 'no side-stripe accent on denied rows')
  const history = read('src/screens/FileHistory.jsx')
  assert.match(history, /listApi\.loading \|\| \(activeId != null && detailApi\.loading\)/, 'no file selected is not "loading forever"')
})

test('NEO-DARK-AUTOFILL credential autofill cannot land in search or a share password', () => {
  const search = read('src/components/GlobalSearch.jsx')
  assert.match(search, /type="search"\s+name="aegis-global-search"\s+autoComplete="off"/)
  const shares = read('src/screens/Shares.jsx')
  assert.match(shares, /type="password"\s+\/\/[^\n]*\n\s+autoComplete="new-password"/)
})

test('NEO-REVEAL-3 sections mounted after the screen key changes are still revealed', async () => {
  const dom = new JSDOM('<!doctype html><main id="scroller"></main>')
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    act: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0)
  dom.window.cancelAnimationFrame = (id) => clearTimeout(id)
  // An observer that never reports — the worst case the failsafe must cover.
  dom.window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  function Screen({ ready }) {
    const ref = useRef(null)
    useScrollReveal(ref, 'storage', true)
    return React.createElement('div', { ref },
      ready
        ? React.createElement('section', { 'data-reveal': '', id: 'late' }, 'Disk health')
        : React.createElement('div', { className: 'skeleton' }))
  }

  const root = createRoot(dom.window.document.getElementById('scroller'))
  try {
    // First render: transition skeleton, no revealable section yet.
    await act(async () => root.render(React.createElement(Screen, { ready: false })))
    // The real section mounts later as a new node.
    await act(async () => root.render(React.createElement(Screen, { ready: true })))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 1400)))
    const late = dom.window.document.getElementById('late')
    assert.equal(dom.window.document.documentElement.dataset.neoReveal, 'on')
    assert.equal(late.dataset.revealed, 'true', 'a late-mounted section is never stranded hidden')
  } finally {
    await act(async () => root.unmount())
    assert.equal(dom.window.document.documentElement.dataset.neoReveal, undefined, 'teardown disarms the from-state')
    globalThis.window = previous.window
    globalThis.document = previous.document
    globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act
    dom.window.close()
  }
})
