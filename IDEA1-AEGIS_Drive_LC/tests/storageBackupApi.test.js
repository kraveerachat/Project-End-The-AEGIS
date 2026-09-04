// tests/storageBackupApi.test.js — AEGIS Drive (IDEA1) · /api/storage + /api/backup/*
//
// Fired through the real Express app. Both host agents are stood up as
// controllable fakes on temp sockets: nothing here touches a real device, a
// real restic repository, or a real database dump.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { Client, DEMO_ADMIN, DEMO_USER, performLogin } from './helpers/testClient.mjs'
import { agentStatus } from './fixtures/backupAgentStatus.js'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-storage-backup-api-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'storage-backup-test-session-secret-not-used-in-production'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { closePool, readAudit } = await import('../server/db/connection.js')

const IS_WINDOWS = process.platform === 'win32'
let socketCounter = 0
const nextSocketPath = (tag) => {
  socketCounter += 1
  return IS_WINDOWS
    ? `\\\\.\\pipe\\aegis-${tag}-${process.pid}-${socketCounter}`
    : path.join(os.tmpdir(), `aegis-${tag}-${process.pid}-${socketCounter}.sock`)
}

const agents = []
async function fakeAgent(envVar, tag, handler) {
  const socketPath = nextSocketPath(tag)
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(socketPath, resolve))
  agents.push(server)
  process.env[envVar] = socketPath
  return socketPath
}
const absentAgent = (envVar, tag) => { process.env[envVar] = nextSocketPath(tag) }

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
const readBody = (req) => new Promise((resolve) => { let t = ''; req.setEncoding('utf8'); req.on('data', (c) => { t += c }); req.on('end', () => resolve(t ? JSON.parse(t) : {})) })

const healthyDiskDocument = () => ({
  schemaVersion: 1,
  measuredAt: new Date(Date.now() - 120_000).toISOString(),
  device: 'sda',
  disk: { available: true, model: 'AEGIS-FIXTURE M.2 2280 128GB', smart: { supported: true, enabled: true, passed: true }, temperatureCelsius: 41, powerOnHours: 3210, capacityBytes: 128035676160, warnings: [] },
})
const telemetryV1 = () => ({
  schemaVersion: 1, measuredAt: new Date().toISOString(),
  metrics: { cpu: { available: false }, memory: { available: false }, network: { available: false }, uptime: { available: false } },
})

/** A telemetry agent serving both routes. */
const telemetryAgent = (diskDocument) => (req, res) => {
  if (req.url === '/internal/disk-health') return json(res, 200, diskDocument)
  if (req.url === '/internal/telemetry') return json(res, 200, telemetryV1())
  return json(res, 404, { error: 'not-found' })
}

/** A backup agent with a scripted status and recorded commands. */
function backupAgent({ status, commands = [] } = {}) {
  return async (req, res) => {
    if (req.method === 'GET' && req.url === '/internal/backup/status') return json(res, 200, status())
    const body = await readBody(req)
    commands.push({ url: req.url, body })
    if (req.url === '/internal/backup/policy') {
      if (body.activeTargetId && body.activeTargetId !== 'usb-external-1') return json(res, 400, { error: 'invalid-policy', reason: 'not allowlisted' })
      return json(res, 200, { ok: true, policy: { activeTargetId: body.activeTargetId ?? null, scheduleId: body.scheduleId ?? 'disabled', retentionId: body.retentionId ?? 'keep-7d-4w', enabled: Boolean(body.enabled) } })
    }
    if (req.url === '/internal/backup/run' || req.url === '/internal/backup/verify') return json(res, 202, { ok: true, jobId: 'abcdef12-3456-7890-abcd-ef1234567890', reason: null })
    if (req.url === '/internal/backup/quiesced') return json(res, 200, { ok: true })
    return json(res, 404, { error: 'not-found' })
  }
}

let server
let baseUrl
let admin
let user

