import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { register } from 'node:module'
import { randomBytes, createHmac } from 'node:crypto'
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
    export const canSeeCamera = (...args) => globalThis.streamTest.canSeeCamera(...args);
    export const getUserById = (...args) => globalThis.streamTest.getUserById(...args);`,
  '../auth/cameraAccess.js': `export * from ${JSON.stringify(new URL('../server/auth/cameraAccess.js', import.meta.url).href)};
    import { resolvePhysicalStreamTarget as resolveTarget } from ${JSON.stringify(new URL('../server/auth/cameraAccess.js', import.meta.url).href)};
    export const resolvePhysicalStreamTarget = (req, id, now, deps) => resolveTarget(req, id, now,
      { ...deps, approvedStreamUrlForPhysicalCamera: () => 'http://engine.test/stream.mjpg' });
    export const resolveLiveCameraActor = (...args) => globalThis.streamTest.actor(...args);
    export const resolveOperatorAccess = (...args) => globalThis.streamTest.access(...args);`,
  '../db/store.js': `export * from ${JSON.stringify(new URL('../server/db/store.js', import.meta.url).href)};
    export const streamSourceForPhysicalCamera = (...args) => globalThis.streamTest.source(...args);
    export const listDetectionsForPhysicalView = (...args) => globalThis.streamTest.viewDetections(...args);
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
        .replace(/const STREAM_IDLE_MS = (6_000|20_000)/, 'const STREAM_IDLE_MS = 80')
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
    events: [], controls: [], reloads: 0, drainEvents: 0, closesBeforeRelease: 0,
    socLive: true, socAccess: true, socDbRole: 'SOC-Responder', socDbActive: true,
    bootCalls: 0, refreshAttempts: 0, association: true, releaseBootFailure: null }
  let renewing = 0
  const generation = '9007199254740993'
  const binding = Buffer.alloc(32, 7).toString('base64url')
  globalThis.streamTest = {
    getUserById: async id => ({ id, username: 'soc', role: state.socDbRole,
      active: state.socDbActive, mustResetPassword: false }),
    viewDetections: async view => [{ id: `frame-${view.nodeId}`, cam: view.cameraId }],
    actor: async req => ({ userId: req.user.id, username: req.user.username, role: req.user.role }),
    access: async (req, alias) => {
      if (!state.association)
        throw new CameraAccessError(403, 'LOCAL_NODE_ASSOCIATION_DENIED')
      if (!state.assignment || alias !== (req.user.id === 2 ? 'CAM-01' : 'CAM-02'))
        throw new CameraAccessError(403, 'CAMERA_ALIAS_DENIED')
      return { kind: 'verified-node', viewerMode: 'demanding', userId: req.user.id, nodeId: 'machine-a-node',
        physicalCameraId: 41, keyVersion: 1, logicalCameraId: alias }
    },
    canSeeCamera: async (user, alias) => {
      state.authorization.push([user.id, alias])
      return scenario !== 'unauthorized' && (user.role === 'SOC-Responder' ? state.socAccess : state.assignment)
    },
    source: async id => {
      assert.equal(id, 41)
      return { nodeId: 'machine-a-node', url: 'http://engine.test/stream.mjpg', ageMs: 0 }
    },
    legacySource: () => assert.fail('strict route must not use logical fallback'),
    acquire: async ({ access, sessionBinding }) => {
      assert.equal(sessionBinding, binding)
      const handle = service ? await service.acquire({ access, sessionBinding })
        : { ...access, producerGeneration: generation, demandOwnerId: randomBytes(32).toString('base64url'),
          sessionBindingHash: `v1:${'a'.repeat(64)}`, leaseExpiresAtMs: Date.now() + 30000,
          dbNowMs: Date.now(), dbObservationStartMs: Date.now(), dbObservationEndMs: Date.now() }
      state.acquired.push(handle)
      state.active.add(handle.demandOwnerId)
      if (scenario === 'acquire-denied') {
        state.active.delete(handle.demandOwnerId)
        state.acquired.pop()
        throw new CameraAccessError(403, 'PRODUCER_AUTHORITY_DENIED')
      }
      if (scenario === 'slow-acquire') await new Promise(resolve => setTimeout(resolve, 40))
      return handle
    },
    renew: async ({ handle, access, sessionBinding }) => {
      assert.equal(sessionBinding, binding)
      assert.equal(access.logicalCameraId, handle.logicalCameraId)
      assert.ok(state.active.has(handle.demandOwnerId))
      state.renewed.push(handle)
      state.events.push('renew-start')
      renewing += 1
      state.maxRenewing = Math.max(state.maxRenewing, renewing)
      try {
        if (scenario === 'renewal-failure' || scenario === 'backpressure-renewal')
          throw new CameraAccessError(403, 'PRODUCER_AUTHORITY_DENIED')
        if (scenario === 'slow-renewal') await new Promise(resolve => setTimeout(resolve, 40))
        if (service) return await service.renew({ handle, access, sessionBinding })
        Object.assign(handle, { leaseExpiresAtMs: Date.now() + 30000,
          dbNowMs: Date.now(), dbObservationStartMs: Date.now(), dbObservationEndMs: Date.now() })
        return handle
      } finally { renewing -= 1; state.events.push('renew-end') }
    },
    release: async handle => {
      const outcome = service ? await service.release(handle) : null
      state.events.push('release')
      state.released.push(handle)
      if (scenario === 'release-failure') throw new Error('fixture cleanup unavailable')
      state.active.delete(handle.demandOwnerId)
      state.retired = state.active.size === 0
      return outcome ?? { released: true, epochRetired: state.retired }
    },
  }
  const previousFetch = globalThis.fetch
  const previousKey = process.env.DETECTION_ENGINE_API_KEY
  process.env.DETECTION_ENGINE_API_KEY = 'server-only-engine-key'
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/producer/boot')) {
      state.bootCalls += 1

      if (scenario === 'transient-boot-probe' && state.bootCalls === 2)
        throw new Error('fixture transient boot probe failure')

      if (scenario === 'repeated-boot-probe' && state.bootCalls >= 2)
        throw new Error('fixture repeated boot probe failure')

      if (scenario === 'client-close-during-boot-retry' && state.bootCalls === 2) {
        await new Promise(resolve => { state.releaseBootFailure = resolve })
        throw new Error('fixture delayed transient boot failure')
      }

      if (scenario === 'boot-change-on-retry' && state.bootCalls === 2)
        throw new Error('fixture transient boot probe failure')

      const bootByte = scenario === 'boot-change-on-retry' && state.bootCalls >= 3 ? 5 : 4
      const claims = { engineBootId: Buffer.alloc(32, bootByte).toString('base64url'),
        nodeId: 'machine-a-node', nonce: options.headers['X-Aegis-Clock-Nonce'], engineNowMs: Date.now() }
      const raw = Buffer.from(JSON.stringify(claims, Object.keys(claims).sort()))
      const key = createHmac('sha256', 'server-only-engine-key').update('AEGIS-demand-grant-v1-key').digest()
      const mac = createHmac('sha256', key).update('aegis-producer-clock-v1\n').update(raw).digest('base64url')
      return { ok: true, text: async () => `${raw.toString('base64url')}.${mac}` }
    }
    if (String(url).endsWith('/producer/control')) {
      const token = options.headers['X-Aegis-Demand-Grant']
      state.controls.push(JSON.parse(Buffer.from(token.split('.')[0], 'base64url')))
      const controlAction = state.controls.at(-1).action
      if (controlAction === 'refresh') {
        state.refreshAttempts += 1
        if (scenario === 'transient-refresh-control' && state.refreshAttempts === 1)
          throw new Error('fixture transient refresh control failure')
        if (scenario === 'repeated-refresh-control')
          throw new Error('fixture repeated refresh control failure')
      }
      state.events.push(state.controls.at(-1).action)
      return { ok: true }
    }
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
        if (reads === 1) return Promise.resolve({ done: false,
          value: Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 5\r\n\r\nframe\r\n') })
        if (scenario === 'normal') return Promise.resolve({ done: true })
        return new Promise((resolve, reject) => {
          pendingResolve = resolve
          if (scenario === 'passive-source-failure') state.failSource = () => reject(new Error('upstream failed'))
          if (scenario === 'real-viewers') frameTimer = setTimeout(() => {
            resolve({ done: false,
              value: Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 5\r\n\r\nframe\r\n') })
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
    if (req.headers['x-test-slow-soc'] === 'yes') {
      const write = _res.write.bind(_res)
      _res.write = (...args) => { write(...args); return false }
    }
    if (scenario.startsWith('backpressure-')) {
      const write = _res.write.bind(_res)
      _res.write = (...args) => { write(...args); return false }
      _res.on('drain', () => { state.drainEvents += 1 })
      _res.on('close', () => { if (!state.released.length) state.closesBeforeRelease += 1 })
    }
    req.session = { createdAt: Date.now(), nodeSessionBinding: binding,
      user: { id: req.headers['x-test-user'] === '3' ? 3 : 2,
        username: req.headers['x-test-role'] === 'soc' ? 'soc' : 'operator',
        role: req.headers['x-test-role'] === 'soc' ? 'SOC-Responder' : 'CCTV-Operator' },
      reload(callback) {
        state.reloads += 1
        if (req.session.user.role === 'SOC-Responder' && !state.socLive) return callback(new Error('SOC revoked'))
        if (scenario === 'slow-reload') return setTimeout(callback, 40)
        if (scenario === 'session-revoked') return callback(new Error('revoked'))
        if (scenario === 'assignment-revoked' || scenario === 'backpressure-revoked') state.assignment = false
        if (scenario === 'association-revoked') state.association = false
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
    const payload = JSON.stringify({ producerGeneration: '888', logicalCameraId: 'CAM-99', nodeId: 'forged', physicalCameraId: 999 })
    return new Promise((resolve, reject) => {
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: `/api/cameras/${alias}/stream?producerGeneration=666&logicalCameraId=CAM-98&nodeId=forged&physicalCameraId=999`,
        headers: { 'x-test-user': String(user), 'X-Aegis-Producer-Generation': '777', 'content-type': 'application/json',
          'X-Detection-Engine-Key': 'browser-forged-key',
          'X-Aegis-Logical-Camera-Id': 'CAM-97',
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
  async function socRequest(resource, { streaming = false, slow = false } = {}) {
    return new Promise((resolve, reject) => {
      const request = http.get({ hostname: '127.0.0.1', port: server.address().port,
        path: resource, headers: { 'x-test-role': 'soc', ...(slow ? { 'x-test-slow-soc': 'yes' } : {}) } }, resolve)
      request.once('error', reject)
    }).then(async response => {
      if (streaming) return response
      let body = ''
      response.on('data', chunk => { body += chunk })
      await once(response, 'end')
      let parsed
      try { parsed = JSON.parse(body) } catch { parsed = body }
      return { status: response.statusCode, body: parsed }
    })
  }
  return { state, open, settle, logout, socRequest, generation, binding }
}

test('SOC idle active-view list is empty and cannot wake an Engine', async t => {
  const { state, socRequest } = await streamHarness(t)
  const list = await socRequest('/api/live/active-views')
  assert.equal(list.status, 200)
  assert.deepEqual(list.body, { views: [] })
  const forged = await socRequest('/api/live/active-views/forged/stream')
  assert.equal(forged.status, 404)
  assert.equal(state.fetched.length, 0)
  assert.equal(state.acquired.length, 0)
})

test('two CAM-01 physical Nodes remain distinct through SOC HTTP list, stream and detection routes', async t => {
  const bounded = (label, promise) => Promise.race([promise, new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`SOC cross-node ${label} timed out`)), 1000).unref()
  })])
  const { passiveLiveRegistry } = await import('../server/passiveLiveRegistry.js')
  const { state, socRequest } = await streamHarness(t)
  const a = passiveLiveRegistry.register({ logicalCameraId: 'CAM-01', nodeId: 'node-a',
    physicalCameraId: 41, producerGeneration: '9007199254740993',
    contentType: 'multipart/x-mixed-replace; boundary=frame' })
  const b = passiveLiveRegistry.register({ logicalCameraId: 'CAM-01', nodeId: 'node-b',
    physicalCameraId: 42, producerGeneration: '9007199254740994',
    contentType: 'multipart/x-mixed-replace; boundary=frame' })
  t.after(() => { a.close(); b.close() })
  const views = (await socRequest('/api/live/active-views')).body.views
  assert.deepEqual(new Set(views.map(view => view.viewId)), new Set([a.viewId, b.viewId]))
  assert.deepEqual(new Set(views.map(view => view.nodeId)), new Set(['node-a', 'node-b']))
  const aStream = await bounded('a-open', socRequest(`/api/live/active-views/${a.viewId}/stream`, { streaming: true }))
  const bStream = await bounded('b-open', socRequest(`/api/live/active-views/${b.viewId}/stream`, { streaming: true }))
  const aBytes = once(aStream, 'data')
  const bBytes = once(bStream, 'data')
  a.publish(Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\nnode-a\r\n'))
  b.publish(Buffer.from('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 6\r\n\r\nnode-b\r\n'))
  assert.match((await bounded('a-bytes', aBytes))[0].toString(), /node-a/)
  assert.match((await bounded('b-bytes', bBytes))[0].toString(), /node-b/)
  assert.deepEqual((await socRequest(`/api/live/active-views/${a.viewId}/detections`)).body.detections,
    [{ id: 'frame-node-a', cam: 'CAM-01' }])
  assert.deepEqual((await socRequest(`/api/live/active-views/${b.viewId}/detections`)).body.detections,
    [{ id: 'frame-node-b', cam: 'CAM-01' }])
  aStream.destroy(); bStream.destroy()
  assert.equal(state.fetched.length, 0, 'SOC route must not fetch Engine for either Node')
  assert.equal(state.acquired.length, 0)
})

test('SOC attaches to an existing Operator source without another Engine fetch or demand', async t => {
  const { state, open, settle, socRequest } = await streamHarness(t, 'real-viewers')
  const operator = await open('CAM-01', 2)
  assert.equal(operator.statusCode, 200)
  const list = await socRequest('/api/live/active-views')
  assert.equal(list.status, 200)
  assert.equal(list.body.views.length, 1)
  const view = list.body.views[0]
  assert.equal(view.cameraId, 'CAM-01')
  assert.equal(view.nodeId, 'machine-a-node')
  assert.equal('producerGeneration' in view, false)
  assert.equal('physicalCameraId' in view, false)
  const soc = await socRequest(`/api/live/active-views/${encodeURIComponent(view.viewId)}/stream`, { streaming: true })
  assert.equal(soc.statusCode, 200)
  assert.equal(state.fetched.length, 1)
  assert.equal(state.acquired.length, 1)
  await settle(soc, true)
  assert.equal(state.released.length, 0)
  await settle(operator, true)
  assert.equal(state.released.length, 1)
})

test('final Operator close removes the passive source and terminates the SOC viewer', async t => {
  const { state, open, settle, socRequest } = await streamHarness(t, 'real-viewers')
  const operator = await open()
  const { body } = await socRequest('/api/live/active-views')
  const soc = await socRequest(`/api/live/active-views/${body.views[0].viewId}/stream`, { streaming: true })
  assert.equal(soc.statusCode, 200)
  soc.resume()
  const socClosed = once(soc, 'close')
  await settle(operator, true)
  await socClosed
  assert.equal(state.released.length, 1)
  assert.deepEqual((await socRequest('/api/live/active-views')).body.views, [])
  assert.equal(state.fetched.length, 1)
})

test('SOC session revocation closes only its passive viewer', async t => {
  const { state, open, settle, socRequest } = await streamHarness(t, 'real-viewers')
  const operator = await open()
  const { body } = await socRequest('/api/live/active-views')
  const soc = await socRequest(`/api/live/active-views/${body.views[0].viewId}/stream`, { streaming: true })
  soc.resume()
  const socClosed = once(soc, 'close')
  state.socLive = false
  await socClosed
  assert.equal(state.released.length, 0)
  assert.equal(state.fetched.length, 1)
  await settle(operator, true)
})

test('SOC camera access revocation closes its passive viewer without releasing Operator demand', async t => {
  const { state, open, settle, socRequest } = await streamHarness(t, 'real-viewers')
  const operator = await open()
  const { body } = await socRequest('/api/live/active-views')
  const soc = await socRequest(`/api/live/active-views/${body.views[0].viewId}/stream`, { streaming: true })
  soc.resume()
  const socClosed = once(soc, 'close')
  state.socAccess = false
  await socClosed
  assert.equal(state.released.length, 0)
  await settle(operator, true)
})

test('live SOC database role or active-state revocation denies new views and closes an open passive viewer', async t => {
  const { state, open, settle, socRequest } = await streamHarness(t, 'real-viewers')
  const operator = await open('CAM-01', 2)
  const { body } = await socRequest('/api/live/active-views')
  const viewId = body.views[0].viewId
  const soc = await socRequest(`/api/live/active-views/${viewId}/stream`, { streaming: true })
  soc.resume()
  const socClosed = once(soc, 'close')
  state.socDbRole = 'CCTV-Operator'
  await socClosed
  assert.equal((await socRequest('/api/live/active-views')).status, 403)
  assert.equal((await socRequest(`/api/live/active-views/${viewId}/detections`)).status, 403)
  state.socDbRole = 'SOC-Responder'
  state.socDbActive = false
  assert.equal((await socRequest(`/api/live/active-views/${viewId}/stream`)).status, 403)
  assert.equal(state.fetched.length, 1)
  await settle(operator, true)
})

test('SOC cannot invoke the legacy logical camera stream or forge physical authority', async t => {
  const { state, open, settle, socRequest } = await streamHarness(t, 'real-viewers')
  const operator = await open()
  const forged = await socRequest('/api/live/active-views/forged/stream?producerGeneration=999&physicalCameraId=2&nodeId=forged')
  assert.equal(forged.status, 404)
  const legacy = await socRequest('/api/cameras/CAM-01/stream')
  assert.equal(legacy.status, 403)
  assert.equal(state.fetched.length, 1)
  assert.equal(state.acquired.length, 1)
  await settle(operator, true)
})

test('slow SOC backpressure disconnects only SOC and does not stall the demanding Operator', async t => {
  const { state, open, settle, socRequest } = await streamHarness(t, 'real-viewers')
  const operator = await open()
  const { body } = await socRequest('/api/live/active-views')
  const soc = await socRequest(`/api/live/active-views/${body.views[0].viewId}/stream`,
    { streaming: true, slow: true })
  soc.resume()
  const socClosed = new Promise(resolve => { soc.on('error', () => {}); soc.once('close', resolve) })
  await socClosed
  assert.equal(state.released.length, 0)
  assert.equal(state.fetched.length, 1)
  assert.equal(state.active.size, 1)
  await settle(operator, true)
})

test('upstream failure closes passive SOC and releases Operator demand exactly once', async t => {
  const { state, open, settle, socRequest } = await streamHarness(t, 'passive-source-failure')
  const operator = await open()
  operator.resume()
  const { body } = await socRequest('/api/live/active-views')
  const soc = await socRequest(`/api/live/active-views/${body.views[0].viewId}/stream`, { streaming: true })
  soc.resume()
  const socClosed = once(soc, 'close')
  const operatorClosed = once(operator, 'close')
  state.failSource()
  await Promise.all([socClosed, operatorClosed])
  assert.equal(state.released.length, 1)
  assert.equal(state.fetched.length, 1)
  assert.deepEqual((await socRequest('/api/live/active-views')).body.views, [])
})

test('strict_stream_sends_server_generation_and_key; client_generation_claim_cannot_override', async t => {
  const { state, open, settle, generation, binding } = await streamHarness(t)
  const response = await open()
  const body = await settle(response)
  assert.equal(response.statusCode, 200)
  assert.equal(state.acquired.length, 1)
  assert.equal(state.fetched[0].acquired, 1)
  assert.equal(state.fetched[0].authorized, 1)
  assert.equal(state.fetched[0].options.headers['X-Aegis-Producer-Generation'], generation)
  assert.equal(state.fetched[0].options.headers['X-Aegis-Logical-Camera-Id'], 'CAM-01')
  assert.equal(state.fetched[0].options.headers['X-Aegis-Logical-Camera-Id'], state.acquired[0].logicalCameraId)
  assert.equal(state.fetched[0].options.headers['X-Detection-Engine-Key'], 'server-only-engine-key')
  const token = state.fetched[0].options.headers['X-Aegis-Demand-Grant']
  assert.equal(typeof token, 'string', 'a bare key and generation are not demand authority')
  const claims = JSON.parse(Buffer.from(token.split('.')[0], 'base64url'))
  assert.equal(claims.demandOwnerId, state.acquired[0].demandOwnerId)
  assert.equal(claims.logicalCameraId, 'CAM-01')
  assert.equal(claims.userId, '2')
  assert.equal(claims.physicalCameraId, 41)
  assert.equal(claims.producerGeneration, generation)
  assert.ok(claims.expiresAtMs < state.acquired[0].leaseExpiresAtMs)
  assert.deepEqual(state.controls.map(c => c.action), ['revoke', 'retire'])
  assert.ok(state.events.indexOf('release') < state.events.indexOf('revoke'))
  assert.equal(response.headers['x-aegis-producer-generation'], undefined)
  assert.equal(response.headers['x-aegis-logical-camera-id'], undefined)
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
  'idle', 'first-byte-timeout', 'logout', 'session-revoked', 'assignment-revoked', 'association-revoked',
  'renewal-failure', 'absolute-expiry', 'release-failure', 'reader-read-throw']) {
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
    if (['session-revoked', 'assignment-revoked', 'association-revoked'].includes(scenario))
      assert.equal(state.renewed.length, 0)
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
  assert.deepEqual(state.fetched.map(entry => entry.options.headers['X-Aegis-Logical-Camera-Id']), ['CAM-01', 'CAM-02'])
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

test('production class: transient post-renew boot probe failure must recover without killing stream', async t => {
  const { state, open } = await streamHarness(t, 'transient-boot-probe')
  const response = await open()
  response.resume()
  try {
    const deadline = Date.now() + 300
    while (state.renewed.length < 2 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5))

    assert.ok(
      state.renewed.length >= 2,
      'retry must perform a fresh producer DB renewal after transient boot failure',
    )
    assert.ok(
      state.bootCalls >= 3,
      'retry must obtain a fresh Engine boot observation',
    )
    assert.equal(
      state.released.length,
      0,
      'a recovered transient boot failure must not release the healthy stream',
    )
  } finally {
    response.destroy()
    const cleanupDeadline = Date.now() + 300
    while (!state.released.length && Date.now() < cleanupDeadline)
      await new Promise(resolve => setTimeout(resolve, 5))
  }

  assert.deepEqual(state.released, state.acquired)
  assert.equal(state.maxRenewing, 1)
})

test('production class: transient post-renew refresh failure must recover with fresh authority', async t => {
  const { state, open } = await streamHarness(t, 'transient-refresh-control')
  const response = await open()
  response.resume()
  try {
    const deadline = Date.now() + 300
    while (state.refreshAttempts < 2 && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 5))

    assert.ok(
      state.renewed.length >= 2,
      'refresh retry must use a fresh producer DB renewal',
    )
    assert.ok(
      state.bootCalls >= 3,
      'refresh retry must use a fresh Engine boot observation',
    )
    assert.ok(
      state.refreshAttempts >= 2,
      'transient refresh control failure must be retried',
    )
    assert.equal(
      state.released.length,
      0,
      'a recovered transient refresh failure must not release the healthy stream',
    )
  } finally {
    response.destroy()
    const cleanupDeadline = Date.now() + 300
    while (!state.released.length && Date.now() < cleanupDeadline)
      await new Promise(resolve => setTimeout(resolve, 5))
  }

  assert.deepEqual(state.released, state.acquired)
  assert.equal(state.maxRenewing, 1)
})

test('production class: repeated post-renew boot failures exhaust retry and fail closed once', async t => {
  const { state, open, settle } = await streamHarness(t, 'repeated-boot-probe')
  const response = await open()
  await settle(response)

  assert.equal(state.renewed.length, 2)
  assert.equal(state.bootCalls, 3)
  assert.equal(state.released.length, 1)
  assert.deepEqual(state.released, state.acquired)
  assert.equal(state.maxRenewing, 1)
})

test('production class: repeated post-renew refresh failures exhaust retry and fail closed once', async t => {
  const { state, open, settle } = await streamHarness(t, 'repeated-refresh-control')
  const response = await open()
  await settle(response)

  assert.equal(state.renewed.length, 2)
  assert.equal(state.refreshAttempts, 2)
  assert.equal(state.released.length, 1)
  assert.deepEqual(state.released, state.acquired)
  assert.equal(state.maxRenewing, 1)
})

test('production class: Engine boot change during retry is immediate fail closed', async t => {
  const { state, open, settle } = await streamHarness(t, 'boot-change-on-retry')
  const response = await open()
  await settle(response)

  assert.equal(state.renewed.length, 2)
  assert.equal(state.bootCalls, 3)
  assert.equal(state.refreshAttempts, 0)
  assert.equal(state.released.length, 1)
  assert.deepEqual(state.released, state.acquired)
})

test('production class: client close while transient boot failure is pending cannot resurrect demand', async t => {
  const { state, open } = await streamHarness(t, 'client-close-during-boot-retry')
  const response = await open()
  response.resume()

  const pendingDeadline = Date.now() + 300
  while (!state.releaseBootFailure && Date.now() < pendingDeadline)
    await new Promise(resolve => setTimeout(resolve, 5))

  assert.equal(typeof state.releaseBootFailure, 'function')
  assert.equal(state.renewed.length, 1)
  assert.equal(state.bootCalls, 2)

  response.destroy()
  state.releaseBootFailure()

  const releaseDeadline = Date.now() + 300
  while (!state.released.length && Date.now() < releaseDeadline)
    await new Promise(resolve => setTimeout(resolve, 5))

  assert.equal(state.renewed.length, 1, 'client close must prevent a retry renewal')
  assert.equal(state.refreshAttempts, 0)
  assert.equal(state.released.length, 1)
  assert.deepEqual(state.released, state.acquired)
})

test('revalidation awaits renewal instead of overlapping callbacks', async t => {
  const { state, open, settle } = await streamHarness(t, 'slow-renewal')
  const response = await open()
  await settle(response)
  assert.ok(state.renewed.length >= 1)
  assert.equal(state.maxRenewing, 1)
  assert.deepEqual(state.released, state.acquired)
  assert.deepEqual(state.events.slice(-3), ['release', 'revoke', 'retire'])
  const releasedAt = state.events.indexOf('release')
  assert.ok(state.events.lastIndexOf('renew-end') < releasedAt)
  assert.ok(state.events.lastIndexOf('refresh') < releasedAt)
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
  let socOne
  let socTwo
  const waitForRelease = async (handle, context) => {
    const wasReleased = () => state.released.some(released => released.demandOwnerId === handle.demandOwnerId
      && released.producerGeneration === handle.producerGeneration)
    const started = Date.now()
    while (!wasReleased() && Date.now() - started < transactionTimeoutMs)
      await new Promise(resolve => setTimeout(resolve, 5))
    t.diagnostic(`${context}: releaseCompleted=${wasReleased()} waitMs=${Date.now() - started}`)
    assert.ok(wasReleased(), `${context}: real transaction must release before DB assertions/teardown`)
  }
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    await admin.query(`SET search_path TO "${schema}"`)
    await admin.query(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'))
    await admin.query(`
      INSERT INTO users (id, username, password_hash, display_name) VALUES
        (2, 'operator', 'test-only', 'One'), (3, 'operator2', 'test-only', 'Two'),
        (4, 'soc', 'test-only', 'SOC');
      UPDATE users SET role = 'SOC-Responder' WHERE id = 4;
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
    const scopedDatabaseUrl = new URL(process.env.AEGIS_MONITOR_TEST_DATABASE_URL)
    scopedDatabaseUrl.searchParams.set('options', `-csearch_path=${schema}`)
    const previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = scopedDatabaseUrl.toString()
    let liveUserDb
    try { liveUserDb = await import(`../server/db/connection.js?soc-user-revocation=${schema}`) }
    finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabaseUrl
    }
    try {
      assert.equal((await liveUserDb.getUserById(4)).active, true)
      await admin.query('UPDATE users SET active = FALSE WHERE id = 4')
      assert.equal((await liveUserDb.getUserById(4)).active, false,
        'real PostgreSQL mapping must expose deactivation to passive SOC revalidation')
    } finally { await liveUserDb.closePool() }
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
    assert.equal(one.statusCode, 200)
    assert.equal((await admin.query('SELECT * FROM camera_producer_demands WHERE released_at IS NULL')).rowCount, 1)
    assert.equal((await admin.query('SELECT * FROM camera_producer_epochs WHERE released_at IS NULL')).rowCount, 1)
    const firstViews = (await harness.socRequest('/api/live/active-views')).body.views
    assert.equal(firstViews.length, 1)
    socOne = await harness.socRequest(`/api/live/active-views/${firstViews[0].viewId}/stream`, { streaming: true })
    assert.equal(socOne.statusCode, 200)
    assert.equal((await admin.query('SELECT * FROM camera_producer_demands WHERE released_at IS NULL')).rowCount, 1)
    assert.equal((await admin.query('SELECT * FROM camera_producer_epochs WHERE released_at IS NULL')).rowCount, 1)
    socOne.destroy()
    assert.equal((await admin.query('SELECT * FROM camera_producer_demands WHERE released_at IS NULL')).rowCount, 1)
    two = await harness.open('CAM-02', 3)
    assert.equal(two.statusCode, 200)
    const secondViews = (await harness.socRequest('/api/live/active-views')).body.views
    assert.equal(secondViews.length, 2)
    const cam02View = secondViews.find(view => view.cameraId === 'CAM-02')
    socTwo = await harness.socRequest(`/api/live/active-views/${cam02View.viewId}/stream`, { streaming: true })
    socTwo.resume()
    const socTwoClosed = once(socTwo, 'close')
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
    await socTwoClosed
    assert.equal((await admin.query('SELECT * FROM camera_producer_demands WHERE released_at IS NULL')).rowCount, 0)
    assert.equal((await admin.query('SELECT * FROM camera_producer_epochs WHERE released_at IS NULL')).rowCount, 0)
    assert.equal(state.fetched.length, 2, 'SOC must not open a third Engine stream')
    await admin.query(`
      INSERT INTO detection_nodes (node_id, public_key, public_key_fingerprint, key_version)
        VALUES ('machine-b-node', 'test-key-b', 'test-fingerprint-b', 1);
      INSERT INTO physical_cameras (physical_camera_id, node_id) OVERRIDING SYSTEM VALUE
        VALUES (42, 'machine-b-node');
    `)
    const secondNodeEpoch = (await admin.query(`
      INSERT INTO camera_producer_epochs (physical_camera_id, node_id, lease_expires_at, released_at)
      VALUES (42, 'machine-b-node', now() + interval '1 minute', now())
      RETURNING producer_generation
    `)).rows[0].producer_generation
    await admin.query(`
      INSERT INTO detections (frame_id, camera_id, physical_camera_id, producer_generation, result)
      VALUES ('node-a-frame', 'CAM-01', 41, $1::bigint, 'Unknown'),
             ('node-b-frame', 'CAM-01', 42, $2::bigint, 'Unknown')
    `, [state.acquired[0].producerGeneration, secondNodeEpoch])
    const { listDetectionsForPhysicalView } = await import('../server/db/store.js')
    const readView = ({ physicalCameraId, producerGeneration, nodeId }) =>
      listDetectionsForPhysicalView({ cameraId: 'CAM-01', physicalCameraId, producerGeneration, nodeId },
        { postgresEnabled: true, executeQuery: (sql, params) => admin.query(sql, params) })
    assert.deepEqual((await readView({ physicalCameraId: 41,
      producerGeneration: state.acquired[0].producerGeneration, nodeId: 'machine-a-node' }))
      .map(frame => frame.id), ['node-a-frame'])
    assert.deepEqual((await readView({ physicalCameraId: 42,
      producerGeneration: secondNodeEpoch, nodeId: 'machine-b-node' }))
      .map(frame => frame.id), ['node-b-frame'])
    assert.deepEqual(await readView({ physicalCameraId: 41,
      producerGeneration: secondNodeEpoch, nodeId: 'machine-a-node' }), [])
  } finally {
    // Close both viewers even when an earlier assertion fails, then wait for
    // real route cleanup before removing the schema those transactions use.
    try {
      one?.destroy()
      two?.destroy()
      socOne?.destroy()
      socTwo?.destroy()
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
