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

defineStoreSpec({ test: (name, fn) => test(name, { skip }, fn), store, userA: () => USER_A, userB: () => USER_B, reset: () => store.__resetVaultTreeForTests() })