before(async () => {
  await initStorage()
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  admin = new Client(baseUrl)
  await performLogin(admin, DEMO_ADMIN.username, DEMO_ADMIN.password)
  user = new Client(baseUrl)
  await performLogin(user, DEMO_USER.username, DEMO_USER.password)
})

after(async () => {
  for (const agent of agents) await new Promise((resolve) => agent.close(resolve))
  await new Promise((resolve) => server.close(resolve))
  await closePool()
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  delete process.env.AEGIS_TELEMETRY_SOCKET
  delete process.env.AEGIS_BACKUP_SOCKET
})

// ── /api/storage ──────────────────────────────────────────────────────
test('STORAGE-1 unauthenticated callers get 401 and nothing about the host', async () => {
  await fakeAgent('AEGIS_TELEMETRY_SOCKET', 'telemetry', telemetryAgent(healthyDiskDocument()))
  const res = await new Client(baseUrl).req('/api/storage')
  assert.equal(res.status, 401)
  assert.equal(JSON.stringify(res.data).includes('AEGIS-FIXTURE'), false)
})

test('STORAGE-2 with both agents absent every new section is truthfully unavailable and capacity is unchanged', async () => {
  absentAgent('AEGIS_TELEMETRY_SOCKET', 'telemetry')
  absentAgent('AEGIS_BACKUP_SOCKET', 'backup')
  const res = await user.req('/api/storage')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')
  const d = res.data
  assert.ok(d.capacityBytes.totalBytes > 0)
  assert.equal(d.capacityBytes.usedBytes + d.capacityBytes.freeBytes, d.capacityBytes.totalBytes)
  assert.deepEqual(Object.keys(d.usage).sort(), ['archives', 'docs', 'media', 'other', 'vaultSeg', 'versions'])
  assert.equal(d.diskHealth.available, false)
  assert.equal(d.diskHealth.status, 'UNKNOWN')
  assert.equal(d.diskHealth.reason, 'agent-unreachable')
  assert.equal(d.raid.status, 'NOT_CONFIGURED')
  assert.equal(d.backup.available, false)
  assert.equal(d.backup.risk, 'UNKNOWN')
  assert.equal(d.backup.successRate30d, null)
  assert.equal(d.unavailable.diskHealth, 'agent-unreachable')
  assert.equal(d.unavailable.backups, 'agent-unreachable')
  assert.equal(d.unavailable.raid, 'not-configured')
  assert.equal(d.maintenance.active, false)
})

test('STORAGE-3 a healthy disk document renders HEALTHY with model, temperature and hours, and the serial never appears', async () => {
  await fakeAgent('AEGIS_TELEMETRY_SOCKET', 'telemetry', telemetryAgent(healthyDiskDocument()))
  const res = await user.req('/api/storage')
  assert.equal(res.data.diskHealth.available, true)
  assert.equal(res.data.diskHealth.status, 'HEALTHY')
  assert.equal(res.data.diskHealth.model, 'AEGIS-FIXTURE M.2 2280 128GB')
  assert.equal(res.data.diskHealth.temperatureCelsius, 41)
  assert.equal(res.data.diskHealth.powerOnHours, 3210)
  assert.equal(res.data.diskHealth.device, 'sda')
  assert.equal('diskHealth' in res.data.unavailable, false)
  assert.equal(JSON.stringify(res.data).includes('serial'), false)
})

test('STORAGE-4 SMART failure is CRITICAL; a warning attribute is WARNING; an unreported SMART status is UNKNOWN', async () => {
  const base = healthyDiskDocument()
  await fakeAgent('AEGIS_TELEMETRY_SOCKET', 'telemetry', telemetryAgent({ ...base, disk: { ...base.disk, smart: { supported: true, enabled: true, passed: false }, warnings: ['smart-failed', 'reallocated-sectors'] } }))
  assert.equal((await user.req('/api/storage')).data.diskHealth.status, 'CRITICAL')
  await fakeAgent('AEGIS_TELEMETRY_SOCKET', 'telemetry', telemetryAgent({ ...base, disk: { ...base.disk, warnings: ['pending-sectors'] } }))
  assert.equal((await user.req('/api/storage')).data.diskHealth.status, 'WARNING')
  await fakeAgent('AEGIS_TELEMETRY_SOCKET', 'telemetry', telemetryAgent({ ...base, disk: { ...base.disk, smart: { supported: true, enabled: true, passed: null } } }))
  const unknown = (await user.req('/api/storage')).data.diskHealth
  assert.equal(unknown.status, 'UNKNOWN')
  assert.equal(unknown.reason, 'smart-status-not-reported')
})

