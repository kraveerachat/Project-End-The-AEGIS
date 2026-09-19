// tests/vaultTreePostgres.test.js — AEGIS Drive (IDEA1) · PR #157 · opaque tree store against PostgreSQL 15
//
// ⚠️ ชุดนี้พิสูจน์สิ่งที่โหมดหน่วยความจำพิสูจน์ไม่ได้: migration เพิ่มอย่างเดียว/รันซ้ำได้, GRANT ของ drive_app,
//    CHECK/trigger ที่ฐานข้อมูลบังคับเอง (state invariants, revision immutability), และการแข่ง CAS
//    ข้าม connection จริง
// ⚠️ ต้องรันกับฐานข้อมูลแบบใช้แล้วทิ้งจาก scripts/pg-integration-env.sh (postgres:15-alpine) —
//    POSTGRES_REQUIRED_MAJOR=15: PG-VERSION-1 ล้มทั้งไฟล์ถ้า major ไม่ใช่ 15
//    ไม่ตั้ง TEST_DATABASE_URL = ข้ามทั้งไฟล์และบันทึกตามตรงว่าไม่ได้ตรวจ
// ⚠️ หนึ่งฐานข้อมูลต่อไฟล์: สร้างจาก TEMPLATE aegis_drive_test ด้วย AEGIS_PGTEST_SUPER_URL แล้วลบใน after
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_URL = process.env.TEST_DATABASE_URL
const SUPER_URL = process.env.AEGIS_PGTEST_SUPER_URL
const skip = TEST_URL ? false : 'ต้องตั้ง TEST_DATABASE_URL เพื่อรันกับ PostgreSQL 15 จริง (ดู scripts/pg-integration-env.sh)'
const POSTGRES_REQUIRED_MAJOR = 15

// ── per-file database ────────────────────────────────────────────────────────
let dbName = null, dbUrl = TEST_URL, superPool = null
if (!skip && SUPER_URL) {
  superPool = new pg.Pool({ connectionString: SUPER_URL, max: 2 })
  dbName = `aegis_drive_tree_${Date.now().toString(36)}`
  const template = new URL(TEST_URL).pathname.slice(1)
  await superPool.query(`CREATE DATABASE ${dbName} TEMPLATE ${template}`)
  await superPool.query(`REVOKE CONNECT ON DATABASE ${dbName} FROM PUBLIC`)
  await superPool.query(`GRANT CONNECT ON DATABASE ${dbName} TO drive_app`)
  const u = new URL(TEST_URL); u.pathname = '/' + dbName; dbUrl = u.toString()
}
process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
if (!skip) process.env.DATABASE_URL = dbUrl
else delete process.env.DATABASE_URL

const store = await import('../server/db/vaultTreeStore.js')
const { usingPostgres, closePool, createUserWithTempPassword, getUserByUsername } = await import('../server/db/connection.js')
const { ROLES } = await import('../server/rbac/permissions.js')
const { defineStoreSpec, seedTree, stageRevision, envelopeFixture, ID } = await import('./helpers/vaultTreeStoreSpec.mjs')

const MIGRATION = path.join(ROOT, 'server/db/migrations/011_vault_tree_v1.sql')
const SCHEMA = path.join(ROOT, 'server/db/schema.sql')
const TREE_TABLES = ['vault_tree_state', 'vault_tree_frozen_inventory', 'vault_tree_key_envelope', 'vault_tree_heads', 'vault_tree_revisions', 'vault_tree_blob_state', 'vault_tree_purge_candidates']

let app = null, superDb = null // app = drive_app pool for direct SQL; superDb = admin pool on the per-file db
let USER_A, USER_B

before(async () => {
  if (skip) return
  assert.equal(usingPostgres, true)
  app = new pg.Pool({ connectionString: dbUrl, max: 6 })
  if (SUPER_URL) { const u = new URL(SUPER_URL); u.pathname = '/' + (dbName ?? new URL(TEST_URL).pathname.slice(1)); superDb = new pg.Pool({ connectionString: u.toString(), max: 2 }) }
  USER_A = String((await getUserByUsername('user')).id)
  USER_B = String((await getUserByUsername('admin')).id)
})
after(async () => {
  if (skip) return
  await app?.end(); await superDb?.end()
  await closePool()
  if (superPool && dbName) { await superPool.query(`DROP DATABASE ${dbName} WITH (FORCE)`); await superPool.end() }
})

test('PG-VERSION-1 server major version is 15 (POSTGRES_REQUIRED_MAJOR=15)', { skip }, async () => {
  const { rows } = await app.query(`SELECT current_setting('server_version_num') AS n, version() AS v`)
  const num = Number(rows[0].n)
  assert.ok(num >= 150000 && num < 160000, `POSTGRES_REQUIRED_MAJOR=${POSTGRES_REQUIRED_MAJOR} but server_version_num=${num} (${rows[0].v})`)
  console.log(`[vault tree pg tests] ${rows[0].v}`)
})

test('PG-SCHEMA-EQ-1 the DDL block in 011_vault_tree_v1.sql equals the block appended to schema.sql', { skip }, () => {
  const mig = fs.readFileSync(MIGRATION, 'utf8')
  const schema = fs.readFileSync(SCHEMA, 'utf8')
  const norm = (s) => s.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean).join('\n')
  const migBlock = mig.slice(mig.indexOf('-- ── Owner protocol state'), mig.indexOf('-- ── Scoped application DML'))
  const schemaBlock = schema.slice(schema.indexOf('-- ── Owner protocol state'))
  assert.equal(norm(schemaBlock), norm(migBlock))
  assert.ok(migBlock.includes('CREATE TRIGGER vault_tree_revisions_immutable'))
  assert.doesNotMatch(mig, /ALTER TABLE (vault_meta|vault_blobs|vault_v2_)/, 'migration is additive')
})

