import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createMachineApp } from '../../server/createMachineApp.js'
import { createDemoProvider } from '../../server/providers/demoProvider.js'
import { createLiveProvider } from '../../server/providers/liveProvider.js'
import { createSqliteRepository } from '../../server/repositories/sqliteRepository.js'
import { createMachineContactTracker } from '../../server/security/machineIdentity.js'
import { healthyRuntimeRaw } from '../fixtures/evidence.js'

/**
 * AEGIS IDEA3 local, non-production end-to-end acceptance (live contract path).
 *
 * Real Express apps, real HTTP request/response, real session + CSRF + SQLite repository (in memory).
 * The ONLY injected pieces are the upstream IDEA1/IDEA2/runtime HTTP responses (a test-only fetchImpl) and the
 * Core's machine identity headers. Nothing here can reach MQTT, an ESP32, or Production: the Core is simulated
 * by calling the same machine routes the real Core would, and the Web never publishes.
 */
const contract = JSON.parse(readFileSync(join(process.cwd(), '..', 'tests', 'fixtures', 'dispatch-contract.json'), 'utf8'))
const route = contract.machineRoute
const PASSWORD = 'correct-horse-battery-staple'
const NOW = new Date('2026-09-08T08:00:00.000Z')
const URLS = Object.freeze({
  idea1: 'https://idea1.internal/api/integration/events',
  idea2: 'https://idea2.internal/api/integration/events',
  runtime: 'https://idea3.internal/api/runtime/status',
})
const IDENTITY = Object.freeze({
  [route.edgeIdentityHeaders.verify]: route.edgeIdentityHeaders.verifySuccess,
  [route.edgeIdentityHeaders.subjectDn]: 'CN=idea3-core,O=AEGIS',
})

function envFor(overrides = {}) {
  return {
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
    AEGIS_ALLOW_DEV_LOGIN: 'true',
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_DEV_PASSWORD: PASSWORD,
    AEGIS_IDEA3_DISPATCH_ENABLED: 'true',
    AEGIS_IDEA3_DISPATCH_PORT: '18103',
    AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '127.0.0.1',
    AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: 'idea3-core',
    ...overrides,
  }
}

const json = (body, ok = true) => ({ ok, redirected: false, text: async () => JSON.stringify(body) })
const rawEvent = (source, overrides = {}) => ({
  source,
  event_id: `${source.toLowerCase()}-event-1`,
  event_type: 'ACCESS_DENIED',
  severity: 'WARNING',
  occurred_at: '2026-09-08T07:59:55.000Z',
  resource: source === 'IDEA1' ? 'AEGIS Drive' : 'CAM-02',
  evidence: { result: 'DENIED' },
  correlation_key: 'zone-a-incident-42',
  ...overrides,
})
const feed = (events) => ({ schema_version: 1, generated_at: NOW.toISOString(), events, status: { ok: true } })

/** Build the full stack. `upstream` maps a URL to a response factory; anything unmapped fails like an offline host. */
function stack({ configured = true, upstream = {}, dispatch = true } = {}) {
  const env = envFor(configured ? {
    AEGIS_IDEA1_STATUS_URL: URLS.idea1,
    AEGIS_IDEA2_STATUS_URL: URLS.idea2,
    AEGIS_IDEA3_RUNTIME_STATUS_URL: URLS.runtime,
    AEGIS_IDEA1_INTEGRATION_TOKEN: 'idea1-integration-credential',
    AEGIS_IDEA2_INTEGRATION_TOKEN: 'idea2-integration-credential',
  } : {})
  if (!dispatch) delete env.AEGIS_IDEA3_DISPATCH_ENABLED
  const config = loadConfig(env)
  const clock = () => NOW
  const fetchImpl = async (url) => {
    const factory = upstream[url]
    if (!factory) throw new Error('offline')
    return factory()
  }
  const repository = createSqliteRepository({ path: ':memory:', clock })
  const contact = createMachineContactTracker({ clock })
  const app = createApp({
    config,
    clock,
    demoProvider: createDemoProvider({ clock }),
    liveProvider: createLiveProvider({ config, clock, fetchImpl }),
    repository,
    machineContact: contact,
  })
  const machine = config.dispatch.enabled ? createMachineApp({ config, repository, contact }) : null
  return { app, machine, repository, config }
}