test('STORAGE-5 smartctl absent on the host, an unsupported temperature, a stale reading, and a malformed body are each honest', async () => {
  const base = healthyDiskDocument()
  await fakeAgent('AEGIS_TELEMETRY_SOCKET', 'telemetry', telemetryAgent({ ...base, device: null, disk: { available: false, reason: 'smartctl-absent' } }))
  let disk = (await user.req('/api/storage')).data.diskHealth
  assert.equal(disk.available, false)
  assert.equal(disk.reason, 'smartctl-absent')
  assert.equal(disk.status, 'UNKNOWN')

  await fakeAgent('AEGIS_TELEMETRY_SOCKET', 'telemetry', telemetryAgent({ ...base, disk: { ...base.disk, temperatureCelsius: null } }))
  disk = (await user.req('/api/storage')).data.diskHealth
  assert.equal(disk.status, 'HEALTHY')
  assert.equal(disk.temperatureCelsius, null, 'unsupported = null, never 0')

  await fakeAgent('AEGIS_TELEMETRY_SOCKET', 'telemetry', telemetryAgent({ ...base, measuredAt: new Date(Date.now() - 2 * 3600_000).toISOString() }))
  disk = (await user.req('/api/storage')).data.diskHealth
  assert.equal(disk.stale, true)
  assert.equal(disk.status, 'UNKNOWN')
  assert.equal(disk.reason, 'stale')
  assert.equal(disk.model, 'AEGIS-FIXTURE M.2 2280 128GB')

  await fakeAgent('AEGIS_TELEMETRY_SOCKET', 'telemetry', telemetryAgent({ ...base, disk: { ...base.disk, serialNumber: 'LEAK', warnings: [] } }))
  disk = (await user.req('/api/storage')).data.diskHealth
  assert.equal(disk.available, false)
  assert.equal(disk.reason, 'disk-unexpected-key')
  assert.equal(JSON.stringify(disk).includes('LEAK'), false)
})