test('PG-REAPPLY-1 applying migration 011 twice on a database built from schema.sql is a no-op', { skip: skip || (!SUPER_URL && 'needs AEGIS_PGTEST_SUPER_URL') }, async () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8')
  const snapshot = async () => {
    const cols = await superDb.query(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name LIKE 'vault_tree_%' ORDER BY table_name, ordinal_position`)
    const cons = await superDb.query(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid::regclass::text LIKE 'vault_tree_%' ORDER BY 1, 2`)
    const idx = await superDb.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename LIKE 'vault_tree_%' ORDER BY 1`)
    const trg = await superDb.query(`SELECT tgname, tgrelid::regclass::text AS t FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text LIKE 'vault_tree_%' ORDER BY 1`)
    return JSON.stringify({ cols: cols.rows, cons: cons.rows, idx: idx.rows, trg: trg.rows })
  }
  const before0 = await snapshot()
  await superDb.query(sql)
  const after1 = await snapshot()
  await superDb.query(sql)
  const after2 = await snapshot()
  assert.equal(after1, before0); assert.equal(after2, before0)
  assert.equal(JSON.parse(before0).cols.length > 60, true)
})

test('PG-GRANT-1 drive_app has DML on every tree table and cannot create tables', { skip }, async () => {
  for (const t of TREE_TABLES) {
    const { rows } = await app.query(`SELECT has_table_privilege('drive_app', $1, 'SELECT') s, has_table_privilege('drive_app', $1, 'INSERT') i, has_table_privilege('drive_app', $1, 'UPDATE') u, has_table_privilege('drive_app', $1, 'DELETE') d`, [t])
    assert.deepEqual(rows[0], { s: true, i: true, u: true, d: true }, t)
  }
  await assert.rejects(app.query('CREATE TABLE vault_tree_should_not_exist (id int)'), /permission denied/)
  await assert.rejects(app.query('TRUNCATE vault_tree_state'), /permission denied/)
})

test('PG-CHECK-1 every CHECK constraint rejects the listed invalid values', { skip }, async () => {
  await store.__resetVaultTreeForTests()
  const rejects = (sql, params, re = /check|violat/i) => assert.rejects(app.query(sql, params), re, sql.slice(0, 60))
  await rejects(`INSERT INTO vault_tree_state (user_id, protocol_state) VALUES ($1, 'PLAIN')`, [USER_A])
  await rejects(`INSERT INTO vault_tree_blob_state (user_id, blob_format_version, blob_id, lifecycle) VALUES ($1, 2, 'x', 'DELETED')`, [USER_A])
  await rejects(`INSERT INTO vault_tree_blob_state (user_id, blob_format_version, blob_id, lifecycle) VALUES ($1, 3, 'x', 'UNREFERENCED')`, [USER_A])
  await rejects(`INSERT INTO vault_tree_revisions (revision_id, user_id, tree_id, generation, manifest_schema_version, iv_b64, wrapped_manifest_dek_b64, wrap_iv_b64, state, idempotency_key) VALUES ('r', $1, 't', 0, 1, 'iv', 'w', 'wi', 'CREATED', 'k')`, [USER_A])
  await rejects(`INSERT INTO vault_tree_revisions (revision_id, user_id, tree_id, generation, manifest_schema_version, iv_b64, wrapped_manifest_dek_b64, wrap_iv_b64, state, idempotency_key) VALUES ('r', $1, 't', 1, 1, 'iv', 'w', 'wi', 'BOGUS', 'k')`, [USER_A])
  await rejects(`INSERT INTO vault_tree_key_envelope (user_id, tree_id, owner_scope_id_b64, primary_wrapped_trk_b64, primary_wrap_iv_b64, recovery_wrapped_trk_b64, recovery_wrap_iv_b64) VALUES ($1, 't', 'o', 'a', 'same-iv', 'b', 'same-iv')`, [USER_A])
  await rejects(`INSERT INTO vault_tree_purge_candidates (purge_id, user_id, barrier_generation, blob_format_version, blob_id, state, confirmable_at) VALUES ('p', $1, 0, 2, 'x', 'RETENTION_WAIT', now())`, [USER_A])
})

async function insertState(user, fields) {
  const cols = Object.keys(fields)
  await app.query(`INSERT INTO vault_tree_state (user_id, ${cols.join(', ')}) VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`, [user, ...Object.values(fields)])
}
const MIG = { migration_lease_id: 'lease', migration_lease_expires_at: new Date(Date.now() + 60_000), frozen_inventory_id: 'inv', frozen_inventory_digest: 'd'.repeat(64) }

test('PG-STATE-1 valid FLAT row accepted', { skip }, async () => {
  await store.__resetVaultTreeForTests()
  await insertState(USER_A, { protocol_state: 'FLAT', head_ever_committed: false })
})
test('PG-STATE-2 valid MIGRATING_TREE_V1 row accepted', { skip }, async () => {
  await store.__resetVaultTreeForTests()
  await insertState(USER_A, { protocol_state: 'MIGRATING_TREE_V1', head_ever_committed: false, ...MIG })
})
test('PG-STATE-3 valid TREE_V1 row accepted', { skip }, async () => {
  await store.__resetVaultTreeForTests()
  await insertState(USER_A, { protocol_state: 'TREE_V1', head_ever_committed: true })
})
test('PG-STATE-4 mixed state/lease combinations are rejected', { skip }, async () => {
  const cases = [
    { protocol_state: 'FLAT', migration_lease_id: 'lease' },
    { protocol_state: 'FLAT', head_ever_committed: true },
    { protocol_state: 'MIGRATING_TREE_V1', ...MIG, migration_lease_id: null },
    { protocol_state: 'MIGRATING_TREE_V1', ...MIG, migration_lease_expires_at: null },
    { protocol_state: 'MIGRATING_TREE_V1', ...MIG, frozen_inventory_id: null },
    { protocol_state: 'MIGRATING_TREE_V1', ...MIG, frozen_inventory_digest: null },
    { protocol_state: 'MIGRATING_TREE_V1', ...MIG, head_ever_committed: true },
    { protocol_state: 'TREE_V1', head_ever_committed: true, migration_lease_id: 'lease' },
    { protocol_state: 'TREE_V1', head_ever_committed: true, frozen_inventory_id: 'inv' },
    { protocol_state: 'TREE_V1', head_ever_committed: true, frozen_inventory_digest: 'd'.repeat(64) },
    { protocol_state: 'TREE_V1', head_ever_committed: true, migration_lease_expires_at: new Date() },
    { protocol_state: 'TREE_V1', head_ever_committed: false },
    { protocol_state: 'UNKNOWN', head_ever_committed: false },
  ]
  for (const c of cases) {
    await store.__resetVaultTreeForTests()
    await assert.rejects(insertState(USER_A, c), /vault_tree_state_invariants|protocol_state/, JSON.stringify(c))
  }
})

async function committedFixture() {
  await store.__resetVaultTreeForTests()
  const { treeId, rootRevision } = await seedTree(store, USER_A)
  await stageRevision(store, USER_A, { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: ID(902), key: ID(2, 'K') })
  assert.equal((await store.casHead(USER_A, { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(902), idempotencyKey: ID(2, 'K') })).ok, true)
  return { treeId, rootRevision, head: ID(902) }
}
const immutable = /immutable|not allowed|identity/

test('PG-IMMUTABLE-1 committed revision cannot change iv; delete of HEAD_COMMITTED raises; delete of ORPHANED succeeds', { skip }, async () => {
  const { rootRevision, head, treeId } = await committedFixture()
  await assert.rejects(app.query(`UPDATE vault_tree_revisions SET iv_b64 = 'iv-changed000000' WHERE revision_id = $1`, [head]), immutable)
  await assert.rejects(app.query(`DELETE FROM vault_tree_revisions WHERE revision_id = $1`, [head]), /delete forbidden/)
  await stageRevision(store, USER_A, { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: ID(903), key: ID(3, 'K') })
  assert.equal((await store.casHead(USER_A, { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: ID(903), idempotencyKey: ID(3, 'K') })).code, 'TREE_HEAD_CONFLICT')
  const { rowCount } = await app.query(`DELETE FROM vault_tree_revisions WHERE revision_id = $1`, [ID(903)])
  assert.equal(rowCount, 1)
})

test('PG-IMMUTABLE-2 storage_key cannot change on PUBLISHED, HEAD_COMMITTED or SUPERSEDED', { skip }, async () => {
  const { rootRevision, head, treeId } = await committedFixture()
  await stageRevision(store, USER_A, { treeId, baseRevisionId: head, generation: 3, revisionId: ID(904), key: ID(4, 'K') })
  for (const id of [ID(904), head, rootRevision]) {
    await assert.rejects(app.query(`UPDATE vault_tree_revisions SET storage_key = 'vault-tree/moved.aegisenc' WHERE revision_id = $1`, [id]), immutable, id)
  }
})

test('PG-IMMUTABLE-3 ciphertext_size/sha256 and every identity column are frozen after PUBLISHED', { skip }, async () => {
  const { head } = await committedFixture()
  const attempts = [
    [`ciphertext_size = 999`], [`ciphertext_sha256 = '${'e'.repeat(64)}'`], [`tree_id = 'other'`], [`revision_id = 'other'`],
    [`base_revision_id = 'other'`], [`generation = 9`], [`manifest_schema_version = 2`], [`wrapped_manifest_dek_b64 = 'x'`],
    [`wrap_iv_b64 = 'x'`], [`idempotency_key = 'x'`], [`published_at = now()`],
  ]
  for (const [set] of attempts) await assert.rejects(app.query(`UPDATE vault_tree_revisions SET ${set} WHERE revision_id = $1`, [head]), immutable, set)
})

test('PG-IMMUTABLE-4 CREATED → PUBLISHED sets the identity exactly once; a second attempt or a partial/extra change raises', { skip }, async () => {
  await store.__resetVaultTreeForTests()
  const { treeId, rootRevision } = await seedTree(store, USER_A)
  const r = await store.createRevision(USER_A, { revisionId: ID(905), treeId, baseRevisionId: rootRevision, generation: 2, manifestSchemaVersion: 1, ivB64: 'iv00000000000005', wrappedManifestDekB64: 'w', wrapIvB64: 'iv00000000000105', idempotencyKey: ID(5, 'K') })
  assert.equal(r.ok, true)
  // partial publish (no sha) raises; publish that also touches generation raises
  await assert.rejects(app.query(`UPDATE vault_tree_revisions SET state = 'PUBLISHED', storage_key = 'k', ciphertext_size = 1, published_at = now() WHERE revision_id = $1`, [ID(905)]), /full identity|published_has_identity/)
  await assert.rejects(app.query(`UPDATE vault_tree_revisions SET state = 'PUBLISHED', storage_key = 'k', ciphertext_size = 1, ciphertext_sha256 = '${'f'.repeat(64)}', published_at = now(), generation = 7 WHERE revision_id = $1`, [ID(905)]), immutable)
  const pub = await store.markRevisionPublished(USER_A, ID(905), { storageKey: 'vault-tree/905.aegisenc', ciphertextSize: 4112, sha256: 'f'.repeat(64) })
  assert.equal(pub.ok, true)
  // second publish, even with identical values, raises (state is no longer CREATED → identity frozen path)
  await assert.rejects(app.query(`UPDATE vault_tree_revisions SET storage_key = 'vault-tree/905.aegisenc', ciphertext_size = 4113 WHERE revision_id = $1`, [ID(905)]), immutable)
  const again = await store.markRevisionPublished(USER_A, ID(905), { storageKey: 'vault-tree/905.aegisenc', ciphertextSize: 4112, sha256: 'f'.repeat(64) })
  assert.equal(again.ok, false); assert.equal(again.code, 'TREE_REVISION_NOT_PUBLISHED')
})

test('PG-IMMUTABLE-5 allowed state-only transitions work; disallowed edges raise', { skip }, async () => {
  const { rootRevision, head, treeId } = await committedFixture()
  // HEAD_COMMITTED(902) ← head; rootRevision is SUPERSEDED
  await app.query(`UPDATE vault_tree_revisions SET state = 'NON_RECOVERABLE', retired_at = now() WHERE revision_id = $1`, [rootRevision])
  await app.query(`UPDATE vault_tree_revisions SET state = 'FORENSIC_DELETED', retired_at = now() WHERE revision_id = $1`, [rootRevision])
  await assert.rejects(app.query(`UPDATE vault_tree_revisions SET state = 'PUBLISHED' WHERE revision_id = $1`, [head]), /not allowed/)
  await stageRevision(store, USER_A, { treeId, baseRevisionId: head, generation: 3, revisionId: ID(906), key: ID(6, 'K') })
  await app.query(`UPDATE vault_tree_revisions SET state = 'ORPHANED', retired_at = now() WHERE revision_id = $1`, [ID(906)])
  await assert.rejects(app.query(`UPDATE vault_tree_revisions SET state = 'HEAD_COMMITTED', committed_at = now() WHERE revision_id = $1`, [ID(906)]), /not allowed/)
  // same-state no-op is allowed; changing committed_at outside the PUBLISHED→HEAD_COMMITTED edge is not
  await app.query(`UPDATE vault_tree_revisions SET state = 'HEAD_COMMITTED' WHERE revision_id = $1`, [head])
  await assert.rejects(app.query(`UPDATE vault_tree_revisions SET committed_at = now() WHERE revision_id = $1`, [head]), /not allowed/)
  await assert.rejects(app.query(`UPDATE vault_tree_revisions SET state = 'SUPERSEDED' WHERE revision_id = $1`, [rootRevision]), /not allowed/, 'FORENSIC_DELETED never goes back')
})

test('PG-CAS-RACE-1 two connections race the same expectedGeneration → exactly one wins, loser ORPHANED (20×)', { skip }, async () => {
  for (let i = 0; i < 20; i++) {
    await store.__resetVaultTreeForTests()
    const { treeId, rootRevision } = await seedTree(store, USER_A)
    const a = ID(1000 + i * 2, 'B'), b = ID(1001 + i * 2, 'B')
    await stageRevision(store, USER_A, { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: a, key: ID(10 + i * 2, 'K') })
    await stageRevision(store, USER_A, { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: b, key: ID(11 + i * 2, 'K') })
    const [ra, rb] = await Promise.all([
      store.casHead(USER_A, { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: a, idempotencyKey: ID(10 + i * 2, 'K') }),
      store.casHead(USER_A, { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: b, idempotencyKey: ID(11 + i * 2, 'K') }),
    ])
    assert.equal([ra, rb].filter((r) => r.ok).length, 1, `iteration ${i}: ${JSON.stringify([ra, rb])}`)
    const loser = ra.ok ? rb : ra
    assert.equal(loser.code, 'TREE_HEAD_CONFLICT')
    const head = await store.getHead(USER_A)
    assert.equal(head.generation, 2); assert.equal(head.revisionId, ra.ok ? a : b)
    assert.equal((await store.getRevision(USER_A, ra.ok ? b : a)).state, 'ORPHANED')
  }
})

test('PG-CAS-RACE-2 two connections race attaching the same UNREFERENCED blob → one wins, other TREE_BLOB_STATE_CONFLICT', { skip }, async () => {
  for (let i = 0; i < 10; i++) {
    await store.__resetVaultTreeForTests()
    const { treeId, rootRevision } = await seedTree(store, USER_A)
    await store.upsertBlobState(USER_A, { formatVersion: 2, id: 'shared' }, 'UNREFERENCED')
    const a = ID(2000 + i * 2, 'C'), b = ID(2001 + i * 2, 'C')
    await stageRevision(store, USER_A, { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: a, key: ID(30 + i * 2, 'K') })
    await stageRevision(store, USER_A, { treeId, baseRevisionId: rootRevision, generation: 2, revisionId: b, key: ID(31 + i * 2, 'K') })
    const [ra, rb] = await Promise.all([
      store.casHead(USER_A, { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: a, idempotencyKey: ID(30 + i * 2, 'K'), attachBlobRefs: [{ formatVersion: 2, id: 'shared' }] }),
      store.casHead(USER_A, { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: b, idempotencyKey: ID(31 + i * 2, 'K'), attachBlobRefs: [{ formatVersion: 2, id: 'shared' }] }),
    ])
    assert.equal([ra, rb].filter((r) => r.ok).length, 1)
    const loser = ra.ok ? rb : ra
    assert.ok(['TREE_HEAD_CONFLICT', 'TREE_BLOB_STATE_CONFLICT'].includes(loser.code), loser.code)
    assert.equal((await store.listBlobStates(USER_A))[0].lifecycle, 'TREE_MANAGED')
    assert.equal((await store.getHead(USER_A)).generation, 2)
  }
})

test('PG-ENVELOPE-RACE-1 concurrent casKeyEnvelope with the same expected version → one wins', { skip }, async () => {
  await store.__resetVaultTreeForTests()
  await seedTree(store, USER_A)
  const results = await Promise.all([2, 3, 4, 5].map((n) => store.casKeyEnvelope(USER_A, { expectedEnvelopeCasVersion: 1, ...envelopeFixture(n) })))
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal(results.filter((r) => r.code === 'TREE_ENVELOPE_CONFLICT').length, 3)
  assert.equal((await store.getKeyEnvelope(USER_A)).envelopeCasVersion, 2)
})

test('PG-CASCADE-1 deleting the user cascades every tree row', { skip }, async () => {
  await store.__resetVaultTreeForTests()
  const tmp = await createUserWithTempPassword({ username: `treecascade${Date.now().toString(36)}`, displayName: 'Tree Cascade', role: ROLES.USER })
  assert.ok(tmp, 'temp user created')
  const uid = String(tmp.id)
  await seedTree(store, uid, { blobRefs: [{ formatVersion: 2, id: 'cascade-blob' }] })
  await app.query(`INSERT INTO vault_tree_frozen_inventory (user_id, frozen_inventory_id, blob_format_version, blob_id) VALUES ($1, 'inv', 2, 'x')`, [uid])
  await app.query(`INSERT INTO vault_tree_purge_candidates (purge_id, user_id, barrier_generation, blob_format_version, blob_id, state, confirmable_at) VALUES ('p', $1, 1, 2, 'x', 'RETENTION_WAIT', now())`, [uid])
  // committed revisions block DELETE by trigger; cascade from users must still succeed because the FK cascade deletes rows — prove it
  await app.query(`DELETE FROM users WHERE id = $1`, [uid])
  for (const t of TREE_TABLES) {
    const { rows } = await app.query(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = $1`, [uid])
    assert.equal(rows[0].n, 0, t)
  }
})

