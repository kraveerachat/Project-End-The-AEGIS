import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import express from 'express'
import test from 'node:test'

import {
  bindLocalNode,
  clearLocalNode,
  currentLocalNode,
  currentNodeSessionBinding,
  destroySession,
  establishSession,
  sessionMiddleware,
} from '../server/auth/session.js'
import { csrfProtection } from '../server/middleware/csrf.js'
import { errorHandler } from '../server/middleware/errorHandler.js'
import { BrowserAssociationChallengeStore } from '../server/nodeIdentity/browserAssociationChallenges.js'
import { canonicalBrowserAssociationPayload } from '../server/nodeIdentity/browserAssociationProof.js'
import {
  createBrowserAssociationService,
  createLocalNodeAssociationRouter,
} from '../server/routes/api.js'

const AUDIENCE = 'https://monitor.test.invalid'

function fakeSession(initial = {}) {
  const session = {
    ...initial,
    cookie: { maxAge: 0 },
    regenerate(callback) {
      for (const key of Object.keys(this)) {
        if (!['cookie', 'regenerate', 'save', 'destroy'].includes(key)) delete this[key]
      }
      callback()
    },
    save(callback) { callback() },
    destroy(callback) {
      for (const key of Object.keys(this)) {
        if (!['cookie', 'regenerate', 'save', 'destroy'].includes(key)) delete this[key]
      }
      callback()
    },
  }
  return session
}

const operator = Object.freeze({
  id: 2,
  username: 'operator',
  displayName: 'Test Operator',
  role: 'CCTV-Operator',
  active: true,
  mustResetPassword: false,
})

function signedAssertion(challenge, node, privateKey) {
  const claims = {
    ...challenge,
    node_id: node.nodeId,
    key_version: node.keyVersion,
  }
  return {
    claims,
    signature: sign(null, canonicalBrowserAssociationPayload(claims), privateKey).toString('base64url'),
  }
}

function serviceFixture(overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  let now = 100_000
  const registryLookups = []
  const state = {
    user: { ...operator },
    node: {
      nodeId: 'machine-a-node',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
      keyVersion: 4,
      active: true,
    },
    physical: { physicalCameraId: 41, nodeId: 'machine-a-node', active: true },
    registryError: null,
  }
  Object.assign(state, overrides.state)
  const dependencies = {
    audience: AUDIENCE,
    now: () => now,
    challengeStore: new BrowserAssociationChallengeStore({ now: () => now }),
    getUserByUsername: async (username) => username === operator.username ? state.user : null,
    getDetectionNode: async (nodeId) => {
      registryLookups.push(['node', nodeId])
      if (state.registryError) throw state.registryError
      return nodeId === state.node?.nodeId ? state.node : null
    },
    getPhysicalCameraForNode: async (nodeId) => {
      registryLookups.push(['physical', nodeId])
      if (state.registryError) throw state.registryError
      return nodeId === state.physical?.nodeId ? state.physical : null
    },
    ...overrides.dependencies,
  }
  return {
    state,
    registryLookups,
    privateKey,
    dependencies,
    service: createBrowserAssociationService(dependencies),
    setNow(value) { now = value },
  }
}

async function httpFixture(t, overrides = {}) {
  process.env.SESSION_SECRET = 'task8-test-session-secret-with-at-least-32-bytes'
  process.env.COOKIE_SECURE = 'false'
  const ctx = serviceFixture(overrides)
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({
    limit: '16kb',
    verify(req, _res, bytes) { req.rawBody = Buffer.from(bytes) },
  }))
  app.use(sessionMiddleware())
  app.post('/test/login', async (req, res) => {
    await establishSession(req, operator, false)
    res.json({ csrfToken: req.session.csrfToken })
  })
  app.get('/test/session', (req, res) => {
    res.json({ localNode: currentLocalNode(req, ctx.dependencies.now()) })
  })
  app.post('/test/expire-session', (req, res) => {
    req.session.createdAt = 1
    res.json({ expired: true })
  })
  app.use('/api', csrfProtection, createLocalNodeAssociationRouter({ service: ctx.service }))
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  let cookie = ''
  let csrf = ''
  return {
    ...ctx,
    async request(path, { method = 'GET', body, rawBody, useCookie = true, useCsrf = true, headers = {} } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body === undefined && rawBody === undefined ? {} : { 'content-type': 'application/json' }),
          ...(useCookie && cookie ? { cookie } : {}),
          ...(useCsrf && csrf ? { 'x-csrf-token': csrf } : {}),
          ...headers,
        },
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';', 1)[0]
      let data = null
      try { data = await response.json() } catch { /* intentionally empty */ }
      return { status: response.status, body: data }
    },
    async login() {
      const result = await this.request('/test/login', { method: 'POST', body: {} })
      assert.equal(result.status, 200)
      csrf = result.body.csrfToken
      return result
    },
  }
}

