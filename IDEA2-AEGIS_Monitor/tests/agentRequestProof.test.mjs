import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import express from 'express'
import http from 'node:http'
import test from 'node:test'

import { createAuthenticateDetectionIngest } from '../server/middleware/authenticateDetectionIngest.js'
import { canonicalRequestPayload, REQUEST_PROOFS } from '../server/nodeIdentity/agentProtocol.js'
import { ReplayWindow } from '../server/nodeIdentity/replayWindow.js'

const SESSION_ID = Buffer.alloc(32, 9).toString('base64url')
const NODE_ID = 'edge-a'

function token(size, fill) { return Buffer.alloc(size, fill).toString('base64url') }

function harness() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  let now = 100_000
  let downstreamCalls = 0
  const registeredNode = {
    nodeId: NODE_ID,
    keyVersion: 4,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    ingestAuthMode: 'ed25519_required',
    active: true,
  }
  let liveNode = registeredNode
  let livePhysical = { physicalCameraId: 41, nodeId: NODE_ID, active: true }
  const state = {
    nodeId: NODE_ID,
    keyVersion: 4,
    physicalCameraId: 41,
    expiresAtMs: 700_000,
    replay: new ReplayWindow(),
  }
  const middleware = createAuthenticateDetectionIngest({
    now: () => now,
    legacyKey: 'legacy-secret',
    sessionStore: { lookup: (value) => value === SESSION_ID ? state : null },
    getDetectionNode: async (nodeId) => nodeId === NODE_ID ? liveNode : null,
    getPhysicalCameraForNode: async () => livePhysical,
    getPhysicalCamera: async () => null,
  })
  const app = express()
  app.use(express.json({ limit: '16kb', verify(req, _res, bytes) { req.rawBody = Buffer.from(bytes) } }))
  app.use('/internal', middleware)
  app.post('/internal/heartbeat', (req, res) => {
    downstreamCalls += 1
    res.json({
      verifiedNode: req.verifiedNode,
      authKind: req.ingestAuth.kind,
      body: req.body,
    })
  })
  const server = app.listen(0, '127.0.0.1')

  async function send({
    body = { cameraId: 'CAM-01' },
    signedBody = body,
    sequence = '1',
    nonce = token(16, 7),
    timestamp = String(now),
    path = '/internal/heartbeat',
    proof = REQUEST_PROOFS.heartbeat,
    headers = {},
  } = {}) {
    await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve))
    const rawBody = JSON.stringify(body)
    const signedRawBody = JSON.stringify(signedBody)
    const canonical = canonicalRequestPayload({
      domain: proof.domain,
      sessionId: SESSION_ID,
      requestNonce: nonce,
      timestampMs: timestamp,
      sequence,
      method: proof.method,
      path: proof.path,
      bodySha256: createHash('sha256').update(signedRawBody).digest('hex'),
    })
    const signature = sign(null, canonical, privateKey).toString('base64url')
    const { port } = server.address()
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-detection-engine-key': 'legacy-secret',
        'x-aegis-agent-session': SESSION_ID,
        'x-aegis-request-nonce': nonce,
        'x-aegis-request-timestamp': timestamp,
        'x-aegis-request-sequence': sequence,
        'x-aegis-request-signature': signature,
        ...headers,
      },
      body: rawBody,
    })
    return { status: response.status, body: await response.json() }
  }
  async function sendRaw(headers) {
    await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve))
    const rawBody = JSON.stringify({ cameraId: 'CAM-01' })
    const { port } = server.address()
    return new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port, path: '/internal/heartbeat', method: 'POST', headers,
      }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({
            status: response.statusCode,
            body: text ? JSON.parse(text) : null,
          })
        })
      })
      request.on('error', reject)
      request.end(rawBody)
    })
  }
  return {
    send,
    sendRaw,
    close: () => new Promise((resolve) => server.close(resolve)),
    setNow: (value) => { now = value },
    setNode: (value) => { liveNode = value },
    registeredNode: () => ({ ...registeredNode }),
    resetNode: () => { liveNode = registeredNode },
    setPhysical: (value) => { livePhysical = value },
    calls: () => downstreamCalls,
  }
}

test('valid route-bound proof exposes only server-derived physical authority', async (t) => {
  const ctx = harness(); t.after(() => ctx.close())
  const result = await ctx.send({ body: { cameraId: 'CAM-01', nodeId: 'forged', physicalCameraId: 999 } })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.verifiedNode, {
    nodeId: NODE_ID,
    keyVersion: 4,
    physicalCameraId: 41,
    agentSessionId: SESSION_ID,
  })
  assert.equal(result.body.authKind, 'ed25519')
})