// ── PG-MG-1..5: migration lease / frozen inventory / genesis against real transactions ──
// V1 blob rows are inserted directly (drive_app DML) — the legacy route is fenced and this file has no HTTP client here
const insertV1Blob = async (userId, tag) => {
  const { rows } = await app.query(
    `INSERT INTO vault_blobs (user_id, storage_key, iv_b64, wrapped_dek_b64, wrap_iv_b64, meta_iv_b64, meta_b64, size_bytes) VALUES ($1, $2, 'aXY=', 'ZGVr', 'aXY=', 'aXY=', 'bWV0YQ==', 3) RETURNING id`,
    [userId, `vault/pg-mg-${tag}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.aegisenc`],
  )
  return String(rows[0].id)
}
const stateRow = async (userId) => (await app.query(`SELECT * FROM vault_tree_state WHERE user_id = $1`, [userId])).rows[0]
const countRows = async (table, userId) => (await app.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [userId])).rows[0].n
const resetMigration = async (userId) => { await store.__resetVaultTreeForTests(); await app.query(`DELETE FROM vault_blobs WHERE user_id = $1`, [userId]) }
const LEASE_MS = 60_000
const stageGenesis = async (userId, { treeId, revisionId, key }) => {
  await stageRevision(store, userId, { treeId, baseRevisionId: null, generation: 1, revisionId, key })
}
const genesisArgs = (lease, { treeId, revisionId, key, n = 7 }) => ({
  leaseId: lease.leaseId, epoch: lease.epoch, frozenInventoryId: lease.frozenInventoryId, treeId, ownerScopeIdB64: ID(n, 'S'),
  keyEnvelope: envelopeFixture(n), revisionId, idempotencyKey: key,
})

