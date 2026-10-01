import assert from 'node:assert/strict'
import test from 'node:test'

import { maintainLocalNodeAssociation } from '../src/lib/localNode.js'

const operator = Object.freeze({ username: 'operator', role: 'CCTV-Operator' })

function timerHarness() {
  let nextId = 0
  const timers = []
  return {
    timers,
    setTimeoutFn(callback, delay) {
      const entry = { id: ++nextId, callback, delay, cleared: false }
      timers.push(entry)
      return entry.id
    },
    clearTimeoutFn(id) {
      const entry = timers.find((item) => item.id === id)
      if (entry) entry.cleared = true
    },
    active(delay) { return timers.filter((entry) => !entry.cleared && entry.delay === delay) },
  }
}

function successFixture(overrides = {}) {
  let now = 1_000
  const timers = timerHarness()
  const calls = []
  const challenge = {
    version: 1,
    purpose: 'AEGIS-BROWSER-NODE-ASSOCIATION-V1',
    audience: 'https://monitor.test.invalid',
    challenge_id: Buffer.alloc(32, 1).toString('base64url'),
    challenge_nonce: Buffer.alloc(32, 2).toString('base64url'),
    session_binding: Buffer.alloc(32, 3).toString('base64url'),
    issued_at_ms: now,
    expires_at_ms: now + 30_000,
  }
  const assertion = { claims: { ...challenge, node_id: 'machine-a-node', key_version: 4 }, signature: Buffer.alloc(64, 4).toString('base64url') }
  const apiFetch = async (path, options) => {
    calls.push({ kind: 'monitor', path, options })
    if (path === '/api/local-node/challenge') return { ok: true, status: 200, data: challenge }
    if (path === '/api/local-node/verify') {
      return { ok: true, status: 200, data: { associated: true, expiresAt: now + 300_000, renewAfterMs: 240_000 } }
    }
    throw new Error(`unexpected Monitor path: ${path}`)
  }
  const loopbackFetch = async (url, options) => {
    calls.push({ kind: 'loopback', url, options })
    return { ok: true, json: async () => assertion }
  }
  return {
    calls,
    timers,
    challenge,
    assertion,
    options: {
      session: operator,
      apiFetch,
      loopbackFetch,
      now: () => now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      ...overrides,
    },
    setNow(value) { now = value },
  }
}

test('Operator association starts immediately, uses public loopback data without credentials, and schedules renewal', async () => {
  const ctx = successFixture()
  const controller = maintainLocalNodeAssociation(ctx.options)
  assert.equal(await controller.associateNow(), 'associated')
  assert.deepEqual(ctx.calls.map((call) => call.path ?? call.url), [
    '/api/local-node/challenge',
    'http://127.0.0.1:8078/v1/browser-association/assert',
    '/api/local-node/verify',
  ])
  const loopback = ctx.calls.find((call) => call.kind === 'loopback')
  assert.equal(loopback.options.credentials, 'omit')
  assert.equal(loopback.options.redirect, 'error')
  assert.deepEqual(JSON.parse(loopback.options.body), ctx.challenge)
  assert.equal(ctx.calls.every((call) => !String(call.path ?? call.url).includes('/stream')), true)
  assert.equal(ctx.timers.active(240_000).length, 1)
  controller.stop()
})

test('SOC is ineligible and creates no local association or camera request', async () => {
  const ctx = successFixture({ session: { username: 'soc', role: 'SOC-Responder' }, autoStart: false })
  const controller = maintainLocalNodeAssociation(ctx.options)
  assert.equal(await controller.associateNow(), 'ineligible')
  assert.deepEqual(ctx.calls, [])
  controller.stop()
})

test('Agent and proof failures retain login state and retry in five seconds without extending authority', async () => {
  const ctx = successFixture({ autoStart: false })
  let first = true
  ctx.options.loopbackFetch = async (url, options) => {
    ctx.calls.push({ kind: 'loopback', url, options })
    if (first) {
      first = false
      return { ok: true, json: async () => ctx.assertion }
    }
    throw new Error('Agent unavailable')
  }
  const controller = maintainLocalNodeAssociation(ctx.options)
  assert.equal(await controller.associateNow(), 'associated')
  ctx.setNow(241_000)
  assert.equal(await controller.associateNow(), 'retry')
  assert.equal(ctx.timers.active(5_000).length, 1)
  assert.equal(ctx.calls.filter((call) => call.path === '/api/local-node/verify').length, 1)
  controller.stop()
})

