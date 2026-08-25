// tests/shareOwnershipAuthorization.test.js — Secure Shares owner-only authorization
//
// Runs against the real Express application in either PostgreSQL or memory mode.
// Every assertion is behavior-level: a global list, non-atomic revoke, Admin
// override, Dashboard bypass, or private-field leak makes this suite fail.
import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  Client, loginClient, currentPasswordOf, DEMO_ADMIN, DEMO_USER,
} from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-share-auth-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const store = await import('../server/db/store.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const {
  usingPostgres, closePool, query, readAudit, sha256Hex,
} = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `database mode mismatch: expected ${DB_MODE}`)
console.log(`[share ownership authorization tests] database mode: ${DB_MODE}`)

let server
let baseUrl
let sequence = 0

before(async () => {
  await initStorage()
  const app = createApp()
  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

beforeEach(async () => {
  await store.__resetSharesForTests()
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  if (usingPostgres) {
    await query('DELETE FROM shares')
    await query(`DELETE FROM files WHERE name LIKE 'shareauth-%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

const rowId = (row) => String(row.id)
const eventActor = (event) => event.actor_label ?? event.actorLabel ?? null
const eventSource = (event) => event.source_ip ?? event.sourceIp ?? null
const eventTarget = (event) => event.target_hash ?? event.targetHash ?? null

async function upload(client, ownerLabel) {
  const name = `shareauth-${ownerLabel}-${Date.now()}-${sequence++}.txt`
  const form = new FormData()
  form.append('file', new Blob([`private bytes for ${ownerLabel}`], { type: 'application/octet-stream' }), name)
  const response = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(response.status, 201, `upload failed: ${JSON.stringify(response.data)}`)
  return response.data.file
}

async function createShare(client, file, options = {}) {
  const response = await client.req('/api/shares', {
    method: 'POST',
    body: {
      fileId: file.id,
      expiry: '24h',
      authType: 'none',
      scope: 'any',
      ...options,
    },
  })
  assert.equal(response.status, 201, `share creation failed: ${JSON.stringify(response.data)}`)
  return {
    share: response.data.share,
    path: response.data.path,
    token: response.data.path.split('/').pop(),
  }
}

async function twoOwnersWithShares(options = {}) {
  const admin = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const user = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const adminFile = await upload(admin, 'admin-private')
  const userFile = await upload(user, 'user-private')
  const adminShare = await createShare(admin, adminFile, options.admin)
  const userShare = await createShare(user, userFile, options.user)
  return { admin, user, adminFile, userFile, adminShare, userShare }
}

async function removeFiles(context) {
  await context.admin.req(`/api/files/${encodeURIComponent(context.adminFile.id)}`, { method: 'DELETE' })
  await context.user.req(`/api/files/${encodeURIComponent(context.userFile.id)}`, { method: 'DELETE' })
}

test('SHARE-AUTH-1/2/5: each role lists only its own shares and Dashboard uses the same scope', async () => {
  const context = await twoOwnersWithShares()
  const { admin, user, adminShare, userShare } = context

  const userList = (await user.req('/api/shares')).data.shares
  assert.deepEqual(userList.map(rowId), [rowId(userShare.share)], 'DataLake list must contain only its own share')
  assert.equal(userList.some((share) => rowId(share) === rowId(adminShare.share)), false)

  const userDashboard = (await user.req('/api/dashboard')).data
  assert.deepEqual(userDashboard.shares.map(rowId), [rowId(userShare.share)])
  assert.equal(userDashboard.metrics.activeShares, 1, 'Dashboard active-share count must be owner-scoped')

  const adminList = (await admin.req('/api/shares')).data.shares
  assert.deepEqual(adminList.map(rowId), [rowId(adminShare.share)], 'Admin list must contain only its own share')
  assert.equal(adminList.some((share) => rowId(share) === rowId(userShare.share)), false)

  const adminDashboard = (await admin.req('/api/dashboard')).data
  assert.deepEqual(adminDashboard.shares.map(rowId), [rowId(adminShare.share)])
  assert.equal(adminDashboard.metrics.activeShares, 1)

  await removeFiles(context)
})

test('SHARE-AUTH-3: DataLake owner can revoke an active share and redemption stops', async () => {
  const user = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await upload(user, 'user-own-revoke')
  const created = await createShare(user, file)

  const response = await user.req(`/api/shares/${encodeURIComponent(created.share.id)}`, { method: 'DELETE' })
  assert.equal(response.status, 200)
  assert.deepEqual(response.data, { ok: true })
  assert.equal((await new Client(baseUrl).raw(created.path)).status, 404)

  await user.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
})

test('SHARE-AUTH-4: DataLake cross-owner revoke is hidden and leaves the Admin share redeemable', async () => {
  const context = await twoOwnersWithShares()
  const { user, adminShare } = context

  const response = await user.req(`/api/shares/${encodeURIComponent(adminShare.share.id)}`, {
    method: 'DELETE',
    headers: { 'X-Forwarded-For': '203.0.113.77' },
  })
  assert.equal(response.status, 404)
  assert.deepEqual(response.data, { error: 'Not found' })
  assert.equal('share' in response.data || 'fileName' in response.data || 'createdBy' in response.data, false)
  assert.equal((await new Client(baseUrl).raw(adminShare.path)).status, 200)

  await removeFiles(context)
})

test('SHARE-AUTH-6: Admin has no cross-owner revoke override', async () => {
  const context = await twoOwnersWithShares()
  const { admin, userShare } = context

  const response = await admin.req(`/api/shares/${encodeURIComponent(userShare.share.id)}`, { method: 'DELETE' })
  assert.equal(response.status, 404)
  assert.deepEqual(response.data, { error: 'Not found' })
  assert.equal((await new Client(baseUrl).raw(userShare.path)).status, 200)

  await removeFiles(context)
})

test('SHARE-AUTH-7/8: unauthenticated list and revoke are denied without changing the share', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await upload(owner, 'anonymous-denial')
  const created = await createShare(owner, file)
  const anonymous = new Client(baseUrl)

  assert.equal((await anonymous.req('/api/shares')).status, 401)
  const revoke = await anonymous.req(`/api/shares/${encodeURIComponent(created.share.id)}`, { method: 'DELETE' })
  assert.equal(revoke.status, 401)
  assert.equal((await new Client(baseUrl).raw(created.path)).status, 200, 'anonymous denial must not mutate the share')

  await owner.req(`/api/shares/${encodeURIComponent(created.share.id)}`, { method: 'DELETE' })
  await owner.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
})

test('SHARE-AUTH-9: owner success and authenticated denial are durably, canonically audited', async () => {
  const context = await twoOwnersWithShares()
  const { admin, user, adminShare, userShare } = context
  const userIdentity = (await user.req('/api/me')).data.user

  assert.equal(
    (await user.req(`/api/shares/${encodeURIComponent(userShare.share.id)}`, { method: 'DELETE' })).status,
    200,
  )
  assert.equal(
    (await user.req(`/api/shares/${encodeURIComponent(adminShare.share.id)}`, {
      method: 'DELETE', headers: { 'X-Forwarded-For': '203.0.113.88' },
    })).status,
    404,
  )

  const events = await readAudit(200)
  const ownTarget = sha256Hex(String(userShare.share.id))
  const deniedTarget = sha256Hex(String(adminShare.share.id))
  const success = events.find(
    (event) => event.action === 'SHARE_REVOKE' && event.result === 'OK'
      && eventActor(event) === DEMO_USER.username && eventTarget(event) === ownTarget,
  )
  const denial = events.find(
    (event) => event.action === 'SHARE_REVOKE' && event.result === 'DENIED'
      && eventActor(event) === DEMO_USER.username && eventTarget(event) === deniedTarget,
  )
  assert.ok(success, 'owner revoke must produce SHARE_REVOKE / OK')
  assert.ok(denial, 'authenticated unsuccessful revoke must produce SHARE_REVOKE / DENIED')
  assert.equal(success.role, 'DataLake-User')
  assert.equal(denial.role, 'DataLake-User')
  assert.match(eventSource(success), /^(?:::ffff:)?127\.0\.0\.1$/)
  assert.match(eventSource(denial), /^(?:::ffff:)?127\.0\.0\.1$/)
  assert.notEqual(eventSource(denial), '203.0.113.88', 'untrusted XFF must not replace canonical req.ip')
  if (!usingPostgres) {
    assert.equal(String(success.actorId), String(userIdentity.id))
    assert.equal(String(denial.actorId), String(userIdentity.id))
  }

  await removeFiles(context)
})

test('SHARE-AUTH-10: list, denial, and audit expose no credential, internal owner ID, or cross-owner metadata', async () => {
  const password = `shareauth-password-${Date.now()}`
  const context = await twoOwnersWithShares({
    admin: { authType: 'password', password },
    user: { authType: 'password', password },
  })
  const { admin, user, adminFile, adminShare } = context

  const userListResponse = await user.req('/api/shares')
  await user.req(`/api/shares/${encodeURIComponent(adminShare.share.id)}`, { method: 'DELETE' })
  const audit = await readAudit(200)
  const dump = JSON.stringify({ response: userListResponse.data, audit })

  for (const forbidden of [
    adminShare.token, password, adminFile.name,
    'token_hash', 'tokenHash', 'password_hash', 'passwordHash',
    'created_by', 'createdById', 'ownerId',
  ]) {
    assert.equal(dump.includes(forbidden), false, `forbidden value/field leaked: ${forbidden}`)
  }

  await removeFiles(context)
})

test('SHARE-AUTH-11: store helpers fail closed without owner identity in both storage modes', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await upload(owner, 'store-fail-closed')
  const created = await createShare(owner, file)

  assert.deepEqual(await store.listShares(), [], 'unscoped list helper must not return global rows')
  assert.equal(await store.revokeShare(created.share.id), false, 'revoke helper must require owner identity')
  assert.equal((await new Client(baseUrl).raw(created.path)).status, 200)

  await owner.req(`/api/shares/${encodeURIComponent(created.share.id)}`, { method: 'DELETE' })
  await owner.req(`/api/files/${encodeURIComponent(file.id)}`, { method: 'DELETE' })
})

test('object hiding: nonexistent, malformed, expired, and already-revoked targets all return 404', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const remembered = await owner.req('/api/login', {
    method: 'POST',
    body: { username: DEMO_USER.username, password: currentPasswordOf(DEMO_USER.username), remember: true },
  })
  assert.equal(remembered.status, 200)
  owner.csrf = remembered.data.csrfToken

  assert.equal((await owner.req('/api/shares/not-a-share', { method: 'DELETE' })).status, 404)
  assert.equal((await owner.req('/api/shares/999999999', { method: 'DELETE' })).status, 404)

  const expiredFile = await upload(owner, 'expired')
  const expired = await createShare(owner, expiredFile, { expiry: '1h' })
  const realNow = Date.now
  try {
    if (usingPostgres) await query(`UPDATE shares SET expires_at = now() - interval '1 minute' WHERE id = $1`, [expired.share.id])
    else Date.now = () => realNow() + 2 * 60 * 60 * 1000
    assert.equal(
      (await owner.req(`/api/shares/${encodeURIComponent(expired.share.id)}`, { method: 'DELETE' })).status,
      404,
    )
  } finally {
    Date.now = realNow
  }

  const activeFile = await upload(owner, 'already-revoked')
  const active = await createShare(owner, activeFile)
  assert.equal((await owner.req(`/api/shares/${encodeURIComponent(active.share.id)}`, { method: 'DELETE' })).status, 200)
  assert.equal((await owner.req(`/api/shares/${encodeURIComponent(active.share.id)}`, { method: 'DELETE' })).status, 404)

  await owner.req(`/api/files/${encodeURIComponent(expiredFile.id)}`, { method: 'DELETE' })
  await owner.req(`/api/files/${encodeURIComponent(activeFile.id)}`, { method: 'DELETE' })
})
