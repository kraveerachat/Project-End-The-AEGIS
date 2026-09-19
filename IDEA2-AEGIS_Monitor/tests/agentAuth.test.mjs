import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { canonicalAuthPayload } from '../server/nodeIdentity/agentProtocol.js'
import { ChallengeStore } from '../server/nodeIdentity/challengeStore.js'
import { AgentSessionStore } from '../server/nodeIdentity/agentSessionStore.js'
import { createAgentAuthRouter } from '../server/routes/agentAuth.js'

const AUDIENCE = 'urn:aegis:monitor:idea2:test'
const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const node = {
    nodeId: 'edge-a',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    keyVersion: 3,
    ingestAuthMode: 'legacy_shared_key',
    active: true,
    ...overrides.node,
  }
  const physical = { physicalCameraId: 41, nodeId: node.nodeId, active: true, ...overrides.physical }
  let now = 10_000
  const challenges = new ChallengeStore({ now: () => now })
  const sessions = new AgentSessionStore({ now: () => now })
  const adapters = {
    getDetectionNode: async (nodeId) => nodeId === node.nodeId ? node : null,
    getPhysicalCameraForNode: async (nodeId) => nodeId === physical.nodeId ? physical : null,
    ...overrides.adapters,
  }
  const app = express()
  app.disable('x-powered-by')
  app.use('/internal/agent-auth', createAgentAuthRouter({
    audience: AUDIENCE,
    challengeStore: challenges,
    sessionStore: sessions,
    ...adapters,
  }))
  const server = app.listen(0, '127.0.0.1')
  return {
    node,
    physical,
    privateKey,
    challenges,
    sessions,
    setNow(value) { now = value },
    async request(path, body) {
      await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve))
      const { port } = server.address()
      const response = await fetch(`http://127.0.0.1:${port}/internal/agent-auth${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return { status: response.status, body: await response.json() }
    },
    close() { return new Promise((resolve) => server.close(resolve)) },
  }
}

async function issue(ctx, nodeId = ctx.node.nodeId) {
  const result = await ctx.request('/challenge', { nodeId })
  assert.equal(result.status, 200)
  return result.body
}

function proof(ctx, challenge, privateKey = ctx.privateKey) {
  return {
    challengeId: challenge.challengeId,
    signature: sign(null, canonicalAuthPayload(challenge), privateKey).toString('base64url'),
  }
}

test('valid Agent proof creates one opaque session bound to live physical authority', async (t) => {
  const ctx = fixture()
  t.after(() => ctx.close())
  const challenge = await issue(ctx)
  assert.deepEqual(Object.keys(challenge), [
    'challengeId', 'nonce', 'issuedAtMs', 'expiresAtMs',
    'audience', 'purpose', 'nodeId', 'keyVersion',
  ])
  const verified = await ctx.request('/verify', proof(ctx, challenge))
  assert.equal(verified.status, 200)
  assert.match(verified.body.sessionId, /^[A-Za-z0-9][A-Za-z0-9_-]{42}$/)
  assert.deepEqual(ctx.sessions.lookup(verified.body.sessionId), {
    nodeId: 'edge-a',
    keyVersion: 3,
    physicalCameraId: 41,
    issuedAtMs: 10_000,
    expiresAtMs: 610_000,
    replay: ctx.sessions.lookup(verified.body.sessionId).replay,
  })
})

test('wrong proof is generic and does not consume the one-use challenge', async (t) => {
  const ctx = fixture()
  t.after(() => ctx.close())
  const challenge = await issue(ctx)
  const wrongKey = generateKeyPairSync('ed25519').privateKey
  const rejected = await ctx.request('/verify', proof(ctx, challenge, wrongKey))
  assert.deepEqual(rejected, { status: 401, body: { error: 'AUTHENTICATION_FAILED' } })
  const accepted = await ctx.request('/verify', proof(ctx, challenge))
  assert.equal(accepted.status, 200)
})

test('two concurrent valid proofs have exactly one winner', async (t) => {
  const ctx = fixture()
  t.after(() => ctx.close())
  const challenge = await issue(ctx)
  const signed = proof(ctx, challenge)
  const results = await Promise.all([
    ctx.request('/verify', signed),
    ctx.request('/verify', signed),
  ])
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 401])
})

test('live node, key version, and physical registration are revalidated before session creation', async (t) => {
  let liveNode
  let livePhysical
  const ctx = fixture({
    adapters: {
      getDetectionNode: async () => liveNode,
      getPhysicalCameraForNode: async () => livePhysical,
    },
  })
  t.after(() => ctx.close())
  liveNode = ctx.node
  livePhysical = ctx.physical
  const challenge = await issue(ctx)

  liveNode = { ...ctx.node, keyVersion: 4 }
  assert.deepEqual(await ctx.request('/verify', proof(ctx, challenge)), {
    status: 401,
    body: { error: 'AUTHENTICATION_FAILED' },
  })
  liveNode = ctx.node
  livePhysical = { ...ctx.physical, nodeId: 'edge-b' }
  assert.deepEqual(await ctx.request('/verify', proof(ctx, challenge)), {
    status: 401,
    body: { error: 'AUTHENTICATION_FAILED' },
  })
})

test('unknown, inactive, malformed, expired, and reused challenges fail closed', async (t) => {
  const ctx = fixture()
  t.after(() => ctx.close())
  assert.deepEqual(await ctx.request('/challenge', {}), {
    status: 400,
    body: { error: 'INVALID_REQUEST' },
  })
  assert.deepEqual(await ctx.request('/challenge', { nodeId: 'unknown' }), {
    status: 401,
    body: { error: 'AUTHENTICATION_FAILED' },
  })
  const challenge = await issue(ctx)
  ctx.setNow(challenge.expiresAtMs)
  assert.deepEqual(await ctx.request('/verify', proof(ctx, challenge)), {
    status: 401,
    body: { error: 'AUTHENTICATION_FAILED' },
  })
})

test('registry failures and bounded state exhaustion use a non-secret availability error', async (t) => {
  const ctx = fixture({ adapters: { getDetectionNode: async () => { throw new Error('database secret') } } })
  t.after(() => ctx.close())
  assert.deepEqual(await ctx.request('/challenge', { nodeId: 'edge-a' }), {
    status: 503,
    body: { error: 'IDENTITY_SERVICE_UNAVAILABLE' },
  })
})

test('inactive Node and inactive or mismatched physical camera share the generic failure shape', async (t) => {
  for (const overrides of [
    { node: { active: false } },
    { physical: { active: false } },
    { physical: { nodeId: 'edge-other' } },
  ]) {
    const ctx = fixture(overrides)
    t.after(() => ctx.close())
    assert.deepEqual(await ctx.request('/challenge', { nodeId: 'edge-a' }), {
      status: 401,
      body: { error: 'AUTHENTICATION_FAILED' },
    })
  }
})

test('Agent authentication is mounted separately from sessions and the legacy shared-key gate', () => {
  const source = fs.readFileSync(path.join(monitorRoot, 'server/index.js'), 'utf8')
  const agentMount = source.indexOf("app.use('/internal/agent-auth', agentAuthRouter)")
  const jsonMount = source.indexOf('app.use(express.json({')
  const ingestMount = source.indexOf("app.use('/internal', authenticateDetectionIngest, internalRouter)")
  assert.ok(agentMount > 0)
  assert.ok(agentMount < jsonMount)
  assert.ok(agentMount < ingestMount)
})
