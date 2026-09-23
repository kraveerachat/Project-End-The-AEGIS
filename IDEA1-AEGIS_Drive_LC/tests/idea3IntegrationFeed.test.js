// tests/idea3IntegrationFeed.test.js — AEGIS Drive (IDEA1)
// GET /api/integration/events is the bounded, read-only, privacy-safe feed
// IDEA3 (AEGIS Lockdown) consumes for cross-IDEA visibility (PR11 combined
// visibility PR). This suite pins the exact contract IDEA3's adapter expects
// and the exact things this endpoint must never leak or allow.
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.NODE_ENV = 'test'
process.env.SESSION_SECRET = 'idea3-feed-test-session-secret-not-used-in-production'
process.env.COOKIE_SECURE = 'false'

const { createApp } = await import('../server/app.js')
const { recordAudit } = await import('../server/db/connection.js')

const TOKEN = 'idea1-integration-test-token'

let server
let baseUrl

before(async () => {
  process.env.AEGIS_IDEA1_INTEGRATION_TOKEN = TOKEN
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  delete process.env.AEGIS_IDEA1_INTEGRATION_TOKEN
  await new Promise((resolve) => server.close(resolve))
})

async function seedDeniedEvent(overrides = {}) {
  await recordAudit({
    action: 'LOGIN',
    result: 'DENIED',
    actorLabel: 'someone@example.com', // must never reach the feed
    role: 'User',
    sourceIp: '203.0.113.9',
    ...overrides,
  })
}

test('IDEA3-FEED-1 no credential configured server-side fails secure (503), not open', async () => {
  delete process.env.AEGIS_IDEA1_INTEGRATION_TOKEN
  try {
    const res = await fetch(`${baseUrl}/api/integration/events`, {
      headers: { authorization: 'Bearer anything' },
    })
    assert.equal(res.status, 503)
  } finally {
    process.env.AEGIS_IDEA1_INTEGRATION_TOKEN = TOKEN
  }
})

test('IDEA3-FEED-2 missing/incorrect key is rejected with a generic 401', async () => {
  const missing = await fetch(`${baseUrl}/api/integration/events`)
  assert.equal(missing.status, 401)

  const wrong = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: 'Bearer not-the-token' },
  })
  assert.equal(wrong.status, 401)
})

test('IDEA3-FEED-2b the IDEA2 credential must not authenticate to IDEA1 (independent per-source tokens)', async () => {
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: 'Bearer idea2-integration-test-token' },
  })
  assert.equal(res.status, 401)
})

test('IDEA3-FEED-3 no browser-session credential path: cookies alone never authenticate this route', async () => {
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { cookie: 'aegis_session=whatever-a-real-admin-cookie-would-look-like' },
  })
  assert.equal(res.status, 401)
})

test('IDEA3-FEED-4 GET-only: POST to the same path is never treated as a mutation endpoint', async () => {
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.notEqual(res.status, 200)
})

test('IDEA3-FEED-5 authenticated GET returns the versioned bounded envelope', async () => {
  await seedDeniedEvent()
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.schema_version, 1)
  assert.match(body.generated_at, /^\d{4}-\d\d-\d\dT/)
  assert.ok(Array.isArray(body.events))
  assert.ok(body.events.length >= 1)

  const event = body.events.find((e) => e.event_id != null)
  assert.equal(event.source, 'IDEA1')
  assert.equal(event.event_type, 'ACCESS_DENIED')
  assert.equal(event.severity, 'WARNING')
  assert.equal(event.resource, 'AEGIS Drive')
  assert.match(event.occurred_at, /^\d{4}-\d\d-\d\dT/)
  assert.deepEqual(event.evidence, { result: 'DENIED' })
})

test('IDEA3-FEED-11 envelope reports Drive daemon/db health honestly, reusing the same signal /healthz uses', async () => {
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = await res.json()
  assert.equal(typeof body.status.ok, 'boolean')
  assert.deepEqual(Object.keys(body.status).sort(), ['detail', 'ok'])
  assert.deepEqual(Object.keys(body.status.detail).sort(), ['db'])
  assert.equal(typeof body.status.detail.db, 'string')
})

test('IDEA3-FEED-6 BLOCKED results are surfaced as HIGH severity', async () => {
  await seedDeniedEvent({ action: 'SHARE_ACCESS', result: 'BLOCKED' })
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = await res.json()
  assert.ok(body.events.some((e) => e.severity === 'HIGH'))
})

test('IDEA3-FEED-7 successful (OK) actions are not security events and are never emitted', async () => {
  await recordAudit({ action: 'LOGIN', result: 'OK', actorLabel: 'ok-user', sourceIp: '203.0.113.5' })
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const body = await res.json()
  // Every emitted event must originate from a non-OK row; this does not assert
  // total count (other tests seed rows too) — only the exclusion contract.
  assert.ok(body.events.every((e) => e.evidence.result !== 'OK'))
})

test('IDEA3-FEED-8 response never leaks actor identity, role, or raw target — only bounded, privacy-safe fields', async () => {
  await seedDeniedEvent({ actorLabel: 'must-not-leak@example.com', role: 'Admin', targetHash: 'a'.repeat(64) })
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const raw = await res.text()
  assert.doesNotMatch(raw, /must-not-leak@example\.com/)
  assert.doesNotMatch(raw, /"role"/)
  assert.doesNotMatch(raw, /"actor/)
  assert.doesNotMatch(raw, /"target_hash"/)
  const body = JSON.parse(raw)
  for (const event of body.events) {
    assert.deepEqual(Object.keys(event).sort(), [
      'correlation_key', 'event_id', 'event_type', 'evidence', 'occurred_at', 'resource', 'severity', 'source',
    ])
  }
})

test('IDEA3-FEED-9 event_id is a stable source-owned identifier across repeated reads', async () => {
  await seedDeniedEvent({ action: 'STABLE_ID_CHECK' })
  const first = await (await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json()
  const second = await (await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json()
  assert.deepEqual(first.events.map((e) => e.event_id), second.events.map((e) => e.event_id))
})

test('IDEA3-FEED-10 no mutation side effect: repeated reads never change stored audit state', async () => {
  const before1 = await (await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json()
  const before2 = await (await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })).json()
  assert.equal(before1.events.length, before2.events.length)
})
