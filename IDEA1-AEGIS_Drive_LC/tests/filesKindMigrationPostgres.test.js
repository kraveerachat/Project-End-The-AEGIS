// tests/filesKindMigrationPostgres.test.js — FILES-MANAGEMENT-UX-1 · migration 010 บน PostgreSQL จริง
//
// ⚠️ ทำไมต้องมีชุดนี้ทั้งที่ filesKindIdentity อ่านข้อความของ migration อยู่แล้ว:
//    การอ่านข้อความบอกได้ว่า "เขียนอะไรไว้" แต่ไม่ได้บอกว่า PostgreSQL ทำอะไรจริง
//    คอลัมน์ที่ได้จากการติดตั้งใหม่ (schema.sql) กับการอัปเกรดฐานเดิม (010) ต้อง
//    มีรูปเดียวกันในแคตตาล็อกจริง — รวมถึง DEFAULT ซึ่งเคยหายไปฝั่งอัปเกรด
//    ทำให้ INSERT ที่ไม่ระบุ kind ผ่านบนฐานใหม่แต่ระเบิด 23502 บนฐานที่อัปเกรดมา
//
// ⚠️ ต้องตั้ง AEGIS_PGTEST_SUPER_URL (scripts/pg-integration-env.sh พิมพ์ให้) เพราะชุดนี้
//    สร้างและทิ้งฐานข้อมูลของตัวเองต่อหนึ่งเทสต์ ไม่แตะฐานที่ TEST_DATABASE_URL ชี้อยู่
//    และไม่มีวันชี้ไป Production — มันคุยกับฐานที่มันเพิ่งสร้างเท่านั้น
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import pg from 'pg'

const SUPER_URL = process.env.AEGIS_PGTEST_SUPER_URL
const skip = SUPER_URL ? false : 'ต้องตั้ง AEGIS_PGTEST_SUPER_URL เพื่อสร้างฐานทดสอบชั่วคราว (ดู scripts/pg-integration-env.sh)'

const schemaSql = () => fs.readFile(new URL('../server/db/schema.sql', import.meta.url), 'utf8')
const migrationSql = () => fs.readFile(new URL('../server/db/migrations/010_files_kind_parent.sql', import.meta.url), 'utf8')

const SHA = 'a'.repeat(64)

/** ทำให้ฐานที่เพิ่งสร้างจาก schema.sql กลับไปมีรูป "ก่อน 010" — ถอดเฉพาะสิ่งที่ 010 เพิ่ม */
const PRE_010 = `
ALTER TABLE upload_sessions DROP COLUMN IF EXISTS parent_id;
DROP INDEX IF EXISTS files_unique_name_per_parent_idx;
DROP INDEX IF EXISTS files_parent_id_idx;
ALTER TABLE files DROP COLUMN IF EXISTS parent_id;
ALTER TABLE files DROP COLUMN IF EXISTS kind;
`

/** สร้างฐานชั่วคราว รันงาน แล้วทิ้งเสมอ — ผู้เรียกได้ client ที่ต่อกับฐานนั้นแล้ว */
async function withDisposableDb(label, work) {
  const admin = new pg.Client({ connectionString: SUPER_URL })
  await admin.connect()
  const dbName = `aegis_drive_kindmig_${label}_${Date.now()}`
  let probe
  try {
    await admin.query(`CREATE DATABASE ${dbName}`)
    probe = new pg.Client({ connectionString: SUPER_URL.replace(/\/[^/]*$/, `/${dbName}`) })
    await probe.connect()
    await probe.query(await schemaSql())
    await work(probe)
  } finally {
    await probe?.end().catch(() => {})
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {})
    await admin.end()
  }
}

async function kindColumn(client) {
  const { rows } = await client.query(
    `SELECT column_default, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'files' AND column_name = 'kind'`,
  )
  return rows[0] ?? null
}

async function toPre010(client) {
  await client.query(PRE_010)
  assert.equal(await kindColumn(client), null, 'ก่อน 010 ต้องไม่มีคอลัมน์ kind')
}

async function seedOwner(client) {
  const { rows: [u] } = await client.query(
    `INSERT INTO users (username, password_hash, display_name)
     VALUES ('kindmig_owner', '$2a$10$notarealhash', 'Kind Migration Owner') RETURNING id`,
  )
  return u.id
}

async function provenRows(client, owner) {
  await client.query(
    `INSERT INTO files (name, path, size_bytes, sha256, vault, uploaded_by) VALUES
       ('proven-file.bin', 'uploads/11111111-1111-4111-8111-111111111111.bin', 123, $1, FALSE, $2),
       ('Docs',            '/datalake/Docs',                                      0,   NULL, FALSE, $2)`,
    [SHA, owner],
  )
}

test('MIG-DEFAULT-A · a fresh schema.sql install gives files.kind DEFAULT \'file\'', { skip }, async () => {
  await withDisposableDb('fresh', async (db) => {
    const col = await kindColumn(db)
    assert.ok(col, 'schema.sql ต้องสร้างคอลัมน์ kind')
    assert.equal(col.column_default, "'file'::text")
    assert.equal(col.is_nullable, 'NO')
  })
})

