// tests/twingateAgent.test.js — AEGIS host telemetry agent · /internal/twingate-connector
//
// The agent republishes the Twingate collector's evidence file as a THIRD
// versioned route. These tests pin: the V1 telemetry snapshot and the
// disk-health route are untouched by the new read; the file is validated as
// untrusted input; and the wire body is rebuilt from the allowlist, so nothing
// the collector did not agree to publish can leak through.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createSampler } from '../src/sampler.js'
import {
  DISK_HEALTH_ROUTE, TELEMETRY_ROUTE, TWINGATE_CONNECTOR_ROUTE, createTelemetryServer,
} from '../src/server.js'
import {
  AGENT_TWINGATE_REASONS, TWINGATE_CONNECTOR_KEYS,
  projectTwingateHealth, twingateHealthFromFileText, validateTwingateEvidence,
} from '../src/twingateHealth.js'

const PROC_STAT = 'cpu  100 0 100 800 0 0 0 0 0 0\n'
const MEMINFO = 'MemTotal:       8000000 kB\nMemAvailable:   4000000 kB\n'
const NOW = Date.parse('2026-09-05T10:00:00.000Z')

const validEvidence = (overrides = {}) => ({
  schemaVersion: 1,
  measuredAt: '2026-09-05T09:59:30.000Z',
  connector: {
    available: true,
    runtimeState: 'RUNNING',
    health: 'HEALTHY',
    restartCount: 0,
    startedAt: '2026-09-01T08:30:00.000Z',
    ...overrides,
  },
})

function readersWith(twingateText, { includeDisk = false } = {}) {
  return {
    procStat: async () => PROC_STAT,
    memInfo: async () => MEMINFO,
    networkRx: async () => '1000',
    networkTx: async () => '2000',
    uptime: async () => '100.00 0.00',
    ...(includeDisk ? { diskHealth: async () => null } : {}),
    ...(twingateText === undefined ? {} : { twingateHealth: async () => twingateText }),
  }
}

// ── The existing contracts must not move ─────────────────────────────────────

test('TWAGENT-1 the V1 telemetry snapshot shape is unchanged by the connector read', async () => {
  const sampler = createSampler({
    interfaceName: 'enp1s0',
    readers: readersWith(JSON.stringify(validEvidence())),
    now: () => NOW,
  })
  const snapshot = await sampler.sampleOnce()
  assert.deepEqual(Object.keys(snapshot).sort(), ['measuredAt', 'metrics', 'schemaVersion'])
  assert.deepEqual(Object.keys(snapshot.metrics).sort(), ['cpu', 'memory', 'network', 'uptime'])
  assert.equal('twingate' in snapshot.metrics, false, 'a new metric group would break every deployed Drive V1 validator')
  assert.equal('connector' in snapshot, false)
})

// ── Reading the evidence file ────────────────────────────────────────────────

test('TWAGENT-2 an unconfigured, empty, or corrupt file each get their own reason', () => {
  const at = () => NOW
  assert.equal(
    twingateHealthFromFileText(null, { now: at, configured: false }).connector.reason,
    AGENT_TWINGATE_REASONS.NOT_CONFIGURED,
  )
  assert.equal(
    twingateHealthFromFileText(null, { now: at }).connector.reason,
    AGENT_TWINGATE_REASONS.NO_EVIDENCE,
  )
  assert.equal(
    twingateHealthFromFileText('   ', { now: at }).connector.reason,
    AGENT_TWINGATE_REASONS.NO_EVIDENCE,
  )
  assert.equal(
    twingateHealthFromFileText('{ not json', { now: at }).connector.reason,
    AGENT_TWINGATE_REASONS.INVALID,
  )
})

test('TWAGENT-3 a valid file round-trips unchanged', () => {
  const evidence = twingateHealthFromFileText(JSON.stringify(validEvidence()), { now: () => NOW })
  assert.deepEqual(evidence, validEvidence())
})

test('TWAGENT-4 malformed evidence degrades to invalid-evidence rather than being forwarded', () => {
  const rejected = [
    ['wrong schema version', { ...validEvidence(), schemaVersion: 2 }],
    ['malformed measuredAt', { ...validEvidence(), measuredAt: 'yesterday' }],
    ['unexpected top-level key', { ...validEvidence(), hostname: 'aegis-edge' }],
    ['runtime state outside the enum', validEvidence({ runtimeState: 'TELEPORTING' })],
    ['health outside the enum', validEvidence({ health: 'EXCELLENT' })],
    ['negative restart count', validEvidence({ restartCount: -1 })],
    ['fractional restart count', validEvidence({ restartCount: 1.5 })],
    ['restart count as a string', validEvidence({ restartCount: '3' })],
    ['malformed startedAt', validEvidence({ startedAt: 'soon' })],
    ['an extra connector key', validEvidence({ containerId: 'e3b0c442' })],
  ]
  for (const [label, doc] of rejected) {
    assert.equal(validateTwingateEvidence(doc).ok, false, label)
    assert.equal(
      twingateHealthFromFileText(JSON.stringify(doc), { now: () => NOW }).connector.reason,
      AGENT_TWINGATE_REASONS.INVALID,
      label,
    )
  }
})

