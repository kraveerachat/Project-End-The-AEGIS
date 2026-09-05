// Server contract for the Settings redesign: per-account security settings,
// self-scoped security activity, and "sign out other sessions".
//
// The point of this file is that every NEW setting is bounded and owned by the
// session's own account. Each test below fails loudly if a value the share
// contract cannot honour, or a value belonging to another account, can reach or
// leave the database through these routes.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

import { Client, DEMO_ADMIN, DEMO_USER, performLogin } from './helpers/testClient.mjs'

const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-settings-security-test-'))
const moduleRoot = path.resolve(import.meta.dirname, '..')
process.env.STORAGE_ROOT = storageRoot
process.env.COOKIE_SECURE = 'false'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initAvatarStorage } = await import('../server/storage/avatarStore.js')

let server
let baseUrl

const DEFAULTS = {
  vaultAutoLockMinutes: 10,
  shareDefaults: { expiry: '24h', scope: 'zones', requirePassword: true },
}

before(async () => {
  await Promise.all([initStorage(), initVaultStorage(), initAvatarStorage()])
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await fs.rm(storageRoot, { recursive: true, force: true })
})

// ── Migration ────────────────────────────────────────────────────────────────

test('migration 007 is additive, idempotent, and constrains every new column', async () => {
  const sql = await fs.readFile(
    path.join(moduleRoot, 'server/db/migrations/007_security_settings.sql'),
    'utf8',
  )
  assert.match(sql, /BEGIN;/)
  assert.match(sql, /COMMIT;/)
  for (const column of [
    'vault_autolock_minutes', 'share_default_expiry',
    'share_default_scope', 'share_default_require_password',
  ]) {
    assert.match(sql, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`))
  }
  // Existing rows must land on the documented defaults, not on NULL.
  assert.match(sql, /vault_autolock_minutes INTEGER NOT NULL DEFAULT 10/)
  assert.match(sql, /share_default_expiry TEXT NOT NULL DEFAULT '24h'/)
  assert.match(sql, /share_default_scope TEXT NOT NULL DEFAULT 'zones'/)
  assert.match(sql, /share_default_require_password BOOLEAN NOT NULL DEFAULT true/)
  // Range is enforced by the database too, not only by the route.
  // 007 is deployed and immutable: it still declares the ORIGINAL set. The widened
  // set arrives through 008 (see tests/vaultAutoLockDuration.test.js AUTOLOCK-5).
  assert.match(sql, /CHECK \(vault_autolock_minutes IN \(5, 10, 15, 30, 60\)\)/)
  assert.match(sql, /CHECK \(share_default_expiry IN \('1h', '24h', '7d', '30d'\)\)/)
  assert.match(sql, /CHECK \(share_default_scope IN \('any', 'zones'\)\)/)

  // No existing migration may be edited to carry this change.
  assert.doesNotMatch(
    await fs.readFile(path.join(moduleRoot, 'server/db/migrations/006_interface_style.sql'), 'utf8'),
    /vault_autolock_minutes|share_default_/,
  )
})

test('no migration or schema file creates a stored default share password', async () => {
  const dir = path.join(moduleRoot, 'server/db/migrations')
  const files = await fs.readdir(dir)
  const sources = await Promise.all([
    ...files.map((f) => fs.readFile(path.join(dir, f), 'utf8')),
    fs.readFile(path.join(moduleRoot, 'server/db/schema.sql'), 'utf8'),
  ])
  for (const sql of sources) {
    assert.doesNotMatch(sql, /share_default_password|default_share_password/i)
  }
})

// ── Defaults and persistence ─────────────────────────────────────────────────

test('new accounts receive the documented safe defaults', async () => {
  const client = new Client(baseUrl)
  await performLogin(client, DEMO_USER.username, DEMO_USER.password)

  const res = await client.req('/api/security/settings')
  assert.equal(res.status, 200)
  assert.deepEqual(res.data.settings, DEFAULTS)
})

test('settings persist for the authenticated account and ignore a supplied userId', async () => {
  const admin = new Client(baseUrl)
  await performLogin(admin, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const saved = await admin.req('/api/security/settings', {
    method: 'PATCH',
    body: {
      vaultAutoLockMinutes: 30,
      shareDefaults: { expiry: '7d', scope: 'any', requirePassword: false },
      userId: '2', // must be ignored — the row written is the session's own
    },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.data.settings, {
    vaultAutoLockMinutes: 30,
    shareDefaults: { expiry: '7d', scope: 'any', requirePassword: false },
  })

  // Same session, read back.
  const reread = await admin.req('/api/security/settings')
  assert.deepEqual(reread.data.settings, saved.data.settings)

  // Fresh login — the value came from the account, not from browser state.
  const fresh = new Client(baseUrl)
  await performLogin(fresh, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const afterRelogin = await fresh.req('/api/security/settings')
  assert.deepEqual(afterRelogin.data.settings, saved.data.settings)
})

test('one account cannot change another account settings', async () => {
  const user = new Client(baseUrl)
  await performLogin(user, DEMO_USER.username, DEMO_USER.password)

  const mine = await user.req('/api/security/settings')
  // The admin above moved to 30/7d/any/false; this account must be untouched.
  assert.deepEqual(mine.data.settings, DEFAULTS)
})

// ── Bounded values ───────────────────────────────────────────────────────────

const REJECTED = [
  // ⚠️ 1 is now ACCEPTED (SECURITY-2) and has moved to the accepted list in
  //    tests/vaultAutoLockDuration.test.js. 2 stands in for it here: still not a
  //    member of the allowed set, so the fail-closed path is unchanged.
  ['auto-lock out of range', { vaultAutoLockMinutes: 2, shareDefaults: DEFAULTS.shareDefaults }],
  ['auto-lock zero', { vaultAutoLockMinutes: 0, shareDefaults: DEFAULTS.shareDefaults }],
  ['auto-lock negative', { vaultAutoLockMinutes: -1, shareDefaults: DEFAULTS.shareDefaults }],
  ['auto-lock absurdly large', { vaultAutoLockMinutes: 100_000, shareDefaults: DEFAULTS.shareDefaults }],
  ['auto-lock as string', { vaultAutoLockMinutes: '15', shareDefaults: DEFAULTS.shareDefaults }],
  ['auto-lock as boolean', { vaultAutoLockMinutes: true, shareDefaults: DEFAULTS.shareDefaults }],
  ['expiry the share contract does not accept', {
    vaultAutoLockMinutes: 15, shareDefaults: { expiry: '365d', scope: 'zones', requirePassword: true },
  }],
  ['scope the share contract does not accept', {
    vaultAutoLockMinutes: 15, shareDefaults: { expiry: '7d', scope: 'public-internet', requirePassword: true },
  }],
  ['requirePassword as string', {
    vaultAutoLockMinutes: 15, shareDefaults: { expiry: '7d', scope: 'any', requirePassword: 'yes' },
  }],
  ['missing shareDefaults', { vaultAutoLockMinutes: 15 }],
  ['an empty object', {}],
  ['an array instead of an object', []],
]

for (const [label, body] of REJECTED) {
  test(`PATCH /api/security/settings rejects ${label}`, async () => {
    const client = new Client(baseUrl)
    await performLogin(client, DEMO_USER.username, DEMO_USER.password)
    const before = await client.req('/api/security/settings')

    const res = await client.req('/api/security/settings', { method: 'PATCH', body })
    assert.equal(res.status, 400)

    // Rejected means nothing was written — not partially applied.
    const after = await client.req('/api/security/settings')
    assert.deepEqual(after.data.settings, before.data.settings)
  })
}

test('a stored share password is not accepted, kept, or returned', async () => {
  const client = new Client(baseUrl)
  await performLogin(client, DEMO_USER.username, DEMO_USER.password)

  const res = await client.req('/api/security/settings', {
    method: 'PATCH',
    body: {
      vaultAutoLockMinutes: 15,
      shareDefaults: {
        expiry: '7d', scope: 'zones', requirePassword: true,
        password: 'hunter2-should-never-persist',
      },
    },
  })
  assert.equal(res.status, 200)
  assert.equal(JSON.stringify(res.data).includes('hunter2'), false)
  assert.deepEqual(
    Object.keys(res.data.settings.shareDefaults).sort(),
    ['expiry', 'requirePassword', 'scope'],
  )

  const reread = await client.req('/api/security/settings')
  assert.equal(JSON.stringify(reread.data).includes('hunter2'), false)
})

// ── Authorization ────────────────────────────────────────────────────────────

test('security settings require authentication', async () => {
  const anon = new Client(baseUrl)
  assert.equal((await anon.req('/api/security/settings')).status, 401)

  // ⚠️ The mutating route answers 403, not 401, and that ordering is deliberate:
  //    csrfProtection runs ahead of requireAuth, so a cross-origin write is refused
  //    before the app discloses whether the caller is signed in. Asserting 401 here
  //    would be asserting that the CSRF gate had been moved behind authentication.
  assert.equal((await anon.req('/api/security/settings', {
    method: 'PATCH', body: DEFAULTS,
  })).status, 403)
})

// ── Security activity ────────────────────────────────────────────────────────

test('GET /api/audit/me is self-scoped and returns no raw audit rows', async () => {
  const user = new Client(baseUrl)
  await performLogin(user, DEMO_USER.username, DEMO_USER.password)

  const res = await user.req('/api/audit/me')
  assert.equal(res.status, 200)

  const activity = res.data.activity
  // A successful login just happened, so the ledger has it.
  assert.ok(activity.lastLoginAt, 'expected the real login event to be reported')
  assert.equal(typeof activity.deniedLoginCount, 'number')
  assert.equal(typeof activity.blockedActionCount, 'number')

  // Summary only: no rows, no IPs, no hashed targets, no other actors.
  assert.equal(Array.isArray(res.data.events), false)
  const serialized = JSON.stringify(res.data)
  assert.doesNotMatch(serialized, /sourceIp|source_ip|targetHash|target_hash|actorLabel/)
  assert.doesNotMatch(serialized, new RegExp(DEMO_ADMIN.username))
})

test('the full audit ledger stays Admin-only while /audit/me does not', async () => {
  const user = new Client(baseUrl)
  await performLogin(user, DEMO_USER.username, DEMO_USER.password)
  assert.equal((await user.req('/api/audit')).status, 403)
  assert.equal((await user.req('/api/audit/me')).status, 200)

  const anon = new Client(baseUrl)
  assert.equal((await anon.req('/api/audit/me')).status, 401)
})

// ── Sign out other sessions ──────────────────────────────────────────────────

test('sign out other sessions revokes the others and keeps the caller signed in', async () => {
  const first = new Client(baseUrl)
  await performLogin(first, DEMO_USER.username, DEMO_USER.password)
  const second = new Client(baseUrl)
  await performLogin(second, DEMO_USER.username, DEMO_USER.password)
  const third = new Client(baseUrl)
  await performLogin(third, DEMO_USER.username, DEMO_USER.password)

  const before = await third.req('/api/sessions')
  assert.ok(before.data.sessions.length >= 3, 'expected three live sessions for this account')

  const res = await third.req('/api/sessions/revoke-others', { method: 'POST' })
  assert.equal(res.status, 200)
  assert.ok(res.data.revoked >= 2, `expected at least two revocations, got ${res.data.revoked}`)

  // The caller survives.
  assert.equal((await third.req('/api/me')).status, 200)
  // The others do not.
  assert.equal((await first.req('/api/me')).status, 401)
  assert.equal((await second.req('/api/me')).status, 401)

  const after = await third.req('/api/sessions')
  assert.equal(after.data.sessions.length, 1)
  assert.equal(after.data.sessions[0].current, true)
})

test('sign out other sessions never touches another account sessions', async () => {
  const admin = new Client(baseUrl)
  await performLogin(admin, DEMO_ADMIN.username, DEMO_ADMIN.password)
  const victim = new Client(baseUrl)
  await performLogin(victim, DEMO_USER.username, DEMO_USER.password)

  const res = await admin.req('/api/sessions/revoke-others', { method: 'POST' })
  assert.equal(res.status, 200)

  // A different account session is untouched by an Admin bulk revoke.
  assert.equal((await victim.req('/api/me')).status, 200)
})

test('sign out other sessions is refused without a session', async () => {
  // 403 for the same reason as above — the CSRF gate is in front of requireAuth.
  const anon = new Client(baseUrl)
  assert.equal((await anon.req('/api/sessions/revoke-others', { method: 'POST' })).status, 403)
})
