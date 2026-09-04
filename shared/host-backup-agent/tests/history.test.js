// tests/history.test.js — sanitized job history
import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_JOBS, createHistoryStore, sanitizeJob } from '../src/history.js'
import { memoryFs } from './helpers.js'

const job = (overrides = {}) => ({
  jobId: '4f0c3d2e-1111-2222-3333-444455556666', kind: 'backup', trigger: 'manual',
  startedAt: '2026-09-03T02:00:00.000Z', finishedAt: '2026-09-03T02:04:00.000Z', status: 'SUCCESS',
  targetId: 'usb-external-1', targetType: 'external-mount', protection: 'DIFFERENT_DEVICE',
  bytesScanned: 18_300_000_000, bytesBackedUp: 250_000_000, snapshotId: 'abc123',
  integrityCheck: 'PASS', restoreVerification: 'NOT_TESTED', errorCode: null,
  ...overrides,
})

test('HIST-1 sanitizeJob keeps the contract fields and drops everything else', () => {
  const clean = sanitizeJob({ ...job(), commandLine: 'restic backup --password secret', stderr: 'boom', repositoryPassword: 'x' })
  assert.deepEqual(Object.keys(clean).sort(), [
    'bytesBackedUp', 'bytesScanned', 'errorCode', 'finishedAt', 'integrityCheck', 'jobId', 'kind', 'protection',
    'restoreVerification', 'snapshotId', 'startedAt', 'status', 'targetId', 'targetType', 'trigger',
  ])
  assert.equal(JSON.stringify(clean).includes('secret'), false)
})

test('HIST-2 off-contract values are normalised or the record is refused', () => {
  assert.equal(sanitizeJob(job({ errorCode: 'rm -rf / failed' })).errorCode, null)
  assert.equal(sanitizeJob(job({ integrityCheck: 'ok' })).integrityCheck, 'NOT_RUN')
  assert.equal(sanitizeJob(job({ restoreVerification: 'yes' })).restoreVerification, 'NOT_TESTED')
  assert.equal(sanitizeJob(job({ bytesBackedUp: -1 })).bytesBackedUp, null)
  assert.equal(sanitizeJob(job({ status: 'GREEN' })), null)
  assert.equal(sanitizeJob(job({ jobId: '../x' })), null)
  assert.equal(sanitizeJob(job({ startedAt: 'yesterday' })), null)
})

test('HIST-3 upsert finalises a RUNNING record in place, caps the file, and survives a corrupt file', async () => {
  const fs = memoryFs()
  fs.files.set('/var/lib/aegis-backup/jobs.json', '{corrupt')
  const store = createHistoryStore({ stateDir: '/var/lib/aegis-backup', fs })
  assert.deepEqual(await store.list(), [], 'a corrupt history never invents a past job')

  await store.upsert(job({ status: 'RUNNING', finishedAt: null }))
  await store.upsert(job({ status: 'SUCCESS' }))
  const list = await store.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].status, 'SUCCESS')

  for (let i = 0; i < MAX_JOBS + 5; i += 1) await store.upsert(job({ jobId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` }))
  assert.equal((await store.list()).length, MAX_JOBS)
  await assert.rejects(store.upsert({ jobId: 'x' }), /off-contract/)
})
