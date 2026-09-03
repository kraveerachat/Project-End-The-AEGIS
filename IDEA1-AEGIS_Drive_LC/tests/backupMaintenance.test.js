// tests/backupMaintenance.test.js — AEGIS Drive (IDEA1) · the write-freeze gate
//
// Drive's half of the consistency model. Pinned here: which requests are
// destructive, that a freeze is only ever taken from a validated agent status,
// that acknowledgement waits for in-flight destructive requests, that the
// lease is enforced on Drive's own clock, and that completed jobs are audited
// exactly once with a SYSTEM actor.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { MAINTENANCE_CODE, createBackupMaintenance, isDestructiveRequest } from '../server/backup/maintenance.js'
import { agentStatus } from './fixtures/backupAgentStatus.js'

const NOW = Date.parse('2026-09-03T02:00:00.000Z')

function fakeRes() {
  const res = new EventEmitter()
  res.headers = {}
  res.statusCode = 200
  res.body = null
  res.set = (k, v) => { res.headers[k] = v }
  res.status = (code) => { res.statusCode = code; return res }
  res.json = (body) => { res.body = body; return res }
  return res
}

function harness({ statuses = [], acks = [] } = {}) {
  let t = NOW
  const audits = []
  const ackCalls = []
  const queue = [...statuses]
  const m = createBackupMaintenance({
    fetchStatus: async () => (queue.length ? queue.shift() : { ok: false, reason: 'unreachable' }),
    acknowledge: async (body) => { ackCalls.push(body); return acks.length ? acks.shift() : { ok: true } },
    recordAudit: async (event) => { audits.push(event) },
    hash: (s) => `h:${s}`,
    now: () => t,
    setTimer: () => ({}),
    clearTimer: () => {},
  })
  return { m, audits, ackCalls, advance: (ms) => { t += ms }, push: (s) => queue.push(s) }
}

const runningStatus = (phase = 'QUIESCE_REQUESTED', { jobId = 'abcdef12-3456-7890-abcd-ef1234567890', leaseMs = 600_000 } = {}) => ({
  ok: true,
  status: agentStatus({
    state: 'RUNNING',
    job: { jobId, kind: 'backup', phase, startedAt: new Date(NOW).toISOString(), leaseUntil: new Date(NOW + leaseMs).toISOString(), ackDeadline: new Date(NOW + 60_000).toISOString(), quiesceRequired: ['QUIESCE_REQUESTED', 'QUIESCED', 'DUMPING', 'SNAPSHOTTING'].includes(phase) },
  }),
})

test('MAINT-1 the destructive set is exactly the routes that move or remove referenced bytes', () => {
  const yes = [['DELETE', '/files/42'], ['POST', '/files/upload'], ['POST', '/files/uploads/abc/commit'], ['POST', '/files/42/versions/7/restore'], ['DELETE', '/trash/42'], ['DELETE', '/trash'], ['DELETE', '/vault/blobs/9'], ['POST', '/vault/uploads/abc/commit']]
  const no = [['GET', '/files'], ['GET', '/files/42/download'], ['POST', '/shares'], ['DELETE', '/shares/1'], ['POST', '/files/uploads'], ['PUT', '/files/uploads/abc/chunks/3'], ['POST', '/files/42/verify'], ['POST', '/login'], ['DELETE', '/files/42/versions/7'], ['GET', '/storage']]
  for (const [method, path] of yes) assert.equal(isDestructiveRequest(method, path), true, `${method} ${path} must be gated`)
  for (const [method, path] of no) assert.equal(isDestructiveRequest(method, path), false, `${method} ${path} must not be gated`)
})

test('MAINT-8 background Trash purge participates in quiesce and cannot start during a freeze', async () => {
  const h = harness({ statuses: [runningStatus(), runningStatus()] })
  let finishPurge
  const purge = h.m.runDestructive(() => new Promise((resolve) => { finishPurge = resolve }))
  assert.equal(h.m.snapshot().inFlight, 1)

  await h.m.tick()
  assert.equal(h.m.snapshot().active, true)
  assert.equal(h.m.snapshot().acknowledged, false)

  finishPurge({ purged: 1 })
  assert.deepEqual(await purge, { allowed: true, value: { purged: 1 } })
  assert.equal(h.m.snapshot().inFlight, 0)
  await h.m.tick()
  assert.equal(h.m.snapshot().acknowledged, true)

  let started = false
  const blocked = await h.m.runDestructive(async () => { started = true })
  assert.deepEqual(blocked, { allowed: false, value: null })
  assert.equal(started, false)
})

test('MAINT-2 with no agent nothing is ever frozen and destructive requests pass through', async () => {
  const h = harness()
  const result = await h.m.tick()
  assert.deepEqual(result, { active: false, reachable: false })
  let passed = false
  h.m.middleware({ method: 'DELETE', path: '/files/1' }, fakeRes(), () => { passed = true })
  assert.equal(passed, true)
  assert.equal(h.m.snapshot().active, false)
})

