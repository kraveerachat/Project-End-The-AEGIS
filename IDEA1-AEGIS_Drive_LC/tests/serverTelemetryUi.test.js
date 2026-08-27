// tests/serverTelemetryUi.test.js — AEGIS Drive (IDEA1) · Server Telemetry tiles
//
// The tiles now render the real /api/telemetry contract. The rule that shaped
// the original placeholder version survives intact and is the point of most of
// these tests: a metric that could not be measured says so, and never renders
// as 0 — a fabricated zero is indistinguishable from a real idle reading.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { LANGS, makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let vite
let ServerTelemetry

before(async () => {
  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
  })
  ;({ ServerTelemetry } = await vite.ssrLoadModule('/src/components/ServerTelemetry.jsx'))
})

after(async () => {
  await vite?.close()
})

/** A complete, healthy /api/telemetry response. */
const telemetry = (overrides = {}) => ({
  schemaVersion: 1,
  measuredAt: '2026-08-27T10:00:00.000Z',
  ok: true,
  stale: false,
  maxAgeSeconds: 15,
  metrics: {
    cpu: { available: true, percent: 37.4, windowSeconds: 5, stale: false },
    memory: {
      available: true, usedBytes: 3_150_000_000, totalBytes: 8_333_651_968,
      percent: 37.8, stale: false,
    },
    disk: {
      available: true, scope: 'datalake',
      usedBytes: 15_470_845_952, freeBytes: 45_604_417_536, totalBytes: 61_075_263_488,
      percent: 25.3, health: { available: false, reason: 'smart-not-observable' },
    },
    network: {
      available: true, interface: 'enp1s0',
      rxBytesPerSec: 2_411_724, txBytesPerSec: 524_288, windowSeconds: 5, stale: false,
    },
    twingate: { available: false, scope: 'server-connector', status: 'unavailable', reason: 'no-approved-source' },
    uptime: {
      available: true,
      host: { available: true, seconds: 950_400, stale: false },
      service: { available: true, seconds: 7_200 },
    },
    ...overrides,
  },
})

const render = (data, lang = 'en', extra = {}) =>
  renderToStaticMarkup(React.createElement(ServerTelemetry, { t: makeT(lang), data, ...extra }))

