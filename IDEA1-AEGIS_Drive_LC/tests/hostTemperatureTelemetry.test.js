// tests/hostTemperatureTelemetry.test.js — AEGIS Drive (IDEA1) · CPU temperature
//
// The Drive half of the host package-temperature chain: the contract check on
// the agent's snapshot, the /api/telemetry projection, staleness, and the
// Dashboard tile.
//
// The invariant every case here defends: the Temperature tile shows the CPU
// package or it shows nothing. The host also has a chassis sensor at ~28 °C and
// an SSD SMART temperature at ~40 °C, both real numbers about something else.
// Rendering either as "Temperature" would be a lie the reader cannot detect,
// so each is asserted to be rejected rather than relabelled.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { buildTelemetry } from '../server/telemetry/index.js'
import { APPROVED_TEMPERATURE_SENSORS, validateAgentSnapshot } from '../server/telemetry/schema.js'
import { makeT } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NOW = Date.parse('2026-09-07T10:00:00.000Z')

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

/** A well-formed agent snapshot, with the temperature group overridable. */
const snapshot = (temperature, { measuredAt = '2026-09-07T10:00:00.000Z' } = {}) => ({
  schemaVersion: 1,
  measuredAt,
  metrics: {
    cpu: { available: true, percent: 12.3, windowSeconds: 5 },
    memory: { available: true, usedBytes: 3_000_000_000, totalBytes: 8_000_000_000, percent: 37.5 },
    network: {
      available: true, interface: 'enp1s0',
      rxBytesPerSec: 1024, txBytesPerSec: 512, windowSeconds: 5,
    },
    uptime: { available: true, hostSeconds: 86_400 },
    ...(temperature === undefined ? {} : { temperature }),
  },
})

const build = (temperature, options = {}) => buildTelemetry({
  fetchHost: async () => ({ ok: true, snapshot: snapshot(temperature, options) }),
  disk: async () => ({ available: true, scope: 'datalake', percent: 25 }),
  serviceUptimeSeconds: () => 7200,
  now: options.now ?? NOW,
})

// ── the agent contract ──────────────────────────────────────────────────────

test('TEMP-SCHEMA-1 a valid temperature group is accepted', () => {
  const result = validateAgentSnapshot(snapshot({ available: true, celsius: 55.8, sensor: 'x86_pkg_temp' }), { now: NOW })
  assert.equal(result.ok, true)
})

test('TEMP-SCHEMA-2 temperature is optional, so an older agent still validates', () => {
  // This is what makes Drive deployable before the agent. The reverse ordering
  // is not supported and is documented as a rollout constraint.
  const result = validateAgentSnapshot(snapshot(undefined), { now: NOW })
  assert.equal(result.ok, true, 'a snapshot with no temperature group is a valid V1 snapshot')
})

test('TEMP-SCHEMA-3 optional does not mean lenient', () => {
  const cases = [
    [{ available: true, celsius: 55.8 }, 'metrics.temperature-sensor-not-approved'],
    [{ available: true, sensor: 'x86_pkg_temp' }, 'metrics.temperature-celsius-invalid'],
    [{ available: true, celsius: '55.8', sensor: 'x86_pkg_temp' }, 'metrics.temperature-celsius-invalid'],
    [{ available: true, celsius: Number.NaN, sensor: 'x86_pkg_temp' }, 'metrics.temperature-celsius-invalid'],
    [{ available: true, celsius: -5, sensor: 'x86_pkg_temp' }, 'metrics.temperature-celsius-out-of-range'],
    [{ available: true, celsius: 0, sensor: 'x86_pkg_temp' }, 'metrics.temperature-celsius-out-of-range'],
    [{ available: true, celsius: 55_000, sensor: 'x86_pkg_temp' }, 'metrics.temperature-celsius-out-of-range'],
    [{ available: true, celsius: 55.8, sensor: 'x86_pkg_temp', extra: 1 }, 'metrics.temperature-unexpected-key'],
    [{ available: false, celsius: 55.8 }, 'metrics.temperature-unavailable-with-values'],
    [{ available: 'yes', celsius: 55.8, sensor: 'x86_pkg_temp' }, 'metrics.temperature-available-not-boolean'],
  ]
  for (const [temperature, reason] of cases) {
    const result = validateAgentSnapshot(snapshot(temperature), { now: NOW })
    assert.equal(result.ok, false, `${JSON.stringify(temperature)} must be rejected`)
    assert.equal(result.reason, reason)
  }
})

