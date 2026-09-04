// tests/protectedTrash.test.js — IDEA1 Protected Trash / Recycle Bin
//
// Contract: normal Data Lake files are soft-deleted for 30 days. Trash metadata
// is hidden until the current account completes a server-side password step-up.
// Every mutation remains owner-scoped (Admin has no override), shares stay
// revoked after restore, and permanent deletion removes current + version bytes.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loginClient, currentPasswordOf, DEMO_ADMIN, DEMO_USER } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-trash-test-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-trash-session-secret'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage, keyExists, removeKey } = await import('../server/storage/fileStore.js')
const { usingPostgres, closePool, query, readAudit } = await import('../server/db/connection.js')
const store = await import('../server/db/store.js')
const { runTrashAutoPurge, purgeTrashRecord, withTrashFileLock } = await import('../server/storage/trashCleanup.js')
const { unlockTrashSession, trashAuthorization } = await import('../server/auth/session.js')

let server, baseUrl, seq = 0
const uniqueName = (label) => `trash-${label}-${Date.now()}-${seq++}.txt`

before(async () => {
  await initStorage()
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  if (usingPostgres) {
    await query('DELETE FROM shares')
    await query(`DELETE FROM files WHERE name LIKE 'trash-%'`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

async function upload(client, name, content) {
  const form = new FormData()
  form.append('file', new Blob([content]), name)
  const response = await client.req('/api/files/upload', { method: 'POST', body: form })
  assert.equal(response.status, 201, JSON.stringify(response.data))
  return response.data.file
}

async function unlock(client, account, password = currentPasswordOf(account.username)) {
  return client.req('/api/trash/unlock', { method: 'POST', body: { password } })
}

test('TRASH-1..8 soft delete hides active routes, revokes share, preserves bytes and versions', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const ownerId = (await owner.req('/api/me')).data.user.id
  const name = uniqueName('lifecycle')
  await upload(owner, name, 'version one')
  const file = await upload(owner, name, 'version two')
  const beforeVersions = await store.listFileVersions(file.id)
  assert.equal(beforeVersions.length, 1)

  const shareResponse = await owner.req('/api/shares', {
    method: 'POST', body: { fileId: file.id, expiry: '24h', authType: 'none', scope: 'any' },
  })
  assert.equal(shareResponse.status, 201)
  const sharePath = shareResponse.data.path

  const trashed = await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })
  assert.equal(trashed.status, 200)
  assert.equal(trashed.data?.ok, true)
  assert.match(String(trashed.data?.purgeAt), /^\d{4}-\d{2}-\d{2}T/)

  assert.equal((await owner.req('/api/files')).data.files.some((row) => row.id === file.id), false)
  assert.equal((await owner.raw(`/api/files/${file.id}/download`)).status, 404)
  assert.equal((await owner.req(`/api/files/${file.id}/verify`, { method: 'POST' })).status, 404)
  assert.equal((await owner.req(`/api/files/${file.id}/versions`)).status, 404)
  assert.equal((await owner.req('/api/shares')).data.shares.some((row) => row.fileId === file.id), false)
  assert.equal((await owner.raw(sharePath)).status, 404)

  const internal = await store.findTrashedFile(file.id, ownerId)
  assert.ok(internal)
  assert.equal(await keyExists(internal.path), true, 'soft delete must not move/delete current bytes')
  assert.equal((await store.listFileVersions(file.id)).length, beforeVersions.length)
})

test('TRASH-9..14 metadata stays hidden until correct current-account password unlocks session', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const file = await upload(owner, uniqueName('step-up'), 'step-up payload')
  await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })

  const statusBefore = await owner.req('/api/trash/status')
  assert.equal(statusBefore.status, 200)
  assert.deepEqual(statusBefore.data, { unlocked: false })
  const lockedList = await owner.req('/api/trash')
  assert.equal(lockedList.status, 423)
  assert.equal(JSON.stringify(lockedList.data).includes(file.name), false)

  const wrong = await unlock(owner, DEMO_USER, 'definitely-wrong-password')
  assert.equal(wrong.status, 401)
  const good = await unlock(owner, DEMO_USER)
  assert.equal(good.status, 200)
  assert.equal(good.data?.unlocked, true)

  const list = await owner.req('/api/trash')
  assert.equal(list.status, 200)
  const item = list.data.items.find((row) => row.id === file.id)
  assert.ok(item)
  assert.equal(item.name, file.name)
  assert.equal(item.versionCount, 0)
  assert.ok(!('path' in item) && !('ownerId' in item) && !('deletedBy' in item))

  assert.equal((await owner.req('/api/trash/lock', { method: 'POST' })).status, 204)
  assert.deepEqual((await owner.req('/api/trash/status')).data, { unlocked: false })
})

