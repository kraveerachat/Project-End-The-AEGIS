import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createDemoProvider } from '../../server/providers/demoProvider.js'
import { createLiveProvider } from '../../server/providers/liveProvider.js'
import { createLabMqttObserver, parseObserverLine } from '../../server/providers/labMqttObserver.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { fixedNow } from '../fixtures/evidence.js'

const PAYLOAD = { state: 'LOCKDOWN', reason: 'heartbeat', rssi: -10, heap: 250196, profile: 0, time_ok: true }
const OPTS = '/home/test/.config/aegis-lab-observer/mosquitto.opts'
const okStat = () => ({ isFile: () => true, mode: 0o100600, uid: process.getuid() })
// Shape of `mosquitto_sub -F %j` output.
const line = (payload = PAYLOAD, overrides = {}) => JSON.stringify({
  tst: '2026-10-17T05:00:00Z', topic: 'aegis/status', qos: 0, retain: 0, payloadlen: 1,
  payload: typeof payload === 'string' ? payload : JSON.stringify(payload), ...overrides,
})

function fakeChild() {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.kill = vi.fn()
  return child
}

function harness(options = {}) {
  let now = 1_000_000
  const child = fakeChild()
  const spawn = vi.fn(() => child)
  const observer = createLabMqttObserver({
    optionsFile: OPTS, clock: () => new Date(now), spawn, statSync: okStat, setTimer: vi.fn(() => ({ unref() {} })), ...options,
  })
  observer.start()
  return { observer, child, spawn, advance: (ms) => { now += ms } }
}

describe('LAB MQTT observer parsing', () => {
  it('accepts the observed ESP32 payload', () => {
    expect(parseObserverLine(line())).toEqual({ ok: true, value: PAYLOAD })
  })

  it.each([
    ['not JSON', 'garbage', 'malformed'],
    ['array envelope', '[]', 'malformed'],
    ['retained', line(PAYLOAD, { retain: 1 }), 'retained'],
    ['wrong topic', line(PAYLOAD, { topic: 'aegis/lockdown/cmd' }), 'unsupported'],
    ['payload not JSON', line('LOCKDOWN'), 'malformed'],
    ['payload not a string', JSON.stringify({ topic: 'aegis/status', retain: 0, payload: PAYLOAD }), 'malformed'],
    ['extra key', line({ ...PAYLOAD, relay: 'OPEN' }), 'unsupported'],
    ['missing key', line({ state: 'LOCKDOWN' }), 'unsupported'],
    ['bad state shape', line({ ...PAYLOAD, state: 'lock down' }), 'unsupported'],
    ['rssi out of range', line({ ...PAYLOAD, rssi: 20 }), 'unsupported'],
    ['time_ok as string', line({ ...PAYLOAD, time_ok: 'true' }), 'unsupported'],
    ['oversized payload', line('x'.repeat(600)), 'malformed'],
    ['oversized line', 'x'.repeat(3000), 'malformed'],
  ])('rejects %s', (_name, input, reason) => {
    expect(parseObserverLine(input)).toEqual({ ok: false, reason })
  })
})

