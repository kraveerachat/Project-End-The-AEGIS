// tests/thermal.test.js — AEGIS host telemetry agent · CPU package temperature
//
// The property under test throughout: the agent publishes the x86_pkg_temp
// reading or it publishes nothing. Every "close enough" answer — the chassis
// sensor, another zone, a stale-looking zero — is a wrong number that would
// render on the dashboard with the authority of a measured one, so each of
// those paths is asserted to produce `{ available: false }` instead.
import test from 'node:test'
import assert from 'node:assert/strict'

import { createAgent } from '../src/agent.js'
import {
  MAX_CELSIUS, MIN_CELSIUS, TARGET_SENSOR, THERMAL_ROOT,
  celsiusFromMilliDegrees, parseSensorType, readHostTemperature,
} from '../src/thermal.js'

const UNAVAILABLE = { available: false }

/**
 * Build a fake /sys/class/thermal from a zone map.
 *
 * `zones` maps entry name -> { type, temp }. A value of `null` for either file
 * means "this read throws", which is how EACCES and a hotplugged-away zone both
 * present themselves at this boundary.
 */
function fakeThermal(zones, { extraEntries = [] } = {}) {
  const opened = []
  return {
    opened,
    readdir: async (root) => {
      assert.equal(root, THERMAL_ROOT, 'the root must never be anything but the fixed constant')
      return [...Object.keys(zones), ...extraEntries]
    },
    readFile: async (filePath) => {
      opened.push(filePath)
      const match = /^\/sys\/class\/thermal\/([^/]+)\/(type|temp)$/.exec(filePath)
      assert.ok(match, `refused: ${filePath} is outside the permitted two-file surface`)
      const value = zones[match[1]]?.[match[2]]
      if (value === null || value === undefined) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return value
    },
  }
}

const read = (fake) => readHostTemperature({ readdir: fake.readdir, readFile: fake.readFile })

// ── 1. selection is by sensor name, not by zone number ──────────────────────

test('x86_pkg_temp is selected even when it is not thermal_zone1', async () => {
  // Zone 4 here: the whole reason discovery exists is that the kernel makes no
  // promise about the number, so a passing test must not use the lucky one.
  const fake = fakeThermal({
    thermal_zone0: { type: 'acpitz', temp: '27800' },
    thermal_zone4: { type: 'x86_pkg_temp', temp: '55812' },
  })
  assert.deepEqual(await read(fake), { available: true, celsius: 55.8, sensor: TARGET_SENSOR })
})

// ── 2. directory order must not decide the answer ───────────────────────────

test('a different thermal zone ordering yields the same reading', async () => {
  const first = await read(fakeThermal({
    thermal_zone0: { type: 'x86_pkg_temp', temp: '56000' },
    thermal_zone1: { type: 'acpitz', temp: '27800' },
  }))
  const second = await read(fakeThermal({
    thermal_zone1: { type: 'acpitz', temp: '27800' },
    thermal_zone0: { type: 'x86_pkg_temp', temp: '56000' },
  }))
  assert.deepEqual(first, { available: true, celsius: 56, sensor: TARGET_SENSOR })
  assert.deepEqual(second, first, 'listing order must not change a measurement')
})

// ── 3. the chassis sensor is never a substitute ─────────────────────────────

test('acpitz is ignored when x86_pkg_temp exists, and its temp is never even read', async () => {
  const fake = fakeThermal({
    thermal_zone0: { type: 'acpitz', temp: '27800' },
    thermal_zone1: { type: 'x86_pkg_temp', temp: '55900' },
  })
  const result = await read(fake)
  assert.equal(result.celsius, 55.9)
  assert.equal(result.celsius === 27.8, false, 'the ~28 °C chassis reading must never surface as the CPU')
  // A non-target zone costs exactly one read: its `type`. Reading its `temp`
  // would be a wasted syscall and a larger surface for no gain.
  assert.deepEqual(fake.opened, [
    '/sys/class/thermal/thermal_zone0/type',
    '/sys/class/thermal/thermal_zone1/type',
    '/sys/class/thermal/thermal_zone1/temp',
  ])
})

// ── 4. absence is unavailable, not a fallback ───────────────────────────────

test('no x86_pkg_temp zone means unavailable, never the warmest zone', async () => {
  const fake = fakeThermal({
    thermal_zone0: { type: 'acpitz', temp: '27800' },
    thermal_zone1: { type: 'iwlwifi_1', temp: '44000' },
  })
  assert.deepEqual(await read(fake), UNAVAILABLE)
})

test('an empty /sys/class/thermal is unavailable', async () => {
  assert.deepEqual(await read(fakeThermal({})), UNAVAILABLE)
})

test('an unreadable /sys/class/thermal is unavailable, not a crash', async () => {
  const result = await readHostTemperature({
    readdir: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
    readFile: async () => { throw new Error('must not be reached') },
  })
  assert.deepEqual(result, UNAVAILABLE)
})

// ── 5. an unreadable `type` skips that zone only ────────────────────────────

test('an unreadable type is skipped, and the real target is still found', async () => {
  const fake = fakeThermal({
    thermal_zone0: { type: null, temp: '99000' },
    thermal_zone1: { type: 'x86_pkg_temp', temp: '55000' },
  })
  assert.deepEqual(await read(fake), { available: true, celsius: 55, sensor: TARGET_SENSOR })
})

test('an unreadable type is unavailable when no valid target remains', async () => {
  const fake = fakeThermal({
    thermal_zone0: { type: null, temp: '99000' },
    thermal_zone1: { type: 'acpitz', temp: '27800' },
  })
  assert.deepEqual(await read(fake), UNAVAILABLE)
})

// ── 6. an unreadable `temp` on the target is unavailable ────────────────────

