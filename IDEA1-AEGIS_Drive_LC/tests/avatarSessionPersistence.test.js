// tests/avatarSessionPersistence.test.js — AEGIS Drive (IDEA1)
//
// Integration cover for the avatar fact that /api/me reports. This runs against
// the real Express app (server/app.js) with real sessions and real cookies —
// no mocks, and deliberately NOT source-regex assertions, because the defect
// this file exists for was invisible in the source of any single file.
//
// The bug: `publicUser()` derives `hasAvatar` / `avatarVersion` from
// `u.avatarKey`, and `/api/me` serialises the **session** user. But
// `establishSession()` builds that session object field by field and did not
// copy `avatarKey`. So an account that genuinely had a picture got:
//
//   POST /api/login  → hasAvatar: true   (correct — serialises the DB row)
//   GET  /api/me     → hasAvatar: false  (wrong — serialises the session)
//
// which is exactly the "avatar disappears after a refresh" shape, only
// inverted: the picture existed and the app claimed it did not.
//
// The second case is idempotency: DELETE returned 404 early when there was
// nothing to delete, which could leave a stale `avatarKey` on the session — so
// a repeat delete (or one racing another device) left /api/me still asserting a
// picture the database no longer had.
//
// ⚠️ Runs in both DB modes — no TEST_DATABASE_URL = in-memory.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client, loginClient, performLogin, DEMO_USER } from './helpers/testClient.mjs'

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-avatar-session-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'

if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const DB_MODE = process.env.DATABASE_URL ? 'postgres' : 'memory'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initAvatarStorage } = await import('../server/storage/avatarStore.js')
const { usingPostgres, closePool, query } = await import('../server/db/connection.js')

assert.equal(usingPostgres, DB_MODE === 'postgres', `unexpected DB mode — wanted ${DB_MODE}`)
console.log(`[avatar session tests] database mode: ${DB_MODE}`)

let server
let baseUrl

before(async () => {
  await initStorage()
  await initAvatarStorage()
  const app = createApp()
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((r) => server.close(r))
  if (usingPostgres) {
    await query(`UPDATE users SET avatar_key = NULL, avatar_mime = NULL`)
    await closePool()
  }
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
})

/* ── a real, minimal PNG (the upload route sniffs actual bytes) ────────── */

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([len, typed, crc])
}

