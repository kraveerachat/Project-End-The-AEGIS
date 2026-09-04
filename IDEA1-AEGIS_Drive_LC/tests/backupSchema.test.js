// tests/backupSchema.test.js — AEGIS Drive (IDEA1) · backup agent status contract
import test from 'node:test'
import assert from 'node:assert/strict'

import { validateBackupStatus } from '../server/backup/schema.js'
import { agentStatus } from './fixtures/backupAgentStatus.js'

const NOW = Date.parse('2026-09-03T02:00:00.000Z')
const check = (overrides) => validateBackupStatus(agentStatus(overrides), { now: NOW })

test('BK-SCHEMA-1 a valid status passes and is returned unchanged', () => {
  const result = check()
  assert.equal(result.ok, true)
  assert.equal(result.status.state, 'READY')
})

test('BK-SCHEMA-2 unknown or missing top-level keys, wrong engine, wrong version, future timestamp are refused', () => {
  assert.equal(validateBackupStatus({ ...agentStatus(), extra: 1 }, { now: NOW }).reason, 'unexpected-or-missing-top-level-key')
  const missing = agentStatus()
  delete missing.history
  assert.equal(validateBackupStatus(missing, { now: NOW }).reason, 'unexpected-or-missing-top-level-key')
  assert.equal(check({ engine: 'rsync' }).reason, 'engine-unknown')
  assert.equal(check({ schemaVersion: 2 }).reason, 'unsupported-schema-version')
  assert.equal(check({ measuredAt: new Date(NOW + 60_000).toISOString() }).reason, 'measured-in-the-future')
  assert.equal(validateBackupStatus('nope', { now: NOW }).reason, 'not-an-object')
})

test('BK-SCHEMA-3 states, protections, and policy IDs come from fixed sets', () => {
  assert.equal(check({ state: 'HEALTHY' }).reason, 'state-unknown')
  assert.equal(check({ target: { id: 'usb-external-1', label: 'x', type: 'external-mount', protection: 'SAFE' } }).reason, 'target-protection')
  assert.equal(check({ targets: [{ id: '/mnt/x', label: 'x', type: 'external-mount', protection: 'OFF_HOST' }] }).reason, 'target-id')
  assert.equal(check({ targets: [{ id: 'a', label: 'x', type: 'tape', protection: 'OFF_HOST' }] }).reason, 'target-type')
  assert.equal(check({ targets: [{ id: 'a', label: 'x', type: 'off-host-sftp', protection: 'OFF_HOST', repository: 'sftp:leak' }] }).reason, 'target-shape')
  assert.equal(check({ policy: { activeTargetId: 'usb-external-1', scheduleId: 'daily-02:00', retentionId: 'keep-7d-4w', enabled: 'yes' } }).reason, 'policy-enabled')
  assert.equal(check({ policy: { activeTargetId: 'usb-external-1', scheduleId: 'daily-02:00', retentionId: 'keep-7d-4w', enabled: true, passwordFile: '/etc/x' } }).reason, 'policy-shape')
})

test('BK-SCHEMA-4 history entries are strictly shaped: enums, timestamps, non-negative bytes, no free-form error text', () => {
  const entry = {
    jobId: '4f0c3d2e-1111-2222-3333-444455556666', kind: 'backup', trigger: 'manual',
    startedAt: new Date(NOW - 3600_000).toISOString(), finishedAt: new Date(NOW - 3000_000).toISOString(), status: 'SUCCESS',
    targetId: 'usb-external-1', targetType: 'external-mount', protection: 'DIFFERENT_DEVICE',
    bytesScanned: 1, bytesBackedUp: 1, snapshotId: 'abc', integrityCheck: 'PASS', restoreVerification: 'NOT_TESTED', errorCode: null,
  }
  assert.equal(check({ history: [entry] }).ok, true)
  assert.equal(check({ history: [{ ...entry, errorCode: 'restic: Fatal: password incorrect' }] }).reason, 'history-error-code')
  assert.equal(check({ history: [{ ...entry, stderr: 'leak' }] }).reason, 'history-shape')
  assert.equal(check({ history: [{ ...entry, bytesBackedUp: -5 }] }).reason, 'history-bytes')
  assert.equal(check({ history: [{ ...entry, status: 'GREEN' }] }).reason, 'history-status')
  assert.equal(check({ history: [{ ...entry, integrityCheck: 'ok' }] }).reason, 'history-integrity')
  assert.equal(check({ history: Array.from({ length: 51 }, () => entry) }).reason, 'history-shape')
})

test('BK-SCHEMA-5 a running job is shaped and timestamped; limits are positive integers', () => {
  const jobShape = { jobId: 'abcdef12-3456-7890-abcd-ef1234567890', kind: 'backup', phase: 'DUMPING', startedAt: new Date(NOW).toISOString(), leaseUntil: new Date(NOW + 1).toISOString(), ackDeadline: new Date(NOW + 1).toISOString(), quiesceRequired: true }
  assert.equal(check({ job: jobShape, state: 'RUNNING' }).ok, true)
  assert.equal(check({ job: { ...jobShape, phase: 'FLYING' } }).reason, 'job-kind-or-phase')
  assert.equal(check({ job: { ...jobShape, quiesceRequired: 'true' } }).reason, 'job-quiesce')
  assert.equal(check({ limits: { quiesceLeaseSeconds: 0, quiesceAckTimeoutSeconds: 1, maxBackupAgeHours: 1, verifyIntervalDays: 1 } }).reason, 'limits-value')
})
