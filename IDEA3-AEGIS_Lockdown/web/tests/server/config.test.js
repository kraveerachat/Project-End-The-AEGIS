import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'

const STRONG_SESSION_SECRET = 'S3cure!ProductionSessionSecret-2026'
const BCRYPT_HASH = '$2b$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy'

function productionConfig(overrides = {}) {
  return {
    NODE_ENV: 'production',
    SESSION_SECRET: STRONG_SESSION_SECRET,
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_ADMIN_PASSWORD_HASH: BCRYPT_HASH,
    ...overrides,
  }
}

function configurationError(env) {
  try {
    loadConfig(env)
  } catch (error) {
    return error
  }
  throw new Error('Expected configuration to be rejected')
}

describe('configuration boundaries', () => {
  it('fails closed in production without an admin password hash', () => {
    expect(() => loadConfig(productionConfig({
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH: undefined,
    }))).toThrow(/AEGIS_IDEA3_ADMIN_PASSWORD_HASH/)
  })

  it.each([
    ['missing', undefined],
    ['the known development fallback', 'development-only-session-secret-change-me'],
    ['repeated characters', 'A'.repeat(40)],
    ['fewer than three character classes', 'lowercase-only-session-secret-value'],
    ['fewer than 32 characters', 'Short!Secret1'],
  ])('fails closed in production when SESSION_SECRET has %s', (_case, sessionSecret) => {
    const error = configurationError(productionConfig({ SESSION_SECRET: sessionSecret }))

    expect(error.message).toMatch(/SESSION_SECRET/)
    if (sessionSecret) expect(error.message).not.toContain(sessionSecret)
  })

  it.each([
    ['malformed', '$2b$12$not-a-complete-bcrypt-hash'],
    ['an unsupported format', `$2x$12$${BCRYPT_HASH.slice(7)}`],
    ['a cost below 12', `$2b$11$${BCRYPT_HASH.slice(7)}`],
  ])('fails closed in production when the admin password hash has %s', (_case, passwordHash) => {
    const error = configurationError(productionConfig({
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH: passwordHash,
    }))

    expect(error.message).toMatch(/AEGIS_IDEA3_ADMIN_PASSWORD_HASH/)
    expect(error.message).not.toContain(passwordHash)
  })

  it.each(['2a', '2b', '2y'])('accepts a strong production configuration using bcrypt $%s$', (version) => {
    const config = loadConfig(productionConfig({
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH: `$${version}$12$${BCRYPT_HASH.slice(7)}`,
    }))

    expect(config.production).toBe(true)
    expect(config.auth.allowDevelopmentLogin).toBe(false)
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
    const config = loadConfig(productionConfig({
      AEGIS_DEMO_ALLOWED: 'true',
      AEGIS_ALLOW_DEV_LOGIN: 'true',
    }))

    expect(config.demoAllowed).toBe(false)
    expect(config.auth.allowDevelopmentLogin).toBe(false)
  })

  it('uses an in-memory audit database in tests', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).auditDbPath).toBe(':memory:')
  })

  it('uses the durable runtime audit database outside tests', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).auditDbPath)
      .toBe('.aegis-runtime/security-center-audit.sqlite3')
  })

  it('honors an explicit audit database path override', () => {
    expect(loadConfig({
      NODE_ENV: 'test',
      AEGIS_IDEA3_AUDIT_DB_PATH: '/var/lib/aegis/audit.sqlite3',
    }).auditDbPath).toBe('/var/lib/aegis/audit.sqlite3')
  })
})
