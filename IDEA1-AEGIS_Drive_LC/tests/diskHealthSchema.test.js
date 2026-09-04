// tests/diskHealthSchema.test.js — AEGIS Drive (IDEA1) · host disk-health contract + status rules
//
// The agent's /internal/disk-health body is untrusted input. These tests pin
// the fail-closed validator and the deterministic status derivation against
// the same smartctl fixtures the collector is tested with, so a rule cannot
// drift between the two sides of the socket.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DISK_STALE_THRESHOLD_SECONDS, DISK_STATUS, deriveDiskStatus, validateDiskHealthResponse,
} from '../server/telemetry/diskHealthSchema.js'
import { hostDiskHealth } from '../server/telemetry/diskHealth.js'
import { evidenceFromSmartctl } from '../../shared/host-telemetry-agent/collectors/smart.js'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'host-telemetry-agent', 'tests', 'fixtures')
const fixture = async (name) => JSON.parse(await fs.readFile(path.join(FIXTURES, name), 'utf8'))
const NOW = Date.parse('2026-09-03T02:00:00.000Z')

const document = (disk, { ageSeconds = 120, device = 'sda' } = {}) => ({
  schemaVersion: 1,
  measuredAt: new Date(NOW - ageSeconds * 1000).toISOString(),
  device,
  disk,
})
const healthyDisk = () => ({
  available: true, model: 'AEGIS-FIXTURE M.2 2280 128GB', smart: { supported: true, enabled: true, passed: true },
  temperatureCelsius: 38, powerOnHours: 3210, capacityBytes: 128035676160, warnings: [],
})

test('DISK-SCHEMA-1 a valid document passes; unknown keys, a serial, or a bad device are refused', () => {
  assert.equal(validateDiskHealthResponse(document(healthyDisk()), { now: NOW }).ok, true)
  assert.equal(validateDiskHealthResponse({ ...document(healthyDisk()), extra: 1 }, { now: NOW }).reason, 'unexpected-top-level-key')
  assert.equal(validateDiskHealthResponse(document({ ...healthyDisk(), serialNumber: 'x' }), { now: NOW }).reason, 'disk-unexpected-key')
  assert.equal(validateDiskHealthResponse(document(healthyDisk(), { device: '/dev/sda' }), { now: NOW }).reason, 'device-invalid')
  assert.equal(validateDiskHealthResponse(document(healthyDisk(), { device: 'sda1' }), { now: NOW }).reason, 'device-invalid')
  assert.equal(validateDiskHealthResponse({ ...document(healthyDisk()), schemaVersion: 2 }, { now: NOW }).reason, 'unsupported-schema-version')
  assert.equal(validateDiskHealthResponse(document(healthyDisk(), { ageSeconds: -60 }), { now: NOW }).reason, 'measured-in-the-future')
  assert.equal(validateDiskHealthResponse(null, { now: NOW }).reason, 'not-an-object')
})

test('DISK-SCHEMA-2 unavailable is exactly { available:false, reason }; a number beside it is refused', () => {
  assert.equal(validateDiskHealthResponse(document({ available: false, reason: 'smartctl-absent' }, { device: null }), { now: NOW }).ok, true)
  assert.equal(validateDiskHealthResponse(document({ available: false, reason: 'smartctl-absent', temperatureCelsius: 0 }), { now: NOW }).reason, 'disk-unavailable-with-values')
  assert.equal(validateDiskHealthResponse(document({ available: false }), { now: NOW }).reason, 'disk-unavailable-with-values')
  assert.equal(validateDiskHealthResponse(document({ available: 'yes' }), { now: NOW }).reason, 'disk-available-not-boolean')
})

test('DISK-SCHEMA-3 nulls are legal readings; negatives, strings, and unknown warning codes are not', () => {
  assert.equal(validateDiskHealthResponse(document({ ...healthyDisk(), temperatureCelsius: null, powerOnHours: null, model: null, capacityBytes: null }), { now: NOW }).ok, true)
  assert.equal(validateDiskHealthResponse(document({ ...healthyDisk(), temperatureCelsius: -1 }), { now: NOW }).reason, 'disk-temperature-invalid')
  assert.equal(validateDiskHealthResponse(document({ ...healthyDisk(), smart: { supported: true, enabled: true, passed: 'PASSED' } }), { now: NOW }).reason, 'disk-smart-invalid')
  assert.equal(validateDiskHealthResponse(document({ ...healthyDisk(), warnings: ['looks-fine'] }), { now: NOW }).reason, 'disk-warnings-invalid')
  const missing = { ...healthyDisk() }
  delete missing.warnings
  assert.equal(validateDiskHealthResponse(document(missing), { now: NOW }).reason, 'disk-missing-warnings')
})

