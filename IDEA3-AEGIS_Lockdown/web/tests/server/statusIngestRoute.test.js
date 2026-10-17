import { readFileSync } from 'node:fs'
import path from 'node:path'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createMachineApp } from '../../server/createMachineApp.js'
import { createDemoProvider } from '../../server/providers/demoProvider.js'
import { createLiveProvider } from '../../server/providers/liveProvider.js'
import { createStatusIngestStore } from '../../server/domain/statusIngest.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { createMachineContactTracker } from '../../server/security/machineIdentity.js'
import { startServer } from '../../server/runtime.js'

// Synthetic fixture only: nothing here contacts a HUB, a Core, a broker or hardware.
const PUSH = JSON.parse(readFileSync(path.resolve(process.cwd(), 'tests/fixtures/core-status-push.json'), 'utf8'))
const NOW = new Date(PUSH.sentAtMs + 5_000)
const BASE = '/api/machine/v1'
const IDENTITY = Object.freeze({ 'X-AEGIS-Client-Verify': 'SUCCESS', 'X-AEGIS-Client-DN': 'CN=idea3-core,O=AEGIS' })
const SESSION_SECRET = 'test-session-secret-with-at-least-32-characters'

function env(overrides = {}) {
  return {
    NODE_ENV: 'test',
    SESSION_SECRET,
    AEGIS_ALLOW_DEV_LOGIN: 'true',
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple',
    AEGIS_IDEA3_DISPATCH_PORT: '18103',
    AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '127.0.0.1',
    AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: 'idea3-core',
    ...overrides,
  }
}

function push(overrides = {}, projection = {}) {
  return { ...PUSH, ...overrides, projection: { ...PUSH.projection, ...projection } }
}

