import { describe, expect, it } from 'vitest'
import request from 'supertest'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createDemoProvider } from '../../server/providers/demoProvider.js'
import { createLiveProvider } from '../../server/providers/liveProvider.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'
import { fixedNow } from '../fixtures/evidence.js'

const BCRYPT_HASH = '$2b$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy'

function production(overrides = {}) {
  return {
    NODE_ENV: 'production',
    SESSION_SECRET: 'S3cure!ProductionSessionSecret-2026',
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_ADMIN_PASSWORD_HASH: BCRYPT_HASH,
    AEGIS_IDEA3_AUDIT_DB_PATH: '/var/lib/aegis-idea3/db/security-center-audit.sqlite3',
    AEGIS_WEB_STATIC_DIR: '/opt/aegis/security-center',
    ...overrides,
  }
}

describe('Production refuses every LAB/local status feature', () => {
  it('loads the plain production configuration without any LAB feed', () => {
    const config = loadConfig(production())
    expect(config.labRuntimeStatus).toBe(false)
    expect(config.labMqtt.enabled).toBe(false)
    expect(config.adapters.runtimeUrl).toBeNull()
    expect(config.auth.allowDevelopmentLogin).toBe(false)
    expect(config.demoAllowed).toBe(false)
  })

  it.each([
    ['LAB runtime status feed', { AEGIS_IDEA3_LAB_RUNTIME_STATUS: 'true', AEGIS_IDEA3_RUNTIME_STATUS_URL: 'http://127.0.0.1:18194/status' }, /AEGIS_IDEA3_LAB_RUNTIME_STATUS/],
    ['LAB runtime status feed (remote URL)', { AEGIS_IDEA3_LAB_RUNTIME_STATUS: 'true', AEGIS_IDEA3_RUNTIME_STATUS_URL: 'https://hub.example/status' }, /AEGIS_IDEA3_LAB_RUNTIME_STATUS/],
    ['LAB MQTT observer', { AEGIS_IDEA3_LAB_MQTT_OBSERVER: 'true' }, /AEGIS_IDEA3_LAB_MQTT_OBSERVER/],
    ['LAB MQTT observer with options file', { AEGIS_IDEA3_LAB_MQTT_OBSERVER: 'true', AEGIS_IDEA3_LAB_MQTT_OPTS_FILE: '/tmp/x.opts' }, /AEGIS_IDEA3_LAB_MQTT_OBSERVER/],
  ])('rejects %s', (_name, env, pattern) => {
    expect(() => loadConfig(production(env))).toThrow(pattern)
  })

  it('ignores development login and demo switches in production', () => {
    const config = loadConfig(production({ AEGIS_ALLOW_DEV_LOGIN: 'true', AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple', AEGIS_DEMO_ALLOWED: 'true' }))
    expect(config.auth.allowDevelopmentLogin).toBe(false)
    expect(config.demoAllowed).toBe(false)
  })
})

describe('an unauthorized or credential-less request gets no status evidence', () => {
  function app() {
    const config = loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-session-secret-with-at-least-32-characters',
      AEGIS_ALLOW_DEV_LOGIN: 'true',
      AEGIS_IDEA3_ADMIN_USER: 'admin',
      AEGIS_IDEA3_DEV_PASSWORD: 'correct-horse-battery-staple',
    })
    const clock = () => fixedNow
    return createApp({
      config,
      clock,
      demoProvider: createDemoProvider({ clock }),
      liveProvider: createLiveProvider({ config, clock, fetchImpl: async () => { throw new Error('offline') } }),
      repository: createMemoryRepository({ clock }),
    })
  }

  it.each(['/api/security/snapshot', '/api/security/lab-mqtt', '/api/security/audit'])('%s requires a session', async (route) => {
    const response = await request(app()).get(route)
    expect(response.status).toBe(401)
    expect(JSON.stringify(response.body)).not.toMatch(/HEALTHY|DEGRADED|generatedAt|broker/)
  })

  it('refuses a wrong password and a forged bearer header', async () => {
    const instance = app()
    const login = await request(instance).post('/api/auth/login').set('Origin', 'http://localhost').set('Host', 'localhost')
      .send({ username: 'admin', password: 'wrong-password-value' })
    expect(login.status).toBe(401)
    const forged = await request(instance).get('/api/security/snapshot').set('Authorization', 'Bearer not-a-real-token-value')
    expect(forged.status).toBe(401)
  })
})
