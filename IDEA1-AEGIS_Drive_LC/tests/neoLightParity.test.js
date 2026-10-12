import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8')
const css = read('src/neoLight.css')
const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
const LIGHT = /^:root\[data-ui-style="neo"\]\[data-theme="light"\]/

test('LIGHT-1 every Neo Light rule is Light-scoped: nothing can reach Dark or Classic', () => {
  const selectors = body.match(/[^{}@;]+(?=\{)/g)
    .map((s) => s.trim())
    .filter((s) => s && !/^(?:\(|from|to|\d)/.test(s) && !s.startsWith('media') && !s.startsWith('keyframes'))
  assert.ok(selectors.length > 80, `expected a full system, got ${selectors.length} selectors`)
  for (const selector of selectors) {
    for (const part of selector.split(/,(?![^(]*\))/)) {
      assert.match(part.trim(), LIGHT, `not Light-scoped: ${part.trim()}`)
    }
  }
  assert.doesNotMatch(body, /data-theme="dark"/)
})

test('LIGHT-2 the owner palette is the token base, and loads after every Dark layer', () => {
  assert.match(css, /--lux-indigo: #4F5DFF;/)
  assert.match(css, /--lux-sky: #78C7FF;/)
  assert.match(css, /--lux-blush: #FABFFF;/)
  assert.match(css, /--accent: #4F5DFF;/)
  const main = read('src/main.jsx')
  const order = ['./index.css', './neoDarkApp.css', './neoDashboard.css', './neoOverlays.css', './neoSelect.css', './neoNavigation.css', './neoLight.css']
  let last = -1
  for (const file of order) {
    const at = main.indexOf(`import '${file}'`)
    assert.ok(at > last, `${file} imported in order`)
    last = at
  }
})

test('LIGHT-3 parity surfaces: chrome, sidebar, panels, controls, overlays, dashboard, charts', () => {
  const hooks = [
    // top chrome
    '.app-topbar {', '.neo-status-pill {', '.neo-topbar-search input {', '.theme-toggle {', '.neo-profile-trigger {', '.neo-topbar-avatar-shell {',
    // sidebar
    '.app-sidebar-frame > .app-sidebar {', '.neo-nav-indicator {',
    // panels + controls
    'main .ui-card {', '.ui-segmented-option[aria-checked="true"]', '.ui-button.bg-accent {', 'button[role="switch"][aria-checked="true"]',
    '.settings-section-button.is-active', '[data-file-card-shell][data-selected="true"]',
    // overlays
    '.ui-modal {', ':is(.anchored-menu, .quick-actions-menu)', '.neo-search-menu [role="option"][aria-selected="true"]', '.upload-entry-dropzone',
    // dashboard + charts
    '.dashboard-layout .ui-card {', '.metric-icon, .dashboard-panel-icon', '.dashboard-storage-radial {', '.recharts-cartesian-axis-tick-value',
    '.dashboard-telemetry-progress > div > span', '.header-action-button.is-primary', '.dashboard-chart-tooltip',
  ]
  for (const hook of hooks) assert.ok(css.includes(hook), `Light styles ${hook}`)
  // Chart series come from the palette through the same tokens Dark uses.
  assert.match(css, /--dashboard-series-uploads: #4F5DFF;\s*--dashboard-series-uploads-top: #78C7FF;/)
  assert.match(css, /--dashboard-series-downloads-top: #FABFFF;/)
})

test('LIGHT-4 the black Light top bar and white-on-white logo are gone; navigation + selects share the Neo system', () => {
  // Top bar: a Light-scoped !important background beats the shared #000117 rule.
  assert.match(css, /\[data-theme="light"\] \.authenticated-shell\[data-screen\] \.app-topbar \{[\s\S]*?background:[\s\S]*?!important;/)
  // Sidebar mark follows the resolved theme (dark-ink logo on the light rail).
  assert.match(read('src/components/Sidebar.jsx'), /<AegisMark size=\{44\} theme=\{resolvedTheme === 'dark' \? 'dark' : 'light'\}/)
  assert.match(read('src/neoNavigation.css'), /\[data-theme="light"\] \.positioned-navigation \{/)
  assert.match(read('src/neoSelect.css'), /\[data-theme="light"\] \{[\s\S]*?--ns-panel-fill/)
  assert.match(read('src/components/ui.jsx'), /const neo = useNeoUi\(\)/)
})

test('LIGHT-5 motion stays in the Neo family, with a reduced-motion fallback', () => {
  assert.doesNotMatch(css, /cubic-bezier\([^)]*-|\b(?:bounce|elastic)\b/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?transition: none !important;/)
  assert.match(css, /animation: lux-pop-in 180ms var\(--neo-ease\) both;/)
})
