// tests/trustedProxy.test.js — explicit Express reverse-proxy trust boundary
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.SESSION_SECRET = 'trusted-proxy-test-session-secret'
delete process.env.TRUSTED_PROXY_CIDRS

const { createApp } = await import('../server/app.js')
const { readAudit } = await import('../server/db/connection.js')

async function withServer(env, run) {
  const app = createApp({ env })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    await run({ app, baseUrl: `http://127.0.0.1:${server.address().port}` })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('B2-T1 untrusted direct request ignores forged X-Forwarded-For', async () => {
  await withServer({ NODE_ENV: 'test', SESSION_SECRET: 'test-secret' }, async ({ baseUrl }) => {
    const marker = `b2-t1-${Date.now()}`
    const res = await fetch(`${baseUrl}/s/${marker}`, {
      headers: { 'X-Forwarded-For': '198.51.100.77' },
    })
    assert.equal(res.status, 404)

    const event = (await readAudit(20)).find((row) => row.action === 'SHARE_REDEEM')
    assert.ok(event, 'request source must be recorded in audit')
    assert.match(event.sourceIp, /^(?:::ffff:)?127\.0\.0\.1$/)
    assert.notEqual(event.sourceIp, '198.51.100.77')
  })
})

test('B2-T2 explicitly trusted proxy accepts the sanitized forwarded address only', async () => {
  const env = {
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-secret',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
  }
  await withServer(env, async ({ app, baseUrl }) => {
    const trust = app.get('trust proxy fn')
    assert.equal(trust('127.0.0.1', 0), true, 'configured proxy socket must be trusted')
    assert.equal(trust('10.20.30.40', 0), false, 'an unrelated direct socket must not be trusted')

    const res = await fetch(`${baseUrl}/s/b2-t2-${Date.now()}`, {
      headers: { 'X-Forwarded-For': '203.0.113.42' },
    })
    assert.equal(res.status, 404)
    const event = (await readAudit(20)).find((row) => row.action === 'SHARE_REDEEM')
    assert.equal(event?.sourceIp, '203.0.113.42')
  })
})

test('B2-T3 malformed TRUSTED_PROXY_CIDRS fails application configuration', () => {
  assert.throws(
    () => createApp({
      env: {
        NODE_ENV: 'production',
        SESSION_SECRET: 'test-secret',
        TRUSTED_PROXY_CIDRS: '172.19.255.0/29,definitely-not-a-cidr',
      },
    }),
    /TRUSTED_PROXY_CIDRS/i,
  )
})

test('B2-T4 production without TRUSTED_PROXY_CIDRS fails closed', () => {
  assert.throws(
    () => createApp({ env: { NODE_ENV: 'production', SESSION_SECRET: 'test-secret' } }),
    /TRUSTED_PROXY_CIDRS.*required/i,
  )
})

test('B2 trust configuration rejects hop counts, aliases, and the old shared bridge', () => {
  for (const value of [
    '1',
    'loopback',
    'linklocal',
    'uniquelocal',
    '172.18.0.0/16',
    '172.18.0.1/32',
  ]) {
    assert.throws(
      () => createApp({
        env: {
          NODE_ENV: 'test',
          SESSION_SECRET: 'test-secret',
          TRUSTED_PROXY_CIDRS: value,
        },
      }),
      /TRUSTED_PROXY_CIDRS/i,
      value,
    )
  }
})

test('TP-A1 production accepts only the exact HUB proxy identity', () => {
  const app = createApp({
    env: {
      NODE_ENV: 'production',
      SESSION_SECRET: 'test-secret',
      TRUSTED_PROXY_CIDRS: '172.19.255.2/32',
    },
  })
  const trust = app.get('trust proxy fn')
  assert.equal(trust('172.19.255.2', 0), true)
  assert.equal(trust('172.19.255.1', 0), false)
  assert.equal(trust('172.19.255.3', 0), false)
})

test('TP-R1..R8 production rejects every proxy range except the exact HUB identity', () => {
  const rejected = [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '172.18.0.0/15',
    '172.19.255.0/24',
    '172.19.255.0/29',
    '172.18.0.1/32',
    '172.19.255.2/32,10.0.0.0/8',
  ]

  for (const value of rejected) {
    assert.throws(
      () => createApp({
        env: {
          NODE_ENV: 'production',
          SESSION_SECRET: 'test-secret',
          TRUSTED_PROXY_CIDRS: value,
        },
      }),
      /TRUSTED_PROXY_CIDRS/i,
      value,
    )
  }
})

// ── PUBLIC-SHARE-2 · the two approved production states (owner gate G2) ──────
//
// Production accepts exactly two trusted-proxy configurations and nothing else.
// Legacy mode remains the default so the configuration currently running in
// production still boots after this change; the gateway identity is optional
// until the rollout phase that deploys a gateway.
const HUB = '172.19.255.2/32'
const GATEWAY = '172.19.254.2/32'
const prodEnv = (extra) => ({ NODE_ENV: 'production', SESSION_SECRET: 'test-secret', ...extra })

test('TP-S1 legacy mode: HUB alone, no gateway configured, still boots', () => {
  const app = createApp({ env: prodEnv({ TRUSTED_PROXY_CIDRS: HUB }) })
  const trust = app.get('trust proxy fn')
  assert.equal(trust('172.19.255.2', 0), true)
  assert.equal(trust('172.19.254.2', 0), false, 'an unconfigured gateway must not be trusted')
  assert.equal(app.get('publicShareConfig').publicIngressConfigured, false)
})

test('TP-S2 gateway-enabled mode: HUB plus exactly one approved gateway', () => {
  for (const order of [`${HUB},${GATEWAY}`, `${GATEWAY},${HUB}`]) {
    const app = createApp({
      env: prodEnv({ TRUSTED_PROXY_CIDRS: order, PUBLIC_SHARE_GATEWAY_CIDR: GATEWAY }),
    })
    const trust = app.get('trust proxy fn')
    // A set of identities, not a forwarding chain — order must not change meaning.
    assert.equal(trust('172.19.255.2', 0), true, order)
    assert.equal(trust('172.19.254.2', 0), true, order)
    assert.equal(trust('172.19.254.3', 0), false, order)
    assert.equal(app.get('publicShareConfig').gatewayAddress, '172.19.254.2')
  }
})

test('TP-S3 production rejects every state that is neither approved shape', () => {
  const rejected = [
    // A named gateway that is not trusted: Express would stop at it when walking
    // X-Forwarded-For and req.ip would collapse to the gateway's own address.
    [{ TRUSTED_PROXY_CIDRS: HUB, PUBLIC_SHARE_GATEWAY_CIDR: GATEWAY }, /exactly/i],
    // The gateway without HUB — the private path would lose its edge.
    [{ TRUSTED_PROXY_CIDRS: GATEWAY, PUBLIC_SHARE_GATEWAY_CIDR: GATEWAY }, /exactly/i],
    // Trusting a second peer that is not the declared gateway.
    [{ TRUSTED_PROXY_CIDRS: `${HUB},172.19.254.9/32`, PUBLIC_SHARE_GATEWAY_CIDR: GATEWAY }, /exactly/i],
    // A third proxy.
    [{ TRUSTED_PROXY_CIDRS: `${HUB},${GATEWAY},172.19.254.9/32`, PUBLIC_SHARE_GATEWAY_CIDR: GATEWAY }, /exactly/i],
    // Reusing HUB's identity as the gateway makes provenance ambiguous.
    [{ TRUSTED_PROXY_CIDRS: HUB, PUBLIC_SHARE_GATEWAY_CIDR: HUB }, /reuse/i],
    // A repeated identity hides a typo behind an apparently correct count.
    [{ TRUSTED_PROXY_CIDRS: `${HUB},${HUB}`, PUBLIC_SHARE_GATEWAY_CIDR: GATEWAY }, /repeat/i],
    // A prefix is a range, and a range is not an identity.
    [{ TRUSTED_PROXY_CIDRS: `${HUB},172.19.254.0/24`, PUBLIC_SHARE_GATEWAY_CIDR: '172.19.254.0/24' }, /PUBLIC_SHARE_GATEWAY_CIDR/],
    [{ TRUSTED_PROXY_CIDRS: `${HUB},172.19.254.2/31`, PUBLIC_SHARE_GATEWAY_CIDR: '172.19.254.2/31' }, /PUBLIC_SHARE_GATEWAY_CIDR/],
    // The shared aegis_internal bridge carries PostgreSQL and Monitor.
    [{ TRUSTED_PROXY_CIDRS: `${HUB},172.18.0.1/32`, PUBLIC_SHARE_GATEWAY_CIDR: '172.18.0.1/32' }, /PUBLIC_SHARE_GATEWAY_CIDR|bridge/i],
    // Malformed.
    [{ TRUSTED_PROXY_CIDRS: HUB, PUBLIC_SHARE_GATEWAY_CIDR: 'not-a-cidr' }, /PUBLIC_SHARE_GATEWAY_CIDR/],
    [{ TRUSTED_PROXY_CIDRS: HUB, PUBLIC_SHARE_GATEWAY_CIDR: '172.19.254.2' }, /PUBLIC_SHARE_GATEWAY_CIDR/],
  ]
  for (const [extra, pattern] of rejected) {
    assert.throws(() => createApp({ env: prodEnv(extra) }), pattern, JSON.stringify(extra))
  }
})

test('TP-S4 a gateway named outside production must still be trusted', () => {
  assert.throws(
    () => createApp({
      env: {
        NODE_ENV: 'test',
        SESSION_SECRET: 'test-secret',
        TRUSTED_PROXY_CIDRS: '127.0.0.2/32',
        PUBLIC_SHARE_GATEWAY_CIDR: '127.0.0.3/32',
      },
    }),
    /must trust PUBLIC_SHARE_GATEWAY_CIDR/i,
  )
  assert.throws(
    () => createApp({
      env: { NODE_ENV: 'test', SESSION_SECRET: 'test-secret', PUBLIC_SHARE_GATEWAY_CIDR: '127.0.0.3/32' },
    }),
    /must trust PUBLIC_SHARE_GATEWAY_CIDR/i,
  )
})