test('one association attempt has a ten-second total deadline and stop clears all work', async () => {
  const ctx = successFixture({ autoStart: false })
  ctx.options.loopbackFetch = async (_url, options) => new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  const controller = maintainLocalNodeAssociation(ctx.options)
  const pending = controller.associateNow()
  const deadline = ctx.timers.active(10_000)[0]
  assert.ok(deadline)
  deadline.callback()
  assert.equal(await pending, 'retry')
  assert.equal(ctx.timers.active(5_000).length, 1)
  controller.stop()
  assert.equal(ctx.timers.timers.every((entry) => entry.cleared), true)
})

test('invalid Monitor verification cannot invoke the global unauthorized handler contract', async () => {
  const ctx = successFixture({ autoStart: false })
  ctx.options.apiFetch = async (path, options) => {
    ctx.calls.push({ kind: 'monitor', path, options })
    if (path.endsWith('/challenge')) return { ok: true, status: 200, data: ctx.challenge }
    return { ok: false, status: 401, data: { error: 'LOCAL_NODE_PROOF_INVALID' } }
  }
  const controller = maintainLocalNodeAssociation(ctx.options)
  assert.equal(await controller.associateNow(), 'retry')
  const monitorCalls = ctx.calls.filter((call) => call.kind === 'monitor')
  assert.equal(monitorCalls.find((call) => call.path.endsWith('/verify')).options.suppressAuthHandler, true)
  assert.equal(ctx.timers.active(5_000).length, 1)
  controller.stop()
})

test('renewal uses the server-provided relative delay and is independent of browser clock skew', async () => {
  const ctx = successFixture({ autoStart: false, now: () => 9_000_000_000_000 })
  const controller = maintainLocalNodeAssociation(ctx.options)
  assert.equal(await controller.associateNow(), 'associated')
  assert.equal(ctx.timers.active(240_000).length, 1)
  controller.stop()
})

test('Agent response is stopped at the byte cap before the complete body is buffered', async () => {
  const ctx = successFixture({ autoStart: false })
  let reads = 0
  let cancels = 0
  ctx.options.loopbackFetch = async () => ({
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        async read() {
          reads += 1
          return reads <= 2
            ? { done: false, value: new Uint8Array(9 * 1024) }
            : { done: true, value: undefined }
        },
        async cancel() { cancels += 1 },
      }),
    },
    async text() { throw new Error('streaming reader was not used') },
  })
  const controller = maintainLocalNodeAssociation(ctx.options)
  assert.equal(await controller.associateNow(), 'retry')
  assert.equal(reads, 2)
  assert.equal(cancels, 1)
  assert.equal(ctx.calls.some((call) => call.path === '/api/local-node/verify'), false)
  controller.stop()
})

test('oversized declared Agent response is rejected before reading its body', async () => {
  const ctx = successFixture({ autoStart: false })
  let reads = 0
  let textCalls = 0
  ctx.options.loopbackFetch = async () => ({
    ok: true,
    headers: { get: (name) => name.toLowerCase() === 'content-length' ? String(16 * 1024 + 1) : null },
    body: { getReader: () => ({ async read() { reads += 1; return { done: true } } }) },
    async text() { textCalls += 1; return 'x'.repeat(16 * 1024 + 1) },
  })
  const controller = maintainLocalNodeAssociation(ctx.options)
  assert.equal(await controller.associateNow(), 'retry')
  assert.equal(reads, 0)
  assert.equal(textCalls, 0)
  controller.stop()
})

test('invalid UTF-8 cancels the Agent response stream before retrying', async () => {
  const ctx = successFixture({ autoStart: false })
  let reads = 0
  let cancels = 0
  ctx.options.loopbackFetch = async () => ({
    ok: true,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        async read() {
          reads += 1
          return reads === 1
            ? { done: false, value: new Uint8Array([0xc3, 0x28]) }
            : { done: true, value: undefined }
        },
        async cancel() { cancels += 1 },
      }),
    },
  })
  const controller = maintainLocalNodeAssociation(ctx.options)
  assert.equal(await controller.associateNow(), 'retry')
  assert.equal(cancels, 1)
  controller.stop()
})
