import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createMachineApp } from '../../server/createMachineApp.js'
import { startServer } from '../../server/runtime.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { createSqliteRepository } from '../../server/repositories/sqliteRepository.js'
import { createMachineContactTracker } from '../../server/security/machineIdentity.js'

// Local test fixtures only. The loopback trusted peer stands in for the HUB's
// pinned address; it is not the Production topology (spec §4.4).
const ACCEPTED_AT = '2026-09-12T08:00:00.000Z'
const TTL_MS = 120_000
const BASE = '/api/machine/v1'
const IDENTITY = Object.freeze({
  'X-AEGIS-Client-Verify': 'SUCCESS',
  'X-AEGIS-Client-DN': 'CN=idea3-core,O=AEGIS',
})
const DECISION = Object.freeze({
  incidentId: 'inc-0123456789abcd',
  decision: 'ACCEPT',
  state: 'CONTAINMENT_ACCEPTED',
  correlationKey: 'zone-a-incident-42',
  evidenceIds: ['IDEA1:idea1-event-1', 'IDEA2:idea2-event-1'],
  severity: 'HIGH',
})
const directories = []
const opened = []

afterEach(() => {
  while (opened.length > 0) {
    try {
      opened.pop().close()
    } catch {
      // A test that closes its own repository owns that state.
    }
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function dispatchEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
    AEGIS_ALLOW_DEV_LOGIN: 'true',
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple',
    AEGIS_IDEA3_DISPATCH_ENABLED: 'true',
    AEGIS_IDEA3_DISPATCH_PORT: '18103',
    AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '127.0.0.1',
    AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: 'idea3-core',
    ...overrides,
  }
}

function mutableClock(iso = ACCEPTED_AT) {
  let now = new Date(iso)
  const clock = () => new Date(now)
  clock.set = (value) => { now = new Date(value) }
  return clock
}

function at(offsetMs) {
  return new Date(Date.parse(ACCEPTED_AT) + offsetMs).toISOString()
}

function machine({ env = {}, repository, clock = mutableClock() } = {}) {
  const repo = repository ?? createMemoryRepository({ clock })
  const contact = createMachineContactTracker({ clock })
  const app = createMachineApp({ config: loadConfig(dispatchEnv(env)), repository: repo, contact })
  return { app, repository: repo, contact, clock }
}

function mint(repository, incidentId = DECISION.incidentId) {
  return repository.recordContainmentDecision({ ...DECISION, incidentId }, { mintDispatch: true }).dispatch
}

function claim(app, actionId, headers = IDENTITY, body = {}) {
  return request(app).post(`${BASE}/dispatch/${actionId}/claim`).set(headers).send(body)
}

function claimedAudit(repository) {
  return repository.queryAudit({ limit: 250 }).filter((row) => row.category === 'DISPATCH' && row.action === 'ACTION_CLAIMED')
}

function sqlitePath() {
  const directory = mkdtempSync(join(tmpdir(), 'aegis-idea3-machine-'))
  directories.push(directory)
  return join(directory, 'audit.sqlite')
}

describe('PR10 S2 machine identity', () => {
  it('W9: accepts the pinned peer presenting a verified certificate for the expected subject', async () => {
    const { app, repository, contact } = machine()
    const action = mint(repository)

    const response = await request(app).get(`${BASE}/dispatch/pending`).set(IDENTITY)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      actions: [{ actionId: action.actionId, action: 'CUT_UPLINK', acceptedAt: ACCEPTED_AT, expiresAt: at(TTL_MS) }],
    })
    expect(contact.lastContactAt()?.toISOString()).toBe(ACCEPTED_AT)
  })

  it.each([
    ['the wrong peer', { AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '192.0.2.2' }, IDENTITY],
    ['a forwarded-for header naming the trusted peer', { AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '192.0.2.2' }, { ...IDENTITY, 'X-Forwarded-For': '192.0.2.2' }],
    ['a missing verify header', {}, { 'X-AEGIS-Client-DN': IDENTITY['X-AEGIS-Client-DN'] }],
    ['an unverified certificate', {}, { ...IDENTITY, 'X-AEGIS-Client-Verify': 'NONE' }],
    ['a failed verification', {}, { ...IDENTITY, 'X-AEGIS-Client-Verify': 'FAILED:certificate has expired' }],
    ['a lower-case success value', {}, { ...IDENTITY, 'X-AEGIS-Client-Verify': 'success' }],
    ['a duplicated verify header', {}, { ...IDENTITY, 'X-AEGIS-Client-Verify': ['SUCCESS', 'SUCCESS'] }],
    ['a missing subject', {}, { 'X-AEGIS-Client-Verify': 'SUCCESS' }],
    ['the wrong subject', {}, { ...IDENTITY, 'X-AEGIS-Client-DN': 'CN=idea3-imposter,O=AEGIS' }],
    ['an escaped subject', {}, { ...IDENTITY, 'X-AEGIS-Client-DN': 'CN=idea3\\-core,O=AEGIS' }],
    ['a multi-valued RDN', {}, { ...IDENTITY, 'X-AEGIS-Client-DN': 'CN=idea3-core+OU=ops,O=AEGIS' }],
    ['a duplicate CN', {}, { ...IDENTITY, 'X-AEGIS-Client-DN': 'CN=idea3-core,CN=idea3-core' }],
    ['a subject without a CN', {}, { ...IDENTITY, 'X-AEGIS-Client-DN': 'O=AEGIS' }],
    ['the Admin session cookie', {}, { ...IDENTITY, Cookie: 'aegis.idea3.sid=s%3Abrowser-session' }],
    ['any cookie', {}, { ...IDENTITY, Cookie: 'unrelated=1' }],
    ['a browser Origin header', {}, { ...IDENTITY, Origin: 'http://localhost' }],
  ])('W9: rejects %s with 403 and changes no state', async (_case, env, headers) => {
    const { app, repository, contact } = machine({ env })
    const action = mint(repository)

    const listed = await request(app).get(`${BASE}/dispatch/pending`).set(headers)
    const claimed = await claim(app, action.actionId, headers)

    for (const response of [listed, claimed]) {
      expect(response.status).toBe(403)
      expect(response.body).toEqual({ error: { code: 'MACHINE_IDENTITY_INVALID' } })
    }
    expect(repository.readDispatchAction(action.actionId).state).toBe('PENDING_DISPATCH')
    expect(claimedAudit(repository)).toEqual([])
    expect(contact.lastContactAt()).toBeNull()
  })

  it('refuses to build the machine app while dispatch is disabled', () => {
    const config = loadConfig({ NODE_ENV: 'test' })

    expect(() => createMachineApp({
      config,
      repository: createMemoryRepository(),
      contact: createMachineContactTracker({ clock: () => new Date() }),
    })).toThrow(/dispatch/)
  })
})

