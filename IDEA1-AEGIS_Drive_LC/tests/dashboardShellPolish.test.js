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

  assert.match(sidebar, /neo-sidebar-brand-row[\s\S]*?<AegisMark size=\{44\} theme="dark"/)
  assert.match(sidebar, /<AegisLockup markSize=\{44\} theme="dark" title="AEGIS Drive_LC" sub=\{null\}/)
  assert.match(sidebar, /neo-sidebar-brand-row[\s\S]*?neo-sidebar-header-toggle/)
  assert.match(sidebar, /onClick=\{\(\) => setCollapsed\(\(current\) => !current\)\}/)
  assert.match(css, /data-rail-state="hover"\] \.neo-sidebar-header-toggle/)
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
