import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8')

test('Dashboard quick actions live in the page header instead of a full-width content rail', () => {
  const app = read('src/App.jsx')
  const dashboard = read('src/screens/Dashboard.jsx')
  const quickActionsPath = path.join(rootDir, 'src/components/DashboardQuickActions.jsx')

  assert.equal(fs.existsSync(quickActionsPath), true, 'compact header actions component must exist')
  assert.match(app, /screen === 'dashboard' && <DashboardQuickActions/)
  assert.doesNotMatch(dashboard, /quick-action-rail/)
})

test('AEGIS marks consume the existing resolved theme without a second observer-based theme source', () => {
  const mark = read('src/components/AegisMark.jsx')
  const sidebar = read('src/components/Sidebar.jsx')
  const login = read('src/screens/Login.jsx')

  assert.doesNotMatch(mark, /MutationObserver|useIsDarkMode/)
  assert.match(mark, /themeAssetsFor\(theme\)\.logo/)
  assert.match(sidebar, /resolvedTheme/)
  assert.match(sidebar, /<AegisMark[^>]*theme=\{resolvedTheme\}/)
  assert.match(sidebar, /<AegisLockup[^>]*theme=\{resolvedTheme\}/)
  assert.match(login, /<AegisMark[^>]*theme=\{resolvedTheme\}/)
})

test('static cards do not advertise clickability and polish respects reduced motion', () => {
  const ui = read('src/components/ui.jsx')
  const css = read('src/index.css')

  assert.doesNotMatch(ui, /hover:-translate-y-0\.5 hover:shadow-lg/)
  assert.match(ui, /interactive \? 'is-interactive' : ''/)
  assert.match(css, /\.dashboard-header-actions/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.dashboard-header-actions/)
})

test('a theme choice remains active for the current session when preference persistence is unavailable', () => {
  const app = read('src/App.jsx')
  const strings = read('src/lib/strings.js')

  assert.doesNotMatch(app, /setValue\(previous\[key\]\)/)
  assert.match(strings, /active for this session only/i)
  assert.match(strings, /ใช้ได้เฉพาะในเซสชันนี้/)
})

test('the mobile quick-actions trigger does not leak into desktop and its menu stacks above cards', () => {
  const css = read('src/index.css')

  assert.match(css, /\.quick-actions-trigger\s*\{[\s\S]*?display:\s*none/)
  assert.match(css, /@media \(max-width: 767px\)[\s\S]*?\.quick-actions-trigger\s*\{[\s\S]*?display:\s*inline-flex/)
  assert.match(css, /\.dashboard-page-header\s*\{[\s\S]*?z-index:\s*var\(--z-dropdown\)/)
})
