// tests/twingateConnectorApi.test.js — AEGIS Drive (IDEA1) · GET /api/remote-access
//
// Fired through the same Express app production runs (server/app.js), so
// securityHeaders / session / CSRF / requireAuth all execute for real. The host
// agent is stood up as a controllable fake on a temp socket; nothing here
// touches a real host, a real Docker daemon, or production runtime.
//
// The property under test throughout: Drive reports LOCAL connector runtime
// health as measured evidence, and reports the Twingate CONTROL PLANE as not
// measured — separately, always, and with no path that lets the first imply
// the second.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { Client, DEMO_ADMIN, DEMO_USER, performLogin } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-twingate-api-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'twingate-test-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { closePool } = await import('../server/db/connection.js')
const {
  validateTwingateResponse, deriveConnectorStatus, TWINGATE_STALE_THRESHOLD_SECONDS,
} = await import('../server/telemetry/twingateHealthSchema.js')
const { CONTROL_PLANE_NOT_MEASURED } = await import('../server/telemetry/twingateHealth.js')

const IS_WINDOWS = process.platform === 'win32'
let socketCounter = 0
const nextSocketPath = () => {
  socketCounter += 1
  return IS_WINDOWS
    ? `\\\\.\\pipe\\aegis-twingate-api-${process.pid}-${socketCounter}`
    : path.join(os.tmpdir(), `aegis-twingate-api-${process.pid}-${socketCounter}.sock`)
}

/** Connector evidence measured `ageSeconds` ago, from Drive's point of view. */
const evidence = ({ ageSeconds = 5, connector = {} } = {}) => ({
  schemaVersion: 1,
  measuredAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
  connector: {
    available: true,
    runtimeState: 'RUNNING',
    health: 'HEALTHY',
    restartCount: 0,
    startedAt: '2026-09-01T08:30:00.000Z',
    ...connector,
  },
})

const agents = []
async function useFakeAgent(handler) {
  const socketPath = nextSocketPath()
  const server = http.createServer(handler)
  await new Promise((resolve) => server.listen(socketPath, resolve))
  agents.push(server)
  process.env.AEGIS_TELEMETRY_SOCKET = socketPath
  return socketPath
}

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

// ── Authorization ────────────────────────────────────────────────────────────

test('TWAPI-1 an unauthenticated request is rejected', async () => {
  await useFakeAgent(respondWith(evidence()))
  const anonymous = new Client(baseUrl)
  assert.equal((await anonymous.req('/api/remote-access')).status, 401)
})

test('TWAPI-2 any signed-in role may read the deployment posture', async () => {
  await useFakeAgent(respondWith(evidence()))
  const user = new Client(baseUrl)
  await performLogin(user, DEMO_USER.username, DEMO_USER.password)
  const res = await user.req('/api/remote-access')
  assert.equal(res.status, 200)
  assert.equal(res.data.localConnector.status, 'HEALTHY')
})

// ── The measured half ────────────────────────────────────────────────────────

test('TWAPI-3 a running, healthy connector is reported as HEALTHY with its real values', async () => {
  await useFakeAgent(respondWith(evidence({ connector: { restartCount: 3 } })))
  const res = await admin.req('/api/remote-access')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('cache-control'), 'no-store')

  const local = res.data.localConnector
  assert.equal(local.available, true)
  assert.equal(local.status, 'HEALTHY')
  assert.equal(local.runtimeState, 'RUNNING')
  assert.equal(local.health, 'HEALTHY')
  assert.equal(local.restartCount, 3)
  assert.equal(local.startedAt, '2026-09-01T08:30:00.000Z')
  assert.equal(local.stale, false)
  assert.equal(typeof local.measuredAt, 'string')
})

test('TWAPI-4 each runtime and health combination derives its own status', async () => {
  const cases = [
    [{ runtimeState: 'RUNNING', health: 'HEALTHY' }, 'HEALTHY'],
    [{ runtimeState: 'RUNNING', health: 'STARTING' }, 'STARTING'],
    [{ runtimeState: 'RUNNING', health: 'UNHEALTHY' }, 'UNHEALTHY'],
    // Running with no healthcheck must never read as healthy.
    [{ runtimeState: 'RUNNING', health: 'NOT_CONFIGURED' }, 'NOT_CONFIGURED'],
    [{ runtimeState: 'RUNNING', health: 'UNKNOWN' }, 'UNKNOWN'],
    [{ runtimeState: 'STOPPED', health: 'NOT_CONFIGURED' }, 'STOPPED'],
    [{ runtimeState: 'RESTARTING', health: 'UNHEALTHY' }, 'RESTARTING'],
    [{ runtimeState: 'UNKNOWN', health: 'HEALTHY' }, 'UNKNOWN'],
  ]
  for (const [connector, expected] of cases) {
    await useFakeAgent(respondWith(evidence({ connector })))
    const res = await admin.req('/api/remote-access')
    assert.equal(res.data.localConnector.status, expected, JSON.stringify(connector))
  }
})

