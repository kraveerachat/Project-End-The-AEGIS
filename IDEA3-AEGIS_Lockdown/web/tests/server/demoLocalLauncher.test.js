import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { assertDemoAllowed, buildDemoEnv, createTempAuditDir } from '../../scripts/demo-local.mjs'
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

describe('production refusal and temp-dir ownership (unit)', () => {
  it('refuses production before any directory could be allocated', () => {
    expect(() => assertDemoAllowed({ NODE_ENV: 'production' })).toThrow(/production/)
    expect(() => assertDemoAllowed({ NODE_ENV: 'development' })).not.toThrow()
  })

  it('removes only the directory it allocated, once, and never a foreign path', () => {
    const removed = []
    const owner = createTempAuditDir({ root: '/tmp/x', make: (prefix) => `${prefix}AbC123`, remove: (target) => removed.push(target) })
    owner.remove() // nothing allocated yet
    expect(removed).toEqual([])
    const dir = owner.allocate()
    expect(dir).toBe('/tmp/x/aegis-idea3-demo-AbC123')
    owner.remove()
    owner.remove() // idempotent
    expect(removed).toEqual(['/tmp/x/aegis-idea3-demo-AbC123'])

    for (const foreign of ['/etc', '/tmp/x/other-AbC123', '/tmp/x/sub/aegis-idea3-demo-AbC123', '/tmp/aegis-idea3-demo-AbC123']) {
      const guarded = createTempAuditDir({ root: '/tmp/x', make: () => foreign, remove: (target) => removed.push(target) })
      guarded.allocate()
      guarded.remove()
    }
    expect(removed).toEqual(['/tmp/x/aegis-idea3-demo-AbC123'])
  })
})

// Real launcher process, real HTTP, private TMPDIR so each test inspects only its own temporary directory.
const LAUNCHER = path.resolve(process.cwd(), 'scripts', 'demo-local.mjs')
const roots = []
const children = []

function privateTmp() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aegis-launcher-test-')))
  roots.push(root)
  return root
}
const leftovers = (root) => readdirSync(root)

async function freePort() {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return String(port)
}

function launch({ tmp, port, env = {} }) {
  const child = spawn(process.execPath, [LAUNCHER], {
    env: { PATH: process.env.PATH, TMPDIR: tmp, PORT: port, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  const state = { out: '', err: '', exit: null }
  child.stdout.on('data', (chunk) => { state.out += chunk })
  child.stderr.on('data', (chunk) => { state.err += chunk })
  state.exited = new Promise((resolve) => child.on('exit', (code, signal) => { state.exit = { code, signal }; resolve(state.exit) }))
  state.child = child
  state.ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('launcher did not become ready')), 10_000)
    const check = setInterval(() => {
      if (/Password\s+\S+/.test(state.out)) { clearTimeout(timer); clearInterval(check); resolve() }
      if (state.exit) { clearTimeout(timer); clearInterval(check); resolve() }
    }, 25)
  })
  return state
}

async function loginOnce(state, port) {
  const password = state.out.match(/Password\s+(\S+)/)[1]
  const base = `http://127.0.0.1:${port}`
  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'admin', password }),
  })
  expect(response.status).toBe(200)
}

beforeAll(() => {
  if (!existsSync(path.join(process.cwd(), 'dist', 'index.html'))) {
    execFileSync(process.execPath, [path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: process.cwd(), stdio: 'ignore' })
  }
}, 60_000)

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('launcher process cleanup (real process, private TMPDIR)', () => {
  it('refuses production without allocating any temporary directory', async () => {
    const tmp = privateTmp()
    const run = launch({ tmp, port: await freePort(), env: { NODE_ENV: 'production' } })
    const { code } = await run.exited
    expect(code).toBe(1)
    expect(run.err).toMatch(/refuses to run when NODE_ENV=production/)
    expect(leftovers(tmp)).toEqual([])
  }, 15_000)

  it('leaves no database, WAL, SHM or directory when startup fails on a busy port', async () => {
    const tmp = privateTmp()
    const blocker = net.createServer()
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    try {
      const run = launch({ tmp, port: String(blocker.address().port) })
      const { code } = await run.exited
      expect(code).toBe(1)
      expect(run.err).toMatch(/demo-local failed/)
      expect(run.out).not.toMatch(/Password/)
      expect(leftovers(tmp)).toEqual([])
    } finally {
      await new Promise((resolve) => blocker.close(resolve))
    }
  }, 15_000)

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('removes the audit database after an actual login and %s', async (signal) => {
    const tmp = privateTmp()
    const port = await freePort()
    const run = launch({ tmp, port })
    await run.ready
    expect(run.exit).toBeNull()
    expect(run.out).toMatch(new RegExp(`http://127\\.0\\.0\\.1:${port}/`))
    await loginOnce(run, port)
    const [dir] = leftovers(tmp)
    expect(dir).toMatch(/^aegis-idea3-demo-/)
    expect(readdirSync(path.join(tmp, dir)).some((name) => name.endsWith('.sqlite3'))).toBe(true)

    run.child.kill(signal)
    const { code } = await run.exited
    expect(code).toBe(0)
    expect(leftovers(tmp)).toEqual([])
    // The login credential is shown only on the operator terminal, never written to disk or stderr.
    expect(run.err).toBe('')
  }, 20_000)
})
