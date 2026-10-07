import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8')

test('Classic Phase 1 keeps the Neo dashboard module structure and truthful data bindings', () => {
  const dashboard = read('src/screens/Dashboard.jsx')
  const app = read('src/App.jsx')
  for (const hook of ['dashboard-kpi-row', 'dashboard-analytics-grid', 'dashboard-ops-grid', 'dashboard-links-row']) {
    assert.match(dashboard, new RegExp(hook))
  }
  for (const binding of ['/api/dashboard', '/api/storage', 'ServerTelemetry', 'dashboardUnavailable']) {
    assert.ok(dashboard.includes(binding))
  }
  assert.match(dashboard, /classic \? UPLOAD_COLOR : 'url\(#dash-series-uploads\)'/)
  assert.match(dashboard, /classic \? DOWNLOAD_COLOR : 'url\(#dash-series-downloads\)'/)
  assert.match(app, /classicDashboard[\s\S]*?classic-dashboard-content/)
  assert.match(app, /neoDashboard=\{modernShell\}/)
})

// PR #388 (stacked on this branch) replaces the Classic Precision visual layer
// with Glossy Enamel. The dedicated-layer contract still holds — it now lives
// in theme-classic.css, and classicPrecision.css is no longer loaded.
test('Classic Light and Dark have a dedicated visual layer (Glossy Enamel supersedes Classic Precision)', () => {
  const main = read('src/main.jsx')
  const css = read('src/theme-classic.css')
  assert.match(main, /import '\.\/theme-classic\.css'/)
  assert.doesNotMatch(main, /import '\.\/classicPrecision\.css'/)
  assert.ok(main.indexOf('theme-classic.css') > main.indexOf('neoLight.css'), 'Classic layer loads after the Neo layers')
  assert.match(css, /:root\[data-ui-style="classic"\]\[data-theme="light"\]/)
  assert.match(css, /:root\[data-ui-style="classic"\]\[data-theme="dark"\]/)
  assert.match(css, /app-sidebar-frame\[data-rail-state="hover"\]/)
  assert.match(css, /positioned-navigation--top/)
  assert.match(css, /positioned-navigation--bottom/)
  assert.match(css, /prefers-reduced-motion: reduce/)
})

test('Classic primary controls keep readable white labels in both themes', () => {
  const css = read('src/classicPrecision.css')
  const actions = [...css.matchAll(/--classic-action: #(\w{6});/g)].map((match) => match[1])
  const luminance = (hex) => {
    const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
  }
  assert.equal(actions.length, 2)
  for (const action of actions) {
    assert.ok(1.05 / (luminance(action) + 0.05) >= 4.5, `white on #${action} must meet AA`)
  }
})
