import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import request from 'supertest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createOperationalError } from '../../server/domain/operationalErrors.js'
import { AuditPersistenceError } from '../../server/repositories/auditRecords.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { createSqliteRepository } from '../../server/repositories/sqliteRepository.js'

const repositories = []

function config() {
  return loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
    AEGIS_ALLOW_DEV_LOGIN: 'true',
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple',
  })
}

function openRepository() {
  const path = join(mkdtempSync(join(tmpdir(), 'aegis-idea3-routes-')), 'audit.sqlite3')
  const repository = createSqliteRepository({ path, clock: () => new Date('2026-09-08T04:00:00.000Z') })
  repositories.push(repository)
  return { path, repository }
}

function liveSnapshot(operationalErrors = []) {
  return {
    mode: 'LIVE',
    alerts: [],
    incidents: [],
    audit: [],
    operationalErrors,
    settings: { policy: {} },
  }
}

const CANDIDATE = Object.freeze({
  id: 'inc-0123456789abcd',
  state: 'CONTAINMENT_CANDIDATE',
  severity: 'HIGH',
  correlationKey: 'zone-a-incident-42',
  firstSeen: '2026-09-08T03:55:00.000Z',
  lastSeen: '2026-09-08T04:00:00.000Z',
  idea1Count: 1,
  idea2Count: 1,
  evidenceIds: ['IDEA1:idea1-event-1', 'IDEA2:idea2-event-1'],
  responseState: 'NOT_REQUESTED',
})

function integrationSnapshot({ idea1 = {}, idea2 = {}, conflicts = [], incidents = [] } = {}) {
  return {
    ...liveSnapshot(),
    incidents,
    integration: {
      schemaVersion: 1,
      idea1: { source: 'IDEA1', status: 'HEALTHY', code: null, rejectedCount: 0, ...idea1 },
      idea2: { source: 'IDEA2', status: 'HEALTHY', code: null, rejectedCount: 0, ...idea2 },
      events: [],
      conflicts,
      eligibleCount: 0,
    },
  }
}

function actionsIn(audit, action) {
  return audit.filter((row) => row.action === action)
}

async function login(agent) {
  const response = await agent
    .post('/api/auth/login')
    .set('Origin', 'http://localhost')
    .set('Host', 'localhost')
    .send({ username: 'admin', password: 'correct-horse-battery-staple' })
  expect(response.status).toBe(200)
  return response.body.csrfToken
}

function securityWrite(agent, csrfToken, path) {
  return agent.post(path)
    .set('Origin', 'http://localhost')
    .set('Host', 'localhost')
    .set('x-csrf-token', csrfToken)
}

afterEach(() => {
  while (repositories.length > 0) {
    try {
      repositories.pop().close()
    } catch {
      // The test may intentionally close a repository before reopening it.
    }
  }
})

