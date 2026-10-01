// tests/previewIndexStorePostgres.test.js — AEGIS Drive (IDEA1) · D-1 PR-A Task A.3 · preview-index store on PostgreSQL 15
//
// ⚠️ Runs only against the disposable database from scripts/pg-integration-env.sh (drive_app, non-superuser).
//    Without TEST_DATABASE_URL the whole file is skipped and reported honestly as not verified.
// ⚠️ One database per file: created from TEMPLATE aegis_drive_test with AEGIS_PGTEST_SUPER_URL and dropped in after().
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'

const TEST_URL = process.env.TEST_DATABASE_URL
const SUPER_URL = process.env.AEGIS_PGTEST_SUPER_URL
const skip = TEST_URL ? false : 'needs TEST_DATABASE_URL (scripts/pg-integration-env.sh) to run against PostgreSQL 15'

let dbName = null, dbUrl = TEST_URL, superPool = null
if (!skip && SUPER_URL) {
  superPool = new pg.Pool({ connectionString: SUPER_URL, max: 2 })
  dbName = `aegis_drive_pistore_${Date.now().toString(36)}`
  const template = new URL(TEST_URL).pathname.slice(1)
  await superPool.query(`CREATE DATABASE ${dbName} TEMPLATE ${template}`)
  await superPool.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`)
  await superPool.query(`GRANT CONNECT ON DATABASE ${dbName} TO drive_app`)
  const u = new URL(TEST_URL); u.pathname = '/' + dbName; dbUrl = u.toString()
}
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
if (!skip) process.env.DATABASE_URL = dbUrl
else delete process.env.DATABASE_URL

const store = await import('../server/db/vaultPreviewIndexStore.js')
const tree = await import('../server/db/vaultTreeStore.js')
const v2 = await import('../server/db/vaultV2Store.js')
const { usingPostgres, closePool, createUserWithTempPassword } = await import('../server/db/connection.js')
const { ROLES } = await import('../server/rbac/permissions.js')
const { definePreviewIndexStoreSpec } = await import('./helpers/previewIndexStoreSpec.mjs')

before(() => { if (!skip) assert.equal(usingPostgres, true) })
after(async () => {
  if (skip) return
  await closePool()
  if (superPool && dbName) { await superPool.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await superPool.end() }
})

let seq = 0
const newOwner = async () => {
  const u = await createUserWithTempPassword({ username: `pistore${Date.now().toString(36)}${++seq}`, displayName: 'Preview Index Store', role: ROLES.USER })
  assert.ok(u, 'disposable owner created')
  return String(u.id)
}

definePreviewIndexStoreSpec({ test, store, tree, v2, newOwner, skip })