test('STORAGE-6 backup: not configured, same-disk target, ready target, and a successful job derive the documented states', async () => {
  const commands = []
  let status = () => agentStatus({ policy: { activeTargetId: null, scheduleId: 'disabled', retentionId: 'keep-7d-4w', enabled: false }, target: null, state: 'NOT_CONFIGURED', nextRun: null, measuredAt: new Date().toISOString() })
  await fakeAgent('AEGIS_BACKUP_SOCKET', 'backup', backupAgent({ status: () => status(), commands }))
  let backup = (await user.req('/api/storage')).data
  assert.equal(backup.backup.state, 'NOT_CONFIGURED')
  assert.equal(backup.backup.risk, 'NOT_CONFIGURED')
  assert.equal(backup.unavailable.backups, 'not-configured')

  status = () => agentStatus({ state: 'SAME_FAILURE_DOMAIN', target: { id: 'usb-external-1', label: 'Same disk', type: 'external-mount', protection: 'SAME_FAILURE_DOMAIN' }, measuredAt: new Date().toISOString() })
  backup = (await user.req('/api/storage')).data
  assert.equal(backup.backup.state, 'SAME_FAILURE_DOMAIN')
  assert.equal(backup.backup.risk, 'NOT_CONFIGURED')
  assert.notEqual(backup.backup.risk, 'HEALTHY')

  status = () => agentStatus({ measuredAt: new Date().toISOString() })
  backup = (await user.req('/api/storage')).data
  assert.equal(backup.backup.state, 'READY')
  assert.equal(backup.backup.risk, 'CRITICAL', 'READY with no successful job is not protected')
  assert.equal('backups' in backup.unavailable, false)

  const now = Date.now()
  status = () => agentStatus({
    measuredAt: new Date().toISOString(),
    history: [
      { jobId: '11111111-1111-1111-1111-111111111111', kind: 'backup', trigger: 'manual', startedAt: new Date(now - 3600_000).toISOString(), finishedAt: new Date(now - 3500_000).toISOString(), status: 'SUCCESS', targetId: 'usb-external-1', targetType: 'external-mount', protection: 'DIFFERENT_DEVICE', bytesScanned: 18_300_000_000, bytesBackedUp: 250_000_000, snapshotId: 'abc123', integrityCheck: 'PASS', restoreVerification: 'NOT_TESTED', errorCode: null },
      { jobId: '22222222-2222-2222-2222-222222222222', kind: 'verify', trigger: 'manual', startedAt: new Date(now - 1800_000).toISOString(), finishedAt: new Date(now - 1700_000).toISOString(), status: 'SUCCESS', targetId: 'usb-external-1', targetType: 'external-mount', protection: 'DIFFERENT_DEVICE', bytesScanned: null, bytesBackedUp: null, snapshotId: null, integrityCheck: 'PASS', restoreVerification: 'PASS', errorCode: null },
    ],
  })
  backup = (await user.req('/api/storage')).data.backup
  assert.equal(backup.risk, 'HEALTHY')
  assert.equal(backup.successRate30d, 100)
  assert.equal(backup.bytesCovered, 18_300_000_000)
  assert.equal(backup.integrity, 'PASS')
  assert.equal(backup.restoreVerification.status, 'PASS')
  assert.equal(backup.lastSnapshotId, 'abc123')
})

test('STORAGE-7 a malformed backup status is rejected and never partially trusted', async () => {
  await fakeAgent('AEGIS_BACKUP_SOCKET', 'backup', backupAgent({ status: () => ({ ...agentStatus({ measuredAt: new Date().toISOString() }), history: [{ jobId: 'x', stderr: 'restic: Fatal: wrong password for /etc/aegis/restic' }] }) }))
  const d = (await user.req('/api/storage')).data
  assert.equal(d.backup.available, false)
  assert.equal(d.backup.risk, 'UNKNOWN')
  assert.ok(d.backup.reason.startsWith('agent-data-invalid'))
  assert.equal(JSON.stringify(d).includes('wrong password'), false)
})

// ── /api/backup (Admin) ───────────────────────────────────────────────
test('BACKUP-API-1 the admin surface is Admin-only; a DataLake-User gets 403 on every route', async () => {
  await fakeAgent('AEGIS_BACKUP_SOCKET', 'backup', backupAgent({ status: () => agentStatus({ measuredAt: new Date().toISOString() }) }))
  assert.equal((await new Client(baseUrl).req('/api/backup')).status, 401)
  assert.equal((await user.req('/api/backup')).status, 403)
  assert.equal((await user.req('/api/backup/policy', { method: 'PATCH', body: { enabled: true } })).status, 403)
  assert.equal((await user.req('/api/backup/run', { method: 'POST' })).status, 403)
  assert.equal((await user.req('/api/backup/verify', { method: 'POST' })).status, 403)

  const view = await admin.req('/api/backup')
  assert.equal(view.status, 200)
  assert.equal(view.headers.get('cache-control'), 'no-store')
  assert.deepEqual(Object.keys(view.data).sort(), ['allowed', 'history', 'limits', 'report', 'targets', 'tools'])
  assert.equal(view.data.targets[0].protection, 'DIFFERENT_DEVICE')
  assert.ok(view.data.allowed.scheduleIds.includes('daily-02:00'))
})

