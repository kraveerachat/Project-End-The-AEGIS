import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'

import { Client, DEMO_ADMIN, DEMO_USER, performLogin } from './helpers/testClient.mjs'

const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-preferences-test-'))
const moduleRoot = path.resolve(import.meta.dirname, '..')
process.env.STORAGE_ROOT = storageRoot
process.env.COOKIE_SECURE = 'false'

const { createApp } = await import('../server/app.js')
const { initStorage } = await import('../server/storage/fileStore.js')
const { initVaultStorage } = await import('../server/storage/vaultStore.js')
const { initAvatarStorage } = await import('../server/storage/avatarStore.js')

let server
let baseUrl

test('existing PostgreSQL installations have an idempotent preferences migration', async () => {
  const migration = await fs.readFile(
    path.join(moduleRoot, 'server/db/migrations/002_user_preferences.sql'),
    'utf8',
  )
  assert.match(migration, /BEGIN;/)
  for (const column of ['ui_theme', 'ui_language', 'ui_density']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`))
  }
  assert.match(migration, /COMMIT;/)

  const interfaceStyleMigration = await fs.readFile(
    path.join(moduleRoot, 'server/db/migrations/006_interface_style.sql'),
    'utf8',
  )
  assert.match(interfaceStyleMigration, /BEGIN;/)
  assert.match(interfaceStyleMigration, /ADD COLUMN IF NOT EXISTS ui_interface_style/)
  assert.match(interfaceStyleMigration, /DEFAULT 'classic'/)
  assert.match(interfaceStyleMigration, /IN \('classic', 'neo'\)/)
  assert.match(interfaceStyleMigration, /COMMIT;/)
})

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

test('new accounts receive light, Thai, comfortable, Classic preferences from the server', async () => {
  const client = new Client(baseUrl)
  const login = await performLogin(client, DEMO_ADMIN.username, DEMO_ADMIN.password)

  assert.deepEqual(login.user.preferences, {
    theme: 'light',
    language: 'th',
    density: 'comfortable',
    interfaceStyle: 'classic',
  })
})

test('appearance preferences persist for the authenticated user and ignore a supplied userId', async () => {
  const admin = new Client(baseUrl)
  await performLogin(admin, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const saved = await admin.req('/api/preferences', {
    method: 'PATCH',
    body: { theme: 'dark', language: 'en', density: 'compact', interfaceStyle: 'neo', userId: '2' },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.data.preferences, {
    theme: 'dark',
    language: 'en',
    density: 'compact',
    interfaceStyle: 'neo',
  })

  const me = await admin.req('/api/me')
  assert.equal(me.status, 200)
  assert.deepEqual(me.data.user.preferences, saved.data.preferences)

  const freshAdminSession = new Client(baseUrl)
  const freshAdminLogin = await performLogin(
    freshAdminSession,
    DEMO_ADMIN.username,
    DEMO_ADMIN.password,
  )
  assert.deepEqual(freshAdminLogin.user.preferences, saved.data.preferences)

  const ordinaryUser = new Client(baseUrl)
  const ordinaryLogin = await performLogin(ordinaryUser, DEMO_USER.username, DEMO_USER.password)
  assert.deepEqual(ordinaryLogin.user.preferences, {
    theme: 'light',
    language: 'th',
    density: 'comfortable',
    interfaceStyle: 'classic',
  })
})

test('invalid preference values are rejected without changing the current values', async () => {
  const client = new Client(baseUrl)
  await performLogin(client, DEMO_ADMIN.username, DEMO_ADMIN.password)

  const baseline = await client.req('/api/preferences', {
    method: 'PATCH',
    body: { theme: 'dark', language: 'en', density: 'compact', interfaceStyle: 'neo' },
  })
  assert.equal(baseline.status, 200)

  const rejected = await client.req('/api/preferences', {
    method: 'PATCH',
    body: { theme: 'light', language: 'th', density: 'comfortable', interfaceStyle: 'cyberpunk' },
  })
  assert.equal(rejected.status, 400)

  const me = await client.req('/api/me')
  assert.deepEqual(me.data.user.preferences, {
    theme: 'dark',
    language: 'en',
    density: 'compact',
    interfaceStyle: 'neo',
  })
})
