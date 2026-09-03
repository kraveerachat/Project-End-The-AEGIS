// tests/server.test.js — the socket contract Drive consumes
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { createHistoryStore } from '../src/history.js'
import { createJobRunner } from '../src/job.js'
import { createPolicyStore } from '../src/policy.js'
import { ROUTES, createBackupServer, deriveBackupState } from '../src/server.js'
import { classifyTarget } from '../src/targets.js'
import { fakeClock, fakeRestic, fixtureConfig, memoryFs, productionTargetDeps, settle } from './helpers.js'

const IS_WINDOWS = process.platform === 'win32'
let counter = 0
const socketPathFor = () => {
  counter += 1
  return IS_WINDOWS ? `\\\\.\\pipe\\aegis-backup-test-${process.pid}-${counter}` : path.join(os.tmpdir(), `aegis-backup-test-${process.pid}-${counter}.sock`)
}

function request(socketPath, route, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body))
    const req = http.request({ socketPath, path: route, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function stand({ restic = fakeRestic() } = {}) {
  // Validated with the production socket path, then pointed at a per-test
  // socket (a Windows named pipe is not a POSIX-absolute path and must not
  // be something the validator accepts in production).
  const config = { ...fixtureConfig(), socketPath: socketPathFor() }
  const fs = memoryFs()
  const clock = fakeClock()
  const deps = productionTargetDeps()
  const classify = (target) => classifyTarget(target, { datalakePath: config.source.datalakePath, ...deps })
  const policyStore = createPolicyStore({ stateDir: config.stateDir, config, fs })
  const history = createHistoryStore({ stateDir: config.stateDir, fs })
  const runner = createJobRunner({
    config, policyStore, history, resticFor: () => restic, classify,
    dumpDatabase: async () => ({ ok: true }), verifyDumpReadable: async () => ({ ok: true, entries: 2 }),
    now: clock.now, fs, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  })
  const server = createBackupServer({ config, policyStore, history, runner, classify, now: clock.now, fs, tools: { resticPresent: true, pgDumpPresent: true } })
  await server.start()
  return { config, server, runner, clock, policyStore, socketPath: config.socketPath }
}

test('SRV-1 status before any configuration is NOT_CONFIGURED with an honest empty history', async () => {
  const s = await stand()
  try {
    const res = await request(s.socketPath, ROUTES.STATUS)
    assert.equal(res.status, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.deepEqual(Object.keys(res.body).sort(), [
      'allowed', 'engine', 'history', 'job', 'lastBackupAt', 'limits', 'measuredAt', 'nextRun', 'policy', 'schemaVersion', 'state', 'target', 'targets', 'tools',
    ])
    assert.equal(res.body.state, 'NOT_CONFIGURED')
    assert.equal(res.body.target, null)
    assert.equal(res.body.nextRun, null)
    assert.deepEqual(res.body.history, [])
    assert.equal(res.body.engine, 'restic')
    // Every allowlisted target is classified so the Admin can see which are protected before choosing.
    assert.deepEqual(res.body.targets.map((t) => [t.id, t.protection]), [
      ['usb-external-1', 'DIFFERENT_DEVICE'], ['same-disk-dir', 'NOT_MOUNTED'], ['offsite-sftp', 'OFF_HOST'],
    ])
  } finally {
    await s.server.stop()
  }
})

test('SRV-2 the status body never carries a credential file path, a repository password, or a command line', async () => {
  const s = await stand()
  try {
    const res = await request(s.socketPath, ROUTES.STATUS)
    const dump = JSON.stringify(res.body)
    for (const forbidden of ['passwordFile', 'pgpass', 'restic-password', 'PGPASSFILE', 'RESTIC_PASSWORD', '/usr/bin/restic', 'sftp:aegis@', '/mnt/aegis-backup/aegis-restic']) {
      assert.equal(dump.includes(forbidden), false, `${forbidden} must not cross the socket`)
    }
  } finally {
    await s.server.stop()
  }
})

test('SRV-3 policy updates are validated against the allowlist and change the derived state', async () => {
  const s = await stand()
  try {
    const bad = await request(s.socketPath, ROUTES.POLICY, { method: 'POST', body: { activeTargetId: '/mnt/evil' } })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error, 'invalid-policy')
    const unknownKey = await request(s.socketPath, ROUTES.POLICY, { method: 'POST', body: { activeTargetId: 'usb-external-1', command: 'x' } })
    assert.equal(unknownKey.status, 400)

    const sameDisk = await request(s.socketPath, ROUTES.POLICY, { method: 'POST', body: { activeTargetId: 'same-disk-dir' } })
    assert.equal(sameDisk.status, 200)
    assert.equal((await request(s.socketPath, ROUTES.STATUS)).body.state, 'TARGET_UNAVAILABLE')

    const ok = await request(s.socketPath, ROUTES.POLICY, { method: 'POST', body: { activeTargetId: 'usb-external-1', scheduleId: 'daily-02:00', retentionId: 'keep-7d-4w', enabled: true } })
    assert.equal(ok.status, 200)
    const status = (await request(s.socketPath, ROUTES.STATUS)).body
    assert.equal(status.state, 'READY')
    assert.equal(status.target.protection, 'DIFFERENT_DEVICE')
    assert.ok(status.nextRun, 'an enabled schedule with a target has a next run')
    assert.equal(status.history.length, 0, 'READY from configuration alone — no job is invented')
  } finally {
    await s.server.stop()
  }
})

test('SRV-4 run -> RUNNING with quiesceRequired; quiesced ack; completion lands in history', async () => {
  const s = await stand()
  try {
    await request(s.socketPath, ROUTES.POLICY, { method: 'POST', body: { activeTargetId: 'usb-external-1' } })
    const run = await request(s.socketPath, ROUTES.RUN, { method: 'POST' })
    assert.equal(run.status, 202)
    assert.equal(run.body.ok, true)
    await settle()
    const running = (await request(s.socketPath, ROUTES.STATUS)).body
    assert.equal(running.state, 'RUNNING')
    assert.equal(running.job.phase, 'QUIESCE_REQUESTED')
    assert.equal(running.job.quiesceRequired, true)
    assert.equal(running.job.jobId, run.body.jobId)

    const busy = await request(s.socketPath, ROUTES.RUN, { method: 'POST' })
    assert.equal(busy.status, 409)
    assert.equal(busy.body.reason, 'busy')

    const badAck = await request(s.socketPath, ROUTES.QUIESCED, { method: 'POST', body: { jobId: 'nope' } })
    assert.equal(badAck.status, 409)
    const ack = await request(s.socketPath, ROUTES.QUIESCED, { method: 'POST', body: { jobId: run.body.jobId } })
    assert.equal(ack.status, 200)
    await settle(50)
    const after = (await request(s.socketPath, ROUTES.STATUS)).body
    assert.equal(after.state, 'READY')
    assert.equal(after.job, null)
    assert.equal(after.history.length, 1)
    assert.equal(after.history[0].status, 'SUCCESS')
    assert.equal(after.history[0].integrityCheck, 'PASS')
    assert.equal(after.lastBackupAt, after.history[0].finishedAt)
  } finally {
    await s.server.stop()
  }
})

test('SRV-5 a run against an unprotected target is refused with a recorded FAILED job', async () => {
  const s = await stand()
  try {
    const run = await request(s.socketPath, ROUTES.RUN, { method: 'POST' })
    assert.equal(run.status, 409)
    assert.equal(run.body.reason, 'not-configured')
    const status = (await request(s.socketPath, ROUTES.STATUS)).body
    assert.equal(status.history[0].status, 'FAILED')
    assert.equal(status.history[0].errorCode, 'TARGET_NOT_CONFIGURED')
  } finally {
    await s.server.stop()
  }
})

test('SRV-6 unknown routes, wrong methods, malformed and oversized bodies are refused', async () => {
  const s = await stand()
  try {
    assert.equal((await request(s.socketPath, '/internal/backup/anything')).status, 404)
    assert.equal((await request(s.socketPath, ROUTES.STATUS, { method: 'POST' })).status, 405)
    assert.equal((await request(s.socketPath, ROUTES.RUN)).status, 405)
    assert.equal((await request(s.socketPath, ROUTES.POLICY, { method: 'POST', body: '{nope' })).status, 400)
    assert.equal((await request(s.socketPath, ROUTES.POLICY, { method: 'POST', body: '[]' })).status, 400)
    assert.equal((await request(s.socketPath, ROUTES.QUIESCED, { method: 'POST', body: {} })).status, 400)
    const big = await request(s.socketPath, ROUTES.POLICY, { method: 'POST', body: JSON.stringify({ x: 'y'.repeat(5000) }) }).catch((err) => ({ status: 'aborted', err }))
    assert.ok(big.status === 413 || big.status === 'aborted')
  } finally {
    await s.server.stop()
  }
})

test('SRV-7 deriveBackupState is exhaustive and never READY from an unknown classification', () => {
  const target = { id: 't' }
  assert.equal(deriveBackupState({ target: null, classification: null, running: false }), 'NOT_CONFIGURED')
  assert.equal(deriveBackupState({ target, classification: null, running: false }), 'TARGET_UNAVAILABLE')
  assert.equal(deriveBackupState({ target, classification: { protection: 'SAME_FAILURE_DOMAIN' }, running: false }), 'SAME_FAILURE_DOMAIN')
  assert.equal(deriveBackupState({ target, classification: { protection: 'NOT_MOUNTED' }, running: false }), 'TARGET_UNAVAILABLE')
  assert.equal(deriveBackupState({ target, classification: { protection: 'UNKNOWN' }, running: false }), 'TARGET_UNAVAILABLE')
  assert.equal(deriveBackupState({ target, classification: { protection: 'DIFFERENT_DEVICE' }, running: false }), 'READY')
  assert.equal(deriveBackupState({ target, classification: { protection: 'OFF_HOST' }, running: false }), 'READY')
  assert.equal(deriveBackupState({ target, classification: { protection: 'OFF_HOST' }, running: true }), 'RUNNING')
})

test('SRV-8 the listener is path-addressed; no TCP port exists', async () => {
  const s = await stand()
  try {
    const address = s.server.address()
    assert.equal(typeof address, 'string')
  } finally {
    await s.server.stop()
  }
})
