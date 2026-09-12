import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../server/config.js'

// AEGIS_WEB_STATIC_DIR is resolved with node:path, whose semantics are
// platform-native. A rooted POSIX literal is absolute on Windows too, but
// path.resolve() anchors it to the current drive ('/opt/x' -> 'C:\opt\x'), so
// expectations must be computed rather than hardcoded. The launcher supplies a
// platform-native absolute path (str(LauncherSettings.static_dir)), which
// resolves to itself on both platforms.
const NATIVE_STATIC_DIR = process.platform === 'win32'
  ? 'C:\\AEGIS\\AEGIS-IDEA3\\web'
  : '/opt/aegis/security-center'
const NATIVE_AUDIT_DB_PATH = process.platform === 'win32'
  ? 'C:\\ProgramData\\AEGIS\\security-center-audit.sqlite3'
  : '/var/lib/aegis-idea3/db/security-center-audit.sqlite3'

const STRONG_SESSION_SECRET = 'S3cure!ProductionSessionSecret-2026'
const BCRYPT_HASH = '$2b$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy'

function productionConfig(overrides = {}) {
  return {
    NODE_ENV: 'production',
    SESSION_SECRET: STRONG_SESSION_SECRET,
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_ADMIN_PASSWORD_HASH: BCRYPT_HASH,
    AEGIS_IDEA3_AUDIT_DB_PATH: NATIVE_AUDIT_DB_PATH,
    AEGIS_WEB_STATIC_DIR: NATIVE_STATIC_DIR,
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

  it.each([
    ['PORT', '8003x'],
    ['PORT', '0'],
    ['AEGIS_SESSION_IDLE_MS', '-1'],
    ['AEGIS_MAX_EVIDENCE_AGE_MS', 'NaN'],
    ['AEGIS_ADAPTER_TIMEOUT_MS', '2.5'],
  ])('rejects malformed production %s=%j instead of silently defaulting', (name, value) => {
    expect(() => loadConfig(productionConfig({ [name]: value }))).toThrow(new RegExp(name))
  })

  it.each([
    'security-center-audit.sqlite3',
    './runtime/security-center-audit.sqlite3',
    '../runtime/security-center-audit.sqlite3',
  ])('rejects the relative production audit database path %j', (auditDbPath) => {
    expect(() => loadConfig(productionConfig({
      AEGIS_IDEA3_AUDIT_DB_PATH: auditDbPath,
    }))).toThrow(/AEGIS_IDEA3_AUDIT_DB_PATH/)
  })

  it('accepts an absolute production audit database path unchanged', () => {
    expect(loadConfig(productionConfig()).auditDbPath).toBe(NATIVE_AUDIT_DB_PATH)
  })

  it('uses an in-memory audit database in tests', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).auditDbPath).toBe(':memory:')
  })

  it('uses the durable runtime audit database outside tests', () => {
    expect(loadConfig({ NODE_ENV: 'development' }).auditDbPath)
      .toBe('.aegis-runtime/security-center-audit.sqlite3')
  })

  it('wires all five documented read-only adapter environment keys into configuration', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AEGIS_IDEA1_STATUS_URL: 'https://idea1.internal/api/integration/events',
      AEGIS_IDEA2_STATUS_URL: 'https://idea2.internal/api/integration/events',
      AEGIS_IDEA3_RUNTIME_STATUS_URL: 'https://idea3.internal/api/runtime/status',
      AEGIS_MAX_EVIDENCE_AGE_MS: '45000',
      AEGIS_ADAPTER_TIMEOUT_MS: '1500',
    })

    expect(config.adapters).toEqual(expect.objectContaining({
      idea1Url: 'https://idea1.internal/api/integration/events',
      idea2Url: 'https://idea2.internal/api/integration/events',
      runtimeUrl: 'https://idea3.internal/api/runtime/status',
    }))
    expect(config.maxEvidenceAgeMs).toBe(45_000)
    expect(config.adapterTimeoutMs).toBe(1_500)
  })

  it('falls back to safe defaults when the five adapter keys are absent', () => {
    const config = loadConfig({ NODE_ENV: 'test' })

    expect(config.adapters).toEqual(expect.objectContaining({ idea1Url: null, idea2Url: null, runtimeUrl: null }))
    expect(config.maxEvidenceAgeMs).toBe(120_000)
    expect(config.adapterTimeoutMs).toBe(2_500)
  })

  it('keeps the per-source integration credentials separate and absent by default', () => {
    const configured = loadConfig({
      NODE_ENV: 'test',
      AEGIS_IDEA1_INTEGRATION_TOKEN: ' idea1-integration-credential ',
      AEGIS_IDEA2_INTEGRATION_TOKEN: 'idea2-integration-credential',
    })

    expect(configured.adapters.idea1Token).toBe('idea1-integration-credential')
    expect(configured.adapters.idea2Token).toBe('idea2-integration-credential')
    expect(loadConfig({ NODE_ENV: 'test', AEGIS_IDEA1_INTEGRATION_TOKEN: '   ' }).adapters)
      .toEqual(expect.objectContaining({ idea1Token: null, idea2Token: null }))
  })

  it('honors an explicit audit database path override', () => {
    expect(loadConfig({
      NODE_ENV: 'test',
      AEGIS_IDEA3_AUDIT_DB_PATH: '/var/lib/aegis/audit.sqlite3',
    }).auditDbPath).toBe('/var/lib/aegis/audit.sqlite3')
  })

  it('uses the packaged security base path and loopback binding in production', () => {
    const config = loadConfig(productionConfig())

    expect(config.webBasePath).toBe('/security')
    expect(config.staticDir).toBe(path.resolve(NATIVE_STATIC_DIR))
    expect(path.isAbsolute(config.staticDir)).toBe(true)
    expect(config.bindHost).toBe('127.0.0.1')
  })

  it('returns a platform-native absolute static directory unchanged', () => {
    // This is the exact shape the Windows launcher exports as
    // AEGIS_WEB_STATIC_DIR, so resolution must be idempotent on each platform.
    const config = loadConfig(productionConfig({ AEGIS_WEB_STATIC_DIR: NATIVE_STATIC_DIR }))

    expect(config.staticDir).toBe(NATIVE_STATIC_DIR)
    expect(path.isAbsolute(config.staticDir)).toBe(true)
  })

  it.each([
    'web/dist',
    './web/dist',
    '../security-center',
    '',
  ])('still rejects the non-absolute static path %j in production', (staticDir) => {
    expect(() => loadConfig(productionConfig({ AEGIS_WEB_STATIC_DIR: staticDir })))
      .toThrow(/AEGIS_WEB_STATIC_DIR/)
  })

  it.each([
    ['an external bind address', { AEGIS_BIND_HOST: '0.0.0.0' }, /AEGIS_BIND_HOST/],
    ['a relative static path', { AEGIS_WEB_STATIC_DIR: 'web/dist' }, /AEGIS_WEB_STATIC_DIR/],
    ['a traversing base path', { AEGIS_WEB_BASE_PATH: '/security/../admin' }, /AEGIS_WEB_BASE_PATH/],
    ['a URL as base path', { AEGIS_WEB_BASE_PATH: 'https://example.test/security' }, /AEGIS_WEB_BASE_PATH/],
  ])('rejects %s', (_case, override, message) => {
    expect(() => loadConfig(productionConfig(override))).toThrow(message)
  })

  it('requires an explicit static directory in production', () => {
    expect(() => loadConfig(productionConfig({ AEGIS_WEB_STATIC_DIR: undefined })))
      .toThrow(/AEGIS_WEB_STATIC_DIR/)
  })
})