test('TRASH-15..22 restore is owner-only, collision-safe, preserves history and never reactivates shares', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const other = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const name = uniqueName('restore')
  await upload(owner, name, 'old version')
  const file = await upload(owner, name, 'current version')
  const share = await owner.req('/api/shares', {
    method: 'POST', body: { fileId: file.id, expiry: '24h', authType: 'none', scope: 'any' },
  })
  await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })
  await unlock(owner, DEMO_USER)
  await unlock(other, DEMO_ADMIN)

  assert.equal((await other.req(`/api/trash/${file.id}/restore`, { method: 'POST' })).status, 404)
  const restored = await owner.req(`/api/trash/${file.id}/restore`, { method: 'POST' })
  assert.equal(restored.status, 200, JSON.stringify(restored.data))
  assert.equal(restored.data.file.id, file.id)
  const detail = (await owner.req(`/api/files/${file.id}/versions`)).data
  assert.equal(detail.versions.length, 1)
  const currentBytes = await owner.raw(`/api/files/${file.id}/download`)
  const previousBytes = await owner.raw(`/api/files/${file.id}/versions/${detail.versions[0].id}/download`)
  assert.equal(currentBytes.buffer.toString('utf8'), 'current version')
  assert.equal(previousBytes.buffer.toString('utf8'), 'old version')
  const verified = await owner.req(`/api/files/${file.id}/verify`, { method: 'POST' })
  assert.equal(verified.status, 200)
  assert.equal(verified.data?.match, true)
  assert.equal(verified.data?.storedSha256, file.sha256)
  assert.equal((await owner.raw(share.data.path)).status, 404)
})

test('TRASH-RESTORE-CONFLICT suggests a safe name and accepts explicit restore-as-copy name', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const name = uniqueName('collision')
  const trashed = await upload(owner, name, 'first file')
  await owner.req(`/api/files/${trashed.id}`, { method: 'DELETE' })
  await upload(owner, name, 'new active file with same name')
  await unlock(owner, DEMO_USER)

  const conflict = await owner.req(`/api/trash/${trashed.id}/restore`, { method: 'POST' })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.data?.code, 'NAME_CONFLICT')
  assert.match(conflict.data?.suggestedName, /\(restored\)/)
  const restored = await owner.req(`/api/trash/${trashed.id}/restore`, {
    method: 'POST', body: { name: conflict.data.suggestedName },
  })
  assert.equal(restored.status, 200)
  assert.equal(restored.data.file.name, conflict.data.suggestedName)
})

test('TRASH-STORAGE restore fails closed when retained bytes are missing', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const ownerId = (await owner.req('/api/me')).data.user.id
  const file = await upload(owner, uniqueName('missing-bytes'), 'will be removed out of band')
  await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })
  const internal = await store.findTrashedFile(file.id, ownerId)
  await removeKey(internal.path)
  await unlock(owner, DEMO_USER)
  const response = await owner.req(`/api/trash/${file.id}/restore`, { method: 'POST' })
  assert.equal(response.status, 409)
  assert.equal(response.data?.code, 'STORAGE_INCOMPLETE')
})

test('TRASH-RACE restore and purge serialize; stale purge candidates never remove restored bytes', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const ownerId = (await owner.req('/api/me')).data.user.id
  const file = await upload(owner, uniqueName('race'), 'race-safe payload')
  await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })
  await unlock(owner, DEMO_USER)
  const staleCandidate = await store.findTrashedFile(file.id, ownerId)

  let enterLock
  let releaseLock
  const entered = new Promise((resolve) => { enterLock = resolve })
  const released = new Promise((resolve) => { releaseLock = resolve })
  const holder = withTrashFileLock(file.id, async () => {
    enterLock()
    await released
    return true
  })
  await entered
  const busy = await owner.req(`/api/trash/${file.id}/restore`, { method: 'POST' })
  assert.equal(busy.status, 409)
  assert.equal(busy.data?.code, 'TRASH_ITEM_BUSY')
  releaseLock()
  await holder

  const restored = await owner.req(`/api/trash/${file.id}/restore`, { method: 'POST' })
  assert.equal(restored.status, 200)
  assert.equal(await purgeTrashRecord(staleCandidate), false)
  assert.equal(await keyExists(staleCandidate.path), true)
  assert.equal((await owner.req('/api/files')).data.files.some((row) => row.id === file.id), true)
})

test('TRASH-23..30 permanent delete requires recent verification and removes current + version bytes', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const name = uniqueName('purge')
  await upload(owner, name, 'old bytes')
  const file = await upload(owner, name, 'current bytes')
  const before = await store.findFile(file.id)
  const versions = await store.listFileVersions(file.id)
  await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })

  assert.equal((await owner.req(`/api/trash/${file.id}`, { method: 'DELETE' })).status, 403)
  const wrong = await owner.req(`/api/trash/${file.id}`, {
    method: 'DELETE', body: { password: 'wrong-password' },
  })
  assert.equal(wrong.status, 401)
  const removed = await owner.req(`/api/trash/${file.id}`, {
    method: 'DELETE', body: { password: currentPasswordOf(DEMO_USER.username) },
  })
  assert.equal(removed.status, 200)
  assert.equal(await keyExists(before.path), false)
  for (const version of versions) assert.equal(await keyExists(version.storageKey), false)
  assert.equal(await store.findFile(file.id), null)
})

