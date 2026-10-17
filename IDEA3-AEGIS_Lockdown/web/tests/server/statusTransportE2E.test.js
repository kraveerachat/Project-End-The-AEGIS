// Offline end-to-end: synthetic Core status -> real Python push client (run from a freshly BUILT status sidecar package, not the checkout) -> real mTLS front (nginx stand-in) ->
// machine app -> status store -> Web live provider -> UI-facing snapshot. Everything is disposable: test-only
// certificates, ephemeral loopback ports, synthetic status files. It never contacts a HUB, Core broker or ESP32.
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createMachineApp } from '../../server/createMachineApp.js'
import { createStatusIngestStore } from '../../server/domain/statusIngest.js'
import { createLiveProvider } from '../../server/providers/liveProvider.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { createMachineContactTracker } from '../../server/security/machineIdentity.js'

const LOCKDOWN_ROOT = path.resolve(process.cwd(), '..')
const PYTHON = process.env.AEGIS_TEST_PYTHON || 'python3'
const SERVER_NAME = 'idea3-core.aegis.internal'
const BASE = '/api/machine/v1'
const SESSION_SECRET = 'test-session-secret-with-at-least-32-characters'

let dir
let pki
let sidecar
let canRun = true

const openssl = (...args) => execFileSync('openssl', args, { stdio: 'pipe' })

function makeCa(name) {
  const key = path.join(dir, `${name}.key`)
  const crt = path.join(dir, `${name}.crt`)
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt,
    '-subj', `/CN=${name}`, '-days', '2', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
  return { key, crt }
}

function makeLeaf(name, cn, ca, { san, usage }) {
  const key = path.join(dir, `${name}.key`)
  const csr = path.join(dir, `${name}.csr`)
  const crt = path.join(dir, `${name}.crt`)
  const ext = path.join(dir, `${name}.ext`)
  writeFileSync(ext, `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${usage}\n${san ? `subjectAltName=DNS:${san}\n` : ''}`)
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${cn}`)
  openssl('x509', '-req', '-in', csr, '-CA', ca.crt, '-CAkey', ca.key, '-CAcreateserial', '-out', crt, '-days', '2', '-extfile', ext)
  return { key, crt }
}

function buildPki() {
  const serverCa = makeCa('server-ca')
  const clientCa = makeCa('client-ca')
  const rogueCa = makeCa('rogue-ca')
  return {
    serverCa,
    clientCa,
    rogueCa,
    server: makeLeaf('server', SERVER_NAME, serverCa, { san: SERVER_NAME, usage: 'serverAuth' }),
    core: makeLeaf('core', 'idea3-core', clientCa, { usage: 'clientAuth' }),
    other: makeLeaf('other', 'other-core', clientCa, { usage: 'clientAuth' }),
    rogueClient: makeLeaf('rogue-client', 'idea3-core', rogueCa, { usage: 'clientAuth' }),
  }
}

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
    AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'true',
    ...overrides,
  }
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = (server) => new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()))

/** One disposable Web: machine app on http + an mTLS front that, like nginx, vouches for the verified client. */
async function startWeb({ envOverrides, profiles = null } = {}) {
  const config = loadConfig(env(envOverrides))
  const store = createStatusIngestStore({ maxAgeMs: config.maxEvidenceAgeMs, allowedProfiles: profiles })
  const machineApp = createMachineApp({
    config,
    repository: createMemoryRepository(),
    contact: createMachineContactTracker(),
    statusStore: config.statusIngest.enabled ? store : null,
  })
  const machine = http.createServer(machineApp)
  const machinePort = await listen(machine)
  const front = https.createServer({
    key: readFileSync(pki.server.key),
    cert: readFileSync(pki.server.crt),
    ca: readFileSync(pki.clientCa.crt),
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
  }, (req, res) => {
    const peer = req.socket.getPeerCertificate()
    const headers = {
      'content-type': req.headers['content-type'] ?? 'application/json',
      'x-aegis-client-verify': req.socket.authorized ? 'SUCCESS' : 'FAILED',
      'x-aegis-client-dn': `CN=${peer?.subject?.CN ?? ''}`,
    }
    const upstream = http.request({ host: '127.0.0.1', port: machinePort, method: req.method, path: req.url, headers }, (reply) => {
      res.writeHead(reply.statusCode, reply.headers)
      reply.pipe(res)
    })
    req.pipe(upstream)
  })
  const frontPort = await listen(front)
  const provider = createLiveProvider({
    config,
    clock: () => new Date(),
    fetchImpl: async () => { throw new Error('must not fetch') },
    statusStore: config.statusIngest.enabled ? store : null,
  })
  return { config, store, provider, frontPort, stop: async () => { await close(front); await close(machine) } }
}

function writeStatus(file, overrides = {}) {
  const now = Date.now() / 1000
  writeFileSync(file, JSON.stringify({
    state: 'RUNNING', profile: 'production', dry_run: false, auto_contain: false, broker: 'CONNECTED', device: 'ONLINE',
    uplink: 'NORMAL', armed: 'MONITOR_ONLY', dispatch: 'DISABLED', time_trust: 'SYNCED', updated_at: now - 2,
    components: { detector: 'RUNNING' }, ...overrides,
  }))
}

function push(web, { source, client = pki.core, ca = pki.serverCa, host = SERVER_NAME } = {}) {
  return new Promise((resolve) => {
    execFile(PYTHON, ['-E', '-s', '-B', path.join(LOCKDOWN_ROOT, 'tests/fixtures/status_push_driver.py')], {
      cwd: sidecar,
      env: {
        PATH: process.env.PATH,
        AEGIS_TEST_SIDECAR_ROOT: sidecar,
        AEGIS_TEST_HOST_MAP: `${host}=127.0.0.1`,
        AEGIS_CORE_STATUS_PUSH_ENABLED: '1',
        AEGIS_CORE_STATUS_PUSH_BASE_URL: `https://${host}:${web.frontPort}${BASE}`,
        AEGIS_CORE_STATUS_PUSH_SOURCE: source,
        AEGIS_CORE_STATUS_PUSH_CA_FILE: ca.crt,
        AEGIS_CORE_STATUS_PUSH_CLIENT_CERT: client.crt,
        AEGIS_CORE_STATUS_PUSH_CLIENT_KEY: client.key,
      },
      timeout: 20_000,
    }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, out: `${stdout}${stderr}` }))
  })
}

