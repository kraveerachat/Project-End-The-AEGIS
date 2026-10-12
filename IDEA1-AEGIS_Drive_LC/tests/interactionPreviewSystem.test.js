import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { makeT } from '../src/lib/strings.js'
import {
  sharePreview, loginPreview, recentFilePreview, telemetryPreview, storageCategoryPreview,
  capacityPreview, shareScopeChip,
} from '../src/lib/previewContent.js'

// Contracts for the shared interaction pass: Secure Shares column repair,
// the hover/focus preview system and its safety rules, and style scoping.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => fs.readFileSync(path.join(rootDir, name), 'utf8')
const t = makeT('en')
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)

test('IX-SHARES-1 Active links: one six-track template shared by header and rows', () => {
  const shares = read('src/screens/Shares.jsx')
  const css = read('src/interactionSystem.css')
  assert.match(shares, /className="share-table" role="table"/)
  assert.equal((shares.match(/role="columnheader"/g) ?? []).length, 6)
  for (const cell of ['file', 'scope', 'auth', 'expires', 'hits', 'action']) {
    assert.match(shares, new RegExp(`role="cell" className="share-cell share-cell--${cell}"`), `${cell} cell`)
  }
  const cols = /--share-cols:\s*([^;]+);/.exec(css)?.[1] ?? ''
  const tracks = cols.match(/minmax\([^)]*\)|\S+/g)
  assert.equal(tracks.length, 6, `six tracks: ${cols}`)
  // File is the only flexible track; Scope/Auth/Expires/Hits/Action are fixed
  // so a long Scope label cannot move the columns after it.
  assert.match(tracks[0], /^minmax\(\d+px, 1fr\)$/)
  for (const fixed of tracks.slice(1)) assert.match(fixed, /^\d+px$/)
  assert.match(css, /\.share-table-head,\s*\.share-row \{\s*display: grid;\s*grid-template-columns: var\(--share-cols\);/)
  // No fixed min-width + horizontal scroll: narrow containers reflow instead.
  assert.doesNotMatch(shares, /min-w-\[720px\]/)
  assert.match(css, /@container share-table \(max-width: \d+px\)/)
})

test('IX-SHARES-2 the scope badge is confined to its own track and cannot overlap Auth', () => {
  const css = read('src/interactionSystem.css')
  assert.match(css, /\.share-cell \{\s*display: flex;\s*min-width: 0;/)
  assert.match(css, /\.share-scope-badge \{[^}]*max-width: 100%;[^}]*white-space: nowrap;/)
  assert.match(css, /\.share-scope-label \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/)
  // A truncated label still exposes its full text.
  assert.match(read('src/screens/Shares.jsx'), /className="share-scope-badge" data-tone=\{scopeChip\.tone\} title=\{scopeLabel\}/)
  // Public must never fall back to the AEGIS-reachable label.
  assert.equal(shareScopeChip('public').key, 'chipPublicInternet')
  assert.equal(shareScopeChip('unknown-scope').key, 'chipAnyNetwork')
})

test('IX-SHARES-3 Revoke keeps its confirm step, names the file and cannot double-fire', () => {
  const shares = read('src/screens/Shares.jsx')
  assert.match(shares, /onClick=\{\(\) => onAskRevoke\(link\)\}/)
  assert.match(shares, /disabled=\{revoking\}/)
  assert.match(shares, /aria-label=\{`\$\{t\('revoke'\)\} · \$\{link\.fileName\}`\}/)
  assert.match(shares, /<Btn variant="danger" className="flex-1" onClick=\{confirmRevoke\}>/)
  // Unknown hit counts render as unknown, not as 0.
  assert.match(shares, /\{hitsKnown \? link\.hits : '—'\}/)
})