test('an unreadable temp on the target zone is unavailable', async () => {
  const fake = fakeThermal({ thermal_zone1: { type: 'x86_pkg_temp', temp: null } })
  assert.deepEqual(await read(fake), UNAVAILABLE)
})

// ── 7. malformed temperatures never become numbers ──────────────────────────

test('every malformed temp shape is rejected rather than repaired', async () => {
  for (const temp of [
    '',            // empty
    '   ',         // whitespace only
    'abc',         // non-numeric
    'NaN',
    'Infinity',
    '-Infinity',
    '55.8',        // the kernel writes integers; a float here is not this file
    '1e5',         // exponent notation is not a kernel millidegree value
    '-1000',       // negative
    '0',           // 0 °C: below the plausibility floor, and the classic placeholder
    '56',          // degrees mistaken for millidegrees -> 0.056 °C
    '55000000',    // malformed millidegrees -> 55000 °C
    '151000',      // above the plausibility ceiling
  ]) {
    const fake = fakeThermal({ thermal_zone1: { type: 'x86_pkg_temp', temp } })
    assert.deepEqual(await read(fake), UNAVAILABLE, `temp ${JSON.stringify(temp)} must not produce a reading`)
  }
})

test('the plausibility band is inclusive at both ends', () => {
  assert.equal(celsiusFromMilliDegrees(`${MIN_CELSIUS * 1000}`), MIN_CELSIUS)
  assert.equal(celsiusFromMilliDegrees(`${MAX_CELSIUS * 1000}`), MAX_CELSIUS)
  assert.equal(celsiusFromMilliDegrees(`${MIN_CELSIUS * 1000 - 1}`), null)
  assert.equal(celsiusFromMilliDegrees(`${MAX_CELSIUS * 1000 + 1}`), null)
})

// ── 8. millidegree conversion ───────────────────────────────────────────────

test('millidegrees convert to degrees and round to one decimal', () => {
  assert.equal(celsiusFromMilliDegrees('55812'), 55.8)
  assert.equal(celsiusFromMilliDegrees('56000'), 56)
  assert.equal(celsiusFromMilliDegrees('27800'), 27.8)
  assert.equal(celsiusFromMilliDegrees('55850'), 55.9) // rounds, not truncates
  assert.equal(celsiusFromMilliDegrees(' 55812\n'), 55.8) // sysfs trailing newline
})

test('a sensor type is bounded, trimmed, and never path- or markup-shaped', () => {
  assert.equal(parseSensorType('x86_pkg_temp\n'), 'x86_pkg_temp')
  assert.equal(parseSensorType('  acpitz  '), 'acpitz')
  assert.equal(parseSensorType(''), null)
  assert.equal(parseSensorType('../../etc/passwd'), null)
  assert.equal(parseSensorType('<script>x</script>'), null)
  assert.equal(parseSensorType('a'.repeat(33)), null)
  assert.equal(parseSensorType(Buffer.from('x86_pkg_temp')), null) // not a string
})

// ── the read surface itself ─────────────────────────────────────────────────

test('only thermal_zone[0-9]+ entries are ever opened', async () => {
  const fake = fakeThermal(
    { thermal_zone2: { type: 'x86_pkg_temp', temp: '55000' } },
    { extraEntries: ['cooling_device0', 'thermal_zoneX', '..', 'policy', 'thermal_zone'] },
  )
  await read(fake)
  // fakeThermal's readFile asserts the shape of every path it is handed, so a
  // stray entry would have thrown above. This pins the exact resulting set.
  assert.deepEqual(fake.opened, [
    '/sys/class/thermal/thermal_zone2/type',
    '/sys/class/thermal/thermal_zone2/temp',
  ])
})

// ── 9. the assembled agent's published snapshot ─────────────────────────────

test('the agent publishes temperature inside the V1 metrics snapshot', async () => {
  const agent = createAgent({
    env: { AEGIS_TELEMETRY_INTERFACE: 'enp1s0' },
    readFile: async (filePath) => {
      if (filePath.endsWith('/type')) return 'x86_pkg_temp'
      if (filePath.endsWith('/temp')) return '55812'
      return '0'
    },
    readdir: async () => ['thermal_zone0'],
  })
  const snapshot = await agent.sampler.sampleOnce()

  assert.deepEqual(Object.keys(snapshot.metrics), ['cpu', 'memory', 'network', 'uptime', 'temperature'])
  assert.deepEqual(snapshot.metrics.temperature, {
    available: true, celsius: 55.8, sensor: 'x86_pkg_temp',
  })
  assert.equal(snapshot.schemaVersion, 1, 'temperature is an addition to V1, not a new version')
})

test('a host with no package sensor still publishes a complete snapshot', async () => {
  const agent = createAgent({
    env: { AEGIS_TELEMETRY_INTERFACE: 'enp1s0' },
    readFile: async (filePath) => (filePath.endsWith('/type') ? 'acpitz' : '0'),
    readdir: async () => ['thermal_zone0'],
  })
  const snapshot = await agent.sampler.sampleOnce()
  // Exactly one key. An unavailable metric carrying a number is the failure the
  // whole contract exists to prevent.
  assert.deepEqual(snapshot.metrics.temperature, { available: false })
})

test('a thermal reader that throws degrades one metric, not the cycle', async () => {
  const agent = createAgent({
    env: { AEGIS_TELEMETRY_INTERFACE: 'enp1s0' },
    readFile: async () => '0',
    readdir: async () => { throw new Error('boom') },
  })
  const snapshot = await agent.sampler.sampleOnce()
  assert.deepEqual(snapshot.metrics.temperature, { available: false })
  assert.ok(snapshot.measuredAt, 'the snapshot is still published and still timestamped')
})