// Local test fixture values only. The loopback trusted peer and bind address are
// not the Production topology (spec §4.4). RFC 5737/3849 documentation
// addresses stand in for any non-loopback value.
const DISPATCH_ENABLED = Object.freeze({
  AEGIS_IDEA3_DISPATCH_ENABLED: 'true',
  AEGIS_IDEA3_DISPATCH_PORT: '18103',
  AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '127.0.0.1',
  AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: 'idea3-core',
})

function dispatchTestEnv(overrides = {}) {
  return { NODE_ENV: 'test', ...DISPATCH_ENABLED, ...overrides }
}

describe('PR10 S2 dispatch configuration', () => {
  it('is disabled by default in every environment', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).dispatch).toEqual({ enabled: false })
    expect(loadConfig(productionConfig()).dispatch).toEqual({ enabled: false })
    expect(loadConfig({ NODE_ENV: 'test', AEGIS_IDEA3_DISPATCH_ENABLED: 'false' }).dispatch).toEqual({ enabled: false })
    expect(loadConfig({ NODE_ENV: 'test', AEGIS_IDEA3_DISPATCH_ENABLED: '' }).dispatch).toEqual({ enabled: false })
  })

  it('accepts a complete enabled configuration and defaults the local bind address to 127.0.0.1', () => {
    const { dispatch } = loadConfig(dispatchTestEnv())

    expect(dispatch).toEqual({
      enabled: true,
      host: '127.0.0.1',
      port: 18103,
      trustedProxy: '127.0.0.1',
      expectedSubject: 'idea3-core',
    })
    expect(Object.isFrozen(dispatch)).toBe(true)
  })

  it.each(['yes', 'TRUE', '1', ' true', 'on'])('rejects the ambiguous enable value %j', (value) => {
    expect(() => loadConfig({ NODE_ENV: 'test', AEGIS_IDEA3_DISPATCH_ENABLED: value }))
      .toThrow(/AEGIS_IDEA3_DISPATCH_ENABLED/)
  })

  it.each([
    'AEGIS_IDEA3_DISPATCH_PORT',
    'AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY',
    'AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT',
  ])('requires %s when dispatch is enabled', (key) => {
    expect(() => loadConfig(dispatchTestEnv({ [key]: undefined }))).toThrow(new RegExp(key))
  })

  it.each(['0', '-1', '65536', '18103.5', 'abc', '8003'])('rejects the dispatch port %j', (port) => {
    expect(() => loadConfig(dispatchTestEnv({ AEGIS_IDEA3_DISPATCH_PORT: port })))
      .toThrow(/AEGIS_IDEA3_DISPATCH_PORT/)
  })

  it.each(['hub.internal', '192.0.2.2/32', '999.0.2.2', '192.0.2.2:443'])('rejects the trusted proxy %j', (proxy) => {
    expect(() => loadConfig(dispatchTestEnv({ AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: proxy })))
      .toThrow(/AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY/)
  })

  it.each(['IDEA3-CORE', '-idea3', 'idea3_core', 'cn=idea3-core', 'a'.repeat(64)])('rejects the expected subject %j', (subject) => {
    expect(() => loadConfig(dispatchTestEnv({ AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: subject })))
      .toThrow(/AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT/)
  })

  it.each(['192.0.2.10', '2001:db8::10'])('accepts the non-loopback documentation bind address %j', (host) => {
    expect(loadConfig(dispatchTestEnv({ AEGIS_IDEA3_DISPATCH_HOST: host })).dispatch.host).toBe(host)
  })

  it.each([
    'localhost',
    'idea3.internal',
    '0.0.0.0',
    '::',
    '0:0:0:0:0:0:0:0',
    '::ffff:127.0.0.1',
    '192.0.2.10:18103',
    '192.0.2.0/24',
  ])('rejects the bind address %j', (host) => {
    expect(() => loadConfig(dispatchTestEnv({ AEGIS_IDEA3_DISPATCH_HOST: host })))
      .toThrow(/AEGIS_IDEA3_DISPATCH_HOST/)
  })

  it('requires an explicit non-loopback bind address in production', () => {
    const production = (overrides) => loadConfig(productionConfig({ ...DISPATCH_ENABLED, ...overrides }))

    expect(() => production({})).toThrow(/AEGIS_IDEA3_DISPATCH_HOST/)
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', '0:0:0:0:0:0:0:1']) {
      expect(() => production({ AEGIS_IDEA3_DISPATCH_HOST: host })).toThrow(/AEGIS_IDEA3_DISPATCH_HOST/)
    }
    expect(production({ AEGIS_IDEA3_DISPATCH_HOST: '192.0.2.10' }).dispatch.host).toBe('192.0.2.10')
  })

  it('leaves the browser listener loopback-only while dispatch is enabled', () => {
    const config = loadConfig(productionConfig({ ...DISPATCH_ENABLED, AEGIS_IDEA3_DISPATCH_HOST: '192.0.2.10' }))

    expect(config.bindHost).toBe('127.0.0.1')
  })
})