test('MIG-DEFAULT-B · a database upgraded through migration 010 converges on the same DEFAULT \'file\'', { skip }, async () => {
  await withDisposableDb('upgrade', async (db) => {
    await toPre010(db)
    const owner = await seedOwner(db)
    await provenRows(db, owner)

    await db.query(await migrationSql())

    const col = await kindColumn(db)
    assert.ok(col, '010 ต้องสร้างคอลัมน์ kind')
    assert.equal(col.is_nullable, 'NO')
    assert.equal(col.column_default, "'file'::text", 'ฐานที่อัปเกรดต้องได้ DEFAULT เดียวกับ schema.sql')
    const { rows: [check] } = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'files'::regclass AND conname = 'files_kind_check'`,
    )
    assert.match(check.def, /'file'.*'folder'/)
    // แถวเก่ายังถูกจำแนกจากหลักฐาน ไม่ใช่จากค่าเริ่มต้น
    const { rows } = await db.query('SELECT name, kind FROM files ORDER BY id')
    assert.deepEqual(rows, [{ name: 'proven-file.bin', kind: 'file' }, { name: 'Docs', kind: 'folder' }])
  })
})

test('MIG-DEFAULT-C · an ambiguous legacy row still aborts 010 before any default could classify it', { skip }, async () => {
  await withDisposableDb('ambiguous', async (db) => {
    await toPre010(db)
    const owner = await seedOwner(db)
    await provenRows(db, owner)
    await db.query(
      `INSERT INTO files (name, path, size_bytes, sha256, vault, uploaded_by)
       VALUES ('mystery', 'legacy/unknown', 0, NULL, FALSE, $1)`, [owner],
    )
    const before = (await db.query('SELECT id, name, path, sha256 FROM files ORDER BY id')).rows

    await assert.rejects(db.query(await migrationSql()), /migration 010 aborted: 1 files row\(s\)/)
    // ⚠️ simple-query protocol ทิ้ง transaction ที่ล้มไว้เปิดค้างบน connection นี้ — ปิดให้จบ
    await db.query('ROLLBACK').catch(() => {})

    // ล้มแบบปิดจริง: ไม่มีคอลัมน์ ไม่มีค่าเริ่มต้น ไม่มีแถวไหนถูกแตะ
    assert.equal(await kindColumn(db), null, 'หลังล้มต้องไม่เหลือคอลัมน์ kind (และ DEFAULT) ค้างอยู่')
    const after = (await db.query('SELECT id, name, path, sha256 FROM files ORDER BY id')).rows
    assert.deepEqual(after, before)
    const { rows: [{ n }] } = await db.query(
      "SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'files' AND indexname = 'files_unique_name_per_parent_idx'",
    )
    assert.equal(n, 0)
  })
})

test('MIG-DEFAULT-D · after 010, an INSERT that omits kind is a file — the same as on a fresh install', { skip }, async () => {
  await withDisposableDb('omitkind', async (db) => {
    await toPre010(db)
    const owner = await seedOwner(db)
    await provenRows(db, owner)
    await db.query(await migrationSql())

    // แบบเดียวกับ fixture ใน commitCrashRecoveryPostgres ที่เขียนแถว metadata ด้วยมือ
    const { rows: [row] } = await db.query(
      `INSERT INTO files (name, path, size_bytes, sha256, vault, verified, uploaded_by)
       VALUES ('crash-metadata.bin', 'uploads/22222222-2222-4222-8222-222222222222.bin', 5, $1, false, true, $2)
       RETURNING kind, parent_id`,
      [SHA, owner],
    )
    assert.equal(row.kind, 'file')
    assert.equal(row.parent_id, null)
  })
})

test('MIG-DEFAULT-E · an explicit kind still wins: folder stays folder and anything else is refused', { skip }, async () => {
  await withDisposableDb('explicit', async (db) => {
    await toPre010(db)
    const owner = await seedOwner(db)
    await provenRows(db, owner)
    await db.query(await migrationSql())

    const { rows: [folder] } = await db.query(
      `INSERT INTO files (name, path, size_bytes, sha256, vault, uploaded_by, kind)
       VALUES ('Sub', '/datalake/Sub', 0, NULL, FALSE, $1, 'folder') RETURNING kind`, [owner],
    )
    assert.equal(folder.kind, 'folder')
    await assert.rejects(
      db.query(
        `INSERT INTO files (name, path, size_bytes, sha256, vault, uploaded_by, kind)
         VALUES ('bad', '/datalake/bad', 0, NULL, FALSE, $1, 'symlink')`, [owner],
      ),
      /files_kind_check/,
    )
    await assert.rejects(
      db.query(
        `INSERT INTO files (name, path, size_bytes, sha256, vault, uploaded_by, kind)
         VALUES ('bad2', '/datalake/bad2', 0, NULL, FALSE, $1, NULL)`, [owner],
      ),
      /not-null constraint/,
    )
  })
})
