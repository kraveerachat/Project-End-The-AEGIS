import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createDemoProvider } from '../../server/providers/demoProvider.js'
import { createLiveProvider } from '../../server/providers/liveProvider.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { fixedNow } from '../fixtures/evidence.js'

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

function buildApp(configValue = config()) {
  const clock = () => fixedNow
  return createApp({
    config: configValue,
    clock,
    demoProvider: createDemoProvider({ clock }),
    liveProvider: createLiveProvider({ config: configValue, clock, fetchImpl: async () => { throw new Error('offline') } }),
    repository: createMemoryRepository({ clock }),
  })
}

async function authenticatedAgent(app) {
  const agent = request.agent(app)
  const login = await agent
    .post('/api/auth/login')
    .set('Origin', 'http://localhost')
    .set('Host', 'localhost')
    .send({ username: 'admin', password: 'correct-horse-battery-staple' })
  return { agent, csrfToken: login.body.csrfToken }
}

function write(agent, csrfToken, path) {
  return agent.post(path)
    .set('Origin', 'http://localhost')
    .set('Host', 'localhost')
    .set('x-csrf-token', csrfToken)
}

describe('security snapshot routes', () => {
  it('requires an authenticated Admin for snapshot data', async () => {
    const response = await request(buildApp()).get('/api/security/snapshot')
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('keeps Demo and Live records structurally separate', async () => {
    const { agent, csrfToken } = await authenticatedAgent(buildApp())

    await write(agent, csrfToken, '/api/security/demo-mode').send({ enabled: true })
    const demo = await agent.get('/api/security/snapshot')
    await write(agent, csrfToken, '/api/security/demo-mode').send({ enabled: false })
    const live = await agent.get('/api/security/snapshot')

    expect(demo.body.mode).toBe('DEMO')
    expect(demo.body.events.some((event) => event.id.startsWith('demo-'))).toBe(true)
    expect(live.body.mode).toBe('LIVE')
    expect(live.body.events.some((event) => event.id.startsWith('demo-'))).toBe(false)
    expect(live.body.overall.status).toBe('UNKNOWN')
  })

  it('hard-denies Demo mode when production policy disables it', async () => {
    // Route-level policy test keeps an HTTP test cookie; config.test.js separately proves
    // that real production configuration always sets demoAllowed to false.
    const productionLike = Object.freeze({ ...config(), demoAllowed: false })
    const { agent, csrfToken } = await authenticatedAgent(buildApp(productionLike))
    const response = await write(agent, csrfToken, '/api/security/demo-mode').send({ enabled: true })
    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('DEMO_DISABLED')
  })

  it('rejects unbounded query input', async () => {
    const { agent } = await authenticatedAgent(buildApp())
    const response = await agent.get('/api/security/snapshot?limit=10000')
    expect(response.status).toBe(400)
    expect(response.body.error.code).toBe('QUERY_INVALID')
  })

  it('audits an alert acknowledgement without trusting an actor from the client', async () => {
    const { agent, csrfToken } = await authenticatedAgent(buildApp())
    await write(agent, csrfToken, '/api/security/demo-mode').send({ enabled: true })
    const response = await write(agent, csrfToken, '/api/security/alerts/demo-alert-001/acknowledge').send({})
    expect(response.status).toBe(200)
    expect(response.body.alert.status).toBe('ACKNOWLEDGED')
    expect(response.body.audit).toMatchObject({
      category: 'ALERT', action: 'ACKNOWLEDGE', outcome: 'SUCCESS', actorRef: 'session-admin', resourceId: 'demo-alert-001',
    })
  })

  it('validates recovery in dry-run without exposing a hardware action', async () => {
    const { agent, csrfToken } = await authenticatedAgent(buildApp())
    await write(agent, csrfToken, '/api/security/demo-mode').send({ enabled: true })
    const response = await write(agent, csrfToken, '/api/security/recovery/dry-run').send({ incidentId: 'demo-inc-001', confirmation: 'VALIDATE ONLY' })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ dryRun: true, hardwareAction: false, publishAttempted: false })
  })
})
