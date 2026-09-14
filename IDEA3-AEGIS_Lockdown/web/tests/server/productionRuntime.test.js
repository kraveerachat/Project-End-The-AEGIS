import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import bcrypt from 'bcryptjs'
import { loadConfig } from '../../server/config.js'
import { createApp } from '../../server/createApp.js'
import { createMachineApp } from '../../server/createMachineApp.js'
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

// PR11 Phase 2 (design §4.3, §4.4, §4.10). supertest connects from loopback, so
// the pinned HUB here is 127.0.0.1 (a trusted peer) or 192.0.2.2 (an untrusted
// peer). These are fixture values, not the Production topology.
const PROXY_PASSWORD = 'proxied-runtime-password'
const PROXY_PASSWORD_HASH = bcrypt.hashSync(PROXY_PASSWORD, 12)
const HTTPS = Object.freeze({ 'X-Forwarded-Proto': 'https' })
const COOKIE_SCOPED_TO_SECURITY = /;\s*Path=\/security(;|$)/

function proxiedConfig(trustedProxy, overrides = {}) {
  return productionConfig(staticDirectory(), {
    AEGIS_WEB_TRUSTED_PROXY: trustedProxy,
    AEGIS_BIND_HOST: '192.0.2.3',
    AEGIS_IDEA3_ADMIN_PASSWORD_HASH: PROXY_PASSWORD_HASH,
    ...overrides,
  })
}

function proxiedApp(trustedProxy) {
  return createApp({ config: proxiedConfig(trustedProxy), repository: createMemoryRepository() })
}

function hubLogin(app, headers = {}, password = PROXY_PASSWORD) {
  return request(app)
    .post('/security/api/auth/login')
    .set('Host', 'aegis.internal')
    .set('Origin', 'https://aegis.internal')
    .set(headers)
    .send({ username: 'admin', password })
}

// Every security-related header IDEA3 emits (K2 enumeration, design §4.10). A
// change here must be reflected in the HUB integration request IR-1.
const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self';base-uri 'self';font-src 'self';form-action 'self';frame-ancestors 'none';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' 'unsafe-inline';upgrade-insecure-requests;connect-src 'self'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-dns-prefetch-control': 'off',
  'x-download-options': 'noopen',
  'x-frame-options': 'SAMEORIGIN',
  'x-permitted-cross-domain-policies': 'none',
  'x-xss-protection': '0',
})
const TRANSPORT_HEADERS = new Set([
  'accept-ranges', 'cache-control', 'connection', 'content-length', 'content-type', 'date',
  'etag', 'keep-alive', 'last-modified', 'set-cookie', 'transfer-encoding', 'vary',
])

function securityHeaders(response) {
  return Object.fromEntries(Object.entries(response.headers).filter(([name]) => !TRANSPORT_HEADERS.has(name)))
}