test('PG-MG-1 two connections race beginMigration from FLAT → exactly one lease; loser writes no frozen rows (10×)', { skip }, async () => {
  for (let i = 0; i < 10; i++) {
    await resetMigration(USER_A)
    const ids = [await insertV1Blob(USER_A, `race${i}a`), await insertV1Blob(USER_A, `race${i}b`)]
    const inventory = ids.map((id) => ({ formatVersion: 1, id }))
    const [ra, rb] = await Promise.all([
      store.beginMigration(USER_A, { leaseMs: LEASE_MS, inventory }),
      store.beginMigration(USER_A, { leaseMs: LEASE_MS, inventory }),
    ])
    assert.equal([ra, rb].filter((r) => r.ok).length, 1, `iteration ${i}: ${JSON.stringify([ra, rb])}`)
    const winner = ra.ok ? ra : rb, loser = ra.ok ? rb : ra
    assert.equal(loser.code, 'TREE_STATE_CONFLICT')
    const st = await stateRow(USER_A)
    assert.equal(st.protocol_state, 'MIGRATING_TREE_V1'); assert.equal(st.migration_lease_id, winner.leaseId); assert.equal(Number(st.migration_lease_epoch), 1)
    assert.equal(st.frozen_inventory_id, winner.frozenInventoryId)
    const { rows } = await app.query(`SELECT DISTINCT frozen_inventory_id FROM vault_tree_frozen_inventory WHERE user_id = $1`, [USER_A])
    assert.deepEqual(rows.map((r) => r.frozen_inventory_id), [winner.frozenInventoryId], 'only the winning lease left frozen rows')
    assert.equal(await countRows('vault_tree_frozen_inventory', USER_A), 2)
  }
})

