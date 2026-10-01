import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { register } from 'node:module'
import test from 'node:test'

register(new URL('./fixtures/physicalLinkRouteLoader.mjs', import.meta.url))

const originalTrustedSources = process.env.AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES
const originalStreamHost = process.env.AEGIS_MONITOR_STREAM_HOST
process.env.AEGIS_MONITOR_STREAM_HOST = 'aegis-stream-host.internal'
process.env.AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES = JSON.stringify({
  41: { nodeId: 'machine-a-node', url: 'http://aegis-stream-host.internal:18077/stream.mjpg' },
})
test.after(() => {
  if (originalTrustedSources === undefined) delete process.env.AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES
  else process.env.AEGIS_TRUSTED_PHYSICAL_STREAM_SOURCES = originalTrustedSources
  if (originalStreamHost === undefined) delete process.env.AEGIS_MONITOR_STREAM_HOST
  else process.env.AEGIS_MONITOR_STREAM_HOST = originalStreamHost
})

globalThis.__physicalLinkFixture = {
  actor: { userId: 2, username: 'operator', role: 'CCTV-Operator' },
  access: {
    kind: 'verified-node', viewerMode: 'demanding', userId: 2,
    nodeId: 'machine-a-node', physicalCameraId: 41, logicalCameraId: 'CAM-01', keyVersion: 1,
  },
  source: {
    nodeId: 'machine-a-node',
    url: 'http://aegis-stream-host.internal:18077/stream.mjpg',
    ageMs: 1_000,
    cameraConnected: false,
  },
  physicalLookups: [],
  logicalLinkCalls: 0,
  assignmentActive: true,
  assignmentChecks: [],
  acquireCalls: [],
  releaseCalls: [],
  sessionBinding: Buffer.alloc(32, 5).toString('base64url'),
}

const express = (await import('express')).default
const { apiRouter } = await import('../server/routes/api.js')

async function requestJson(server, path) {
  const { port } = server.address()
  const response = await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}${path}`, resolve)
    request.once('error', reject)
  })
  let body = ''
  response.setEncoding('utf8')
  response.on('data', (chunk) => { body += chunk })
  await once(response, 'end')
  return { status: response.statusCode, body: JSON.parse(body) }
}

test('strict /api/link resolves physical availability without logical heartbeat authority', async (t) => {
  const fixture = globalThis.__physicalLinkFixture
  const app = express()
  app.use((req, _res, next) => {
    req.session = {
      createdAt: Date.now(),
      user: { id: 2, username: 'operator', role: 'CCTV-Operator' },
      destroy(callback) { callback?.() },
    }
    next()
  })
  app.use('/api', apiRouter)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => server.close(resolve)))

  const response = await requestJson(server, '/api/link')
  assert.equal(response.status, 200)
  assert.equal(response.body.cameras[0].cam, 'CAM-01')
  assert.equal(response.body.cameras[0].hasStream, true)
  assert.deepEqual(fixture.physicalLookups, [41])
  assert.equal(fixture.logicalLinkCalls, 0)
})

test('strict /api/link serializes live association denial before any heartbeat lookup', async (t) => {
  const fixture = globalThis.__physicalLinkFixture
  fixture.actorError = { status: 403, code: 'LOCAL_NODE_ASSOCIATION_DENIED' }
  fixture.physicalLookups.length = 0
  const app = express()
  app.use((req, _res, next) => {
    req.session = {
      createdAt: Date.now(),
      user: { id: 2, username: 'operator', role: 'CCTV-Operator' },
      destroy(callback) { callback?.() },
    }
    next()
  })
  app.use('/api', apiRouter)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    delete fixture.actorError
    return new Promise((resolve) => server.close(resolve))
  })

  const response = await requestJson(server, '/api/link')
  assert.equal(response.status, 403)
  assert.deepEqual(response.body, { error: 'LOCAL_NODE_ASSOCIATION_DENIED' })
  assert.deepEqual(fixture.physicalLookups, [])
  assert.equal(fixture.logicalLinkCalls, 0)
})

test('strict stream rejects redirects before the Engine credential reaches another origin', async (t) => {
  const fixture = globalThis.__physicalLinkFixture
  const originalSource = fixture.source
  const originalKey = process.env.DETECTION_ENGINE_API_KEY
  let redirectedRequests = 0
  let redirectedCredential
  let originGeneration
  let originCredential

  const redirectTarget = http.createServer((req, res) => {
    redirectedRequests += 1
    redirectedCredential = req.headers['x-detection-engine-key']
    res.writeHead(204)
    res.end()
  })
  redirectTarget.listen(0, '127.0.0.1')
  await once(redirectTarget, 'listening')

  const redirector = http.createServer((req, res) => {
    originCredential = req.headers['x-detection-engine-key']
    originGeneration = req.headers['x-aegis-producer-generation']
    const { port } = redirectTarget.address()
    res.writeHead(302, { Location: `http://127.0.0.1:${port}/capture` })
    res.end()
  })
  redirector.listen(0, '127.0.0.1')
  await once(redirector, 'listening')

  const app = express()
  app.use((req, _res, next) => {
    req.session = {
      createdAt: Date.now(),
      user: { id: 2, username: 'operator', role: 'CCTV-Operator' },
      nodeSessionBinding: fixture.sessionBinding,
      destroy(callback) { callback?.() },
    }
    next()
  })
  app.use('/api', apiRouter)
  const monitor = app.listen(0, '127.0.0.1')
  await once(monitor, 'listening')

  fixture.source = {
    ...originalSource,
    url: `http://127.0.0.1:${redirector.address().port}/stream.mjpg`,
  }
  process.env.DETECTION_ENGINE_API_KEY = 'test-only-redirect-sentinel'
  t.after(async () => {
    fixture.source = originalSource
    if (originalKey === undefined) delete process.env.DETECTION_ENGINE_API_KEY
    else process.env.DETECTION_ENGINE_API_KEY = originalKey
    await Promise.all([
      new Promise((resolve) => monitor.close(resolve)),
      new Promise((resolve) => redirector.close(resolve)),
      new Promise((resolve) => redirectTarget.close(resolve)),
    ])
  })

  const response = await requestJson(monitor, '/api/cameras/CAM-01/stream')
  assert.equal(redirectedRequests, 0)
  assert.equal(redirectedCredential, undefined)
  assert.equal(response.status, 504)
  assert.equal(originCredential, 'test-only-redirect-sentinel')
  assert.equal(originGeneration, '9007199254740993')
  assert.deepEqual(fixture.assignmentChecks, [[2, 'CAM-01']])
  assert.equal(fixture.acquireCalls.length, 1)
  assert.deepEqual(fixture.releaseCalls, fixture.acquireCalls)
})
