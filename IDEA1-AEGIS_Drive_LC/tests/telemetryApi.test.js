// tests/telemetryApi.test.js — AEGIS Drive (IDEA1) · GET /api/telemetry
//
// Fired through the same Express app production runs (server/app.js), so
// securityHeaders / session / CSRF / requireAuth all execute for real.
//
// The host agent is stood up as a controllable fake on a temp socket. Nothing
// here touches a real /proc, a real host, or production runtime.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { Client, DEMO_ADMIN, DEMO_USER, performLogin } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-telemetry-api-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'telemetry-test-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { closePool, readAudit } = await import('../server/db/connection.js')

const IS_WINDOWS = process.platform === 'win32'
let socketCounter = 0
const nextSocketPath = () => {
  socketCounter += 1
  return IS_WINDOWS
    ? `\\\\.\\pipe\\aegis-telemetry-api-${process.pid}-${socketCounter}`
    : path.join(os.tmpdir(), `aegis-telemetry-api-${process.pid}-${socketCounter}.sock`)
}

/** A host snapshot measured `ageSeconds` ago, from Drive's point of view. */
const hostSnapshot = ({ ageSeconds = 2, overrides = {} } = {}) => ({
  schemaVersion: 1,
  measuredAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
  metrics: {
    cpu: { available: true, percent: 12.5, windowSeconds: 5 },
    memory: { available: true, usedBytes: 3_150_000_000, totalBytes: 8_333_651_968, percent: 37.8 },
    network: { available: true, interface: 'enp1s0', rxBytesPerSec: 1024, txBytesPerSec: 512, windowSeconds: 5 },
    uptime: { available: true, hostSeconds: 86_400.55 },
    ...overrides,
  },
})

const agents = []
/** Point Drive at a fake agent for the duration of one test. */
async function useFakeAgent(handler) {
  const socketPath = nextSocketPath()
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(socketPath, resolve))
  agents.push(server)
  process.env.AEGIS_TELEMETRY_SOCKET = socketPath
  return socketPath
}

/** Point Drive at a socket where nothing is listening. */
function useAbsentAgent() {
  process.env.AEGIS_TELEMETRY_SOCKET = nextSocketPath()
}

const respondWith = (body, status = 200) => (_req, res) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

let server
let baseUrl
let admin

before(async () => {
  await initStorage()
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  admin = new Client(baseUrl)
  await performLogin(admin, DEMO_ADMIN.username, DEMO_ADMIN.password)
})

after(async () => {
  for (const agent of agents) await new Promise((resolve) => agent.close(resolve))
  await new Promise((resolve) => server.close(resolve))
  await closePool()
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  delete process.env.AEGIS_TELEMETRY_SOCKET
})

// ── TELEM-API-1 ───────────────────────────────────────────────────────
test('TELEM-API-1 an unauthenticated request is rejected', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const anonymous = new Client(baseUrl)
  const res = await anonymous.req('/api/telemetry')

  assert.equal(res.status, 401)
  assert.equal(res.data.error, 'Not authenticated')
  // Nothing about the host may leak to a caller with no session.
  assert.equal(res.data.metrics, undefined)
  assert.equal(JSON.stringify(res.data).includes('enp1s0'), false)
})

// ── TELEM-API-2 / TELEM-API-3 ─────────────────────────────────────────
test('TELEM-API-2 an authenticated request succeeds', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const res = await admin.req('/api/telemetry')
  assert.equal(res.status, 200)
  assert.deepEqual(
    Object.keys(res.data).sort(),
    ['maxAgeSeconds', 'measuredAt', 'metrics', 'ok', 'schemaVersion', 'stale'],
  )
})

