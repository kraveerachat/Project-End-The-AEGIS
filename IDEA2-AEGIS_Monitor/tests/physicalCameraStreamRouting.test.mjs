import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { register } from 'node:module'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { createProducerLifecycle } from '../server/db/producerLifecycle.js'

import {
  CameraAccessError,
  parseLocalNodeAssociationRequirement,
  resolvePhysicalStreamTarget,
} from '../server/auth/cameraAccess.js'
import { approvedStreamUrlForPhysicalCamera } from '../server/auth/physicalStreamSource.js'

const streamHost = 'aegis-stream-host.internal'
const machineAStreamUrl = `http://${streamHost}:18077/stream.mjpg`

test('strict rollout setting defaults false and accepts only explicit booleans', () => {
  assert.equal(parseLocalNodeAssociationRequirement(undefined), false)
  assert.equal(parseLocalNodeAssociationRequirement('false'), false)
  assert.equal(parseLocalNodeAssociationRequirement('true'), true)
  for (const invalid of ['', '1', 'yes', 'TRUE', ' true ', 'off']) {
    assert.throws(() => parseLocalNodeAssociationRequirement(invalid), /true or false/i)
  }
})

test('physical source lookup uses registry-derived identity for either account alias', async () => {
  const lookups = []
  for (const logicalCameraId of ['CAM-01', 'CAM-02']) {
    const result = await resolvePhysicalStreamTarget(
      { body: { physicalCameraId: 999 }, query: { nodeId: 'forged' }, headers: { 'x-stream-url': 'http://attacker.invalid' } },
      logicalCameraId,
      10_000,
      {
        resolveOperatorAccess: async () => ({
          kind: 'verified-node', viewerMode: 'demanding', userId: 2,
          nodeId: 'machine-a-node', physicalCameraId: 41, logicalCameraId,
        }),
        streamSourceForPhysicalCamera: async (physicalCameraId) => {
          lookups.push(physicalCameraId)
          return {
            nodeId: 'machine-a-node',
            url: machineAStreamUrl,
            ageMs: 0,
            cameraConnected: false,
          }
        },
        approvedStreamUrlForPhysicalCamera: async () => machineAStreamUrl,
      },
    )
    assert.equal(result.access.physicalCameraId, 41)
    assert.equal(result.source.url, machineAStreamUrl)
  }
  assert.deepEqual(lookups, [41, 41])
})

test('authorization denial occurs before physical source lookup or network fetch', async () => {
  let sourceLookups = 0
  await assert.rejects(
    resolvePhysicalStreamTarget({}, 'CAM-99', 10_000, {
      resolveOperatorAccess: async () => { throw new CameraAccessError(403, 'CAMERA_ALIAS_DENIED') },
      streamSourceForPhysicalCamera: async () => { sourceLookups += 1; return null },
    }),
    (error) => error.code === 'CAMERA_ALIAS_DENIED',
  )
  assert.equal(sourceLookups, 0)
})

test('authenticated heartbeat cannot redirect the Engine credential to an unapproved upstream', async () => {
  await assert.rejects(
    resolvePhysicalStreamTarget({}, 'CAM-01', 10_000, {
      resolveOperatorAccess: async () => ({
        kind: 'verified-node', viewerMode: 'demanding', userId: 2,
        nodeId: 'machine-a-node', physicalCameraId: 41, logicalCameraId: 'CAM-01',
      }),
      streamSourceForPhysicalCamera: async () => ({
        nodeId: 'machine-a-node', url: 'http://attacker.invalid/collect',
        ageMs: 0, cameraConnected: false,
      }),
      approvedStreamUrlForPhysicalCamera: async () => 'http://172.18.0.1:18077/stream.mjpg',
    }),
    (error) => error instanceof CameraAccessError
      && error.status === 503
      && error.code === 'PHYSICAL_STREAM_UNAVAILABLE',
  )
})