test('TWAGENT-5 unavailable evidence may not carry a reading alongside its reason', () => {
  const withValue = {
    schemaVersion: 1,
    measuredAt: '2026-09-05T09:59:30.000Z',
    connector: { available: false, reason: 'connector-not-found', runtimeState: 'RUNNING' },
  }
  assert.equal(validateTwingateEvidence(withValue).ok, false)
  assert.equal(validateTwingateEvidence({
    schemaVersion: 1,
    measuredAt: '2026-09-05T09:59:30.000Z',
    connector: { available: false, reason: 'Not A Fixed Enum!' },
  }).ok, false)
})

// ── Projection ───────────────────────────────────────────────────────────────

test('TWAGENT-6 the wire body is rebuilt from the allowlist only', () => {
  // A key that somehow reached the in-memory document must not be copied out.
  const smuggled = validEvidence()
  smuggled.connector.containerId = 'e3b0c44298fc1c149afbf4c8996fb924'
  smuggled.connector.env = ['TWINGATE_ACCESS_TOKEN=secret']

  const body = projectTwingateHealth(smuggled)
  assert.deepEqual(Object.keys(body).sort(), ['connector', 'measuredAt', 'schemaVersion'])
  assert.deepEqual(Object.keys(body.connector).sort(), [...TWINGATE_CONNECTOR_KEYS].sort())
  const serialized = JSON.stringify(body)
  assert.equal(serialized.includes('TWINGATE_ACCESS_TOKEN'), false)
  assert.equal(serialized.includes('e3b0c442'), false)
})

// ── The route, over a real listener ──────────────────────────────────────────

const IS_WINDOWS = process.platform === 'win32'
const socketPathFor = (tag) => IS_WINDOWS
  ? `\\\\.\\pipe\\aegis-twingate-test-${process.pid}-${tag}`
  : path.join(os.tmpdir(), `aegis-twingate-test-${process.pid}-${tag}.sock`)

function get(socketPath, route) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method: 'GET' }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('TWAGENT-7 GET /internal/twingate-connector serves the projected evidence with no-store', async () => {
  const sampler = createSampler({
    interfaceName: 'enp1s0',
    readers: readersWith(JSON.stringify(validEvidence()), { includeDisk: true }),
    now: () => NOW,
  })
  await sampler.sampleOnce()
  const socketPath = socketPathFor('route')
  const server = createTelemetryServer({ sampler, socketPath })
  await server.start()
  try {
    const res = await get(socketPath, TWINGATE_CONNECTOR_ROUTE)
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.deepEqual(res.body.connector, {
      available: true, runtimeState: 'RUNNING', health: 'HEALTHY', restartCount: 0,
      startedAt: '2026-09-01T08:30:00.000Z',
    })

    // The other two routes still answer, and still answer their own shape.
    const v1 = await get(socketPath, TELEMETRY_ROUTE)
    assert.equal(v1.status, 200)
    assert.deepEqual(Object.keys(v1.body).sort(), ['measuredAt', 'metrics', 'schemaVersion'])
    const disk = await get(socketPath, DISK_HEALTH_ROUTE)
    assert.equal(disk.status, 200)
    assert.deepEqual(Object.keys(disk.body).sort(), ['device', 'disk', 'measuredAt', 'schemaVersion'])

    // A near-miss path is still a 404; the route set did not become a prefix match.
    assert.equal((await get(socketPath, '/internal/twingate')).status, 404)
    assert.equal((await get(socketPath, '/internal/twingate-connector/env')).status, 404)
  } finally {
    await server.stop()
  }
})

test('TWAGENT-8 an unconfigured connector file answers not-configured, not a fabricated state', async () => {
  const sampler = createSampler({
    interfaceName: 'enp1s0',
    readers: readersWith(undefined), // no twingateHealth reader at all
    now: () => NOW,
  })
  await sampler.sampleOnce()
  const socketPath = socketPathFor('unconfigured')
  const server = createTelemetryServer({ sampler, socketPath })
  await server.start()
  try {
    const res = await get(socketPath, TWINGATE_CONNECTOR_ROUTE)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.connector, { available: false, reason: 'not-configured' })
  } finally {
    await server.stop()
  }
})

test('TWAGENT-9 the route answers 503 before the first sampling cycle', async () => {
  const sampler = createSampler({ interfaceName: 'enp1s0', readers: readersWith(null), now: () => NOW })
  const socketPath = socketPathFor('nosample')
  const server = createTelemetryServer({ sampler, socketPath })
  await server.start()
  try {
    const res = await get(socketPath, TWINGATE_CONNECTOR_ROUTE)
    assert.equal(res.status, 503)
    assert.deepEqual(res.body, { error: 'no-sample-yet' })
  } finally {
    await server.stop()
  }
})