// ── 14. no SSD (or chassis) temperature substitution ────────────────────────

test('TEMP-SUBST-1 only x86_pkg_temp is an approved sensor', () => {
  assert.deepEqual([...APPROVED_TEMPERATURE_SENSORS], ['x86_pkg_temp'])

  // acpitz (~27.8 °C chassis) and the SSD's SMART reading (~40 °C) are both
  // real measurements of something that is not the CPU package. Drive refuses
  // them at its own boundary, so even a replaced agent cannot get them onto
  // the Temperature tile by simply labelling them differently.
  for (const sensor of ['acpitz', 'nvme', 'ssd', 'iwlwifi_1', 'x86_pkg_temp ', 'X86_PKG_TEMP']) {
    const result = validateAgentSnapshot(snapshot({ available: true, celsius: 40, sensor }), { now: NOW })
    assert.equal(result.ok, false, `sensor ${JSON.stringify(sensor)} must not be accepted`)
    assert.equal(result.reason, 'metrics.temperature-sensor-not-approved')
  }
})

test('TEMP-SUBST-2 the disk metric never supplies the temperature tile', async () => {
  // diskHealth's temperatureCelsius lives on a different contract entirely.
  // If the host agent reports no package sensor, temperature stays unavailable
  // even while the disk metric is perfectly available.
  const response = await build(undefined)
  assert.deepEqual(response.metrics.temperature, { available: false })
  assert.equal(response.metrics.disk.available, true)
})

// ── 10. the /api/telemetry projection ───────────────────────────────────────

test('TEMP-API-1 a valid reading is projected with its sensor name', async () => {
  const response = await build({ available: true, celsius: 55.8, sensor: 'x86_pkg_temp' })
  assert.deepEqual(response.metrics.temperature, {
    available: true, celsius: 55.8, sensor: 'x86_pkg_temp', stale: false,
  })
})

test('TEMP-API-2 an unavailable reading is projected with no number beside it', async () => {
  const response = await build({ available: false })
  assert.deepEqual(response.metrics.temperature, { available: false })
})

test('TEMP-API-3 an unreachable agent leaves temperature unavailable, not zero', async () => {
  const response = await buildTelemetry({
    fetchHost: async () => ({ ok: false, reason: 'unreachable' }),
    disk: async () => ({ available: true, scope: 'datalake', percent: 25 }),
    serviceUptimeSeconds: () => 7200,
    now: NOW,
  })
  assert.deepEqual(response.metrics.temperature, { available: false })
})

test('TEMP-API-4 temperature does not decide the response-level ok flag', async () => {
  // A host with no x86_pkg_temp zone can never report one. Folding it into `ok`
  // would pin the whole dashboard to "degraded" forever on such a machine.
  const withSensor = await build({ available: true, celsius: 55.8, sensor: 'x86_pkg_temp' })
  const without = await build({ available: false })
  assert.equal(withSensor.ok, true)
  assert.equal(without.ok, true, 'a missing package sensor is not a measurement failure of the host')
})

// ── 11. stale propagation ───────────────────────────────────────────────────

test('TEMP-STALE-1 an old snapshot marks the temperature stale but keeps the value', async () => {
  // 40 s > the 15 s threshold. The reading is still true about the moment it
  // names, so it is labelled rather than discarded.
  const response = await build(
    { available: true, celsius: 55.8, sensor: 'x86_pkg_temp' },
    { measuredAt: new Date(NOW - 40_000).toISOString() },
  )
  assert.equal(response.stale, true)
  assert.deepEqual(response.metrics.temperature, {
    available: true, celsius: 55.8, sensor: 'x86_pkg_temp', stale: true,
  })
})