test('TRASH-31 empty requires password plus typed DELETE and audit covers security mutations', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const one = await upload(owner, uniqueName('empty-a'), 'a')
  const two = await upload(owner, uniqueName('empty-b'), 'b')
  await owner.req(`/api/files/${one.id}`, { method: 'DELETE' })
  await owner.req(`/api/files/${two.id}`, { method: 'DELETE' })
  await unlock(owner, DEMO_USER)

  const denied = await owner.req('/api/trash/empty', {
    method: 'POST', body: { password: currentPasswordOf(DEMO_USER.username), confirmation: 'delete' },
  })
  assert.equal(denied.status, 400)
  const emptied = await owner.req('/api/trash/empty', {
    method: 'POST', body: { password: currentPasswordOf(DEMO_USER.username), confirmation: 'DELETE' },
  })
  assert.equal(emptied.status, 200)
  assert.ok(emptied.data.deletedCount >= 2)

  const events = await readAudit(100)
  const own = events.filter((event) => (event.actor_label ?? event.actorLabel) === DEMO_USER.username)
  assert.ok(own.some((event) => event.action === 'FILE_TRASH' && event.result === 'OK'))
  assert.ok(own.some((event) => event.action === 'TRASH_UNLOCK' && event.result === 'OK'))
  assert.ok(own.some((event) => event.action === 'TRASH_EMPTY' && event.result === 'OK'))
})

test('TRASH-32 auto purge only claims expired trash and reports idempotent bounded work', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const ownerId = (await owner.req('/api/me')).data.user.id
  const expired = await upload(owner, uniqueName('expired'), 'expired')
  const future = await upload(owner, uniqueName('future'), 'future')
  const expiredKey = expired.path
  await owner.req(`/api/files/${expired.id}`, { method: 'DELETE' })
  await owner.req(`/api/files/${future.id}`, { method: 'DELETE' })
  await store.setTrashPurgeAtForTest(expired.id, new Date(Date.now() - 60_000))

  const first = await store.listExpiredTrash(10)
  assert.deepEqual(first.map((row) => row.id), [expired.id])
  assert.equal(first.some((row) => row.id === future.id), false)
  assert.deepEqual(await runTrashAutoPurge({ limit: 10 }), { examined: 1, purged: 1 })
  assert.equal(await keyExists(expiredKey), false)
  assert.equal(await store.findTrashedFile(future.id, ownerId) != null, true)
  assert.deepEqual(await runTrashAutoPurge({ limit: 10 }), { examined: 0, purged: 0 })
  const audit = await readAudit(100)
  assert.ok(audit.some((event) => event.action === 'FILE_TRASH_AUTO_PURGE'
    && (event.actor_label ?? event.actorLabel) === 'system'))
})

test('TRASH-AUTH unauthenticated endpoints deny and another owner never sees metadata', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const other = await loginClient(baseUrl, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const file = await upload(owner, uniqueName('isolation'), 'owner only')
  await owner.req(`/api/files/${file.id}`, { method: 'DELETE' })
  await unlock(other, DEMO_ADMIN)
  const otherList = await other.req('/api/trash')
  assert.equal(otherList.status, 200)
  assert.equal(JSON.stringify(otherList.data).includes(file.name), false)

  const anonymous = new (await import('./helpers/testClient.mjs')).Client(baseUrl)
  assert.equal((await anonymous.req('/api/trash/status')).status, 401)
  assert.equal((await anonymous.req('/api/trash')).status, 401)
  assert.equal((await anonymous.req('/api/trash/unlock', { method: 'POST', body: { password: 'x' } })).status, 401)
  assert.equal((await anonymous.req('/api/trash/lock', { method: 'POST' })).status, 401)
  assert.equal((await anonymous.req('/api/trash/empty', { method: 'POST', body: { confirmation: 'DELETE', password: 'x' } })).status, 401)
  assert.equal((await anonymous.req(`/api/trash/${file.id}/restore`, { method: 'POST' })).status, 401)
  assert.equal((await anonymous.req(`/api/trash/${file.id}`, { method: 'DELETE' })).status, 401)
})

test('TRASH-RATE-LIMIT repeated wrong step-up passwords are blocked and audited', async () => {
  const owner = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  let blocked = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await unlock(owner, DEMO_USER, `wrong-trash-password-${attempt}`)
    if (response.status === 429) {
      blocked = response
      break
    }
    assert.equal(response.status, 401)
  }
  assert.ok(blocked, 'repeated wrong passwords must reach the server-side lockout')
  blocked = await unlock(owner, DEMO_USER, 'wrong-trash-password-blocked')
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1)
  const audit = await readAudit(100)
  assert.ok(audit.some((event) => event.action === 'TRASH_UNLOCK' && event.result === 'BLOCKED'))
})

test('TRASH-SESSION unlock and destructive reauth windows expire on server-controlled time', () => {
  const request = { session: { user: { id: 42 } } }
  assert.equal(unlockTrashSession(request, 1_000), true)
  assert.deepEqual(trashAuthorization(request, 60_999), { unlocked: true, destructiveReauth: true })
  assert.deepEqual(trashAuthorization(request, 61_001), { unlocked: true, destructiveReauth: false })
  assert.deepEqual(trashAuthorization(request, 301_001), { unlocked: false, destructiveReauth: false })
})
