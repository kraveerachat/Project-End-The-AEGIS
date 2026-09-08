import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createDemoProvider } from '../../server/providers/demoProvider.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { containmentBoundary, evaluateContainmentDecision } from '../../server/domain/containment.js'

const NOW = new Date('2026-09-08T08:00:00.000Z')
const CANDIDATE = Object.freeze({
  id: 'inc-0123456789abcd',
  state: 'CONTAINMENT_CANDIDATE',
  severity: 'HIGH',
  correlationKey: 'zone-a-incident-42',
  firstSeen: '2026-09-08T07:55:00.000Z',
  lastSeen: '2026-09-08T08:00:00.000Z',
  idea1Count: 1,
  idea2Count: 1,
  evidenceIds: ['IDEA1:idea1-event-1', 'IDEA2:idea2-event-1'],
  responseState: 'NOT_REQUESTED',
})

function config(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
    AEGIS_ALLOW_DEV_LOGIN: 'true',
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple',
    ...overrides,
  })
}

function liveProviderWith(incidents) {
  return {
    getSnapshot: async () => ({
      schemaVersion: 1,
      mode: 'LIVE',
      generatedAt: NOW.toISOString(),
      overall: { status: 'HEALTHY', evidenceAgeMs: null, eventCount: 0, activeIncidents: incidents.length, highAlerts: 0 },
      sources: [], events: [], alerts: [], incidents, audit: [], devices: [],
      runtime: { status: 'UNKNOWN', operationalErrors: [] },
      operationalErrors: [],
      settings: { policy: {}, adapters: [], security: {} },
      provenance: { provider: 'test', liveMerged: false, persistence: 'SQLITE_AUDIT_ONLY' },
    }),
  }
}

function buildApp({ incidents = [CANDIDATE], repository = createMemoryRepository({ clock: () => NOW }) } = {}) {
  return createApp({
    config: config(),
    clock: () => NOW,
    demoProvider: createDemoProvider({ clock: () => NOW }),
    liveProvider: liveProviderWith(incidents),
    repository,
  })
}

async function adminAgent(app) {
  const agent = request.agent(app)
  const login = await agent
    .post('/api/auth/login')
    .set('Origin', 'http://localhost')
    .set('Host', 'localhost')
    .send({ username: 'admin', password: 'correct-horse-battery-staple' })
  return { agent, csrfToken: login.body.csrfToken }
}

function decide(agent, csrfToken, body, incidentId = CANDIDATE.id) {
  return agent
    .post(`/api/security/incidents/${incidentId}/containment`)
    .set('Origin', 'http://localhost')
    .set('Host', 'localhost')
    .set('X-CSRF-Token', csrfToken)
    .send(body)
}

describe('containment decision domain boundary', () => {
  it('reports every downstream command and physical stage as not reached', () => {
    expect(containmentBoundary()).toEqual({
      command_requested: false,
      command_published: false,
      acknowledged: false,
      executed: false,
      physical_evidence: false,
    })
  })

  it.each([
    ['ACCEPT', 'CONTAINMENT_ACCEPTED'],
    ['REJECT', 'CONTAINMENT_REJECTED'],
  ])('maps the %s decision to %s for a current candidate', (decision, state) => {
    expect(evaluateContainmentDecision({ incident: CANDIDATE, decision })).toEqual({ ok: true, state })
  })

  it.each([
    ['a missing incident', undefined],
    ['an incident that is not a candidate', { ...CANDIDATE, state: 'CONTAINMENT_ACCEPTED' }],
    ['an incident with no state', { ...CANDIDATE, state: undefined }],
  ])('refuses a decision for %s', (_case, incident) => {
    expect(evaluateContainmentDecision({ incident, decision: 'ACCEPT' }))
      .toEqual({ ok: false, error: { code: 'INCIDENT_NOT_CANDIDATE' } })
  })

  it('refuses an unsupported decision value', () => {
    expect(evaluateContainmentDecision({ incident: CANDIDATE, decision: 'EXECUTE' }))
      .toEqual({ ok: false, error: { code: 'DECISION_INVALID' } })
  })
})

