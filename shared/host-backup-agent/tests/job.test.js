// tests/job.test.js — the job runner and the write-freeze consistency model
//
// Every tool is a double and the clock is a fake. What is asserted is the
// ORDER of operations and the outcome under each failure: a backup is only
// SUCCESS when the freeze was acknowledged, the dump was readable, the
// snapshot completed inside the lease, and the repository check passed.
import test from 'node:test'
import assert from 'node:assert/strict'

import { PHASES, QUIESCED_PHASES, createJobRunner } from '../src/job.js'
import { createHistoryStore } from '../src/history.js'
import { createPolicyStore } from '../src/policy.js'
import { classifyTarget } from '../src/targets.js'
import { fakeClock, fakeRestic, fixtureConfig, memoryFs, productionTargetDeps, settle } from './helpers.js'

function harness({ policy = { activeTargetId: 'usb-external-1', scheduleId: 'disabled', retentionId: 'keep-7d-4w', enabled: false }, restic = fakeRestic(), dump, verifyDump, targetDeps = productionTargetDeps() } = {}) {
  const config = fixtureConfig()
  const fs = memoryFs()
  const clock = fakeClock()
  const policyStore = createPolicyStore({ stateDir: config.stateDir, config, fs })
  const history = createHistoryStore({ stateDir: config.stateDir, fs })
  const toolCalls = []
  const runner = createJobRunner({
    config, policyStore, history,
    resticFor: () => restic,
    classify: (target) => classifyTarget(target, { datalakePath: config.source.datalakePath, ...targetDeps }),
    dumpDatabase: dump ?? (async (args) => { toolCalls.push(['pg_dump', args.outputFile]); return { ok: true } }),
    verifyDumpReadable: verifyDump ?? (async (args) => { toolCalls.push(['pg_restore --list', args.file]); return { ok: true, entries: 2 } }),
    now: clock.now, fs, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  return { config, fs, clock, policyStore, history, runner, restic, toolCalls, setPolicy: () => policyStore.set(policy) }
}

test('JOB-1 no active target: the job fails immediately with TARGET_NOT_CONFIGURED and no tool runs', async () => {
  const h = harness()
  const result = await h.runner.requestBackup()
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-configured')
  assert.equal(result.job.status, 'FAILED')
  assert.equal(result.job.errorCode, 'TARGET_NOT_CONFIGURED')
  assert.equal(h.restic.calls.length, 0)
  assert.equal(h.toolCalls.length, 0)
})

test('JOB-2 a target on the same physical disk is refused as TARGET_NOT_PROTECTED', async () => {
  const mountinfo = productionTargetDeps().readMountInfo
  const deps = productionTargetDeps()
  deps.readMountInfo = async () => (await mountinfo()) + '130 25 8:4 / /srv/backup rw,relatime - ext4 /dev/sda4 rw\n'
  const original = deps.sys.realpath
  deps.sys.realpath = async (p) => (p === '/sys/class/block/sda4' ? '/sys/devices/x/block/sda/sda4' : original(p))
  const h = harness({ policy: { activeTargetId: 'same-disk-dir', scheduleId: 'disabled', retentionId: 'keep-7d-4w', enabled: false }, targetDeps: deps })
  await h.setPolicy()
  const result = await h.runner.requestBackup()
  assert.equal(result.reason, 'target-not-protected')
  assert.equal(result.job.errorCode, 'TARGET_NOT_PROTECTED')
  assert.equal(result.job.protection, 'SAME_FAILURE_DOMAIN')
  assert.equal(h.restic.calls.length, 0)
})

test('JOB-3 an unmounted target is TARGET_UNAVAILABLE', async () => {
  const h = harness({ policy: { activeTargetId: 'same-disk-dir', scheduleId: 'disabled', retentionId: 'keep-7d-4w', enabled: false } })
  await h.setPolicy()
  const result = await h.runner.requestBackup()
  assert.equal(result.job.errorCode, 'TARGET_UNAVAILABLE')
})

test('JOB-4 the happy path: freeze requested -> acknowledged -> dump -> snapshot -> release -> check -> prune -> SUCCESS', async () => {
  const h = harness()
  await h.setPolicy()
  const result = await h.runner.requestBackup()
  assert.equal(result.ok, true)
  await settle()

  let status = h.runner.status()
  assert.equal(status.job.phase, PHASES.QUIESCE_REQUESTED)
  assert.equal(status.job.quiesceRequired, true)
  assert.equal(h.toolCalls.length, 0, 'nothing runs before Drive acknowledges the freeze')

  assert.deepEqual(h.runner.acknowledgeQuiesce('wrong-id'), { ok: false, reason: 'no-such-job' })
  assert.deepEqual(h.runner.acknowledgeQuiesce(result.jobId), { ok: true })
  const record = await result.done

  assert.equal(record.status, 'SUCCESS')
  assert.equal(record.integrityCheck, 'PASS')
  assert.equal(record.snapshotId, 'abc123')
  assert.equal(record.bytesScanned, 18_300_000_000)
  assert.equal(record.bytesBackedUp, 250_000_000)
  assert.equal(record.restoreVerification, 'NOT_TESTED', 'a backup does not claim a restore it never performed')
  assert.equal(record.protection, 'DIFFERENT_DEVICE')

  // Order: dump, dump readable, then restic (init check, unlock, backup, check, forget)
  assert.deepEqual(h.toolCalls.map(([name]) => name), ['pg_dump', 'pg_restore --list'])
  assert.deepEqual(h.restic.calls.map(([name]) => name), ['isInitialized', 'unlock', 'backup', 'check', 'forget'])
  const backupPaths = h.restic.calls.find(([name]) => name === 'backup')[1]
  assert.deepEqual(backupPaths, [
    '/var/lib/aegis-backup/dump',
    '/var/lib/docker/volumes/aegis_drive_storage/_data/uploads',
    '/var/lib/docker/volumes/aegis_drive_storage/_data/versions',
    '/var/lib/docker/volumes/aegis_drive_storage/_data/vault',
    '/var/lib/docker/volumes/aegis_drive_storage/_data/avatars',
  ])
  status = h.runner.status()
  assert.equal(status.running, false)
  assert.equal((await h.history.list())[0].status, 'SUCCESS')
})

test('JOB-5 without an acknowledgement before the deadline the job FAILS with QUIESCE_TIMEOUT and never backs up', async () => {
  const h = harness()
  await h.setPolicy()
  const result = await h.runner.requestBackup()
  await settle()
  h.clock.advance(61_000)
  h.clock.fireDue()
  const record = await result.done
  assert.equal(record.status, 'FAILED')
  assert.equal(record.errorCode, 'QUIESCE_TIMEOUT')
  assert.equal(h.toolCalls.length, 0)
  assert.equal(h.restic.calls.length, 0)
  assert.deepEqual(h.runner.acknowledgeQuiesce(result.jobId), { ok: false, reason: 'no-such-job' })
})

test('JOB-6 a snapshot that finishes after the lease expired is FAILED with LEASE_EXPIRED, not SUCCESS', async () => {
  const h = harness({ restic: fakeRestic({ backup: () => { h.clock.advance(601_000); return { ok: true, summary: { snapshotId: 'late', bytesScanned: 1, bytesBackedUp: 1 } } } }) })
  await h.setPolicy()
  const result = await h.runner.requestBackup()
  await settle()
  h.runner.acknowledgeQuiesce(result.jobId)
  const record = await result.done
  assert.equal(record.status, 'FAILED')
  assert.equal(record.errorCode, 'LEASE_EXPIRED')
  assert.equal(record.snapshotId, 'late', 'the snapshot id is recorded so an operator can prune it')
  assert.ok(!h.restic.calls.some(([name]) => name === 'check'), 'no check is run on a snapshot that is not evidence')
})

test('JOB-7 a failed or unreadable dump stops the job before any bytes are snapshotted', async () => {
  const failed = harness({ dump: async () => ({ ok: false }) })
  await failed.setPolicy()
  const a = await failed.runner.requestBackup()
  await settle()
  failed.runner.acknowledgeQuiesce(a.jobId)
  assert.equal((await a.done).errorCode, 'PG_DUMP_FAILED')
  assert.equal(failed.restic.calls.length, 0)

  const unreadable = harness({ verifyDump: async () => ({ ok: false, entries: 0 }) })
  await unreadable.setPolicy()
  const b = await unreadable.runner.requestBackup()
  await settle()
  unreadable.runner.acknowledgeQuiesce(b.jobId)
  assert.equal((await b.done).errorCode, 'PG_DUMP_UNREADABLE')
  assert.equal(unreadable.restic.calls.length, 0)
})

test('JOB-8 a repository check failure after the snapshot records integrityCheck FAIL', async () => {
  const h = harness({ restic: fakeRestic({ check: { ok: false } }) })
  await h.setPolicy()
  const result = await h.runner.requestBackup()
  await settle()
  h.runner.acknowledgeQuiesce(result.jobId)
  const record = await result.done
  assert.equal(record.status, 'FAILED')
  assert.equal(record.errorCode, 'RESTIC_CHECK_FAILED')
  assert.equal(record.integrityCheck, 'FAIL')
  assert.equal(record.snapshotId, 'abc123')
})

test('JOB-9 the freeze is released before check and prune run', async () => {
  let phaseDuringCheck = null
  const h = harness()
  h.restic.check = async () => { phaseDuringCheck = h.runner.status().job.phase; return { ok: true } }
  await h.setPolicy()
  const result = await h.runner.requestBackup()
  await settle()
  h.runner.acknowledgeQuiesce(result.jobId)
  await result.done
  assert.equal(phaseDuringCheck, PHASES.CHECKING)
  assert.equal(QUIESCED_PHASES.includes(PHASES.CHECKING), false)
})

test('JOB-10 a missing tool binary is TOOL_MISSING, not a generic failure', async () => {
  const h = harness({ dump: async () => { throw Object.assign(new Error('spawn pg_dump ENOENT'), { code: 'ENOENT' }) } })
  await h.setPolicy()
  const result = await h.runner.requestBackup()
  await settle()
  h.runner.acknowledgeQuiesce(result.jobId)
  assert.equal((await result.done).errorCode, 'TOOL_MISSING')
})

test('JOB-11 only one job runs at a time', async () => {
  const h = harness()
  await h.setPolicy()
  const first = await h.runner.requestBackup()
  await settle()
  const second = await h.runner.requestBackup()
  assert.deepEqual(second, { ok: false, reason: 'busy', jobId: first.jobId })
  h.runner.acknowledgeQuiesce(first.jobId)
  await first.done
})

test('JOB-12 restore verification PASS requires check, content presence, isolated restore and a readable dump', async () => {
  const h = harness()
  await h.setPolicy()
  const result = await h.runner.requestVerify()
  assert.equal(result.ok, true)
  const record = await result.done
  assert.equal(record.kind, 'verify')
  assert.equal(record.status, 'SUCCESS')
  assert.equal(record.restoreVerification, 'PASS')
  assert.equal(record.integrityCheck, 'PASS')
  assert.deepEqual(h.restic.calls.map(([name]) => name), ['check', 'listSnapshot', 'restoreTo'])
  assert.deepEqual(h.restic.calls[0][1], { readDataSubset: '10%' })
  const restoreTarget = h.restic.calls[2][1]
  assert.ok(restoreTarget.startsWith('/var/lib/aegis-backup/verify/'), 'restore goes into the agent state dir, never production')
  assert.ok(!restoreTarget.startsWith('/var/lib/docker'))
  assert.equal(h.toolCalls[0][0], 'pg_restore --list')
  assert.ok(h.toolCalls[0][1].startsWith('/var/lib/aegis-backup/verify/'))
})

test('JOB-13 restore verification FAILS on missing content or an unreadable restored dump', async () => {
  const missing = harness({ restic: fakeRestic({ listSnapshot: { ok: true, paths: ['/var/lib/aegis-backup/dump/aegis_drive.pgdump'] } }) })
  await missing.setPolicy()
  const a = await missing.runner.requestVerify()
  const ra = await a.done
  assert.equal(ra.errorCode, 'CONTENT_MISSING')
  assert.equal(ra.restoreVerification, 'FAIL')

  const unreadable = harness({ verifyDump: async () => ({ ok: false, entries: 0 }) })
  await unreadable.setPolicy()
  const b = await unreadable.runner.requestVerify()
  const rb = await b.done
  assert.equal(rb.errorCode, 'PG_DUMP_UNREADABLE')
  assert.equal(rb.restoreVerification, 'FAIL')
})