test('server-owned physical source mapping requires the configured stable host and rejects runtime IPs', () => {
  const valid = JSON.stringify({ 41: { nodeId: 'machine-a-node', url: machineAStreamUrl } })
  assert.equal(approvedStreamUrlForPhysicalCamera(41, 'machine-a-node', valid, streamHost), machineAStreamUrl)
  assert.equal(approvedStreamUrlForPhysicalCamera(41, 'machine-a-node', valid, `${streamHost}.`), null)
  assert.equal(approvedStreamUrlForPhysicalCamera(41, 'machine-a-node', valid, ''), null)
  assert.equal(approvedStreamUrlForPhysicalCamera(41, 'machine-a-node', valid, 'other.internal'), null)
  assert.equal(approvedStreamUrlForPhysicalCamera(41, 'machine-b-node', valid, streamHost), null)
  assert.equal(approvedStreamUrlForPhysicalCamera(42, 'machine-a-node', valid, streamHost), null)
  assert.equal(approvedStreamUrlForPhysicalCamera(41, 'machine-a-node', '', streamHost), null)
  for (const url of [
    'http://attacker.invalid/collect?key=1',
    'http://user:pass@aegis-stream-host.internal:18077/stream.mjpg',
    'http://172.18.0.1:18077/stream.mjpg',
    'http://aegis-stream-host.internal:0/stream.mjpg',
    'http://aegis-stream-host.internal:80/stream.mjpg',
    'file:///stream.mjpg',
    'http://aegis-stream-host.internal:18077/other',
  ]) {
    const config = JSON.stringify({ 41: { nodeId: 'machine-a-node', url } })
    assert.equal(approvedStreamUrlForPhysicalCamera(41, 'machine-a-node', config, streamHost), null)
  }
})