test('each login regeneration creates a fresh canonical binding and clears prior local authority', async () => {
  const req = { session: fakeSession() }
  await establishSession(req, operator, false)
  const first = currentNodeSessionBinding(req)
  assert.match(first, /^[A-Za-z0-9][A-Za-z0-9_-]{42}$/)

  bindLocalNode(req, {
    nodeId: 'machine-a-node', physicalCameraId: 41, keyVersion: 4,
    verifiedAt: 1, expiresAt: 2,
  })
  await establishSession(req, operator, false)
  const second = currentNodeSessionBinding(req)
  assert.match(second, /^[A-Za-z0-9][A-Za-z0-9_-]{42}$/)
  assert.notEqual(second, first)
  assert.equal(currentLocalNode(req, 1), null)
})

test('local authority expires at the exact boundary and logout destroys all server authority', async () => {
  const req = { session: fakeSession() }
  const res = { clearCookie() {} }
  await establishSession(req, operator, false)
  bindLocalNode(req, {
    nodeId: 'machine-a-node', physicalCameraId: 41, keyVersion: 4,
    verifiedAt: 10_000, expiresAt: 20_000,
  })
  assert.equal(currentLocalNode(req, 19_999)?.physicalCameraId, 41)
  assert.equal(currentLocalNode(req, 20_000), null)
  clearLocalNode(req)
  await destroySession(req, res)
  assert.equal(currentNodeSessionBinding(req), null)
  assert.equal(currentLocalNode(req, 1), null)
})

test('association routes require authentication and CSRF and bind only registry-derived authority', async (t) => {
  const ctx = await httpFixture(t)
  assert.deepEqual(await ctx.request('/api/local-node/challenge', {
    method: 'POST', body: {}, useCookie: false, useCsrf: false,
  }), { status: 401, body: { error: 'NOT_AUTHENTICATED' } })

  await ctx.login()
  assert.deepEqual(await ctx.request('/api/local-node/challenge', {
    method: 'POST', body: {}, useCsrf: false,
  }), { status: 403, body: { error: 'Forbidden' } })

  const issued = await ctx.request('/api/local-node/challenge?nodeId=forged', {
    method: 'POST', body: { nodeId: 'forged', physicalCameraId: 999 },
    headers: { 'x-aegis-node-id': 'forged', 'x-forwarded-host': 'attacker.invalid' },
  })
  assert.equal(issued.status, 200)
  assert.deepEqual(Object.keys(issued.body), [
    'version', 'purpose', 'audience', 'challenge_id', 'challenge_nonce',
    'session_binding', 'issued_at_ms', 'expires_at_ms',
  ])

  const assertion = signedAssertion(issued.body, ctx.state.node, ctx.privateKey)
  const verified = await ctx.request('/api/local-node/verify?physicalCameraId=999', {
    method: 'POST',
    body: assertion,
    headers: { 'x-aegis-physical-camera-id': '999' },
  })
  assert.deepEqual(verified, {
    status: 200,
    body: { associated: true, expiresAt: 400_000, renewAfterMs: 240_000 },
  })
  assert.deepEqual((await ctx.request('/test/session')).body.localNode, {
    nodeId: 'machine-a-node',
    physicalCameraId: 41,
    keyVersion: 4,
    verifiedAt: 100_000,
    expiresAt: 400_000,
  })
})