test('IX-PREVIEW-1 share previews never carry credentials, hashes or tokens', () => {
  const share = {
    id: '7', fileName: 'START_LIVE.mp4', scope: 'public', authType: 'password', hits: 1,
    expiresAt: NOW + 54 * 60_000 + 42_000, hasPassword: true,
    password: 'hunter2-SECRET', password_hash: '$2a$10$SECRETHASH', token: 'tok-SECRET', token_hash: 'th-SECRET',
    scopeCidrs: ['10.0.0.0/8'],
  }
  const preview = sharePreview(t, share, NOW)
  const text = JSON.stringify(preview)
  for (const secret of ['hunter2-SECRET', 'SECRETHASH', 'tok-SECRET', 'th-SECRET', '10.0.0.0/8']) {
    assert.ok(!text.includes(secret), `preview must not contain ${secret}`)
  }
  assert.equal(preview.title, 'START_LIVE.mp4')
  assert.equal(preview.status.label, 'PUBLIC INTERNET')
  assert.deepEqual(preview.rows.map((row) => row.value), ['Password', '54m 42s', '1'])
})

test('IX-PREVIEW-2 login previews show only the visible row fields', () => {
  const preview = loginPreview(t, { at: new Date(NOW - 120_000).toISOString(), result: 'DENIED', source_ip: '10.1.2.3', target_hash: 'abc123HASH', actor_label: 'someone' }, NOW)
  const text = JSON.stringify(preview)
  assert.ok(!text.includes('abc123HASH'))
  assert.equal(preview.status.tone, 'danger')
  assert.ok(preview.rows.some((row) => row.value === '10.1.2.3'))
})

test('IX-PREVIEW-3 unknown values stay unknown — never a fabricated zero', () => {
  const na = t('telemetryValueUnavailable')
  const unavailable = telemetryPreview(t, { id: 'cpu', label: 'CPU', metric: { available: false, reason: 'no-source' }, stateLabel: 'Unavailable', tone: 'neutral' })
  assert.equal(unavailable.rows.length, 0)
  const partial = telemetryPreview(t, { id: 'memory', label: 'RAM', metric: { available: true }, stateLabel: 'Normal', tone: 'ok' })
  assert.deepEqual(partial.rows.map((row) => row.value), [na, na])
  const network = telemetryPreview(t, { id: 'network', label: 'Network', metric: { available: true, rxBytesPerSec: 2048 }, stateLabel: 'Normal', tone: 'ok' })
  assert.deepEqual(network.rows.map((row) => row.value), ['2.0 KB/s', na, na])
  // Recent files carry no size: the preview must not invent one.
  const file = recentFilePreview(t, { id: 1, name: 'IMG_3207.JPG', modified: NOW - 3_600_000 }, NOW)
  assert.equal(file.rows.some((row) => row.label === t('previewSize')), false)
  assert.equal(file.rows[0].value, 'JPG')
  assert.equal(storageCategoryPreview(t, { key: 'media', bytes: null, accounted: 10 }), null)
  assert.equal(capacityPreview(t, { usedBytes: null, totalBytes: 100 }), null)
})

test('IX-PREVIEW-4 HoverPreview opens after a stable mouse hover, ignores touch, closes on Escape', async () => {
  const vite = await createServer({
    configFile: false,
    root: rootDir,
    cacheDir: path.join(rootDir, 'node_modules/.vite-ix-preview-test'),
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
  })
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })
  const prev = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT }
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const win = dom.window
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const pointer = (el, type, pointerType) => {
    const event = new win.MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 })
    Object.defineProperty(event, 'pointerType', { value: pointerType })
    el.dispatchEvent(event)
  }
  try {
    const { HoverPreview } = await vite.ssrLoadModule('/src/components/HoverPreview.jsx')
    const preview = { kind: 'share', title: 'START_LIVE.mp4', rows: [{ label: 'Access', value: 'Password' }] }
    const root = createRoot(win.document.getElementById('root'))
    await act(async () => {
      root.render(React.createElement(HoverPreview, { preview, tabIndex: 0, className: 'row' }, 'row'))
    })
    const row = win.document.querySelector('.row')
    const tooltip = () => win.document.querySelector('[role="tooltip"]')

    // Touch never opens it.
    await act(async () => { pointer(row, 'pointerover', 'touch') })
    await act(async () => { await wait(380) })
    assert.equal(tooltip(), null)

    // Mouse: not instantly, then after the hover delay.
    await act(async () => { pointer(row, 'pointerover', 'mouse') })
    assert.equal(tooltip(), null)
    await act(async () => { await wait(380) })
    assert.ok(tooltip(), 'opens after a stable hover')
    assert.equal(row.getAttribute('aria-describedby'), tooltip().id)
    assert.match(tooltip().textContent, /START_LIVE\.mp4/)

    // Escape closes it.
    await act(async () => { win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(tooltip(), null)
    assert.equal(row.hasAttribute('aria-describedby'), false)
    await act(async () => { root.unmount() })
  } finally {
    globalThis.window = prev.window
    globalThis.document = prev.document
    globalThis.IS_REACT_ACT_ENVIRONMENT = prev.act
    win.close()
    await vite.close()
  }
})

