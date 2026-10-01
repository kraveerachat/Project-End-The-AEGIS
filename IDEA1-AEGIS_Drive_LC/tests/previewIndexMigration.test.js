// tests/previewIndexMigration.test.js — AEGIS Drive (IDEA1) · D-1 PR-A Task A.2 · migration 012
//
// ⚠️ Static checks always run (they read SQL text). PostgreSQL checks need AEGIS_PGTEST_SUPER_URL
//    (scripts/pg-integration-env.sh prints it); each PG test creates and drops its own disposable
//    database and never touches TEST_DATABASE_URL's database or any Production endpoint.
// ⚠️ What is proven here: 012 is additive (three new tables + a widened lifecycle CHECK), rewrites no
//    existing row, is re-runnable, matches schema.sql, grants drive_app no DELETE on the migration path,
//    and its triggers keep generations/blob references immutable and undeletable except by owner cascade.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATION = path.join(ROOT, 'server/db/migrations/012_vault_preview_index_v1.sql')
const MIGRATIONS_DIR = path.join(ROOT, 'server/db/migrations')
const SCHEMA = path.join(ROOT, 'server/db/schema.sql')
const SUPER_URL = process.env.AEGIS_PGTEST_SUPER_URL
const pgSkip = SUPER_URL ? false : 'needs AEGIS_PGTEST_SUPER_URL (scripts/pg-integration-env.sh) to create a disposable database'

const NEW_TABLES = ['vault_preview_index_heads', 'vault_preview_index_generations', 'vault_preview_index_blob_refs']
const SIX = ['UNREFERENCED', 'TREE_MANAGED', 'PURGE_PENDING', 'PURGED', 'INDEX_STAGED', 'INDEX_MANAGED']
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n')
const migrationSql = () => read(MIGRATION)
const ddlBlock = (s) => s.slice(s.indexOf('-- ── D-1 preview index'), s.indexOf('-- ── Scoped application DML') === -1 ? undefined : s.indexOf('-- ── Scoped application DML'))
const norm = (s) => s.split('\n').map((l) => l.replace(/--.*$/, '').trim()).filter(Boolean).join('\n')

test('PI-MIG-1 migration 012 exists, is wrapped in one transaction, and contains no destructive SQL', () => {
  assert.ok(fs.existsSync(MIGRATION), '012_vault_preview_index_v1.sql must exist')
  const sql = norm(migrationSql())
  assert.match(sql, /^BEGIN;/)
  assert.match(sql, /COMMIT;$/)
  for (const bad of [/DROP\s+TABLE/i, /DELETE\s+FROM/i, /TRUNCATE/i, /DROP\s+COLUMN/i, /UPDATE\s+vault_/i, /INSERT\s+INTO/i]) {
    assert.doesNotMatch(sql, bad, `forbidden statement ${bad}`)
  }
  const altered = [...sql.matchAll(/ALTER\s+TABLE\s+(\w+)/gi)].map((m) => m[1])
  assert.ok(altered.length > 0)
  assert.deepEqual([...new Set(altered)], ['vault_tree_blob_state'], 'only the lifecycle CHECK of vault_tree_blob_state may be altered')
  const dropped = [...sql.matchAll(/DROP\s+CONSTRAINT\s+([%\w]+)/gi)].map((m) => m[1])
  assert.deepEqual(dropped, ['%I'], 'the only DROP CONSTRAINT is the definition-matched lifecycle CHECK')
  for (const v of SIX) assert.ok(sql.includes(`'${v}'`), v)
})

test('PI-MIG-2 no down-migration exists for 012', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR)
  assert.deepEqual(files.filter((f) => f.startsWith('012')), ['012_vault_preview_index_v1.sql'])
  assert.equal(files.some((f) => /down|rollback|revert/i.test(f)), false)
})

