import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('Neo Dashboard brand and pin control remain inside the floating sidebar', () => {
  const sidebar = read('src/components/Sidebar.jsx')
  const css = read('src/index.css')

  assert.match(sidebar, /neo-sidebar-brand-row[\s\S]*?<AegisMark size=\{44\} theme="dark" className="neo-sidebar-brand-mark"/)
  assert.match(sidebar, /neo-sidebar-brand-name" aria-hidden=\{isCollapsed\}/)
  assert.match(sidebar, /neo-sidebar-brand-row[\s\S]*?neo-sidebar-header-toggle/)
  assert.match(sidebar, /onClick=\{\(\) => \{\s*clearTimeout\(hoverTimerRef\.current\)\s*setCollapsed\(\(current\) => !current\)/)
  assert.match(sidebar, /hoverTimerRef\.current = setTimeout\(\(\) => setTemporaryExpanded\(true\), 180\)/)
  assert.match(sidebar, /event\.target\.matches\(':focus-visible'\)/)
  assert.match(css, /neo-sidebar-header--compact \.neo-sidebar-header-toggle\s*\{\s*translate: 0 50px/)
  assert.match(css, /data-rail-state="hover"\] \.neo-sidebar-header-toggle\s*\{\s*translate: 188px 0/)
  assert.match(css, /neo-sidebar-header-toggle:focus-visible::before/)
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?neo-sidebar-header-toggle\)::before/)
  assert.match(css, /linear-gradient\(162deg, #293dd6 0%, #3e48c1 46%, #6c5ba4 100%\)/)
})

test('Dashboard utility menus use scoped open and close motion with reduced-motion fallback', () => {
  const topBar = read('src/components/TopBar.jsx')
  const search = read('src/components/GlobalSearch.jsx')
  const css = read('src/index.css')

  assert.match(topBar, /data-state=\{open \? 'open' : 'closing'\}/)
  assert.match(topBar, /inert=\{!open\}/)
  assert.match(search, /neoDashboard \? panelVisible && !disabled : panelOpen/)
  assert.match(search, /data-state=\{panelOpen \? 'open' : 'closing'\}/)
  assert.match(css, /\.neo-profile-menu,[^{]+\.neo-search-menu\s*\{[\s\S]{0,100}background: #111a33 !important/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.neo-profile-menu, \.neo-search-menu/)
})
