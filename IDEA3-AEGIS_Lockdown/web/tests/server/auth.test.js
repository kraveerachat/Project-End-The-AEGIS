import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { AuditPersistenceError } from '../../server/repositories/auditRecords.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'

function testConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
    AEGIS_ALLOW_DEV_LOGIN: 'true',
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple',
    ...overrides,
  })
}

describe('administrator authentication', () => {
  it('returns the same failure response for an unknown user and a wrong password', async () => {
    const repository = createMemoryRepository()
    const app = createApp({ config: testConfig(), repository })

    const unknown = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ username: 'nobody', password: 'wrong' })
    const wrong = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ username: 'admin', password: 'wrong' })
    const clientActor = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ username: 'admin', password: 'correct-horse-battery-staple', actorRef: 'client-controlled-actor' })

    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual({ error: { code: 'AUTH_FAILED', message: 'เข้าสู่ระบบไม่สำเร็จ' } })
    expect(wrong.body).toEqual(unknown.body)
    expect(clientActor.body).toEqual(unknown.body)
    const audit = repository.queryAudit({ limit: 10 })
    expect(audit).toHaveLength(3)
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'AUTH', action: 'LOGIN', outcome: 'FAILURE', actorRef: 'anonymous',
        resourceType: 'session', resourceId: 'current', detail: {},
      }),
    ]))
    expect(JSON.stringify(audit)).not.toMatch(/nobody|wrong|client-controlled-actor|correct-horse-battery-staple/)
  })

  it('regenerates a session and returns only the safe Admin identity', async () => {
    const repository = createMemoryRepository()
    const agent = request.agent(createApp({ config: testConfig(), repository }))

    const response = await agent
      .post('/api/auth/login')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ username: 'admin', password: 'correct-horse-battery-staple' })

    expect(response.status).toBe(200)
    expect(response.body.identity).toEqual({
      displayName: 'System Administrator',
      role: 'ADMIN',
      workspace: 'AEGIS Security Center',
    })
    expect(response.body.csrfToken).toMatch(/^[a-f0-9]{64}$/)
    expect(response.body).not.toHaveProperty('password')
    expect(response.headers['set-cookie'][0]).toContain('HttpOnly')
    expect(response.headers['set-cookie'][0]).toContain('SameSite=Strict')

    expect(repository.queryAudit({ limit: 10 })).toEqual([
      expect.objectContaining({
        category: 'AUTH', action: 'LOGIN', outcome: 'SUCCESS', actorRef: 'session-admin',
        resourceType: 'session', resourceId: 'current', detail: {},
      }),
    ])

    const session = await agent.get('/api/auth/session')
    expect(session.body.authenticated).toBe(true)
    expect(session.body.identity.role).toBe('ADMIN')
  })

  it('shares the app-owned SQLite repository between authentication and security routes', async () => {
    const agent = request.agent(createApp({ config: testConfig() }))
    const login = await agent
      .post('/api/auth/login')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ username: 'admin', password: 'correct-horse-battery-staple' })

    expect(login.status).toBe(200)
    const snapshot = await agent.get('/api/security/snapshot')
    expect(snapshot.status).toBe(200)
    expect(snapshot.body.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'AUTH', action: 'LOGIN', outcome: 'SUCCESS', actorRef: 'session-admin',
      }),
    ]))
  })

  it('rate-limits repeated login failures without revealing account existence', async () => {
    const repository = createMemoryRepository()
    const app = createApp({ config: testConfig(), repository })

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await request(app)
        .post('/api/auth/login')
        .set('Origin', 'http://localhost')
        .set('Host', 'localhost')
        .send({ username: 'admin', password: 'wrong' })
      expect(response.status).toBe(401)
    }

    const blocked = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ username: 'admin', password: 'wrong' })
    expect(blocked.status).toBe(429)
    expect(blocked.body.error.code).toBe('RATE_LIMITED')
    expect(repository.queryAudit({ limit: 10 })).toEqual([
      expect.objectContaining({
        category: 'AUTH', action: 'LOGIN', outcome: 'RATE_LIMITED', actorRef: 'anonymous',
        resourceType: 'session', resourceId: 'current', detail: {},
      }),
      ...Array.from({ length: 5 }, () => expect.objectContaining({
        category: 'AUTH', action: 'LOGIN', outcome: 'FAILURE', actorRef: 'anonymous',
      })),
    ])
  })

  it('does not return or retain authenticated state when the login audit cannot be persisted', async () => {
    const workingRepository = createMemoryRepository()
    const repository = {
      ...workingRepository,
      recordAction(entry) {
        if (entry.action === 'LOGIN' && entry.outcome === 'SUCCESS') {
          throw new AuditPersistenceError('record login', new Error('/private/audit.sqlite3 secret-token'))
        }
        return workingRepository.recordAction(entry)
      },
    }
    const agent = request.agent(createApp({ config: testConfig(), repository }))

    const response = await agent
      .post('/api/auth/login')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .send({ username: 'admin', password: 'correct-horse-battery-staple' })

    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      error: {
        code: 'AUDIT_PERSISTENCE_FAILURE',
        message: 'ระบบบันทึกเหตุการณ์ไม่พร้อมใช้งาน',
      },
    })
    expect(response.headers).not.toHaveProperty('set-cookie')
    expect(JSON.stringify(response.body)).not.toMatch(/private|sqlite|secret|token|stack|payload/i)

    const session = await agent.get('/api/auth/session')
    expect(session.body).toEqual({ authenticated: false })
  })
})