// ── TELEM-API-11 · host counters are Admin-scoped ─────────────────────
// A DataLake-User keeps exactly what Drive already showed them elsewhere: Data
// Lake capacity (also on /api/storage) and Drive's own process uptime. Host
// counters are not theirs: RAM size, live CPU, the NIC name, throughput and
// host uptime together describe the machine, and host uptime in particular
// discloses the patch window. Withheld is reported with its own reason so the
// screen can say "not available to your role" instead of the untrue
// "could not be measured".
test('TELEM-API-11 a non-admin user reads Drive-measured telemetry only', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const user = new Client(baseUrl)
  await performLogin(user, DEMO_USER.username, DEMO_USER.password)
  const res = await user.req('/api/telemetry')

  assert.equal(res.status, 200, 'a non-admin still gets a response, not a 403')
  for (const name of ['cpu', 'memory', 'network']) {
    assert.equal(res.data.metrics[name].available, false, `${name} must be withheld`)
    assert.equal(res.data.metrics[name].reason, 'requires-admin')
  }
  assert.equal(res.data.metrics.uptime.host.available, false)
  assert.equal(res.data.metrics.uptime.host.reason, 'requires-admin')

  // What a DataLake-User keeps.
  assert.equal(res.data.metrics.disk.available, true)
  assert.equal(res.data.metrics.uptime.service.available, true)
  assert.ok(res.data.metrics.uptime.service.seconds >= 0)
})

test('TELEM-API-11 no host value survives anywhere in a non-admin response', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const user = new Client(baseUrl)
  await performLogin(user, DEMO_USER.username, DEMO_USER.password)
  const { data } = await user.req('/api/telemetry')

  // Two complementary checks, because neither alone is both sound and complete.
  //
  // 1) Structural: a withheld metric carries the availability flag and the
  //    reason, and nothing else. This is what actually proves no number leaked,
  //    including numbers this test did not think to name.
  for (const name of ['cpu', 'memory', 'network']) {
    assert.deepEqual(
      Object.keys(data.metrics[name]).sort(), ['available', 'reason'],
      `metrics.${name} must carry no value of any kind`,
    )
  }
  assert.deepEqual(Object.keys(data.metrics.uptime.host).sort(), ['available', 'reason'])

  // 2) Substring: only for values distinctive enough that a match cannot be a
  //    coincidence. Short numerics from the snapshot (12.5, 1024, 512) are
  //    deliberately NOT scanned for — they occur inside the real statfs byte
  //    counts this response legitimately carries, which would make the
  //    assertion fail at random. That is the same flake shape recorded for
  //    TELEM-SOCKET-5, and the structural check above already covers them.
  const body = JSON.stringify(data)
  for (const leak of ['enp1s0', '8333651968', '3150000000', '86400.55']) {
    assert.equal(body.includes(leak), false, `a non-admin response must not contain ${leak}`)
  }
})

test('TELEM-API-11 an Admin still receives the full host contract', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const res = await admin.req('/api/telemetry')

  assert.equal(res.data.metrics.cpu.available, true)
  assert.equal(res.data.metrics.memory.available, true)
  assert.equal(res.data.metrics.network.available, true)
  assert.equal(res.data.metrics.network.interface, 'enp1s0')
  assert.equal(res.data.metrics.uptime.host.available, true)
})

test('TELEM-API-11 withholding is not reported as a measurement failure', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const user = new Client(baseUrl)
  await performLogin(user, DEMO_USER.username, DEMO_USER.password)
  const res = await user.req('/api/telemetry')

  // `ok` answers "was everything this caller is entitled to actually measured".
  // A healthy agent the user is simply not shown must not read as degraded.
  assert.equal(res.data.ok, true, 'a complete in-scope response is ok')
  assert.equal(res.data.stale, false)
})

test('TELEM-API-3 a healthy agent is normalized into the Drive contract', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const { data } = await admin.req('/api/telemetry')

  assert.equal(data.schemaVersion, 1)
  assert.equal(data.ok, true)
  assert.equal(data.stale, false)
  assert.equal(data.maxAgeSeconds, 15)
  assert.deepEqual(
    Object.keys(data.metrics).sort(),
    ['cpu', 'disk', 'memory', 'network', 'twingate', 'uptime'],
  )

  assert.equal(data.metrics.cpu.percent, 12.5)
  assert.equal(data.metrics.memory.totalBytes, 8_333_651_968)
  assert.equal(data.metrics.network.interface, 'enp1s0')
  assert.equal(data.metrics.network.rxBytesPerSec, 1024)
  assert.equal(data.metrics.uptime.host.seconds, 86_400.55)
})

// ── TELEM-API-4 / TELEM-API-7 ─────────────────────────────────────────
test('TELEM-API-4 an absent agent yields truthful partial telemetry, not an error', async () => {
  useAbsentAgent()
  const res = await admin.req('/api/telemetry')

  assert.equal(res.status, 200, 'a dead agent must not fail a Drive request')
  assert.equal(res.data.ok, false)
  for (const name of ['cpu', 'memory', 'network']) {
    assert.equal(res.data.metrics[name].available, false, `${name} must be unavailable`)
  }
  assert.equal(res.data.metrics.uptime.host.available, false)
})

