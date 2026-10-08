import { describe, expect, it } from 'vitest'
import { buildDemoEnv } from '../../scripts/demo-local.mjs'
import { loadConfig } from '../../server/config.js'

const dirs = { auditDir: '/tmp/aegis-demo-test', staticDir: process.cwd() }

describe('local demo launcher environment', () => {
  it('refuses to run in production', () => {
    expect(() => buildDemoEnv({ NODE_ENV: 'production' }, dirs)).toThrow(/production/)
  })

  it('is loopback-only, development-only, random-credentialed, and Demo-capable', () => {
    const env = buildDemoEnv({ PATH: '/usr/bin' }, { ...dirs, password: 'fixed-test-password' })
    expect(env).toMatchObject({
      NODE_ENV: 'development', AEGIS_BIND_HOST: '127.0.0.1', AEGIS_ALLOW_DEV_LOGIN: 'true', AEGIS_DEMO_ALLOWED: 'true',
      AEGIS_IDEA3_DEV_PASSWORD: 'fixed-test-password', AEGIS_IDEA3_AUDIT_DB_PATH: '/tmp/aegis-demo-test/security-center-audit.sqlite3',
    })
    expect(env.SESSION_SECRET.length).toBeGreaterThanOrEqual(32)
    const config = loadConfig(env)
    expect(config.production).toBe(false)
    expect(config.demoAllowed).toBe(true)
    expect(config.dispatch.enabled).toBe(false)
  })

  it('drops every upstream, token, dispatch, proxy and production-credential setting from the caller environment', () => {
    const env = buildDemoEnv({
      AEGIS_IDEA1_STATUS_URL: 'https://idea1.example/x', AEGIS_IDEA2_STATUS_URL: 'https://idea2.example/x',
      AEGIS_IDEA1_INTEGRATION_TOKEN: 'secret-1', AEGIS_IDEA2_INTEGRATION_TOKEN: 'secret-2',
      AEGIS_IDEA3_RUNTIME_STATUS_URL: 'https://core.example/status',
      AEGIS_IDEA3_DISPATCH_ENABLED: 'true', AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '10.0.0.1',
      AEGIS_WEB_TRUSTED_PROXY: '10.0.0.2', AEGIS_WEB_BASE_PATH: '/security',
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH: '$2a$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuuabcdefghi',
    }, dirs)
    expect(Object.keys(env).filter((key) => /IDEA1|IDEA2|RUNTIME_STATUS|DISPATCH|TRUSTED_PROXY|BASE_PATH|PASSWORD_HASH/.test(key))).toEqual([])
    const config = loadConfig(env)
    expect(config.adapters.idea1Url).toBeFalsy()
    expect(config.adapters.runtimeUrl).toBeFalsy()
    expect(config.dispatch.enabled).toBe(false)
  })

  it('ignores a malformed PORT and falls back to the default', () => {
    expect(buildDemoEnv({ PORT: '99999999' }, dirs).PORT).toBe('8003')
    expect(buildDemoEnv({ PORT: '18003' }, dirs).PORT).toBe('18003')
  })
})
