import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-health-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'health-test-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'
const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { closePool } = await import('../server/db/connection.js')

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
  await closePool()
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

test('healthz reports independent measured evidence for application, metadata, and storage', async () => {
  const response = await fetch(`${baseUrl}/healthz`)
  assert.equal(response.status, 200)
  const body = await response.json()

  assert.equal(body.ok, true)
  assert.equal(body.db, DB_MODE)
  assert.deepEqual(Object.keys(body.layers).sort(), ['application', 'metadata', 'storage'])

  assert.equal(body.layers.application.ok, true)
  assert.equal(body.layers.application.measured, true)
  assert.equal(Number.isFinite(body.layers.application.latencyMs), true)
  assert.equal(body.layers.application.check, 'event-loop-turn')

  assert.equal(body.layers.storage.ok, true)
  assert.equal(body.layers.storage.measured, true)
  assert.equal(Number.isFinite(body.layers.storage.latencyMs), true)
  assert.equal(body.layers.storage.check, 'write-read-delete')

  if (DB_MODE === 'postgres') {
    assert.equal(body.layers.metadata.ok, true)
    assert.equal(body.layers.metadata.measured, true)
    assert.equal(Number.isFinite(body.layers.metadata.latencyMs), true)
    assert.equal(body.layers.metadata.check, 'select-1')
  } else {
    assert.equal(body.layers.metadata.ok, false)
    assert.equal(body.layers.metadata.measured, false)
    assert.equal(body.layers.metadata.latencyMs, null)
  }

  // Runtime probe must clean up after itself; health checks cannot accumulate fake user files.
  assert.deepEqual(await fs.readdir(path.join(STORAGE_ROOT, 'uploads')), [])
})

test('health UI consumes layer evidence and contains no fixed latency or Edge-node overclaim', async () => {
  const [dashboard, topBar, strings] = await Promise.all([
    fs.readFile(new URL('../src/screens/Dashboard.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/components/TopBar.jsx', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/lib/strings.js', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(dashboard, /baseLat|12\s*\/\s*4\s*\/\s*2/)
  assert.match(dashboard, /health\?\.layers/)
  assert.match(dashboard, /latencyMs/)
  assert.doesNotMatch(topBar, /Edge node: online/)
  assert.doesNotMatch(strings, /Edge node: (?:Not connected|ยังไม่เชื่อมต่อ|尚未连接)/)
  assert.match(topBar, /driveOnline/)
  assert.match(topBar, /driveNotConnected/)
})