test('altered body, wrong route domain, query strings, and partial proof fail without legacy fallback', async (t) => {
  const ctx = harness(); t.after(() => ctx.close())
  assert.equal((await ctx.send({ body: { cameraId: 'CAM-02' }, signedBody: { cameraId: 'CAM-01' } })).status, 401)
  assert.equal((await ctx.send({ sequence: '2', nonce: token(16, 8), proof: REQUEST_PROOFS.alert })).status, 401)
  assert.equal((await ctx.send({ sequence: '3', nonce: token(16, 9), path: '/internal/heartbeat?cameraId=CAM-02' })).status, 401)

  const { send } = ctx
  const result = await send({
    sequence: '4',
    nonce: token(16, 10),
    headers: { 'x-aegis-request-signature': '' },
  })
  assert.equal(result.status, 401)
  assert.equal(ctx.calls(), 0)
})

test('timestamp boundaries, sequence window, and nonce replay are enforced atomically', async (t) => {
  const ctx = harness(); t.after(() => ctx.close())
  ctx.setNow(200_000)
  assert.equal((await ctx.send({ timestamp: '170000', sequence: '100', nonce: token(16, 20) })).status, 200)
  assert.equal((await ctx.send({ timestamp: '210000', sequence: '102', nonce: token(16, 21) })).status, 200)
  assert.equal((await ctx.send({ timestamp: '200000', sequence: '101', nonce: token(16, 22) })).status, 200)
  assert.equal((await ctx.send({ timestamp: '200000', sequence: '101', nonce: token(16, 23) })).status, 401)
  assert.equal((await ctx.send({ timestamp: '200000', sequence: '103', nonce: token(16, 22) })).status, 401)
  assert.equal((await ctx.send({ timestamp: '169999', sequence: '104', nonce: token(16, 24) })).status, 401)
  assert.equal((await ctx.send({ timestamp: '210001', sequence: '105', nonce: token(16, 25) })).status, 401)
  assert.equal(ctx.calls(), 3)
})

test('duplicate headers and concurrent duplicate requests are admitted at most once', async (t) => {
  const ctx = harness(); t.after(() => ctx.close())
  const duplicate = await ctx.sendRaw([
    'Content-Type', 'application/json',
    'Content-Length', String(Buffer.byteLength(JSON.stringify({ cameraId: 'CAM-01' }))),
    'X-Detection-Engine-Key', 'legacy-secret',
    'X-Aegis-Agent-Session', SESSION_ID,
    'X-Aegis-Agent-Session', SESSION_ID,
    'X-Aegis-Request-Nonce', token(16, 30),
    'X-Aegis-Request-Timestamp', '100000',
    'X-Aegis-Request-Sequence', '1',
    'X-Aegis-Request-Signature', token(64, 31),
  ])
  assert.ok([400, 401].includes(duplicate.status), 'HTTP or proof parser must reject duplicate headers')
  assert.equal(ctx.calls(), 0)

  const options = { sequence: '2', nonce: token(16, 32) }
  const results = await Promise.all([ctx.send(options), ctx.send(options)])
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 401])
  assert.equal(ctx.calls(), 1)
})

test('live key rotation, Node disable, and physical remap invalidate an existing session', async (t) => {
  const ctx = harness(); t.after(() => ctx.close())
  ctx.setNode({
    ...ctx.registeredNode(),
    keyVersion: 5,
  })
  assert.equal((await ctx.send()).status, 401)
  ctx.setNode({ nodeId: NODE_ID, keyVersion: 4, publicKey: '', ingestAuthMode: 'ed25519_required', active: false })
  assert.equal((await ctx.send({ sequence: '2', nonce: token(16, 33) })).status, 401)
  ctx.resetNode()
  ctx.setPhysical({ physicalCameraId: 42, nodeId: NODE_ID, active: true })
  assert.equal((await ctx.send({ sequence: '3', nonce: token(16, 34) })).status, 401)

  ctx.setNode({ ...ctx.registeredNode(), nodeId: 'edge-b' })
  ctx.setPhysical({ physicalCameraId: 41, nodeId: 'edge-b', active: true })
  assert.equal((await ctx.send({ sequence: '4', nonce: token(16, 35) })).status, 401)
  assert.equal(ctx.calls(), 0)
})