const healthyUpstream = () => ({
  [URLS.idea1]: () => json(feed([rawEvent('IDEA1')])),
  [URLS.idea2]: () => json(feed([rawEvent('IDEA2')])),
  [URLS.runtime]: () => json({ ...healthyRuntimeRaw, generatedAt: NOW.toISOString() }),
})

async function login(app) {
  const agent = request.agent(app)
  const response = await agent.post('/api/auth/login').set('Origin', 'http://localhost').set('Host', 'localhost')
    .send({ username: 'admin', password: PASSWORD })
  expect(response.status).toBe(200)
  return { agent, csrf: response.body.csrfToken }
}
const write = (agent, csrf, method, path, body = {}) => agent[method](path).set('Origin', 'http://localhost').set('Host', 'localhost').set('x-csrf-token', csrf).send(body)
const snapshot = async (agent) => (await agent.get('/api/security/snapshot')).body
const base = route.basePath
const claim = (machine, actionId) => request(machine).post(`${base}/dispatch/${actionId}/claim`).set(IDENTITY).send({})
const report = (machine, actionId, sequence, stage, detail = {}) => request(machine)
  .post(`${base}/dispatch/${actionId}/evidence`).set(IDENTITY)
  .send({ sequence, stage, observedAt: '2026-09-08T08:00:10.000Z', detail })

describe('A. authentication, CSRF and fail-closed access (real HTTP)', () => {
  it('rejects every protected route without a session and every write without Origin and CSRF proof', async () => {
    const { app } = stack({ upstream: healthyUpstream() })
    for (const [method, path] of [
      ['get', '/api/security/snapshot'], ['get', '/api/security/audit'], ['post', '/api/security/demo-mode'],
      ['post', '/api/security/incidents/inc-1/containment'], ['post', '/api/security/recovery/dry-run'], ['patch', '/api/security/settings'],
    ]) {
      const response = await request(app)[method](path).set('Origin', 'http://localhost').set('Host', 'localhost').send({})
      expect(response.status, `${method} ${path}`).toBe(401)
    }

    const { agent, csrf } = await login(app)
    const noCsrf = await agent.post('/api/security/demo-mode').set('Origin', 'http://localhost').set('Host', 'localhost').send({ enabled: true })
    const crossOrigin = await agent.post('/api/security/demo-mode').set('Origin', 'http://evil.example').set('Host', 'localhost').set('x-csrf-token', csrf).send({ enabled: true })
    const wrongCsrf = await agent.post('/api/security/demo-mode').set('Origin', 'http://localhost').set('Host', 'localhost').set('x-csrf-token', 'x'.repeat(64)).send({ enabled: true })
    expect([noCsrf.status, crossOrigin.status, wrongCsrf.status]).toEqual([403, 403, 403])
    expect([noCsrf.body.error.code, crossOrigin.body.error.code, wrongCsrf.body.error.code]).toEqual(['CSRF_INVALID', 'ORIGIN_INVALID', 'CSRF_INVALID'])
  })

  it('answers wrong credentials uniformly, ends the session on logout, and rate-limits repeated failures', async () => {
    const { app } = stack({ upstream: healthyUpstream() })
    const bad = await request(app).post('/api/auth/login').set('Origin', 'http://localhost').set('Host', 'localhost').send({ username: 'admin', password: 'wrong' })
    const unknown = await request(app).post('/api/auth/login').set('Origin', 'http://localhost').set('Host', 'localhost').send({ username: 'nobody', password: PASSWORD })
    expect(bad.status).toBe(401)
    expect(unknown.body).toEqual(bad.body)

    const { agent, csrf } = await login(app)
    expect((await write(agent, csrf, 'post', '/api/auth/logout')).status).toBe(204)
    expect((await agent.get('/api/security/snapshot')).status).toBe(401)

    let last
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await request(app).post('/api/auth/login').set('Origin', 'http://localhost').set('Host', 'localhost').send({ username: 'admin', password: 'wrong' })
    }
    expect(last.status).toBe(429)
  })

  it('never accepts the development login in a production configuration', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production', AEGIS_ALLOW_DEV_LOGIN: 'true', AEGIS_IDEA3_DEV_PASSWORD: PASSWORD,
      SESSION_SECRET: 'Prod-Secret-0123456789-abcdefXYZ!!', AEGIS_WEB_STATIC_DIR: process.cwd(),
    })).toThrow(/PASSWORD_HASH/)
    expect(loadConfig(envFor({ NODE_ENV: 'development' })).demoAllowed).toBe(true)
  })
})

