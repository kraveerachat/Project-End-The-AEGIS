// tests/backupDerive.test.js — AEGIS Drive (IDEA1) · backup facts and risk rules
//
// Every number and the risk word are derived from job history the agent
// actually recorded. Configuration alone never yields HEALTHY; no jobs yields
// null (not 0 %, not 100 %); UNKNOWN is reserved for missing evidence.
import test from 'node:test'
import assert from 'node:assert/strict'

import { BACKUP_RISK, deriveBackupReport, lastRestoreVerification, successRate30d } from '../server/backup/derive.js'
import { validateBackupStatus } from '../server/backup/schema.js'
import { agentStatus } from './fixtures/backupAgentStatus.js'

const NOW = Date.parse('2026-09-03T02:00:00.000Z')
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

const job = (overrides = {}) => ({
  jobId: '4f0c3d2e-1111-2222-3333-444455556666', kind: 'backup', trigger: 'manual',
  startedAt: new Date(NOW - 2 * HOUR).toISOString(), finishedAt: new Date(NOW - 2 * HOUR + 5 * 60_000).toISOString(),
  status: 'SUCCESS', targetId: 'usb-external-1', targetType: 'external-mount', protection: 'DIFFERENT_DEVICE',
  bytesScanned: 18_300_000_000, bytesBackedUp: 250_000_000, snapshotId: 'abc123',
  integrityCheck: 'PASS', restoreVerification: 'NOT_TESTED', errorCode: null,
  ...overrides,
})
const at = (hoursAgo, overrides = {}) => job({
  jobId: `00000000-0000-0000-0000-${String(Math.round(hoursAgo * 100)).padStart(12, '0')}`,
  startedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
  finishedAt: new Date(NOW - hoursAgo * HOUR + 60_000).toISOString(),
  ...overrides,
})

/** Validate first, as the route does — a fixture that fails the contract is a test bug. */
const validated = (overrides) => {
  const result = validateBackupStatus(agentStatus(overrides), { now: NOW })
  assert.equal(result.ok, true, `fixture must validate: ${result.reason}`)
  return result.status
}

test('RISK-1 no evidence: UNKNOWN with null facts', () => {
  const report = deriveBackupReport(null, { now: NOW })
  assert.equal(report.available, false)
  assert.equal(report.risk, BACKUP_RISK.UNKNOWN)
  assert.equal(report.successRate30d, null)
  assert.equal(report.lastSuccessfulBackup, null)
  assert.equal(report.restoreVerification.status, 'NOT_TESTED')
})

test('RISK-2 no target -> NOT_CONFIGURED; same disk -> NOT_CONFIGURED with the failure-domain reason; never HEALTHY from configuration', () => {
  const none = deriveBackupReport(validated({ policy: { activeTargetId: null, scheduleId: 'disabled', retentionId: 'keep-7d-4w', enabled: false }, target: null, state: 'NOT_CONFIGURED', nextRun: null }), { now: NOW })
  assert.equal(none.risk, BACKUP_RISK.NOT_CONFIGURED)
  assert.deepEqual(none.riskReasons, ['no-target-selected'])

  const same = deriveBackupReport(validated({ state: 'SAME_FAILURE_DOMAIN', target: { id: 'usb-external-1', label: 'x', type: 'external-mount', protection: 'SAME_FAILURE_DOMAIN' } }), { now: NOW })
  assert.equal(same.risk, BACKUP_RISK.NOT_CONFIGURED)
  assert.deepEqual(same.riskReasons, ['target-same-failure-domain'])

  const ready = deriveBackupReport(validated(), { now: NOW })
  assert.notEqual(ready.risk, BACKUP_RISK.HEALTHY, 'READY with no job is not healthy')
  assert.equal(ready.risk, BACKUP_RISK.CRITICAL)
  assert.deepEqual(ready.riskReasons, ['no-successful-backup'])
  assert.equal(ready.successRate30d, null)
})

test('RISK-3 a recent success with a recent restore verification is HEALTHY', () => {
  const report = deriveBackupReport(validated({ history: [
    at(2),
    at(20, { kind: 'verify', restoreVerification: 'PASS' }),
  ] }), { now: NOW })
  assert.equal(report.risk, BACKUP_RISK.HEALTHY)
  assert.deepEqual(report.riskReasons, [])
  assert.equal(report.successRate30d, 100)
  assert.equal(report.completedJobs30d, 1)
  assert.equal(report.backupAgeSeconds, 2 * 3600 - 60)
  assert.equal(report.bytesCovered, 18_300_000_000)
  assert.equal(report.integrity, 'PASS')
  assert.equal(report.restoreVerification.status, 'PASS')
})

