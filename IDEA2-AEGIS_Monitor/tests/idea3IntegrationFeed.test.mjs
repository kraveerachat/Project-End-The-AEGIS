// tests/idea3IntegrationFeed.test.mjs — AEGIS Monitor (IDEA2)
// GET /api/integration/events is the bounded, read-only, privacy-safe feed
// IDEA3 (AEGIS Lockdown) consumes for cross-IDEA visibility (PR11 combined
// visibility PR). This suite exercises the router/middleware directly (not the
// full server/index.js, which binds a real port and serves a built dist/ on
// import) — the same narrow-scope approach as the Detection Engine ingest key.
//
// No AEGIS_MONITOR_TEST_DATABASE_URL is available in this environment, so the
// dev-fallback path (usingPostgres === false) is what these tests can honestly
// exercise: readIntegrationSecurityEvents() returns [] without a real Postgres
// (see server/db/store.js), so the envelope here is EMPTY_BUT_VALID — real,
// authenticated, schema-valid, zero events. This is NOT live evidence; it only
// pins the contract shape and the auth/GET-only/privacy boundary.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

process.env.NODE_ENV = 'test'

const { integrationRouter } = await import('../server/routes/integration.js')
const { errorHandler } = await import('../server/middleware/errorHandler.js')

const TOKEN = 'idea2-integration-test-token'

let server
let baseUrl

before(async () => {
  process.env.AEGIS_IDEA2_INTEGRATION_TOKEN = TOKEN
  const app = express()
  app.use(integrationRouter)
  app.use(errorHandler)
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  delete process.env.AEGIS_IDEA2_INTEGRATION_TOKEN
  await new Promise((resolve) => server.close(resolve))
})

test('IDEA3-FEED-1 no credential configured server-side fails secure (503), not open', async () => {
  delete process.env.AEGIS_IDEA2_INTEGRATION_TOKEN
  try {
    const res = await fetch(`${baseUrl}/api/integration/events`, {
      headers: { authorization: 'Bearer anything' },
    })
    assert.equal(res.status, 503)
  } finally {
    process.env.AEGIS_IDEA2_INTEGRATION_TOKEN = TOKEN
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

test('IDEA3-FEED-2b the IDEA1 credential must not authenticate to IDEA2 (independent per-source tokens)', async () => {
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: 'Bearer idea1-integration-test-token' },
  })
  assert.equal(res.status, 401)
})

test('IDEA3-FEED-3 no browser-session credential path: cookies alone never authenticate this route', async () => {
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { cookie: 'aegis_monitor_session=whatever-a-real-soc-cookie-would-look-like' },
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

test('IDEA3-FEED-5 authenticated GET returns the versioned bounded envelope (empty-but-valid without Postgres)', async () => {
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.schema_version, 1)
  assert.match(body.generated_at, /^\d{4}-\d\d-\d\dT/)
  assert.ok(Array.isArray(body.events))
  assert.equal(body.events.length, 0) // dev fallback: no Postgres in this environment
})

test('IDEA3-FEED-6 response schema never carries snapshot_path, matched_name, title, or Telegram routing', async () => {
  const res = await fetch(`${baseUrl}/api/integration/events`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const raw = await res.text()
  for (const forbidden of ['snapshot_path', 'snapshotPath', 'matched_name', 'matchedName', 'telegram', 'title']) {
    assert.doesNotMatch(raw, new RegExp(forbidden, 'i'))
  }
})
