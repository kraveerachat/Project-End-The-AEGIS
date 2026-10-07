import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Source contracts for the Classic Glossy Enamel shell (PR #388). Behaviour of
// the shared rail/positioned navigation itself is covered by neoNavigation.test.js.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8')

test('Classic keeps its approved Glossy Dashboard while Neo keeps its own', () => {
  const app = read('src/App.jsx')
  assert.match(app, /lazyNamed\(\(\) => import\('\.\/screens\/ClassicDashboard\.jsx'\), 'ClassicDashboard'\)/)
  assert.match(app, /dashboard: interfaceStyle === 'classic' \? \(\s*<ClassicDashboard/)
  assert.match(read('src/screens/ClassicDashboard.jsx'), /from '\.\.\/components\/ClassicServerTelemetry\.jsx'/)
  // Neo's overview subtitle + inline status are not part of the Classic header.
  assert.match(app, /\{neoDashboard && <p className="mt-1 text-\[13px\] text-ink-2">\{t\('dashOverviewSub'\)\}/)
})

test('Classic and Neo share one rail state machine; Classic only adds material', () => {
  const app = read('src/App.jsx')
  const sidebar = read('src/components/Sidebar.jsx')
  assert.match(app, /const modernShell = neoShell \|\| interfaceStyle === 'classic'/)
  assert.match(app, /neoDashboard=\{modernShell\}/)
  assert.match(sidebar, /const railState = !collapsed \? 'pinned' : temporaryExpanded && hoverRail \? 'hover' : 'compact'/)
  const css = read('src/theme-classic.css')
  // The frame keeps its footprint; only the bar inside widens (overlay, no reflow).
  assert.match(css, /\.app-sidebar-frame > \.app-sidebar \{\s*position: absolute;/)
  assert.match(css, /\.app-sidebar-frame\[data-rail-state="hover"\] > \.app-sidebar \{\s*width: 260px;/)
})

test('Classic brand is the product name only — no marketing subtitle', () => {
  const sidebar = read('src/components/Sidebar.jsx')
  const topbar = read('src/components/TopBar.jsx')
  assert.match(sidebar, /className="neo-sidebar-brand-name"[^>]*>\s*AEGIS Drive_LC\s*</)
  assert.match(topbar, /sub=\{classic \? null : t\('productLockupSub'\)\}/)
})

test('Classic navigation colours resolve through Classic tokens in both modes', () => {
  const css = read('src/theme-classic.css')
  for (const token of ['--classic-nav-bg', '--classic-nav-bg-pressed', '--classic-nav-text', '--classic-nav-accent', '--classic-nav-active-bg', '--classic-nav-active-ink', '--classic-nav-focus', '--classic-nav-divider']) {
    assert.match(css, new RegExp(`${token}:`), `${token} is defined`)
  }
  // No Neo spectral gradient leaks into Classic navigation.
  assert.doesNotMatch(css, /#126ded|#504be6|#9656bf|#9d3fc1/i)
})

test('Classic Top descends and Bottom rises, with reduced motion collapsing travel', () => {
  const css = read('src/theme-classic.css')
  assert.match(css, /\[data-tab-phase="down"\] \.positioned-navigation__item\.is-active \{\s*transform: translateY\(var\(--classic-nav-drop\)\);/)
  assert.match(css, /\.positioned-navigation__item\.is-active \.positioned-navigation__pod \{[\s\S]*?transform: translateY\(var\(--classic-nav-rise\)\);/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*:root\[data-ui-style="classic"\] \{\s*--nav-dur: 0\.01ms;/)
})

test('Appearance previews: Classic card shows Glossy Enamel; position previews hover without saving', () => {
  const settings = read('src/screens/Settings.jsx')
  const css = read('src/theme-classic.css')
  assert.match(settings, /<span className="navigation-position-preview__active" \/>/)
  // Hover is CSS-only; selection still goes through the existing preference setter.
  assert.match(settings, /onSelect=\{\(\) => setNavigationPosition\?\.\(position\)\}/)
  assert.match(css, /\.interface-style-preview__canvas\.is-classic \.interface-style-preview__sidebar/)
  assert.match(css, /\.navigation-position-preview:hover:not\(:disabled\) \.navigation-position-preview__canvas\.is-top \.navigation-position-preview__active/)
  assert.doesNotMatch(read('src/lib/strings.js'), /interfaceStyleClassicDescription: '[^']*Precision Ledger/)
})

test('Classic Top/Bottom rails: centred floating rail, one cell width, labels never ellipsised', () => {
  const css = read('src/theme-classic.css')
  assert.match(css, /\.positioned-navigation--top \.positioned-navigation__items \{\s*margin-inline: auto;/)
  assert.match(css, /\.positioned-navigation__item \{\s*flex: 0 1 var\(--rail-cell-w\);[\s\S]*?width: var\(--rail-cell-w\);[\s\S]*?height: var\(--rail-cell-h\);/)
  // Thai tone marks must not be shaved: no clamp/overflow clipping on rail labels.
  const label = css.match(/\.positioned-navigation__label \{([^}]*)\}/)[1]
  assert.doesNotMatch(label, /overflow:\s*hidden|line-clamp|text-overflow/)
  assert.match(label, /white-space: normal;/)
  // Bottom keeps icon + label together at every desktop width (base hides labels <1450px).
  assert.match(css, /\.positioned-navigation--bottom \.positioned-navigation__label \{\s*display: block;/)
})

test('Classic selects reuse the shared custom listbox; menus share one Classic surface', () => {
  const ui = read('src/components/ui.jsx')
  assert.match(ui, /const classic = useIsClassic\(\)\s*if \(neo \|\| classic\) return <NeoSelect/)
  const css = read('src/theme-classic.css')
  for (const surface of ['.neo-select-panel', '.anchored-menu', '.neo-profile-menu', '.neo-search-menu', '.quick-actions-menu']) {
    assert.ok(css.includes(surface), `${surface} has a Classic surface`)
  }
  for (const token of ['--menu-radius', '--menu-row-h', '--classic-menu-hover', '--classic-menu-selected']) {
    assert.match(css, new RegExp(`${token}:`))
  }
})
