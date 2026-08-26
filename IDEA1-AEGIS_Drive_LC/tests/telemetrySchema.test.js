// tests/telemetrySchema.test.js — AEGIS Drive (IDEA1) · host agent contract
//
// The agent runs as a different user, outside the container, under a different
// release cycle. Drive therefore treats its output as untrusted input and
// validates it structurally before a single number reaches a screen.
//
// The rule throughout is fail-closed: anything that does not match returns a
// reason, never a partially-repaired snapshot. A metric Drive cannot prove is
// unavailable, and unavailable never renders as 0.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STALE_THRESHOLD_SECONDS, ageSeconds, isStale, validateAgentSnapshot,
} from '../server/telemetry/schema.js'

const NOW = Date.parse('2026-08-27T10:00:00.000Z')
const MEASURED_AT = '2026-08-27T09:59:58.000Z'

const validSnapshot = (overrides = {}) => ({
  schemaVersion: 1,
  measuredAt: MEASURED_AT,
  metrics: {
    cpu: { available: true, percent: 12.3, windowSeconds: 5 },
    memory: { available: true, usedBytes: 3_150_000_000, totalBytes: 8_333_651_968, percent: 37.8 },
    network: {
      available: true, interface: 'enp1s0',
      rxBytesPerSec: 1024, txBytesPerSec: 512, windowSeconds: 5,
    },
    uptime: { available: true, hostSeconds: 86_400.55 },
  },
  ...overrides,
})

const accept = (raw) => {
  const result = validateAgentSnapshot(raw, { now: NOW })
  assert.equal(result.ok, true, `expected accept, got reason ${result.reason}`)
  return result.snapshot
}

const reject = (raw, label) => {
  const result = validateAgentSnapshot(raw, { now: NOW })
  assert.equal(result.ok, false, `${label} must be rejected`)
  assert.equal(typeof result.reason, 'string')
  assert.equal(result.snapshot, undefined, `${label} must not yield a repaired snapshot`)
}

test('a well-formed snapshot is accepted unchanged', () => {
  const snapshot = accept(validSnapshot())
  assert.equal(snapshot.metrics.cpu.percent, 12.3)
  assert.equal(snapshot.metrics.network.interface, 'enp1s0')
  assert.equal(snapshot.measuredAt, MEASURED_AT)
})

test('every metric may independently declare itself unavailable', () => {
  const snapshot = accept(validSnapshot({
    metrics: {
      cpu: { available: false },
      memory: { available: false },
      network: { available: false },
      uptime: { available: true, hostSeconds: 10 },
    },
  }))
  assert.equal(snapshot.metrics.cpu.available, false)
  assert.equal(snapshot.metrics.cpu.percent, undefined, 'unavailable must carry no number')
  assert.equal(snapshot.metrics.uptime.hostSeconds, 10)
})

test('an unknown schemaVersion is refused rather than best-effort parsed', () => {
  for (const version of [0, 2, '1', null, undefined, 1.5]) {
    reject(validSnapshot({ schemaVersion: version }), `schemaVersion ${JSON.stringify(version)}`)
  }
})

test('missing required structural keys are refused', () => {
  reject(undefined, 'undefined body')
  reject(null, 'null body')
  reject('{}', 'string body')
  reject([], 'array body')
  reject({ schemaVersion: 1, metrics: validSnapshot().metrics }, 'no measuredAt')
  reject({ schemaVersion: 1, measuredAt: MEASURED_AT }, 'no metrics')
  for (const missing of ['cpu', 'memory', 'network', 'uptime']) {
    const metrics = { ...validSnapshot().metrics }
    delete metrics[missing]
    reject(validSnapshot({ metrics }), `missing metrics.${missing}`)
  }
})

test('TELEM-11E extra keys are refused, never silently carried through', () => {
  reject(validSnapshot({ hostname: 'aegis-server' }), 'extra top-level key')
  reject(
    validSnapshot({ metrics: { ...validSnapshot().metrics, docker: { containers: 7 } } }),
    'extra metric group',
  )
  const metrics = validSnapshot().metrics
  reject(
    validSnapshot({ metrics: { ...metrics, cpu: { ...metrics.cpu, model: 'Intel(R)' } } }),
    'extra key inside a metric',
  )
  reject(
    validSnapshot({ metrics: { ...metrics, network: { ...metrics.network, macAddress: 'aa:bb:cc:dd:ee:ff' } } }),
    'MAC address smuggled into network',
  )
  reject(
    validSnapshot({ metrics: { ...metrics, cpu: { available: false, percent: 0 } } }),
    'unavailable metric carrying a value',
  )
})

test('NaN, Infinity, and non-numeric values are refused', () => {
  const metrics = validSnapshot().metrics
  for (const bad of [NaN, Infinity, -Infinity, '12.3', null, {}]) {
    reject(
      validSnapshot({ metrics: { ...metrics, cpu: { available: true, percent: bad, windowSeconds: 5 } } }),
      `cpu percent ${String(bad)}`,
    )
  }
})

