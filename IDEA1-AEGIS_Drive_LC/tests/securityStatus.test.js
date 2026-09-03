// IDEA3 status is Admin-only, read-only, fresh-only, and strictly sanitized.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, loginClient, DEMO_ADMIN, DEMO_USER } from './helpers/testClient.mjs'

const TEST_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-security-status-'))
const STATUS_PATH = path.join(TEST_ROOT, 'status.json')
process.env.STORAGE_ROOT = path.join(TEST_ROOT, 'storage')
process.env.SESSION_SECRET = 'test-only-session-signing-material'
process.env.AEGIS_IDEA3_STATUS_PATH = STATUS_PATH
process.env.AEGIS_IDEA3_STATUS_STALE_SEC = '30'
delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')

let server
let baseUrl

before(async () => {
  await initStorage()
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(TEST_ROOT, { recursive: true, force: true })
})

async function writeStatus(overrides = {}) {
  await fs.writeFile(STATUS_PATH, JSON.stringify({
    state: 'RUNNING',
    profile: 'development',
    dry_run: true,
    auto_contain: false,
    broker: 'UNKNOWN',
    device: 'UNKNOWN',
    uplink: 'UNKNOWN',
    armed: 'MONITOR_ONLY',
    detail: 'internal free-form text must not cross the API',
    updated_at: Date.now() / 1000,
    components: { detector: 'RUNNING' },
    credential_like_field: 'test-marker-must-not-cross',
    ...overrides,
  }))
}

test('Security navigation and status endpoint are Admin-only', async () => {
  await writeStatus()

  const anonymous = new Client(baseUrl)
  assert.equal((await anonymous.req('/api/security/status')).status, 401)

  const user = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const userMe = await user.req('/api/me')
  assert.equal(userMe.status, 200)
  assert.equal(userMe.data.menu.some((item) => item.id === 'security'), false)
  const forbidden = await user.req('/api/security/status')
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.data.error, 'Forbidden')

  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const adminMe = await admin.req('/api/me')
  assert.equal(adminMe.status, 200)
  assert.equal(adminMe.data.menu.some((item) => item.id === 'security'), true)

  const allowed = await admin.req('/api/security/status')
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('cache-control'), 'no-store')
  assert.equal(allowed.data.idea3.available, true)
  assert.equal(allowed.data.idea3.fresh, true)
  assert.equal(allowed.data.idea3.state, 'RUNNING')
  assert.equal(allowed.data.idea3.dryRun, true)
  assert.deepEqual(Object.keys(allowed.data.idea3).sort(), [
    'ageSeconds', 'armed', 'available', 'broker', 'device', 'dryRun', 'fresh',
    'profile', 'reason', 'state', 'updatedAt', 'uplink',
  ])
  const serialized = JSON.stringify(allowed.data)
  assert.equal(serialized.includes('credential_like_field'), false)
  assert.equal(serialized.includes('test-marker-must-not-cross'), false)
  assert.equal(serialized.includes('components'), false)
  assert.equal(serialized.includes('detail'), false)
  assert.equal(serialized.includes('autoContain'), false)
})

test('stale or future-dated telemetry cannot appear current or healthy', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  await writeStatus({
    state: 'RUNNING', broker: 'CONNECTED', device: 'ONLINE', uplink: 'NORMAL',
    updated_at: (Date.now() / 1000) - 120,
  })
  const stale = await admin.req('/api/security/status')
  assert.equal(stale.status, 200)
  assert.equal(stale.data.idea3.available, true)
  assert.equal(stale.data.idea3.fresh, false)
  assert.equal(stale.data.idea3.reason, 'STALE')
  assert.equal(stale.data.idea3.state, 'UNKNOWN')
  assert.equal(stale.data.idea3.broker, 'UNKNOWN')
  assert.equal(stale.data.idea3.device, 'UNKNOWN')
  assert.equal(stale.data.idea3.uplink, 'UNKNOWN')
  assert.ok(stale.data.idea3.updatedAt)

  await writeStatus({ updated_at: (Date.now() / 1000) + 120 })
  const future = await admin.req('/api/security/status')
  assert.equal(future.status, 200)
  assert.equal(future.data.idea3.available, false)
  assert.equal(future.data.idea3.reason, 'INVALID_TIMESTAMP')
  assert.equal(future.data.idea3.state, 'UNKNOWN')
})

test('malformed, oversized, missing, and unknown status input fails safely', async () => {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)

  await fs.writeFile(STATUS_PATH, '{not-json')
  assert.equal((await admin.req('/api/security/status')).data.idea3.available, false)

  await fs.writeFile(STATUS_PATH, Buffer.alloc((64 * 1024) + 1, 0x20))
  const oversized = await admin.req('/api/security/status')
  assert.equal(oversized.data.idea3.reason, 'INVALID_STATUS_FILE')
  assert.equal(oversized.data.idea3.state, 'UNKNOWN')

  await writeStatus({ state: 'NOT_A_STATE', profile: 'custom', device: 'MAYBE' })
  const unknown = await admin.req('/api/security/status')
  assert.equal(unknown.data.idea3.fresh, true)
  assert.equal(unknown.data.idea3.state, 'UNKNOWN')
  assert.equal(unknown.data.idea3.profile, 'UNKNOWN')
  assert.equal(unknown.data.idea3.device, 'UNKNOWN')

  await fs.rm(STATUS_PATH)
  const missing = await admin.req('/api/security/status')
  assert.equal(missing.data.idea3.available, false)
  assert.equal(missing.data.idea3.reason, 'UNAVAILABLE')
  assert.equal(missing.data.idea3.state, 'UNKNOWN')
})