describe('containment acceptance route', () => {
  it('records an Admin acceptance without requesting or publishing any command', async () => {
    const app = buildApp()
    const { agent, csrfToken } = await adminAgent(app)

    const response = await decide(agent, csrfToken, { decision: 'ACCEPT' })

    expect(response.status).toBe(200)
    expect(response.body.containment).toEqual({
      incident_id: CANDIDATE.id,
      state: 'CONTAINMENT_ACCEPTED',
      command_requested: false,
      command_published: false,
      acknowledged: false,
      executed: false,
      physical_evidence: false,
    })
    expect(response.body.audit).toEqual(expect.objectContaining({ action: 'CONTAINMENT_ACCEPTED', outcome: 'SUCCESS' }))
  })

  it('records an Admin rejection with the same non-command boundary', async () => {
    const { agent, csrfToken } = await adminAgent(buildApp())

    const response = await decide(agent, csrfToken, { decision: 'REJECT' })

    expect(response.status).toBe(200)
    expect(response.body.containment).toEqual(expect.objectContaining({
      state: 'CONTAINMENT_REJECTED', command_requested: false, physical_evidence: false,
    }))
  })

  it('denies an unauthenticated decision', async () => {
    const response = await request(buildApp())
      .post(`/api/security/incidents/${CANDIDATE.id}/containment`)
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ decision: 'ACCEPT' })

    expect(response.status).toBe(401)
  })

  it('denies a cross-origin decision', async () => {
    const { agent, csrfToken } = await adminAgent(buildApp())

    const response = await agent
      .post(`/api/security/incidents/${CANDIDATE.id}/containment`)
      .set('Origin', 'https://attacker.example')
      .set('Host', 'localhost')
      .set('X-CSRF-Token', csrfToken)
      .send({ decision: 'ACCEPT' })

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('ORIGIN_INVALID')
  })

  it('denies a decision without a valid CSRF token', async () => {
    const { agent } = await adminAgent(buildApp())

    const response = await agent
      .post(`/api/security/incidents/${CANDIDATE.id}/containment`)
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .set('X-CSRF-Token', 'forged-token')
      .send({ decision: 'ACCEPT' })

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('CSRF_INVALID')
  })

  it.each([
    ['an unknown incident', 'inc-does-not-exist'],
    ['a malformed incident id', 'inc-../../etc/passwd'],
  ])('refuses a decision for %s', async (_case, incidentId) => {
    const { agent, csrfToken } = await adminAgent(buildApp())

    const response = await decide(agent, csrfToken, { decision: 'ACCEPT' }, encodeURIComponent(incidentId))

    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.body.containment).toBeUndefined()
  })

  it('refuses a decision for an incident that is not a current candidate', async () => {
    const app = buildApp({ incidents: [{ ...CANDIDATE, state: 'CONTAINMENT_ACCEPTED' }] })
    const { agent, csrfToken } = await adminAgent(app)

    const response = await decide(agent, csrfToken, { decision: 'ACCEPT' })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('INCIDENT_NOT_CANDIDATE')
  })

  it.each([
    ['an unsupported decision', { decision: 'EXECUTE' }],
    ['a command request', { decision: 'ACCEPT', command_requested: true }],
    ['a missing decision', {}],
  ])('rejects %s', async (_case, body) => {
    const { agent, csrfToken } = await adminAgent(buildApp())

    const response = await decide(agent, csrfToken, body)

    expect(response.status).toBe(400)
    expect(response.body.containment).toBeUndefined()
  })

  it('is idempotent for a repeated identical decision', async () => {
    const repository = createMemoryRepository({ clock: () => NOW })
    const { agent, csrfToken } = await adminAgent(buildApp({ repository }))

    const first = await decide(agent, csrfToken, { decision: 'ACCEPT' })
    const second = await decide(agent, csrfToken, { decision: 'ACCEPT' })

    expect(second.status).toBe(200)
    expect(second.body.containment).toEqual(first.body.containment)
    expect(repository.queryAudit({ limit: 50 }).filter((row) => row.action === 'CONTAINMENT_ACCEPTED')).toHaveLength(1)
  })

  it('conflicts on an opposite repeated decision instead of silently overwriting', async () => {
    const { agent, csrfToken } = await adminAgent(buildApp())

    await decide(agent, csrfToken, { decision: 'ACCEPT' })
    const reversed = await decide(agent, csrfToken, { decision: 'REJECT' })

    expect(reversed.status).toBe(409)
    expect(reversed.body.error.code).toBe('CONTAINMENT_DECISION_CONFLICT')
    expect(reversed.body.containment).toBeUndefined()
  })

  it('refuses to record a live containment decision while Demo Mode is active', async () => {
    const app = buildApp()
    const { agent, csrfToken } = await adminAgent(app)
    await agent
      .post('/api/security/demo-mode')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .set('X-CSRF-Token', csrfToken)
      .send({ enabled: true })

    const response = await decide(agent, csrfToken, { decision: 'ACCEPT' })

    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('DEMO_MODE_ACTIVE')
  })

  it('never imports a controller, broker, MQTT, firmware, or command module', async () => {
    const { readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const sources = [
      readFileSync(resolve(process.cwd(), 'server/routes/securityRoutes.js'), 'utf8'),
      readFileSync(resolve(process.cwd(), 'server/domain/containment.js'), 'utf8'),
    ]

    for (const source of sources) {
      const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(([, specifier]) => specifier)
      expect(imports.some((specifier) => /mqtt|broker|firmware|controller|command|paho|serial/i.test(specifier))).toBe(false)
    }
  })
})