describe('production reliability routes', () => {
  it('retains failed authentication in the same durable audit ledger exposed to an Admin after restart', async () => {
    const { path, repository } = openRepository()
    const firstApp = createApp({ config: config(), repository })

    const failed = await request(firstApp)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ username: 'admin', password: 'wrong' })
    expect(failed.status).toBe(401)
    repository.close()

    const reopened = createSqliteRepository({ path, clock: () => new Date('2026-09-08T04:01:00.000Z') })
    repositories.push(reopened)
    const agent = request.agent(createApp({ config: config(), repository: reopened }))
    await login(agent)
    const audit = await agent.get('/api/security/audit?limit=10')

    expect(audit.status).toBe(200)
    expect(audit.body.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'AUTH', action: 'LOGIN', outcome: 'FAILURE', actorRef: 'anonymous' }),
    ]))
    expect(JSON.stringify(audit.body)).not.toMatch(/wrong|password|csrf|cookie/i)
  })

  it('persists each active live operational failure once, removes it on recovery, and records recurrence after restart', async () => {
    const { path, repository } = openRepository()
    const error = createOperationalError('ACK_TIMEOUT', {
      occurredAt: '2026-09-08T03:59:00.000Z',
      correlationId: 'audit-correlation-1',
    })
    let operationalErrors = [error]
    const liveProvider = { getSnapshot: async () => liveSnapshot(operationalErrors) }
    const agent = request.agent(createApp({ config: config(), repository, liveProvider }))
    await login(agent)

    expect((await agent.get('/api/security/snapshot')).status).toBe(200)
    expect((await agent.get('/api/security/snapshot')).status).toBe(200)
    operationalErrors = []
    expect((await agent.get('/api/security/snapshot')).status).toBe(200)
    operationalErrors = [error]
    expect((await agent.get('/api/security/snapshot')).status).toBe(200)
    expect(repository.queryAudit({ limit: 10 }).filter(({ action }) => action === 'ACK_TIMEOUT')).toHaveLength(2)
    repository.close()

    const reopened = createSqliteRepository({ path, clock: () => new Date('2026-09-08T04:01:00.000Z') })
    repositories.push(reopened)
    const restartedAgent = request.agent(createApp({ config: config(), repository: reopened, liveProvider }))
    await login(restartedAgent)
    const audit = await restartedAgent.get('/api/security/audit?limit=10')

    expect(audit.body.audit.filter(({ action }) => action === 'ACK_TIMEOUT')).toHaveLength(2)
    expect(audit.body.audit.filter(({ action }) => action === 'ACK_TIMEOUT').every(({ correlationId }) => correlationId === 'audit-correlation-1')).toBe(true)
  })

  it('does not turn Demo-only operational errors into live audit failures', async () => {
    const repository = createMemoryRepository()
    const demoProvider = { getSnapshot: async () => liveSnapshot([createOperationalError('ACK_TIMEOUT')]) }
    const agent = request.agent(createApp({ config: config(), repository, demoProvider }))
    const csrfToken = await login(agent)

    expect((await securityWrite(agent, csrfToken, '/api/security/demo-mode').send({ enabled: true })).status).toBe(200)
    expect((await agent.get('/api/security/snapshot')).status).toBe(200)

    expect(repository.queryAudit({ limit: 10 }).map(({ action }) => action)).not.toContain('ACK_TIMEOUT')
  })

  it('keeps lifecycle evidence query-only and correlates each independent CUT and RESTORE sequence', () => {
    const repository = createMemoryRepository()
    const cutCorrelationId = 'cut-correlation-1'
    const restoreCorrelationId = 'restore-correlation-1'
    const cutStages = ['REQUESTED', 'COMMAND_SENT', 'ACK', 'STATUS', 'PHYSICAL_CONFIRMATION']
    for (const action of cutStages) {
      repository.recordAction({ category: 'COMMAND', action, outcome: 'SUCCESS', actorRef: 'system', resourceType: 'command', resourceId: 'CUT', correlationId: cutCorrelationId })
    }
    repository.recordAction({ category: 'AUTHORIZATION', action: 'AUTHORIZATION', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'recovery', resourceId: 'RESTORE', correlationId: 'restore-authorization-1' })
    for (const action of cutStages) {
      repository.recordAction({ category: 'COMMAND', action, outcome: 'SUCCESS', actorRef: 'system', resourceType: 'command', resourceId: 'RESTORE', correlationId: restoreCorrelationId })
    }

    const chronological = repository.queryAudit({ limit: 20 }).toReversed()
    expect(chronological.filter(({ correlationId }) => correlationId === cutCorrelationId).map(({ action }) => action)).toEqual(cutStages)
    expect(chronological.filter(({ correlationId }) => correlationId === restoreCorrelationId).map(({ action }) => action)).toEqual(cutStages)
    expect(chronological.findIndex(({ action }) => action === 'AUTHORIZATION')).toBeLessThan(chronological.findIndex(({ correlationId }) => correlationId === restoreCorrelationId))
  })

  it('returns the safe 503 boundary before any security action reports success when persistence fails', async () => {
    const workingRepository = createMemoryRepository()
    let persistenceUnavailable = false
    const failure = () => {
      throw new AuditPersistenceError('persist audit', new Error('/private/audit.sqlite3 secret-token'))
    }
    const repository = {
      ...workingRepository,
      recordAction(entry) {
        return persistenceUnavailable ? failure() : workingRepository.recordAction(entry)
      },
      acknowledgeAlert: failure,
      addIncidentNote: failure,
      updateSettings: failure,
      queryAudit: failure,
    }
    const agent = request.agent(createApp({ config: config(), repository }))
    const csrfToken = await login(agent)
    persistenceUnavailable = true
    const writes = [
      () => securityWrite(agent, csrfToken, '/api/security/demo-mode').send({ enabled: true }),
      () => securityWrite(agent, csrfToken, '/api/security/alerts/alert-1/acknowledge').send({}),
      () => securityWrite(agent, csrfToken, '/api/security/incidents/incident-1/notes').send({ note: 'Validated without secrets' }),
      () => securityWrite(agent, csrfToken, '/api/security/recovery/dry-run').send({ incidentId: 'incident-1', confirmation: 'VALIDATE ONLY' }),
      () => agent.patch('/api/security/settings').set('Origin', 'http://localhost').set('Host', 'localhost').set('x-csrf-token', csrfToken).send({ auditRetentionDays: 180 }),
      () => securityWrite(agent, csrfToken, '/api/security/audit/export').send({}),
    ]

    for (const write of writes) {
      const response = await write()
      expect(response.status).toBe(503)
      expect(response.body).toEqual({
        error: { code: 'AUDIT_PERSISTENCE_FAILURE', message: 'ระบบบันทึกเหตุการณ์ไม่พร้อมใช้งาน' },
      })
      expect(JSON.stringify(response.body)).not.toMatch(/private|sqlite|secret|token|stack|payload/i)
    }
    expect((await agent.get('/api/auth/session')).body.demoMode).toBe(false)
    const audit = await agent.get('/api/security/audit?limit=1')
    expect(audit.status).toBe(503)
  })
})