test('MAINT-3 a quiesce request freezes destructive mutations with 503 BACKUP_MAINTENANCE and Retry-After, and leaves reads alone', async () => {
  const h = harness({ statuses: [runningStatus()] })
  await h.m.tick()
  assert.equal(h.m.snapshot().active, true)
  assert.equal(h.m.snapshot().acknowledged, true, 'nothing was in flight, so the freeze is acknowledged on the same tick')
  assert.deepEqual(h.ackCalls, [{ jobId: 'abcdef12-3456-7890-abcd-ef1234567890' }])

  const res = fakeRes()
  let passed = false
  h.m.middleware({ method: 'DELETE', path: '/files/1' }, res, () => { passed = true })
  assert.equal(passed, false)
  assert.equal(res.statusCode, 503)
  assert.equal(res.body.code, MAINTENANCE_CODE)
  assert.ok(Number(res.headers['Retry-After']) > 0)

  let readPassed = false
  h.m.middleware({ method: 'GET', path: '/files/1/download' }, fakeRes(), () => { readPassed = true })
  assert.equal(readPassed, true)
})

test('MAINT-4 acknowledgement waits until in-flight destructive requests have finished', async () => {
  const h = harness({ statuses: [runningStatus(), runningStatus()] })
  // A delete is mid-flight before the agent asks for the freeze.
  const inFlight = fakeRes()
  h.m.middleware({ method: 'DELETE', path: '/files/1' }, inFlight, () => {})
  assert.equal(h.m.snapshot().inFlight, 1)

  await h.m.tick()
  assert.equal(h.m.snapshot().active, true, 'new destructive requests are refused immediately')
  assert.equal(h.m.snapshot().acknowledged, false, 'but the agent is not told "quiesced" while one is still running')
  assert.equal(h.ackCalls.length, 0)

  inFlight.emit('finish')
  inFlight.emit('close') // both events fire in Express; the release must be idempotent
  assert.equal(h.m.snapshot().inFlight, 0)
  await h.m.tick()
  assert.equal(h.m.snapshot().acknowledged, true)
  assert.equal(h.ackCalls.length, 1)
})

test('MAINT-5 the freeze lifts when the agent leaves the quiesced phases, and on lease expiry even if the agent vanishes', async () => {
  const lifted = harness({ statuses: [runningStatus('QUIESCED'), runningStatus('CHECKING')] })
  await lifted.m.tick()
  assert.equal(lifted.m.snapshot().active, true)
  await lifted.m.tick()
  assert.equal(lifted.m.snapshot().active, false)

  const vanished = harness({ statuses: [runningStatus('DUMPING', { leaseMs: 120_000 })] })
  await vanished.m.tick()
  assert.equal(vanished.m.snapshot().active, true)
  await vanished.m.tick() // agent unreachable now; lease still valid
  assert.equal(vanished.m.snapshot().active, true, 'a lease is held through a transient agent failure')
  vanished.advance(121_000)
  const res = fakeRes()
  let passed = false
  vanished.m.middleware({ method: 'DELETE', path: '/files/1' }, res, () => { passed = true })
  assert.equal(passed, true, 'past the lease, Drive frees itself on its own clock')
  await vanished.m.tick()
  assert.equal(vanished.m.snapshot().active, false)
})

test('MAINT-6 an acknowledgement is never sent for a job that is already past QUIESCE_REQUESTED', async () => {
  const h = harness({ statuses: [runningStatus('DUMPING')] })
  await h.m.tick()
  assert.equal(h.m.snapshot().active, true)
  assert.equal(h.ackCalls.length, 0)
})

test('MAINT-7 completed jobs are audited exactly once with a SYSTEM actor and hashed job id', async () => {
  const success = { jobId: '11111111-1111-1111-1111-111111111111', kind: 'backup', trigger: 'schedule', startedAt: new Date(NOW - 7200_000).toISOString(), finishedAt: new Date(NOW - 7000_000).toISOString(), status: 'SUCCESS', targetId: 'usb-external-1', targetType: 'external-mount', protection: 'DIFFERENT_DEVICE', bytesScanned: 1, bytesBackedUp: 1, snapshotId: 'a', integrityCheck: 'PASS', restoreVerification: 'NOT_TESTED', errorCode: null }
  const failedVerify = { ...success, jobId: '22222222-2222-2222-2222-222222222222', kind: 'verify', status: 'FAILED', restoreVerification: 'FAIL', errorCode: 'CONTENT_MISSING' }
  const running = { ...success, jobId: '33333333-3333-3333-3333-333333333333', status: 'RUNNING', finishedAt: null }
  const status = { ok: true, status: agentStatus({ history: [running, failedVerify, success] }) }
  const h = harness({ statuses: [status, status] })
  await h.m.tick()
  await h.m.tick()
  assert.equal(h.audits.length, 2, 'two completed jobs, seen on two ticks, audited once each')
  const byAction = Object.fromEntries(h.audits.map((a) => [a.action, a]))
  assert.equal(byAction.BACKUP_RUN_SUCCESS.result, 'OK')
  assert.equal(byAction.BACKUP_RUN_SUCCESS.actorLabel, 'SYSTEM:backup-agent')
  assert.equal(byAction.BACKUP_RUN_SUCCESS.role, 'SYSTEM')
  assert.equal(byAction.BACKUP_RUN_SUCCESS.targetHash, 'h:11111111-1111-1111-1111-111111111111')
  assert.equal(byAction.BACKUP_VERIFY_FAIL.result, 'BLOCKED')
  assert.equal(h.audits.some((a) => a.actorId !== null), false)
})