// ── TELEM-UI-11 · the first paint ──────────────────────────────────────
// "Not yet measured" and "could not be measured" are different facts, and the
// component's whole reason for existing is refusing to blur that line. Before
// the first response lands there is nothing to report either way, so the tiles
// must not accuse a source that has not been asked yet.
test('TELEM-UI-11 tiles say loading, not unavailable, before the first response', () => {
  const html = render(null, 'en', { loading: true })
  assert.equal((html.match(/aria-label="[^"]+ · Loading"/g) ?? []).length, 6)
  assert.doesNotMatch(html, /· Unavailable"/)
  assert.doesNotMatch(
    html, /No telemetry source connected/,
    'claiming there is no source is a different assertion from "not read yet"',
  )
  // The loading state is still not permission to invent a number.
  assert.doesNotMatch(html, /0(?:\.0+)?\s*(?:%|GB|B\/s)/)
})

test('TELEM-UI-11 a finished load with no data still reports unavailable', () => {
  // loading:false + data:null is a real failure, and must keep saying so.
  const html = render(null, 'en', { loading: false })
  assert.equal((html.match(/aria-label="[^"]+ · Unavailable"/g) ?? []).length, 6)
})

test('TELEM-UI-11 loading never overrides a metric that already has a value', () => {
  // A refresh in flight over data already on screen must not blank the tiles.
  const html = render(telemetry(), 'en', { loading: true })
  assert.match(html, /37%/, 'the CPU reading already on screen must survive a refresh')
  assert.match(html, /2\.9 GB \/ 7\.8 GB/, 'so must memory')
  assert.doesNotMatch(html, /· Loading"/)
})

// ── TELEM-UI-12 · role no longer changes what these tiles show ────────
// Product decision 2026-08-27: every authenticated Drive user receives the
// approved host telemetry, so the normal response now renders identically for
// a DataLake-User and an Admin. There is no role prop and never was — the
// component renders the response it is handed — which is precisely why this
// test asserts against the response an authenticated non-admin actually gets
// from the server today (see tests/telemetryApi.test.js, TELEM-API-11).
test('TELEM-UI-12 an authenticated user sees real CPU, RAM, network, and host uptime', () => {
  const html = render(telemetry())

  assert.match(html, /CPU · Normal/)
  assert.match(html, /RAM · Normal/)
  assert.match(html, /Network · Normal/)
  assert.match(html, /System uptime · Normal/)

  // The readings themselves, not just the chips.
  assert.match(html, /37%/)               // CPU
  assert.match(html, /2\.9 GB \/ 7\.8 GB/)  // RAM
  assert.match(html, /2\.3 MB\/s/)         // network rx
  assert.match(html, /enp1s0/)            // the approved interface
  assert.match(html, /11d 0h/)            // host uptime
  assert.match(html, /2h 00m/)            // Drive service uptime
})

test('TELEM-UI-12 the normal response shows no restricted state for any tile', () => {
  const html = render(telemetry())

  // The screen must no longer tell an ordinary user that a measured value is
  // being kept from them, because it is not.
  assert.doesNotMatch(html, /· Restricted/)
  assert.doesNotMatch(html, /Requires an Admin role/)
  assert.doesNotMatch(html, /requires-admin/)
})

// The restricted rendering itself is kept as a defensive contract, not as a
// description of the current API: nothing in /api/telemetry emits
// `requires-admin` any more. If a future policy withholds some metric again,
// the tile must still say "not shown to your account" rather than the untrue
// "could not be measured" — that distinction is the component's whole purpose,
// so it stays covered even though the server no longer exercises it.
test('TELEM-UI-12 a withheld metric would still be distinguished from an unmeasurable one', () => {
  const html = render(telemetry({
    cpu: { available: false, reason: 'requires-admin' },
    memory: { available: false },
  }))

  assert.match(html, /CPU · Restricted/)
  assert.match(html, /Requires an Admin role/)
  // The unmeasurable one keeps its own, different story.
  assert.match(html, /RAM · Unavailable/)
  assert.match(html, /No telemetry source connected/)
})

// ── the pre-existing contract, unchanged ──────────────────────────────
test('Server Telemetry renders six truthful unavailable metric cards', () => {
  const html = render(null)
  for (const label of ['CPU', 'RAM', 'Disk', 'Network', 'Twingate', 'System uptime']) {
    assert.match(html, new RegExp(`>${label}<`), `${label} card must be visible`)
  }
  assert.equal((html.match(/aria-label="[^"]+ · Unavailable"/g) ?? []).length, 6)
  assert.doesNotMatch(html, /0(?:\.0+)?\s*(?:%|°C|ms|Mbps|Kbps|GB)/)
})

test('telemetry state is conveyed with accessible text and not colour alone', () => {
  const html = render(telemetry({ cpu: { available: true, percent: 82, windowSeconds: 5, stale: false } }))
  assert.match(html, />Warning</)
  assert.match(html, /82%/)
})

// ── TELEM-UI-1 · CPU ──────────────────────────────────────────────────
test('TELEM-UI-1 real CPU usage renders', () => {
  const html = render(telemetry())
  assert.match(html, /37%/)
  assert.match(html, />Normal</)
})

// ── TELEM-UI-2 · memory ───────────────────────────────────────────────
test('TELEM-UI-2 real memory renders as used of total', () => {
  const html = render(telemetry())
  assert.match(html, /38%/)          // 37.8 rounded
  assert.match(html, /2\.9 GB/)      // 3_150_000_000 bytes
  assert.match(html, /7\.8 GB/)      // 8_333_651_968 bytes
})

// ── TELEM-UI-3 · Data Lake disk ───────────────────────────────────────
test('TELEM-UI-3 real Data Lake disk renders and claims no physical health', () => {
  const html = render(telemetry())
  assert.match(html, /25%/)
  assert.match(html, /14\.4 GB/)     // used
  assert.match(html, /56\.9 GB/)     // total
  // SMART is not observable from this container; the tile must not imply it is.
  assert.doesNotMatch(html, /Healthy|>OK<|Good/)
})

// ── TELEM-UI-4 · network ──────────────────────────────────────────────
test('TELEM-UI-4 network throughput renders in both directions', () => {
  const html = render(telemetry())
  assert.match(html, /2\.3 MB\/s/)   // rx
  assert.match(html, /512 KB\/s/)    // tx — fmtBytes drops the decimal at >= 100
  assert.match(html, /enp1s0/)
})

// ── TELEM-UI-5 · uptime ───────────────────────────────────────────────
test('TELEM-UI-5 host uptime renders distinctly from Drive service uptime', () => {
  const html = render(telemetry())
  assert.match(html, /Host/)
  assert.match(html, /Drive service/)
  assert.match(html, /11d 0h/)       // host: 950_400s
  assert.match(html, /2h 00m/)       // service: 7_200s
  // The two must never be presented as one number.
  assert.notEqual(html.indexOf('11d 0h'), html.indexOf('2h 00m'))
})

test('TELEM-UI-5 Drive service uptime survives a dead host agent', () => {
  const html = render(telemetry({
    uptime: {
      available: true,
      host: { available: false },
      service: { available: true, seconds: 7_200 },
    },
  }))
  assert.match(html, /2h 00m/)
  assert.match(html, /No data/, 'the host half must say so rather than borrow the service value')
})

// ── TELEM-UI-6 · Twingate ─────────────────────────────────────────────
test('TELEM-UI-6 Twingate is truthfully unavailable, never implied online', () => {
  const html = render(telemetry())
  assert.match(html, /Twingate · Unavailable/)
  assert.doesNotMatch(html, /Connected|Online|Reachable/)
})

// ── TELEM-UI-7 · partial failure ──────────────────────────────────────
test('TELEM-UI-7 one failed metric does not blank the metrics that worked', () => {
  const html = render(telemetry({
    cpu: { available: false },
    network: { available: false },
  }))
  assert.match(html, /CPU · Unavailable/)
  assert.match(html, /Network · Unavailable/)
  // Memory and disk were measured and must still be shown.
  assert.match(html, /38%/)
  assert.match(html, /25%/)
  assert.match(html, /14\.4 GB/)
})

// ── TELEM-UI-8 · no fabricated zero ───────────────────────────────────
test('TELEM-UI-8 an unavailable metric never renders a fabricated zero', () => {
  const html = render(telemetry({
    cpu: { available: false },
    memory: { available: false },
    disk: {
      available: false, reason: 'capacity-unreadable', scope: 'datalake',
      health: { available: false, reason: 'smart-not-observable' },
    },
    network: { available: false },
    uptime: { available: true, host: { available: false }, service: { available: true, seconds: 7_200 } },
  }))
  // Nothing may render as a zero measurement of any unit.
  assert.doesNotMatch(html, /\b0(?:\.0+)?\s*(?:%|B|KB|MB|GB|TB)\b/)
  assert.doesNotMatch(html, /\b0(?:\.0+)?\s*[KMGT]?B\/s/)
  assert.equal((html.match(/· Unavailable"/g) ?? []).length >= 5, true)
})

// ── TELEM-UI-9 · staleness ────────────────────────────────────────────
test('TELEM-UI-9 stale host metrics are visibly distinguishable from fresh ones', () => {
  const fresh = render(telemetry())
  const stale = render({
    ...telemetry(),
    stale: true,
    ok: false,
    metrics: {
      ...telemetry().metrics,
      cpu: { available: true, percent: 37.4, windowSeconds: 5, stale: true },
      memory: {
        available: true, usedBytes: 3_150_000_000, totalBytes: 8_333_651_968,
        percent: 37.8, stale: true,
      },
    },
  })

  assert.doesNotMatch(fresh, />Stale</)
  assert.match(stale, />Stale</)
  // Stale data is still shown, labelled — not blanked and not replaced by 0.
  assert.match(stale, /37%/)
  // A Drive-local metric measured just now must not inherit the host's age.
  assert.match(stale, /25%/)
  assert.equal((stale.match(/>Stale</g) ?? []).length, 2, 'only the stale metrics are labelled')
})

// ── TELEM-UI-13 · Twingate stays truthful ─────────────────────────────
// Widening host-metric visibility did not connect a Twingate source. The tile
// must never read Online, Connected, or Reachable while none exists.
test('TELEM-UI-13 the Twingate tile claims no connection for any authenticated user', () => {
  const html = render(telemetry())

  assert.match(html, /Twingate · Unavailable/)
  assert.match(html, /No telemetry source connected/)
  for (const claim of [/>Online</, />Connected</, />Reachable</]) {
    assert.doesNotMatch(html, claim, 'no approved connector source exists')
  }
})

// ── TELEM-UI-10 · localization ────────────────────────────────────────
test('TELEM-UI-10 every telemetry string resolves in all three languages', () => {
  for (const lang of LANGS) {
    for (const data of [null, telemetry(), telemetry({ cpu: { available: false } })]) {
      const html = render(data, lang)
      assert.doesNotMatch(html, /\[\[/, `${lang} must not render a missing-key marker`)
      assert.doesNotMatch(html, /undefined/, `${lang} must not render undefined`)
    }
  }
  // The Thai and Chinese tiles must carry their own copy, not the English one.
  assert.match(render(telemetry(), 'th'), /ดิสก์/)
  assert.match(render(telemetry(), 'zh'), /磁盘/)
})
