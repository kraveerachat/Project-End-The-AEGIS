import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'

describe('configuration boundaries', () => {
  it('fails closed in production without an admin password hash', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'x'.repeat(32),
      AEGIS_IDEA3_ADMIN_USER: 'admin',
    })).toThrow(/ADMIN_PASSWORD_HASH/)
  })

  it('fails closed in production with a short session secret', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'short',
      AEGIS_IDEA3_ADMIN_USER: 'admin',
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH: '$2a$12$valid-looking-value',
    })).toThrow(/SESSION_SECRET/)
  })

  it('allows explicit local review credentials only outside production', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      SESSION_SECRET: 'local-review-session-secret-12345',
      AEGIS_ALLOW_DEV_LOGIN: 'true',
      AEGIS_IDEA3_ADMIN_USER: 'reviewer',
      AEGIS_IDEA3_DEV_PASSWORD: 'local-password',
    })

    expect(config.auth).toEqual({
      username: 'reviewer',
      passwordHash: null,
      developmentPassword: 'local-password',
      allowDevelopmentLogin: true,
    })
    expect(config.demoAllowed).toBe(true)
  })

  it('hard-disables demo mode in production', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'production-session-secret-with-32-chars',
      AEGIS_IDEA3_ADMIN_USER: 'admin',
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH: '$2a$12$valid-looking-value',
      AEGIS_DEMO_ALLOWED: 'true',
    })

    expect(config.demoAllowed).toBe(false)
    expect(config.auth.allowDevelopmentLogin).toBe(false)
  })
})