test('PG-MG-2 expired lease taken over: old holder and new holder race genesis → only the new epoch commits; old → TREE_LEASE_STALE', { skip }, async () => {
  await resetMigration(USER_A)
  const id = await insertV1Blob(USER_A, 'takeover')
  const old = await store.beginMigration(USER_A, { leaseMs: LEASE_MS, inventory: [{ formatVersion: 1, id }] })
  assert.equal(old.ok, true)
  const treeId = ID(50, 'T')
  await stageGenesis(USER_A, { treeId, revisionId: ID(51, 'R'), key: ID(51, 'K') })
  await stageGenesis(USER_A, { treeId, revisionId: ID(52, 'R'), key: ID(52, 'K') })
  assert.equal((await store.takeoverMigration(USER_A, { leaseMs: LEASE_MS })).code, 'TREE_LEASE_HELD', 'takeover refused while the lease is live')
  await store.__expireLeaseForTests(USER_A)
  const taken = await store.takeoverMigration(USER_A, { leaseMs: LEASE_MS })
  assert.equal(taken.ok, true); assert.equal(taken.epoch, 2); assert.equal(taken.frozenInventoryId, old.frozenInventoryId)
  // both holders now attempt genesis concurrently (each with its own staged generation-1 revision)
  const [rOld, rNew] = await Promise.all([
    store.commitGenesis(USER_A, genesisArgs(old, { treeId, revisionId: ID(51, 'R'), key: ID(51, 'K'), n: 8 })),
    store.commitGenesis(USER_A, genesisArgs(taken, { treeId, revisionId: ID(52, 'R'), key: ID(52, 'K'), n: 9 })),
  ])
  assert.equal(rOld.ok, false); assert.equal(rOld.code, 'TREE_LEASE_STALE')
  assert.equal(rNew.ok, true, JSON.stringify(rNew)); assert.equal(rNew.replay, false)
  const head = await store.getHead(USER_A)
  assert.equal(head.revisionId, ID(52, 'R')); assert.equal(head.generation, 1)
  assert.equal((await store.getRevision(USER_A, ID(51, 'R'))).state, 'PUBLISHED', 'the stale holder revision is untouched (orphan sweep retires it later)')
  const st = await stateRow(USER_A)
  assert.equal(st.protocol_state, 'TREE_V1'); assert.equal(Number(st.migration_lease_epoch), 2, 'epoch history retained')
  // a late attempt by the old holder after TREE_V1 is a conflict, never a second genesis
  const late = await store.commitGenesis(USER_A, genesisArgs(old, { treeId, revisionId: ID(51, 'R'), key: ID(51, 'K'), n: 8 }))
  assert.equal(late.code, 'TREE_STATE_CONFLICT')
})

