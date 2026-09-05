// tests/vaultAutoLockDuration.test.js — AEGIS Drive (IDEA1) · SECURITY-2
//
// Two defects are covered here and in tests/vaultAutoLockTimer.test.js.
//
//   1. The 1-minute auto-lock option did not exist, in four places that all have
//      to agree: the Settings control, the server validator, the fresh schema,
//      and the CHECK on databases that already exist.
//   2. The post-lock message was the hard-coded string "Vault re-locked after 10
//      minutes of inactivity." — false for every account not set to 10.
//
// This file covers the contract, the schema, the migration, the Settings control
// and the copy. The timer behaviour and the message the user actually sees live
// in the companion file, which drives the real Vault screen.
import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer, normalizePath } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

import { Client, DEMO_USER, performLogin } from './helpers/testClient.mjs'
import { LANGS, STRINGS, makeT, autoLockUnitKey, autoLockedMessageKey } from '../src/lib/strings.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mockHooksPath = normalizePath(path.join(rootDir, 'tests/fixtures/mockHooks.js'))

const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-autolock-'))
process.env.STORAGE_ROOT = STORAGE_ROOT
process.env.SESSION_SECRET = 'autolock-test-session-secret-not-used-in-production'
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
else delete process.env.DATABASE_URL

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { closePool } = await import('../server/db/connection.js')

/** The set SECURITY-2 makes valid, everywhere. */
const ALLOWED = [1, 5, 10, 15, 30, 60]

let server
let baseUrl
let vite
let Settings