describe('B. unconfigured and degraded integrations are reported as such, never invented', () => {
  it('reports NOT_CONFIGURED sources, an UNKNOWN overall state, no events and no containment candidates', async () => {
    const { app } = stack({ configured: false })
    const { agent, csrf } = await login(app)
    const live = await snapshot(agent)
    const byId = Object.fromEntries(live.sources.map((source) => [source.id, source.status]))

    expect(live.mode).toBe('LIVE')
    expect(byId.idea1).toBe('NOT_CONFIGURED')
    expect(byId.idea2).toBe('NOT_CONFIGURED')
    expect(live.overall.status).toBe('UNKNOWN')
    expect(live.events).toEqual([])
    expect(live.incidents).toEqual([])
    expect(live.devices).toEqual([])
    const refused = await write(agent, csrf, 'post', '/api/security/incidents/inc-0123456789abcd/containment', { decision: 'ACCEPT' })
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('INCIDENT_NOT_CANDIDATE')
  })

  it('fails closed to UNKNOWN on an unreachable or stale upstream without leaking credentials, URLs or raw errors', async () => {
    const staleOnly = { ...healthyUpstream(), [URLS.idea1]: () => json({ ...feed([rawEvent('IDEA1', { occurred_at: '2026-09-08T07:40:00.000Z' })]), generated_at: '2026-09-08T07:40:00.000Z' }) }
    delete staleOnly[URLS.idea2] // IDEA2 is offline
    const { app } = stack({ upstream: staleOnly })
    const { agent, csrf } = await login(app)
    const live = await snapshot(agent)
    const byId = Object.fromEntries(live.sources.map((source) => [source.id, source]))

    expect(byId.idea1.status).toBe('UNKNOWN')
    expect(byId.idea1.freshness).toBe('STALE')
    expect(byId.idea2.status).toBe('UNKNOWN')
    expect(live.incidents).toEqual([])
    expect(JSON.stringify(live)).not.toMatch(/idea1-integration-credential|idea2-integration-credential|idea1\.internal|idea2\.internal|offline/)
    expect((await write(agent, csrf, 'post', '/api/security/incidents/inc-0123456789abcd/containment', { decision: 'ACCEPT' })).status).toBe(409)
  })
})

