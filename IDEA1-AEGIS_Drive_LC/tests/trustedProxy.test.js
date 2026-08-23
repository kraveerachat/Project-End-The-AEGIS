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
        NODE_ENV: 'test',
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