before(async () => {
  await initStorage()
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`

  vite = await createServer({
    configFile: false,
    root: rootDir,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [reactPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    resolve: { alias: [{ find: '../lib/hooks.js', replacement: mockHooksPath }] },
  })
  ;({ Settings } = await vite.ssrLoadModule('/src/screens/Settings.jsx'))
})

after(async () => {
  await vite?.close()
  await new Promise((resolve) => server.close(resolve))
  await closePool()
  await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  delete globalThis.__AEGIS_API_FIXTURES__
})

const settingsBody = (minutes) => ({
  vaultAutoLockMinutes: minutes,
  shareDefaults: { expiry: '24h', scope: 'zones', requirePassword: true },
})

async function saveAutoLock(client, minutes) {
  return client.req('/api/security/settings', { method: 'PATCH', body: settingsBody(minutes) })
}

// ── AUTOLOCK-1 ───────────────────────────────────────────────────────────────

test('AUTOLOCK-1 one minute is accepted by backend validation and read back', async () => {
  const client = new Client(baseUrl)
  await performLogin(client, DEMO_USER.username, DEMO_USER.password)

  const saved = await saveAutoLock(client, 1)
  assert.equal(saved.status, 200)
  assert.equal(saved.data.settings.vaultAutoLockMinutes, 1)

  const reread = await client.req('/api/security/settings')
  assert.equal(reread.data.settings.vaultAutoLockMinutes, 1, 'the value must survive a read-back')
})

// ── AUTOLOCK-2 ───────────────────────────────────────────────────────────────

test('AUTOLOCK-2 two minutes is rejected, and so is everything else outside the set', async () => {
  const client = new Client(baseUrl)
  await performLogin(client, DEMO_USER.username, DEMO_USER.password)
  await saveAutoLock(client, 10) // a known-good starting point

  // 2 is the specific case: adding 1 must NOT have opened the range.
  assert.equal((await saveAutoLock(client, 2)).status, 400, '2 minutes is not a member of the set')

  for (const bad of [0, -1, -60, 3, 7, 45, 61, 100_000, 1.5, 0.5, '1', '15', true, false, null, [], {}]) {
    const res = await saveAutoLock(client, bad)
    assert.equal(res.status, 400, `rejected: ${JSON.stringify(bad)}`)
  }

  // Nothing above was partially applied.
  const after = await client.req('/api/security/settings')
  assert.equal(after.data.settings.vaultAutoLockMinutes, 10)
})

// ── AUTOLOCK-3 ───────────────────────────────────────────────────────────────

test('AUTOLOCK-3 every previously valid duration is still accepted', async () => {
  const client = new Client(baseUrl)
  await performLogin(client, DEMO_USER.username, DEMO_USER.password)

  for (const minutes of ALLOWED) {
    const res = await saveAutoLock(client, minutes)
    assert.equal(res.status, 200, `${minutes} must remain valid`)
    assert.equal(res.data.settings.vaultAutoLockMinutes, minutes)
  }
})

// ── AUTOLOCK-4 ───────────────────────────────────────────────────────────────

test('AUTOLOCK-4 the fresh schema accepts the widened set and still defaults to 10', async () => {
  const sql = await fs.readFile(path.join(rootDir, 'server/db/schema.sql'), 'utf8')
  assert.match(sql, /CHECK \(vault_autolock_minutes IN \(1, 5, 10, 15, 30, 60\)\)/)
  // 1 is an option, never the new default — a fresh account must not start on it.
  assert.match(sql, /vault_autolock_minutes INTEGER NOT NULL DEFAULT 10/)
  assert.doesNotMatch(sql, /vault_autolock_minutes INTEGER NOT NULL DEFAULT 1\b(?!0)/)
})

// ── AUTOLOCK-5 ───────────────────────────────────────────────────────────────

test('AUTOLOCK-5 migration 008 replaces the CHECK without touching the column', async () => {
  const dir = path.join(rootDir, 'server/db/migrations')
  const sql = await fs.readFile(path.join(dir, '008_vault_autolock_1_minute.sql'), 'utf8')
  // Assert the EXECUTABLE SQL, not the file. The header legitimately explains
  // what 007 did (`ALTER TABLE ... ADD COLUMN`) and what this migration
  // deliberately avoids, so a comment must never be able to pass or fail a
  // "does this migration rewrite the column?" check.
  const stripComments = (text) => text.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n')
  const ddl = stripComments(sql)

  assert.match(ddl, /BEGIN;/)
  assert.match(ddl, /COMMIT;/)
  // The widened constraint is added.
  assert.match(ddl, /CHECK \(vault_autolock_minutes IN \(1, 5, 10, 15, 30, 60\)\)/)
  // The old one is dropped by a name looked up in the catalog, not guessed.
  assert.match(ddl, /pg_constraint/)
  assert.match(ddl, /DROP CONSTRAINT %I/)
  assert.match(ddl, /contype = 'c'/, 'the search must be restricted to CHECK constraints')

  // The column itself must survive untouched: no rewrite, no default change, no
  // nullability change, and no data update.
  assert.doesNotMatch(ddl, /DROP COLUMN/i)
  assert.doesNotMatch(ddl, /ADD COLUMN/i)
  assert.doesNotMatch(ddl, /SET DEFAULT/i)
  assert.doesNotMatch(ddl, /DROP DEFAULT/i)
  assert.doesNotMatch(ddl, /SET NOT NULL/i)
  assert.doesNotMatch(ddl, /DROP NOT NULL/i)
  assert.doesNotMatch(ddl, /\bUPDATE\s+users\b/i)
  assert.doesNotMatch(ddl, /\bTRUNCATE\b/i)

  // 007 is deployed and must not have been edited to carry this change.
  const seven = await fs.readFile(path.join(dir, '007_security_settings.sql'), 'utf8')
  const sevenDdl = stripComments(seven)
  assert.match(sevenDdl, /CHECK \(vault_autolock_minutes IN \(5, 10, 15, 30, 60\)\)/)
  assert.doesNotMatch(sevenDdl, /IN \(1, 5, 10, 15, 30, 60\)/)
})

// ── AUTOLOCK-6 / AUTOLOCK-7 ──────────────────────────────────────────────────

const USER = { id: 1, username: 'kla', displayName: 'Kla', accountName: 'Kla' }

function renderSettings(minutes, lang = 'en') {
  const fx = (data) => ({ loading: false, data, error: null })
  globalThis.__AEGIS_API_FIXTURES__ = {
    '/api/sessions': fx({ sessions: [], volatile: true }),
    '/api/security/settings': fx({ settings: settingsBody(minutes) }),
    '/api/storage': fx(null),
    '/api/backup': fx(null),
    '/api/audit/me': fx(null),
    '/api/zones': fx({ zones: [] }),
    '/api/remote-access': fx(null),
  }
  return renderToStaticMarkup(React.createElement(Settings, {
    t: makeT(lang), lang, setLang() {}, theme: 'light', setTheme() {},
    density: 'comfortable', setDensity() {}, interfaceStyle: 'classic',
    onInterfaceStyleChange() {}, role: 'Admin', user: USER, go() {}, onProfileSaved() {},
    initialTab: 'security', placeholderMode: false,
  }))
}

test('AUTOLOCK-6 the Settings control offers 1 minute, worded singular', () => {
  const html = renderSettings(10)
  for (const minutes of ALLOWED) {
    assert.match(
      html,
      new RegExp(`<option[^>]*value="${minutes}"`),
      `${minutes} must be selectable`,
    )
  }
  // Singular at 1, plural elsewhere — never "1 minutes".
  assert.ok(html.includes('>1 minute<'), 'the 1-minute option must read "1 minute"')
  assert.ok(html.includes('>5 minutes<'))
  assert.ok(html.includes('>60 minutes<'))
  assert.equal(html.includes('1 minutes'), false, '"1 minutes" is never acceptable copy')
})

test('AUTOLOCK-7 a saved value of 1 is rendered as the account current setting', () => {
  const html = renderSettings(1)
  // The select is driven from the account value, so the 1-minute option is the
  // selected one after a refresh — not merely present in the list.
  assert.match(html, /<option[^>]*value="1"[^>]*selected/)
  // And the summary line beside the control agrees, in the singular.
  assert.ok(html.includes('1 minute'))
  assert.equal(html.includes('1 minutes'), false)

  // A different saved value selects that one instead, so the assertion above is
  // about the account value rather than about 1 being first in the list.
  const thirty = renderSettings(30)
  assert.match(thirty, /<option[^>]*value="30"[^>]*selected/)
  assert.equal(/<option[^>]*value="1"[^>]*selected/.test(thirty), false)
})

// ── AUTOLOCK-11 ──────────────────────────────────────────────────────────────

test('AUTOLOCK-11 no active auto-lock copy hard-codes a duration', async () => {
  // The message must be a template, not a sentence with a number baked in.
  for (const lang of LANGS) {
    const message = STRINGS[lang].vaultAutoLocked
    assert.ok(message.includes('{n}'), `${lang}.vaultAutoLocked must interpolate the duration`)
    assert.equal(/\b10\b/.test(message), false, `${lang}.vaultAutoLocked must not hard-code 10`)
  }

  // The singular variants are the one legitimate place a literal 1 appears.
  for (const lang of LANGS) {
    assert.match(STRINGS[lang].vaultAutoLockedOne, /1/)
    assert.equal(/\b(5|10|15|30|60)\b/.test(STRINGS[lang].vaultAutoLockedOne), false)
  }

  // And no active source file renders the old fixed sentence.
  const sources = await Promise.all([
    fs.readFile(path.join(rootDir, 'src/screens/Vault.jsx'), 'utf8'),
    fs.readFile(path.join(rootDir, 'src/components/SettingsPanels.jsx'), 'utf8'),
  ])
  for (const source of sources) {
    assert.doesNotMatch(source, /re-locked after 10 minutes/i)
    // The message key must always be chosen through the helper, so a call site
    // cannot quietly go back to a single fixed string.
    assert.equal(/t\('vaultAutoLocked'\)/.test(source), false, "vaultAutoLocked must not be called without a duration")
  }
})

// ── AUTOLOCK-12 ──────────────────────────────────────────────────────────────

test('AUTOLOCK-12 EN, TH and ZH all word the duration correctly', () => {
  const expected = {
    en: { 1: 'Vault re-locked after 1 minute of inactivity.', 5: 'Vault re-locked after 5 minutes of inactivity.' },
    th: { 1: 'ล็อกห้องนิรภัยอัตโนมัติ หลังไม่มีการใช้งาน 1 นาที', 5: 'ล็อกห้องนิรภัยอัตโนมัติ หลังไม่มีการใช้งาน 5 นาที' },
    zh: { 1: '闲置 1 分钟后保险库已自动重新锁定。', 5: '闲置 5 分钟后保险库已自动重新锁定。' },
  }
  for (const lang of LANGS) {
    const t = makeT(lang)
    for (const minutes of [1, 5]) {
      assert.equal(t(autoLockedMessageKey(minutes), { n: minutes }), expected[lang][minutes], `${lang}/${minutes}`)
    }
    // Every allowed duration renders with its own number and no leftover token.
    for (const minutes of ALLOWED) {
      const rendered = t(autoLockedMessageKey(minutes), { n: minutes })
      assert.ok(rendered.includes(String(minutes)), `${lang}/${minutes} must name its own duration`)
      assert.equal(rendered.includes('{n}'), false, `${lang}/${minutes} left an uninterpolated token`)
    }
    // The unit label used by the Settings control follows the same rule.
    assert.equal(t(autoLockUnitKey(1), { n: 1 }).includes('{n}'), false)
    for (const minutes of ALLOWED) {
      assert.ok(t(autoLockUnitKey(minutes), { n: minutes }).includes(String(minutes)), `${lang} unit ${minutes}`)
    }
  }
  // English is the only one of the three that inflects; assert it explicitly so
  // a future edit cannot collapse the singular back into the plural.
  assert.equal(makeT('en')(autoLockUnitKey(1), { n: 1 }), '1 minute')
  assert.equal(makeT('en')(autoLockUnitKey(5), { n: 5 }), '5 minutes')
})