describe('LAB MQTT observer lifecycle', () => {
  it('spawns only mosquitto_sub, subscribe-only, loopback broker, credentials via options file', () => {
    const { spawn } = harness()
    const [binary, args, options] = spawn.mock.calls[0]
    expect(binary).toBe('mosquitto_sub')
    expect(args).toEqual(['-o', OPTS, '-h', '127.0.0.1', '-p', '1883', '-t', 'aegis/status', '-q', '0', '-k', '30', '-F', '%j'])
    expect(args.join(' ')).not.toMatch(/-[uP]\b|-m\b|-L\b/)
    expect(options.stdio).toEqual(['ignore', 'pipe', 'ignore'])
    expect(Object.keys(options.env)).toEqual(['PATH'])
  })

  it('is UNKNOWN before any message and OBSERVED/FRESH after one, using local reception time', () => {
    const { observer, child } = harness()
    expect(observer.snapshot()).toMatchObject({ evidenceState: 'UNKNOWN', freshness: 'UNKNOWN', reportedState: null, observer: 'RUNNING' })
    child.stdout.emit('data', `${line()}\n`)
    expect(observer.snapshot()).toMatchObject({
      evidenceState: 'OBSERVED', freshness: 'FRESH', reportedState: 'LOCKDOWN', rssi: -10, freeHeap: 250196, profile: 0, timeOk: true,
      lastReceivedAt: new Date(1_000_000).toISOString(), ageMs: 0,
      provenance: { readOnly: true, coreProjection: false, physicalRelayVerified: false, signedHeartbeatVerified: false, timestampBasis: 'LOCAL_RECEPTION_TIME' },
    })
  })

  it('reassembles split chunks and ignores retained/malformed messages without replacing good evidence', () => {
    const { observer, child } = harness()
    const text = `${line()}\n`
    child.stdout.emit('data', text.slice(0, 20))
    child.stdout.emit('data', text.slice(20))
    child.stdout.emit('data', `${line({ ...PAYLOAD, state: 'NORMAL' }, { retain: 1 })}\nnot-json\n`)
    const view = observer.snapshot()
    expect(view.reportedState).toBe('LOCKDOWN')
    expect(view.rejected).toEqual({ retained: 1, malformed: 1, unsupported: 0 })
  })

  it('only retained messages leave evidence UNKNOWN', () => {
    const { observer, child } = harness()
    child.stdout.emit('data', `${line(PAYLOAD, { retain: 1 })}\n`)
    expect(observer.snapshot()).toMatchObject({ evidenceState: 'UNKNOWN', reportedState: null })
  })

  it('marks evidence STALE/UNKNOWN past the freshness boundary and drops values', () => {
    const { observer, child, advance } = harness({ maxAgeMs: 120_000 })
    child.stdout.emit('data', `${line()}\n`)
    advance(120_000)
    expect(observer.snapshot().freshness).toBe('FRESH')
    advance(1)
    expect(observer.snapshot()).toMatchObject({ evidenceState: 'UNKNOWN', freshness: 'STALE', reportedState: null, rssi: null, freeHeap: null, timeOk: null })
  })

  it('is UNKNOWN when the subscriber process ends, and restarts only on a backoff timer', () => {
    const setTimer = vi.fn(() => ({ unref() {} }))
    const { observer, child } = harness({ setTimer })
    child.stdout.emit('data', `${line()}\n`)
    child.emit('close', 1)
    expect(observer.snapshot()).toMatchObject({ observer: 'STOPPED', evidenceState: 'UNKNOWN', reportedState: null })
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 1_000)
  })

  it.each([
    ['missing', () => { throw new Error('ENOENT') }],
    ['group-readable', () => ({ isFile: () => true, mode: 0o100640, uid: process.getuid() })],
    ['not a file', () => ({ isFile: () => false, mode: 0o100600, uid: process.getuid() })],
    ['foreign owner', () => ({ isFile: () => true, mode: 0o100600, uid: process.getuid() + 1 })],
  ])('refuses to spawn with a %s options file', (_name, statSync) => {
    const { observer, spawn } = harness({ statSync })
    expect(spawn).not.toHaveBeenCalled()
    expect(observer.snapshot()).toMatchObject({ observer: 'MISCONFIGURED', evidenceState: 'UNKNOWN' })
    expect(JSON.stringify(observer.snapshot())).not.toContain(OPTS)
  })

  it('stop() terminates only its own child and does not restart', () => {
    const { observer, child, spawn } = harness()
    observer.stop()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    child.emit('close', 0)
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('contains no publish or control path in its source', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'server/providers/labMqttObserver.js'), 'utf8')
    expect(source).not.toMatch(/mosquitto_pub|\.publish\(|aegis\/lockdown|aegis\/heartbeat|'-m'|'-P'|'-u'/)
  })
})