test('TELEM-API-7 disk stays available while the host agent is down', async () => {
  useAbsentAgent()
  const { data } = await admin.req('/api/telemetry')

  assert.equal(data.metrics.disk.available, true, 'Drive measures its own mount')
  assert.equal(data.metrics.disk.scope, 'datalake')
  assert.ok(data.metrics.disk.totalBytes > 0)
  assert.ok(data.metrics.disk.percent >= 0 && data.metrics.disk.percent <= 100)
  assert.deepEqual(data.metrics.disk.health, { available: false, reason: 'smart-not-observable' })
})

test('one unavailable host metric does not disable the others', async () => {
  await useFakeAgent(respondWith(hostSnapshot({ overrides: { cpu: { available: false } } })))
  const { data } = await admin.req('/api/telemetry')

  assert.equal(data.metrics.cpu.available, false)
  assert.equal(data.metrics.cpu.percent, undefined)
  assert.equal(data.metrics.memory.available, true)
  assert.equal(data.metrics.network.available, true)
  assert.equal(data.ok, false, 'ok reflects that not everything measurable was measured')
})

// ── TELEM-API-5 ───────────────────────────────────────────────────────
test('TELEM-API-5 host metrics older than the threshold are marked stale', async () => {
  await useFakeAgent(respondWith(hostSnapshot({ ageSeconds: 90 })))
  const { data } = await admin.req('/api/telemetry')

  assert.equal(data.stale, true)
  assert.equal(data.ok, false, 'stale is not ok')
  // Stale data is still shown — labelled, not blanked and not replaced by 0.
  assert.equal(data.metrics.cpu.available, true)
  assert.equal(data.metrics.cpu.percent, 12.5)
  assert.equal(data.metrics.cpu.stale, true)
  assert.equal(data.metrics.disk.stale, undefined, 'a Drive-local metric is never stale')
})

test('an unreachable agent is unavailable, which is not the same as stale', async () => {
  useAbsentAgent()
  const { data } = await admin.req('/api/telemetry')
  assert.equal(data.stale, false, 'there is no old measurement to be stale about')
  assert.equal(data.metrics.cpu.available, false)
})

// ── TELEM-API-6 ───────────────────────────────────────────────────────
test('TELEM-API-6 a malformed agent response fails closed', async () => {
  const cases = [
    ['percent out of range', hostSnapshot({ overrides: { cpu: { available: true, percent: 400, windowSeconds: 5 } } })],
    ['unknown schemaVersion', { ...hostSnapshot(), schemaVersion: 99 }],
    ['smuggled extra field', { ...hostSnapshot(), hostname: 'aegis-server' }],
    ['not json', '<html>nope</html>'],
    ['empty object', {}],
  ]

  for (const [label, body] of cases) {
    await useFakeAgent(respondWith(body))
    const res = await admin.req('/api/telemetry')

    assert.equal(res.status, 200, `${label}: Drive still answers`)
    assert.equal(res.data.ok, false, label)
    for (const name of ['cpu', 'memory', 'network']) {
      assert.equal(res.data.metrics[name].available, false, `${label}: ${name} must not be trusted`)
      assert.equal(res.data.metrics[name].percent, undefined, `${label}: no value may survive`)
    }
    assert.equal(res.data.metrics.disk.available, true, `${label}: Drive-local data is unaffected`)
  }
})

// ── TELEM-API-8 ───────────────────────────────────────────────────────
test('TELEM-API-8 Drive service uptime is reported separately from host uptime', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const { data } = await admin.req('/api/telemetry')

  assert.equal(data.metrics.uptime.host.available, true)
  assert.equal(data.metrics.uptime.host.seconds, 86_400.55)
  assert.equal(data.metrics.uptime.service.available, true)
  assert.ok(data.metrics.uptime.service.seconds >= 0)
  assert.notEqual(
    data.metrics.uptime.service.seconds, data.metrics.uptime.host.seconds,
    'the container process and the host did not boot at the same moment',
  )

  useAbsentAgent()
  const degraded = await admin.req('/api/telemetry')
  assert.equal(degraded.data.metrics.uptime.host.available, false)
  assert.equal(degraded.data.metrics.uptime.service.available, true, 'Drive always knows its own uptime')
})