describe('PR11 Phase 2 proxied browser listener', () => {
  it('P2-A1: issues a Secure, HttpOnly, SameSite=Strict cookie scoped to /security through the pinned HUB', async () => {
    const app = proxiedApp('127.0.0.1')

    const login = await hubLogin(app, { ...HTTPS, 'X-Forwarded-For': '198.51.100.7' })

    expect(login.status).toBe(200)
    const setCookie = login.headers['set-cookie']?.[0]
    expect(setCookie).toMatch(/^aegis\.idea3\.sid=/)
    expect(setCookie).toMatch(COOKIE_SCOPED_TO_SECURITY)
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')

    const session = await request(app)
      .get('/security/api/auth/session')
      .set('Host', 'aegis.internal')
      .set(HTTPS)
      .set('Cookie', setCookie.split(';', 1)[0])
    expect(session.body.authenticated).toBe(true)
  })

  it('P2-A2: issues no session cookie from the pinned HUB without X-Forwarded-Proto https', async () => {
    const app = proxiedApp('127.0.0.1')

    for (const headers of [{}, { 'X-Forwarded-Proto': 'http' }]) {
      const login = await hubLogin(app, headers)
      expect(login.headers['set-cookie']).toBeUndefined()
    }
  })

  it('P2-A3: ignores forwarded headers from any peer other than the pinned HUB, loopback included', async () => {
    const app = proxiedApp('192.0.2.2')

    const login = await hubLogin(app, { ...HTTPS, 'X-Forwarded-For': '198.51.100.7' })

    expect(login.headers['set-cookie']).toBeUndefined()
  })

  it('P2-A4: keys the login rate limit on the HUB-supplied client address only from the pinned HUB', async () => {
    const trusted = proxiedApp('127.0.0.1')
    const fromClient = (address) => hubLogin(trusted, { ...HTTPS, 'X-Forwarded-For': address }, 'wrong-password')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await fromClient('198.51.100.7')).status).toBe(401)
    }
    expect((await fromClient('198.51.100.7')).status).toBe(429)
    expect((await fromClient('198.51.100.8')).status).toBe(401)

    const untrusted = proxiedApp('192.0.2.2')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await hubLogin(untrusted, { 'X-Forwarded-For': `198.51.100.${attempt + 10}` }, 'wrong-password')
      expect(response.status).toBe(401)
    }
    const spoofed = await hubLogin(untrusted, { 'X-Forwarded-For': '198.51.100.99' }, 'wrong-password')
    expect(spoofed.status).toBe(429)
  }, 30_000)

  it('P2-A4: scopes the session cookie to /security in loopback mode as well (D3)', async () => {
    const root = staticDirectory()
    const app = createApp({
      config: productionConfig(root, { AEGIS_IDEA3_ADMIN_PASSWORD_HASH: PROXY_PASSWORD_HASH }),
      repository: createMemoryRepository(),
    })

    const login = await request(app)
      .post('/security/api/auth/login')
      .set('Host', 'localhost')
      .set('Origin', 'http://localhost')
      .send({ username: 'admin', password: PROXY_PASSWORD })

    expect(login.headers['set-cookie']?.[0]).toMatch(COOKIE_SCOPED_TO_SECURITY)
  })

  it('P2-A5: enumerates every security header IDEA3 emits so the HUB can hide or own each one (K2)', async () => {
    const app = proxiedApp('127.0.0.1')
    const routes = [
      ['/security/', 'no-store'],
      ['/security/api/health', 'no-store'],
      ['/security/assets/app-a1b2c3.js', 'public, max-age=31536000, immutable'],
    ]

    for (const [route, cacheControl] of routes) {
      const response = await request(app).get(route).set('Accept', 'text/html').set(HTTPS)
      expect(response.status).toBe(200)
      expect(securityHeaders(response)).toEqual(SECURITY_HEADERS)
      expect(response.headers['cache-control']).toBe(cacheControl)
    }
  })

  it('P2-A5: records that the machine app emits the same security header names', async () => {
    const config = proxiedConfig('127.0.0.1', {
      AEGIS_IDEA3_DISPATCH_ENABLED: 'true',
      AEGIS_IDEA3_DISPATCH_HOST: '192.0.2.3',
      AEGIS_IDEA3_DISPATCH_PORT: '8004',
      AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '127.0.0.1',
      AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: 'idea3-core',
    })
    const machineApp = createMachineApp({ config, repository: createMemoryRepository(), contact: { record() {} } })

    const response = await request(machineApp).get('/security/api/machine/v1/dispatch/pending')

    expect(response.status).toBe(403)
    expect(Object.keys(securityHeaders(response)).sort()).toEqual(Object.keys(SECURITY_HEADERS).sort())
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('P2-A6: the proxied browser app serves no machine path, in any case variant, even with identity headers', async () => {
    const app = proxiedApp('127.0.0.1')
    const paths = [
      '/security/api/machine/v1/dispatch/pending',
      '/security/api/MACHINE/v1/dispatch/pending',
      '/security/api/machine/V1/dispatch/pending',
    ]

    for (const route of paths) {
      const response = await request(app)
        .get(route)
        .set(HTTPS)
        .set('X-Aegis-Client-Verify', 'SUCCESS')
        .set('X-Aegis-Client-Dn', 'CN=idea3-core')
      expect(response.status).toBe(404)
    }
  })

  it('P2-A7: binds the browser and machine listeners to the configured container address', async () => {
    const config = proxiedConfig('127.0.0.1', {
      AEGIS_IDEA3_DISPATCH_ENABLED: 'true',
      AEGIS_IDEA3_DISPATCH_HOST: '192.0.2.3',
      AEGIS_IDEA3_DISPATCH_PORT: '8004',
      AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY: '127.0.0.1',
      AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT: 'idea3-core',
    })
    const requested = []
    // Record the requested address; bind an ephemeral loopback port instead,
    // because the documentation address is not assigned to this host.
    const listen = (app, port, host) => {
      requested.push([port, host])
      return app.listen(0, '127.0.0.1')
    }

    const runtime = await startServer({ config, repository: createMemoryRepository(), listen })
    await runtime.close()

    expect(requested).toEqual([[8003, '192.0.2.3'], [8004, '192.0.2.3']])
  })
})
