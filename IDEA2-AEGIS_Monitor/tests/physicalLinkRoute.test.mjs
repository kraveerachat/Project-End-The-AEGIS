import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { register } from 'node:module'
import test from 'node:test'

register(new URL('./fixtures/physicalLinkRouteLoader.mjs', import.meta.url))

globalThis.__physicalLinkFixture = {
  actor: { userId: 2, username: 'operator', role: 'CCTV-Operator' },
  access: {
    kind: 'verified-node', viewerMode: 'demanding', userId: 2,
    nodeId: 'machine-a-node', physicalCameraId: 41, logicalCameraId: 'CAM-01',
  },
  source: {
    nodeId: 'machine-a-node',
    url: 'http://127.0.0.1:8077/stream.mjpg',
    ageMs: 1_000,
    cameraConnected: false,
  },
  physicalLookups: [],
  logicalLinkCalls: 0,
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