// ── Fail-closed ──────────────────────────────────────────────────────────────

test('TWAPI-5 stale evidence stops being reported as a current state', async () => {
  await useFakeAgent(respondWith(evidence({ ageSeconds: TWINGATE_STALE_THRESHOLD_SECONDS + 60 })))
  const res = await admin.req('/api/remote-access')
  const local = res.data.localConnector
  assert.equal(local.stale, true)
  assert.equal(local.status, 'UNKNOWN', 'a stale RUNNING must not read as up')
  assert.equal(local.reason, 'stale')
  // The last reading stays visible — "it was running when something last looked"
  // is more useful than a blank, as long as the status says it is not current.
  assert.equal(local.runtimeState, 'RUNNING')
})

test('TWAPI-6 an absent host agent is unavailable, never a fabricated state', async () => {
  useAbsentAgent()
  const res = await admin.req('/api/remote-access')
  assert.equal(res.status, 200)
  const local = res.data.localConnector
  assert.equal(local.available, false)
  assert.equal(local.status, 'UNKNOWN')
  assert.equal(local.reason, 'agent-unreachable')
  assert.equal(local.runtimeState, null)
  assert.equal(local.restartCount, null)
})

test('TWAPI-7 the collector reason survives to the API when there is no evidence', async () => {
  for (const reason of ['connector-not-found', 'docker-unavailable', 'inspect-failed', 'collector-not-run', 'not-configured']) {
    await useFakeAgent(respondWith({
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      connector: { available: false, reason },
    }))
    const res = await admin.req('/api/remote-access')
    assert.equal(res.data.localConnector.reason, reason, reason)
    assert.equal(res.data.localConnector.status, 'UNKNOWN')
  }
})

test('TWAPI-8 a malformed or hostile agent body is refused, not repaired', async () => {
  const rejected = [
    ['wrong schema version', { ...evidence(), schemaVersion: 2 }],
    ['unexpected top-level key', { ...evidence(), hostname: 'aegis-edge' }],
    ['runtime state outside the enum', evidence({ connector: { runtimeState: 'TELEPORTING' } })],
    ['health outside the enum', evidence({ connector: { health: 'EXCELLENT' } })],
    ['negative restart count', evidence({ connector: { restartCount: -4 } })],
    ['restart count as a string', evidence({ connector: { restartCount: '4' } })],
    ['malformed startedAt', evidence({ connector: { startedAt: 'soon' } })],
    ['an extra connector key', evidence({ connector: { containerId: 'e3b0c442' } })],
    ['measured in the future', { ...evidence(), measuredAt: new Date(Date.now() + 600_000).toISOString() }],
    ['not an object', 'nope'],
  ]
  for (const [label, body] of rejected) {
    await useFakeAgent(respondWith(body))
    const res = await admin.req('/api/remote-access')
    assert.equal(res.status, 200, label)
    assert.equal(res.data.localConnector.available, false, label)
    assert.equal(res.data.localConnector.status, 'UNKNOWN', label)
  }
})

