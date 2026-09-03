import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'

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
    const app = createApp({ config: testConfig() })

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

    expect(unknown.status).toBe(401)
    expect(unknown.body).toEqual({ error: { code: 'AUTH_FAILED', message: 'เข้าสู่ระบบไม่สำเร็จ' } })
    expect(wrong.body).toEqual(unknown.body)
  })

  it('regenerates a session and returns only the safe Admin identity', async () => {
    const agent = request.agent(createApp({ config: testConfig() }))

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

    const session = await agent.get('/api/auth/session')
    expect(session.body.authenticated).toBe(true)
    expect(session.body.identity.role).toBe('ADMIN')
  })

  it('rate-limits repeated login failures without revealing account existence', async () => {
    const app = createApp({ config: testConfig() })

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
  })
})