test('non-canonical claims and duplicate JSON keys fail before registry lookup', async (t) => {
  const ctx = await httpFixture(t)
  await ctx.login()

  const malformedChallenge = (await ctx.request('/api/local-node/challenge', { method: 'POST', body: {} })).body
  const malformedClaims = {
    ...malformedChallenge,
    node_id: '../browser-selected-node',
    key_version: 4,
  }
  const malformedAssertion = {
    claims: malformedClaims,
    signature: sign(null, canonicalBrowserAssociationPayload(malformedClaims), ctx.privateKey).toString('base64url'),
  }
  assert.deepEqual(await ctx.request('/api/local-node/verify', {
    method: 'POST', body: malformedAssertion,
  }), { status: 401, body: { error: 'LOCAL_NODE_PROOF_INVALID' } })
  assert.deepEqual(ctx.registryLookups, [])

  const duplicateChallenge = (await ctx.request('/api/local-node/challenge', { method: 'POST', body: {} })).body
  const valid = signedAssertion(duplicateChallenge, ctx.state.node, ctx.privateKey)
  const duplicateRawBody = `{"claims":${JSON.stringify(valid.claims)},"signature":"invalid","signature":${JSON.stringify(valid.signature)}}`
  assert.deepEqual(await ctx.request('/api/local-node/verify', {
    method: 'POST', rawBody: duplicateRawBody,
  }), { status: 401, body: { error: 'LOCAL_NODE_PROOF_INVALID' } })
  assert.deepEqual(ctx.registryLookups, [])
})

test('malformed and oversized verify JSON use the bounded proof error contract', async (t) => {
  const ctx = await httpFixture(t)
  await ctx.login()
  assert.deepEqual(await ctx.request('/api/local-node/verify', {
    method: 'POST', rawBody: '{"claims":',
  }), { status: 401, body: { error: 'LOCAL_NODE_PROOF_INVALID' } })
  assert.deepEqual(await ctx.request('/api/local-node/verify', {
    method: 'POST', rawBody: `{"padding":"${'a'.repeat(16 * 1024)}"}`,
  }), { status: 401, body: { error: 'LOCAL_NODE_PROOF_INVALID' } })
  assert.deepEqual(ctx.registryLookups, [])
})

test('challenge issuance is rate-limited per login session before global replay state can be exhausted', async (t) => {
  const ctx = await httpFixture(t)
  await ctx.login()
  for (let attempt = 0; attempt < 12; attempt += 1) {
    assert.equal((await ctx.request('/api/local-node/challenge', { method: 'POST', body: {} })).status, 200)
  }
  assert.deepEqual(await ctx.request('/api/local-node/challenge', { method: 'POST', body: {} }), {
    status: 429,
    body: { error: 'LOCAL_NODE_ASSOCIATION_RATE_LIMITED' },
  })
})

test('fresh login bindings cannot bypass the global challenge issuance ceiling', async () => {
  const ctx = serviceFixture({ dependencies: { globalIssueLimit: 3 } })
  const sessions = Array.from({ length: 4 }, (_, index) => fakeSession({
    user: { ...operator },
    nodeSessionBinding: Buffer.alloc(32, index + 10).toString('base64url'),
  }))
  for (const session of sessions.slice(0, 3)) {
    assert.equal((await ctx.service.issue(session)).purpose, 'AEGIS-BROWSER-NODE-ASSOCIATION-V1')
  }
  await assert.rejects(
    ctx.service.issue(sessions[3]),
    (error) => error?.status === 429 && error?.code === 'LOCAL_NODE_ASSOCIATION_RATE_LIMITED',
  )
})

test('expired sessions receive the authentication contract before CSRF, including a trailing slash', async (t) => {
  const ctx = await httpFixture(t)
  await ctx.login()
  assert.equal((await ctx.request('/test/expire-session', { method: 'POST', body: {} })).status, 200)
  assert.deepEqual(await ctx.request('/api/local-node/challenge/', {
    method: 'POST', body: {}, useCsrf: false,
  }), { status: 401, body: { error: 'NOT_AUTHENTICATED' } })
})