test('Compose Monitor passes the server-owned physical stream mapping into its container', () => {
  const compose = fs.readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8')
  const rootEnv = fs.readFileSync(new URL('../../.env.example', import.meta.url), 'utf8')
  const monitor = compose.split(/\r?\n  monitor:\r?\n/)[1]?.split(/\r?\n  aegis-camera:\r?\n/)[0]
  assert.ok(monitor, 'Monitor service exists in Compose')
  assert.match(monitor, /AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION:\s*['"]?\$\{AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION/)
  assert.match(monitor, /AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES:\s*\$\{AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES/)
  assert.match(monitor, /AEGIS_MONITOR_STREAM_HOST:\s*\$\{AEGIS_MONITOR_STREAM_HOST/)
  assert.match(monitor, /extra_hosts:[\s\S]*AEGIS_MONITOR_STREAM_HOST[\s\S]*AEGIS_MONITOR_STREAM_HOST_GATEWAY/)
  assert.doesNotMatch(monitor, /172\.18\.0\./)
  assert.match(rootEnv, /^AEGIS_MONITOR_STREAM_HOST=aegis-stream-host\.internal$/m)
  assert.match(rootEnv, /^AEGIS_MONITOR_STREAM_HOST_GATEWAY=host-gateway$/m)
  assert.match(rootEnv, /^AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES=\{\}$/m)
})

test('missing, stale, malformed, or uncertain physical source fails without logical fallback', async () => {
  const access = async () => ({
    kind: 'verified-node', viewerMode: 'demanding', userId: 2,
    nodeId: 'machine-a-node', physicalCameraId: 41, logicalCameraId: 'CAM-01',
  })
  const sources = [
    async () => null,
    async () => ({ url: 'http://127.0.0.1:8077/stream.mjpg', ageMs: 45_001, cameraConnected: true }),
    async () => ({ url: '', ageMs: 0, cameraConnected: true }),
    async () => { throw new Error('database unavailable') },
    async () => ({
      nodeId: 'machine-b-node',
      url: 'http://127.0.0.1:8077/stream.mjpg',
      ageMs: 0,
      cameraConnected: true,
    }),
  ]
  for (const streamSourceForPhysicalCamera of sources) {
    await assert.rejects(
      resolvePhysicalStreamTarget({}, 'CAM-01', 10_000, {
        resolveOperatorAccess: access,
        streamSourceForPhysicalCamera,
      }),
      (error) => error instanceof CameraAccessError
        && error.status === 503
        && error.code === 'PHYSICAL_STREAM_UNAVAILABLE',
    )
  }
})

test('strict stream route selects the physical primitive and preserves legacy compatibility branch', () => {
  const source = fs.readFileSync(new URL('../server/routes/api.js', import.meta.url), 'utf8')
  assert.match(source, /parseLocalNodeAssociationRequirement/)
  assert.match(source, /resolveLiveCameraActor/)
  assert.match(source, /resolvePhysicalStreamTarget/)
  assert.match(source, /streamSourceForPhysicalCamera/)
  assert.match(source, /streamSourceFor\(cameraId\)/)
  assert.match(source, /error instanceof CameraAccessError/)
  assert.match(source, /res\.status\(error\.status\)\.json\(\{ error: error\.code \}\)/)
  assert.doesNotMatch(source, /strictOperator\s*=\s*REQUIRE_LOCAL_NODE_ASSOCIATION\s*&&\s*req\.user\.role/)
})

test('strict HTTP route cannot use a cached SOC role after the live account is Operator', async (t) => {
  const priorSetting = process.env.AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION
  process.env.AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION = 'true'
  t.after(() => {
    if (priorSetting === undefined) delete process.env.AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION
    else process.env.AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION = priorSetting
  })

  const express = (await import('express')).default
  const { apiRouter } = await import(`../server/routes/api.js?strict-stale-role=${Date.now()}`)
  const app = express()
  app.use((req, _res, next) => {
    req.session = {
      user: {
        id: 2,
        username: 'operator',
        displayName: 'Stale SOC cache',
        role: 'SOC-Responder',
        mustResetPassword: false,
      },
      createdAt: Date.now(),
      nodeSessionBinding: Buffer.alloc(32, 4).toString('base64url'),
      localNode: {
        nodeId: 'unregistered-test-node',
        physicalCameraId: 41,
        keyVersion: 1,
        verifiedAt: Date.now() - 1_000,
        expiresAt: Date.now() + 60_000,
      },
      destroy(callback) { callback?.() },
      reload(callback) { callback() },
    }
    next()
  })
  app.use('/api', apiRouter)

  let upstreamFetches = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    upstreamFetches += 1
    throw new Error('upstream fetch must not run')
  }
  t.after(() => { globalThis.fetch = originalFetch })

  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const { port } = server.address()
  const response = await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/api/cameras/CAM-01/stream`, resolve)
    request.once('error', reject)
  })
  let body = ''
  response.setEncoding('utf8')
  response.on('data', (chunk) => { body += chunk })
  await once(response, 'end')

  assert.equal(response.statusCode, 403)
  assert.deepEqual(JSON.parse(body), { error: 'LOCAL_NODE_ASSOCIATION_DENIED' })
  assert.equal(upstreamFetches, 0)
})

// Keep the registered HTTP route real; replace only external authority/database
// boundaries. Data-URL loader avoids creating another fixture surface.
const routeBase = new URL('../server/routes/api.js', import.meta.url)
const injectedSources = {
  '../db/connection.js': `export * from ${JSON.stringify(new URL('../server/db/connection.js', import.meta.url).href)};
    export const canSeeCamera = (...args) => globalThis.streamTest.canSeeCamera(...args);`,
  '../auth/cameraAccess.js': `export * from ${JSON.stringify(new URL('../server/auth/cameraAccess.js', import.meta.url).href)};
    import { resolvePhysicalStreamTarget as resolveTarget } from ${JSON.stringify(new URL('../server/auth/cameraAccess.js', import.meta.url).href)};
    export const resolvePhysicalStreamTarget = (req, id, now, deps) => resolveTarget(req, id, now,
      { ...deps, approvedStreamUrlForPhysicalCamera: () => 'http://engine.test/stream.mjpg' });
    export const resolveLiveCameraActor = (...args) => globalThis.streamTest.actor(...args);
    export const resolveOperatorAccess = (...args) => globalThis.streamTest.access(...args);`,
  '../db/store.js': `export * from ${JSON.stringify(new URL('../server/db/store.js', import.meta.url).href)};
    export const streamSourceForPhysicalCamera = (...args) => globalThis.streamTest.source(...args);
    export const streamSourceFor = () => globalThis.streamTest.legacySource();`,
  '../auth/physicalStreamSource.js': `export const approvedStreamUrlForPhysicalCamera = () => 'http://engine.test/stream.mjpg';`,
  '../db/producerLifecycle.js': `export const createProducerLifecycle = () => ({
    acquire: (...args) => globalThis.streamTest.acquire(...args),
    renew: (...args) => globalThis.streamTest.renew(...args),
    release: (...args) => globalThis.streamTest.release(...args),
  }); export const STREAM_REVALIDATE_MS = 10000; export const RENEW_BEFORE_MS = 20000;`,
}
let injectedRouter
async function loadInjectedRouter() {
  if (injectedRouter) return injectedRouter
  const loader = `const sources = ${JSON.stringify(injectedSources)};
    export function resolve(specifier, context, next) {
      if (context.parentURL?.includes('/server/routes/api.js?producer-http') && sources[specifier])
        return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(sources[specifier]) };
      return next(specifier, context);
    }
    export async function load(url, context, next) {
      const result = await next(url, context);
      if (!url.includes('/server/routes/api.js?producer-http')) return result;
      return { ...result, source: result.source.toString()
        .replace('const STREAM_IDLE_MS = 6_000', 'const STREAM_IDLE_MS = 80')
        .replace('const STREAM_FIRST_BYTE_MS = 50_000', 'const STREAM_FIRST_BYTE_MS = 120')
        .replace('const STREAM_REVALIDATE_MS = PRODUCER_REVALIDATE_MS', 'const STREAM_REVALIDATE_MS = 15') };
    }`
  register(`data:text/javascript,${encodeURIComponent(loader)}`)
  const previousSetting = process.env.AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION
  try {
    process.env.AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION = 'true'
    injectedRouter = (await import(`${routeBase.href}?producer-http`)).apiRouter
  } finally {
    if (previousSetting === undefined) delete process.env.AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION
    else process.env.AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION = previousSetting
  }
  return injectedRouter
}

async function streamHarness(t, scenario = 'normal', service = null) {
  const router = await loadInjectedRouter()
  const express = (await import('express')).default
  const state = { acquired: [], released: [], fetched: [], renewed: [], cancelled: 0, aborted: 0,
    authorization: [], live: true, assignment: true, active: new Set(), retired: false, maxRenewing: 0,
    events: [], reloads: 0, drainEvents: 0, closesBeforeRelease: 0 }
  let renewing = 0
  const generation = '9007199254740993'
  const binding = Buffer.alloc(32, 7).toString('base64url')
  globalThis.streamTest = {
    actor: async req => ({ userId: req.user.id, username: req.user.username, role: 'CCTV-Operator' }),
    access: async (req, alias) => {
      if (!state.assignment || alias !== (req.user.id === 2 ? 'CAM-01' : 'CAM-02'))
        throw new CameraAccessError(403, 'CAMERA_ALIAS_DENIED')
      return { kind: 'verified-node', viewerMode: 'demanding', userId: req.user.id, nodeId: 'machine-a-node',
        physicalCameraId: 41, keyVersion: 1, logicalCameraId: alias }
    },
    canSeeCamera: async (user, alias) => {
      state.authorization.push([user.id, alias])
      return scenario !== 'unauthorized' && state.assignment
    },
    source: async id => {
      assert.equal(id, 41)
      return { nodeId: 'machine-a-node', url: 'http://engine.test/stream.mjpg', ageMs: 0 }
    },
    legacySource: () => assert.fail('strict route must not use logical fallback'),
    acquire: async ({ access, sessionBinding }) => {
      assert.equal(sessionBinding, binding)
      const handle = service ? await service.acquire({ access, sessionBinding })
        : { ...access, producerGeneration: generation, demandOwnerId: `demand-${state.acquired.length}` }
      state.acquired.push(handle)
      state.active.add(handle)
      if (scenario === 'acquire-denied') {
        state.active.delete(handle)
        state.acquired.pop()
        throw new CameraAccessError(403, 'PRODUCER_AUTHORITY_DENIED')
      }
      if (scenario === 'slow-acquire') await new Promise(resolve => setTimeout(resolve, 40))
      return handle
    },
    renew: async ({ handle, access, sessionBinding }) => {
      assert.equal(sessionBinding, binding)
      assert.equal(access.logicalCameraId, handle.logicalCameraId)
      assert.ok(state.active.has(handle))
      state.renewed.push(handle)
      state.events.push('renew-start')
      renewing += 1
      state.maxRenewing = Math.max(state.maxRenewing, renewing)
      try {
        if (scenario === 'renewal-failure' || scenario === 'backpressure-renewal')
          throw new CameraAccessError(403, 'PRODUCER_AUTHORITY_DENIED')
        if (scenario === 'slow-renewal') await new Promise(resolve => setTimeout(resolve, 40))
        return service ? await service.renew({ handle, access, sessionBinding }) : handle
      } finally { renewing -= 1; state.events.push('renew-end') }
    },
    release: async handle => {
      if (service) await service.release(handle)
      state.events.push('release')
      state.released.push(handle)
      if (scenario === 'release-failure') throw new Error('fixture cleanup unavailable')
      state.active.delete(handle)
      state.retired = state.active.size === 0
    },
  }
  const previousFetch = globalThis.fetch
  const previousKey = process.env.DETECTION_ENGINE_API_KEY
  process.env.DETECTION_ENGINE_API_KEY = 'server-only-engine-key'
  globalThis.fetch = async (url, options) => {
    state.fetched.push({ url, options, acquired: state.acquired.length, authorized: state.authorization.length })
    options.signal.addEventListener('abort', () => { state.aborted += 1 }, { once: true })
    if (scenario === 'fetch-throw') throw new Error('network down')
    if (scenario === 'non-2xx') return { ok: false, status: 500, body: null }
    if (scenario === 'missing-body') return { ok: true, status: 200, body: null }
    let reads = 0
    let pendingResolve
    let frameTimer
    let readerClosed = false
    const reader = {
      read() {
        if (readerClosed) return Promise.resolve({ done: true })
        reads += 1
        if (scenario === 'reader-read-throw') throw new Error('reader failed')
        if (reads === 1 && scenario === 'first-byte-timeout') {
          return new Promise(resolve => { pendingResolve = resolve })
        }
        if (reads === 1) return Promise.resolve({ done: false, value: Buffer.from('frame') })
        if (scenario === 'normal') return Promise.resolve({ done: true })
        return new Promise(resolve => {
          pendingResolve = resolve
          if (scenario === 'real-viewers') frameTimer = setTimeout(() => {
            resolve({ done: false, value: Buffer.from('frame') })
          }, 20)
        })
      },
      cancel() {
        readerClosed = true
        clearTimeout(frameTimer)
        state.cancelled += 1
        pendingResolve?.({ done: true })
        return Promise.resolve()
      },
    }
    return { ok: true, status: 200, headers: scenario === 'route-error'
      ? { get() { throw new Error('response setup failed') } }
      : new Headers({ 'content-type': 'multipart/x-mixed-replace; boundary=frame',
      'X-Aegis-Producer-Generation': generation, 'X-Detection-Engine-Key': 'server-only-engine-key' }),
      body: { getReader: () => reader } }
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (scenario.startsWith('backpressure-')) {
      const write = _res.write.bind(_res)
      _res.write = (...args) => { write(...args); return false }
      _res.on('drain', () => { state.drainEvents += 1 })
      _res.on('close', () => { if (!state.released.length) state.closesBeforeRelease += 1 })
    }
    req.session = { createdAt: Date.now(), nodeSessionBinding: binding,
      user: { id: req.headers['x-test-user'] === '3' ? 3 : 2, username: 'operator', role: 'CCTV-Operator' },
      reload(callback) {
        state.reloads += 1
        if (scenario === 'slow-reload') return setTimeout(callback, 40)
        if (scenario === 'session-revoked') return callback(new Error('revoked'))
        if (scenario === 'assignment-revoked' || scenario === 'backpressure-revoked') state.assignment = false
        if (!state.live) return callback(new Error('session destroyed'))
        if (scenario === 'absolute-expiry') req.session.createdAt = 1
        callback()
      }, destroy(callback) { state.live = false; callback?.() } }
    next()
  })
  app.use('/api', router)
  app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Internal error' }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.DETECTION_ENGINE_API_KEY
    else process.env.DETECTION_ENGINE_API_KEY = previousKey
  })
  async function open(alias = 'CAM-01', user = 2, onRequest = () => {}) {
    const payload = JSON.stringify({ producerGeneration: '888', nodeId: 'forged', physicalCameraId: 999 })
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: `/api/cameras/${alias}/stream?producerGeneration=666&nodeId=forged&physicalCameraId=999`,
        headers: { 'x-test-user': String(user), 'X-Aegis-Producer-Generation': '777', 'content-type': 'application/json',
          'X-Detection-Engine-Key': 'browser-forged-key',
          'content-length': Buffer.byteLength(payload) } }, resolve)
      request.once('error', reject)
      onRequest(request)
      request.end(payload)
    })
  }
  async function settle(response, close = false) {
    let body = ''
    response.on('data', chunk => { body += chunk })
    const ended = once(response, close ? 'close' : 'end')
    if (close) response.destroy()
    else response.resume()
    await ended
    const deadline = Date.now() + 300
    while (state.acquired.length && state.released.length < state.acquired.length && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5))
    return body
  }
  async function logout() {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/logout', method: 'POST' }, resolve)
      request.once('error', reject)
      request.end()
    })
    response.resume()
    await once(response, 'end')
    assert.equal(response.statusCode, 200)
  }
  return { state, open, settle, logout, generation, binding }
}

test('strict_stream_sends_server_generation_and_key; client_generation_claim_cannot_override', async t => {
  const { state, open, settle, generation, binding } = await streamHarness(t)
  const response = await open()
  const body = await settle(response)
  assert.equal(response.statusCode, 200)
  assert.equal(state.acquired.length, 1)
  assert.equal(state.fetched[0].acquired, 1)
  assert.equal(state.fetched[0].authorized, 1)
  assert.equal(state.fetched[0].options.headers['X-Aegis-Producer-Generation'], generation)
  assert.equal(state.fetched[0].options.headers['X-Detection-Engine-Key'], 'server-only-engine-key')
  assert.equal(response.headers['x-aegis-producer-generation'], undefined)
  assert.equal(response.headers['x-detection-engine-key'], undefined)
  assert.ok(!body.includes(generation) && !body.includes(binding) && !body.includes('machine-a-node')
    && !body.includes('server-only-engine-key'))
  assert.deepEqual(state.released, state.acquired)
})

test('unauthorized_assignment_has_zero_side_effects', async t => {
  const { state, open, settle } = await streamHarness(t, 'unauthorized')
  const response = await open()
  await settle(response)
  assert.equal(response.statusCode, 403)
  assert.equal(state.acquired.length, 0)
  assert.equal(state.fetched.length, 0)
})

test('wrong account alias has zero demand or upstream side effects', async t => {
  const { state, open, settle } = await streamHarness(t)
  const response = await open('CAM-02', 2)
  const body = await settle(response)
  assert.equal(response.statusCode, 403)
  assert.deepEqual(JSON.parse(body), { error: 'CAMERA_ALIAS_DENIED' })
  assert.equal(state.acquired.length, 0)
  assert.equal(state.fetched.length, 0)
})

test('transactional acquire denial returns redacted authority error without fetch', async t => {
  const { state, open, settle } = await streamHarness(t, 'acquire-denied')
  const response = await open()
  const body = await settle(response)
  assert.equal(response.statusCode, 403)
  assert.deepEqual(JSON.parse(body), { error: 'PRODUCER_AUTHORITY_DENIED' })
  assert.equal(state.fetched.length, 0)
  assert.equal(state.released.length, 0)
})

for (const scenario of ['normal', 'socket-close', 'non-2xx', 'missing-body', 'fetch-throw', 'route-error',
  'idle', 'first-byte-timeout', 'logout', 'session-revoked', 'assignment-revoked', 'renewal-failure', 'absolute-expiry', 'release-failure',
  'reader-read-throw']) {
  test(`close_and_every_upstream_failure_release_demand: ${scenario}`, async t => {
    const { state, open, settle, logout } = await streamHarness(t, scenario)
    const response = await open()
    if (scenario === 'logout') await logout()
    await settle(response, scenario === 'socket-close')
    assert.equal(state.acquired.length, 1)
    assert.deepEqual(state.released, state.acquired)
    assert.equal(state.aborted, 1)
    if (!['non-2xx', 'missing-body', 'fetch-throw'].includes(scenario)) assert.equal(state.cancelled, 1)
    if (scenario === 'renewal-failure') assert.equal(state.renewed.length, 1)
    if (scenario === 'release-failure') {
      assert.equal(state.active.size, 1, 'failed release is bounded by DB lease, not reported as removed')
      assert.equal(state.retired, false)
    }
  })
}

test('two_account_aliases_share_physical_upstream; final viewer retires its epoch', async t => {
  const { state, open, settle } = await streamHarness(t, 'socket-close')
  const first = await open('CAM-01', 2)
  const second = await open('CAM-02', 3)
  assert.equal(state.acquired.length, 2)
  assert.equal(state.acquired[0].producerGeneration, '9007199254740993')
  assert.equal(state.acquired[1].producerGeneration, '9007199254740993')
  assert.deepEqual(state.fetched.map(entry => entry.url), ['http://engine.test/stream.mjpg', 'http://engine.test/stream.mjpg'])
  first.destroy()
  const deadline = Date.now() + 50
  while (!state.released.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(state.active.size, 1)
  assert.equal(state.retired, false)
  await settle(second, true)
  assert.equal(state.active.size, 0)
  assert.equal(state.retired, true)
  assert.equal(state.released.length, 2)
})

test('revalidation awaits renewal instead of overlapping callbacks', async t => {
  const { state, open, settle } = await streamHarness(t, 'slow-renewal')
  const response = await open()
  await settle(response)
  assert.ok(state.renewed.length >= 1)
  assert.equal(state.maxRenewing, 1)
  assert.deepEqual(state.released, state.acquired)
  assert.equal(state.events.at(-1), 'release')
  assert.equal(state.events.at(-2), 'renew-end')
})

test('socket close during session reload releases once without a late renewal', async t => {
  const { state, open, settle } = await streamHarness(t, 'slow-reload')
  const response = await open()
  const deadline = Date.now() + 200
  while (!state.reloads && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(state.reloads, 1)
  await settle(response, true)
  assert.equal(state.renewed.length, 0)
  assert.deepEqual(state.released, state.acquired)
})

test('socket close during acquire releases the returned demand without opening Engine', async t => {
  const { state, open } = await streamHarness(t, 'slow-acquire')
  let request
  const result = open('CAM-01', 2, req => { request = req }).catch(error => error)
  const deadline = Date.now() + 200
  while (!state.acquired.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(state.acquired.length, 1)
  request.destroy()
  assert.equal((await result).code, 'ECONNRESET')
  while (!state.released.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))
  assert.deepEqual(state.released, state.acquired)
  assert.equal(state.fetched.length, 0)
})

for (const scenario of ['backpressure-idle', 'backpressure-revoked', 'backpressure-renewal']) {
  test(`connected non-draining HTTP viewer releases demand on ${scenario}`, async t => {
    const { state, open } = await streamHarness(t, scenario)
    const response = await open()
    response.resume()
    try {
      const deadline = Date.now() + 250
      while (!state.released.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      assert.equal(state.released.length, 1, 'server abort must reach finally without browser close/drain')
      assert.deepEqual(state.released, state.acquired)
      assert.equal(state.drainEvents, 0)
      assert.equal(state.closesBeforeRelease, 0)
      assert.equal(state.cancelled, 1)
      assert.equal(state.aborted, 1)
      if (scenario === 'backpressure-revoked') assert.equal(state.renewed.length, 0)
      if (scenario === 'backpressure-renewal') assert.equal(state.renewed.length, 1)
    } finally {
      response.destroy()
      const cleanupDeadline = Date.now() + 200
      while (!state.released.length && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 5))
    }
  })
}

test('real PostgreSQL HTTP viewers share one epoch; final route cleanup retires it', {
  skip: !process.env.AEGIS_MONITOR_TEST_DATABASE_URL && 'requires explicit disposable AEGIS_MONITOR_TEST_DATABASE_URL',
}, async t => {
  const schema = `aegis_route_${randomBytes(12).toString('hex')}`
  const pool = new pg.Pool({ connectionString: process.env.AEGIS_MONITOR_TEST_DATABASE_URL, max: 5 })
  const admin = await pool.connect()
  const transactionTimeoutMs = 5_000
  let state
  let one
  let two
  const waitForRelease = async (handle, context) => {
    const started = Date.now()
    while (!state.released.includes(handle) && Date.now() - started < transactionTimeoutMs)
      await new Promise(resolve => setTimeout(resolve, 5))
    t.diagnostic(`${context}: releaseCompleted=${state.released.includes(handle)} waitMs=${Date.now() - started}`)
    assert.ok(state.released.includes(handle), `${context}: real transaction must release before DB assertions/teardown`)
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
    await admin.query(`
      INSERT INTO users (id, username, password_hash, display_name) VALUES
        (2, 'operator', 'test-only', 'One'), (3, 'operator2', 'test-only', 'Two');
      INSERT INTO cameras (id, name, zone) VALUES ('CAM-01', 'One', 'lab'), ('CAM-02', 'Two', 'lab');
      INSERT INTO camera_assignment (camera_id, user_id) VALUES ('CAM-01', 2), ('CAM-02', 3);
      INSERT INTO detection_nodes (node_id, public_key, public_key_fingerprint, key_version)
        VALUES ('machine-a-node', 'test-key', 'test-fingerprint', 1);
      INSERT INTO physical_cameras (physical_camera_id, node_id) OVERRIDING SYSTEM VALUE VALUES (41, 'machine-a-node');
      INSERT INTO node_camera_alias_policy (node_id, mode) VALUES ('machine-a-node', 'account');
      INSERT INTO node_account_camera_alias (node_id, user_id, logical_camera_id)
        VALUES ('machine-a-node', 2, 'CAM-01'), ('machine-a-node', 3, 'CAM-02');
      SELECT setval('camera_producer_epochs_producer_generation_seq', 9007199254740993, false);
    `)
    const transact = async fn => {
      const client = await pool.connect()
      try {
        await client.query(`SET search_path TO "${schema}"`)
        await client.query(`SET statement_timeout = '${transactionTimeoutMs}ms'`)
        await client.query('BEGIN')
        const result = await fn(client)
        await client.query('COMMIT')
        return result
      } catch (error) { await client.query('ROLLBACK'); throw error }
      finally { client.release() }
    }
    const service = createProducerLifecycle({ transact, secret: 'route-test-only-session-secret' })
    const harness = await streamHarness(t, 'real-viewers', service)
    state = harness.state
    one = await harness.open('CAM-01', 2)
    two = await harness.open('CAM-02', 3)
    assert.equal(one.statusCode, 200)
    assert.equal(two.statusCode, 200)
    assert.deepEqual(state.fetched.map(entry => entry.options.headers['X-Aegis-Producer-Generation']),
      ['9007199254740993', '9007199254740993'])
    const rows = (await admin.query('SELECT logical_camera_id, viewer_user_id FROM camera_producer_demands ORDER BY viewer_user_id')).rows
    assert.deepEqual(rows, [{ logical_camera_id: 'CAM-01', viewer_user_id: '2' },
      { logical_camera_id: 'CAM-02', viewer_user_id: '3' }])
    one.destroy()
    await waitForRelease(state.acquired[0], 'first viewer close')
    assert.equal((await admin.query('SELECT * FROM camera_producer_demands WHERE released_at IS NULL')).rowCount, 1)
    assert.equal((await admin.query('SELECT * FROM camera_producer_epochs WHERE released_at IS NULL')).rowCount, 1)
    two.destroy()
    await waitForRelease(state.acquired[1], 'final viewer close')
    assert.equal((await admin.query('SELECT * FROM camera_producer_demands WHERE released_at IS NULL')).rowCount, 0)
    assert.equal((await admin.query('SELECT * FROM camera_producer_epochs WHERE released_at IS NULL')).rowCount, 0)
  } finally {
    // Close both viewers even when an earlier assertion fails, then wait for
    // real route cleanup before removing the schema those transactions use.
    try {
      one?.destroy()
      two?.destroy()
      for (const handle of state?.acquired ?? []) await waitForRelease(handle, 'fixture teardown')
    } finally {
      await admin.query('ROLLBACK')
      await admin.query('SET search_path TO public')
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      admin.release()
      await pool.end()
    }
  }
})