describe('PR10 S2 claim', () => {
  it('W6: claims a pending action within the TTL, records the claim, and stops listing it', async () => {
    const { app, repository, clock } = machine()
    const action = mint(repository)
    clock.set(at(30_000))

    const response = await claim(app, action.actionId)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      actionId: action.actionId,
      action: 'CUT_UPLINK',
      state: 'CORE_CLAIMED',
      claimedAt: at(30_000),
      expiresAt: at(TTL_MS),
    })
    expect(repository.readDispatchAction(action.actionId)).toEqual(expect.objectContaining({
      state: 'CORE_CLAIMED', claimedAt: at(30_000), claimedBy: 'idea3-core',
    }))
    expect(claimedAudit(repository)).toEqual([expect.objectContaining({
      outcome: 'SUCCESS', actorRef: 'machine-core', resourceType: 'dispatch_action', resourceId: action.actionId,
    })])
    expect(repository.listPendingDispatchActions()).toEqual([])
  })

  it('W7: of parallel claims exactly one wins; the rest receive 409 and nothing is claimed twice', async () => {
    const { app, repository } = machine()
    const action = mint(repository)

    const responses = await Promise.all(Array.from({ length: 5 }, () => claim(app, action.actionId)))

    expect(responses.filter(({ status }) => status === 200)).toHaveLength(1)
    const losers = responses.filter(({ status }) => status !== 200)
    expect(losers).toHaveLength(4)
    for (const loser of losers) {
      expect(loser.status).toBe(409)
      expect(loser.body.error.code).toBe('ACTION_ALREADY_CLAIMED')
    }
    expect(claimedAudit(repository)).toHaveLength(1)
  })

  it('W7: a replayed claim from the same machine identity is refused with 409', async () => {
    const { app, repository } = machine()
    const action = mint(repository)

    expect((await claim(app, action.actionId)).status).toBe(200)
    const replay = await claim(app, action.actionId)

    expect(replay.status).toBe(409)
    expect(replay.body.error.code).toBe('ACTION_ALREADY_CLAIMED')
    expect(claimedAudit(repository)).toHaveLength(1)
  })

  it('W8: an action is claimable just before 120 s and gone (410, never listed) from 120 s', async () => {
    const { app, repository, clock } = machine()
    const early = mint(repository, 'inc-0000-claim-early')
    const late = mint(repository, 'inc-0001-claim-late')

    clock.set(at(TTL_MS - 1))
    expect((await claim(app, early.actionId)).status).toBe(200)

    clock.set(at(TTL_MS))
    const expired = await claim(app, late.actionId)

    expect(expired.status).toBe(410)
    expect(expired.body.error.code).toBe('ACTION_EXPIRED')
    expect(repository.readDispatchAction(late.actionId).state).toBe('EXPIRED')
    expect((await request(app).get(`${BASE}/dispatch/pending`).set(IDENTITY)).body).toEqual({ actions: [] })
  })

  it('reports an unknown action as 404 and a malformed action id as 400', async () => {
    const { app } = machine()

    const unknown = await claim(app, '5b0e3c1e-0000-4000-8000-000000000000')
    const malformed = await Promise.all(['not-a-uuid', '5B0E3C1E-8F6A-4C2D-9B7E-2F1A0C9D8E7F'].map((id) => claim(app, id)))

    expect(unknown.status).toBe(404)
    expect(unknown.body.error.code).toBe('ACTION_NOT_FOUND')
    for (const response of malformed) {
      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('ACTION_ID_INVALID')
    }
  })

  it('rejects a claim body with any field, or an oversized body, without claiming', async () => {
    const { app, repository } = machine()
    const action = mint(repository)

    const extra = await claim(app, action.actionId, IDENTITY, { action: 'RESTORE_UPLINK' })
    const oversized = await claim(app, action.actionId, IDENTITY, { padding: 'x'.repeat(9 * 1024) })

    expect(extra.status).toBe(400)
    expect(oversized.status).toBe(413)
    expect(repository.readDispatchAction(action.actionId).state).toBe('PENDING_DISPATCH')
  })

  it('W11: a stored non-CUT_UPLINK action is never listed and is refused at claim', async () => {
    const path = sqlitePath()
    const clock = mutableClock()
    const repository = createSqliteRepository({ path, clock })
    opened.push(repository)
    repository.recordContainmentDecision({ ...DECISION, incidentId: 'inc-restore-injected' })
    const injectedId = '5b0e3c1e-8f6a-4c2d-9b7e-2f1a0c9d8e7f'
    // Bypass the schema CHECK only to prove the claim path re-checks the action itself.
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA ignore_check_constraints = 1')
    const auditId = raw.prepare('SELECT id FROM audit_log ORDER BY id DESC LIMIT 1').get().id
    raw.prepare(`
      INSERT INTO dispatch_actions (action_id, incident_id, action, state, accepted_at, expires_at, audit_id)
      VALUES (?, 'inc-restore-injected', 'RESTORE_UPLINK', 'PENDING_DISPATCH', ?, ?, ?)
    `).run(injectedId, ACCEPTED_AT, at(TTL_MS), auditId)
    raw.close()
    const { app } = machine({ repository, clock })

    const listed = await request(app).get(`${BASE}/dispatch/pending`).set(IDENTITY)
    const response = await claim(app, injectedId)

    expect(listed.body).toEqual({ actions: [] })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('ACTION_NOT_DISPATCHABLE')
    expect(repository.readDispatchAction(injectedId)).toEqual(expect.objectContaining({ state: 'PENDING_DISPATCH', claimedBy: null }))
    expect(claimedAudit(repository)).toEqual([])
  })
})