test('TWAPI-9 a hostile agent cannot smuggle a token or an address through the API', async () => {
  await useFakeAgent(respondWith({
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    connector: {
      available: true, runtimeState: 'RUNNING', health: 'HEALTHY', restartCount: 0,
      startedAt: '2026-09-01T08:30:00.000Z',
      env: ['TWINGATE_ACCESS_TOKEN=super-secret-value'],
      ipAddress: '10.20.0.9',
    },
  }))
  const res = await admin.req('/api/remote-access')
  const serialized = JSON.stringify(res.data)
  for (const secret of ['TWINGATE_ACCESS_TOKEN', 'super-secret-value', '10.20.0.9']) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`)
  }
  // The extra keys made the whole document invalid — it was refused, not trimmed.
  assert.equal(res.data.localConnector.available, false)
})

// ── The control plane stays unmeasured ───────────────────────────────────────

test('TWAPI-10 the control plane is always reported as not measured', async () => {
  // Including — especially — when the local connector is perfectly healthy.
  await useFakeAgent(respondWith(evidence()))
  const res = await admin.req('/api/remote-access')
  assert.equal(res.data.localConnector.status, 'HEALTHY')
  assert.deepEqual(res.data.controlPlane, { ...CONTROL_PLANE_NOT_MEASURED })
  assert.equal(res.data.controlPlane.measured, false)
  assert.equal(res.data.controlPlane.state, 'unavailable')
})

test('TWAPI-11 no response can claim the connector is online to Twingate', async () => {
  for (const body of [evidence(), evidence({ connector: { runtimeState: 'STOPPED' } })]) {
    await useFakeAgent(respondWith(body))
    const res = await admin.req('/api/remote-access')
    const serialized = JSON.stringify(res.data).toLowerCase()
    for (const claim of ['online', 'connected', 'control-plane-healthy']) {
      assert.equal(serialized.includes(claim), false, `the API must not emit "${claim}"`)
    }
  }
})

// ── The existing contracts must not move ─────────────────────────────────────

test('TWAPI-12 /api/telemetry and /api/storage are untouched by the new route', async () => {
  await useFakeAgent((req, res) => {
    // One fake agent serving all three routes, as the real one does.
    if (req.url.startsWith('/internal/twingate-connector')) return respondWith(evidence())(req, res)
    if (req.url.startsWith('/internal/disk-health')) return respondWith({}, 503)(req, res)
    return respondWith({
      schemaVersion: 1,
      measuredAt: new Date().toISOString(),
      metrics: {
        cpu: { available: true, percent: 10, windowSeconds: 5 },
        memory: { available: true, usedBytes: 1, totalBytes: 2, percent: 50 },
        network: { available: true, interface: 'enp1s0', rxBytesPerSec: 1, txBytesPerSec: 1, windowSeconds: 5 },
        uptime: { available: true, hostSeconds: 100 },
      },
    })(req, res)
  })

  const telemetry = await admin.req('/api/telemetry')
  assert.equal(telemetry.status, 200)
  // No connector group was added to the Dashboard telemetry document.
  assert.equal('connector' in telemetry.data, false)
  assert.equal('localConnector' in (telemetry.data.metrics ?? {}), false)

  // ⚠️ /api/telemetry has carried a `twingate` metric since V1, and it is
  //    deliberately NOT touched by this work. It describes the connector as a
  //    whole — control plane included — and no approved source for that exists,
  //    so it must still say so. The local runtime evidence added here is a
  //    different question and lives on its own route. Changing this metric would
  //    silently change what the Dashboard claims.
  assert.deepEqual(telemetry.data.metrics.twingate, {
    available: false,
    scope: 'server-connector',
    status: 'unavailable',
    reason: 'no-approved-source',
  })

  const storage = await admin.req('/api/storage')
  assert.equal(storage.status, 200)
  assert.equal('connector' in storage.data, false)
  assert.equal('twingate' in storage.data, false)
  assert.equal('localConnector' in storage.data, false)
})

// ── The pure layers ──────────────────────────────────────────────────────────

test('TWAPI-13 status derivation never promotes unknown or unchecked to healthy', () => {
  assert.equal(deriveConnectorStatus({ runtimeState: 'RUNNING', health: 'NOT_CONFIGURED' }).status, 'NOT_CONFIGURED')
  assert.equal(deriveConnectorStatus({ runtimeState: 'RUNNING', health: 'UNKNOWN' }).status, 'UNKNOWN')
  // Stale wins over everything, including a healthy reading.
  assert.equal(
    deriveConnectorStatus({ runtimeState: 'RUNNING', health: 'HEALTHY' }, { stale: true }).status,
    'UNKNOWN',
  )
  assert.equal(deriveConnectorStatus({ runtimeState: 'RUNNING', health: 'HEALTHY' }).status, 'HEALTHY')
})

test('TWAPI-14 the validator accepts the documented shape and nothing wider', () => {
  const now = Date.parse('2026-09-05T10:00:00.000Z')
  const good = {
    schemaVersion: 1,
    measuredAt: '2026-09-05T09:59:30.000Z',
    connector: {
      available: true, runtimeState: 'RUNNING', health: 'HEALTHY',
      restartCount: 0, startedAt: '2026-09-01T08:30:00.000Z',
    },
  }
  assert.equal(validateTwingateResponse(good, { now }).ok, true)
  // null is an allowed "unknown" for both optional readings.
  assert.equal(validateTwingateResponse({
    ...good,
    connector: { ...good.connector, restartCount: null, startedAt: null },
  }, { now }).ok, true)
  // Unavailable must carry a reason and nothing else.
  assert.equal(validateTwingateResponse({
    schemaVersion: 1, measuredAt: good.measuredAt,
    connector: { available: false, reason: 'connector-not-found' },
  }, { now }).ok, true)
  assert.equal(validateTwingateResponse({
    schemaVersion: 1, measuredAt: good.measuredAt,
    connector: { available: false, reason: 'connector-not-found', runtimeState: 'RUNNING' },
  }, { now }).ok, false)
})