test('percent outside 0..100 is refused for cpu and memory', () => {
  const metrics = validSnapshot().metrics
  for (const bad of [-0.1, 100.1, 1000]) {
    reject(
      validSnapshot({ metrics: { ...metrics, cpu: { available: true, percent: bad, windowSeconds: 5 } } }),
      `cpu percent ${bad}`,
    )
    reject(
      validSnapshot({
        metrics: {
          ...metrics,
          memory: { available: true, usedBytes: 1, totalBytes: 2, percent: bad },
        },
      }),
      `memory percent ${bad}`,
    )
  }
})

test('negative byte counts and impossible memory totals are refused', () => {
  const metrics = validSnapshot().metrics
  reject(
    validSnapshot({ metrics: { ...metrics, memory: { available: true, usedBytes: -1, totalBytes: 2, percent: 50 } } }),
    'negative usedBytes',
  )
  reject(
    validSnapshot({ metrics: { ...metrics, memory: { available: true, usedBytes: 3, totalBytes: 2, percent: 50 } } }),
    'used exceeding total',
  )
  reject(
    validSnapshot({ metrics: { ...metrics, memory: { available: true, usedBytes: 0, totalBytes: 0, percent: 0 } } }),
    'zero-sized memory',
  )
  reject(
    validSnapshot({
      metrics: {
        ...metrics,
        network: { available: true, interface: 'enp1s0', rxBytesPerSec: -1, txBytesPerSec: 0, windowSeconds: 5 },
      },
    }),
    'negative rx rate',
  )
})

test('a non-positive measurement window and a negative uptime are refused', () => {
  const metrics = validSnapshot().metrics
  for (const bad of [0, -5]) {
    reject(
      validSnapshot({ metrics: { ...metrics, cpu: { available: true, percent: 10, windowSeconds: bad } } }),
      `cpu windowSeconds ${bad}`,
    )
  }
  reject(
    validSnapshot({ metrics: { ...metrics, uptime: { available: true, hostSeconds: -1 } } }),
    'negative uptime',
  )
})

test('TELEM-11G the interface name is validated, not accepted as free text', () => {
  const metrics = validSnapshot().metrics
  const withInterface = (value) => validSnapshot({
    metrics: {
      ...metrics,
      network: { available: true, interface: value, rxBytesPerSec: 1, txBytesPerSec: 1, windowSeconds: 5 },
    },
  })
  reject(withInterface(''), 'empty interface')
  reject(withInterface('../../etc/passwd'), 'path-shaped interface')
  reject(withInterface(42), 'non-string interface')
  reject(withInterface('a'.repeat(64)), 'over-long interface')
  accept(withInterface('enp1s0'))
})

test('a malformed or future-dated measurement timestamp is refused', () => {
  reject(validSnapshot({ measuredAt: 'yesterday' }), 'unparseable timestamp')
  reject(validSnapshot({ measuredAt: '' }), 'empty timestamp')
  reject(validSnapshot({ measuredAt: 1_756_288_798_000 }), 'epoch number instead of ISO')
  reject(validSnapshot({ measuredAt: '2026-13-45T99:99:99Z' }), 'impossible calendar date')
  // A small skew is tolerated because the agent and Drive keep separate clocks.
  accept(validSnapshot({ measuredAt: new Date(NOW + 1_000).toISOString() }))
  reject(validSnapshot({ measuredAt: new Date(NOW + 60_000).toISOString() }), 'a minute in the future')
})

// ── TELEM-8 · staleness ───────────────────────────────────────────────
test('TELEM-8 a measurement older than 15 seconds is stale', () => {
  assert.equal(STALE_THRESHOLD_SECONDS, 15)

  assert.equal(ageSeconds('2026-08-27T09:59:58.000Z', NOW), 2)
  assert.equal(isStale('2026-08-27T09:59:58.000Z', NOW), false)
  assert.equal(isStale('2026-08-27T09:59:45.000Z', NOW), false, 'exactly 15s is not yet stale')
  assert.equal(isStale('2026-08-27T09:59:44.900Z', NOW), true)
  assert.equal(isStale('2026-08-27T09:00:00.000Z', NOW), true)
})

test('TELEM-8 staleness is reported, not used to discard the data', () => {
  // Validation and staleness are separate decisions on purpose: a stale
  // snapshot is still true about the moment it names, so Drive shows it and
  // labels it rather than replacing it with a fabricated blank.
  const old = validSnapshot({ measuredAt: '2026-08-27T09:00:00.000Z' })
  const result = validateAgentSnapshot(old, { now: NOW })
  assert.equal(result.ok, true, 'age alone must not fail validation')
  assert.equal(isStale(result.snapshot.measuredAt, NOW), true)
})