test('PG-MG-3 injected failure after the envelope insert aborts the whole genesis: no envelope, head, blob-state or state change; frozen rows intact', { skip: skip || (!superDb && 'ต้องมี AEGIS_PGTEST_SUPER_URL เพื่อติดตั้ง trigger จำลอง crash') }, async () => {
  await resetMigration(USER_A)
  const id = await insertV1Blob(USER_A, 'crash')
  const lease = await store.beginMigration(USER_A, { leaseMs: LEASE_MS, inventory: [{ formatVersion: 1, id }] })
  const treeId = ID(60, 'T')
  await stageGenesis(USER_A, { treeId, revisionId: ID(61, 'R'), key: ID(61, 'K') })
  const before = await stateRow(USER_A)
  // crash point: the head insert (after the envelope insert and the revision HEAD_COMMITTED update, before the state update)
  await superDb.query(`CREATE OR REPLACE FUNCTION pg_mg3_crash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PG-MG-3 injected crash'; END $$`)
  await superDb.query(`CREATE TRIGGER pg_mg3_crash BEFORE INSERT ON vault_tree_heads FOR EACH ROW EXECUTE FUNCTION pg_mg3_crash()`)
  try {
    await assert.rejects(store.commitGenesis(USER_A, genesisArgs(lease, { treeId, revisionId: ID(61, 'R'), key: ID(61, 'K') })), /PG-MG-3 injected crash/)
  } finally {
    await superDb.query(`DROP TRIGGER IF EXISTS pg_mg3_crash ON vault_tree_heads`)
    await superDb.query(`DROP FUNCTION IF EXISTS pg_mg3_crash()`)
  }
  assert.equal(await countRows('vault_tree_key_envelope', USER_A), 0, 'envelope insert rolled back')
  assert.equal(await countRows('vault_tree_heads', USER_A), 0)
  assert.equal(await countRows('vault_tree_blob_state', USER_A), 0)
  assert.equal(await countRows('vault_tree_frozen_inventory', USER_A), 1, 'frozen rows intact')
  assert.equal((await store.getRevision(USER_A, ID(61, 'R'))).state, 'PUBLISHED', 'revision state update rolled back')
  const after = await stateRow(USER_A)
  assert.deepEqual({ ...after, updated_at: null }, { ...before, updated_at: null }, 'state row unchanged')
  // the same lease still commits once the fault is gone — no partial state was left behind
  const r = await store.commitGenesis(USER_A, genesisArgs(lease, { treeId, revisionId: ID(61, 'R'), key: ID(61, 'K') }))
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal((await stateRow(USER_A)).protocol_state, 'TREE_V1')
})

