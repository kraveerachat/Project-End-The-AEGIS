import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { startServer } from '../../server/runtime.js'
import { createMemoryRepository } from '../../server/repositories/memoryRepository.js'

const STRONG_SESSION_SECRET = 'S3cure!ProductionSessionSecret-2026'
const BCRYPT_HASH = '$2b$12$lQ3edrbcQxKq1sNMxX8bzuC/2IAHW5LExZtuJ21rUpMdjB3pN6cYy'
const temporaryDirectories = []

function staticDirectory() {
  const root = mkdtempSync(path.join(tmpdir(), 'aegis-web-runtime-'))
  temporaryDirectories.push(root)
  mkdirSync(path.join(root, 'assets'))
  writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>AEGIS Security Center</title>')
  writeFileSync(path.join(root, 'assets', 'app-a1b2c3.js'), 'globalThis.aegisLoaded = true')
  return root
}

function productionConfig(root, overrides = {}) {
  return loadConfig({
    NODE_ENV: 'production',
    SESSION_SECRET: STRONG_SESSION_SECRET,
    AEGIS_IDEA3_ADMIN_USER: 'admin',
    AEGIS_IDEA3_ADMIN_PASSWORD_HASH: BCRYPT_HASH,
    AEGIS_IDEA3_AUDIT_DB_PATH: path.join(root, 'security-center-audit.sqlite3'),
    AEGIS_WEB_STATIC_DIR: root,
    ...overrides,
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('production Web runtime', () => {
  it('serves the built application and prefixed health endpoint', async () => {
    const root = staticDirectory()
    const app = createApp({ config: productionConfig(root), repository: createMemoryRepository() })

    const index = await request(app).get('/security/')
    const health = await request(app).get('/security/api/health')

    expect(index.status).toBe(200)
    expect(index.text).toContain('AEGIS Security Center')
    expect(index.headers['cache-control']).toContain('no-store')
    expect(health.status).toBe(200)
    expect(health.body).toEqual({ status: 'ok' })
  })

  it('reports ready only after the schema-v3 audit repository probe succeeds', async () => {
    const root = staticDirectory()
    const app = createApp({ config: productionConfig(root) })

    const readiness = await request(app).get('/security/api/readiness')

    expect(readiness.status).toBe(200)
    expect(readiness.body).toEqual({
      status: 'READY',
      audit: 'READY',
      schemaVersion: 3,
    })
    app.locals.close()
  })

  it('W3: reports degraded for a repository at any schema version other than v3', async () => {
    for (const version of [2, 4]) {
      const root = staticDirectory()
      const repository = { schemaVersion: () => version, close() {} }
      const app = createApp({ config: productionConfig(root), repository })

      const readiness = await request(app).get('/security/api/readiness')

      expect(readiness.status).toBe(503)
      expect(readiness.body).toEqual({ status: 'DEGRADED', audit: 'DEGRADED' })
    }
  })

  it('reports degraded when the audit repository readiness probe fails', async () => {
    const root = staticDirectory()
    const repository = {
      schemaVersion() {
        throw new Error('injected audit probe failure')
      },
      close() {},
    }
    const app = createApp({ config: productionConfig(root), repository })

    const readiness = await request(app).get('/security/api/readiness')

    expect(readiness.status).toBe(503)
    expect(readiness.body).toEqual({ status: 'DEGRADED', audit: 'DEGRADED' })
  })

  it('emits a Secure production session cookie on the trusted localhost origin', async () => {
    const root = staticDirectory()
    const password = 'standalone-loopback-password'
    const config = productionConfig(root, {
      AEGIS_IDEA3_ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 12),
    })
    const app = createApp({ config, repository: createMemoryRepository() })

    const login = await request(app)
      .post('/security/api/auth/login')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ username: 'admin', password })

    expect(login.status).toBe(200)
    const setCookie = login.headers['set-cookie']?.[0]
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')

    const session = await request(app)
      .get('/security/api/auth/session')
      .set('Host', 'localhost')
      .set('Cookie', setCookie.split(';', 1)[0])
    expect(session.body.authenticated).toBe(true)
  })

  it('caches hashed assets without caching the application shell', async () => {
    const root = staticDirectory()
    const app = createApp({ config: productionConfig(root), repository: createMemoryRepository() })

    const asset = await request(app).get('/security/assets/app-a1b2c3.js')
    const explicitIndex = await request(app).get('/security/index.html')

    expect(asset.status).toBe(200)
    expect(asset.headers['cache-control']).toMatch(/max-age=31536000/)
    expect(asset.headers['cache-control']).toContain('immutable')
    expect(explicitIndex.status).toBe(200)
    expect(explicitIndex.headers['cache-control']).toContain('no-store')
  })

  it('uses the SPA fallback for HTML routes but never for API routes', async () => {
    const root = staticDirectory()
    const app = createApp({ config: productionConfig(root), repository: createMemoryRepository() })

    const page = await request(app).get('/security/incidents/incident-1').set('Accept', 'text/html')
    const missingApi = await request(app).get('/security/api/not-real').set('Accept', 'text/html')
    const unprefixedApi = await request(app).get('/api/auth/session')

    expect(page.status).toBe(200)
    expect(page.text).toContain('AEGIS Security Center')
    expect(missingApi.status).toBe(404)
    expect(missingApi.type).toMatch(/json/)
    expect(missingApi.body.error.code).toBe('NOT_FOUND')
    expect(unprefixedApi.status).toBe(404)
  })

  it('closes the listener and repository exactly once', async () => {
    const repository = createMemoryRepository()
    repository.close = vi.fn(repository.close)
    const config = {
      ...loadConfig({ NODE_ENV: 'test' }),
      port: 0,
      bindHost: '127.0.0.1',
      webBasePath: '',
      staticDir: null,
    }
    const runtime = await startServer({ config, repository })

    expect(runtime.server.listening).toBe(true)
    await runtime.close()
    await runtime.close()

    expect(runtime.server.listening).toBe(false)
    expect(repository.close).toHaveBeenCalledTimes(1)
  })
})