test('PI-MIG-3 no new column can hold a name, path, node, MIME, kind or prefix', () => {
  const sql = migrationSql()
  for (const t of NEW_TABLES) {
    const m = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(([\\s\\S]*?)\\n\\);`))
    assert.ok(m, `${t} must be created`)
    const cols = m[1].split('\n').map((l) => l.trim()).filter((l) => /^[a-z_]+\s+[A-Z]/.test(l)).map((l) => l.split(/\s+/)[0])
    assert.ok(cols.length >= 4, t)
    for (const c of cols) assert.doesNotMatch(c, /name|path|parent|node|mime|media|kind|prefix|shard|thumb|key_material/, `${t}.${c}`)
  }
})

test('PI-MIG-4 the 012 DDL block equals the block appended to schema.sql; schema.sql keeps the 011 lifecycle CHECK before it', () => {
  const schema = read(SCHEMA)
  const mig = ddlBlock(migrationSql())
  assert.ok(mig.length > 500)
  const tail = schema.slice(schema.indexOf('-- ── D-1 preview index'))
  assert.ok(schema.indexOf('-- ── D-1 preview index') > schema.indexOf('CREATE TABLE IF NOT EXISTS vault_tree_blob_state'), '012 block comes after the 011 tables')
  assert.equal(norm(tail), norm(mig))
})

// ── PostgreSQL ───────────────────────────────────────────────────────────────

async function withDisposableDb(label, work) {
  const admin = new pg.Client({ connectionString: SUPER_URL })
  await admin.connect()
  const dbName = `aegis_drive_pimig_${label}_${Date.now().toString(36)}`
  let db
  try {
    await admin.query(`CREATE DATABASE ${dbName}`)
    const u = new URL(SUPER_URL); u.pathname = '/' + dbName
    db = new pg.Client({ connectionString: u.toString() })
    await db.connect()
    await db.query(read(SCHEMA))
    await work(db, u.toString(), dbName)
  } finally {
    await db?.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
    await admin.end()
  }
}

/** turn a schema.sql database back into its pre-012 shape (only what 012 adds) */
async function toPre012(db) {
  await db.query(`DROP TABLE IF EXISTS vault_preview_index_heads, vault_preview_index_blob_refs, vault_preview_index_generations CASCADE`)
  await db.query(`DROP FUNCTION IF EXISTS vault_preview_index_generations_guard(), vault_preview_index_blob_refs_guard()`)
  await db.query(`ALTER TABLE vault_tree_blob_state DROP CONSTRAINT vault_tree_blob_state_lifecycle_check`)
  await db.query(`ALTER TABLE vault_tree_blob_state ADD CONSTRAINT vault_tree_blob_state_lifecycle_check CHECK (lifecycle IN ('UNREFERENCED', 'TREE_MANAGED', 'PURGE_PENDING', 'PURGED'))`)
}

const lifecycleDef = async (db) => (await db.query(
  `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
    WHERE conrelid = 'vault_tree_blob_state'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%lifecycle%'`,
)).rows

async function seedUser(db, username) {
  const { rows: [u] } = await db.query(
    `INSERT INTO users (username, password_hash, display_name) VALUES ($1, '$2a$10$notarealhash', $1) RETURNING id`, [username],
  )
  return u.id
}

test('PI-PG-1 fresh schema.sql: lifecycle accepts INDEX_STAGED/INDEX_MANAGED and still rejects unknown values; new tables exist', { skip: pgSkip }, async () => {
  await withDisposableDb('fresh', async (db) => {
    const defs = await lifecycleDef(db)
    assert.equal(defs.length, 1)
    assert.equal(defs[0].conname, 'vault_tree_blob_state_lifecycle_check')
    for (const v of SIX) assert.ok(defs[0].def.includes(v), v)
    const owner = await seedUser(db, 'pimig_fresh')
    await db.query(`INSERT INTO vault_tree_blob_state (user_id, blob_format_version, blob_id, lifecycle) VALUES ($1, 2, 'a', 'INDEX_MANAGED'), ($1, 2, 'b', 'INDEX_STAGED')`, [owner])
    await assert.rejects(db.query(`INSERT INTO vault_tree_blob_state (user_id, blob_format_version, blob_id, lifecycle) VALUES ($1, 2, 'c', 'BOGUS')`, [owner]), /lifecycle_check/)
    for (const t of NEW_TABLES) assert.ok((await db.query('SELECT to_regclass($1) AS oid', [`public.${t}`])).rows[0].oid, t)
  })
})

test('PI-PG-2 upgrade path: 012 on a pre-012 database rewrites no row, is re-runnable, and grants drive_app no DELETE', { skip: pgSkip }, async () => {
  await withDisposableDb('upgrade', async (db) => {
    await toPre012(db)
    const owner = await seedUser(db, 'pimig_upgrade')
    for (const [i, lc] of ['UNREFERENCED', 'TREE_MANAGED', 'PURGE_PENDING', 'PURGED'].entries()) {
      await db.query(`INSERT INTO vault_tree_blob_state (user_id, blob_format_version, blob_id, lifecycle, attached_generation) VALUES ($1, 2, $2, $3, $4)`, [owner, `blob-${i}`, lc, i || null])
    }
    await assert.rejects(db.query(`INSERT INTO vault_tree_blob_state (user_id, blob_format_version, blob_id, lifecycle) VALUES ($1, 2, 'x', 'INDEX_STAGED')`, [owner]), /lifecycle_check/, 'pre-012 rejects INDEX_STAGED')
    const checksum = async () => (await db.query(`SELECT md5(string_agg(t::text, '|' ORDER BY blob_id)) AS h FROM vault_tree_blob_state t`)).rows[0].h
    const before = await checksum()
    await db.query(migrationSql())
    const once = await checksum()
    const defsOnce = await lifecycleDef(db)
    await db.query(migrationSql())
    assert.equal(await checksum(), before, 'no existing row rewritten (twice)')
    assert.equal(once, before)
    assert.deepEqual(await lifecycleDef(db), defsOnce, 're-run is a no-op for the constraint')
    assert.equal(defsOnce.length, 1)
    for (const v of SIX) assert.ok(defsOnce[0].def.includes(v), v)
    await db.query(`INSERT INTO vault_tree_blob_state (user_id, blob_format_version, blob_id, lifecycle) VALUES ($1, 2, 'x', 'INDEX_STAGED')`, [owner])
    const hasDriveApp = (await db.query(`SELECT 1 FROM pg_roles WHERE rolname = 'drive_app'`)).rows.length === 1
    if (hasDriveApp) {
      for (const t of NEW_TABLES) {
        const { rows } = await db.query(`SELECT has_table_privilege('drive_app', $1, 'SELECT') s, has_table_privilege('drive_app', $1, 'INSERT') i, has_table_privilege('drive_app', $1, 'UPDATE') u, has_table_privilege('drive_app', $1, 'DELETE') d, has_table_privilege('drive_app', $1, 'TRUNCATE') tr`, [t])
        assert.deepEqual(rows[0], { s: true, i: true, u: true, d: false, tr: false }, t)
      }
    }
  })
})

test('PI-PG-3 generations and blob refs are immutable and undeletable except by owner cascade; head must reference a generation', { skip: pgSkip }, async () => {
  await withDisposableDb('guard', async (db) => {
    const owner = await seedUser(db, 'pimig_guard')
    await assert.rejects(db.query(`INSERT INTO vault_preview_index_heads (user_id, tree_id, index_generation, root_blob_id, root_content_id_b64) VALUES ($1, 't', 1, 'r', 'c')`, [owner]), /generation_fk/)
    await db.query(`INSERT INTO vault_preview_index_generations (user_id, index_generation, tree_id, base_generation, root_blob_id, root_content_id_b64, idempotency_key, request_digest) VALUES ($1, 1, 't', 0, 'r1', 'c1', 'k1', $2)`, [owner, 'a'.repeat(64)])
    await assert.rejects(db.query(`INSERT INTO vault_preview_index_generations (user_id, index_generation, tree_id, base_generation, root_blob_id, root_content_id_b64, idempotency_key, request_digest) VALUES ($1, 3, 't', 1, 'r3', 'c3', 'k3', $2)`, [owner, 'a'.repeat(64)]), /sequential/)
    await assert.rejects(db.query(`INSERT INTO vault_preview_index_generations (user_id, index_generation, tree_id, base_generation, root_blob_id, root_content_id_b64, idempotency_key, request_digest) VALUES ($1, 2, 't', 1, 'r2', 'c2', 'k1', $2)`, [owner, 'a'.repeat(64)]), /idempotency/)
    await db.query(`INSERT INTO vault_preview_index_heads (user_id, tree_id, index_generation, root_blob_id, root_content_id_b64) VALUES ($1, 't', 1, 'r1', 'c1')`, [owner])
    await db.query(`INSERT INTO vault_preview_index_blob_refs (user_id, index_generation, blob_id, role) VALUES ($1, 1, 'r1', 'ATTACHED'), ($1, 1, 'old', 'SUPERSEDED')`, [owner])
    await assert.rejects(db.query(`INSERT INTO vault_preview_index_blob_refs (user_id, index_generation, blob_id, role) VALUES ($1, 1, 'z', 'DELETE')`, [owner]), /role/)
    await assert.rejects(db.query(`UPDATE vault_preview_index_generations SET root_blob_id = 'evil' WHERE user_id = $1`, [owner]), /immutable/)
    await assert.rejects(db.query(`DELETE FROM vault_preview_index_generations WHERE user_id = $1`, [owner]), /delete forbidden/)
    await assert.rejects(db.query(`UPDATE vault_preview_index_blob_refs SET role = 'ATTACHED' WHERE user_id = $1`, [owner]), /immutable/)
    await assert.rejects(db.query(`DELETE FROM vault_preview_index_blob_refs WHERE user_id = $1`, [owner]), /delete forbidden/)
    await db.query(`UPDATE vault_preview_index_generations SET superseded_at = now() WHERE user_id = $1`, [owner])
    await assert.rejects(db.query(`UPDATE vault_preview_index_generations SET superseded_at = now() + interval '1 day' WHERE user_id = $1`, [owner]), /set once/)
    await assert.rejects(db.query(`UPDATE vault_preview_index_generations SET superseded_at = NULL WHERE user_id = $1`, [owner]), /set once/)
    await db.query(`DELETE FROM users WHERE id = $1`, [owner])
    for (const t of NEW_TABLES) assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, `${t} cascades with its owner`)
  })
})