test('TEMP-STALE-2 a fresh snapshot is not stale', async () => {
  const response = await build(
    { available: true, celsius: 55.8, sensor: 'x86_pkg_temp' },
    { measuredAt: new Date(NOW - 3_000).toISOString() },
  )
  assert.equal(response.metrics.temperature.stale, false)
})

// ── 12 & 13. the Dashboard tile ─────────────────────────────────────────────

const tile = (temperature, lang = 'en') => renderToStaticMarkup(
  React.createElement(ServerTelemetry, {
    t: makeT(lang),
    data: { metrics: { temperature } },
  }),
)

/**
 * The Temperature tile's own visible text.
 *
 * Icons are inline SVG whose path data is full of digits ("M12 20v2"), so a
 * "renders no number" assertion against raw markup would pass or fail on
 * artwork. Narrowing to one article and stripping the SVG makes the assertion
 * about what a reader actually sees.
 */
function temperatureTileText(temperature, lang = 'en') {
  const html = tile(temperature, lang)
  const article = html.split('<article').find((chunk) => chunk.includes('lucide-thermometer'))
  assert.ok(article, 'the temperature tile must be rendered at all')
  // The split dropped the opening tag, whose class list is full of digits
  // (`p-4`, `min-w-0`). Restoring it means the tag-stripper removes those too,
  // leaving only what the tile actually renders as text.
  return `<article${article}`.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ')
}

test('TEMP-UI-1 an available reading renders the value and names its sensor', () => {
  const html = tile({ available: true, celsius: 55.8, sensor: 'x86_pkg_temp', stale: false })
  assert.match(html, /55\.8 °C/)
  assert.match(html, /x86_pkg_temp/, 'the sensor is named so the number cannot be mistaken for the SSD')
  assert.match(html, /CPU temperature · Normal/)
})

test('TEMP-UI-2 the tile is labelled in all three languages', () => {
  assert.match(tile({ available: true, celsius: 56, sensor: 'x86_pkg_temp' }, 'th'), /อุณหภูมิ CPU/)
  assert.match(tile({ available: true, celsius: 56, sensor: 'x86_pkg_temp' }, 'zh'), /CPU 温度/)
})

test('TEMP-UI-3 an unavailable tile states the failure and renders no number', () => {
  const html = tile({ available: false })
  assert.match(html, /CPU temperature · Unavailable/)
  assert.doesNotMatch(temperatureTileText({ available: false }), /°C/, 'an unmeasurable temperature must never render a degree value')
  const text = temperatureTileText({ available: false })
  assert.doesNotMatch(text, /[0-9]/, 'and must never fall back to zero or any other number')
  assert.match(text, /No telemetry source connected/)
  assert.match(html, /hatch/, 'a failed source is hatched, the same as every other failed tile')
})

test('TEMP-UI-4 a missing temperature group renders unavailable, not blank', () => {
  // This is the old-agent case: Drive is new, the agent is not, so the group
  // is simply absent from the response.
  const html = tile(undefined)
  assert.match(html, /CPU temperature · Unavailable/)
  assert.doesNotMatch(html, /°C/)
})

test('TEMP-UI-5 a stale reading stays on screen and says so', () => {
  const html = tile({ available: true, celsius: 55.8, sensor: 'x86_pkg_temp', stale: true })
  assert.match(html, /CPU temperature · Stale/)
  assert.match(html, /55\.8 °C/, 'stale data is labelled, not blanked — blanking loses information')
})

test('TEMP-UI-6 absolute thresholds colour the tile, since it has no percentage', () => {
  const state = (celsius) => {
    const html = tile({ available: true, celsius, sensor: 'x86_pkg_temp', stale: false })
    return /CPU temperature · (\w+)/.exec(html)?.[1]
  }
  assert.equal(state(55.8), 'Normal')   // the production reading
  assert.equal(state(79.9), 'Normal')
  assert.equal(state(80), 'Warning')
  assert.equal(state(89.9), 'Warning')
  assert.equal(state(90), 'Critical')
})
