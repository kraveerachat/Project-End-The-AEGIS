import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createDemoProvider } from '../../server/providers/demoProvider.js'
import { createLiveProvider } from '../../server/providers/liveProvider.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { createDemoRegistry } from '../../server/repositories/demoRegistry.js'
import { fixedNow } from '../fixtures/evidence.js'

const PASSWORD = 'correct-horse-battery-staple'

function config(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
    AEGIS_ALLOW_DEV_LOGIN: 'true',
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_DEV_PASSWORD: PASSWORD,
    ...overrides,
  })
}

function build(demoRegistry) {
  const clock = () => fixedNow
  const repository = createMemoryRepository({ clock })
  const configValue = config()
  const app = createApp({
    config: configValue,
    clock,
    demoProvider: createDemoProvider({ clock }),
    liveProvider: createLiveProvider({ config: configValue, clock, fetchImpl: async () => { throw new Error('offline') } }),
    repository,
    ...(demoRegistry ? { demoRegistry } : {}),
  })
  return { app, repository }
}

async function login(app) {
  const agent = request.agent(app)
  const response = await agent.post('/api/auth/login').set('Origin', 'http://localhost').set('Host', 'localhost')
    .send({ username: 'admin', password: PASSWORD })
  return { agent, csrf: response.body.csrfToken }
}

const post = (agent, csrf, path, body = {}) => agent.post(path).set('Origin', 'http://localhost').set('Host', 'localhost').set('x-csrf-token', csrf).send(body)
const patch = (agent, csrf, path, body = {}) => agent.patch(path).set('Origin', 'http://localhost').set('Host', 'localhost').set('x-csrf-token', csrf).send(body)

describe('Demo Mode record isolation (simulated activity never becomes live evidence)', () => {
  it('keeps every Demo write action out of the durable Live repository and Live snapshot', async () => {
    const { app, repository } = build()
    const { agent, csrf } = await login(app)
    const livePolicyBefore = (await agent.get('/api/security/snapshot')).body.settings.policy
    const liveAuditBefore = repository.queryAudit({ limit: 250 }).length

    await post(agent, csrf, '/api/security/demo-mode', { enabled: true })
    expect((await post(agent, csrf, '/api/security/alerts/demo-alert-001/acknowledge')).status).toBe(200)
    expect((await post(agent, csrf, '/api/security/incidents/demo-inc-001/notes', { note: 'rehearsal note' })).status).toBe(200)
    expect((await post(agent, csrf, '/api/security/recovery/dry-run', { incidentId: 'demo-inc-001', confirmation: 'VALIDATE ONLY' })).status).toBe(200)
    expect((await patch(agent, csrf, '/api/security/settings', { escalationThreshold: 77 })).status).toBe(200)
    expect((await post(agent, csrf, '/api/security/audit/export')).status).toBe(202)

    // Inside Demo Mode the presenter still sees the effect of their own actions…
    const demo = await agent.get('/api/security/snapshot')
    expect(demo.body.mode).toBe('DEMO')
    expect(demo.body.alerts.find((alert) => alert.id === 'demo-alert-001').status).toBe('ACKNOWLEDGED')
    expect(demo.body.incidents[0].analystNote).toBe('rehearsal note')
    expect(demo.body.settings.policy.escalationThreshold).toBe(77)

    await post(agent, csrf, '/api/security/demo-mode', { enabled: false })

    // …but the durable Live repository saw none of it except the truthful mode toggles.
    const liveAudit = repository.queryAudit({ limit: 250 })
    const added = liveAudit.slice(0, liveAudit.length - liveAuditBefore)
    expect(added.map((entry) => `${entry.category}/${entry.action}`)).toEqual(['SETTINGS/DEMO_MODE', 'SETTINGS/DEMO_MODE'])
    expect(liveAudit.some((entry) => String(entry.resourceId).startsWith('demo-'))).toBe(false)

    const live = await agent.get('/api/security/snapshot')
    expect(live.body.mode).toBe('LIVE')
    expect(live.body.settings.policy).toEqual(livePolicyBefore)
    expect(live.body.audit.some((entry) => String(entry.resourceId).startsWith('demo-'))).toBe(false)
  })

  it('serves the audit ledger of the active mode only', async () => {
    const { app } = build()
    const { agent, csrf } = await login(app)

    await post(agent, csrf, '/api/security/demo-mode', { enabled: true })
    await post(agent, csrf, '/api/security/alerts/demo-alert-002/acknowledge')
    const demoAudit = (await agent.get('/api/security/audit?limit=50')).body.audit
    expect(demoAudit.map((entry) => entry.action)).toContain('ACKNOWLEDGE')
    expect(demoAudit.some((entry) => entry.action === 'LOGIN')).toBe(false)

    await post(agent, csrf, '/api/security/demo-mode', { enabled: false })
    const liveAudit = (await agent.get('/api/security/audit?limit=50')).body.audit
    expect(liveAudit.map((entry) => entry.action)).not.toContain('ACKNOWLEDGE')
    expect(liveAudit.map((entry) => entry.action)).toContain('LOGIN')
  })

  it('discards Demo state on deactivation, on re-activation and on logout, and never shares it between sessions', async () => {
    const { app } = build()
    const first = await login(app)
    const second = await login(app)

    await post(first.agent, first.csrf, '/api/security/demo-mode', { enabled: true })
    await post(first.agent, first.csrf, '/api/security/alerts/demo-alert-001/acknowledge')
    await post(second.agent, second.csrf, '/api/security/demo-mode', { enabled: true })
    const other = await second.agent.get('/api/security/snapshot')
    expect(other.body.alerts.find((alert) => alert.id === 'demo-alert-001').status).toBe('UNACKNOWLEDGED')

    await post(first.agent, first.csrf, '/api/security/demo-mode', { enabled: false })
    await post(first.agent, first.csrf, '/api/security/demo-mode', { enabled: true })
    const fresh = await first.agent.get('/api/security/snapshot')
    expect(fresh.body.alerts.find((alert) => alert.id === 'demo-alert-001').status).toBe('UNACKNOWLEDGED')
  })

  it('never mints or reports a containment dispatch for a simulated incident', async () => {
    const { app, repository } = build()
    const { agent, csrf } = await login(app)
    await post(agent, csrf, '/api/security/demo-mode', { enabled: true })
    const response = await post(agent, csrf, '/api/security/incidents/demo-inc-001/containment', { decision: 'ACCEPT' })
    expect(response.status).toBe(409)
    expect(response.body.error.code).toBe('DEMO_MODE_ACTIVE')
    expect(repository.queryAudit({ limit: 250 }).some((entry) => entry.category === 'CONTAINMENT')).toBe(false)
  })
})

describe('Demo registry lifecycle', () => {
  it('releases the simulated repository on logout and bounds the number of live Demo sessions', async () => {
    const demoRegistry = createDemoRegistry({ clock: () => fixedNow })
    const { app } = build(demoRegistry)
    const { agent, csrf } = await login(app)
    await post(agent, csrf, '/api/security/demo-mode', { enabled: true })
    await agent.get('/api/security/snapshot')
    await post(agent, csrf, '/api/security/alerts/demo-alert-001/acknowledge')
    expect(demoRegistry.size()).toBe(1)
    expect((await post(agent, csrf, '/api/auth/logout')).status).toBe(204)
    expect(demoRegistry.size()).toBe(0)

    const bounded = createDemoRegistry({ clock: () => fixedNow, limit: 2 })
    for (const id of ['a', 'b', 'c']) bounded.forSession(id)
    expect(bounded.size()).toBe(2)
    expect(() => bounded.forSession('')).toThrow()
  })
})