describe('PR10 S2 machine and browser app isolation', () => {
  const MACHINE_PATHS = [
    `${BASE}/dispatch/pending`,
    '/api/MACHINE/v1/dispatch/pending',
    '/api/machine/V1/dispatch/pending',
    '/api/machine/v1/DISPATCH/pending',
  ]

  it('W10: the browser app serves no machine path, even with an Admin session and identity headers', async () => {
    const repository = createMemoryRepository({ clock: mutableClock() })
    const app = createApp({ config: loadConfig(dispatchEnv()), repository })
    const agent = request.agent(app)
    await agent
      .post('/api/auth/login')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ username: 'admin', password: 'correct-horse-battery-staple' })
    const action = mint(repository)

    for (const path of MACHINE_PATHS) {
      const response = await agent.get(path).set(IDENTITY)
      expect(response.status).toBe(404)
    }
    const claimAttempt = await agent.post(`${BASE}/dispatch/${action.actionId}/claim`).set(IDENTITY).send({})

    expect(claimAttempt.status).toBe(404)
    expect(repository.readDispatchAction(action.actionId).state).toBe('PENDING_DISPATCH')
  })

  it('W10: the machine app serves no Admin, auth, security, or health route, and no machine path in another case', async () => {
    const { app } = machine()
    const paths = ['/api/auth/login', '/api/security/snapshot', '/api/health', '/api/readiness', '/', ...MACHINE_PATHS.slice(1)]

    for (const path of paths) {
      const response = await request(app).get(path).set(IDENTITY)
      expect(response.status).toBe(404)
    }
    const login = await request(app).post('/api/auth/login').set(IDENTITY).send({ username: 'admin', password: 'correct-horse-battery-staple' })
    expect(login.status).toBe(404)
  })

  it('W10: the machine app sets no cookie and never lets a response be cached', async () => {
    const { app } = machine()

    const response = await request(app).get(`${BASE}/dispatch/pending`).set(IDENTITY)

    expect(response.status).toBe(200)
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(response.headers['cache-control']).toBe('no-store')
  })
})

