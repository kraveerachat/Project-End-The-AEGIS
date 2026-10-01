import assert from 'node:assert/strict'
import express from 'express'
import test from 'node:test'

import { createAuthenticateDetectionIngest } from '../server/middleware/authenticateDetectionIngest.js'

async function start(overrides = {}) {
  const nodes = new Map([
    ['edge-legacy', { nodeId: 'edge-legacy', ingestAuthMode: 'legacy_shared_key', active: true }],
    ['edge-strict', { nodeId: 'edge-strict', ingestAuthMode: 'ed25519_required', active: true }],
  ])
  const middleware = createAuthenticateDetectionIngest({
    legacyKey: 'legacy-secret',
    sessionStore: { lookup: () => null },
    getDetectionNode: async (nodeId) => nodes.get(nodeId) ?? null,
    getPhysicalCamera: async (id) => Number(id) === 77
      ? { physicalCameraId: 77, nodeId: 'edge-strict', active: true }
      : null,
    getPhysicalCameraForNode: async () => null,
    ...overrides,
  })
  const app = express()
  app.use(express.json({ verify(req, _res, bytes) { req.rawBody = Buffer.from(bytes) } }))
  app.use('/internal', middleware)
  app.post('/internal/heartbeat', (req, res) => res.json({ kind: req.ingestAuth.kind, verified: req.verifiedNode ?? null }))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve))
  const { port } = server.address()
  return {
    async send(body, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${port}/internal/heartbeat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-detection-engine-key': 'legacy-secret', ...headers },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('legacy mode stays logical-only while strict Node and physical claims fail closed', async (t) => {
  const ctx = await start(); t.after(() => ctx.close())
  assert.deepEqual(await ctx.send({ cameraId: 'CAM-02', nodeId: 'edge-legacy', physicalCameraId: 999 }), {
    status: 200,
    body: { kind: 'legacy_unverified', verified: null },
  })
  assert.equal((await ctx.send({ cameraId: 'CAM-01', nodeId: 'edge-strict' })).status, 401)
  assert.equal((await ctx.send({ cameraId: 'CAM-01', physicalCameraId: 77 })).status, 401)
})

test('any Agent proof header selects strict proof handling and never falls back to the shared key', async (t) => {
  const ctx = await start(); t.after(() => ctx.close())
  const result = await ctx.send(
    { cameraId: 'CAM-02', nodeId: 'edge-legacy' },
    { 'x-aegis-agent-session': 'partial-proof' },
  )
  assert.equal(result.status, 401)
  assert.equal(result.body.error, 'REQUEST_PROOF_FAILED')
})