test('expired, malformed, and replayed proofs fail closed and a failed proof is consumed', async (t) => {
  const ctx = await httpFixture(t)
  await ctx.login()
  const issued = (await ctx.request('/api/local-node/challenge', { method: 'POST', body: {} })).body
  const valid = signedAssertion(issued, ctx.state.node, ctx.privateKey)
  const malformed = { ...valid, signature: Buffer.alloc(64, 1).toString('base64url') }
  assert.deepEqual(await ctx.request('/api/local-node/verify', { method: 'POST', body: malformed }), {
    status: 401, body: { error: 'LOCAL_NODE_PROOF_INVALID' },
  })
  assert.deepEqual(await ctx.request('/api/local-node/verify', { method: 'POST', body: valid }), {
    status: 401, body: { error: 'LOCAL_NODE_PROOF_INVALID' },
  })

  const expiring = (await ctx.request('/api/local-node/challenge', { method: 'POST', body: {} })).body
  ctx.setNow(expiring.expires_at_ms)
  assert.deepEqual(await ctx.request('/api/local-node/verify', {
    method: 'POST', body: signedAssertion(expiring, ctx.state.node, ctx.privateKey),
  }), { status: 401, body: { error: 'LOCAL_NODE_PROOF_INVALID' } })
})

test('live account, node, key, and physical registration changes deny association', async (t) => {
  const mutations = [
    ['disabled account', (ctx) => { ctx.state.user = null }],
    ['changed role', (ctx) => { ctx.state.user = { ...operator, role: 'SOC-Responder' } }],
    ['disabled node', (ctx) => { ctx.state.node = { ...ctx.state.node, active: false } }],
    ['rotated key', (ctx) => { ctx.state.node = { ...ctx.state.node, keyVersion: 5 } }],
    ['disabled physical camera', (ctx) => { ctx.state.physical = { ...ctx.state.physical, active: false } }],
    ['remapped physical camera', (ctx) => { ctx.state.physical = { ...ctx.state.physical, nodeId: 'machine-b-node' } }],
  ]
  for (const [name, mutate] of mutations) {
    await t.test(name, async (st) => {
      const ctx = await httpFixture(st)
      await ctx.login()
      const issued = (await ctx.request('/api/local-node/challenge', { method: 'POST', body: {} })).body
      mutate(ctx)
      assert.deepEqual(await ctx.request('/api/local-node/verify', {
        method: 'POST', body: signedAssertion(issued, { nodeId: 'machine-a-node', keyVersion: 4 }, ctx.privateKey),
      }), { status: 403, body: { error: 'LOCAL_NODE_ASSOCIATION_DENIED' } })
      assert.equal((await ctx.request('/test/session')).body.localNode, null)
    })
  }
})

test('registry uncertainty is unavailable without leaking details, and consumes the challenge', async (t) => {
  const ctx = await httpFixture(t)
  await ctx.login()
  const issued = (await ctx.request('/api/local-node/challenge', { method: 'POST', body: {} })).body
  const assertion = signedAssertion(issued, ctx.state.node, ctx.privateKey)
  ctx.state.registryError = new Error('database secret must not escape')
  assert.deepEqual(await ctx.request('/api/local-node/verify', { method: 'POST', body: assertion }), {
    status: 503, body: { error: 'LOCAL_NODE_REGISTRY_UNAVAILABLE' },
  })
  ctx.state.registryError = null
  assert.deepEqual(await ctx.request('/api/local-node/verify', { method: 'POST', body: assertion }), {
    status: 401, body: { error: 'LOCAL_NODE_PROOF_INVALID' },
  })
})

test('a Monitor restart loses outstanding challenges even when the login session object survives', async () => {
  const first = serviceFixture()
  const session = fakeSession({
    user: { ...operator },
    nodeSessionBinding: Buffer.alloc(32, 8).toString('base64url'),
  })
  const challenge = await first.service.issue(session)
  const assertion = signedAssertion(challenge, first.state.node, first.privateKey)
  const restarted = createBrowserAssociationService({
    ...first.dependencies,
    challengeStore: new BrowserAssociationChallengeStore({ now: first.dependencies.now }),
  })
  await assert.rejects(
    restarted.verify(session, assertion),
    (error) => error?.code === 'LOCAL_NODE_PROOF_INVALID',
  )
})