describe('LAB MQTT config', () => {
  const base = { NODE_ENV: 'test', SESSION_SECRET: 'test-session-secret-with-at-least-32-characters' }
  it('is disabled by default and when false', () => {
    expect(loadConfig(base).labMqtt).toEqual({ enabled: false })
    expect(loadConfig({ ...base, AEGIS_IDEA3_LAB_MQTT_OBSERVER: 'false' }).labMqtt.enabled).toBe(false)
  })
  it('enables only with explicit true and an absolute options path', () => {
    expect(loadConfig({ ...base, AEGIS_IDEA3_LAB_MQTT_OBSERVER: 'true', AEGIS_IDEA3_LAB_MQTT_OPTS_FILE: OPTS }).labMqtt).toEqual({ enabled: true, optionsFile: OPTS })
    expect(() => loadConfig({ ...base, AEGIS_IDEA3_LAB_MQTT_OBSERVER: 'yes' })).toThrow(/true or false/)
    expect(() => loadConfig({ ...base, AEGIS_IDEA3_LAB_MQTT_OBSERVER: 'true', AEGIS_IDEA3_LAB_MQTT_OPTS_FILE: 'relative.opts' })).toThrow(/absolute/)
  })
  it('is rejected in production', () => {
    const production = {
      NODE_ENV: 'production',
      SESSION_SECRET: 'S3cure!ProductionSessionSecret-2026',
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH: '$2b$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy',
      AEGIS_IDEA3_AUDIT_DB_PATH: '/var/lib/aegis-idea3/db/security-center-audit.sqlite3',
      AEGIS_WEB_STATIC_DIR: '/opt/aegis/security-center',
    }
    expect(() => loadConfig(production)).not.toThrow()
    expect(() => loadConfig({ ...production, AEGIS_IDEA3_LAB_MQTT_OBSERVER: 'true' })).toThrow(/LAB_MQTT_OBSERVER is not allowed in production/)
  })
})

describe('LAB MQTT route boundary', () => {
  const cfg = loadConfig({
    NODE_ENV: 'test', SESSION_SECRET: 'test-session-secret-with-at-least-32-characters', AEGIS_ALLOW_DEV_LOGIN: 'true',
    AEGIS_IDEA3_ADMIN_USER: 'admin', AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple',
  })
  const clock = () => fixedNow
  const build = (labMqttObserver) => createApp({
    config: cfg, clock, labMqttObserver,
    demoProvider: createDemoProvider({ clock }),
    liveProvider: createLiveProvider({ config: cfg, clock, fetchImpl: async () => { throw new Error('offline') } }),
    repository: createMemoryRepository({ clock }),
  })
  const login = async (app) => {
    const agent = request.agent(app)
    const res = await agent.post('/api/auth/login').set('Origin', 'http://localhost').set('Host', 'localhost')
      .send({ username: 'admin', password: 'correct-horse-battery-staple' })
    return { agent, csrf: res.body.csrfToken }
  }

  it('requires authentication', async () => {
    const res = await request(build(null)).get('/api/security/lab-mqtt')
    expect(res.status).toBe(401)
  })

  it('reports disabled when no observer is configured', async () => {
    const { agent } = await login(build(null))
    const res = await agent.get('/api/security/lab-mqtt')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ enabled: false, observer: 'DISABLED', evidenceState: 'UNKNOWN' })
  })

  it('serves observer evidence to an authenticated Admin, with no credential material', async () => {
    const { observer, child } = harness()
    const { agent } = await login(build(observer))
    child.stdout.emit('data', `${line()}\n`)
    const res = await agent.get('/api/security/lab-mqtt')
    expect(res.body).toMatchObject({ enabled: true, evidenceState: 'OBSERVED', reportedState: 'LOCKDOWN' })
    expect(JSON.stringify(res.body)).not.toMatch(/opts|password|aegis-lab-observer|reason/i)
  })

  it('never shows LAB evidence to a Demo session', async () => {
    const { observer, child } = harness()
    const { agent, csrf } = await login(build(observer))
    child.stdout.emit('data', `${line()}\n`)
    await agent.post('/api/security/demo-mode').set('Origin', 'http://localhost').set('Host', 'localhost').set('x-csrf-token', csrf).send({ enabled: true })
    const res = await agent.get('/api/security/lab-mqtt')
    expect(res.body).toMatchObject({ enabled: false, reportedState: null })
  })

  it.each(['post', 'put', 'patch', 'delete'])('exposes no %s method on the LAB route', async (method) => {
    const { agent, csrf } = await login(build(null))
    const res = await agent[method]('/api/security/lab-mqtt').set('Origin', 'http://localhost').set('Host', 'localhost').set('x-csrf-token', csrf).send({})
    expect(res.status).toBe(404)
  })

  it('stops the observer when the app closes', () => {
    const observer = { start: vi.fn(), stop: vi.fn(), snapshot: vi.fn() }
    const app = build(observer)
    app.locals.close()
    expect(observer.start).toHaveBeenCalledOnce()
    expect(observer.stop).toHaveBeenCalledOnce()
  })
})