describe('durable integration lifecycle audit', () => {
  it('records one adapter failure per active period, one recovery, and a new period after restart', async () => {
    const { path, repository } = openRepository()
    let snapshot = integrationSnapshot({ idea1: { status: 'UNKNOWN', code: 'ADAPTER_TIMEOUT' } })
    const liveProvider = { getSnapshot: async () => snapshot }
    const agent = request.agent(createApp({ config: config(), repository, liveProvider }))
    await login(agent)

    await agent.get('/api/security/snapshot')
    await agent.get('/api/security/snapshot')
    snapshot = integrationSnapshot()
    await agent.get('/api/security/snapshot')
    await agent.get('/api/security/snapshot')
    snapshot = integrationSnapshot({ idea1: { status: 'UNKNOWN', code: 'ADAPTER_UNAVAILABLE' } })
    await agent.get('/api/security/snapshot')

    const audit = repository.queryAudit({ limit: 100 })
    expect(actionsIn(audit, 'ADAPTER_FAILURE')).toHaveLength(2)
    expect(actionsIn(audit, 'ADAPTER_RECOVERED')).toHaveLength(1)
    repository.close()

    const reopened = createSqliteRepository({ path, clock: () => new Date('2026-09-08T04:01:00.000Z') })
    repositories.push(reopened)
    const restarted = request.agent(createApp({ config: config(), repository: reopened, liveProvider }))
    await login(restarted)
    await restarted.get('/api/security/snapshot')

    // The active failure period survives the restart, so it is not re-reported.
    expect(actionsIn(reopened.queryAudit({ limit: 100 }), 'ADAPTER_FAILURE')).toHaveLength(2)
  })

  it('records rejected events and each stable ID conflict exactly once per active period', async () => {
    const { repository } = openRepository()
    let snapshot = integrationSnapshot({
      idea1: { rejectedCount: 3 },
      conflicts: [{ code: 'EVENT_ID_CONFLICT', source: 'IDEA1', event_id: 'dupe' }],
    })
    const agent = request.agent(createApp({ config: config(), repository, liveProvider: { getSnapshot: async () => snapshot } }))
    await login(agent)

    await agent.get('/api/security/snapshot')
    await agent.get('/api/security/snapshot')
    snapshot = integrationSnapshot()
    await agent.get('/api/security/snapshot')
    snapshot = integrationSnapshot({ idea1: { rejectedCount: 1 } })
    await agent.get('/api/security/snapshot')

    const audit = repository.queryAudit({ limit: 100 })
    expect(actionsIn(audit, 'EVENT_ID_CONFLICT')).toHaveLength(1)
    expect(actionsIn(audit, 'EVENT_REJECTED')).toHaveLength(2)
    expect(actionsIn(audit, 'EVENT_REJECTED')[0].detail).toEqual(expect.objectContaining({ count: 1 }))
  })

  it('records one correlation row per stable incident no matter how often it is observed', async () => {
    const { repository } = openRepository()
    const liveProvider = { getSnapshot: async () => integrationSnapshot({ incidents: [CANDIDATE] }) }
    const agent = request.agent(createApp({ config: config(), repository, liveProvider }))
    await login(agent)

    await agent.get('/api/security/snapshot')
    await agent.get('/api/security/snapshot')

    const correlated = actionsIn(repository.queryAudit({ limit: 100 }), 'INCIDENT_CORRELATED')
    expect(correlated).toHaveLength(1)
    expect(correlated[0]).toEqual(expect.objectContaining({
      outcome: 'SUCCESS', resourceId: CANDIDATE.id, correlationId: 'zone-a-incident-42',
    }))
  })

  it('records exactly one decision row per Admin containment action', async () => {
    const { repository } = openRepository()
    const liveProvider = { getSnapshot: async () => integrationSnapshot({ incidents: [CANDIDATE] }) }
    const agent = request.agent(createApp({ config: config(), repository, liveProvider }))
    const csrfToken = await login(agent)

    await securityWrite(agent, csrfToken, `/api/security/incidents/${CANDIDATE.id}/containment`).send({ decision: 'ACCEPT' })
    await securityWrite(agent, csrfToken, `/api/security/incidents/${CANDIDATE.id}/containment`).send({ decision: 'ACCEPT' })

    expect(actionsIn(repository.queryAudit({ limit: 100 }), 'CONTAINMENT_ACCEPTED')).toHaveLength(1)
  })

  it('uses only the allowlisted integration audit actions and stores no raw payload, path, or credential', async () => {
    const { repository } = openRepository()
    const liveProvider = {
      getSnapshot: async () => integrationSnapshot({
        idea1: { status: 'UNKNOWN', code: 'ADAPTER_TIMEOUT', rejectedCount: 2, rawBody: '/var/aegis/snapshots/cam-02.jpg', token: 'must-not-leak' },
        conflicts: [{ code: 'EVENT_ID_CONFLICT', source: 'IDEA2', event_id: 'dupe', subject: 'Alice Example' }],
        incidents: [{ ...CANDIDATE, analystNote: 'Alice Example at /var/aegis/cam-02.jpg' }],
      }),
    }
    const agent = request.agent(createApp({ config: config(), repository, liveProvider }))
    await login(agent)

    await agent.get('/api/security/snapshot')

    const audit = repository.queryAudit({ limit: 100 })
    const allowed = new Set([
      'ADAPTER_FAILURE', 'ADAPTER_RECOVERED', 'EVENT_REJECTED', 'EVENT_ID_CONFLICT',
      'INCIDENT_CORRELATED', 'CONTAINMENT_ACCEPTED', 'CONTAINMENT_REJECTED', 'LOGIN',
    ])
    expect(audit.every((row) => allowed.has(row.action))).toBe(true)
    expect(JSON.stringify(audit)).not.toMatch(/Alice Example|must-not-leak|cam-02\.jpg|\/var\/aegis/)
  })

  it('does not write live integration audit rows while Demo Mode is active', async () => {
    const repository = createMemoryRepository()
    const demoProvider = { getSnapshot: async () => integrationSnapshot({ idea1: { status: 'UNKNOWN', code: 'ADAPTER_TIMEOUT' }, incidents: [CANDIDATE] }) }
    const agent = request.agent(createApp({ config: config(), repository, demoProvider }))
    const csrfToken = await login(agent)

    expect((await securityWrite(agent, csrfToken, '/api/security/demo-mode').send({ enabled: true })).status).toBe(200)
    expect((await agent.get('/api/security/snapshot')).status).toBe(200)

    const actions = repository.queryAudit({ limit: 100 }).map((row) => row.action)
    expect(actions).not.toContain('ADAPTER_FAILURE')
    expect(actions).not.toContain('INCIDENT_CORRELATED')
  })

  it('returns the safe 503 boundary when integration lifecycle persistence fails', async () => {
    const working = createMemoryRepository()
    const repository = {
      ...working,
      recordIntegrationOutcome() {
        throw new AuditPersistenceError('persist integration outcome', new Error('/private/audit.sqlite3 secret-token'))
      },
    }
    const liveProvider = { getSnapshot: async () => integrationSnapshot({ incidents: [CANDIDATE] }) }
    const agent = request.agent(createApp({ config: config(), repository, liveProvider }))
    await login(agent)

    const response = await agent.get('/api/security/snapshot')

    expect(response.status).toBe(503)
    expect(response.body).toEqual({ error: { code: 'AUDIT_PERSISTENCE_FAILURE', message: 'ระบบบันทึกเหตุการณ์ไม่พร้อมใช้งาน' } })
    expect(JSON.stringify(response.body)).not.toMatch(/private|sqlite|secret|token|stack|payload/i)
  })
})