test('DISK-SCHEMA-4 status rules against the collector fixtures: healthy, failing, no-temperature NVMe', async () => {
  const healthy = evidenceFromSmartctl(await fixture('smartctl-sata-healthy.json'))
  assert.deepEqual(deriveDiskStatus(healthy), { status: DISK_STATUS.HEALTHY, reason: null })

  const failing = evidenceFromSmartctl(await fixture('smartctl-sata-failing.json'), { exitStatus: 8 })
  assert.deepEqual(deriveDiskStatus(failing), { status: DISK_STATUS.CRITICAL, reason: null })

  const nvme = evidenceFromSmartctl(await fixture('smartctl-nvme-no-temperature.json'))
  assert.equal(nvme.temperatureCelsius, null)
  assert.deepEqual(deriveDiskStatus(nvme), { status: DISK_STATUS.HEALTHY, reason: null })
})

test('DISK-SCHEMA-5 a measured warning with SMART passed is WARNING; passed=false is CRITICAL regardless', () => {
  assert.equal(deriveDiskStatus({ ...healthyDisk(), warnings: ['pending-sectors'] }).status, DISK_STATUS.WARNING)
  assert.equal(deriveDiskStatus({ ...healthyDisk(), warnings: ['temperature-high'] }).status, DISK_STATUS.WARNING)
  assert.equal(deriveDiskStatus({ ...healthyDisk(), smart: { supported: true, enabled: true, passed: false }, warnings: [] }).status, DISK_STATUS.CRITICAL)
  assert.equal(deriveDiskStatus({ ...healthyDisk(), warnings: ['nvme-critical-warning'] }).status, DISK_STATUS.CRITICAL)
  assert.equal(deriveDiskStatus({ ...healthyDisk(), warnings: ['attribute-failing-now'] }).status, DISK_STATUS.CRITICAL)
})

test('DISK-SCHEMA-6 UNKNOWN is never promoted: missing evidence, stale evidence, or an unreported SMART status', () => {
  assert.deepEqual(deriveDiskStatus({ available: false, reason: 'smartctl-absent' }), { status: DISK_STATUS.UNKNOWN, reason: 'smartctl-absent' })
  assert.deepEqual(deriveDiskStatus(healthyDisk(), { stale: true }), { status: DISK_STATUS.UNKNOWN, reason: 'stale' })
  assert.deepEqual(deriveDiskStatus({ ...healthyDisk(), smart: { supported: true, enabled: true, passed: null } }), { status: DISK_STATUS.UNKNOWN, reason: 'smart-status-not-reported' })
  assert.deepEqual(deriveDiskStatus(null), { status: DISK_STATUS.UNKNOWN, reason: 'no-evidence' })
})

test('DISK-PROJ-1 the projection: fresh evidence is HEALTHY with every field; stale evidence keeps the readings but says UNKNOWN', async () => {
  const fresh = await hostDiskHealth({ fetch: async () => ({ ok: true, document: document(healthyDisk()) }), now: NOW })
  assert.equal(fresh.available, true)
  assert.equal(fresh.status, 'HEALTHY')
  assert.equal(fresh.stale, false)
  assert.equal(fresh.model, 'AEGIS-FIXTURE M.2 2280 128GB')
  assert.equal(fresh.device, 'sda')
  assert.equal(fresh.temperatureCelsius, 38)
  assert.equal(fresh.ageSeconds, 120)
  assert.equal(fresh.maxAgeSeconds, DISK_STALE_THRESHOLD_SECONDS)

  const stale = await hostDiskHealth({ fetch: async () => ({ ok: true, document: document(healthyDisk(), { ageSeconds: DISK_STALE_THRESHOLD_SECONDS + 1 }) }), now: NOW })
  assert.equal(stale.available, true)
  assert.equal(stale.stale, true)
  assert.equal(stale.status, 'UNKNOWN')
  assert.equal(stale.reason, 'stale')
  assert.equal(stale.model, 'AEGIS-FIXTURE M.2 2280 128GB', 'last known readings stay visible')
})

test('DISK-PROJ-2 an unreachable agent, a malformed body, or a contract failure is unavailable and carries no numbers', async () => {
  const unreachable = await hostDiskHealth({ fetch: async () => ({ ok: false, reason: 'unreachable' }), now: NOW })
  assert.equal(unreachable.available, false)
  assert.equal(unreachable.status, 'UNKNOWN')
  assert.equal(unreachable.reason, 'agent-unreachable')
  assert.equal(unreachable.temperatureCelsius, null)
  assert.deepEqual(unreachable.warnings, [])

  const contract = await hostDiskHealth({ fetch: async () => ({ ok: false, reason: 'disk-unexpected-key' }), now: NOW })
  assert.equal(contract.reason, 'disk-unexpected-key', 'a contract failure keeps its specific reason')

  const thrown = await hostDiskHealth({ fetch: async () => { throw new Error('boom') }, now: NOW })
  assert.equal(thrown.available, false)
  assert.equal(thrown.reason, 'agent-unreachable')

  const collectorUnavailable = await hostDiskHealth({ fetch: async () => ({ ok: true, document: document({ available: false, reason: 'smartctl-absent' }, { device: null }) }), now: NOW })
  assert.equal(collectorUnavailable.available, false)
  assert.equal(collectorUnavailable.reason, 'smartctl-absent')
  assert.equal(collectorUnavailable.status, 'UNKNOWN')
})