test('PG-MG-4 a frozen blob deleted directly in SQL (operator action) → genesis TREE_INVENTORY_MISMATCH; a frozen row removed in SQL → mismatch too', { skip }, async () => {
  await resetMigration(USER_A)
  const ids = [await insertV1Blob(USER_A, 'del1'), await insertV1Blob(USER_A, 'del2')]
  const lease = await store.beginMigration(USER_A, { leaseMs: LEASE_MS, inventory: ids.map((id) => ({ formatVersion: 1, id })) })
  const treeId = ID(70, 'T')
  await stageGenesis(USER_A, { treeId, revisionId: ID(71, 'R'), key: ID(71, 'K') })
  await app.query(`DELETE FROM vault_blobs WHERE user_id = $1 AND id = $2`, [USER_A, ids[1]])
  const r = await store.commitGenesis(USER_A, genesisArgs(lease, { treeId, revisionId: ID(71, 'R'), key: ID(71, 'K') }))
  assert.equal(r.ok, false); assert.equal(r.code, 'TREE_INVENTORY_MISMATCH')
  assert.equal((await stateRow(USER_A)).protocol_state, 'MIGRATING_TREE_V1', 'nothing committed')
  assert.equal(await countRows('vault_tree_key_envelope', USER_A), 0)
  // digest check: a frozen row removed out of band no longer matches the digest recorded at begin
  await resetMigration(USER_A)
  const ids2 = [await insertV1Blob(USER_A, 'dig1'), await insertV1Blob(USER_A, 'dig2')]
  const lease2 = await store.beginMigration(USER_A, { leaseMs: LEASE_MS, inventory: ids2.map((id) => ({ formatVersion: 1, id })) })
  await stageGenesis(USER_A, { treeId, revisionId: ID(72, 'R'), key: ID(72, 'K') })
  await app.query(`DELETE FROM vault_tree_frozen_inventory WHERE user_id = $1 AND blob_id = $2`, [USER_A, ids2[0]])
  const r2 = await store.commitGenesis(USER_A, genesisArgs(lease2, { treeId, revisionId: ID(72, 'R'), key: ID(72, 'K') }))
  assert.equal(r2.code, 'TREE_INVENTORY_MISMATCH')
  assert.equal((await stateRow(USER_A)).protocol_state, 'MIGRATING_TREE_V1')
})

test('PG-MG-5 successful genesis leaves zero frozen rows for the consumed id; state row has the four migration fields NULL, epoch retained, head_ever_committed=true', { skip }, async () => {
  await resetMigration(USER_A)
  const ids = [await insertV1Blob(USER_A, 'ok1'), await insertV1Blob(USER_A, 'ok2'), await insertV1Blob(USER_A, 'ok3')]
  const lease = await store.beginMigration(USER_A, { leaseMs: LEASE_MS, inventory: ids.map((id) => ({ formatVersion: 1, id })) })
  const treeId = ID(80, 'T')
  await stageGenesis(USER_A, { treeId, revisionId: ID(81, 'R'), key: ID(81, 'K') })
  assert.equal(await countRows('vault_tree_frozen_inventory', USER_A), 3)
  const r = await store.commitGenesis(USER_A, genesisArgs(lease, { treeId, revisionId: ID(81, 'R'), key: ID(81, 'K') }))
  assert.equal(r.ok, true, JSON.stringify(r))
  const { rows } = await app.query(`SELECT count(*)::int AS n FROM vault_tree_frozen_inventory WHERE user_id = $1 AND frozen_inventory_id = $2`, [USER_A, lease.frozenInventoryId])
  assert.equal(rows[0].n, 0)
  const st = await stateRow(USER_A)
  assert.equal(st.protocol_state, 'TREE_V1'); assert.equal(st.head_ever_committed, true)
  assert.equal(st.migration_lease_id, null); assert.equal(st.migration_lease_expires_at, null); assert.equal(st.frozen_inventory_id, null); assert.equal(st.frozen_inventory_digest, null)
  assert.equal(Number(st.migration_lease_epoch), 1); assert.equal(Number(st.tree_mutation_count), 0)
  const blobs = await store.listBlobStates(USER_A)
  assert.deepEqual(blobs.map((b) => b.id).sort(), ids.sort())
  assert.ok(blobs.every((b) => b.lifecycle === 'TREE_MANAGED' && b.attachedGeneration === 1 && b.formatVersion === 1))
  assert.equal((await store.getRevision(USER_A, ID(81, 'R'))).state, 'HEAD_COMMITTED')
  assert.equal((await store.getKeyEnvelope(USER_A)).envelopeCasVersion, 1)
  // replay with the same key is the same outcome; abandon is refused forever
  const again = await store.commitGenesis(USER_A, genesisArgs(lease, { treeId, revisionId: ID(81, 'R'), key: ID(81, 'K') }))
  assert.equal(again.ok, true); assert.equal(again.replay, true)
  assert.equal((await store.abandonMigration(USER_A, { leaseId: lease.leaseId })).code, 'TREE_ABANDON_FORBIDDEN')
  await app.query(`DELETE FROM vault_blobs WHERE user_id = $1`, [USER_A])
})