// An injected listen() records where each listener would bind; no real port is opened.
function fakeListen() {
  const calls = []
  const listen = (app, port, host) => {
    const server = new EventEmitter()
    server.listening = false
    server.close = (callback) => {
      server.listening = false
      setImmediate(() => callback?.())
    }
    calls.push({ app, port, host, server })
    setImmediate(() => {
      server.listening = true
      server.emit('listening')
    })
    return server
  }
  return { calls, listen }
}

describe('PR10 S2 machine listener', () => {
  it('starts only the browser listener while dispatch is disabled (the default)', async () => {
    const { calls, listen } = fakeListen()

    const runtime = await startServer({ config: loadConfig({ NODE_ENV: 'test' }), repository: createMemoryRepository(), listen })

    expect(calls.map(({ port, host }) => ({ port, host }))).toEqual([{ port: 8003, host: '127.0.0.1' }])
    expect(runtime.machineServer).toBeNull()
    await runtime.close()
  })

  it('binds the machine listener to the configured dispatch host and port, never a hard-coded address', async () => {
    const { calls, listen } = fakeListen()
    const config = loadConfig(dispatchEnv({ AEGIS_IDEA3_DISPATCH_HOST: '192.0.2.10', AEGIS_IDEA3_DISPATCH_PORT: '18555' }))

    const runtime = await startServer({ config, repository: createMemoryRepository(), listen })

    expect(calls.map(({ port, host }) => ({ port, host }))).toEqual([
      { port: 8003, host: '127.0.0.1' },
      { port: 18555, host: '192.0.2.10' },
    ])
    expect(calls[1].app).not.toBe(calls[0].app)
    expect(runtime.machineServer).toBe(calls[1].server)
    await runtime.close()
    expect(calls.every(({ server }) => server.listening === false)).toBe(true)
  })

  it('shares one repository between the browser and machine apps and closes it once', async () => {
    const { calls, listen } = fakeListen()
    const repository = createMemoryRepository({ clock: mutableClock() })
    const close = vi.spyOn(repository, 'close')
    const action = mint(repository)

    const runtime = await startServer({ config: loadConfig(dispatchEnv()), repository, listen })
    const listed = await request(calls[1].app).get(`${BASE}/dispatch/pending`).set(IDENTITY)
    await runtime.close()
    await runtime.close()

    expect(listed.body.actions.map(({ actionId }) => actionId)).toEqual([action.actionId])
    expect(close).toHaveBeenCalledTimes(1)
  })
})