describe('C. correlation → request → dispatch → Core ACK → physical evidence stay distinct states', () => {
  it('walks one correlated incident through every stage and never implies execution or physical confirmation', async () => {
    const { app, machine, repository } = stack({ upstream: healthyUpstream() })
    const { agent, csrf } = await login(app)

    // Detection and correlation from real IDEA1 + IDEA2 contract feeds.
    const before = await snapshot(agent)
    expect(before.mode).toBe('LIVE')
    expect(before.sources.filter((s) => ['idea1', 'idea2'].includes(s.id)).map((s) => s.status)).toEqual(['HEALTHY', 'HEALTHY'])
    // Live upstream events travel in the integration envelope (the legacy evidence-page lists stay empty by design).
    expect(before.integration.events.map((event) => event.source).sort()).toEqual(['IDEA1', 'IDEA2'])
    expect(before.integration.events.every((event) => event.freshness === 'FRESH' && !String(event.event_id).startsWith('demo-'))).toBe(true)
    expect(before.events).toEqual([])
    expect(before.incidents).toHaveLength(1)
    const incident = before.incidents[0]
    expect(incident.state).toBe('CONTAINMENT_CANDIDATE')
    expect(incident.idea1Count).toBe(1)
    expect(incident.idea2Count).toBe(1)
    expect(incident.dispatch).toBeUndefined()

    // 1. REQUEST: an Admin decision records the request and mints a pending dispatch. Nothing is published.
    const accepted = await write(agent, csrf, 'post', `/api/security/incidents/${incident.id}/containment`, { decision: 'ACCEPT' })
    expect(accepted.status).toBe(200)
    expect(accepted.body.containment).toMatchObject({
      state: 'CONTAINMENT_ACCEPTED', command_requested: true, command_published: false, acknowledged: false, executed: false, physical_evidence: false,
    })
    const afterRequest = (await snapshot(agent)).incidents.find((candidate) => candidate.id === incident.id)
    expect(afterRequest.dispatch).toMatchObject({ state: 'PENDING_DISPATCH', humanReviewRequired: false })
    expect(afterRequest.responseState).toBe('DISPATCH_UNAVAILABLE') // the Core has not contacted the Web
    expect(afterRequest.dispatch.boundary).toEqual({ command_requested: true, command_published: false, acknowledged: false, executed: false, physical_evidence: false })

    // A second, conflicting decision is refused and does not mint another action.
    const conflict = await write(agent, csrf, 'post', `/api/security/incidents/${incident.id}/containment`, { decision: 'REJECT' })
    expect(conflict.status).toBe(409)
    const { actionId } = afterRequest.dispatch

    // 2. DISPATCH: only the Core, with a verified machine identity, can claim. A browser session cannot.
    expect((await request(machine).post(`${base}/dispatch/${actionId}/claim`).send({})).status).toBe(403)
    expect((await agent.post(`${base}/dispatch/${actionId}/claim`).set('Origin', 'http://localhost').set('x-csrf-token', csrf).send({})).status).toBe(404)
    expect((await claim(machine, actionId)).status).toBe(200)
    const claimed = (await snapshot(agent)).incidents.find((candidate) => candidate.id === incident.id)
    expect(claimed.dispatch.state).toBe('CORE_CLAIMED')
    expect(claimed.dispatch.boundary.command_published).toBe(false)

    // 3. PUBLISHED then ACK are separate Core-reported stages; neither is execution or physical evidence.
    expect((await report(machine, actionId, 1, 'PUBLISHED')).status).toBe(201)
    const published = (await snapshot(agent)).incidents.find((candidate) => candidate.id === incident.id)
    expect(published.dispatch.boundary).toEqual({ command_requested: true, command_published: true, acknowledged: false, executed: false, physical_evidence: false })

    expect((await report(machine, actionId, 2, 'ACK', { ackCode: 'OK' })).status).toBe(201)
    const acked = (await snapshot(agent)).incidents.find((candidate) => candidate.id === incident.id)
    expect(acked.dispatch.boundary).toEqual({ command_requested: true, command_published: true, acknowledged: true, executed: false, physical_evidence: false })

    // 4. A device-reported LOCKDOWN status correlates, but physical confirmation is still NOT claimed.
    expect((await report(machine, actionId, 3, 'STATUS', { deviceState: 'LOCKDOWN' })).status).toBe(201)
    const correlated = (await snapshot(agent)).incidents.find((candidate) => candidate.id === incident.id)
    expect(correlated.responseState).toBe('STATUS_CORRELATED')
    expect(correlated.dispatch.boundary.executed).toBe(false)
    expect(correlated.dispatch.boundary.physical_evidence).toBe(false)

    // The durable ledger holds exactly one action, and the Web published nothing itself.
    expect(repository.queryAudit({ limit: 250 }).filter((entry) => entry.action === 'CONTAINMENT_ACCEPTED')).toHaveLength(1)
  })

  it('refuses stage reports that would skip the claim or claim a physical result', async () => {
    const { app, machine } = stack({ upstream: healthyUpstream() })
    const { agent, csrf } = await login(app)
    const [incident] = (await snapshot(agent)).incidents
    await write(agent, csrf, 'post', `/api/security/incidents/${incident.id}/containment`, { decision: 'ACCEPT' })
    const { dispatch } = (await snapshot(agent)).incidents[0]

    expect((await report(machine, dispatch.actionId, 1, 'PUBLISHED')).status).toBe(409) // not claimed yet
    await claim(machine, dispatch.actionId)
    for (const stage of ['CONTAINED', 'RELAY_EVIDENCE', 'PHYSICALLY_VERIFIED']) {
      expect((await report(machine, dispatch.actionId, 1, stage)).status, stage).toBe(400)
    }
    expect((await report(machine, dispatch.actionId, 1, 'ACK', { ackCode: 'ERROR' })).status).toBe(400)
  })

  it('has no Web route to RESTORE, and recovery validation is a dry run that cannot publish or add a dispatch', async () => {
    const { app } = stack({ upstream: healthyUpstream() })
    const { agent, csrf } = await login(app)
    const [incident] = (await snapshot(agent)).incidents

    expect((await write(agent, csrf, 'post', '/api/security/recovery/restore', { incidentId: incident.id })).status).toBe(404)
    expect((await write(agent, csrf, 'post', '/api/security/recovery/execute', { incidentId: incident.id })).status).toBe(404)
    expect((await write(agent, csrf, 'post', `/api/security/incidents/${incident.id}/containment`, { decision: 'RESTORE_UPLINK' })).status).toBe(400)
    expect((await write(agent, csrf, 'post', `/api/security/incidents/${incident.id}/containment`, { decision: 'EXECUTE' })).status).toBe(400)

    const wrongPhrase = await write(agent, csrf, 'post', '/api/security/recovery/dry-run', { incidentId: incident.id, confirmation: 'RESTORE' })
    expect(wrongPhrase.status).toBe(400)
    const dryRun = await write(agent, csrf, 'post', '/api/security/recovery/dry-run', { incidentId: incident.id, confirmation: 'VALIDATE ONLY' })
    expect(dryRun.status).toBe(200)
    expect(dryRun.body).toMatchObject({ dryRun: true, hardwareAction: false, publishAttempted: false, validation: 'PRECONDITIONS_EVALUATED' })
    expect((await snapshot(agent)).incidents[0].dispatch).toBeUndefined()
  })

  it('does not mint any dispatch when dispatch is disabled: a decision remains a record only', async () => {
    const { app } = stack({ upstream: healthyUpstream(), dispatch: false })
    const { agent, csrf } = await login(app)
    const [incident] = (await snapshot(agent)).incidents
    const accepted = await write(agent, csrf, 'post', `/api/security/incidents/${incident.id}/containment`, { decision: 'ACCEPT' })
    expect(accepted.body.containment).toMatchObject({ command_requested: false, command_published: false, acknowledged: false, executed: false, physical_evidence: false })
  })
})

