import { describe, expect, it } from 'vitest'
import session from 'express-session'
import request from 'supertest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { AuditPersistenceError } from '../../server/repositories/auditRecords.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'

const config = () => loadConfig({
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
  AEGIS_ALLOW_DEV_LOGIN: 'true',
  AEGIS_IDEA3_ADMIN_USER: 'admin',
  AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple',
})

async function login(agent) {
  return agent
    .post('/api/auth/login')
    .set('Origin', 'http://localhost')
    .set('Host', 'localhost')
    .send({ username: 'admin', password: 'correct-horse-battery-staple' })
}

function readSessions(store) {
  return new Promise((resolve, reject) => {
    store.all((error, sessions) => error ? reject(error) : resolve(sessions || {}))
  })
}

function writeSession(store, id, value) {
  return new Promise((resolve, reject) => {
    store.set(id, value, (error) => error ? reject(error) : resolve())
  })
}

describe('session, origin, RBAC, and CSRF boundaries', () => {
  it('rejects protected CSRF material without an Admin session', async () => {
    const response = await request(createApp({ config: config() })).get('/api/auth/csrf')
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('AUTH_REQUIRED')
  })

  it('rejects a forged session cookie', async () => {
    const response = await request(createApp({ config: config() }))
      .get('/api/auth/csrf')
      .set('Cookie', 'aegis.idea3.sid=s%3Ainvalid.invalid')

    expect(response.status).toBe(401)
    expect(response.body).toEqual({ error: { code: 'AUTH_REQUIRED', message: 'กรุณาเข้าสู่ระบบ' } })
  })

  it('deterministically rejects an expired server-side session', async () => {
    const sessionStore = new session.MemoryStore()
    const app = createApp({ config: config(), sessionStore })
    const agent = request.agent(app)
    expect((await login(agent)).status).toBe(200)

    const sessions = await readSessions(sessionStore)
    const [id, stored] = Object.entries(sessions)[0] || []
    expect(stored).toBeDefined()
    if (!stored) return
    stored.cookie.expires = '2000-01-01T00:00:00.000Z'
    await writeSession(sessionStore, id, stored)

    const response = await agent.get('/api/auth/csrf')
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('AUTH_REQUIRED')
    expect((await agent.get('/api/auth/session')).body).toEqual({ authenticated: false })
  })

  it('rejects a valid session whose server-side identity is not Admin', async () => {
    const sessionStore = new session.MemoryStore()
    const app = createApp({ config: config(), sessionStore })
    const agent = request.agent(app)
    expect((await login(agent)).status).toBe(200)

    const sessions = await readSessions(sessionStore)
    const [id, stored] = Object.entries(sessions)[0] || []
    expect(stored).toBeDefined()
    if (!stored) return
    stored.identity = { displayName: 'Read Only', role: 'ANALYST', workspace: 'AEGIS Security Center' }
    await writeSession(sessionStore, id, stored)

    const response = await agent.get('/api/auth/csrf')
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('AUTH_REQUIRED')
    expect((await agent.get('/api/auth/session')).body).toEqual({ authenticated: false })
  })

  it('rejects login from a cross-origin request', async () => {
    const response = await request(createApp({ config: config() }))
      .post('/api/auth/login')
      .set('Origin', 'https://attacker.example')
      .set('Host', 'localhost')
      .send({ username: 'admin', password: 'correct-horse-battery-staple' })

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('ORIGIN_INVALID')
  })

  it('rejects an authenticated write without a valid CSRF token', async () => {
    const repository = createMemoryRepository()
    const agent = request.agent(createApp({ config: config(), repository }))
    await login(agent)

    const response = await agent
      .post('/api/auth/logout')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('CSRF_INVALID')
    expect(repository.queryAudit({ limit: 10 }).map(({ action }) => action)).toEqual(['LOGIN'])
  })

  it('destroys the authenticated session when logout has same-origin and CSRF proof', async () => {
    const repository = createMemoryRepository()
    const agent = request.agent(createApp({ config: config(), repository }))
    const authenticated = await login(agent)

    const response = await agent
      .post('/api/auth/logout')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .set('x-csrf-token', authenticated.body.csrfToken)

    expect(response.status).toBe(204)
    expect(repository.queryAudit({ limit: 10 })).toEqual([
      expect.objectContaining({
        category: 'AUTH', action: 'LOGOUT', outcome: 'SUCCESS', actorRef: 'session-admin',
        resourceType: 'session', resourceId: 'current', detail: {},
      }),
      expect.objectContaining({ category: 'AUTH', action: 'LOGIN', outcome: 'SUCCESS' }),
    ])
    const session = await agent.get('/api/auth/session')
    expect(session.body).toEqual({ authenticated: false })
    const protectedResponse = await agent.get('/api/auth/csrf')
    expect(protectedResponse.status).toBe(401)
  })

  it('keeps the authenticated session when logout audit persistence fails', async () => {
    const workingRepository = createMemoryRepository()
    const repository = {
      ...workingRepository,
      recordAction(entry) {
        if (entry.action === 'LOGOUT') {
          throw new AuditPersistenceError('record logout', new Error('/private/audit.sqlite3 secret-token'))
        }
        return workingRepository.recordAction(entry)
      },
    }
    const agent = request.agent(createApp({ config: config(), repository }))
    const authenticated = await login(agent)

    const response = await agent
      .post('/api/auth/logout')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .set('x-csrf-token', authenticated.body.csrfToken)

    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      error: {
        code: 'AUDIT_PERSISTENCE_FAILURE',
        message: 'ระบบบันทึกเหตุการณ์ไม่พร้อมใช้งาน',
      },
    })
    expect(JSON.stringify(response.body)).not.toMatch(/private|sqlite|secret|token|stack|payload/i)

    const retained = await agent.get('/api/auth/session')
    expect(retained.body.authenticated).toBe(true)
  })

  it('sets defense-in-depth headers and disables response caching', async () => {
    const response = await request(createApp({ config: config() })).get('/api/auth/session')
    expect(response.headers['content-security-policy']).toContain("default-src 'self'")
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })
})
