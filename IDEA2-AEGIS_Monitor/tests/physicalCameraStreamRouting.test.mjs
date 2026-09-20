import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'

import {
  CameraAccessError,
  parseLocalNodeAssociationRequirement,
  resolvePhysicalStreamTarget,
} from '../server/auth/cameraAccess.js'

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
            url: 'http://127.0.0.1:8077/stream.mjpg',
            ageMs: 0,
            cameraConnected: false,
          }
        },
      },
    )
    assert.equal(result.access.physicalCameraId, 41)
    assert.equal(result.source.url, 'http://127.0.0.1:8077/stream.mjpg')
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