describe('D. Demo and Live stay separate for the same operator session', () => {
  it('shows simulated data only while Demo is active and never lets it touch the live incident, ledger or dispatch', async () => {
    const { app, repository } = stack({ upstream: healthyUpstream() })
    const { agent, csrf } = await login(app)
    const [incident] = (await snapshot(agent)).incidents
    await write(agent, csrf, 'post', `/api/security/incidents/${incident.id}/containment`, { decision: 'ACCEPT' })
    const liveBefore = (await snapshot(agent)).incidents[0]

    await write(agent, csrf, 'post', '/api/security/demo-mode', { enabled: true })
    const demo = await snapshot(agent)
    expect(demo.mode).toBe('DEMO')
    expect(demo.provenance).toMatchObject({ provider: 'isolated-demo-provider', liveMerged: false })
    expect(demo.events.every((event) => event.id.startsWith('demo-'))).toBe(true)
    expect(demo.incidents.map((candidate) => candidate.id)).toEqual(['demo-inc-001'])
    // The simulated incident never reports an executed or physically confirmed stage.
    const stages = Object.fromEntries(demo.incidents[0].evidenceStages.map((stage) => [stage.stage, stage.status]))
    expect(stages.EXECUTED).toBe('UNKNOWN')
    expect(stages['PHYSICALLY VERIFIED']).toBe('UNKNOWN')
    expect(demo.devices[0].physicalRelayState).toBe('UNKNOWN')
    expect(demo.recovery).toMatchObject({ gatewayStatus: 'DISABLED', liveHardware: false, authorization: 'DISABLED' })
    expect(demo.runtime.modes).toMatchObject({ armed: false, autoContain: false, recoveryAuthorized: false })

    // Containment of a simulated incident is refused outright, and the real request is not reachable from Demo.
    const refused = await write(agent, csrf, 'post', `/api/security/incidents/${incident.id}/containment`, { decision: 'REJECT' })
    expect(refused.status).toBe(409)
    expect(refused.body.error.code).toBe('DEMO_MODE_ACTIVE')

    await write(agent, csrf, 'post', '/api/security/demo-mode', { enabled: false })
    const liveAfter = (await snapshot(agent)).incidents[0]
    expect(liveAfter.dispatch).toEqual(liveBefore.dispatch)
    expect(repository.queryAudit({ limit: 250 }).some((entry) => String(entry.resourceId).startsWith('demo-'))).toBe(false)
  })
})
