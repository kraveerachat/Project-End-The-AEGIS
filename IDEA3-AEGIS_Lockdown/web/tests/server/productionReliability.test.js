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