test('BACKUP-API-2 policy updates forward allowlisted IDs only, are audited, and reject anything path-shaped', async () => {
  const commands = []
  await fakeAgent('AEGIS_BACKUP_SOCKET', 'backup', backupAgent({ status: () => agentStatus({ measuredAt: new Date().toISOString() }), commands }))
  const ok = await admin.req('/api/backup/policy', { method: 'PATCH', body: { activeTargetId: 'usb-external-1', scheduleId: 'daily-02:00', retentionId: 'keep-7d-4w', enabled: true } })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.policy.activeTargetId, 'usb-external-1')
  assert.deepEqual(commands[0], { url: '/internal/backup/policy', body: { activeTargetId: 'usb-external-1', scheduleId: 'daily-02:00', retentionId: 'keep-7d-4w', enabled: true } })

  for (const bad of [{ activeTargetId: '/mnt/evil' }, { scheduleId: '* * * * *' }, { enabled: 'yes' }, { mountPoint: '/mnt/x' }, { command: 'restic init' }]) {
    const res = await admin.req('/api/backup/policy', { method: 'PATCH', body: bad })
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused by Drive`)
  }
  assert.equal(commands.length, 1, 'nothing path-shaped ever reached the agent')

  const notAllowlisted = await admin.req('/api/backup/policy', { method: 'PATCH', body: { activeTargetId: 'not-in-list' } })
  assert.equal(notAllowlisted.status, 400)
  assert.equal(notAllowlisted.data.reason, 'rejected-by-agent')

  const audit = await readAudit(50)
  const configEvents = audit.filter((e) => e.action === 'BACKUP_CONFIG_UPDATE')
  assert.ok(configEvents.some((e) => e.result === 'OK'))
  assert.ok(configEvents.some((e) => e.result === 'DENIED'))
  assert.equal(JSON.stringify(audit).includes('/mnt/evil'), false, 'the audit log never carries the rejected path')
})

test('BACKUP-API-3 run and verify are forwarded, answer 202 with the job id, and are audited as requests', async () => {
  const commands = []
  await fakeAgent('AEGIS_BACKUP_SOCKET', 'backup', backupAgent({ status: () => agentStatus({ measuredAt: new Date().toISOString() }), commands }))
  const run = await admin.req('/api/backup/run', { method: 'POST' })
  assert.equal(run.status, 202)
  assert.equal(run.data.jobId, 'abcdef12-3456-7890-abcd-ef1234567890')
  const verify = await admin.req('/api/backup/verify', { method: 'POST' })
  assert.equal(verify.status, 202)
  assert.deepEqual(commands.map((c) => c.url), ['/internal/backup/run', '/internal/backup/verify'])
  const audit = await readAudit(50)
  assert.ok(audit.some((e) => e.action === 'BACKUP_RUN_REQUEST' && e.result === 'OK'))
  assert.ok(audit.some((e) => e.action === 'BACKUP_VERIFY_REQUEST' && e.result === 'OK'))
})

test('BACKUP-API-4 an absent agent makes every command 503 (audited DENIED) and the view honest', async () => {
  absentAgent('AEGIS_BACKUP_SOCKET', 'backup')
  const run = await admin.req('/api/backup/run', { method: 'POST' })
  assert.equal(run.status, 503)
  assert.equal(run.data.reason, 'agent-unreachable')
  const view = await admin.req('/api/backup')
  assert.equal(view.status, 200)
  assert.equal(view.data.report.available, false)
  assert.deepEqual(view.data.targets, [])
  const audit = await readAudit(50)
  assert.ok(audit.some((e) => e.action === 'BACKUP_RUN_REQUEST' && e.result === 'DENIED'))
})

test('BACKUP-API-5 a refusal from the agent (busy / not configured) is a 409, not a 500', async () => {
  await fakeAgent('AEGIS_BACKUP_SOCKET', 'backup', async (req, res) => {
    if (req.url === '/internal/backup/status') return json(res, 200, agentStatus({ measuredAt: new Date().toISOString() }))
    await readBody(req)
    return json(res, 409, { ok: false, jobId: null, reason: 'busy' })
  })
  const run = await admin.req('/api/backup/run', { method: 'POST' })
  assert.equal(run.status, 409)
  assert.equal(run.data.reason, 'busy')
})