/** A valid 1x1 PNG — the route rejects anything it cannot actually decode. */
function makePng() {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x62, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

async function uploadAvatar(client) {
  const form = new FormData()
  form.append('avatar', new Blob([makePng()], { type: 'image/png' }), 'me.png')
  return client.req('/api/profile/avatar', { method: 'POST', body: form })
}

/** What /api/me — the call every page load makes — says about the avatar. */
async function avatarFactsFromMe(client) {
  const me = await client.req('/api/me')
  assert.equal(me.status, 200, `/api/me should answer for a live session, got ${me.status}`)
  return { hasAvatar: me.data.user.hasAvatar, avatarVersion: me.data.user.avatarVersion, user: me.data.user }
}

/** A brand-new client: a real second login, i.e. a genuinely fresh session. */
async function freshLogin() {
  const c = new Client(baseUrl)
  await performLogin(c, DEMO_USER.username, DEMO_USER.password)
  return c
}

/* ── the regression this file was written for ─────────────────────────── */

test('AVATAR-SESSION-A a fresh login preserves an avatar that already exists in the database', async () => {
  const setup = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const created = await uploadAvatar(setup)
  assert.equal(created.status, 201, `upload should succeed, got ${created.status}`)

  // A completely new session for an account that already has a picture. The
  // session is built by establishSession(), not from the POST response, so this
  // is the exact path that used to lose the avatar.
  const fresh = await freshLogin()
  const facts = await avatarFactsFromMe(fresh)

  assert.equal(facts.hasAvatar, true, 'a newly established session must still know the account has a picture')
  assert.ok(facts.avatarVersion, 'and must carry a version token')
  assert.equal(typeof facts.avatarVersion, 'string')
})

test('AVATAR-SESSION-B login and /api/me agree with each other', async () => {
  // The tell of the original defect was these two disagreeing: login
  // serialises the DB row, /api/me serialises the session.
  const client = new Client(baseUrl)
  const login = await performLogin(client, DEMO_USER.username, DEMO_USER.password)
  const fromMe = await avatarFactsFromMe(client)

  assert.equal(
    login.user.hasAvatar, fromMe.hasAvatar,
    'the login response and /api/me must report the same avatar state',
  )
  assert.equal(login.user.avatarVersion, fromMe.avatarVersion, 'and the same version')
})

test('AVATAR-SESSION-C uploading is visible on /api/me, and stays visible on the next call', async () => {
  const client = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const created = await uploadAvatar(client)
  assert.equal(created.status, 201)
  assert.equal(created.data.hasAvatar, true)
  assert.ok(created.data.avatarVersion, 'the upload response carries the new version')

  const first = await avatarFactsFromMe(client)
  assert.equal(first.hasAvatar, true)
  assert.equal(first.avatarVersion, created.data.avatarVersion, 'the session agrees with the upload response')

  // The refresh-equivalent: a second GET on the same session.
  const second = await avatarFactsFromMe(client)
  assert.equal(second.hasAvatar, true, 'still true on the next page load')
  assert.equal(second.avatarVersion, first.avatarVersion, 'and the version is stable')
})

test('AVATAR-SESSION-D deleting clears the fact on /api/me', async () => {
  const client = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  await uploadAvatar(client)
  assert.equal((await avatarFactsFromMe(client)).hasAvatar, true, 'precondition: a picture exists')

  const removed = await client.req('/api/profile/avatar', { method: 'DELETE' })
  assert.equal(removed.status, 204)

  const facts = await avatarFactsFromMe(client)
  assert.equal(facts.hasAvatar, false, 'the removal is reflected without a re-login')
  assert.equal(facts.avatarVersion, null, 'and no stale version is left behind')
})

test('AVATAR-SESSION-E deleting again is idempotent for the session, not just for the database', async () => {
  const client = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  await uploadAvatar(client)
  assert.equal((await client.req('/api/profile/avatar', { method: 'DELETE' })).status, 204)

  // Nothing left to delete. The HTTP contract still says 404 — but the session
  // must end up reconciled all the same, which the early return used to skip.
  const again = await client.req('/api/profile/avatar', { method: 'DELETE' })
  assert.equal(again.status, 404, 'the API contract for "nothing to delete" is unchanged')

  const facts = await avatarFactsFromMe(client)
  assert.equal(facts.hasAvatar, false, 'the session is still reconciled to no avatar')
  assert.equal(facts.avatarVersion, null)
})

test('AVATAR-SESSION-F a stale session that already lost its picture is reconciled by a repeat delete', async () => {
  // Two live sessions for one account — the second device deletes, so the first
  // one is holding an avatarKey the database no longer has.
  const first = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  await uploadAvatar(first)
  assert.equal((await avatarFactsFromMe(first)).hasAvatar, true)

  const second = await freshLogin()
  assert.equal((await second.req('/api/profile/avatar', { method: 'DELETE' })).status, 204)

  // The first session has not been told anything yet; when it tries to delete,
  // it gets 404 — and must still come out reconciled rather than stuck.
  const stale = await first.req('/api/profile/avatar', { method: 'DELETE' })
  assert.equal(stale.status, 404)
  assert.equal((await avatarFactsFromMe(first)).hasAvatar, false, 'the stale session is corrected, not left asserting a deleted picture')
})

test('AVATAR-SESSION-G removal survives logout and a fresh login', async () => {
  const client = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  await uploadAvatar(client)
  assert.equal((await client.req('/api/profile/avatar', { method: 'DELETE' })).status, 204)
  await client.req('/api/logout', { method: 'POST' })

  const fresh = await freshLogin()
  const facts = await avatarFactsFromMe(fresh)
  assert.equal(facts.hasAvatar, false, 'the picture is still gone after a real logout/login round trip')
  assert.equal(facts.avatarVersion, null)
})

/* ── what must never travel with those facts ──────────────────────────── */

test('AVATAR-SESSION-H the storage key never reaches the client, in any avatar response', async () => {
  const client = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const created = await uploadAvatar(client)
  const me = await client.req('/api/me')

  // avatar_key is a real path inside the Storage Layer ('avatars/<uuid>.<ext>').
  // Only an opaque hash of it may be published.
  for (const [label, payload] of [['upload', created.data], ['/api/me', me.data]]) {
    const body = JSON.stringify(payload)
    assert.equal(/avatars\//.test(body), false, `${label} must not leak the storage path`)
    assert.equal(/avatarKey/.test(body), false, `${label} must not expose avatarKey`)
    assert.equal(/\.png"|\.jpe?g"/.test(body), false, `${label} must not expose a stored filename`)
  }

  assert.match(me.data.user.avatarVersion, /^[0-9a-f]{12}$/, 'the version is a short opaque hex token')
  assert.equal(me.data.user.avatarVersion, created.data.avatarVersion, 'the published version matches the one the upload returned')
})

test('AVATAR-SESSION-I the version changes when the picture is replaced', async () => {
  const client = await loginClient(baseUrl, DEMO_USER.username, DEMO_USER.password)
  const first = await uploadAvatar(client)
  const firstVersion = (await avatarFactsFromMe(client)).avatarVersion

  const second = await uploadAvatar(client)
  const secondVersion = (await avatarFactsFromMe(client)).avatarVersion

  assert.equal(first.status, 201)
  assert.equal(second.status, 201)
  assert.ok(firstVersion && secondVersion)
  assert.notEqual(firstVersion, secondVersion, 'a replaced picture gets a new version, so a cached URL cannot win')
})
