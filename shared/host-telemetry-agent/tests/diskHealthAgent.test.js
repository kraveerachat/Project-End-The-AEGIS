// tests/diskHealthAgent.test.js — AEGIS host telemetry agent · /internal/disk-health
//
// The agent republishes the collector's evidence file as a separate versioned
// route. These tests pin: the V1 telemetry snapshot is untouched by the new
// read; the file is validated as untrusted input; and the wire body is rebuilt
// from the allowlist, so nothing the collector did not agree to publish leaks.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createSampler } from '../src/sampler.js'
import { DISK_HEALTH_ROUTE, TELEMETRY_ROUTE, createTelemetryServer } from '../src/server.js'
import {
  AGENT_DISK_REASONS, diskHealthFromFileText, projectDiskHealth, validateDiskHealthEvidence,
} from '../src/diskHealth.js'

const PROC_STAT = 'cpu  100 0 100 800 0 0 0 0 0 0\n'
const MEMINFO = 'MemTotal:       8000000 kB\nMemAvailable:   4000000 kB\n'
const NOW = Date.parse('2026-09-03T02:00:00.000Z')

const validEvidence = (overrides = {}) => ({
  schemaVersion: 1,
  measuredAt: '2026-09-03T01:55:00.000Z',
  device: 'sda',
  disk: {
    available: true,
    model: 'AEGIS-FIXTURE M.2 2280 128GB',
    smart: { supported: true, enabled: true, passed: true },
    temperatureCelsius: 38,
    powerOnHours: 3210,
    capacityBytes: 128035676160,
    warnings: [],
    ...overrides,
  },
})

function readersWith(diskText) {
  return {
    procStat: async () => PROC_STAT,
    memInfo: async () => MEMINFO,
    networkRx: async () => '1000',
    networkTx: async () => '2000',
    uptime: async () => '100.00 0.00',
    ...(diskText === undefined ? {} : { diskHealth: async () => diskText }),
  }
}

test('DISKAGENT-1 the V1 telemetry snapshot shape is unchanged by the disk-health read', async () => {
  const sampler = createSampler({ interfaceName: 'enp1s0', readers: readersWith(JSON.stringify(validEvidence())), now: () => NOW })
  const snapshot = await sampler.sampleOnce()
  assert.deepEqual(Object.keys(snapshot).sort(), ['measuredAt', 'metrics', 'schemaVersion'])
  assert.deepEqual(Object.keys(snapshot.metrics).sort(), ['cpu', 'memory', 'network', 'uptime'])
  assert.equal('disk' in snapshot.metrics, false, 'a new metric group would break every deployed Drive V1 validator')
})

test('DISKAGENT-2 valid evidence is kept verbatim and available on the sampler', async () => {
  const sampler = createSampler({ interfaceName: 'enp1s0', readers: readersWith(JSON.stringify(validEvidence())), now: () => NOW })
  assert.equal(sampler.diskHealth(), null, 'nothing before the first cycle')
  await sampler.sampleOnce()
  assert.deepEqual(sampler.diskHealth(), validEvidence())
})

test('DISKAGENT-3 no configured file answers not-configured; a missing file answers collector-not-run', async () => {
  const none = createSampler({ interfaceName: 'enp1s0', readers: readersWith(undefined), now: () => NOW })
  await none.sampleOnce()
  assert.deepEqual(none.diskHealth().disk, { available: false, reason: AGENT_DISK_REASONS.NOT_CONFIGURED })
  assert.equal(none.diskHealth().device, null)

  const missing = createSampler({ interfaceName: 'enp1s0', readers: readersWith(null), now: () => NOW })
  await missing.sampleOnce()
  assert.deepEqual(missing.diskHealth().disk, { available: false, reason: AGENT_DISK_REASONS.NO_EVIDENCE })
  assert.equal(missing.diskHealth().measuredAt, new Date(NOW).toISOString())
})

