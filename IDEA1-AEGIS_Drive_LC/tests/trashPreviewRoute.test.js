import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, currentPasswordOf, DEMO_USER, DEMO_ADMIN } from './helpers/testClient.mjs'

const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-trash-preview-'))
process.env.STORAGE_ROOT = storageRoot
process.env.SESSION_SECRET = 'test-only-trash-preview-session'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')
const store = await import('../server/db/store.js')
let server, baseUrl, seq = 0

before(async () => {
  await initStorage()
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  if (usingPostgres) {
    await query("DELETE FROM files WHERE name LIKE 'trash-preview-%'")
    await closePool()
  }
  await fs.rm(storageRoot, { recursive: true, force: true })
})

async function upload(client, extension, bytes) {
  const name = `trash-preview-${Date.now()}-${seq++}.${extension}`
  const form = new FormData()
  form.append('file', new Blob([bytes]), name)
  const response = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(response.status, 201, JSON.stringify(response.data))
  return response.data.file
}

async function unlock(client, account) {
  const response = await client.req('/api/trash/unlock', {
    method: 'POST', body: { password: currentPasswordOf(account.username) },
  })
  assert.equal(response.status, 200)
}

const preview = (client, id, headers = {}) =>
  client.raw(`/api/trash/${encodeURIComponent(id)}/preview`, { headers })

test('TRASH-PREVIEW-ROUTE: unlocked owner reads bytes and Range without changing Trash state', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const bytes = Buffer.from('image bytes retained unchanged')
  const file = await upload(owner, 'png', bytes)
  assert.equal((await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })).status, 200)
  const locked = await preview(owner, file.id)
  assert.equal(locked.status, 423)
  await unlock(owner, DEMO_USER)
  const beforeItem = (await owner.req('/api/trash')).data.items.find((item) => item.id === file.id)
  const full = await preview(owner, file.id)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('content-type'), 'image/png')
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff')
  assert.match(full.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.ok(full.buffer.equals(bytes))
  const range = await preview(owner, file.id, { Range: 'bytes=2-7' })
  assert.equal(range.status, 206)
  assert.equal(range.headers.get('content-range'), `bytes 2-7/${bytes.length}`)
  assert.ok(range.buffer.equals(bytes.subarray(2, 8)))
  const invalidRange = await preview(owner, file.id, { Range: 'bytes=999999-' })
  assert.equal(invalidRange.status, 416)
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${bytes.length}`)
  assert.deepEqual((await owner.req('/api/trash')).data.items.find((item) => item.id === file.id), beforeItem)
  assert.equal((await store.findFile(file.id)), null)
})

test('TRASH-PREVIEW-ROUTE: auth, owner and current-trash gates are non-enumerating', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const other = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const file = await upload(owner, 'jpg', Buffer.from('owner only'))
  assert.equal((await fetch(`${baseUrl}/api/trash/${file.id}/preview`)).status, 401)
  await unlock(owner, DEMO_USER)
  assert.equal((await preview(owner, file.id)).status, 404, 'live file is not a Trash item')
  assert.equal((await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })).status, 200)
  await unlock(other, DEMO_ADMIN)
  const denied = await preview(other, file.id, { Range: 'bytes=999999-' })
  assert.equal(denied.status, 404)
  assert.equal(denied.headers.get('content-range'), null)
  assert.equal((await preview(owner, '999999999')).status, 404)
  assert.equal((await owner.req(`/api/trash/${file.id}/restore`, { method: 'POST' })).status, 200)
  assert.equal((await preview(owner, file.id)).status, 404, 'restored file is not a Trash item')
})

test('TRASH-PREVIEW-ROUTE: unsupported bytes are refused and normal live preview stays unchanged', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await upload(owner, 'pdf', Buffer.from('%PDF-1.7'))
  const live = await owner.raw(`/api/files/${file.id}/preview`)
  assert.equal(live.status, 415)
  await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })
  await unlock(owner, DEMO_USER)
  const trashed = await preview(owner, file.id)
  assert.equal(trashed.status, 415)
  assert.equal(trashed.headers.get('content-type')?.startsWith('application/pdf'), false)
  assert.equal((await owner.raw(`/api/files/${file.id}/preview`)).status, 404)
})

test('TRASH-PREVIEW-ROUTE: text stays inert and signature mismatch fails closed', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const html = Buffer.from('<script>doNotRun()</script>')
  const source = await upload(owner, 'html', html)
  const disguised = await upload(owner, 'txt', Buffer.from([0, 1, 2, 3, 4]))
  await owner.req(`/api/files/${source.id}`, { method: 'DELETE' })
  await owner.req(`/api/files/${disguised.id}`, { method: 'DELETE' })
  await unlock(owner, DEMO_USER)
  const inert = await preview(owner, source.id)
  assert.equal(inert.status, 200)
  assert.match(inert.headers.get('content-type') ?? '', /^text\/plain/)
  assert.match(inert.headers.get('content-security-policy') ?? '', /sandbox/)
  assert.ok(inert.buffer.equals(html))
  assert.equal((await preview(owner, disguised.id)).status, 415)
})

test('TRASH-PREVIEW-ROUTE: Vault ciphertext never enters Trash plaintext preview', {
  skip: usingPostgres ? false : 'direct legacy Vault row requires PostgreSQL',
}, async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const { rows: [account] } = await query('SELECT id FROM users WHERE username = $1', [DEMO_USER.username])
  const name = `trash-preview-vault-${Date.now()}-${seq++}.jpg`
  const { rows: [row] } = await query(
    `INSERT INTO files (name, path, size_bytes, sha256, vault, verified, uploaded_by, kind, deleted_at, purge_after)
     VALUES ($1, 'vault/00000000-0000-4000-8000-000000000000.bin', 10, NULL, TRUE, TRUE, $2, 'file', now(), now() + interval '30 days')
     RETURNING id`,
    [name, account.id],
  )
  await unlock(owner, DEMO_USER)
  const response = await preview(owner, String(row.id), { Range: 'bytes=99999-' })
  assert.equal(response.status, 404)
  assert.equal(response.headers.get('content-range'), null)
})