/** Direct mTLS client for replay / schema cases (the same identity a captured key would give an attacker). */
function rawPost(web, body, { client = pki.core } = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request({
      host: '127.0.0.1', port: web.frontPort, method: 'POST', path: `${BASE}/status`, servername: SERVER_NAME,
      ca: readFileSync(pki.serverCa.crt), key: readFileSync(client.key), cert: readFileSync(client.crt),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const snapshotOf = (web) => web.provider.getSnapshot()
const component = (snapshot, id) => snapshot.runtime.components.find((item) => item.id === id).status

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'aegis-status-e2e-'))
  mkdirSync(dir, { recursive: true })
  try {
    pki = buildPki()
    const work = path.join(dir, 'sidecar-work')
    mkdirSync(work, { recursive: true })
    sidecar = execFileSync(PYTHON, ['-B', path.join(LOCKDOWN_ROOT, 'tests/fixtures/build_sidecar_fixture.py'), work], { env: { PATH: process.env.PATH }, stdio: 'pipe' }).toString().trim().split('\n').pop()
    execFileSync(PYTHON, ['-E', '-s', '-B', '-c', 'import aegis_soc.observer, tools.status_push_client'], { cwd: sidecar, env: { PATH: process.env.PATH }, stdio: 'pipe' })
  } catch {
    canRun = false
  }
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('offline Core push -> Web snapshot (disposable mTLS)', () => {
  let web
  let source
  beforeEach(async () => {
    source = path.join(dir, `status-${Math.random().toString(16).slice(2)}.json`)
    web = await startWeb()
    return async () => web.stop()
  })

  it('the environment can run the harness (openssl + python)', () => {
    expect(canRun).toBe(true)
  })

  it('good evidence flows to a LIVE snapshot with the Core original timestamp, and relay/ACK/heartbeat stay UNKNOWN', async () => {
    writeStatus(source)
    const result = await push(web, { source })
    expect(result.code).toBe(0)
    const snapshot = await snapshotOf(web)
    expect(snapshot.mode).toBe('LIVE')
    expect(snapshot.runtime.freshness).toBe('FRESH')
    expect(snapshot.runtime.status).toBe('HEALTHY')
    expect(component(snapshot, 'broker')).toBe('HEALTHY')
    for (const id of ['relay', 'ack', 'heartbeat']) expect(component(snapshot, id)).toBe('UNKNOWN')
    expect(Date.now() - Date.parse(snapshot.runtime.generatedAt)).toBeLessThan(30_000)
    expect(JSON.stringify(snapshot)).not.toMatch(/hunter2|BEGIN (EC )?PRIVATE|\.key/)
  })

  it('missing, stale, future and contradictory sources send nothing: the snapshot stays UNKNOWN', async () => {
    const now = Date.now() / 1000
    const variants = [
      null,
      { updated_at: now - 3600 },
      { updated_at: now + 3600 },
      { state: 'LOCKDOWN', uplink: 'NORMAL' },
    ]
    for (const variant of variants) {
      if (variant) writeStatus(source, variant)
      const result = await push(web, { source: variant ? source : path.join(dir, 'does-not-exist.json') })
      expect(result.code).toBe(1)
      expect(result.out).toContain('NOT_SENT')
    }
    expect(web.store.current()).toBeNull()
    expect((await snapshotOf(web)).runtime.status).toBe('UNKNOWN')
  })

  it('refuses an untrusted server certificate, an unknown client certificate, and a wrong hostname', async () => {
    writeStatus(source)
    const wrongCa = await push(web, { source, ca: pki.rogueCa })
    const rogueClient = await push(web, { source, client: pki.rogueClient })
    const wrongHost = await push(web, { source, host: 'wrong-name.aegis.internal' })
    for (const result of [wrongCa, rogueClient, wrongHost]) {
      expect(result.code).toBe(1)
      expect(result.out).toContain('RETRY')
    }
    expect(web.store.current()).toBeNull()
  })

  it('refuses a wrong machine identity even though the client chains to the trusted CA', async () => {
    writeStatus(source)
    const result = await push(web, { source, client: pki.other })
    expect(result.code).toBe(1)
    expect(result.out).toContain('CREDENTIAL')
    expect(web.store.current()).toBeNull()
  })

  it('refuses replayed and reordered evidence and keeps the accepted state', async () => {
    writeStatus(source)
    expect((await push(web, { source })).code).toBe(0)
    const accepted = web.store.current()
    const base = { schema: 'aegis.idea3.status-push', version: 1, sentAtMs: Date.now(), projection: accepted }
    expect((await rawPost(web, base)).status).toBe(200)
    const replay = await rawPost(web, base)
    const older = await rawPost(web, { ...base, sentAtMs: base.sentAtMs - 1000 })
    expect([replay.status, older.status]).toEqual([409, 409])
    expect(web.store.current()).toEqual(accepted)
  })

  it('rejects invalid schemas and cannot be used to inject another source through the machine route', async () => {
    const accepted = (writeStatus(source), await push(web, { source }), web.store.current())
    const bad = [
      { schema: 'aegis.idea3.status-push', version: 1, sentAtMs: Date.now() + 1, projection: { ...accepted, status: 'LAB' } },
      { schema: 'other', version: 1, sentAtMs: Date.now() + 1, projection: accepted },
      { schema: 'aegis.idea3.status-push', version: 1, sentAtMs: Date.now() + 1, projection: { ...accepted, evidenceSource: 'LAB_MQTT_OBSERVER' } },
      { schema: 'aegis.idea3.status-push', version: 1, sentAtMs: Date.now() + 1, projection: accepted, admin: true },
    ]
    for (const body of bad) expect((await rawPost(web, body)).status).toBe(400)
    expect(web.store.current()).toEqual(accepted)
  })

  it('Core restart: a new push process continues with newer evidence', async () => {
    writeStatus(source)
    expect((await push(web, { source })).code).toBe(0)
    const first = web.store.current().generatedAt
    await new Promise((resolve) => setTimeout(resolve, 1100))
    writeStatus(source)
    expect((await push(web, { source })).code).toBe(0)
    expect(Date.parse(web.store.current().generatedAt)).toBeGreaterThan(Date.parse(first))
  })

  it('the authenticated UI API serves the pushed evidence: UNKNOWN before the first push, LIVE with the Core timestamp after, 401 without a session', async () => {
    const app = createApp({ config: web.config, statusStore: web.store })
    expect((await request(app).get('/api/security/snapshot')).status).toBe(401)
    const agent = request.agent(app)
    const loggedIn = await agent.post('/api/auth/login').set('Origin', 'http://localhost').set('Host', 'localhost')
      .send({ username: 'admin', password: 'correct-horse-battery-staple' })
    expect(loggedIn.status).toBe(200)
    const before = await agent.get('/api/security/snapshot').set('Host', 'localhost')
    expect(before.status).toBe(200)
    expect(before.body.runtime.status).toBe('UNKNOWN')
    writeStatus(source)
    expect((await push(web, { source })).code).toBe(0)
    const after = await agent.get('/api/security/snapshot').set('Host', 'localhost')
    expect(after.status).toBe(200)
    expect(after.body.runtime.status).toBe('HEALTHY')
    expect(after.body.runtime.generatedAt).toBe(web.store.current().generatedAt)
    expect(after.body.runtime.components.find((item) => item.id === 'heartbeat').status).toBe('UNKNOWN')
  })

  it('pusher failure is contained: with the Web endpoint down the push exits non-zero, sends nothing and the Web keeps its state', async () => {
    writeStatus(source)
    expect((await push(web, { source })).code).toBe(0)
    const kept = web.store.current()
    const unreachable = { ...web, frontPort: 1 }
    const failed = await push(unreachable, { source })
    expect(failed.code).not.toBe(0)
    expect(failed.out).not.toMatch(/Traceback/)
    expect(web.store.current()).toEqual(kept)
  })

  it('the pusher runs from the built sidecar package and loads no Core, MQTT or controller module', async () => {
    writeStatus(source)
    const result = await push(web, { source })
    expect(result.code).toBe(0)
    expect(result.out).not.toMatch(/isolation violated/)
  })

  it('Web restart: the new process holds nothing (UNKNOWN) until the next push; no persistence', async () => {
    writeStatus(source)
    expect((await push(web, { source })).code).toBe(0)
    await web.stop()
    web = await startWeb()
    expect((await snapshotOf(web)).runtime.status).toBe('UNKNOWN')
    writeStatus(source)
    expect((await push(web, { source })).code).toBe(0)
    expect((await snapshotOf(web)).runtime.status).toBe('HEALTHY')
  })

  it('broker disconnected, device offline, lockdown and dry-run are never HEALTHY', async () => {
    const cases = [
      [{ broker: 'DISCONNECTED' }, 'broker'],
      [{ device: 'OFFLINE' }, 'esp32'],
      [{ state: 'LOCKDOWN', uplink: 'LOCKDOWN' }, 'uplink'],
    ]
    for (const [override, id] of cases) {
      const fresh = await startWeb()
      writeStatus(source, override)
      expect((await push(fresh, { source })).code).toBe(0)
      const snapshot = await snapshotOf(fresh)
      expect(snapshot.runtime.status).not.toBe('HEALTHY')
      expect(snapshot.overall.status).not.toBe('HEALTHY')
      expect(component(snapshot, id)).not.toBe('HEALTHY')
      await fresh.stop()
    }
    writeStatus(source, { dry_run: true })
    await push(web, { source })
    expect((await snapshotOf(web)).runtime.status).not.toBe('HEALTHY')
  })

  it('status-only exposes no dispatch route through the front either', async () => {
    for (const route of ['dispatch/pending', 'dispatch/0b6b7f2e-3b4a-4c1e-8a55-1f5f3c2d9e10/claim']) {
      const answer = await new Promise((resolve, reject) => {
        const req = https.request({
          host: '127.0.0.1', port: web.frontPort, method: route.endsWith('claim') ? 'POST' : 'GET', path: `${BASE}/${route}`, servername: SERVER_NAME,
          ca: readFileSync(pki.serverCa.crt), key: readFileSync(pki.core.key), cert: readFileSync(pki.core.crt),
        }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
        req.on('error', reject)
        req.end()
      })
      expect(answer).toBe(404)
    }
  })

  it('production-profile Web refuses LAB/development Core evidence', async () => {
    const production = await startWeb({ profiles: ['production'] })
    writeStatus(source, { profile: 'development' })
    const result = await push(production, { source })
    expect(result.code).toBe(1)
    expect(result.out).toContain('STATUS_PUSH_PROFILE')
    expect(production.store.current()).toBeNull()
    writeStatus(source)
    expect((await push(production, { source })).code).toBe(0)
    await production.stop()
  })

  it('flag matrix at the listener: dispatch-only has no status route; both-off cannot build a machine app', async () => {
    const dispatchOnly = await startWeb({ envOverrides: { AEGIS_IDEA3_DISPATCH_ENABLED: 'true', AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'false' } })
    expect((await rawPost(dispatchOnly, { schema: 'aegis.idea3.status-push' })).status).toBe(404)
    await dispatchOnly.stop()
    const both = await startWeb({ envOverrides: { AEGIS_IDEA3_DISPATCH_ENABLED: 'true' } })
    writeStatus(source)
    expect((await push(both, { source })).code).toBe(0)
    await both.stop()
    expect(() => createMachineApp({ config: loadConfig(env({ AEGIS_IDEA3_STATUS_INGEST_ENABLED: 'false' })), contact: { record() {} } })).toThrow()
  })

  it('a browser (cookie / Origin / no certificate) cannot read or write status', async () => {
    writeStatus(source)
    await push(web, { source })
    const store = web.store
    const browser = createApp({ config: web.config, repository: createMemoryRepository(), statusStore: store })
    expect((await request(browser).get('/api/security/snapshot')).status).toBe(401)
    expect((await request(browser).post(`${BASE}/status`).send({})).status).toBe(404)
    const noCert = await new Promise((resolve) => {
      const req = https.request({ host: '127.0.0.1', port: web.frontPort, method: 'POST', path: `${BASE}/status`, servername: SERVER_NAME, ca: readFileSync(pki.serverCa.crt) }, () => resolve('answered'))
      req.on('error', () => resolve('refused'))
      req.end('{}')
    })
    expect(noCert).toBe('refused')
  })
})