// ── TELEM-API-9 ───────────────────────────────────────────────────────
test('TELEM-API-9 Twingate is explicitly unavailable with a stated reason', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const { data } = await admin.req('/api/telemetry')

  assert.deepEqual(data.metrics.twingate, {
    available: false,
    scope: 'server-connector',
    status: 'unavailable',
    reason: 'no-approved-source',
  })
  // ok is about measurable sources; Twingate has none by design and must not
  // drag the whole response down forever.
  assert.equal(data.ok, true)
})

// ── TELEM-API-10 ──────────────────────────────────────────────────────
test('TELEM-API-10 telemetry responses are never cached', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const res = await admin.req('/api/telemetry')
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

// ── audit hygiene ─────────────────────────────────────────────────────
test('polling telemetry does not write an audit event per request', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const before = (await readAudit(200)).length

  for (let i = 0; i < 8; i += 1) {
    assert.equal((await admin.req('/api/telemetry')).status, 200)
  }

  const after = (await readAudit(200)).length
  assert.equal(after, before, 'a dashboard polling every 10s would drown the audit log')
})

// ── TELEM-11D / TELEM-12 · response allowlist ─────────────────────────
test('TELEM-12 the response carries only approved telemetry keys', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const { data } = await admin.req('/api/telemetry')

  const allowed = {
    cpu: ['available', 'percent', 'windowSeconds', 'stale'],
    memory: ['available', 'usedBytes', 'totalBytes', 'percent', 'stale'],
    disk: ['available', 'scope', 'usedBytes', 'freeBytes', 'totalBytes', 'percent', 'health', 'reason'],
    network: ['available', 'interface', 'rxBytesPerSec', 'txBytesPerSec', 'windowSeconds', 'stale'],
    twingate: ['available', 'scope', 'status', 'reason'],
    uptime: ['available', 'host', 'service'],
  }
  for (const [name, keys] of Object.entries(allowed)) {
    for (const key of Object.keys(data.metrics[name])) {
      assert.ok(keys.includes(key), `metrics.${name}.${key} is not an approved telemetry key`)
    }
  }
})

test('TELEM-11D the response leaks no environment, user, container, or path detail', async () => {
  process.env.AEGIS_TELEMETRY_API_CANARY = 'canary-must-not-appear'
  await useFakeAgent(respondWith(hostSnapshot()))
  const res = await admin.req('/api/telemetry')
  const body = JSON.stringify(res.data)

  for (const needle of [
    'canary-must-not-appear', os.hostname(), os.userInfo().username,
    process.cwd(), STORAGE_ROOT, process.env.AEGIS_TELEMETRY_SOCKET,
  ]) {
    if (!needle) continue
    assert.ok(!body.includes(needle), `response must not contain ${JSON.stringify(needle)}`)
  }
  for (const word of ['password', 'token', 'secret', 'docker', 'container', 'csrf', 'session', '/datalake', '/proc', '/sys']) {
    assert.ok(!body.toLowerCase().includes(word.toLowerCase()), `response must not mention ${word}`)
  }
  delete process.env.AEGIS_TELEMETRY_API_CANARY
})

// ── TELEM-11F ─────────────────────────────────────────────────────────
test('TELEM-11F the browser cannot choose a path, an interface, or an agent', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  const baseline = (await admin.req('/api/telemetry')).data

  for (const query of [
    '?interface=eth0',
    '?path=/etc/passwd',
    '?socket=/var/run/docker.sock',
    '?root=/',
    '?scope=host',
  ]) {
    const res = await admin.req(`/api/telemetry${query}`)
    assert.equal(res.status, 200)
    // The query string must be inert: same interface, same disk scope.
    assert.equal(res.data.metrics.network.interface, baseline.metrics.network.interface)
    assert.equal(res.data.metrics.disk.scope, 'datalake')
  }
})

test('TELEM-11F a state-changing method on the telemetry route is not accepted', async () => {
  await useFakeAgent(respondWith(hostSnapshot()))
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await admin.req('/api/telemetry', { method })
    assert.ok(res.status >= 400, `${method} must not be served, got ${res.status}`)
  }
})