test('DISKAGENT-4 a corrupt or off-contract file is invalid-evidence, never forwarded', () => {
  const opts = { now: () => NOW }
  assert.equal(diskHealthFromFileText('{not json', opts).disk.reason, AGENT_DISK_REASONS.INVALID)
  assert.equal(diskHealthFromFileText(JSON.stringify({ ...validEvidence(), extra: 1 }), opts).disk.reason, AGENT_DISK_REASONS.INVALID)
  assert.equal(diskHealthFromFileText(JSON.stringify({ ...validEvidence(), schemaVersion: 2 }), opts).disk.reason, AGENT_DISK_REASONS.INVALID)
  assert.equal(diskHealthFromFileText(JSON.stringify(validEvidence({ serial: 'leak' })), opts).disk.reason, AGENT_DISK_REASONS.INVALID)
  assert.equal(diskHealthFromFileText(JSON.stringify(validEvidence({ temperatureCelsius: -5 })), opts).disk.reason, AGENT_DISK_REASONS.INVALID)
  assert.equal(diskHealthFromFileText(JSON.stringify(validEvidence({ warnings: ['made-up'] })), opts).disk.reason, AGENT_DISK_REASONS.INVALID)
  assert.equal(diskHealthFromFileText(JSON.stringify({ ...validEvidence(), device: '/dev/sda' }), opts).disk.reason, AGENT_DISK_REASONS.INVALID)
})

test('DISKAGENT-5 validation: unavailable is exactly { available:false, reason } and nulls are legal', () => {
  assert.equal(validateDiskHealthEvidence({ ...validEvidence(), disk: { available: false, reason: 'smartctl-absent' } }).ok, true)
  assert.equal(validateDiskHealthEvidence({ ...validEvidence(), disk: { available: false, reason: 'smartctl-absent', temperatureCelsius: 0 } }).reason, 'disk-unavailable-with-values')
  assert.equal(validateDiskHealthEvidence({ ...validEvidence(), disk: { available: false } }).reason, 'disk-unavailable-with-values')
  assert.equal(validateDiskHealthEvidence(validEvidence({ temperatureCelsius: null, powerOnHours: null, model: null })).ok, true)
  assert.equal(validateDiskHealthEvidence(validEvidence({ smart: { supported: true, enabled: true, passed: 'PASSED' } })).reason, 'disk-smart-invalid')
})

test('DISKAGENT-6 projection rebuilds the body from the allowlist only', () => {
  const evidence = validEvidence()
  evidence.disk.serialNumber = 'must-not-cross' // cannot happen after validation, but projection must not rely on that
  const body = projectDiskHealth(evidence)
  assert.deepEqual(Object.keys(body).sort(), ['device', 'disk', 'measuredAt', 'schemaVersion'])
  assert.deepEqual(Object.keys(body.disk).sort(), ['available', 'capacityBytes', 'model', 'powerOnHours', 'smart', 'temperatureCelsius', 'warnings'])
  assert.equal(JSON.stringify(body).includes('must-not-cross'), false)
  assert.deepEqual(projectDiskHealth({ ...evidence, disk: { available: false, reason: 'smartctl-absent' } }).disk, { available: false, reason: 'smartctl-absent' })
})

// ── the route itself, over a real listener ────────────────────────────
const IS_WINDOWS = process.platform === 'win32'
const socketPathFor = (tag) => IS_WINDOWS
  ? `\\\\.\\pipe\\aegis-disk-health-test-${process.pid}-${tag}`
  : path.join(os.tmpdir(), `aegis-disk-health-test-${process.pid}-${tag}.sock`)

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

test('DISKAGENT-7 GET /internal/disk-health serves the projected evidence with no-store', async () => {
  const sampler = createSampler({ interfaceName: 'enp1s0', readers: readersWith(JSON.stringify(validEvidence())), now: () => NOW })
  await sampler.sampleOnce()
  const socketPath = socketPathFor('route')
  const server = createTelemetryServer({ sampler, socketPath })
  await server.start()
  try {
    const res = await get(socketPath, DISK_HEALTH_ROUTE)
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.deepEqual(res.body, projectDiskHealth(validEvidence()))
    // The V1 route is byte-for-byte the same contract it was.
    const v1 = await get(socketPath, TELEMETRY_ROUTE)
    assert.equal(v1.status, 200)
    assert.deepEqual(Object.keys(v1.body.metrics).sort(), ['cpu', 'memory', 'network', 'uptime'])
    // No third route appeared.
    assert.equal((await get(socketPath, '/internal/disk')).status, 404)
  } finally {
    await server.stop()
  }
})

test('DISKAGENT-8 before the first cycle the disk-health route says no-sample-yet, not healthy', async () => {
  const sampler = createSampler({ interfaceName: 'enp1s0', readers: readersWith(JSON.stringify(validEvidence())), now: () => NOW })
  const socketPath = socketPathFor('nosample')
  const server = createTelemetryServer({ sampler, socketPath })
  await server.start()
  try {
    const res = await get(socketPath, DISK_HEALTH_ROUTE)
    assert.equal(res.status, 503)
    assert.deepEqual(res.body, { error: 'no-sample-yet' })
  } finally {
    await server.stop()
  }
})