test('IX-SCOPE-1 Neo materials stay in the Neo block; Classic §8 has no glow, blur or bloom', () => {
  const shared = read('src/interactionSystem.css')
  const neoStart = shared.indexOf(':root[data-ui-style="neo"] {')
  assert.ok(neoStart > 0)
  for (const glassy of ['backdrop-filter', 'drop-shadow(0 0']) {
    let at = shared.indexOf(glassy)
    while (at !== -1) {
      assert.ok(at > neoStart, `${glassy} at ${at} must live inside the Neo block`)
      at = shared.indexOf(glassy, at + 1)
    }
  }
  // Classic tokens never appear in the shared/Neo file.
  assert.doesNotMatch(shared, /var\(--(?:mat-|acc\b|led-|raised)/)
  const classic = read('src/theme-classic.css')
  const section = classic.slice(classic.indexOf('/* ── 8. Interaction language'))
  assert.ok(section.length > 200)
  assert.match(section, /^[\s\S]*?:root\[data-ui-style="classic"\] \{/)
  assert.doesNotMatch(section, /backdrop-filter|drop-shadow|blur\(/)
  // Hover lifts use `translate` so they cannot fight the transform-based entrance.
  assert.match(section, /\.dashboard-stat-card:is\(:hover, \[data-preview-open="true"\]\) \{\s*--elev-1: var\(--classic-lift-shadow\);\s*translate: 0 -2px;/)
})

test('IX-MOTION-1 reduced motion and coarse pointers are respected', () => {
  const shared = read('src/interactionSystem.css')
  const classic = read('src/theme-classic.css')
  const component = read('src/components/HoverPreview.jsx')
  assert.match(shared, /@media \(prefers-reduced-motion: reduce\) \{\s*\.hover-preview,/)
  assert.match(classic.slice(classic.indexOf('/* ── 8. Interaction language')), /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(shared, /@media \(hover: none\), \(pointer: coarse\)/)
  assert.match(component, /if \(event\.pointerType !== 'mouse'\) return/)
  // The security alarm pulses twice, then rests — never an infinite alert.
  assert.match(shared, /\.alarm-attention \{\s*animation: border-pulse 2\.4s var\(--ease, ease\) 2;/)
  for (const screen of ['src/screens/Dashboard.jsx', 'src/screens/ClassicDashboard.jsx']) {
    assert.doesNotMatch(read(screen), /'border-pulse'/)
  }
})

test('IX-SELECT-1 Secure Shares filters stay on the shared custom listbox (no raw <select>)', () => {
  const shares = read('src/screens/Shares.jsx')
  const filters = shares.slice(shares.indexOf('className="share-filters'), shares.indexOf('className="share-table"'))
  assert.equal((filters.match(/<PillSelect /g) ?? []).length, 2)
  assert.doesNotMatch(filters, /<select\b/)
  assert.match(read('src/components/ui.jsx'), /if \(neo \|\| classic\) return <NeoSelect/)
})