// ── boot probe (A.4) ─────────────────────────────────────────────────────────
const { probePreviewIndexSchema } = await import('../server/db/vaultTreeSchemaProbe.js')

test('PI-PROBE-1 probe reports missing tables and an un-widened lifecycle CHECK; memory mode has nothing missing', async () => {
  assert.deepEqual(await probePreviewIndexSchema({ pg: false }), { missing: [], lifecycleValuesOk: true })
  const old = "CHECK ((lifecycle = ANY (ARRAY['UNREFERENCED'::text, 'TREE_MANAGED'::text, 'PURGE_PENDING'::text, 'PURGED'::text])))"
  const widened = old.replace("'PURGED'::text]", "'PURGED'::text, 'INDEX_STAGED'::text, 'INDEX_MANAGED'::text]")
  const fake = (present, def) => async (sql, params) => ({ rows: sql.includes('to_regclass($1)') ? [{ oid: present.includes(params[0].replace('public.', '')) ? 'x' : null }] : [{ def }] })
  assert.deepEqual(await probePreviewIndexSchema({ pg: true, q: fake([], old) }), { missing: NEW_TABLES, lifecycleValuesOk: false })
  assert.deepEqual(await probePreviewIndexSchema({ pg: true, q: fake(NEW_TABLES, widened) }), { missing: [], lifecycleValuesOk: true })
  assert.deepEqual(await probePreviewIndexSchema({ pg: true, q: fake(NEW_TABLES, old) }), { missing: [], lifecycleValuesOk: false })
})

test('PI-PG-4 boot probe on a real pre-012 database fails; after 012 it passes', { skip: pgSkip }, async () => {
  await withDisposableDb('probe', async (db) => {
    const q = (sql, params) => db.query(sql, params)
    await toPre012(db)
    assert.deepEqual(await probePreviewIndexSchema({ pg: true, q }), { missing: NEW_TABLES, lifecycleValuesOk: false })
    await db.query(migrationSql())
    assert.deepEqual(await probePreviewIndexSchema({ pg: true, q }), { missing: [], lifecycleValuesOk: true })
  })
})