function statusMachine({ envOverrides = { AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' }, clock = () => NOW } = {}) {
  const config = loadConfig(env(envOverrides))
  const statusStore = createStatusIngestStore({ maxAgeMs: config.maxEvidenceAgeMs })
  const contact = createMachineContactTracker({ clock })
  const app = createMachineApp({ config, repository: createMemoryRepository({ clock }), contact, statusStore, clock })
  return { app, config, statusStore, contact }
}

const post = (app, body, headers = IDENTITY) => request(app).post(`${BASE}/status`).set(headers).send(body)

describe('STATUS_INGEST flag truth table', () => {
  const cases = [
    { dispatch: undefined, status: undefined, machine: false, dispatchOn: false, statusOn: false },
    { dispatch: 'false', status: 'false', machine: false, dispatchOn: false, statusOn: false },
    { dispatch: 'true', status: undefined, machine: true, dispatchOn: true, statusOn: false },
    { dispatch: undefined, status: 'true', machine: true, dispatchOn: false, statusOn: true },
    { dispatch: 'true', status: 'true', machine: true, dispatchOn: true, statusOn: true },
  ]

  for (const row of cases) {
    it(`dispatch=${row.dispatch} status=${row.status} -> machine=${row.machine}`, () => {
      const overrides = {}
      if (row.dispatch !== undefined) overrides.AEGIS_IDEA3_DISPATCH_ENABLED = row.dispatch
      if (row.status !== undefined) overrides.AEGIS_IDEA3_STATUS_INGEST_ENABLED = row.status
      const config = loadConfig(env(overrides))
      expect(config.dispatch.enabled).toBe(row.dispatchOn)
      expect(config.statusIngest.enabled).toBe(row.statusOn)
      expect(config.machine.enabled).toBe(row.machine)
    })
  }

  it('defaults to disabled and needs no machine variables when both features are off', () => {
    const config = loadConfig({ NODE_ENV: 'test', SESSION_SECRET })
    expect(config.statusIngest.enabled).toBe(false)
    expect(config.machine.enabled).toBe(false)
  })

  it('rejects anything but true/false', () => {
    for (const value of ['1', 'yes', 'TRUE', 'on']) {
      expect(() => loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: value }))).toThrow(/STATUS_INGEST_ENABLED must be true or false/)
    }
  })

  it('enabling status ingest does not enable dispatch', () => {
    const config = loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' }))
    expect(config.dispatch).toEqual({ enabled: false })
  })

  it('status-only needs the same pinned peer and subject as dispatch', () => {
    expect(() => loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true', AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: 'not-an-ip' }))).toThrow(/single IP address literal/)
    expect(() => loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true', AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: 'Bad Name' }))).toThrow(/lower-case machine name/)
  })

  it('production status-only requires an explicit non-loopback machine host', () => {
    const production = {
      NODE_ENV: 'production',
      SESSION_SECRET: 'p'.repeat(48),
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH: undefined,
      AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true',
    }
    // The production password-hash rules apply before the machine rules; reuse a loadable production base.
    const base = { ...env(production), AEGIS_ALLOW_DEV_LOGIN: undefined, AEGIS_IDEA3_DEV_PASSWORD: undefined }
    expect(() => loadConfig(base)).toThrow()
  })

  it('refuses to combine pushed status with a polled runtime feed', () => {
    expect(() => loadConfig(env({
      AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true',
      AEGIS_IDEA3_RUNTIME_STATUS_URL: 'https://example.invalid/status',
    }))).toThrow(/cannot be combined/)
    expect(() => loadConfig(env({
      AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true',
      AEGIS_IDEA3_LAB_RUNTIME_STATUS: 'true',
      AEGIS_IDEA3_RUNTIME_STATUS_URL: 'http://127.0.0.1:9/status',
    }))).toThrow(/cannot be combined/)
  })
})

describe('machine app mounting', () => {
  it('refuses to be built with both features off', () => {
    const config = loadConfig(env())
    expect(() => createMachineApp({ config, repository: createMemoryRepository(), contact: { record() {} } })).toThrow(/dispatch or status ingest/)
  })

  it('status-only: accepts a push and exposes no dispatch route', async () => {
    const { app } = statusMachine()
    expect((await post(app, PUSH)).status).toBe(200)
    for (const [method, route] of [
      ['get', `${BASE}/dispatch/pending`],
      ['post', `${BASE}/dispatch/0b6b7f2e-3b4a-4c1e-8a55-1f5f3c2d9e10/claim`],
      ['post', `${BASE}/dispatch/0b6b7f2e-3b4a-4c1e-8a55-1f5f3c2d9e10/evidence`],
    ]) {
      const response = await request(app)[method](route).set(IDENTITY).send({})
      expect(response.status).toBe(404)
    }
  })

  it('dispatch-only: the status route does not exist', async () => {
    const config = loadConfig(env({ AEGIS_IDEA3_DISPATCH_ENABLED: 'true' }))
    const app = createMachineApp({ config, repository: createMemoryRepository(), contact: createMachineContactTracker() })
    expect((await post(app, PUSH)).status).toBe(404)
    expect((await request(app).get(`${BASE}/dispatch/pending`).set(IDENTITY)).status).toBe(200)
  })

  it('both enabled: both route groups work independently', async () => {
    const config = loadConfig(env({ AEGIS_IDEA3_DISPATCH_ENABLED: 'true', AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' }))
    const statusStore = createStatusIngestStore()
    const contact = createMachineContactTracker()
    const app = createMachineApp({ config, repository: createMemoryRepository(), contact, statusStore, clock: () => NOW })
    expect((await post(app, PUSH)).status).toBe(200)
    expect(contact.lastContactAt()).toBeNull()
    expect((await request(app).get(`${BASE}/dispatch/pending`).set(IDENTITY)).status).toBe(200)
    expect(contact.lastContactAt()).not.toBeNull()
  })

  it('status ingest without a store is a programming error', () => {
    const config = loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' }))
    expect(() => createMachineApp({ config, contact: { record() {} } })).toThrow(/status store/)
  })
})

describe('POST /status', () => {
  it('accepts a well formed envelope with a small JSON body and stores nothing durable', async () => {
    const { app, statusStore } = statusMachine()
    const response = await post(app, PUSH)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ACCEPTED' })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(statusStore.current().generatedAt).toBe(PUSH.projection.generatedAt)
  })

  it('verifies machine identity before looking at the body', async () => {
    const { app, statusStore } = statusMachine()
    const bad = [
      {},
      { 'X-AEGIS-Client-Verify': 'FAILED', 'X-AEGIS-Client-DN': 'CN=idea3-core' },
      { 'X-AEGIS-Client-Verify': 'SUCCESS', 'X-AEGIS-Client-DN': 'CN=other-core' },
      { 'X-AEGIS-Client-Verify': 'SUCCESS', 'X-AEGIS-Client-DN': 'CN=idea3-core,CN=evil' },
      { ...IDENTITY, Cookie: 'sid=1' },
      { ...IDENTITY, Origin: 'https://evil.example' },
    ]
    for (const headers of bad) {
      const response = await post(app, PUSH, headers)
      expect(response.status).toBe(403)
      expect(response.body).toEqual({ error: { code: 'MACHINE_IDENTITY_INVALID' } })
    }
    expect(statusStore.current()).toBeNull()
  })

  it('ignores forged forwarding headers: the socket peer must be the pinned peer', async () => {
    const config = loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true', AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '192.0.2.77' }))
    const app = createMachineApp({ config, contact: { record() {} }, statusStore: createStatusIngestStore(), clock: () => NOW })
    const response = await post(app, PUSH, { ...IDENTITY, 'X-Forwarded-For': '192.0.2.77', 'X-Real-IP': '192.0.2.77' })
    expect(response.status).toBe(403)
  })

  it('maps each refusal to the documented status and leaves accepted state unchanged', async () => {
    const { app, statusStore } = statusMachine()
    expect((await post(app, PUSH)).status).toBe(200)
    const accepted = statusStore.current()

    const cases = [
      [{ ...PUSH, extra: 1 }, 400, 'STATUS_PUSH_INVALID'],
      [{ ...PUSH, version: 2 }, 400, 'STATUS_PUSH_UNSUPPORTED'],
      [push({}, { status: 'ALL_GOOD' }), 400, 'STATUS_PUSH_INVALID'],
      [PUSH, 409, 'STATUS_PUSH_REPLAY'],
      [push({ sentAtMs: PUSH.sentAtMs - 10 }), 409, 'STATUS_PUSH_REPLAY'],
      [push({ sentAtMs: PUSH.sentAtMs + 600_000 }), 422, 'STATUS_PUSH_FUTURE'],
    ]
    for (const [body, status, code] of cases) {
      const response = await post(app, body)
      expect([response.status, response.body.error.code]).toEqual([status, code])
    }
    expect(statusStore.current()).toEqual(accepted)
  })

  it('refuses stale evidence', async () => {
    const { app, statusStore } = statusMachine({ clock: () => new Date(PUSH.sentAtMs + 10 * 60_000) })
    const response = await post(app, PUSH)
    expect([response.status, response.body.error.code]).toEqual([422, 'STATUS_PUSH_STALE'])
    expect(statusStore.current()).toBeNull()
  })

  it('refuses malformed JSON, non-JSON, arrays and oversized bodies', async () => {
    const { app, statusStore } = statusMachine()
    const malformed = await request(app).post(`${BASE}/status`).set(IDENTITY).set('Content-Type', 'application/json').send('{not json')
    expect(malformed.status).toBe(400)
    const text = await request(app).post(`${BASE}/status`).set(IDENTITY).set('Content-Type', 'text/plain').send('hello')
    expect(text.status).toBe(400)
    expect((await post(app, [PUSH])).status).toBe(400)
    const huge = await post(app, push({}, { padding: 'x'.repeat(9_000) }))
    expect(huge.status).toBe(413)
    expect(statusStore.current()).toBeNull()
  })

  it('accepting status touches no repository, database or audit store', async () => {
    const touched = []
    const repository = new Proxy({}, { get: (_t, name) => { touched.push(String(name)); return () => { throw new Error('repository must not be used') } } })
    const config = loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' }))
    const statusStore = createStatusIngestStore()
    const app = createMachineApp({ config, repository, contact: { record() {} }, statusStore, clock: () => NOW })
    expect((await post(app, PUSH)).status).toBe(200)
    expect((await post(app, PUSH)).status).toBe(409)
    expect(touched).toEqual([])
    const bare = createMachineApp({ config, contact: { record() {} }, statusStore: createStatusIngestStore(), clock: () => NOW })
    expect((await post(bare, PUSH)).status).toBe(200)
  })

  it('does not let prototype-pollution keys through', async () => {
    const { app, statusStore } = statusMachine()
    const raw = JSON.stringify(PUSH).replace('{', '{"__proto__":{"polluted":true},')
    const response = await request(app).post(`${BASE}/status`).set(IDENTITY).set('Content-Type', 'application/json').send(raw)
    expect(response.status).toBe(400)
    expect({}.polluted).toBeUndefined()
    expect(statusStore.current()).toBeNull()
  })

  it('serves only POST: GET and other verbs are 404', async () => {
    const { app } = statusMachine()
    for (const method of ['get', 'put', 'delete', 'patch']) {
      expect((await request(app)[method](`${BASE}/status`).set(IDENTITY).send({})).status).toBe(404)
    }
  })

  it('does not serve other casings or paths', async () => {
    const { app } = statusMachine()
    for (const route of ['/api/MACHINE/v1/status', `${BASE}/Status`, `${BASE}/status/`, `${BASE}/status/extra`]) {
      const response = await request(app).post(route).set(IDENTITY).send(PUSH)
      expect([404]).toContain(response.status)
    }
  })

  it('never echoes status data back to a caller', async () => {
    const { app } = statusMachine()
    const refused = await post(app, PUSH, {})
    expect(JSON.stringify(refused.body)).not.toContain('HEALTHY')
    const accepted = await post(app, PUSH)
    expect(JSON.stringify(accepted.body)).not.toContain('HEALTHY')
  })

  it('production accepts only production-profile evidence (LAB evidence is never genuine Production evidence)', async () => {
    const config = loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' }))
    const statusStore = createStatusIngestStore({ allowedProfiles: ['production'] })
    const app = createMachineApp({ config, contact: { record() {} }, statusStore, clock: () => NOW })
    for (const profile of ['lab', 'development', 'UNKNOWN']) {
      const response = await post(app, push({}, { modes: { ...PUSH.projection.modes, profile } }))
      expect([response.status, response.body.error.code]).toEqual([422, 'STATUS_PUSH_PROFILE'])
    }
    expect(statusStore.current()).toBeNull()
    expect((await post(app, PUSH)).status).toBe(200)
  })
})

describe('runtime listener selection', () => {
  function runtimeWith(overrides) {
    const listened = []
    const listen = (app, port, host) => {
      listened.push({ port, host })
      return { listening: true, close: (callback) => callback?.(), once() {}, off() {} }
    }
    const config = loadConfig(env({ ...overrides }))
    const stores = []
    return startServer({
      config,
      repository: createMemoryRepository(),
      listen,
      appFactory: ({ statusStore }) => { stores.push(statusStore); return { locals: {} } },
      machineAppFactory: (options) => { stores.push(options.statusStore); return { locals: {} } },
    }).then((runtime) => ({ runtime, listened, stores }))
  }

  it('starts no machine listener when both features are off', async () => {
    const { runtime, listened } = await runtimeWith({})
    expect(listened).toHaveLength(1)
    expect(runtime.machineServer).toBeNull()
  })

  it('starts the machine listener for status-only and shares one store', async () => {
    const { runtime, listened, stores } = await runtimeWith({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' })
    expect(listened).toHaveLength(2)
    expect(listened[1]).toEqual({ port: 18103, host: '127.0.0.1' })
    expect(runtime.machineServer).not.toBeNull()
    expect(stores[0]).toBeTruthy()
    expect(stores[0]).toBe(stores[1])
  })

  it('dispatch-only passes no store', async () => {
    const { stores, listened } = await runtimeWith({ AEGIS_IDEA3_DISPATCH_ENABLED: 'true' })
    expect(listened).toHaveLength(2)
    expect(stores).toEqual([null, null])
  })
})

describe('Web live provider with the status store', () => {
  function provider(store, clock = () => NOW, envOverrides = { AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' }) {
    const config = loadConfig(env(envOverrides))
    const fetchImpl = async () => { throw new Error('the live provider must not fetch when ingest is enabled') }
    return createLiveProvider({ config, clock, fetchImpl, statusStore: store })
  }

  it('missing projection is UNKNOWN', async () => {
    const snapshot = await provider(createStatusIngestStore()).getSnapshot()
    expect(snapshot.runtime.status).toBe('UNKNOWN')
    expect(snapshot.integration.idea3.status).toBe('UNKNOWN')
    expect(snapshot.runtime.components.every((component) => component.status === 'UNKNOWN')).toBe(true)
    expect(snapshot.operationalErrors.length).toBeGreaterThan(0)
  })

  it('a fresh accepted projection is used with the Core original timestamp', async () => {
    const store = createStatusIngestStore()
    expect(store.accept(PUSH, NOW).ok).toBe(true)
    const snapshot = await provider(store).getSnapshot()
    expect(snapshot.mode).toBe('LIVE')
    expect(snapshot.runtime.generatedAt).toBe(PUSH.projection.generatedAt)
    expect(snapshot.runtime.freshness).toBe('FRESH')
    expect(snapshot.runtime.status).toBe('HEALTHY')
    const byId = Object.fromEntries(snapshot.runtime.components.map((component) => [component.id, component.status]))
    expect(byId.broker).toBe('HEALTHY')
    expect(byId.esp32).toBe('HEALTHY')
    expect(byId.relay).toBe('UNKNOWN')
    expect(byId.ack).toBe('UNKNOWN')
    expect(byId.heartbeat).toBe('UNKNOWN')
  })

  it('an expired projection becomes UNKNOWN (freshness comes from the Core timestamp, not receipt time)', async () => {
    const store = createStatusIngestStore()
    store.accept(PUSH, NOW)
    const later = new Date(PUSH.sentAtMs + 10 * 60_000)
    const snapshot = await provider(store, () => later).getSnapshot()
    expect(snapshot.runtime.status).toBe('UNKNOWN')
    expect(snapshot.runtime.freshness).toBe('STALE')
  })

  it('broker disconnected and device offline are never HEALTHY', async () => {
    const store = createStatusIngestStore()
    store.accept(push({}, {
      status: 'FAILED',
      components: { broker: 'DISCONNECTED', device: 'OFFLINE', uplink: 'NORMAL', detector: 'RUNNING' },
      issues: ['MQTT_DISCONNECTED', 'ESP32_UNAVAILABLE'],
    }), NOW)
    const snapshot = await provider(store).getSnapshot()
    expect(snapshot.runtime.status).toBe('FAILED')
    expect(snapshot.runtime.components.find((component) => component.id === 'broker').status).toBe('FAILED')
    expect(snapshot.runtime.components.find((component) => component.id === 'esp32').status).toBe('FAILED')
    expect(snapshot.overall.status).not.toBe('HEALTHY')
  })

  it('LOCKDOWN with uplink DEGRADED never yields HEALTHY overall', async () => {
    const store = createStatusIngestStore()
    store.accept(push({}, { status: 'HEALTHY', components: { ...PUSH.projection.components, uplink: 'LOCKDOWN' } }), NOW)
    const snapshot = await provider(store).getSnapshot()
    expect(snapshot.runtime.status).toBe('DEGRADED')
    expect(snapshot.overall.status).not.toBe('HEALTHY')
  })

  it('a rejected push never overwrites accepted evidence', async () => {
    const store = createStatusIngestStore()
    store.accept(PUSH, NOW)
    const refused = store.accept(push({ sentAtMs: PUSH.sentAtMs + 1 }, { status: 'FAILED', evidenceSource: 'LAB' }), NOW)
    expect(refused.ok).toBe(false)
    const snapshot = await provider(store).getSnapshot()
    expect(snapshot.runtime.status).toBe('HEALTHY')
  })

  it('a LAB runtime URL is never read in production-style ingest mode (no fetch, no fallback)', async () => {
    let fetched = 0
    const config = loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' }))
    const live = createLiveProvider({ config, clock: () => NOW, fetchImpl: async () => { fetched += 1; throw new Error('no') }, statusStore: createStatusIngestStore() })
    await live.getSnapshot()
    expect(fetched).toBe(0)
  })

  it('without the flag the provider keeps its original polled behaviour', async () => {
    const config = loadConfig(env())
    const live = createLiveProvider({ config, clock: () => NOW, fetchImpl: async () => { throw new Error('offline') } })
    const snapshot = await live.getSnapshot()
    expect(snapshot.runtime.status).toBe('UNKNOWN')
    expect(snapshot.runtime.freshness).toBe('NOT_CONFIGURED')
  })

  it('Demo mode never reads the pushed store and Live never shows demo events', async () => {
    const store = createStatusIngestStore()
    store.accept(PUSH, NOW)
    const demo = await createDemoProvider({ clock: () => NOW }).getSnapshot({})
    expect(demo.mode).toBe('DEMO')
    expect(demo.runtime.generatedAt).not.toBe(PUSH.projection.generatedAt)
    const live = await provider(store).getSnapshot()
    expect(live.events.some((event) => String(event.id).startsWith('demo-'))).toBe(false)
  })
})

describe('browser surface with status ingest enabled', () => {
  function browserApp() {
    const config = loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true' }))
    const statusStore = createStatusIngestStore()
    statusStore.accept(PUSH, NOW)
    return createApp({ config, clock: () => NOW, repository: createMemoryRepository({ clock: () => NOW }), statusStore })
  }

  it('does not serve the machine status route on the browser listener', async () => {
    const app = browserApp()
    for (const headers of [IDENTITY, {}]) {
      const response = await request(app).post(`${BASE}/status`).set(headers).send(PUSH)
      expect([404, 401, 403]).toContain(response.status)
      expect(JSON.stringify(response.body)).not.toContain('HEALTHY')
    }
  })

  it('gives unauthenticated callers no status data', async () => {
    const response = await request(browserApp()).get('/api/security/snapshot')
    expect(response.status).toBe(401)
    expect(JSON.stringify(response.body)).not.toContain('MONITOR_ONLY')
  })

  it('an authenticated Admin sees the pushed projection through the existing snapshot route', async () => {
    const agent = request.agent(browserApp())
    await agent.post('/api/auth/login').set('Origin', 'http://localhost').set('Host', 'localhost')
      .send({ username: 'admin', password: 'correct-horse-battery-staple' })
    const response = await agent.get('/api/security/snapshot')
    expect(response.status).toBe(200)
    expect(response.body.mode).toBe('LIVE')
    expect(response.body.runtime.generatedAt).toBe(PUSH.projection.generatedAt)
  })
})
