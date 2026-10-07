import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8')
const dashboard = read('src/screens/Dashboard.jsx')
const telemetry = read('src/components/ServerTelemetry.jsx')
const dashCss = read('src/neoDashboard.css')
const overlayCss = read('src/neoOverlays.css')
const uploadPanel = read('src/components/UploadEntryPanel.jsx')
const main = read('src/main.jsx')

const selectorsOf = (css) => (css.match(/^[^@/\s{}][^{}]*\{/gm) ?? [])
  .map((s) => s.trim())
  .filter((s) => !/^(from|to|\d+%)\b/.test(s))

test('REF-KPI the top row renders the four real metrics and no sparkline', () => {
  const row = dashboard.slice(dashboard.indexOf('className="dashboard-kpi-row"'), dashboard.indexOf('className="dashboard-analytics-grid"'))
  for (const accent of ['storage', 'files', 'shares', 'security']) {
    assert.match(row, new RegExp(`accent="${accent}"`), `${accent} KPI present`)
  }
  assert.match(row, /value=\{m\.files\}/)
  assert.match(row, /value=\{m\.activeShares\}/)
  assert.match(row, /value=\{d\.securityAlerts\}/)
  assert.match(row, /alarm=\{!dashboardUnavailable && d\.securityAlerts > 0\}/, 'security semantics unchanged')
  assert.doesNotMatch(dashboard, /Sparkline|LineChart|AreaChart/, 'no trend graphics invented for the KPI row')
})

test('REF-TRUTH unknown values stay unknown; the data layer is untouched', () => {
  assert.match(dashboard, /valueLabel=\{storageKnown \? fmtBytes\(storageUsed\) : '—'\}/)
  assert.match(dashboard, /valueLabel=\{dashboardUnavailable \? '—' : undefined\}/)
  assert.match(dashboard, /normalizeDashboardData\(dashboardUnavailable \? null : dash\.data\)/)
  // Telemetry still refuses to render a fabricated zero.
  assert.match(telemetry, /const number = \(value\) => typeof value === 'number' && Number\.isFinite\(value\)/)
  assert.match(telemetry, /if \(!number\(value\)\) return null/)
  assert.match(telemetry, /data-state=\{state\}/)
  // The activity chart keeps its real bar semantic.
  assert.match(dashboard, /<BarChart data=\{rows\}/)
  assert.match(dashboard, /dataKey="uploads"[\s\S]*dataKey="downloads"/)
})

test('REF-SCOPE reference colour and overlay glass are Dark Neo only', () => {
  assert.match(main, /import '\.\/neoDashboard\.css'\s+import '\.\/neoOverlays\.css'/)
  for (const selector of selectorsOf(overlayCss)) {
    assert.match(selector, /:root\[data-ui-style="neo"\]\[data-theme="dark"\]/, `overlay rule not Dark-scoped: ${selector}`)
  }
  for (const selector of selectorsOf(dashCss)) {
    assert.match(selector, /:root\[data-ui-style="neo"\]/, `dashboard rule not Neo-scoped: ${selector}`)
    assert.doesNotMatch(selector, /data-theme="light"/)
  }
  // Reference colour/light (literal hex/rgba) is Dark-scoped. A both-theme
  // rule may only colour through the existing theme tokens (var(--…)).
  const blocks = dashCss.match(/[^{}]+\{[^{}]*\}/g) ?? []
  for (const block of blocks) {
    const selector = block.slice(0, block.indexOf('{'))
    if (/data-theme="dark"/.test(selector)) continue
    const colourDecls = block.match(/(?:^|;|\{)\s*(?:background[\w-]*|box-shadow|text-shadow|filter|color|border-color)\s*:[^;}]*/g) ?? []
    for (const decl of colourDecls) {
      assert.doesNotMatch(decl, /#[0-9a-f]{3,8}\b|rgba?\(/i, `literal colour leaks into Light: ${selector.trim()} → ${decl.trim()}`)
    }
  }
})

test('REF-OVERLAY upload sheet, tray and menus share one overlay family', () => {
  for (const hook of ['upload-entry-panel', 'upload-entry-scrim', 'upload-entry-dropzone', 'upload-entry-choose', 'upload-entry-hint']) {
    assert.match(uploadPanel, new RegExp(hook), `${hook} hook present`)
    assert.match(overlayCss, new RegExp(`\\.${hook}`), `${hook} styled`)
  }
  assert.match(uploadPanel, /data-drag-over=\{dragOver \? 'true' : undefined\}/)
  assert.doesNotMatch(uploadPanel, /border-l-2/, 'no side-stripe hint')
  assert.match(overlayCss, /\[data-upload-tray\] \{/)
  assert.match(overlayCss, /\[data-upload-tray-launcher\] \{/)
  assert.match(overlayCss, /\[data-upload-row\]\[data-upload-stage="complete"\] \{[\s\S]*?animation: neo-upload-complete 900ms ease-out both/)
  assert.match(overlayCss, /:is\(\.anchored-menu, \.quick-actions-menu\) \{/)
  assert.match(overlayCss, /:is\(\.neo-profile-menu, \.neo-search-menu\) \{/)
  // Progress colour follows the stage; width stays the measured inline value.
  assert.doesNotMatch(overlayCss, /\[role="progressbar"\] > div \{[^}]*width/)
  assert.doesNotMatch(overlayCss, /@keyframes[^{]*\{[^}]*width/)
  assert.match(overlayCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: fade-in 120ms linear both !important/)
})

test('REF-FOCUS controls keep their own radius under keyboard focus', () => {
  const layer = read('src/neoDarkApp.css')
  assert.match(layer, /:focus-visible \{\s*border-radius: revert-layer;/)
})

test('REF-390 the activity data table stays for assistive tech but cannot widen the page', () => {
  assert.match(dashboard, /<table className="sr-only">/)
  assert.match(dashCss, /\.dashboard-activity-card table\.sr-only \{[\s\S]*?display: block;[\s\S]*?max-width: 1px;[\s\S]*?overflow: hidden;/)
})

test('POLISH-DASH resources split into usage vs runtime groups, same six tiles in order', () => {
  assert.match(telemetry, /\{ id: 'usage', labelKey: 'telemetryGroupUsage', ids: \['cpu', 'memory', 'disk'\] \}/)
  assert.match(telemetry, /\{ id: 'state', labelKey: 'telemetryGroupState', ids: \['network', 'uptime', 'temperature'\] \}/)
  const strings = read('src/lib/strings.js')
  assert.equal((strings.match(/telemetryGroupUsage:/g) ?? []).length, 3, 'EN/TH/ZH parity')
  assert.equal((strings.match(/telemetryGroupState:/g) ?? []).length, 3, 'EN/TH/ZH parity')
})

test('POLISH-DASH active shares sit in the ops row; sign-in history spans the bottom row', () => {
  const ops = dashboard.slice(dashboard.indexOf('className="dashboard-ops-grid"'), dashboard.indexOf('className="dashboard-links-row"'))
  const bottom = dashboard.slice(dashboard.indexOf('className="dashboard-links-row"'))
  assert.match(ops, /<ActiveLinksCard /)
  assert.match(bottom, /<LoginHistoryCard /)
})

test('POLISH-DASH Data Lake state colour comes only from the real probe tone', () => {
  assert.match(dashboard, /const TIER_ICONS = \{ application: Server, metadata: Database, storage: HardDrive \}/)
  assert.match(dashboard, /<span className="lake-tier-icon" data-tone=\{tone\} aria-hidden>/)
  for (const tone of ['ok', 'warn', 'danger', 'neutral']) {
    assert.ok(dashCss.includes(`.lake-tier-icon[data-tone="${tone}"]`), `${tone} tone styled`)
  }
  // The storage KPI meter is the same real ratio as its number.
  assert.match(dashboard, /aria-valuenow=\{storagePct\}/)
  assert.match(dashboard, /<span style=\{\{ width: `\$\{storagePct\}%` \}\} \/>/)
})

test('POLISH-OVERLAY header actions, selection bar, select triggers and drop overlay join the family', () => {
  const quick = read('src/components/DashboardQuickActions.jsx')
  assert.match(quick, /className="header-action-icon"/)
  assert.match(dashCss, /\.header-action-button:focus-visible \{[\s\S]*?border-radius: 14px;/)
  const bar = read('src/components/SelectionActionBar.jsx')
  assert.match(bar, /selection-action-bar/)
  assert.match(bar, /data-danger=\{danger \? 'true' : undefined\}/)
  for (const hook of ['.selection-action-bar', '.vault-transfer-panel', '[data-neo-drop-overlay]']) {
    assert.ok(overlayCss.includes(hook), `${hook} styled`)
  }
  assert.match(overlayCss, /\.authenticated-shell select,[\s\S]*?background-image: url\("data:image\/svg\+xml/)
})
