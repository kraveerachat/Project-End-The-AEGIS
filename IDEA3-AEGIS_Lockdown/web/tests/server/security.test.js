import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'

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

describe('session, origin, RBAC, and CSRF boundaries', () => {
  it('rejects protected CSRF material without an Admin session', async () => {
    const response = await request(createApp({ config: config() })).get('/api/auth/csrf')
    expect(response.status).toBe(401)
    expect(response.body.error.code).toBe('AUTH_REQUIRED')
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
    const agent = request.agent(createApp({ config: config() }))
    await login(agent)

    const response = await agent
      .post('/api/auth/logout')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')

    expect(response.status).toBe(403)
    expect(response.body.error.code).toBe('CSRF_INVALID')
  })

  it('destroys the authenticated session when logout has same-origin and CSRF proof', async () => {
    const agent = request.agent(createApp({ config: config() }))
    const authenticated = await login(agent)

    const response = await agent
      .post('/api/auth/logout')
      .set('Origin', 'http://localhost')
      .set('Host', 'localhost')
      .set('x-csrf-token', authenticated.body.csrfToken)

    expect(response.status).toBe(204)
    const session = await agent.get('/api/auth/session')
    expect(session.body).toEqual({ authenticated: false })
  })

  it('sets defense-in-depth headers and disables response caching', async () => {
    const response = await request(createApp({ config: config() })).get('/api/auth/session')
    expect(response.headers['content-security-policy']).toContain("default-src 'self'")
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.headers['x-content-type-options']).toBe('nosniff')
  })
})