defineStoreSpec({ test: (name, fn) => test(name, { skip }, fn), store, userA: () => USER_A, userB: () => USER_B, reset: () => store.__resetVaultTreeForTests() })

// ── PG-API-1..4: the HTTP surface against PostgreSQL (staging → publish → CAS, stale, replay, attach) ──
test('PG-API-1..4 tree API sequences against PostgreSQL', { skip }, async () => {
  const fs = await import('node:fs/promises'); const os = await import('node:os'); const path = await import('node:path')
  const STORAGE_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-tree-pg-api-'))
  process.env.STORAGE_ROOT = STORAGE_ROOT
  process.env.SESSION_SECRET = 'test-only-session-secret-not-used-in-production'
  const { createApp } = await import('../server/app.js')
  const { vaultTreeConfigFromEnv } = await import('../server/config/vaultTreeLimits.js')
  const { initStorage } = await import('../server/storage/fileStore.js')
  const { initVaultManifestStorage } = await import('../server/storage/vaultManifestStore.js')
  const { loginClient, DEMO_USER } = await import('./helpers/testClient.mjs')
  const { randomId, revisionDescriptor, fakeCiphertext } = await import('./helpers/vaultTreeFixtures.mjs')
  await initStorage(); await initVaultManifestStorage()
  await store.__resetVaultTreeForTests()
  const server = createApp({ vaultTreeConfig: vaultTreeConfigFromEnv({ VAULT_TREE_SCHEMA_AVAILABLE: 'true', VAULT_TREE_PROTOCOL_ENABLED: 'true' }) }).listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const c = await loginClient(base, DEMO_USER.username, DEMO_USER.password)
    const { rootRevision } = await seedTree(store, USER_A)
    await store.upsertBlobState(USER_A, { formatVersion: 2, id: 'pgblob' }, 'UNREFERENCED')
    const stage = async (generation, baseRevisionId) => {
      const desc = revisionDescriptor({ generation, baseRevisionId })
      assert.equal((await c.req('/api/vault/tree/revisions', { method: 'POST', body: desc })).status, 201)
      const bytes = fakeCiphertext()
      assert.equal((await c.req(`/api/vault/tree/revisions/${desc.revisionId}/ciphertext`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } })).status, 200)
      return { desc, bytes }
    }
    // PG-API-1 success + GET head + GET revision bytes
    const a = await stage(2, rootRevision)
    const cas = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: a.desc.revisionId, idempotencyKey: a.desc.idempotencyKey, attachBlobIds: [{ formatVersion: 2, id: 'pgblob' }] } })
    assert.equal(cas.status, 200, JSON.stringify(cas.data)); assert.equal(cas.data.generation, 2)
    const head = await c.req('/api/vault/tree/head'); assert.equal(head.data.revisionId, a.desc.revisionId)
    const raw = await fetch(`${base}/api/vault/tree/revisions/${a.desc.revisionId}`, { headers: { cookie: c.cookie } })
    assert.equal(Buffer.from(await raw.arrayBuffer()).equals(Buffer.from(a.bytes)), true)
    assert.equal((await store.listBlobStates(USER_A)).find((b) => b.id === 'pgblob').lifecycle, 'TREE_MANAGED')
    // PG-API-2 stale → 409 + orphan 404
    const b = await stage(2, rootRevision)
    const stale = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: b.desc.revisionId, idempotencyKey: b.desc.idempotencyKey } })
    assert.equal(stale.status, 409); assert.equal(stale.data.currentGeneration, 2)
    assert.equal((await fetch(`${base}/api/vault/tree/revisions/${b.desc.revisionId}`, { headers: { cookie: c.cookie } })).status, 404)
    // PG-API-3 idempotent replay / mismatch
    const again = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: a.desc.revisionId, idempotencyKey: a.desc.idempotencyKey } })
    assert.equal(again.status, 200); assert.equal(again.data.generation, 2)
    const mismatch = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 1, expectedRevisionId: rootRevision, revisionId: a.desc.revisionId, idempotencyKey: randomId() } })
    assert.equal(mismatch.status, 409); assert.equal(mismatch.data.code, 'TREE_IDEMPOTENCY_MISMATCH')
    // PG-API-4 attach conflict rolls back the whole CAS
    const d = await stage(3, a.desc.revisionId)
    const conflict = await c.req('/api/vault/tree/head', { method: 'POST', body: { expectedGeneration: 2, expectedRevisionId: a.desc.revisionId, revisionId: d.desc.revisionId, idempotencyKey: d.desc.idempotencyKey, attachBlobIds: [{ formatVersion: 2, id: 'pgblob' }] } })
    assert.equal(conflict.status, 409); assert.equal(conflict.data.code, 'TREE_BLOB_STATE_CONFLICT')
    assert.equal((await c.req('/api/vault/tree/head')).data.generation, 2)
    assert.equal((await store.getRevision(USER_A, d.desc.revisionId)).state, 'PUBLISHED')
  } finally {
    await new Promise((r) => server.close(r))
    await fs.rm(STORAGE_ROOT, { recursive: true, force: true })
  }
})