test('RISK-4 a recent success with no restore verification ever is WARNING', () => {
  const report = deriveBackupReport(validated({ history: [at(2)] }), { now: NOW })
  assert.equal(report.risk, BACKUP_RISK.WARNING)
  assert.deepEqual(report.riskReasons, ['restore-never-verified'])
})

test('RISK-5 the last backup failed with no newer success -> CRITICAL; a newer success clears it', () => {
  const failedLast = deriveBackupReport(validated({ history: [at(1, { status: 'FAILED', errorCode: 'RESTIC_BACKUP_FAILED', integrityCheck: 'NOT_RUN' }), at(25)] }), { now: NOW })
  assert.equal(failedLast.risk, BACKUP_RISK.CRITICAL)
  assert.ok(failedLast.riskReasons.includes('last-backup-failed'))
  assert.equal(failedLast.lastFailedBackup !== null, true)
  assert.equal(failedLast.successRate30d, 50)

  const recovered = deriveBackupReport(validated({ history: [at(1), at(3, { status: 'FAILED', errorCode: 'QUIESCE_TIMEOUT', integrityCheck: 'NOT_RUN' }), at(20, { kind: 'verify', restoreVerification: 'PASS' })] }), { now: NOW })
  assert.equal(recovered.risk, BACKUP_RISK.HEALTHY)
})

test('RISK-6 staleness: past 75 % of the maximum age is WARNING, past the maximum is CRITICAL', () => {
  const verify = at(1, { kind: 'verify', restoreVerification: 'PASS' })
  const stale = deriveBackupReport(validated({ history: [at(30), verify] }), { now: NOW }) // 30 h of 36 h
  assert.equal(stale.risk, BACKUP_RISK.WARNING)
  assert.deepEqual(stale.riskReasons, ['backup-becoming-stale'])
  const tooOld = deriveBackupReport(validated({ history: [at(40), verify] }), { now: NOW })
  assert.equal(tooOld.risk, BACKUP_RISK.CRITICAL)
  assert.deepEqual(tooOld.riskReasons, ['backup-older-than-max-age'])
})

test('RISK-7 a failed restore verification is CRITICAL; a stale one is WARNING', () => {
  const failed = deriveBackupReport(validated({ history: [at(2), at(3, { kind: 'verify', status: 'FAILED', restoreVerification: 'FAIL', errorCode: 'CONTENT_MISSING' })] }), { now: NOW })
  assert.equal(failed.risk, BACKUP_RISK.CRITICAL)
  assert.deepEqual(failed.riskReasons, ['restore-verification-failed'])
  const stale = deriveBackupReport(validated({ history: [at(2), at(8 * 24, { kind: 'verify', restoreVerification: 'PASS' })] }), { now: NOW })
  assert.equal(stale.risk, BACKUP_RISK.WARNING)
  assert.deepEqual(stale.riskReasons, ['restore-verification-stale'])
})

test('RISK-8 successRate30d counts completed backup jobs in the window only; verify jobs and running jobs are excluded', () => {
  const history = [
    at(1), at(5, { status: 'FAILED', errorCode: 'INTERNAL', integrityCheck: 'NOT_RUN' }), at(10), at(40 * 24), // the last is outside 30 days
    at(2, { kind: 'verify', restoreVerification: 'PASS' }),
    at(0.1, { status: 'RUNNING', finishedAt: null }),
  ]
  assert.equal(successRate30d(history, NOW), 66.7)
  assert.equal(successRate30d([], NOW), null)
  assert.equal(successRate30d([at(40 * 24)], NOW), null, 'only jobs older than 30 days = unavailable')
  assert.deepEqual(lastRestoreVerification([]), { at: null, status: 'NOT_TESTED' })
})

test('RISK-9 running job and next run are passed through as facts, not as health', () => {
  const running = deriveBackupReport(validated({
    state: 'RUNNING',
    job: { jobId: 'abcdef12-3456-7890-abcd-ef1234567890', kind: 'backup', phase: 'DUMPING', startedAt: new Date(NOW - 60_000).toISOString(), leaseUntil: new Date(NOW + 800_000).toISOString(), ackDeadline: new Date(NOW + 60_000).toISOString(), quiesceRequired: true },
    history: [at(2), at(20, { kind: 'verify', restoreVerification: 'PASS' })],
  }), { now: NOW })
  assert.equal(running.state, 'RUNNING')
  assert.equal(running.job.phase, 'DUMPING')
  assert.equal(running.risk, BACKUP_RISK.HEALTHY)
  assert.ok(running.nextRun)
})
